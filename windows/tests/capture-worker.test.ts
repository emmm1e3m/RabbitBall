import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

function harness() {
  const children: Child[] = [];
  class Child extends EventEmitter {
    stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
    stderr = { resume() {} };
    lines: string[] = [];
    stdin = Object.assign(new EventEmitter(), { write: (line: string) => this.lines.push(line) });
    killed = false;
    kill() { this.killed = true; }
    emitLine(value: unknown) { this.stdout.emit('data', Buffer.from(JSON.stringify(value) + '\n')); }
    reply(result: unknown) {
      const request = JSON.parse(this.lines.at(-1)!);
      this.emitLine({ type: 'result', requestId: request.requestId, result });
    }
  }
  const url = new URL('../electron/capture-worker.ts', import.meta.url);
  const source = readFileSync(url, 'utf8').replace(/^import .*;\r?\n/gm, '').replaceAll('import.meta.url', '__moduleUrl');
  const context: any = {
    spawn: () => { const child = new Child(); children.push(child); return child; },
    readFileSync: () => 'script', path, fileURLToPath, __moduleUrl: url.href, randomUUID,
    Buffer, process: { pid: 42 }, setTimeout, clearTimeout,
  };
  vm.runInNewContext(stripTypeScriptTypes(source).replace(/^export /gm, '') + '\nglobalThis.WorkerClass = CaptureWorker;', context);
  return { worker: new context.WorkerClass(), children };
}

test('助手启动只编译一次，分片响应和连续截图复用同一空闲进程', async () => {
  const { worker, children } = harness();
  const ready = worker.prepare();
  assert.equal(children.length, 1);
  children[0].stdout.emit('data', Buffer.from('{"type":"rea'));
  children[0].stdout.emit('data', Buffer.from('dy"}\n'));
  await ready;
  for (let i = 0; i < 2; i++) {
    const request = i === 0 ? { type: 'window' } : { type: 'desktop', bounds: { x: -100, y: 0, width: 100, height: 80 } };
    const capture = worker.capture(request, new AbortController().signal);
    await Promise.resolve();
    const { requestId, ...sent } = JSON.parse(children[0].lines.at(-1)!);
    assert.deepEqual(sent, request);
    children[0].reply({ title: 'image-' + i });
    assert.equal((await capture).title, 'image-' + i);
  }
  assert.equal(children.length, 1);
  worker.stop();
  assert.equal(children[0].killed, true);
});

test('窗口图与独立背景同包返回，跨块中文与二进制换行不干扰协议', async () => {
  const { worker, children } = harness();
  const ready = worker.prepare(); children[0].emitLine({ type: 'ready' }); await ready;
  const bounds = { x: -2, y: 0, width: 2, height: 1 };
  const capture = worker.capture({ type: 'window', backgroundBounds: bounds }, new AbortController().signal);
  await Promise.resolve();
  const { requestId, ...request } = JSON.parse(children[0].lines.at(-1)!);
  assert.deepEqual(request, { type: 'window', backgroundBounds: bounds });
  const pixels = Buffer.from([10, 0, 255, 255, 0, 255, 10, 255]);
  const metadata = { title: '屏幕', handle: '1234', bounds, cursor: { x: -1, y: 0 }, imageBase64: Buffer.from('window PNG').toString('base64'), imageWidth: 240, imageHeight: 160 };
  const header = Buffer.from(JSON.stringify({ type: 'result', requestId, bitmapBytes: 8, result: { ...metadata, desktopWidth: 2, desktopHeight: 1 } }) + '\n');
  const chineseByte = header.indexOf(Buffer.from('屏')) + 1;
  children[0].stdout.emit('data', header.subarray(0, chineseByte));
  children[0].stdout.emit('data', Buffer.concat([header.subarray(chineseByte), pixels.subarray(0, 3)]));
  children[0].stdout.emit('data', pixels.subarray(3));
  const result = await capture;
  assert.equal(result.title, '屏幕');
  assert.equal(result.handle, metadata.handle);
  assert.deepEqual(JSON.parse(JSON.stringify(result.bounds)), metadata.bounds);
  assert.deepEqual(JSON.parse(JSON.stringify(result.cursor)), metadata.cursor);
  assert.deepEqual(result.desktopBitmap, pixels);
  assert.equal(result.imageBase64, metadata.imageBase64);
  assert.equal(result.imageWidth, 240);
  assert.equal(result.imageHeight, 160);
  worker.stop();
});

test('取消未完成的窗口截图会结束旧助手，新会话不受旧响应或退出影响', async () => {
  const { worker, children } = harness();
  const ready = worker.prepare(); children[0].emitLine({ type: 'ready' }); await ready;
  const controller = new AbortController();
  const request = { type: 'window' };
  const oldCapture = worker.capture(request, controller.signal);
  await Promise.resolve();
  controller.abort();
  await assert.rejects(oldCapture, /取消/);
  assert.equal(children[0].killed, true);
  const next = worker.capture(request, new AbortController().signal);
  children[1].emitLine({ type: 'ready' });
  await Promise.resolve();
  children[0].reply({ title: '旧图' }); children[0].emit('exit');
  children[1].reply({ title: '新图' });
  assert.equal((await next).title, '新图');
  worker.stop();
});

test('启动期间取消的会话不会在助手就绪后提交截图', async () => {
  const { worker, children } = harness();
  const controller = new AbortController();
  const capture = worker.capture({ type: 'window' }, controller.signal);
  controller.abort();
  children[0].emitLine({ type: 'ready' });
  await assert.rejects(capture);
  assert.equal(children[0].lines.length, 1, '只有脚本首行，没有截图请求');
  worker.stop();
});

test('进程启动失败可重新准备，停止后不能再次生成助手', async () => {
  const { worker, children } = harness();
  const ready = worker.prepare(); children[0].emit('error', new Error('启动失败'));
  await assert.rejects(ready, /启动失败/);
  const retry = worker.prepare(); children[1].emitLine({ type: 'ready' }); await retry;
  worker.stop();
  await assert.rejects(worker.prepare(), /关闭/);
  assert.equal(children.length, 2);
});
