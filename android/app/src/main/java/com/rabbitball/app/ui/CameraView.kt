package com.rabbitball.app.ui

import android.Manifest
import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PointF
import android.graphics.SurfaceTexture
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CaptureFailure
import android.hardware.camera2.CaptureRequest
import android.hardware.camera2.params.OutputConfiguration
import android.hardware.camera2.params.SessionConfiguration
import android.hardware.display.DisplayManager
import android.media.ImageReader
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.util.Size
import android.view.Gravity
import android.view.MotionEvent
import android.view.Surface
import android.view.TextureView
import android.view.View
import android.view.animation.PathInterpolator
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

// 兔球载体 96×108dp、画布 360×400、球半径 137：球体直径的 75% 为 54.8dp。
private const val CAMERA_CONTROL_SIDE_DP = 54.8f
private const val CAMERA_CONTROL_TOUCH_DP = 60f

/** 使用融合陀螺仪的姿态矩阵，照片在内存中旋转为正向像素，不依赖查看器解释 EXIF。 */
internal object CameraOrientation {
    fun fromGravity(x: Float, y: Float, z: Float): Int? {
        if ((x * x + y * y) * 4f < z * z || x * x + y * y < 0.0001f) return null
        val angle = Math.toDegrees(atan2(y.toDouble(), -x.toDouble()))
        return ((90 - angle.roundToInt()) % 360 + 360) % 360
    }

    fun jpegRotation(sensorOrientation: Int, deviceOrientation: Int, front: Boolean = false): Int {
        val rounded = ((deviceOrientation + 45) / 90 * 90) % 360
        return (sensorOrientation + (if (front) -rounded else rounded) + 360) % 360
    }

    fun normaliseBitmap(bitmap: Bitmap, degrees: Int): Bitmap {
        if (degrees % 360 == 0) return bitmap
        return Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height,
            Matrix().apply { postRotate(degrees.toFloat()) }, true)
    }
}

/** 原生取景器只交付内存 Bitmap，组件不打开文件、相册或外部相机。 */
class CameraView(context: Context) : FrameLayout(context), SensorEventListener {
    var onPhoto: ((Bitmap) -> Unit)? = null
    var onClose: (() -> Unit)? = null
    var onError: ((String) -> Unit)? = null
    var onReadyChanged: ((Boolean) -> Unit)? = null
    val isReady: Boolean get() = run?.let { current(it) && it.ready && !it.capturing } == true

    private val main = Handler(Looper.getMainLooper())
    private val cameraManager = context.getSystemService(CameraManager::class.java)
    private val sensors = context.getSystemService(SensorManager::class.java)
    private val displays = context.getSystemService(DisplayManager::class.java)
    private val viewport = FrameLayout(context)
    private val texture = TextureView(context)
    private val frozenPhoto = ImageView(context)
    private val flash = View(context)
    private val loading = ProgressBar(context)
    private val close = CameraControl(context, false).apply {
        contentDescription = "取消拍摄"
        tooltipText = "取消拍摄"
        setOnClickListener { onClose?.invoke() }
    }
    private val switchCamera = CameraControl(context, true).apply {
        contentDescription = "切换前后摄像头"
        tooltipText = "切换前后摄像头"
        isEnabled = false
        visibility = INVISIBLE
        setOnClickListener { switchLens() }
    }
    private val errorPanel = LinearLayout(context)
    private val errorText = Palette.text(context, "", 14f, Palette.ink)
    private val retry = Palette.text(context, "重新尝试", 14f, Palette.accent, true)
    @Volatile private var run: CameraRun? = null
    @Volatile private var requested = false
    @Volatile private var released = false
    private var deviceOrientation = 0
    private var stableOrientation = false
    private val rotation = FloatArray(9)
    private val filteredGravity = FloatArray(3)
    private var hasGravity = false
    private var listeningSensor: Sensor? = null
    private var previewScaleX = Float.NaN
    private var previewScaleY = Float.NaN
    private var previewRotation = Float.NaN
    private var requestedFacing = CameraCharacteristics.LENS_FACING_BACK
    private var canSwitch = false
    private var switchingLens = false
    private var frozenIsSwitch = false
    private val ease = PathInterpolator(.2f, .8f, .2f, 1f)

