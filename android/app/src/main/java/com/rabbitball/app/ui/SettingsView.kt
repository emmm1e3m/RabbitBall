package com.rabbitball.app.ui

import android.animation.Animator
import android.animation.AnimatorListenerAdapter
import android.animation.AnimatorSet
import android.animation.ObjectAnimator
import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.text.InputType
import android.text.InputFilter
import android.text.Editable
import android.text.TextWatcher
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.view.WindowInsets
import android.view.accessibility.AccessibilityNodeInfo
import android.view.inputmethod.InputMethodManager
import android.view.animation.PathInterpolator
import android.widget.*
import com.rabbitball.app.AppSettings
import com.rabbitball.app.AppConfig
import com.rabbitball.app.AppearanceConfig
import com.rabbitball.app.PromptCatalog
import com.rabbitball.app.PromptKey
import com.rabbitball.app.R
import com.rabbitball.app.RabbitVoiceService
import kotlin.math.roundToInt

class SettingsView(context: Context, initial: AppConfig, firstRun: Boolean) : FrameLayout(context) {
    var onSave: ((AppConfig, Boolean) -> Unit)? = null
    var onClose: (() -> Unit)? = null
    var onAccessibility: (() -> Unit)? = null
    var onAssistant: (() -> Unit)? = null
    var onHistory: (() -> Unit)? = null
    var onPetMode: ((Boolean) -> Unit)? = null
    private val endpoint: EditText
    private val model: Selector
    private val key: EditText
    private val reasoning: Selector
    private val rounds: EditText
    private val accessValue: TextView
    private val assistantValue: TextView
    private val error: TextView
    private val models = mutableListOf("deepseek-flash", "deepseek-v4-pro")
    private val modelPage = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
    private val appearancePage = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
    private val generalPage = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
    private val promptPage = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
    private val tabPages = listOf(modelPage, appearancePage, generalPage, promptPage)
    private var draftAppearance = initial.appearance
    private val preview = RabbitView(context)
    private lateinit var bodyColor: EditText
    private lateinit var eyeColor: EditText
    private lateinit var historyLimit: EditText
    private lateinit var promptEditor: EditText
    private lateinit var promptHint: TextView
    private val promptKeys = listOf(PromptKey.SYSTEM, PromptKey.FALLBACK, PromptKey.SEARCH,
        PromptKey.EXTRACT, PromptKey.TRANSLATE, PromptKey.SEARCH_TOOL)
    private val promptDraft = PromptCatalog.resolve(initial.model.prompts).toMutableMap()
    private var activePrompt = promptKeys.first()
    private val advanced = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL; visibility = GONE }
    private var activePage = -1
    private var pageAnimator: AnimatorSet? = null
    private var advancedAnimator: ValueAnimator? = null
    private var advancedExpanded = false
    private val pageEase = PathInterpolator(.22f, 1f, .36f, 1f)
    private fun d(value: Int) = Palette.dp(context, value.toFloat())

    init {
        setBackgroundColor(Palette.paper)
        val column = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(d(24), d(12), d(24), d(20))
        }
        addView(column, LayoutParams(-1, -1))
        setOnApplyWindowInsetsListener { _, insets ->
            val safe = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.ime())
            column.setPadding(d(24) + safe.left, d(12) + safe.top, d(24) + safe.right, d(20) + safe.bottom)
            insets
        }
        val header = LinearLayout(context).apply { gravity = Gravity.CENTER_VERTICAL }
        header.addView(Palette.text(context, "设置", 18f, Palette.ink, true), LinearLayout.LayoutParams(0, d(48), 1f))
        if (!firstRun) header.addView(button("×", false) { onClose?.invoke() }.apply {
            textSize = 24f; contentDescription = "关闭设置"
        }, LinearLayout.LayoutParams(d(44), d(44)))
        column.addView(header)
        val tabs = LinearLayout(context)
        val pages = FrameLayout(context)
        val tabViews = listOf("模型", "外观", "常规", "提示词").mapIndexed { index, title ->
            Palette.text(context, title, 14f, Palette.muted, true).apply {
                gravity = Gravity.CENTER
                isClickable = true; isFocusable = true
                setOnClickListener {
                    selectPage(index)
                    for (i in 0 until tabs.childCount) {
                        (tabs.getChildAt(i) as TextView).setTextColor(if (i == index) Palette.accent else Palette.muted)
                        tabs.getChildAt(i).background = if (i == index) Palette.round(context, Palette.blush, Palette.cornerSmall) else null
                    }
                }
                tabs.addView(this, LinearLayout.LayoutParams(0, d(42), 1f).apply { if(index>0) leftMargin=d(8) })
            }
        }
        column.addView(tabs, LinearLayout.LayoutParams(-1, d(42)).apply { topMargin=d(8); bottomMargin=d(12) })
        val scroll = ScrollView(context).apply { isFillViewport = true; clipToPadding = false }
        column.addView(scroll, LinearLayout.LayoutParams(-1, 0, 1f))
        scroll.addView(pages, FrameLayout.LayoutParams(-1, -2))
        tabPages.forEach { pages.addView(it, LayoutParams(-1, -2)) }

        val initialModel = initial.model
        key = field(modelPage, "API Key", initialModel.apiKey, "填写 API Key", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD).apply {
            transformationMethod = android.text.method.PasswordTransformationMethod.getInstance()
        }
        if (initialModel.model !in models) models.add(initialModel.model)
        label(modelPage, "模型")
        model = Selector("模型", models.map { when(it) { "deepseek-flash" -> "DeepSeek Flash"; "deepseek-v4-pro" -> "DeepSeek V4 Pro"; else -> it } }).apply {
            setSelection(models.indexOf(initialModel.model).coerceAtLeast(0))
        }
        modelPage.addView(model, LinearLayout.LayoutParams(-1, d(48)))
        label(modelPage, "思考强度")
        reasoning = Selector("思考强度", listOf("low", "high", "max")).apply {
            setSelection(listOf("low", "medium", "high").indexOf(initialModel.reasoning).coerceAtLeast(0))
        }
        modelPage.addView(reasoning, LinearLayout.LayoutParams(-1, d(48)))
        rounds = field(modelPage, "工具调用轮数上限", initialModel.maxToolRounds.toString(), "3", InputType.TYPE_CLASS_NUMBER)
        modelPage.addView(button("高级设置", false) { toggleAdvanced() }, LinearLayout.LayoutParams(-1, d(46)).apply { topMargin=d(16) })
        modelPage.addView(advanced)
        endpoint = field(advanced, "API 基础地址", initialModel.endpoint, "https://api.deepseek.com", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI)

        buildAppearance()
        historyLimit = field(generalPage, "历史记录保留条数", initial.historyLimit.toString(), "10", InputType.TYPE_CLASS_NUMBER)
        generalPage.addView(Palette.text(context, context.getString(R.string.capture_entry_choice_hint), 12f, Palette.muted).apply {
            setPadding(0, d(18), 0, d(4))
        })
        val access = LinearLayout(context).apply { gravity = Gravity.CENTER_VERTICAL }
        access.addView(Palette.text(context, "即开即选（无障碍）", 14f), LinearLayout.LayoutParams(0, d(58), 1f))
        accessValue = button("开启", false) { onAccessibility?.invoke() }
        access.addView(accessValue, LinearLayout.LayoutParams(d(84), d(40)))
        generalPage.addView(access)
        generalPage.addView(Palette.text(context, context.getString(R.string.capture_accessibility_hint), 12f, Palette.muted),
            LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = d(8) })
        val petSwitch = Switch(context).apply {
            text = "屏幕边缘陪伴"; textSize = 14f; setTextColor(Palette.ink); minimumHeight=d(58)
            isChecked = context.getSharedPreferences("rabbitball_ui", Context.MODE_PRIVATE).getBoolean("edge_pet", true)
            setOnCheckedChangeListener { _, checked ->
                context.getSharedPreferences("rabbitball_ui", Context.MODE_PRIVATE).edit().putBoolean("edge_pet", checked).apply()
                onPetMode?.invoke(checked)
            }
        }
        generalPage.addView(petSwitch)
        assistantValue = button("设为系统助理  ›", false) { onAssistant?.invoke() }
        generalPage.addView(assistantValue, LinearLayout.LayoutParams(-1, d(50)).apply { topMargin=d(8) })
        generalPage.addView(Palette.text(context, context.getString(R.string.capture_assistant_hint), 12f, Palette.muted),
            LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = d(8) })
        if (!firstRun) generalPage.addView(button("最近对话  ›", false) { onHistory?.invoke() }, LinearLayout.LayoutParams(-1, d(50)).apply { topMargin=d(8) })
        buildPrompts()
        error = Palette.text(context, "", 12f, Palette.error).apply { visibility = GONE; setPadding(0,d(8),0,d(8)) }
        column.addView(error)
        column.addView(button(if (firstRun) "保存并开始" else "保存", true) {
            try {
                storePromptDraft()
                val config = initial.copy(
                    model = initial.model.copy(
                        endpoint = endpoint.text.toString().trim(), model = models[model.selectedItemPosition],
                        apiKey = key.text.toString().trim(), reasoning = listOf("low", "medium", "high")[reasoning.selectedItemPosition],
                        maxToolRounds = rounds.text.toString().toIntOrNull() ?: 0,
                        prompts = PromptCatalog.normalize(promptDraft)
                    ),
                    appearance = draftAppearance.copy(bodyColor = parseColor(bodyColor, "球色"), eyeColor = parseColor(eyeColor, "眼睛色")),
                    historyLimit = historyLimit.text.toString().toIntOrNull() ?: 0
                )
                AppSettings.validate(config)
                onSave?.invoke(config, firstRun)
            } catch (e: Exception) { showError(e.message ?: "设置未能保存。") }
        }, LinearLayout.LayoutParams(-1, d(48)).apply { topMargin=d(16) })
        tabViews.first().performClick()
    }

    private fun buildAppearance() {
        val previewFrame = FrameLayout(context)
        previewFrame.addView(preview, LayoutParams(d(96), d(108), Gravity.CENTER))
        appearancePage.addView(previewFrame, LinearLayout.LayoutParams(-1, d(196)))
        val sizeLabel = LinearLayout(context).apply { gravity = Gravity.CENTER_VERTICAL }
        sizeLabel.addView(Palette.text(context, "宠物尺寸", 12f, Palette.muted), LinearLayout.LayoutParams(0, d(32), 1f))
        val sizeValue = Palette.text(context, "${(draftAppearance.petSize * 100).roundToInt()}%", 12f, Palette.muted)
        sizeLabel.addView(sizeValue)
        appearancePage.addView(sizeLabel)
        appearancePage.addView(SeekBar(context).apply {
            max = 20
            progress = ((draftAppearance.petSize - .6f) / .05f).roundToInt().coerceIn(0, 20)
            progressTintList = android.content.res.ColorStateList.valueOf(Palette.accent)
            thumbTintList = android.content.res.ColorStateList.valueOf(Palette.accent)
            contentDescription = "宠物尺寸"
            setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
                override fun onProgressChanged(bar: SeekBar, progress: Int, fromUser: Boolean) {
                    draftAppearance = draftAppearance.copy(petSize = .6f + progress * .05f)
                    sizeValue.text = "${60 + progress * 5}%"
                    updatePreview()
                }
                override fun onStartTrackingTouch(bar: SeekBar) = Unit
                override fun onStopTrackingTouch(bar: SeekBar) = Unit
            })
        }, LinearLayout.LayoutParams(-1, d(44)))
        bodyColor = colorField("球色", draftAppearance.bodyColor) { draftAppearance = draftAppearance.copy(bodyColor = it); updatePreview() }
        eyeColor = colorField("眼睛色", draftAppearance.eyeColor) { draftAppearance = draftAppearance.copy(eyeColor = it); updatePreview() }
        updatePreview()
    }

    private fun colorField(title: String, initial: Int, changed: (Int) -> Unit): EditText {
        label(appearancePage, title)
        val row = LinearLayout(context).apply { gravity = Gravity.CENTER_VERTICAL }
        val swatch = View(context).apply {
            background = Palette.round(context, initial, Palette.cornerSmall, Palette.line)
            importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
        }
        row.addView(swatch, LinearLayout.LayoutParams(d(36), d(36)).apply { rightMargin = d(12) })
        val editor = EditText(context).apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
            setSingleLine(true)
            textSize = 14f
            setTextColor(Palette.ink)
            setPadding(d(14), 0, d(14), 0)
            background = Palette.round(context, Color.WHITE, Palette.cornerControl, Palette.line)
            importantForAutofill = IMPORTANT_FOR_AUTOFILL_NO
            contentDescription = title
            filters = arrayOf(InputFilter.LengthFilter(7))
            setText(colorHex(initial))
            setSelectAllOnFocus(true)
            addTextChangedListener(object : TextWatcher {
                override fun beforeTextChanged(text: CharSequence?, start: Int, count: Int, after: Int) = Unit
                override fun onTextChanged(text: CharSequence?, start: Int, before: Int, count: Int) = Unit
                override fun afterTextChanged(text: Editable?) {
                    val value = text.toString()
                    if (HEX_COLOR.matches(value)) {
                        val color = Color.parseColor(value)
                        swatch.background = Palette.round(context, color, Palette.cornerSmall, Palette.line)
                        changed(color)
                    }
                }
            })
        }
        row.addView(editor, LinearLayout.LayoutParams(0, d(48), 1f))
        appearancePage.addView(row, LinearLayout.LayoutParams(-1, d(48)))
        return editor
    }

    private fun colorHex(color: Int) = "#%06X".format(color and 0xFFFFFF)

    private fun parseColor(field: EditText, title: String): Int {
        val value = field.text.toString().trim()
        require(HEX_COLOR.matches(value)) { "${title}请使用 #RRGGBB 格式。" }
        return Color.parseColor(value)
    }

    private fun updatePreview() {
        preview.applyAppearance(draftAppearance)
        preview.layoutParams = (preview.layoutParams as LayoutParams).apply {
            width = Palette.dp(context, 96f * draftAppearance.petSize)
            height = Palette.dp(context, 108f * draftAppearance.petSize)
        }
    }

    private fun buildPrompts() {
        label(promptPage, "用途")
        val purpose = Selector("用途", promptKeys.map { "${it.group} · ${it.label}" })
        promptPage.addView(purpose, LinearLayout.LayoutParams(-1, d(48)))
        promptEditor = EditText(context).apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
            gravity = Gravity.TOP or Gravity.START
            textSize = 14f
            setTextColor(Palette.ink)
            setPadding(d(14), d(12), d(14), d(12))
            background = Palette.round(context, Color.WHITE, Palette.cornerControl, Palette.line)
            filters = arrayOf(InputFilter.LengthFilter(20_000))
            contentDescription = "提示词内容"
            importantForAutofill = IMPORTANT_FOR_AUTOFILL_NO
            isVerticalScrollBarEnabled = true
            setHorizontallyScrolling(false)
        }
        promptPage.addView(promptEditor, LinearLayout.LayoutParams(-1, d(300)).apply { topMargin = d(12) })
        promptHint = Palette.text(context, "", 12f, Palette.muted).apply { setPadding(0, d(8), 0, d(8)) }
        promptPage.addView(promptHint, LinearLayout.LayoutParams(-1, -2))
        val actions = LinearLayout(context)
        actions.addView(button("恢复这项默认", false) {
            promptDraft[activePrompt] = PromptCatalog.defaults.getValue(activePrompt)
            showPrompt(animated = true)
        }, LinearLayout.LayoutParams(0, d(44), 1f))
        actions.addView(button("全部恢复默认", false) {
            promptDraft.clear()
            promptDraft.putAll(PromptCatalog.defaults)
            showPrompt(animated = true)
        }, LinearLayout.LayoutParams(0, d(44), 1f))
        promptPage.addView(actions, LinearLayout.LayoutParams(-1, d(44)))
        promptPage.addView(Palette.text(context, "保存后在新对话中生效。", 12f, Palette.muted), LinearLayout.LayoutParams(-1, d(32)))
        purpose.onSelectionChanged = { index ->
            storePromptDraft()
            activePrompt = promptKeys[index]
            showPrompt(animated = true)
        }
        showPrompt(animated = false)
    }

    private fun storePromptDraft() {
        promptDraft[activePrompt] = promptEditor.text.toString()
    }

    private fun showPrompt(animated: Boolean) {
        promptEditor.animate().cancel()
        promptEditor.alpha = 1f
        promptEditor.translationY = 0f
        promptEditor.setText(promptDraft.getValue(activePrompt))
        promptEditor.setSelection(0)
        promptHint.text = activePrompt.hint
        if (animated && isLaidOut && ValueAnimator.areAnimatorsEnabled()) {
            promptEditor.alpha = .25f
            promptEditor.translationY = d(4).toFloat()
            promptEditor.animate().alpha(1f).translationY(0f).setDuration(180).setInterpolator(pageEase).start()
        }
    }

    private fun settlePages() {
        pageAnimator?.removeAllListeners()
        pageAnimator?.cancel()
        pageAnimator = null
        tabPages.forEachIndexed { index, page ->
            page.alpha = 1f
            page.translationX = 0f
            page.visibility = if (index == activePage) VISIBLE else GONE
            page.importantForAccessibility = if (index == activePage) IMPORTANT_FOR_ACCESSIBILITY_AUTO else IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        }
    }

    private fun selectPage(index: Int) {
        val previous = activePage
        settlePages()
        if (previous == index) return
        findFocus()?.clearFocus()
        context.getSystemService(InputMethodManager::class.java).hideSoftInputFromWindow(windowToken, 0)
        settleAdvanced()
        activePage = index
        if (previous < 0 || !isLaidOut || !ValueAnimator.areAnimatorsEnabled()) {
            settlePages()
            return
        }
        val outgoing = tabPages[previous]
        val incoming = tabPages[index]
        outgoing.visibility = VISIBLE
        outgoing.importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        incoming.visibility = VISIBLE
        incoming.importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_AUTO
        incoming.bringToFront()
        incoming.alpha = 0f
        incoming.translationX = d(7).toFloat()
        val animation = AnimatorSet()
        pageAnimator = animation
        animation.playTogether(
            ObjectAnimator.ofFloat(incoming, View.ALPHA, 0f, 1f).apply { duration = 200L; interpolator = pageEase },
            ObjectAnimator.ofFloat(incoming, View.TRANSLATION_X, d(7).toFloat(), 0f).apply { duration = 300L; interpolator = pageEase },
            ObjectAnimator.ofFloat(outgoing, View.ALPHA, 1f, 0f).apply { duration = 200L; interpolator = pageEase },
            ObjectAnimator.ofFloat(outgoing, View.TRANSLATION_X, 0f, d(7).toFloat()).apply { duration = 300L; interpolator = pageEase }
        )
        animation.addListener(object : AnimatorListenerAdapter() {
            override fun onAnimationEnd(animator: Animator) {
                if (pageAnimator === animator) settlePages()
            }
        })
        animation.start()
    }

    private fun settleAdvanced() {
        advancedAnimator?.removeAllListeners()
        advancedAnimator?.cancel()
        advancedAnimator = null
        advanced.alpha = 1f
        advanced.visibility = if (advancedExpanded) VISIBLE else GONE
        advanced.layoutParams = advanced.layoutParams.apply { height = LayoutParams.WRAP_CONTENT }
    }

    private fun toggleAdvanced() {
        val startHeight = if (advanced.visibility == GONE) 0 else
            advanced.layoutParams.height.takeIf { it >= 0 } ?: advanced.height
        val startAlpha = if (advanced.visibility == GONE) 0f else advanced.alpha
        advancedAnimator?.removeAllListeners()
        advancedAnimator?.cancel()
        advancedAnimator = null
        advancedExpanded = !advancedExpanded
        if (!isLaidOut || !ValueAnimator.areAnimatorsEnabled()) {
            settleAdvanced()
            return
        }
        val width = (modelPage.width - modelPage.paddingLeft - modelPage.paddingRight).coerceAtLeast(0)
        advanced.measure(MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY),
            MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
        val targetHeight = if (advancedExpanded) advanced.measuredHeight else 0
        val targetAlpha = if (advancedExpanded) 1f else 0f
        advanced.visibility = VISIBLE
        advanced.layoutParams = advanced.layoutParams.apply { height = startHeight }
        advanced.alpha = startAlpha
        val animation = ValueAnimator.ofFloat(0f, 1f)
        advancedAnimator = animation
        animation.duration = 220L
        animation.interpolator = pageEase
        animation.addUpdateListener {
            val progress = it.animatedValue as Float
            advanced.layoutParams = advanced.layoutParams.apply { height = (startHeight + (targetHeight - startHeight) * progress).toInt() }
            advanced.alpha = startAlpha + (targetAlpha - startAlpha) * progress
        }
        animation.addListener(object : AnimatorListenerAdapter() {
            override fun onAnimationEnd(animator: Animator) {
                if (advancedAnimator === animator) settleAdvanced()
            }
        })
        animation.start()
    }

    override fun onDetachedFromWindow() {
        settlePages()
        settleAdvanced()
        promptEditor.animate().cancel()
        promptEditor.alpha = 1f
        promptEditor.translationY = 0f
        super.onDetachedFromWindow()
    }

    fun updateAccess(connected: Boolean, authorized: Boolean = connected) {
        accessValue.text = when {
            connected -> "已开启  ›"
            authorized -> "重新连接  ›"
            else -> "开启  ›"
        }
        accessValue.contentDescription = when {
            connected -> "即开即选已开启"
            authorized -> "即开即选已授权，点击重新连接"
            else -> "开启即开即选"
        }
        val assistantEnabled = RabbitVoiceService.isDefault(context)
        assistantValue.text = if (assistantEnabled) "系统助理 · 已设置  ›" else "设为系统助理  ›"
        assistantValue.contentDescription = if (assistantEnabled) "兔球已设为系统助理，点击更改" else "将兔球设为系统助理"
    }
    fun showError(message: String) { error.text = message; error.visibility = VISIBLE }
    private fun label(parent: LinearLayout, title: String) {
        parent.addView(Palette.text(context, title, 12f, Palette.muted).apply { setPadding(0,d(18),0,d(8)) })
    }
    private fun field(parent: LinearLayout, title: String, value: String, placeholder: String, type: Int = InputType.TYPE_CLASS_TEXT): EditText {
        label(parent, title)
        return EditText(context).apply {
            inputType=type; setText(value); hint=placeholder; textSize=14f
            setTextColor(Palette.ink); setHintTextColor(Palette.muted); setSingleLine(true)
            setPadding(d(14),0,d(14),0); background=Palette.round(context,Color.WHITE,Palette.cornerControl,Palette.line)
            importantForAutofill=View.IMPORTANT_FOR_AUTOFILL_NO
            parent.addView(this, LinearLayout.LayoutParams(-1,d(48)))
        }
    }
    private inner class Selector(private val title: String, private val values: List<String>) : LinearLayout(context) {
        var selectedItemPosition = 0
            private set
        var onSelectionChanged: ((Int) -> Unit)? = null
        private val value = Palette.text(context, values.first(), 14f).apply {
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.END
            importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
        }
        private val arrow = SelectorArrow(context)
        private var popup: PopupWindow? = null

        init {
            orientation = HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(d(12), 0, d(10), 0)
            addView(value, LinearLayout.LayoutParams(0, -1, 1f))
            addView(arrow, LinearLayout.LayoutParams(d(20), d(20)).apply { leftMargin = d(10) })
            isClickable = true
            isFocusable = true
            accessibilityDelegate = object : View.AccessibilityDelegate() {
                override fun onInitializeAccessibilityNodeInfo(host: View, info: AccessibilityNodeInfo) {
                    super.onInitializeAccessibilityNodeInfo(host, info)
                    info.className = "android.widget.Spinner"
                }
            }
            setOnFocusChangeListener { _, _ -> updateBorder() }
            setOnClickListener { openOptions() }
            setSelection(0)
            updateBorder()
        }

        fun setSelection(index: Int) {
            val changed = selectedItemPosition != index
            selectedItemPosition = index
            value.text = values[index]
            contentDescription = "$title：${values[index]}"
            if (changed) onSelectionChanged?.invoke(index)
        }

        private fun updateBorder() {
            background = Palette.ripple(context, Color.WHITE, Palette.cornerControl, if (isActivated || isFocused) Palette.accent else Palette.line)
        }

        private fun openOptions() {
            if (popup != null) return
            requestFocus()
            context.getSystemService(InputMethodManager::class.java).hideSoftInputFromWindow(windowToken, 0)
            val options = LinearLayout(context).apply {
                orientation = VERTICAL
                setPadding(d(5), d(5), d(5), d(5))
            }
            values.forEachIndexed { index, label ->
                val selected = index == selectedItemPosition
                val row = LinearLayout(context).apply {
                    gravity = Gravity.CENTER_VERTICAL
                    setPadding(d(10), 0, d(10), 0)
                    background = Palette.ripple(context, if (selected) Palette.blush else Color.WHITE, Palette.cornerSmall)
                    isClickable = true
                    isFocusable = true
                    contentDescription = label
                    accessibilityDelegate = object : View.AccessibilityDelegate() {
                        override fun onInitializeAccessibilityNodeInfo(host: View, info: AccessibilityNodeInfo) {
                            super.onInitializeAccessibilityNodeInfo(host, info)
                            info.className = "android.widget.CheckedTextView"
                            info.isCheckable = true
                            info.isChecked = selected
                        }
                    }
                    setOnFocusChangeListener { _, focused ->
                        background = Palette.ripple(context, if (selected || focused) Palette.blush else Color.WHITE, Palette.cornerSmall)
                    }
                    setOnClickListener {
                        setSelection(index)
                        popup?.dismiss()
                    }
                }
                row.addView(Palette.text(context, label, 14f, if (selected) Palette.accent else Palette.ink).apply {
                    maxLines = 1
                    ellipsize = TextUtils.TruncateAt.END
                    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
                }, LinearLayout.LayoutParams(0, -1, 1f))
                row.addView(Palette.text(context, if (selected) "✓" else "", 14f, Palette.accent).apply {
                    gravity = Gravity.CENTER
                    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
                }, LinearLayout.LayoutParams(d(24), -1))
                options.addView(row, LinearLayout.LayoutParams(-1, d(48)))
            }
            // 白底细边与柔粉选中态沿用 PC 设置和浮层菜单，不使用系统 Spinner 皮肤。
            popup = PopupWindow(options, width, LayoutParams.WRAP_CONTENT, true).apply {
                setBackgroundDrawable(Palette.round(context, Color.WHITE, Palette.cornerControl, Palette.line))
                elevation = d(8).toFloat()
                isOutsideTouchable = true
                inputMethodMode = PopupWindow.INPUT_METHOD_NOT_NEEDED
                setOnDismissListener {
                    popup = null
                    this@Selector.isActivated = false
                    arrow.animate().rotation(0f).setDuration(160).start()
                    updateBorder()
                }
                showAsDropDown(this@Selector, 0, d(6))
            }
            isActivated = true
            updateBorder()
            arrow.animate().rotation(180f).setDuration(160).start()
            options.alpha = 0f
            options.animate().alpha(1f).setDuration(120).start()
            options.getChildAt(selectedItemPosition).requestFocus()
        }

        override fun onDetachedFromWindow() {
            popup?.dismiss()
            super.onDetachedFromWindow()
        }
    }

    private class SelectorArrow(context: Context) : View(context) {
        private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Palette.muted
            style = Paint.Style.STROKE
            strokeWidth = context.resources.displayMetrics.density * 1.5f
            strokeCap = Paint.Cap.ROUND
            strokeJoin = Paint.Join.ROUND
        }
        private val path = Path()

        init { importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO }

        override fun onDraw(canvas: Canvas) {
            super.onDraw(canvas)
            path.rewind()
            path.moveTo(width * .28f, height * .4f)
            path.lineTo(width * .5f, height * .62f)
            path.lineTo(width * .72f, height * .4f)
            canvas.drawPath(path, paint)
        }
    }
    companion object {
        private val HEX_COLOR = Regex("#[0-9a-fA-F]{6}")
    }

    private fun button(label: String, primary: Boolean, action: () -> Unit): TextView = Palette.text(context,label,14f,if(primary) Color.WHITE else Palette.accent,primary).apply {
        gravity=Gravity.CENTER
        background=Palette.ripple(context,if(primary) Palette.accent else Color.TRANSPARENT,Palette.cornerControl)
        isClickable=true; isFocusable=true; setOnClickListener { action() }
    }
}
