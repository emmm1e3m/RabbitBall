import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import type { WindowsNative } from '../electron/windows-native.ts';

function bridge() {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter & { setEncoding(): void }; stdin: EventEmitter & { write(value: string): void; end(): void }; kill(): void };
  const commands: any[] = [], events: string[] = [];
  let bootstrap = true, errors = 0;
  child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
  child.stdin = Object.assign(new EventEmitter(), {
    write(value: string) { if (bootstrap) bootstrap = false; else commands.push(JSON.parse(value)); },
    end() { queueMicrotask(() => child.emit('exit')); },
  });
  child.kill = () => {};
  const url = new URL('../electron/windows-native.ts', import.meta.url);
  const source = readFileSync(url, 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/\bexport /g, '').replaceAll('import.meta.url', '__moduleUrl');
  const context: any = { spawn: () => child, readFileSync, path, fileURLToPath, randomUUID, process: { pid: 1 },
    Buffer, setTimeout, clearTimeout, queueMicrotask, __moduleUrl: url.href };
  vm.runInNewContext(stripTypeScriptTypes(source) + '\nglobalThis.create = createWindowsNative;', context);
  const native: WindowsNative = context.create({
    onTriggerBegin(id: number) { events.push('begin:' + id); }, onTriggerHold(id: number) { events.push('hold:' + id); },
    onTriggerEnd(id: number) { events.push('end:' + id); }, onTriggerCancel(id: number) { events.push('cancel:' + id); },
    onSelectionPointer(id: number, phase: string) { events.push(phase + ':' + id); },
    onPointerDown(point: { x: number; y: number }) { events.push('pointer:' + point.x + ',' + point.y); },
    onPointerUp(point: { x: number; y: number }) { events.push('release:' + point.x + ',' + point.y); },
    onFullscreen() {}, onError() { errors++; },
  });
  const emit = (...messages: unknown[]) => child.stdout.emit('data', messages.map(message => JSON.stringify(message)).join('\n') + '\n');
  emit({ type: 'ready' });
  return { native, commands, events, emit, errors: () => errors, child };
}

test('手动框选同批回执先完成编号登记，再有序交付鼠标与结束事件', async () => {
  const app = bridge();
  try {
    await app.native.ready;
    const pending = app.native.beginSelection().then(id => { app.events.push('registered:' + id); return id; });
    const command = app.commands.at(-1);
    assert.equal(command.type, 'begin-selection');
    app.emit({ type: 'selection-started', requestId: command.requestId, captureId: 17 },
      { type: 'selection-pointer', captureId: 17, phase: 'down', x: -20, y: 30 },
      { type: 'selection-pointer', captureId: 17, phase: 'up', x: 80, y: 130 },
      { type: 'trigger-end', captureId: 17 });
    assert.deepEqual(app.events, []);
    assert.equal(await pending, 17);
    assert.deepEqual(app.events, ['registered:17', 'down:17', 'up:17', 'end:17']);
    assert.equal(app.errors(), 0);
  } finally { app.native.stop(); }
});

test('普通点击保留每次按下的坐标与顺序，不重新读取后续鼠标位置', async () => {
  const app = bridge();
  try {
    await app.native.ready;
    app.emit({ type: 'pointer-down', x: -1920, y: 330 },
      { type: 'pointer-down', x: 2410, y: -100 },
      { type: 'pointer-down', x: 0, y: 0 });
    assert.deepEqual(app.events, ['pointer:-1920,330', 'pointer:2410,-100', 'pointer:0,0']);
    assert.equal(app.errors(), 0);
  } finally { app.native.stop(); }
});

test('普通释放按原生顺序交给主进程，使页面丢失松开时仍可解除整窗命中', async () => {
  const app = bridge();
  try {
    await app.native.ready;
    app.emit({ type: 'pointer-down', x: 12, y: 34 },
      { type: 'pointer-up', x: 500, y: 640 },
      { type: 'pointer-down', x: 700, y: 800 });
    assert.deepEqual(app.events, ['pointer:12,34', 'release:500,640', 'pointer:700,800']);
    assert.equal(app.errors(), 0);
  } finally { app.native.stop(); }
});

test('手动框选结束后的普通点击与下一次激活不越过此前的区域提交', async () => {
  const app = bridge();
  try {
    const pending = app.native.beginSelection().then(id => { app.events.push('registered:' + id); return id; });
    app.emit({ type: 'selection-started', requestId: app.commands.at(-1).requestId, captureId: 19 },
      { type: 'selection-pointer', captureId: 19, phase: 'down', x: -20, y: 30 },
      { type: 'selection-pointer', captureId: 19, phase: 'up', x: 80, y: 130 },
      { type: 'trigger-end', captureId: 19 },
      { type: 'pointer-down', x: -300, y: 240 },
      { type: 'trigger-begin', captureId: 20 });
    assert.deepEqual(app.events, []);
    assert.equal(await pending, 19);
    assert.deepEqual(app.events, ['registered:19', 'down:19', 'up:19', 'end:19', 'pointer:-300,240', 'begin:20']);
    assert.equal(app.errors(), 0);
  } finally { app.native.stop(); }
});

