# 已确认的工程约定

- 版本号仅在用户明确批准时调整，具体规则见根目录 `AGENTS.md`。2026-11-10，用户已批准 Windows 与 Android 两端 0.1.3。Android versionCode 保留 7，以覆盖已安装的本地测试包，不自动递增；之前本地 0.1.4–0.1.6 编号已作废。

- Windows 原工程已整体迁至 `windows/`，`.git` 保留根目录。迁移包含全部原有未提交修改、依赖和发行包。
- Android Studio 工程在 `android/`，由 IDE 新建并同步。原生 Kotlin Views，Android 11+，JDK 21、Gradle 9.3.1、AGP 9.1.0、SDK 36.1。
- 两端 UI 与设计风格保持一致，当前以 PC 为准；主约定在根 README。激活界面略缩完整截图，背景使用同图 16dp 高斯模糊与 36/255（约 14%）黑色叠层，400ms 非线性显现；普通截图卡片同步 400ms 渐显与轻微缩入。白色圈画与细角边界，选区外直接重选。
- 兔球恢复为 96×108dp，边缘窗口也为 96×108dp，球心停在左右屏外 0.2×96dp，仅露薄球帽，耳眼按 PC tuck 弹簧收起；速度按上一版的 75%，横向飞行 600ms、激活飞入 433ms。默认位置、拖动与飞行共享面板上方 12dp 的边界；无足够空间时隐藏。点击表情和爱心以 Windows 实际实现为依据，不另设样式。IME 使用 ADJUST_NOTHING，截图保持原比例只向上平移，背景保持固定；设置页恢复 ADJUST_RESIZE 与浅色系统栏。
- 普通打开由独立透明、noHistory 的 `CaptureActivity` 空任务先完成无障碍截图，再把内存图片交给聊天 `MainActivity`。Launcher、快捷方式、磁贴、边缘兔球均走该入口；设置 shortcut 仍直达 Main。掉线有限等待并提供重新连接入口；外部 ASSIST 手势/按键由系统提供截图。已移除 MediaProjection 服务、前台权限和旧 Main 捕获协调，不再弹共享授权。图片不经 Binder、不落盘，选区归一化后发送完整图的标记副本。
- 圈选粒子沿触摸轨迹生成，松手后 420ms 收拢为圆角范围；遮罩、边界沿同一轮廓绘制。粒子上限 160，所有发射路径密度为此前两倍；实时轨迹/角点线宽 3dp，稳定边界 2.2dp，形变轮廓为闭合 Catmull-Rom 平滑曲线。四角 24dp 热区，固定对角、最小 20dp，框内移动、框外重选。
- 视线采用 PC facing/faceX/faceY/glint 弹簧：默认左半屏朝右、右半屏朝左，输入焦点时看真实输入框；脸横移 70、耳朵换向、高光旋转 120°及渐变中心镜像共同转向，拖动和飞行中持续更新。旧版只有 ±8 的眼移，用户无法感知，已替换。
- 当前按钮布局为左侧搜索/提取/翻译、右侧历史，全部独立悬浮；四个表面与发送同为40dp，由45×48dp容器承载，保留5dp可见间隔。更多菜单已删除，设置从桌面图标长按进入。输入条无提示文案，左侧相机图标打开拍照/上传照片菜单，32dp视觉/44dp触摸，右侧发送；按钮配套按压回弹。
- `beginTurn` 后隐藏截图/圈选，保留模糊背景与用户/助手多轮气泡；`restoreConversation` 恢复所有轮次，`showResponse` 只更新当前助手。气泡及列表衔接使用弹簧动效，长消息由单一聊天视口滚动，根 `clipChildren` 保持默认 true，消息视口位于左上兔球安全带下方、输入条上方，chatMode隐藏整排工具；不再保留底部132dp兔球活动带。输入视线垂直幅度为 11 原单位。
- 内存相机通过 `CameraView` 提供 `start/stop/release/takePhoto`、`isReady/onReadyChanged` 与 `shutterCenter`。Configuration决定横4:3/竖3:4，按安全区与完整兔球快门带约束最大取景框；CENTER_CROP铺满，快门冻结取景框映回JPEG原坐标的裁切比例，先中心裁切再按融合旋转向量等传感器姿态转正，不依赖EXIF。96×108dp兔球飞到底部中央担当快门，目光约−7原单位；左取消、右切摄。点击先画PC表情/爱心，拍摄或切摄未就绪禁重复；切镜保留旧帧，首帧淡入恢复ready。Search稳定快门位置随旋转后的shutterCenter重新对齐。
- 相机模式隐藏旧输入、工具和状态，不显示 AI busy 信号；同一兔球与爱心绘制在相机层上方。取消不重置会话、草稿或选区；成功保留 input，Main 停旧请求并重置图片/轮次后调用 `setPhoto` 恢复框选。归位飞行完成后才揭示原生工具和恢复触摸/无障碍。Main 与组件分别管理宿主暂停及窗口不可见时停资源。
- 输入条相机菜单的“上传照片”经 Main 调用 Android 系统照片选择器，云端照片可异步读取与方向校正；只保留内存 Bitmap，不写相册/应用图片缓存。`setPhotoLoading` 与 busy 合并启禁：读取时禁新发送/前三功能，input 可编辑，图片来源菜单可换输入；圈选模式保留历史，旧回答仍可停止。取消保留当前上下文；成功采用与相机相同的 `setPhoto` 380ms 柔弹入场，与普通 `setScreenshot` 的 400ms 分支互斥。新选择、改视觉上下文和销毁时取消旧解码，防迟到结果覆盖。
- 富文本直接复用 `windows/prototype/rich-text.js`，通过 AGP Variant API 的生成资产任务同步；PC Markdown/DOMPurify/KaTeX 与公式 woff2 字体本地打包，四种公式语法及来源 SVG 图标同源。单个透明 ConversationWebView 只载入拦截的本地 https 资源，无网络子资源/文件内容权限/JS bridge；丢弃 Search 或 Activity 销毁时显式 release，设置暂离保留，照片导入在原组件 reset。历史恢复保留当前模糊背景，但清理模型图片上下文与旧输入草稿。
- DeepSeek 模型、思考参数与工具循环以 `windows/electron/agent.ts` 和 `settings.ts` 为依据；无 Responses 分支。恢复文字历史、新采集会清理 AiClient 的工具/图片会话缓存。
- 验收设备 `RabbitBall_API_36_1` / `emulator-5556` 是此次创建的独立 AVD。旧 Medium Phone 因空间不足无法更新 APK，已关闭，没有清理其应用或缓存。新设备已开启兔球截图服务、设为默认助理；边缘陪伴开关验收后为关闭。
- `assembleDebug`、`assembleDebugAndroidTest`、`lintDebug`（0 errors）和五组 instrumentation 已通过，涵盖完整图与标记、PC 模型工具循环、错误取消、加密历史、草稿/链接/圆角及四角调整、多轮气泡/历史恢复、Markdown/四种 LaTeX/来源图标/子资源约束、IME 不缩图与兔球避让，以及相机姿态像素旋转、切镜状态、选图解码和气泡动效。模拟器实际验证前后镜 CENTER_CROP 无黑边、兔球快门拍照归位、系统照片选择器取消及确认导入、发送气泡衔接；拍照前后 MediaStore 不新增记录，QA 图片夹具已删除。相机辅助按钮按 73.0667dp 球体直径的 75% 取 54.8dp，图标 27.4dp、触摸区 60dp；两侧中心距兔球 96dp。真实 Launcher 十轮聊天后重开与外部 ASSIST 均曾得到完整干净 Settings，Entry 交付后消失。测试不调用真实 API。
- 安装和 instrumentation 会终止服务进程，模拟器可能残留「已授权但未连接」的截图服务，助理也可能需要系统重新绑定。最终交互验收必须在测试完成后重新确认实际服务连接与截图，不能将空态录屏当作截图验收。生产代码不通过写系统设置来绕开授权。
- 授权入口使用公开 `Settings.ACTION_ACCESSIBILITY_SETTINGS`。Android 16 的无障碍详情 action 虽可 resolve，却要求系统签名权限；已在真实点击中发现并移除该私有入口。公开入口重新构建/Lint 通过，实际开启服务后返回 Main 自动截图成功。
- 外部助理请求同时设置 `SHOW_WITH_ASSIST | SHOW_WITH_SCREENSHOT`，App 不消费 AssistStructure。旧 Main 内部捕获会遇到系统 `SnapshotStartingWindow`：Main 隐藏后，系统旧聊天快照仍 shown/HAS_DRAWN，真正 Main 处于 DRAW_PENDING，A11y 和 inline Assist 都可能抓到旧帧；一次 A11y 对照成功不足以排除此问题。API33+禁最近任务截图只把缓存变成主题快照，不能作为可用性修复。现通过先截图、后打开聊天任务消除根因，普通入口不再走 inline 助理，Main 不再用 alpha/延时猜测交接。
- QA 截图/XML 在 `android/qa/`，已忽略。旧测试设备中曾安装开发版，后续验收使用 5556。
- 录屏避免使用 `uiautomator dump`：其 UiAutomation 默认抑制其它无障碍服务，会干扰此应用；使用 `input`、`screencap`、`screenrecord` 和只读 `dumpsys`。录制前需确认用户未同时操作同一模拟器，避免手动输入与验收动作互相干扰。

## 2026-11-09 独立架构与实现审查

