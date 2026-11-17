import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { UsageStore, validateUsageScope } from '../electron/usage.ts';
import type { RabbitDesktop, UsageReport, UsageScope, UsageSummary } from '../electron/contracts.ts';

const graph: UsageScope = { kind: 'graph', workspaceId: 'workspace', graphId: 'graph' };
const chat: UsageScope = { kind: 'chat', conversationId: 'chat' };
const empty: UsageSummary = { requestCount: 0, reportedRequestCount: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, cacheReportedRequestCount: 0 };

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), 'rabbitball-usage-'));
  const changes: UsageScope[] = [];
  const store = new UsageStore(directory, scope => changes.push(scope));
  await store.load();
  t.after(async () => { await store.idle(); await rm(directory, { recursive: true, force: true }); });
  return { store, directory, changes };
}

test('未知用量只累计请求，真实零缓存与未报告缓存保持区别', async t => {
  const { store } = await fixture(t);
  assert.deepEqual(await store.query(), empty);
  await store.record({ scope: graph, model: 'model' });
  assert.deepEqual(await store.query(graph), { ...empty, requestCount: 1 });
  await store.record({ scope: graph, model: 'model', usage: { promptTokens: 7, completionTokens: 3, totalTokens: 10 } });
  assert.deepEqual(await store.query(graph), { ...empty, requestCount: 2, reportedRequestCount: 1, promptTokens: 7, completionTokens: 3, totalTokens: 10 });
  await store.record({ scope: graph, model: 'model', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, reasoningTokens: 0 } });
  assert.deepEqual(await store.query(graph), { requestCount: 3, reportedRequestCount: 2, promptTokens: 7, completionTokens: 3, totalTokens: 10,
    cacheReportedRequestCount: 1, cacheHitTokens: 0, cacheMissTokens: 0, reasoningTokens: 0 });
  await store.record({ scope: graph, model: 'model', usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, cacheHitTokens: 9 } });
  const partial = await store.query(graph);
  assert.equal(partial.cacheReportedRequestCount, 1);
  assert.equal(partial.cacheHitTokens, 0, '单边缓存不混入完整缓存请求子集');
  assert.equal(partial.totalTokens, 22);
});

test('并发请求按图谱或聊天累计，重载与总体查询保留完整数字', async t => {
  const { store, directory, changes } = await fixture(t);
  const otherGraph: UsageScope = { kind: 'graph', workspaceId: 'other-workspace', graphId: 'graph' };
  await Promise.all(Array.from({ length: 20 }, (_, i) => store.record({
    scope: i % 2 ? graph : chat, model: 'private-model-name',
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, cacheHitTokens: 6, cacheMissTokens: 4, reasoningTokens: 2 },
  })));
  await store.record({ scope: otherGraph, model: 'other' });
  const oneScope = { requestCount: 10, reportedRequestCount: 10, promptTokens: 100, completionTokens: 50, totalTokens: 150,
    cacheReportedRequestCount: 10, cacheHitTokens: 60, cacheMissTokens: 40, reasoningTokens: 20 };
  assert.deepEqual(await store.query(graph), oneScope);
  assert.deepEqual(await store.query(chat), oneScope);
  assert.deepEqual(await store.query(otherGraph), { ...empty, requestCount: 1 });
  assert.deepEqual(await store.query(), { requestCount: 21, reportedRequestCount: 20, promptTokens: 200, completionTokens: 100, totalTokens: 300,
    cacheReportedRequestCount: 20, cacheHitTokens: 120, cacheMissTokens: 80, reasoningTokens: 40 });
  assert.equal(changes.length, 21);
  const raw = await readFile(path.join(directory, 'usage.json'), 'utf8');
  assert.equal(JSON.parse(raw).entries.length, 3, '仅保存各范围累计，不保存逐次请求');
  assert.equal(raw.includes('private-model-name'), false);
  const reloaded = new UsageStore(directory); await reloaded.load();
  assert.deepEqual(await reloaded.query(), await store.query());
  const mutable = await reloaded.query(graph); mutable.totalTokens = 1;
  assert.equal((await reloaded.query(graph)).totalTokens, 150, '查询快照不暴露内部累计值');
});

