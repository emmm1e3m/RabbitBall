import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';

function deferred<T = void>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

type Area = { x: number; y: number; width: number; height: number };

function harness(options: { load?: Promise<void>; paint?: Promise<void>; frame?: Promise<void>; focus?: Promise<boolean>; prepare?: Promise<void>; background?: (area: Area, signal: AbortSignal) => Promise<string | undefined> } = {}) {
  const windows: Window[] = [], visibility: boolean[] = [], external: string[] = [], reloads: unknown[] = [];
  const backgrounds: Array<{ area: Area; bounds: Area; visible: boolean }> = [];
  const backgroundSignals: AbortSignal[] = [];
  const cursor = { x: -900, y: 350 }, area = { x: -1280, y: 40, width: 1280, height: 984 };
  let closes = 0, focuses = 0, preparations = 0;
  class Contents extends EventEmitter {
    sent: { channel: string; value: any }[] = [];
    frames: unknown[][] = [];
    scripts: string[] = [];
    focusCount = 0;
    openHandler?: (details: { url: string }) => unknown;
    setWindowOpenHandler(handler: (details: { url: string }) => unknown) { this.openHandler = handler; }
    send(channel: string, value: unknown) { this.sent.push({ channel, value: structuredClone(value) }); }
    executeJavaScript(source: string) { this.scripts.push(source); return options.paint ?? Promise.resolve(); }
    capturePage(...args: unknown[]) { this.frames.push(args); return options.frame ?? Promise.resolve(); }
    focus() { this.focusCount++; }
  }
  class Window extends EventEmitter {
    readonly webContents = new Contents();
    destroyed = false;
    visible = false;
    focusCount = 0;
    shown = 0;
    raised = 0;
    opacity = 1;
    ignoreMouse = false;
    topLevels: unknown[][] = [];
    loaded?: { filename: string; options: unknown };
    bounds: typeof area;
    readonly options: any;
    constructor(options: any) { super(); this.options = options; this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height }; windows.push(this); }
    setMenu() {}
    setAlwaysOnTop(...args: unknown[]) { this.topLevels.push(args); }
    setOpacity(value: number) { this.opacity = value; }
    setIgnoreMouseEvents(value: boolean) { this.ignoreMouse = value; }
    isDestroyed() { return this.destroyed; }
    showInactive() { this.visible = true; this.shown++; }
    moveTop() { assert.equal(this.visible && this.opacity === 1 && !this.ignoreMouse, true, '隐藏或预绘制阶段不能提升窗口'); this.raised++; }
    hide() { this.visible = false; }
    setBounds(bounds: typeof area) { this.bounds = { ...bounds }; }
    getPosition() { return [this.bounds.x, this.bounds.y]; }
    focus() { this.focusCount++; }
    isFocused() { return this.focusCount > 0; }
    destroy() { this.destroyed = true; this.visible = false; this.emit('closed'); }
    async loadFile(filename: string, loadOptions: unknown) {
      this.loaded = { filename, options: loadOptions }; this.webContents.emit('did-start-loading');
      await options.load; this.webContents.emit('did-finish-load');
    }
  }
  const url = new URL('../electron/graph-window.ts', import.meta.url);
  const source = readFileSync(url, 'utf8').replace(/^import .*;\r?\n/gm, '');
  const context: any = { BrowserWindow: Window, AbortController, app: { getAppPath: () => '/rabbitball' },
    screen: { getCursorScreenPoint: () => ({ ...cursor }), getDisplayNearestPoint: () => ({ workArea: { ...area } }) },
    shell: { openExternal: async (url: string) => { external.push(url); } }, path,
  };
  vm.runInNewContext(stripTypeScriptTypes(source, { mode: 'transform' }).replace(/^export /gm, '') + '\nglobalThis.GraphWindowClass = GraphWindow;', context);
  const graph = new context.GraphWindowClass({ preload: '/rabbitball/preload.cjs',
    onVisibility: (visible: boolean) => visibility.push(visible), onClose: () => { closes++; }, onReload: (contents: unknown) => reloads.push(contents),
    prepare: async () => { preparations++; await options.prepare; },
    focus: async () => { focuses++; return options.focus ? options.focus : true; },
    background: options.background && (async (area: Area, signal: AbortSignal) => {
      const window = windows.at(-1)!;
      backgrounds.push({ area: { ...area }, bounds: { ...window.bounds }, visible: window.visible });
      backgroundSignals.push(signal);
      return options.background!(area, signal);
    }),
  });
  return { graph, windows, visibility, external, reloads, backgrounds, backgroundSignals, cursor, area, options,
    closes: () => closes, focuses: () => focuses, preparations: () => preparations };
}