- 优化前 APK 和对应源码已发布为 `android-v0.1.0-preview.1`，基线 `5b46003`；同仓库主分支已同时包含 `windows/` 与 `android/`。
- 捕获结果绑定具体请求，取消后的迟到结果不交给新入口；`CaptureStore` 仅作 `CaptureResult` 一次性交接，Main 统一 `replaceConversation`。AiClient 已有请求身份门禁，因此移除 Main 重复代数；照片导入仍有独立代数。
- 图片使用 `VisualContext(bitmap, source)` 一起替换，模型区分截图/拍摄/图库；成功会话复用首轮图片和工具消息，追问不再次编码或追加同图。归一化选区转为同一 Bitmap 的像素坐标，在内存副本画粉色圆角框并传整图。
- `PetDock` 共享停靠侧、高度比例和球心几何；`EdgePetOverlay` 独占小型可触窗口、拖动吸附与穿透心形窗，不包含激活入口。点击仅互动；Main 关闭时将实际位置交给 overlay 飞回。Search 从同一停靠点入场，正常移动/相机共用一套有限飞行与取消契约。
- 修复局部隐藏仍运行无限兔球动画、入场中断后残留中间态，以及拍照后的照片入场被取景器遮完。设置切页和高级区已补短过渡及打断收尾，静态快捷方式使用各自粉色语义图标。
- 具体审查与验证范围见 `docs/android-review.md`。

- 本轮最终验证：Android构建/Lint（0 errors）/五组runner通过；PC构建与34项focused检查通过。新AppConfig分离ModelConfig与AppearanceConfig，6项PromptCatalog覆盖保存、长度验证与会话快照；历史上限立即trim。Settings为PC四页，输入横飞已删除。新默认词两端都只处理鼠标附近或选区目标，背景仅增强理解。
- 重启后同一AVD当前是emulator-5554（原5556编号不固定）；边缘真机拖动曾被Back手势抢走，已对RabbitView小窗口设systemGestureExclusionRects，复验可左右拖动且点击不激活。相机160%避让及照片reveal实测通过，恢复100%，MediaStore仍无图片。最终A11y/Voice均Bound。QA无需再次重装或instrument，以免破坏连接。

- 2026-11-09 聊天布局更新：chatMode后工具栏GONE，角色飞往顶部安全带，消息延伸至composer上方；相机取消时按模式归位，新图片恢复圈选工具。输入相机菜单二选一拍照/上传，不直接触发Picker。Palette圆角层级small10/control16/surface24（dp），圆形和按尺寸同比的相机辅助控件例外保持比例。

- 照片来源菜单按内容测量宽度（最小144dp），左边缘对齐sheet，并沿用cornerSurface=24dp；通用选择器16dp，对话气泡与输入外壳同为24dp。conversation直接使用sheet左右边界，助手/用户分别左/右贴齐。权限用途文案集中capture_strings，设置/系统A11y说明/未授权空态均说明A11y和系统助理可独立。

- 用户后续收敛：圈选工具栏不再有重复camera按钮，只留3功能+history；input相机菜单为唯一图片入口，chatMode后也GONE并回收宽度，新视觉内容回到圈选时恢复。

- 上述聊天布局与菜单改动初验构建/Lint（0 errors）/五组runner通过；实际验证菜单144dp与sheet左对齐、相机交接和取消、原生PhotoPicker、chatMode图片入口与工具隐藏、24dp气泡左右边界和顶部角色，以及常规页独立权限提示。初验调试APK另存android/release/RabbitBall-Android-current-debug.apk，不覆盖已发布Preview2。

## 2026-11-09 双端 0.1.2

- Search.beginTurn 在创建用户气泡时清空 input；删除 submittedDraft/completeSubmission，完成、失败、取消回调不再写输入。AiClient 仅在校验通过、即将实际调用 search 时递增本轮计数，沿用请求身份门禁交付。
- Conversation JS 的单次 progressRun 记录开始时间和搜索数，忙碌前台每秒显示，后台撤掉节点/定时器但保留开始时间，完成、取消、错误及历史恢复清理。article 承担列表 FLIP，surface 包进度与正文、负责白底/24dp 圆角/整泡入场，body 保留首 token 动效；减少动态和退出清理待退场节点。
- PetEffects 沿用 PC 两槽 Wi-Fi 形信号的路径、寿命和时间公式，球心经 pet.matrix 映射以匹配飞行旋转；替换旧扫描线。设置页显式 PasswordTransformationMethod，避免 setSingleLine 后密钥明文展示。
- PC check/161 项测试/build/dist 通过，ZIP 在 windows/release/v0.1.2；Android debug/test/release 构建、Lint（0 errors）、五组 runner 通过。发布 APK 为 versionCode3/versionName0.1.2、非 debuggable，使用既有签名身份，已实际覆盖安装并确认干净截图。模拟接口实测两次搜索、计时、信号、发送清空和新草稿保留；原配置/历史已恢复，A11y/Voice 已 Bound。QA 的 force-stop 会清除模拟器 A11y enabled 项，最终恢复的仍是本轮原先已授权服务；生产代码不写系统设置。

## 2026-11-09 Android 0.1.3 本地修订

- 长文旧版已在真实 WebView 复现：视口1742px / 2.625≈663CSSpx，JS滚到底为5108.57，但原生上滑却回退到约4870，末行与底角在屏外。根因是Search的FrameLayout先整屏layout，再在onLayout缩小WebView；现onMeasure先量sheet/status并确定消息LP.height/topMargin，WebView只按最终大小测量和布局。修后同样原生手势保持5108.57，末行完整可见。
- 文档使用首泡auto margin保短列表贴底，去掉纵向overflow裁切；touch手势期间持有回看位置，pointercancel不重启自动跟随。每个surface按自身与视口交集做动态圆角clip，缩放反算保持24dp，使用单个有限clipFrame随现有动画刷新，静止不轮询；可见中段四角实测正确。
- HistoryView取代所有应用自建AlertDialog历史分支，列表按内容收紧，图片页扩大；进入/退出、行按压、分页、删除和面板尺寸过渡均完整。HistoryPreview将最长960px JPEG与文字存同一AtomicFile记录，delete/trim同步移除，旧文字记录无图仍可读；恢复时只把预览用于查看/背景，模型原图上下文清空。
- Camera按屏幕Configuration保持横4:3/竖3:4，锁定同一取景裁切与实际传感器姿态，旋转后兔球重锚到快门。Main新主题仅取消主界面窗口透明性，避免继承Launcher固定竖屏；CaptureActivity仍透明采集。已实测2400×1080相机Texture656×492、回竖屏996×1328，控制不重叠。系统栏沿用截图背景明暗，不再因相机开启强制白色图标。
- debug/test/release构建、Lint（0 errors）、五组runner通过。实际检查长文末尾和中段四角、历史缩略图/大预览/删除/空态、横竖取景和拍照，MediaStore未新增图片。原历史与设备旋转/服务状态已恢复。签名非调试APK为android/release/RabbitBall-Android-0.1.3.apk，versionCode4，已覆盖安装模拟器。

## 2026-11-09 Android 助理悬浮会话与附件

- 用户明确：系统助理为推荐入口和主要适配对象，无障碍仅备用。`CaptureActivity` 改为 NoDisplay 入口，优先等已设默认的 `RabbitVoiceService` 就绪，再用 `VoiceInteractionSession` 直接承载 UI；备用 `AccessibilitySearchWindow` 用 TYPE_ACCESSIBILITY_OVERLAY。`SearchSession` 独占聊天、历史和图片上下文，普通聊天不启动 Activity。
- `MainActivity` 只承担设置、无授权空态及前台系统交互。相机暂时重挂同一个会话 root，使用不透明无转场窗口保证前台相机权限和 Launcher 上的自由旋转；拍照/取消归还原悬浮窗口。外部启动先标记 externalVisible、启动 Activity，再 hide 助理；AOSP 拒绝已隐藏助理启动 Activity。返回由历史→Search局部层→关闭会话处理，退场中不穿透；菜单/历史可撤销未执行的后续动作。
- 长文几何 bridge 只报告本地气泡文档坐标与 visualViewport 浮点宽度；ConversationWebView.onDraw 使用同帧原生 scrollY 求交并做24dp圆角裁切，移除滚动驱动 JS clip。桥不暴露宿主操作，网页来源仍限本地资源，首图使用 data JPEG。软件Canvas连续原生滚动像素测试与真实助理窗口手势均通过；5秒硬件窗口滚动录屏77帧，圆角采样边缘变化在1px范围内。
- 待发图片在输入框显示，空文本退格（实体/IME字符/码点）或移除叉取消发送；移除只清模型图片上下文，背景和选区保留。清图片必须 setImageDrawable(null)，setImageBitmap(null) 会保留空 BitmapDrawable 并误判仍有附件。发送后首条用户消息显示现有960px压缩预览；历史恢复首图用于显示，模型原图上下文为空，不重发旧图。
- 构建、Lint和五组设备检查已通过核心悬浮/附件/裁切修改；实测助手相机进入、取消、连续返回、图库取消、Launcher入口优先助理、相机横竖切换与快门归还、备用无障碍窗口和Home关闭。照片仍只在内存，MediaStore未新增；临时历史夹具已还原。最终配色为工具与输入壳同款半透明白色、send浅粉色，图标均accent且真实几何尺寸同send；search/history分别对齐camera/send圆心。输入宽3/4上限再受IME/安全高度约束，端部控件固定底部，超限内部滚动；新增200行输入连接、键盘、横屏及删回短文检查通过。最终debug/test/release构建、Lint（0 errors）及五组instrument全部通过；上述功能已合并到用户批准的0.1.3/versionCode7（覆盖安装沿用内部序号）中，已覆盖安装模拟器并复查主助手唤起、真实超长输入和两次返回。未调用付费API，原历史及旋转状态已还原。

