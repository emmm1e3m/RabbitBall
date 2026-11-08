package com.rabbitball.app

import android.content.Context
import android.util.AtomicFile
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID

data class ChatTurn(val role: String, val content: String)
data class SavedChat(val id: String, val title: String, val updatedAt: Long, val turns: List<ChatTurn>)

class ChatHistory(context: Context) {
    // 历史只保存文字；完整截图及标记图始终留在本次会话内存中。
    private val file = AtomicFile(File(context.filesDir, "chat_history.json"))

    @Synchronized fun list(): List<SavedChat> = runCatching {
        if (!file.baseFile.exists()) return emptyList()
        val array = file.openRead().bufferedReader(Charsets.UTF_8).use { JSONArray(it.readText()) }
        (0 until array.length()).map { index ->
            val item = array.getJSONObject(index)
            val turns = item.getJSONArray("turns")
            SavedChat(item.getString("id"), item.getString("title"), item.getLong("updatedAt"),
                (0 until turns.length()).map { turnIndex ->
                    val turn = turns.getJSONObject(turnIndex)
                    ChatTurn(turn.getString("role"), turn.getString("content"))
                })
        }.sortedByDescending { it.updatedAt }.take(10)
    }.getOrDefault(emptyList())

    @Synchronized fun save(id: String?, title: String, turns: List<ChatTurn>): SavedChat {
        val chat = SavedChat(id ?: UUID.randomUUID().toString(), title.take(80), System.currentTimeMillis(), turns.toList())
        val entries = (listOf(chat) + list().filter { it.id != chat.id }).take(10)
        val array = JSONArray()
        entries.forEach { entry ->
            val messages = JSONArray()
            entry.turns.forEach { turn -> messages.put(JSONObject().put("role", turn.role).put("content", turn.content)) }
            array.put(JSONObject().put("id", entry.id).put("title", entry.title)
                .put("updatedAt", entry.updatedAt).put("turns", messages))
        }
        val stream = file.startWrite()
        try {
            stream.write(array.toString().toByteArray(Charsets.UTF_8))
            file.finishWrite(stream)
        } catch (error: Exception) {
            file.failWrite(stream)
            throw error
        }
        return chat
    }
}
