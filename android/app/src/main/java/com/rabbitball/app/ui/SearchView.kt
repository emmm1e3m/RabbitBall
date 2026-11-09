package com.rabbitball.app.ui

import android.animation.ValueAnimator
import android.animation.Animator
import android.animation.AnimatorListenerAdapter
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PointF
import android.graphics.RectF
import android.graphics.Typeface
import android.net.Uri
import android.text.InputType
import android.transition.ChangeBounds
import android.transition.Fade
import android.transition.TransitionManager
import android.transition.TransitionSet
import android.view.Gravity
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.animation.OvershootInterpolator
import android.view.animation.AccelerateDecelerateInterpolator
import android.view.animation.DecelerateInterpolator
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputConnectionWrapper
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import com.rabbitball.app.ChatTurn
import com.rabbitball.app.AppSettings
import com.rabbitball.app.HistoryPreview
import kotlin.math.max

class SearchView(context: Context) : FrameLayout(context) {
    var onSend: ((String, String) -> Unit)? = null
    var onRecapture: (() -> Unit)? = null
    var onCaptureSetup: (() -> Unit)? = null
    var onCancelRequest: (() -> Unit)? = null
    var onHistory: (() -> Unit)? = null
    var onCameraRequested: (() -> Unit)? = null
    var onCameraClosed: (() -> Unit)? = null
    var onPhotoCaptured: ((Bitmap) -> Unit)? = null
    var onPickImageRequested: (() -> Unit)? = null
    var onRemoveAttachment: (() -> Unit)? = null
    var onOpenSource: ((Uri) -> Unit)? = null
    val selectionView = SelectionView(context)
    val selection: RectF? get() = selectionView.selection?.let { RectF(it) }

    private fun dp(value: Float) = Palette.dp(context, value)
    private val actionSide = dp(40f)
    private val composerTouchSide = dp(44f)
    private val shortcutHeight = dp(Palette.cornerSurface * 2f)
    private val petDock = PetDock(context)
    private var mascotWidth = petDock.viewWidth
    private var mascotHeight = petDock.viewHeight
    private val mascotGap = dp(12f)
    private val blur = BlurBackgroundView(context)
    private val sheet = LinearLayout(context)
    private val composer = LinearLayout(context)
    private val input = AttachmentInput(context)
    private val attachmentChip = FrameLayout(context)
    private val attachmentImage = ImageView(context)
    private val send = ActionIcon(context, "send", 1.2f)
    private val mascot = RabbitView(context)
    private val petEffects = PetEffectsView(context)
    private val shortcuts = LinearLayout(context)
    private val conversation = ConversationWebView(context)
    private val status = Palette.text(context, "", 12f, Palette.muted)
    private val recapture = ActionIcon(context, "capture")
    private lateinit var photoButton: View
    private lateinit var historyButton: View
    private var photoMenu: PhotoSourceMenu? = null
    private var pendingChatFlight: PointF? = null
    private var busy = false
    private var photoLoading = false
    private var hasScreenshot = false
    private var chatMode = false
    private var topInset = 0
    private var bottomInset = 0
    private var navigationInset = 0
    private var imeVisible = false
    private var screenshotBottomInset: Int? = null
    private var mascotPosition: PointF? = null
    private var mascotDragging = false
    private var petFlight: ValueAnimator? = null
    private var activityVisible = true
    private var cameraView: CameraView? = null
    private var cameraClosing = false
    private var cameraEntryPending = false
    private var cameraPhotoPending = false
    private var cameraPetPosition: PointF? = null
    private var cameraReturnPosition: PointF? = null
    private val inputLocation = IntArray(2)
    private val mascotLocation = IntArray(2)
    private val rootLocation = IntArray(2)
    private var lightStatusBar = true
    private var lightNavigationBar = true
    private var hasAnimated = false

