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
            UiContractChecks.run(this)
            results.putString("stream", "5 组检查通过：完整截图与选框、PC同款DeepSeek搜索与多轮推理、错误与取消、加密设置与文字历史、草稿/聊天/安全链接/IME/选区/相机方向与切摄/选图/发送动效。\n")
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
            val first = runRequest(server, action = "search", client = client)
            check(first.error == null && first.text!!.contains("查到了") && first.text.contains("https://example.com/one")
                && first.text.contains("https://example.com/two")) { first.error.orEmpty() }
            val initial = server.requests[0].body
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
            val second = runRequest(server, previous = listOf(ChatTurn("user", "测试问题"), ChatTurn("assistant", first.text!!)), client = client)
            check(second.error == null && second.text == "继续回答")
            val preserved = server.requests[5].body.getJSONArray("messages")
            check(preserved.length() == 8 && preserved.getJSONObject(2).getJSONArray("tool_calls").getJSONObject(0).getString("id") == "call-1") {
                "后续提问丢失了工具消息前缀"
            }
            client.cancel()
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
        MockServer(listOf(Reply(answer("已取消的回复"))), stall = true).use { server ->
            val client = AiClient()
            val callback = CountDownLatch(1)
            client.request(ModelConfig(endpoint = server.endpoint, apiKey = "mock-key"), "问题", "ask", null, null,
                emptyList(), { callback.countDown() }, { callback.countDown() }, { callback.countDown() })
            check(server.received.await(5, TimeUnit.SECONDS))
            client.cancel(); server.release.countDown()
            check(!callback.await(250, TimeUnit.MILLISECONDS)) { "取消后仍执行了回调" }
        }
    }

    private fun encryptedSettingsAndTextHistory() {
        check(ModelConfig().endpoint == "https://api.deepseek.com" && ModelConfig().model == "deepseek-flash"
            && ModelConfig().reasoning == "medium" && ModelConfig().maxToolRounds == 3)
        val settings = AppSettings(targetContext)
        val original = settings.load()
        try {
            val test = ModelConfig("https://example.com/v1", "deepseek-flash", "mock-secret", "high", 2)
            settings.save(test)
            check(settings.load() == test)
            check(!targetContext.getSharedPreferences("rabbit_settings", 0).all.toString().contains("mock-secret")) { "Key 被明文保存" }
        } finally { settings.save(original) }
        val testFiles = File(targetContext.cacheDir, "ai-history-test").apply { mkdirs() }
        val history = ChatHistory(object : ContextWrapper(targetContext) { override fun getFilesDir(): File = testFiles })
        val chat = history.save("test-chat", "文字历史", listOf(ChatTurn("user", "问题"), ChatTurn("assistant", "回答")))
        check(history.list().first().id == chat.id && history.list().first().turns.last().content == "回答")
        val json = File(testFiles, "chat_history.json").readText()
        check(!json.contains("image") && !json.contains("bitmap") && !json.contains("base64"))
    }

    private data class Output(val text: String?, val error: String?, val deltas: List<String>)
    private fun runRequest(server: MockServer, action: String = "ask", bitmap: Bitmap? = null,
        selection: RectF? = null, previous: List<ChatTurn> = emptyList(), client: AiClient = AiClient()): Output {
        val done = CountDownLatch(1)
        val response = AtomicReference<String?>()
        val failure = AtomicReference<String?>()
        val deltas = mutableListOf<String>()
        client.request(ModelConfig(endpoint = server.endpoint, apiKey = "mock-key"), "测试问题", action, bitmap, selection,
            previous, { deltas.add(it) }, { response.set(it); done.countDown() }, { failure.set(it); done.countDown() })
        check(done.await(8, TimeUnit.SECONDS)) { "模型回调超时" }
        return Output(response.get(), failure.get(), deltas.toList())
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
