package com.rabbitball.app

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.service.voice.VoiceInteractionSession
import android.service.voice.VoiceInteractionSessionService

class RabbitSessionService : VoiceInteractionSessionService() {
    override fun onNewSession(args: Bundle?): VoiceInteractionSession = RabbitSession(this)
}

private class RabbitSession(context: Context) : VoiceInteractionSession(context) {
    private val handler = Handler(Looper.getMainLooper())
    private var launched = false
    private var cancelled = true
    private var generation = 0

    override fun onPrepareShow(args: Bundle?, showFlags: Int) {
        super.onPrepareShow(args, showFlags)
        setUiEnabled(false)
        launched = false
        cancelled = false
        generation++
    }

    override fun onShow(args: Bundle?, showFlags: Int) {
        super.onShow(args, showFlags)
        val captureFlags = SHOW_WITH_ASSIST or SHOW_WITH_SCREENSHOT
        if (showFlags and captureFlags != captureFlags) {
            show(args, showFlags or captureFlags)
            return
        }
        val currentGeneration = generation
        handler.postDelayed({
            if (currentGeneration == generation && !launched) {
                launch(null, "系统未提供当前屏幕，可以直接输入问题或重新截图。")
            }
        }, 1800)
    }

    override fun onHandleScreenshot(screenshot: Bitmap?) {
        if (launched || cancelled) return
        val image = screenshot?.copy(Bitmap.Config.ARGB_8888, false)
        launch(image, if (image == null) "当前页面未允许截图，可以直接输入问题。" else null)
    }

    private fun launch(image: Bitmap?, message: String?) {
        if (launched || cancelled) return
        launched = true
        CaptureStore.bitmap = image
        CaptureStore.error = message
        // Bitmap 不经 Intent 序列化，避免整屏图像触及 Binder 大小限制。
        startAssistantActivity(Intent(context, MainActivity::class.java)
            .setAction("com.rabbitball.app.CAPTURED")
            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP))
    }

    override fun onHide() {
        cancelled = true
        generation++
        super.onHide()
    }

    override fun onTaskFinished(intent: Intent?, taskId: Int) {
        super.onTaskFinished(intent, taskId)
        finish()
    }

    override fun onDestroy() {
        cancelled = true
        handler.removeCallbacksAndMessages(null)
        super.onDestroy()
    }
}