    init {
        setBackgroundColor(Palette.paper)
        isFocusableInTouchMode = true
        addView(blur, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
        addView(selectionView, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
        buildConversation()
        buildEmptyState()
        buildSheet()
        addView(mascot, LayoutParams(mascotWidth, mascotHeight, Gravity.TOP or Gravity.END))
        addView(petEffects, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
        mascot.onPetClick = {
            petEffects.burst(mascot)
            val camera = cameraView
            if (camera != null && !cameraClosing && camera.isReady && !cameraPhotoPending) {
                cameraPhotoPending = true
                updateCameraShutter()
                // 第一帧先画出 PC 点击表情和爱心，下一帧再请求拍照。
                mascot.postOnAnimation {
                    mascot.postOnAnimation {
                        if (cameraView === camera && !cameraClosing && camera.isReady) camera.takePhoto()
                        else {
                            cameraPhotoPending = false
                            updateCameraShutter()
                        }
                    }
                }
            }
        }
        selectionView.onSelectionChanged = { selected ->
            if (selected != null) {
                input.clearFocus()
                context.getSystemService(InputMethodManager::class.java).hideSoftInputFromWindow(windowToken, 0)
            }
        }
        enableMascotDragging()
        setOnApplyWindowInsetsListener { _, insets ->
            val keyboardVisible = insets.isVisible(WindowInsets.Type.ime())
            // 系统先关闭输入法时同步结束编辑，不让下一次返回再被残留焦点吞掉。
            if (imeVisible && !keyboardVisible) input.clearFocus()
            imeVisible = keyboardVisible
            topInset = insets.getInsets(WindowInsets.Type.statusBars() or WindowInsets.Type.displayCutout()).top
            navigationInset = insets.getInsets(WindowInsets.Type.navigationBars()).bottom
            bottomInset = max(
                navigationInset,
                insets.getInsets(WindowInsets.Type.ime()).bottom
            )
            (sheet.layoutParams as LayoutParams).also {
                it.bottomMargin = bottomInset + dp(10f)
                sheet.layoutParams = it
            }
            insets
        }
    }

    private fun buildEmptyState() {
        recapture.contentDescription = "设置助理或重新读取屏幕"
        recapture.tooltipText = "设置助理或重新读取屏幕"
        recapture.background = Palette.ripple(context, Color.WHITE, 28f, Palette.line)
        recapture.setOnClickListener { onCaptureSetup?.invoke() ?: onRecapture?.invoke() }
        addView(recapture, LayoutParams(dp(56f), dp(56f), Gravity.CENTER))
    }

    private fun buildConversation() {
        conversation.visibility = GONE
        conversation.onOpenSource = { onOpenSource?.invoke(it) }
        addView(conversation, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT).apply {
            leftMargin = dp(16f)
            rightMargin = dp(16f)
        })
    }

    private fun shortcut(kind: String, description: String, embedded: Boolean = false, action: (View) -> Unit): View = FrameLayout(context).apply {
        contentDescription = description
        tooltipText = description
        isClickable = true
        isFocusable = true
        val icon = ActionIcon(context, kind, 1.2f).apply {
            inkColor = Palette.accent
            isClickable = false
            isFocusable = false
            importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
            isDuplicateParentStateEnabled = true
            background = Palette.ripple(context, if (embedded) Color.TRANSPARENT else 0xCCFFFFFF.toInt(),
                if (embedded) 20f else Palette.cornerSurface)
        }
        val side = if (embedded) actionSide else shortcutHeight
        addView(icon, LayoutParams(side, side, Gravity.CENTER))
        setOnTouchListener { _, event ->
            if (ValueAnimator.areAnimatorsEnabled()) {
                when (event.actionMasked) {
                    MotionEvent.ACTION_DOWN -> icon.animate().scaleX(.9f).scaleY(.9f).setDuration(90).start()
                    MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> icon.animate().scaleX(1f).scaleY(1f)
                        .setDuration(220).setInterpolator(OvershootInterpolator(.8f)).start()
                }
            }
            false
        }
        setOnClickListener { if (!chatMode) action(this) }
    }

    private fun togglePhotoMenu() {
        val existing = photoMenu
        if (existing?.isShowing == true) {
            existing.dismiss()
            return
        }
        if (!photoButton.isAttachedToWindow || photoButton.windowToken == null) return
        val menu = PhotoSourceMenu(context,
            onCamera = { onCameraRequested?.invoke() },
            onUpload = { onPickImageRequested?.invoke() })
        photoMenu = menu
        menu.setOnDismissListener { if (photoMenu === menu) photoMenu = null }
        menu.show(photoButton, sheet)
    }

    fun dismissPhotoMenu(): Boolean {
        val menu = photoMenu ?: return false
        if (!menu.isShowing) return false
        menu.dismiss()
        return true
    }

    /** 先退出当前局部层；根页面的返回由宿主决定。 */
    fun handleBack(): Boolean {
        if (dismissPhotoMenu()) return true
        if (closeCamera()) return true
        if (rootWindowInsets?.isVisible(WindowInsets.Type.ime()) == true) {
            input.clearFocus()
            windowInsetsController?.hide(WindowInsets.Type.ime())
            return true
        }
        return false
    }

    private fun closePhotoMenuImmediately() {
        photoMenu?.dismissImmediately()
        photoMenu = null
    }

    private fun updateControlsPresentation(covered: Boolean = false, animate: Boolean = false) {
        if (chatMode) closePhotoMenuImmediately()
        photoButton.isEnabled = !chatMode && !covered
        photoButton.importantForAccessibility = if (chatMode) IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS else IMPORTANT_FOR_ACCESSIBILITY_AUTO
        val photoVisibility = if (chatMode) GONE else VISIBLE
        TransitionManager.endTransitions(composer)
        if (photoButton.visibility != photoVisibility && animate && composer.isLaidOut &&
            isAttachedToWindow && ValueAnimator.areAnimatorsEnabled()) {
            // 相机入口淡出时让输入区域同步收回宽度，过渡只作用于输入条内部。
            val transition = TransitionSet().setOrdering(TransitionSet.ORDERING_TOGETHER)
                .addTransition(Fade().addTarget(photoButton).setDuration(160))
                .addTransition(ChangeBounds().addTarget(input).setDuration(220))
                .setInterpolator(DecelerateInterpolator(1.6f))
            TransitionManager.beginDelayedTransition(composer, transition)
        }
        photoButton.visibility = photoVisibility

        shortcuts.importantForAccessibility = if (chatMode) IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS else IMPORTANT_FOR_ACCESSIBILITY_AUTO
        shortcuts.animate().cancel()
        shortcuts.alpha = 1f
        shortcuts.translationY = 0f
        if (chatMode && animate && !covered && shortcuts.visibility == VISIBLE &&
            isAttachedToWindow && ValueAnimator.areAnimatorsEnabled()) {
            shortcuts.animate().alpha(0f).translationY(dp(6f).toFloat()).setStartDelay(0).setDuration(160)
                .withEndAction {
                    if (chatMode) {
                        shortcuts.visibility = GONE
                        shortcuts.alpha = 1f
                        shortcuts.translationY = 0f
                        requestLayout()
                    }
                }.start()
        } else shortcuts.visibility = if (chatMode) GONE else if (covered) INVISIBLE else VISIBLE
    }

    private fun buildSheet() {
        sheet.orientation = LinearLayout.VERTICAL
        sheet.setPadding(dp(8f), dp(6f), dp(8f), dp(6f))
        sheet.background = Palette.round(context, 0xCCFFFFFF.toInt(), Palette.cornerSurface, 0x88FFFFFF.toInt())
        sheet.elevation = dp(8f).toFloat()
        sheet.outlineAmbientShadowColor = 0x326C5260
        sheet.outlineSpotShadowColor = 0x326C5260

        shortcuts.gravity = Gravity.CENTER_VERTICAL
        for ((action, description) in listOf("search" to "搜索", "extract" to "提取文字", "translate" to "翻译")) {
            shortcuts.addView(shortcut(action, description) { dispatch(action) }, LinearLayout.LayoutParams(shortcutHeight, shortcutHeight).apply {
                rightMargin = dp(8f)
            })
        }
        shortcuts.addView(View(context), LinearLayout.LayoutParams(0, 1, 1f))
        historyButton = shortcut("history", "历史记录") { onHistory?.invoke() }
        shortcuts.addView(historyButton, LinearLayout.LayoutParams(shortcutHeight, shortcutHeight))
        refreshHistoryAvailability()
        addView(shortcuts, LayoutParams(LayoutParams.MATCH_PARENT, shortcutHeight).apply {
            // 工具圆心与输入两端圆心共用同一轴，较大的工具圆向两侧各伸出 4dp。
            val controlInset = sheet.paddingLeft + (composerTouchSide - shortcutHeight) / 2
            leftMargin = dp(16f) + controlInset
            rightMargin = dp(16f) + controlInset
        })

        composer.gravity = Gravity.BOTTOM
        composer.minimumHeight = composerTouchSide
        photoButton = shortcut("camera", "拍照或上传照片", true) { togglePhotoMenu() }
        composer.addView(photoButton, LinearLayout.LayoutParams(composerTouchSide, composerTouchSide))
        buildAttachmentPreview()
        composer.addView(attachmentChip, LinearLayout.LayoutParams(dp(48f), composerTouchSide))
        input.setTextColor(Palette.ink)
        input.setHintTextColor(Palette.muted)
        input.textSize = 15f
        input.typeface = Typeface.create("sans-serif", Typeface.NORMAL)
        input.background = null
        input.setPadding(dp(4f), dp(10f), dp(8f), dp(10f))
        input.hint = ""
        input.contentDescription = "输入问题"
        input.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
        input.minLines = 1
        input.minimumHeight = composerTouchSide
        input.gravity = Gravity.TOP or Gravity.START
        input.setHorizontallyScrolling(false)
        input.isVerticalScrollBarEnabled = true
        input.scrollBarStyle = SCROLLBARS_INSIDE_OVERLAY
        input.imeOptions = EditorInfo.IME_ACTION_SEND or EditorInfo.IME_FLAG_NO_EXTRACT_UI
        input.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_SEND) { dispatch("ask"); true } else false
        }
        input.setOnFocusChangeListener { _, _ -> updatePetGaze() }
        input.onDeleteEmpty = ::removeAttachment
        composer.addView(input, LinearLayout.LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f))
        send.contentDescription = "发送问题"
        send.background = Palette.ripple(context, Palette.blush, 20f)
        send.setOnClickListener { if (busy) onCancelRequest?.invoke() else dispatch("ask") }
        val sendTouchArea = FrameLayout(context).apply {
            importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
            addView(send, LayoutParams(actionSide, actionSide, Gravity.CENTER))
            setOnClickListener { if (send.isEnabled) send.performClick() }
        }
        composer.addView(sendTouchArea, LinearLayout.LayoutParams(composerTouchSide, composerTouchSide))
        sheet.addView(composer, LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))

        status.visibility = GONE
        status.gravity = Gravity.CENTER
        status.setPadding(dp(10f), dp(5f), dp(10f), dp(5f))
        status.maxLines = 2
        addView(status, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply {
            leftMargin = dp(24f)
            rightMargin = dp(24f)
        })
        addView(sheet, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT, Gravity.BOTTOM).apply {
            leftMargin = dp(16f)
            rightMargin = dp(16f)
            bottomMargin = dp(10f)
        })
    }

    private fun buildAttachmentPreview() {
        attachmentChip.visibility = GONE
        attachmentImage.contentDescription = "待发送图片"
        attachmentImage.scaleType = ImageView.ScaleType.CENTER_CROP
        attachmentImage.background = Palette.round(context, Color.WHITE, 8f, Palette.line)
        attachmentImage.clipToOutline = true
        attachmentChip.addView(attachmentImage, LayoutParams(dp(40f), dp(32f), Gravity.CENTER_VERTICAL or Gravity.START))
        val remove = FrameLayout(context).apply {
            contentDescription = "移除待发送图片"
            tooltipText = "移除待发送图片"
            isFocusable = true
            addView(ActionIcon(context, "close").apply {
                inkColor = Palette.accent
                background = Palette.ripple(context, Color.WHITE, 10f, Palette.line)
                isClickable = false
                isFocusable = false
                importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
                isDuplicateParentStateEnabled = true
            }, LayoutParams(dp(20f), dp(20f), Gravity.CENTER))
            setOnClickListener { removeAttachment() }
        }
        attachmentChip.addView(remove, LayoutParams(dp(28f), dp(28f), Gravity.TOP or Gravity.END))
    }

    /** 只展示当前待发送图片；移除附件不触碰框选画面与背景。 */
    fun setAttachmentPreview(bitmap: Bitmap?) {
        if (bitmap == null) attachmentImage.setImageDrawable(null) else attachmentImage.setImageBitmap(bitmap)
        attachmentChip.visibility = if (bitmap == null) GONE else VISIBLE
    }

    private fun removeAttachment(): Boolean {
        if (attachmentImage.drawable == null) return false
        setAttachmentPreview(null)
        onRemoveAttachment?.invoke()
        return true
    }

    private fun dispatch(action: String) {
        if (busy || photoLoading) return
        closePhotoMenuImmediately()
        val value = input.text.toString().trim()
        if (action == "ask" && value.isBlank() && attachmentImage.drawable == null) {
            input.requestFocus()
            context.getSystemService(InputMethodManager::class.java).showSoftInput(input, InputMethodManager.SHOW_IMPLICIT)
            return
        }
        context.getSystemService(InputMethodManager::class.java).hideSoftInputFromWindow(windowToken, 0)
        input.clearFocus()
        onSend?.invoke(value, action)
    }

    fun openCamera() {
        closePhotoMenuImmediately()
        if (cameraView != null) return
        val camera = CameraView(context).apply { applyPetSize(mascotWidth, mascotHeight) }
        camera.isClickable = true
        camera.elevation = dp(16f).toFloat()
        cameraReturnPosition = PointF(mascot.x, mascot.y)
        cameraPetPosition = PointF(mascot.x, mascot.y)
        cameraEntryPending = true
        cameraPhotoPending = false
        cameraView = camera
        input.clearFocus()
        context.getSystemService(InputMethodManager::class.java).hideSoftInputFromWindow(windowToken, 0)
        petFlight?.cancel()
        petFlight = null
        mascot.animate().cancel()
        mascot.translationX = 0f
        mascot.translationY = 0f
        mascot.rotation = 0f
        updateProcessingVisibility()
        mascot.elevation = dp(20f).toFloat()
        petEffects.elevation = dp(24f).toFloat()
        camera.onClose = { closeCamera() }
        camera.onReadyChanged = { ready ->
            if (cameraView === camera) {
                if (ready) cameraPhotoPending = false
                updateCameraShutter()
            }
        }
        camera.onError = { _ ->
            if (cameraView === camera && !cameraClosing) {
                cameraPhotoPending = false
                updateCameraShutter()
            }
        }
        camera.onPhoto = { photo ->
            if (cameraView !== camera || cameraClosing) photo.recycle()
            else {
                cameraPhotoPending = false
                onPhotoCaptured?.invoke(photo) ?: photo.recycle()
                closeCamera()
            }
        }
        setCameraAccessibility(true)
        coverVisualContext(true)
        addView(camera, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
        mascot.bringToFront()
        petEffects.bringToFront()
        updateCameraShutter()
        applySystemBarContrast()
        if (ValueAnimator.areAnimatorsEnabled()) {
            camera.alpha = 0f
            camera.scaleX = 1.025f
            camera.scaleY = 1.025f
            camera.animate().alpha(1f).scaleX(1f).scaleY(1f).setDuration(300)
                .setInterpolator(DecelerateInterpolator(1.8f)).start()
        }
        camera.start()
    }

    fun closeCamera(): Boolean = dismissCamera(true)

    fun pauseCamera() {
        activityVisible = false
        updateProcessingVisibility()
        closePhotoMenuImmediately()
        if (cameraClosing) {
            dismissCamera(false)
            return
        }
        cameraView?.stop()
        if (cameraView != null && petFlight?.isRunning == true) {
            cameraEntryPending = true
            petFlight?.cancel()
            petFlight = null
        }
    }

    fun resumeCamera() {
        activityVisible = true
        updateProcessingVisibility()
        if (!cameraClosing && isAttachedToWindow && windowVisibility == VISIBLE) {
            cameraView?.start()
            if (cameraEntryPending) requestLayout()
        }
        applySystemBarContrast()
    }

    private fun dismissCamera(animated: Boolean, revealed: () -> Unit = {}): Boolean {
        val camera = cameraView ?: return false
        if (cameraClosing && animated) return true
        cameraClosing = true
        cameraEntryPending = false
        cameraPhotoPending = false
        camera.animate().cancel()
        camera.stop()
        val finish: () -> Unit = {
            if (cameraView === camera) {
                cameraView = null
                cameraClosing = false
                cameraPetPosition = null
                cameraReturnPosition = null
                removeView(camera)
                camera.release()
                setCameraAccessibility(false)
                mascot.elevation = 0f
                petEffects.elevation = 0f
                mascot.isEnabled = true
                mascot.alpha = 1f
                updateProcessingVisibility()
                applySystemBarContrast()
                requestLayout()
                onCameraClosed?.invoke()
            }
        }
        val reveal: () -> Unit = {
            coverVisualContext(false)
            revealed()
            if (animated && isAttachedToWindow && ValueAnimator.areAnimatorsEnabled()) {
                camera.animate().alpha(0f).scaleX(.985f).scaleY(.985f).setDuration(240)
                    .setInterpolator(DecelerateInterpolator(1.6f)).withEndAction(finish).start()
            } else finish()
        }
        flyCameraPet(true, animated && isAttachedToWindow, reveal)
        return true
    }

    private fun setCameraAccessibility(active: Boolean) {
        val importance = if (active) IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS else IMPORTANT_FOR_ACCESSIBILITY_AUTO
        listOf(selectionView, conversation, sheet, shortcuts, status, recapture).forEach {
            it.importantForAccessibility = importance
        }
        mascot.contentDescription = if (active) "兔球快门" else "兔球"
        mascot.importantForAccessibility = if (active) IMPORTANT_FOR_ACCESSIBILITY_YES else IMPORTANT_FOR_ACCESSIBILITY_AUTO
    }

    private fun coverVisualContext(covered: Boolean) {
        conversation.visibility = if (!chatMode) GONE else if (covered) INVISIBLE else VISIBLE
        selectionView.visibility = if (chatMode) GONE else if (covered) INVISIBLE else VISIBLE
        recapture.visibility = if (!covered && !chatMode && !hasScreenshot) VISIBLE else GONE
        sheet.visibility = if (covered) INVISIBLE else VISIBLE
        updateControlsPresentation(covered = covered)
        status.visibility = if (status.text.isBlank()) GONE else if (covered) INVISIBLE else VISIBLE
    }

    private fun cameraPetTarget(returning: Boolean): PointF {
        if (returning) {
            val saved = requireNotNull(cameraReturnPosition)
            val minY = normalPetMinimumY()
            return PointF(saved.x.coerceIn(0f, (width - mascotWidth).coerceAtLeast(0).toFloat()),
                saved.y.coerceIn(minY.toFloat(), normalPetMaximumY().coerceAtLeast(minY).toFloat()))
        }
        val camera = requireNotNull(cameraView)
        val center = camera.shutterCenter()
        return PointF(camera.left + center.x - mascotWidth * .5f, camera.top + center.y - mascotHeight * .6f)
    }

    private fun flyCameraPet(returning: Boolean, animated: Boolean, finished: () -> Unit = {}) {
        animatePetTo({ cameraPetTarget(returning) }, dp(24f).toFloat(), animated) {
            if (returning) mascotPosition = cameraPetPosition?.let { PointF(it.x, it.y) }
            finished()
        }
    }

    private fun updateCameraShutter() {
        val camera = cameraView ?: return
        val flying = cameraEntryPending || petFlight?.isRunning == true
        val ready = !cameraClosing && !cameraPhotoPending && !flying && camera.isReady
        mascot.isEnabled = ready
        mascot.alpha = if (cameraClosing || cameraPhotoPending || flying || ready) 1f else .6f
    }

    fun refreshHistoryAvailability() {
        historyButton.visibility = if (AppSettings(context).historyLimit > 0) VISIBLE else GONE
    }

    /** 保存外观后更新现有角色，保留选区、草稿、消息和滚动位置。 */
    fun refreshAppearance() {
        val centerX = mascot.x + mascotWidth * .5f
        val centerY = mascot.y + mascotHeight * .6f
        stopPetMotion()
        petDock.refreshAppearance()
        mascotWidth = petDock.viewWidth
        mascotHeight = petDock.viewHeight
        mascot.layoutParams = mascot.layoutParams.apply { width = mascotWidth; height = mascotHeight }
        mascot.applyAppearance(AppSettings(context).loadAppearance())
        if (cameraView != null) {
            cameraView?.applyPetSize(mascotWidth, mascotHeight)
            cameraEntryPending = !cameraClosing
        } else if (hasAnimated) {
            mascotPosition = PointF(centerX - mascotWidth * .5f, centerY - mascotHeight * .6f)
        }
        requestLayout()
    }

    fun setScreenshot(bitmap: Bitmap?) = displayImage(bitmap, false)

    fun setPhoto(bitmap: Bitmap) = displayImage(bitmap, true)

    private fun displayImage(bitmap: Bitmap?, photo: Boolean) {
        closePhotoMenuImmediately()
        pendingChatFlight = null
        val fromCamera = cameraView != null
        if (!fromCamera) stopPetMotion()
        selectionView.animate().cancel()
        selectionView.alpha = 1f
        selectionView.scaleX = 1f
        selectionView.scaleY = 1f
        chatMode = false
        updateControlsPresentation(covered = fromCamera, animate = !fromCamera)
        conversation.reset()
        conversation.visibility = GONE
        selectionView.visibility = VISIBLE
        hasScreenshot = bitmap != null
        screenshotBottomInset = null
        selectionView.setScreenshot(bitmap)
        blur.setScreenshot(bitmap)
        updateSystemBarContrast(bitmap)
        recapture.visibility = if (hasScreenshot) GONE else VISIBLE
        setStatus("")
        val revealImage: () -> Unit = {
            if (bitmap != null && ValueAnimator.areAnimatorsEnabled()) {
                selectionView.alpha = 0f
                val scale = if (photo) .96f else 1.025f
                selectionView.scaleX = scale
                selectionView.scaleY = scale
                selectionView.animate().alpha(1f).scaleX(1f).scaleY(1f)
                    .setStartDelay(if (photo) 0L else 100L)
                    .setDuration(if (photo) 380L else 280L)
                    .setInterpolator(if (photo) OvershootInterpolator(.45f) else DecelerateInterpolator(1.6f)).start()
            }
        }
        // 照片到达的动效与取景器退出衔接，避免在兔球返程时被完全遮住。
        if (fromCamera) dismissCamera(true, revealImage) else revealImage()
        requestLayout()
    }

    private fun enterConversation() {
        val entering = !chatMode
        if (entering && hasAnimated && isLaidOut && cameraView == null) {
            pendingChatFlight = PointF(mascot.x, mascot.y)
        }
        chatMode = true
        updateControlsPresentation(animate = entering)
        selectionView.visibility = GONE
        recapture.visibility = GONE
        conversation.visibility = VISIBLE
        setStatus("")
        requestLayout()
    }

    fun beginTurn(userText: String) {
        enterConversation()
        conversation.beginTurn(userText)
        setAttachmentPreview(null)
        input.text.clear()
    }

    fun setFirstImage(preview: HistoryPreview?) = conversation.setFirstImage(preview)

    fun restoreConversation(turns: List<ChatTurn>) {
        setBusy(false)
        setAttachmentPreview(null)
        input.text.clear()
        enterConversation()
        conversation.restoreConversation(turns)
    }

    fun release() {
        setBusy(false)
        setAttachmentPreview(null)
        closePhotoMenuImmediately()
        dismissCamera(false)
        removeView(conversation)
        conversation.release()
    }

    fun setBusy(value: Boolean) {
        busy = value
        conversation.setBusy(value)
        updateProcessingVisibility()
        send.kind = if (value) "stop" else "send"
        send.contentDescription = if (value) "停止回答" else "发送问题"
        updateSubmissionAvailability()
        if (value && !photoLoading) setStatus("")
        send.invalidate()
    }

    fun setSearchCount(value: Int) {
        if (busy) conversation.setSearchCount(value)
    }

    private fun updateProcessingVisibility() {
        val visible = activityVisible && isAttachedToWindow && windowVisibility == VISIBLE
        conversation.setActivityVisible(visible && cameraView == null)
        petEffects.setThinking(mascot, visible && busy && cameraView == null && mascot.isShown)
    }

    fun setPhotoLoading(value: Boolean) {
        photoLoading = value
        updateSubmissionAvailability()
        status.animate().cancel()
        status.alpha = 1f
        if (value) {
            setStatus("正在读取照片…")
            if (status.visibility == VISIBLE && ValueAnimator.areAnimatorsEnabled()) {
                status.alpha = 0f
                status.animate().alpha(1f).setDuration(180).setInterpolator(DecelerateInterpolator()).start()
            }
        } else if (status.text.toString() == "正在读取照片…") setStatus("")
    }

    private fun updateSubmissionAvailability() {
        val canSubmit = !busy && !photoLoading
        for (index in 0 until 3) {
            shortcuts.getChildAt(index).isEnabled = canSubmit
            shortcuts.getChildAt(index).alpha = if (canSubmit) 1f else .4f
        }
        send.isEnabled = busy || !photoLoading
        send.alpha = if (send.isEnabled) 1f else .4f
    }

    fun showResponse(value: String, error: Boolean = false) {
        conversation.showResponse(value, error)
    }

    fun setStatus(value: String) {
        val message = if (value.isBlank() && photoLoading) "正在读取照片…" else value
        status.text = message
        status.visibility = if (message.isBlank()) GONE else if (cameraView != null && !cameraClosing) INVISIBLE else VISIBLE
    }

    fun petScreenPosition(): PointF? {
        if (!mascot.isShown || mascot.width == 0 || mascot.height == 0) return null
        mascot.getLocationOnScreen(mascotLocation)
        return PointF(mascotLocation[0].toFloat(), mascotLocation[1].toFloat())
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        // 先确定输入条和提示的高度，WebView 只以最终消息视口参与测量及布局。
        // 先铺满整屏再缩小，会让原生触摸滚动仍使用整屏高度计算底部边界。
        if (status.visibility != GONE) measureChildWithMargins(status, widthMeasureSpec, 0, heightMeasureSpec, 0)
        val statusHeight = if (status.visibility != GONE) status.measuredHeight else 0
        val sheetParams = sheet.layoutParams as LayoutParams
        val availableWidth = MeasureSpec.getSize(widthMeasureSpec) - sheetParams.leftMargin - sheetParams.rightMargin
        val availableHeight = MeasureSpec.getSize(heightMeasureSpec) - topInset - sheetParams.bottomMargin - dp(8f)
        val toolsHeight = if (shortcuts.visibility != GONE) shortcutHeight + dp(8f) else 0
        val statusSpace = if (statusHeight > 0) statusHeight + dp(8f) else 0
        val contentSpace = minOf(dp(96f), (availableHeight * .2f).toInt())
        val maximumSheetHeight = minOf((availableWidth * .75f).toInt(), availableHeight - toolsHeight - statusSpace - contentSpace)
        val maximumInputHeight = (maximumSheetHeight - sheet.paddingTop - sheet.paddingBottom).coerceAtLeast(composerTouchSide)
        if (input.maxHeight != maximumInputHeight) input.maxHeight = maximumInputHeight
        measureChildWithMargins(sheet, widthMeasureSpec, 0, heightMeasureSpec, 0)
        val sheetTop = MeasureSpec.getSize(heightMeasureSpec) - sheetParams.bottomMargin - sheet.measuredHeight
        val statusTop = sheetTop - dp(4f) - statusHeight
        val toolsTop = (if (statusHeight > 0) statusTop - dp(4f) else sheetTop - dp(8f)) - shortcutHeight
        val chatBottom = chatContentBottom(sheetTop, statusTop, toolsTop)
        val showPet = chatMode && chatBottom - chatPetTop() - mascotHeight - mascotGap >= dp(48f)
        val chatTop = if (showPet) chatPetTop() + mascotHeight + mascotGap else topInset + dp(8f)
        (conversation.layoutParams as LayoutParams).apply {
            height = (chatBottom - chatTop).coerceAtLeast(0)
            topMargin = chatTop
        }
        super.onMeasure(widthMeasureSpec, heightMeasureSpec)
    }

    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
        super.onLayout(changed, left, top, right, bottom)
        val statusHeight = if (status.visibility != GONE) status.measuredHeight else 0
        val statusBottom = sheet.top - dp(4f)
        status.layout(dp(24f), statusBottom - statusHeight, width - dp(24f), statusBottom)
        val toolsBottom = if (statusHeight > 0) status.top - dp(4f) else sheet.top - dp(8f)
        shortcuts.layout(shortcuts.left, toolsBottom - shortcutHeight, shortcuts.right, toolsBottom)
        val keyboardOffset = (bottomInset - navigationInset).coerceAtLeast(0)
        // 键盘只平移原图，保留弹出前的视口尺寸与选区坐标。
        if (keyboardOffset == 0 || screenshotBottomInset == null) {
            screenshotBottomInset = height - shortcuts.top - keyboardOffset
        }
        selectionView.setViewportInsets(topInset, screenshotBottomInset!!)
        selectionView.translationY = -keyboardOffset.toFloat()
        val image = selectionView.displayedImageBounds
        val defaultY = if (image.isEmpty) (topInset + sheet.top - mascotHeight) / 2f else image.bottom - keyboardOffset - mascotHeight
        if (cameraView != null) {
            if (cameraEntryPending && !cameraClosing) {
                cameraEntryPending = false
                flyCameraPet(false, true)
            }
            if (!cameraClosing && petFlight?.isRunning != true) cameraPetPosition = cameraPetTarget(false)
            cameraPetPosition?.let { placeMascot(it.x, it.y) }
        } else {
            val start = pendingChatFlight
            if (start != null) {
                pendingChatFlight = null
                if (canShowChatPet()) {
                    placeMascot(start.x, start.y, arriving = true)
                    animatePetTo(::chatPetTarget, dp(24f).toFloat(), initialPosition = start)
                } else {
                    stopPetMotion()
                    val target = chatPetTarget()
                    mascotPosition = target
                    placeMascot(target.x, target.y)
                }
            } else {
                if (chatMode && (!hasAnimated || mascotPosition == null)) mascotPosition = chatPetTarget()
                val position = mascotPosition ?: PointF((width - mascotWidth).toFloat(), defaultY)
                placeMascot(position.x, position.y)
            }
        }
        updatePetGaze()
        updateProcessingVisibility()
        animateEntranceIfNeeded()
    }

    private fun chatPetTop() = topInset + dp(8f)

    private fun chatContentBottom(sheetTop: Int = sheet.top, statusTop: Int = status.top, toolsTop: Int = shortcuts.top): Int = when {
        chatMode && shortcuts.visibility == VISIBLE -> toolsTop - dp(8f)
        status.visibility != GONE -> statusTop - dp(8f)
        else -> sheetTop - dp(8f)
    }

    private fun canShowChatPet() = chatContentBottom() - chatPetTop() - mascotHeight - mascotGap >= dp(48f)

    private fun chatPetTarget() = PointF(dp(16f).coerceAtMost((width - mascotWidth).coerceAtLeast(0)).toFloat(), chatPetTop().toFloat())

    private fun normalPetMinimumY() = if (chatMode) chatPetTop() else topInset

    private fun normalPetMaximumY() = if (chatMode) {
        if (canShowChatPet()) chatPetTop() else topInset - 1
    } else shortcuts.top - mascotHeight - mascotGap

    private fun placeMascot(x: Float, y: Float, arriving: Boolean = false) {
        val cameraFlight = cameraView != null && (!cameraClosing || petFlight?.isRunning == true)
        val chatArrival = chatMode && cameraView == null && (arriving || petFlight?.isRunning == true)
        val minimumY = if (cameraFlight || chatArrival) topInset else normalPetMinimumY()
        val maximumY = when {
            cameraFlight -> height - navigationInset - mascotHeight - dp(12f)
            chatArrival -> sheet.top - mascotHeight - mascotGap
            else -> normalPetMaximumY()
        }
        val hasSpace = maximumY >= minimumY && (!chatMode || cameraView != null || canShowChatPet())
        mascot.visibility = if (hasSpace) VISIBLE else INVISIBLE
        val boundedX = x.toInt().coerceIn(0, (width - mascotWidth).coerceAtLeast(0))
        val boundedY = y.toInt().coerceIn(minimumY, maximumY.coerceAtLeast(minimumY))
        mascot.layout(boundedX, boundedY, boundedX + mascotWidth, boundedY + mascotHeight)
    }

    private fun stopPetMotion() {
        petFlight?.cancel()
        petFlight = null
        mascot.animate().setUpdateListener(null).cancel()
        mascot.translationX = 0f
        mascot.translationY = 0f
        mascot.rotation = 0f
        mascot.setDockPose(petDock.left, 0f)
    }

    /** 角色飞行共用取消与收尾契约，目标随布局变化。 */
    private fun animatePetTo(
        target: () -> PointF,
        arcHeight: Float,
        animated: Boolean = true,
        initialPosition: PointF? = null,
        finished: () -> Unit = {}
    ) {
        val start = initialPosition ?: cameraPetPosition ?: PointF(mascot.x, mascot.y)
        stopPetMotion()
        fun place(x: Float, y: Float) {
            placeMascot(x, y)
            val position = PointF(mascot.left.toFloat(), mascot.top.toFloat())
            if (cameraView != null) cameraPetPosition = position else mascotPosition = position
            updatePetGaze()
        }
        if (!animated || !ValueAnimator.areAnimatorsEnabled()) {
            val destination = target()
            place(destination.x, destination.y)
            updateCameraShutter()
            finished()
            return
        }
        val flight = ValueAnimator.ofFloat(0f, 1f)
        petFlight = flight
        flight.duration = 600L
        flight.interpolator = AccelerateDecelerateInterpolator()
        flight.addUpdateListener {
            val progress = it.animatedValue as Float
            val destination = target()
            val bend = kotlin.math.sin(progress * Math.PI).toFloat()
            place(start.x + (destination.x - start.x) * progress,
                start.y + (destination.y - start.y) * progress - bend * arcHeight)
            mascot.rotation = bend * if (destination.x > start.x) 6f else -6f
        }
        flight.addListener(object : AnimatorListenerAdapter() {
            private var cancelled = false
            override fun onAnimationCancel(animation: Animator) { cancelled = true }
            override fun onAnimationEnd(animation: Animator) {
                if (petFlight === animation) petFlight = null
                if (!cancelled) {
                    val destination = target()
                    place(destination.x, destination.y)
                    mascot.rotation = 0f
                    updateCameraShutter()
                    finished()
                }
            }
        })
        flight.start()
        updateCameraShutter()
    }

    private fun updatePetGaze() {
        if (cameraView != null) {
            mascot.setGazeTarget(mascot.width * .5f, mascot.height * .15f)
            return
        }
        mascot.getLocationInWindow(mascotLocation)
        if (input.hasFocus() || chatMode) {
            input.getLocationInWindow(inputLocation)
            mascot.setGazeTarget(
                inputLocation[0] + input.width * .5f - mascotLocation[0],
                inputLocation[1] + input.height * .5f - mascotLocation[1], input.hasFocus()
            )
        } else {
            getLocationInWindow(rootLocation)
            val inwardX = if (mascot.x + mascot.width * .5f < width * .5f) width.toFloat() else 0f
            mascot.setGazeTarget(rootLocation[0] + inwardX - mascotLocation[0], mascot.height * .6f)
        }
    }

    private fun enableMascotDragging() {
        val touchSlop = ViewConfiguration.get(context).scaledTouchSlop
        var downX = 0f
        var downY = 0f
        var startX = 0f
        var startY = 0f
        mascot.setOnTouchListener { _, event ->
            if (cameraView != null) return@setOnTouchListener false
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    startX = mascot.x
                    startY = mascot.y
                    downX = event.rawX
                    downY = event.rawY
                    mascotDragging = false
                    stopPetMotion()
                    placeMascot(startX, startY)
                    updatePetGaze()
                    false
                }
                MotionEvent.ACTION_MOVE -> {
                    val deltaX = event.rawX - downX
                    val deltaY = event.rawY - downY
                    if (!mascotDragging && kotlin.math.hypot(deltaX, deltaY) > touchSlop) {
                        mascotDragging = true
                        parent?.requestDisallowInterceptTouchEvent(true)
                        val cancel = MotionEvent.obtain(event)
                        cancel.action = MotionEvent.ACTION_CANCEL
                        mascot.onTouchEvent(cancel)
                        cancel.recycle()
                    }
                    if (mascotDragging) {
                        placeMascot(startX + deltaX, startY + deltaY)
                        mascotPosition = PointF(mascot.left.toFloat(), mascot.top.toFloat())
                        updatePetGaze()
                    }
                    mascotDragging
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    parent?.requestDisallowInterceptTouchEvent(false)
                    val wasDragging = mascotDragging
                    mascotDragging = false
                    wasDragging
                }
                else -> false
            }
        }
    }

    private fun updateSystemBarContrast(bitmap: Bitmap?) {
        lightStatusBar = true
        lightNavigationBar = true
        if (bitmap != null) {
            val readable = if (bitmap.config == Bitmap.Config.HARDWARE) bitmap.copy(Bitmap.Config.ARGB_8888, false) else bitmap
            if (readable != null) {
                fun isLight(y: Int): Boolean {
                    var brightness = 0.0
                    for (sample in 0 until 12) {
                        val pixel = readable.getPixel(((sample + .5f) * readable.width / 12f).toInt().coerceAtMost(readable.width - 1), y)
                        brightness += Color.red(pixel) * .2126 + Color.green(pixel) * .7152 + Color.blue(pixel) * .0722
                    }
                    return brightness / 12 > 155
                }
                lightStatusBar = isLight((readable.height * .015f).toInt())
                lightNavigationBar = isLight((readable.height * .985f).toInt().coerceAtMost(readable.height - 1))
                if (readable !== bitmap) readable.recycle()
            }
        }
        applySystemBarContrast()
    }

    private fun applySystemBarContrast() {
        val statusMask = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
        val navigationMask = WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
        val appearance = (if (lightStatusBar) statusMask else 0) or (if (lightNavigationBar) navigationMask else 0)
        windowInsetsController?.setSystemBarsAppearance(appearance, statusMask or navigationMask)
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        refreshHistoryAvailability()
        requestApplyInsets()
        applySystemBarContrast()
        resumeCamera()
        requestLayout()
    }

    override fun onWindowVisibilityChanged(visibility: Int) {
        super.onWindowVisibilityChanged(visibility)
        updateProcessingVisibility()
        if (visibility != VISIBLE) {
            closePhotoMenuImmediately()
            updateControlsPresentation(covered = cameraView != null)
        }
    }

    private fun animateEntranceIfNeeded() {
        if (hasAnimated || !isAttachedToWindow || width == 0 || height == 0) return
        hasAnimated = true
        if (cameraView != null) return
        val docked = petDock.enabled
        val left = petDock.left
        if (!ValueAnimator.areAnimatorsEnabled()) {
            mascot.setDockPose(left, 0f)
            return
        }
        sheet.translationY = dp(12f).toFloat()
        sheet.alpha = 0f
        sheet.animate().translationY(0f).alpha(1f).setStartDelay(100).setDuration(280)
            .setInterpolator(OvershootInterpolator(.35f)).start()
        if (!chatMode) {
            shortcuts.alpha = 0f
            shortcuts.translationY = dp(6f).toFloat()
            shortcuts.animate().translationY(0f).alpha(1f).setStartDelay(100).setDuration(280)
                .setInterpolator(DecelerateInterpolator(1.6f)).start()
        }
        // 首次布局后再求真实停靠点；设置暂离和更换照片不重播入场。
        val origin = if (docked) petDock.position(width, height, topInset, navigationInset)
            else PointF(width.toFloat(), mascot.top - dp(18f).toFloat())
        mascot.translationX = origin.x - mascot.left
        mascot.translationY = origin.y - mascot.top
        mascot.rotation = if (origin.x < mascot.left) 18f else -18f
        mascot.setDockPose(left, if (docked) 1f else 0f, snap = true)
        mascot.animate().translationX(0f).translationY(0f).rotation(0f)
            .setStartDelay(100).setDuration(360).setInterpolator(OvershootInterpolator(.7f))
            .setUpdateListener {
                if (docked) mascot.setDockPose(left, 1f - it.animatedFraction)
                updatePetGaze()
            }.withEndAction {
                mascot.setDockPose(left, 0f)
                mascot.animate().setUpdateListener(null)
            }.start()
    }

    override fun onDetachedFromWindow() {
        closePhotoMenuImmediately()
        pendingChatFlight = null
        shortcuts.animate().cancel()
        shortcuts.alpha = 1f
        shortcuts.translationY = 0f
        shortcuts.visibility = if (chatMode) GONE else if (cameraView != null) INVISIBLE else VISIBLE
        TransitionManager.endTransitions(composer)
        photoButton.alpha = 1f
        photoButton.visibility = if (chatMode) GONE else VISIBLE
        sheet.animate().cancel()
        sheet.alpha = 1f
        sheet.translationY = 0f
        selectionView.animate().cancel()
        selectionView.alpha = 1f
        selectionView.scaleX = 1f
        selectionView.scaleY = 1f
        pauseCamera()
        stopPetMotion()
        if (chatMode && cameraView == null) mascotPosition = chatPetTarget()
        super.onDetachedFromWindow()
    }
}

