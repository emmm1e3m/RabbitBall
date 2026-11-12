import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { imageCropRect, selectionRect, unionBounds } from '../electron/capture-geometry.ts';
import { ClipboardStore } from '../electron/clipboard.ts';
import type { Activation, CursorPoint } from '../electron/contracts.ts';

const WINDOW_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jTQAAAABJRU5ErkJggg==';

type PanelView = Activation['view'];
type IpcHandler = (...args: unknown[]) => unknown;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function desktop(focusResult: Promise<boolean> = Promise.resolve(false), clipboardResult: Promise<void> = Promise.resolve(), hasWindow = true, frameResult: Promise<void> = Promise.resolve(), captureFrame: { bounds?: { x: number; y: number; width: number; height: number }; cursor?: { x: number; y: number }; width?: number; height?: number; captureError?: string | null; imageWidth?: number; imageHeight?: number; background?: boolean; windowImage?: boolean } = {}) {
  const calls: string[] = [];
  const captureRequests: any[] = [], decodedWindowImages: string[] = [];
  const sent: Array<{ channel: string; value: unknown }> = [];
  const clipboardWrites: unknown[] = [];
  const effects: any[] = [];
  let clearedEffects = 0;
  const handlers = new Map<string, IpcHandler>();
  const settings = { autoCopyScreenshots: true, eyeColor: '#F90040', activationShortcut: ['AltLeft'], followMouse: true,
    graphPluginEnabled: true, graphModeEnabled: false, pauseOnFullscreen: true };
  const state = { focusable: false, ignoreMouse: true, visible: false, opacity: 1 };
  let bounds = { x: 0, y: 0, width: 1440, height: 900 };
  const webContents = {
    mainFrame: {},
    capturePage(rect: unknown, options: unknown) {
      calls.push('capture:frame');
      assert.equal(JSON.stringify(rect), JSON.stringify({ x: 0, y: 0, width: 1, height: 1 }));
      assert.equal(JSON.stringify(options), JSON.stringify({ stayHidden: true }));
      return frameResult;
    },
    focus() { calls.push('webContents.focus'); },
    send(channel: string, value: unknown) { sent.push({ channel, value }); },
  };
  const window = {
    webContents,
    isDestroyed: () => false,
    isVisible: () => state.visible,
    isFocused: () => false,
    isFocusable: () => state.focusable,
    setFocusable(value: boolean) { state.focusable = value; calls.push('focusable:' + value); },
    setSkipTaskbar() { calls.push('skipTaskbar'); },
    setIgnoreMouseEvents(value: boolean) { state.ignoreMouse = value; calls.push('ignoreMouse:' + value); },
    setAlwaysOnTop() { calls.push('alwaysOnTop'); },
    setOpacity(value: number) { state.opacity = value; calls.push('opacity:' + value); },
    setBounds(value: typeof bounds) { bounds = value; calls.push('bounds:' + value.x + ',' + value.y); },
    getBounds: () => ({ ...bounds }),
    getPosition: () => [bounds.x, bounds.y],
    getNativeWindowHandle: () => Buffer.from([42, 0, 0, 0, 0, 0, 0, 0]),
    show() { state.visible = true; calls.push('show'); },
    showInactive() { state.visible = true; calls.push('showInactive'); },
    focus() { calls.push('focus'); },
    moveTop() { calls.push('window.moveTop'); },
    hide() { state.visible = false; calls.push('hide'); },
  };
  const native = {
    configure(config: { allowOwnForeground: boolean }) { calls.push('native.ownForeground:' + config.allowOwnForeground); return Promise.resolve(); },
    cancelCapture() { calls.push('native.cancelCapture'); },
    cancelFocus() { calls.push('cancelFocus'); },
    focusWindow(handle: string) {
      assert.equal(handle, '42');
      calls.push('native.focus');
      return focusResult;
    },
  };

  const image = (width = 1440, height = 900, content = 'window-image') => ({
    isEmpty: () => false, getSize: () => ({ width, height }),
    crop: (rect: { width: number; height: number }) => { calls.push('image.crop:' + content); return image(rect.width, rect.height, content); },
    resize: (size: { width: number; height: number }) => image(size.width, size.height, content),
    toJPEG: () => Buffer.from(content), toPNG: () => Buffer.from(content), toDataURL: () => 'data:image/png;base64,' + Buffer.from(content).toString('base64'),
  });

  // 执行真正的主进程函数，只移除模块导入与应用启动，替换 Electron 边界。
  const source = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');
  const startup = source.indexOf('\nconst quitRequested =');
  assert.ok(startup > 0, '应用启动入口必须与待测函数分开');
  const module = source.slice(0, startup)
    .replace(/^import .*;\r?\n/gm, '')
    .replace(/^const execFileAsync = .*;\r?\n/m, '')
    .replace(/^const here = .*;\r?\n/m, '');
  const context = {
    __window: window, __native: native,
    __effect: { play: async (...args: unknown[]) => { effects.push(args); }, clear() { clearedEffects++; } },
    __store: { getPublic: () => ({ ...settings }), async save(patch: Partial<typeof settings>) { Object.assign(settings, patch); return { ...settings }; } },
    __graphJobs: { cancelAll() { calls.push('jobs.cancelAll'); } },
    __overlays: { close() { calls.push('overlays.close'); }, show: async () => { calls.push('overlays.show'); }, frame() {}, image() {}, owns: () => false },
    here: '.', path, randomUUID, imageCropRect, selectionRect, unionBounds, nativeShortcut: (v: unknown) => v, validateSettingsPatch: (v: unknown) => v,
    markCaptureCursor: (value: unknown) => value,
    nativeImage: { createFromBuffer: (value: Buffer) => { decodedWindowImages.push(value.toString('base64')); return image(captureFrame.imageWidth ?? 1440, captureFrame.imageHeight ?? 900); },
      createFromDataURL: (value: string) => { decodedWindowImages.push(value); return image(captureFrame.imageWidth ?? 1440, captureFrame.imageHeight ?? 900); },
      createFromBitmap: () => image(captureFrame.width ?? 1440, captureFrame.height ?? 900, 'desktop-image'), createEmpty: () => ({ isEmpty: () => true }) },
    CaptureWorker: class {
      async capture(request: { type: string; backgroundBounds?: unknown }) {
        captureRequests.push(JSON.parse(JSON.stringify(request)));
        calls.push('capture:' + request.type);
        const withBackground = captureFrame.background !== false && (request.type === 'desktop' || request.backgroundBounds !== undefined);
        return { handle: hasWindow ? '77' : '0', title: '公开应用窗口', processId: 99,
          bounds: captureFrame.bounds ?? { x: 0, y: 0, width: hasWindow ? 1440 : 0, height: hasWindow ? 900 : 0 }, cursor: captureFrame.cursor ?? { x: 300, y: 200 },
          ...(withBackground ? { desktopBitmap: Buffer.alloc(4), desktopWidth: captureFrame.width ?? 1440, desktopHeight: captureFrame.height ?? 900 } : {}),
          ...(request.type === 'window' && hasWindow && captureFrame.windowImage !== false ? { imageBase64: WINDOW_PNG, imageWidth: captureFrame.imageWidth ?? 1440, imageHeight: captureFrame.imageHeight ?? 900 } : {}),
          ...(hasWindow ? { captureError: captureFrame.captureError ?? undefined } : { captureError: captureFrame.captureError === null ? undefined : captureFrame.captureError ?? '没有合适的应用窗口' }),
        };
      }
    },
    Buffer, Blob, AbortController, ClipboardStore,
    ClipboardItem: class {
      data: unknown;
      constructor(data: unknown) { this.data = data; }
    },
    clipboard: { async read() { return []; }, write(items: unknown) { clipboardWrites.push(items); return clipboardResult; } },
    process: { platform: 'win32', env: {}, pid: 42 },
    screen: {
      getCursorScreenPoint: () => ({ x: 700, y: 420 }),
      getAllDisplays: () => [{ bounds: { x: 0, y: 0, width: 1440, height: 900 } }],
      dipToScreenRect: (_window: unknown, rect: unknown) => rect,
      dipToScreenPoint: (point: unknown) => point,
      screenToDipPoint: (point: unknown) => point,
      screenToDipRect: (_window: unknown, rect: unknown) => rect,
      getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
    },
    ipcMain: {
      handle(channel: string, handler: IpcHandler) { handlers.set(channel, handler); },
      on(channel: string, handler: IpcHandler) { handlers.set(channel, handler); },
    },
    subject: undefined as undefined | {
      showPanel(view: PanelView): void;
      showMainWindow(): void;
      activatePrompt(released?: boolean, nativeId?: number): void;
      focusInput(epoch: unknown): Promise<boolean>;
      hidePanel(reason?: string): void;
      view(): PanelView | undefined;
      setCapture(session: unknown): void;
      completeCapture(session: unknown): Promise<void> | void;
      copyScreenshot(session: unknown, image: unknown): void;
      cancelCapture(notifyNative?: boolean): void;
      captureActive(): boolean;
      context(): unknown;
      clipboardIdle(): Promise<void>;
      beginCapture(released?: boolean, nativeId?: number): void;
      endCapture(): void;
      captureForeground(signal: AbortSignal, bounds?: { x: number; y: number; width: number; height: number }, clean?: boolean): Promise<any>;
      holdCapture(session: unknown): void;
      selectionPointer(phase: string, point: { x: number; y: number }): void;
      session(): any;
      cursor(): any;
      updateGraphPinHover(point: CursorPoint): void;
      nativePointerDown(point: { x: number; y: number }): void;
      nativePointerUp(): void;
      setSuspended(value: boolean): void;
    },
  };
  const bootstrap = `
    window = __window;
    activationEffect = __effect;
    windowsNative = __native;
    store = __store;
    graphJobs = __graphJobs;
    captureOverlays = __overlays;
    registerIpc();
    globalThis.subject = {
      showMainWindow, showPanel, activatePrompt, focusInput, hidePanel, completeCapture, copyScreenshot, cancelCapture,
      beginCapture, endCapture, captureForeground, holdCapture, selectionPointer, updateGraphPinHover, nativePointerDown, nativePointerUp, setSuspended,
      cursor: desktopCursor,
      session: () => captureSession,
      view: () => panelView,
      setCapture: session => { captureSession = session; },
      captureActive: () => !!captureSession,
      context: () => currentContext,
      clipboardIdle: () => clipboardQueue,
    };
  `;
  vm.runInNewContext(stripTypeScriptTypes(module) + bootstrap, context);
  const subject = context.subject!;
  const event = { sender: webContents, senderFrame: webContents.mainFrame };
  const activation = () => sent.findLast(message => message.channel === 'rabbit:activate')!.value as Activation;
  return {
    subject, state, calls, captureRequests, decodedWindowImages, activation, clipboardWrites, screen: context.screen as any, settings,
    bounds: window.getBounds, sent, effects, clearedEffects: () => clearedEffects,
    receivesPointer(_point: { x: number; y: number }) {
      return !state.ignoreMouse;
    },
    send(channel: string, ...args: unknown[]) {
      const handler = handlers.get(channel);
      assert.ok(handler, 'IPC 必须由实际 registerIpc 注册');
      return handler(event, ...args);
    },
  };
}

