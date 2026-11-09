package com.rabbitball.app.ui

import android.animation.Animator
import android.animation.AnimatorListenerAdapter
import android.animation.AnimatorSet
import android.animation.ObjectAnimator
import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.text.TextUtils
import android.transition.ChangeBounds
import android.transition.TransitionManager
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.animation.OvershootInterpolator
import android.view.animation.PathInterpolator
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import com.rabbitball.app.SavedChat
import java.text.DateFormat
import java.util.Date
import kotlin.math.min
import kotlin.math.roundToInt

/** 历史与图片预览共用同一浮层，不创建独立系统对话框。 */
class HistoryView(context: Context, entries: List<SavedChat>) : FrameLayout(context) {
    var onOpen: ((SavedChat) -> Unit)? = null
    var onDelete: ((SavedChat) -> Boolean)? = null
    var onClosed: (() -> Unit)? = null

    private enum class State { NEW, OPEN, CLOSING, CLOSED, RELEASED }
    private var state = State.NEW
    private val records = entries.toMutableList()
    private val shade = View(context)
    private val panel = LinearLayout(context)
    private val title = Palette.text(context, "历史记录", 15f, Palette.ink, true)
    private val back = HistoryIcon(context, "back")
    private val pages = FrameLayout(context)
    private val scroll = ScrollView(context)
    private val list = LinearLayout(context)
    private val empty = Palette.text(context, "还没有对话", 14f, Palette.muted)
    private val preview = ImageView(context)
    private val status = Palette.text(context, "", 12f, Palette.error)
    private val bitmaps = mutableMapOf<ImageView, Bitmap>()
    private val rowAnimations = mutableSetOf<ValueAnimator>()
    private var surfaceAnimation: AnimatorSet? = null
    private var pageAnimation: AnimatorSet? = null
    private var previewOpen = false
    private var afterDismiss: (() -> Unit)? = null
    private val ease = PathInterpolator(.22f, 1f, .36f, 1f)
    private fun dp(value: Float) = Palette.dp(context, value)
    private val motion: Boolean get() = ValueAnimator.areAnimatorsEnabled()

    init {
        isClickable = true
        isFocusableInTouchMode = true
        shade.setBackgroundColor(0x18000000)
        shade.setOnClickListener { dismiss() }
        addView(shade, LayoutParams(-1, -1))
        panel.orientation = LinearLayout.VERTICAL
        panel.background = Palette.round(context, Color.WHITE, Palette.cornerSurface, Palette.line)
        panel.clipToOutline = true
        panel.elevation = dp(12f).toFloat()
        panel.outlineAmbientShadowColor = 0x22A46782
        panel.outlineSpotShadowColor = 0x22A46782
        panel.isClickable = true
        addView(panel, LayoutParams(-1, -1, Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL).apply {
            bottomMargin = dp(12f)
        })

        val header = LinearLayout(context).apply {
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(12f), dp(4f), dp(8f), 0)
        }
        back.contentDescription = "返回历史记录"
        back.visibility = GONE
        pressFeedback(back)
        back.setOnClickListener { showPreview(false) }
        header.addView(back, LinearLayout.LayoutParams(dp(36f), dp(44f)))
        title.setPadding(dp(8f), 0, 0, 0)
        header.addView(title, LinearLayout.LayoutParams(0, dp(52f), 1f))
        val close = HistoryIcon(context, "close").apply {
            contentDescription = "关闭历史记录"
            pressFeedback(this)
            setOnClickListener { dismiss() }
        }
        header.addView(close, LinearLayout.LayoutParams(dp(44f), dp(44f)))
        panel.addView(header, LinearLayout.LayoutParams(-1, -2))
        panel.addView(pages, LinearLayout.LayoutParams(-1, 0, 1f).apply {
            leftMargin = dp(12f); rightMargin = dp(12f); bottomMargin = dp(12f)
        })

