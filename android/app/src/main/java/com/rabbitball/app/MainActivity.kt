package com.rabbitball.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.MediaStore
import android.provider.Settings
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.window.OnBackInvokedDispatcher
import com.rabbitball.app.ui.HistoryView
import com.rabbitball.app.ui.SettingsView

/** 设置与系统交互宿主；相机暂时接管同一会话视图，保证前台权限和自由旋转。 */
class MainActivity : Activity() {
    companion object {
        const val ACTION_CAPTURED = "com.rabbitball.app.CAPTURED"
        const val ACTION_SETTINGS = "com.rabbitball.app.SETTINGS"
        const val ACTION_CAMERA = "com.rabbitball.app.CAMERA"
        const val ACTION_PHOTO = "com.rabbitball.app.PHOTO"
        const val ACTION_ASSISTANT = "com.rabbitball.app.ASSISTANT_SETUP"
        const val ACTION_SOURCE = "com.rabbitball.app.SOURCE"
        private const val CAMERA_PERMISSION_REQUEST = 201
        private const val IMAGE_PICK_REQUEST = 202
        private const val SOURCE_REQUEST = 203
        private var cameraDenied = false

        fun externalIntent(context: Context, action: String) = Intent(context, MainActivity::class.java)
            .setAction(action).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or
                Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_NO_ANIMATION)
    }
    private lateinit var settings: AppSettings
    private var settingsView: SettingsView? = null
    private var historyView: HistoryView? = null
    private var session: SearchSession? = null
    private var ownsSession = false
    private var mode: String? = null
    private var resumed = false
    private var cameraStarted = false
    private var cameraSettingsPending = false
    private var captureSettingsPending = false
    private var externalDeparted = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        settings = AppSettings(this)
        if (Build.VERSION.SDK_INT >= 33) setRecentsScreenshotEnabled(false)
        if (Build.VERSION.SDK_INT >= 34) {
            overrideActivityTransition(OVERRIDE_TRANSITION_OPEN, 0, 0)
            overrideActivityTransition(OVERRIDE_TRANSITION_CLOSE, 0, 0)
        }
        window.setDecorFitsSystemWindows(false)
        window.clearFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
        if (Build.VERSION.SDK_INT >= 33) {
            onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, ::handleBack)
        }
        route(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        route(intent)
    }

    private fun route(intent: Intent) {
        closeHistory()
        mode = intent.action
        if (!settings.setupComplete || mode == ACTION_SETTINGS) {
            session = SearchSession.active
            session?.setExternalVisible(true)
            showSettings()
        } else if (mode in listOf(ACTION_CAMERA, ACTION_PHOTO, ACTION_ASSISTANT, ACTION_SOURCE)) {
            session = SearchSession.active
            if (session == null) { finish(); return }
            beginExternal(mode!!)
        } else {
            // 尚未授权任何系统窗口时，仍允许在应用内配置和输入文字。
            val controller = createActivitySession()
            controller.acceptCapture(CaptureStore.take() ?: CaptureResult(null, null))
        }
    }

    private fun attachSession() {
        val controller = session ?: return
        settingsView = null
        (controller.root.parent as? ViewGroup)?.removeView(controller.root)
        setContentView(controller.root)
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING or
            WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN)
        controller.root.requestApplyInsets()
    }

    private fun createActivitySession(): SearchSession {
        if (ownsSession) { session?.release(); session = null }
        val controller = SearchSession(this, {
            session?.release()
            session = null
            finishAndRemoveTask()
        }, {
            session?.close()
            CaptureActivity.activate(this)
        }, ::beginExternal)
        session = controller
        ownsSession = true
        controller.onExternalVisibilityChanged = { external -> if (!external) attachSession() }
        attachSession()
        RabbitAccessibilityService.setSearchVisible(true)
        return controller
    }

    private fun beginExternal(action: String) {
        mode = action
        externalDeparted = false
        attachSession()
        when (action) {
            ACTION_CAMERA -> {
                if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) startCamera()
                else if (cameraDenied && !shouldShowRequestPermissionRationale(Manifest.permission.CAMERA)) {
                    cameraSettingsPending = true
                    startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
                } else requestPermissions(arrayOf(Manifest.permission.CAMERA), CAMERA_PERMISSION_REQUEST)
            }
            ACTION_PHOTO -> pickImage()
            ACTION_SOURCE -> {
                val uri = session?.pendingSourceUri
                if (uri == null) completeExternal()
                else try { startActivityForResult(Intent(Intent.ACTION_VIEW, uri), SOURCE_REQUEST) }
                catch (_: android.content.ActivityNotFoundException) {
                    session?.search?.setStatus("系统暂时无法打开网页。")
                    completeExternal()
                }
            }
            ACTION_ASSISTANT -> {
                captureSettingsPending = true
                startActivity(Intent(Settings.ACTION_VOICE_INPUT_SETTINGS))
            }
        }
    }

    private fun startCamera() {
        val controller = session ?: return
        if (!resumed || cameraStarted || !controller.isActive()) return
        cameraStarted = true
        controller.onCameraFinished = { completeExternal() }
        controller.search.resumeCamera()
        controller.openCamera()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != CAMERA_PERMISSION_REQUEST) return
        if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) {
            cameraDenied = false
            startCamera()
        } else {
            cameraDenied = true
            session?.search?.setStatus("相机权限未开启，可以继续使用当前画面；再次拍照可重新授权。")
            completeExternal()
        }
    }

    @SuppressLint("InlinedApi")
    private fun pickImage() {
        val picker = Intent(MediaStore.ACTION_PICK_IMAGES).setType("image/*")
        val request = if (picker.resolveActivity(packageManager) != null) picker else
            Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("image/*")
        try { startActivityForResult(request, IMAGE_PICK_REQUEST) }
        catch (_: android.content.ActivityNotFoundException) {
            session?.search?.setStatus("系统暂时无法选择照片，可以直接拍照。")
            completeExternal()
        }
    }

    @Deprecated("系统照片选择器使用平台结果回调")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == SOURCE_REQUEST) { completeExternal(); return }
        if (requestCode != IMAGE_PICK_REQUEST) return
        val target = session
        completeExternal()
        if (resultCode == RESULT_OK) target?.acceptPickedImage(data?.data)
    }

    private fun completeExternal() {
        val controller = session
        cameraStarted = false
        controller?.onCameraFinished = null
        controller?.setExternalVisible(false)
        if (ownsSession) {
            mode = ACTION_CAPTURED
            attachSession()
            controller?.resume()
        } else {
            session = null
            finishAndRemoveTask()
        }
    }

    private fun showSettings() {
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
        val view = SettingsView(this, settings.load(), !settings.setupComplete)
        settingsView = view
        view.onClose = ::finishSettings
        view.onAccessibility = { startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)) }
        view.onAssistant = { startActivity(Intent(Settings.ACTION_VOICE_INPUT_SETTINGS)) }
        view.onPetMode = { RabbitAccessibilityService.refreshPet() }
        view.onHistory = ::showHistory
        view.onSave = { config, first ->
            try {
                settings.save(config)
                ChatHistory(this).trim()
                settings.setupComplete = true
                session?.search?.refreshAppearance()
                session?.search?.refreshHistoryAvailability()
                RabbitAccessibilityService.refreshPet()
                if (first) {
                    finishAndRemoveTask()
                    CaptureActivity.activate(this)
                } else finishSettings()
            } catch (e: Exception) { view.showError(e.message ?: "设置未能保存。") }
        }
        setContentView(view)
        val light = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
        window.decorView.windowInsetsController?.setSystemBarsAppearance(light, light)
        view.updateAccess(RabbitAccessibilityService.instance != null, RabbitAccessibilityService.isEnabled(this))
    }

    private fun finishSettings() {
        if (session?.isActive() == true) completeExternal() else finishAndRemoveTask()
    }

    private fun showHistory() {
        if (historyView != null || settings.historyLimit == 0) return
        window.decorView.windowInsetsController?.hide(WindowInsets.Type.ime())
        currentFocus?.clearFocus()
        val history = ChatHistory(this)
        val overlay = HistoryView(this, history.list())
        historyView = overlay
        overlay.onClosed = ::closeHistory
        overlay.onDelete = { entry ->
            try { history.delete(entry.id); true }
            catch (_: java.io.IOException) { overlay.showError("这条记录暂时无法删除，请重试。"); false }
        }
        overlay.onOpen = { entry ->
            val controller = session?.takeIf { it.isActive() } ?: createActivitySession()
            controller.restoreHistory(entry)
            if (ownsSession) { mode = ACTION_CAPTURED; attachSession() } else completeExternal()
        }
        (window.decorView as ViewGroup).addView(overlay, ViewGroup.LayoutParams(-1, -1))
        overlay.show()
    }

    private fun closeHistory() {
        val overlay = historyView ?: return
        historyView = null
        (overlay.parent as? ViewGroup)?.removeView(overlay)
        overlay.release()
    }

    override fun onResume() {
        super.onResume()
        resumed = true
        settingsView?.updateAccess(RabbitAccessibilityService.instance != null, RabbitAccessibilityService.isEnabled(this))
        if (captureSettingsPending && externalDeparted) {
            captureSettingsPending = false
            session?.close()
            session = null
            finishAndRemoveTask()
            CaptureActivity.activate(this)
            return
        }
        if (cameraSettingsPending && externalDeparted) {
            cameraSettingsPending = false
            if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
                session?.search?.setStatus("相机权限未开启，可以继续使用当前画面。")
                completeExternal()
                return
            }
        }
        if (settingsView == null) session?.search?.resumeCamera()
        if (mode == ACTION_CAMERA && checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) startCamera()
    }

    override fun onPause() {
        resumed = false
        externalDeparted = true
        if (settingsView == null) session?.pause()
        super.onPause()
    }

    override fun onStop() {
        if (cameraStarted && !isChangingConfigurations && !isFinishing) {
            session?.close()
            finishAndRemoveTask()
        }
        super.onStop()
    }

    private fun handleBack() {
        if (historyView?.handleBack() == true) return
        if (window.decorView.rootWindowInsets?.isVisible(WindowInsets.Type.ime()) == true) {
            window.decorView.windowInsetsController?.hide(WindowInsets.Type.ime())
            currentFocus?.clearFocus()
            return
        }
        if (settingsView != null) finishSettings() else session?.handleBack() ?: finishAndRemoveTask()
    }

    @SuppressLint("GestureBackNavigation")
    @Deprecated("Android 13 及以上使用平台返回回调")
    override fun onBackPressed() = handleBack()

    override fun onDestroy() {
        closeHistory()
        if (ownsSession) {
            session?.release()
            RabbitAccessibilityService.setSearchVisible(false)
        } else if (session?.isActive() == true) session?.close()
        session = null
        super.onDestroy()
    }
}