test('鼠标跨屏只更新跟随目标，兔球物理中心进入新屏才切窗并同步视口', async () => {
  const app = desktop();
  const primary = { bounds: { x: 0, y: 0, width: 1440, height: 900 }, workArea: { x: 0, y: 0, width: 1440, height: 900 } };
  const secondary = { bounds: { x: 1440, y: -816, width: 2752, height: 1153 }, workArea: { x: 1440, y: -816, width: 2752, height: 1108 } };
  app.screen.getAllDisplays = () => [primary, secondary];
  app.screen.getDisplayNearestPoint = () => secondary;
  app.screen.getCursorScreenPoint = () => ({ x: 1600, y: -400 });
  app.screen.dipToScreenRect = (_: unknown, rect: typeof primary.bounds) => rect.x >= 1440
    ? { x: 2880, y: -766, width: rect.width * 1.25, height: rect.height * 1.25 }
    : { x: 0, y: 0, width: rect.width * 2, height: rect.height * 2 };
  app.screen.dipToScreenPoint = () => ({ x: 3080, y: -246 });
  const cursor = app.subject.cursor();
  assert.equal(cursor.x, 1540, '指针在旧屏局部坐标外仍是有效跟随目标');
  assert.equal(cursor.followBounds.x, 1440);
  assert.equal(cursor.followBounds.y, -383);
  assert.deepEqual(app.bounds(), primary.workArea, '不能跟随鼠标立即搬窗');
  app.send('rabbit:pet-position', { x: 2870, y: 300 });
  assert.deepEqual(app.bounds(), primary.workArea);
  app.send('rabbit:pet-position', { x: 2881, y: 300 });
  assert.deepEqual(app.bounds(), secondary.workArea);
  assert.equal(app.state.opacity, 0, '新屏坐标尚未绘制时窗口保持透明');
  assert.ok(app.calls.indexOf('opacity:0') < app.calls.indexOf('bounds:1440,-816'), '原生窗口先变为0，再改变屏幕位置');
  const updated = app.sent.at(-1)!;
  assert.equal(updated.channel, 'rabbit:cursor');
  assert.deepEqual(JSON.parse(JSON.stringify((updated.value as any).viewport)), { x: 2880, y: -766, scale: 1.25 });
  await app.send('rabbit:pet-viewport-ready', (updated.value as any).transitionId - 1);
  assert.equal(app.state.opacity, 0, '旧轮次就绪不能显示本次窗口');
  await app.send('rabbit:pet-viewport-ready', (updated.value as any).transitionId);
  assert.equal(app.state.opacity, 1);
});

