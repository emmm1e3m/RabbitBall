package com.rabbitball.app

import android.graphics.Bitmap
import android.os.Handler
import android.os.Looper

/** 截图只在当前进程内传递，不写入相册、缓存文件或剪贴板。 */
object CaptureStore {
    var bitmap: Bitmap? = null
    var error: String? = null
    var listener: ((Bitmap?, String?) -> Unit)? = null
    private val mainHandler = Handler(Looper.getMainLooper())

    fun publish(image: Bitmap?, message: String? = null) {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            mainHandler.post { publish(image, message) }
            return
        }
        val receiver = listener
        if (receiver != null) receiver(image, message)
        else image?.recycle()
    }
}
