package com.rabbitball.app

import android.content.Context
import android.graphics.Bitmap
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.view.inputmethod.InputMethodManager
import android.widget.FrameLayout
import com.rabbitball.app.ui.HistoryView
import com.rabbitball.app.ui.SearchView
import java.io.IOException
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.Future

/** 以助理窗口为主，备用无障碍窗口共用会话；相机和系统页面暂时交给前台 Activity。 */
class SearchSession(
    val context: Context,
    private val onClose: () -> Unit,
    private val onRecapture: () -> Unit,
    private val onExternal: (String) -> Unit
) {
    companion object {
        var active: SearchSession? = null
            private set
    }

    val root: FrameLayout
    val search: SearchView
    var onCameraFinished: (() -> Unit)? = null
    var onExternalVisibilityChanged: ((Boolean) -> Unit)? = null
    var externalVisible = false
        private set
    var pendingSourceUri: Uri? = null
        private set

    private val settings = AppSettings(context)
    private val history = ChatHistory(context)
    private val ai = AiClient()
    private var historyView: HistoryView? = null
    private var visualContext: VisualContext? = null
    private var conversationId: String? = null
    private var conversationPreview: HistoryPreview? = null
    private val turns = mutableListOf<ChatTurn>()
    private val mainHandler = Handler(Looper.getMainLooper())
    private var imageImportWorker: ExecutorService? = null
    private var imageImportFuture: Future<*>? = null
    private var imageImportGeneration = 0
    private var closing = false
    private var released = false

    init {
        active?.close()
        active = this
        root = FrameLayout(context)
        search = SearchView(context)
        root.addView(search, FrameLayout.LayoutParams(-1, -1))
        search.onHistory = ::showHistory
        search.onRecapture = {
            if (isActive()) {
                stopRequest()
                cancelImageImport()
                onRecapture()
            }
        }
        search.onCaptureSetup = {
            if (RabbitVoiceService.isDefault(context)) onRecapture()
            else openExternal(MainActivity.ACTION_ASSISTANT)
        }
        search.onCameraRequested = { openExternal(MainActivity.ACTION_CAMERA) }
        search.onPhotoCaptured = { acceptPhoto(it, VisualSource.CAMERA) }
        search.onPickImageRequested = { openExternal(MainActivity.ACTION_PHOTO) }
        search.onRemoveAttachment = ::removeAttachment
        search.onCameraClosed = {
            val finished = onCameraFinished
            onCameraFinished = null
            finished?.invoke()
        }
        search.onCancelRequest = {
            stopRequest()
            search.setStatus("已停止，可以继续提问。")
        }
        search.onSend = ::send
        search.onOpenSource = { uri ->
            pendingSourceUri = uri
            openExternal(MainActivity.ACTION_SOURCE)
        }
    }

    fun isActive(): Boolean = active === this && !closing && !released

    private fun openExternal(action: String) {
        if (!isActive() || externalVisible) return
        cancelImageImport()
        // 先标记暂离并启动页面，再隐藏助理窗口；隐藏中的助理不能启动 Activity。
        externalVisible = true
        pause()
        onExternal(action)
        onExternalVisibilityChanged?.invoke(true)
    }

    fun acceptCapture(result: CaptureResult) {
        if (!isActive()) {
            result.bitmap?.recycle()
            return
        }
        closeHistory()
        replaceConversation(result.bitmap?.let { VisualContext(it, VisualSource.SCREEN) })
        search.setScreenshot(result.bitmap)
        search.setAttachmentPreview(result.bitmap)
        if (result.bitmap == null) {
            search.setStatus(result.error ?: "轻点中央图标设置系统助理，即可唤起并框选屏幕。")
        }
    }

    private fun replaceConversation(visual: VisualContext?, saved: SavedChat? = null) {
        cancelImageImport()
        ai.resetConversation()
        search.setBusy(false)
        visualContext = visual
        conversationId = saved?.id
        conversationPreview = saved?.preview
        turns.clear()
        saved?.let { turns.addAll(it.turns) }
    }

    fun openCamera() {
        if (!isActive()) return
        cancelImageImport()
        search.openCamera()
    }

    private fun acceptPhoto(image: Bitmap, source: VisualSource) {
        if (!isActive()) {
            image.recycle()
            return
        }
        replaceConversation(VisualContext(image, source))
        search.setPhoto(image)
        search.setAttachmentPreview(image)
    }

    private fun removeAttachment() {
        if (!isActive()) return
        visualContext = null
        conversationPreview = null
        ai.resetConversation()
        search.setAttachmentPreview(null)
    }

    fun acceptPickedImage(uri: Uri?) {
        if (!isActive() || uri == null) return
        if (uri.scheme != "content") {
            search.setStatus("未能读取这张照片，请重新选择。")
            return
        }
        cancelImageImport()
        val generation = ++imageImportGeneration
        search.setPhotoLoading(true)
        val application = context.applicationContext
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
                if (generation != imageImportGeneration || !isActive()) {
                    image?.recycle()
                    return@post
                }
                imageImportFuture = null
                search.setPhotoLoading(false)
                if (image != null) acceptPhoto(image, VisualSource.PHOTO)
                else search.setStatus("照片无法读取，请换一张再试。")
            }
        }
    }

    private fun cancelImageImport() {
        imageImportGeneration++
        imageImportFuture?.cancel(true)
        imageImportFuture = null
        search.setPhotoLoading(false)
    }

    private fun stopRequest() {
        ai.cancel()
        search.setBusy(false)
    }

    private fun send(text: String, action: String) {
        if (!isActive()) return
        val config = settings.load().model
        val userText = text.ifBlank {
            when (action) {
                "search" -> "搜索选中内容"
                "translate" -> "翻译选中内容"
                "extract" -> "提取选中文字"
                else -> "解释选中内容"
            }
        }
        val selectedRegion = search.selection
        val requestVisual = visualContext
        stopRequest()
        search.beginTurn(userText)
        if (conversationPreview == null && requestVisual != null) {
            conversationPreview = HistoryPreview.from(requestVisual)
            search.setFirstImage(conversationPreview)
        }
        if (config.apiKey.isBlank()) {
            search.showResponse("请先在设置中填写 DeepSeek API Key。", true)
            return
        }
        search.setBusy(true)
        ai.request(config, text, action, requestVisual, selectedRegion, turns.toList(),
            onDelta = { search.showResponse(it) },
            onDone = { response ->
                search.showResponse(response)
                search.setBusy(false)
                turns.add(ChatTurn("user", userText))
                turns.add(ChatTurn("assistant", response))
                try {
                    val saved = history.save(conversationId, turns.first().content.take(36), turns, conversationPreview)
                    conversationId = saved?.id
                    if (saved != null) conversationPreview = saved.preview
                } catch (_: IOException) {
                    search.setStatus("回答已完成，本次历史未能保存。")
                }
            },
            onError = { search.showResponse(it, true); search.setBusy(false) },
            onSearchCount = search::setSearchCount)
    }

    fun showHistory() {
        if (!isActive() || historyView != null || settings.historyLimit == 0) return
        stopRequest()
        cancelImageImport()
        root.findFocus()?.let { focus ->
            context.getSystemService(InputMethodManager::class.java).hideSoftInputFromWindow(focus.windowToken, 0)
            focus.clearFocus()
        }
        val overlay = HistoryView(context, history.list())
        historyView = overlay
        overlay.onClosed = {
            if (historyView === overlay) historyView = null
            root.removeView(overlay)
            overlay.release()
        }
        overlay.onOpen = ::restoreHistory
        overlay.onDelete = { entry ->
            try {
                history.delete(entry.id)
                if (conversationId == entry.id) conversationId = null
                true
            } catch (_: IOException) {
                overlay.showError("这条记录暂时无法删除，请重试。")
                false
            }
        }
        root.addView(overlay, FrameLayout.LayoutParams(-1, -1))
        overlay.show()
    }

    fun restoreHistory(entry: SavedChat) {
        if (!isActive()) return
        closeHistory()
        // 历史只恢复压缩预览与文字，模型不再持有原始完整图片。
        replaceConversation(null, entry)
        entry.preview?.decode()?.let(search::setScreenshot)
        search.setAttachmentPreview(null)
        search.restoreConversation(turns.toList())
        search.setFirstImage(entry.preview)
    }

    private fun closeHistory() {
        val overlay = historyView ?: return
        historyView = null
        root.removeView(overlay)
        overlay.release()
    }

    fun handleBack() {
        if (!isActive()) return
        if (historyView?.handleBack() == true) return
        if (search.handleBack()) return
        if (imageImportFuture != null) {
            cancelImageImport()
            search.setStatus("已取消读取照片。")
            return
        }
        close()
    }

    fun setExternalVisible(visible: Boolean) {
        if (!isActive() || externalVisible == visible) return
        externalVisible = visible
        if (visible) pause()
        onExternalVisibilityChanged?.invoke(visible)
        if (!visible) resume()
    }

    fun pause() {
        if (!released) search.pauseCamera()
    }

    fun resume() {
        if (isActive() && !externalVisible) {
            search.refreshHistoryAvailability()
            search.resumeCamera()
        }
    }

    fun close() {
        if (closing || released) return
        closing = true
        onClose()
    }

    fun release() {
        if (released) return
        released = true
        if (active === this) active = null
        closeHistory()
        cancelImageImport()
        imageImportWorker?.shutdownNow()
        imageImportWorker = null
        ai.resetConversation()
        val cameraFinished = onCameraFinished
        onCameraFinished = null
        onExternalVisibilityChanged = null
        search.onHistory = null
        search.onRecapture = null
        search.onCaptureSetup = null
        search.onCameraRequested = null
        search.onPhotoCaptured = null
        search.onPickImageRequested = null
        search.onRemoveAttachment = null
        search.onCancelRequest = null
        search.onSend = null
        search.onOpenSource = null
        pendingSourceUri = null
        search.onCameraClosed = null
        search.release()
        root.removeAllViews()
        visualContext = null
        conversationPreview = null
        turns.clear()
        cameraFinished?.invoke()
    }
}
