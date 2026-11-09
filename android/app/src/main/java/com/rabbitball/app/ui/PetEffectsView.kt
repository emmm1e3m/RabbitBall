package com.rabbitball.app.ui

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.view.View
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin
import kotlin.random.Random

/** 直接沿用 PC 的爱心、信号池与 360×400 坐标及模拟时间公式。 */
class PetEffectsView(context: Context) : View(context) {
    private data class Heart(
        var birth: Float = Float.NEGATIVE_INFINITY,
        var x: Float = 0f,
        var y: Float = 0f,
        var velocityX: Float = 0f,
        var velocityY: Float = 0f,
        var scale: Float = 1f,
        var rotation: Float = 0f
    )

    private data class Signal(
        var birth: Float = Float.NEGATIVE_INFINITY,
        var life: Float = 1f,
        var angle: Float = 0f,
        var speed: Float = 90f,
        var scale: Float = 1f
    )

    private val hearts = Array(14) { Heart() }
    private val signals = Array(2) { Signal() }
    private var nextHeart = 0
    private var sourcePet: RabbitView? = null
    private var thinking = false
    private var nextSignal = Float.POSITIVE_INFINITY
    private val petLocation = IntArray(2)
    private val effectLocation = IntArray(2)
    private val petAnchor = FloatArray(4)
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val shape = Path().apply {
        moveTo(0f, 6f)
        cubicTo(-19f, -7f, -10f, -22f, 0f, -12f)
        cubicTo(10f, -22f, 19f, -7f, 0f, 6f)
        close()
    }
    private val signalShape = Path().apply {
        moveTo(-31f, -17f)
        quadTo(0f, -39f, 31f, -17f)
        moveTo(-17f, 0f)
        quadTo(0f, -14f, 17f, 0f)
    }

    init {
        isClickable = false
        isFocusable = false
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
    }

    fun burst(pet: RabbitView) {
        if (!ValueAnimator.areAnimatorsEnabled()) return
        sourcePet = pet
        // PC 的普通点击固定 burst(5, 2)，连点写入环形池，不改变数量或倍率。
        repeat(5) {
            val heart = hearts[nextHeart]
            nextHeart = (nextHeart + 1) % hearts.size
            heart.birth = pet.animationTime
            heart.x = 160f + (Random.nextFloat() - .5f) * 105f
            heart.y = 190f + Random.nextFloat() * 55f
            heart.velocityX = (Random.nextFloat() - .5f) * 72f
            heart.velocityY = -38f - Random.nextFloat() * 50f
            heart.scale = (.32f + Random.nextFloat() * .38f) * 2f
            heart.rotation = (Random.nextFloat() - .5f) * 40f
        }
        invalidate()
    }

