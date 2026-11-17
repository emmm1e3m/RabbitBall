import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import vm from 'node:vm';
import { ClipboardStore } from '../electron/clipboard.ts';
import { imageCropRect, selectionRect, unionBounds } from '../electron/capture-geometry.ts';
import { GraphStore } from '../electron/graph-store.ts';
import { GraphJobs, buildGraphChatContext } from '../electron/graph-jobs.ts';
import { DEFAULT_PROMPTS } from '../electron/prompts.ts';
import { effectiveShortcutBindings, shortcutAcceleratorBindings } from '../electron/shortcut.ts';
import type { Activation, CaptureContext, PrivateSettings } from '../electron/contracts.ts';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jTQAAAABJRU5ErkJggg==';
const JPEG = '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD8qqKKKAP/2Q==';
const originalCapture: CaptureContext = { id: 'original-capture', title: '已有资料', capturedAt: 1,
  images: [{ id: 'original-image', title: '第一页', imageDataUrl: 'data:image/png;base64,' + PNG }] };
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function eventually(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 3000;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(predicate(), message);
}

async function desktop(t: TestContext, options: { existing?: boolean; captureGate?: Promise<void>; focusGate?: Promise<boolean>; selectionGate?: Promise<number>; chatGate?: Promise<void>; desktopError?: boolean; missingBackground?: boolean; missingWindowImage?: boolean } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'rabbitball-graph-activation-'));
  const graphStore = new GraphStore(directory, () => {});
  await graphStore.load();
  let workspace = await graphStore.create('阅读工作区');
  if (options.existing) {
    workspace = await graphStore.mutate(workspace.id, { type: 'create-graph', title: originalCapture.title });
    workspace = await graphStore.attachCapture(workspace.id, workspace.lastGraphId!, originalCapture);
  }
  let settings = { autoCopyScreenshots: false, eyeColor: '#F90040', activationShortcut: ['AltLeft'], followMouse: true,
    graphPluginEnabled: true, graphActivationShortcut: null as string[] | null, pauseOnFullscreen: true, launchAtLogin: false, historyLimit: 10, prompts: DEFAULT_PROMPTS };
  const captureRequests: any[] = [], decodedWindowImages: string[] = [];
  const calls: string[] = [], signals: AbortSignal[] = [];
  const chatRequests: Array<{ id: string }> = [];
  const chatRuns: Array<{ request: { id: string }; signal: AbortSignal; onEvent: (event: unknown) => void; conversation: unknown }> = [];
  const historyRuns: Array<{ requestId: string; events: any[]; saves: number }> = [];
  const jobs = new GraphJobs(graphStore, () => settings as unknown as PrivateSettings, {
    run: async (_request, _settings, { signal }) => {
      signals.push(signal);
      await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); });
    },
  });
  const graphJobs = {
    cancelAll() { calls.push('jobs.cancelAll'); jobs.cancelAll(); },
    cancel: jobs.cancel.bind(jobs), generate: jobs.generate.bind(jobs), regenerate: jobs.regenerate.bind(jobs), reconcile: jobs.reconcile.bind(jobs),
  };
  const sent: Array<{ channel: string; value: any }> = [];
  const graphSent: Array<{ channel: string; value: any }> = [];
  const petWindowCalls: string[] = [];
  let nativeCallbacks: any;
  const handlers = new Map<string, (...args: any[]) => any>();
  const state = { visible: false, focusable: false, ignoreMouse: true, opacity: 1 };
  let bounds = { x: 0, y: 0, width: 1440, height: 900 };
  const webContents = { mainFrame: {}, isDestroyed: () => false, send(channel: string, value: any) { sent.push({ channel, value }); },
    focus() { calls.push('webContents.focus'); }, capturePage: async () => {} };
  const window = {
    webContents, isDestroyed: () => false, isVisible: () => state.visible, isFocused: () => false, isFocusable: () => state.focusable,
    setFocusable(value: boolean) { state.focusable = value; }, setIgnoreMouseEvents(value: boolean) { state.ignoreMouse = value; },
    setSkipTaskbar() {}, setAlwaysOnTop() {}, setOpacity(value: number) { petWindowCalls.push('setOpacity'); state.opacity = value; },
    setBounds(value: typeof bounds) { petWindowCalls.push('setBounds'); bounds = value; }, getBounds: () => bounds, getPosition: () => [bounds.x, bounds.y],
    getNativeWindowHandle: () => Buffer.from([42, 0, 0, 0, 0, 0, 0, 0]),
    show() { petWindowCalls.push('show'); state.visible = true; }, showInactive() { petWindowCalls.push('showInactive'); state.visible = true; }, focus() { calls.push('window.focus'); },
    moveTop() { calls.push('window.moveTop'); },
    hide() { petWindowCalls.push('hide'); state.visible = false; },
  };
  const graphState = { visible: false, focusable: true, ignoreMouse: false, opacity: 1 };
  const graphContents = { mainFrame: {}, isDestroyed: () => false, send(channel: string, value: any) { graphSent.push({ channel, value }); }, focus() { calls.push('graph.webContents.focus'); } };
  let graphVisible = false, graphEpoch = 0, graphCapturing = false;
  const graphWindow = {
    onVisibility(_visible: boolean) {},
    webContents: graphContents,
    window: { webContents: graphContents, isDestroyed: () => false, isVisible: () => graphState.visible, isFocused: () => false, getBounds: () => ({ x: 1440, y: -800, width: 2560, height: 1400 }) },
    get visible() { return graphVisible; }, get activationId() { return graphEpoch; },
    owns: (sender: unknown) => sender === graphContents,
    send(channel: string, value: unknown) { graphContents.send(channel, value); },
    async show(extra: unknown) {
      const wasVisible = graphVisible;
      graphVisible = true; graphCapturing = false; graphState.visible = true;
      if (!wasVisible) this.onVisibility(true);
      graphContents.send('rabbit:activate', { activationId: ++graphEpoch, view: 'graph', ...extra as object });
    },
    hide() { const owner = graphEpoch++, wasVisible = graphVisible; graphVisible = false; graphCapturing = false; graphState.visible = false; if (wasVisible) this.onVisibility(false); graphContents.send('rabbit:dismiss', owner); },
    hideForCapture() { graphCapturing = true; graphState.visible = false; },
    async restoreAfterCapture() { graphCapturing = false; if (graphVisible) graphState.visible = true; },
    async focusInput(owner: unknown) {
      if (!graphVisible || graphCapturing || owner !== graphEpoch) return false;
      const focused = await (options.focusGate ?? Promise.resolve(false));
      return graphVisible && !graphCapturing && owner === graphEpoch && focused;
    },
  };
  const image = (width = 1440, height = 900): any => ({ isEmpty: () => false, getSize: () => ({ width, height }),
    crop: (rect: { width: number; height: number }) => image(rect.width, rect.height),
    resize: (size: { width: number; height: number }) => image(size.width, size.height),
    toJPEG: () => Buffer.from(JPEG, 'base64'), toPNG: () => Buffer.from(PNG, 'base64') });
  // 执行主进程真实激活、焦点与 IPC 函数；仅替换系统窗口、截图和设置存储边界。
  const source = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');
  const startup = source.indexOf('\nconst quitRequested =');
  assert.ok(startup > 0);
  const module = source.slice(0, startup).replace(/^import .*;\r?\n/gm, '').replace(/^const here = .*;\r?\n/m, '');
  const context: any = {
    __window: window, __graphWindow: graphWindow, __graphStore: graphStore, __graphJobs: graphJobs,
    __store: { getPublic: () => ({ ...settings }), getPrivate: () => ({ ...settings }), async save(patch: Partial<typeof settings>) { settings = { ...settings, ...patch }; return { ...settings }; } },
    __historyStore: { getConversation: () => undefined, list: () => [], begin(request: { id: string }) {
      const run = { requestId: request.id, events: [] as any[], saves: 0 }; historyRuns.push(run);
      return { onEvent(event: unknown) { run.events.push(event); }, async save() { run.saves++; } };
    }, setLimit: async () => {} },
    __native: { ready: Promise.resolve(), configure: async () => {}, cancelFocus() {}, cancelCapture(id: number) { calls.push('native.cancelCapture:' + id); },
      beginSelection: () => { calls.push('native.beginSelection'); return options.selectionGate ?? Promise.resolve(100); }, focusWindow: () => options.focusGate ?? Promise.resolve(false) },
    __overlays: { close() { calls.push('overlays.close'); }, show: async () => { calls.push('overlays.show'); }, frame() {}, image() {}, owns: () => false },
    here: '.', path, randomUUID, imageCropRect, selectionRect, unionBounds, nativeShortcut: (value: unknown) => value, effectiveShortcutBindings, shortcutAcceleratorBindings,
    createWindowsNative(callbacks: unknown) { nativeCallbacks = callbacks; return context.__native; },
    validateSettingsPatch: (value: unknown) => value,
    markCaptureCursor(value: unknown) { calls.push('markCursor'); return value; },
    nativeImage: { createFromBuffer: (value: Buffer) => { decodedWindowImages.push(value.toString('base64')); return image(); }, createFromBitmap: () => image(), createFromDataURL: (value: string) => { decodedWindowImages.push(value); return image(); }, createEmpty: () => ({ isEmpty: () => true }) },
    createAgentConversation: () => ({}), buildGraphChatContext, GRAPH_CHAT_RULES: '图谱测试规则',
    runAgent: async (request: { id: string }, _settings: unknown, run: { signal: AbortSignal; onEvent: (event: unknown) => void; conversation: unknown }) => { chatRequests.push(request); chatRuns.push({ request, ...run }); await options.chatGate; },
    CaptureWorker: class {
      async capture(request: { type: string; backgroundBounds?: unknown }) {
        captureRequests.push(JSON.parse(JSON.stringify(request)));
        calls.push('capture:' + request.type); await options.captureGate;
        if (request.type === 'desktop' && options.desktopError) throw new Error('屏幕暂时不可读取');
        return { handle: '77', title: '当前应用资料', appName: '阅读器', processName: 'reader.exe', processId: 99,
          bounds: { x: 0, y: 0, width: 1440, height: 900 }, cursor: { x: 300, y: 200 },
          ...(!options.missingBackground && (request.type === 'desktop' || request.backgroundBounds !== undefined) ? { desktopBitmap: Buffer.alloc(4), desktopWidth: 1, desktopHeight: 1 } : {}),
          ...(request.type === 'window' && !options.missingWindowImage ? { imageBase64: PNG, imageWidth: 1440, imageHeight: 900 } : {}) };
      }
    },
    Buffer, Blob, AbortController, ClipboardStore,
    ClipboardItem: class { data: unknown; constructor(data: unknown) { this.data = data; } }, clipboard: { read: async () => [], write: async () => {} },
    process: { platform: 'win32', env: {}, pid: 42 },
    shell: { openPath: async (directory: string) => { calls.push('folder:' + directory); return ''; } },
    screen: { getCursorScreenPoint: () => ({ x: 700, y: 420 }), getAllDisplays: () => [{ bounds }],
      dipToScreenRect: (_window: unknown, rect: unknown) => rect, dipToScreenPoint: (point: unknown) => point,
      screenToDipRect: (_window: unknown, rect: unknown) => rect, getDisplayNearestPoint: () => ({ workArea: bounds }) },
    ipcMain: { handle: (channel: string, handler: (...args: any[]) => any) => handlers.set(channel, handler),
      on: (channel: string, handler: (...args: any[]) => any) => handlers.set(channel, handler) },
  };
  vm.runInNewContext(stripTypeScriptTypes(module) + `
    window=__window; graphWindow=__graphWindow; windowsNative=__native; store=__store; historyStore=__historyStore; graphStore=__graphStore; graphJobs=__graphJobs; captureOverlays=__overlays;
    __graphWindow.onVisibility=graphVisibilityChanged;
    registerIpc();
    globalThis.subject={activatePrompt,activateGraph,focusInput,cancelCapture,endCapture,holdCapture,selectionPointer,showPanel,graphChanged,listen:registerActivationKey,
      context:()=>currentContext,petConversation:()=>petChat.currentConversation?.conversation,session:()=>captureSession,view:()=>panelView,
      graphTrigger:()=>pendingGraphTrigger,
      graphAvailable:value=>{graphWindow=value?__graphWindow:undefined;},
      clearGraphCache:()=>graphImageCache.delete(__graphWindow.webContents)};
  `, context);
  const subject = context.subject;
  t.after(async () => {
    subject.cancelCapture(); jobs.cancelAll(); await jobs.idle();
    await graphStore.dispose(); await rm(directory, { recursive: true, force: true });
  });
  const event = { sender: webContents, senderFrame: webContents.mainFrame };
  const graphEvent = { sender: graphContents, senderFrame: graphContents.mainFrame };
  return { subject, state: graphState, petState: state, graphWindow, calls, petWindowCalls, captureRequests, decodedWindowImages, sent: graphSent, petSent: sent, graphStore, graphJobs, jobs, workspace, signals, chatRequests, chatRuns, historyRuns, bounds: () => ({ ...bounds }), screen: context.screen,
    get nativeCallbacks() { return nativeCallbacks; },
    activation: () => graphSent.findLast(item => item.channel === 'rabbit:activate')?.value as Activation | undefined,
    petActivation: () => sent.findLast(item => item.channel === 'rabbit:activate')?.value as Activation | undefined,
    async opened() {
      await eventually(() => graphSent.findLast(item => item.channel === 'rabbit:activate')?.value.view === 'graph' || graphSent.some(item => item.channel === 'rabbit:graph-error'), '图谱激活应完成');
      assert.equal(graphWindow.visible, true, JSON.stringify(graphSent.filter(item => item.channel === 'rabbit:graph-error')));
      assert.notEqual(subject.view(), 'graph', '图谱不能占用本体面板');
    },
    send(channel: string, ...args: unknown[]) { assert.ok(handlers.has(channel), '调用实际注册的 IPC'); return handlers.get(channel)!(graphEvent, ...args); },
    petSend(channel: string, ...args: unknown[]) { assert.ok(handlers.has(channel), '调用实际注册的本体 IPC'); return handlers.get(channel)!(event, ...args); },
  };
}