test('中心经过屏间空隙时不提前切屏，打开面板后不接受迟到的位置回报', async () => {
  const app = desktop();
  const remote = { bounds: { x: 1800, y: 0, width: 1200, height: 900 }, workArea: { x: 1800, y: 0, width: 1200, height: 860 } };
  app.screen.getAllDisplays = () => [{ bounds: { x: 0, y: 0, width: 1440, height: 900 }, workArea: app.bounds() }, remote];
  app.send('rabbit:pet-position', { x: 1600, y: 200 });
  assert.equal(app.bounds().x, 0);
  app.send('rabbit:pet-position', { x: 1801, y: 200 });
  assert.equal(app.bounds().x, 1800);
  app.screen.getDisplayNearestPoint = () => remote;
  app.subject.showPanel('settings');
  const transitionId = (app.sent.findLast(message => message.channel === 'rabbit:cursor')!.value as any).transitionId;
  assert.equal(app.state.opacity, 0, '跨屏尚未完成时打开面板仍需等待新坐标绘制');
  await app.send('rabbit:pet-viewport-ready', transitionId);
  assert.equal(app.state.opacity, 1);
  app.send('rabbit:pet-position', { x: 100, y: 100 });
  assert.equal(app.bounds().x, 1800);
});

test('关闭跟随的跨屏提问仍立即开框，但等新坐标就绪后才恢复窗口并聚焦', async () => {
  const app = desktop();
  app.send('rabbit:set-interactive', false);
  app.settings.followMouse = false;
  app.state.visible = true;
  const remote = { workArea: { x: 1440, y: -800, width: 2560, height: 1400 } };
  app.screen.getDisplayNearestPoint = () => remote;
  app.subject.showPanel('prompt');
  const activation = app.activation();
  assert.equal(activation.view, 'prompt', '不等待兔球飞到位才提交激活');
  assert.deepEqual(app.bounds(), remote.workArea);
  assert.equal(app.state.opacity, 0);
  assert.equal(app.state.visible, false, '跨屏确认前不能把缓存旧画面的窗口显示到新屏');
  assert.ok(app.calls.indexOf('opacity:0') < app.calls.indexOf('bounds:1440,-800'), '关闭跟随后激活同样先透明再换屏');
  const cursors = app.sent.filter(message => message.channel === 'rabbit:cursor').map(message => message.value as any);
  assert.equal(cursors[0].viewport.x, 0, '先发送旧屏基准，确保首次激活也能重基真实起点');
  assert.equal(cursors[1].viewport.x, 1440);
  assert.equal(await app.subject.focusInput(activation.activationId), false);
  assert.equal(app.calls.includes('native.focus'), false, '隐藏期间不尝试聚焦');
  const id = cursors[1].transitionId;
  assert.equal(await app.send('rabbit:pet-viewport-ready', id - 1), false);
  assert.equal(app.state.opacity, 0);
  assert.equal(await app.send('rabbit:pet-viewport-ready', id), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.state.opacity, 1);
  assert.equal(app.state.visible, true);
  assert.equal(app.calls.includes('native.focus'), true);
  assert.equal(app.state.focusable, true);
});

test('跨屏激活在坐标就绪前取消，ACK只完成坐标同步并恢复宠物，不恢复旧面板', async () => {
  const app = desktop();
  app.send('rabbit:set-interactive', false);
  app.settings.followMouse = false;
  app.screen.getDisplayNearestPoint = () => ({ workArea: { x: -1200, y: 0, width: 1200, height: 900 } });
  app.subject.showPanel('prompt');
  const id = (app.sent.findLast(message => message.channel === 'rabbit:cursor')!.value as any).transitionId;
  await app.subject.focusInput(app.activation().activationId);
  app.subject.hidePanel();
  assert.equal(app.state.visible, false, '取消面板也不能提前暴露正在换屏的旧画面');
  app.calls.length = 0;
  assert.equal(await app.send('rabbit:pet-viewport-ready', id), true);
  assert.equal(app.subject.view(), undefined);
  assert.equal(app.state.opacity, 1, '取消后宠物不应永久透明');
  assert.equal(app.state.visible, true);
  assert.equal(app.calls.includes('focus'), false);
  assert.equal(app.calls.includes('native.focus'), false);
});

test('换屏就绪时若新截图已开始，不能把被隐藏的宠物窗口提前恢复', async () => {
  const app = desktop();
  app.send('rabbit:set-interactive', false);
  app.screen.getDisplayNearestPoint = () => ({ workArea: { x: 1800, y: 0, width: 1200, height: 900 } });
  app.subject.showPanel('prompt');
  const id = (app.sent.findLast(message => message.channel === 'rabbit:cursor')!.value as any).transitionId;
  app.subject.beginCapture(false, 2);
  assert.equal(await app.send('rabbit:pet-viewport-ready', id), true);
  assert.equal(app.state.visible, false);
  assert.equal(app.calls.includes('native.focus'), false);
  app.subject.cancelCapture();
  assert.equal(app.state.visible, true);
});

test('短按只截应用窗口，不冻结屏幕或进入手动框选', async () => {
  const app = desktop();
  app.subject.beginCapture(false, 1);
  assert.equal(app.calls.some(call => call.startsWith('capture:')), false);
  app.subject.endCapture();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(app.calls.filter(call => call.startsWith('capture:')), ['capture:window']);
  assert.equal(app.activation().context?.images.length, 1);
  assert.equal(app.activation().context?.title, '公开应用窗口');
  assert.deepEqual(app.captureRequests, [{ type: 'window' }], '普通聊天不请求桌面背景');
  assert.deepEqual(app.decodedWindowImages, [WINDOW_PNG]);
  assert.equal(app.activation().context?.images[0].imageDataUrl, 'data:image/jpeg;base64,' + Buffer.from('window-image').toString('base64'));
});

