# 已确认的工程约定

- Windows 原工程已整体迁至 `windows/`，`.git` 保留根目录。迁移包含全部原有未提交修改、依赖和发行包。Windows 构建及 161 项测试通过。
- Android Studio 工程在 `android/`，由 IDE 新建并同步。原生 Kotlin Views，Android 11+，JDK 21、Gradle 9.3.1、AGP 9.1.0、SDK 36.1。
- 两端 UI 与设计风格保持一致，当前以 PC 为准；主约定在根 README。激活界面略缩完整截图，背景使用同图 16dp 高斯模糊与 36/255（约 14%）黑色叠层，400ms 非线性显现；普通截图卡片同步 400ms 渐显与轻微缩入。白色圈画与细角边界，选区外直接重选。
- 兔球恢复为 96×108dp，边缘窗口也为 96×108dp，球心停在左右屏外 0.2×96dp，仅露薄球帽，耳眼按 PC tuck 弹簧收起；速度按上一版的 75%，横向飞行 600ms、激活飞入 433ms。默认位置、拖动与飞行共享面板上方 12dp 的边界；无足够空间时隐藏。点击表情和爱心以 Windows 实际实现为依据，不另设样式。IME 使用 ADJUST_NOTHING，截图保持原比例只向上平移，背景保持固定；设置页恢复 ADJUST_RESIZE 与浅色系统栏。
- 普通打开由独立透明、noHistory 的 `CaptureActivity` 空任务先完成无障碍截图，再把内存图片交给聊天 `MainActivity`。Launcher、快捷方式、磁贴、边缘兔球均走该入口；设置 shortcut 仍直达 Main。掉线有限等待并提供重新连接入口；外部 ASSIST 手势/按键由系统提供截图。已移除 MediaProjection 服务、前台权限和旧 Main 捕获协调，不再弹共享授权。图片不经 Binder、不落盘，选区归一化后发送完整图的标记副本。
- 圈选粒子沿触摸轨迹生成，松手后 420ms 收拢为圆角范围；遮罩、边界沿同一轮廓绘制。粒子上限 160，所有发射路径密度为此前两倍；实时轨迹/角点线宽 3dp，稳定边界 2.2dp，形变轮廓为闭合 Catmull-Rom 平滑曲线。四角 24dp 热区，固定对角、最小 20dp，框内移动、框外重选。
- 视线采用 PC facing/faceX/faceY/glint 弹簧：默认左半屏朝右、右半屏朝左，输入焦点时看真实输入框；脸横移 70、耳朵换向、高光旋转 120°及渐变中心镜像共同转向，拖动和飞行中持续更新。旧版只有 ±8 的眼移，用户无法感知，已替换。
- 当前按钮布局为左侧搜索/提取/翻译、右侧历史，全部独立悬浮；PC 视觉 32×30dp、可见间隔 5dp，由 37dp 容器承载。更多菜单已删除，设置从桌面图标长按进入。输入条无提示文案，左侧相机图标打开拍照/上传照片菜单，32dp 视觉/44dp 触摸，右侧发送；原生按钮配套按压回弹。
- `beginTurn` 后隐藏截图/圈选，保留模糊背景与用户/助手多轮气泡；`restoreConversation` 恢复所有轮次，`showResponse` 只更新当前助手。气泡及列表衔接使用弹簧动效，长消息由单一聊天视口滚动，根 `clipChildren` 保持默认 true，消息视口位于左上兔球安全带下方、输入条上方，chatMode隐藏整排工具；不再保留底部132dp兔球活动带。输入视线垂直幅度为 11 原单位。
- 内存相机通过 `CameraView` 提供 `start/stop/release/takePhoto`、`isReady/onReadyChanged` 与 `shutterCenter`。预览按 CENTER_CROP 等比居中裁切铺满，回传 Bitmap 仍是全图；姿态由融合旋转向量等传感器估算，拍摄时冻结方向并把像素旋为正向，不依赖 EXIF 展示。普通快门已删除，96×108dp 兔球飞到底部中央担当快门，目光约 −7 原单位轻微上看；左侧取消、右侧切前后摄。点击先画 PC 表情/爱心再拍，拍中与切镜未就绪时禁重复；切镜冻结旧帧，首帧淡入后恢复 ready。
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
