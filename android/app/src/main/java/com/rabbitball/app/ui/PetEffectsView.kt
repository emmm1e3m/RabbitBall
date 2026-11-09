package com.rabbitball.app.ui

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.view.View
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin
import kotlin.random.Random

/** 直接沿用 PC 的 14 槽爱心池、360×400 坐标及模拟时间公式。 */
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

    private val hearts = Array(14) { Heart() }
    private var nextHeart = 0
    private var sourcePet: RabbitView? = null
    private val petLocation = IntArray(2)
    private val effectLocation = IntArray(2)
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val shape = Path().apply {
        moveTo(0f, 6f)
        cubicTo(-19f, -7f, -10f, -22f, 0f, -12f)
        cubicTo(10f, -22f, 19f, -7f, 0f, 6f)
        close()
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

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        if (!ValueAnimator.areAnimatorsEnabled()) {
            for (heart in hearts) heart.birth = Float.NEGATIVE_INFINITY
            return
        }
        val pet = sourcePet ?: return
        val colors = pet.heartColors
        val simulationTime = pet.animationTime
        val artworkScale = min(pet.width / 360f, pet.height / 400f)
        pet.getLocationOnScreen(petLocation)
        getLocationOnScreen(effectLocation)
        canvas.save()
        canvas.translate(
            petLocation[0] - effectLocation[0] + (pet.width - artworkScale * 360f) / 2f + pet.artworkOffsetX,
            petLocation[1] - effectLocation[1] + (pet.height - artworkScale * 400f) / 2f + pet.artworkOffsetY
        )
        canvas.scale(artworkScale, artworkScale)
        var active = false
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

    override fun onDetachedFromWindow() {
        for (heart in hearts) heart.birth = Float.NEGATIVE_INFINITY
        sourcePet = null
        super.onDetachedFromWindow()
    }
}
