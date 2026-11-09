package com.rabbitball.app

import android.app.Instrumentation
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Insets
import android.graphics.Rect
import android.graphics.RectF
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import android.widget.ImageView
import com.rabbitball.app.ui.SearchView
import java.util.concurrent.atomic.AtomicReference

/** 驱动真实输入连接，验证删字与移除图片的边界。 */
object AttachmentContractChecks {
    fun run(instrumentation: Instrumentation) {
        val failure = AtomicReference<Throwable?>()
        instrumentation.runOnMainSync {
            val view = SearchView(instrumentation.targetContext)
            val bitmap = Bitmap.createBitmap(120, 80, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.WHITE) }
            try {
                view.setScreenshot(bitmap)
                view.setAttachmentPreview(bitmap)
                layout(view)
                val screen = RectF(view.selectionView.displayedImageBounds)
                val input = descendants(view).filterIsInstance<EditText>().single { it.contentDescription == "输入问题" }
                val preview = descendants(view).filterIsInstance<ImageView>().single { it.contentDescription == "待发送图片" }
                val remove = descendants(view).single { it.contentDescription == "移除待发送图片" }
                val send = descendants(view).single { it.contentDescription == "发送问题" }
                var removed = 0
                view.onRemoveAttachment = { removed++ }
                val connection = requireNotNull(input.onCreateInputConnection(EditorInfo()))

                input.setText("字")
                input.setSelection(input.length())
                check(connection.deleteSurroundingText(1, 0))
                check(input.text.isEmpty() && removed == 0 && preview.drawable != null) { "删除最后一个文字时误删了图片" }
                check(connection.deleteSurroundingText(1, 0))
                check(removed == 1 && preview.drawable == null) { "软键盘空输入退格没有移除图片" }
                layout(view)
                check(!screen.isEmpty && screen == view.selectionView.displayedImageBounds) { "移除图片同时清除了原截图或改变其布局" }

                view.setAttachmentPreview(bitmap)
                check(connection.deleteSurroundingTextInCodePoints(1, 0))
                check(removed == 2 && preview.drawable == null) { "按码点删除的输入法没有移除图片" }

                view.setAttachmentPreview(bitmap)
                input.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_DEL))
                input.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_DEL))
                check(removed == 3 && preview.drawable == null) { "实体退格没有移除图片或触发了两次删除" }

                view.setAttachmentPreview(bitmap)
                input.setText("保留的问题")
                check(remove.performClick())
                check(removed == 4 && preview.drawable == null && input.text.toString() == "保留的问题") { "移除按钮改动了输入草稿" }

                view.setAttachmentPreview(bitmap)
                input.text.clear()
                var submitted = false
                view.onSend = { text, action ->
                    check(text.isEmpty() && action == "ask")
                    submitted = true
                    view.beginTurn("解释选中内容")
                }
                check(send.performClick() && submitted) { "仅图片消息无法发送" }
                check(preview.drawable == null && (preview.parent as View).visibility == View.GONE && removed == 4) {
                    "发送后附件未清除，或把发送误报为移除图片"
                }

                view.setAttachmentPreview(bitmap)
                view.restoreConversation(listOf(ChatTurn("user", "历史问题"), ChatTurn("assistant", "历史回答")))
                check(preview.drawable == null && removed == 4) { "恢复历史保留了旧待发图片" }
                checkComposerLayout(view, bitmap)
            } catch (error: Throwable) {
                failure.set(error)
            } finally {
                view.release()
                bitmap.recycle()
            }
        }
        failure.get()?.let { throw it }
    }

    private fun checkComposerLayout(view: SearchView, bitmap: Bitmap) {
        view.setScreenshot(bitmap)
        view.setAttachmentPreview(bitmap)
        val input = descendants(view).filterIsInstance<EditText>().single { it.contentDescription == "输入问题" }
        val sheet = input.parent.parent as View
        val camera = descendants(view).single { it.contentDescription == "拍照或上传照片" }
        val send = descendants(view).single { it.contentDescription == "发送问题" }
        val search = descendants(view).single { it.contentDescription == "搜索" }
        val history = descendants(view).single { it.contentDescription == "历史记录" }
        val preview = descendants(view).single { it.contentDescription == "待发送图片" }
        fun px(value: Int) = (value * view.resources.displayMetrics.density).toInt()
        fun bounds(child: View) = Rect().also { child.getDrawingRect(it); view.offsetDescendantRectToMyCoords(child, it) }
        fun insets(keyboard: Int = 0) {
            view.dispatchApplyWindowInsets(WindowInsets.Builder()
                .setInsets(WindowInsets.Type.statusBars(), Insets.of(0, px(24), 0, 0))
                .setInsets(WindowInsets.Type.navigationBars(), Insets.of(0, 0, 0, px(24)))
                .setInsets(WindowInsets.Type.ime(), Insets.of(0, 0, 0, px(keyboard)))
                .setVisible(WindowInsets.Type.ime(), keyboard > 0).build())
        }
        fun checkButtons() {
            val photoBounds = bounds(camera)
            val sendBounds = bounds(send)
            check(kotlin.math.abs(bounds(search).exactCenterX() - photoBounds.exactCenterX()) <= 1f &&
                kotlin.math.abs(bounds(history).exactCenterX() - sendBounds.exactCenterX()) <= 1f) { "上下两排按钮的中心线不一致" }
            check(kotlin.math.abs(photoBounds.exactCenterY() - sendBounds.exactCenterY()) <= 1f &&
                kotlin.math.abs(bounds(preview).exactCenterY() - sendBounds.exactCenterY()) <= 1f) { "输入两端按钮与图片未沿底部对齐" }
            val sheetBounds = bounds(sheet)
            check(sheetBounds.contains(photoBounds) && sheetBounds.contains(sendBounds) && sheetBounds.contains(bounds(input))) {
                "长输入挤出了拍照、发送或文本区域"
            }
            check(bounds(search).top >= px(24)) { "工具栏进入状态栏安全区" }
        }

        insets()
        input.setText("短问题")
        layout(view)
        val shortHeight = sheet.height
        check(shortHeight in px(52)..px(60)) { "单行输入不再紧凑" }
        checkButtons()
        input.setText((1..5).joinToString("\n") { "第${it}行问题" })
        layout(view)
        val mediumHeight = sheet.height
        check(mediumHeight > shortHeight && input.height > input.lineHeight * 3) { "多行输入没有随文字增长" }
        checkButtons()

        // 通过真实输入连接提交大段文本，覆盖输入法粘贴路径。
        val connection = requireNotNull(input.onCreateInputConnection(EditorInfo()))
        input.setText("")
        check(connection.commitText((1..200).joinToString("\n") { "第${it}行：这是用于检查长输入的完整问题。" }, 1))
        layout(view)
        val tallHeight = sheet.height
        check(tallHeight > mediumHeight && tallHeight <= (sheet.width * .75f).toInt() + 1) { "超长输入未在宽度四分之三附近封顶" }
        input.scrollTo(0, 0)
        check(input.canScrollVertically(1)) { "输入达到最大高度后不能内部滚动" }
        checkButtons()

        insets(keyboard = 270)
        layout(view)
        check(sheet.height < tallHeight && bounds(sheet).bottom <= view.height - px(270)) { "键盘弹出后未收紧长输入或遮住输入框" }
        checkButtons()
        insets(keyboard = 180)
        layout(view, 800, 360)
        check(bounds(sheet).top >= px(24) && bounds(sheet).bottom <= view.height - px(180)) { "横屏键盘下输入框超出安全区域" }
        checkButtons()

        insets()
        input.setText("短问题")
        layout(view)
        check(sheet.height == shortHeight) { "删掉长文本后输入框没有收回单行高度" }
        checkButtons()
    }

    private fun layout(view: View, widthDp: Int = 400, heightDp: Int = 600) {
        val density = view.resources.displayMetrics.density
        val width = (widthDp * density).toInt()
        val height = (heightDp * density).toInt()
        view.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(height, View.MeasureSpec.EXACTLY))
        view.layout(0, 0, width, height)
    }

    private fun descendants(view: View): List<View> = listOf(view) +
        if (view is ViewGroup) (0 until view.childCount).flatMap { descendants(view.getChildAt(it)) } else emptyList()
}
