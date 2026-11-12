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

async function desktop(t: TestContext, options: { existing?: boolean; mode?: boolean; captureGate?: Promise<void>; focusGate?: Promise<boolean>; selectionGate?: Promise<number>; desktopError?: boolean; missingBackground?: boolean; missingWindowImage?: boolean } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'rabbitball-graph-activation-'));
  const graphStore = new GraphStore(directory, () => {});
  await graphStore.load();
  let workspace = await graphStore.create('阅读工作区');
  if (options.existing) {
    workspace = await graphStore.mutate(workspace.id, { type: 'create-graph', title: originalCapture.title });
    workspace = await graphStore.attachCapture(workspace.id, workspace.lastGraphId!, originalCapture);
  }
  let settings = { autoCopyScreenshots: false, eyeColor: '#F90040', activationShortcut: ['AltLeft'], followMouse: true,
    graphPluginEnabled: true, graphModeEnabled: options.mode ?? true, pauseOnFullscreen: true, launchAtLogin: false, historyLimit: 10, prompts: DEFAULT_PROMPTS };
  const captureRequests: any[] = [], decodedWindowImages: string[] = [];
  const calls: string[] = [], signals: AbortSignal[] = [];
  const chatRequests: Array<{ id: string }> = [];
  const jobs = new GraphJobs(graphStore, () => settings as unknown as PrivateSettings, {
    run: async (_request, _settings, { signal }) => {
      signals.push(signal);
      await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); });
    },
  });
  const graphJobs = {
    cancelAll() { calls.push('jobs.cancelAll'); jobs.cancelAll(); },
    cancel: jobs.cancel.bind(jobs), generate: jobs.generate.bind(jobs), regenerate: jobs.regenerate.bind(jobs),
  };
  const sent: Array<{ channel: string; value: any }> = [];
  const handlers = new Map<string, (...args: any[]) => any>();
  const state = { visible: false, focusable: false, ignoreMouse: true, opacity: 1 };
  let bounds = { x: 0, y: 0, width: 1440, height: 900 };
  const webContents = { mainFrame: {}, send(channel: string, value: any) { sent.push({ channel, value }); },
    focus() { calls.push('webContents.focus'); }, capturePage: async () => {} };
  const window = {
    webContents, isDestroyed: () => false, isVisible: () => state.visible, isFocused: () => false, isFocusable: () => state.focusable,
    setFocusable(value: boolean) { state.focusable = value; }, setIgnoreMouseEvents(value: boolean) { state.ignoreMouse = value; },
    setSkipTaskbar() {}, setAlwaysOnTop() {}, setOpacity(value: number) { state.opacity = value; },
    setBounds(value: typeof bounds) { bounds = value; }, getBounds: () => bounds, getPosition: () => [bounds.x, bounds.y],
    getNativeWindowHandle: () => Buffer.from([42, 0, 0, 0, 0, 0, 0, 0]),
    show() { state.visible = true; }, showInactive() { state.visible = true; }, focus() { calls.push('window.focus'); },
    moveTop() { calls.push('window.moveTop'); },
    hide() { state.visible = false; },
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
    __window: window, __graphStore: graphStore, __graphJobs: graphJobs,
    __store: { getPublic: () => ({ ...settings }), getPrivate: () => ({ ...settings }), async save(patch: Partial<typeof settings>) { settings = { ...settings, ...patch }; if (!settings.graphPluginEnabled) settings.graphModeEnabled = false; return { ...settings }; } },
    __historyStore: { getConversation: () => undefined, list: () => [], begin: () => ({ onEvent() {}, save: async () => {} }), setLimit: async () => {} },
    __native: { configure: async () => {}, cancelFocus() {}, cancelCapture(id: number) { calls.push('native.cancelCapture:' + id); },
      beginSelection: () => { calls.push('native.beginSelection'); return options.selectionGate ?? Promise.resolve(100); }, focusWindow: () => options.focusGate ?? Promise.resolve(false) },
    __overlays: { close() { calls.push('overlays.close'); }, show: async () => { calls.push('overlays.show'); }, frame() {}, image() {}, owns: () => false },
    here: '.', path, randomUUID, imageCropRect, selectionRect, unionBounds, nativeShortcut: (value: unknown) => value,
    validateSettingsPatch: (value: unknown) => value,
    markCaptureCursor(value: unknown) { calls.push('markCursor'); return value; },
    nativeImage: { createFromBuffer: (value: Buffer) => { decodedWindowImages.push(value.toString('base64')); return image(); }, createFromBitmap: () => image(), createFromDataURL: (value: string) => { decodedWindowImages.push(value); return image(); }, createEmpty: () => ({ isEmpty: () => true }) },
    createAgentConversation: () => ({}), buildGraphChatContext,
    runAgent: async (request: { id: string }) => { chatRequests.push(request); },
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
    window=__window; windowsNative=__native; store=__store; historyStore=__historyStore; graphStore=__graphStore; graphJobs=__graphJobs; captureOverlays=__overlays;
    registerIpc();
    globalThis.subject={activatePrompt,focusInput,cancelCapture,endCapture,holdCapture,selectionPointer,showPanel,
      session:()=>captureSession,view:()=>panelView};
  `, context);
  const subject = context.subject;
  t.after(async () => {
    subject.cancelCapture(); jobs.cancelAll(); await jobs.idle();
    await graphStore.dispose(); await rm(directory, { recursive: true, force: true });
  });
  const event = { sender: webContents, senderFrame: webContents.mainFrame };
  return { subject, state, calls, captureRequests, decodedWindowImages, sent, graphStore, graphJobs, jobs, workspace, signals, chatRequests,
    activation: () => sent.findLast(item => item.channel === 'rabbit:activate')?.value as Activation | undefined,
    async opened() {
      await eventually(() => sent.findLast(item => item.channel === 'rabbit:activate')?.value.view === 'graph' || sent.some(item => item.channel === 'rabbit:graph-error'), '图谱激活应完成');
      assert.equal(subject.view(), 'graph', JSON.stringify(sent.filter(item => item.channel === 'rabbit:graph-error')));
    },
    send(channel: string, ...args: unknown[]) { assert.ok(handlers.has(channel), '调用实际注册的 IPC'); return handlers.get(channel)!(event, ...args); },
  };
}

test('打开文档文件夹只打开当前工作区目录，不激活窗口或采集屏幕', async t => {
  const app=await desktop(t,{existing:true});
  await app.send('rabbit:graph-reveal-document',app.workspace.id);
  assert.deepEqual(app.calls,['folder:'+app.graphStore.getDirectory(app.workspace.id)]);
  assert.equal(app.activation(),undefined);assert.equal(app.state.visible,false);
});

test('大爆炸短按恢复已有图，只刷新桌面背景，不重拍应用或改变原图', async t => {
  const app = await desktop(t, { existing: true }), before = await app.graphStore.readDocument(app.workspace.id);
  app.subject.activatePrompt(false, 1); app.subject.endCapture();
  await eventually(() => app.activation()?.view === 'graph', '应打开已有图');
  assert.deepEqual(app.calls.filter(call => call.startsWith('capture:')), ['capture:desktop']);
  assert.deepEqual(app.captureRequests, [{ type: 'desktop', bounds: { x: 0, y: 0, width: 1440, height: 900 } }]);
  assert.equal(app.activation()?.workspaceId, app.workspace.id);
  assert.match(app.activation()?.backgroundImageDataUrl ?? '', /^data:image\/jpeg;base64,/);
  assert.equal((await app.graphStore.open()).lastGraphId, app.workspace.lastGraphId);
  assert.equal((await app.graphStore.readDocument(app.workspace.id)).markdown, before.markdown);
  assert.equal(app.signals.length, 0); assert.equal(app.chatRequests.length, 0);
});

test('工作区无图时短按保存独立窗口图为初始节点，并请求桌面模糊背景', async t => {
  const app = await desktop(t);
  app.subject.activatePrompt(false, 2); app.subject.endCapture();
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
  app.subject.activatePrompt(false, 3); app.subject.holdCapture(app.subject.session());
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

test('图谱激活等待就绪后保持全画布可交互，重复激活退出且旧焦点回执不重开', async t => {
  const focus = deferred<boolean>(), app = await desktop(t, { existing: true, focusGate: focus.promise });
  app.subject.activatePrompt(); await eventually(() => app.activation()?.view === 'graph', '应打开图谱');
  const epoch = app.activation()!.activationId;
  assert.equal(app.state.focusable, false); assert.equal(app.state.ignoreMouse, true);
  const pending = app.subject.focusInput(epoch);
  assert.equal(app.state.focusable, true); assert.equal(app.state.ignoreMouse, false);
  app.send('rabbit:set-interactive', false, epoch);
  assert.equal(app.state.ignoreMouse, false, '图谱内移动到空白区域也不能穿透到桌面');
  assert.equal(app.state.opacity, 1, '整屏图谱直接显示原窗口');
  const captures = app.calls.filter(call => call.startsWith('capture:')).length;
  app.subject.activatePrompt(false, 4); focus.resolve(true); assert.equal(await pending, false);
  assert.equal(app.subject.view(), undefined); assert.equal(app.subject.session(), undefined);
  assert.equal(app.calls.filter(call => call.startsWith('capture:')).length, captures);
  assert.equal(app.sent.findLast(item => item.channel === 'rabbit:dismiss')?.value, epoch);
  assert.equal(app.state.opacity, 1, '退出图谱后仍直接显示本体');
});

test('关闭插件取消用户主动触发的图谱生成，已有文档和图片仍然保留', async t => {
  const app = await desktop(t);
  app.subject.activatePrompt(); await app.opened();
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
    app.subject.activatePrompt(); await eventually(() => app.calls.includes('capture:window'), '应用截图已经开始');
    if (disable) await app.send('rabbit:save-settings', { graphPluginEnabled: false });
    else app.subject.cancelCapture();
    gate.resolve(); await flush(); await app.graphStore.flush(); await flush();
    assert.equal(app.activation(), undefined, '迟到截图不能重新打开图谱');
    assert.equal(app.subject.session(), undefined);
    assert.equal((await app.graphStore.open()).graphs.length, 0);
    assert.equal(app.signals.length, 0); assert.equal(app.chatRequests.length, 0);
  }
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

test('打开大爆炸模式开关立即截图并进入，重复保存开启状态不会再次激活', async t => {
  const app = await desktop(t, { mode: false });
  app.subject.showPanel('prompt');
  await app.send('rabbit:save-settings', { graphModeEnabled: true }); await app.opened();
  assert.deepEqual(app.calls.filter(call => call.startsWith('capture:')), ['capture:window']);
  const owner = app.activation()!.activationId;
  await app.send('rabbit:save-settings', { graphModeEnabled: true }); await flush();
  assert.equal(app.activation()!.activationId, owner);
  assert.equal(app.subject.view(), 'graph');
  assert.equal(app.signals.length, 0); assert.equal(app.chatRequests.length, 0);
});

test('通过图谱入口打开后再启用模式仍留在图谱，不误触激活键退出逻辑', async t => {
  const app = await desktop(t, { existing: true, mode: false });
  await app.send('rabbit:graph-activate'); await app.opened();
  const owner = app.activation()!.activationId;
  await app.send('rabbit:save-settings', { graphModeEnabled: true });
  await eventually(() => (app.activation()?.activationId ?? 0) > owner, '启用模式后仍应完成图谱进入');
  assert.equal(app.subject.view(), 'graph'); assert.equal(app.activation()!.view, 'graph');
  assert.deepEqual(app.calls.filter(call => call.startsWith('capture:')), ['capture:desktop', 'capture:desktop']);
  assert.equal(app.sent.filter(item => item.channel === 'rabbit:dismiss').length, 0);
  assert.equal(app.signals.length, 0);
});

test('模式持续关闭时保存无关设置不退出菜单打开的图谱或取消批注截图', async t => {
  const app = await desktop(t, { existing: true, mode: false });
  await app.send('rabbit:graph-activate'); await app.opened();
  const owner = app.activation()!.activationId;
  await app.subject.focusInput(owner);
  await app.send('rabbit:save-settings', { eyeColor: '#3355FF' });
  assert.equal(app.subject.view(), 'graph'); assert.equal(app.activation()!.activationId, owner);
  const graph = app.workspace.graphs[0], previousOverlays = app.calls.filter(call => call === 'overlays.show').length;
  const pending = app.send('rabbit:graph-capture-images', { workspaceId: app.workspace.id, graphId: graph.id, nodeId: graph.rootId });
  await eventually(() => app.calls.filter(call => call === 'overlays.show').length > previousOverlays, '批注框选应开启');
  const session = app.subject.session();
  await app.send('rabbit:save-settings', { eyeColor: '#55AA33' });
  assert.equal(app.subject.session(), session); assert.equal(session.controller.signal.aborted, false);
  assert.equal(app.subject.view(), 'graph'); assert.equal(app.state.visible, false);
  app.subject.selectionPointer('down', { x: 100, y: 120 });
  app.subject.selectionPointer('up', { x: 340, y: 300 }); app.subject.endCapture();
  assert.equal((await pending).length, 1);
  assert.equal(app.activation()!.activationId, owner); assert.equal(app.state.ignoreMouse, false);
  assert.equal(app.sent.filter(item => item.channel === 'rabbit:dismiss').length, 0);
});

test('批注手动截图失败会取消原生框选并恢复可交互原图', async t => {
  const app = await desktop(t, { existing: true, desktopError: true });
  await app.send('rabbit:graph-open', app.workspace.id);
  app.subject.showPanel('graph', undefined, { workspaceId: app.workspace.id });
  const owner = app.activation()!.activationId; await app.subject.focusInput(owner);
  const graph = app.workspace.graphs[0];
  const images = await app.send('rabbit:graph-capture-images', { workspaceId: app.workspace.id, graphId: graph.id, nodeId: graph.rootId });
  assert.equal(images, null); assert.equal(app.subject.session(), undefined);
  assert.ok(app.calls.includes('native.cancelCapture:100')); assert.equal(app.calls.includes('overlays.show'), false);
  assert.equal(app.subject.view(), 'graph'); assert.equal(app.activation()!.activationId, owner);
  assert.equal(app.state.visible, true); assert.equal(app.state.ignoreMouse, false); assert.equal(app.state.focusable, true);
  assert.match(app.sent.findLast(item => item.channel === 'rabbit:graph-error')?.value.message, /屏幕暂时不可读取/);
});

test('批注单次截图完成或取消后保留原图和激活轮次，不重置批注草稿', async t => {
  for (const cancel of [false, true]) {
    const app = await desktop(t, { existing: true });
    await app.send('rabbit:graph-open', app.workspace.id);
    app.subject.showPanel('graph', undefined, { workspaceId: app.workspace.id });
    const activation = app.activation()!; await app.subject.focusInput(activation.activationId);
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
    assert.equal(app.subject.session(), undefined); assert.equal(app.subject.view(), 'graph');
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
  app.subject.showPanel('graph', undefined, { workspaceId: app.workspace.id });
  const activation = app.activation()!; await app.subject.focusInput(activation.activationId);
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
  assert.equal(app.subject.session(), undefined); assert.equal(app.subject.view(), 'graph');
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
  app.subject.showPanel('graph', undefined, { workspaceId: app.workspace.id });
  const activation = app.activation()!; await app.subject.focusInput(activation.activationId);
  const pending = app.send('rabbit:graph-capture-images', { workspaceId: app.workspace.id, graphId: graph.id });
  await eventually(() => app.calls.includes('overlays.show'), '根草稿截图应开始');
  app.subject.selectionPointer('down', { x: 100, y: 100 }); app.subject.selectionPointer('up', { x: 400, y: 300 });
  app.subject.cancelCapture();
  assert.equal(await pending, null); assert.equal(app.subject.session(), undefined);
  const after = await app.graphStore.open(app.workspace.id);
  assert.equal(after.graphs.length, 1); assert.equal(after.graphs[0].rootId, graph.rootId); assert.equal(after.graphs[0].nodes.length, 0);
  assert.equal(app.subject.view(), 'graph'); assert.equal(app.state.visible, true); assert.equal(app.state.ignoreMouse, false);
  assert.equal(app.activation()!.activationId, activation.activationId);
});

test('根草稿截图拒绝非空图，不开始截图也不改变已有根', async t => {
  const app = await desktop(t, { existing: true }), graph = app.workspace.graphs[0];
  await app.send('rabbit:graph-open', app.workspace.id);
  app.subject.showPanel('graph', undefined, { workspaceId: app.workspace.id });
  await app.subject.focusInput(app.activation()!.activationId);
  const before = await app.graphStore.readDocument(app.workspace.id);
  await assert.rejects(app.send('rabbit:graph-capture-images', { workspaceId: app.workspace.id, graphId: graph.id }), /已有根节点/);
  assert.equal(app.subject.session(), undefined); assert.equal(app.calls.includes('native.beginSelection'), false);
  assert.equal(app.calls.some(call => call.startsWith('capture:')), false);
  assert.equal((await app.graphStore.readDocument(app.workspace.id)).markdown, before.markdown);
  assert.equal(app.subject.view(), 'graph'); assert.equal(app.state.ignoreMouse, false);
});

test('批注截图读取或原生握手迟到时不能覆盖后续设置页', async t => {
  for (const phase of ['read', 'native'] as const) {
    const readGate = deferred(), nativeGate = deferred<number>();
    const app = await desktop(t, { existing: true, ...(phase === 'native' ? { selectionGate: nativeGate.promise } : {}) });
    await app.send('rabbit:graph-open', app.workspace.id);
    app.subject.showPanel('graph', undefined, { workspaceId: app.workspace.id });
    await app.subject.focusInput(app.activation()!.activationId);
    const graph = app.workspace.graphs[0];
    if (phase === 'read') {
      const open = app.graphStore.open.bind(app.graphStore);
      app.graphStore.open = async id => { const workspace = await open(id); await readGate.promise; return workspace; };
    }
    const pending = app.send('rabbit:graph-capture-images', { workspaceId: app.workspace.id, graphId: graph.id, nodeId: graph.rootId });
    if (phase === 'native') await eventually(() => app.calls.includes('native.beginSelection'), '原生框选握手应开始');
    app.send('rabbit:open-settings');
    const settingsOwner = app.activation()!.activationId;
    app.send('rabbit:set-interactive', true, settingsOwner);
    readGate.resolve(); nativeGate.resolve(101);
    assert.equal(await pending, null); await flush();
    assert.equal(app.subject.session(), undefined); assert.equal(app.subject.view(), 'settings');
    assert.equal(app.activation()!.activationId, settingsOwner); assert.equal(app.activation()!.view, 'settings');
    assert.equal(app.state.ignoreMouse, false); assert.equal(app.state.focusable, true);
    if (phase === 'read') assert.equal(app.calls.includes('native.beginSelection'), false);
    else assert.ok(app.calls.includes('native.cancelCapture:101'), '迟到原生框选编号必须立即取消，避免后续鼠标被吞');
  }
});

test('批注截图期间停用插件返回空结果且不恢复已退出图谱', async t => {
  const app = await desktop(t, { existing: true });
  await app.send('rabbit:graph-open', app.workspace.id);
  app.subject.showPanel('graph', undefined, { workspaceId: app.workspace.id });
  await app.subject.focusInput(app.activation()!.activationId);
  const graph = app.workspace.graphs[0];
  const pending = app.send('rabbit:graph-capture-images', { workspaceId: app.workspace.id, graphId: graph.id, nodeId: graph.rootId });
  await eventually(() => app.calls.includes('overlays.show'), '批注框选应进入');
  await app.send('rabbit:save-settings', { graphPluginEnabled: false });
  assert.equal(await pending, null); assert.equal(app.subject.session(), undefined); assert.equal(app.subject.view(), undefined);
  assert.equal(app.state.ignoreMouse, true);
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

function renderer(options: { focus?: (epoch: number) => Promise<boolean>; graphOpen?: () => Promise<void>; hide?: (epoch: number) => void } = {}) {
  const events = new EventEmitter(), hides: number[] = [], focuses: number[] = [];
  const ui = { graph: false, chat: false, settings: false, opening: false };
  let activationListener!: (activation: Activation) => Promise<void>, dismissListener!: (id: number) => void;
  let epoch = 0;
  const document = { addEventListener: events.on.bind(events), dispatchEvent: (event: any) => events.emit(event.type, event),
    querySelector(selector: string) { return (selector.includes('rabbit-graph') && ui.graph || selector.includes('rabbit-chat') && ui.chat || selector.includes('rabbit-settings') && ui.settings) ? {} : null; } };
  const window: any = {
    rabbitDesktop: { onActivate(listener: typeof activationListener) { activationListener = listener; }, onDismiss(listener: typeof dismissListener) { dismissListener = listener; },
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

test('真实renderer图谱就绪握手解除主进程鼠标穿透，不依赖外部手动聚焦', async t => {
  const app = await desktop(t, { existing: true }), gate = deferred();
  const page = renderer({ graphOpen: () => gate.promise, focus: id => app.send('rabbit:focus-input', id) });
  app.subject.activatePrompt(false, 30); app.subject.endCapture(); await app.opened();
  const activation = app.activation()!, pending = page.activate(activation);
  assert.equal(app.state.ignoreMouse, true); assert.equal(app.state.focusable, false);
  assert.deepEqual(page.focuses, [], '图谱数据就绪前仍保持原生待就绪阶段');
  gate.resolve(); await pending;
  assert.deepEqual(page.focuses, [activation.activationId]);
  assert.equal(app.state.ignoreMouse, false, '系统鼠标点击和滚轮必须交给图谱窗口');
  assert.equal(app.state.focusable, true); assert.equal(page.ui.graph, true);
  assert.deepEqual(page.hides, []);
});

test('根草稿及批注截图完成或取消后，renderer退出真实主进程恢复空闲穿透', async t => {
  for (const kind of ['root', 'annotation'] as const) for (const cancel of [false, true]) {
    const app = await desktop(t, { existing: kind === 'annotation' });
    const workspace = kind === 'root'
      ? await app.send('rabbit:graph-mutate', app.workspace.id, { type: 'create-graph' })
      : app.workspace;
    const graph = workspace.graphs[0];
    const page = renderer({ focus: id => app.send('rabbit:focus-input', id), hide: id => app.send('rabbit:hide-panel', id) });
    await app.send('rabbit:graph-open', app.workspace.id);
    app.subject.showPanel('graph', undefined, { workspaceId: app.workspace.id });
    const activation = app.activation()!; await page.activate(activation);
    assert.equal(app.subject.view(), 'graph'); assert.equal(app.state.ignoreMouse, false);
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
    assert.equal(app.subject.session(), undefined); assert.equal(app.subject.view(), 'graph');
    assert.equal(app.activation()!.activationId, activation.activationId);
    assert.equal(app.sent.filter(item => item.channel === 'rabbit:activate').length, 1, '截图只恢复原窗口，不依赖新的激活重置renderer');
    assert.ok(app.sent.some(item => item.channel === 'rabbit:capture-event' && item.value.sessionId === sessionId && item.value.type === (cancel ? 'cancel' : 'end')));
    assert.deepEqual(page.hides, []);
    page.graph.close(); await flush();
    assert.deepEqual(page.hides, [activation.activationId], '退出事件必须携带仍有效的原激活轮次');
    assert.equal(app.subject.view(), undefined, '主进程不能残留graph全屏交互状态');
    assert.equal(app.state.ignoreMouse, true, '没有宠物或固定卡热区时，正常应用点击与滚动应穿透');
    assert.equal(app.state.focusable, false);
    assert.equal((await app.graphStore.readDocument(app.workspace.id)).markdown, before.markdown);
  }
});

test('图谱已经呈现时附加操作失败仍完成原生焦点握手', async t => {
  const app = await desktop(t, { existing: true });
  const page = renderer({ graphOpen: async () => { throw new Error('图谱名称暂时无法读取'); }, focus: id => app.send('rabbit:focus-input', id) });
  app.subject.showPanel('graph', undefined, { workspaceId: app.workspace.id, graphAction: 'rename-graph' });
  const activation = app.activation()!;
  assert.equal(app.state.ignoreMouse, true); assert.equal(app.state.focusable, false);
  await assert.rejects(page.activate(activation), /图谱名称暂时无法读取/);
  assert.deepEqual(page.focuses, [activation.activationId]);
  assert.equal(page.ui.graph, true); assert.deepEqual(page.hides, []);
  assert.equal(app.state.ignoreMouse, false, '附加操作失败不能让已打开图谱继续穿透系统鼠标');
  assert.equal(app.state.focusable, true);
});

test('过期或已关闭图谱的异步打开完成后不争抢焦点', async () => {
  for (const dismissed of [false, true]) {
    const gate = deferred(), page = renderer({ graphOpen: () => gate.promise });
    const pending = page.activate({ activationId: 31, view: 'graph', workspaceId: 'workspace' });
    if (dismissed) page.dismiss(31);
    else await page.activate({ activationId: 32, view: 'prompt' });
    gate.resolve(); await pending;
    assert.deepEqual(page.focuses, []); assert.equal(page.ui.graph, false);
    assert.equal(page.ui.chat, !dismissed);
  }
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
  app.subject.activatePrompt(false, 200); app.subject.endCapture(); await app.opened();
  const workspace = await app.graphStore.open();
  assert.equal(workspace.graphs[0].nodes[0].images.length, 1);
  assert.equal(workspace.graphs[0].nodes[0].images[0].source, 'window');
  assert.equal(app.activation()?.backgroundImageDataUrl, undefined);
  assert.equal(app.sent.some(item => item.channel === 'rabbit:graph-error'), false);
});

test('图谱窗口截图失败时背景仍可显示，但不能保存为根资料', async t => {
  const app = await desktop(t, { missingWindowImage: true });
  app.subject.activatePrompt(false, 201); app.subject.endCapture(); await app.opened();
  const workspace = await app.graphStore.open();
  assert.equal(workspace.graphs[0].nodes.length, 0);
  assert.match(app.activation()?.backgroundImageDataUrl ?? '', /^data:image\/jpeg;base64,/);
  assert.equal(app.sent.some(item => item.channel === 'rabbit:graph-error'), true);
});