test('长按直接框选屏幕，即使没有应用窗口也能选区且不附加应用图', async () => {
  const app = desktop(Promise.resolve(false), Promise.resolve(), false);
  app.subject.beginCapture(false, 1);
  app.subject.holdCapture(app.subject.session());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.calls.includes('overlays.show'), true);
  app.subject.selectionPointer('down', { x: 100, y: 80 });
  app.subject.selectionPointer('up', { x: 400, y: 200 });
  app.subject.endCapture();
  assert.deepEqual(app.calls.filter(call => call.startsWith('capture:')), ['capture:desktop']);
  assert.deepEqual(app.captureRequests, [{ type: 'desktop', bounds: { x: 0, y: 0, width: 1440, height: 900 } }]);
  assert.equal(app.activation().context?.title, '屏幕选区');
  assert.equal(app.activation().context?.images.length, 1);
  assert.equal(app.activation().context?.images[0].cursor, undefined);
});

test('长按没有拖选时不回退应用截图，短按无应用时也不附加桌面图', async () => {
  const manual = desktop();
  manual.subject.beginCapture(false, 1);
  manual.subject.holdCapture(manual.subject.session());
  await new Promise(resolve => setImmediate(resolve));
  manual.subject.endCapture();
  assert.equal(manual.activation().context?.images.length, 0);
  assert.deepEqual(manual.calls.filter(call => call.startsWith('capture:')), ['capture:desktop']);
  const short = desktop(Promise.resolve(false), Promise.resolve(), false);
  short.subject.beginCapture(true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(short.activation().context?.images.length, 0);
  assert.equal(short.activation().context?.error, '没有合适的应用窗口');
});

test('取消后迟到的屏幕快照不会显示截图层或重新打开聊天', async () => {
  const app = desktop();
  app.subject.beginCapture(false, 1);
  app.subject.holdCapture(app.subject.session());
  app.subject.cancelCapture();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.calls.includes('overlays.show'), false);
  assert.equal(app.subject.view(), undefined);
});

test('自动聚焦失败后提示框仍保留可聚焦、可点击的输入态', async () => {
  const app = desktop();
  app.subject.showPanel('prompt');
  assert.equal(app.calls.includes('focus'), false, '输入界面呈现前不抢前台焦点');
  app.send('rabbit:set-interactive', true, app.activation().activationId);

  assert.equal(await app.subject.focusInput(app.activation().activationId), false);
  assert.equal(app.subject.view(), 'prompt');
  assert.equal(app.state.visible, true);
  assert.equal(app.state.focusable, true);
  assert.equal(app.state.ignoreMouse, false);
});

test('退出图谱后固定卡悬停和本体交互互不覆盖，移出后穿透且不抢键盘', async () => {
  const app = desktop();
  let pointer = { x: 120, y: 80 };
  app.screen.getCursorScreenPoint = () => pointer;
  app.subject.showPanel('graph'); await app.subject.focusInput(app.activation().activationId);
  app.send('rabbit:set-graph-pin-regions', { rects: [{ x: 100, y: 60, width: 160, height: 120 }] });
  app.calls.length = 0; app.subject.hidePanel();
  assert.equal(app.subject.view(), undefined); assert.equal(app.state.ignoreMouse, false); assert.equal(app.state.focusable, true);
  app.send('rabbit:set-interactive', true);
  assert.equal(app.state.focusable, true, '固定条提前允许系统点击激活，不依赖鼠标悬停');
  app.send('rabbit:set-interactive', false);
  assert.equal(app.state.ignoreMouse, false, '宠物失去命中也不能覆盖固定卡片命中');
  assert.equal(app.state.ignoreMouse, false, '当前光标仍在固定条内');
  assert.equal(app.calls.some(call => ['focus', 'native.focus', 'webContents.focus'].includes(call)), false);
  pointer = { x: 280, y: 80 }; app.subject.updateGraphPinHover(app.subject.cursor());
  assert.equal(app.receivesPointer(pointer), false); assert.equal(app.state.focusable, true);
  assert.equal(app.state.ignoreMouse, true, '移开固定条后恢复本体穿透');
  app.send('rabbit:set-interactive', true);
  assert.equal(app.state.ignoreMouse, false); assert.equal(app.state.focusable, true, '离开固定条后宠物原有交互仍有效');
  app.send('rabbit:set-interactive', false);
  assert.equal(app.receivesPointer(pointer), false);
  assert.equal(app.calls.some(call => ['show', 'focus', 'native.focus', 'webContents.focus'].includes(call)), false, '区域与悬停更新均不主动聚焦');
});

test('固定卡片由系统点击激活，原生按住拖选越界且不异步抢焦点', async () => {
  const app = desktop();
  let pointer = { x: 120, y: 80 };
  app.screen.getCursorScreenPoint = () => pointer;
  app.send('rabbit:set-graph-pin-regions', { rects: [{ x: 100, y: 60, width: 160, height: 120 }] });
  assert.equal(app.state.focusable, true);
  app.calls.length = 0;
  app.subject.nativePointerDown(pointer);
  assert.equal(app.send('rabbit:graph-pin-interaction', { phase: 'down', point: pointer }), true);
  pointer = { x: 420, y: 240 }; app.subject.updateGraphPinHover(app.subject.cursor());
  assert.equal(app.state.ignoreMouse, false, '按住拖选越界时继续接收输入');
  assert.equal(await app.send('rabbit:graph-pin-interaction', { phase: 'up', point: pointer }), true);
  assert.equal(app.state.ignoreMouse, true);
  assert.equal(app.state.focusable, true, '保留系统选择焦点供 Ctrl+C 使用');
  app.subject.nativePointerUp();
  pointer = { x: 120, y: 80 }; app.subject.updateGraphPinHover(app.subject.cursor());
  assert.equal(app.state.ignoreMouse, false);
  assert.equal(app.calls.some(call => ['focusable:true', 'focusable:false', 'show', 'focus', 'native.focus', 'webContents.focus', 'cancelFocus'].includes(call)), false);
});

test('固定卡丢失页面松开事件时，原生释放立即恢复穿透且迟到页面down不能重新锁住', async () => {
  const app = desktop(), point = { x: 700, y: 420 }, outside = { x: 1100, y: 700 };
  let pointer = point;
  app.screen.getCursorScreenPoint = () => pointer;
  app.send('rabbit:set-graph-pin-regions', { rects: [{ x: 680, y: 400, width: 80, height: 80 }] });
  app.subject.nativePointerDown(point);
  pointer = outside; app.subject.updateGraphPinHover(app.subject.cursor());
  assert.equal(app.state.ignoreMouse, false);
  app.subject.nativePointerUp();
  assert.equal(app.state.ignoreMouse, true);
  assert.equal(await app.send('rabbit:graph-pin-interaction', { phase: 'down', point }), true, '迟到页面事件仍可验证卡片点击');
  assert.equal(app.state.ignoreMouse, true, '已释放的原生按压不能被迟到down复活');
  app.subject.updateGraphPinHover(app.subject.cursor());
  assert.equal(app.state.ignoreMouse, true);
  assert.equal(await app.send('rabbit:graph-pin-interaction', { phase: 'up', point }), false);
  app.calls.length = 0; app.subject.nativePointerUp();
  assert.deepEqual(app.calls, []);
  pointer = point; app.subject.updateGraphPinHover(app.subject.cursor());
  assert.equal(app.state.ignoreMouse, false, '重回卡片可正常交互');
});

