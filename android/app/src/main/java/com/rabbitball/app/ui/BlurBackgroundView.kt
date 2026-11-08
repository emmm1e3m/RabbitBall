package com.rabbitball.app.ui

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.RenderEffect
import android.graphics.Shader
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.animation.PathInterpolator
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import kotlin.math.ceil
import kotlin.math.exp
import kotlin.math.max
import kotlin.math.roundToInt

/** 模糊层始终使用完整截图，不参与选区坐标或发送图片的计算。 */
class BlurBackgroundView(context: Context) : View(context) {
    private val imagePaint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
    private val dimPaint = Paint().apply { color = Color.BLACK; alpha = 0 }
    private val destination = RectF()
    private val mainHandler = Handler(Looper.getMainLooper())
    private var sourceBitmap: Bitmap? = null
    private var blurredBitmap: Bitmap? = null
    private var revealProgress = 1f
    private var revealAnimator: ValueAnimator? = null
    private var worker: ExecutorService? = null
    private var generation = 0

    init {
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
    }

    fun setScreenshot(bitmap: Bitmap?) {
        val request = ++generation
        revealAnimator?.cancel()
        revealAnimator = null
        sourceBitmap = bitmap
        blurredBitmap = null
        applyReveal(if (bitmap == null) 1f else 0f)
        if (bitmap == null) return
        if (Build.VERSION.SDK_INT >= 31) {
            startReveal()
            return
        }
        val executor = worker ?: Executors.newSingleThreadExecutor { task ->
            Thread(task, "rabbit-background-blur").apply { isDaemon = true }
        }.also { worker = it }
        executor.execute {
            val blurred = gaussianBlur(bitmap) ?: return@execute
            mainHandler.post {
                if (generation == request) {
                    blurredBitmap = blurred
                    startReveal()
                } else blurred.recycle()
            }
        }
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val original = sourceBitmap
        if (original == null || original.isRecycled) {
            canvas.drawColor(Color.rgb(246, 232, 240))
            return
        }
        val blurred = blurredBitmap
        if (Build.VERSION.SDK_INT >= 31 || blurred == null || revealProgress < 1f) {
            drawImage(canvas, original, 255)
        }
        if (Build.VERSION.SDK_INT < 31 && blurred != null && !blurred.isRecycled) {
            drawImage(canvas, blurred, (revealProgress * 255f).roundToInt())
        }
        canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), dimPaint)
    }

    private fun drawImage(canvas: Canvas, bitmap: Bitmap, alpha: Int) {
        val scale = max(width.toFloat() / bitmap.width, height.toFloat() / bitmap.height)
        val left = (width - bitmap.width * scale) / 2f
        val top = (height - bitmap.height * scale) / 2f
        destination.set(left, top, left + bitmap.width * scale, top + bitmap.height * scale)
        imagePaint.alpha = alpha
        canvas.drawBitmap(bitmap, null, destination, imagePaint)
    }

    private fun startReveal() {
        if (sourceBitmap == null || (Build.VERSION.SDK_INT < 31 && blurredBitmap == null)) return
        if (!ValueAnimator.areAnimatorsEnabled() || revealProgress >= 1f) {
            applyReveal(1f)
            return
        }
        if (!isAttachedToWindow) return
        revealAnimator?.cancel()
        revealAnimator = ValueAnimator.ofFloat(revealProgress, 1f).apply {
            duration = 400L
            interpolator = PathInterpolator(.2f, 0f, 0f, 1f)
            addUpdateListener { applyReveal(it.animatedValue as Float) }
            start()
        }
    }

    private fun applyReveal(progress: Float) {
        revealProgress = progress
        dimPaint.alpha = if (sourceBitmap != null) (36f * progress).roundToInt() else 0
        if (Build.VERSION.SDK_INT >= 31) {
            val radius = if (sourceBitmap != null) resources.displayMetrics.density * 16f * progress else 0f
            setRenderEffect(if (radius > 0f) RenderEffect.createBlurEffect(radius, radius, Shader.TileMode.CLAMP) else null)
        }
        invalidate()
    }

    override fun onDetachedFromWindow() {
        ++generation
        revealAnimator?.cancel()
        revealAnimator = null
        worker?.shutdownNow()
        worker = null
        applyReveal(1f)
        super.onDetachedFromWindow()
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        if (Build.VERSION.SDK_INT < 31 && sourceBitmap != null && blurredBitmap == null && worker == null) {
            setScreenshot(sourceBitmap)
        } else startReveal()
    }

    // Android 11 使用缩小后的可分离高斯卷积；中间数组只存于工作线程。
    private fun gaussianBlur(source: Bitmap): Bitmap? {
        if (source.isRecycled || Thread.currentThread().isInterrupted) return null
        val scale = minOf(1f, 300f / max(source.width, source.height))
        val width = max(1, (source.width * scale).roundToInt())
        val height = max(1, (source.height * scale).roundToInt())
        val pixels = IntArray(width * height)
        // 系统助理可能交付硬件位图；先复制为可读取像素的自有软件位图。
        val readable = if (source.config == Bitmap.Config.HARDWARE) {
            source.copy(Bitmap.Config.ARGB_8888, false) ?: return null
        } else source
        try {
            val sampled = Bitmap.createScaledBitmap(readable, width, height, true)
            try {
                sampled.getPixels(pixels, 0, width, 0, 0, width, height)
            } finally {
                if (sampled !== readable) sampled.recycle()
            }
        } finally {
            if (readable !== source) readable.recycle()
        }
        val sigma = (16f * resources.displayMetrics.density * width /
            resources.displayMetrics.widthPixels).coerceIn(1f, 10f)
        val radius = ceil(sigma * 3f).toInt()
        val kernel = FloatArray(radius * 2 + 1) { index ->
            val distance = (index - radius).toFloat()
            exp((-distance * distance / (2f * sigma * sigma)).toDouble()).toFloat()
        }
        val sum = kernel.sum()
        for (index in kernel.indices) kernel[index] /= sum
        val horizontal = IntArray(pixels.size)
        val output = IntArray(pixels.size)
        for (y in 0 until height) {
            if (Thread.currentThread().isInterrupted) return null
            for (x in 0 until width) {
                horizontal[y * width + x] = weightedPixel(kernel) { offset ->
                    pixels[y * width + (x + offset - radius).coerceIn(0, width - 1)]
                }
            }
        }
        for (y in 0 until height) {
            if (Thread.currentThread().isInterrupted) return null
            for (x in 0 until width) {
                output[y * width + x] = weightedPixel(kernel) { offset ->
                    horizontal[(y + offset - radius).coerceIn(0, height - 1) * width + x]
                }
            }
        }
        return Bitmap.createBitmap(output, width, height, Bitmap.Config.ARGB_8888)
    }

    private inline fun weightedPixel(kernel: FloatArray, colorAt: (Int) -> Int): Int {
        var red = 0f
        var green = 0f
        var blue = 0f
        for (index in kernel.indices) {
            val color = colorAt(index)
            val weight = kernel[index]
            red += (color shr 16 and 255) * weight
            green += (color shr 8 and 255) * weight
            blue += (color and 255) * weight
        }
        return Color.rgb(red.roundToInt(), green.roundToInt(), blue.roundToInt())
    }
}