    private class CameraRun(val thread: HandlerThread) {
        val handler = Handler(thread.looper)
        var device: CameraDevice? = null
        var session: CameraCaptureSession? = null
        var reader: ImageReader? = null
        var previewSurface: Surface? = null
        var photoSize = Size(1, 1)
        var previewSize = Size(1, 1)
        var sensorOrientation = 0
        var front = false
        var autofocus = CaptureRequest.CONTROL_AF_MODE_OFF
        var opening = false
        var ready = false
        var firstFrame = false
        @Volatile var capturing = false
        @Volatile var photoRotation = 0
        @Volatile var closed = false
    }

    private fun dp(value: Float) = Palette.dp(context, value)
    private fun current(candidate: CameraRun) = !released && requested && run === candidate && !candidate.closed

    init {
        contentDescription = "相机取景器"
        setBackgroundColor(Color.TRANSPARENT)
        viewport.background = Palette.round(context, 0xFF201B1F.toInt(), 24f)
        viewport.clipToOutline = true
        viewport.addView(texture, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
        frozenPhoto.scaleType = ImageView.ScaleType.CENTER_CROP
        frozenPhoto.visibility = GONE
        viewport.addView(frozenPhoto, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
        texture.alpha = 0f
        texture.isOpaque = false
        texture.surfaceTextureListener = object : TextureView.SurfaceTextureListener {
            override fun onSurfaceTextureAvailable(surface: SurfaceTexture, width: Int, height: Int) {
                if (requested && run == null) createRun() else openIfReady()
            }
            override fun onSurfaceTextureSizeChanged(surface: SurfaceTexture, width: Int, height: Int) = Unit
            override fun onSurfaceTextureDestroyed(surface: SurfaceTexture): Boolean { closeRun(); return true }
            override fun onSurfaceTextureUpdated(surface: SurfaceTexture) {
                val active = run ?: return
                if (current(active) && !active.firstFrame && active.session != null) {
                    active.firstFrame = true
                    loading.animate().alpha(0f).setDuration(160).withEndAction {
                        if (current(active)) loading.visibility = GONE
                    }.start()
                    val ready = {
                        if (current(active) && !active.capturing) {
                            active.ready = true
                            updateControls()
                            onReadyChanged?.invoke(true)
                        }
                    }
                    if (ValueAnimator.areAnimatorsEnabled()) {
                        if (frozenIsSwitch) {
                            texture.alpha = 1f
                            frozenPhoto.animate().alpha(0f).setDuration(220).setInterpolator(ease)
                                .withEndAction { clearSwitchFreeze(active); ready() }.start()
                        } else texture.animate().alpha(1f).setDuration(220).setInterpolator(ease).withEndAction(ready).start()
                    } else {
                        texture.alpha = 1f
                        clearSwitchFreeze(active)
                        ready()
                    }
                }
            }
        }
        addView(viewport, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT).apply {
            leftMargin = dp(16f)
            rightMargin = dp(16f)
            topMargin = dp(16f)
            bottomMargin = dp(148f)
        })
        loading.indeterminateTintList = android.content.res.ColorStateList.valueOf(Palette.accent)
        addView(loading, LayoutParams(dp(28f), dp(28f), Gravity.CENTER))
        flash.setBackgroundColor(Color.WHITE)
        flash.alpha = 0f
        viewport.addView(flash, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
        addView(close, LayoutParams(dp(CAMERA_CONTROL_TOUCH_DP), dp(CAMERA_CONTROL_TOUCH_DP)))
        addView(switchCamera, LayoutParams(dp(CAMERA_CONTROL_TOUCH_DP), dp(CAMERA_CONTROL_TOUCH_DP)))

        errorPanel.orientation = LinearLayout.VERTICAL
        errorPanel.gravity = Gravity.CENTER
        errorPanel.setPadding(dp(20f), dp(16f), dp(20f), dp(12f))
        errorPanel.background = Palette.round(context, 0xF2FFFFFF.toInt(), 18f)
        errorText.gravity = Gravity.CENTER
        errorPanel.addView(errorText, LinearLayout.LayoutParams(-1, -2))
        retry.gravity = Gravity.CENTER
        retry.background = Palette.ripple(context, Color.TRANSPARENT, 10f)
        retry.setOnClickListener { stop(); start() }
        errorPanel.addView(retry, LinearLayout.LayoutParams(-1, dp(44f)).apply { topMargin = dp(8f) })
        errorPanel.visibility = GONE
        addView(errorPanel, LayoutParams(dp(280f), -2, Gravity.CENTER))
    }

    /** 宿主已取得 CAMERA 权限后开始；同一打开过程不重复创建相机。 */
    fun start() {
        if (released || requested) return
        requested = true
        deviceOrientation = (360 - (display?.rotation ?: Surface.ROTATION_0) * 90) % 360
        stableOrientation = false
        hasGravity = false
        listeningSensor = sensors.getDefaultSensor(Sensor.TYPE_GAME_ROTATION_VECTOR)
            ?: sensors.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR)
            ?: sensors.getDefaultSensor(Sensor.TYPE_GRAVITY)
            ?: sensors.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
        listeningSensor?.let { sensors.registerListener(this, it, SensorManager.SENSOR_DELAY_UI, main) }
        displays.registerDisplayListener(displayListener, main)
        errorPanel.animate().cancel()
        errorPanel.visibility = GONE
        if (!frozenIsSwitch) {
            frozenPhoto.setImageDrawable(null)
            frozenPhoto.visibility = GONE
        }
        loading.animate().cancel()
        loading.visibility = VISIBLE
        loading.alpha = 1f
        createRun()
    }

    fun stop() {
        requested = false
        sensors.unregisterListener(this)
        listeningSensor = null
        displays.unregisterDisplayListener(displayListener)
        closeRun()
    }

    private fun createRun() {
        if (!requested || released || run != null || switchingLens) return
        val thread = HandlerThread("rabbit-camera").apply { start() }
        run = CameraRun(thread)
        onReadyChanged?.invoke(false)
        updateControls()
        openIfReady()
    }

    private fun closeRun(then: (() -> Unit)? = null) {
        val closing = run ?: run { then?.invoke(); return }
        run = null
        closing.closed = true
        closing.capturing = false
        onReadyChanged?.invoke(false)
        updateControls()
        closing.handler.post {
            closing.session?.close()
            closing.device?.close()
            closing.previewSurface?.release()
            closing.reader?.close()
            closing.session = null
            closing.device = null
            closing.previewSurface = null
            closing.reader = null
            closing.thread.quitSafely()
            if (then != null) main.post { then() }
        }
    }

    fun release() {
        if (released) return
        stop()
        released = true
        texture.animate().cancel()
        loading.animate().cancel()
        errorPanel.animate().cancel()
        flash.animate().cancel()
        frozenPhoto.animate().cancel()
        frozenPhoto.setImageDrawable(null)
        switchCamera.animate().cancel()
        main.removeCallbacksAndMessages(null)
        onPhoto = null
        onClose = null
        onError = null
        onReadyChanged = null
    }

    @SuppressLint("MissingPermission")
    private fun openIfReady() {
        val active = run ?: return
        if (!current(active) || active.opening || !texture.isAvailable || viewport.width == 0) return
        if (context.checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            fail(active, "请允许兔球使用相机后重试。")
            return
        }
        active.opening = true
        try {
            val cameras = cameraManager.cameraIdList.map { it to cameraManager.getCameraCharacteristics(it) }.filter { (_, info) ->
                val outputs = info.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
                outputs != null && outputs.getOutputSizes(android.graphics.ImageFormat.JPEG)?.isNotEmpty() == true &&
                    outputs.getOutputSizes(SurfaceTexture::class.java)?.isNotEmpty() == true
            }
            canSwitch = cameras.any { it.second.get(CameraCharacteristics.LENS_FACING) == CameraCharacteristics.LENS_FACING_BACK } &&
                cameras.any { it.second.get(CameraCharacteristics.LENS_FACING) == CameraCharacteristics.LENS_FACING_FRONT }
            val chosen = cameras.firstOrNull { it.second.get(CameraCharacteristics.LENS_FACING) == requestedFacing }
                ?: cameras.firstOrNull() ?: run { fail(active, "此设备没有可用的相机。"); return }
            val cameraId = chosen.first
            val characteristics = chosen.second
            val outputs = characteristics.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
                ?: run { fail(active, "相机暂时无法提供画面。"); return }
            val photos = outputs.getOutputSizes(android.graphics.ImageFormat.JPEG).toList()
            active.photoSize = photos.filter { max(it.width, it.height) <= 2560 }
                .maxByOrNull { it.width.toLong() * it.height } ?: photos.minBy { it.width.toLong() * it.height }
            val ratio = active.photoSize.width.toFloat() / active.photoSize.height
            val previews = outputs.getOutputSizes(SurfaceTexture::class.java).toList()
            val bounded = previews.filter { max(it.width, it.height) <= 1920 && min(it.width, it.height) <= 1080 }.ifEmpty { previews }
            active.previewSize = bounded.sortedWith(compareBy<Size> { abs(it.width.toFloat() / it.height - ratio) }
                .thenByDescending { it.width.toLong() * it.height }).first()
            active.sensorOrientation = characteristics.get(CameraCharacteristics.SENSOR_ORIENTATION) ?: 0
            active.front = characteristics.get(CameraCharacteristics.LENS_FACING) == CameraCharacteristics.LENS_FACING_FRONT
            requestedFacing = if (active.front) CameraCharacteristics.LENS_FACING_FRONT else CameraCharacteristics.LENS_FACING_BACK
            updateControls()
            val modes = characteristics.get(CameraCharacteristics.CONTROL_AF_AVAILABLE_MODES) ?: intArrayOf()
            active.autofocus = when {
                CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE in modes -> CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE
                CaptureRequest.CONTROL_AF_MODE_AUTO in modes -> CaptureRequest.CONTROL_AF_MODE_AUTO
                else -> CaptureRequest.CONTROL_AF_MODE_OFF
            }
            active.reader = ImageReader.newInstance(active.photoSize.width, active.photoSize.height,
                android.graphics.ImageFormat.JPEG, 2).apply {
                setOnImageAvailableListener({ reader -> readPhoto(active, reader) }, active.handler)
            }
            texture.surfaceTexture!!.setDefaultBufferSize(active.previewSize.width, active.previewSize.height)
            active.previewSurface = Surface(texture.surfaceTexture)
            requestLayout()
            cameraManager.openCamera(cameraId, context.mainExecutor, object : CameraDevice.StateCallback() {
                override fun onOpened(camera: CameraDevice) {
                    if (!current(active)) { camera.close(); return }
                    active.device = camera
                    createSession(active)
                }
                override fun onDisconnected(camera: CameraDevice) { camera.close(); fail(active, "相机已断开，轻点重试。"); }
                override fun onError(camera: CameraDevice, error: Int) { camera.close(); fail(active, "相机暂时不可用，轻点重试。"); }
            })
        } catch (_: android.hardware.camera2.CameraAccessException) { fail(active, "相机正被占用，请稍后重试。") }
        catch (_: SecurityException) { fail(active, "请允许兔球使用相机后重试。") }
        catch (_: IllegalArgumentException) { fail(active, "相机暂时无法提供画面，请重试。") }
    }

    private fun createSession(active: CameraRun) {
        val device = active.device ?: return
        val preview = active.previewSurface ?: return
        val reader = active.reader ?: return
        try {
            device.createCaptureSession(SessionConfiguration(SessionConfiguration.SESSION_REGULAR,
                listOf(OutputConfiguration(preview), OutputConfiguration(reader.surface)), context.mainExecutor,
                object : CameraCaptureSession.StateCallback() {
                    override fun onConfigured(session: CameraCaptureSession) {
                        if (!current(active)) { session.close(); return }
                        active.session = session
                        try {
                            val request = device.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW).apply {
                                addTarget(preview)
                                set(CaptureRequest.CONTROL_AF_MODE, active.autofocus)
                                set(CaptureRequest.CONTROL_AE_MODE, CaptureRequest.CONTROL_AE_MODE_ON)
                            }.build()
                            session.setRepeatingRequest(request, null, null)
                        } catch (_: android.hardware.camera2.CameraAccessException) { fail(active, "相机暂时无法提供画面，请重试。") }
                        catch (_: IllegalStateException) { fail(active, "相机已暂停，请重试。") }
                    }
                    override fun onConfigureFailed(session: CameraCaptureSession) { session.close(); fail(active, "相机暂时无法提供画面，请重试。"); }
                }))
        } catch (_: android.hardware.camera2.CameraAccessException) { fail(active, "相机暂时不可用，请重试。") }
        catch (_: IllegalStateException) { fail(active, "相机已暂停，请重试。") }
    }

