package com.rabbitball.app

import android.app.Instrumentation
import android.content.Context
import android.content.ContextWrapper
import android.content.SharedPreferences
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Insets
import android.graphics.PointF
import android.graphics.Rect
import android.graphics.RectF
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.net.Uri
import android.os.SystemClock
import android.provider.Settings
import android.view.MotionEvent
import android.view.TextureView
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.widget.EditText
import android.widget.TextView
import com.rabbitball.app.ui.CameraView
import com.rabbitball.app.ui.CameraOrientation
import com.rabbitball.app.ui.ConversationWebView
import com.rabbitball.app.ui.RabbitView
import com.rabbitball.app.ui.PetDock
import com.rabbitball.app.ui.SearchView
import com.rabbitball.app.ui.SelectionView
import com.rabbitball.app.ui.SettingsView
import java.util.concurrent.atomic.AtomicReference
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.abs
import kotlin.math.roundToInt

/** 在未挂载的真实视图上验证交互，不启动页面或向系统发送输入。 */
object UiContractChecks {
    fun run(instrumentation: Instrumentation) {
        captureResultOwnership(instrumentation)
        dockRemembersViewPosition(instrumentation)
        settingsPagesKeepDrafts(instrumentation)
        historyRetention(instrumentation)
        inputFocusPreservesPetSide(instrumentation)
        submissionClearsSentText(instrumentation)
        AttachmentContractChecks.run(instrumentation)
        conversationDomAndMarkdown(instrumentation)
        keyboardPreservesScreenshotViewport(instrumentation)
        selectionMaskAndGestures(instrumentation)
        cameraFramesKeepControlsClear(instrumentation)
        cameraOrientationAndPixels()
        imageImportMemoryFixtures(instrumentation)
    }

    fun historyRetention(instrumentation: Instrumentation) = onMain(instrumentation) {
        val preferences = instrumentation.targetContext.getSharedPreferences("history_retention_ui_fixture", Context.MODE_PRIVATE)
        preferences.edit().clear().putInt("history_limit", 0).commit()
        val context = object : ContextWrapper(instrumentation.targetContext) {
            override fun getSharedPreferences(name: String, mode: Int): SharedPreferences = preferences
        }
        var search: SearchView? = null
        try {
            val view = SearchView(context).also { search = it }
            val historyButton = descendants(view).single { it.contentDescription == "历史记录" }
            check(historyButton.visibility == View.GONE) { "关闭历史后仍显示历史圆按钮" }
            preferences.edit().putInt("history_limit", 3).commit()
            view.refreshHistoryAvailability()
            check(historyButton.visibility == View.VISIBLE) { "重新启用历史后没有恢复历史圆按钮" }
            preferences.edit().putInt("history_limit", 0).commit()
            view.refreshHistoryAvailability()
            check(historyButton.visibility == View.GONE) { "已有会话没有同步隐藏历史圆按钮" }

            for (limit in listOf(0, 3)) {
                val settings = SettingsView(context, AppConfig(historyLimit = limit), false)
                val recent = descendants(settings).filterIsInstance<TextView>().single { it.text.toString() == "最近对话  ›" }
                check(recent.visibility == if (limit == 0) View.GONE else View.VISIBLE) { "设置页历史入口未遵循保留条数" }
                val input = descendants(settings).filterIsInstance<EditText>().single { it.contentDescription == "历史记录保留条数" }
                val save = descendants(settings).filterIsInstance<TextView>().single { it.isClickable && it.text.toString() == "保存" }
                var saved: AppConfig? = null
                settings.onSave = { config, _ -> saved = config }
                input.setText("0")
                check(save.performClick() && saved?.historyLimit == 0) { "设置页不能保存零条历史" }
                for (invalid in listOf("", "2147483648", "-1")) {
                    saved = null
                    input.setText(invalid)
                    check(save.performClick() && saved == null) { "无效保留条数被当成关闭历史：$invalid" }
                }
            }
        } finally {
            search?.release()
            preferences.edit().clear().commit()
        }
    }

    private fun settingsPagesKeepDrafts(instrumentation: Instrumentation) = onMain(instrumentation) {
        val context = instrumentation.targetContext
        val original = context.getSharedPreferences("rabbit_settings", Context.MODE_PRIVATE).all.toMap()
        val initial = AppConfig(model = ModelConfig(prompts = mapOf(PromptKey.SYSTEM to "初始系统草稿")))
        val view = SettingsView(context, initial, false)
        val keyInput = descendants(view).filterIsInstance<EditText>().first()
        check(keyInput.transformationMethod is android.text.method.PasswordTransformationMethod) { "设置页未遮挡 API Key" }
        val labels = listOf("模型", "外观", "常规", "提示词")
        val tabs = labels.map { title -> descendants(view).filterIsInstance<TextView>().single { it.isClickable && it.text.toString() == title } }
        check(tabs.map { (it.parent as ViewGroup).indexOfChild(it) } == listOf(0, 1, 2, 3)) { "设置四页缺失或顺序与 PC 不一致" }
        val editor = descendants(view).filterIsInstance<EditText>().single { it.contentDescription == "提示词内容" }
        val purpose = descendants(view).single { it.contentDescription?.toString()?.startsWith("用途：") == true }
        fun selectPurpose(index: Int) {
            // 未挂载窗口无法打开 PopupWindow，直接驱动同一选择器的选择动作。
            purpose.javaClass.getDeclaredMethod("setSelection", Int::class.javaPrimitiveType).apply { isAccessible = true }.invoke(purpose, index)
        }
        fun click(title: String) = descendants(view).filterIsInstance<TextView>().single { it.isClickable && it.text.toString() == title }.performClick()
        var saved: AppConfig? = null
        view.onSave = { config, first -> check(!first); saved = config }
        check(tabs[3].performClick() && (editor.parent as View).visibility == View.VISIBLE)
        check(editor.text.toString() == "初始系统草稿")
        editor.setText("修改系统草稿")
        selectPurpose(1)
        check(editor.text.toString() == PromptCatalog.defaults.getValue(PromptKey.FALLBACK))
        editor.setText("附件草稿")
        selectPurpose(0)
        check(editor.text.toString() == "修改系统草稿") { "切换提示词用途后丢失草稿" }
        check(tabs[1].performClick() && tabs[2].performClick() && tabs[3].performClick())
        check(editor.text.toString() == "修改系统草稿") { "切换设置页面后丢失提示词草稿" }
        check(click("保存"))
        check(saved?.model?.prompts == mapOf(PromptKey.SYSTEM to "修改系统草稿", PromptKey.FALLBACK to "附件草稿"))
        check(click("恢复这项默认") && editor.text.toString() == PromptCatalog.defaults.getValue(PromptKey.SYSTEM))
        check(click("保存") && saved?.model?.prompts == mapOf(PromptKey.FALLBACK to "附件草稿")) { "恢复当前项修改了其它提示词" }
        check(click("全部恢复默认") && click("保存") && saved?.model?.prompts?.isEmpty() == true)
        check(context.getSharedPreferences("rabbit_settings", Context.MODE_PRIVATE).all == original) {
            "设置草稿或预览在保存回调之外写入了持久配置"
        }
    }

    private fun inputFocusPreservesPetSide(instrumentation: Instrumentation) {
        lateinit var view: SearchView
        lateinit var mascot: RabbitView
        var before = 0f
        onMain(instrumentation) {
            view = SearchView(instrumentation.targetContext)
            layout(view, 400, 600)
            mascot = descendants(view).filterIsInstance<RabbitView>().single()
            before = mascot.x
            val input = descendants(view).filterIsInstance<EditText>().single { it.contentDescription == "输入问题" }
            input.requestFocus()
        }
        try {
            // 超过原横飞时长，确认输入焦点只改变视线，不触发另一侧移动。
            Thread.sleep(700)
            onMain(instrumentation) { check(abs(mascot.x - before) < 1f) { "开始输入仍触发兔球横飞" } }
        } finally { onMain(instrumentation) { view.release() } }
    }

