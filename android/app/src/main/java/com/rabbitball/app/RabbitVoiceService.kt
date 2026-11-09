package com.rabbitball.app

import android.service.voice.VoiceInteractionService
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.speech.RecognitionService
import android.speech.SpeechRecognizer

/** 由系统的数字助理手势或按键唤起，界面交给对应会话。 */
class RabbitVoiceService : VoiceInteractionService() {
    companion object {
        private var instance: RabbitVoiceService? = null
        fun activate(): Boolean {
            val service = instance ?: return false
            service.showSession(null, android.service.voice.VoiceInteractionSession.SHOW_WITH_ASSIST or
                android.service.voice.VoiceInteractionSession.SHOW_WITH_SCREENSHOT)
            return true
        }
        fun isDefault(context: Context): Boolean = isActiveService(context, ComponentName(context, RabbitVoiceService::class.java))
    }

    override fun onReady() { super.onReady(); instance = this }
    override fun onShutdown() { if (instance === this) instance = null; super.onShutdown() }
    override fun onDestroy() { if (instance === this) instance = null; super.onDestroy() }
}

/** 数字助理元数据要求提供识别服务；当前版本不申请麦克风或录音。 */
class RabbitRecognitionService : RecognitionService() {
    override fun onStartListening(recognizerIntent: Intent?, listener: Callback) {
        listener.error(SpeechRecognizer.ERROR_CLIENT)
    }

    override fun onStopListening(listener: Callback) = Unit
    override fun onCancel(listener: Callback) = Unit
}
