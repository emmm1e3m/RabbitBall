import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { imageCropRect, viewportRect } from '../electron/capture-geometry.ts';
import type { CaptureContext, CaptureEvent } from '../electron/contracts.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function harness(loads: Promise<void>[] = [], contentHeightOffsets: number[] = []) {
  const windows: Window[] = [], crops: unknown[] = [];
  let cancelled = 0;
  class Window {
    readonly options: any;
    bounds: { x: number; y: number; width: number; height: number };
    calls: string[] = [];
    destroyed = false;
    visible = false;
    loadedFile = '';
    handlers = new Map<string, () => void>();
    webHandlers = new Map<string, () => void>();
    sent: CaptureEvent[] = [];
    webContents = {
      on: (name: string, handler: () => void) => { this.webHandlers.set(name, handler); },
      setWindowOpenHandler() {},
      executeJavaScript: async () => true,
      send: (_channel: string, event: CaptureEvent) => { this.sent.push(structuredClone(event)); },
    };
    constructor(options: any) {
      this.options = options;
      // 模拟 Windows 将初始高度限制到任务栏以外的工作区。
      this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height - 40 };
      windows.push(this);
    }
    setMenu() {}
    setAlwaysOnTop() {}
    setIgnoreMouseEvents() {}
    on(name: string, handler: () => void) { this.handlers.set(name, handler); }
    loadFile(file: string) { this.loadedFile = file; return loads.shift() ?? Promise.resolve(); }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.visible = false; this.handlers.get('closed')?.(); }
    showInactive() { this.visible = true; this.calls.push('showInactive'); }
    hide() { this.visible = false; }
    setBounds(bounds: typeof this.bounds) {
      this.bounds = { ...bounds, height: bounds.height + (contentHeightOffsets[windows.indexOf(this)] ?? 0) };
      this.calls.push('setBounds');
    }
    getContentBounds() { this.calls.push('getContentBounds'); return { ...this.bounds }; }
  }
  const moduleUrl = new URL('../electron/capture-overlays.ts', import.meta.url);
  const source = readFileSync(moduleUrl, 'utf8')
    .replace(/^import .*;\r?\n/gm, '')
    .replaceAll('import.meta.url', '__moduleUrl');
  // 执行实际类，仅替换 Electron 窗口和图像边界；坐标运算仍使用实际共享模块。
  const context: any = {
    BrowserWindow: Window, app: { getAppPath: () => '/rabbitball' }, path, fileURLToPath,
    __moduleUrl: moduleUrl.href, imageCropRect, viewportRect, Buffer,
  };
  vm.runInNewContext(stripTypeScriptTypes(source, { mode: 'transform' }).replace(/^export /gm, '') + '\nglobalThis.OverlayClass = CaptureOverlays;', context);
  const overlays = new context.OverlayClass(() => { cancelled++; });
  const background = {
    getSize: () => ({ width: 4480, height: 1440 }),
    crop(rect: { width: number; height: number }) {
      crops.push(rect);
      return { getSize: () => ({ width: rect.width, height: rect.height }), toBitmap: () => Buffer.from([0, 0, 255, 255]) };
    },
  };
  const options = {
    sessionId: 'session-1',
    viewports: [
      { bounds: { x: -1280, y: 0, width: 1280, height: 720 }, physicalBounds: { x: -2560, y: 0, width: 2560, height: 1440 } },
      { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, physicalBounds: { x: 0, y: 0, width: 1920, height: 1080 } },
    ],
    background, physicalBounds: { x: -2560, y: 0, width: 4480, height: 1440 },
    context: { id: 'context', title: '屏幕选区', images: [], capturedAt: 1 } as CaptureContext,
    shortcut: ['AltRight'], color: '#F90040',
  };
  return { overlays, windows, crops, options, cancelled: () => cancelled };
}

test('背景直接发送本屏原始像素和实际像素尺寸，不再编码图片或 Base64', async () => {
  const app = harness();
  await app.overlays.show(app.options);
  for (const [index, window] of app.windows.entries()) {
    const event = window.sent[0];
    assert.equal(event.type, 'start');
    if (event.type !== 'start') throw new Error('缺少 start');
    assert.equal(event.backgroundImageDataUrl, undefined);
    assert.deepEqual([...event.backgroundBitmap!.data], [0, 0, 255, 255]);
    assert.equal(event.backgroundBitmap!.width, app.options.viewports[index].physicalBounds.width);
    assert.equal(event.backgroundBitmap!.height, app.options.viewports[index].physicalBounds.height);
  }
  app.overlays.dispose();
});