    private fun captureResultOwnership(instrumentation: Instrumentation) = onMain(instrumentation) {
        val original = CaptureStore.take()
        val first = Bitmap.createBitmap(4, 4, Bitmap.Config.ARGB_8888)
        val second = Bitmap.createBitmap(4, 4, Bitmap.Config.ARGB_8888)
        val third = Bitmap.createBitmap(4, 4, Bitmap.Config.ARGB_8888)
        try {
            CaptureStore.store(CaptureResult(first))
            val pending = CaptureResult(second)
            CaptureStore.store(pending)
            check(first.isRecycled && !second.isRecycled) { "覆盖未消费截图没有释放旧图，或提前释放了新图" }
            check(CaptureStore.take() === pending && CaptureStore.take() == null) { "截图结果没有一次消费" }
            CaptureStore.clear()
            check(!second.isRecycled) { "清理缓存回收了已交付消费者的截图" }
            CaptureStore.store(CaptureResult(null, "测试错误"))
            check(!second.isRecycled && CaptureStore.take()?.error == "测试错误" && CaptureStore.take() == null)
            CaptureStore.store(CaptureResult(third))
            CaptureStore.clear()
            check(third.isRecycled && CaptureStore.take() == null) { "清理没有回收仍未消费的截图" }
        } finally {
            CaptureStore.clear()
            listOf(first, second, third).forEach { if (!it.isRecycled) it.recycle() }
            if (original != null) CaptureStore.store(original)
        }
    }

    private fun dockRemembersViewPosition(instrumentation: Instrumentation) = onMain(instrumentation) {
        val preferences = instrumentation.targetContext.getSharedPreferences("pet_dock_fixture", Context.MODE_PRIVATE)
        preferences.edit().clear().commit()
        val context = object : ContextWrapper(instrumentation.targetContext) {
            override fun getSharedPreferences(name: String, mode: Int): SharedPreferences = preferences
        }
        try {
            val dock = PetDock(context)
            val density = context.resources.displayMetrics.density
            val width = (400 * density).roundToInt()
            val height = (800 * density).roundToInt()
            val top = (24 * density).roundToInt()
            val bottom = (32 * density).roundToInt()
            val wanted = PointF(0f, 200f * density)
            dock.remember(wanted, width, height, top, bottom)
            val saved = PetDock(context)
            val left = saved.position(width, height, top, bottom)
            check(saved.left && abs(left.y - wanted.y) < 1f) { "停靠高度未按视图左上角记忆" }
            check(left.x < 0f && left.x + dock.viewWidth > 0f && left.x + dock.viewWidth < dock.viewWidth * .4f) {
                "左停靠没有留下可见薄球帽"
            }
            val taller = saved.position(width, height * 3 / 2, top, bottom)
            check(taller.y > left.y)
            saved.remember(taller, width, height * 3 / 2, top, bottom)
            check(abs(PetDock(context).position(width, height, top, bottom).y - left.y) < 1f) { "窗口高度变化后丢失了相对停靠高度" }

            val rightWanted = PointF((width - dock.viewWidth).toFloat(), height * .6f)
            saved.remember(rightWanted, width, height, top, bottom)
            val restored = PetDock(context)
            val right = restored.position(width, height, top, bottom)
            check(!restored.left && abs(right.y - rightWanted.y) < 1f)
            check(right.x < width && right.x + dock.viewWidth > width && width - right.x < dock.viewWidth * .4f) {
                "右停靠没有留下可见薄球帽"
            }
            restored.remember(PointF(0f, -height.toFloat()), width, height, top, bottom)
            val safeTop = restored.position(width, height, top, bottom)
            restored.remember(PointF(0f, height * 2f), width, height, top, bottom)
            val safeBottom = restored.position(width, height, top, bottom)
            check(safeTop.y < safeBottom.y)
            check(abs(restored.constrain(PointF(0f, -height.toFloat()), width, height, top, bottom).y - safeTop.y) < 1f &&
                abs(restored.constrain(PointF(0f, height * 2f), width, height, top, bottom).y - safeBottom.y) < 1f) {
                "极端记忆位置与拖动安全高度约束不一致"
            }
        } finally { preferences.edit().clear().commit() }
    }

    private fun imageImportMemoryFixtures(instrumentation: Instrumentation) {
        val file = java.io.File.createTempFile("rabbit-import-fixture-", ".png", instrumentation.targetContext.cacheDir)
        fun decode(source: Bitmap): Bitmap {
            file.outputStream().use { check(source.compress(Bitmap.CompressFormat.PNG, 100, it)) }
            return ImageImport.decode(instrumentation.targetContext, Uri.fromFile(file))
        }
        try {
            val small = Bitmap.createBitmap(6, 4, Bitmap.Config.ARGB_8888).apply {
                setPixel(0, 0, Color.RED)
                setPixel(5, 3, Color.argb(64, 0, 255, 0))
            }
            try {
                val decoded = decode(small)
                try {
                    check(decoded.width == 6 && decoded.height == 4) { "导入小图被放大或裁剪" }
                    check(decoded.getPixel(0, 0) == Color.RED && Color.alpha(decoded.getPixel(1, 1)) == 0 &&
                        Color.alpha(decoded.getPixel(5, 3)) == 64) { "导入图片的透明度或像素未保留" }
                } finally { decoded.recycle() }
            } finally { small.recycle() }
            val wide = Bitmap.createBitmap(3000, 30, Bitmap.Config.ARGB_8888)
            try {
                val decoded = decode(wide)
                try {
                    check(decoded.width == 2560 && abs(decoded.height - 30f * decoded.width / 3000f) <= 1f) {
                        "导入大图未等比限制最长边"
                    }
                } finally { decoded.recycle() }
            } finally { wide.recycle() }
        } finally { file.delete() }
    }

    private fun cameraFramesKeepControlsClear(instrumentation: Instrumentation) {
        for ((orientation, widthDp, heightDp) in listOf(
            Triple(Configuration.ORIENTATION_PORTRAIT, 400, 800),
            Triple(Configuration.ORIENTATION_LANDSCAPE, 800, 400)
        )) {
            val configuration = Configuration(instrumentation.targetContext.resources.configuration).also { it.orientation = orientation }
            val context = instrumentation.targetContext.createConfigurationContext(configuration)
            val view = onMain(instrumentation) {
                SearchView(context).also { layout(it, widthDp, heightDp); it.openCamera(); layout(it, widthDp, heightDp) }
            }
            try {
                // 在有限飞行动画完成后检查实际快门位置，避免把途中姿态当成最终布局。
                Thread.sleep(700)
                onMain(instrumentation) {
                    layout(view, widthDp, heightDp)
                    val camera = descendants(view).filterIsInstance<CameraView>().single()
                    val frame = descendants(camera).filterIsInstance<TextureView>().single().parent as View
                    val mascot = descendants(view).filterIsInstance<RabbitView>().single()
                    fun bounds(child: View): RectF {
                        val box = Rect(0, 0, child.width, child.height)
                        view.offsetDescendantRectToMyCoords(child, box)
                        return RectF(box)
                    }
                    val frameBox = bounds(frame)
                    val mascotBox = bounds(mascot)
                    val expected = if (orientation == Configuration.ORIENTATION_LANDSCAPE) 4f / 3f else 3f / 4f
                    check(frameBox.width() > 0 && frameBox.height() > 0 &&
                        abs(frameBox.width() / frameBox.height() - expected) < .005f) { "相机取景框未匹配屏幕横竖比例" }
                    check(mascot.visibility == View.VISIBLE && frameBox.left >= 0 && frameBox.right <= view.width && frameBox.top >= 0 &&
                        frameBox.bottom <= mascotBox.top && mascotBox.bottom <= view.height) { "取景框侵入快门区或越出屏幕" }
                    val controls = descendants(camera).filter { it.contentDescription in listOf("取消拍摄", "切换前后摄像头") && it.visibility == View.VISIBLE }
                    check(controls.any { it.contentDescription == "取消拍摄" })
                    controls.forEach { control ->
                        val controlBox = bounds(control)
                        check(controlBox.left >= 0 && controlBox.right <= view.width && controlBox.top >= 0 &&
                            controlBox.bottom <= view.height && !RectF.intersects(controlBox, frameBox) &&
                            !RectF.intersects(controlBox, mascotBox)) { "相机控制与取景框或兔球快门重叠" }
                    }
                }
            } finally { onMain(instrumentation) { view.release() } }
        }
    }

