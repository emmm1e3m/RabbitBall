package com.rabbitball.app.ui

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RadialGradient
import android.graphics.RectF
import android.graphics.Shader
import android.os.SystemClock
import android.util.AttributeSet
import android.view.View
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin

/** 沿用桌面版的球体、短耳与高光比例；所有尺寸以原始 360×400 画布为准。 */
class RabbitView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
) : View(context, attrs) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val oval = RectF()
    private val gradientMatrix = Matrix()
    private val leftSqueezedEye = Path().apply {
        moveTo(109f, 187f)
        lineTo(124f, 199f)
        lineTo(109f, 211f)
    }
    private val rightSqueezedEye = Path().apply {
        moveTo(181f, 189f)
        lineTo(166f, 201f)
        lineTo(181f, 213f)
    }
    private val bodyFill = RadialGradient(
        224f, 178f, 236f,
        intArrayOf(
            Color.rgb(255, 217, 230), Color.rgb(255, 183, 207),
            Color.rgb(247, 154, 187), Color.rgb(239, 134, 174), Color.rgb(243, 161, 190),
        ),
        floatArrayOf(0f, 0.32f, 0.68f, 0.9f, 1f),
        Shader.TileMode.CLAMP,
    )
    private var phase = 0f
    private var motion: ValueAnimator? = null
    private var lastFrameTime = 0L
    private var simulationTime = 0f
    internal val animationTime: Float get() = simulationTime
    private var happy = 0f
    private val squash = Spring()
    private val earLeft = Spring()
    private val earRight = Spring()
    private val facing = Spring()
    private var facingTarget = 0f
    private val faceX = Spring()
    private val faceY = Spring()
    private val glint = Spring()
    private var desiredGazeX = 0f
    private var desiredGazeY = 0f
    private var desiredLightOffset = 0f

    internal var artworkOffsetX = 0f
        private set
    internal var artworkOffsetY = 0f
        private set

    var thinking: Boolean = false
        set(value) {
            field = value
            invalidate()
        }

    var onPetClick: (() -> Unit)? = null

    /** 目标使用本视图的像素坐标，可传入视图外的输入框位置。 */
    fun setGazeTarget(x: Float, y: Float, inputFocused: Boolean = false) {
        val scale = min(width / 360f, height / 400f)
        if (scale <= 0f) return
        val targetX = (x - (width - 360f * scale) / 2f) / scale
        val targetY = (y - (height - 400f * scale) / 2f) / scale
        val dx = targetX - 180f
        val dy = targetY - 240f
        // 与桌面版相同的方向迟滞：靠近球心时保留已有朝向。
        if (dx > 18f) facingTarget = 1f
        else if (dx < -18f) facingTarget = 0f
        desiredGazeX = (dx / 80f).coerceIn(-1f, 1f) * 10f
        desiredGazeY = (dy / 90f).coerceIn(-1f, 1f) * if (inputFocused) 11f else 7f
        desiredLightOffset = (dy / 360f).coerceIn(-1f, 1f) * 18f
        invalidate()
    }

    fun clearGazeTarget() {
        desiredGazeX = 0f
        desiredGazeY = 0f
        desiredLightOffset = 0f
        invalidate()
    }

    init {
        contentDescription = "兔球"
        isClickable = true
        isFocusable = false
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        startMotion()
    }

    override fun onDetachedFromWindow() {
        motion?.cancel()
        motion = null
        animate().cancel()
        lastFrameTime = 0L
        super.onDetachedFromWindow()
    }

    override fun onWindowVisibilityChanged(visibility: Int) {
        super.onWindowVisibilityChanged(visibility)
        if (visibility == VISIBLE && isAttachedToWindow) startMotion()
        else {
            motion?.cancel()
            motion = null
            lastFrameTime = 0L
        }
    }

    private fun startMotion() {
        if (motion != null || !ValueAnimator.areAnimatorsEnabled()) return
        lastFrameTime = 0L
        motion = ValueAnimator.ofFloat(0f, 1f).apply {
            duration = 4800L
            repeatCount = ValueAnimator.INFINITE
            interpolator = android.view.animation.LinearInterpolator()
            addUpdateListener {
                phase = it.animatedValue as Float
                advanceSimulation()
                invalidate()
            }
            start()
        }
    }

    private class Spring(var position: Float = 0f, var velocity: Float = 0f)

    /** 与桌面版共用时间倍率、阻尼和子步积分，点击只累加速度冲量。 */
    private fun advanceSimulation() {
        val now = SystemClock.uptimeMillis()
        val elapsed = if (lastFrameTime == 0L) 1f / 60f else (now - lastFrameTime) / 1000f
        lastFrameTime = now
        if (!ValueAnimator.areAnimatorsEnabled()) return
        val dt = elapsed.coerceIn(0f, 0.04f) * 1.25f
        simulationTime += dt
        happy = (happy - dt * 0.47f).coerceAtLeast(0f)
        step(squash, sin(simulationTime * 2.1f) * 0.012f, dt, 13f, 0.52f)
        val earIdle = sin(simulationTime * 1.7f) * 2f
        step(earLeft, earIdle, dt, 10.6f, 0.51f)
        step(earRight, -earIdle * 0.6f, dt, 9.1f, 0.48f)
        step(facing, facingTarget, dt, 11f, 0.88f)
        val turn = facing.position.coerceIn(0f, 1f)
        step(faceX, desiredGazeX + turn * 70f, dt, 13f, 0.84f)
        step(faceY, desiredGazeY, dt, 12f, 0.82f)
        step(glint, turn * 120f + desiredLightOffset, dt, 7.8f, 0.82f)
    }

    private fun step(spring: Spring, target: Float, dt: Float, frequency: Float, damping: Float) {
        val count = max(1, ceil(dt * 120f).toInt())
        val h = dt / count
        repeat(count) {
            spring.velocity += (frequency * frequency * (target - spring.position) -
                2f * damping * frequency * spring.velocity) * h
            spring.position += spring.velocity * h
        }
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        if (width == 0 || height == 0) return
        val scale = min(width / 360f, height / 400f)
        canvas.save()
        canvas.translate((width - 360f * scale) / 2f, (height - 400f * scale) / 2f)
        canvas.scale(scale, scale)
        val animationsEnabled = ValueAnimator.areAnimatorsEnabled()
        val seconds = SystemClock.uptimeMillis() / 1000.0
        val wave = if (animationsEnabled) sin(seconds * 2.0 * PI / 4.8).toFloat() else 0f
        // 不同周期的平滑叠加提供自然漂移；位置不依赖重复动画的进度归零。
        val driftX = if (animationsEnabled) {
            (sin(seconds * 0.83) * 7.0 + sin(seconds * 1.29 + 1.7) * 3.0).toFloat()
        } else 0f
        val driftY = if (animationsEnabled) {
            (sin(seconds * 1.13) * 9.0 + sin(seconds * 0.61 + 2.4) * 3.0).toFloat()
        } else 0f
        val turn = if (animationsEnabled) facing.position.coerceIn(0f, 1f) else facingTarget
        val displayedFaceX = if (animationsEnabled) faceX.position else desiredGazeX + turn * 70f
        val displayedFaceY = if (animationsEnabled) faceY.position else desiredGazeY
        val displayedGlint = if (animationsEnabled) glint.position else turn * 120f + desiredLightOffset
        val displayedHappy = if (animationsEnabled) happy else 0f
        val displayedSquash = if (animationsEnabled) squash.position else 0f
        artworkOffsetX = driftX * scale
        artworkOffsetY = driftY * scale
        canvas.translate(driftX, driftY)
        canvas.scale(1f - displayedSquash + displayedHappy * 0.012f, 1f + displayedSquash, 180f, 240f)

        paint.style = Paint.Style.FILL
        paint.shader = null
        paint.color = Color.WHITE
        canvas.drawCircle(180f, 240f, 137f, paint)
        gradientMatrix.setTranslate(-88f * turn, 0f)
        bodyFill.setLocalMatrix(gradientMatrix)
        paint.shader = bodyFill
        canvas.drawCircle(180f, 240f, 123f, paint)
        paint.shader = null

        drawEar(canvas, 144f, 140f + turn * 5f,
            15f - turn * 45f + if (animationsEnabled) earLeft.position else 0f)
        drawEar(canvas, 216f, 145f - turn * 5f,
            30f - turn * 45f + if (animationsEnabled) earRight.position else 0f)

        // 眨眼只占周期的一小段，静止和思考时均保持原版的红色竖眼。
        val blink = if (animationsEnabled && phase in 0.77f..0.81f) {
            1f - sin((phase - 0.77f) / 0.04f * PI).toFloat() * 0.93f
        } else 1f
        val eyeOpen = blink * (1f - displayedHappy * 0.18f)
        val eyeWide = 1f + displayedHappy * 0.12f
        val expression = ((displayedHappy - 0.32f) / 0.28f).coerceIn(0f, 1f)
        canvas.save()
        canvas.translate(displayedFaceX, displayedFaceY)
        drawEye(canvas, 118f, 199f, leftSqueezedEye, eyeWide, eyeOpen, expression)
        drawEye(canvas, 172f, 201f, rightSqueezedEye, eyeWide, eyeOpen, expression)
        paint.color = Color.rgb(249, 0, 64)
        paint.alpha = (expression * 255f).roundToInt()
        oval.set(138f, 216f, 155f, 223f)
        canvas.drawRoundRect(oval, 3.5f, 3.5f, paint)
        paint.alpha = 255
        canvas.restore()

        canvas.save()
        canvas.rotate(displayedGlint, 180f, 240f)
        paint.color = Color.WHITE
        paint.style = Paint.Style.STROKE
        paint.strokeWidth = 13f
        paint.strokeCap = Paint.Cap.ROUND
        oval.set(74f, 134f, 286f, 346f)
        canvas.drawArc(oval, 6f, 48f, false, paint)
        paint.style = Paint.Style.FILL
        canvas.save()
        canvas.rotate(15f, 283f, 216f)
        canvas.drawOval(276f, 207f, 290f, 225f, paint)
        canvas.restore()
        canvas.restore()

        if (thinking) {
            val scanY = 177f + (phase * 2f % 1f) * 75f
            paint.style = Paint.Style.STROKE
            paint.strokeWidth = 3f
            paint.color = Color.argb((75f + abs(wave) * 65f).toInt(), 212, 66, 124)
            canvas.drawLine(100f, scanY, 204f, scanY, paint)
            paint.style = Paint.Style.FILL
        }
        canvas.restore()
    }

    private fun drawEar(canvas: Canvas, x: Float, y: Float, angle: Float) {
        canvas.save()
        canvas.translate(x, y)
        canvas.rotate(angle)
        paint.color = Color.rgb(255, 215, 227)
        oval.set(-20f, -65f, 20f, 5f)
        canvas.drawRoundRect(oval, 20f, 20f, paint)
        canvas.restore()
    }

    private fun drawEye(
        canvas: Canvas,
        centerX: Float,
        centerY: Float,
        squeezed: Path,
        eyeWide: Float,
        eyeOpen: Float,
        expression: Float,
    ) {
        canvas.save()
        canvas.scale(eyeWide, 1f, centerX, centerY)
        paint.color = Color.rgb(249, 0, 64)
        paint.style = Paint.Style.FILL
        paint.alpha = ((1f - expression) * 255f).roundToInt()
        canvas.save()
        canvas.scale(1f, eyeOpen, centerX, centerY)
        oval.set(centerX - 11f, centerY - 17.5f, centerX + 11f, centerY + 17.5f)
        canvas.drawRoundRect(oval, 11f, 11f, paint)
        canvas.restore()
        paint.style = Paint.Style.STROKE
        paint.strokeWidth = 11.5f
        paint.strokeCap = Paint.Cap.ROUND
        paint.strokeJoin = Paint.Join.ROUND
        paint.alpha = (expression * 255f).roundToInt()
        canvas.drawPath(squeezed, paint)
        paint.style = Paint.Style.FILL
        paint.alpha = 255
        canvas.restore()
    }

    override fun performClick(): Boolean {
        if (ValueAnimator.areAnimatorsEnabled()) {
            happy = 1f
            squash.velocity -= 1.9f
            earLeft.velocity -= 95f
            earRight.velocity += 120f
            if (isAttachedToWindow) startMotion()
            invalidate()
        }
        val handled = super.performClick()
        onPetClick?.invoke()
        return handled || onPetClick != null
    }
}
