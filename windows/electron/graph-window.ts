import { app, BrowserWindow, screen, shell, type WebContents } from 'electron';
import path from 'node:path';
import type { Activation } from './contracts.js';

export interface GraphWindowOptions {
  preload: string;
  onVisibility: (visible: boolean) => void;
  onClose?: () => void;
  onReload?: (webContents: WebContents) => void;
  prepare?: (window: BrowserWindow) => Promise<void>;
  focus?: (window: BrowserWindow) => Promise<boolean>;
  background?: (area: Electron.Rectangle, signal: AbortSignal) => Promise<string | undefined>;
}

type GraphActivation = Partial<Omit<Activation, 'activationId' | 'view'>>;
interface PendingActivation {
  id: number;
  data: GraphActivation;
  area?: Electron.Rectangle;
  background?: AbortController;
  ready?: Promise<void>;
  focus?: Promise<boolean>;
}

let nextActivationId = 0;

export class GraphWindow {
  private current?: BrowserWindow;
  private loading?: Promise<BrowserWindow>;
  private activation?: PendingActivation;
  private painting?: PendingActivation;
  private epoch = 0;
  private captureHidden = false;
  private captureGeneration = 0;
  private disposed = false;

  constructor(private readonly options: GraphWindowOptions) {}

  get window(): BrowserWindow | undefined { return this.current && !this.current.isDestroyed() ? this.current : undefined; }
  get webContents(): WebContents | undefined { return this.window?.webContents; }
  get visible(): boolean { return !!this.activation; }
  get activationId(): number { return this.epoch; }

  owns(sender: WebContents): boolean { return this.webContents === sender; }
  send(channel: string, value: unknown): void { this.webContents?.send(channel, value); }