    private fun cameraOrientationAndPixels() {
        check(CameraOrientation.fromGravity(0f, 1f, 0f) == 0)
        check(CameraOrientation.fromGravity(-1f, 0f, 0f) == 90)
        check(CameraOrientation.fromGravity(0f, -1f, 0f) == 180)
        check(CameraOrientation.fromGravity(1f, 0f, 0f) == 270)
        check(CameraOrientation.fromGravity(0f, 0f, 1f) == null && CameraOrientation.fromGravity(0f, 0f, -1f) == null) {
            "平躺姿态没有保留上一稳定方向"
        }
        val rotations = listOf(
            Triple(90, false, intArrayOf(90, 180, 270, 0)),
            Triple(270, false, intArrayOf(270, 0, 90, 180)),
            Triple(90, true, intArrayOf(90, 0, 270, 180)),
            Triple(270, true, intArrayOf(270, 180, 90, 0))
        )
        for ((sensor, front, expected) in rotations) {
            listOf(0, 90, 180, 270).forEachIndexed { index, device ->
                check(CameraOrientation.jpegRotation(sensor, device, front) == expected[index]) {
                    "照片方向与传感器/设备方向不符：sensor=$sensor，device=$device，front=$front"
                }
            }
        }
        val sourcePixels = intArrayOf(Color.RED, Color.GREEN, Color.BLUE, Color.YELLOW, Color.CYAN, Color.MAGENTA)
        val expectedPixels = listOf(sourcePixels,
            intArrayOf(Color.CYAN, Color.BLUE, Color.RED, Color.MAGENTA, Color.YELLOW, Color.GREEN),
            intArrayOf(Color.MAGENTA, Color.CYAN, Color.YELLOW, Color.BLUE, Color.GREEN, Color.RED),
            intArrayOf(Color.GREEN, Color.YELLOW, Color.MAGENTA, Color.RED, Color.BLUE, Color.CYAN))
        listOf(0, 90, 180, 270).forEachIndexed { index, degrees ->
            val original = Bitmap.createBitmap(sourcePixels, 2, 3, Bitmap.Config.ARGB_8888)
            val rotated = CameraOrientation.normaliseBitmap(original, degrees)
            try {
                check(!original.isRecycled) { "方向转换提前回收了调用者的原图" }
                check(rotated.width == if (index % 2 == 0) 2 else 3)
                check(rotated.height == if (index % 2 == 0) 3 else 2)
                val actual = IntArray(6)
                rotated.getPixels(actual, 0, rotated.width, 0, 0, rotated.width, rotated.height)
                check(actual.contentEquals(expectedPixels[index])) { "${degrees}度旋转未生成正确的实际像素方向" }
            } finally {
                if (rotated !== original) rotated.recycle()
                original.recycle()
            }
        }
        for ((width, height) in listOf(16 to 9, 9 to 16)) {
            val source = Bitmap.createBitmap(32, 32, Bitmap.Config.ARGB_8888)
            for (y in 0 until source.height) for (x in 0 until source.width) {
                source.setPixel(x, y, Color.rgb(x * 7, y * 7, 100))
            }
            val cropped = CameraOrientation.centerCrop(source, width, height)
            try {
                check(!source.isRecycled && abs(cropped.width.toFloat() / cropped.height - width.toFloat() / height) < .005f)
                check(cropped.width == source.width || cropped.height == source.height) { "照片裁切额外缩放了像素" }
                check(cropped.getPixel(cropped.width / 2, cropped.height / 2) == source.getPixel(source.width / 2, source.height / 2)) {
                    "照片没有围绕原始画面中心裁切"
                }
                check(CameraOrientation.centerCrop(cropped, width, height) === cropped) { "相同比例重复生成了位图" }
            } finally { if (cropped !== source) cropped.recycle(); source.recycle() }
        }
    }

    private fun submissionClearsSentText(instrumentation: Instrumentation) = withMainSearch(instrumentation) { view ->
        layout(view, 400, 600)
        val input = descendants(view).filterIsInstance<EditText>().single { it.contentDescription == "输入问题" }
        val send = descendants(view).single { it.contentDescription == "发送问题" }
        val sent = mutableListOf<Pair<String, String>>()
        val actions = listOf("搜索", "提取文字", "翻译", "历史记录")
        check(descendants(view).mapNotNull { it.contentDescription?.toString() }.filter { it in actions } == actions &&
            descendants(view).none { it.contentDescription == "拍照" }) {
            "圈选功能栏顺序错误，或仍保留旧拍照按钮"
        }
        val imageSource = descendants(view).single { it.contentDescription == "拍照或上传照片" }
        check(imageSource.visibility == View.VISIBLE)
        var picked = false
        var requested = false
        view.onPickImageRequested = { picked = true }
        view.onCameraRequested = { requested = true }
        check(imageSource.performClick() && !picked && !requested) { "图片菜单未经选择便打开了图片来源" }
        val inputBeforeChat = input.left

        // 发送立即消费当前输入，错误和停止都不把已发文本放回输入框。
        input.setText("  未配置模型时的消息  ")
        view.onSend = { text, action ->
            sent += text to action
            view.beginTurn(text)
            view.showResponse("请先填写 API Key。", true)
        }
        check(send.performClick())
        check(sent.last() == ("未配置模型时的消息" to "ask"))
        check(input.text.isEmpty()) { "用户气泡发出后没有立即清空输入" }
        layout(view, 400, 600)
        check(imageSource.visibility == View.GONE && input.left < inputBeforeChat) {
            "对话开始后未隐藏图片入口或收回输入空间"
        }

        input.setText("发生网络错误的消息")
        view.onSend = { text, action -> sent += text to action; view.beginTurn(text); view.setBusy(true) }
        send.performClick()
        check(input.text.isEmpty()) { "等待回答期间仍留着已发文本" }
        view.showResponse("网络连接中断，请重试。", true)
        view.setBusy(false)
        check(input.text.isEmpty()) { "请求失败恢复了已发文本" }

        input.setText("用户稍后停止的消息")
        var cancelled = false
        view.onCancelRequest = { cancelled = true; view.setBusy(false); view.setStatus("已停止") }
        send.performClick()
        check(send.contentDescription == "停止回答" && input.text.isEmpty())
        input.setText("停止前输入的新草稿")
        send.performClick()
        check(cancelled && input.text.toString() == "停止前输入的新草稿") { "停止回答改动了用户的新草稿" }

        input.setText("成功回答的消息")
        send.performClick()
        check(input.text.isEmpty())
        view.showResponse("回答完成")
        view.setBusy(false)
        check(input.text.isEmpty()) { "回答完成后恢复了已发文本" }

        input.setText("已经发送的问题")
        send.performClick()
        check(input.text.isEmpty())
        input.setText("等待期间编辑的新草稿")
        view.showResponse("网络错误", true)
        view.setBusy(false)
        check(input.text.toString() == "等待期间编辑的新草稿") { "失败回调覆盖了用户新编辑的草稿" }
        check(sent.size == 5) { "取消按钮触发了额外发送" }
    }

