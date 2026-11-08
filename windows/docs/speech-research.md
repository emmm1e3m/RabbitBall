# Windows 与离线语音转文字方案

核实日期：2026-11-05。本阶段只调研，不在 RabbitBall 中加入录音或语音按钮。

当前最省事的方式是让用户在输入框内使用系统听写。无需自行申请 API Key；如果要求完全离线，可以先使用已下载中文语言文件的 Windows 11 语音访问。后续若要把离线中文识别集成进 RabbitBall，优先验证 sherpa-onnx 的 Node.js 接口与中文流式模型。

## 系统自带能力

| 方案 | 是否离线 | 中文与使用条件 | 对 RabbitBall 的意义 |
| --- | --- | --- | --- |
| Windows 语音键入 `Win + H` | 否，采用 Azure 在线语音识别 | 需要网络、麦克风及获得焦点的文本框；支持中文 | 输入框正常获得焦点即可交给系统处理，不增加应用内语音依赖 |
| Windows 11 语音访问 Voice Access | 首次设置和下载语言文件需联网，之后可离线 | 当前官方支持列表已含简体中文（中国）和繁体中文（台湾）；应以目标机器更新后的可下载语言为准 | 可用系统功能完成离线听写，也能控制电脑；无需 RabbitBall 接入云端语音 API |

以上依据：[语音键入说明](https://support.microsoft.com/en-us/accessibility/windows/use-voice-typing-to-talk-instead-of-type-on-your-pc)、[语音访问设置](https://support.microsoft.com/en-us/accessibility/windows/voice-access/set-up-voice-access)、[语音访问中文支持更新](https://support.microsoft.com/en-us/accessibility/windows/voice-access/history-of-voice-access-updates)。

Voice Access 的基础听写与 Copilot+ PC 上的“流畅听写”是不同能力：后者的当前官方说明仍限定于英语地区设置，不能据此限制基础语音访问的中文支持。

## 能否直接调用 Windows 识别接口

`Windows.Media.SpeechRecognition` 当前要求应用具有 MSIX 包标识。List/SRGS 命令语法在设备端识别，需要对应语音语言包；Topic 自由听写与网页搜索依赖在线服务。安装语音语言包不能据此推导出自由听写可离线。[识别语言与本地处理边界](https://learn.microsoft.com/en-us/windows/apps/develop/input/specify-the-speech-recognizer-language)、[应用要求](https://learn.microsoft.com/en-us/windows/apps/develop/input/speech-recognition)。

SAPI / `System.Speech` 可以使用机器已安装的进程内识别引擎，`DictationGrammar` 提供自由听写语法。集成前要通过 `InstalledRecognizers()` 验证实际语言和引擎，不能假定每台 Windows 11 都已有中文识别器，也不能将其当作 Win+H 或 Voice Access 的调用接口。[识别引擎](https://learn.microsoft.com/en-us/dotnet/api/system.speech.recognition.speechrecognitionengine)、[听写语法](https://learn.microsoft.com/en-us/dotnet/api/system.speech.recognition.dictationgrammar)。

这两条路线都需要额外的 Windows 原生桥接，当前没有比直接使用系统输入功能更省事。

## 应用内完全离线识别

| 方案 | 适配性 | 主要成本 |
| --- | --- | --- |
| sherpa-onnx | 支持 Windows、macOS、Linux，提供 C/C++、C#、Rust、JavaScript/Node.js 等接口，包含中文及中英混合的流式与非流式模型 | 需要下载模型并分发对应平台的本地运行库；适合在 Electron 的工作进程中按需加载 |
| whisper.cpp | C/C++ 本地推理，支持 Windows 和 CPU；中文应选择多语言模型 | 未量化 `base` 模型约 142 MiB、参考内存约 388 MB；`small` 约 466 MiB、参考内存约 852 MB。量化可以减小体积；实际延迟需在目标 CPU 上测量 |

依据：[sherpa-onnx 官方项目](https://github.com/k2-fsa/sherpa-onnx)、[中文与中英流式模型](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/online-transducer/zipformer-transducer-models.html)、[whisper.cpp 能力与资源表](https://github.com/ggml-org/whisper.cpp#memory-usage)、[中文语言支持](https://github.com/ggml-org/whisper.cpp/blob/master/src/whisper.cpp)。资源表只描述模型与推理内存，不等于完整应用安装包或整机占用。

## 实施建议

当前保持普通文本输入与明确的焦点，用户可自行使用 `Win + H`；要求离线时先验证系统 Voice Access 中文听写。若未来需要应用自己的按键说话体验，再单独加入 sherpa-onnx：模型按需下载、按需加载，不随桌宠常驻启动。模型选择以中文、中英混合和目标设备延迟的实测结果为准。

## 按住说话、松开结束的应用内方案

针对用户新提出的按键说话需求，若只要求松开后得到文字，优先验证 `sherpa-onnx-node` + SenseVoiceSmall int8 的非流式识别。Chromium `getUserMedia`/`AudioWorklet` 采集并转为 16 kHz 单声道 PCM，现有全局键盘服务提供按下、释放事件；松开后交给 Electron `utilityProcess` 内的识别器，结果填入 RabbitBall 输入框。首次启用时加载模型，随后复用；无需新增 Python 环境、本地 HTTP 服务或原生麦克风依赖。按键已经界定录音起止，第一版无需额外引入唤醒词和 VAD 分段。

若进一步要求边说边出字，再选择中英流式 Zipformer/Paraformer，并在按键释放时结束当前输入流。识别准确率、专业术语和结束延迟需要目标机器实测；原生 Node 插件与 DLL 的打包加载也需要验证。目前仅形成方案，尚未实现或下载模型。

依据：[推荐 Node-Addon 接口](https://k2-fsa.github.io/sherpa/onnx/javascript-api/index.html)、[SenseVoice int8 模型](https://k2-fsa.github.io/sherpa/onnx/sense-voice/pretrained.html)、[非流式 API](https://k2-fsa.github.io/sherpa/onnx/javascript-api/examples/api_non_streaming_asr.html)、[流式 API](https://k2-fsa.github.io/sherpa/onnx/javascript-api/examples/api_streaming_asr.html)、[Electron utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process)。
