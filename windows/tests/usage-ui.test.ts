import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import type { UsageScope, UsageSummary } from '../electron/contracts.ts';

const source = readFileSync(new URL('../prototype/usage-ui.js', import.meta.url), 'utf8');
const graph: UsageScope = { kind: 'graph', workspaceId: 'workspace', graphId: 'graph' };
const otherGraph: UsageScope = { kind: 'graph', workspaceId: 'workspace', graphId: 'other' };
const empty: UsageSummary = { requestCount: 0, reportedRequestCount: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, cacheReportedRequestCount: 0 };
const known: UsageSummary = { requestCount: 3, reportedRequestCount: 2, promptTokens: 1200, completionTokens: 300, totalTokens: 1500, cacheReportedRequestCount: 1, cacheHitTokens: 600, cacheMissTokens: 200 };

function fixture() {
  class Element {
    children: Element[] = [];
    parent: Element | null = null;
    className = '';
    textContent = '';
    onclick?: (event: { target: Element }) => void;
    append(...children: Element[]) { for (const child of children) { child.parent = this; this.children.push(child); } }
    replaceChildren(...children: Element[]) { for (const child of this.children) child.parent = null; this.children = []; this.append(...children); }
    remove() { if (this.parent) { this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; } }
    setAttribute() {}
    get isConnected(): boolean { return this === document.body || this === document.head || !!this.parent?.isConnected; }
    focus() { document.activeElement = this; }
  }
  const listeners = new Map<string, Array<(event: any) => void>>();
  const document = {
    head: new Element(), body: new Element(), activeElement: null as Element | null,
    createElement: () => new Element(), getElementById: () => null,
    addEventListener(name: string, listener: (event: any) => void) { listeners.set(name, [...listeners.get(name) || [], listener]); },
    dispatchEvent(event: { type: string }) { for (const listener of listeners.get(event.type) || []) listener(event); },
  };
  const origin = new Element(); document.body.append(origin); origin.focus();
  const calls: Array<{ scope?: UsageScope; resolve: (value: UsageSummary) => void; reject: (error: Error) => void }> = [];
  const changes = new Set<(scope: UsageScope) => void>();
  const window = {
    rabbitDesktop: {
      usageQuery(scope?: UsageScope) { return new Promise<UsageSummary>((resolve, reject) => calls.push({ scope, resolve, reject })); },
      onUsageChanged(listener: (scope: UsageScope) => void) { changes.add(listener); return () => changes.delete(listener); },
    },
    RabbitUsage: undefined as { open: (scope?: UsageScope, options?: { title: string }) => void; close: () => void } | undefined,
  };
  vm.runInNewContext(source, { window, document, CustomEvent: class { type: string; constructor(type: string) { this.type = type; } } });
  const find = (className: string, root = document.body): Element | undefined => root.className === className ? root : root.children.map(child => find(className, child)).find(Boolean);
  return {
    document, origin, calls, changes, ui: window.RabbitUsage!, find,
    emit(scope: UsageScope) { for (const listener of changes) listener(scope); },
    metrics() { return find('rabbit-usage-grid')?.children.map(box => box.children[1].textContent) || []; },
    note() { return find('rabbit-usage-note')?.textContent; },
  };
}

async function flush() { await Promise.resolve(); await Promise.resolve(); }

test('总体和图谱范围查询保留真实数字，缓存命中率使用已知缓存子集', async () => {
  const f = fixture();
  f.ui.open(graph, { title: '研究图谱' });
  assert.deepEqual(f.calls[0].scope, graph);
  assert.equal(f.find('rabbit-usage-title')?.textContent, '研究图谱');
  f.calls[0].resolve(known); await flush();
  assert.deepEqual(f.metrics(), ['1,200', '300', '1,500', '75.0%']);
  assert.match(f.note()!, /3 次模型请求，2 次返回用量/);
  f.find('rabbit-usage-total')!.onclick!({ target: f.find('rabbit-usage-total')! });
  assert.equal(f.calls[1].scope, undefined);
  assert.equal(f.find('rabbit-usage-title')?.textContent, '兔球全部用量');
  f.calls[1].resolve(known); await flush();
  f.emit(otherGraph);
  assert.equal(f.calls.length, 3, '总体统计接收其它图谱的用量变化');
});