- Android 历史保留支持 0：AppSettings 拒绝空值/溢出/负数；Main 保存设置后 trim 删除 AtomicFile 的正文与备份，ChatHistory.save 在关闭状态直接返回 null、不落盘。SearchView 在创建、附着与会话恢复时刷新历史按钮，设置页也隐藏最近对话；当前轮次和图片仍在内存供追问使用。可用 instrumentation 参数 -e checks history 定向验证存储/入口/设置，已通过；版本保持 0.1.3 / versionCode 7。

## 2026-11-10 PC 0.1.3 发布准备

- 按用户要求完整删除 PC Alt+Tab 多任务插件，包括面板、预览/背景专用采集、IPC、配置与空插件设置页；旧配置残留字段由既有设置读取逻辑自然忽略。同步删除 Alt+Tab 专门透传、补发及仲裁逻辑，恢复配置激活键的原有直接拦截与按下即关闭对话语义，不保留多任务兼容分支。
- 三个快捷功能与历史按钮保留 32×32 圆形背景；生产 BrowserWindow 统一使用 resources/icons/rabbitball.ico。外观 useBuiltinFont 默认 false，主界面及截图界面使用系统字体，开启后使用内置字体；KaTeX 字体独立不变。
- historyLimit 支持 0：保存时裁剪全部持久历史、撤销旧 run 保存权，新 run 不创建文件，主进程跳过历史缩略图编码；当前内存会话仍支持多轮与重生成。UI 预览及保存均隐藏历史按钮、关闭历史浮层并作废迟到读取，恢复正数后启用后续记录保存。
- 用户偏好：本地修改完成后自动重新打包并启动更新版，保留设置和历史，未经批准不改版本。start:win 按本项目 release 绝对路径识别旧进程，通过 --rabbitball-quit 正常退出并等待保存后启动正式 RabbitBall.exe；打包前可用 --quit-only。
- Windows 0.1.3 类型检查、171/171 项测试与原生 ValidateOnly 371 项状态断言通过。两端 0.1.3 均已获用户批准并发布至 GitHub v0.1.3，标签对应源码提交 672c2a94ced0956f50f355ae474febf7ecc5012d；Windows ZIP 与 Android APK 均已上传。Android 仍为 versionCode 7，构建、Lint、签名及对齐验证通过。Windows 最终 asar 无插件与诊断代码，正式 RabbitBall.exe 0.1.3 及原生辅助已启动。

## 2026-11-11 Windows 大爆炸插件