async function flush() { await new Promise<void>(resolve => setImmediate(resolve)); }

test('装饰背景只在图谱隐藏并定位后采集，等待期间换屏不改变本次目标区域', async () => {
  const background = deferred<string>(), entered = deferred();
  const app = harness({ background: async () => { entered.resolve(); return background.promise; } });
  await app.graph.show({ workspaceId: 'first', backgroundImageDataUrl: 'data:image/jpeg;base64,existing' });
  const window = app.windows[0], area = { ...app.area };
  assert.equal(window.visible, true);
  const showing = app.graph.show({ workspaceId: 'refresh' });
  await entered.promise;
  assert.deepEqual(app.backgrounds, [{ area, bounds: area, visible: false }]);
  assert.equal(window.visible, false);
  assert.equal(window.webContents.sent.filter(item => item.channel === 'rabbit:activate').length, 1);
  Object.assign(app.area, { x: 0, y: 0, width: 2560, height: 1440 });
  Object.assign(app.cursor, { x: 700, y: 400 });
  background.resolve('data:image/jpeg;base64,fresh'); await showing;
  assert.deepEqual(window.bounds, area);
  assert.equal(window.webContents.sent.at(-1)?.value.backgroundImageDataUrl, 'data:image/jpeg;base64,fresh');
  assert.deepEqual(window.webContents.sent.at(-1)?.value.anchor, { x: 380, y: 310 });
  assert.equal(window.visible, true); assert.equal(window.opacity, 1); assert.equal(window.ignoreMouse, false);
  app.graph.dispose();
});

test('截图已有背景直接复用，不额外读取桌面', async () => {
  const app = harness({ background: async () => { assert.fail('已有背景时不能调用装饰截图'); } });
  await app.graph.show({ workspaceId: 'captured', backgroundImageDataUrl: 'data:image/jpeg;base64,captured' });
  assert.deepEqual(app.backgrounds, []);
  assert.equal(app.windows[0].webContents.sent.at(-1)?.value.backgroundImageDataUrl, 'data:image/jpeg;base64,captured');
  assert.equal(app.windows[0].visible, true);
  app.graph.dispose();
});

test('重载复用背景和原屏幕位置，新激活才按当前光标重新选屏采集', async () => {
  let captures = 0;
  const app = harness({ background: async () => 'data:image/jpeg;base64,desktop-' + ++captures });
  await app.graph.show({ workspaceId: 'workspace' });
  const window = app.windows[0], area = { ...window.bounds };
  const original = window.webContents.sent.at(-1)!.value;
  Object.assign(app.area, { x: 0, y: 0, width: 2560, height: 1440 });
  Object.assign(app.cursor, { x: 700, y: 400 });
  window.webContents.emit('did-start-loading'); window.webContents.emit('did-finish-load');
  assert.equal(await app.graph.focusInput(app.graph.activationId), true);
  const restored = window.webContents.sent.at(-1)!.value;
  assert.deepEqual(window.bounds, area); assert.deepEqual(restored.anchor, original.anchor);
  assert.equal(restored.backgroundImageDataUrl, original.backgroundImageDataUrl);
  assert.equal(captures, 1, '同一次激活的页面重载不重复采集桌面');
  await app.graph.show({ workspaceId: 'next' });
  const next = window.webContents.sent.at(-1)!.value;
  assert.deepEqual(window.bounds, app.area); assert.deepEqual(next.anchor, { x: 700, y: 400 });
  assert.equal(next.backgroundImageDataUrl, 'data:image/jpeg;base64,desktop-2');
  assert.equal(captures, 2); assert.deepEqual(app.visibility, [true]);
  app.graph.dispose();
});