async function graphEntryFixture(t: TestContext, kind: 'activate' | 'capture' | 'images') {
  const app = await desktop(t, { existing: kind !== 'capture' });
  const workspace = kind === 'capture' ? await app.graphStore.mutate(app.workspace.id, { type: 'create-graph' }) : app.workspace;
  if (kind === 'images') await app.graphWindow.show({ workspaceId: workspace.id });
  const channel = kind === 'activate' ? 'rabbit:graph-activate' : kind === 'capture' ? 'rabbit:graph-capture' : 'rabbit:graph-capture-images';
  const request = kind === 'activate' ? undefined : { workspaceId: workspace.id, graphId: workspace.lastGraphId,
    ...(kind === 'images' ? { nodeId: workspace.graphs[0].rootId } : {}) };
  return { ...app, request: () => app.send(channel, request), activationCount: () => app.sent.filter(event => event.channel === 'rabbit:activate').length };
}

test('打开文档文件夹只打开当前工作区目录，不激活窗口或采集屏幕', async t => {
  const app=await desktop(t,{existing:true});
  await app.send('rabbit:graph-reveal-document',app.workspace.id);
  assert.deepEqual(app.calls,['folder:'+app.graphStore.getDirectory(app.workspace.id)]);
  assert.equal(app.activation(),undefined);assert.equal(app.state.visible,false);
});

test('大爆炸短按恢复已有图，不截图或改变本体显隐及原图', async t => {
  const app = await desktop(t, { existing: true }), before = await app.graphStore.readDocument(app.workspace.id);
  app.subject.activateGraph(false, 1); app.subject.endCapture();
  await eventually(() => app.activation()?.view === 'graph', '应打开已有图');
  assert.deepEqual(app.calls.filter(call => call.startsWith('capture:')), []);
  assert.deepEqual(app.captureRequests, []);
  assert.deepEqual(app.petWindowCalls, []);
  assert.equal(app.activation()?.workspaceId, app.workspace.id);
  assert.equal(app.activation()?.backgroundImageDataUrl, undefined);
  assert.equal((await app.graphStore.open()).lastGraphId, app.workspace.lastGraphId);
  assert.equal((await app.graphStore.readDocument(app.workspace.id)).markdown, before.markdown);
  assert.equal(app.signals.length, 0); assert.equal(app.chatRequests.length, 0);
});

test('已有图反复短按打开和关闭均不闪动本体，普通聊天输入保持可用', async t => {
  const app = await desktop(t, { existing: true, focusGate: Promise.resolve(true) });
  app.subject.showPanel('prompt');
  const owner = app.petActivation()!.activationId;
  assert.equal(await app.petSend('rabbit:focus-input', owner), true);
  app.petSend('rabbit:set-interactive', true, owner);
  const petState = { ...app.petState }, petBounds = app.bounds(), petContext = app.subject.context();
  app.petWindowCalls.length = 0;
  for (let round = 0; round < 3; round++) {
    app.subject.activateGraph(false, 10 + round * 2);
    assert.equal(app.subject.session(), undefined, '按下尚未达到长按阈值，不建立截图会话');
    assert.equal(app.graphWindow.visible, false);
    app.subject.endCapture();
    await eventually(() => app.graphWindow.visible, '松键后打开已有图');
    app.subject.activateGraph(false, 11 + round * 2);
    assert.equal(app.graphWindow.visible, true, '按下仍保留图谱，松键才关闭');
    app.subject.endCapture();
    assert.equal(app.graphWindow.visible, false);
    assert.equal(app.subject.graphTrigger(), undefined);
    assert.equal(app.subject.session(), undefined);
    assert.equal(app.subject.view(), 'prompt');
    assert.equal(app.petActivation()!.activationId, owner);
    assert.equal(app.subject.context(), petContext);
    assert.deepEqual(app.petState, petState); assert.deepEqual(app.bounds(), petBounds);
  }
  assert.deepEqual(app.petWindowCalls, []);
  assert.deepEqual(app.captureRequests, []);
  assert.equal(app.petSent.some(item => item.channel === 'rabbit:dismiss'), false);
  assert.equal(app.petSent.filter(item => item.channel === 'rabbit:activate').length, 1);
});

