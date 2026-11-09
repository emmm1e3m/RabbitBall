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
import com.rabbitball.app.AppSettings
import com.rabbitball.app.AppearanceConfig
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
    private var appearance = AppSettings(context).loadAppearance()
    private var colors = RabbitColors.from(appearance)
    internal val heartColors: IntArray get() = colors.hearts
    private var bodyFill = RadialGradient(
        224f, 178f, 236f,
        colors.sphere,
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
    private val tuck = Spring()
    private var dockOnLeft = false
    private var dockAmount = 0f
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

    /** 草稿预览与实际角色共用调色公式；尺寸由承载布局控制。 */
    fun applyAppearance(config: AppearanceConfig) {
        if (appearance == config) return
        appearance = config
        colors = RabbitColors.from(config)
        bodyFill = RadialGradient(224f, 178f, 236f, colors.sphere,
            floatArrayOf(0f, .32f, .68f, .9f, 1f), Shader.TileMode.CLAMP)
        invalidate()
    }

    /** 只改变停靠姿态；球心的屏外位置和朝内注视由承载层提供。 */
    fun setDockPose(left: Boolean, amount: Float, snap: Boolean = false) {
        dockOnLeft = left
        dockAmount = amount.coerceIn(0f, 1f)
        if (snap || !ValueAnimator.areAnimatorsEnabled()) {
            tuck.position = dockAmount
            tuck.velocity = 0f
            faceX.position = lerp(desiredGazeX + facing.position * 70f, if (dockOnLeft) 133f else -63f, dockAmount)
            faceY.position = lerp(desiredGazeY, 40f, dockAmount)
            faceX.velocity = 0f
            faceY.velocity = 0f
        }
        syncMotion()
        invalidate()
    }

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
        syncMotion()
    }

    override fun onDetachedFromWindow() {
        syncMotion(false)
        animate().cancel()
        super.onDetachedFromWindow()
    }

    override fun onVisibilityAggregated(isVisible: Boolean) {
        super.onVisibilityAggregated(isVisible)
        syncMotion(isVisible)
    }

    private fun syncMotion(visible: Boolean = isShown) {
        if (!visible || !isAttachedToWindow || !isShown || windowVisibility != VISIBLE || !ValueAnimator.areAnimatorsEnabled()) {
            motion?.cancel()
            motion = null
            lastFrameTime = 0L
            return
        }
        if (motion != null) return
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
        step(tuck, dockAmount, dt, 13f, 0.86f)
        val tucked = tuck.position.coerceIn(0f, 1f)
        step(facing, facingTarget, dt, 11f, 0.88f)
        val turn = facing.position.coerceIn(0f, 1f)
        step(faceX, lerp(desiredGazeX + turn * 70f, if (dockOnLeft) 133f else -63f, tucked), dt, 13f, 0.84f)
        step(faceY, lerp(desiredGazeY, 40f, tucked), dt, 12f, 0.82f)
        step(glint, turn * 120f + desiredLightOffset, dt, 7.8f, 0.82f)
    }

    private fun lerp(from: Float, to: Float, amount: Float) = from + (to - from) * amount

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
        val tucked = if (animationsEnabled) tuck.position.coerceIn(0f, 1f) else dockAmount
        val seconds = SystemClock.uptimeMillis() / 1000.0
        val wave = if (animationsEnabled) sin(seconds * 2.0 * PI / 4.8).toFloat() else 0f
        // 不同周期的平滑叠加提供自然漂移；位置不依赖重复动画的进度归零。
        val driftX = if (animationsEnabled) {
            (sin(seconds * 0.83) * 7.0 + sin(seconds * 1.29 + 1.7) * 3.0).toFloat() * (1f - tucked)
        } else 0f
        val driftY = if (animationsEnabled) {
            (sin(seconds * 1.13) * 9.0 + sin(seconds * 0.61 + 2.4) * 3.0).toFloat() * (1f - tucked)
        } else 0f
        val turn = if (animationsEnabled) facing.position.coerceIn(0f, 1f) else facingTarget
        val displayedFaceX = if (animationsEnabled) faceX.position else
            lerp(desiredGazeX + turn * 70f, if (dockOnLeft) 133f else -63f, tucked)
        val displayedFaceY = if (animationsEnabled) faceY.position else lerp(desiredGazeY, 40f, tucked)
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

        drawEar(canvas, lerp(144f, if (dockOnLeft) 144f else 130f, tucked),
            lerp(140f + turn * 5f, if (dockOnLeft) 145f else 160f, tucked),
            lerp(15f - turn * 45f + if (animationsEnabled) earLeft.position else 0f,
                if (dockOnLeft) -20f else -30f, tucked))
        drawEar(canvas, lerp(216f, if (dockOnLeft) 230f else 216f, tucked),
            lerp(145f - turn * 5f, if (dockOnLeft) 160f else 145f, tucked),
            lerp(30f - turn * 45f + if (animationsEnabled) earRight.position else 0f,
                if (dockOnLeft) 30f else 20f, tucked))

        // 眨眼只占周期的一小段，静止和思考时均保持原版的红色竖眼。
        val blink = if (animationsEnabled && phase in 0.77f..0.81f) {
            1f - sin((phase - 0.77f) / 0.04f * PI).toFloat() * 0.93f
        } else 1f
        val eyeOpen = blink * (1f - displayedHappy * 0.18f) * lerp(1f, .65f, tucked)
        val eyeWide = (1f + displayedHappy * 0.12f) * lerp(1f, .58f, tucked)
        val expression = ((displayedHappy - 0.32f) / 0.28f).coerceIn(0f, 1f)
        canvas.save()
        canvas.translate(displayedFaceX, displayedFaceY)
        drawEye(canvas, 118f, 199f, 18f * tucked, tucked, leftSqueezedEye, eyeWide, eyeOpen, expression)
        drawEye(canvas, 172f, 201f, -18f * tucked, -tucked, rightSqueezedEye, eyeWide, eyeOpen, expression)
        paint.color = colors.eye
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
            paint.color = colors.signal
            paint.alpha = (75f + abs(wave) * 65f).toInt()
            canvas.drawLine(100f, scanY, 204f, scanY, paint)
            paint.style = Paint.Style.FILL
        }
        canvas.restore()
    }

    private fun drawEar(canvas: Canvas, x: Float, y: Float, angle: Float) {
        canvas.save()
        canvas.translate(x, y)
        canvas.rotate(angle)
        paint.color = colors.ear
        oval.set(-20f, -65f, 20f, 5f)
        canvas.drawRoundRect(oval, 20f, 20f, paint)
        canvas.restore()
    }

    private fun drawEye(
        canvas: Canvas,
        centerX: Float,
        centerY: Float,
        offsetX: Float,
        offsetY: Float,
        squeezed: Path,
        eyeWide: Float,
        eyeOpen: Float,
        expression: Float,
    ) {
        canvas.save()
        canvas.translate(offsetX, offsetY)
        canvas.scale(eyeWide, 1f, centerX, centerY)
        paint.color = colors.eye
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
            syncMotion()
            invalidate()
        }
        val handled = super.performClick()
        onPetClick?.invoke()
        return handled || onPetClick != null
    }
}