    fun shutterCenter(): PointF {
        val bottomInset = rootWindowInsets?.getInsets(android.view.WindowInsets.Type.navigationBars())?.bottom ?: 0
        return PointF(width * .5f, height - bottomInset - dp(78f).toFloat())
    }

    fun takePhoto() {
        val active = run ?: return
        val device = active.device ?: return
        val session = active.session ?: return
        val reader = active.reader ?: return
        if (!current(active) || !active.ready || active.capturing) return
        active.capturing = true
        active.photoRotation = CameraOrientation.jpegRotation(active.sensorOrientation, deviceOrientation, active.front)
        onReadyChanged?.invoke(false)
        updateControls()
        performHapticFeedback(android.view.HapticFeedbackConstants.CONFIRM)
        flash.animate().cancel()
        if (ValueAnimator.areAnimatorsEnabled()) {
            flash.alpha = .75f
            flash.animate().alpha(0f).setDuration(260).setInterpolator(ease).start()
        }
        try {
            val request = device.createCaptureRequest(CameraDevice.TEMPLATE_STILL_CAPTURE).apply {
                addTarget(reader.surface)
                set(CaptureRequest.CONTROL_AF_MODE, active.autofocus)
                set(CaptureRequest.CONTROL_AE_MODE, CaptureRequest.CONTROL_AE_MODE_ON)
                // 固定为零，统一在内存中旋转像素，避免 HAL 写 EXIF 或旋转数据的实现差异。
                set(CaptureRequest.JPEG_ORIENTATION, 0)
                set(CaptureRequest.JPEG_QUALITY, 94.toByte())
                set(CaptureRequest.JPEG_THUMBNAIL_SIZE, Size(0, 0))
            }.build()
            session.capture(request, object : CameraCaptureSession.CaptureCallback() {
                override fun onCaptureFailed(session: CameraCaptureSession, request: CaptureRequest, failure: CaptureFailure) {
                    if (current(active)) { active.capturing = false; updateControls(); onReadyChanged?.invoke(true); showError("没有拍到照片，请再试一次。") }
                }
            }, main)
        } catch (_: android.hardware.camera2.CameraAccessException) { fail(active, "拍摄未完成，请重试。"); }
        catch (_: IllegalStateException) { fail(active, "相机已暂停，请重试。"); }
    }