    private fun conversationDomAndMarkdown(instrumentation: Instrumentation) {
        val view = onMain(instrumentation) { SearchView(instrumentation.targetContext).also { layout(it, 400, 600) } }
        val web = onMain(instrumentation) { descendants(view).filterIsInstance<ConversationWebView>().single() }
        try {
            awaitJavascript(instrumentation, web,
                "document.documentElement.dataset.ready === 'true' && !!window.RabbitRender && !!window.markdownit && !!window.DOMPurify && !!window.katex",
                "本地 Markdown/KaTeX 页面或依赖未能载入")
            val screenshot = Bitmap.createBitmap(400, 600, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.WHITE) }
            onMain(instrumentation) {
                check(web.settings.blockNetworkLoads && !web.settings.allowFileAccess && !web.settings.allowContentAccess)
                view.setScreenshot(screenshot)
                layout(view, 400, 600)
                val image = view.selectionView.displayedImageBounds
                gesture(view.selectionView, point(image, .2f, .2f), point(image, .5f, .5f), point(image, .8f, .75f))
                val selected = RectF(view.selection ?: error("聊天前选区未生成"))
                var historyOpened = false
                view.onHistory = { historyOpened = true }
                val historyButton = descendants(view).single { it.contentDescription == "历史记录" }
                check((historyButton.parent as View).visibility == View.VISIBLE && historyButton.performClick() && historyOpened) {
                    "圈选阶段的历史记录入口不可用"
                }
                view.beginTurn("第一轮问题")
                view.setBusy(true); view.showResponse("第一轮回答"); view.setBusy(false)
                check(view.selectionView.visibility != View.VISIBLE)
                checkBounds(view.selection ?: error("聊天隐藏了发送所需选区"), selected)
                view.beginTurn("第二轮问题")
                view.setBusy(true); view.showResponse("第二轮流式片段")
                layout(view, 400, 600)
                checkChatPresentation(view)
            }
            awaitSources(instrumentation, web, listOf("第一轮问题", "第一轮回答", "第二轮问题", "第二轮流式片段"))
            onMain(instrumentation) { view.showResponse("第二轮完整回答"); view.setBusy(false) }
            awaitSources(instrumentation, web, listOf("第一轮问题", "第一轮回答", "第二轮问题", "第二轮完整回答"))
            val history = listOf(ChatTurn("user", "历史问题一"), ChatTurn("assistant", "历史回答一"),
                ChatTurn("user", "历史问题二"), ChatTurn("assistant", "历史回答二"))
            onMain(instrumentation) {
                val input = descendants(view).filterIsInstance<EditText>().single()
                input.setText("历史切换前的草稿")
                view.restoreConversation(history)
                layout(view, 400, 600)
                check(input.text.isEmpty()) { "恢复历史未清理旧草稿" }
                checkChatPresentation(view)
            }
            awaitSources(instrumentation, web, history.map { it.content })
            onMain(instrumentation) {
                val input = descendants(view).filterIsInstance<EditText>().single()
                input.setText("拍照前保留的草稿")
                val selection = RectF(view.selection ?: error("相机打开前选区丢失"))
                var picked = false
                var requested = false
                view.onPickImageRequested = { picked = true }
                view.onCameraRequested = { requested = true; view.openCamera() }
                view.setBusy(true)
                check(descendants(view).single { it.contentDescription == "拍照或上传照片" }.visibility == View.GONE)
                // 模拟宿主已取得的图片结果；聊天中隐藏的入口不参与点击。
                view.onPickImageRequested?.invoke()
                check(picked && input.text.toString() == "拍照前保留的草稿") { "选图取消前清空了草稿" }
                checkBounds(view.selection ?: error("选图取消前清空了选区"), selection)
                view.setBusy(false)
                view.onCameraRequested?.invoke()
                check(requested && descendants(view).filterIsInstance<CameraView>().size == 1)
                val camera = descendants(view).filterIsInstance<CameraView>().single()
                val switch = descendants(camera).single { it.contentDescription == "切换前后摄像头" }
                val shutter = descendants(view).filterIsInstance<RabbitView>().single()
                var unexpectedPhoto = false
                view.onPhotoCaptured = { unexpectedPhoto = true; it.recycle() }
                camera.onReadyChanged?.invoke(false)
                check(!camera.isReady && !switch.isEnabled && !shutter.isEnabled && shutter.contentDescription == "兔球快门") {
                    "相机尚未ready时仍允许快门或切摄"
                }
                camera.takePhoto()
                check(!unexpectedPhoto) { "未ready的相机交付了照片" }
                val manager = instrumentation.targetContext.getSystemService(CameraManager::class.java)
                val facings = manager.cameraIdList.mapNotNull { manager.getCameraCharacteristics(it).get(CameraCharacteristics.LENS_FACING) }.toSet()
                if (!(facings.contains(CameraCharacteristics.LENS_FACING_FRONT) && facings.contains(CameraCharacteristics.LENS_FACING_BACK))) {
                    check(!switch.isEnabled && switch.visibility != View.VISIBLE) { "只有一类镜头时仍可切摄" }
                }
                check(view.closeCamera())
                check(!view.closeCamera() && descendants(view).none { it is CameraView })
                check(input.text.toString() == "拍照前保留的草稿") { "取消拍照清空了草稿" }
                checkBounds(view.selection ?: error("取消拍照清空了选区"), selection)
                layout(view, 400, 600)
                checkChatPresentation(view)
            }
            awaitSources(instrumentation, web, history.map { it.content })
            onMain(instrumentation) {
                val input = descendants(view).filterIsInstance<EditText>().single()
                view.onPhotoCaptured = { photo -> view.setPhoto(photo) }
                view.openCamera()
                val camera = descendants(view).filterIsInstance<CameraView>().single()
                val photo = Bitmap.createBitmap(600, 400, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.WHITE) }
                // 使用真实公开照片回调模拟 Camera2 的内存交付，不启动取景 Surface。
                camera.onPhoto?.invoke(photo)
                layout(view, 400, 600)
                check(descendants(view).none { it is CameraView })
                check(view.selectionView.visibility == View.VISIBLE && !view.selectionView.displayedImageBounds.isEmpty)
                check((descendants(view).single { it.contentDescription == "历史记录" }.parent as View).visibility == View.VISIBLE &&
                    descendants(view).single { it.contentDescription == "拍照或上传照片" }.visibility == View.VISIBLE) {
                    "新照片没有恢复圈选功能栏和图片入口"
                }
                check(view.selection == null)
                check(input.text.toString() == "拍照前保留的草稿") { "新照片丢失了提问草稿" }
                val photoBounds = view.selectionView.displayedImageBounds
                check(abs(photoBounds.width() / photoBounds.height() - 1.5f) < .005f) { "新照片没有替换旧屏幕截图" }
                gesture(view.selectionView, point(photoBounds, .1f, .15f), point(photoBounds, .5f, .5f), point(photoBounds, .9f, .85f))
                checkBounds(view.selection ?: error("新照片无法圈选"), RectF(.1f, .15f, .9f, .85f))
            }
            awaitSources(instrumentation, web, emptyList())
            onMain(instrumentation) {
                view.beginTurn("导图前问题")
                val input = descendants(view).filterIsInstance<EditText>().single()
                check(input.text.isEmpty()) { "直接发出用户气泡后没有清空已发输入" }
                input.setText("导图期间输入的新草稿")
                view.showResponse("导图前回答")
            }
            awaitSources(instrumentation, web, listOf("导图前问题", "导图前回答"))
            onMain(instrumentation) {
                // 模拟系统选择器返回后的宿主内存交付；不启动选择器或引入测试 Provider。
                view.onPickImageRequested = {
                    view.setPhoto(Bitmap.createBitmap(300, 600, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.WHITE) })
                }
                check(descendants(view).single { it.contentDescription == "拍照或上传照片" }.visibility == View.GONE)
                view.onPickImageRequested?.invoke()
                layout(view, 400, 600)
                val input = descendants(view).filterIsInstance<EditText>().single()
                check(input.text.toString() == "导图期间输入的新草稿") { "导图丢失了发送后新写的草稿" }
                val imported = view.selectionView.displayedImageBounds
                check(view.selectionView.visibility == View.VISIBLE && abs(imported.width() / imported.height() - .5f) < .005f)
                check((descendants(view).single { it.contentDescription == "历史记录" }.parent as View).visibility == View.VISIBLE &&
                    descendants(view).single { it.contentDescription == "拍照或上传照片" }.visibility == View.VISIBLE) {
                    "导入图片没有恢复圈选功能栏和图片入口"
                }
                gesture(view.selectionView, point(imported, .15f, .2f), point(imported, .5f, .5f), point(imported, .9f, .8f))
                checkBounds(view.selection ?: error("导入图片无法圈选"), RectF(.15f, .2f, .9f, .8f))
            }
            awaitSources(instrumentation, web, emptyList())
            val dollar = '$'
            val markdown = """
                # 标题

                **粗体**与`inlineCode`。

                ```kotlin
                val x = 1
                ```

                |列一|列二|
                |---|---|
                |a|b|

                数学：${dollar}x^2${dollar}、\(y+1\)

                ${dollar}${dollar}z=2${dollar}${dollar}

                \[a=b\]

                见[来源](https://example.com/a)，裸地址 http://example.org/b 。[危险](javascript:alert(1))

                ![外部图](https://example.com/blocked.png)

                <img src="https://example.com/blocked2.png" onerror="window.__rabbitUnsafeExecuted=true"><script>window.__rabbitUnsafeExecuted=true</script>
            """.trimIndent()
            onMain(instrumentation) {
                view.beginTurn("富文本问题"); view.setBusy(true)
                view.showResponse(markdown); view.setBusy(false); layout(view, 400, 600)
            }
            awaitSources(instrumentation, web, listOf("富文本问题", markdown))
            val icon = JSONObject.quote("M14 4h6v6m0-6L10 14m0-10H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4")
            awaitJavascript(instrumentation, web, """
                (() => {
                  const b = document.querySelector('.bubble.assistant');
                  const links = Array.from(b.querySelectorAll('a[href]'));
                  return b.querySelector('h1')?.textContent === '标题' &&
                    b.querySelector('strong')?.textContent === '粗体' &&
                    b.querySelector('pre code')?.textContent.includes('val x = 1') &&
                    b.querySelectorAll('code').length >= 2 && !!b.querySelector('table th') &&
                    b.querySelectorAll('.katex').length === 4 && b.querySelectorAll('.katex-display').length === 2 &&
                    links.some(a => a.getAttribute('href') === 'https://example.com/a') &&
                    links.some(a => a.getAttribute('href') === 'http://example.org/b') &&
                    links.every(a => /^https?:\/\//i.test(a.getAttribute('href'))) &&
                    links.every(a => a.matches('.rabbit-source') && a.querySelector('svg path')?.getAttribute('d') === $icon) &&
                    !b.querySelector('img,image,script,iframe') && window.__rabbitUnsafeExecuted !== true &&
                    performance.getEntriesByType('resource').every(r => r.name.startsWith(location.origin + '/conversation/'));
                })()
            """.trimIndent(), "Markdown、四种公式、安全来源图标或外部资源约束未满足")
            responseProgressLifecycle(instrumentation, view, web)
            messageMotionSemantics(instrumentation, view, web)
            shortAndLongConversationScroll(instrumentation, view, web)
        } finally {
            onMain(instrumentation) { view.setScreenshot(null); view.release() }
        }
    }

    private fun responseProgressLifecycle(instrumentation: Instrumentation, view: SearchView, web: ConversationWebView) {
        onMain(instrumentation) {
            view.restoreConversation(emptyList())
            view.beginTurn("进度问题")
            view.setBusy(true)
            // 未挂载视图由宿主生命周期保持暂停；这里驱动真实页面的前后台入口。
            web.setActivityVisible(true)
            view.setSearchCount(2)
        }
        awaitJavascript(instrumentation, web, """
            (() => {
              const nodes = document.querySelectorAll('.bubble-progress');
              const match = nodes[0]?.textContent.match(/^思考 (\d+) 秒 · 2 次搜索$/);
              if (nodes.length !== 1 || !match || Number(match[1]) < 1) return false;
              window.__rabbitQaProgressSeconds = Number(match[1]);
              return true;
            })()
        """.trimIndent(), "思考计时没有推进，或没有显示实际搜索次数")
        onMain(instrumentation) { web.setActivityVisible(false) }
        awaitJavascript(instrumentation, web, "!document.querySelector('.bubble-progress')",
            "离开前台后仍显示思考进度")
        Thread.sleep(1_100)
        onMain(instrumentation) { web.setActivityVisible(true) }
        awaitJavascript(instrumentation, web, """
            (() => {
              const match = document.querySelector('.bubble-progress')?.textContent.match(/^思考 (\d+) 秒 · 2 次搜索$/);
              return !!match && Number(match[1]) >= window.__rabbitQaProgressSeconds + 1;
            })()
        """.trimIndent(), "回到前台后丢失搜索次数或重新开始计时")
        onMain(instrumentation) { view.showResponse("仍在生成的回答") }
        awaitSources(instrumentation, web, listOf("进度问题", "仍在生成的回答"))
        awaitJavascript(instrumentation, web,
            "!!document.querySelector('.bubble-progress') && document.querySelector('.bubble.assistant .bubble-content')?.textContent.trim() === '仍在生成的回答'",
            "首段回答覆盖了进度，或进度替代了回答内容")
        onMain(instrumentation) { view.setBusy(false); view.setSearchCount(99) }
        awaitJavascript(instrumentation, web, "!document.querySelector('.bubble-progress')",
            "回答完成或晚到搜索事件仍保留进度")
        onMain(instrumentation) {
            view.beginTurn("新一轮")
            view.setBusy(true)
            web.setActivityVisible(true)
        }
        awaitJavascript(instrumentation, web,
            "Array.from(document.querySelectorAll('.bubble-progress')).length === 1 && /^思考 \\d+ 秒$/.test(document.querySelector('.bubble-progress').textContent)",
            "新一轮沿用了旧搜索次数")
        onMain(instrumentation) { view.showResponse("请求失败", true); view.setBusy(false) }
        awaitSources(instrumentation, web, listOf("进度问题", "仍在生成的回答", "新一轮", "请求失败"))
        awaitJavascript(instrumentation, web, "!document.querySelector('.bubble-progress')",
            "请求失败后残留思考进度")
        onMain(instrumentation) {
            view.beginTurn("历史切换前的请求")
            view.setBusy(true)
            web.setActivityVisible(true)
            view.setSearchCount(3)
            view.restoreConversation(listOf(ChatTurn("assistant", "恢复的回答")))
        }
        awaitSources(instrumentation, web, listOf("恢复的回答"))
        awaitJavascript(instrumentation, web, "!document.querySelector('.bubble-progress')",
            "恢复历史带入了上一请求的进度")
        onMain(instrumentation) {
            view.beginTurn("重置前的请求")
            view.setBusy(true)
            web.setActivityVisible(true)
            view.setSearchCount(4)
            web.reset()
        }
        awaitJavascript(instrumentation, web, "!document.querySelector('.bubble-progress') && !document.querySelector('.bubble')",
            "重置对话后残留请求气泡或进度")
        onMain(instrumentation) { view.setBusy(false) }
    }

    private fun messageMotionSemantics(instrumentation: Instrumentation, view: SearchView, web: ConversationWebView) {
        onMain(instrumentation) { view.restoreConversation(emptyList()); layout(view, 400, 600) }
        awaitSources(instrumentation, web, emptyList())
        evaluateJavascript(instrumentation, web, """
            (() => {
              const original = Element.prototype.animate;
              window.__rabbitQaAnimations = [];
              Element.prototype.animate = function(...args) {
                const animation = original.apply(this, args);
                window.__rabbitQaAnimations.push(animation);
                return animation;
              };
              return true;
            })()
        """.trimIndent())
        onMain(instrumentation) { view.beginTurn("动画问题"); view.setBusy(true) }
        awaitSources(instrumentation, web, listOf("动画问题", ""))
        awaitJavascript(instrumentation, web, """
            (() => {
              const arrivals = window.__rabbitQaAnimations.filter(a => a.id === 'rabbit-message-arrive').length;
              const expected = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 2;
              window.__rabbitQaEntryCount = arrivals;
              return arrivals === expected;
            })()
        """.trimIndent(), "新一轮没有只为用户与本轮回答创建入场动画")
        onMain(instrumentation) { view.showResponse("首段回复") }
        awaitSources(instrumentation, web, listOf("动画问题", "首段回复"))
        onMain(instrumentation) { view.showResponse("更新后的完整回复"); view.setBusy(false) }
        awaitSources(instrumentation, web, listOf("动画问题", "更新后的完整回复"))
        awaitJavascript(instrumentation, web, """
            window.__rabbitQaAnimations.filter(a => a.id === 'rabbit-message-arrive').length === window.__rabbitQaEntryCount &&
            window.__rabbitQaAnimations.filter(a => a.id === 'rabbit-first-token').length <= 1 &&
            (!matchMedia('(prefers-reduced-motion: reduce)').matches || window.__rabbitQaAnimations.length === 0)
        """.trimIndent(), "流式 token 重播入场/首段动画，或未尊重减少动态效果设置")

        val history = (1..4).flatMap { index -> listOf(ChatTurn("user", "回看问题$index"),
            ChatTurn("assistant", (1..12).joinToString("\n\n") { line -> "第${index}轮第${line}段，用于确认上滚回看时保留阅读位置。" })) }
        onMain(instrumentation) { view.restoreConversation(history); layout(view, 400, 600) }
        awaitSources(instrumentation, web, history.map { it.content })
        awaitJavascript(instrumentation, web,
            "window.__rabbitQaAnimations.filter(a => a.id === 'rabbit-message-arrive').length === window.__rabbitQaEntryCount",
            "恢复历史重播了消息入场动画")
        onMain(instrumentation) { view.beginTurn("长回答问题"); view.setBusy(true) }
        awaitSources(instrumentation, web, history.map { it.content } + listOf("长回答问题", ""))
        awaitJavascript(instrumentation, web, """
            (() => {
              const maximum = document.scrollingElement.scrollHeight - document.scrollingElement.clientHeight;
              if (maximum < 200) return false;
              window.dispatchEvent(new TouchEvent('touchstart'));
              window.dispatchEvent(new PointerEvent('pointercancel', { pointerType:'touch' }));
              window.scrollTo(0, Math.min(100, maximum / 4));
              window.dispatchEvent(new Event('scroll'));
              window.__rabbitQaReadPosition = scrollY;
              return scrollY < maximum - 100;
            })()
        """.trimIndent(), "回看测试没有建立可滚动的实际聊天页面")
        val response = (1..8).joinToString("\n\n") { "继续生成的第${it}段回答。" }
        onMain(instrumentation) { view.showResponse(response) }
        awaitSources(instrumentation, web, history.map { it.content } + listOf("长回答问题", response))
        // 给有限滚动弹簧和异步浏览器事件完成的机会，避免只检查更新瞬间。
        Thread.sleep(700)
        awaitJavascript(instrumentation, web, "Math.abs(scrollY - window.__rabbitQaReadPosition) < 2",
            "手指回看期间，流式回复或 pointercancel 重新把用户拉到了底部")
        evaluateJavascript(instrumentation, web, "window.dispatchEvent(new TouchEvent('touchend', { touches:[] })); true")
        val finished = response + "\n\n手指离开后继续生成的内容。"
        onMain(instrumentation) { view.showResponse(finished); view.setBusy(false) }
        awaitSources(instrumentation, web, history.map { it.content } + listOf("长回答问题", finished))
        Thread.sleep(700)
        awaitJavascript(instrumentation, web, "Math.abs(scrollY - window.__rabbitQaReadPosition) < 2",
            "回看松手后，新内容重新把用户拉到了底部")
    }

    private fun shortAndLongConversationScroll(instrumentation: Instrumentation, view: SearchView, web: ConversationWebView) {
        onMain(instrumentation) {
            view.restoreConversation(listOf(ChatTurn("user", "短问题"), ChatTurn("assistant", "短回答")))
            layout(view, 400, 600)
            web.setActivityVisible(true)
        }
        awaitSources(instrumentation, web, listOf("短问题", "短回答"))
        awaitJavascript(instrumentation, web, """
            (() => {
              const documentBox = document.scrollingElement;
              const messages = document.getElementById('messages');
              const last = messages.lastElementChild?.querySelector('.bubble-surface')?.getBoundingClientRect();
              const gap = parseFloat(getComputedStyle(messages).paddingBottom);
              return documentBox.scrollHeight <= documentBox.clientHeight + 2 && !!last &&
                Math.abs(innerHeight - gap - last.bottom) < 2;
            })()
        """.trimIndent(), "短对话没有贴底，或产生了空白滚动区")
        val previewBitmap = Bitmap.createBitmap(120, 80, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.WHITE) }
        val firstImage = try { HistoryPreview.from(VisualContext(previewBitmap, VisualSource.PHOTO)) }
            finally { previewBitmap.recycle() }
        onMain(instrumentation) { web.setFirstImage(firstImage) }
        awaitJavascript(instrumentation, web, """
            (() => {
              const image = document.querySelector('.bubble.user .bubble-image');
              return document.querySelectorAll('.bubble-image').length === 1 && image?.complete &&
                image.naturalWidth === 120 && image.naturalHeight === 80 &&
                image.closest('.bubble') === document.querySelector('.bubble');
            })()
        """.trimIndent(), "恢复的历史图片未进入第一条用户气泡，或本地 JPEG 无法显示")
        onMain(instrumentation) { view.beginTurn("图片后的追问"); view.showResponse("保留首图") }
        awaitJavascript(instrumentation, web,
            "document.querySelectorAll('.bubble-image').length === 1 && !document.querySelectorAll('.bubble.user')[1].querySelector('img')",
            "追问重复添加了首图")
        val longAnswer = (1..60).joinToString("\n\n") { "第${it}段长回答，确认超出一屏的内容保持实际文档高度并能够继续向下阅读。" } + "\n\n末行可见标记"
        onMain(instrumentation) {
            view.restoreConversation(listOf(ChatTurn("user", "长问题"), ChatTurn("assistant", longAnswer)))
            web.setActivityVisible(true)
        }
        awaitSources(instrumentation, web, listOf("长问题", longAnswer))
        awaitJavascript(instrumentation, web, """
            (() => {
              const documentBox = document.scrollingElement;
              if (documentBox.scrollHeight - documentBox.clientHeight <= innerHeight) return false;
              window.dispatchEvent(new WheelEvent('wheel', { deltaY:-600 }));
              window.scrollTo(0, 0);
              const firstLine = document.querySelector('.bubble:last-child .bubble-content p:first-child')?.getBoundingClientRect();
              return !!firstLine && firstLine.top >= 0 && firstLine.bottom <= innerHeight &&
                document.querySelector('.bubble:last-child .bubble-content p:last-child')?.getBoundingClientRect().top > innerHeight;
            })()
        """.trimIndent(), "长回答没有真实滚动范围，或开头内容无法完整阅读")
        evaluateJavascript(instrumentation, web, """
            (() => {
              const bubble = document.querySelector('.bubble:last-child .bubble-surface').getBoundingClientRect();
              window.scrollTo(0, scrollY + bubble.top + bubble.height / 2 - innerHeight / 2);
              return true;
            })()
        """.trimIndent())
        awaitJavascript(instrumentation, web, """
            (() => {
              const surface = document.querySelector('.bubble:last-child .bubble-surface');
              const box = surface.getBoundingClientRect();
              return box.top < 0 && box.bottom > innerHeight && !surface.style.clipPath &&
                typeof window.RabbitViewport?.setBubbleBounds === 'function';
            })()
        """.trimIndent(), "长气泡没有交给原生视口裁切，或仍保留逐滚动 JS 遮罩")
        val boundsField = ConversationWebView::class.java.getDeclaredField("bubbleBounds").apply { isAccessible = true }
        val widthField = ConversationWebView::class.java.getDeclaredField("documentWidth").apply { isAccessible = true }
        val geometryDeadline = SystemClock.uptimeMillis() + 5_000
        while (true) {
            val ready = onMain(instrumentation) {
                @Suppress("UNCHECKED_CAST")
                val bounds = boundsField.get(web) as List<RectF>
                bounds.size == 2 && bounds.last().height() * web.width / widthField.getFloat(web) > web.height * 2
            }
            if (ready) break
            check(SystemClock.uptimeMillis() < geometryDeadline) { "本地气泡几何未交付给原生视口" }
            Thread.sleep(16)
        }
        onMain(instrumentation) {
            @Suppress("UNCHECKED_CAST")
            val bounds = (boundsField.get(web) as List<RectF>).last()
            val scale = web.width / widthField.getFloat(web)
            val left = (bounds.left * scale - web.scrollX).roundToInt()
            val right = (bounds.right * scale - web.scrollX).roundToInt()
            val savedScroll = web.scrollY
            // 不等待 JS 或新几何回调，原生滚动后立即绘制并核对视口角点。
            for (offset in listOf(0, 37, 121)) {
                web.scrollTo(0, savedScroll + offset)
                val bitmap = Bitmap.createBitmap(web.width, web.height, Bitmap.Config.ARGB_8888)
                try {
                    val canvas = Canvas(bitmap)
                    canvas.translate(-web.scrollX.toFloat(), -web.scrollY.toFloat())
                    web.draw(canvas)
                    val sampleX = (left + 30 * scale).roundToInt().coerceIn(0, web.width - 1)
                    for (y in listOf(1, web.height - 2)) {
                        check(Color.alpha(bitmap.getPixel((left + 1).coerceIn(0, web.width - 1), y)) < 16 &&
                            Color.alpha(bitmap.getPixel((right - 2).coerceIn(0, web.width - 1), y)) < 16) {
                            "原生滚动后气泡角点没有保持透明：offset=$offset，y=$y"
                        }
                        check(Color.alpha(bitmap.getPixel(sampleX, y)) > 128) {
                            "原生裁切坐标偏移，视口边缘的气泡内容消失：offset=$offset，y=$y"
                        }
                    }
                } finally { bitmap.recycle() }
            }
            web.scrollTo(0, savedScroll)
        }
        evaluateJavascript(instrumentation, web, "window.scrollTo(0, document.scrollingElement.scrollHeight); true")
        awaitJavascript(instrumentation, web, """
            (() => {
              const documentBox = document.scrollingElement;
              const surface = document.querySelector('.bubble:last-child .bubble-surface');
              const lastLine = surface?.querySelector('.bubble-content p:last-child');
              if (!lastLine || lastLine.textContent.trim() !== '末行可见标记') return false;
              const bubbleBox = surface.getBoundingClientRect(), lineBox = lastLine.getBoundingClientRect();
              const style = getComputedStyle(surface);
              return Math.abs(documentBox.scrollHeight - documentBox.clientHeight - scrollY) < 2 &&
                lineBox.top >= 0 && lineBox.bottom <= innerHeight && bubbleBox.bottom <= innerHeight &&
                parseFloat(style.borderBottomLeftRadius) > 0 && parseFloat(style.borderBottomRightRadius) > 0;
            })()
        """.trimIndent(), "长回答无法滚到末行，或气泡底部圆角仍被视口裁断")
    }

    private fun awaitSources(instrumentation: Instrumentation, web: ConversationWebView, expected: List<String>) {
        val json = JSONArray().apply { expected.forEach { put(it) } }.toString()
        try {
            // 比较实际字符串，避免 Android JSON 与 JavaScript 对斜杠等字符的不同转义造成误报。
            awaitJavascript(instrumentation, web, """
                (() => {
                  const expected = $json;
                  const actual = Array.from(document.querySelectorAll('.bubble')).map(b => b.dataset.source);
                  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
                })()
            """.trimIndent(), "气泡内容未完整保留或本轮更新覆盖了历史")
        } catch (failure: IllegalStateException) {
            val diagnostic = evaluateJavascript(instrumentation, web,
                "Array.from(document.querySelectorAll('.bubble')).map(b => ({role:b.dataset.role,length:b.dataset.source.length}))")
            throw IllegalStateException("气泡检查失败；期望长度=${expected.map { it.length }}，实际角色与长度=$diagnostic", failure)
        }
    }

    private fun awaitJavascript(instrumentation: Instrumentation, web: ConversationWebView, expression: String, failure: String) {
        val deadline = SystemClock.uptimeMillis() + 12_000
        while (true) {
            if (evaluateJavascript(instrumentation, web, expression) == "true") return
            check(SystemClock.uptimeMillis() < deadline) { failure }
            Thread.sleep(50)
        }
    }

    private fun evaluateJavascript(instrumentation: Instrumentation, web: ConversationWebView, expression: String): String {
        val result = AtomicReference<String>()
        val returned = CountDownLatch(1)
        onMain(instrumentation) { web.evaluateJavascript(expression) { result.set(it); returned.countDown() } }
        check(returned.await(3, TimeUnit.SECONDS)) { "WebView JavaScript 回调超时" }
        return result.get()
    }

    private fun withMainSearch(instrumentation: Instrumentation, action: (SearchView) -> Unit) = onMain(instrumentation) {
        val view = SearchView(instrumentation.targetContext)
        try { action(view) } finally { view.release() }
    }

    private fun keyboardPreservesScreenshotViewport(instrumentation: Instrumentation) = withMainSearch(instrumentation) { view ->
        val density = view.resources.displayMetrics.density
        val statusBar = (24 * density).roundToInt()
        val navigationBar = (24 * density).roundToInt()
        val keyboard = (240 * density).roundToInt()
        fun insets(ime: Int): WindowInsets = WindowInsets.Builder()
            .setInsets(WindowInsets.Type.statusBars(), Insets.of(0, statusBar, 0, 0))
            .setInsets(WindowInsets.Type.navigationBars(), Insets.of(0, 0, 0, navigationBar))
            .setInsets(WindowInsets.Type.ime(), Insets.of(0, 0, 0, ime))
            .setVisible(WindowInsets.Type.statusBars() or WindowInsets.Type.navigationBars(), true)
            .setVisible(WindowInsets.Type.ime(), ime > 0).build()
        view.dispatchApplyWindowInsets(insets(0))
        val screenshot = Bitmap.createBitmap(400, 600, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.WHITE) }
        view.setScreenshot(screenshot)
        layout(view, 400, 600)
        val before = view.selectionView.displayedImageBounds
        check(!before.isEmpty)
        view.dispatchApplyWindowInsets(insets(keyboard))
        layout(view, 400, 600)
        val after = view.selectionView.displayedImageBounds
        check(abs(before.width() - after.width()) < 1f && abs(before.height() - after.height()) < 1f) {
            "键盘弹出缩小了截图视口"
        }
        check(abs(view.selectionView.translationY + keyboard - navigationBar) < 1f) { "截图没有随键盘负向平移" }
        val mascot = descendants(view).filterIsInstance<RabbitView>().single()
        fun checkMascot(chat: Boolean) {
            val historyButton = descendants(view).single { it.contentDescription == "历史记录" }
            val tools = historyButton.parent as View
            val toolsBounds = Rect(0, 0, tools.width, tools.height)
            view.offsetDescendantRectToMyCoords(tools, toolsBounds)
            if (chat) checkChatPresentation(view, statusBar)
            else check(tools.visibility == View.VISIBLE && mascot.visibility == View.VISIBLE &&
                mascot.left >= 0 && mascot.right <= view.width && mascot.top >= statusBar &&
                mascot.bottom <= toolsBounds.top && mascot.bottom <= view.height - keyboard) {
                "键盘弹出后兔球越出活动区或遮挡圈选快捷操作"
            }
        }
        checkMascot(false)
        view.beginTurn("键盘布局问题")
        layout(view, 400, 600)
        checkMascot(true)
        layout(view, 400, 1000)
        checkChatPresentation(view, statusBar, requirePet = true)
        view.setScreenshot(null)
    }

    private fun checkChatPresentation(view: SearchView, topInset: Int = 0, requirePet: Boolean = false) {
        val historyButton = descendants(view).single { it.contentDescription == "历史记录" }
        val tools = historyButton.parent as View
        check(tools.visibility == View.GONE &&
            descendants(view).single { it.contentDescription == "拍照或上传照片" }.visibility == View.GONE) {
            "对话开始或恢复后仍显示圈选功能栏或图片入口"
        }
        val web = descendants(view).filterIsInstance<ConversationWebView>().single()
        val mascot = descendants(view).filterIsInstance<RabbitView>().single()
        val input = descendants(view).filterIsInstance<EditText>().single { it.contentDescription == "输入问题" }
        val sheet = (input.parent as View).parent as View
        val sheetBounds = Rect(0, 0, sheet.width, sheet.height)
        view.offsetDescendantRectToMyCoords(sheet, sheetBounds)
        check(web.visibility == View.VISIBLE && web.height > 0 && web.top >= topInset && web.bottom <= sheetBounds.top) {
            "聊天视口没有延伸至输入栏上方，或覆盖输入区域"
        }
        val density = view.resources.displayMetrics.density
        val petTop = topInset + (8f * density).roundToInt()
        val gap = (12f * density).roundToInt()
        val minimumMessages = (48f * density).roundToInt()
        val petFits = web.bottom - petTop - mascot.measuredHeight - gap >= minimumMessages
        if (requirePet) check(petFits) { "大视口未能为兔球和消息保留足够空间" }
        if (petFits) {
            check(mascot.visibility == View.VISIBLE && mascot.left >= 0 && mascot.right <= view.width &&
                mascot.top >= topInset && mascot.bottom <= web.top) {
                "聊天兔球没有位于顶部安全带，或遮挡消息"
            }
            check(mascot.left < mascot.width) { "开始对话后兔球没有移到左上角" }
        } else check(mascot.visibility != View.VISIBLE) { "空间不足时兔球仍遮挡消息区" }
    }

    private fun selectionMaskAndGestures(instrumentation: Instrumentation) {
        val screenshot = Bitmap.createBitmap(400, 600, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.WHITE) }
        lateinit var view: SelectionView
        lateinit var image: RectF
        lateinit var original: RectF
        onMain(instrumentation) {
            view = SelectionView(instrumentation.targetContext)
            layout(view, 400, 600)
            view.setScreenshot(screenshot)
            image = view.displayedImageBounds
            check(!image.isEmpty)
            gesture(view, point(image, .2f, .2f), point(image, .5f, .5f), point(image, .8f, .75f))
            original = RectF(view.selection ?: error("划选没有生成选区"))
            checkBounds(original, RectF(.2f, .2f, .8f, .75f))
        }
        waitForSelectionToSettle(instrumentation)
        onMain(instrumentation) {
            val rendered = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
            try {
                rendered.eraseColor(Color.WHITE)
                view.draw(Canvas(rendered))
                val region = RectF(image.left + original.left * image.width(), image.top + original.top * image.height(),
                    image.left + original.right * image.width(), image.top + original.bottom * image.height())
                val inset = view.resources.displayMetrics.density
                val corners = listOf(region.left + inset to region.top + inset, region.right - inset to region.top + inset,
                    region.right - inset to region.bottom - inset, region.left + inset to region.bottom - inset)
                corners.forEach { (x, y) ->
                    check(brightness(rendered.getPixel(x.roundToInt(), y.roundToInt())) < 245) {
                        "矩形角点未被遮罩，圆角轮廓与镂空不一致"
                    }
                }
                check(brightness(rendered.getPixel(region.centerX().roundToInt(), region.centerY().roundToInt())) > 250) {
                    "选区中心被遮罩"
                }
                checkBounds(view.selection ?: error("绘制后选区丢失"), original)
            } finally { rendered.recycle() }

            cornerResizeConstraints(view, image, original)

            gesture(view, point(image, original.centerX(), original.centerY()),
                point(image, original.centerX() + .08f, original.centerY() + .05f))
            val moved = view.selection ?: error("内部拖动后选区丢失")
            check(abs(moved.width() - original.width()) < .003f && abs(moved.height() - original.height()) < .003f) {
                "内部拖动改变了选区大小"
            }
            check(abs(moved.left - original.left - .08f) < .003f && abs(moved.top - original.top - .05f) < .003f) {
                "内部拖动没有移动选区"
            }
            gesture(view, point(image, .04f, .05f), point(image, .12f, .12f), point(image, .18f, .16f))
            checkBounds(view.selection ?: error("选区外划选没有生成新区域"), RectF(.04f, .05f, .18f, .16f))
        }
        waitForSelectionToSettle(instrumentation)
        onMain(instrumentation) { view.setScreenshot(null); screenshot.recycle() }
    }

    private data class CornerCase(
        val name: String,
        val start: Pair<Float, Float>,
        val outside: Pair<Float, Float>,
        val edge: Pair<Float, Float>,
        val crossing: Pair<Float, Float>,
        val expanded: RectF,
        val minimum: RectF
    )

    private fun cornerResizeConstraints(view: SelectionView, image: RectF, original: RectF) {
        val minimumWidth = 20f * view.resources.displayMetrics.density / image.width()
        val minimumHeight = 20f * view.resources.displayMetrics.density / image.height()
        val cases = listOf(
            CornerCase("左上", .2f to .2f, -.2f to -.2f, 0f to 0f, 1.2f to 1.2f,
                RectF(0f, 0f, .8f, .75f), RectF(.8f - minimumWidth, .75f - minimumHeight, .8f, .75f)),
            CornerCase("右上", .8f to .2f, 1.2f to -.2f, 1f to 0f, -.2f to 1.2f,
                RectF(.2f, 0f, 1f, .75f), RectF(.2f, .75f - minimumHeight, .2f + minimumWidth, .75f)),
            CornerCase("右下", .8f to .75f, 1.2f to 1.2f, 1f to 1f, -.2f to -.2f,
                RectF(.2f, .2f, 1f, 1f), RectF(.2f, .2f, .2f + minimumWidth, .2f + minimumHeight)),
            CornerCase("左下", .2f to .75f, -.2f to 1.2f, 0f to 1f, 1.2f to -.2f,
                RectF(0f, .2f, .8f, 1f), RectF(.8f - minimumWidth, .2f, .8f, .2f + minimumHeight))
        )
        for (case in cases) {
            view.clearSelection()
            gesture(view, point(image, original.left, original.top), point(image, original.centerX(), original.centerY()),
                point(image, original.right, original.bottom))
            gesture(view, point(image, case.start.first, case.start.second), point(image, case.outside.first, case.outside.second))
            val expanded = view.selection ?: error("${case.name}角拖动后选区丢失")
            // 越过截图边缘仍固定对角，移动角停在整图边界。
            checkBounds(expanded, case.expanded)
            gesture(view, point(image, case.edge.first, case.edge.second), point(image, case.crossing.first, case.crossing.second))
            val minimum = view.selection ?: error("${case.name}角越过对角后选区丢失")
            check(minimum.left >= 0f && minimum.top >= 0f && minimum.right <= 1f && minimum.bottom <= 1f &&
                minimum.left < minimum.right && minimum.top < minimum.bottom) { "${case.name}角拖动后选区翻转或越界" }
            // 跨过对角只收至20dp最小尺寸，不交换角点或移动固定对角。
            checkBounds(minimum, case.minimum)
        }
        view.clearSelection()
        gesture(view, point(image, original.left, original.top), point(image, original.centerX(), original.centerY()),
            point(image, original.right, original.bottom))
        checkBounds(view.selection ?: error("恢复选区失败"), original)
    }

    private fun waitForSelectionToSettle(instrumentation: Instrumentation) {
        val scale = Settings.Global.getFloat(instrumentation.targetContext.contentResolver,
            Settings.Global.ANIMATOR_DURATION_SCALE, 1f).coerceAtLeast(1f)
        // 等待实际收拢动画结束，不阻塞负责动画的主线程。
        Thread.sleep((650f * scale).toLong())
        instrumentation.waitForIdleSync()
    }

    private fun layout(view: View, widthDp: Int, heightDp: Int) {
        val density = view.resources.displayMetrics.density
        val width = (widthDp * density).roundToInt()
        val height = (heightDp * density).roundToInt()
        view.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(height, View.MeasureSpec.EXACTLY))
        view.layout(0, 0, width, height)
    }

    private fun descendants(view: View): List<View> = buildList {
        add(view)
        if (view is ViewGroup) for (index in 0 until view.childCount) addAll(descendants(view.getChildAt(index)))
    }

    private fun point(image: RectF, x: Float, y: Float): Pair<Float, Float> =
        image.left + image.width() * x to image.top + image.height() * y

    private fun gesture(view: View, vararg points: Pair<Float, Float>) {
        val downTime = SystemClock.uptimeMillis()
        points.forEachIndexed { index, (x, y) ->
            val action = when(index) { 0 -> MotionEvent.ACTION_DOWN; points.lastIndex -> MotionEvent.ACTION_UP; else -> MotionEvent.ACTION_MOVE }
            val event = MotionEvent.obtain(downTime, downTime + index * 16L, action, x, y, 0)
            try { check(view.dispatchTouchEvent(event)) { "视图未接受划选手势" } } finally { event.recycle() }
        }
    }

    private fun checkBounds(actual: RectF, expected: RectF) {
        check(abs(actual.left - expected.left) < .003f && abs(actual.top - expected.top) < .003f &&
            abs(actual.right - expected.right) < .003f && abs(actual.bottom - expected.bottom) < .003f) {
            "选区没有按完整截图归一化：期望 $expected，实际 $actual"
        }
    }

    private fun brightness(color: Int): Int = (Color.red(color) + Color.green(color) + Color.blue(color)) / 3

    private fun <T> onMain(instrumentation: Instrumentation, action: () -> T): T {
        val result = AtomicReference<T>()
        val error = AtomicReference<Throwable>()
        instrumentation.runOnMainSync {
            try { result.set(action()) } catch (failure: Throwable) { error.set(failure) }
        }
        error.get()?.let { throw it }
        return result.get()
    }
}