/** 与 PC settings-ui.js 的 derive、mix、readable 保持同源数值。 */
private data class RabbitColors(val sphere: IntArray, val ear: Int, val eye: Int, val signal: Int, val hearts: IntArray) {
    companion object {
        fun from(config: AppearanceConfig): RabbitColors {
            val body = config.bodyColor
            val eye = config.eyeColor
            val seed = mix(body, eye, .23f)
            var accent = seed
            repeat(18) { if (1.05 / (luminance(accent) + .05) < 3.3) accent = darken(accent, .9f) }
            return RabbitColors(
                intArrayOf(mix(body, Color.WHITE, .65f), mix(body, Color.WHITE, .35f),
                    mix(body, Color.WHITE, .08f), darken(body, .96f), mix(body, Color.WHITE, .14f)),
                mix(body, Color.WHITE, .6f), eye, mix(body, eye, .62f),
                intArrayOf(accent, mix(body, Color.WHITE, .32f), mix(body, eye, .38f)))
        }

        private fun mix(a: Int, b: Int, ratio: Float) = Color.rgb(
            (Color.red(a) * (1f - ratio) + Color.red(b) * ratio).roundToInt(),
            (Color.green(a) * (1f - ratio) + Color.green(b) * ratio).roundToInt(),
            (Color.blue(a) * (1f - ratio) + Color.blue(b) * ratio).roundToInt())

        private fun darken(color: Int, factor: Float) = Color.rgb(
            (Color.red(color) * factor).roundToInt(), (Color.green(color) * factor).roundToInt(),
            (Color.blue(color) * factor).roundToInt())

        private fun luminance(color: Int): Double {
            fun channel(value: Int): Double {
                val s = value / 255.0
                return if (s <= .04045) s / 12.92 else Math.pow((s + .055) / 1.055, 2.4)
            }
            return channel(Color.red(color)) * .2126 + channel(Color.green(color)) * .7152 + channel(Color.blue(color)) * .0722
        }
    }
}
