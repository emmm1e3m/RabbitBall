import { app, BrowserWindow, type NativeImage, type WebContents } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { imageCropRect, viewportRect } from './capture-geometry.js';
import type { CaptureContext, CaptureEvent, PointerPoint } from './contracts.js';

export interface CaptureViewport {
  bounds: Electron.Rectangle;
  physicalBounds: Electron.Rectangle;
}

interface Overlay {
  window: BrowserWindow;
  viewport: CaptureViewport;
  active: boolean;
}

export class CaptureOverlays {
  private generation = 0;
  private sessionGeneration = 0;
  private entries: Overlay[] = [];
  private layout = '';
  private preparing?: Promise<void>;
  private sessionId = '';
  private context?: CaptureContext;
  private lastFrame?: { start?: PointerPoint; end: PointerPoint };

  constructor(private readonly onCancel: () => void) {}

  prepare(viewports: CaptureViewport[]): Promise<void> {
    if (this.layout !== JSON.stringify(viewports)) this.close();
    return this.preparePool(viewports);
  }

  async show(options: {
    sessionId: string;
    viewports: CaptureViewport[];
    background: NativeImage;
    physicalBounds: Electron.Rectangle;
    context: CaptureContext;
    shortcut: readonly string[];
    color: string;
  }): Promise<void> {
    this.close();
    const sessionGeneration = this.sessionGeneration;
    this.sessionId = options.sessionId;
    this.context = options.context;
    try {
      await this.preparePool(options.viewports);
      if (sessionGeneration !== this.sessionGeneration) return;
      for (const [index, entry] of this.entries.entries()) {
        const { window } = entry;
        const viewport = options.viewports[index];
        const background = options.background.crop(imageCropRect(viewport.physicalBounds, options.physicalBounds, options.background.getSize()));
        window.showInactive();
        // Windows 初次显示可能压到工作区；125% 等缩放还可能产生一 DIP 舍入差异。
        window.setBounds(viewport.bounds);
        entry.viewport.bounds = window.getContentBounds();
        this.send(entry, {
          type: 'start', sessionId: this.sessionId, context: this.context!, backgroundBitmap: { data: background.toBitmap(), ...background.getSize() },
          width: entry.viewport.bounds.width, height: entry.viewport.bounds.height, shortcut: [...options.shortcut], color: options.color,
        });
        entry.active = true;
        if (this.lastFrame) this.sendFrame(entry, this.lastFrame.start, this.lastFrame.end);
      }
    } catch (error) {
      if (sessionGeneration !== this.sessionGeneration) return;
      this.close();
      throw error;
    }
  }

  frame(start: PointerPoint | undefined, end: PointerPoint): void {
    if (!this.sessionId) return;
    this.lastFrame = { start, end };
    for (const entry of this.entries) if (entry.active) this.sendFrame(entry, start, end);
  }

  image(context: CaptureContext, rect: Electron.Rectangle): void {
    if (!this.sessionId) return;
    this.context = context;
    for (const entry of this.entries) {
      if (!entry.active) continue;
      this.send(entry, {
        type: 'image', sessionId: this.sessionId, context,
        rect: viewportRect(rect, entry.viewport.physicalBounds, entry.viewport.bounds),
      });
    }
  }

  close(): void {
    this.sessionGeneration++;
    const sessionId = this.sessionId;
    this.lastFrame = undefined;
    this.context = undefined;
    this.sessionId = '';
    // 取消清空页面背景和选区，窗口继续隐藏待用；迟到加载不能重新显示。
    for (const entry of this.entries) {
      if (entry.window.isDestroyed()) continue;
      entry.window.hide();
      if (entry.active) this.send(entry, { type: 'cancel', sessionId });
      entry.active = false;
    }
  }

  dispose(): void {
    this.close();
    this.destroyPool();
  }

  owns(sender: WebContents): boolean {
    return this.entries.some(entry => !entry.window.isDestroyed() && entry.window.webContents === sender);
  }

  private destroyPool(): void {
    this.generation++;
    const previous = this.entries;
    this.entries = [];
    this.preparing = undefined;
    this.layout = '';
    for (const entry of previous) if (!entry.window.isDestroyed()) entry.window.destroy();
  }

  private preparePool(viewports: CaptureViewport[]): Promise<void> {
    const layout = JSON.stringify(viewports);
    if (this.layout === layout && this.preparing) return this.preparing;
    this.destroyPool();
    this.layout = layout;
    const generation = this.generation;
    const preload = path.join(path.dirname(fileURLToPath(import.meta.url)), 'preload.cjs');
    const invalidate = () => {
      if (generation !== this.generation) return;
      const active = !!this.sessionId;
      this.dispose();
      if (active) this.onCancel();
    };
    // 页面在启动及布局变化时预载，长按只更新快照，不再冷启动渲染进程。
    this.preparing = Promise.all(viewports.map(async viewport => {
      const window = new BrowserWindow({
        ...viewport.bounds, show: false, frame: false, transparent: true, focusable: false,
        resizable: false, thickFrame: false, hasShadow: false, skipTaskbar: true,
        fullscreenable: false, backgroundColor: '#00000000',
        webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
      });
      const entry: Overlay = { window, viewport: { bounds: { ...viewport.bounds }, physicalBounds: { ...viewport.physicalBounds } }, active: false };
      this.entries.push(entry);
      window.setMenu(null);
      window.setAlwaysOnTop(true, 'screen-saver');
      window.setIgnoreMouseEvents(true);
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', event => event.preventDefault());
      window.webContents.on('render-process-gone', invalidate);
      window.on('closed', invalidate);
      await window.loadFile(path.join(app.getAppPath(), 'prototype', 'capture.html'));
      if (generation !== this.generation || window.isDestroyed()) return;
      await window.webContents.executeJavaScript('window.RabbitCaptureReady.then(() => true)');
    })).then(() => {}).catch(error => {
      if (generation === this.generation) this.destroyPool();
      throw error;
    });
    return this.preparing;
  }

  private send(entry: Overlay, event: CaptureEvent): void {
    if (!entry.window.isDestroyed()) entry.window.webContents.send('rabbit:capture-event', event);
  }

  private sendFrame(entry: Overlay, start: PointerPoint | undefined, end: PointerPoint): void {
    const { physicalBounds, bounds } = entry.viewport;
    const physicalRect = start ? {
      x: Math.min(start.x, end.x), y: Math.min(start.y, end.y),
      width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y),
    } : undefined;
    this.send(entry, {
      type: 'frame', sessionId: this.sessionId,
      ...(physicalRect ? {
        rect: viewportRect(physicalRect, physicalBounds, bounds),
      } : {}),
    });
  }
}
