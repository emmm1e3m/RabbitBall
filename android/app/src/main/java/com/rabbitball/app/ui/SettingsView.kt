package com.rabbitball.app.ui

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.text.InputType
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.view.WindowInsets
import android.view.accessibility.AccessibilityNodeInfo
import android.view.inputmethod.InputMethodManager
import android.widget.*
import com.rabbitball.app.AppSettings
import com.rabbitball.app.ModelConfig

class SettingsView(context: Context, initial: ModelConfig, firstRun: Boolean) : FrameLayout(context) {
    var onSave: ((ModelConfig, Boolean) -> Unit)? = null
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
    private val error: TextView
    private val models = mutableListOf("deepseek-flash", "deepseek-v4-pro")
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
        val modelPage = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
        val petPage = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
        val tabViews = listOf("模型", "兔球").mapIndexed { index, title ->
            Palette.text(context, title, 14f, Palette.muted, true).apply {
                gravity = Gravity.CENTER
                isClickable = true; isFocusable = true
                setOnClickListener {
                    modelPage.visibility = if (index == 0) VISIBLE else GONE
                    petPage.visibility = if (index == 1) VISIBLE else GONE
                    for (i in 0 until tabs.childCount) {
                        (tabs.getChildAt(i) as TextView).setTextColor(if (i == index) Palette.accent else Palette.muted)
                        tabs.getChildAt(i).background = if (i == index) Palette.round(context, Palette.blush, 12f) else null
                    }
                }
                tabs.addView(this, LinearLayout.LayoutParams(0, d(42), 1f).apply { if(index>0) leftMargin=d(8) })
            }
        }
        column.addView(tabs, LinearLayout.LayoutParams(-1, d(42)).apply { topMargin=d(8); bottomMargin=d(12) })
        val scroll = ScrollView(context).apply { isFillViewport = true; clipToPadding = false }
        column.addView(scroll, LinearLayout.LayoutParams(-1, 0, 1f))
        scroll.addView(pages, FrameLayout.LayoutParams(-1, -2))
        pages.addView(modelPage, LayoutParams(-1, -2))
        pages.addView(petPage, LayoutParams(-1, -2))

        key = field(modelPage, "DeepSeek API Key", initial.apiKey, "填写 API Key", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD)
        if (initial.model !in models) models.add(initial.model)
        label(modelPage, "模型")
        model = Selector("模型", models.map { when(it) { "deepseek-flash" -> "DeepSeek Flash"; "deepseek-v4-pro" -> "DeepSeek V4 Pro"; else -> it } }).apply {
            setSelection(models.indexOf(initial.model).coerceAtLeast(0))
        }
        modelPage.addView(model, LinearLayout.LayoutParams(-1, d(48)))
        label(modelPage, "思考强度")
        reasoning = Selector("思考强度", listOf("low", "high", "max")).apply { setSelection(listOf("low", "medium", "high").indexOf(initial.reasoning).coerceAtLeast(0)) }
        modelPage.addView(reasoning, LinearLayout.LayoutParams(-1, d(48)))
        val advanced = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL; visibility = GONE }
        modelPage.addView(button("高级设置", false) { advanced.visibility = if(advanced.visibility == VISIBLE) GONE else VISIBLE }, LinearLayout.LayoutParams(-1, d(46)).apply { topMargin=d(16) })
        modelPage.addView(advanced)
        endpoint = field(advanced, "API 基础地址", initial.endpoint, "https://api.deepseek.com", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI)
        rounds = field(advanced, "工具调用轮数", initial.maxToolRounds.toString(), "3", InputType.TYPE_CLASS_NUMBER)

        val access = LinearLayout(context).apply { gravity = Gravity.CENTER_VERTICAL }
        access.addView(Palette.text(context, "即开即选", 14f), LinearLayout.LayoutParams(0, d(58), 1f))
        accessValue = button("开启", false) { onAccessibility?.invoke() }
        access.addView(accessValue, LinearLayout.LayoutParams(d(84), d(40)))
        petPage.addView(access)
        val petSwitch = Switch(context).apply {
            text = "屏幕边缘陪伴"; textSize = 14f; setTextColor(Palette.ink); minimumHeight=d(58)
            isChecked = context.getSharedPreferences("rabbitball_ui", Context.MODE_PRIVATE).getBoolean("edge_pet", true)
            setOnCheckedChangeListener { _, checked ->
                context.getSharedPreferences("rabbitball_ui", Context.MODE_PRIVATE).edit().putBoolean("edge_pet", checked).apply()
                onPetMode?.invoke(checked)
            }
        }
        petPage.addView(petSwitch)
        petPage.addView(button("系统数字助理  ›", false) { onAssistant?.invoke() }, LinearLayout.LayoutParams(-1, d(50)).apply { topMargin=d(8) })
        if (!firstRun) petPage.addView(button("最近对话  ›", false) { onHistory?.invoke() }, LinearLayout.LayoutParams(-1, d(50)).apply { topMargin=d(8) })
        error = Palette.text(context, "", 12f, Palette.error).apply { visibility = GONE; setPadding(0,d(8),0,d(8)) }
        column.addView(error)
        column.addView(button(if (firstRun) "保存并开始" else "保存", true) {
            try {
                val config = ModelConfig(endpoint.text.toString().trim(), models[model.selectedItemPosition], key.text.toString().trim(),
                    listOf("low","medium","high")[reasoning.selectedItemPosition], rounds.text.toString().toIntOrNull() ?: 0)
                AppSettings.validate(config)
                onSave?.invoke(config, firstRun)
            } catch (e: Exception) { showError(e.message ?: "设置未能保存。") }
        }, LinearLayout.LayoutParams(-1, d(48)).apply { topMargin=d(16) })
        tabViews.first().performClick()
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
            setPadding(d(14),0,d(14),0); background=Palette.round(context,Color.WHITE,14f,Palette.line)
            importantForAutofill=View.IMPORTANT_FOR_AUTOFILL_NO
            parent.addView(this, LinearLayout.LayoutParams(-1,d(48)))
        }
    }
    private inner class Selector(private val title: String, private val values: List<String>) : LinearLayout(context) {
        var selectedItemPosition = 0
            private set
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
            selectedItemPosition = index
            value.text = values[index]
            contentDescription = "$title：${values[index]}"
        }

        private fun updateBorder() {
            background = Palette.ripple(context, Color.WHITE, 9f, if (isActivated || isFocused) Palette.accent else Palette.line)
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
                    background = Palette.ripple(context, if (selected) Palette.blush else Color.WHITE, 8f)
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
                        background = Palette.ripple(context, if (selected || focused) Palette.blush else Color.WHITE, 8f)
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
                setBackgroundDrawable(Palette.round(context, Color.WHITE, 13f, Palette.line))
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
    private fun button(label: String, primary: Boolean, action: () -> Unit): TextView = Palette.text(context,label,14f,if(primary) Color.WHITE else Palette.accent,primary).apply {
        gravity=Gravity.CENTER
        background=Palette.ripple(context,if(primary) Palette.accent else Color.TRANSPARENT,14f)
        isClickable=true; isFocusable=true; setOnClickListener { action() }
    }
}
