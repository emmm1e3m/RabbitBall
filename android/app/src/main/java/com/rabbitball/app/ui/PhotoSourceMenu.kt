package com.rabbitball.app.ui

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.animation.OvershootInterpolator
import android.view.animation.PathInterpolator
import android.widget.LinearLayout
import android.widget.PopupWindow

/** 锚定输入按钮的局部菜单，选择在退出完成后交接给相机或系统选图。 */
internal class PhotoSourceMenu(
    private val context: Context,
    onCamera: () -> Unit,
    onUpload: () -> Unit
) : PopupWindow(context) {
    private val panel = LinearLayout(context)
    private val ease = PathInterpolator(.2f, .8f, .2f, 1f)
    private var closing = false
    private var pendingAction: (() -> Unit)? = null
    private var owner: View? = null
    private var contentWidth = 0f

    private fun dp(value: Float) = Palette.dp(context, value)

    init {
        panel.orientation = LinearLayout.VERTICAL
        panel.setPadding(dp(6f), dp(6f), dp(6f), dp(6f))
        panel.background = Palette.round(context, Color.WHITE, Palette.cornerSurface, Palette.line)
        panel.clipToOutline = true
        panel.addView(option("camera", "拍照", onCamera))
        panel.addView(option("photo", "上传照片", onUpload))
        contentView = panel
        width = kotlin.math.ceil(maxOf(dp(144f).toFloat(), contentWidth)).toInt()
        height = ViewGroup.LayoutParams.WRAP_CONTENT
        isFocusable = true
        isOutsideTouchable = true
        inputMethodMode = INPUT_METHOD_NOT_NEEDED
        animationStyle = 0
        elevation = dp(8f).toFloat()
        setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
        setIsClippedToScreen(true)
    }

    private fun option(kind: String, title: String, action: () -> Unit): View =
        LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(8f), 0, dp(12f), 0)
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(48f))
            background = Palette.ripple(context, Color.TRANSPARENT, Palette.cornerSmall)
            contentDescription = title
            isClickable = true
            isFocusable = true
            addView(ActionIcon(context, kind).apply {
                inkColor = Palette.ink
                isClickable = false
                isFocusable = false
                importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
                isDuplicateParentStateEnabled = true
            }, LinearLayout.LayoutParams(dp(32f), dp(32f)))
            addView(Palette.text(context, title, 14f).apply {
                importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
                contentWidth = maxOf(contentWidth, paint.measureText(title) + dp(72f))
            }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f).apply {
                leftMargin = dp(8f)
            })
            setOnTouchListener { _, event ->
                if (ValueAnimator.areAnimatorsEnabled()) {
                    when (event.actionMasked) {
                        MotionEvent.ACTION_DOWN -> animate().scaleX(.97f).scaleY(.97f)
                            .setDuration(90).setInterpolator(ease).start()
                        MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> animate().scaleX(1f).scaleY(1f)
                            .setDuration(220).setInterpolator(OvershootInterpolator(.65f)).start()
                    }
                }
                false
            }
            setOnClickListener {
                if (isShowing && !closing) {
                    pendingAction = action
                    dismiss()
                }
            }
        }

    fun show(anchor: View, alignTo: View) {
        if (isShowing || !anchor.isAttachedToWindow || anchor.windowToken == null) return
        owner = anchor
        closing = false
        pendingAction = null
        panel.animate().cancel()
        panel.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED))
        val anchorPosition = IntArray(2)
        val alignedPosition = IntArray(2)
        anchor.getLocationOnScreen(anchorPosition)
        alignTo.getLocationOnScreen(alignedPosition)
        val horizontalOffset = alignedPosition[0] - anchorPosition[0]
        panel.pivotX = anchor.width * .5f - horizontalOffset
        panel.pivotY = panel.measuredHeight.toFloat()
        val animated = ValueAnimator.areAnimatorsEnabled()
        panel.alpha = if (animated) 0f else 1f
        panel.scaleX = if (animated) .94f else 1f
        panel.scaleY = panel.scaleX
        panel.translationY = if (animated) dp(6f).toFloat() else 0f
        showAsDropDown(anchor, horizontalOffset, -anchor.height - panel.measuredHeight - dp(8f), Gravity.START)
        if (animated) panel.animate().alpha(1f).scaleX(1f).scaleY(1f).translationY(0f)
            .setDuration(220).setInterpolator(OvershootInterpolator(.55f)).start()
    }

    override fun dismiss() {
        if (!isShowing || closing) return
        closing = true
        panel.animate().cancel()
        if (!ValueAnimator.areAnimatorsEnabled()) {
            finishDismiss()
            return
        }
        panel.animate().alpha(0f).scaleX(.97f).scaleY(.97f).translationY(dp(4f).toFloat())
            .setDuration(160).setInterpolator(ease).withEndAction { finishDismiss() }.start()
    }

    private fun finishDismiss() {
        val action = pendingAction
        val anchor = owner
        pendingAction = null
        owner = null
        closing = false
        super.dismiss()
        if (anchor?.isAttachedToWindow == true && anchor.windowVisibility == View.VISIBLE) action?.invoke()
    }

    /** 宿主暂停或解绑时不执行已经失去界面的选项。 */
    fun dismissImmediately() {
        pendingAction = null
        owner = null
        closing = false
        panel.animate().cancel()
        super.dismiss()
    }
}