test('每屏背景和跨屏选框独立投影，混合 DPI 与负坐标不共用比例', async () => {
  const app = harness();
  await app.overlays.show(app.options);
  assert.deepEqual(app.crops, [
    { x: 0, y: 0, width: 2560, height: 1440 },
    { x: 2560, y: 0, width: 1920, height: 1080 },
  ]);
  for (let index = 0; index < app.windows.length; index++) {
    const window = app.windows[index];
    assert.equal(window.visible, true);
    assert.equal(window.options.focusable, false);
    assert.equal(window.options.show, false);
    assert.equal(window.options.x, app.options.viewports[index].bounds.x);
    assert.deepEqual(window.bounds, app.options.viewports[index].bounds);
    assert.ok(window.calls.indexOf('setBounds') > window.calls.indexOf('showInactive'), '显示后恢复整屏范围，不能只依赖构造尺寸');
    const start = window.sent[0];
    assert.equal(start.type, 'start');
    if (start.type !== 'start') throw new Error('缺少 start');
    assert.deepEqual(start.shortcut, ['AltRight']);
    assert.equal(start.color, '#F90040');
  }
  app.overlays.frame({ x: -300, y: 100 }, { x: 200, y: 500 });
  const frames = app.windows.map(window => window.sent.at(-1));
  assert.deepEqual(frames.map(event => event?.type === 'frame' ? event.rect : null), [
    { x: 1130, y: 50, width: 250, height: 200 },
    { x: -300, y: 100, width: 500, height: 400 },
  ]);
  assert.deepEqual(frames.map(event => event?.type === 'frame' ? event.showSize : null), [false, true]);
  assert.deepEqual(frames.map(event => event?.type === 'frame' ? event.physicalSize : null), [
    { width: 500, height: 400 }, { width: 500, height: 400 },
  ]);
  app.overlays.frame(undefined, { x: -100, y: 100 });
  assert.equal(app.windows[0].sent.at(-1)?.type, 'frame');
  assert.equal((app.windows[0].sent.at(-1) as any).rect, undefined);
  app.overlays.close();
  assert.equal(app.cancelled(), 0);
});

test('异步加载期间取消保持隐藏，后续会话复用同一窗口且只显示最新内容', async () => {
  const first = deferred(), second = deferred();
  const app = harness([first.promise, second.promise]);
  const oldShow = app.overlays.show(app.options);
  const oldWindows = [...app.windows];
  app.overlays.frame({ x: -300, y: 100 }, { x: 200, y: 500 });
  app.overlays.close();
  assert.ok(oldWindows.every(window => !window.destroyed && !window.visible));
  const newShow = app.overlays.show({ ...app.options, sessionId: 'session-2' });
  first.resolve(); second.resolve(); await Promise.all([oldShow, newShow]);
  assert.equal(app.windows.length, 2);
  assert.ok(oldWindows.every(window => window.visible && !window.destroyed && app.overlays.owns(window.webContents)));
  assert.ok(oldWindows.every(window => window.sent[0].sessionId === 'session-2'));
  assert.equal(app.cancelled(), 0);
  app.overlays.close();
});

test('预加载保持隐藏，结束会话清空背景，下一次使用同一页面', async () => {
  const app = harness();
  await app.overlays.prepare(app.options.viewports);
  assert.equal(app.windows.length, 2);
  assert.ok(app.windows.every(window => !window.visible && !window.sent.length));
  assert.equal(app.crops.length, 0);
  await app.overlays.show(app.options);
  app.overlays.close();
  for (const window of app.windows) {
    assert.equal(window.visible, false);
    assert.equal(window.destroyed, false);
    assert.equal(window.sent.at(-1)?.type, 'cancel');
    assert.equal(window.sent.at(-1)?.sessionId, 'session-1');
  }
  await app.overlays.show({ ...app.options, sessionId: 'session-2' });
  assert.equal(app.windows.length, 2);
  assert.ok(app.windows.every(window => window.sent.at(-1)?.sessionId === 'session-2'));
  app.overlays.dispose();
  assert.ok(app.windows.every(window => window.destroyed && !app.overlays.owns(window.webContents)));
  assert.equal(app.cancelled(), 0);
});

test('加载尚未完成时取消，迟到完成只保留隐藏预载页面', async () => {
  const first = deferred(), second = deferred();
  const app = harness([first.promise, second.promise]);
  const showing = app.overlays.show(app.options);
  app.overlays.close();
  first.resolve(); second.resolve(); await showing;
  assert.ok(app.windows.every(window => !window.visible && !window.destroyed && !window.sent.length));
  app.overlays.dispose();
});

test('预加载失败销毁半成品，下一次可以重新创建', async () => {
  const app = harness([Promise.reject(new Error('页面加载失败'))]);
  await assert.rejects(app.overlays.prepare(app.options.viewports), /页面加载失败/);
  assert.ok(app.windows.every(window => window.destroyed));
  await app.overlays.show(app.options);
  assert.equal(app.windows.length, 4);
  assert.ok(app.windows.slice(2).every(window => window.visible));
  app.overlays.dispose();
  assert.equal(app.cancelled(), 0);
});