/** 空输入的退格与 PC 一致移除待发图片，兼容软键盘和实体键盘。 */
private class AttachmentInput(context: Context) : EditText(context) {
    var onDeleteEmpty: (() -> Boolean)? = null
    private var consumedDelete = false

    private fun deleteAttachment(): Boolean {
        val value = text
        if (value.isNotEmpty() || BaseInputConnection.getComposingSpanStart(value) >= 0) return false
        return onDeleteEmpty?.invoke() == true
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        if (keyCode == KeyEvent.KEYCODE_DEL && !event.isCtrlPressed && !event.isAltPressed && !event.isMetaPressed &&
            deleteAttachment()) {
            consumedDelete = true
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onKeyUp(keyCode: Int, event: KeyEvent): Boolean {
        if (keyCode == KeyEvent.KEYCODE_DEL && consumedDelete) {
            consumedDelete = false
            return true
        }
        return super.onKeyUp(keyCode, event)
    }

    override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection? {
        val connection = super.onCreateInputConnection(outAttrs) ?: return null
        return object : InputConnectionWrapper(connection, false) {
            override fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean =
                if (beforeLength > 0 && afterLength == 0 && deleteAttachment()) true
                else super.deleteSurroundingText(beforeLength, afterLength)

            override fun deleteSurroundingTextInCodePoints(beforeLength: Int, afterLength: Int): Boolean =
                if (beforeLength > 0 && afterLength == 0 && deleteAttachment()) true
                else super.deleteSurroundingTextInCodePoints(beforeLength, afterLength)
        }
    }
}

/** 路径沿用桌面版 chat-ui.js 的 search、type、translate、send。 */
internal class ActionIcon(context: Context, var kind: String, private val iconScale: Float = 1f) : View(context) {
    var lineWidth = 2.25f
    var inkColor = Palette.accent
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val path = Path()

    init {
        isClickable = true
        isFocusable = true
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        // 各路径的实际外沿与发送箭头等大；图案缩放不改变屏幕上的线宽。
        val iconSize = 20.8f * iconScale * resources.displayMetrics.density
        val geometryScale = when (kind) {
            "search" -> 14f / 16.5f
            "camera" -> 14f / 20f
            "history", "photo" -> 14f / 18f
            "extract" -> 14f / 16f
            "translate" -> 14f / 19f
            else -> 1f
        }
        val centerX = when (kind) { "search" -> 12.25f; "translate" -> 12.5f; else -> 12f }
        val centerY = when (kind) { "search" -> 12.25f; "extract" -> 12.5f; else -> 12f }
        canvas.save()
        canvas.translate(width * .5f, height * .5f)
        canvas.scale(iconSize / 24f * geometryScale, iconSize / 24f * geometryScale)
        canvas.translate(-centerX, -centerY)
        paint.color = inkColor
        paint.strokeWidth = lineWidth / (geometryScale * iconScale)
        paint.style = Paint.Style.STROKE
        paint.strokeCap = Paint.Cap.ROUND
        paint.strokeJoin = Paint.Join.ROUND
        path.reset()
        when (kind) {
            "close" -> { path.moveTo(7f, 7f); path.lineTo(17f, 17f); path.moveTo(17f, 7f); path.lineTo(7f, 17f) }
            "send" -> { path.moveTo(12f, 19f); path.lineTo(12f, 5f); path.moveTo(6f, 11f); path.lineTo(12f, 5f); path.lineTo(18f, 11f) }
            "stop" -> { paint.style = Paint.Style.FILL; canvas.drawRoundRect(6f, 6f, 18f, 18f, 2f, 2f, paint) }
            "search" -> { canvas.drawCircle(10.5f, 10.5f, 6.5f, paint); path.moveTo(15.5f, 15.5f); path.lineTo(20.5f, 20.5f) }
            "camera" -> {
                path.moveTo(8f, 6f); path.lineTo(10f, 3f); path.lineTo(14f, 3f); path.lineTo(16f, 6f)
                path.lineTo(20f, 6f); path.quadTo(22f, 6f, 22f, 8f); path.lineTo(22f, 19f)
                path.quadTo(22f, 21f, 20f, 21f); path.lineTo(4f, 21f)
                path.quadTo(2f, 21f, 2f, 19f); path.lineTo(2f, 8f); path.quadTo(2f, 6f, 4f, 6f); path.close()
                canvas.drawCircle(12f, 13f, 3.5f, paint)
            }
            "photo" -> {
                path.addRoundRect(3f, 3f, 21f, 21f, 3f, 3f, Path.Direction.CW)
                canvas.drawCircle(8f, 8f, 1.5f, paint)
                path.moveTo(3f, 16f); path.lineTo(9f, 11f); path.lineTo(14f, 16f)
                path.moveTo(12f, 14f); path.lineTo(16f, 10f); path.lineTo(21f, 15f)
            }
            "history" -> {
                path.addArc(3f, 3f, 21f, 21f, 180f, -315f)
                path.lineTo(3f, 8f)
                path.moveTo(3f, 3f); path.lineTo(3f, 8f); path.lineTo(8f, 8f)
                path.moveTo(12f, 7f); path.lineTo(12f, 12f); path.lineTo(15f, 14f)
            }
            "extract" -> {
                path.moveTo(4f, 8f); path.lineTo(4f, 5f); path.lineTo(20f, 5f); path.lineTo(20f, 8f)
                path.moveTo(12f, 5f); path.lineTo(12f, 20f); path.moveTo(8f, 20f); path.lineTo(16f, 20f)
            }
            "translate" -> {
                path.moveTo(3f, 5f); path.lineTo(14f, 5f); path.moveTo(8f, 3f); path.lineTo(8f, 5f)
                path.moveTo(5f, 5f); path.cubicTo(5f, 10f, 9f, 13f, 12f, 15f)
                path.moveTo(12f, 5f); path.cubicTo(12f, 10f, 8f, 13f, 5f, 15f)
                path.moveTo(13f, 21f); path.lineTo(17.5f, 10f); path.lineTo(22f, 21f)
                path.moveTo(15f, 17f); path.lineTo(20f, 17f)
            }
            "capture" -> {
                path.moveTo(8f, 3f); path.lineTo(5f, 3f); path.quadTo(3f, 3f, 3f, 5f); path.lineTo(3f, 8f)
                path.moveTo(16f, 3f); path.lineTo(19f, 3f); path.quadTo(21f, 3f, 21f, 5f); path.lineTo(21f, 8f)
                path.moveTo(3f, 16f); path.lineTo(3f, 19f); path.quadTo(3f, 21f, 5f, 21f); path.lineTo(8f, 21f)
                path.moveTo(16f, 21f); path.lineTo(19f, 21f); path.quadTo(21f, 21f, 21f, 19f); path.lineTo(21f, 16f)
                path.moveTo(7f, 12f); path.lineTo(17f, 12f)
            }
        }
        canvas.drawPath(path, paint)
        canvas.restore()
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        if (!isEnabled) return false
        if (ValueAnimator.areAnimatorsEnabled()) {
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> animate().scaleX(.9f).scaleY(.9f).setDuration(90).start()
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> animate().scaleX(1f).scaleY(1f).setDuration(180).setInterpolator(OvershootInterpolator(.7f)).start()
            }
        }
        return super.onTouchEvent(event)
    }
}