test('工作区无图时短按保存独立窗口图为初始节点，并请求桌面模糊背景', async t => {
  const app = await desktop(t);
  app.subject.activateGraph(false, 2); app.subject.endCapture();
  await app.opened();
  assert.deepEqual(app.calls.filter(call => call.startsWith('capture:')), ['capture:window']);
  assert.equal(app.calls.includes('markCursor'), false, '图谱初始资料应保存干净原图');
  assert.deepEqual(app.captureRequests, [{ type: 'window', backgroundBounds: { x: 0, y: 0, width: 1440, height: 900 } }]);
  assert.deepEqual(app.decodedWindowImages, [PNG]);
  const workspace = await app.graphStore.open(), graph = workspace.graphs[0], root = graph.nodes[0];
  assert.equal(workspace.graphs.length, 1); assert.equal(root.id, graph.rootId);
  assert.equal(root.images.length, 1); assert.equal(root.images[0].source, 'window');
  assert.equal(root.images[0].appName, '阅读器');
  assert.equal(root.status, 'idle'); assert.equal(root.markdown, '');
  assert.equal(app.signals.length, 0, '截图只建立资料节点，等待用户批注后才生成');
  assert.equal(app.chatRequests.length, 0);
});

test('长按多次框选在已有工作区新建一个共同根节点，不重拍应用图', async t => {
  const app = await desktop(t, { existing: true });
  app.petState.visible = true;
  app.subject.activateGraph(false, 3);
  assert.equal(app.subject.session(), undefined);
  assert.equal(app.petState.visible, true);
  assert.deepEqual(app.petWindowCalls, []); assert.deepEqual(app.captureRequests, []);
  app.subject.holdCapture(app.subject.session());
  assert.equal(app.subject.session()?.holdReady, true);
  assert.deepEqual(app.petWindowCalls, ['hide']);
  assert.equal(app.petState.visible, false);
  await eventually(() => app.calls.includes('overlays.show'), '长按应展示框选层');
  for (const [x, y] of [[100, 100], [600, 200]]) {
    app.subject.selectionPointer('down', { x, y }); app.subject.selectionPointer('up', { x: x + 200, y: y + 150 });
  }
  app.subject.endCapture(); await app.opened();
  const workspace = await app.graphStore.open(), graph = workspace.graphs.find(item => item.id === workspace.lastGraphId)!;
  assert.equal(workspace.graphs.length, 2); assert.notEqual(graph.id, app.workspace.lastGraphId);
  assert.equal(graph.nodes.length, 1); assert.equal(graph.nodes[0].images.length, 2);
  assert.ok(graph.nodes[0].images.every(image => image.source === 'region'));
  assert.deepEqual(app.calls.filter(call => call.startsWith('capture:')), ['capture:desktop']);
});

test('独立图谱始终可交互，重复激活退出且旧焦点回执不重开', async t => {
  const focus = deferred<boolean>(), app = await desktop(t, { existing: true, focusGate: focus.promise });
  app.subject.activateGraph(); await eventually(() => app.activation()?.view === 'graph', '应打开图谱');
  const epoch = app.activation()!.activationId;
  assert.equal(app.state.focusable, true); assert.equal(app.state.ignoreMouse, false);
  const petState = { ...app.petState }, petBounds = app.bounds();
  const pending = app.send('rabbit:focus-input', epoch);
  assert.equal(app.state.focusable, true); assert.equal(app.state.ignoreMouse, false);
  app.send('rabbit:set-interactive', false, epoch);
  assert.equal(app.state.ignoreMouse, false, '图谱内移动到空白区域也不能穿透到桌面');
  assert.deepEqual(app.petState, petState); assert.deepEqual(app.bounds(), petBounds);
  const captures = app.calls.filter(call => call.startsWith('capture:')).length;
  app.subject.activateGraph(false, 4);
  assert.equal(app.graphWindow.visible, true, '按下先等待短按或长按判定');
  assert.equal(app.subject.view(), undefined); assert.equal(app.subject.session(), undefined);
  assert.equal(app.subject.graphTrigger()?.dismissOnTap, true);
  app.subject.endCapture(); focus.resolve(true); assert.equal(await pending, false);
  assert.equal(app.calls.filter(call => call.startsWith('capture:')).length, captures);
  assert.equal(app.sent.findLast(item => item.channel === 'rabbit:dismiss')?.value, epoch);
  assert.equal(app.graphWindow.visible, false);
  assert.equal(app.subject.graphTrigger(), undefined);
  assert.equal(app.subject.session(), undefined);
});

test('已打开图谱的同一次长按可转入屏幕选区，短按关闭语义保留', async t => {
  const app = await desktop(t, { existing: true });
  await app.graphWindow.show({});
  app.subject.activateGraph(false, 40);
  app.subject.holdCapture(app.subject.session());
  await eventually(() => app.calls.includes('overlays.show'), '图谱中长按也应显示截图界面');
  assert.deepEqual(app.calls.filter(call => call.startsWith('capture:')), ['capture:desktop']);
  assert.equal(app.state.visible, false, '截图时主窗口保持隐藏');
  app.subject.cancelCapture();
  assert.equal(app.subject.session(), undefined);
});

test('关闭插件取消用户主动触发的图谱生成，已有文档和图片仍然保留', async t => {
  const app = await desktop(t);
  app.subject.activateGraph(); await app.opened();
  const captured = await app.graphStore.open(), graph = captured.graphs[0], root = graph.nodes[0];
  await app.send('rabbit:graph-mutate', captured.id, { type: 'annotation', graphId: graph.id, nodeId: root.id,
    annotation: { id: 'annotation', selection: { kind: 'text', text: '需要理解的内容' }, comment: '解释这段内容' } });
  await app.send('rabbit:graph-generate', { workspaceId: captured.id, graphId: graph.id, nodeId: root.id, annotationIds: ['annotation'] });
  await eventually(() => app.signals.length === 1, '主动提交批注后才启动生成');
  const before = await app.graphStore.readDocument(app.workspace.id);
  await app.send('rabbit:save-settings', { graphPluginEnabled: false }); await app.jobs.idle();
  assert.ok(app.signals.every(signal => signal.aborted)); assert.equal(app.subject.view(), undefined);
  const after = await app.graphStore.readDocument(app.workspace.id), workspace = await app.graphStore.open();
  assert.equal(after.markdown, before.markdown); assert.equal(workspace.graphs.length, 1);
  assert.equal(workspace.graphs[0].nodes[0].images.length, 1);
  assert.equal(workspace.graphs[0].nodes[0].status, 'idle');
  assert.equal(workspace.graphs[0].nodes.find(node => node.id !== root.id)?.status, 'cancelled');
});

test('取消及停用插件后迟到的图谱截图不能打开旧视图或新建图', async t => {
  for (const disable of [false, true]) {
    const gate = deferred(), app = await desktop(t, { captureGate: gate.promise });
    app.subject.activateGraph(); await eventually(() => app.calls.includes('capture:window'), '应用截图已经开始');
    if (disable) await app.send('rabbit:save-settings', { graphPluginEnabled: false });
    else app.subject.cancelCapture();
    gate.resolve(); await flush(); await app.graphStore.flush(); await flush();
    assert.equal(app.activation(), undefined, '迟到截图不能重新打开图谱');
    assert.equal(app.subject.session(), undefined);
    assert.equal((await app.graphStore.open()).graphs.length, 0);
    assert.equal(app.signals.length, 0); assert.equal(app.chatRequests.length, 0);
  }
});

test('短按等待读取工作区时取消或停用，迟到读取不能打开图谱或启动截图', async t => {
  for (const existing of [false, true]) for (const disable of [false, true]) {
    const app = await desktop(t, { existing }), gate = deferred(), entered = deferred();
    const open = app.graphStore.open.bind(app.graphStore);
    app.graphStore.open = async id => { const workspace = await open(id); entered.resolve(); await gate.promise; return workspace; };
    app.subject.activateGraph(false, 21); app.subject.endCapture();
    await entered.promise;
    assert.equal(app.subject.session(), undefined);
    assert.deepEqual(app.petWindowCalls, []);
    if (disable) await app.send('rabbit:save-settings', { graphPluginEnabled: false });
    else app.subject.cancelCapture();
    assert.equal(app.subject.graphTrigger(), undefined);
    gate.resolve(); await flush();
    assert.equal(app.activation(), undefined); assert.equal(app.graphWindow.visible, false);
    assert.equal(app.subject.session(), undefined);
    assert.deepEqual(app.captureRequests, []); assert.deepEqual(app.petWindowCalls, []);
    assert.equal(app.calls.includes('native.cancelCapture:21'), true);
  }
});

