package com.rabbitball.app

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.util.Base64
import java.io.ByteArrayOutputStream
import kotlin.math.max
import kotlin.math.roundToInt

/** 历史条目内的压缩预览，不替代会话中用于模型识别的完整图片。 */
data class HistoryPreview(val jpegBase64: String, val source: VisualSource) {
    fun decode(maxEdge: Int = 960): Bitmap? {
        val bytes = try { Base64.decode(jpegBase64, Base64.NO_WRAP) }
            catch (_: IllegalArgumentException) { return null }
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        var sample = 1
        while (max(bounds.outWidth, bounds.outHeight) / sample > maxEdge) sample *= 2
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.size,
            BitmapFactory.Options().apply { inSampleSize = sample; inPreferredConfig = Bitmap.Config.ARGB_8888 })
    }

    companion object {
        fun from(visual: VisualContext): HistoryPreview {
            val source = visual.bitmap
            val ratio = minOf(1f, 960f / max(source.width, source.height))
            val width = max(1, (source.width * ratio).roundToInt())
            val height = max(1, (source.height * ratio).roundToInt())
            val preview = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
            try {
                val canvas = Canvas(preview)
                canvas.drawColor(Color.WHITE)
                canvas.drawBitmap(source, null, RectF(0f, 0f, width.toFloat(), height.toFloat()),
                    Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG))
                val bytes = ByteArrayOutputStream().use { output ->
                    check(preview.compress(Bitmap.CompressFormat.JPEG, 82, output))
                    output.toByteArray()
                }
                return HistoryPreview(Base64.encodeToString(bytes, Base64.NO_WRAP), visual.source)
            } finally { preview.recycle() }
        }
    }
}
