package com.rabbitball.app

import android.graphics.Bitmap

data class CaptureResult(val bitmap: Bitmap?, val error: String? = null)

/** 截图只在当前进程内传递，不写入相册、缓存文件或剪贴板。 */
object CaptureStore {
    private var result: CaptureResult? = null

    fun store(value: CaptureResult) {
        clear()
        result = value
    }

    fun take(): CaptureResult? = result.also { result = null }

    fun clear() {
        take()?.bitmap?.recycle()
    }
}