test('布局变化销毁旧池，迟到加载不会恢复旧屏，退出会彻底释放新池', async () => {
  const first = deferred(), second = deferred();
  const app = harness([first.promise, second.promise]);
  const showing = app.overlays.show(app.options);
  const oldWindows = [...app.windows];
  const nextViewports = [app.options.viewports[1]];
  await app.overlays.prepare(nextViewports);
  first.resolve(); second.resolve(); await showing;
  assert.ok(oldWindows.every(window => window.destroyed && !window.visible && !window.sent.length));
  const nextWindow = app.windows[2];
  assert.equal(nextWindow.visible, false);
  await app.overlays.show({ ...app.options, viewports: nextViewports, sessionId: 'session-2' });
  assert.equal(app.windows.length, 3);
  assert.equal(nextWindow.visible, true);
  app.overlays.dispose();
  assert.ok(app.windows.every(window => window.destroyed));
  assert.equal(app.cancelled(), 0);
});

test('渲染进程退出作废整池并取消当前会话，下一次可重新预加载', async () => {
  const app = harness();
  await app.overlays.show(app.options);
  const oldWindows = [...app.windows];
  app.windows[0].webHandlers.get('render-process-gone')!();
  assert.equal(app.cancelled(), 1);
  assert.ok(oldWindows.every(window => window.destroyed));
  await app.overlays.prepare(app.options.viewports);
  assert.equal(app.windows.length, 4);
  assert.ok(app.windows.slice(2).every(window => !window.visible));
  app.overlays.dispose();
  assert.equal(app.cancelled(), 1);
});

test('125% 系统舍入后按实际内容尺寸投影，背景和选框不相差一 DIP', async () => {
  const app = harness([], [1, 0]);
  app.options.viewports[0] = {
    bounds: { x: -2048, y: 0, width: 2048, height: 1153 },
    physicalBounds: { x: -2560, y: 0, width: 2560, height: 1442 },
  };
  app.options.physicalBounds.height = 1442;
  app.options.background.getSize = () => ({ width: 4480, height: 1442 });
  await app.overlays.show(app.options);
  const window = app.windows[0], start = window.sent[0];
  assert.equal(start.type, 'start');
  if (start.type !== 'start') throw new Error('缺少 start');
  assert.equal(start.height, 1154);
  assert.equal(app.options.viewports[0].bounds.height, 1153, '不能改写会话保存的原始显示器配置');
  assert.deepEqual(window.calls, ['showInactive', 'setBounds', 'getContentBounds']);
  app.overlays.frame({ x: -2560, y: 0 }, { x: 0, y: 1442 });
  const frame = window.sent.at(-1);
  assert.equal(frame?.type, 'frame');
  if (frame?.type !== 'frame') throw new Error('缺少 frame');
  assert.deepEqual(frame.rect, { x: 0, y: 0, width: 2048, height: 1154 });
  assert.deepEqual(frame.physicalSize, { width: 2560, height: 1442 });
  app.overlays.close();
});

test('加载期间保留最后选框和最新图片数量，所有屏幕收到同一上下文', async () => {
  const first = deferred(), second = deferred();
  const app = harness([first.promise, second.promise]);
  const showing = app.overlays.show(app.options);
  const context: CaptureContext = { ...app.options.context, images: [{ id: 'one', title: '选区 1', imageDataUrl: 'fixture-1' }] };
  app.overlays.frame({ x: -300, y: 100 }, { x: 200, y: 500 });
  app.overlays.image(context, { x: -300, y: 100, width: 500, height: 400 });
  first.resolve(); second.resolve(); await showing;
  for (const window of app.windows) {
    const start = window.sent[0];
    assert.equal(start.type, 'start');
    assert.equal(start.type === 'start' ? start.context.images.length : -1, 1);
    assert.equal(window.sent.at(-1)?.type, 'frame');
  }
  const next = { ...context, images: [...context.images, { id: 'two', title: '选区 2', imageDataUrl: 'fixture-2' }] };
  app.overlays.image(next, { x: -300, y: 100, width: 500, height: 400 });
  for (const window of app.windows) {
    const event = window.sent.at(-1);
    assert.equal(event?.type, 'image');
    assert.equal(event?.type === 'image' ? event.context.images.length : -1, 2);
  }
  assert.deepEqual(app.windows.map(window => (window.sent.at(-1) as any).rect), [
    { x: 1130, y: 50, width: 250, height: 200 },
    { x: -300, y: 100, width: 500, height: 400 },
  ]);
  app.overlays.close();
});
