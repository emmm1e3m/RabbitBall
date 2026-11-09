package com.rabbitball.app

import android.graphics.Bitmap

enum class VisualSource(val description: String) {
    SCREEN("屏幕截图"),
    CAMERA("相机拍摄的照片"),
    PHOTO("用户选择的图片")
}

/** 图片与来源一起替换，选区始终相对于这张完整图片。 */
data class VisualContext(val bitmap: Bitmap, val source: VisualSource)