- 设置新增插件页，`graphPluginEnabled=true`、`graphModeEnabled=false`；管理/文档文件夹入口集中在插件页，功能栏开启模式立即进入。图谱描边与兔球功能按钮图标统一为2px，SVG使用non-scaling-stroke，沿用主题与字体。普通截图、图谱截图及批注截图共用原生捕获生命周期，图谱保存干净原图，模糊背景独立截取。
- `graph-contracts.ts` 定义共享数据；`graph-store.ts` 独占串行文档事务；`graph-jobs.ts` 独占并行生成与取消；`graph-ui.js` 为正式画布。`graph-demo.js` 只在无桌面桥时启用，不接触真实设置和文件。
- `app.getPath('documents')/RabbitBall/知识图谱/<工作区名称>/<工作区名称>.md` 是工作区正文，`assets/` 保存原图及批注附件，`state.json` 保存稳定工作区ID、坐标、批注和生成状态。GraphStore统一维护ID到实际路径，旧UUID/document.md首次加载迁移；应用改名、Markdown首行标题改名和undo/redo共用重定位及watcher重绑。Windows非法字符用全角对应字符，文件stem最长80字符，同名或占位加“ (2)”顺延且不覆盖；目录名和文件名始终一致。`graph-location.ts`首次将旧`userData/knowledge`完整复制至文档目录，旧库仅作为备份保留，已有新库优先。截图直接位于 `## 图谱` 下，卡片使用 `###`，隐藏ID/父节点标记支持任意树深度。工作区事件修订与正文修订独立；插件页“打开文档文件夹”用稳定ID查询当前路径并shell.openPath，不激活图谱或截图。内部文档编辑器及前端桥已移除，外部Markdown编辑仍由watcher同步；错误手稿不能被新截图覆盖。
- 创建空图与填根分离：`create-graph` 预留 rootId，`attachCapture(workspaceId,graphId,context)` 填指定图。短按采集完成前不提前创建图，取消不会留下空图；长按在非空图建立新图。已移除所有 seed/自动出题模型路径。
- 生成任务默认并发 3，批注分别入队、停止、重试；完整祖先正文和原图供参考，唯一讲解目标为选中文字或裁图。删除、重挂、祖先内容或原批注变化使旧任务失效；本卡人工编辑后的生成结果保留为候选，排队阶段也保留原始contentRevision。退出画布不取消任务，停用插件取消，退出应用等待写入完成。每轮generation记录id、正文基线、实际开始/结束时间与工具次数，统计不进入正文指纹或用户撤销历史。旧正文淡出、新草稿流入，取消/失败恢复保存稿；仅生成过程中显示实际耗时和搜索次数，完成后沿状态行高度动画收起，不虚构思考阶段耗时，demo不填虚假统计。
- `onGraphChanged` 相同图片 ID 的重复数据用空字符串省略；覆盖节点图片、批注 images、source.images 和 source.selectionImage，前端统一 hydrate，直接 open/mutate 返回完整图片。流式更新复用卡片 DOM。`selectionImage` 是原选区来源快照，区别于批注附图，跨图搬迁或删来源仍能重新生成。
- 画布鼠标滚轮以指针为中心缩放，左键空白平移；精细pixel wheel判为触控板平移，ctrl+wheel捏合缩放，同一连续手势保留模式。正文普通wheel保留内部滚动，ctrl+wheel在画布卡内仍缩放画布，在展开/固定区拦截浏览器缩放。缩略图连续wheel单次手势只切一张，避免惯性连跳。
- 图谱控件禁选；普通画布卡片单击展开，鼠标按住移动超过6px直接拖动子树，取消独立手柄；展开/固定预览正文保留原生选字，触摸保留内滚和双指画布手势；固定预览正文点击保留原生选择，不用延迟click识别双击。空白pan在pointerdown排他preventDefault并仅清图内Range，4px阈值后平移，按pointerId处理移动/结束；lostcapture、blur、关闭和context切换统一清理。pointerPress/clickFrom为标题、卡片和遮罩共享按下归属及8px移动判断，防拖选后误展开/收回；文字选区只影响所属卡点击，延迟批注回调验证当前focusCard身份和连接状态。
- 回正使用420ms、cubic-bezier(.22,1,.36,1)的rAF插值，每帧同步state.view、world变换和按钮逆缩放；切图的方向偏移并入真实视角，不再叠加viewport位移动画。切图/点击当前缩略图平滑居中，首次打开直接居中；新切图替换旧目标，用户按下/画布wheel立即停在当前帧。流式render不打断动画，resize重算目标，reduced-motion直接完成。独立subagent审查通过，未引入通用手势管理层。
- Windows输入层按职责分开：原生钩子只交付按下时物理坐标/快捷键，main只转换一次坐标、管理窗口命中和聚焦，DOM控件负责click。兔球只接受主动pointerId的完整轻点/拖动，取消/失焦/关闭统一收尾，暂停视觉动画仍更新命中。截图、图像批注和重挂均绑定唯一主动指针；截图第二指放弃未提交框，pen不受手掌触点提交。重挂关闭/换上下文用cancel({restore:false})清ghost与捕获，settle验证drag/workspace/open，不复活旧图。
- 本体setInteractive恢复v0.1.2的boolean契约，renderer按elementFromPoint与拖动状态上报；不再调用setShape，不因空输入区域hide，也不引入镜像显示层。大爆炸独立上报固定卡rects，仅在画布激活、悬停或按住固定卡时贡献输入状态。截图/暂停/跨屏沿用原来的显隐生命周期。
- 画布触屏采用一条非passive TouchEvent路径，mouse/pen平移仍用PointerEvent并排除touch。scene、viewport、普通图片和正文滚动区使用touch-action:auto，只有兔球拖动、重挂手柄、放大图像框选局部none；原manipulation/pan-x pan-y会令Chromium正文触摸从首帧不可取消，已实测移除。单指正文不干预默认滚动/选择，双指（含正文和截图）按质心与距离更新同一view；抬一指重设基准、不跳变，取消抑制迟到move和合成click。已开始的原生单指滚动不能半途夺取，需抬起重新开始双指。实际CDP触点验证缩放、平移、取消和正文165px滚动；headless长按在无脚本对照页也不产生原生选区，不能当作实体触屏选词验证。
- 固定预览按住正文时锁定当前top，暂停入场移动，释放后续播；pinPress在图谱打开/关闭两种预览状态均生效，只有关闭状态通知主进程按压状态，原生按压期间允许跨出卡片拖选，释放后按当前悬停状态恢复穿透。结束监听在window捕获阶段，隐藏/移除pin和pagehide主动清理，chat/settings的冒泡隔离不再截断收尾。真实浏览器过渡中按住8帧top变化0px，选文保留。
- chat/settings/edit-menu保留浏览器默认输入：组合输入期Escape/Enter229不关闭/发送，chat-history使用auto支持长公式横向滚动；number/email等无selectionStart的控件使用原生命令可用状态判断复制/剪切。编辑菜单在graph开关/换上下文取消迟到粘贴。实际Chromium长公式宽332px、内容1156px，触摸横移scrollLeft=165，未触发画布或窗口动作。
- 批注前先放大，阅读窗口约占85%屏高，最终正文15px/行高27px不变；从原卡矩形直接展开/收回，原卡隐藏直到收回结束。focusTransition以同一startTime控制牌面、内距、胶囊和原画布视觉比例，标题沿用原短预览及宽度上限，避免长标题起点被重复缩窄；仅动画中的一张卡逐帧按实际Range/图片边界重绘批注，结束或中断清理所有动画与帧回调。原牌与展开牌保留阅读scroll位置，入场暂inert、退场立即inert避免工具误触。展开卡工具常显，普通卡隐藏生成和批注编号；功能按钮使用画布逆缩放保持屏幕大小。标题600字重，非根普通/展开标题居中跨顶边，固定标题居中跨底边；模型卡与图谱快速会话统一短标题提示，不截断存储的TeX。
- 截图根卡由pixelSize和实际内距计算高度；普通卡高宽4:3。`layoutUnit`归一化坐标，唯一`layoutTree`以深度为列（1.12u间距）、DFS叶分支为行，父节点与首分支同行，其余分支另起行，各行按实际最高卡片加max(28px,.10u)间距，给顶边胶囊留出空间。非根标题统一单行短预览，完整标题保留在tooltip；根节点在画布、展开和固定状态均隐藏标题胶囊，但保留文档元数据。source根头部占用25px，移成子节点后为41px。根位置保留；已有图、新增/删除/重挂均进入同一布局，平移/缩放不重排。进入或切换图谱由rootView统一以zoom1将根卡居中，不恢复旧视角或fit-all；constrainView按全部节点实际边界、当前缩放和视口限制平移，边缘卡可居中并留20%视口余量。缩放和resize共用同一限制。后台add-card/生成/move使用同一深度列初始位置；曲线统一右出左入，走两列间隙。
- `graph-selection.js`将公式视为原子语义单元，`rich-text.js`在`.rabbit-math`保留转义后的`data-latex`（DOMPurify会剥掉MathML annotation）；隐藏MathML和可见HTML不重复计入文字偏移。批注保存完整TeX，恢复按语义偏移/唯一文本匹配，已有旧DOM偏移验证原文后转入同一几何路径。同一行合并高亮，公式矩形使用可见KaTeX区域。document捕获输入框外pointerdown：有文字或附件即保存，空稿取消，Escape明确取消；截图暂停期间保留草稿。保存同步固定批注快照和workspace/graph/node归属，异步结果不清新选区或关闭新编辑器；noteWrites按工作区/批注ID独立保留失败快照，提示统一重试，新保存替代同ID旧重试。
- 拖动在root捕获指针，ghost平滑跟随、旧入边淡出，悬停缩略图450ms只预览切图，释放后一次提交move-subtree；目标允许根或已有分支节点，仅禁止自身和后代成环。取消恢复原视图且不写访问/树。批注删除保留子卡与source快照，并取消关联未完成任务。
- 每工作区保留20步会话内稀疏字段/实体撤销历史：Ctrl+Z撤销，Ctrl+Shift+Z或Ctrl+Y重做；创建、删除、批注、固定、重挂、跨图移动和整批生成等统一记录。视图与流式回写不入历史、不清重做；撤销按当前状态构造逆操作，保留已完成生成和无关异步变化，冲突字段拒绝覆盖。恢复未完成任务为取消状态，不自动重启生成。输入框及IME走原生文本历史，不触发图谱撤销。
- 所有卡片取消拖动手柄，world卡按住移动超过6px启动拖动，展开及固定预览保留选字。展开卡无专用关闭按钮，点击外部或Escape收回，删除使用垃圾桶图标。
- 图谱快速会话复用 RabbitChat；每轮固定所选节点及祖先参考，读取期间即可取消。graph:contextchange在实际换工作区/图谱时关闭旧会话，发送/重生成/加入图谱再次校验graphKey；回答始终加入该轮原始父节点。空图允许回答成为首根。回答加入图谱时正文标题降至四级起，代码围栏原样；图谱文件独立于聊天历史上限。graph-jobs重新生成在读取store前登记任务，读取期间停止可阻止迟到入队。
- 已确认旧点击失效根因：showPanel('graph') 将 promptActivation 置 pending，renderer 未 focusInput，造成 OS 一直鼠标穿透。assistant 在图谱 open 的 finally 按激活轮次完成 ready 握手。CDP mouse 能绕过系统命中，不能代替 Win32 鼠标验收。
- 批注截图的 beginSelection 回执先登记 captureId，再以 microtask 顺序交付 pointer/end；一次拖动即结束，取消返回 null。返回复用同一个 graph activation，不重新 open、不清空批注。桌面抓取失败立即取消并恢复。模式持续 false 的菜单图不会因无关设置保存关闭，只有真实停用切换才退出。
- 固定卡片在当前画布可见时不生成顶部副本；退出后root保留pin-only层。固定按钮独立牌面子元素，位于居中标题右侧6px，34px直径/17px圆角，与标题胶囊同高；画布逆缩放和focus过渡均保持屏幕尺寸。已固定按钮始终可见，pin模式仅此按钮，无其它工具；无标题根卡保留顶/底边缘入口。setGraphPinRegions始终上报牌面、可见标题和按钮（裁剪到可见区），位置/动画变化时更新。可见固定区域提前允许Windows点击激活，悬停不调用focus/show；graphPinPressed仅由有序原生down/up开启和结束，renderer的迟到down只能校验，不能重新锁住输入；renderer up可提前释放。已删除按下后的异步focus Promise、抢焦点及外点清焦点补偿，失焦/模式切换清理按压。Ctrl+C由实际获得焦点的渲染窗口处理。关闭插件、截图、暂停、跨屏pending均受门禁控制。固定正文点击/双击保留文本选择，标题或图片点击先visit所属图再graphActivate；启动恢复最近工作区，临时设置/聊天面板遮盖pin。
- 所有action按钮统一捕获指针，移动超过8px取消点击，保留键盘click。取消固定热区的pointer及desktop:cursor悬停、focusin均不触发展开，保持当前牌面位置；其他牌面正常悬浮预览。真实Win32收起直接点击和完整预览后点击均记录pointerdown/up/click到同一按钮，pin:false且图谱不激活。原外悬工具栏已移除，不再随牌面滑走或移出原生命中区。
- 左侧整图缩略图及文字合为白色浮卡，深色标题保持对比；缩略图、新建和工作区入口统一14px圆角，整栏透明。预览采用真实根截图、白色小卡、细线和内容纹理，过密小卡省略纹理，避免饱和色块拥挤。标题省略并保留tooltip，1440/1024/320px布局通过视觉检查。
- 验证：build及412项测试通过，graph-ui 67项。自动保存回归覆盖空稿/附图、document外点捕获、跨workspace迟到结果不碰新note或Selection、同一入口恢复多份失败快照；浏览器实测单击/触摸tap展开、拖选不展开、外点保存及Escape取消。新增手势与回正动画6项回归；实际浏览器确认空白平移无选文、正文批注不移画布、拖选出界不收回、固定预览可选字。回正连续54帧、状态与实际矩阵误差<0.00051px，拖动/滚轮中断后无回跳；真实浏览器逐帧验证旧稿退场、草稿流入、成功末帧不再淡出、进度高度连续收回、取消恢复与立即重试，控件位置稳定且pageerror为0。本轮Win32真实点击标题右侧圆形按钮可取消固定且graph保持closed；真实拖选后Ctrl+C的剪贴板内容与选文完全一致，该轮旧策略下外部点击后及再次悬停时均focused=false/focusable=false；现策略已改为可见固定区域提前focusable，仍不在悬停主动focus。浏览器zoom0.4/1/1.8的固定按钮均34×34、17px圆角、与标题间距约6px；展开后无关闭按钮，外部点击收回并恢复原卡。根节点居中误差小于0.004px，平移边界与320px窄屏正常。此前已验证库迁移/重命名/撤销重做、标题与批注中间帧、树拖动/历史、公式选区、截图附图、本机SSE及原生透传。触控板仅精细wheel/ctrl捏合事件验证。显示器1440×852 CSS、200%缩放，截图在本任务visualizations/production。QA的userData/documents均隔离，临时资料未写正式目录，剪贴板已还原，测试应用已关闭。
- 已完成0.1.3重新打包，`windows/release/RabbitBall-0.1.3-win-x64.zip`已生成；asar内graph-ui/selection/rich-text/edit-menu/settings/demo与本地一致，main/graph-store/graph-location与本地编译结果一致。旧版正常退出后正式`win-unpacked/RabbitBall.exe`已启动，两项原生辅助进程正常。正式目录为`<用户文档>/RabbitBall/知识图谱`；工作区现为`未命名工作区/未命名工作区.md`，稳定ID保留，2张图及2份图片正常，旧userData备份仍保留。未提升版本。
- 输入层更新已再次沿用0.1.3打包：完整index及graph/capture/chat/settings/edit/assistant等内联源一致，main/preload/windows-native JS与PS1均匹配当前编译结果。启动脚本的Get-CimInstance遇到0x80004005；旧版此前已正常退出，改用Get-Process核对路径后直接Start-Process，正式主进程与2项原生辅助已确认运行。该WMI故障未引入应用逻辑兜底或无关系统改动。

