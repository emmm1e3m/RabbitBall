package com.rabbitball.app

import android.content.Context
import android.util.AtomicFile
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID

data class ChatTurn(val role: String, val content: String)
data class SavedChat(
    val id: String,
    val title: String,
    val updatedAt: Long,
    val turns: List<ChatTurn>,
    val preview: HistoryPreview? = null
)

class ChatHistory(context: Context) {
    // 文字和压缩预览同属一个原子条目；原始图片及模型标记图不落盘。
    private val file = AtomicFile(File(context.filesDir, "chat_history.json"))
    private val settings = AppSettings(context)

    @Synchronized fun list(): List<SavedChat> =
        if (settings.historyLimit == 0) emptyList() else readEntries().take(settings.historyLimit)

    private fun readEntries(): List<SavedChat> = runCatching {
        if (!file.baseFile.exists()) return emptyList()
        val array = file.openRead().bufferedReader(Charsets.UTF_8).use { JSONArray(it.readText()) }
        (0 until array.length()).map { index ->
            val item = array.getJSONObject(index)
            val turns = item.getJSONArray("turns")
            SavedChat(item.getString("id"), item.getString("title"), item.getLong("updatedAt"),
                (0 until turns.length()).map { turnIndex ->
                    val turn = turns.getJSONObject(turnIndex)
                    ChatTurn(turn.getString("role"), turn.getString("content"))
                }, item.optJSONObject("preview")?.let { preview ->
                    HistoryPreview(preview.getString("jpegBase64"), VisualSource.valueOf(preview.getString("source")))
                })
        }.sortedByDescending { it.updatedAt }
    }.getOrDefault(emptyList())

    @Synchronized fun save(id: String?, title: String, turns: List<ChatTurn>, preview: HistoryPreview? = null): SavedChat? {
        if (settings.historyLimit == 0) {
            file.delete()
            return null
        }
        val previous = list()
        val savedPreview = previous.firstOrNull { it.id == id }?.preview ?: preview
        val chat = SavedChat(id ?: UUID.randomUUID().toString(), title.take(80), System.currentTimeMillis(), turns.toList(), savedPreview)
        val entries = (listOf(chat) + previous.filter { it.id != chat.id }).take(settings.historyLimit)
        persist(entries)
        return chat
    }

    @Synchronized fun delete(id: String) {
        val entries = readEntries()
        if (entries.any { it.id == id }) persist(entries.filter { it.id != id }.take(settings.historyLimit))
    }

    /** 保存设置后立即裁减文件，之后调大上限也不会重新出现已删除的记录。 */
    @Synchronized fun trim() {
        if (settings.historyLimit == 0) {
            file.delete()
            return
        }
        val entries = readEntries()
        if (entries.size > settings.historyLimit) persist(entries.take(settings.historyLimit))
    }

    private fun persist(entries: List<SavedChat>) {
        val array = JSONArray()
        entries.forEach { entry ->
            val messages = JSONArray()
            entry.turns.forEach { turn -> messages.put(JSONObject().put("role", turn.role).put("content", turn.content)) }
            array.put(JSONObject().put("id", entry.id).put("title", entry.title)
                .put("updatedAt", entry.updatedAt).put("turns", messages).apply {
                    entry.preview?.let { preview ->
                        put("preview", JSONObject().put("jpegBase64", preview.jpegBase64).put("source", preview.source.name))
                    }
                })
        }
        val stream = file.startWrite()
        try {
            stream.write(array.toString().toByteArray(Charsets.UTF_8))
            file.finishWrite(stream)
        } catch (error: Exception) {
            file.failWrite(stream)
            throw error
        }
    }
}