test('已经发出的操作和定位命令不随重载重放，再次显式激活仍可发出', async () => {
  const commands = [{ graphAction: 'undo' }, { graphAction: 'redo' }, { graphAction: 'rename-graph' },
    { graphSelection: { graphId: 'graph', nodeId: 'node' } }];
  for (const command of commands) {
    const app = harness(), data = { workspaceId: 'workspace', ...command };
    await app.graph.show(data);
    const window = app.windows[0], first = window.webContents.sent.at(-1)!.value;
    assert.deepEqual(first.graphSelection, command.graphSelection); assert.equal(first.graphAction, command.graphAction);
    assert.deepEqual(data, { workspaceId: 'workspace', ...command }, '消费命令不修改调用方的数据');
    window.webContents.emit('did-start-loading'); window.webContents.emit('did-finish-load');
    assert.equal(await app.graph.focusInput(app.graph.activationId), true);
    const restored = window.webContents.sent.at(-1)!.value;
    assert.equal(restored.workspaceId, 'workspace');
    assert.equal(Object.hasOwn(restored, 'graphAction'), false); assert.equal(Object.hasOwn(restored, 'graphSelection'), false);
    await app.graph.show(data);
    const repeated = window.webContents.sent.at(-1)!.value;
    assert.equal(repeated.graphAction, command.graphAction); assert.deepEqual(repeated.graphSelection, command.graphSelection);
    app.graph.dispose();
  }
});

test('命令发送前重载保留首次操作与原屏幕位置，成功发送后才消费', async () => {
  const commands = [{ graphAction: 'undo' }, { graphSelection: { graphId: 'graph', nodeId: 'node' } }];
  for (const command of commands) {
    const background = deferred<string | undefined>(), entered = deferred();
    let captures = 0;
    const app = harness({ background: async () => {
      if (++captures === 1) { entered.resolve(); return background.promise; }
      return 'data:image/jpeg;base64,reloaded';
    } });
    const showing = app.graph.show({ workspaceId: 'workspace', ...command }); await entered.promise;
    const window = app.windows[0], area = { ...window.bounds };
    Object.assign(app.area, { x: 0, y: 0, width: 2560, height: 1440 });
    Object.assign(app.cursor, { x: 700, y: 400 });
    window.webContents.emit('did-start-loading'); window.webContents.emit('did-finish-load');
    assert.equal(await app.graph.focusInput(app.graph.activationId), true);
    background.resolve(undefined); await showing;
    const activations = window.webContents.sent.filter(item => item.channel === 'rabbit:activate');
    assert.equal(activations.length, 1);
    assert.equal(activations[0].value.graphAction, command.graphAction);
    assert.deepEqual(activations[0].value.graphSelection, command.graphSelection);
    assert.deepEqual(activations[0].value.anchor, { x: 380, y: 310 }); assert.deepEqual(window.bounds, area);
    assert.deepEqual(app.backgrounds.map(item => item.area), [area, area]);
    window.webContents.emit('did-start-loading'); window.webContents.emit('did-finish-load');
    assert.equal(await app.graph.focusInput(app.graph.activationId), true);
    const restored = window.webContents.sent.at(-1)!.value;
    assert.equal(restored.graphAction, undefined); assert.equal(restored.graphSelection, undefined);
    assert.equal(restored.backgroundImageDataUrl, 'data:image/jpeg;base64,reloaded');
    assert.equal(captures, 2);
    app.graph.dispose();
  }
});

test('背景采集期间关闭，迟到结果不能下发旧激活或显示窗口', async () => {
  const background = deferred<string>(), entered = deferred();
  const app = harness({ background: async () => { entered.resolve(); return background.promise; } });
  const showing = app.graph.show({ workspaceId: 'closed' });
  await entered.promise;
  const window = app.windows[0]; app.graph.hide();
  assert.equal(app.backgroundSignals[0].aborted, true, '关闭同步取消正在占用截图助手的背景请求');
  background.resolve('data:image/jpeg;base64,stale'); await showing;
  assert.equal(app.graph.visible, false); assert.equal(window.visible, false);
  assert.equal(window.shown, 0); assert.equal(window.raised, 0);
  assert.equal(window.webContents.sent.some(item => item.channel === 'rabbit:activate'), false);
  assert.equal(window.webContents.scripts.length, 0);
  app.graph.dispose();
});