test('下一次区域外原生按下清除固定卡遗留按压', async () => {
  const app = desktop(), point = { x: 700, y: 420 }, outside = { x: 1100, y: 700 };
  app.send('rabbit:set-graph-pin-regions', { rects: [{ x: 680, y: 400, width: 80, height: 80 }] });
  app.subject.nativePointerDown(point);
  await app.send('rabbit:graph-pin-interaction', { phase: 'down', point });
  app.subject.nativePointerDown(outside);
  assert.equal(app.state.ignoreMouse, true);
  assert.equal(await app.send('rabbit:graph-pin-interaction', { phase: 'up', point }), false);
});

test('固定卡片拒绝无效或非卡片按下，清空区域结束按压且不保留焦点任务', async () => {
  const app = desktop();
  const point = { x: 700, y: 420 };
  app.send('rabbit:set-graph-pin-regions', { rects: [{ x: 680, y: 400, width: 80, height: 80 }] });
  for (const value of [null, { phase: 'down' }, { phase: 'down', point: { x: NaN, y: 420 } }, { phase: 'move', point }, { phase: 'down', point: { x: 500, y: 420 } }, { phase: 'up', point }]) {
    assert.equal(await app.send('rabbit:graph-pin-interaction', value), false);
  }
  assert.equal(app.calls.includes('native.focus'), false);
  app.subject.nativePointerDown(point);
  assert.equal(await app.send('rabbit:graph-pin-interaction', { phase: 'down', point }), true);
  app.send('rabbit:set-graph-pin-regions', { rects: [] });
  assert.equal(app.state.focusable, false); assert.equal(app.state.ignoreMouse, true);
  assert.equal(await app.send('rabbit:graph-pin-interaction', { phase: 'up', point }), false, '区域消失后迟到松开无效');
  assert.equal(app.calls.some(call => ['focus', 'native.focus', 'webContents.focus', 'cancelFocus'].includes(call)), false, '固定卡交互不创建或取消异步焦点任务');
});

test('原生按下使用事件坐标而非随后鼠标位置，并按当前窗口 DPI 转换', async () => {
  const app=desktop(Promise.resolve(true));
  app.screen.dipToScreenRect=(_:unknown,rect:{x:number;y:number;width:number;height:number})=>({x:rect.x*1.5,y:rect.y*1.5,width:rect.width*1.5,height:rect.height*1.5});
  app.screen.dipToScreenPoint=(point:{x:number;y:number})=>({x:point.x*1.5,y:point.y*1.5});
  app.screen.screenToDipPoint=(point:{x:number;y:number})=>({x:point.x/1.5,y:point.y/1.5});
  const point={x:120,y:80};
  app.send('rabbit:set-graph-pin-regions',{rects:[{x:100,y:60,width:160,height:120}]});
  await app.send('rabbit:graph-pin-interaction',{phase:'down',point});
  await app.send('rabbit:graph-pin-interaction',{phase:'up',point});
  app.subject.nativePointerDown({x:180,y:120});
  assert.equal(app.state.focusable,true,'按下发生在卡片内部，随后鼠标移出不能清除选择焦点');
  const event=app.sent.findLast(item=>item.channel==='rabbit:pointer-down')!;
  assert.equal(JSON.stringify(event.value),JSON.stringify(point));
  app.subject.nativePointerDown({x:750,y:600});
  assert.equal(app.receivesPointer({x:500,y:400}),false,'实际发生在外部的下一次点击透传给所属窗口');
  assert.equal(app.calls.includes('native.focus'),false,'内外点击均不主动重取焦点');
});

test('固定卡片交互在打开面板、截图或停用后失效，迟到松开不影响新视图', async () => {
  for (const transition of ['panel', 'capture', 'disabled'] as const) {
    const app = desktop(), point = { x: 700, y: 420 };
    app.send('rabbit:set-graph-pin-regions', { rects: [{ x: 680, y: 400, width: 80, height: 80 }] });
    assert.equal(await app.send('rabbit:graph-pin-interaction', { phase: 'down', point }), true);
    if (transition === 'panel') app.subject.showPanel('settings');
    else if (transition === 'capture') app.subject.beginCapture(false, 50);
    else await app.send('rabbit:save-settings', { graphPluginEnabled: false });
    const before = { focusable: app.state.focusable, ignoreMouse: app.state.ignoreMouse };
    assert.equal(await app.send('rabbit:graph-pin-interaction', { phase: 'up', point }), false);
    assert.deepEqual({ focusable: app.state.focusable, ignoreMouse: app.state.ignoreMouse }, before);
    assert.equal(app.calls.includes('native.focus'), false, '固定卡没有可能迟到的原生聚焦请求');
    if (transition === 'capture') app.subject.cancelCapture();
  }
});

test('移除固定区域或停用插件立即恢复穿透，重新启用需要新区域回报', async () => {
  const app = desktop(), regions = { rects: [{ x: 680, y: 400, width: 80, height: 80 }] };
  app.send('rabbit:set-graph-pin-regions', regions);
  assert.equal(app.state.ignoreMouse, false); assert.equal(app.state.focusable, true);
  app.send('rabbit:set-graph-pin-regions', { rects: [] });
  assert.equal(app.state.ignoreMouse, true);
  app.send('rabbit:set-graph-pin-regions', regions);
  assert.equal(app.state.ignoreMouse, false);
  await app.send('rabbit:save-settings', { graphPluginEnabled: false });
  assert.equal(app.state.ignoreMouse, true); assert.equal(app.state.focusable, false);
  app.send('rabbit:set-graph-pin-regions', regions); app.subject.updateGraphPinHover(app.subject.cursor());
  assert.equal(app.state.ignoreMouse, true, '停用期间不能被迟到区域重新打开鼠标命中');
  await app.send('rabbit:save-settings', { graphPluginEnabled: true });
  app.subject.updateGraphPinHover(app.subject.cursor());
  assert.equal(app.state.ignoreMouse, true, '旧区域在停用时已清理');
  app.send('rabbit:set-graph-pin-regions', regions);
  assert.equal(app.state.ignoreMouse, false); assert.equal(app.state.focusable, true);
});