    private fun readPhoto(active: CameraRun, reader: ImageReader) {
        val image = try { reader.acquireLatestImage() } catch (_: IllegalStateException) { null } ?: return
        val bytes = try {
            if (!current(active) || !active.capturing) return
            image.planes[0].buffer.let { buffer -> ByteArray(buffer.remaining()).also { buffer.get(it) } }
        } finally { image.close() }
        if (!current(active)) return
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        var sample = 1
        while (max(bounds.outWidth, bounds.outHeight) / sample > 2560) sample *= 2
        val decoded = BitmapFactory.decodeByteArray(bytes, 0, bytes.size,
            BitmapFactory.Options().apply { inSampleSize = sample; inPreferredConfig = Bitmap.Config.ARGB_8888 })
        if (decoded == null) { main.post { fail(active, "暂时无法读取照片，请重试。") }; return }
        if (!current(active)) { decoded.recycle(); return }
        val photo = CameraOrientation.normaliseBitmap(decoded, active.photoRotation)
        if (photo !== decoded) decoded.recycle()
        main.post {
            val receiver = onPhoto
            if (!current(active) || receiver == null) { photo.recycle(); return@post }
            // 显示实际拍到的正向照片，宿主随后平滑切换为可圈选画面。
            frozenIsSwitch = false
            frozenPhoto.animate().cancel()
            frozenPhoto.scaleType = ImageView.ScaleType.CENTER_CROP
            frozenPhoto.scaleX = 1f
            frozenPhoto.scaleY = 1f
            frozenPhoto.rotation = 0f
            frozenPhoto.setImageBitmap(photo)
            frozenPhoto.visibility = VISIBLE
            frozenPhoto.alpha = 0f
            frozenPhoto.animate().alpha(1f).setDuration(140).setInterpolator(ease).start()
            try { active.session?.stopRepeating() }
            catch (_: android.hardware.camera2.CameraAccessException) { }
            catch (_: IllegalStateException) { }
            receiver(photo)
        }
    }

