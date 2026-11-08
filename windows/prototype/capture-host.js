import * as shortcut from './shortcut.js';

window.RabbitShortcut = shortcut;
// 截图页只订阅原生选区事件，不初始化宠物、聊天或设置。
window.RabbitCaptureReady = import('./capture-ui.js').then(() => {
  window.rabbitDesktop.onCaptureEvent(event => window.RabbitCapture.handleEvent(event));
});