- 2026-11-11 输入复发修复：卡片边缘按钮曾由hover同时控制opacity与pointer-events，导致从空白直达按钮或首次触摸落到画布；现命中固定、hover只调外观，any-pointer:coarse时常显。拖动副本整棵子树禁命中，避免按钮挡住重挂目标。固定卡的Windows激活提前准备，主进程按压态缩为单个graphPinPressed，删除异步焦点请求与外点补偿。UI、GraphStore和生成入口统一拒绝无文字且无附图的批注，选择原文本身不算批注；确认、Enter、外点和截图完成共享非空规则。

- 卡片工具按钮统一采用固定按钮的34px圆形样式；展开牌的40px生成按钮距卡片右侧和底部内边缘各10px（半个按钮半径），退出按钮同为40px。根节点无重新生成入口；未生成批注存在时启用生成按钮。批注textarea首次Enter仅保存并将焦点交给现有生成按钮，第二次Enter通过原生按钮激活生成子节点；Shift+Enter换行，IME确认和repeat不提交；勾选仅保存。异步保存仅在同workspace/graph/focusCard且无新批注时转移焦点。生成等待展开卡320ms收回后提交，新增卡与连线分别480/420ms入场，连线复用避免流式重播，必要时平移缩放展示父子分支。

- 自定义子卡：world/focus卡片常显加号直接add-custom-node(graphId,parentId,markdown,images)，允许空白，以kind:source持久化身份。追加图复用append-node-images，文字复用edit/contentRevision；source禁止regenerate但支持annotation生成子节点。异步创建保留原workspace/parent，仅原focusCard身份未变时展开新卡（world入口快照为空）；空卡、混排、undo/redo、重载、跨图移动均有行为回归。
- 根节点采用截图优先：空图“添加根节点”直接截图并add-root，成功后展开；已展开根的相机按钮继续截图，append-node-images(graphId,nodeId,images)保留原正文/批注/图片并支持撤销；文字按钮在卡片内编辑，复用edit与contentRevision，不弹出前置创建表单。graphCaptureImages/captureImages共用根/批注截图链路（purpose=images）。截图成功写入发起时的图谱，迟到结果不展开其它工作区。
- 退出图谱输入审查：已删除固定卡按压扩大整屏shape的路径；原生鼠标释放清graphPinPressed，下一次区域外按下也清理遗留状态。隔离Win32双窗口+真实钩子验证释放后底层点击和滚轮可用。主assistant中无生产start来源的旧截图会话监听/关闭门禁已删除；正式capture-host独立持有截图UI。现场未发现旧会话分支参与生产截图，不能将它称为已复现的主因。
- 全局输入复审：FocusOwnedWindow的AttachThreadInput会把辅助线程、兔球和当前前台（常为被截图窗口）的输入队列拼接，后续同步焦点调用可能阻塞且JS超时无法解除。已删除AttachThreadInput、BringWindowToTop及跨线程SetFocus，现仅一次SetForegroundWindow与最多150ms可取消观察。截图覆盖窗始终鼠标穿透；未发现滚轮被全局hook吞掉的路径。
- 截图worker区分window/desktop请求：窗口恢复v0.1.2 PrintWindow(flags2)，返回完整GetWindowRect边界、限幅1920×1200的PNG；屏幕框选/图谱背景继续CopyFromScreen BGRA。main不再用桌面裁剪代替窗口内容。最初删除PrintWindow是排查假设，未证实它是停绘根因；用户明确无需再测Bili。

- 当前验证：473项Windows自动测试、107项原生窗口断言通过；真实Chromium覆盖首次Enter仅保存、再次Enter生成、repeat不提交、Shift+Enter换行、根截图优先及自定义卡片纯文本/附图/批注生成。CDP Enter需附字符事件text:\r，否则无法模拟按钮原生激活；不要给产品叠加Enter到click监听。
- 前次0.1.3已交付自定义卡片；开始菜单快捷方式指向win-unpacked/RabbitBall.exe。本轮截图修改的最新验证与交付以文末为准。

- 激活光效恢复：activation-effect.js保留原渐变、2100/920ms与实际--rb-accent；desktop chat:open只发origin/activationId/color给main，预览继续原DOM播放。独立ActivationEffectWindow无preload、不可聚焦、永久ignoreMouse/showInactive，覆盖currentContext.focusScreenBounds，主交互窗moveTop保持在光效上方。主UI不扩大shape。IPC校验主sender/轮次/prompt/非截图/非暂停及hex色；新激活/截图/暂停/退出清理，旧动画/旧load失败/renderer-gone用实例与generation隔离。真实Windows确认完整720×550 DIP光效、focusable=false且目标焦点保持；穿透投点因其它topmost窗口覆盖被HWND守卫阻止，因此未声称点击/滚轮实测成功。controller4项回归、完整473项与真实Chromium加号常显及world创建流程通过。
- 光效与常显加号合并后再次dist:win交付0.1.3，包内host/动画/index/main/控制器与本次构建一致；正式实例及两项原生辅助进程已确认运行。

## 2026-11-12 大爆炸固定卡片修复

- 用户确认0.1.2本体正常，任务边界为大爆炸插件。已撤掉本轮DesktopDisplay候选、其预加载/host/测试及编译遗留；不使用局部capturePage镜像。恢复本体直接呈现和boolean交互契约，插件不得以setShape裁剪本体，输入状态不得驱动本体hide。
- 已确认Chromium 156遮挡误判条件：RabbitBall HWND为全工作区，只有一个region矩形时Chromium仍使用完整窗口矩形；LAYERED且alpha255也不自动排除。prepareOverlayWindow仅为本进程有效HWND增加WS_EX_TOOLWINDOW，保留其它样式、前台、尺寸和region；隔离自有Electron窗口的遮挡predicate由true变false。setFocusable/setSkipTaskbar不会移除此标记。
- ReadFullscreen显式排除GetDesktopWindow/GetShellWindow；空目标上下文无captureError也正常打开聊天。截图助手独立于输入钩子；窗口与屏幕采集分工见下文。
- 桌面取消固定时输入rects立即移除、元素inert，原DOM保留180ms淡出下移后才删除布局占位。快速重新固定取消旧退场；切换图谱/工作区/插件清理旧实例，旧promise不能删除重新固定的卡片。
- 原生down/up是插件持续按压的唯一开启来源；renderer迟到down不再重新开启按压。未按压时离开卡片恢复穿透；物理松开、失焦、截图和退出释放插件按压状态，不修改本体hover状态。
- 参考VPet的局部WPF窗口和Shimeji的逐像素原生窗口后，以用户给出的可用0.1.2本体作为更直接基线；没有迁移本体显示技术。按要求不再测试Bili。
- 最终472项Node回归、436项原生断言及真实Chromium图谱交互通过。隔离main-plugin-live.cjs实测本体opacity1、无shape、空目标prompt真聚焦；固定卡Win32悬停与拖选成功，移出后自建底层窗口click=1/wheel=1且动画ticks793→1091继续，ignoreMouse=true；native up后迟到renderer down未重新锁住。取消固定60ms输入0但inert卡仍1，400ms后卡0。正式asar已核对工具窗口标记、退场动画及不存在镜像/旧window-input编译遗留；版本0.1.3未变。
- dist:win完成后正常启动正式RabbitBall.exe，确认两项原生辅助进程存活、开始菜单仍指向win-unpacked。正式主窗Visible=true、RegionKind=0、ExStyle=0x082800A8含TOOLWINDOW，ChromiumOpaquePredicate=false。ZIP为windows/release/RabbitBall-0.1.3-win-x64.zip。

## 2026-11-12 大爆炸实现精简

- 三个subagent分别审查画布、存储/生成、桌面桥/预览。保留现有分层和有实际数据用途的迁移、公式选区兼容；本轮不调整本体显示及原生输入。
- graph-ui的根截图、追加图片、批注附图共用captureInto挂起与恢复；固定卡激活持有独立目标，逐次await后核对目标身份与epoch，关闭或其他打开操作取消未提交目标，避免连续点击串用共享pendingPin。
- GraphStore子树查找改邻接遍历，树校验复用已确认祖先路径，两段深树遍历降为O(n)；512层逆序树回归覆盖合法乱序、环、断链及完整分支删除。GraphJobs路径用push/reverse，重新生成准备并回调用方，消除重复异常清理。
- graph-demo以localStorage写入成功作为提交边界，再更新内存、历史及失效任务。失败的新建、重命名、切换、撤销/重做不留下半次修改；当前工作区读取不再写存储。流式保存失败保留已保存正文并结束任务，仅显示失败状态。workspace返回独立副本，调用方不再重复克隆工作副本。
- build与479项Windows自动回归通过；新增7项回归覆盖固定卡异步竞态、深树及预览存储配额失败。数据格式和版本0.1.3保持不变。
- dist:win完成，旧正式实例通过--rabbitball-quit正常退出后更新，已启动新win-unpacked/RabbitBall.exe并确认主进程持续运行；ZIP仍为RabbitBall-0.1.3-win-x64.zip。

## 2026-11-12 恢复窗口截图