test('固定条命中不能绕过图谱就绪阶段、截图占用或全屏暂停', async () => {
  const app = desktop(), regions = { rects: [{ x: 680, y: 400, width: 80, height: 80 }] };
  app.send('rabbit:set-graph-pin-regions', regions);
  app.subject.showPanel('graph');
  app.send('rabbit:set-graph-pin-regions', regions); app.subject.updateGraphPinHover(app.subject.cursor());
  app.send('rabbit:set-interactive', true, app.activation().activationId);
  assert.equal(app.state.ignoreMouse, true); assert.equal(app.state.focusable, false, '图谱仍须完成真实就绪握手');
  await app.subject.focusInput(app.activation().activationId);
  app.subject.hidePanel();
  assert.equal(app.state.ignoreMouse, false); assert.equal(app.state.focusable, true);
  app.subject.beginCapture(false, 20); app.subject.updateGraphPinHover(app.subject.cursor());
  app.send('rabbit:set-graph-pin-regions', regions);
  assert.equal(app.state.ignoreMouse, true); assert.equal(app.state.focusable, false);
  assert.equal(app.state.visible, false, '截图占用时主窗隐藏，截图层独立显示');
  app.subject.cancelCapture();
  assert.equal(app.state.ignoreMouse, false); assert.equal(app.state.focusable, true);
  app.subject.setSuspended(true); app.send('rabbit:set-graph-pin-regions', regions);
  assert.equal(app.state.visible, false); assert.equal(app.state.ignoreMouse, true); assert.equal(app.state.focusable, false);
  app.subject.setSuspended(false);
  assert.equal(app.state.ignoreMouse, false); assert.equal(app.state.focusable, true);
});

test('固定条以窗口局部DIP命中负原点高DPI屏幕，并等待换屏完成', async () => {
  const app = desktop(), area = { x: -1280, y: -400, width: 1280, height: 800 };
  let pointer = { x: -1100, y: -200 };
  app.screen.getDisplayNearestPoint = () => ({ workArea: area });
  app.screen.getCursorScreenPoint = () => pointer;
  app.screen.dipToScreenRect = (_: unknown, rect: typeof area) => ({ x: rect.x * 1.5, y: rect.y * 1.5, width: rect.width * 1.5, height: rect.height * 1.5 });
  app.screen.dipToScreenPoint = (point: typeof pointer) => ({ x: point.x * 1.5, y: point.y * 1.5 });
  app.subject.showPanel('graph');
  const transition = (app.sent.findLast(item => item.channel === 'rabbit:cursor')!.value as CursorPoint).transitionId;
  app.subject.hidePanel();
  assert.equal(app.subject.cursor().x, 180); assert.equal(app.subject.cursor().y, 200);
  app.send('rabbit:set-graph-pin-regions', { rects: [{ x: 160, y: 190, width: 60, height: 40 }] });
  assert.equal(app.state.ignoreMouse, true); assert.equal(app.state.focusable, false, '坐标切换期间固定条仍不可命中');
  app.calls.length = 0; await app.send('rabbit:pet-viewport-ready', transition);
  assert.equal(app.state.ignoreMouse, false); assert.equal(app.state.focusable, true);
  assert.equal(app.calls.some(call => ['focus', 'native.focus', 'webContents.focus'].includes(call)), false);
  pointer = { x: -900, y: -200 }; app.subject.updateGraphPinHover(app.subject.cursor());
  assert.equal(app.receivesPointer(app.subject.cursor()), false); assert.equal(app.state.focusable, true);
  pointer = { x: -1100, y: -200 }; app.subject.updateGraphPinHover(app.subject.cursor());
  assert.equal(app.state.ignoreMouse, false, '重新进入局部 DIP 区域后接收下一次点击');
});

test('设置与已呈现的提问共用 Electron 窗口激活路径', async () => {
  const settings = desktop();
  settings.subject.showPanel('settings');
  settings.send('rabbit:set-interactive', true, settings.activation().activationId);
  const prompt = desktop();
  prompt.subject.showPanel('prompt');
  prompt.send('rabbit:set-interactive', true, prompt.activation().activationId);
  await prompt.subject.focusInput(prompt.activation().activationId);
  const activationCalls = (calls: string[]) => calls.filter(call => ['show', 'focus', 'webContents.focus'].includes(call));
  assert.deepEqual(activationCalls(settings.calls), ['show', 'focus', 'webContents.focus']);
  assert.deepEqual(activationCalls(prompt.calls).slice(0, 3), activationCalls(settings.calls));
  assert.ok(prompt.calls.indexOf('native.focus') > prompt.calls.indexOf('webContents.focus'));
});

test('旧轮次的关闭或交互事件不能覆盖新的提问或设置', () => {
  for (const view of ['prompt', 'settings'] as const) {
    const app = desktop();
    app.subject.showPanel('prompt');
    const staleEpoch = app.activation().activationId;
    app.subject.showPanel(view);
    const snapshot = { ...app.state };
    app.calls.length = 0;

    app.send('rabbit:hide-panel', staleEpoch);
    app.send('rabbit:set-interactive', false, staleEpoch);
    assert.equal(app.subject.view(), view);
    assert.deepEqual(app.state, snapshot);
    assert.deepEqual(app.calls, []);

    // 当前轮次仍可正常关闭，不能只靠忽略所有 renderer 事件通过检查。
    app.send('rabbit:hide-panel', app.activation().activationId);
    assert.equal(app.subject.view(), undefined);
    assert.equal(app.state.focusable, false);
  }
});

test('已取消的聚焦请求迟到返回不会改变新的界面', async () => {
  for (const view of ['prompt', 'settings'] as const) {
    const result = deferred<boolean>();
    const app = desktop(result.promise);
    app.subject.showPanel('prompt');
    app.send('rabbit:set-interactive', true, app.activation().activationId);
    const focusing = app.subject.focusInput(app.activation().activationId);
    assert.ok(app.calls.includes('native.focus'));
    assert.equal(app.state.focusable, true);
    assert.equal(app.state.ignoreMouse, false, '鼠标位于输入框时，原生聚焦等待不应继续强制穿透');
    app.subject.hidePanel('test-cancel');
    app.subject.showPanel(view);
    const snapshot = { ...app.state };
    app.calls.length = 0;

    result.resolve(true);
    assert.equal(await focusing, false);
    assert.equal(app.subject.view(), view);
    assert.deepEqual(app.state, snapshot);
    assert.deepEqual(app.calls, []);
  }
});

test('旧轮次的聚焦请求在触及窗口前被拒绝', async () => {
  const app = desktop();
  app.subject.showPanel('prompt');
  const staleEpoch = app.activation().activationId;
  app.subject.showPanel('prompt');
  app.calls.length = 0;
  assert.equal(await app.subject.focusInput(staleEpoch), false);
  assert.deepEqual(app.calls, []);
});

