# Android 独立审查与修订

2026-11-09。审查基线为已发布的 GitHub 标签 `android-v0.1.0-preview.1`，提交 `5b46003`。本轮在发布后分别审查捕获与会话架构、模型请求、PC 交互一致性及动画生命周期，再整合修订；以下为已实施结论，构建与设备结果由主代理统一补充。

## 捕获与视觉上下文

- 捕获结果绑定具体请求，旧请求不能交付给后来的入口；`CaptureStore` 一次消费结果交接；捕获请求取消后丢弃自身迟到结果。相关实现：[CaptureActivity](../android/app/src/main/java/com/rabbitball/app/CaptureActivity.kt)、[CaptureStore](../android/app/src/main/java/com/rabbitball/app/CaptureStore.kt)、[RabbitAccessibilityService](../android/app/src/main/java/com/rabbitball/app/RabbitAccessibilityService.kt)。
- `MainActivity` 统一更换视觉上下文、恢复文字历史和清理旧会话，移除与请求身份重复的 generation 判断；异步照片导入仍保留自身的取消与迟到结果检查。[MainActivity](../android/app/src/main/java/com/rabbitball/app/MainActivity.kt)
- 新增 `VisualContext`，明确区分 `SCREEN`、`CAMERA`、`PHOTO`，使模型收到正确的图片来源。追问同一图片时只在首轮保留图像，与 PC 行为一致。选区使用完整图的内存副本绘制粉色圆角标记，并提供原图像素坐标；不裁掉周边上下文。[VisualContext](../android/app/src/main/java/com/rabbitball/app/VisualContext.kt)、[AiClient](../android/app/src/main/java/com/rabbitball/app/AiClient.kt)

## 边缘陪伴与角色

- 以 [PC 设计约定](../windows/docs/design.md) 和 [实际角色实现](../windows/prototype/index.html) 为依据，统一兔球尺寸与停靠几何。球心移至屏外 `0.2 × 角色宽度`，由屏幕裁出真实球体的薄球帽；耳尖保持相连，双眼收紧后移入可见区域，左右镜像。
- `PetDock` 统一保存停靠侧和高度，`EdgePetOverlay` 负责二维拖动与释放吸附。点击仅播放表情、爱心，绝不激活采集或搜索；拖动不触发点击。独立激活从停靠原点飞入，退出后返回同侧同高。[PetDock](../android/app/src/main/java/com/rabbitball/app/ui/PetDock.kt)、[EdgePetOverlay](../android/app/src/main/java/com/rabbitball/app/ui/EdgePetOverlay.kt)、[SearchView](../android/app/src/main/java/com/rabbitball/app/ui/SearchView.kt)
- `RabbitView` 复用现有弹簧实现收起与展开姿态，并按实际聚合可见性启停动画，避免角色局部隐藏后继续逐帧运行。[RabbitView](../android/app/src/main/java/com/rabbitball/app/ui/RabbitView.kt)

## 动画与界面收敛

- `SearchView` 的相机往返共用一个动画入口；开始输入不再触发横飞，统一取消、弧线、旋转和完成回调。一次性入场被解绑打断后提交明确终态，避免返回设置后残留半透明输入条、平移或旋转。[SearchView](../android/app/src/main/java/com/rabbitball/app/ui/SearchView.kt)
- 拍照后的图片入场推迟至相机揭示底层画面的交接点，解决原先 380ms 入场在兔球归位期间已被相机遮住并播完的问题；取消拍照保留原上下文和草稿。
- 设置页签补充淡入、轻微位移，高级区补充展开与收起；快速反向操作及解绑时稳定到最终状态，关闭系统动画时直接呈现终态。[SettingsView](../android/app/src/main/java/com/rabbitball/app/ui/SettingsView.kt)
- 桌面快捷方式此前误用白色快捷设置磁贴图标，已替换为粉色搜索、设置语义图标。[shortcuts.xml](../android/app/src/main/res/xml/shortcuts.xml)、[搜索图标](../android/app/src/main/res/drawable/ic_shortcut_search.xml)、[设置图标](../android/app/src/main/res/drawable/ic_shortcut_settings.xml)

PC 与 Android 的系统默认词均明确：只处理鼠标附近或框选范围内的任务对象，其余画面仅提供增强理解的背景，不主动遍历解释整屏。Android 未框选时也不再错误声明“用户选择了整张图片”。

## 与 PC 对齐的设置

- 设置统一为模型、外观、常规、提示词四页。模型参数独立于界面配置，`AppConfig` 聚合 `ModelConfig`、`AppearanceConfig` 和历史上限，渲染器不读取或解密 API Key。
- 外观支持 60%–160% 尺寸、球色与眼睛色，渐变、耳朵与爱心使用 PC 派生公式；聊天、边缘陪伴和相机使用同一尺寸几何，辅助按钮仍为球体直径的 75%。保存不丢弃当前会话、选区和草稿。
- 提示词与 PC 相同，分为回答方式、仅有附件时、搜索与解释、提取文字、翻译、联网搜索六项。仅保存相对默认值的覆盖；单项 1–20000 字、总长不超过 80000 字，支持单项与全部恢复默认。同一已完成会话保留整套有效提示词，保存后新对话才使用新设置。
- 系统默认词按 Android 的完整图片与触控框选适配，移除鼠标/指针圆环/窗口定位要求，保留 PC 的回答风格、四种 LaTeX 分隔符、资料指令隔离和来源链接规则。开始输入仅更新视线，不横飞换侧，其余动效保留。

## 其他审查结论

对 [CameraView](../android/app/src/main/java/com/rabbitball/app/ui/CameraView.kt) 的取消、失败、切镜与后台资源交接，以及 [ConversationWebView](../android/app/src/main/java/com/rabbitball/app/ui/ConversationWebView.kt) 和 [对话页面](../android/app/src/main/assets/conversation/conversation.js) 的流式更新、取消、历史恢复、减弱动画和本地资源边界进行了独立检查。模型参数、工具循环及安全输入检查未发现明确必须追加修复的问题，本轮未据此扩展功能或增加兼容分支。

## 验证

- Android：`assembleDebug`、`assembleDebugAndroidTest`、`lintDebug` 通过，Lint 为 0 errors；五组 instrumentation 通过，覆盖配置与提示词持久化、会话快照、图片来源与单图去重、完整图标记及原图保持、取消重试、四页草稿与重置、输入焦点不横飞、相机/选图与原有富文本契约。测试只调用本机模拟服务。
- PC：`npm run build`、提示词/设置/界面/agent 的 34 项针对性测试通过；额外检查鼠标定位和选区各自对应 ask/search/extract/translate 的实际请求载荷，均进入新的范围约束。
- 模拟器 `RabbitBall_API_36_1` 重启后编号为 `emulator-5554`。实际检查四页设置、快捷方式图标、左右薄球帽、拖动换侧、点击只互动、独立激活与返程、输入停留原侧、取景铺满、照片揭示及 160% 尺寸下相机控件避让。尺寸已恢复到原来的 100%，拍摄前后相册记录均为空。
- 实机发现屏缘返回手势会抢走拖动，已在兔球局部窗口调用 `setSystemGestureExclusionRects`。复验拖动和点击时前台仍为原应用；系统报告排除区域仅为该局部窗口，例如左侧 `(0,780)-(76,1064)`，其余屏缘保持系统手势。
- 最终无障碍服务与系统助理均已重新连接。未发起真实模型付费请求。
