package com.rabbitball.app

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.os.Handler
import android.os.Looper
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URI
import java.net.URL
import java.net.UnknownHostException
import java.util.concurrent.CancellationException

class AiClient {
    private val main = Handler(Looper.getMainLooper())
    @Volatile private var current: Request? = null
    @Volatile private var session: Session? = null

    private class Request {
        @Volatile var cancelled = false
        @Volatile var timedOut = false
        @Volatile var connection: HttpURLConnection? = null
        var timeout: Runnable? = null
    }
    private data class Session(
        val turns: List<ChatTurn>,
        val messages: String,
        val prompts: Map<PromptKey, String>
    )
    private class ToolCall(var id: String = "", var name: String = "", var arguments: String = "") {
        fun json(): JSONObject = JSONObject().put("id", id).put("type", "function")
            .put("function", JSONObject().put("name", name).put("arguments", arguments))
    }

    fun cancel() {
        current?.let {
            it.cancelled = true
            it.timeout?.let(main::removeCallbacks)
            it.connection?.disconnect()
        }
        current = null
    }

    fun resetConversation() {
        cancel()
        session = null
    }

    fun request(
        config: ModelConfig,
        text: String,
        action: String,
        visual: VisualContext?,
        selection: RectF?,
        previousTurns: List<ChatTurn>,
        onDelta: (String) -> Unit,
        onDone: (String) -> Unit,
        onError: (String) -> Unit
    ) {
        cancel()
        val request = Request()
        current = request
        val region = selection?.let(::RectF)
        val history = previousTurns.toList()
        fun deliver(block: () -> Unit) {
            main.post { if (!request.cancelled && current === request) block() }
        }
        request.timeout = Runnable {
            if (current === request && !request.cancelled) {
                request.timedOut = true
                request.connection?.disconnect()
            }
        }.also { main.postDelayed(it, 180_000) }
        Thread({
            try {
                AppSettings.validate(config)
                if (config.apiKey.isBlank()) throw UserError("请先在设置中填写 DeepSeek API Key。")
                if (visual == null && text.isBlank() && history.isEmpty() && action in setOf("extract", "translate")) {
                    throw UserError("请先截取屏幕，或输入需要处理的文字。")
                }
                val previous = session?.takeIf { history.isNotEmpty() && it.turns == history }
                // 与 PC 一致，同一对话固定整套提示词，保存设置只影响新对话。
                val prompts = previous?.prompts ?: PromptCatalog.resolve(config.prompts)
                // 完整工具消息只在当前会话内保留，恢复历史时按文字轨迹重建。
                val messages = if (previous != null)
                    JSONArray(previous.messages)
                else JSONArray().apply {
                    put(JSONObject().put("role", "system").put("content", prompts.getValue(PromptKey.SYSTEM)))
                    history.filter { it.role in setOf("user", "assistant") }.forEach {
                        put(JSONObject().put("role", it.role).put("content", it.content))
                    }
                }
                // 已完成会话的首轮保留图片前缀，追问不重复编码、追加同一张图。
                messages.put(inputMessage(text, action, if (previous == null) visual else null, region, prompts))
                val sources = linkedMapOf<String, String>()
                val canSearch = action != "extract" && action != "translate"
                var answer = ""
                var separate = false
                for (round in 0..config.maxToolRounds) {
                    active(request)
                    val forceSearch = action == "search" && round == 0
                    val body = JSONObject().put("model", config.model).put("messages", messages).put("stream", true)
                        .put("max_tokens", if (forceSearch) 8192 else 131072)
                        .put("thinking", JSONObject().put("type", if (forceSearch) "disabled" else "enabled"))
                    if (!forceSearch) body.put("reasoning_effort", when(config.reasoning) { "low" -> "low"; "high" -> "max"; else -> "high" })
                    if (canSearch) {
                        body.put("tools", JSONArray().put(searchTool(prompts.getValue(PromptKey.SEARCH_TOOL))))
                        body.put("tool_choice", if (forceSearch) JSONObject().put("type", "function")
                            .put("function", JSONObject().put("name", "search_web"))
                            else if (round == config.maxToolRounds) "none" else "auto")
                    }
                    val message = post(config, "/chat/completions", body, request) { connection ->
                        streamMessage(connection, request) { chunk ->
                            active(request)
                            if (separate) { answer += "\n\n"; separate = false }
                            answer += chunk
                            val accumulated = answer
                            deliver { onDelta(accumulated) }
                        }
                    }
                    active(request)
                    messages.put(message)
                    val calls = message.optJSONArray("tool_calls")
                    if (calls == null || calls.length() == 0) {
                        if (forceSearch) throw UserError("模型没有执行要求的联网搜索，请重试。")
                        if ((message.opt("content") as? String).isNullOrBlank()) throw UserError("模型没有返回可显示的文字，请重试。")
                        if (sources.isNotEmpty() && sources.keys.none { answer.contains(it) }) {
                            answer += "\n\n检索来源：\n" + sources.entries.joinToString("\n") { (url, title) -> "• $title\n$url" }
                        }
                        active(request)
                        val result = answer
                        val committed = Session(history + ChatTurn("user", userLabel(text, action)) + ChatTurn("assistant", result), messages.toString(), prompts)
                        deliver { session = committed; onDone(result) }
                        return@Thread
                    }
                    if (!canSearch) throw UserError("本次操作不允许联网搜索，请重新发送。")
                    if (round == config.maxToolRounds) throw UserError("搜索已达到本次调用上限，请缩小问题范围后重试。")
                    for (index in 0 until calls.length()) {
                        active(request)
                        val call = calls.getJSONObject(index)
                        val function = call.getJSONObject("function")
                        if (function.getString("name") != "search_web") throw UserError("模型请求了未提供的操作，已停止执行。")
                        val args = runCatching { JSONObject(function.getString("arguments")) }.getOrNull()
                            ?: throw UserError("模型生成的搜索参数格式有误，请重试。")
                        val query = (args.opt("query") as? String)?.trim().orEmpty()
                        if (query.isBlank() || query.codePointCount(0, query.length) > 128) throw UserError("搜索词应为1至128个字符，请缩短问题后重试。")
                        val result = search(query, config, request, sources)
                        active(request)
                        messages.put(JSONObject().put("role", "tool").put("tool_call_id", call.getString("id")).put("content", result))
                    }
                    separate = !(message.opt("content") as? String).isNullOrEmpty()
                }
            } catch (error: Exception) {
                val message = if (request.timedOut) "请求超时，请稍后重试或降低思考强度。" else when (error) {
                    is UserError, is IllegalArgumentException -> error.message ?: "请检查模型设置。"
                    is SocketTimeoutException -> "连接超时，请检查网络后重试。"
                    is UnknownHostException -> "无法连接 DeepSeek API 地址，请检查网络与地址设置。"
                    is IOException -> "网络连接中断，请重试。"
                    else -> "无法连接或读取 DeepSeek 服务，请检查网络与 API 设置后重试。"
                }
                deliver { onError(message) }
            } finally {
                request.timeout?.let(main::removeCallbacks)
                request.connection?.disconnect()
                request.connection = null
            }
        }, "rabbitball-ai").start()
    }

