import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { imageCropRect, selectionRect, unionBounds } from '../electron/capture-geometry.ts';
import { ClipboardStore } from '../electron/clipboard.ts';
import type { Activation } from '../electron/contracts.ts';

type PanelView = Activation['view'];
type IpcHandler = (...args: unknown[]) => unknown;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function desktop(focusResult: Promise<boolean> = Promise.resolve(false), clipboardResult: Promise<void> = Promise.resolve(), hasWindow = true, frameResult: Promise<void> = Promise.resolve()) {
  const calls: string[] = [];
  const sent: Array<{ channel: string; value: unknown }> = [];
  const clipboardWrites: unknown[] = [];
  const handlers = new Map<string, IpcHandler>();
  const settings = { autoCopyScreenshots: true, eyeColor: '#F90040', activationShortcut: ['AltLeft'], followMouse: true };
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
    setSkipTaskbar() {},
    setIgnoreMouseEvents(value: boolean) { state.ignoreMouse = value; calls.push('ignoreMouse:' + value); },
    setAlwaysOnTop() {},
    setOpacity(value: number) { state.opacity = value; calls.push('opacity:' + value); },
    setBounds(value: typeof bounds) { bounds = value; calls.push('bounds:' + value.x + ',' + value.y); },
    getBounds: () => ({ ...bounds }),
    getPosition: () => [bounds.x, bounds.y],
    getNativeWindowHandle: () => Buffer.from([42, 0, 0, 0, 0, 0, 0, 0]),
    show() { state.visible = true; calls.push('show'); },
    showInactive() { state.visible = true; calls.push('showInactive'); },
    focus() { calls.push('focus'); },
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

  const image = (width = 1440, height = 900) => ({
    isEmpty: () => false, getSize: () => ({ width, height }),
    crop: (rect: { width: number; height: number }) => image(rect.width, rect.height),
    resize: (size: { width: number; height: number }) => image(size.width, size.height),
    toJPEG: () => Buffer.from('test-image'), toPNG: () => Buffer.from('test-image'), toDataURL: () => 'data:image/png;base64,dGVzdA==',
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
    __store: { getPublic: () => settings },
    __overlays: { close() { calls.push('overlays.close'); }, show: async () => { calls.push('overlays.show'); }, frame() {}, image() {}, owns: () => false },
    here: '.', path, randomUUID, imageCropRect, selectionRect, unionBounds, nativeShortcut: (v: unknown) => v,
    markCaptureCursor: (value: unknown) => value,
    nativeImage: { createFromBuffer: () => image(), createFromBitmap: () => image(), createEmpty: () => ({ isEmpty: () => true }) },
    CaptureWorker: class {
      async capture(request: { type: string }) {
        const manual = request.type === 'desktop';
        calls.push(manual ? 'capture:desktop' : 'capture:window');
        return { handle: hasWindow ? '77' : '0', title: '公开应用窗口', processId: 99,
          bounds: { x: 0, y: 0, width: hasWindow ? 1440 : 0, height: hasWindow ? 900 : 0 }, cursor: { x: 300, y: 200 },
          ...(manual ? { desktopBitmap: Buffer.alloc(4), desktopWidth: 1, desktopHeight: 1 } : hasWindow ? { imageBase64: 'dGVzdA==' } : { captureError: '没有合适的应用窗口' }),
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
      screenToDipRect: (_window: unknown, rect: unknown) => rect,
      getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
    },
    ipcMain: {
      handle(channel: string, handler: IpcHandler) { handlers.set(channel, handler); },
      on(channel: string, handler: IpcHandler) { handlers.set(channel, handler); },
    },
    subject: undefined as undefined | {
      showPanel(view: PanelView): void;
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
      holdCapture(session: unknown): void;
      selectionPointer(phase: string, point: { x: number; y: number }): void;
      session(): any;
      cursor(): any;
    },
  };
  const bootstrap = `
    window = __window;
    windowsNative = __native;
    store = __store;
    captureOverlays = __overlays;
    registerIpc();
    globalThis.subject = {
      showPanel, activatePrompt, focusInput, hidePanel, completeCapture, copyScreenshot, cancelCapture,
      beginCapture, endCapture, holdCapture, selectionPointer,
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
    subject, state, calls, activation, clipboardWrites, screen: context.screen as any, settings,
    bounds: window.getBounds, sent,
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

test('宠物命中时允许鼠标交互但不主动抢焦点，移开后恢复穿透', () => {
  const app = desktop();
  app.send('rabbit:set-interactive', true);
  assert.equal(app.state.focusable, true);
  assert.equal(app.state.ignoreMouse, false);
  assert.equal(app.calls.includes('focus'), false);
  app.send('rabbit:set-interactive', false);
  assert.equal(app.state.focusable, false);
  assert.equal(app.state.ignoreMouse, true);
});

test('设置与已呈现的提问共用 Electron 窗口激活路径', async () => {
  const settings = desktop();
  settings.subject.showPanel('settings');
  const prompt = desktop();
  prompt.subject.showPanel('prompt');
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