test('短按读取期间的新按键保留自己的待决状态，旧读取不提前打开窗口', async t => {
  const app = await desktop(t, { existing: true }), gate = deferred(), entered = deferred();
  const open = app.graphStore.open.bind(app.graphStore);
  app.graphStore.open = async id => { const workspace = await open(id); entered.resolve(); await gate.promise; return workspace; };
  app.subject.activateGraph(false, 31); app.subject.endCapture();
  await entered.promise;
  app.subject.activateGraph(false, 32);
  const trigger = app.subject.graphTrigger();
  gate.resolve(); await flush();
  assert.equal(app.subject.graphTrigger(), trigger); assert.equal(trigger.nativeId, 32);
  assert.equal(trigger.released, false);
  assert.equal(app.activation(), undefined); assert.equal(app.subject.session(), undefined);
  assert.deepEqual(app.petWindowCalls, []); assert.deepEqual(app.captureRequests, []);
  app.subject.endCapture(); await app.opened();
  assert.equal(app.sent.filter(item => item.channel === 'rabbit:activate').length, 1);
  assert.equal(app.subject.graphTrigger(), undefined);
});

test('短按读取期间从其他入口打开图谱，旧读取不能覆盖新的激活轮次', async t => {
  const app = await desktop(t, { existing: true }), gate = deferred(), entered = deferred();
  const open = app.graphStore.open.bind(app.graphStore);
  app.graphStore.open = async id => { const workspace = await open(id); entered.resolve(); await gate.promise; return workspace; };
  app.subject.activateGraph(false, 33); app.subject.endCapture();
  await entered.promise;
  await app.graphWindow.show({ workspaceId: app.workspace.id, graphAction: 'new' });
  const activation = app.activation();
  gate.resolve(); await flush();
  assert.equal(app.activation(), activation);
  assert.equal(app.sent.filter(item => item.channel === 'rabbit:activate').length, 1);
  assert.equal(app.subject.graphTrigger(), undefined); assert.equal(app.subject.session(), undefined);
  assert.deepEqual(app.petWindowCalls, []); assert.deepEqual(app.captureRequests, []);
});

test('旧原生按键的取消、释放和长按回调不能触碰新的图谱待决触发', async t => {
  const app = await desktop(t, { existing: true });
  await app.subject.listen();
  const native = app.nativeCallbacks;
  native.onTriggerBegin(100, 'graph'); native.onTriggerBegin(101, 'graph');
  const trigger = app.subject.graphTrigger();
  native.onTriggerCancel(100); native.onTriggerEnd(100); native.onTriggerHold(100);
  assert.equal(app.subject.graphTrigger(), trigger); assert.equal(trigger.nativeId, 101);
  assert.equal(trigger.released, false); assert.equal(app.subject.session(), undefined);
  assert.equal(app.activation(), undefined);
  assert.deepEqual(app.petWindowCalls, []); assert.deepEqual(app.captureRequests, []);
  native.onTriggerEnd(101); await app.opened();
  assert.equal(app.subject.graphTrigger(), undefined);
  assert.equal(app.sent.filter(item => item.channel === 'rabbit:activate').length, 1);
  assert.deepEqual(app.petWindowCalls, []); assert.deepEqual(app.captureRequests, []);
});

test('截图按钮等待读取工作区时停用插件，迟到请求不能开始截图', async t => {
  const app = await desktop(t, { existing: true }), gate = deferred();
  const open = app.graphStore.open.bind(app.graphStore);
  app.graphStore.open = async id => { const workspace = await open(id); await gate.promise; return workspace; };
  const pending = app.send('rabbit:graph-capture', { workspaceId: app.workspace.id, graphId: app.workspace.lastGraphId });
  await app.send('rabbit:save-settings', { graphPluginEnabled: false });
  gate.resolve(); await Promise.allSettled([pending]); await flush();
  assert.equal(app.subject.session(), undefined, '停用后不能创建新的捕获会话');
  assert.deepEqual(app.calls.filter(call => call.startsWith('capture:')), []);
});

test('图谱入口读取期间新普通截图保持所有权，完成或取消后旧入口仍失效', async t => {
  for (const kind of ['activate', 'capture', 'images'] as const) for (const finish of ['active', 'complete', 'cancel']) {
    const app = await graphEntryFixture(t, kind), gate = deferred(), entered = deferred();
    const open = app.graphStore.open.bind(app.graphStore);
    app.graphStore.open = async id => { const workspace = await open(id); entered.resolve(); await gate.promise; return workspace; };
    const count = app.activationCount(), pending = app.request(); await entered.promise;
    app.subject.activatePrompt(false, 600);
    const prompt = app.subject.session(); assert.equal(prompt.target, 'prompt');
    if (finish === 'complete') {
      app.subject.endCapture();
      await eventually(() => !!app.petActivation() && app.subject.session() === undefined, '新普通截图应正常完成');
    } else if (finish === 'cancel') app.subject.cancelCapture();
    const captures = app.captureRequests.length, activation = app.petActivation();
    gate.resolve(); await pending; await flush();
    assert.equal(app.activationCount(), count, `${kind}/${finish}: 旧入口不能重新打开图谱`);
    assert.equal(app.subject.session(), finish === 'active' ? prompt : undefined, `${kind}/${finish}: 旧入口不能替换新截图`);
    assert.equal(prompt.controller.signal.aborted, finish === 'cancel');
    assert.equal(app.captureRequests.length, captures); assert.equal(app.petActivation(), activation);
    assert.equal(app.calls.includes('native.beginSelection'), false);
  }
});

test('尚无CaptureSession时显式取消同样使三个图谱入口的迟到读取失效', async t => {
  for (const kind of ['activate', 'capture', 'images'] as const) {
    const app = await graphEntryFixture(t, kind), gate = deferred(), entered = deferred();
    const open = app.graphStore.open.bind(app.graphStore);
    app.graphStore.open = async id => { const workspace = await open(id); entered.resolve(); await gate.promise; return workspace; };
    const count = app.activationCount(), pending = app.request(); await entered.promise;
    assert.equal(app.subject.session(), undefined);
    await app.send('rabbit:cancel-capture'); gate.resolve(); await pending; await flush();
    assert.equal(app.activationCount(), count); assert.equal(app.subject.session(), undefined);
    assert.deepEqual(app.captureRequests, []); assert.equal(app.calls.includes('native.beginSelection'), false);
  }
});

test('并发图谱入口只执行最后一次请求，较早读取完成不能抢先覆盖待决请求', async t => {
  for (const kind of ['activate', 'capture', 'images'] as const) {
    const app = await graphEntryFixture(t, kind), gates = [deferred(), deferred(), deferred()], entered = gates.map(() => deferred());
    const open = app.graphStore.open.bind(app.graphStore); let reads = 0;
    app.graphStore.open = async id => {
      const index = reads++, workspace = await open(id);
      if (index < gates.length) { entered[index].resolve(); await gates[index].promise; }
      return workspace;
    };
    const count = app.activationCount(), pending = gates.map(() => app.request());
    await Promise.all(entered.map(item => item.promise));
    for (const index of [0, 1]) {
      gates[index].resolve(); await pending[index];
      assert.equal(app.activationCount(), count); assert.equal(app.subject.session(), undefined);
      assert.deepEqual(app.captureRequests, []);
    }
    gates[2].resolve();
    if (kind === 'images') {
      await eventually(() => app.subject.session()?.target === 'images', '最后一次图谱附图请求应开始');
      assert.equal(app.calls.filter(call => call === 'native.beginSelection').length, 1);
      app.subject.cancelCapture(); await pending[2];
    } else {
      await pending[2];
      await eventually(() => app.activationCount() === count + 1, '最后一次图谱入口应完成');
      assert.equal(app.captureRequests.length, kind === 'capture' ? 1 : 0);
    }
  }
});

test('新图按钮建立空白图谱，不自动截图或生成内容', async t => {
  const app = await desktop(t, { existing: true });
  const workspace = await app.send('rabbit:graph-mutate', app.workspace.id, { type: 'create-graph' });
  assert.equal(workspace.graphs.length, 2);
  const graph = workspace.graphs.find((item: { id: string }) => item.id === workspace.lastGraphId);
  assert.notEqual(graph.id, app.workspace.lastGraphId); assert.equal(graph.nodes.length, 0);
  assert.deepEqual(app.calls.filter(call => call.startsWith('capture:')), []);
  assert.equal(app.signals.length, 0); assert.equal(app.chatRequests.length, 0);
});