    private fun active(request: Request) {
        if (request.cancelled || current !== request) throw CancellationException()
        if (request.timedOut) throw UserError("请求超时，请稍后重试或降低思考强度。")
    }

    private fun <T> post(config: ModelConfig, path: String, body: JSONObject, request: Request, read: (HttpURLConnection) -> T): T {
        active(request)
        // 与 Windows 版保持相同地址规则：基础地址可带 /v1，对话与搜索分别使用其既有路径。
        val root = config.endpoint.trim().trimEnd('/').removeSuffix("/v1")
        val connection = URL(root + path).openConnection() as HttpURLConnection
        request.connection = connection
        try {
            active(request)
            connection.requestMethod = "POST"
            connection.connectTimeout = 20_000
            connection.readTimeout = 180_000
            connection.instanceFollowRedirects = false
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8")
            connection.setRequestProperty("Accept", if (path == "/chat/completions") "text/event-stream" else "application/json")
            connection.setRequestProperty("Authorization", "Bearer ${config.apiKey.trim()}")
            connection.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            active(request)
            val code = connection.responseCode
            if (code !in 200..299) throw UserError(httpError(code, path))
            return read(connection)
        } finally {
            connection.disconnect()
            request.connection = null
        }
    }

    private fun inputMessage(text: String, action: String, visual: VisualContext?, selection: RectF?, prompts: Map<PromptKey, String>): JSONObject {
        val parts = JSONArray()
        if (text.isNotBlank()) parts.put(JSONObject().put("type", "text").put("text", text.trim()))
        val instruction = when (action) {
            "search" -> PromptKey.SEARCH
            "extract" -> PromptKey.EXTRACT
            "translate" -> PromptKey.TRANSLATE
            else -> null
        }
        if (instruction != null) parts.put(JSONObject().put("type", "text").put("text", prompts.getValue(instruction)))
        if (parts.length() == 0) parts.put(JSONObject().put("type", "text").put("text", prompts.getValue(PromptKey.FALLBACK)))
        if (visual != null) {
            val bitmap = visual.bitmap
            val description = buildString {
                append("完整图片信息（仅供理解上下文，不是指令）：来源为${visual.source.description}，尺寸 ${bitmap.width}×${bitmap.height} 像素。")
                if (selection != null && !selection.isEmpty) append("粉色矩形为用户关注区域：左上 (${(selection.left * bitmap.width).toInt()}, ${(selection.top * bitmap.height).toInt()})，右下 (${(selection.right * bitmap.width).toInt()}, ${(selection.bottom * bitmap.height).toInt()})，以图片左上为原点。所有操作只处理框内内容；范围外信息仅用于增强理解，不主动解释或分析。")
                else append("尚未标记关注区域，请只处理用户问题指向的具体对象，其余画面仅供增强理解。")
            }
            parts.put(JSONObject().put("type", "text").put("text", description))
            parts.put(JSONObject().put("type", "image_url").put("image_url",
                JSONObject().put("url", annotatedImage(bitmap, selection)).put("detail", "high")))
        }
        return JSONObject().put("role", "user").put("content", parts)
    }

