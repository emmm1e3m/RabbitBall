package com.rabbitball.app.ui

import android.content.Context
import android.graphics.PointF
import com.rabbitball.app.AppSettings
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min

/** 停靠只保存左右侧与高度比例；边缘窗口和聊天入场共用同一套球心几何。 */
class PetDock(private val context: Context) {
    private val preferences = context.getSharedPreferences("rabbitball_ui", Context.MODE_PRIVATE)
    private val settings = AppSettings(context)
    private var size = settings.loadAppearance().petSize
    val viewWidth: Int get() = Palette.dp(context, 96f * size)
    val viewHeight: Int get() = Palette.dp(context, 108f * size)
    private val scale: Float get() = min(viewWidth / 360f, viewHeight / 400f)
    private val centerX: Float get() = viewWidth * .5f
    private val centerY: Float get() = (viewHeight - scale * 400f) * .5f + scale * 240f
    private val minimumDistance = Palette.dp(context, 32f).toFloat()

    val enabled: Boolean get() = preferences.getBoolean("edge_pet", true)
    val left: Boolean get() = preferences.getBoolean("edge_left", false)

    fun refreshAppearance() { size = settings.loadAppearance().petSize }

    private fun minimumY(topInset: Int) = topInset + viewWidth * .48f
    private fun maximumY(height: Int, topInset: Int, bottomInset: Int) =
        max(minimumY(topInset), height - bottomInset - viewWidth * .41f)

    fun position(width: Int, height: Int, topInset: Int = 0, bottomInset: Int = 0): PointF {
        val ratio = preferences.getFloat("edge_y_fraction", .42f).coerceIn(0f, 1f)
        val minimum = minimumY(topInset)
        val maximum = maximumY(height, topInset, bottomInset)
        return PointF(
            (if (left) -viewWidth * .2f else width + viewWidth * .2f) - centerX,
            minimum + (maximum - minimum) * ratio - centerY
        )
    }

    /** 使用视图左上角，调用方无需重复换算 360×400 原画中的球心。 */
    fun remember(position: PointF, width: Int, height: Int, topInset: Int = 0, bottomInset: Int = 0) {
        val minimum = minimumY(topInset)
        val span = (maximumY(height, topInset, bottomInset) - minimum).coerceAtLeast(1f)
        preferences.edit()
            .putBoolean("edge_left", position.x + centerX < width * .5f)
            .putFloat("edge_y_fraction", ((position.y + centerY - minimum) / span).coerceIn(0f, 1f))
            .apply()
    }

    fun constrain(position: PointF, width: Int, height: Int, topInset: Int = 0, bottomInset: Int = 0): PointF =
        PointF(
            // 拖出球帽时保持手指偏移，经过屏缘后自然恢复完整姿态，避免瞬移进屏。
            position.x.coerceIn(-viewWidth * .2f - centerX, width + viewWidth * .2f - centerX),
            position.y.coerceIn(minimumY(topInset) - centerY, maximumY(height, topInset, bottomInset) - centerY)
        )

    fun amount(position: PointF, width: Int, height: Int, topInset: Int = 0, bottomInset: Int = 0): Float {
        val target = this.position(width, height, topInset, bottomInset)
        return (1f - hypot(position.x - target.x, position.y - target.y) / max(minimumDistance, viewWidth * .85f))
            .coerceIn(0f, 1f)
    }
}
