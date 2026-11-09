package com.rabbitball.app.ui

import android.animation.Animator
import android.animation.AnimatorListenerAdapter
import android.animation.ValueAnimator
import android.content.Context
import android.graphics.PixelFormat
import android.graphics.PointF
import android.graphics.Rect
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.MotionEvent
import android.view.ViewConfiguration
import android.view.WindowInsets
import android.view.WindowManager
import android.view.animation.PathInterpolator
import kotlin.math.hypot
import kotlin.math.roundToInt
import kotlin.math.sin

/** 边缘陪伴只提供拖动与互动；截图和激活入口不依赖这个窗口。 */
class EdgePetOverlay(private val context: Context) {
    private val manager = context.getSystemService(WindowManager::class.java)
    private val handler = Handler(Looper.getMainLooper())
    private val dock = PetDock(context)
    private val pet = RabbitView(context)
    private val effects = PetEffectsView(context)
    private val touchSlop = ViewConfiguration.get(context).scaledTouchSlop
    private val layout = windowLayout(dock.viewWidth, dock.viewHeight, false)
    private var viewport = manager.maximumWindowMetrics
    private var attached = false
    private var effectsAttached = false
    private var released = false
    private var position = PointF()
    private var flight: ValueAnimator? = null
    private var drag: Drag? = null
    private val clearEffects = Runnable { removeEffects() }

    private data class Drag(val x: Float, val y: Float, val start: PointF, var active: Boolean = false)

    private fun windowLayout(width: Int, height: Int, passThrough: Boolean): WindowManager.LayoutParams =
        WindowManager.LayoutParams(width, height, WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
                WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
                (if (passThrough) WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE else 0),
            PixelFormat.TRANSLUCENT).apply {
            gravity = Gravity.TOP or Gravity.LEFT
            fitInsetsTypes = 0
            layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
            setTitle(if (passThrough) "兔球互动" else "兔球边缘陪伴")
        }

