package com.rabbitball.app

import android.content.Context
import android.graphics.Bitmap
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.service.voice.VoiceInteractionSession
import android.service.voice.VoiceInteractionSessionService
import android.view.ViewGroup
import android.view.WindowManager
import android.window.OnBackInvokedDispatcher

class RabbitSessionService : VoiceInteractionSessionService() {
    override fun onNewSession(args: Bundle?): VoiceInteractionSession = RabbitSession(this)
}

/** 助手直接显示系统会话窗口，激活时不再启动聊天 Activity。 */
private class RabbitSession(context: Context) : VoiceInteractionSession(context) {
    private val handler = Handler(Looper.getMainLooper())
    private var session: SearchSession? = null
    private var waitingForScreenshot = false
    private var resumeContent = false
    private var needsSetup = false
    private var generation = 0

    override fun onCreate() {
        setTheme(R.style.Theme_RabbitBall)
        super.onCreate()
        window.window!!.apply {
            setDecorFitsSystemWindows(false)
            clearFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
            setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING or
                WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN)
            attributes = attributes.apply {
                windowAnimations = 0
                layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
            }
        }
        if (Build.VERSION.SDK_INT >= 33) {
            window.onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT) { onBackPressed() }
        }
    }

    override fun onPrepareShow(args: Bundle?, showFlags: Int) {
        super.onPrepareShow(args, showFlags)
        resumeContent = args?.getBoolean("resume_content") == true && session?.isActive() == true
        setUiEnabled(true)
        if (resumeContent) return
        disposeContent()
        needsSetup = !AppSettings(context).setupComplete
        waitingForScreenshot = !needsSetup
        generation++
        RabbitAccessibilityService.setSearchVisible(true)
    }

    override fun onShow(args: Bundle?, showFlags: Int) {
        super.onShow(args, showFlags)
        if (needsSetup) {
            startAssistantActivity(MainActivity.externalIntent(context, MainActivity.ACTION_SETTINGS))
            finish()
            return
        }
        if (resumeContent) {
            attachContent()
            session?.resume()
            return
        }
        val captureFlags = SHOW_WITH_ASSIST or SHOW_WITH_SCREENSHOT
        if (showFlags and captureFlags != captureFlags) {
            show(args, showFlags or captureFlags)
            return
        }
        val current = generation
        handler.postDelayed({
            if (current == generation && waitingForScreenshot) acceptScreenshot(null,
                "系统未提供当前屏幕，可以直接输入问题或上传照片。")
        }, 1800)
    }

    override fun onHandleScreenshot(screenshot: Bitmap?) {
        if (!waitingForScreenshot) return
        val image = screenshot?.copy(Bitmap.Config.ARGB_8888, false)
        acceptScreenshot(image, if (image == null) "当前页面未允许截图，可以直接输入问题。" else null)
    }

    private fun acceptScreenshot(image: Bitmap?, error: String?) {
        if (!waitingForScreenshot) { image?.recycle(); return }
        waitingForScreenshot = false
        val controller = SearchSession(context, {
            disposeContent()
            finish()
        }, {
            disposeContent()
            hide()
            CaptureActivity.activate(context)
        }, { action -> startAssistantActivity(MainActivity.externalIntent(context, action)) })
        session = controller
        controller.onExternalVisibilityChanged = { external ->
            if (external) hide() else show(Bundle().apply { putBoolean("resume_content", true) }, 0)
        }
        controller.acceptCapture(CaptureResult(image, error))
        attachContent()
    }

    private fun attachContent() {
        val controller = session ?: return
        (controller.root.parent as? ViewGroup)?.removeView(controller.root)
        setContentView(controller.root)
        window.window!!.setLayout(-1, -1)
        controller.root.requestApplyInsets()
    }

    override fun onBackPressed() {
        val controller = session
        if (controller != null) controller.handleBack() else { disposeContent(); finish() }
    }

    override fun onHide() {
        waitingForScreenshot = false
        generation++
        if (session?.externalVisible == true) session?.pause() else disposeContent()
        super.onHide()
    }

    private fun disposeContent() {
        waitingForScreenshot = false
        generation++
        val controller = session
        session = null
        val position = controller?.search?.petScreenPosition()
        controller?.release()
        RabbitAccessibilityService.setSearchVisible(false, position)
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        disposeContent()
        super.onDestroy()
    }
}