- 普通prompt仅发window请求；graph需要根图时发window加可选backgroundBounds（同response分别返回窗口PNG/桌面BGRA）；已有图背景与长按框选只发desktop，不再携带foreground标志。背景失败不丢窗口图，窗口失败也不拿桌面图冒充；组合请求真正挂住时仍受原有8秒整请求超时约束。
- CaptureWindow与v0.1.2方法一致，光标按完整窗口边界与实际输出尺寸映射，不按屏幕交集裁剪。保留CaptureWorker取消杀进程/新请求重建、session身份检查及已完成的TOOLWINDOW/插件按压修复；没有修改本体动画或增加截图fallback。
- 恢复后483项Node回归及107项原生断言通过。自有40×40窗口被不同颜色窗口完全遮挡时，CaptureWindow仍返回目标色与完整窗口边界，CaptureDesktop返回遮挡色且未请求窗口绘制，前台保持不变。PW_RENDERFULLCONTENT可能由DWM缓存完成，因此以像素来源而非必须收到WM_PRINT作为窗口截图依据；当前仅一台显示器，多屏用例跳过。
- 本轮按0.1.3完成dist:win，asar已确认PrintWindow PNG和独立desktop分支；正常重启正式程序，主进程及两项原生助手运行。主窗Visible=true/RegionKind=0/TOOLWINDOW存在/ChromiumOpaquePredicate=false，先前插件遮挡修复保持。

## 2026-11-12 Windows 文档导入与工作区背景

- 普通聊天与图谱背景共用 `prototype/documents.js` 的 `RabbitDocuments.readFile`。图片保留原有 5 MiB 限制；文档经 `parseDocument` IPC 交给 `document-parser.ts`，使用 officeparser 8.7.1。输入上限 50 MiB、解析结果上限 100 万字符，超限明确报错。按用户修正，已支持文档走专用解析，其余文件一律尝试严格 UTF-8/BOM UTF-16 解码并检查二进制控制字符，不用后缀限制纯文本准入。无后缀、点文件和未知后缀可导入；类型标签保留后缀，无后缀为 text，已知代码继续附语言标签。文本 .exe/.zip 可导入，真实二进制按内容拒绝；映射只查询自有键。原文不重排、不执行。
- 解析在独立、短生命周期子进程运行，完成或失败后退出；打包后的 ASAR ESM 路径限制使此处采用 `child_process.fork`，不使用 `worker_threads`。解析不启用 OCR；PDF 字符与排版提取不保证恢复原始 LaTeX，已有文本公式按原文保留。
- `GraphWorkspace.background` 保存说明和附件，`set-background` 统一修改；附件作为工作区文件资产持久化，Markdown 记录背景与资源引用。背景供同一工作区的所有图谱使用；直接读取返回完整附件，流式事件省略未变正文，前端按工作区和附件 ID 复用缓存。
- 左侧工作区下方的背景入口提供文字、多文件/图片、移除、保存及取消。草稿按工作区留在当前运行会话；关闭、外点、Escape、换图或换工作区后可继续，明确取消才丢弃。文件读取和保存捕获原工作区，流式更新不覆盖输入，迟到结果不改新工作区；失败保留草稿以便重试。
- 背景加入图谱生成和会话参考，仍以当前问题、批注及指定选区为重点。图谱会话独立保存一份背景和当前根到叶路径，随历史持久化，每次请求注入一次；历史消息只保存真实问题、附件、回答及工具链。重新生成保留原问题和用户附件，读取当前选中节点的最新路径及工作区背景。背景、附件和沿途批注作为参考资料，不覆盖本次指令；生成过程中背景变化使旧任务失效，避免新旧参考混用。
- officeparser 8.7.1 的数学序列化存在单字母参数粘连控制词等错误；`scripts/patch-officeparser.mjs` 在安装、构建和测试前为固定版本应用结构层修复，升级依赖必须重验补丁。用真实 DOCX/HTML 字节核验公式，不能只检查数字分式（`\frac12` 本来就是有效 TeX，暴露不了 `\fracH2` 的问题）。
- toast 偏右后跳回的原因是通用入场动画覆盖了 CSS `translateX(-50%)`。`arrive/depart` 改为独立 `translate` 属性，保留组件定位 transform。真实 Chromium 在 0/20/75/150/300ms 的水平中心偏差均为 0，撤销恢复卡片。
- 初次集成的 514 项自动回归、构建及 Chromium 图谱输入检查通过；12 项文档解析测试同时通过系统 Node 和 Electron 内置 Node。隔离桌面界面验证了加号选文件、二进制失败保留原附件和问题、背景跨图共享/跨工作区隔离/重载恢复，并检查常规及约 900×640 视口。正式 ASAR 中 PDF 和含缩进的 MathML 分式解析通过。
- 沿用 0.1.3 完成 `dist:win`，旧程序正常退出并保存历史后启动新包；正式主进程响应正常、窗口标题正常。Windows 与 Android 版本均未提升，未发布 GitHub。
- 取消纯文本后缀限制后的验证：系统 Node 与 Electron 内置 Node 的 13 项解析测试、4 项上下文/失败保留/背景持久化回归及类型检查通过。格式标签长度与文件名上限统一为 240，避免未知长后缀导入后在发送或背景保存时被拒。正式 ASAR 已验证 README、Dockerfile、.env、未知/长后缀及文本 .exe/.zip 导入、真实 EXE 拒绝，PDF 和 MathML 公式解析保持通过。已再次沿用 0.1.3 打包并正常重启，主进程响应、窗口标题及两项原生助手正常。

## 2026-11-13 图谱按真实问答链构造上下文

- 按用户进一步明确的结构，图谱根到叶路径还原为 user 原始资料、user 来源批注/选区、assistant 卡片标题及正文；无原始问题的自定义卡片按已有资料提供，不捏造提问。每级图片及其他标注保留为资料，图片按整链 ID 去重，不展开旁支正文。聊天与批注生成共用同一结构，无路径 JSON 文本双轨。
- `AgentConversation.reference.messages` 独立于正常聊天消息保存。每次请求顺序为 system、最新工作区背景、当前图谱问答链、正常聊天历史及本轮问题/工具链。同路径续聊保持完整已有请求前缀；路径变更后只替换图谱链，正常问题、附件、回答及工具链不改写；重新生成保留原问题/附件并读取当前选中节点。
- 规则在稳定 system 层，图谱消息不注入修改时间或随机值。背景与共同祖先尽量形成跨请求、跨分支前缀；不添加供应商专属缓存开关，不宣称实际命中率。用户明确取消旧历史迁移，本轮无迁移函数，也不改写旧历史结构。
- 523 项全量回归与构建通过。正式 ASAR 探针验证根到叶批注/选区/assistant 回复、整链图片与背景各一份、正常历史独立；相同路径第二次请求以第一次全部 8 条输入消息为精确前缀。图谱专项覆盖 12 级图片批注回复链和跨分支共同祖先前缀。
- 已沿用 0.1.3 重新生成 Windows ZIP；旧版正常退出保存后启动新包，主进程响应、窗口标题和两项原生助手正常。未发布 GitHub。

## 2026-11-13 图谱侧栏与文件资料统一

- 图谱侧栏统一布局；背景、自定义卡片及聊天附件共用 `documents.js` 的 `createTile`，图片与文档预览为主、文件名和类型为辅。自定义卡片可导入或移除文档、图片，文档保存为独立附件，不拼入 `markdown` 正文。聊天新增附件自动横向滚入可见区域；composer 焦点坐标与实际 DOM 输入框对齐。
- `parseDocument` 携带 `workspaceId` 时先将解析全文暂存到工作区 `assets/<hash>.txt`，上传本身不修改工作区 revision，也不使未保存背景生效。保存后的工作区 Markdown 使用可读文件链接，不内联附件全文；模型沿 root→leaf 读取每级附件的文件名、类型及完整内容。
- 附件缓存按工作区 revision 拒绝旧响应，避免迟到结果污染新状态；同一卡片的文字编辑与附件变更互斥，防止保存覆盖。背景取消保留已保存内容；批量导入中个别文件失败仍保留有效项。
- 542 项全量测试、构建与 Chromium `graph-input` 检查通过。实际 Electron 在 1440×900、900×640 验证上传立即落盘且 revision 不变、保存文件链接而非内联正文、自定义卡片图文导入/删除/文字编辑/重开、失败保留有效项、背景取消及焦点坐标；预览无裁切、遮挡。
- 版本保持 0.1.3，已完成最终 ZIP。正式 ASAR 实测 PDF 解析后立即落资产、Markdown 仅链接、重载及 LLM 全文均通过。首次新包启动出现无窗口的失败实例；发行目录一度只剩 electron.exe，而 ZIP 中仍为 RabbitBall.exe，原因未确定。已从 ZIP 恢复 RabbitBall.exe，正常退出尝试无响应后仅结束本轮新启动且无会话的失败进程；原配置副本及历史/图谱只读诊断正常。随后原配置诊断启动成功并正常退出，再经常规脚本启动，主窗响应、标题和两项原生助手均正常。实际配置与历史未改写，临时配置副本已清理；未发布 GitHub。
- 空聊天输入框的 Backspace 每次移除最近的待发送附件（任意文件或图片），再按上下文截图的逆序逐张移除；有文字/空格、IME 组合或 Ctrl/Alt/Meta 修饰时保留正常编辑。54 项聊天 UI 回归和真实 Electron 键盘检查通过，沿用 0.1.3 重新打包并常规重启，主窗及两项原生助手正常。