test('空白图截图只填入请求指定的图，保留其他图和已有资料', async t => {
  const app = await desktop(t, { existing: true });
  const created = await app.send('rabbit:graph-mutate', app.workspace.id, { type: 'create-graph' });
  const target = created.lastGraphId;
  await app.send('rabbit:graph-mutate', app.workspace.id, { type: 'visit', graphId: app.workspace.lastGraphId });
  await app.send('rabbit:graph-capture', { workspaceId: app.workspace.id, graphId: target }); await app.opened();
  const workspace = await app.graphStore.open(), filled = workspace.graphs.find(graph => graph.id === target)!;
  assert.equal(workspace.graphs.length, 2); assert.equal(workspace.lastGraphId, target);
  assert.equal(filled.nodes.length, 1); assert.equal(filled.nodes[0].images.length, 1); assert.equal(filled.nodes[0].images[0].source, 'window');
  assert.deepEqual(workspace.graphs.find(graph => graph.id === app.workspace.lastGraphId)?.nodes, app.workspace.graphs[0].nodes);
  assert.deepEqual(app.calls.filter(call => call.startsWith('capture:')), ['capture:window']);
  assert.equal(app.signals.length, 0); assert.equal(app.chatRequests.length, 0);
});

test('保存图谱独立启动键不打开或关闭任何窗口，也不采集屏幕', async t => {
  const app = await desktop(t);
  app.subject.showPanel('prompt');
  const owner = app.petActivation()!.activationId, petBounds = app.bounds(), petState = { ...app.petState };
  await app.send('rabbit:save-settings', { graphActivationShortcut: ['AltRight'] });
  assert.equal(app.activation(), undefined);
  assert.equal(app.petActivation()!.activationId, owner);
  assert.equal(app.subject.view(), 'prompt');
  assert.deepEqual(app.petState, petState); assert.deepEqual(app.bounds(), petBounds);
  assert.deepEqual(app.calls.filter(call => call.startsWith('capture:')), []);
});

test('图谱入口打开独立窗口，保留本体聊天轮次与坐标', async t => {
  const app = await desktop(t, { existing: true });
  app.subject.showPanel('prompt');
  const owner = app.petActivation()!.activationId, petBounds = app.bounds();
  await app.send('rabbit:graph-activate'); await app.opened();
  assert.equal(app.graphWindow.visible, true); assert.equal(app.activation()!.view, 'graph');
  assert.equal(app.subject.view(), 'prompt'); assert.equal(app.petActivation()!.activationId, owner);
  assert.deepEqual(app.bounds(), petBounds);
  assert.equal(app.petSent.some(item => item.channel === 'rabbit:dismiss'), false);
  assert.equal(app.petSent.filter(item => item.channel === 'rabbit:activate').length, 1);
  assert.equal(app.signals.length, 0);
});

test('保存无关设置不退出独立图谱或取消批注截图', async t => {
  const app = await desktop(t, { existing: true });
  await app.send('rabbit:graph-activate'); await app.opened();
  const owner = app.activation()!.activationId;
  await app.send('rabbit:focus-input', owner);
  await app.send('rabbit:save-settings', { eyeColor: '#3355FF' });
  assert.equal(app.graphWindow.visible, true); assert.equal(app.activation()!.activationId, owner);
  const graph = app.workspace.graphs[0], previousOverlays = app.calls.filter(call => call === 'overlays.show').length;
  const pending = app.send('rabbit:graph-capture-images', { workspaceId: app.workspace.id, graphId: graph.id, nodeId: graph.rootId });
  await eventually(() => app.calls.filter(call => call === 'overlays.show').length > previousOverlays, '批注框选应开启');
  const session = app.subject.session();
  await app.send('rabbit:save-settings', { eyeColor: '#55AA33' });
  assert.equal(app.subject.session(), session); assert.equal(session.controller.signal.aborted, false);
  assert.equal(app.graphWindow.visible, true); assert.equal(app.state.visible, false);
  app.subject.selectionPointer('down', { x: 100, y: 120 });
  app.subject.selectionPointer('up', { x: 340, y: 300 }); app.subject.endCapture();
  assert.equal((await pending).length, 1);
  assert.equal(app.activation()!.activationId, owner); assert.equal(app.state.ignoreMouse, false);
  assert.equal(app.sent.filter(item => item.channel === 'rabbit:dismiss').length, 0);
});

test('批注手动截图失败会取消原生框选并恢复可交互原图', async t => {
  const app = await desktop(t, { existing: true, desktopError: true });
  await app.send('rabbit:graph-open', app.workspace.id);
  await app.graphWindow.show({ workspaceId: app.workspace.id });
  const owner = app.activation()!.activationId; await app.send('rabbit:focus-input', owner);
  const graph = app.workspace.graphs[0];
  const images = await app.send('rabbit:graph-capture-images', { workspaceId: app.workspace.id, graphId: graph.id, nodeId: graph.rootId });
  assert.equal(images, null); assert.equal(app.subject.session(), undefined);
  assert.ok(app.calls.includes('native.cancelCapture:100')); assert.equal(app.calls.includes('overlays.show'), false);
  assert.equal(app.graphWindow.visible, true); assert.equal(app.activation()!.activationId, owner);
  assert.equal(app.state.visible, true); assert.equal(app.state.ignoreMouse, false); assert.equal(app.state.focusable, true);
  assert.match(app.sent.findLast(item => item.channel === 'rabbit:graph-error')?.value.message, /屏幕暂时不可读取/);
});

test('批注单次截图完成或取消后保留原图和激活轮次，不重置批注草稿', async t => {
  for (const cancel of [false, true]) {
    const app = await desktop(t, { existing: true });
    await app.send('rabbit:graph-open', app.workspace.id);
    await app.graphWindow.show({ workspaceId: app.workspace.id });
    const activation = app.activation()!; await app.send('rabbit:focus-input', activation.activationId);
    const before = await app.graphStore.readDocument(app.workspace.id), graph = app.workspace.graphs[0];
    const pending = app.send('rabbit:graph-capture-images', { workspaceId: app.workspace.id, graphId: graph.id, nodeId: graph.rootId });
    await eventually(() => app.calls.includes('overlays.show'), '点击批注相机后应立即进入单次框选');
    assert.ok(app.calls.includes('native.beginSelection'));
    assert.deepEqual(app.calls.filter(call => call.startsWith('capture:')), ['capture:desktop']);
    assert.equal(app.state.visible, false, '框选期间隐藏原图，避免把兔球界面截入资料');
    if (cancel) app.subject.cancelCapture();
    else {
      app.subject.selectionPointer('down', { x: 100, y: 120 });
      app.subject.selectionPointer('up', { x: 340, y: 300 });
      app.subject.endCapture();
    }
    const images = await pending;
    if (cancel) assert.equal(images, null);
    else {
      assert.equal(images.length, 1); assert.equal(images[0].source, 'region');
      assert.match(images[0].imageDataUrl, /^data:image\/jpeg;base64,/);
    }
    assert.equal(app.subject.session(), undefined); assert.equal(app.graphWindow.visible, true);
    assert.equal(app.state.visible, true); assert.equal(app.state.ignoreMouse, false); assert.equal(app.state.focusable, true);
    assert.equal(app.activation()!.activationId, activation.activationId);
    assert.equal(app.sent.filter(item => item.channel === 'rabbit:activate').length, 1, '返回截图只恢复窗口，不重新打开 renderer 图谱');
    assert.equal(app.sent.filter(item => item.channel === 'rabbit:dismiss').length, 0);
    assert.equal((await app.graphStore.readDocument(app.workspace.id)).markdown, before.markdown, '截图仅交给批注草稿，不擅自保存成资料节点');
    assert.equal(app.signals.length, 0);
  }
});

test('空图根草稿连续框选返回多图，确认截图不提前写入根节点或重开图谱', async t => {
  const app = await desktop(t);
  const empty = await app.send('rabbit:graph-mutate', app.workspace.id, { type: 'create-graph' }), graph = empty.graphs[0];
  await app.send('rabbit:graph-open', app.workspace.id);
  await app.graphWindow.show({ workspaceId: app.workspace.id });
  const activation = app.activation()!; await app.send('rabbit:focus-input', activation.activationId);
  const before = await app.graphStore.readDocument(app.workspace.id);
  const pending = app.send('rabbit:graph-capture-images', { workspaceId: app.workspace.id, graphId: graph.id });
  await eventually(() => app.calls.includes('overlays.show'), '根草稿相机应立即打开框选层');
  assert.equal(app.state.visible, false);
  for (const [x, y] of [[100, 100], [600, 250]]) {
    app.subject.selectionPointer('down', { x, y }); app.subject.selectionPointer('up', { x: x + 200, y: y + 150 });
  }
  assert.equal(app.subject.session().context.images.length, 2, '同一次截图会话允许连续添加多个选区');
  assert.equal((await app.graphStore.open(app.workspace.id)).graphs[0].nodes.length, 0);
  app.subject.endCapture();
  const images = await pending;
  assert.equal(images.length, 2); assert.notEqual(images[0].id, images[1].id);
  assert.ok(images.every((image: any) => image.source === 'region' && /^data:image\/jpeg;base64,/.test(image.imageDataUrl)));
  assert.equal(app.subject.session(), undefined); assert.equal(app.graphWindow.visible, true);
  assert.equal(app.state.visible, true); assert.equal(app.state.ignoreMouse, false);
  assert.equal(app.activation()!.activationId, activation.activationId);
  assert.equal(app.sent.filter(item => item.channel === 'rabbit:activate').length, 1);
  assert.equal((await app.graphStore.readDocument(app.workspace.id)).markdown, before.markdown);
  assert.equal((await app.graphStore.open(app.workspace.id)).graphs[0].rootId, graph.rootId);
  assert.equal((await app.graphStore.open(app.workspace.id)).graphs[0].nodes.length, 0, '返回的图片仅由根草稿持有');
  assert.deepEqual(app.calls.filter(call => call.startsWith('capture:')), ['capture:desktop']);
  assert.equal(app.signals.length, 0);
});

