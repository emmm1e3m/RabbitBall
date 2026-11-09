package com.rabbitball.app

data class AppearanceConfig(
    val petSize: Float = 1f,
    val bodyColor: Int = 0xFFF58DAA.toInt(),
    val eyeColor: Int = 0xFFF90040.toInt()
)

/** 模型请求只消费 model，界面和历史直接读取各自的设置。 */
data class AppConfig(
    val model: ModelConfig = ModelConfig(),
    val appearance: AppearanceConfig = AppearanceConfig(),
    val historyLimit: Int = 10
)