test('新激活的背景先完成后，旧背景不能覆盖内容或再次显示', async () => {
  const oldBackground = deferred<string>(), newBackground = deferred<string>();
  const oldEntered = deferred(), newEntered = deferred();
  let captures = 0;
  const app = harness({ background: async () => {
    if (++captures === 1) { oldEntered.resolve(); return oldBackground.promise; }
    newEntered.resolve(); return newBackground.promise;
  } });
  const oldShowing = app.graph.show({ workspaceId: 'old' }); await oldEntered.promise;
  const newShowing = app.graph.show({ workspaceId: 'new' });
  assert.equal(app.backgroundSignals[0].aborted, true, '新激活同步取消旧背景');
  await newEntered.promise;
  assert.equal(app.backgroundSignals[1].aborted, false);
  newBackground.resolve('data:image/jpeg;base64,new'); await newShowing;
  const window = app.windows[0], shown = window.shown, raised = window.raised;
  oldBackground.resolve('data:image/jpeg;base64,old'); await oldShowing;
  const activations = window.webContents.sent.filter(item => item.channel === 'rabbit:activate');
  assert.equal(activations.length, 1); assert.equal(activations[0].value.workspaceId, 'new');
  assert.equal(activations[0].value.backgroundImageDataUrl, 'data:image/jpeg;base64,new');
  assert.equal(window.shown, shown); assert.equal(window.raised, raised); assert.equal(window.visible, true);
  app.graph.dispose();
});

test('背景采集期间临时截图保持隐藏，采集和首帧完成后才允许显式恢复', async () => {
  const background = deferred<string>(), entered = deferred();
  const app = harness({ background: async () => { entered.resolve(); return background.promise; } });
  const showing = app.graph.show({ workspaceId: 'capturing' }); await entered.promise;
  const window = app.windows[0], owner = app.graph.activationId;
  app.graph.hideForCapture();
  assert.equal(app.backgroundSignals[0].aborted, true);
  assert.equal(app.graph.visible, true); assert.equal(window.visible, false);
  assert.equal(await app.graph.focusInput(owner), false);
  background.resolve('data:image/jpeg;base64,desktop'); await showing;
  assert.equal(window.visible, false); assert.equal(window.opacity, 1); assert.equal(window.raised, 0);
  assert.equal(window.webContents.sent.filter(item => item.channel === 'rabbit:activate').length, 1);
  await app.graph.restoreAfterCapture();
  assert.equal(window.visible, true); assert.equal(window.ignoreMouse, false); assert.equal(window.raised, 1);
  assert.equal(app.graph.activationId, owner); assert.deepEqual(app.visibility, [true]);
  app.graph.dispose();
});

test('旧背景结束的清理不丢失新控制器，后续关闭仍同步取消新请求', async () => {
  const oldBackground = deferred<string | undefined>(), newBackground = deferred<string | undefined>();
  const oldEntered = deferred(), newEntered = deferred();
  let captures = 0;
  const app = harness({ background: async () => {
    if (++captures === 1) { oldEntered.resolve(); return oldBackground.promise; }
    newEntered.resolve(); return newBackground.promise;
  } });
  const oldShowing = app.graph.show({ workspaceId: 'old' }); await oldEntered.promise;
  const newShowing = app.graph.show({ workspaceId: 'new' }); await newEntered.promise;
  assert.equal(app.backgroundSignals[0].aborted, true); assert.equal(app.backgroundSignals[1].aborted, false);
  oldBackground.resolve(undefined); await oldShowing;
  assert.equal(app.backgroundSignals[1].aborted, false);
  app.graph.hide();
  assert.equal(app.backgroundSignals[1].aborted, true, '旧请求 finally 不能清掉新控制器');
  newBackground.resolve(undefined); await newShowing;
  assert.equal(app.windows[0].visible, false);
  assert.equal(app.windows[0].webContents.sent.some(item => item.channel === 'rabbit:activate'), false);
  app.graph.dispose();
});