        list.orientation = LinearLayout.VERTICAL
        scroll.isFillViewport = true
        scroll.clipToPadding = false
        scroll.addView(list, FrameLayout.LayoutParams(-1, -2))
        pages.addView(scroll, LayoutParams(-1, -1))
        empty.gravity = Gravity.CENTER
        empty.setPadding(dp(12f), dp(42f), dp(12f), dp(42f))
        pages.addView(empty, LayoutParams(-1, -1))
        preview.scaleType = ImageView.ScaleType.FIT_CENTER
        preview.contentDescription = "会话图片预览"
        preview.isClickable = true
        preview.visibility = GONE
        pages.addView(preview, LayoutParams(-1, -1))
        status.visibility = GONE
        status.setPadding(dp(20f), 0, dp(20f), dp(12f))
        panel.addView(status, LinearLayout.LayoutParams(-1, -2))

        records.forEach(::addRow)
        empty.visibility = if (records.isEmpty()) VISIBLE else GONE
        setOnApplyWindowInsetsListener { _, insets ->
            val safe = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.ime() or WindowInsets.Type.displayCutout())
            setPadding(safe.left, safe.top, safe.right, safe.bottom)
            insets
        }
    }

    private fun addRow(entry: SavedChat) {
        val row = LinearLayout(context).apply {
            gravity = Gravity.CENTER_VERTICAL
            minimumHeight = dp(72f)
            setPadding(dp(10f), dp(10f), dp(4f), dp(10f))
            background = Palette.ripple(context, Color.TRANSPARENT, Palette.cornerControl)
            isClickable = true; isFocusable = true
            contentDescription = "打开对话：${entry.title}"
            pressFeedback(this)
            setOnClickListener {
                if (state == State.OPEN) {
                    val open = onOpen
                    closeWith { open?.invoke(entry) }
                }
            }
        }
        val copy = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
        val name = Palette.text(context, entry.title, 14f).apply {
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.END
        }
        copy.addView(name, LinearLayout.LayoutParams(-1, -2))
        copy.addView(Palette.text(context, DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(entry.updatedAt)), 12f, Palette.muted),
            LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(5f) })
        row.addView(copy, LinearLayout.LayoutParams(0, -2, 1f))
        entry.preview?.let { saved ->
            val image = ImageView(context).apply {
                scaleType = ImageView.ScaleType.FIT_CENTER
                background = Palette.round(context, Color.WHITE, Palette.cornerSmall)
                foreground = Palette.round(context, Color.TRANSPARENT, Palette.cornerSmall, Palette.line)
                clipToOutline = true
                contentDescription = "查看图片：${entry.title}"
                isClickable = true; isFocusable = true
                pressFeedback(this)
                setOnClickListener {
                    if (state != State.OPEN) return@setOnClickListener
                    val bitmap = saved.decode()
                    if (bitmap == null) showError("暂时无法读取这张预览。")
                    else {
                        showPreview(true)
                        discardBitmap(preview)
                        bitmaps[preview] = bitmap
                        preview.setImageBitmap(bitmap)
                    }
                }
            }
            saved.decode(dp(256f))?.let { bitmap -> bitmaps[image] = bitmap; image.setImageBitmap(bitmap) }
            row.addView(image, LinearLayout.LayoutParams(dp(66f), dp(48f)).apply { leftMargin = dp(11f) })
        }
        val remove = HistoryIcon(context, "trash").apply {
            contentDescription = "删除对话：${entry.title}"
            pressFeedback(this)
            setOnClickListener {
                if (state == State.OPEN && onDelete?.invoke(entry) == true) removeRow(row, entry)
            }
        }
        row.addView(remove, LinearLayout.LayoutParams(dp(44f), dp(44f)))
        list.addView(row, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(5f) })
    }

    private fun removeRow(row: ViewGroup, entry: SavedChat) {
        animateBounds()
        records.remove(entry)
        row.isEnabled = false
        row.isClickable = false
        for (index in 0 until row.childCount) row.getChildAt(index).isEnabled = false
        requestLayout()
        fun finish() {
            for (index in 0 until row.childCount) (row.getChildAt(index) as? ImageView)?.let(::discardBitmap)
            list.removeView(row)
            if (records.isEmpty() && state == State.OPEN) {
                empty.visibility = VISIBLE
                if (motion) {
                    empty.alpha = 0f
                    empty.animate().alpha(1f).setDuration(180).setInterpolator(ease).start()
                }
            }
        }
        if (!motion || row.height == 0) { finish(); return }
        row.animate().cancel()
        val start = row.height
        val margin = (row.layoutParams as LinearLayout.LayoutParams).bottomMargin
        val animation = ValueAnimator.ofFloat(1f, 0f)
        rowAnimations.add(animation)
        animation.duration = 260
        animation.interpolator = ease
        animation.addUpdateListener {
            val fraction = it.animatedValue as Float
            row.alpha = fraction
            row.translationX = dp(12f) * (1f - fraction)
            (row.layoutParams as LinearLayout.LayoutParams).apply {
                height = (start * fraction).roundToInt()
                bottomMargin = (margin * fraction).roundToInt()
            }
            row.requestLayout()
        }
        animation.addListener(object : AnimatorListenerAdapter() {
            override fun onAnimationEnd(animator: Animator) {
                rowAnimations.remove(animation)
                if (state == State.OPEN) finish()
            }
        })
        animation.start()
    }

    fun show() {
        if (state != State.NEW) return
        state = State.OPEN
        requestApplyInsets()
        requestFocus()
        if (!motion) return
        shade.alpha = 0f
        panel.alpha = 0f
        panel.translationY = dp(14f).toFloat()
        panel.scaleX = .98f
        panel.scaleY = .98f
        surfaceAnimation = AnimatorSet().apply {
            playTogether(
                ObjectAnimator.ofFloat(shade, View.ALPHA, 0f, 1f),
                ObjectAnimator.ofFloat(panel, View.ALPHA, 0f, 1f),
                ObjectAnimator.ofFloat(panel, View.TRANSLATION_Y, panel.translationY, 0f),
                ObjectAnimator.ofFloat(panel, View.SCALE_X, .98f, 1f),
                ObjectAnimator.ofFloat(panel, View.SCALE_Y, .98f, 1f)
            )
            duration = 300
            interpolator = ease
            start()
        }
    }

    private fun showPreview(value: Boolean) {
        if (state != State.OPEN || previewOpen == value) return
        settlePages()
        animateBounds()
        previewOpen = value
        title.text = if (value) "图片预览" else "历史记录"
        back.visibility = if (value) VISIBLE else GONE
        val incoming = if (value) preview else scroll
        val outgoing = if (value) scroll else preview
        empty.visibility = GONE
        incoming.visibility = VISIBLE
        outgoing.visibility = VISIBLE
        requestLayout()
        if (!motion) { settlePages(); return }
        incoming.alpha = 0f
        incoming.translationX = dp(if (value) 9f else -9f).toFloat()
        pageAnimation = AnimatorSet().apply {
            playTogether(
                ObjectAnimator.ofFloat(incoming, View.ALPHA, 0f, 1f),
                ObjectAnimator.ofFloat(incoming, View.TRANSLATION_X, incoming.translationX, 0f),
                ObjectAnimator.ofFloat(outgoing, View.ALPHA, 1f, 0f)
            )
            duration = 240
            interpolator = ease
            addListener(object : AnimatorListenerAdapter() {
                override fun onAnimationEnd(animation: Animator) { if (pageAnimation === animation) settlePages() }
            })
            start()
        }
    }

    private fun settlePages() {
        pageAnimation?.removeAllListeners()
        pageAnimation?.cancel()
        pageAnimation = null
        scroll.alpha = 1f; scroll.translationX = 0f
        preview.alpha = 1f; preview.translationX = 0f
        scroll.visibility = if (previewOpen) GONE else VISIBLE
        preview.visibility = if (previewOpen) VISIBLE else GONE
        empty.visibility = if (!previewOpen && records.isEmpty()) VISIBLE else GONE
        if (!previewOpen) discardBitmap(preview)
    }

    fun showError(message: String) {
        if (state != State.OPEN) return
        animateBounds()
        status.text = message
        status.visibility = VISIBLE
        if (motion) {
            status.animate().cancel()
            status.alpha = 0f
            status.animate().alpha(1f).setDuration(180).setInterpolator(ease).start()
        }
    }

    fun handleBack(): Boolean {
        if (state == State.CLOSED || state == State.RELEASED) return false
        if (previewOpen && state == State.OPEN) showPreview(false) else dismiss()
        return true
    }

    fun dismiss(animated: Boolean = true) {
        // 返回可以撤销退场动画中尚未执行的打开记录动作。
        afterDismiss = null
        close(animated)
    }

    private fun closeWith(after: () -> Unit) {
        afterDismiss = after
        close(true)
    }

    private fun close(animated: Boolean) {
        if (state == State.CLOSED || state == State.RELEASED || (state == State.CLOSING && animated)) return
        state = State.CLOSING
        surfaceAnimation?.removeAllListeners()
        surfaceAnimation?.cancel()
        settlePages()
        fun finish() {
            if (state != State.CLOSING) return
            state = State.CLOSED
            val after = afterDismiss
            afterDismiss = null
            val closed = onClosed
            onClosed = null
            closed?.invoke()
            after?.invoke()
        }
        if (!animated || !motion || !isAttachedToWindow) { finish(); return }
        surfaceAnimation = AnimatorSet().apply {
            playTogether(
                ObjectAnimator.ofFloat(shade, View.ALPHA, shade.alpha, 0f),
                ObjectAnimator.ofFloat(panel, View.ALPHA, panel.alpha, 0f),
                ObjectAnimator.ofFloat(panel, View.TRANSLATION_Y, panel.translationY, dp(12f).toFloat()),
                ObjectAnimator.ofFloat(panel, View.SCALE_X, panel.scaleX, .985f),
                ObjectAnimator.ofFloat(panel, View.SCALE_Y, panel.scaleY, .985f)
            )
            duration = 200
            interpolator = ease
            addListener(object : AnimatorListenerAdapter() {
                override fun onAnimationEnd(animation: Animator) { finish() }
            })
            start()
        }
    }

    private fun discardBitmap(image: ImageView) {
        image.setImageDrawable(null)
        bitmaps.remove(image)?.recycle()
    }

    fun release() {
        if (state == State.RELEASED) return
        state = State.RELEASED
        TransitionManager.endTransitions(this)
        afterDismiss = null
        surfaceAnimation?.removeAllListeners(); surfaceAnimation?.cancel(); surfaceAnimation = null
        pageAnimation?.removeAllListeners(); pageAnimation?.cancel(); pageAnimation = null
        rowAnimations.toList().forEach { it.removeAllListeners(); it.cancel() }
        rowAnimations.clear()
        fun stop(view: View) {
            view.animate().cancel()
            if (view is ViewGroup) for (index in 0 until view.childCount) stop(view.getChildAt(index))
        }
        stop(this)
        bitmaps.keys.toList().forEach(::discardBitmap)
        onOpen = null; onDelete = null; onClosed = null
    }

    private fun animateBounds() {
        if (!motion || !isLaidOut || state != State.OPEN) return
        TransitionManager.beginDelayedTransition(this, ChangeBounds().apply {
            addTarget(panel)
            duration = 260
            interpolator = ease
        })
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val availableWidth = (MeasureSpec.getSize(widthMeasureSpec) - paddingLeft - paddingRight).coerceAtLeast(0)
        val availableHeight = (MeasureSpec.getSize(heightMeasureSpec) - paddingTop - paddingBottom).coerceAtLeast(0)
        val panelWidth = min(dp(480f), (availableWidth - dp(24f)).coerceAtLeast(0))
        val maximumHeight = min(dp(620f), (availableHeight * .76f).roundToInt()).coerceAtLeast(0)
        val childWidth = MeasureSpec.makeMeasureSpec((panelWidth - dp(24f)).coerceAtLeast(0), MeasureSpec.EXACTLY)
        val unlimited = MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED)
        list.measure(childWidth, unlimited)
        val header = panel.getChildAt(0)
        header.measure(MeasureSpec.makeMeasureSpec(panelWidth, MeasureSpec.EXACTLY), unlimited)
        if (status.visibility != GONE) status.measure(MeasureSpec.makeMeasureSpec(panelWidth, MeasureSpec.EXACTLY), unlimited)
        var rowsHeight = 0
        for (index in 0 until list.childCount) {
            val row = list.getChildAt(index)
            // 删除行仍在淡出，承载面直接过渡到剩余内容的尺寸。
            if (row.isEnabled) {
                val margins = row.layoutParams as LinearLayout.LayoutParams
                rowsHeight += row.measuredHeight + margins.topMargin + margins.bottomMargin
            }
        }
        val contentHeight = if (records.isEmpty()) dp(190f)
            else header.measuredHeight + rowsHeight + dp(12f)
        val desiredHeight = if (previewOpen) maximumHeight else contentHeight + if (status.visibility != GONE) status.measuredHeight else 0
        (panel.layoutParams as LayoutParams).apply {
            width = panelWidth
            height = min(maximumHeight, desiredHeight)
        }
        super.onMeasure(widthMeasureSpec, heightMeasureSpec)
    }

    override fun onDetachedFromWindow() {
        release()
        super.onDetachedFromWindow()
    }

    private fun pressFeedback(view: View) {
        view.setOnTouchListener { _, event ->
            if (motion && state == State.OPEN) when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> view.animate().scaleX(.97f).scaleY(.97f).setDuration(90).start()
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> view.animate().scaleX(1f).scaleY(1f)
                    .setDuration(240).setInterpolator(OvershootInterpolator(.6f)).start()
            }
            false
        }
    }

    private class HistoryIcon(context: Context, private val kind: String) : View(context) {
        private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.STROKE
            color = Palette.muted
            strokeWidth = 2.25f
            strokeCap = Paint.Cap.ROUND
            strokeJoin = Paint.Join.ROUND
        }
        private val path = Path()
        init {
            isClickable = true; isFocusable = true
            background = Palette.ripple(context, Color.TRANSPARENT, Palette.cornerSmall)
        }
        override fun onDraw(canvas: Canvas) {
            super.onDraw(canvas)
            val side = Palette.dp(context, 17f).toFloat()
            canvas.save()
            canvas.translate((width - side) * .5f, (height - side) * .5f)
            canvas.scale(side / 24f, side / 24f)
            path.rewind()
            when (kind) {
                "close" -> { path.moveTo(6f, 6f); path.lineTo(18f, 18f); path.moveTo(18f, 6f); path.lineTo(6f, 18f) }
                "back" -> { path.moveTo(15f, 6f); path.lineTo(9f, 12f); path.lineTo(15f, 18f) }
                "trash" -> {
                    path.moveTo(4f, 7f); path.lineTo(20f, 7f)
                    path.moveTo(9f, 7f); path.lineTo(9f, 4f); path.lineTo(15f, 4f); path.lineTo(15f, 7f)
                    path.moveTo(6f, 7f); path.lineTo(7f, 20f); path.lineTo(17f, 20f); path.lineTo(18f, 7f)
                    path.moveTo(10f, 10f); path.lineTo(10f, 17f); path.moveTo(14f, 10f); path.lineTo(14f, 17f)
                }
            }
            canvas.drawPath(path, paint)
            canvas.restore()
        }
    }
}
