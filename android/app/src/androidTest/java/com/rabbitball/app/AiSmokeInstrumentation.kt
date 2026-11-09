package com.rabbitball.app

import android.app.Activity
import android.app.Instrumentation
import android.content.ContextWrapper
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.RectF
import android.os.Bundle
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.File
import java.net.InetAddress
import java.net.ServerSocket
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/** 只连接本机模拟接口，验证 PC 同款发送契约，不使用真实 API Key。 */
class AiSmokeInstrumentation : Instrumentation() {
    override fun onCreate(arguments: Bundle?) { super.onCreate(arguments); start() }

    override fun onStart() {
        val results = Bundle()
        try {
            wholeScreenshotAndStream()
            deepSeekSearchAndConversation()
            errorsAndCancellation()
            encryptedSettingsAndTextHistory()
            promptOverridesAndSession()
            UiContractChecks.run(this)
            results.putString("stream", "5 组检查通过：完整截图与选框、PC同款DeepSeek搜索与多轮推理、错误与取消、加密外观/提示词/历史设置、四页草稿/聊天/安全链接/IME/选区/相机方向与切摄/选图/发送动效。\n")
            finish(Activity.RESULT_OK, results)
        } catch (error: Throwable) {
            results.putString("stream", "检查失败：${error.stackTraceToString()}\n")
            finish(Activity.RESULT_CANCELED, results)
        }
    }