test('重载同步取消旧背景，只用重载后的新背景激活页面', async () => {
  const oldBackground = deferred<string | undefined>(), newBackground = deferred<string>();
  const oldEntered = deferred(), newEntered = deferred();
  let captures = 0;
  const app = harness({ background: async () => {
    if (++captures === 1) { oldEntered.resolve(); return oldBackground.promise; }
    newEntered.resolve(); return newBackground.promise;
  } });
  const oldShowing = app.graph.show({ workspaceId: 'reloading' }); await oldEntered.promise;
  const window = app.windows[0], previousId = app.graph.activationId;
  window.webContents.emit('did-start-loading');
  assert.equal(app.backgroundSignals[0].aborted, true);
  assert.ok(app.graph.activationId > previousId);
  window.webContents.emit('did-finish-load'); await newEntered.promise;
  assert.equal(app.backgroundSignals[1].aborted, false);
  oldBackground.resolve(undefined); await oldShowing;
  assert.equal(window.webContents.sent.some(item => item.channel === 'rabbit:activate'), false);
  newBackground.resolve('data:image/jpeg;base64,reloaded');
  assert.equal(await app.graph.focusInput(app.graph.activationId), true);
  const activations = window.webContents.sent.filter(item => item.channel === 'rabbit:activate');
  assert.equal(activations.length, 1); assert.equal(activations[0].value.workspaceId, 'reloading');
  assert.equal(activations[0].value.backgroundImageDataUrl, 'data:image/jpeg;base64,reloaded');
  assert.equal(window.visible, true); assert.deepEqual(app.visibility, [true]);
  app.graph.dispose();
});

test('临时截图取消背景后返回空结果，仍完成预绘制并等待原截图恢复', async () => {
  const entered = deferred();
  let cancelled = false;
  const app = harness({ background: (_area, signal) => new Promise(resolve => {
    signal.addEventListener('abort', () => { cancelled = true; resolve(undefined); }, { once: true });
    entered.resolve();
  }) });
  const showing = app.graph.show({ workspaceId: 'capturing' }); await entered.promise;
  const window = app.windows[0], owner = app.graph.activationId;
  app.graph.hideForCapture();
  assert.equal(cancelled, true, '进入文档截图前同步释放背景请求');
  await showing;
  assert.equal(app.graph.visible, true); assert.equal(window.visible, false);
  assert.equal(window.opacity, 1); assert.equal(window.ignoreMouse, false);
  assert.equal(window.webContents.frames.length, 1);
  const activation = window.webContents.sent.find(item => item.channel === 'rabbit:activate')?.value;
  assert.equal(activation?.activationId, owner); assert.equal(activation?.backgroundImageDataUrl, undefined);
  assert.equal(window.webContents.sent.some(item => item.channel === 'rabbit:dismiss'), false);
  await app.graph.restoreAfterCapture();
  assert.equal(window.visible, true); assert.equal(window.raised, 1);
  assert.equal(app.graph.activationId, owner); assert.deepEqual(app.visibility, [true]);
  app.graph.dispose();
});

