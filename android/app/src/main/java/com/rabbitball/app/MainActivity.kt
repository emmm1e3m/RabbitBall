package com.rabbitball.app

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.provider.Settings
import android.view.WindowManager
import android.view.WindowInsetsController
import android.window.OnBackInvokedDispatcher
import com.rabbitball.app.ui.SearchView
import com.rabbitball.app.ui.SettingsView
import java.lang.ref.WeakReference
import java.io.IOException
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.Future

class MainActivity : Activity() {
    companion object {
        const val ACTION_CAPTURED = "com.rabbitball.app.CAPTURED"
        const val ACTION_SETTINGS = "com.rabbitball.app.SETTINGS"
        private const val CAMERA_PERMISSION_REQUEST = 201
        private const val IMAGE_PICK_REQUEST = 202
    }
    private lateinit var settings: AppSettings
    private lateinit var history: ChatHistory
    private val ai = AiClient()
    private var search: SearchView? = null
    private var settingsView: SettingsView? = null
    private var visualContext: VisualContext? = null
    private var retryCaptureAfterSettings = false
    private var conversationId: String? = null
    private var cameraPermissionTarget: WeakReference<SearchView>? = null
    private var cameraPermissionDenied = false
    private var cameraSettingsPending = false
    private var imagePickerTarget: WeakReference<SearchView>? = null
    private var imageImportWorker: ExecutorService? = null
    private var imageImportFuture: Future<*>? = null
    private var imageImportGeneration = 0
    private val mainHandler = Handler(Looper.getMainLooper())
    private val turns = mutableListOf<ChatTurn>()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (Build.VERSION.SDK_INT >= 33) setRecentsScreenshotEnabled(false)
        window.setDecorFitsSystemWindows(false)
        window.clearFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
        settings = AppSettings(this)
        history = ChatHistory(this)
        if (Build.VERSION.SDK_INT >= 33) {
            onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT) { handleBack() }
        }
        route(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        route(intent)
    }

    private fun route(intent: Intent) {
        RabbitAccessibilityService.setSearchVisible(true)
        if (!settings.setupComplete || intent.action == ACTION_SETTINGS) {
            CaptureStore.clear()
            showSettings()
        } else if (intent.action == ACTION_CAPTURED) {
            val result = CaptureStore.take()
            acceptCapture(result?.bitmap, result?.error)
        } else showSearch()
    }

    private fun stopRequest() { ai.cancel(); search?.setBusy(false) }

    private fun beginCapture() {
        stopRequest()
        // 旧聊天任务先结束；透明入口在独立空任务中采集，之后才打开新的聊天界面。
        startActivity(Intent(this, CaptureActivity::class.java).setAction(CaptureActivity.ACTION_CAPTURE)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_ANIMATION))
        finishAndRemoveTask()
    }

    private fun openCaptureSetup(retry: Boolean) {
        retryCaptureAfterSettings = retry
        startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
    }

    // 所有视觉上下文替换共用取消与会话清理，具体画面和草稿由各入口决定。
    private fun replaceConversation(visual: VisualContext?, saved: SavedChat? = null) {
        cancelImageImport()
        ai.resetConversation()
        search?.setBusy(false)
        visualContext = visual
        conversationId = saved?.id
        turns.clear()
        saved?.let { turns.addAll(it.turns) }
    }

    private fun acceptCapture(bitmap: Bitmap?, error: String?) {
        replaceConversation(bitmap?.let { VisualContext(it, VisualSource.SCREEN) })
        search?.release()
        search = null
        showSearch()
        if (bitmap == null) search?.setStatus(error ?: "轻点中央图标开启即开即选，之后打开兔球就能框选屏幕。")
    }

    private fun showSearch() {
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING or WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN)
        settingsView = null
        RabbitAccessibilityService.setSearchVisible(true)
        val previous = search
        val view = previous ?: SearchView(this)
        search = view
        view.onHistory = { stopRequest(); cancelImageImport(); showHistory() }
        view.onRecapture = { beginCapture() }
        view.onCaptureSetup = { openCaptureSetup(retry = true) }
        view.onCameraRequested = { requestCamera(view) }
        view.onPhotoCaptured = { image -> acceptPhoto(view, image, VisualSource.CAMERA) }
        view.onPickImageRequested = { pickImage(view) }
        view.onCancelRequest = { stopRequest(); view.setStatus("已停止，可以继续提问。") }
        view.onSend = { text, action -> send(text, action) }
        setContentView(view)
        if (previous == null) {
            view.setScreenshot(visualContext?.bitmap)
        }
    }

    private fun requestCamera(view: SearchView) {
        if (search !== view || settingsView != null || isFinishing || isDestroyed) return
        if (cameraPermissionTarget?.get() != null || cameraSettingsPending) return
        cancelImageImport()
        if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            view.openCamera()
            return
        }
        cameraPermissionTarget = WeakReference(view)
        if (cameraPermissionDenied && !shouldShowRequestPermissionRationale(Manifest.permission.CAMERA)) {
            cameraSettingsPending = true
            startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
        } else requestPermissions(arrayOf(Manifest.permission.CAMERA), CAMERA_PERMISSION_REQUEST)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != CAMERA_PERMISSION_REQUEST) return
        val target = cameraPermissionTarget?.get()
        cameraPermissionTarget = null
        if (target == null || target !== search || settingsView != null || isFinishing || isDestroyed) return
        if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) {
            cameraPermissionDenied = false
            target.openCamera()
        } else {
            cameraPermissionDenied = true
            target.setStatus(if (shouldShowRequestPermissionRationale(Manifest.permission.CAMERA))
                "允许相机权限后即可拍照，再次轻点拍照开启。" else "相机权限已关闭，轻点拍照前往设置开启。")
        }
    }

    private fun acceptPhoto(view: SearchView, image: Bitmap, source: VisualSource) {
        if (view !== search || settingsView != null || isFinishing || isDestroyed) {
            image.recycle()
            return
        }
        replaceConversation(VisualContext(image, source))
        view.setPhoto(image)
    }

    // 照片选择器可通过系统更新回移到旧版本；没有该入口时使用系统文档选择器。
    @SuppressLint("InlinedApi")
    private fun pickImage(view: SearchView) {
        if (search !== view || settingsView != null || isFinishing || isDestroyed || imagePickerTarget?.get() != null) return
        cancelImageImport()
        val picker = Intent(MediaStore.ACTION_PICK_IMAGES).setType("image/*")
        val intent = if (picker.resolveActivity(packageManager) != null) picker else
            Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("image/*")
        imagePickerTarget = WeakReference(view)
        try { startActivityForResult(intent, IMAGE_PICK_REQUEST) }
        catch (_: android.content.ActivityNotFoundException) {
            imagePickerTarget = null
            view.setStatus("系统暂时无法选择照片，可以直接拍照。")
        }
    }

    @Deprecated("照片选择器使用平台 Activity 结果回调")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != IMAGE_PICK_REQUEST) return
        val target = imagePickerTarget?.get()
        imagePickerTarget = null
        if (resultCode != RESULT_OK || target == null || target !== search || settingsView != null || isFinishing || isDestroyed) return
        val uri = data?.data
        if (uri?.scheme != "content") {
            target.setStatus("未能读取这张照片，请重新选择。")
            return
        }
        val generation = ++imageImportGeneration
        target.setPhotoLoading(true)
        val application = applicationContext
        val worker = imageImportWorker ?: Executors.newSingleThreadExecutor { task ->
            Thread(task, "rabbit-image-import").apply { isDaemon = true }
        }.also { imageImportWorker = it }
        imageImportFuture = worker.submit {
            val image = try { ImageImport.decode(application, uri) }
                catch (_: IOException) { null }
                catch (_: SecurityException) { null }
                catch (_: IllegalArgumentException) { null }
            if (Thread.currentThread().isInterrupted) {
                image?.recycle()
                return@submit
            }
            mainHandler.post {
                if (generation != imageImportGeneration || target !== search || settingsView != null || isFinishing || isDestroyed) {
                    image?.recycle()
                    return@post
                }
                imageImportFuture = null
                target.setPhotoLoading(false)
                if (image != null) acceptPhoto(target, image, VisualSource.PHOTO)
                else target.setStatus("照片无法读取，请换一张再试。")
            }
        }
    }

    private fun cancelImageImport() {
        imageImportGeneration++
        imageImportFuture?.cancel(true)
        imageImportFuture = null
        search?.setPhotoLoading(false)
    }

    private fun send(text: String, action: String) {
        val view = search ?: return
        val config = settings.load().model
        val userText = text.ifBlank { when(action) { "search" -> "搜索选中内容"; "translate" -> "翻译选中内容"; "extract" -> "提取选中文字"; else -> "解释选中内容" } }
        val selectedRegion = view.selection
        stopRequest()
        view.beginTurn(userText)
        if (config.apiKey.isBlank()) {
            view.showResponse("请先在设置中填写 DeepSeek API Key。", true)
            return
        }
        view.setBusy(true)
        ai.request(config, text, action, visualContext, selectedRegion, turns.toList(),
            onDelta = { view.showResponse(it) },
            onDone = { response ->
                view.showResponse(response)
                view.setBusy(false)
                turns.add(ChatTurn("user", userText))
                turns.add(ChatTurn("assistant", response))
                try {
                    conversationId = history.save(conversationId, turns.first().content.take(36), turns).id
                } catch (_: java.io.IOException) { view.setStatus("回答已完成，本次历史未能保存。") }
            },
            onError = { view.showResponse(it, true); view.setBusy(false) },
            onSearchCount = view::setSearchCount)
    }

    private fun showSettings() {
        cancelImageImport()
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE or WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN)
        val view = SettingsView(this, settings.load(), !settings.setupComplete)
        settingsView = view
        view.onClose = { showSearch() }
        view.onAccessibility = {
            openCaptureSetup(retry = false)
        }
        view.onAssistant = {
            startActivity(Intent(Settings.ACTION_VOICE_INPUT_SETTINGS))
        }
        view.onPetMode = { RabbitAccessibilityService.refreshPet() }
        view.onHistory = { showHistory() }
        view.onSave = { config, first ->
            try {
                settings.save(config)
                history.trim()
                settings.setupComplete = true
                search?.refreshAppearance()
                RabbitAccessibilityService.refreshPet()
                if (first) beginCapture() else showSearch()
            } catch (e: Exception) { view.showError(e.message ?: "设置未能保存。") }
        }
        setContentView(view)
        val lightBars = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
        window.decorView.windowInsetsController?.setSystemBarsAppearance(lightBars, lightBars)
        view.updateAccess(RabbitAccessibilityService.instance != null, RabbitAccessibilityService.isEnabled(this))
    }

    private fun showHistory() {
        val entries = history.list()
        if (entries.isEmpty()) {
            AlertDialog.Builder(this).setTitle("还没有对话").setMessage("完成的问答会保存在这里，截图不会保存。").setPositiveButton("知道了", null).show()
            return
        }
        AlertDialog.Builder(this).setTitle("最近的对话")
            .setItems(entries.map { it.title }.toTypedArray()) { _, index ->
                val entry = entries[index]
                // 恢复文字对话时清理模型图片上下文，视图继续保留当前模糊背景。
                replaceConversation(null, entry)
                showSearch()
                search?.restoreConversation(turns.toList())
            }.setNegativeButton("返回", null).show()
    }

    override fun onResume() {
        super.onResume()
        RabbitAccessibilityService.setSearchVisible(true)
        settingsView?.updateAccess(RabbitAccessibilityService.instance != null, RabbitAccessibilityService.isEnabled(this))
        if (settingsView == null) search?.resumeCamera()
        if (cameraSettingsPending) {
            cameraSettingsPending = false
            val target = cameraPermissionTarget?.get()
            cameraPermissionTarget = null
            if (target != null && target === search && settingsView == null) {
                if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                    cameraPermissionDenied = false
                    target.openCamera()
                } else target.setStatus("相机权限未开启，可以继续使用当前画面。")
            }
        }
        if (retryCaptureAfterSettings && settings.setupComplete) {
            retryCaptureAfterSettings = false
            beginCapture()
            return
        }
    }

    override fun onPause() {
        search?.pauseCamera()
        super.onPause()
    }

    private fun finishSearch() { stopRequest(); finishAndRemoveTask() }

    override fun onStop() {
        RabbitAccessibilityService.setSearchVisible(false, search?.petScreenPosition())
        super.onStop()
    }

    private fun handleBack() {
        if (settingsView == null && search?.dismissPhotoMenu() == true) return
        if (settingsView == null && search?.closeCamera() == true) return
        if (settingsView != null && settings.setupComplete) showSearch() else finishSearch()
    }

    // Android 13 起已注册平台回调，此入口仅供 Android 11、12 的返回键使用。
    @SuppressLint("GestureBackNavigation")
    @Deprecated("Android 13 及以上使用 OnBackInvokedDispatcher")
    override fun onBackPressed() = handleBack()

    override fun onDestroy() {
        cancelImageImport()
        imageImportWorker?.shutdownNow()
        imageImportWorker = null
        imagePickerTarget = null
        stopRequest()
        search?.release()
        search = null
        cameraPermissionTarget = null
        visualContext = null
        RabbitAccessibilityService.setSearchVisible(false)
        super.onDestroy()
    }
}