test('根草稿截图取消丢弃本次选区，保留空图和原激活轮次', async t => {
  const app = await desktop(t), empty = await app.send('rabbit:graph-mutate', app.workspace.id, { type: 'create-graph' }), graph = empty.graphs[0];
  await app.send('rabbit:graph-open', app.workspace.id);
  await app.graphWindow.show({ workspaceId: app.workspace.id });
  const activation = app.activation()!; await app.send('rabbit:focus-input', activation.activationId);
  const pending = app.send('rabbit:graph-capture-images', { workspaceId: app.workspace.id, graphId: graph.id });
  await eventually(() => app.calls.includes('overlays.show'), '根草稿截图应开始');
  app.subject.selectionPointer('down', { x: 100, y: 100 }); app.subject.selectionPointer('up', { x: 400, y: 300 });
  app.subject.cancelCapture();
  assert.equal(await pending, null); assert.equal(app.subject.session(), undefined);
  const after = await app.graphStore.open(app.workspace.id);
  assert.equal(after.graphs.length, 1); assert.equal(after.graphs[0].rootId, graph.rootId); assert.equal(after.graphs[0].nodes.length, 0);
  assert.equal(app.graphWindow.visible, true); assert.equal(app.state.visible, true); assert.equal(app.state.ignoreMouse, false);
  assert.equal(app.activation()!.activationId, activation.activationId);
});

test('根草稿截图拒绝非空图，不开始截图也不改变已有根', async t => {
  const app = await desktop(t, { existing: true }), graph = app.workspace.graphs[0];
  await app.send('rabbit:graph-open', app.workspace.id);
  await app.graphWindow.show({ workspaceId: app.workspace.id });
  await app.send('rabbit:focus-input', app.activation()!.activationId);
  const before = await app.graphStore.readDocument(app.workspace.id);
  await assert.rejects(app.send('rabbit:graph-capture-images', { workspaceId: app.workspace.id, graphId: graph.id }), /已有根节点/);
  assert.equal(app.subject.session(), undefined); assert.equal(app.calls.includes('native.beginSelection'), false);
  assert.equal(app.calls.some(call => call.startsWith('capture:')), false);
  assert.equal((await app.graphStore.readDocument(app.workspace.id)).markdown, before.markdown);
  assert.equal(app.graphWindow.visible, true); assert.equal(app.state.ignoreMouse, false);
});

test('图谱关闭后批注截图读取或原生握手迟到不能重新开启框选', async t => {
  for (const phase of ['read', 'native'] as const) {
    const readGate = deferred(), nativeGate = deferred<number>();
    const app = await desktop(t, { existing: true, ...(phase === 'native' ? { selectionGate: nativeGate.promise } : {}) });
    await app.send('rabbit:graph-open', app.workspace.id);
    await app.graphWindow.show({ workspaceId: app.workspace.id });
    await app.send('rabbit:focus-input', app.activation()!.activationId);
    const graph = app.workspace.graphs[0];
    if (phase === 'read') {
      const open = app.graphStore.open.bind(app.graphStore);
      app.graphStore.open = async id => { const workspace = await open(id); await readGate.promise; return workspace; };
    }
    const pending = app.send('rabbit:graph-capture-images', { workspaceId: app.workspace.id, graphId: graph.id, nodeId: graph.rootId });
    if (phase === 'native') await eventually(() => app.calls.includes('native.beginSelection'), '原生框选握手应开始');
    app.graphWindow.hide();
    app.subject.cancelCapture();
    app.subject.showPanel('settings');
    const settingsOwner = app.petActivation()!.activationId;
    app.petSend('rabbit:set-interactive', true, settingsOwner);
    readGate.resolve(); nativeGate.resolve(101);
    assert.equal(await pending, null); await flush();
    assert.equal(app.subject.session(), undefined); assert.equal(app.subject.view(), 'settings');
    assert.equal(app.petActivation()!.activationId, settingsOwner); assert.equal(app.petActivation()!.view, 'settings');
    assert.equal(app.graphWindow.visible, false);
    assert.equal(app.petState.ignoreMouse, false); assert.equal(app.petState.focusable, true);
    if (phase === 'read') assert.equal(app.calls.includes('native.beginSelection'), false);
    else assert.ok(app.calls.includes('native.cancelCapture:101'), '迟到原生框选编号必须立即取消，避免后续鼠标被吞');
  }
});

test('批注截图期间停用插件返回空结果且不恢复已退出图谱', async t => {
  const app = await desktop(t, { existing: true });
  await app.send('rabbit:graph-open', app.workspace.id);
  await app.graphWindow.show({ workspaceId: app.workspace.id });
  await app.send('rabbit:focus-input', app.activation()!.activationId);
  const graph = app.workspace.graphs[0];
  const pending = app.send('rabbit:graph-capture-images', { workspaceId: app.workspace.id, graphId: graph.id, nodeId: graph.rootId });
  await eventually(() => app.calls.includes('overlays.show'), '批注框选应进入');
  await app.send('rabbit:save-settings', { graphPluginEnabled: false });
  assert.equal(await pending, null); assert.equal(app.subject.session(), undefined); assert.equal(app.subject.view(), undefined);
  assert.equal(app.state.visible, false);
  assert.equal((await app.graphStore.open()).graphs[0].nodes[0].images.length, 1);
});

test('图谱快速会话等待读取路径时取消或改发问题，旧请求不再开始模型调用', async t => {
  for (const replacement of [false, true]) {
    const app = await desktop(t, { existing: true }), gate = deferred();
    const open = app.graphStore.open.bind(app.graphStore);
    app.graphStore.open = async id => { const workspace = await open(id); await gate.promise; return workspace; };
    const graph = app.workspace.graphs[0];
    const pending = app.send('rabbit:send-message', { id: 'old-request', conversationId: 'conversation', turnId: 'old-turn', text: '解释这张卡片',
      graphContext: { workspaceId: app.workspace.id, graphId: graph.id, nodeId: graph.rootId } });
    if (replacement) await app.send('rabbit:send-message', { id: 'new-request', conversationId: 'conversation', turnId: 'new-turn', text: '改问一个问题' });
    else app.send('rabbit:cancel-message', 'old-request');
    gate.resolve(); await Promise.allSettled([pending]); await flush();
    assert.deepEqual(app.chatRequests.map(request => request.id), replacement ? ['new-request'] : []);
    assert.ok(app.sent.some(item => item.channel === 'rabbit:agent-event' && item.value.id === 'old-request' && item.value.type === 'cancelled'));
  }
});

test('关闭图谱立即取消并保存图谱聊天，保留并发本体的会话、上下文与token归属', async t => {
  const gate = deferred(), app = await desktop(t, { chatGate: gate.promise });
  t.after(() => gate.resolve());
  app.subject.activatePrompt();
  await eventually(() => !!app.subject.context(), '本体已保存独立截图上下文');
  const context = app.subject.context();
  await app.graphWindow.show({ workspaceId: app.workspace.id });
  const request = { id: 'same-request', conversationId: 'same-conversation', turnId: 'turn', text: '解释内容' };
  await app.petSend('rabbit:send-message', { ...request, contextId: context.id, imageIds: context.images.map((image: any) => image.id) });
  await app.send('rabbit:send-message', request);
  assert.equal(app.chatRuns.length, 2);
  const [pet, graph] = app.chatRuns;
  assert.equal(pet.signal.aborted, false, '图谱开始聊天不能取消本体请求');
  assert.notEqual(pet.conversation, graph.conversation, '同名会话仍不能复用另一窗口的可变模型会话');
  pet.onEvent({ id: request.id, type: 'delta', text: '本体回复' });
  graph.onEvent({ id: request.id, type: 'delta', text: '图谱回复' });
  assert.deepEqual(app.petSent.filter(item => item.channel === 'rabbit:agent-event').map(item => item.value.text), ['本体回复']);
  assert.deepEqual(app.sent.filter(item => item.channel === 'rabbit:agent-event').map(item => item.value.text), ['图谱回复']);
  const saves = app.historyRuns.map(run => run.saves);
  app.send('rabbit:hide-panel', app.graphWindow.activationId);
  assert.equal(graph.signal.aborted, true); assert.equal(pet.signal.aborted, false);
  assert.equal(app.historyRuns[1].saves, saves[1] + 1, '主进程关闭回调立即保存图谱生成进度');
  assert.equal(app.historyRuns[1].events.at(-1)?.type, 'cancelled');
  assert.equal(app.historyRuns[0].saves, saves[0]);
  assert.equal(app.historyRuns[0].events.some(event => event.type === 'cancelled'), false);
  assert.equal(app.subject.context(), context); assert.equal(app.subject.petConversation(), pet.conversation);
  assert.equal(app.subject.view(), 'prompt');
  app.send('rabbit:cancel-message', request.id);
  assert.equal(pet.signal.aborted, false, '图谱迟到的同ID取消不能终止本体请求');
  graph.onEvent({ id: request.id, type: 'delta', text: '已取消的迟到回复' });
  assert.equal(app.sent.some(item => item.value.text === '已取消的迟到回复'), false);
  app.petSend('rabbit:cancel-message', request.id);
  assert.equal(pet.signal.aborted, true);
  gate.resolve(); await flush();
});

