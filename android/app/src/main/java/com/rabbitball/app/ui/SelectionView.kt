package com.rabbitball.app.ui

import android.animation.Animator
import android.animation.AnimatorListenerAdapter
import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PathMeasure
import android.graphics.RectF
import android.os.SystemClock
import android.util.AttributeSet
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.View
import android.view.animation.PathInterpolator
import kotlin.math.hypot
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.PI
import kotlin.random.Random

/** 圈画只改变关注范围；原截图及发送范围始终保持完整。 */
class SelectionView @JvmOverloads constructor(context: Context, attrs: AttributeSet? = null) : View(context, attrs) {
    private var screenshot: Bitmap? = null
    private val imageBounds = RectF()
    val displayedImageBounds: RectF get() = RectF(imageBounds)
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
    private val trail = Path()
    private val contour = Path()
    private val clipping = Path()
    private val shade = Path()
    private val corners = Path()
    private val arc = RectF()
    private var topInset = 0
    private var bottomInset = 0
    private var startX = 0f
    private var startY = 0f
    private var lastX = 0f
    private var lastY = 0f
    private var minX = 0f
    private var minY = 0f
    private var maxX = 0f
    private var maxY = 0f
    private var pathDistance = 0f
    private var movingSelection = false
    private var resizeCorner = -1
    private var active = false
    private var originalSelection: RectF? = null
    private var settling: ValueAnimator? = null
    private var settleProgress = 1f
    private var sourcePoints: FloatArray? = null
    private var targetPoints: FloatArray? = null
    private val morphPoints = FloatArray(SAMPLE_COUNT * 2)
    private val point = FloatArray(2)
    private val sparkles = ArrayList<Sparkle>(MAX_SPARKLES)
    private var sparkleDistance = 0f
    private val random = Random.Default
    private val motionCurve = PathInterpolator(.22f, 0f, .12f, 1f)
    var onSelectionChanged: ((RectF?) -> Unit)? = null
    var selection: RectF? = null
        private set
    private fun dp(value: Float) = value * resources.displayMetrics.density

    init {
        contentDescription = "图片，圈画关注区域；拖动四角调整范围，在选区外重新选择"
        isClickable = true
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
    }

    fun setScreenshot(bitmap: Bitmap?) {
        screenshot = bitmap
        clearSelection()
        updateImageBounds()
        invalidate()
    }

    fun setViewportInsets(top: Int, bottom: Int) {
        if (topInset == top && bottomInset == bottom) return
        topInset = top
        bottomInset = bottom
        if (!active && settling == null) updateImageBounds()
        invalidate()
    }

    fun clearSelection() {
        cancelSettling()
        active = false
        resizeCorner = -1
        selection = null
        trail.reset()
        sparkles.clear()
        parent?.requestDisallowInterceptTouchEvent(false)
        updateImageBounds()
        onSelectionChanged?.invoke(null)
        invalidate()
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        if (!active && settling == null) updateImageBounds()
    }

