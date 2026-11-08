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
        fun isDefault(context: Context): Boolean = isActiveService(context, ComponentName(context, RabbitVoiceService::class.java))
    }
}

/** 数字助理元数据要求提供识别服务；当前版本不申请麦克风或录音。 */
class RabbitRecognitionService : RecognitionService() {
    override fun onStartListening(recognizerIntent: Intent?, listener: Callback) {
        listener.error(SpeechRecognizer.ERROR_CLIENT)
    }

    override fun onStopListening(listener: Callback) = Unit
    override fun onCancel(listener: Callback) = Unit
}