function capture() {
  const area = { x: 0, y: 0, width: 1440, height: 900 };
  const image = { toPNG: () => Buffer.from('png') };
  return {
    id: 'capture', controller: new AbortController(), clipboardSnapshot: Promise.resolve({}),
    displayBounds: area, physicalBounds: area, previousBounds: area,
    regions: [], hasSelection: false, holdReady: false,
    released: true, visible: false, finishing: false,
    context: { id: 'context', title: '当前窗口', images: [], capturedAt: 1 },
    defaultClipboard: image,
  };
}

test('剪贴板复制未完成也立即提交截图并展示提问框', async () => {
  const copied = deferred<void>();
  const app = desktop(Promise.resolve(false), copied.promise);
  const session = capture();
  app.subject.setCapture(session);
  const completed = app.subject.completeCapture(session);
  try {
    await Promise.resolve();
    assert.equal(app.subject.captureActive(), false);
    assert.equal(app.subject.view(), 'prompt');
    assert.equal(app.subject.context(), session.context);
    assert.equal(app.activation().context?.id, session.context.id);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(app.clipboardWrites.length, 1, '已提交会话的复制不能因 captureSession 清空而跳过');
  } finally {
    copied.resolve();
    await completed;
    await app.subject.clipboardIdle();
  }
});

test('已取消的截图在复制队列执行前被跳过', async () => {
  const app = desktop();
  const session = capture();
  app.subject.setCapture(session);
  app.subject.copyScreenshot(session, session.defaultClipboard);
  app.subject.cancelCapture(false);
  await app.subject.clipboardIdle();
  assert.equal(session.controller.signal.aborted, true);
  assert.equal(app.clipboardWrites.length, 0);
});


test('渲染器就绪后仍等待合成帧，等待期间的新换屏使旧帧作废', async () => {
  const frame = deferred<void>();
  const app = desktop(Promise.resolve(false), Promise.resolve(), true, frame.promise);
  app.send('rabbit:set-interactive', false);
  app.screen.getDisplayNearestPoint = () => ({ workArea: { x: 1800, y: 0, width: 1200, height: 900 } });
  app.subject.showPanel('prompt');
  const id = (app.sent.findLast(message => message.channel === 'rabbit:cursor')!.value as any).transitionId;
  const pending = app.send('rabbit:pet-viewport-ready', id);
  assert.equal(app.calls.includes('capture:frame'), true);
  assert.equal(app.state.visible, true, '先以原生透明状态挂回合成树');
  assert.equal(app.state.opacity, 0);
  app.screen.getDisplayNearestPoint = () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } });
  app.subject.showPanel('prompt');
  frame.resolve();
  assert.equal(await pending, false);
  assert.equal(app.state.visible, false, '旧合成结果不能显示新一轮窗口');
  const next = (app.sent.findLast(message => message.channel === 'rabbit:cursor')!.value as any).transitionId;
  assert.equal(await app.send('rabbit:pet-viewport-ready', next), true);
  assert.equal(app.state.visible, true);
});


test('收起自己的输入面板后立即重新允许全局触发，不依赖前台切到别的应用', () => {
  const app = desktop();
  for (let index = 0; index < 4; index++) {
    app.subject.showPanel('prompt');
    assert.equal(app.calls.filter(call => call.startsWith('native.ownForeground:')).at(-1), 'native.ownForeground:true');
    app.subject.hidePanel();
    assert.equal(app.calls.filter(call => call.startsWith('native.ownForeground:')).at(-1), 'native.ownForeground:true');
  }
});


test('对话框再次收到激活键立即取消，释放或长按不重新截图，下一次正常激活', async () => {
  const app = desktop();
  app.subject.showPanel('prompt');
  const owner = app.activation().activationId;
  app.subject.activatePrompt(false, 8);
  assert.equal(app.subject.view(), undefined);
  assert.equal(app.subject.captureActive(), false);
  assert.equal(app.sent.findLast(message => message.channel === 'rabbit:dismiss')?.value, owner);
  app.subject.endCapture();
  assert.equal(app.calls.some(call => call.startsWith('capture:')), false);
  app.subject.activatePrompt(false, 9);
  assert.equal(app.subject.captureActive(), true);
  app.subject.endCapture();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.subject.view(), 'prompt');
  app.subject.showPanel('settings');
  assert.equal(app.calls.filter(call => call.startsWith('native.ownForeground:')).at(-1), 'native.ownForeground:false');
});


test('窗口附图来自完整窗口图，屏外部分不被桌面边界裁掉且负原点光标正确缩放', async () => {
  const bounds = { x: -2200, y: 100, width: 2600, height: 1500 };
  const backgroundBounds = { x: -1920, y: 0, width: 5760, height: 2160 };
  const app = desktop(undefined, undefined, true, undefined, {
    bounds, cursor: { x: -760, y: 850 }, width: 5760, height: 2160, imageWidth: 1920, imageHeight: 1108,
  });
  const snapshot = await app.subject.captureForeground(new AbortController().signal, backgroundBounds, true);
  assert.deepEqual(app.captureRequests, [{ type: 'window', backgroundBounds }]);
  assert.equal(snapshot.background.getSize().width, 5760);
  const captured = snapshot.context.images[0];
  assert.deepEqual(JSON.parse(JSON.stringify(captured.pixelSize)), { width: 1920, height: 1108 });
  assert.deepEqual(JSON.parse(JSON.stringify(captured.cursor)), { x: 1063, y: 554, width: 1920, height: 1108, inside: true });
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot.context.focusScreenBounds)), bounds);
  assert.equal(captured.imageDataUrl, 'data:image/jpeg;base64,' + Buffer.from('window-image').toString('base64'));
  assert.deepEqual(app.decodedWindowImages, [WINDOW_PNG]);
  assert.equal(app.calls.some(call => call.startsWith('image.crop:')), false, '窗口图与桌面背景互不裁切或替换');
  assert.equal(snapshot.defaultClipboard.toPNG().toString(), 'window-image');
});

test('窗口完全位于桌面外也保留返回的完整窗口图，光标仍按窗口坐标计算', async () => {
  const app = desktop(undefined, undefined, true, undefined, { bounds: { x: -3000, y: 100, width: 100, height: 100 }, cursor: { x: 100, y: 200 }, imageWidth: 100, imageHeight: 100 });
  const snapshot = await app.subject.captureForeground(new AbortController().signal, { x: 0, y: 0, width: 1440, height: 900 });
  assert.equal(snapshot.context.images.length, 1);
  assert.ok(snapshot.background);
  assert.equal(snapshot.context.error, undefined);
  assert.equal(snapshot.context.images[0].cursor.inside, false);
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot.context.images[0].cursor)), { x: 3100, y: 100, width: 100, height: 100, inside: false });
});

