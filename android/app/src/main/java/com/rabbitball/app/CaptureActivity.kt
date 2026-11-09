package com.rabbitball.app

import android.app.Activity
import android.content.Context
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock

/** 桌面和磁贴的无界面入口：立即结束，截图与窗口均由已授权服务持有。 */
class CaptureActivity : Activity() {
    companion object {
        const val ACTION_CAPTURE = "com.rabbitball.app.CAPTURE"
        private val handler = Handler(Looper.getMainLooper())
        private var generation = 0

        fun activate(context: Context) {
            val app = context.applicationContext
            val request = ++generation
            SearchSession.active?.close()
            if (!AppSettings(app).setupComplete) {
                app.startActivity(MainActivity.externalIntent(app, MainActivity.ACTION_SETTINGS))
                return
            }
            RabbitAccessibilityService.setSearchVisible(true)
            val deadline = SystemClock.uptimeMillis() + 2_000
            fun capture() {
                if (request != generation) return
                if (RabbitVoiceService.isDefault(app)) {
                    if (RabbitVoiceService.activate()) return
                    if (SystemClock.uptimeMillis() < deadline) {
                        handler.postDelayed({ capture() }, 120)
                        return
                    }
                }
                val service = RabbitAccessibilityService.instance
                if (service != null && service.capture { result ->
                    if (request != generation) result.bitmap?.recycle()
                    else if (RabbitAccessibilityService.instance === service) service.showSearch(result)
                    else {
                        CaptureStore.store(result)
                        app.startActivity(MainActivity.externalIntent(app, MainActivity.ACTION_CAPTURED))
                    }
                }) return
                if (RabbitAccessibilityService.isEnabled(app) && SystemClock.uptimeMillis() < deadline) {
                    handler.postDelayed({ capture() }, 120)
                    return
                }
                CaptureStore.store(CaptureResult(null, if (RabbitAccessibilityService.isEnabled(app))
                    "截图服务需要重新连接，轻点中央图标打开无障碍设置。" else
                    "直接打开时截图需开启无障碍；也可设为系统助理，用助理手势或按键唤起。两项可独立使用。"))
                app.startActivity(MainActivity.externalIntent(app, MainActivity.ACTION_CAPTURED))
            }
            capture()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        activate(applicationContext)
        finish()
    }
}
