package com.rabbitball.app

import android.app.Dialog
import android.annotation.SuppressLint
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.view.ViewGroup
import android.view.WindowManager
import android.window.OnBackInvokedDispatcher

/** 直接挂在无障碍服务的窗口上，聊天不创建应用任务。 */
class AccessibilitySearchWindow(private val service: RabbitAccessibilityService) {
    private var session: SearchSession? = null
    private var registered = false
    private val dialog = object : Dialog(service, R.style.Theme_RabbitBall) {
        @Deprecated("旧系统通过 Dialog 分发返回")
        @SuppressLint("GestureBackNavigation")
        override fun onBackPressed() { session?.handleBack() }
    }
    private val systemDismiss = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (intent.action == Intent.ACTION_SCREEN_OFF ||
                intent.getStringExtra("reason") in listOf("homekey", "recentapps")) close()
        }
    }

    @SuppressLint("UnspecifiedRegisterReceiverFlag") // Android 13 以下没有该标志，以上分支明确限制广播来源。
    fun show(result: CaptureResult) {
        val controller = SearchSession(service, ::close, {
            close()
            CaptureActivity.activate(service)
        }, { action -> service.startActivity(MainActivity.externalIntent(service, action)) })
        session = controller
        controller.onExternalVisibilityChanged = { external ->
            if (external) dialog.hide() else attachContent()
        }
        dialog.window!!.apply {
            setType(WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY)
            setDecorFitsSystemWindows(false)
            clearFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
            setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING or
                WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN)
            attributes = attributes.apply {
                windowAnimations = 0
                layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
            }
        }
        controller.acceptCapture(result)
        attachContent()
        if (Build.VERSION.SDK_INT >= 33) {
            dialog.onBackInvokedDispatcher.registerOnBackInvokedCallback(
                OnBackInvokedDispatcher.PRIORITY_DEFAULT) { session?.handleBack() }
        }
        val filter = IntentFilter(Intent.ACTION_CLOSE_SYSTEM_DIALOGS).apply { addAction(Intent.ACTION_SCREEN_OFF) }
        if (Build.VERSION.SDK_INT >= 33) service.registerReceiver(systemDismiss, filter, Context.RECEIVER_NOT_EXPORTED)
        else service.registerReceiver(systemDismiss, filter)
        registered = true
        RabbitAccessibilityService.setSearchVisible(true)
    }

    private fun attachContent() {
        val controller = session ?: return
        (controller.root.parent as? ViewGroup)?.removeView(controller.root)
        dialog.setContentView(controller.root)
        dialog.show()
        dialog.window!!.setLayout(-1, -1)
        controller.root.requestApplyInsets()
    }

    fun close() {
        val controller = session ?: return
        session = null
        val petPosition = controller.search.petScreenPosition()
        if (registered) { service.unregisterReceiver(systemDismiss); registered = false }
        dialog.dismiss()
        controller.release()
        RabbitAccessibilityService.setSearchVisible(false, petPosition)
    }
}