test('图谱窗口惰性独立创建，激活后首帧完成才显示，工作区和安全选项正确', async () => {
  const frame = deferred(), app = harness({ frame: frame.promise });
  app.graph.send('unused', null); assert.equal(app.windows.length, 0);
  const showing = app.graph.show({ workspaceId: 'workspace', graphAction: 'undo' });
  assert.equal(app.graph.visible, true); assert.deepEqual(app.visibility, [true]);
  await flush();
  const window = app.windows[0];
  assert.equal(app.windows.length, 1); assert.equal(app.preparations(), 1);
  assert.equal(app.graph.window, window); assert.equal(app.graph.webContents, window.webContents);
  assert.equal(app.graph.owns(window.webContents), true); assert.equal(app.graph.owns({}), false);
  assert.deepEqual(window.bounds, app.area);
  assert.equal(window.options.transparent, true); assert.equal(window.options.frame, false); assert.equal(window.options.focusable, true);
  assert.deepEqual(window.topLevels, [[true, 'screen-saver']]);
  assert.deepEqual(JSON.parse(JSON.stringify(window.options.webPreferences)), { preload: '/rabbitball/preload.cjs', contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false });
  assert.equal(window.loaded?.filename, path.join('/rabbitball', 'prototype', 'index.html'));
  assert.deepEqual(JSON.parse(JSON.stringify(window.loaded?.options)), { query: { view: 'graph' } });
  assert.equal(window.visible, true); assert.equal(window.opacity, 0); assert.equal(window.ignoreMouse, true); assert.equal(window.webContents.frames.length, 1);
  assert.equal(window.raised, 0);
  assert.deepEqual(window.webContents.sent[0], { channel: 'rabbit:activate', value: { activationId: app.graph.activationId, view: 'graph', workspaceId: 'workspace', graphAction: 'undo', anchor: { x: 380, y: 310 } } });
  frame.resolve(); await showing;
  assert.equal(window.visible, true); assert.equal(window.opacity, 1); assert.equal(window.ignoreMouse, false); assert.equal(window.focusCount, 0);
  assert.equal(window.raised, 1, '首帧就绪才显示并提升同为置顶的窗口顺序');
  assert.equal(app.focuses(), 0, '显示不立即抢占输入焦点');
  app.graph.send('rabbit:graph-changed', { id: 'workspace' });
  assert.equal(window.webContents.sent.at(-1)?.channel, 'rabbit:graph-changed');
  app.graph.dispose();
});

test('并发创建复用一窗，加载或首帧期间关闭不会迟到复活，重新打开沿用该窗', async () => {
  const load = deferred(), frame = deferred(), app = harness({ load: load.promise, frame: frame.promise });
  const first = app.graph.show({ workspaceId: 'old' }), oldId = app.graph.activationId;
  const ensured = app.graph.ensure();
  app.graph.hide(); load.resolve(); await Promise.all([first, ensured]);
  assert.equal(app.windows.length, 1); assert.equal(app.graph.visible, false);
  assert.equal(app.windows[0].visible, false);
  assert.ok(app.windows[0].webContents.sent.every(item => item.channel !== 'rabbit:activate'));
  assert.equal(await app.graph.focusInput(oldId), false);
  const second = app.graph.show({ workspaceId: 'new' }); await flush();
  const newId = app.graph.activationId; assert.notEqual(newId, oldId);
  app.graph.hide(); frame.resolve(); await second;
  assert.equal(app.windows[0].visible, false); assert.equal(app.windows[0].opacity, 1); assert.equal(app.windows[0].ignoreMouse, false);
  assert.equal(app.windows[0].raised, 0, '关闭后迟到的首帧不能提升旧图谱');
  app.options.frame = undefined;
  await app.graph.show({ workspaceId: 'latest', anchor: { x: 1, y: 2 } });
  assert.equal(app.windows.length, 1); assert.equal(app.windows[0].visible, true);
  assert.deepEqual(app.windows[0].webContents.sent.at(-1)?.value.anchor, { x: 1, y: 2 });
  app.graph.dispose();
});

test('窗口透明穿透地等待渲染帧，期间关闭不再采样或显示', async () => {
  const paint = deferred(), app = harness({ paint: paint.promise });
  const showing = app.graph.show(); await flush();
  const window = app.windows[0];
  assert.equal(window.webContents.scripts.length, 1); assert.equal(window.webContents.frames.length, 0);
  assert.equal(window.opacity, 0); assert.equal(window.ignoreMouse, true); assert.equal(window.raised, 0);
  app.graph.hide(); paint.resolve(); await showing;
  assert.equal(window.webContents.frames.length, 0); assert.equal(window.visible, false);
  app.options.paint = undefined;
  await app.graph.show();
  assert.equal(window.webContents.frames.length, 1); assert.equal(window.visible, true);
  app.graph.dispose();
});

