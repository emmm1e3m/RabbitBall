import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function harness(load: Promise<void> | Promise<void>[] = Promise.resolve()) {
  const windows: Window[] = [], animations: ReturnType<typeof deferred>[] = [], payloads: any[] = [], order: string[] = [];
  class Window {
    visible = false; destroyed = false; ignoreMouse = false; bounds = { x: 0, y: 0, width: 1, height: 1 };
    handlers = new Map<string, () => void>();
    webHandlers = new Map<string, () => void>();
    webContents = {
      on: (event: string, callback: () => void) => this.webHandlers.set(event, callback),
      setWindowOpenHandler() {},
      executeJavaScript: (code: string) => {
        if (code.includes('.play(')) {
          payloads.push(JSON.parse(code.slice(code.indexOf('(') + 1, -1)));
          const done = deferred(); animations.push(done); return done.promise;
        }
        return Promise.resolve();
      },
    };
    readonly options: any;
    constructor(options: any) { this.options = options; windows.push(this); }
    setMenu() {} setAlwaysOnTop() {}
    setIgnoreMouseEvents(value: boolean) { this.ignoreMouse = value; }
    on(event: string, callback: () => void) { this.handlers.set(event, callback); }
    loadFile() { return Array.isArray(load) ? load.shift() ?? Promise.resolve() : load; }
    setBounds(value: typeof this.bounds) { this.bounds = { ...value }; order.push('bounds'); }
    showInactive() { this.visible = true; this.bounds.height -= 40; order.push('showInactive'); }
    getContentBounds() { return this.bounds; }
    isDestroyed() { return this.destroyed; }
    hide() { this.visible = false; }
    destroy() { this.destroyed = true; this.visible = false; this.handlers.get('closed')?.(); }
  }
  const source = readFileSync(new URL('../electron/activation-effect-window.ts', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '');
  const context: any = { BrowserWindow: Window, app: { getAppPath: () => '/rabbitball' }, path };
  vm.runInNewContext(stripTypeScriptTypes(source, { mode: 'transform' }).replace(/^export /gm, '') + '\nglobalThis.Effect = ActivationEffectWindow;', context);
  const effect = new context.Effect();
  const raiseInterface = () => { order.push('interfaceTop'); };
  const play = () => effect.play({ x: -800, y: -100, width: 900, height: 700 }, { x: -700, y: 50 }, '#ab12ef', raiseInterface);
  return { effect, windows, animations, payloads, order, play };
}

test('光效覆盖目标完整范围，永久穿透且无焦点和preload，主界面置于其上', async () => {
  const app = harness();
  await app.effect.prepare();
  const playing = app.play(); await new Promise(resolve => setImmediate(resolve));
  const window = app.windows[0];
  assert.equal(window.options.focusable, false);
  assert.equal(window.options.webPreferences.preload, undefined);
  assert.equal(window.ignoreMouse, true); assert.equal(window.visible, true);
  assert.deepEqual(app.order, ['bounds', 'showInactive', 'bounds', 'interfaceTop']);
  assert.deepEqual(app.payloads[0], { origin: { x: 100, y: 150 }, focusBounds: { x: 0, y: 0, width: 900, height: 700 }, color: '#ab12ef' });
  app.animations[0].resolve(); await playing;
  assert.equal(window.visible, false);
  assert.equal(window.ignoreMouse, true);
});

test('取消尚未加载的光效后，迟到准备不能显示窗口', async () => {
  const load = deferred(), app = harness(load.promise);
  const playing = app.play(); app.effect.clear(); load.resolve(); await playing;
  assert.equal(app.windows[0].visible, false);
  assert.equal(app.payloads.length, 0);
});

test('旧动画结束不能隐藏新动画，渲染进程退出会销毁视觉窗口', async () => {
  const app = harness(); await app.effect.prepare();
  const first = app.play(); await new Promise(resolve => setImmediate(resolve));
  const second = app.play(); await new Promise(resolve => setImmediate(resolve));
  app.animations[0].resolve(); await first;
  assert.equal(app.windows[0].visible, true);
  app.windows[0].webHandlers.get('render-process-gone')!();
  assert.equal(app.windows[0].visible, false); assert.equal(app.windows[0].destroyed, true);
  app.animations[1].resolve(); await second;
});

test('旧窗口加载失败或进程退出不能销毁重建的视觉窗口', async () => {
  const load = deferred(), app = harness([load.promise, Promise.resolve()]);
  const first = app.effect.prepare();
  const failure = assert.rejects(first, /old load/);
  app.effect.dispose();
  await app.effect.prepare();
  app.windows[0].webHandlers.get('render-process-gone')!();
  assert.equal(app.windows[1].destroyed, false);
  load.reject(new Error('old load')); await failure;
  assert.equal(app.windows[1].destroyed, false);
  const playing = app.play(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.windows[1].visible, true);
  app.animations[0].resolve(); await playing;
});
