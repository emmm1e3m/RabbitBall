import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ClipboardStore } from '../electron/clipboard.ts';

class Item {
  readonly data: Record<string, Blob>;
  readonly types: string[];
  constructor(data: Record<string, string | Blob>) {
    this.data = Object.fromEntries(Object.entries(data).map(([type, value]) => [type, typeof value === 'string' ? new Blob([value], { type }) : value]));
    this.types = Object.keys(data);
  }
  async getType(type: string) { return this.data[type]; }
}

function fixture(initial: Record<string, string | Blob> = { 'text/plain': '激活前在其他应用复制的文字' }) {
  let items = [new Item(initial)], failRead = false, failWrite = false;
  let beforeWrite: (() => Promise<void>) | undefined;
  const writes: Item[][] = [];
  const clipboard = {
    async read() { if (failRead) throw new Error('clipboard busy'); return [...items]; },
    async write(value: Item[]) { if (beforeWrite) await beforeWrite(); if (failWrite) throw new Error('write failed'); items = value; writes.push(value); },
  };
  const store = new ClipboardStore(clipboard as any, data => new Item(data) as any);
  return { store, writes, copy(data: Record<string, string | Blob>) { items = [new Item(data)]; },
    failRead(value: boolean) { failRead = value; }, failWrite(value: boolean) { failWrite = value; },
    beforeWrite(run: () => Promise<void>) { beforeWrite = run; },
    items: () => items,
  };
}
const png = new Uint8Array([137, 80, 78, 71]);
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

test('自动截图覆盖系统剪贴板，兔球粘贴仍取激活前的用户文字', async () => {
  const f = fixture(), activation = f.store.beginActivation();
  await f.store.writeScreenshot(png, activation);
  assert.equal(f.writes.length, 1);
  assert.ok(f.items()[0].types.includes('image/png'));
  assert.ok(f.items()[0].types.some(type => type.startsWith('web ')));
  assert.deepEqual(await f.store.readForPaste(), { text: '激活前在其他应用复制的文字' });
  assert.equal(f.writes.length, 1, '粘贴读取不改写系统剪贴板');
});

test('连续激活和多次框选不把自动截图当作用户复制内容', async () => {
  const f = fixture();
  for (let n = 0; n < 4; n++) {
    const activation = f.store.beginActivation();
    await f.store.writeScreenshot(png, activation);
    await f.store.writeScreenshot(png, activation);
    assert.deepEqual(await f.store.readForPaste(), { text: '激活前在其他应用复制的文字' });
  }
});

test('激活后或自动截图后重新复制的内容优先，后续多张自动图仍保留新内容', async () => {
  const f = fixture(), activation = f.store.beginActivation();
  await activation;
  f.copy({ 'text/plain': '截图处理中复制 B' });
  await f.store.writeScreenshot(png, activation);
  assert.deepEqual(await f.store.readForPaste(), { text: '截图处理中复制 B' });
  await f.store.writeScreenshot(png, activation);
  assert.deepEqual(await f.store.readForPaste(), { text: '截图处理中复制 B' });
  f.copy({ 'text/plain': '截图完成后复制 C' });
  assert.deepEqual(await f.store.readForPaste(), { text: '截图完成后复制 C' });
  await f.store.writeScreenshot(png, activation);
  await f.store.writeScreenshot(png, activation);
  assert.deepEqual(await f.store.readForPaste(), { text: '截图完成后复制 C' });
});

test('用户图片可粘贴，带文字的多格式内容优先粘贴文字', async () => {
  const f = fixture({ 'image/png': new Blob(['user-image']) });
  await f.store.writeScreenshot(png, f.store.beginActivation());
  assert.deepEqual(await f.store.readForPaste(), { imageDataUrl: 'data:image/png;base64,dXNlci1pbWFnZQ==' });
  f.copy({ 'text/plain': '文字', 'image/png': new Blob(['image']) });
  assert.deepEqual(await f.store.readForPaste(), { text: '文字' });
});

test('读取失败不覆盖剪贴板，后续读取恢复后可继续复制', async () => {
  const f = fixture();f.failRead(true);
  const activation = f.store.beginActivation();
  assert.equal(await activation, null);
  await assert.rejects(f.store.writeScreenshot(png, activation), /截图未自动复制/);
  assert.equal(f.writes.length, 0);
  f.failRead(false);await f.store.writeScreenshot(png, f.store.beginActivation());
  assert.deepEqual(await f.store.readForPaste(), { text: '激活前在其他应用复制的文字' });
});

test('写入失败不使队列失效，也不把失败的标记作为当前截图', async () => {
  const f = fixture(), activation = f.store.beginActivation();f.failWrite(true);
  await assert.rejects(f.store.writeScreenshot(png, activation), /write failed/);
  assert.deepEqual(await f.store.readForPaste(), { text: '激活前在其他应用复制的文字' });
  f.failWrite(false);await f.store.writeScreenshot(png, activation);
  assert.deepEqual(await f.store.readForPaste(), { text: '激活前在其他应用复制的文字' });
});

test('写入进行中触发下一次激活和粘贴，按顺序解析正确原内容', async () => {
  const f = fixture();let release!: () => void;
  f.beforeWrite(() => new Promise<void>(resolve => { release = resolve; }));
  const write = f.store.writeScreenshot(png, f.store.beginActivation());
  await settle();
  const activation = f.store.beginActivation(), paste = f.store.readForPaste();
  release();await write;
  assert.deepEqual(await activation, { text: '激活前在其他应用复制的文字' });
  assert.deepEqual(await paste, { text: '激活前在其他应用复制的文字' });
});

test('排队期间取消截图不会写入，空剪贴板也不会回退到陈旧内容', async () => {
  const f = fixture();let allowed = true;
  const activation = f.store.beginActivation();
  const write = f.store.writeScreenshot(png, activation, () => allowed);allowed = false;await write;
  assert.equal(f.writes.length, 0);
  f.copy({});await f.store.writeScreenshot(png, f.store.beginActivation());
  assert.deepEqual(await f.store.readForPaste(), {});
});

test('用户主动重新选择剪贴板历史里的旧截图时按图片粘贴', async () => {
  const f = fixture();
  await f.store.writeScreenshot(png, f.store.beginActivation());
  const oldImage = f.items()[0].data;
  f.copy({ 'text/plain': '新的文字' });
  await f.store.writeScreenshot(new Uint8Array([1, 2, 3]), f.store.beginActivation());
  f.copy(oldImage);
  assert.deepEqual(await f.store.readForPaste(), { imageDataUrl: 'data:image/png;base64,iVBORw==' });
});