test('首帧预绘制期间开始截图不会露出图谱，完成后仅显式恢复才前置', async () => {
  const paint = deferred(), app = harness({ paint: paint.promise });
  const showing = app.graph.show(); await flush();
  const window = app.windows[0];
  app.graph.hideForCapture();
  assert.equal(window.opacity, 0); assert.equal(window.ignoreMouse, true);
  paint.resolve(); await showing;
  assert.equal(window.visible, false); assert.equal(window.opacity, 1); assert.equal(window.raised, 0);
  await app.graph.restoreAfterCapture();
  assert.equal(window.visible, true); assert.equal(window.ignoreMouse, false); assert.equal(window.raised, 1);
  assert.equal(app.focuses(), 0);
  app.graph.dispose();
});

test('关闭事件只隐藏并发出所属激活的dismiss，截图隐藏保持逻辑可见和页面状态', async () => {
  const app = harness(); await app.graph.show({ workspaceId: 'same' });
  const window = app.windows[0], activationId = app.graph.activationId, sent = window.webContents.sent.length;
  app.graph.hideForCapture();
  assert.equal(app.graph.visible, true); assert.equal(window.visible, false);
  assert.deepEqual(app.visibility, [true]); assert.equal(window.webContents.sent.length, sent);
  assert.equal(await app.graph.focusInput(activationId), false);
  assert.equal(window.raised, 1, '截图临时隐藏不改变层叠顺序');
  await app.graph.restoreAfterCapture();
  assert.equal(window.visible, true); assert.equal(app.graph.activationId, activationId); assert.equal(window.webContents.sent.length, sent);
  assert.equal(window.raised, 2); assert.equal(app.focuses(), 0, '截图恢复只前置，不主动抢焦点');
  app.graph.hideForCapture();
  let prevented = false; window.emit('close', { preventDefault() { prevented = true; } });
  await app.graph.restoreAfterCapture();
  assert.equal(prevented, true); assert.equal(app.closes(), 1);
  assert.equal(window.destroyed, false); assert.equal(window.visible, false); assert.equal(app.graph.visible, false);
  assert.deepEqual(window.webContents.sent.at(-1), { channel: 'rabbit:dismiss', value: activationId });
  const dismisses = window.webContents.sent.filter(item => item.channel === 'rabbit:dismiss').length;
  app.graph.hide(); assert.equal(window.webContents.sent.filter(item => item.channel === 'rabbit:dismiss').length, dismisses);
  assert.deepEqual(app.visibility, [true, false]);
  app.graph.dispose(); assert.equal(window.destroyed, true); assert.equal(app.graph.webContents, undefined);
});

test('聚焦等待当前激活首帧，复用进行中的请求，关闭后的迟到结果不能聚焦网页', async () => {
  const frame = deferred(), focus = deferred<boolean>(), app = harness({ frame: frame.promise, focus: focus.promise });
  const showing = app.graph.show();
  const activationId = app.graph.activationId;
  const first = app.graph.focusInput(activationId), second = app.graph.focusInput(activationId);
  assert.equal(first, second); await flush(); assert.equal(app.focuses(), 0);
  frame.resolve(); await showing; await flush(); assert.equal(app.focuses(), 1);
  assert.equal(app.windows[0].raised, 2, '显式聚焦先提升当前图谱');
  app.graph.hide(); focus.resolve(true);
  assert.equal(await first, false); assert.equal(app.windows[0].webContents.focusCount, 0);
  assert.equal(app.windows[0].raised, 2, '迟到聚焦结果不能再次前置');
  app.options.frame = undefined; app.options.focus = undefined;
  await app.graph.show();
  assert.equal(await app.graph.focusInput(activationId), false);
  assert.equal(await app.graph.focusInput(app.graph.activationId), true);
  assert.equal(app.windows[0].webContents.focusCount, 1);
  app.graph.dispose();
});

test('旧截图的异步恢复不能越过新截图隐藏，关闭也会作废待恢复操作', async () => {
  const app = harness(); await app.graph.show();
  const window = app.windows[0], sent = window.webContents.sent.length;
  app.graph.hideForCapture();
  const staleRestore = app.graph.restoreAfterCapture();
  app.graph.hideForCapture();
  await staleRestore;
  assert.equal(window.visible, false); assert.equal(app.graph.visible, true);
  assert.equal(window.raised, 1, '旧恢复不能越过新截图提升窗口');
  await app.graph.restoreAfterCapture();
  assert.equal(window.visible, true); assert.equal(window.webContents.sent.length, sent);
  assert.equal(window.raised, 2);
  app.graph.hideForCapture();
  const closedRestore = app.graph.restoreAfterCapture(); app.graph.hide();
  await closedRestore;
  assert.equal(window.visible, false); assert.equal(app.graph.visible, false);
  app.graph.dispose();
});

