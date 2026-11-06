# RabbitBall

Windows 桌面上的果冻兔球助手，支持全局快捷键截图、连续框选与 AI 问答。

## 使用

解压 Windows 发行包，双击 `RabbitBall.exe`。请保留同目录中的全部文件；无需安装 Node.js。

目前仅支持 **DeepSeek API Key**，不支持其他模型服务商的 Key。在系统托盘打开设置，填写 DeepSeek API Key、选择模型和思考强度。默认启动键为左 Alt，也可以录制其他按键或组合键：

- 短按：截取当前有效应用窗口并打开提问框。
- 按住约 500ms：进入屏幕框选，可连续选择多个区域，松开后提问。
- Esc：取消框选或关闭提问。
- 输入框为空时按 Backspace 删除最后一张图片，长按可连续删除。

支持多显示器、混合缩放和跨屏动画。关闭鼠标跟随时，兔球停靠在屏幕边缘，可拖动调整位置。

普通文字使用随应用提供的本地字体，公式使用 KaTeX。截图仅在发送提问后随请求提交；API Key 保存在本机用户配置中，不写入源码。AI 问答需要网络及可用的 API Key。

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

输出为 `release/RabbitBall-0.1.0-win-x64.zip`，解压即可使用；`release/win-unpacked/RabbitBall.exe` 是可直接运行的目录版。也可运行 `npm run pack:win` 只生成目录版。

配置使用 Electron `safeStorage` 加密敏感字段。开发依赖、用户配置、调试记录与构建输出不纳入仓库。

实现说明见 [docs/design.md](docs/design.md)。
