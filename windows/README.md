# RabbitBall

Windows 桌面上的果冻兔球助手，支持全局快捷键截图、连续框选、AI 问答与大爆炸知识卡片。

## 使用

解压 Windows 发行包，双击 `RabbitBall.exe`。请保留同目录中的全部文件；无需安装 Node.js。

程序、任务栏和托盘图标与 Android 版共用默认兔球形态。Windows 图标及共享源图的角色外部透明；Android 桌面图标按用户要求使用黑底。在本地仓库可运行 `npm run start:win`，自动退出本项目正在运行的旧版并启动已打包的 `release/win-unpacked/RabbitBall.exe`；退出时会保存对话。重新打包前可运行 `node scripts/start-windows.mjs --quit-only` 释放旧版文件。`npm start` 仍用于 Electron 开发调试。

目前仅支持 **DeepSeek API Key**，不支持其他模型服务商的 Key。在系统托盘打开设置，填写 DeepSeek API Key、选择模型和思考强度。默认启动键为左 Alt，也可以录制其他按键或组合键：

启动键由兔球专用：启用时直接拦截所选按键，其他按键或鼠标的按下状态不影响触发。

- 短按：截取当前有效应用窗口并打开提问框。
- 按住约 500ms：进入屏幕框选，可连续选择多个区域，松开后提问。
- Esc：取消框选或关闭提问。
- 输入框为空时按 Backspace 删除最后一张图片，长按可连续删除。
- 对话打开时，拖动兔球可移动兔球与对话面板；点击兔球保留互动动画。
- 输入框下方右侧的历史图标可选择、继续或删除本机保存的对话，并预览最开始的截图。默认保留最近 10 条，可在设置的通用页调整；设为 0 时清空并停止保存历史，同时隐藏历史按钮，当前对话仍可继续。

支持多显示器、混合缩放和跨屏动画。关闭鼠标跟随时，兔球停靠在屏幕边缘，可拖动调整位置。

普通文字默认使用系统字体，可在外观设置中开启「使用内置字体」；公式使用 KaTeX。截图仅在发送提问后随请求提交；API Key 保存在本机用户配置中，不写入源码。AI 问答需要网络及可用的 API Key。

## 大爆炸插件

在设置的「插件」页开启大爆炸，再通过功能按钮切换大爆炸模式。开启模式后，启动键用于进入或退出图谱；新建根节点先截图，随后可继续添加截图或文本。任意卡片上的加号可创建空白自定义子卡，再附加文本、截图和批注。

单击卡片展开阅读，选中文字或框选图片后填写批注。第一次 Enter 完成批注，再按 Enter 生成子节点；Shift+Enter 换行。普通卡片按住拖动，展开后的正文可选择和复制。固定卡片会在退出图谱后留在桌面，悬停展开；取消固定时淡出退出。

每个工作区保存为用户文档目录下的 `RabbitBall/知识图谱/工作区名称/工作区名称.md`，截图随工作区保存。可从插件设置打开文档文件夹，外部修改 Markdown 会同步回图谱。Ctrl+Z 撤销，Ctrl+Shift+Z 或 Ctrl+Y 重做；关闭插件或清空聊天历史不会删除图谱资料。

## 本地开发

使用 Windows、Node.js 24 或更新版本、npm。Windows PowerShell 用于原生按键和窗口截图。

```powershell
npm ci
npm start
```

`npm start` 编译 TypeScript、准备本地资源并启动 Electron 桌面版。`npm run preview` 在 `http://127.0.0.1:8674` 提供浏览器交互演示；浏览器演示不具备全局快捷键和真实窗口截图能力。

## 检查与打包

```powershell
npm run check
npm test
npm run dist:win
```

输出为 `release/RabbitBall-0.1.3-win-x64.zip`，解压即可使用；`release/win-unpacked/RabbitBall.exe` 是可直接运行的目录版。也可运行 `npm run pack:win` 只生成目录版。

配置使用 Electron `safeStorage` 加密敏感字段。开发依赖、用户配置、调试记录与构建输出不纳入仓库。

实现说明见 [docs/design.md](docs/design.md)。