    init {
        pet.contentDescription = "兔球：轻点互动，拖动调整停靠位置"
        pet.onPetClick = { burst() }
        pet.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ ->
            // 仅在兔球的小型触摸窗口内保留拖动，避免屏缘返回手势抢走手指。
            pet.systemGestureExclusionRects = listOf(Rect(0, 0, pet.width, pet.height))
            updateGaze()
        }
        pet.setOnTouchListener { _, event ->
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    cancelFlight()
                    drag = Drag(event.rawX, event.rawY, PointF(position.x, position.y))
                }
                MotionEvent.ACTION_MOVE -> {
                    val current = drag
                    if (current != null) {
                        val dx = event.rawX - current.x
                        val dy = event.rawY - current.y
                        if (!current.active && hypot(dx, dy) > touchSlop) current.active = true
                        if (current.active) {
                            val metrics = viewport
                            val bounds = metrics.bounds
                            val insets = metrics.windowInsets.getInsetsIgnoringVisibility(
                                WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
                            moveTo(dock.constrain(PointF(current.start.x + dx, current.start.y + dy),
                                bounds.width(), bounds.height(), insets.top, insets.bottom), false)
                        }
                    }
                }
                MotionEvent.ACTION_UP -> finishDrag(click = true)
                MotionEvent.ACTION_CANCEL -> finishDrag(click = false)
            }
            true
        }
    }

    fun show(fromScreen: PointF? = null) {
        if (released || attached || !dock.enabled) return
        viewport = manager.maximumWindowMetrics
        val metrics = viewport
        val bounds = metrics.bounds
        val insets = metrics.windowInsets.getInsetsIgnoringVisibility(
            WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
        val target = dock.position(bounds.width(), bounds.height(), insets.top, insets.bottom)
        position = fromScreen?.let { PointF(it.x - bounds.left, it.y - bounds.top) } ?: target
        layout.x = position.x.roundToInt()
        layout.y = position.y.roundToInt()
        pet.alpha = 1f
        pet.rotation = 0f
        pet.setDockPose(dock.left, if (fromScreen == null) 1f else 0f, snap = true)
        manager.addView(pet, layout)
        attached = true
        updateGaze()
        if (fromScreen != null) flyToDock()
        else if (ValueAnimator.areAnimatorsEnabled()) {
            pet.alpha = 0f
            pet.animate().alpha(1f).setDuration(220).start()
        }
    }

    private fun finishDrag(click: Boolean) {
        val current = drag ?: return
        drag = null
        if (current.active) {
            val metrics = viewport
            val bounds = metrics.bounds
            val insets = metrics.windowInsets.getInsetsIgnoringVisibility(
                WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
            dock.remember(position, bounds.width(), bounds.height(), insets.top, insets.bottom)
            flyToDock()
        } else if (click) pet.performClick()
        else flyToDock()
    }

    private fun moveTo(point: PointF, docking: Boolean) {
        position = point
        layout.x = point.x.roundToInt()
        layout.y = point.y.roundToInt()
        manager.updateViewLayout(pet, layout)
        val metrics = viewport
        val bounds = metrics.bounds
        val insets = metrics.windowInsets.getInsetsIgnoringVisibility(
            WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
        pet.setDockPose(dock.left, if (docking) dock.amount(point, bounds.width(), bounds.height(), insets.top, insets.bottom) else 0f)
        updateGaze()
    }

    private fun updateGaze() {
        val width = viewport.bounds.width()
        val inward = position.x + dock.viewWidth * .5f < width * .5f
        pet.setGazeTarget(if (inward) pet.width * 3f else -pet.width * 2f, pet.height * .6f)
    }

    private fun flyToDock() {
        cancelFlight()
        val metrics = viewport
        val bounds = metrics.bounds
        val insets = metrics.windowInsets.getInsetsIgnoringVisibility(
            WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
        val target = dock.position(bounds.width(), bounds.height(), insets.top, insets.bottom)
        if (!ValueAnimator.areAnimatorsEnabled()) {
            moveTo(target, true)
            pet.rotation = 0f
            return
        }
        val start = PointF(position.x, position.y)
        val arc = Palette.dp(context, 24f)
        val animation = ValueAnimator.ofFloat(0f, 1f)
        flight = animation
        animation.duration = 600
        animation.interpolator = PathInterpolator(.2f, .8f, .2f, 1f)
        animation.addUpdateListener {
            val t = it.animatedValue as Float
            val lift = sin(t * Math.PI).toFloat()
            moveTo(PointF(start.x + (target.x - start.x) * t, start.y + (target.y - start.y) * t - lift * arc), true)
            pet.rotation = lift * if (target.x > start.x) 6f else -6f
        }
        animation.addListener(object : AnimatorListenerAdapter() {
            override fun onAnimationEnd(animation: Animator) {
                if (flight !== animation) return
                flight = null
                moveTo(target, true)
                pet.rotation = 0f
            }
        })
        animation.start()
    }

    private fun cancelFlight() {
        val previous = flight
        flight = null
        previous?.cancel()
        pet.animate().cancel()
        pet.alpha = 1f
        pet.rotation = 0f
    }

    private fun burst() {
        if (!ValueAnimator.areAnimatorsEnabled()) return
        if (!effectsAttached) {
            manager.addView(effects, windowLayout(WindowManager.LayoutParams.MATCH_PARENT,
                WindowManager.LayoutParams.MATCH_PARENT, true))
            effectsAttached = true
        }
        effects.burst(pet)
        handler.removeCallbacks(clearEffects)
        // 爱心寿命为2.5个模拟秒，角色模拟速率为1.25倍，之后释放透明效果窗口。
        handler.postDelayed(clearEffects, 2_100)
    }

    private fun removeEffects() {
        handler.removeCallbacks(clearEffects)
        if (effectsAttached) manager.removeViewImmediate(effects)
        effectsAttached = false
    }

    fun hide() {
        if (!attached) return
        if (drag?.active == true) {
            val metrics = viewport
            val bounds = metrics.bounds
            val insets = metrics.windowInsets.getInsetsIgnoringVisibility(
                WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
            dock.remember(position, bounds.width(), bounds.height(), insets.top, insets.bottom)
        }
        drag = null
        cancelFlight()
        removeEffects()
        manager.removeViewImmediate(pet)
        attached = false
    }

    fun release() {
        hide()
        released = true
        handler.removeCallbacksAndMessages(null)
    }
}