    fun setThinking(pet: RabbitView, active: Boolean) {
        if (!active || !canAnimate(pet)) {
            clearSignals()
            invalidate()
            return
        }
        if (thinking && sourcePet === pet) return
        clearSignals()
        sourcePet = pet
        thinking = true
        nextSignal = pet.animationTime + .08f
        invalidate()
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val pet = sourcePet ?: return
        if (!canAnimate(pet)) {
            clearEffects()
            return
        }
        val colors = pet.heartColors
        val simulationTime = pet.animationTime
        if (thinking && simulationTime >= nextSignal) {
            signals.firstOrNull { simulationTime - it.birth >= it.life }?.apply {
                birth = simulationTime
                life = 1.65f + Random.nextFloat() * .35f
                angle = -PI.toFloat() / 2f + (Random.nextFloat() - .5f) * 1.35f
                speed = 82f + Random.nextFloat() * 22f
                scale = .74f + Random.nextFloat() * .18f
            }
            nextSignal = simulationTime + 1.05f + Random.nextFloat() * .3f
        }
        val artworkScale = min(pet.width / 360f, pet.height / 400f)
        pet.getLocationOnScreen(petLocation)
        getLocationOnScreen(effectLocation)
        // 屏幕坐标已包含局部原点的变换；只补上变换后的球心相对位移。
        petAnchor[0] = 0f
        petAnchor[1] = 0f
        petAnchor[2] = (pet.width - artworkScale * 360f) / 2f + pet.artworkOffsetX + 180f * artworkScale
        petAnchor[3] = (pet.height - artworkScale * 400f) / 2f + pet.artworkOffsetY + 240f * artworkScale
        pet.matrix.mapPoints(petAnchor)
        canvas.save()
        canvas.translate(
            petLocation[0] - effectLocation[0] + petAnchor[2] - petAnchor[0] - 180f * artworkScale,
            petLocation[1] - effectLocation[1] + petAnchor[3] - petAnchor[1] - 240f * artworkScale
        )
        canvas.scale(artworkScale, artworkScale)
        var active = thinking
        for (signal in signals) {
            val age = simulationTime - signal.birth
            if (age < 0f || age >= signal.life) continue
            active = true
            val progress = age / signal.life
            val radius = 184f + signal.speed * age
            val scale = signal.scale * (1f + progress * .22f)
            paint.color = pet.signalColor
            paint.alpha = (sin(progress * PI).pow(.75) * 255).toInt().coerceIn(0, 255)
            canvas.save()
            canvas.translate(180f + cos(signal.angle) * radius, 240f + sin(signal.angle) * radius)
            canvas.rotate(signal.angle * 180f / PI.toFloat() + 90f)
            canvas.scale(scale, scale)
            paint.style = Paint.Style.STROKE
            paint.strokeWidth = 11.5f
            paint.strokeCap = Paint.Cap.ROUND
            canvas.drawPath(signalShape, paint)
            paint.style = Paint.Style.FILL
            canvas.drawCircle(0f, 15f, 6.5f, paint)
            canvas.restore()
        }
        hearts.forEachIndexed { index, heart ->
            val age = simulationTime - heart.birth
            if (age < 0f || age > 2.5f) return@forEachIndexed
            active = true
            val fade = sin(min(age / .22f, 1f) * Math.PI / 2).toFloat() * (1f - age / 2.5f).pow(1.4f)
            val size = heart.scale * (.7f + min(age * 3f, 1f) * .3f)
            paint.color = colors[index % colors.size]
            paint.alpha = (fade * 255).toInt().coerceIn(0, 255)
            canvas.save()
            canvas.translate(
                heart.x + heart.velocityX * age + sin(age * 4f) * 6f,
                heart.y + heart.velocityY * age - 12f * age * age
            )
            canvas.rotate(heart.rotation + age * heart.velocityX * .25f)
            canvas.scale(size, size)
            canvas.drawPath(shape, paint)
            canvas.restore()
        }
        canvas.restore()
        if (active) postInvalidateOnAnimation()
    }

    private fun canAnimate(pet: RabbitView): Boolean =
        ValueAnimator.areAnimatorsEnabled() && isAttachedToWindow && isShown &&
            windowVisibility == VISIBLE && pet.isAttachedToWindow && pet.isShown && pet.windowVisibility == VISIBLE

    private fun clearSignals() {
        thinking = false
        nextSignal = Float.POSITIVE_INFINITY
        for (signal in signals) signal.birth = Float.NEGATIVE_INFINITY
    }

    private fun clearEffects() {
        clearSignals()
        for (heart in hearts) heart.birth = Float.NEGATIVE_INFINITY
    }

    override fun onVisibilityAggregated(isVisible: Boolean) {
        super.onVisibilityAggregated(isVisible)
        if (!isVisible) clearEffects()
    }

    override fun onWindowVisibilityChanged(visibility: Int) {
        super.onWindowVisibilityChanged(visibility)
        if (visibility != VISIBLE) clearEffects()
    }

    override fun onDetachedFromWindow() {
        clearEffects()
        sourcePet = null
        super.onDetachedFromWindow()
    }
}
