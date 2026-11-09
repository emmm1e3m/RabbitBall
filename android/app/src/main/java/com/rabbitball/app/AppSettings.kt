package com.rabbitball.app

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.net.URI
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

data class ModelConfig(
    val endpoint: String = "https://api.deepseek.com",
    val model: String = "deepseek-flash",
    val apiKey: String = "",
    val reasoning: String = "medium",
    val maxToolRounds: Int = 3,
    val prompts: Map<PromptKey, String> = emptyMap()
)

class AppSettings(context: Context) {
    private val preferences = context.getSharedPreferences("rabbit_settings", Context.MODE_PRIVATE)

    var setupComplete: Boolean
        get() = preferences.getBoolean("setup_complete", false)
        set(value) { preferences.edit().putBoolean("setup_complete", value).apply() }

    val historyLimit: Int get() = preferences.getInt("history_limit", 10)

    fun loadAppearance(): AppearanceConfig {
        val defaults = AppearanceConfig()
        return AppearanceConfig(
            preferences.getFloat("pet_size", defaults.petSize),
            preferences.getInt("body_color", defaults.bodyColor),
            preferences.getInt("eye_color", defaults.eyeColor)
        )
    }

    fun load(): AppConfig {
        val defaults = ModelConfig()
        val encrypted = preferences.getString("api_key_encrypted", null)
        val apiKey = if (encrypted.isNullOrEmpty()) "" else {
            // 密钥随设备保护，恢复了失去原密钥的应用数据时要求重新填写。
            runCatching { decrypt(encrypted) }.getOrDefault("")
        }
        val storedPrompts = JSONObject(preferences.getString("prompts_json", "{}") ?: "{}")
        val prompts = storedPrompts.keys().asSequence().associate { wireKey ->
            val key = requireNotNull(PromptKey.entries.firstOrNull { it.wireKey == wireKey }) { "包含未知的提示词项。" }
            key to storedPrompts.getString(wireKey)
        }
        val model = ModelConfig(
            preferences.getString("endpoint", defaults.endpoint) ?: defaults.endpoint,
            preferences.getString("model", defaults.model) ?: defaults.model,
            apiKey,
            preferences.getString("reasoning", defaults.reasoning) ?: defaults.reasoning,
            preferences.getInt("max_tool_rounds", defaults.maxToolRounds),
            PromptCatalog.normalize(prompts)
        )
        return AppConfig(model, loadAppearance(), historyLimit)
    }

    fun save(config: AppConfig) {
        validate(config)
        val model = config.model
        val encrypted = if (model.apiKey.isBlank()) "" else encrypt(model.apiKey.trim())
        val prompts = JSONObject().apply {
            PromptCatalog.normalize(model.prompts).forEach { (key, value) -> put(key.wireKey, value) }
        }
        check(preferences.edit()
            .putString("endpoint", model.endpoint.trim().trimEnd('/'))
            .putString("model", model.model.trim())
            .putString("reasoning", model.reasoning)
            .putInt("max_tool_rounds", model.maxToolRounds)
            .putString("api_key_encrypted", encrypted)
            .putString("prompts_json", prompts.toString())
            .putFloat("pet_size", config.appearance.petSize)
            .putInt("body_color", config.appearance.bodyColor)
            .putInt("eye_color", config.appearance.eyeColor)
            .putInt("history_limit", config.historyLimit)
            .commit()) { "设置未能保存，请重试。" }
    }

    companion object {
        private const val KEY_ALIAS = "rabbitball_api_key"

        fun validate(config: AppConfig) {
            validate(config.model)
            require(config.appearance.petSize.isFinite() && config.appearance.petSize in .6f..1.6f) { "宠物尺寸应为 60% 到 160%。" }
            require((config.appearance.bodyColor ushr 24) == 255 && (config.appearance.eyeColor ushr 24) == 255) { "请选择不透明的球色和眼睛色。" }
            require(config.historyLimit >= 0) { "历史记录保留条数应为非负整数，0 表示不保留。" }
        }

        fun validate(config: ModelConfig) {
            val uri = runCatching { URI(config.endpoint.trim()) }.getOrNull()
            require(uri != null && uri.scheme in setOf("https", "http") && !uri.host.isNullOrEmpty()
                && uri.userInfo == null && uri.query == null && uri.fragment == null) {
                "请填写完整的 API 基础地址，不包含账号、查询参数或接口名。"
            }
            require(config.model.isNotBlank() && config.model.length <= 128) { "请填写模型名称。" }
            require(config.reasoning in setOf("low", "medium", "high")) { "请选择有效的思考强度。" }
            require(config.maxToolRounds >= 1) { "搜索轮数上限应为正整数。" }
            require(config.apiKey.length <= 8192 && !config.apiKey.contains('\n') && !config.apiKey.contains('\r')) {
                "API Key 格式无效。"
            }
            PromptCatalog.normalize(config.prompts)
        }

        private fun secretKey(): SecretKey {
            val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            (store.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
            return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
                init(KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .build())
                generateKey()
            }
        }

        private fun encrypt(value: String): String {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, secretKey())
            return Base64.encodeToString(cipher.iv + cipher.doFinal(value.toByteArray(Charsets.UTF_8)), Base64.NO_WRAP)
        }

        private fun decrypt(value: String): String {
            val bytes = Base64.decode(value, Base64.NO_WRAP)
            require(bytes.size > 12)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
            return String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8)
        }
    }
}