## 2026-11-13 统一资料退格与侧栏图标

- 背景草稿与自定义卡片在正文严格为空时，Backspace 每次删除最近添加的一项文件或图片；保留普通删字、IME 组合及 Ctrl/Alt/Meta 编辑行为。节点以带 `image:` / `attachment:` 前缀的 `materialOrder` 保存混合顺序，批量导入按原选择顺序提交；`remove-latest-node-asset` 在存储队列内原子删除，支持重载、撤销和重做。
- 文件选择器结束和资料删除后恢复输入焦点，不抢走其它对话框或输入框的焦点。编辑器等待自身附件删除并更新 revision 后再保存，避免快速退格后保存失败或覆盖；读取中、保存中不穿透删除已有资料。
- 侧栏依次为新建图谱、背景信息、工作区选择，图标和文字统一左对齐；删除空背景的“添加资料与说明”。背景图标只保留纸张轮廓与折角；操作图标采用 1.5px 描边和 non-scaling-stroke，图谱连线、品牌及兔球装饰不作为操作图标处理。
- 552 项全量自动测试及构建通过。真实 Electron 键盘验证背景和自定义卡片按文档→图片→文档导入后，逐次退格逆序删除，重开卡片后顺序保持，退格后立即编辑保存成功；实际侧栏三项图标与标签分别位于相同横坐标，操作图标计算描边为 1.5px。
- 已正常退出旧版并保存对话，沿用 0.1.3 完成 `dist:win`，常规脚本启动新包；正式主窗响应、标题及两项原生辅助进程正常，未发布 GitHub。

## 2026-11-14 普通模式信号描边恢复

- 上次 `button svg>*` 的 1.5px 图标规则命中了 `#pet .effects > #wifi-pool`，覆盖组的 11.5 描边，圆点仍为半径 6.5 的实心圆，造成粗细失衡；同一规则还把扫描线从 2 改为 1.5。两条全局按钮 SVG 规则改用 `button:where(:not(.pet))`，保持原优先级并排除整个兔球绘制层，操作图标仍为 1.5px。
- 与 git tag `v0.1.2` 对照，信号几何、圆点、发射参数和动画变换均无需修改。真实 Electron 的两段弧线计算描边为 11.5px、vector-effect 为 none，圆点无描边，扫描线为 2px；重新注入旧规则可复现弧线变成 1.5px。已查看发射中间帧和双信号重叠帧，普通模式键盘切换正常；80 项本体/界面回归及构建通过。
- 已沿用 0.1.3 完成 Windows ZIP，旧版通过正常退出保存后启动新包；正式主窗口响应、标题及两项原生辅助进程正常。

## 2026-11-16 图谱输入、视图、用量与多屏截图

- 展开来源卡使用默认 `sourceInput`，提示“输入问题或粘贴内容”；文件、截图为独立入口，预览用于查看排版公式及选文批注。输入按卡片保留草稿并串行自动保存，保存/生成等待附件写入和删除，迟到结果核对原工作区；无待生成批注时以 `GraphGenerateRequest.question` / `GraphSource.question` 保存真实提问，不伪造批注或文件。旧 rootEditor/rootText 路径已删除。
- KaTeX 根号等 SVG 被 DOMPurify 的错误全属性 URI 正则清掉 d/viewBox/尺寸；移除此正则，继续使用 Markdown 的链接验证、html:false、KaTeX trust:false 与 DOMPurify 默认安全清理。全局和图谱图标 CSS 限定按钮的直接 SVG，避免标题公式被当成操作图标。真实 Chromium 覆盖 64 组根号、嵌套分式、伸缩箭头、花括号等公式与容器组合。
- 视图优先恢复按工作区/图谱保存的本地 view/focusId 快照，再使用已有 graph.view；快速切图、退出和界面重载恢复缩放、位置、展开卡片。主动收起清除展开记忆，切换清理保留；同图点击不回中。侧栏提升到阅读遮罩之上，真实点击可在展开卡片时直接切图。输入框以边框颜色标记焦点，取消额外 outline，避免上下边框重复。
- 用户最终明确缩略图上是用量与删除两个按钮；没有保留关闭/重开机制。`delete-graph` 删除整张图、选择相邻图，支持全删后新建及现有撤销/重做；撤销显式回到原图并恢复视图。资产沿用现有留存策略支持撤销。
- 本体 `UsageStore` 统一持久累计模型轮次与真实 prompt/completion/total/cache/reasoning 数字，按 chat 或 workspace/graph 范围查询；工具前后模型轮分别记录，缺字段保持未知。共享 `RabbitUsage` 弹窗由设置“查看用量”或插件带 scope 调用；未知显示 —，真实零保留，命中率仅对有完整缓存统计的请求计算。查询序号拒绝同范围旧响应/错误，main 退出等待普通模型请求及用量落盘。
- 长按 Alt 在已开 prompt/graph 时保留短按关闭，并允许同次按住升级截图。所有显示器先准备首帧状态再一起显示；取消、绘制失败和迟到准备统一清理，避免透明或部分显示窗口。实际双屏组件探针覆盖主屏 200%、副屏 125% 和负 Y 布局，两屏状态 UI/真实桌面像素均可见、前台保持、关闭后隐藏；系统 Alt 整链由 main 函数回归覆盖，不将组件探针表述为实际 Alt 按键验收。
- 最终 593 项自动测试与构建通过；实际 Electron 验证默认输入、问题生成、文件失败保留/退格、公式标题和正文、缩略图用量、整图删除与撤销、缩放展开恢复、899×640 聚焦输入单层边框。用量界面验收使用独立服务固定数据，真实 SSE 字段/工具轮结算由自动测试覆盖。
- `test:graph-input` 已同步默认输入、Enter 换行/自动保存和预览批注，保留真实拖选、双 Enter 生成及多截图验收，全部通过。测试退出前临时 profile 的数据库仍被 Electron 占用，后续清理获自动审批拒绝，保留临时目录，不重复尝试绕过；不涉及正式用户资料。
- 已沿用 0.1.3 完成 `dist:win`，旧版正常退出保存后启动新包；正式窗口响应、标题及两项原生助手正常。ZIP 路径不变，未发布 GitHub。

## 2026-11-16 插件触发键与图谱窗口独立

- 设置增加 `graphActivationShortcut: string[] | null`；null 表示沿用本体键，插件启用且同键时图谱优先，独立右 Alt 等组合则分别路由。删除 `graphModeEnabled` / `setGraphMode`，聊天功能栏入口直接打开图谱，不再写模式。插件页和通用页共用录制状态机；恢复默认设为 null，取消保留旧设置，保存等待原生结束录制回执，失败留稿重试。
- 原生助手接受 prompt/graph 两套绑定，begin/hold/end/cancel 事件携带固定 target。严格前缀组合在消除歧义前不启动短组合：补齐长组合选长，松开短组合或达到长按阈值才锁定短组合；同键图谱优先。修复候选取消编号和上一轮 holdEmitted 残留。最新原生状态机 522 项断言、34 项定向测试通过。
- 新 `GraphWindow` 独立承载 `index.html?view=graph`；preload 明确 pet/graph surface。图谱页面隐藏兔球及装饰并提前退出动画核心，无 RabbitBallDemo/RAF/宠物位置报告。图谱聊天使用独立布局和入口，不依赖宠物几何；主进程 petChat/graphChat 分开会话、取消和事件接收端，图谱隐藏只取消并保存图谱聊天。
- 图谱激活、焦点 epoch、首帧、截图临时隐藏和恢复均按图谱窗实例管理。首次隐藏窗口 capturePage 曾在真实原生探针抛 UnknownVizError；激活后等待两帧再采样，重复真实主进程验收通过。图谱渲染进程的素材缓存按 WebContents 独立，设置/资料/用量广播共用本体服务。
- 固定卡仅 pet surface 渲染和报告命中区域，图谱可见时隐藏，关闭后按其它面板占用恢复。固定卡点击传完整 workspace/graph/node 到独立窗口；工作区选择用完整快照同步本体，迟到的 pet 查询不覆盖图谱刚选工作区。图谱正文展开时侧栏及右上对话/退出仍可点。
- 最终 636 项自动回归和构建通过。隔离真实 main/native/preload 探针验证两窗并存、独立草稿、pet 位置/状态不变、graph 无宠物/固定卡、关闭与重开只复用一图谱窗；结果在 `windows/node_modules/.cache/graph-window-native/result.json`。实际界面另验证默认继承、录制右 Alt 保存而本体仍左 Alt、恢复默认草稿取消、展开卡片直开图谱聊天；无模型调用、无 renderer 错误，测试实例已退出。没有声称注入物理 Alt 的完整按键验收。
- 既有 `test:graph-input` 已同步精确退出按钮、条件收起已恢复的展开卡片、鼠标预移动与实际命中断言，最终全通过。早先单次拖动失败未复现，不归因于已恢复 focus；未更改产品拖动行为或增加长延时。
- 已沿用 0.1.3 完成 Windows ZIP，先正常退出旧版保存后再启动新包；正式主窗口响应、标题和两项原生助手正常。未提升 Windows/Android 版本，未发布 GitHub。

## 2026-11-16 图谱置顶与停靠兔球闪动

