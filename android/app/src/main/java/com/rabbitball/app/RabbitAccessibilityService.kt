package com.rabbitball.app

import android.accessibilityservice.AccessibilityService
import android.graphics.Bitmap
import android.graphics.PointF
import com.rabbitball.app.ui.EdgePetOverlay
import com.rabbitball.app.ui.PetDock
import android.os.Handler
import android.os.Looper
import android.content.Intent
import android.content.ComponentName
import android.content.Context
import android.content.res.Configuration
import android.provider.Settings
import android.view.Display
import android.view.accessibility.AccessibilityEvent

/** 只在用户唤起时读取一次屏幕，无需监听或读取界面节点。 */
class RabbitAccessibilityService : AccessibilityService() {
    companion object {
        @Volatile
        var instance: RabbitAccessibilityService? = null
            private set

        private var searchVisible = false

        fun isEnabled(context: Context): Boolean {
            val component = ComponentName(context, RabbitAccessibilityService::class.java)
            val enabled = Settings.Secure.getString(context.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES)
            return enabled?.split(':')?.any { ComponentName.unflattenFromString(it) == component } == true
        }

        fun setSearchVisible(visible: Boolean, fromScreen: PointF? = null) {
            searchVisible = visible
            val service = instance ?: return
            service.handler.post { if (instance === service) service.updatePet(fromScreen) }
        }

        fun refreshPet() {
            val service = instance ?: return
            service.handler.post {
                if (instance === service) {
                    service.releasePet()
                    service.updatePet()
                }
            }
        }
    }

    private val handler = Handler(Looper.getMainLooper())
    private var edgePet: EdgePetOverlay? = null
    private var searchWindow: AccessibilitySearchWindow? = null

    fun showSearch(result: CaptureResult) {
        searchWindow?.close()
        searchWindow = AccessibilitySearchWindow(this).also { it.show(result) }
    }
    private class ScreenshotRequest(val onResult: (CaptureResult) -> Unit)
    private var captureRequest: ScreenshotRequest? = null
    private val capturing: Boolean get() = captureRequest != null
    private val dock by lazy { PetDock(this) }

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
        updatePet()
    }

    fun capture(onResult: (CaptureResult) -> Unit): Boolean {
        if (capturing) return false
        val request = ScreenshotRequest(onResult)
        captureRequest = request
        edgePet?.hide()
        // 等两帧让边缘兔球从合成画面中消失，截图本身不写文件。
        handler.postDelayed({ takeCurrentScreenshot(request) }, 64)
        return true
    }

    private fun takeCurrentScreenshot(request: ScreenshotRequest) {
        if (captureRequest !== request) return
        if (instance !== this) {
            deliver(null, "截图服务已断开，请重新开启无障碍服务。", request)
            return
        }
        try {
            takeScreenshot(Display.DEFAULT_DISPLAY, mainExecutor, object : TakeScreenshotCallback {
                override fun onSuccess(result: ScreenshotResult) {
                    val buffer = result.hardwareBuffer
                    var hardwareBitmap: Bitmap? = null
                    val image = try {
                        hardwareBitmap = Bitmap.wrapHardwareBuffer(buffer, result.colorSpace)
                        hardwareBitmap?.copy(Bitmap.Config.ARGB_8888, false)
                    } catch (_: RuntimeException) {
                        null
                    } finally {
                        hardwareBitmap?.recycle()
                        buffer.close()
                    }
                    deliver(image, if (image == null) "暂时无法读取屏幕，请再试一次。" else null, request)
                }

                override fun onFailure(errorCode: Int) {
                    val message = when (errorCode) {
                        ERROR_TAKE_SCREENSHOT_INTERVAL_TIME_SHORT -> "唤起得太快了，请稍候再试。"
                        ERROR_TAKE_SCREENSHOT_NO_ACCESSIBILITY_ACCESS -> "截图服务已关闭，请重新开启无障碍服务。"
                        ERROR_TAKE_SCREENSHOT_SECURE_WINDOW -> "当前页面受到保护，无法读取屏幕。可以直接输入问题。"
                        else -> "暂时无法读取屏幕，可以重试或直接输入问题。"
                    }
                    deliver(null, message, request)
                }
            })
        } catch (_: RuntimeException) {
            deliver(null, "截图服务暂时不可用，请重新开启无障碍服务。", request)
        }
    }

    private fun deliver(image: Bitmap?, message: String?, request: ScreenshotRequest) {
        if (captureRequest !== request) {
            image?.recycle()
            return
        }
        captureRequest = null
        request.onResult(CaptureResult(image, message))
        updatePet()
    }

    private fun cancelCapture() {
        captureRequest?.let { deliver(null, "截图服务已断开，请重新开启无障碍服务。", it) }
    }

    private fun updatePet(fromScreen: PointF? = null) {
        if (instance !== this) return
        when {
            !dock.enabled -> releasePet()
            searchVisible || capturing -> edgePet?.hide()
            else -> {
                val overlay = edgePet ?: EdgePetOverlay(this).also { edgePet = it }
                overlay.show(fromScreen)
            }
        }
    }

    private fun releasePet() {
        edgePet?.release()
        edgePet = null
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) = Unit
    override fun onInterrupt() = Unit

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        releasePet()
        updatePet()
    }

    override fun onUnbind(intent: Intent?): Boolean {
        searchWindow?.close()
        searchWindow = null
        if (instance === this) instance = null
        cancelCapture()
        releasePet()
        return super.onUnbind(intent)
    }

    override fun onDestroy() {
        searchWindow?.close()
        searchWindow = null
        handler.removeCallbacksAndMessages(null)
        if (instance === this) instance = null
        cancelCapture()
        releasePet()
        super.onDestroy()
    }
}