test('截图完成的新激活解除旧临时隐藏，旧恢复任务不能覆盖新图谱', async () => {
  const app = harness(); await app.graph.show({ workspaceId: 'old' });
  const window = app.windows[0];
  app.graph.hideForCapture();
  const staleRestore = app.graph.restoreAfterCapture();
  await app.graph.show({ workspaceId: 'captured' }); await staleRestore;
  assert.equal(window.visible, true); assert.equal(app.graph.visible, true);
  assert.equal(window.webContents.sent.at(-1)?.value.workspaceId, 'captured');
  assert.equal(await app.graph.focusInput(app.graph.activationId), true);
  assert.deepEqual(app.visibility, [true]);
  app.graph.dispose();
});

test('导航和新窗口只向系统浏览器放行HTTP(S)，网页无法嵌入webview', async () => {
  const app = harness(), window = await app.graph.ensure();
  for (const url of ['https://example.com', 'file:///private', 'javascript:alert(1)']) {
    let prevented = false;
    window.webContents.emit('will-navigate', { preventDefault() { prevented = true; } }, url);
    assert.equal(prevented, true);
    assert.deepEqual(JSON.parse(JSON.stringify(window.webContents.openHandler!({ url }))), { action: 'deny' });
  }
  let blocked = false; window.webContents.emit('will-attach-webview', { preventDefault() { blocked = true; } });
  assert.equal(blocked, true); assert.deepEqual(app.external, ['https://example.com', 'https://example.com']);
  app.graph.dispose();
});

test('加载失败清理窗口并允许重试，重载通知及新激活恢复独立图谱', async () => {
  const failed = deferred(), app = harness({ load: failed.promise });
  const showing = app.graph.show(); failed.reject(new Error('load failed'));
  await assert.rejects(showing, /load failed/);
  assert.equal(app.windows[0].destroyed, true); assert.equal(app.graph.visible, false);
  app.options.load = undefined; await app.graph.show({ workspaceId: 'restored' });
  const window = app.windows[1], previousId = app.graph.activationId;
  assert.equal(window.visible, true);
  window.webContents.emit('did-start-loading');
  assert.equal(window.visible, false); assert.equal(app.graph.visible, true);
  window.webContents.emit('did-finish-load'); await flush();
  assert.equal(app.reloads.length, 3); assert.ok(app.graph.activationId > previousId);
  assert.equal(window.webContents.sent.at(-1)?.value.workspaceId, 'restored'); assert.equal(window.visible, true);
  assert.equal(window.raised, 2, '重载首帧完成后重新前置');
  app.graph.dispose();
});

test('截图临时隐藏时重载不会露出图谱，恢复等待重载首帧并保持新激活', async () => {
  const app = harness({ background: async () => 'data:image/jpeg;base64,desktop' });
  await app.graph.show({ workspaceId: 'reloading' });
  assert.equal(app.backgrounds.length, 1);
  const window = app.windows[0];
  app.graph.hideForCapture(); window.webContents.emit('did-start-loading');
  const activationId = app.graph.activationId;
  const restoring = app.graph.restoreAfterCapture(); await flush();
  assert.equal(window.visible, false); assert.equal(app.graph.visible, true);
  window.webContents.emit('did-finish-load'); await restoring;
  assert.equal(window.visible, true); assert.equal(app.graph.activationId, activationId);
  assert.equal(app.backgrounds.length, 1, '文档截图期间重载不能另起背景请求争用截图助手');
  assert.equal(window.webContents.sent.at(-1)?.value.backgroundImageDataUrl, 'data:image/jpeg;base64,desktop', '截图期间重载仍保留已取得的装饰背景');
  assert.equal(window.webContents.sent.filter(item => item.channel === 'rabbit:activate').length, 2);
  assert.deepEqual(app.visibility, [true]);
  app.graph.dispose();
});