    private fun fail(active: CameraRun, message: String) {
        if (!current(active)) return
        stop()
        loading.animate().cancel()
        loading.visibility = GONE
        showError(message)
    }

    private fun showError(message: String) {
        if (released) return
        errorText.text = message
        errorPanel.visibility = VISIBLE
        errorPanel.alpha = 0f
        errorPanel.translationY = dp(8f).toFloat()
        errorPanel.animate().alpha(1f).translationY(0f).setDuration(260).setInterpolator(ease).start()
        onError?.invoke(message)
    }

    private fun updateControls() {
        val visible = canSwitch && !released
        if (visible && switchCamera.visibility != VISIBLE) {
            switchCamera.visibility = VISIBLE
            switchCamera.alpha = 0f
        } else if (!visible) switchCamera.visibility = INVISIBLE
        switchCamera.isEnabled = visible && isReady && !switchingLens
        val target = if (switchCamera.isEnabled) 1f else .45f
        if (ValueAnimator.areAnimatorsEnabled()) switchCamera.animate().alpha(target).setDuration(180).setInterpolator(ease).start()
        else switchCamera.alpha = target
    }

    private fun switchLens() {
        if (!canSwitch || !isReady || switchingLens || released) return
        switchingLens = true
        requestedFacing = if (requestedFacing == CameraCharacteristics.LENS_FACING_BACK) CameraCharacteristics.LENS_FACING_FRONT
            else CameraCharacteristics.LENS_FACING_BACK
        switchCamera.turn()
        // 只暂存低分辨率的最后一帧，切镜期间不露黑底，也不会写出图像文件。
        val factor = min(1f, 800f / max(texture.width, texture.height).coerceAtLeast(1))
        val lastFrame = texture.getBitmap(max(1, (texture.width * factor).roundToInt()), max(1, (texture.height * factor).roundToInt()))
        if (lastFrame != null) {
            frozenPhoto.animate().cancel()
            frozenPhoto.scaleType = ImageView.ScaleType.FIT_XY
            frozenPhoto.setImageBitmap(lastFrame)
            frozenPhoto.scaleX = texture.scaleX
            frozenPhoto.scaleY = texture.scaleY
            frozenPhoto.rotation = texture.rotation
            frozenPhoto.alpha = 1f
            frozenPhoto.visibility = VISIBLE
            frozenIsSwitch = true
            texture.animate().cancel()
            texture.alpha = 0f
        }
        loading.visibility = VISIBLE
        loading.alpha = 1f
        errorPanel.visibility = GONE
        closeRun {
            switchingLens = false
            if (requested && !released) createRun()
        }
    }