  ensure(): Promise<BrowserWindow> {
    if (this.disposed) return Promise.reject(new Error('图谱窗口已关闭。'));
    if (this.loading) return this.loading;
    if (this.window) return Promise.resolve(this.window);
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const window = new BrowserWindow({
      icon: path.join(app.getAppPath(), 'resources', 'icons', 'rabbitball.ico'),
      ...area, show: false, frame: false, transparent: true, focusable: true,
      resizable: false, thickFrame: false, hasShadow: false, skipTaskbar: true, backgroundColor: '#00000000',
      webPreferences: { preload: this.options.preload, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
    });
    this.current = window;
    window.setMenu(null);
    window.setAlwaysOnTop(true, 'screen-saver');
    const openExternal = (url: string) => { if (/^https?:\/\//i.test(url)) void shell.openExternal(url); };
    window.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
    window.webContents.on('will-navigate', (event, url) => { event.preventDefault(); openExternal(url); });
    window.webContents.on('will-attach-webview', event => event.preventDefault());
    window.on('close', event => { event.preventDefault(); this.hide(); this.options.onClose?.(); });
    window.on('closed', () => {
      if (this.current !== window) return;
      this.current = undefined; this.loading = undefined; this.hide();
    });
    window.webContents.on('did-start-loading', () => {
      this.options.onReload?.(window.webContents);
      if (!this.loading) this.reloading(window);
    });
    const loading = (async () => {
      await this.options.prepare?.(window);
      if (this.current !== window || window.isDestroyed()) throw new Error('图谱窗口已关闭。');
      await window.loadFile(path.join(app.getAppPath(), 'prototype', 'index.html'), { query: { view: 'graph' } });
      return window;
    })();
    this.loading = loading;
    void loading.then(() => { if (this.loading === loading) this.loading = undefined; }, () => {
      if (this.current !== window) return;
      this.current = undefined; this.loading = undefined;
      if (!window.isDestroyed()) window.destroy();
    });
    return loading;
  }

  show(data: GraphActivation = {}): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('图谱窗口已关闭。'));
    const wasVisible = this.visible;
    this.activation?.background?.abort();
    const activation: PendingActivation = { id: ++nextActivationId, data };
    this.captureHidden = false; this.captureGeneration++;
    this.epoch = activation.id; this.activation = activation;
    if (!wasVisible) this.options.onVisibility(true);
    activation.ready = this.present(activation);
    return activation.ready;
  }

  private live(activation: PendingActivation, window?: BrowserWindow): boolean {
    return this.activation === activation && (!window || this.window === window);
  }

  private finishPainting(activation = this.painting): void {
    if (!activation || this.painting !== activation) return;
    this.painting = undefined;
    const window = this.window;
    window?.hide();
    window?.setOpacity(1);
    window?.setIgnoreMouseEvents(false);
  }

  private async present(activation: PendingActivation): Promise<void> {
    try {
      const window = await this.ensure();
      if (!this.live(activation, window)) return;
      // 重载沿用本次激活的屏幕和锚点，避免缓存背景与窗口位置错配。
      if (!activation.area) {
        const cursor = screen.getCursorScreenPoint(), area = { ...screen.getDisplayNearestPoint(cursor).workArea };
        activation.area = area;
        activation.data = { ...activation.data, anchor: activation.data.anchor ?? { x: cursor.x - area.x, y: cursor.y - area.y } };
      }
      const area = activation.area;
      this.finishPainting();
      window.hide(); window.setBounds(area);
      if (!activation.data.backgroundImageDataUrl && !this.captureHidden && this.options.background) {
        const controller = new AbortController();
        activation.background = controller;
        try {
          const backgroundImageDataUrl = await this.options.background(area, controller.signal);
          if (!controller.signal.aborted && backgroundImageDataUrl) activation.data = { ...activation.data, backgroundImageDataUrl };
        } finally {
          activation.background = undefined;
        }
      }
      if (!this.live(activation, window)) return;
      this.painting = activation;
      // 隐藏页重载后可能不产生动画帧；透明且穿透地挂回合成树，不展旧图或获取焦点。
      window.setOpacity(0);
      window.setIgnoreMouseEvents(true, { forward: true });
      window.showInactive();
      window.webContents.send('rabbit:activate', { ...activation.data, activationId: activation.id, view: 'graph' } satisfies Activation);
      // 操作和定位只发送一次；重载快照保留背景与位置，不重放用户命令。
      activation.data = { ...activation.data };
      delete activation.data.graphAction;
      delete activation.data.graphSelection;
      // 等渲染完成两帧再采样，避免首次显示缺少合成表面的 UnknownVizError。
      await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
      if (!this.live(activation, window)) return;
      await window.webContents.capturePage({ x: 0, y: 0, width: 1, height: 1 }, { stayHidden: true });
      this.finishPainting(activation);
      if (this.live(activation, window) && !this.captureHidden) {
        window.showInactive();
        window.moveTop();
      }
    } catch (error) {
      if (this.activation !== activation) return;
      this.hide(); throw error;
    } finally { this.finishPainting(activation); }
  }

  hide(): void {
    const activation = this.activation;
    activation?.background?.abort();
    this.activation = undefined; this.captureHidden = false; this.captureGeneration++;
    this.finishPainting();
    this.epoch = ++nextActivationId;
    if (activation) this.send('rabbit:dismiss', activation.id);
    this.window?.hide();
    if (activation) this.options.onVisibility(false);
  }

  hideForCapture(): void {
    const activation = this.activation;
    if (!activation) return;
    // 先释放截图助手，再让资料截图接管；背景取消不关闭当前图谱。
    activation.background?.abort();
    this.captureGeneration++;
    activation.focus = undefined;
    this.captureHidden = true;
    if (!this.painting) this.window?.hide();
  }

  async restoreAfterCapture(): Promise<void> {
    const activation = this.activation;
    if (!activation || !this.captureHidden) return;
    const generation = this.captureGeneration;
    await activation.ready;
    if (!this.live(activation) || !this.captureHidden || generation !== this.captureGeneration) return;
    this.captureHidden = false;
    this.window?.showInactive();
    this.window?.moveTop();
  }

  focusInput(observedEpoch: unknown): Promise<boolean> {
    const activation = this.activation;
    if (!activation || activation.id !== observedEpoch || this.captureHidden) return Promise.resolve(false);
    if (activation.focus) return activation.focus;
    const generation = this.captureGeneration;
    const focusing = (async () => {
      await activation.ready;
      const window = this.window;
      if (!window || !this.live(activation, window) || this.captureHidden || generation !== this.captureGeneration) return false;
      // 先提升同为置顶窗口之间的顺序，聚焦仍由当前激活轮次单独控制。
      window.moveTop();
      const focused = this.options.focus ? await this.options.focus(window) : (window.focus(), window.isFocused());
      if (!this.live(activation, window) || this.captureHidden || generation !== this.captureGeneration) return false;
      if (focused) window.webContents.focus();
      return focused;
    })();
    activation.focus = focusing;
    const clear = () => { if (activation.focus === focusing) activation.focus = undefined; };
    void focusing.then(clear, clear);
    return focusing;
  }

  private reloading(window: BrowserWindow): void {
    const activation = this.activation;
    activation?.background?.abort();
    window.hide();
    const loading = new Promise<BrowserWindow>((resolve, reject) => {
      const loaded = () => { cleanup(); resolve(window); };
      const failed = (_event: Electron.Event, _code: number, description: string, _url: string, mainFrame: boolean) => {
        if (mainFrame) { cleanup(); reject(new Error(description)); }
      };
      const closed = () => { cleanup(); reject(new Error('图谱窗口已关闭。')); };
      const cleanup = () => {
        window.webContents.removeListener('did-finish-load', loaded);
        window.webContents.removeListener('did-fail-load', failed);
        window.removeListener('closed', closed);
      };
      window.webContents.once('did-finish-load', loaded);
      window.webContents.on('did-fail-load', failed);
      window.once('closed', closed);
    });
    this.loading = loading;
    void loading.then(() => {
      if (this.loading === loading) this.loading = undefined;
    }, () => { if (this.loading === loading) this.loading = undefined; });
    if (activation && this.live(activation, window)) {
      // 重载换掉旧页面的激活编号，同时保留正在截图时的临时隐藏状态。
      const restored: PendingActivation = { id: ++nextActivationId, data: activation.data, area: activation.area };
      this.epoch = restored.id; this.activation = restored;
      restored.ready = this.present(restored);
      void restored.ready.catch(() => {});
    }
  }

  dispose(): void {
    this.disposed = true; this.hide();
    const window = this.window;
    this.current = undefined; this.loading = undefined;
    window?.destroy();
  }
}