test('图谱附图截图的暂时隐藏、取消与完成均不终止两窗聊天', async t => {
  for (const cancel of [false, true]) {
    const gate = deferred(), app = await desktop(t, { existing: true, chatGate: gate.promise });
    t.after(() => gate.resolve());
    await app.graphWindow.show({ workspaceId: app.workspace.id });
    await app.petSend('rabbit:send-message', { id: 'pet-chat', conversationId: 'pet', turnId: 'turn', text: '本体问题' });
    await app.send('rabbit:send-message', { id: 'graph-chat', conversationId: 'graph', turnId: 'turn', text: '图谱问题' });
    const graph = app.workspace.graphs[0];
    const pending = app.send('rabbit:graph-capture-images', { workspaceId: app.workspace.id, graphId: graph.id, nodeId: graph.rootId });
    await eventually(() => app.calls.includes('overlays.show'), '附图截图已进入框选');
    assert.equal(app.graphWindow.visible, true); assert.equal(app.state.visible, false);
    assert.ok(app.chatRuns.every(run => !run.signal.aborted), '暂时隐藏不能当作图谱关闭');
    app.subject.selectionPointer('down', { x: 100, y: 100 }); app.subject.selectionPointer('up', { x: 300, y: 250 });
    if (cancel) app.subject.cancelCapture(); else app.subject.endCapture();
    assert.equal((await pending) === null, cancel);
    assert.ok(app.chatRuns.every(run => !run.signal.aborted));
    assert.ok(app.historyRuns.every(run => !run.events.some(event => event.type === 'cancelled')));
    assert.equal(app.graphWindow.visible, true); assert.equal(app.state.visible, true);
    gate.resolve(); await flush();
  }
});

test('图谱素材缓存按接收窗口独立，新窗口与单窗重载都收到全文', async t => {
  const app = await desktop(t, { existing: true });
  const attachment = { id: 'document', name: '资料.md', mimeType: 'text/markdown', text: '文档全文' };
  const workspace = { ...app.workspace, background: { text: '', attachments: [attachment] },
    graphs: app.workspace.graphs.map(graph => ({ ...graph, nodes: graph.nodes.map(node => ({ ...node, attachments: [attachment] })) })) };
  const latest = (sent: typeof app.sent) => sent.findLast(item => item.channel === 'rabbit:graph-changed')!.value;
  const full = (packet: any) => {
    assert.equal(packet.graphs[0].nodes[0].images[0].imageDataUrl, originalCapture.images[0].imageDataUrl);
    assert.equal(packet.graphs[0].nodes[0].attachments[0].text, attachment.text);
    assert.equal(packet.background.attachments[0].text, attachment.text);
  };
  const compact = (packet: any) => {
    assert.equal(packet.graphs[0].nodes[0].images[0].imageDataUrl, '');
    assert.equal(packet.graphs[0].nodes[0].attachments[0].text, undefined);
    assert.equal(packet.background.attachments[0].text, undefined);
  };
  app.subject.graphAvailable(false); app.subject.graphChanged(workspace);
  full(latest(app.petSent)); assert.equal(app.sent.some(item => item.channel === 'rabbit:graph-changed'), false);
  app.subject.graphAvailable(true); app.subject.graphChanged(workspace);
  compact(latest(app.petSent)); full(latest(app.sent));
  app.subject.graphChanged(workspace); compact(latest(app.petSent)); compact(latest(app.sent));
  app.subject.clearGraphCache(); app.subject.graphChanged(workspace);
  compact(latest(app.petSent)); full(latest(app.sent));
});

test('图谱关闭和交互IPC不改变本体聊天、坐标或鼠标命中', async t => {
  const app = await desktop(t);
  app.subject.showPanel('prompt');
  const petOwner = app.petActivation()!.activationId;
  app.petSend('rabbit:set-interactive', true, petOwner);
  await app.graphWindow.show({ workspaceId: app.workspace.id });
  const graphOwner = app.activation()!.activationId, petState = { ...app.petState }, petBounds = app.bounds();
  app.send('rabbit:set-interactive', false, petOwner);
  app.send('rabbit:set-graph-pin-regions', { rects: [{ x: 0, y: 0, width: 1440, height: 900 }] });
  assert.equal(await app.send('rabbit:graph-pin-interaction', { phase: 'down', point: { x: 1, y: 1 } }), false);
  app.send('rabbit:hide-panel', graphOwner);
  assert.equal(app.graphWindow.visible, false); assert.equal(app.state.visible, false);
  assert.equal(app.subject.view(), 'prompt'); assert.equal(app.petActivation()!.activationId, petOwner);
  assert.deepEqual(app.petState, petState); assert.deepEqual(app.bounds(), petBounds);
  assert.equal(app.petSent.some(item => item.channel === 'rabbit:dismiss'), false);
});

test('图谱设置广播两窗，图谱不能通过宠物位置IPC移动本体', async t => {
  const app = await desktop(t), before = app.bounds();
  const remote = { bounds: { x: 1800, y: 0, width: 1200, height: 900 }, workArea: { x: 1800, y: 0, width: 1200, height: 860 } };
  app.screen.getAllDisplays = () => [{ bounds: before, workArea: before }, remote];
  app.screen.getDisplayNearestPoint = () => remote;
  app.send('rabbit:pet-position', { x: 1900, y: 100 });
  assert.deepEqual(app.bounds(), before);
  assert.equal(await app.send('rabbit:pet-viewport-ready', 1), false);
  await app.send('rabbit:save-settings', { eyeColor: '#3355FF' });
  assert.equal(app.petSent.findLast(item => item.channel === 'rabbit:settings-changed')?.value.eyeColor, '#3355FF');
  assert.equal(app.sent.findLast(item => item.channel === 'rabbit:settings-changed')?.value.eyeColor, '#3355FF');
  app.petSend('rabbit:pet-position', { x: 1900, y: 100 });
  assert.deepEqual(app.bounds(), remote.workArea, '同一坐标由本体发送仍正常换屏');
});

function renderer(options: { focus?: (epoch: number) => Promise<boolean>; graphOpen?: () => Promise<void>; hide?: (epoch: number) => void } = {}) {
  const events = new EventEmitter(), hides: number[] = [], focuses: number[] = [];
  const ui = { graph: false, chat: false, settings: false, opening: false };
  let activationListener!: (activation: Activation) => Promise<void>, dismissListener!: (id: number) => void;
  let epoch = 0;
  const document = { addEventListener: events.on.bind(events), dispatchEvent: (event: any) => events.emit(event.type, event),
    querySelector(selector: string) { return (selector.includes('rabbit-graph') && ui.graph || selector.includes('rabbit-chat') && ui.chat || selector.includes('rabbit-settings') && ui.settings) ? {} : null; } };
  const window: any = {
    rabbitDesktop: { surface: 'graph', onGraphVisibilityChanged() {}, onActivate(listener: typeof activationListener) { activationListener = listener; }, onDismiss(listener: typeof dismissListener) { dismissListener = listener; },
      onCaptureEvent() {}, onCursor() {}, onPointerDown() {}, onSuspended() {}, onSettingsChanged() {}, hidePanel(id: number) { hides.push(id); options.hide?.(id); },
      async focusInput(id: number) { focuses.push(id); return options.focus ? options.focus(id) : true; } },
    RabbitCapture: { finishNative() {}, handleEvent() {} },
    RabbitSettings: { open: async () => { ui.settings = true; }, close: () => { ui.settings = false; }, applySettings() {} },
    RabbitGraph: { isOpen: () => ui.graph, open: async () => { ui.graph = true; await options.graphOpen?.(); },
      close() { ui.graph = false; document.dispatchEvent({ type: 'graph:close', detail: { activationId: epoch } }); } },
    RabbitChat: { getSnapshot: () => ({ opening: ui.opening, open: ui.chat }), activate: async () => { ui.chat = true; },
      close() { if (!ui.chat) return; ui.chat = false; document.dispatchEvent({ type: 'chat:close', detail: { activationId: epoch, graph: true } }); } },
  };
  vm.runInNewContext(readFileSync(new URL('../prototype/assistant.js', import.meta.url), 'utf8'), {
    window, document, DOMException, setTimeout, clearTimeout, CustomEvent: class {
      type: string; detail: unknown; constructor(type: string, options: any) { this.type = type; this.detail = options.detail; }
    },
  });
  return { ui, hides, focuses, chat: window.RabbitChat, graph: window.RabbitGraph,
    activate(activation: Activation) { epoch = activation.activationId; return activationListener(activation); }, dismiss: (id: number) => dismissListener(id) };
}

