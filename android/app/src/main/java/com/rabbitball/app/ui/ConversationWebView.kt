package com.rabbitball.app.ui

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import com.rabbitball.app.ChatTurn
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream

/** 单个本地页面复用 PC 的 Markdown、LaTeX 和来源图标，原生界面仍负责输入及布局。 */
@SuppressLint("SetJavaScriptEnabled")
class ConversationWebView(context: Context) : WebView(context) {
    companion object {
        private const val ORIGIN = "https://rabbitball.invalid"
        private const val ENTRY = "$ORIGIN/conversation/index.html"
    }

    private var pageReady = false
    private var disposed = false
    private val pending = ArrayDeque<String>()

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

    private fun denied() = WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden",
        emptyMap(), ByteArrayInputStream(ByteArray(0)))

    private fun openSource(uri: Uri) {
        if (uri.scheme?.lowercase() !in listOf("http", "https") || uri.host.isNullOrBlank() ||
            uri.host == "rabbitball.invalid") return
        try {
            context.startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (_: android.content.ActivityNotFoundException) { }
    }

    private fun call(method: String, vararg arguments: String) {
        if (disposed) return
        val script = "window.RabbitConversation.$method(${arguments.joinToString(",")});"
        if (pageReady) evaluateJavascript(script, null) else pending.addLast(script)
    }

    fun reset() = call("reset")
    fun beginTurn(userText: String) = call("beginTurn", JSONObject.quote(userText))
    fun showResponse(value: String, error: Boolean = false) = call("showResponse", JSONObject.quote(value), error.toString())
    fun setBusy(value: Boolean) = call("setBusy", value.toString())
    fun restoreConversation(turns: List<ChatTurn>) {
        val messages = JSONArray()
        turns.forEach { messages.put(JSONObject().put("role", it.role).put("content", it.content)) }
        call("restore", messages.toString())
    }

    /** 从设置暂时离开只解绑视图；仅在所属会话被丢弃时释放页面。 */
    fun release() {
        if (disposed) return
        disposed = true
        pending.clear()
        stopLoading()
        removeAllViews()
        destroy()
    }
}