test('未知用量显示横线，真实零用量显示零，零缓存分母不伪造命中率', async () => {
  const f = fixture(); f.ui.open();
  f.calls[0].resolve({ ...empty, requestCount: 2 }); await flush();
  assert.deepEqual(f.metrics(), ['—', '—', '—', '—']);
  assert.match(f.note()!, /2 次模型请求，0 次返回用量/);
  f.emit(graph);
  f.calls[1].resolve({ ...empty, requestCount: 1, reportedRequestCount: 1, cacheReportedRequestCount: 1, cacheHitTokens: 0, cacheMissTokens: 0 }); await flush();
  assert.deepEqual(f.metrics(), ['0', '0', '0', '—']);
  assert.match(f.note()!, /缓存命中 0 Token，未命中 0 Token/);
  f.emit(graph);
  f.calls[2].resolve({ ...empty, requestCount: 1, reportedRequestCount: 1, promptTokens: 10, totalTokens: 10, cacheReportedRequestCount: 1, cacheHitTokens: 0, cacheMissTokens: 10 }); await flush();
  assert.deepEqual(f.metrics(), ['10', '0', '10', '0.0%']);
});

test('切换范围后迟到的响应和错误都不覆盖当前范围', async () => {
  const f = fixture(); f.ui.open(graph); f.ui.open(otherGraph);
  f.calls[1].resolve(known); await flush();
  f.calls[0].resolve({ ...empty, requestCount: 1 }); await flush();
  assert.deepEqual(f.metrics(), ['1,200', '300', '1,500', '75.0%']);
  f.ui.open(graph); f.ui.open(otherGraph);
  f.calls[3].resolve(known); await flush();
  f.calls[2].reject(new Error('旧范围失败')); await flush();
  assert.match(f.note()!, /3 次模型请求/);
  const before = f.calls.length; f.emit(graph);
  assert.equal(f.calls.length, before, '其它图谱事件不刷新当前图谱');
});

test('Escape 关闭面板并恢复焦点，关闭后事件和迟到响应不重开面板', async () => {
  const f = fixture(); f.ui.open(graph);
  let prevented = false, stopped = false;
  f.document.dispatchEvent({ type: 'keydown', key: 'Escape', preventDefault() { prevented = true; }, stopImmediatePropagation() { stopped = true; } } as any);
  assert.equal(prevented, true); assert.equal(stopped, true);
  assert.equal(f.document.activeElement, f.origin);
  assert.equal(f.find('rabbit-usage-shade'), undefined);
  f.emit(graph); assert.equal(f.calls.length, 1);
  f.calls[0].resolve(known); await flush();
  assert.equal(f.find('rabbit-usage-shade'), undefined);
  f.ui.open(graph); f.ui.close();
  assert.equal(f.changes.size, 1, '重复打开关闭不累积应用级订阅');
});

test('同一范围并发刷新时旧响应不覆盖最新用量', async () => {
  const f = fixture(); f.ui.open(graph); f.emit(graph);
  f.calls[1].resolve(known); await flush();
  f.calls[0].resolve({ ...empty, requestCount: 1, reportedRequestCount: 1, promptTokens: 10, completionTokens: 2, totalTokens: 12 }); await flush();
  assert.deepEqual(f.metrics(), ['1,200', '300', '1,500', '75.0%']);
  assert.match(f.note()!, /3 次模型请求/);
});

test('同一范围旧查询失败不覆盖新查询成功后的说明', async () => {
  const f = fixture(); f.ui.open(graph); f.emit(graph);
  f.calls[1].resolve(known); await flush();
  f.calls[0].reject(new Error('过期查询失败')); await flush();
  assert.match(f.note()!, /3 次模型请求/);
});