test('真实renderer图谱就绪握手只聚焦独立图谱，不改变本体交互', async t => {
  const app = await desktop(t, { existing: true }), gate = deferred();
  const page = renderer({ graphOpen: () => gate.promise, focus: id => app.send('rabbit:focus-input', id) });
  app.subject.activateGraph(false, 30); app.subject.endCapture(); await app.opened();
  const activation = app.activation()!, pending = page.activate(activation);
  const petState = { ...app.petState };
  assert.equal(app.state.ignoreMouse, false); assert.equal(app.state.focusable, true);
  assert.deepEqual(page.focuses, [], '图谱数据就绪前仍保持原生待就绪阶段');
  gate.resolve(); await pending;
  assert.deepEqual(page.focuses, [activation.activationId]);
  assert.equal(app.state.ignoreMouse, false, '系统鼠标点击和滚轮必须交给图谱窗口');
  assert.equal(app.state.focusable, true); assert.equal(page.ui.graph, true);
  assert.deepEqual(app.petState, petState);
  assert.deepEqual(page.hides, []);
});

test('根草稿及批注截图完成或取消后，renderer退出只隐藏独立图谱', async t => {
  for (const kind of ['root', 'annotation'] as const) for (const cancel of [false, true]) {
    const app = await desktop(t, { existing: kind === 'annotation' });
    const workspace = kind === 'root'
      ? await app.send('rabbit:graph-mutate', app.workspace.id, { type: 'create-graph' })
      : app.workspace;
    const graph = workspace.graphs[0];
    const page = renderer({ focus: id => app.send('rabbit:focus-input', id), hide: id => app.send('rabbit:hide-panel', id) });
    await app.send('rabbit:graph-open', app.workspace.id);
    await app.graphWindow.show({ workspaceId: app.workspace.id });
    const activation = app.activation()!; await page.activate(activation);
    assert.equal(app.graphWindow.visible, true); assert.equal(app.state.ignoreMouse, false);
    const before = await app.graphStore.readDocument(app.workspace.id);
    const pending = app.send('rabbit:graph-capture-images', { workspaceId: app.workspace.id, graphId: graph.id,
      ...(kind === 'annotation' ? { nodeId: graph.rootId } : {}) });
    await eventually(() => app.calls.includes('overlays.show'), `${kind}截图必须进入真实截图会话`);
    const sessionId = app.subject.session().id;
    assert.equal(page.ui.graph, true); assert.deepEqual(page.hides, [], '截图期间保留原图谱renderer和激活归属');
    app.subject.selectionPointer('down', { x: 100, y: 100 }); app.subject.selectionPointer('up', { x: 400, y: 300 });
    if (cancel) app.subject.cancelCapture(); else app.subject.endCapture();
    const images = await pending;
    assert.equal(images === null, cancel);
    assert.equal(app.subject.session(), undefined); assert.equal(app.graphWindow.visible, true);
    assert.equal(app.activation()!.activationId, activation.activationId);
    assert.equal(app.sent.filter(item => item.channel === 'rabbit:activate').length, 1, '截图只恢复原窗口，不依赖新的激活重置renderer');
    assert.ok(app.sent.some(item => item.channel === 'rabbit:capture-event' && item.value.sessionId === sessionId && item.value.type === (cancel ? 'cancel' : 'end')));
    assert.deepEqual(page.hides, []);
    page.graph.close(); await flush();
    assert.deepEqual(page.hides, [activation.activationId], '退出事件必须携带仍有效的原激活轮次');
    assert.equal(app.subject.view(), undefined, '本体不能出现graph面板状态');
    assert.equal(app.graphWindow.visible, false); assert.equal(app.state.visible, false);
    assert.equal(app.petState.ignoreMouse, true, '本体保持原有空闲穿透');
    assert.equal(app.petState.focusable, false);
    assert.equal((await app.graphStore.readDocument(app.workspace.id)).markdown, before.markdown);
  }
});

test('图谱已经呈现时附加操作失败仍完成原生焦点握手', async t => {
  const app = await desktop(t, { existing: true });
  const page = renderer({ graphOpen: async () => { throw new Error('图谱名称暂时无法读取'); }, focus: id => app.send('rabbit:focus-input', id) });
  await app.graphWindow.show({ workspaceId: app.workspace.id, graphAction: 'rename-graph' });
  const activation = app.activation()!;
  assert.equal(app.state.ignoreMouse, false); assert.equal(app.state.focusable, true);
  await assert.rejects(page.activate(activation), /图谱名称暂时无法读取/);
  assert.deepEqual(page.focuses, [activation.activationId]);
  assert.equal(page.ui.graph, true); assert.deepEqual(page.hides, []);
  assert.equal(app.state.ignoreMouse, false, '附加操作失败不能让已打开图谱继续穿透系统鼠标');
  assert.equal(app.state.focusable, true);
});

test('图谱关闭后异步打开完成不能再争抢焦点', async () => {
  const gate = deferred(), page = renderer({ graphOpen: () => gate.promise });
  const pending = page.activate({ activationId: 31, view: 'graph', workspaceId: 'workspace' });
  page.dismiss(31);
  gate.resolve(); await pending;
  assert.deepEqual(page.focuses, []); assert.equal(page.ui.graph, false); assert.equal(page.ui.chat, false);
});

test('独立图谱页面忽略本体激活，不切走正在打开的图谱', async () => {
  const gate = deferred(), page = renderer({ graphOpen: () => gate.promise });
  const pending = page.activate({ activationId: 31, view: 'graph', workspaceId: 'workspace' });
  await page.activate({ activationId: 32, view: 'prompt' });
  gate.resolve(); await pending;
  assert.deepEqual(page.focuses, [31]); assert.equal(page.ui.graph, true); assert.equal(page.ui.chat, false);
});

test('新图谱已获得焦点后旧图谱打开完成不能再次握手', async () => {
  const gate = deferred(); let opens = 0;
  const page = renderer({ graphOpen: async () => { if (++opens === 1) await gate.promise; } });
  const old = page.activate({ activationId: 34, view: 'graph', workspaceId: 'old-workspace' });
  await page.activate({ activationId: 35, view: 'graph', workspaceId: 'new-workspace' });
  assert.deepEqual(page.focuses, [35]); assert.equal(page.ui.graph, true);
  gate.resolve(); await old;
  assert.deepEqual(page.focuses, [35], '图仍打开时也必须按激活轮次拒绝旧请求');
  assert.equal(page.ui.graph, true); assert.deepEqual(page.hides, []);
});

test('原生聚焦失败或拒绝不会关闭已经就绪的图谱', async () => {
  for (const reject of [false, true]) {
    const page = renderer({ focus: async () => { if (reject) throw new Error('窗口未获得前台权限'); return false; } });
    await page.activate({ activationId: 33, view: 'graph', workspaceId: 'workspace' });
    assert.deepEqual(page.focuses, [33]); assert.equal(page.ui.graph, true); assert.deepEqual(page.hides, []);
  }
});

test('真实renderer适配器在快速会话关闭时保留图谱，退出通知只影响当前轮次', async () => {
  const page = renderer(); await page.activate({ activationId: 10, view: 'graph', workspaceId: 'workspace' });
  assert.equal(page.ui.graph, true); assert.equal(page.ui.chat, false);
  page.ui.chat = true; page.chat.close(); assert.equal(page.ui.graph, true); assert.deepEqual(page.hides, []);
  page.dismiss(9); assert.equal(page.ui.graph, true);
  page.dismiss(10); assert.equal(page.ui.graph, false);
});


test('图谱初始窗口图成功而背景缺失时仍创建根节点', async t => {
  const app = await desktop(t, { missingBackground: true });
  app.subject.activateGraph(false, 200); app.subject.endCapture(); await app.opened();
  const workspace = await app.graphStore.open();
  assert.equal(workspace.graphs[0].nodes[0].images.length, 1);
  assert.equal(workspace.graphs[0].nodes[0].images[0].source, 'window');
  assert.equal(app.activation()?.backgroundImageDataUrl, undefined);
  assert.equal(app.sent.some(item => item.channel === 'rabbit:graph-error'), false);
});

test('图谱窗口截图失败时背景仍可显示，但不能保存为根资料', async t => {
  const app = await desktop(t, { missingWindowImage: true });
  app.subject.activateGraph(false, 201); app.subject.endCapture(); await app.opened();
  const workspace = await app.graphStore.open();
  assert.equal(workspace.graphs[0].nodes.length, 0);
  assert.match(app.activation()?.backgroundImageDataUrl ?? '', /^data:image\/jpeg;base64,/);
  assert.equal(app.sent.some(item => item.channel === 'rabbit:graph-error'), true);
});