    private fun updateImageBounds() {
        val image = screenshot ?: run { imageBounds.setEmpty(); return }
        val previous = RectF(imageBounds)
        val availableWidth = max(1f, width - dp(32f))
        val availableHeight = max(1f, height - topInset - bottomInset - dp(20f))
        val scale = min(availableWidth / image.width, availableHeight / image.height)
        val imageWidth = image.width * scale
        val imageHeight = image.height * scale
        val left = (width - imageWidth) / 2f
        val top = topInset + dp(8f) + max(0f, (availableHeight - imageHeight) / 2f)
        imageBounds.set(left, top, left + imageWidth, top + imageHeight)
        if (previous != imageBounds) sparkles.clear()
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val image = screenshot ?: return
        if (image.isRecycled || imageBounds.isEmpty) return
        paint.style = Paint.Style.FILL
        paint.color = Color.WHITE
        paint.clearShadowLayer()
        clipping.reset()
        clipping.addRoundRect(imageBounds, dp(12f), dp(12f), Path.Direction.CW)
        canvas.save()
        canvas.clipPath(clipping)
        canvas.drawBitmap(image, null, imageBounds, paint)
        selection?.let { chosen ->
            val region = toViewBounds(chosen)
            buildContour(region)
            // 镂空与轮廓使用同一路径，转角在整个形变过程中完全重合。
            shade.set(clipping)
            shade.addPath(contour)
            shade.fillType = Path.FillType.EVEN_ODD
            paint.color = Color.argb((38f * min(1f, settleProgress * 2.4f)).roundToInt(), 48, 35, 42)
            canvas.drawPath(shade, paint)
            drawGlowPath(canvas, contour, 1f, dp(3f - .8f * settleProgress))
            val cornerProgress = ((settleProgress - .62f) / .38f).coerceIn(0f, 1f)
            if (cornerProgress > 0f) drawCorners(canvas, region, cornerProgress)
        }
        if (active && !movingSelection && resizeCorner < 0) {
            contour.set(trail)
            contour.lineTo(lastX, lastY)
            drawGlowPath(canvas, contour, 1f, dp(3f))
            paint.style = Paint.Style.FILL
            paint.color = 0x25FFFFFF
            canvas.drawCircle(lastX, lastY, dp(7f), paint)
            paint.color = 0xDAFFFFFF.toInt()
            canvas.drawCircle(lastX, lastY, dp(2.4f), paint)
        }
        drawSparkles(canvas)
        canvas.restore()
    }

    private fun buildContour(region: RectF) {
        contour.reset()
        val from = sourcePoints
        val to = targetPoints
        if (settling != null && from != null && to != null) {
            for (index in morphPoints.indices) {
                morphPoints[index] = from[index] + (to[index] - from[index]) * settleProgress
            }
            contour.moveTo(morphPoints[0], morphPoints[1])
            // 闭合三次样条穿过采样点，避免折线的折角，也避免二次平滑向内缩。
            for (index in 0 until SAMPLE_COUNT) {
                val current = index * 2
                val previous = ((index + SAMPLE_COUNT - 1) % SAMPLE_COUNT) * 2
                val next = ((index + 1) % SAMPLE_COUNT) * 2
                val after = ((index + 2) % SAMPLE_COUNT) * 2
                contour.cubicTo(
                    morphPoints[current] + (morphPoints[next] - morphPoints[previous]) / 6f,
                    morphPoints[current + 1] + (morphPoints[next + 1] - morphPoints[previous + 1]) / 6f,
                    morphPoints[next] - (morphPoints[after] - morphPoints[current]) / 6f,
                    morphPoints[next + 1] - (morphPoints[after + 1] - morphPoints[current + 1]) / 6f,
                    morphPoints[next], morphPoints[next + 1]
                )
            }
            contour.close()
        } else contour.addRoundRect(region, radius(region), radius(region), Path.Direction.CW)
    }

    private fun drawGlowPath(canvas: Canvas, path: Path, opacity: Float, width: Float) {
        paint.style = Paint.Style.STROKE
        paint.strokeCap = Paint.Cap.ROUND
        paint.strokeJoin = Paint.Join.ROUND
        paint.strokeWidth = width + dp(6f)
        paint.color = Color.argb((18f * opacity).roundToInt(), 255, 255, 255)
        canvas.drawPath(path, paint)
        paint.strokeWidth = width + dp(2.5f)
        paint.color = Color.argb((38f * opacity).roundToInt(), 255, 255, 255)
        canvas.drawPath(path, paint)
        paint.strokeWidth = width
        paint.color = Color.argb((235f * opacity).roundToInt(), 255, 255, 255)
        canvas.drawPath(path, paint)
    }

    private fun radius(region: RectF) = min(dp(16f), min(region.width(), region.height()) / 3f)

    private fun toViewBounds(chosen: RectF) = RectF(
        imageBounds.left + chosen.left * imageBounds.width(),
        imageBounds.top + chosen.top * imageBounds.height(),
        imageBounds.left + chosen.right * imageBounds.width(),
        imageBounds.top + chosen.bottom * imageBounds.height()
    )