    private fun clearSwitchFreeze(active: CameraRun) {
        if (!current(active) || !frozenIsSwitch) return
        frozenIsSwitch = false
        frozenPhoto.visibility = GONE
        frozenPhoto.setImageDrawable(null)
    }

    override fun onSensorChanged(event: SensorEvent) {
        if (!requested) return
        val angle = if (event.sensor.type == Sensor.TYPE_GAME_ROTATION_VECTOR || event.sensor.type == Sensor.TYPE_ROTATION_VECTOR) {
            SensorManager.getRotationMatrixFromVector(rotation, event.values)
            CameraOrientation.fromGravity(rotation[6], rotation[7], rotation[8])
        } else {
            for (index in 0..2) filteredGravity[index] = if (!hasGravity) event.values[index]
                else filteredGravity[index] * .8f + event.values[index] * .2f
            hasGravity = true
            CameraOrientation.fromGravity(filteredGravity[0], filteredGravity[1], filteredGravity[2])
        } ?: return
        val candidate = ((angle + 45) / 90 * 90) % 360
        val difference = min(abs(angle - deviceOrientation), 360 - abs(angle - deviceOrientation))
        if (!stableOrientation || difference >= 60) { deviceOrientation = candidate; stableOrientation = true }
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit
    private val displayListener = object : DisplayManager.DisplayListener {
        override fun onDisplayAdded(displayId: Int) = Unit
        override fun onDisplayRemoved(displayId: Int) = Unit
        override fun onDisplayChanged(displayId: Int) { if (display?.displayId == displayId) requestLayout() }
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val safe = rootWindowInsets?.getInsets(android.view.WindowInsets.Type.systemBars() or android.view.WindowInsets.Type.displayCutout())
        (viewport.layoutParams as LayoutParams).apply {
            topMargin = (safe?.top ?: 0) + dp(16f)
            bottomMargin = (safe?.bottom ?: 0) + dp(148f)
        }
        super.onMeasure(widthMeasureSpec, heightMeasureSpec)
    }

    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
        super.onLayout(changed, left, top, right, bottom)
        val anchor = shutterCenter()
        val touchSize = dp(CAMERA_CONTROL_TOUCH_DP)
        val halfTouch = touchSize * .5f
        val offset = min(dp(96f).toFloat(), (width * .5f - halfTouch - dp(16f)).coerceAtLeast(0f))
        val controlsY = (anchor.y - halfTouch).roundToInt()
        val closeX = (anchor.x - offset - halfTouch).roundToInt()
        val switchX = (anchor.x + offset - halfTouch).roundToInt()
        close.layout(closeX, controlsY, closeX + touchSize, controlsY + touchSize)
        switchCamera.layout(switchX, controlsY, switchX + touchSize, controlsY + touchSize)
        val active = run
        if (active != null && viewport.width > 0 && viewport.height > 0) {
            val sensorSwapped = active.sensorOrientation % 180 != 0
            val naturalWidth = if (sensorSwapped) active.previewSize.height else active.previewSize.width
            val naturalHeight = if (sensorSwapped) active.previewSize.width else active.previewSize.height
            val displayDegrees = (display?.rotation ?: Surface.ROTATION_0) * 90
            val displaySwapped = displayDegrees % 180 != 0
            val visibleWidth = if (displaySwapped) naturalHeight else naturalWidth
            val visibleHeight = if (displaySwapped) naturalWidth else naturalHeight
            val scale = max(viewport.width.toFloat() / visibleWidth, viewport.height.toFloat() / visibleHeight)
            val scaleX = naturalWidth * scale / viewport.width
            val scaleY = naturalHeight * scale / viewport.height
            val targetRotation = texture.rotation + ((-displayDegrees - texture.rotation + 540f) % 360f - 180f)
            if (previewScaleX != scaleX || previewScaleY != scaleY || previewRotation != targetRotation) {
                previewScaleX = scaleX
                previewScaleY = scaleY
                previewRotation = targetRotation
                // 先抵消默认拉伸，再补显示旋转并等比铺满；只裁取景显示，原照片仍完整。
                if (active.ready && ValueAnimator.areAnimatorsEnabled()) {
                    texture.animate().scaleX(scaleX).scaleY(scaleY).rotation(targetRotation)
                        .setDuration(260).setInterpolator(ease).start()
                } else {
                    texture.scaleX = scaleX
                    texture.scaleY = scaleY
                    texture.rotation = targetRotation
                }
            }
        }
        openIfReady()
    }

