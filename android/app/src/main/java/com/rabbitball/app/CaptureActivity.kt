package com.rabbitball.app

import android.app.Activity
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.WindowManager
import android.widget.FrameLayout

/** 独立的透明空任务先取屏幕，再打开聊天任务，避免聊天启动快照进入截图。 */
class CaptureActivity : Activity() {
    companion object {
        const val ACTION_CAPTURE = "com.rabbitball.app.CAPTURE"
    }

    private val handler = Handler(Looper.getMainLooper())
    private var started = false
    private var pending = false
    private var handedOff = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (Build.VERSION.SDK_INT >= 33) setRecentsScreenshotEnabled(false)
        window.clearFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
        window.addFlags(WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE)
        setContentView(FrameLayout(this))
    }

    override fun onResume() {
        super.onResume()
        if (started) return
        started = true
        RabbitAccessibilityService.setSearchVisible(true)
        if (!AppSettings(this).setupComplete) {
            openMain(MainActivity.ACTION_SETTINGS)
            return
        }
        pending = true
        captureWhenReady(SystemClock.uptimeMillis() + 2_000)
    }

    private fun acceptCapture(result: CaptureResult) {
        if (!pending || isFinishing || isDestroyed) {
            result.bitmap?.recycle()
            return
        }
        pending = false
        RabbitAccessibilityService.setSearchVisible(true)
        CaptureStore.store(result)
        openMain(MainActivity.ACTION_CAPTURED)
    }

    private fun captureWhenReady(deadline: Long) {
        if (!pending || isFinishing || isDestroyed) return
        val service = RabbitAccessibilityService.instance
        if (service != null && service.capture(::acceptCapture)) return
        if ((service != null || RabbitAccessibilityService.isEnabled(this)) && SystemClock.uptimeMillis() < deadline) {
            handler.postDelayed({ captureWhenReady(deadline) }, 120)
            return
        }
        val error = when {
            service != null -> "截图服务暂时没有响应，请再试一次。"
            RabbitAccessibilityService.isEnabled(this) -> "即开即选需要重新连接。轻点屏幕中央的图标打开设置。"
            RabbitVoiceService.isDefault(this) -> "可用系统助理手势唤起兔球；轻点中央图标开启即开即选后，也能直接打开框选。"
            else -> "轻点中央图标开启即开即选，之后打开兔球就能框选屏幕。"
        }
        acceptCapture(CaptureResult(null, error))
    }

    private fun openMain(action: String) {
        handedOff = true
        startActivity(Intent(this, MainActivity::class.java).setAction(action)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or
                Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_NO_ANIMATION))
        finishAndRemoveTask()
    }

    override fun onStop() {
        if (!handedOff) {
            pending = false
            handler.removeCallbacksAndMessages(null)
            RabbitAccessibilityService.setSearchVisible(false)
            if (!isFinishing) finishAndRemoveTask()
        }
        super.onStop()
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        if (!handedOff) RabbitAccessibilityService.setSearchVisible(false)
        super.onDestroy()
    }
}
