package com.rabbitball.app.ui

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Path
import android.graphics.RectF
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import com.rabbitball.app.ChatTurn
import com.rabbitball.app.HistoryPreview
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream

/** 单个本地页面复用 PC 的 Markdown、LaTeX 和来源图标，原生界面仍负责输入及布局。 */
@SuppressLint("SetJavaScriptEnabled")
class ConversationWebView(context: Context) : WebView(context) {
    var onOpenSource: ((Uri) -> Unit)? = null
    companion object {
        private const val ORIGIN = "https://rabbitball.invalid"
        private const val ENTRY = "$ORIGIN/conversation/index.html"
    }

    private var pageReady = false
    private var disposed = false
    private val pending = ArrayDeque<String>()
    private val mainHandler = Handler(Looper.getMainLooper())
    private var documentWidth = 0f
    private var bubbleBounds = emptyList<RectF>()
    private val visibleBubbles = Path()
    private val clippedBounds = RectF()

    init {
        setBackgroundColor(Color.TRANSPARENT)
        isHorizontalScrollBarEnabled = false
        isVerticalScrollBarEnabled = false
        overScrollMode = OVER_SCROLL_NEVER
        contentDescription = "对话记录"
        settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = false
            allowFileAccess = false
            allowContentAccess = false
            blockNetworkLoads = true
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setSupportMultipleWindows(false)
            javaScriptCanOpenWindowsAutomatically = false
            builtInZoomControls = false
            displayZoomControls = false
            textZoom = (resources.configuration.fontScale * 100f).toInt()
        }
        // 页面与脚本均来自受限本地源；桥接只接收绘制几何，不暴露宿主操作。
        addJavascriptInterface(ViewportBridge(), "RabbitViewport")
        webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse {
                val uri = request.url
                val path = uri.path.orEmpty().removePrefix("/")
                if (uri.scheme != "https" || uri.host != "rabbitball.invalid" ||
                    !path.startsWith("conversation/") || path.split('/').any { it == ".." }) return denied()
                val mime = when (path.substringAfterLast('.')) {
                    "html" -> "text/html"
                    "js" -> "text/javascript"
                    "css" -> "text/css"
                    "woff2" -> "font/woff2"
                    else -> return denied()
                }
                return try {
                    WebResourceResponse(mime, if (mime.startsWith("text/")) "UTF-8" else null,
                        context.assets.open(path)).apply {
                        responseHeaders = mapOf("Cache-Control" to "no-store", "X-Content-Type-Options" to "nosniff")
                    }
                } catch (_: java.io.IOException) { denied() }
            }

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                openSource(request.url)
                return true
            }

            override fun onPageFinished(view: WebView, url: String) {
                if (url != ENTRY || disposed) return
                pageReady = true
                while (pending.isNotEmpty()) evaluateJavascript(pending.removeFirst(), null)
            }
        }
        loadUrl(ENTRY)
    }

    private inner class ViewportBridge {
        @JavascriptInterface
        fun setBubbleBounds(value: String) {
            if (value.length > 262_144) return
            val geometry = try {
                val payload = JSONObject(value)
                val width = payload.getDouble("width").toFloat()
                val items = payload.getJSONArray("bounds")
                if (!width.isFinite() || width <= 0f || items.length() > 2048) return
                val bounds = List(items.length()) { index ->
                    val rect = items.getJSONArray(index)
                    if (rect.length() != 4) return
                    val edges = FloatArray(4) { rect.getDouble(it).toFloat() }
                    if (edges.any { !it.isFinite() }) return
                    RectF(edges[0], edges[1], edges[2], edges[3])
                }
                width to bounds
            } catch (_: org.json.JSONException) { return }
            mainHandler.post {
                if (!disposed) {
                    documentWidth = geometry.first
                    bubbleBounds = geometry.second
                    invalidate()
                }
            }
        }
    }

    override fun onDraw(canvas: Canvas) {
        if (documentWidth <= 0f || bubbleBounds.isEmpty()) {
            super.onDraw(canvas)
            return
        }
        val scale = width / documentWidth
        val left = scrollX.toFloat()
        val top = scrollY.toFloat()
        val right = left + width
        val bottom = top + height
        val radius = 24f * scale
        visibleBubbles.rewind()
        for (bounds in bubbleBounds) {
            clippedBounds.set(bounds.left * scale, bounds.top * scale, bounds.right * scale, bounds.bottom * scale)
            if (clippedBounds.intersect(left, top, right, bottom)) {
                visibleBubbles.addRoundRect(clippedBounds, radius, radius, Path.Direction.CW)
            }
        }
        // Canvas 使用文档坐标，原生 scrollY 与 WebView 内容在本次 draw 共用同一滚动位置。
        val checkpoint = canvas.save()
        canvas.clipPath(visibleBubbles)
        super.onDraw(canvas)
        canvas.restoreToCount(checkpoint)
    }

    override fun onScrollChanged(left: Int, top: Int, oldLeft: Int, oldTop: Int) {
        super.onScrollChanged(left, top, oldLeft, oldTop)
        invalidate()
    }

    private fun denied() = WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden",
        emptyMap(), ByteArrayInputStream(ByteArray(0)))

    private fun openSource(uri: Uri) {
        if (uri.scheme?.lowercase() !in listOf("http", "https") || uri.host.isNullOrBlank() ||
            uri.host == "rabbitball.invalid") return
        onOpenSource?.let { it(uri); return }
        try {
            context.startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (_: android.content.ActivityNotFoundException) { }
    }

    private fun call(method: String, vararg arguments: String) {
        if (disposed) return
        val script = "window.RabbitConversation.$method(${arguments.joinToString(",")});"
        if (pageReady) evaluateJavascript(script, null) else pending.addLast(script)
    }

    fun reset() {
        bubbleBounds = emptyList()
        call("reset")
    }
    fun beginTurn(userText: String) = call("beginTurn", JSONObject.quote(userText))
    fun showResponse(value: String, error: Boolean = false) = call("showResponse", JSONObject.quote(value), error.toString())
    fun setBusy(value: Boolean) = call("setBusy", value.toString())
    fun setSearchCount(count: Int) = call("setSearchCount", count.toString())
    fun setActivityVisible(value: Boolean) = call("setActivityVisible", value.toString())
    fun setFirstImage(preview: HistoryPreview?) = call("setFirstImage", preview?.let { JSONObject.quote(it.jpegBase64) } ?: "null")
    fun restoreConversation(turns: List<ChatTurn>) {
        val messages = JSONArray()
        turns.forEach { messages.put(JSONObject().put("role", it.role).put("content", it.content)) }
        call("restore", messages.toString())
    }

    /** 从设置暂时离开只解绑视图；仅在所属会话被丢弃时释放页面。 */
    fun release() {
        if (disposed) return
        disposed = true
        onOpenSource = null
        mainHandler.removeCallbacksAndMessages(null)
        bubbleBounds = emptyList()
        removeJavascriptInterface("RabbitViewport")
        pending.clear()
        stopLoading()
        removeAllViews()
        destroy()
    }
}
