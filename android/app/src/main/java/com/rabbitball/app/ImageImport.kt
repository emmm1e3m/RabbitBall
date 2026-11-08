package com.rabbitball.app

import android.content.Context
import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.net.Uri
import java.io.IOException
import kotlin.math.max
import kotlin.math.roundToInt

object ImageImport {
    private const val MAX_EDGE = 2560

    // 在后台线程调用；系统解码器会应用图片的 EXIF/HEIF 方向，并保留透明度。
    @Throws(IOException::class, SecurityException::class)
    fun decode(context: Context, uri: Uri): Bitmap {
        val source = ImageDecoder.createSource(context.contentResolver, uri)
        return ImageDecoder.decodeBitmap(source) { decoder, info, _ ->
            decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
            val size = info.size
            val longestEdge = max(size.width, size.height)
            if (longestEdge > MAX_EDGE) {
                val scale = MAX_EDGE.toDouble() / longestEdge
                decoder.setTargetSize(
                    max(1, (size.width * scale).roundToInt()),
                    max(1, (size.height * scale).roundToInt())
                )
            }
        }
    }
}
