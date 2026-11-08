package com.rabbitball.app

import android.accessibilityservice.AccessibilityService
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.os.Handler
import android.os.Looper
import android.content.Intent
import android.content.ComponentName
import android.content.Context
import android.content.res.Configuration
import android.provider.Settings
import android.view.Display
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.view.animation.OvershootInterpolator
import com.rabbitball.app.ui.RabbitView
import kotlin.math.abs

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

        fun setSearchVisible(visible: Boolean) {
            searchVisible = visible
            refreshPet()
        }

        fun refreshPet() {
            val service = instance ?: return
            service.handler.post { if (instance === service) service.updatePet() }
        }
    }

    private val handler = Handler(Looper.getMainLooper())
    private var pet: RabbitView? = null
    private var capturing = false
    private val uiPreferences by lazy { getSharedPreferences("rabbitball_ui", MODE_PRIVATE) }
    private val windowManager by lazy { getSystemService(WindowManager::class.java) }

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
        updatePet()
    }

    fun capture() {
        if (capturing) return
        capturing = true
        pet?.visibility = View.GONE
        // 等两帧让边缘兔球从合成画面中消失，截图本身不写文件。
        handler.postDelayed({ takeCurrentScreenshot() }, 64)
    }

    private fun takeCurrentScreenshot() {
        if (instance !== this) return
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
                    deliver(image, if (image == null) "暂时无法读取屏幕，请再试一次。" else null)
                }

                override fun onFailure(errorCode: Int) {
                    val message = when (errorCode) {
                        ERROR_TAKE_SCREENSHOT_INTERVAL_TIME_SHORT -> "唤起得太快了，请稍候再试。"
                        ERROR_TAKE_SCREENSHOT_NO_ACCESSIBILITY_ACCESS -> "截图服务已关闭，请重新开启无障碍服务。"
                        ERROR_TAKE_SCREENSHOT_SECURE_WINDOW -> "当前页面受到保护，无法读取屏幕。可以直接输入问题。"
                        else -> "暂时无法读取屏幕，可以重试或直接输入问题。"
                    }
                    deliver(null, message)
                }
            })
        } catch (_: RuntimeException) {
            deliver(null, "截图服务暂时不可用，请重新开启无障碍服务。")
        }
    }

    private fun deliver(image: Bitmap?, message: String?) {
        capturing = false
        if (instance !== this) {
            image?.recycle()
            return
        }
        CaptureStore.publish(image, message)
        updatePet()
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density + .5f).toInt()

    private fun screenHeight(): Int = windowManager.maximumWindowMetrics.bounds.height()

    private fun updatePet() {
        if (instance !== this) return
        if (!uiPreferences.getBoolean("edge_pet", true)) {
            removePet()
            return
        }
        if (searchVisible || capturing) {
            pet?.visibility = View.GONE
            return
        }
        if (pet == null) createPet()
        pet?.visibility = View.VISIBLE
    }

    private fun createPet() {
        val size = dp(176)
        val availableHeight = (screenHeight() - size).coerceAtLeast(0)
        val layout = WindowManager.LayoutParams(size, size,
            WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT).apply {
            gravity = Gravity.TOP or Gravity.RIGHT
            x = -dp(56)
            y = (uiPreferences.getFloat("edge_y_fraction", .42f) * availableHeight).toInt()
            setTitle("兔球")
        }
        val rabbit = RabbitView(this).apply {
            contentDescription = "兔球：轻点搜索，拖动调整位置"
            setOnClickListener {
                setSearchVisible(true)
                startActivity(Intent(this@RabbitAccessibilityService, CaptureActivity::class.java)
                    .setAction(CaptureActivity.ACTION_CAPTURE)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or
                        Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_NO_ANIMATION))
            }
        }
        var downY = 0f
        var originalY = 0
        var dragging = false
        val touchSlop = ViewConfiguration.get(this).scaledTouchSlop
        rabbit.setOnTouchListener { view, event ->
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downY = event.rawY
                    originalY = layout.y
                    dragging = false
                    view.animate().scaleX(.92f).scaleY(.92f).setDuration(100).start()
                }
                MotionEvent.ACTION_MOVE -> {
                    val offset = event.rawY - downY
                    if (abs(offset) > touchSlop) dragging = true
                    if (dragging) {
                        layout.y = (originalY + offset.toInt()).coerceIn(dp(24), (screenHeight() - size - dp(24)).coerceAtLeast(dp(24)))
                        windowManager.updateViewLayout(view, layout)
                    }
                }
                MotionEvent.ACTION_UP -> {
                    view.animate().scaleX(1f).scaleY(1f).setDuration(320)
                        .setInterpolator(OvershootInterpolator(1.6f)).start()
                    if (dragging) {
                        val available = (screenHeight() - size).coerceAtLeast(1)
                        uiPreferences.edit().putFloat("edge_y_fraction", layout.y.toFloat() / available).apply()
                    } else view.performClick()
                }
                MotionEvent.ACTION_CANCEL -> view.animate().scaleX(1f).scaleY(1f).setDuration(180).start()
            }
            true
        }
        windowManager.addView(rabbit, layout)
        pet = rabbit
    }

    private fun removePet() {
        pet?.let {
            it.animate().cancel()
            windowManager.removeViewImmediate(it)
        }
        pet = null
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) = Unit
    override fun onInterrupt() = Unit

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        removePet()
        updatePet()
    }

    override fun onUnbind(intent: Intent?): Boolean {
        removePet()
        if (instance === this) instance = null
        return super.onUnbind(intent)
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        removePet()
        if (instance === this) instance = null
        super.onDestroy()
    }
}