test('查询范围与用量外部数据校验拒绝无效值且不写盘', async t => {
  const { store, changes } = await fixture(t);
  assert.equal(validateUsageScope(undefined), undefined); assert.equal(validateUsageScope(null), undefined);
  assert.deepEqual(validateUsageScope({ ...graph, extra: 'ignored' }), graph);
  assert.deepEqual(validateUsageScope({ kind: 'chat', conversationId: 'x'.repeat(200) }), { kind: 'chat', conversationId: 'x'.repeat(200) });
  for (const input of [[], '', {}, { kind: 'chat', conversationId: '' }, { kind: 'chat', conversationId: ' ' },
    { kind: 'chat', conversationId: 'x'.repeat(201) }, { kind: 'graph', workspaceId: 'w' }, { kind: 'graph', workspaceId: 1, graphId: 'g' }]) {
    assert.throws(() => validateUsageScope(input), /范围无效/);
    await assert.rejects(store.query(input as UsageScope), /范围无效/);
  }
  for (const input of [null, { scope: null, model: 'model' }, { scope: graph, model: '' },
    { scope: graph, model: 'model', usage: null }, { scope: graph, model: 'model', usage: {} }]) {
    await assert.rejects(store.record(input as UsageReport));
  }
  for (const invalid of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '12']) {
    await assert.rejects(store.record({ scope: graph, model: 'model', usage: { promptTokens: invalid, completionTokens: 0, totalTokens: 0 } } as UsageReport));
    await assert.rejects(store.record({ scope: graph, model: 'model', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cacheHitTokens: invalid } } as UsageReport));
  }
  assert.deepEqual(await store.query(), empty); assert.equal(changes.length, 0);
});

test('写盘失败不发布未保存计数，后续查询与写入仍可继续', async t => {
  const { store, directory, changes } = await fixture(t);
  await store.record({ scope: graph, model: 'model', usage: { promptTokens: 4, completionTokens: 1, totalTokens: 5 } });
  const previous = await store.query(), original = await readFile(path.join(directory, 'usage.json'), 'utf8');
  const temporary = path.join(directory, 'usage.json.tmp'); await mkdir(temporary);
  await assert.rejects(store.record({ scope: graph, model: 'model', usage: { promptTokens: 40, completionTokens: 10, totalTokens: 50 } }));
  await store.idle();
  assert.deepEqual(await store.query(), previous); assert.equal(changes.length, 1);
  assert.equal(await readFile(path.join(directory, 'usage.json'), 'utf8'), original);
  await rm(temporary, { recursive: true });
  await store.record({ scope: graph, model: 'model' });
  assert.deepEqual(await store.query(), { ...previous, requestCount: 2 });
  assert.equal(changes.length, 2);
});

test('损坏文件明确报错且保留原件，读取失败不替换已有内存汇总', async t => {
  const { store, directory } = await fixture(t);
  await store.record({ scope: graph, model: 'model' });
  const previous = await store.query();
  for (const content of ['not-json', JSON.stringify({ version: 2, entries: [] }), JSON.stringify({ version: 1, entries: [{ scope: graph, summary: { ...empty, reportedRequestCount: 2 } }] })]) {
    await writeFile(path.join(directory, 'usage.json'), content, 'utf8');
    await assert.rejects(store.load());
    assert.equal(await readFile(path.join(directory, 'usage.json'), 'utf8'), content);
    assert.deepEqual(await store.query(), previous);
  }
});

test('preload 用量查询保持范围并允许取消变化订阅', async () => {
  for (const search of ['', '?view=graph']) {
    const events = new EventEmitter(), calls: Array<{ channel: string; value: unknown }> = [];
    let desktop: RabbitDesktop | undefined;
    const source = readFileSync(new URL('../electron/preload.cts', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '');
    vm.runInNewContext(stripTypeScriptTypes(source), {
      process: { platform: 'win32' },
      URLSearchParams, location: { search },
      contextBridge: { exposeInMainWorld(_name: string, value: RabbitDesktop) { desktop = value; } },
      ipcRenderer: { on: events.on.bind(events), removeListener: events.removeListener.bind(events),
        async invoke(channel: string, value: unknown) { calls.push({ channel, value }); return empty; } },
    });
    assert.equal(desktop!.surface, search ? 'graph' : 'pet');
    assert.deepEqual(await desktop!.usageQuery(graph), empty);
    assert.deepEqual(calls.at(-1), { channel: 'rabbit:usage-query', value: graph });
    await desktop!.usageQuery(); assert.deepEqual(calls.at(-1), { channel: 'rabbit:usage-query', value: undefined });
    const changes: UsageScope[] = [], stop = desktop!.onUsageChanged(scope => changes.push(scope));
    const visibility: boolean[] = [], stopVisibility = desktop!.onGraphVisibilityChanged(visible => visibility.push(visible));
    events.emit('rabbit:usage-changed', {}, chat); assert.deepEqual(changes, [chat]);
    assert.deepEqual(visibility, []);
    events.emit('rabbit:graph-visibility', {}, true); assert.deepEqual(visibility, [true]); assert.deepEqual(changes, [chat]);
    stop(); events.emit('rabbit:usage-changed', {}, graph); assert.deepEqual(changes, [chat]);
    events.emit('rabbit:graph-visibility', {}, false); assert.deepEqual(visibility, [true, false]);
    stopVisibility(); events.emit('rabbit:graph-visibility', {}, true); assert.deepEqual(visibility, [true, false]);
  }
});