test('停止或故障后不交付已排队的框选、点击与下一次激活', async () => {
  for (const fail of [false, true]) {
    const app = bridge();
    try {
      const pending = app.native.beginSelection();
      app.emit({ type: 'selection-started', requestId: app.commands.at(-1).requestId, captureId: 21 });
      assert.equal(await pending, 21);
      app.emit({ type: 'selection-pointer', captureId: 21, phase: 'up', x: 80, y: 130 },
        { type: 'trigger-end', captureId: 21 },
        { type: 'pointer-down', x: -300, y: 240 },
        { type: 'trigger-begin', captureId: 22 });
      assert.deepEqual(app.events, []);
      if (fail) app.child.emit('error', new Error('child stopped'));
      else app.native.stop();
      await Promise.resolve();
      assert.deepEqual(app.events, []);
      assert.equal(app.errors(), Number(fail));
    } finally { app.native.stop(); }
  }
});

test('普通点击必须包含有限坐标，拒绝旧空事件与非法坐标', async () => {
  for (const event of [
    '{"type":"pointer-down"}',
    '{"type":"pointer-down","x":"1","y":2}',
    '{"type":"pointer-down","x":1,"y":null}',
    '{"type":"pointer-down","x":1e999,"y":2}',
  ]) {
    const app = bridge();
    try {
      await app.native.ready;
      app.child.stdout.emit('data', event + '\n');
      assert.deepEqual(app.events, []);
      assert.equal(app.errors(), 1);
    } finally { app.native.stop(); }
  }
});

test('手动框选拒绝可重试，取消所属编号且停止时释放等待回执的请求', async () => {
  const app = bridge();
  try {
    const rejected = assert.rejects(app.native.beginSelection(), /无法开始屏幕框选/);
    app.emit({ type: 'selection-started', requestId: app.commands.at(-1).requestId, captureId: 0 });
    await rejected;
    const pending = app.native.beginSelection();
    app.emit({ type: 'selection-started', requestId: app.commands.at(-1).requestId, captureId: 18 });
    assert.equal(await pending, 18);
    app.native.cancelCapture(18);
    assert.deepEqual(app.commands.at(-1), { type: 'cancel-capture', captureId: 18 });
    app.emit({ type: 'trigger-cancel', captureId: 18 });
    await Promise.resolve();
    assert.deepEqual(app.events, ['cancel:18']);
    const interrupted = assert.rejects(app.native.beginSelection(), /框选已取消/);
    app.native.stop(); await interrupted;
    await assert.rejects(app.native.beginSelection(), /助手不可用/);
    assert.equal(app.errors(), 0);
  } finally { app.native.stop(); }
});

test('原生助手故障立即拒绝尚未开始的框选', async () => {
  const app = bridge();
  const pending = assert.rejects(app.native.beginSelection(), /框选未能开始/);
  app.child.emit('error', new Error('child stopped'));
  await pending;
  assert.equal(app.errors(), 1);
});


test('悬浮窗口准备仅按请求编号确认，互不干扰且不取消焦点请求', async () => {
  const app = bridge();
  try {
    const first = app.native.prepareOverlayWindow('12345');
    const firstCommand = app.commands.at(-1);
    const second = app.native.prepareOverlayWindow('67890');
    const secondCommand = app.commands.at(-1);
    assert.equal(firstCommand.type, 'prepare-overlay-window');
    assert.equal(firstCommand.handle, '12345');
    assert.equal(secondCommand.handle, '67890');
    assert.notEqual(firstCommand.requestId, secondCommand.requestId);
    assert.equal(app.commands.some(command => command.type === 'cancel-focus'), false);
    let firstFinished = false;
    void first.then(() => { firstFinished = true; });
    app.emit({ type: 'overlay-window-prepared', requestId: 'unrelated', prepared: true });
    app.emit({ type: 'overlay-window-prepared', requestId: secondCommand.requestId, prepared: false });
    assert.equal(await second, false);
    await Promise.resolve();
    assert.equal(firstFinished, false);
    app.emit({ type: 'overlay-window-prepared', requestId: firstCommand.requestId, prepared: true });
    assert.equal(await first, true);
    assert.equal(app.errors(), 0);
  } finally { app.native.stop(); }
});

test('停止或故障会结束全部窗口准备请求，并拒绝后续准备', async () => {
  for (const failure of [false, true]) {
    const app = bridge();
    const first = app.native.prepareOverlayWindow('12345');
    const second = app.native.prepareOverlayWindow('67890');
    if (failure) app.child.emit('error', new Error('child stopped'));
    else app.native.stop();
    assert.equal(await first, false);
    assert.equal(await second, false);
    assert.equal(await app.native.prepareOverlayWindow('12345'), false);
    app.native.stop();
  }
});

test('准备超时返回失败，迟到回执不影响下一次准备', { timeout: 5000 }, async () => {
  const app = bridge();
  try {
    const first = app.native.prepareOverlayWindow('12345');
    const staleId = app.commands.at(-1).requestId;
    // 保持测试事件循环存活，生产超时本身不延长退出。
    const keepAlive = setTimeout(() => {}, 4000);
    try { assert.equal(await first, false); } finally { clearTimeout(keepAlive); }
    const next = app.native.prepareOverlayWindow('12345');
    const nextId = app.commands.at(-1).requestId;
    app.emit({ type: 'overlay-window-prepared', requestId: staleId, prepared: true });
    app.emit({ type: 'overlay-window-prepared', requestId: nextId, prepared: false });
    assert.equal(await next, false);
    assert.equal(app.errors(), 0);
  } finally { app.native.stop(); }
});