    override fun onWindowVisibilityChanged(visibility: Int) {
        super.onWindowVisibilityChanged(visibility)
        if (visibility != VISIBLE) stop()
    }

    override fun onDetachedFromWindow() {
        stop()
        super.onDetachedFromWindow()
    }
}

/** 相机辅助操作延续 PC 的方圆底板，尺寸与兔球球体保持比例。 */
private class CameraControl(context: Context, private val switch: Boolean) : FrameLayout(context) {
    private val icon = object : View(context) {
        private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = 0xFF785D6A.toInt()
            style = Paint.Style.STROKE
            strokeWidth = 2.25f
            strokeCap = Paint.Cap.ROUND
            strokeJoin = Paint.Join.ROUND
        }
        private val path = Path()
        init {
            background = Palette.ripple(context, 0xFFF4F4F6.toInt(), CAMERA_CONTROL_SIDE_DP * 9f / 32f)
            importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
            isDuplicateParentStateEnabled = true
        }
        override fun onDraw(canvas: Canvas) {
            super.onDraw(canvas)
            val size = CAMERA_CONTROL_SIDE_DP * .5f * resources.displayMetrics.density
            canvas.save()
            canvas.translate((width - size) / 2f, (height - size) / 2f)
            canvas.scale(size / 24f, size / 24f)
            path.rewind()
            if (switch) {
                path.moveTo(20f, 7f); path.lineTo(15f, 7f); path.moveTo(20f, 7f); path.lineTo(20f, 2f)
                path.moveTo(4f, 17f); path.lineTo(9f, 17f); path.moveTo(4f, 17f); path.lineTo(4f, 22f)
                path.moveTo(19.5f, 6.5f); path.cubicTo(15f, -.5f, 5f, 2f, 4f, 10f)
                path.moveTo(4.5f, 17.5f); path.cubicTo(9f, 24.5f, 19f, 22f, 20f, 14f)
            } else {
                path.moveTo(6f, 6f); path.lineTo(18f, 18f)
                path.moveTo(18f, 6f); path.lineTo(6f, 18f)
            }
            canvas.drawPath(path, paint)
            canvas.restore()
        }
    }

    init {
        isClickable = true
        isFocusable = true
        val side = Palette.dp(context, CAMERA_CONTROL_SIDE_DP)
        addView(icon, LayoutParams(side, side, Gravity.CENTER))
    }

    fun turn() {
        if (ValueAnimator.areAnimatorsEnabled()) icon.animate().rotation(icon.rotation + 180f)
            .setDuration(320).setInterpolator(PathInterpolator(.2f, .8f, .2f, 1f)).start()
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        if (isEnabled && ValueAnimator.areAnimatorsEnabled()) when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> animate().scaleX(.88f).scaleY(.88f).setDuration(110)
                .setInterpolator(PathInterpolator(.2f, 0f, .2f, 1f)).start()
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> animate().scaleX(1f).scaleY(1f)
                .setDuration(420).setInterpolator(android.view.animation.OvershootInterpolator(1.8f)).start()
        }
        return super.onTouchEvent(event)
    }
}