    private fun drawCorners(canvas: Canvas, region: RectF, progress: Float) {
        val r = radius(region)
        val length = min(dp(16f + 8f * progress), min(region.width(), region.height()) / 2f)
        corners.reset()
        corners.moveTo(region.left, region.top + length)
        corners.lineTo(region.left, region.top + r)
        arc.set(region.left, region.top, region.left + r * 2f, region.top + r * 2f)
        corners.arcTo(arc, 180f, 90f)
        corners.lineTo(region.left + length, region.top)
        corners.moveTo(region.right - length, region.top)
        corners.lineTo(region.right - r, region.top)
        arc.set(region.right - r * 2f, region.top, region.right, region.top + r * 2f)
        corners.arcTo(arc, 270f, 90f)
        corners.lineTo(region.right, region.top + length)
        corners.moveTo(region.right, region.bottom - length)
        corners.lineTo(region.right, region.bottom - r)
        arc.set(region.right - r * 2f, region.bottom - r * 2f, region.right, region.bottom)
        corners.arcTo(arc, 0f, 90f)
        corners.lineTo(region.right - length, region.bottom)
        corners.moveTo(region.left + length, region.bottom)
        corners.lineTo(region.left + r, region.bottom)
        arc.set(region.left, region.bottom - r * 2f, region.left + r * 2f, region.bottom)
        corners.arcTo(arc, 90f, 90f)
        corners.lineTo(region.left, region.bottom - length)
        drawGlowPath(canvas, corners, progress, dp(3f))
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        if (screenshot == null || imageBounds.isEmpty) return false
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                val initialCorner = selection?.let { hitCorner(toViewBounds(it), event.x, event.y) } ?: -1
                if (initialCorner < 0 && !imageBounds.contains(event.x, event.y)) return false
                cancelSettling()
                updateImageBounds()
                sparkles.clear()
                sparkleDistance = 0f
                parent?.requestDisallowInterceptTouchEvent(true)
                val x = event.x.coerceIn(imageBounds.left, imageBounds.right)
                val y = event.y.coerceIn(imageBounds.top, imageBounds.bottom)
                startX = event.x; startY = event.y; lastX = x; lastY = y
                minX = x; maxX = x; minY = y; maxY = y
                pathDistance = 0f
                active = true
                originalSelection = selection?.let { RectF(it) }
                resizeCorner = selection?.let { hitCorner(toViewBounds(it), event.x, event.y) } ?: -1
                movingSelection = resizeCorner < 0 && (selection?.let { containsRounded(toViewBounds(it), x, y) } ?: false)
                if (!movingSelection && resizeCorner < 0) {
                    selection = null
                    trail.reset()
                    trail.moveTo(x, y)
                }
                invalidate()
                return true
            }
            MotionEvent.ACTION_MOVE -> if (active) {
                appendEvent(event)
                return true
            }
            MotionEvent.ACTION_UP -> if (active) {
                appendEvent(event)
                active = false
                parent?.requestDisallowInterceptTouchEvent(false)
                if (resizeCorner >= 0) {
                    trail.reset()
                    updateImageBounds()
                    selection?.let { emitCornerGlint(toViewBounds(it), resizeCorner) }
                    performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
                    requestLayout()
                } else if (!movingSelection && pathDistance >= dp(18f)) {
                    val region = minimumBounds()
                    selection = normalized(region)
                    trail.lineTo(lastX, lastY)
                    settleToSelection(region)
                    performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
                } else {
                    trail.reset()
                    updateImageBounds()
                    requestLayout()
                    if (pathDistance < dp(18f)) performClick()
                }
                onSelectionChanged?.invoke(selection?.let { RectF(it) })
                resizeCorner = -1
                invalidate()
                return true
            }
            MotionEvent.ACTION_POINTER_DOWN, MotionEvent.ACTION_CANCEL -> if (active) {
                active = false
                selection = originalSelection
                trail.reset()
                sparkles.clear()
                resizeCorner = -1
                updateImageBounds()
                requestLayout()
                parent?.requestDisallowInterceptTouchEvent(false)
                onSelectionChanged?.invoke(selection?.let { RectF(it) })
                invalidate()
                return true
            }
        }
        return active
    }

    private fun containsRounded(region: RectF, x: Float, y: Float): Boolean {
        if (!region.contains(x, y)) return false
        val r = radius(region)
        val dx = x - x.coerceIn(region.left + r, region.right - r)
        val dy = y - y.coerceIn(region.top + r, region.bottom - r)
        return dx * dx + dy * dy <= r * r
    }

    private fun hitCorner(region: RectF, x: Float, y: Float): Int {
        var closest = -1
        var distance = dp(24f) * dp(24f)
        for (index in 0..3) {
            val dx = x - cornerX(region, index)
            val dy = y - cornerY(region, index)
            val squared = dx * dx + dy * dy
            if (squared <= distance) { distance = squared; closest = index }
        }
        return closest
    }

    private fun cornerX(region: RectF, corner: Int) = if (corner == 0 || corner == 3) region.left else region.right
    private fun cornerY(region: RectF, corner: Int) = if (corner < 2) region.top else region.bottom

    private fun normalized(region: RectF) = RectF(
        ((region.left - imageBounds.left) / imageBounds.width()).coerceIn(0f, 1f),
        ((region.top - imageBounds.top) / imageBounds.height()).coerceIn(0f, 1f),
        ((region.right - imageBounds.left) / imageBounds.width()).coerceIn(0f, 1f),
        ((region.bottom - imageBounds.top) / imageBounds.height()).coerceIn(0f, 1f)
    )

    private fun appendEvent(event: MotionEvent) {
        for (index in 0 until event.historySize) {
            updateGesture(event.getHistoricalX(index), event.getHistoricalY(index))
        }
        updateGesture(event.x, event.y)
    }

    private fun updateGesture(rawX: Float, rawY: Float) {
        val x = rawX.coerceIn(imageBounds.left, imageBounds.right)
        val y = rawY.coerceIn(imageBounds.top, imageBounds.bottom)
        val distance = hypot(x - lastX, y - lastY)
        pathDistance += distance
        if (resizeCorner >= 0) {
            resizeSelection(rawX - startX, rawY - startY)
            selection?.let {
                val region = toViewBounds(it)
                emitGestureSparkle(cornerX(region, resizeCorner), cornerY(region, resizeCorner), distance)
            }
        } else if (movingSelection) {
            originalSelection?.let { original ->
                val dx = ((x - startX) / imageBounds.width()).coerceIn(-original.left, 1f - original.right)
                val dy = ((y - startY) / imageBounds.height()).coerceIn(-original.top, 1f - original.bottom)
                selection = RectF(original).apply { offset(dx, dy) }
            }
        } else {
            trail.quadTo(lastX, lastY, (lastX + x) / 2f, (lastY + y) / 2f)
            minX = min(minX, x); minY = min(minY, y)
            maxX = max(maxX, x); maxY = max(maxY, y)
            emitGestureSparkle(x, y, distance)
        }
        lastX = x; lastY = y
        invalidate()
    }

    private fun resizeSelection(dx: Float, dy: Float) {
        val original = originalSelection ?: return
        val region = toViewBounds(original)
        val leftCorner = resizeCorner == 0 || resizeCorner == 3
        val topCorner = resizeCorner < 2
        // 对角固定；手指跨越对角时只收至最小尺寸，不翻转角点。
        val minimumWidth = min(dp(20f), if (leftCorner) region.right - imageBounds.left else imageBounds.right - region.left)
        val minimumHeight = min(dp(20f), if (topCorner) region.bottom - imageBounds.top else imageBounds.bottom - region.top)
        if (leftCorner) region.left = (region.left + dx).coerceIn(imageBounds.left, region.right - minimumWidth)
        else region.right = (region.right + dx).coerceIn(region.left + minimumWidth, imageBounds.right)
        if (topCorner) region.top = (region.top + dy).coerceIn(imageBounds.top, region.bottom - minimumHeight)
        else region.bottom = (region.bottom + dy).coerceIn(region.top + minimumHeight, imageBounds.bottom)
        selection = normalized(region)
    }

    private fun minimumBounds(): RectF {
        val width = max(maxX - minX, dp(20f)).coerceAtMost(imageBounds.width())
        val height = max(maxY - minY, dp(20f)).coerceAtMost(imageBounds.height())
        val left = ((minX + maxX - width) / 2f).coerceIn(imageBounds.left, imageBounds.right - width)
        val top = ((minY + maxY - height) / 2f).coerceIn(imageBounds.top, imageBounds.bottom - height)
        return RectF(left, top, left + width, top + height)
    }

    private fun settleToSelection(region: RectF) {
        if (!ValueAnimator.areAnimatorsEnabled()) {
            trail.reset()
            settleProgress = 1f
            updateImageBounds()
            requestLayout()
            return
        }
        sourcePoints = sample(trail)
        val target = Path().apply { addRoundRect(region, radius(region), radius(region), Path.Direction.CW) }
        targetPoints = align(sample(target), sourcePoints!!)
        emitContourSparkles(sourcePoints!!, targetPoints!!)
        settleProgress = 0f
        settling = ValueAnimator.ofFloat(0f, 1f).apply {
            duration = 420L
            interpolator = motionCurve
            addUpdateListener { settleProgress = it.animatedValue as Float; invalidate() }
            addListener(object : AnimatorListenerAdapter() {
                override fun onAnimationEnd(animation: Animator) {
                    settling = null
                    sourcePoints = null
                    targetPoints = null
                    trail.reset()
                    settleProgress = 1f
                    updateImageBounds()
                    requestLayout()
                    invalidate()
                }
            })
            start()
        }
    }

    private fun emitGestureSparkle(x: Float, y: Float, distance: Float) {
        if (!ValueAnimator.areAnimatorsEnabled()) return
        sparkleDistance += distance
        val stride = dp(9f)
        if (sparkleDistance < stride) return
        sparkleDistance %= stride
        val now = SystemClock.uptimeMillis()
        val count = if (distance > stride * 2f) 4 else 2
        repeat(count) {
            val angle = random.nextFloat() * (PI * 2).toFloat()
            val travel = dp(6f + random.nextFloat() * 13f)
            addSparkle(Sparkle(x, y, x + cos(angle) * travel, y + sin(angle) * travel - dp(5f),
                now, 330L + random.nextInt(210), dp(.8f + random.nextFloat() * 1.2f),
                SPARKLE_COLORS[random.nextInt(SPARKLE_COLORS.size)], false, random.nextFloat() * PI.toFloat()))
        }
    }

    private fun emitContourSparkles(from: FloatArray, to: FloatArray) {
        val now = SystemClock.uptimeMillis()
        for (index in 0 until SAMPLE_COUNT step 2) {
            addSparkle(Sparkle(from[index * 2], from[index * 2 + 1], to[index * 2], to[index * 2 + 1],
                now + random.nextInt(24), 460L, dp(.9f + random.nextFloat() * 1.2f),
                SPARKLE_COLORS[(index / 2) % SPARKLE_COLORS.size], true, random.nextFloat() * PI.toFloat()))
        }
    }

    private fun emitCornerGlint(region: RectF, corner: Int) {
        if (!ValueAnimator.areAnimatorsEnabled()) return
        val x = cornerX(region, corner)
        val y = cornerY(region, corner)
        val now = SystemClock.uptimeMillis()
        repeat(16) { index ->
            val angle = index * (PI / 8).toFloat() + random.nextFloat() * .25f
            val travel = dp(7f + random.nextFloat() * 8f)
            addSparkle(Sparkle(x, y, x + cos(angle) * travel, y + sin(angle) * travel,
                now, 300L + random.nextInt(120), dp(.8f + random.nextFloat()),
                SPARKLE_COLORS[index % SPARKLE_COLORS.size], false, angle))
        }
    }

    private fun addSparkle(sparkle: Sparkle) {
        if (sparkles.size == MAX_SPARKLES) sparkles.removeAt(0)
        sparkles.add(sparkle)
    }

    private fun drawSparkles(canvas: Canvas) {
        if (sparkles.isEmpty()) return
        if (!ValueAnimator.areAnimatorsEnabled()) { sparkles.clear(); return }
        val now = SystemClock.uptimeMillis()
        val iterator = sparkles.iterator()
        paint.style = Paint.Style.FILL
        while (iterator.hasNext()) {
            val sparkle = iterator.next()
            val elapsed = now - sparkle.born
            if (elapsed >= sparkle.duration) { iterator.remove(); continue }
            if (elapsed < 0) continue
            val t = elapsed.toFloat() / sparkle.duration
            val progress = if (sparkle.converging) motionCurve.getInterpolation(t) else 1f - (1f - t) * (1f - t)
            val drift = if (sparkle.converging) sin(t * PI).toFloat() * dp(3f) else 0f
            val x = sparkle.x + (sparkle.endX - sparkle.x) * progress + cos(sparkle.phase) * drift
            val y = sparkle.y + (sparkle.endY - sparkle.y) * progress + sin(sparkle.phase) * drift
            val opacity = sin((t * .92f + .08f) * PI).toFloat().coerceAtLeast(0f) * (1f - t * .3f)
            val size = sparkle.radius * (1f - t * .35f)
            paint.color = Color.argb((27f * opacity).roundToInt(), Color.red(sparkle.color), Color.green(sparkle.color), Color.blue(sparkle.color))
            canvas.drawCircle(x, y, size * 3f, paint)
            paint.color = Color.argb((235f * opacity).roundToInt(), Color.red(sparkle.color), Color.green(sparkle.color), Color.blue(sparkle.color))
            canvas.drawCircle(x, y, size, paint)
        }
        if (sparkles.isNotEmpty()) postInvalidateOnAnimation()
    }

    private data class Sparkle(
        val x: Float, val y: Float, val endX: Float, val endY: Float,
        val born: Long, val duration: Long, val radius: Float, val color: Int,
        val converging: Boolean, val phase: Float
    )

    private fun sample(path: Path): FloatArray {
        val measure = PathMeasure(path, true)
        return FloatArray(SAMPLE_COUNT * 2).also { samples ->
            for (index in 0 until SAMPLE_COUNT) {
                measure.getPosTan(measure.length * index / SAMPLE_COUNT, point, null)
                samples[index * 2] = point[0]
                samples[index * 2 + 1] = point[1]
            }
        }
    }

    private fun align(target: FloatArray, source: FloatArray): FloatArray {
        fun area(points: FloatArray): Float {
            var sum = 0f
            for (index in 0 until SAMPLE_COUNT) {
                val next = (index + 1) % SAMPLE_COUNT
                sum += points[index * 2] * points[next * 2 + 1] - points[next * 2] * points[index * 2 + 1]
            }
            return sum
        }
        val direction = if (area(target) * area(source) < 0f) -1 else 1
        var bestOffset = 0
        var bestDistance = Double.POSITIVE_INFINITY
        // 同向、同起点地对应轮廓，避免收拢时产生旋转或翻折。
        for (offset in 0 until SAMPLE_COUNT) {
            var distance = 0.0
            for (index in 0 until SAMPLE_COUNT) {
                val targetIndex = (offset + direction * index + SAMPLE_COUNT) % SAMPLE_COUNT
                val dx = source[index * 2] - target[targetIndex * 2]
                val dy = source[index * 2 + 1] - target[targetIndex * 2 + 1]
                distance += dx.toDouble() * dx + dy.toDouble() * dy
            }
            if (distance < bestDistance) { bestDistance = distance; bestOffset = offset }
        }
        return FloatArray(target.size) { coordinate ->
            val targetIndex = (bestOffset + direction * (coordinate / 2) + SAMPLE_COUNT) % SAMPLE_COUNT
            target[targetIndex * 2 + coordinate % 2]
        }
    }

    private fun cancelSettling() {
        settling?.apply { removeAllListeners(); removeAllUpdateListeners(); cancel() }
        settling = null
        sourcePoints = null
        targetPoints = null
        settleProgress = 1f
    }

    override fun onDetachedFromWindow() {
        cancelSettling()
        active = false
        trail.reset()
        sparkles.clear()
        resizeCorner = -1
        super.onDetachedFromWindow()
    }

    override fun performClick(): Boolean { super.performClick(); return true }

    private companion object {
        const val SAMPLE_COUNT = 112
        const val MAX_SPARKLES = 160
        val SPARKLE_COLORS = intArrayOf(Color.WHITE, 0xFFFFD4EC.toInt(), 0xFFD3E8FF.toInt(), 0xFFD0BDFF.toInt())
    }
}