    private fun wholeScreenshotAndStream() {
        MockServer(listOf(Reply(answer("你好，兔球")))).use { server ->
            val screenshot = Bitmap.createBitmap(120, 80, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.WHITE) }
            val output = runRequest(server, bitmap = screenshot, selection = RectF(.2f, .2f, .8f, .8f),
                previous = listOf(ChatTurn("user", "上一个问题"), ChatTurn("assistant", "上一个回答")))
            check(output.error == null && output.text == "你好，兔球") { output.error.orEmpty() }
            check(output.deltas.last() == "你好，兔球" && !output.deltas.any { it.contains("null") })
            val request = server.requests.first()
            check(request.path == "/chat/completions")
            check(request.body.getString("model") == "deepseek-flash")
            check(request.body.getString("reasoning_effort") == "high")
            check(request.body.getJSONObject("thinking").getString("type") == "enabled")
            val messages = request.body.getJSONArray("messages")
            check(messages.length() == 4 && messages.getJSONObject(1).getString("content") == "上一个问题")
            val parts = messages.getJSONObject(3).getJSONArray("content")
            val image = (0 until parts.length()).map { parts.getJSONObject(it) }.first { it.getString("type") == "image_url" }
            check(parts.toString().contains("120×80"))
            check(image.getJSONObject("image_url").getString("detail") == "high")
            val encoded = image.getJSONObject("image_url").getString("url").substringAfter(',')
            val bytes = Base64.decode(encoded, Base64.DEFAULT)
            val sent = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
            check(sent.width == 120 && sent.height == 80) { "请求裁剪了截图" }
            check(sent.getPixel(24, 40) != Color.WHITE) { "请求没有标记选框" }
            check(sent.getPixel(60, 40) == Color.WHITE && screenshot.getPixel(24, 40) == Color.WHITE)
            sent.recycle(); screenshot.recycle()
        }
        MockServer(listOf(Reply(answer("提取结果")))).use { server ->
            check(runRequest(server, action = "extract").error == null)
            check(!server.requests.first().body.has("tools")) { "提取操作启用了联网工具" }
        }
    }

    private fun deepSeekSearchAndConversation() {
        val searchOne = JSONObject().put("results", JSONArray().put(JSONObject().put("title", "来源一")
            .put("url", "https://example.com/one").put("content", "结果一"))).toString()
        val searchTwo = JSONObject().put("results", JSONArray().put(JSONObject().put("title", "来源二")
            .put("url", "https://example.com/two").put("content", "结果二"))).toString()
        val replies = listOf(Reply(tool("call-1", "查询一", "规划")), Reply(searchOne, contentType = "application/json"),
            Reply(tool("call-2", "查询二", "补充推理")), Reply(searchTwo, contentType = "application/json"),
            Reply(answer("查到了")), Reply(answer("继续回答")))
        MockServer(replies).use { server ->
            val client = AiClient()
            val bitmap = Bitmap.createBitmap(12, 8, Bitmap.Config.ARGB_8888)
            val visual = VisualContext(bitmap, VisualSource.CAMERA)
            val first = runRequest(server, action = "search", client = client, visual = visual)
            check(first.error == null && first.text!!.contains("查到了") && first.text.contains("https://example.com/one")
                && first.text.contains("https://example.com/two")) { first.error.orEmpty() }
            val initial = server.requests[0].body
            check(userText(initial).contains("相机拍摄的照片") && !userText(initial).contains("屏幕截图")) {
                "相机照片被描述成了屏幕截图"
            }
            check(imageCount(initial) == 1)
            check(initial.getJSONObject("thinking").getString("type") == "disabled" && !initial.has("reasoning_effort"))
            check(initial.getInt("max_tokens") == 8192)
            check(initial.getJSONObject("tool_choice").getJSONObject("function").getString("name") == "search_web")
            check(server.requests[1].path == "/v1/tools/search")
            check(server.requests[1].body.getString("query") == "查询一" && server.requests[1].body.getInt("count") == 5
                && server.requests[1].body.getBoolean("need_content"))
            val continuation = server.requests[2].body
            check(continuation.getString("reasoning_effort") == "high" && continuation.getInt("max_tokens") == 131072)
            val secondMessages = continuation.getJSONArray("messages")
            check(secondMessages.getJSONObject(2).getString("reasoning_content") == "规划")
            check(secondMessages.getJSONObject(3).getString("tool_call_id") == "call-1")
            val finalMessages = server.requests[4].body.getJSONArray("messages")
            check(finalMessages.getJSONObject(4).getString("reasoning_content") == "补充推理")
            check(finalMessages.getJSONObject(5).getString("tool_call_id") == "call-2")
            val second = runRequest(server, previous = listOf(ChatTurn("user", "测试问题"), ChatTurn("assistant", first.text!!)),
                client = client, visual = visual)
            check(second.error == null && second.text == "继续回答")
            val preserved = server.requests[5].body.getJSONArray("messages")
            check(preserved.length() == 8 && preserved.getJSONObject(2).getJSONArray("tool_calls").getJSONObject(0).getString("id") == "call-1") {
                "后续提问丢失了工具消息前缀"
            }
            check(imageCount(server.requests[5].body) == 1) { "同一会话后续提问重复追加了原图" }
            client.cancel()
            bitmap.recycle()
        }
    }

    private fun errorsAndCancellation() {
        MockServer(listOf(Reply("data: {\"choices\":[{\"delta\":{\"content\":\"不完整\"}}]}\n\n"))).use { server ->
            check(runRequest(server).error?.contains("提前结束") == true)
        }
        MockServer(listOf(Reply("data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"length\"}]}\n\ndata: [DONE]\n\n"))).use { server ->
            check(runRequest(server).error?.contains("长度限制") == true)
        }
        MockServer(listOf(Reply("secret-key-must-not-appear", 401))).use { server ->
            val output = runRequest(server)
            check(output.error?.contains("HTTP 401") == true && output.error.contains("secret-key").not())
        }
        val cancelledClient = AiClient()
        val cancelledBitmap = Bitmap.createBitmap(12, 8, Bitmap.Config.ARGB_8888)
        val cancelledVisual = VisualContext(cancelledBitmap, VisualSource.SCREEN)
        MockServer(listOf(Reply(answer("已取消的回复"))), stall = true).use { server ->
            val callback = CountDownLatch(1)
            cancelledClient.request(ModelConfig(endpoint = server.endpoint, apiKey = "mock-key"), "测试问题", "ask", cancelledVisual, null,
                emptyList(), { callback.countDown() }, { callback.countDown() }, { callback.countDown() })
            check(server.received.await(5, TimeUnit.SECONDS))
            check(imageCount(server.requests.first().body) == 1)
            cancelledClient.cancel(); server.release.countDown()
            check(!callback.await(250, TimeUnit.MILLISECONDS)) { "取消后仍执行了回调" }
        }
        MockServer(listOf(Reply(answer("取消后重试")))).use { server ->
            val retry = runRequest(server, client = cancelledClient, visual = cancelledVisual)
            check(retry.error == null && imageCount(server.requests.first().body) == 1) { "首次取消后的重试丢失了原图" }
        }
        cancelledClient.cancel(); cancelledBitmap.recycle()

        MockServer(listOf(Reply("failed", 401), Reply(answer("失败后重试")))).use { server ->
            val client = AiClient()
            val bitmap = Bitmap.createBitmap(12, 8, Bitmap.Config.ARGB_8888)
            val visual = VisualContext(bitmap, VisualSource.PHOTO)
            try {
                check(runRequest(server, client = client, visual = visual).error != null)
                check(userText(server.requests.first().body).contains("用户选择的图片") &&
                    !userText(server.requests.first().body).contains("屏幕截图")) { "图库图片被描述成了屏幕截图" }
                check(runRequest(server, client = client, visual = visual).error == null)
                check(server.requests.all { imageCount(it.body) == 1 }) { "首次失败后的重试丢失了原图" }
            } finally { client.cancel(); bitmap.recycle() }
        }
    }

    private fun encryptedSettingsAndTextHistory() {
        check(ModelConfig().endpoint == "https://api.deepseek.com" && ModelConfig().model == "deepseek-flash"
            && ModelConfig().reasoning == "medium" && ModelConfig().maxToolRounds == 3)
        val settings = AppSettings(targetContext)
        val original = settings.load()
        try {
            val overrides = mapOf(PromptKey.SYSTEM to "测试用系统提示词", PromptKey.SEARCH to PromptCatalog.defaults.getValue(PromptKey.SEARCH))
            val test = AppConfig(
                ModelConfig("https://example.com/v1", "deepseek-flash", "mock-secret", "high", 2, overrides),
                AppearanceConfig(.85f, 0xFF6699CC.toInt(), 0xFF224466.toInt()), 3)
            settings.save(test)
            check(settings.load() == test.copy(model = test.model.copy(prompts = mapOf(PromptKey.SYSTEM to "测试用系统提示词"))))
            check(settings.loadAppearance() == test.appearance && settings.historyLimit == 3) { "外观或历史设置未持久化" }
            check(!targetContext.getSharedPreferences("rabbit_settings", 0).all.toString().contains("mock-secret")) { "Key 被明文保存" }
            check(JSONObject(targetContext.getSharedPreferences("rabbit_settings", 0).getString("prompts_json", "{}")!!)
                .keys().asSequence().toSet() == setOf(PromptKey.SYSTEM.wireKey)) { "默认提示词没有从覆盖集中移除" }
            settings.save(test.copy(model = test.model.copy(prompts = PromptCatalog.defaults)))
            check(settings.load().model.prompts.isEmpty()) { "全部恢复默认后仍保留提示词覆盖" }
            check(PromptCatalog.normalize(mapOf(PromptKey.SYSTEM to "字".repeat(20_000))).size == 1)
            val invalidPrompts = listOf(mapOf(PromptKey.SYSTEM to "  "), mapOf(PromptKey.SYSTEM to "字".repeat(20_001)),
                PromptKey.entries.associateWith { "字".repeat(15_000) })
            invalidPrompts.forEach { values ->
                check(runCatching { AppSettings.validate(test.copy(model = test.model.copy(prompts = values))) }.isFailure) {
                    "无效提示词或总长度没有被拒绝"
                }
            }
            check(runCatching { AppSettings.validate(test.copy(appearance = test.appearance.copy(petSize = Float.NaN))) }.isFailure)
            check(runCatching { AppSettings.validate(test.copy(historyLimit = 0)) }.isFailure)

            val files = File(targetContext.cacheDir, "history-limit-${System.nanoTime()}").apply { mkdirs() }
            try {
                val history = ChatHistory(object : ContextWrapper(targetContext) { override fun getFilesDir(): File = files })
                repeat(4) { index -> history.save("limit-$index", "第${index}条", listOf(ChatTurn("user", "问题$index"))) }
                check(history.list().size == 3 && history.list().none { it.id == "limit-0" }) { "历史数量没有遵守设置" }
                settings.save(test.copy(historyLimit = 1))
                history.trim()
                settings.save(test.copy(historyLimit = 3))
                check(history.list().size == 1) { "缩小保留条数后旧历史只被隐藏，没有实际删除" }
            } finally {
                listOf("chat_history.json", "chat_history.json.bak", "chat_history.json.new").forEach { File(files, it).delete() }
                files.delete()
            }
        } finally { settings.save(original) }
        val testFiles = File(targetContext.cacheDir, "ai-history-test").apply { mkdirs() }
        val history = ChatHistory(object : ContextWrapper(targetContext) { override fun getFilesDir(): File = testFiles })
        val chat = history.save("test-chat", "文字历史", listOf(ChatTurn("user", "问题"), ChatTurn("assistant", "回答")))
        check(history.list().first().id == chat.id && history.list().first().turns.last().content == "回答")
        val json = File(testFiles, "chat_history.json").readText()
        check(!json.contains("image") && !json.contains("bitmap") && !json.contains("base64"))
    }

    private fun promptOverridesAndSession() {
        val prompts = mapOf(
            PromptKey.SYSTEM to "旧系统契约", PromptKey.SEARCH to "旧搜索契约", PromptKey.SEARCH_TOOL to "旧工具契约",
            PromptKey.EXTRACT to "自定义提取契约", PromptKey.TRANSLATE to "自定义翻译契约", PromptKey.FALLBACK to "自定义附件契约")
        val changed = prompts + mapOf(PromptKey.SYSTEM to "新系统契约", PromptKey.SEARCH to "新搜索契约", PromptKey.SEARCH_TOOL to "新工具契约")
        val replies = listOf("第一答", "第二答", "新对话").flatMapIndexed { index, text -> listOf(
            Reply(tool("prompt-$index", "提示词查询$index", "提示词规划")),
            Reply("{\"results\":[]}", contentType = "application/json"), Reply(answer(text))) }
        MockServer(replies).use { server ->
            val client = AiClient()
            try {
                val first = runRequest(server, action = "search", client = client, text = "第一问", config = ModelConfig(prompts = prompts))
                check(first.error == null && first.text == "第一答")
                val second = runRequest(server, action = "search", client = client, text = "第二问", config = ModelConfig(prompts = changed),
                    previous = listOf(ChatTurn("user", "第一问"), ChatTurn("assistant", "第一答")))
                check(second.error == null)
                for (request in listOf(server.requests[0], server.requests[3])) {
                    check(request.body.getJSONArray("messages").getJSONObject(0).getString("content") == "旧系统契约")
                    check(lastUserText(request.body).contains("旧搜索契约") && !lastUserText(request.body).contains("新搜索契约")) {
                        "追问混入了新设置的动作提示词"
                    }
                    check(request.body.getJSONArray("tools").getJSONObject(0).getJSONObject("function").getString("description") == "旧工具契约")
                }
                client.resetConversation()
                check(runRequest(server, action = "search", client = client, config = ModelConfig(prompts = changed)).error == null)
                val fresh = server.requests.last().body
                check(fresh.getJSONArray("messages").getJSONObject(0).getString("content") == "新系统契约" &&
                    lastUserText(fresh).contains("新搜索契约") &&
                    fresh.getJSONArray("tools").getJSONObject(0).getJSONObject("function").getString("description") == "新工具契约") {
                    "新对话没有应用保存后的提示词"
                }
            } finally { client.cancel() }
        }
        MockServer(List(3) { Reply(answer("动作结果")) }).use { server ->
            check(runRequest(server, action = "extract", config = ModelConfig(prompts = prompts)).error == null)
            check(lastUserText(server.requests[0].body).contains("自定义提取契约") && !server.requests[0].body.has("tools"))
            check(runRequest(server, action = "translate", config = ModelConfig(prompts = prompts)).error == null)
            check(lastUserText(server.requests[1].body).contains("自定义翻译契约") && !server.requests[1].body.has("tools"))
            val bitmap = Bitmap.createBitmap(4, 4, Bitmap.Config.ARGB_8888)
            try {
                check(runRequest(server, bitmap = bitmap, text = "", config = ModelConfig(prompts = prompts)).error == null)
                check(lastUserText(server.requests[2].body).contains("自定义附件契约"))
            } finally { bitmap.recycle() }
        }
    }

    private data class Output(val text: String?, val error: String?, val deltas: List<String>)
    private fun runRequest(server: MockServer, action: String = "ask", bitmap: Bitmap? = null,
        selection: RectF? = null, previous: List<ChatTurn> = emptyList(), client: AiClient = AiClient(),
        visual: VisualContext? = bitmap?.let { VisualContext(it, VisualSource.SCREEN) },
        config: ModelConfig = ModelConfig(), text: String = "测试问题"): Output {
        val done = CountDownLatch(1)
        val response = AtomicReference<String?>()
        val failure = AtomicReference<String?>()
        val deltas = mutableListOf<String>()
        client.request(config.copy(endpoint = server.endpoint, apiKey = "mock-key"), text, action, visual, selection,
            previous, { deltas.add(it) }, { response.set(it); done.countDown() }, { failure.set(it); done.countDown() })
        check(done.await(8, TimeUnit.SECONDS)) { "模型回调超时" }
        return Output(response.get(), failure.get(), deltas.toList())
    }

    private fun imageCount(body: JSONObject): Int {
        val messages = body.getJSONArray("messages")
        var count = 0
        for (index in 0 until messages.length()) {
            val parts = messages.getJSONObject(index).optJSONArray("content") ?: continue
            for (part in 0 until parts.length()) if (parts.optJSONObject(part)?.optString("type") == "image_url") count++
        }
        return count
    }

    private fun userText(body: JSONObject): String = buildString {
        val messages = body.getJSONArray("messages")
        for (index in 0 until messages.length()) {
            val message = messages.getJSONObject(index)
            if (message.optString("role") != "user") continue
            val parts = message.optJSONArray("content") ?: continue
            for (part in 0 until parts.length()) {
                val item = parts.optJSONObject(part) ?: continue
                if (item.optString("type") == "text") append(item.optString("text"))
            }
        }
    }

    private fun lastUserText(body: JSONObject): String {
        val messages = body.getJSONArray("messages")
        val message = (messages.length() - 1 downTo 0).map { messages.getJSONObject(it) }.first { it.optString("role") == "user" }
        val parts = message.getJSONArray("content")
        return (0 until parts.length()).map { parts.getJSONObject(it) }.filter { it.optString("type") == "text" }
            .joinToString("\n") { it.getString("text") }
    }

    private fun answer(text: String): String = "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":null}}]}\n\n" +
        "data: " + JSONObject().put("choices", JSONArray().put(JSONObject().put("delta", JSONObject().put("content", text))
            .put("finish_reason", "stop"))) + "\n\ndata: [DONE]\n\n"

    private fun tool(id: String, query: String, reasoning: String): String {
        fun event(delta: JSONObject, finish: String? = null): String = "data: " + JSONObject().put("choices", JSONArray()
            .put(JSONObject().put("delta", delta).put("finish_reason", finish ?: JSONObject.NULL))) + "\n\n"
        val opening = JSONObject().put("index", 0).put("id", id).put("function",
            JSONObject().put("name", "search_web").put("arguments", "{\"query\":"))
        val closing = JSONObject().put("index", 0).put("function",
            JSONObject().put("arguments", JSONObject.quote(query) + "}"))
        return event(JSONObject().put("content", JSONObject.NULL).put("reasoning_content", reasoning)) +
            event(JSONObject().put("tool_calls", JSONArray().put(opening))) +
            event(JSONObject().put("tool_calls", JSONArray().put(closing)), "tool_calls") + "data: [DONE]\n\n"
    }

    private data class Reply(val text: String, val status: Int = 200, val contentType: String = "text/event-stream")
    private data class Received(val path: String, val body: JSONObject)
    private class MockServer(private val replies: List<Reply>, private val stall: Boolean = false) : AutoCloseable {
        private val server = ServerSocket(0, 8, InetAddress.getByName("127.0.0.1"))
        val requests = CopyOnWriteArrayList<Received>()
        val received = CountDownLatch(1)
        val release = CountDownLatch(1)
        val endpoint = "http://127.0.0.1:${server.localPort}/v1"

        init {
            Thread({
                runCatching {
                    replies.forEach { reply ->
                        server.accept().use { socket ->
                            socket.soTimeout = 5000
                            val stream = BufferedInputStream(socket.getInputStream())
                            fun line(): String {
                                val bytes = mutableListOf<Byte>()
                                while (true) {
                                    val value = stream.read()
                                    if (value == -1 || value == 10) break
                                    if (value != 13) bytes.add(value.toByte())
                                }
                                return String(bytes.toByteArray(), Charsets.US_ASCII)
                            }
                            val path = line().split(' ')[1]
                            var length = 0
                            while (true) {
                                val header = line()
                                if (header.isEmpty()) break
                                if (header.startsWith("Content-Length:", true)) length = header.substringAfter(':').trim().toInt()
                            }
                            val bytes = ByteArray(length)
                            var offset = 0
                            while (offset < length) { val count = stream.read(bytes, offset, length - offset); check(count > 0); offset += count }
                            requests.add(Received(path, JSONObject(String(bytes, Charsets.UTF_8))))
                            received.countDown()
                            if (stall) release.await(5, TimeUnit.SECONDS)
                            val data = reply.text.toByteArray(Charsets.UTF_8)
                            val header = "HTTP/1.1 ${reply.status} Test\r\nContent-Type: ${reply.contentType}; charset=utf-8\r\nContent-Length: ${data.size}\r\nConnection: close\r\n\r\n"
                            socket.getOutputStream().apply { write(header.toByteArray()); write(data); flush() }
                        }
                    }
                }
            }, "rabbitball-mock-api").start()
        }
        override fun close() { release.countDown(); server.close() }
    }
}