- GraphWindow 原来没有 alwaysOnTop；现创建为 screen-saver 置顶层，并在打开、截图恢复、重新加载与显式聚焦前提升 Z 序，不依赖抢焦点。统一透明且穿透的首帧预绘制，解决隐藏重载后 RAF 不产帧的问题；取消和迟到回调不显示旧窗口。
- 原闪动链为 graph 按下即 beginCapture/hideMainWindow，即使已有资料仍只为装饰背景截图，结束先 showMainWindow 再 show graph。现用独立 pendingGraphTrigger 等待松键/长按：已有图短按直接打开/关闭独立窗，不创建资料 CaptureSession、不改变本体的显隐或输入状态；长按阈值后及空图首次取资料才创建 CaptureSession。待决读取核对触发身份、原生编号和图谱激活编号，取消/停用/新触发不迟到打开。没有修改停靠动画。
- 642 项全量回归通过；收尾错误归属调整后 53 项激活/窗口专项仍通过。覆盖三轮短按开关本体 hide/show/showInactive/setOpacity/setBounds 为零、普通输入不变、长按阈值及空图取图、取消和旧 nativeId 隔离。
- 原生 GraphWindow/WindowsNative Z 序探针 `windows/node_modules/.cache/graph-zorder-native/result.json` 确认实际 WS_EX_TOPMOST、普通及另一置顶窗口相对前置；非聚焦操作不改前台。系统本次拒绝测试 focusInput 聚焦，但 Z 序仍成功提升，未宣称取得焦点。
- `output/graph-no-flash-qa/probe.cjs` 使用独立资料、真实 Win32 F24 注入和低级键盘钩子触发生产 main，反复开关已有图谱。161 次停靠状态采样、0 本体窗口修改调用、0 截图请求、目标/透明度/停靠状态不变（X 仅有约 0.008px 的原弹簧收敛），graphAlwaysOnTop=true；结果 `result.json`、无模型调用，实例正常退出。
- 已正常退出旧版保存后沿用 0.1.3 重新打包并启动，正式主窗口响应、标题及两项原生助手正常，未发布 GitHub。

## 2026-11-16 恢复独立图谱模糊背景

- 移除 CaptureSession 后普通入口不再传背景，导致既有 CSS `blur(18px)` 没有图片。GraphWindow.present 在自身隐藏及定位后，调用 main 的 background(area, signal) 采当前工作区物理矩形；复用预热 CaptureWorker，不触碰本体、不创建资料会话/选区、不进入模型上下文。长按已有背景直接复用。装饰截图失败仍可打开图谱。
- show/hide/reload/hideForCapture 同步取消旧背景，释放共享截图助手；取消结果继续预绘制并由 captureHidden 保持隐藏。控制器归属激活对象，await 后核对当前激活，迟到背景不能覆盖新图谱。截图临时隐藏期间重载不采背景。
- 曾验证 desktopCapturer.getSources，功能正确但背景采集需 2379/1464ms，故未保留该实现。最终原生探针两次 worker 采集 595/167ms，首次窗口冷启动整体 1767ms、重开 315ms；同一个助手，无资料捕获事件/选区、本体原生修改 0，341 次停靠采样稳定。原始背景与当前高对比底图像素均差 1.64/1.45，排除反拍旧图谱；JPEG 1600×947、blur18px。结果与 CSS 尺寸截图在 output/graph-no-flash-qa，本次仅实际检测到一块 200% 屏幕。
- 650 项全量测试及构建通过，19 项 GraphWindow 回归覆盖取消、替换、区域冻结、截图及重载恢复。
- 沿用 0.1.3 完成 Windows ZIP；ASAR 确认 provider、预热助手、取消和 18px 模糊均已打入。正常启动正式包，主进程 64504 响应且标题正确，两项原生助手正常；未提升版本或发布 GitHub。

## 2026-11-16 图谱架构专项审查与优化

- 三个 subagent 分别审查窗口生命周期、截图传输、异步入口和背景渲染，按确证问题修改。PendingActivation 统一持有区域、锚点、背景与取消控制器；移除重复 opened 状态。重载复用当前背景/区域/锚点，新的 show 仍重新取屏幕。graphAction/graphSelection 送出后从恢复快照移除，防止重载再次撤销或重复定位；送出前重载仍保留首次命令。
- captureRequestEpoch 在 cancelCapture 中统一失效，三个图谱 IPC 的工作区读取完成后同时检查请求代次和图谱轮次，防止旧请求覆盖新截图或新的入口；即使新截图已取消/结束、暂时没有 CaptureSession，也拒绝旧请求。
- readDesktop 只读取 NativeImage，资料截图再构造 context；装饰背景直接读取图片，不制造无用资料上下文。背景编码共用 encodeGraphBackground。desktop 请求可带 maxWidth=1600，由同一个 C# CaptureDesktop 在导出 BGRA 前缩放；省略参数的资料/选区仍保留物理像素。采用 32bppRgb 忽略 GDI 未定义 alpha，输出统一强制 alpha255，缩放边缘使用 TileFlipXY。
- 删除 graph-ui 中无 CSS/逻辑使用方的亮度 canvas 回读及 is-dark-desktop 状态。未引入第二截图进程、队列或旧新双轨。
- 全量 Node 回归 658/658、构建与差异检查通过。真实 C# 位图转换 12 项通过。原 FramebufferOnly fixture 的首帧颜色断言在本轮前 Argb 实现与新版均得到 BGRA250，属于既有呈现/遮挡问题，未算通过；改用自有置顶但不激活的 Electron 高对比底图验证真实 worker。默认实际 2880×1704 / 19,630,080B，alpha 全255、采样 RGB 差0；装饰背景 1600×947 / 6,060,800B，管道像素减少69.12%。普通底图会被 Codex 窗口遮挡，不可把被遮挡的屏幕截图误判为颜色转换损坏。
- output/graph-no-flash-qa/result.json 确认 F24 两开两关、背景刷新与18px模糊、本体窗口修改0、单worker；reload 背景hash及bounds保持、采集次数2→2。首次打开721ms、重开295ms，背景采集250/142ms，仅作为本机本轮实测，不保证固定耗时。测试使用隔离资料，无模型调用，实例已退出。
- 沿用 0.1.3 完成 dist:win，正式 ASAR 确认请求代次、1600限宽、激活所属控制器及原生 maxWidth 均已打入；正常启动正式包，设置与历史保留。未提交或发布 GitHub。

## 2026-11-17 普通对话框自动聚焦

- 真实基线确认 DOM chat-input/hasFocus 与 Electron isFocused 可以全为 true，Windows 前台却仍属于 studio64.exe/ChatGPT.exe，原生 focusWindow 返回 false。验收必须读取 GetForegroundWindow 所属进程，并验证真实键盘事件进入输入框，不能只查 activeElement 或手动 input.focus 后断言。
- windows-native.ps1 的 FocusOwnedWindow 正常 SetForegroundWindow 被拒后，在原有 150ms 可取消观察内至多执行一次 SendInput 成对 Alt，再请求前台。只对当前请求、自有可见 HWND 且修饰键已松开执行；修饰状态同时查系统与 hook 已有 held 账本的 volatile 快照。自身输入携带 marker，只有 LLKHF_INJECTED+marker 双匹配才旁路触发状态机，不影响其它注入输入。部分发送只补释放；取消/新请求/隐藏后不取焦。不恢复 AttachThreadInput，不修改系统前台锁超时。
- SendInput 使用完整 INPUT union，默认 ABI 对齐；x64大小40、x86大小28。native内置自测567项通过，覆盖布局、标记、按住修饰、过期/外部目标、发送0/1/2和取消。UI测试去掉手动 focus 后直接检查自动焦点，覆盖关闭及迟到旧回执不抢新视图。
- 全量 Node 658/658、构建和差异检查通过。output/prompt-focus-qa/baseline.json 留存真实原生前台失败；verification.json 验证首次左Alt、重开、长按700ms释放及F23；selection.json 验证鼠标结束拖框后350ms才释放Alt。五类均为原生hook真实触发，前台进程等于测试实例、native聚焦true，直接敲键进入chat-input，Alt/Ctrl/Shift均已释放。测试使用隔离配置，无模型调用，测试实例已退出。
- 本机中文IME会把原生qafocus预编辑为q'a'focus，键盘和input事件均到正确输入框；不能把音节分隔误判为焦点失败。QA键盘驱动仅在真实前台属于自有测试实例时发送文字，避免误写外部应用。
- 同版本 0.1.3 完成 dist:win，ASAR 确认 bounded focus recovery 与 marker 已打入。正常启动正式包，主进程71144响应、标题正确、两项原生助手正常；未升级版本或发布GitHub。

## 2026-11-17 GitHub 同步

- 用户明确授权更新 GitHub。功能源码、测试与更新后的 Windows README 已提交并推送 main：5eed302d8755f87e885a5103656bf40f94f12456。沿用已通过658项回归和真实窗口验证的0.1.3包，不升级任何版本。
- 更新既有 v0.1.3 release（439375406）；先临时上传并核对 uploaded/大小，再替换 Windows 同名 ZIP。新资产757991976，218,867,855B；旧Windows资产738985208已移除。Android资产728166493（2,982,570B）的ID、大小、digest、更新时间均未变。原始tag保留，release说明明确链接本次功能源码提交。
- GitHub连接器get_repo/fetch仍返回Unknown tool，本次用现有Git与REST完成；认证信息只在进程内读取，不落盘。发布前确认60项源码/说明变更均在windows/docs，output、release、node_modules未进Git；发布元数据核验在output/github-release-before.json及github-release-after.json。
