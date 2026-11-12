import { app, BrowserWindow } from 'electron';
import path from 'node:path';

export class ActivationEffectWindow {
  private window?: BrowserWindow;
  private ready?: Promise<void>;
  private generation = 0;

  prepare(): Promise<void> {
    if (this.ready) return this.ready;
    const window = new BrowserWindow({
      x: 0, y: 0, width: 1, height: 1, show: false, frame: false, transparent: true,
      focusable: false, resizable: false, thickFrame: false, hasShadow: false,
      skipTaskbar: true, fullscreenable: false, backgroundColor: '#00000000',
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
    });
    this.window = window;
    window.setMenu(null);
    window.setAlwaysOnTop(true, 'screen-saver');
    window.setIgnoreMouseEvents(true);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('render-process-gone', () => { if (this.window === window) this.dispose(); });
    window.on('closed', () => {
      if (this.window !== window) return;
      this.generation++;
      this.window = undefined;
      this.ready = undefined;
    });
    this.ready = window.loadFile(path.join(app.getAppPath(), 'prototype', 'activation-effect.html')).catch(error => {
      if (this.window === window) this.dispose();
      throw error;
    });
    return this.ready;
  }

  async play(bounds: Electron.Rectangle, origin: Electron.Point, color: string, raiseInterface: () => void): Promise<void> {
    const generation = ++this.generation;
    await this.prepare();
    const window = this.window;
    if (!window || window.isDestroyed() || generation !== this.generation) return;
    window.setBounds(bounds);
    window.showInactive();
    // 首次显示可能被 Windows 收进工作区，显示后再恢复目标窗口的完整范围。
    window.setBounds(bounds);
    const actual = window.getContentBounds();
    const effect = {
      origin: { x: origin.x - actual.x, y: origin.y - actual.y },
      focusBounds: { x: bounds.x - actual.x, y: bounds.y - actual.y, width: bounds.width, height: bounds.height },
      color,
    };
    // 只调整显示顺序，不获取焦点；聊天与按钮始终位于光效上方。
    raiseInterface();
    try { await window.webContents.executeJavaScript(`window.RabbitActivationEffect.play(${JSON.stringify(effect)})`); }
    finally { if (generation === this.generation) this.clear(); }
  }

  clear(): void {
    const generation = ++this.generation, window = this.window;
    if (!window || window.isDestroyed()) return;
    window.hide();
    void this.ready?.then(() => {
      if (this.window === window && !window.isDestroyed() && generation === this.generation) return window.webContents.executeJavaScript('window.RabbitActivationEffect.clear()');
    }).catch(() => {});
  }

  dispose(): void {
    this.clear();
    this.window?.destroy();
  }
}
