package com.rabbitball.app.ui

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.view.Gravity
import android.widget.TextView

object Palette {
    val ink = Color.rgb(81, 57, 67)
    val muted = Color.rgb(148, 120, 135)
    val accent = Color.rgb(198, 84, 129)
    val blush = Color.rgb(249, 230, 239)
    val paper = Color.rgb(255, 251, 253)
    val line = Color.rgb(238, 217, 228)
    val error = Color.rgb(180, 55, 78)

    fun dp(context: Context, value: Float): Int = (value * context.resources.displayMetrics.density + .5f).toInt()
    fun round(context: Context, color: Int, radius: Float = 20f, border: Int? = null): GradientDrawable =
        GradientDrawable().apply {
            setColor(color)
            cornerRadius = dp(context, radius).toFloat()
            if (border != null) setStroke(dp(context, 1f), border)
        }

    fun ripple(context: Context, color: Int = Color.WHITE, radius: Float = 20f, border: Int? = null): RippleDrawable =
        RippleDrawable(ColorStateList.valueOf(0x22C65481), round(context, color, radius, border), round(context, Color.WHITE, radius))

    fun text(context: Context, value: String = "", size: Float = 14f, color: Int = ink, bold: Boolean = false): TextView =
        TextView(context).apply {
            text = value
            textSize = size
            setTextColor(color)
            typeface = Typeface.create("sans-serif", if (bold) Typeface.BOLD else Typeface.NORMAL)
            gravity = Gravity.CENTER_VERTICAL
            includeFontPadding = false
        }
}