test('桌面背景不可用时仍保留有效窗口附图', async () => {
  const app = desktop(undefined, undefined, true, undefined, { background: false });
  const snapshot = await app.subject.captureForeground(new AbortController().signal, { x: 0, y: 0, width: 1440, height: 900 }, true);
  assert.equal(snapshot.background, undefined);
  assert.equal(snapshot.context.error, undefined);
  assert.equal(snapshot.context.images.length, 1);
  assert.equal(snapshot.context.images[0].imageDataUrl, 'data:image/jpeg;base64,' + Buffer.from('window-image').toString('base64'));
});

test('窗口截图失败只保留背景，不用桌面图冒充窗口附图', async () => {
  const app = desktop(undefined, undefined, true, undefined, { windowImage: false, captureError: '窗口拒绝截图' });
  const snapshot = await app.subject.captureForeground(new AbortController().signal, { x: 0, y: 0, width: 1440, height: 900 });
  assert.ok(snapshot.background);
  assert.equal(snapshot.context.images.length, 0);
  assert.equal(snapshot.defaultClipboard, undefined);
  assert.equal(snapshot.context.error, '窗口拒绝截图');
  assert.equal(app.calls.some(call => call.startsWith('image.crop:')), false);
});


test('当前提问轮次光效使用目标窗口范围与局部起点，不扩大主窗命中区域', async () => {
  const app = desktop();
  app.subject.beginCapture(false, 1); app.subject.endCapture();
  await new Promise(resolve => setImmediate(resolve));
  const owner = app.activation().activationId;
  app.send('rabbit:set-interactive', true, owner);
  const ignored = app.state.ignoreMouse;
  app.send('rabbit:activation-effect', { x: 100, y: 200 }, owner, '#aabbcc');
  assert.equal(app.effects.length, 1);
  assert.equal(app.state.ignoreMouse, ignored);
  assert.deepEqual(JSON.parse(JSON.stringify(app.effects[0].slice(0, 3))), [{ x: 0, y: 0, width: 1440, height: 900 }, { x: 100, y: 200 }, '#aabbcc']);
  assert.equal(typeof app.effects[0][3], 'function');
  app.effects[0][3]();
  assert.equal(app.calls.at(-1), 'window.moveTop', '光效仅提升原主窗口');
  for (const [origin, epoch, color] of [[{x:100,y:200}, owner-1, '#aabbcc'], [{x:NaN,y:200},owner,'#aabbcc'], [null,owner,'#aabbcc'], [{x:100,y:200},owner,'red']]) app.send('rabbit:activation-effect', origin, epoch, color);
  assert.equal(app.effects.length, 1);
  const cleared = app.clearedEffects(); app.subject.hidePanel();
  assert.ok(app.clearedEffects() > cleared);
  app.send('rabbit:activation-effect', { x: 100, y: 200 }, owner, '#aabbcc');
  assert.equal(app.effects.length, 1);
});

test('没有目标窗口范围或处于截图、暂停时不能播放窗口光效', async () => {
  const app = desktop(); app.subject.showPanel('prompt');
  app.send('rabbit:activation-effect', { x: 100, y: 200 }, app.activation().activationId, '#aabbcc');
  assert.equal(app.effects.length, 0);
  app.subject.beginCapture(false, 1); app.subject.endCapture(); await new Promise(resolve => setImmediate(resolve));
  const owner = app.activation().activationId;
  app.subject.beginCapture(false, 2);
  app.send('rabbit:activation-effect', { x: 100, y: 200 }, owner, '#aabbcc');
  assert.equal(app.effects.length, 0);
  app.subject.cancelCapture(); app.subject.setSuspended(true);
  app.send('rabbit:activation-effect', { x: 100, y: 200 }, owner, '#aabbcc');
  assert.equal(app.effects.length, 0);
});


test('桌面没有可用应用且没有截图错误时仍展示普通提问并完成后续聚焦', async () => {
  const focus = deferred<boolean>();
  const app = desktop(focus.promise, Promise.resolve(), false, Promise.resolve(), { captureError: null });
  app.subject.beginCapture(true);
  await new Promise(resolve => setImmediate(resolve));
  const activation = app.activation();
  assert.equal(activation.view, 'prompt');
  assert.equal(activation.context?.images.length, 0);
  assert.equal(activation.context?.error, undefined);
  assert.equal(app.state.visible, true);
  assert.equal(app.state.opacity, 1);
  assert.equal(app.state.ignoreMouse, true, '输入框就绪前仍穿透');
  assert.equal(app.calls.includes('native.focus'), false);
  const rect = { x: 400, y: 300, width: 500, height: 100 };
  app.send('rabbit:set-interactive', true, activation.activationId);
  const focused = app.subject.focusInput(activation.activationId);
  assert.equal(app.calls.includes('native.focus'), true);
  focus.resolve(true);
  assert.equal(await focused, true);
  assert.equal(app.state.ignoreMouse, false);
  assert.equal(app.state.focusable, true);
  assert.equal(app.calls.includes('webContents.focus'), true);
});



test('本体沿用布尔悬停交互，移出后穿透且画面保持直接显示', () => {
  const app = desktop();
  app.subject.showMainWindow();
  app.send('rabbit:set-interactive', false);
  assert.equal(app.state.ignoreMouse, true);
  assert.equal(app.state.visible, true);
  assert.equal(app.state.opacity, 1);
  app.send('rabbit:set-interactive', true);
  assert.equal(app.state.ignoreMouse, false);
  assert.equal(app.state.focusable, true);
  app.send('rabbit:set-interactive', false);
  assert.equal(app.state.ignoreMouse, true);
  assert.equal(app.state.visible, true);
  assert.equal(app.calls.some(call => ['focus', 'native.focus', 'webContents.focus'].includes(call)), false);
  app.calls.length = 0;
  app.send('rabbit:set-interactive', false);
  assert.deepEqual(app.calls, [], '相同交互状态不重复改写系统样式');
});

test('只有图谱保持整画布交互，退出后恢复本体悬停穿透', async () => {
  const app = desktop();
  app.subject.showPanel('graph');
  await app.subject.focusInput(app.activation().activationId);
  app.send('rabbit:set-interactive', false, app.activation().activationId);
  assert.equal(app.state.ignoreMouse, false);
  assert.equal(app.state.opacity, 1);
  app.subject.hidePanel();
  assert.equal(app.state.ignoreMouse, true);
  assert.equal(app.state.opacity, 1);
  assert.equal(app.state.visible, true);
});