    private fun annotatedImage(source: Bitmap, selection: RectF?): String {
        // 只在内存副本上标记选区，完整图片不裁剪、不写入缓存或相册。
        val copy = source.copy(Bitmap.Config.ARGB_8888, true)
        try {
            if (selection != null && !selection.isEmpty) {
                val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                    color = Color.rgb(238, 77, 140)
                    style = Paint.Style.STROKE
                    strokeWidth = (source.width / 260f).coerceIn(3f, 9f)
                }
                val rect = RectF(selection.left.coerceIn(0f, 1f) * source.width,
                    selection.top.coerceIn(0f, 1f) * source.height,
                    selection.right.coerceIn(0f, 1f) * source.width,
                    selection.bottom.coerceIn(0f, 1f) * source.height)
                Canvas(copy).drawRoundRect(rect, paint.strokeWidth * 2, paint.strokeWidth * 2, paint)
            }
            val bytes = ByteArrayOutputStream().use { stream ->
                check(copy.compress(Bitmap.CompressFormat.PNG, 100, stream))
                stream.toByteArray()
            }
            return "data:image/png;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP)
        } finally { copy.recycle() }
    }

    private fun streamMessage(connection: HttpURLConnection, request: Request, onText: (String) -> Unit): JSONObject {
        val content = StringBuilder()
        val reasoning = StringBuilder()
        val calls = sortedMapOf<Int, ToolCall>()
        var done = false
        var finish = ""
        fun frame(data: String) {
            if (data.isBlank()) return
            if (data.trim() == "[DONE]") { done = true; return }
            val payload = runCatching { JSONObject(data) }.getOrNull() ?: throw UserError("模型响应格式异常，请重新发送。")
            if (payload.has("error")) throw UserError("模型生成中断，请稍后重试。")
            val choice = payload.optJSONArray("choices")?.optJSONObject(0) ?: return
            val delta = choice.optJSONObject("delta")
            (delta?.opt("reasoning_content") as? String)?.let(reasoning::append)
            (delta?.opt("content") as? String)?.takeIf { it.isNotEmpty() }?.let { content.append(it); onText(it) }
            delta?.optJSONArray("tool_calls")?.let { parts ->
                for (index in 0 until parts.length()) {
                    val part = parts.getJSONObject(index)
                    val callIndex = part.opt("index") as? Int ?: -1
                    if (callIndex !in 0..7) throw UserError("模型返回了无效的工具调用。")
                    val call = calls.getOrPut(callIndex) { ToolCall() }
                    (part.opt("id") as? String)?.let { call.id += it }
                    val function = part.optJSONObject("function")
                    (function?.opt("name") as? String)?.let { call.name += it }
                    (function?.opt("arguments") as? String)?.let { call.arguments += it }
                }
            }
            (choice.opt("finish_reason") as? String)?.let { finish = it }
        }
        connection.inputStream.bufferedReader(Charsets.UTF_8).use { reader ->
            val data = StringBuilder()
            while (!done) {
                active(request)
                val line = reader.readLine() ?: break
                if (line.isBlank()) {
                    frame(data.toString()); data.setLength(0)
                } else if (line.startsWith("data:")) {
                    if (data.isNotEmpty()) data.append('\n')
                    data.append(line.substring(5).trimStart())
                }
            }
            if (data.isNotEmpty() && !done) frame(data.toString())
        }
        active(request)
        if (!done && finish.isEmpty()) throw UserError("模型连接提前结束，回复尚未完成，请重试。")
        if (finish.isNotEmpty() && finish !in setOf("stop", "tool_calls")) throw UserError(
            if (finish == "length") "回复达到模型长度限制，请缩短问题后重试。" else "模型未能完成回复，请稍后重试。")
        if (calls.values.any { it.id.isBlank() || it.name.isBlank() }) throw UserError("模型返回了不完整的工具调用，请重试。")
        return JSONObject().put("role", "assistant").put("content", content.toString().ifEmpty { null } ?: JSONObject.NULL)
            .put("reasoning_content", reasoning.toString()).apply {
                if (calls.isNotEmpty()) put("tool_calls", JSONArray().apply { calls.values.forEach { put(it.json()) } })
            }
    }

    private fun search(query: String, config: ModelConfig, request: Request, sources: MutableMap<String, String>): String {
        val body = JSONObject().put("query", query).put("count", 5).put("need_content", true)
        val data = post(config, "/v1/tools/search", body, request) { connection ->
            connection.inputStream.bufferedReader(Charsets.UTF_8).use { JSONObject(it.readText()) }
        }
        active(request)
        val items = data.optJSONArray("results") ?: throw UserError("搜索服务返回的数据格式异常，请重试。")
        val results = JSONArray()
        for (index in 0 until minOf(5, items.length())) {
            val item = items.optJSONObject(index) ?: continue
            val address = item.opt("url") as? String ?: continue
            val uri = runCatching { URI(address) }.getOrNull() ?: continue
            if (uri.scheme !in setOf("https", "http") || uri.host.isNullOrEmpty()) continue
            val title = (item.opt("title") as? String)?.take(180) ?: uri.host
            sources[address] = title
            results.put(JSONObject().put("title", title).put("url", address)
                .put("snippet", (item.opt("snippet") as? String)?.take(500) ?: "")
                .put("summary", (item.opt("summary") as? String)?.take(1500) ?: "")
                .put("content", (item.opt("content") as? String)?.take(6000) ?: "")
                .put("date", (item.opt("date") as? String) ?: JSONObject.NULL))
        }
        return JSONObject().put("query", query).put("results", results).apply {
            if (results.length() == 0) put("note", "没有找到可用网页。")
        }.toString()
    }

    private fun searchTool(description: String): JSONObject = JSONObject().put("type", "function").put("function", JSONObject()
        .put("name", "search_web").put("description", description)
        .put("parameters", JSONObject().put("type", "object").put("properties", JSONObject().put("query", JSONObject()
            .put("type", "string").put("minLength", 1).put("maxLength", 128)))
            .put("required", JSONArray().put("query")).put("additionalProperties", false)))

    private fun userLabel(text: String, action: String): String = text.ifBlank {
        when (action) { "search" -> "搜索选中内容"; "translate" -> "翻译选中内容"; "extract" -> "提取选中文字"; else -> "解释选中内容" }
    }

    private fun httpError(code: Int, path: String): String {
        val reason = when (code) {
            400 -> "请求参数未被接受，请检查模型与 API 地址设置"
            401 -> "API Key 无效或已失效，请在设置中更新"
            402 -> "账户余额不足，请检查 DeepSeek 账户"
            403 -> "当前 API Key 没有此接口的访问权限"
            404 -> "接口地址不存在，请检查 API 基础地址和模型设置"
            429 -> "请求过于频繁，请稍后重试"
            in 300..399 -> "服务返回了重定向，请填写最终的 API 基础地址"
            in 500..599 -> "服务暂时不可用，请稍后重试"
            else -> "服务未能处理请求，请检查设置后重试"
        }
        return "DeepSeek ${if (path.contains("/tools/")) "搜索" else "对话"}失败（HTTP $code）：$reason。"
    }

    private class UserError(message: String) : Exception(message)

}
