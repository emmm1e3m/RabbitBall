import assert from 'node:assert/strict';
import test from 'node:test';
import { GraphJobs, buildGraphChatContext, parseCardResponse } from '../electron/graph-jobs.ts';
import type { GraphModelRunner } from '../electron/graph-jobs.ts';
import type { AgentRequest, CaptureImage, PrivateSettings } from '../electron/contracts.ts';
import type { GraphAnnotation, GraphNode, GraphNodeRequest, GraphWorkspace } from '../electron/graph-contracts.ts';
import { DEFAULT_PROMPTS } from '../electron/prompts.ts';

const settings = {
  bodyColor: '#F58DAA', eyeColor: '#F90040', petSize: 1, useBuiltinFont: false,
  launchAtLogin: false, pauseOnFullscreen: true, followMouse: true, autoCopyScreenshots: true,
  historyLimit: 0, activationShortcut: ['AltLeft'], reasoning: 'medium', maxToolRounds: 3,
  apiBaseUrl: 'https://example.invalid', model: 'fixture', apiKey: 'test-only',
  prompts: { ...DEFAULT_PROMPTS },
} as PrivateSettings;

const sourceImage: CaptureImage = { id: 'image-root', title: '根截图', imageDataUrl: 'data:image/png;base64,cm9vdA==' };
function node(id: string, parentId: string | null = 'root', extra: Partial<GraphNode> = {}): GraphNode {
  return {
    id, parentId, kind: parentId === null ? 'source' : 'card', title: id,
    markdown: `${id} 的正文`, images: [], annotations: [], pinned: false,
    x: 0, y: 0, contentRevision: 0, status: 'idle', ...extra,
  };
}
function annotations(count: number): GraphAnnotation[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `annotation-${i}`, selection: { kind: 'text', text: `选区内容 ${i}` }, comment: `批注问题 ${i}`,
  }));
}
function workspace(nodes: GraphNode[] = [node('root', null, { images: [sourceImage], annotations: annotations(2) })]): GraphWorkspace {
  return { id: 'workspace', name: '测试文档', revision: 0, updatedAt: 1, lastGraphId: 'graph', graphs: [{
    id: 'graph', title: '测试图', rootId: 'root', nodes, view: { x: 0, y: 0, zoom: 1 }, updatedAt: 1,
    layoutInitialized: false, layoutUnit: 238,
  }] };
}
const request = (nodeId = 'root'): GraphNodeRequest => ({ workspaceId: 'workspace', graphId: 'graph', nodeId });

// 使用与持久化层相同的事务边界，验证任务不会依赖过期的节点对象。
class MemoryStore {
  private value: GraphWorkspace;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(value = workspace()) { this.value = structuredClone(value); }
  async open(id: string): Promise<GraphWorkspace> {
    await this.tail;
    assert.equal(id, this.value.id);
    return structuredClone(this.value);
  }
  update(id: string, change: (workspace: GraphWorkspace) => void): Promise<GraphWorkspace> {
    const next = this.tail.then(() => {
      assert.equal(id, this.value.id);
      const draft = structuredClone(this.value);
      change(draft);
      for (const graph of draft.graphs) for (const item of graph.nodes) {
        const previous = this.value.graphs.find(g => g.id === graph.id)?.nodes.find(n => n.id === item.id);
        if (previous) item.contentRevision = previous.contentRevision + Number(item.title !== previous.title || item.markdown !== previous.markdown);
      }
      draft.revision = this.value.revision + 1;
      this.value = draft;
      return structuredClone(draft);
    });
    this.tail = next.catch(() => {});
    return next;
  }
  async nodes(): Promise<GraphNode[]> { return (await this.open('workspace')).graphs[0].nodes; }
}

type ModelOptions = Parameters<GraphModelRunner>[2];
interface ModelCall {
  request: AgentRequest;
  options: ModelOptions;
  ignoreAbort: boolean;
  settled: boolean;
  start(): void;
  progress(toolCounts?: Record<string, number>): void;
  delta(text: string): void;
  finish(text: string): void;
  fail(message: string): void;
  late(text: string): void;
}
function modelHarness(automaticStart = true) {
  const calls: ModelCall[] = [];
  let running = 0, maximum = 0;
  const run: GraphModelRunner = (req, _settings, options) => new Promise<void>(resolve => {
    running++; maximum = Math.max(maximum, running);
    let streamed = '';
    const settle = () => {
      if (call.settled) return;
      call.settled = true; running--; resolve();
    };
    const emitText = (text: string) => {
      options.onEvent({ id: req.id, type: 'delta', text });
      options.onEvent({ id: req.id, type: 'done', text });
    };
    const call: ModelCall = {
      request: req, options, ignoreAbort: false, settled: false,
      start() { options.onEvent({ id: req.id, type: 'start' }); },
      progress(toolCounts) { options.onEvent({ id: req.id, type: 'tool', toolCounts }); },
      delta(text) { streamed += text; options.onEvent({ id: req.id, type: 'delta', text }); },
      finish(text) {
        if (call.settled) return;
        if (streamed) {
          assert.ok(text.startsWith(streamed), '完成稿应延续已发出的流式前缀');
          options.onEvent({ id: req.id, type: 'delta', text: text.slice(streamed.length) });
          options.onEvent({ id: req.id, type: 'done', text });
        } else emitText(text);
        settle();
      },
      fail(message) { if (!call.settled) { options.onEvent({ id: req.id, type: 'error', message }); settle(); } },
      late: emitText,
    };
    options.signal.addEventListener('abort', () => {
      if (!call.ignoreAbort && !call.settled) {
        options.onEvent({ id: req.id, type: 'cancelled' }); settle();
      }
    }, { once: true });
    calls.push(call);
    if (automaticStart) call.start();
  });
  return { calls, run, get maximum() { return maximum; } };
}
async function eventually(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const until = Date.now() + 2000;
  while (Date.now() < until) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.fail('等待任务状态超时');
}
function arrange(t: { after: (callback: () => unknown) => unknown }, initial = workspace(), concurrency = 3) {
  const store = new MemoryStore(initial), model = modelHarness();
  const jobs = new GraphJobs(store, () => settings, { run: model.run, concurrency, streamInterval: 1 });
  t.after(async () => {
    jobs.cancelAll();
    model.calls.forEach(call => { call.ignoreAbort = false; call.fail('测试清理'); });
    await jobs.idle();
  });
  return { store, model, jobs };
}

test('单卡解析保留代码围栏中的标题，并拒绝多章节或缺少标题', () => {
  assert.deepEqual(parseCardResponse('### 解释标题\n\n正文。'), { title: '解释标题', markdown: '正文。' });
  assert.deepEqual(parseCardResponse('### **概率** $p = |\\alpha|^2$\n\n解释公式。'), { title: '**概率** $p = |\\alpha|^2$', markdown: '解释公式。' });
  const body = '下面是代码：\n\n```markdown\n### 代码中的标题\n```\n\n说明。';
  assert.deepEqual(parseCardResponse(`### 标题\n\n${body}`), { title: '标题', markdown: body });
  assert.throws(() => parseCardResponse('### 第一节\n\n内容\n\n### 第二节\n\n内容'));
  assert.throws(() => parseCardResponse('没有卡片标题的正文'));
});

test('快速会话上下文包含完整祖先路径和原图，不混入旁支', () => {
  const value = workspace([
    node('root', null, { markdown: '根资料的独有内容', images: [sourceImage] }),
    node('middle', 'root', { markdown: '中间解释的独有内容' }),
    node('current', 'middle', { markdown: '当前卡片的独有内容' }),
    node('sibling', 'root', { markdown: '不应发送的旁支秘密', images: [{ ...sourceImage, id: 'sibling-image' }] }),
  ]);
  const result = buildGraphChatContext(value, 'graph', 'current');
  assert.ok(result.reference.startsWith('如果使用标题，'));
  for (const rule of ['短概念名', '8～14字', '最多约18个汉字', '英文3～7词', '公式和推导写在正文']) assert.ok(result.reference.includes(rule));
  assert.ok(!result.reference.includes('输出必须以一个“### 标题”开始'));
  for (const text of ['根资料的独有内容', '中间解释的独有内容', '当前卡片的独有内容']) assert.ok(result.reference.includes(text));
  assert.ok(!result.reference.includes('不应发送的旁支秘密'));
  assert.deepEqual(result.context.images.map(image => image.id), ['image-root']);
});

test('生成提示约束简短概念标题，较长合法回复仍完整保留', { timeout: 5000 }, async t => {
  const { store, model, jobs } = arrange(t, workspace([node('root', null, { annotations: annotations(1) })]));
  await jobs.generate(request());
  await eventually(() => model.calls.length === 1);
  const prompt = model.calls[0].request.text;
  for (const rule of ['短概念名', '8～14字', '最多约18个汉字', '英文3～7词', '标题不复述批注或问题', '不放长公式或推导句', '公式和推导写在正文']) assert.ok(prompt.includes(rule));
  const title = '解释归一化条件与测量概率之间的关系 $\\sum_{i=1}^{n} |\\alpha_i|^2 = 1$';
  model.calls[0].finish(`### ${title}\n\n完整的选区解释。`);
  await jobs.idle();
  const child = (await store.nodes()).find(item => item.kind === 'card')!;
  assert.equal(child.title, title, '标题长度指引不应截断公式或丢弃已完成的正文');
  assert.equal(child.markdown, '完整的选区解释。');
  assert.equal(child.status, 'idle');
});

test('空图快速会话没有参考路径或图片', () => {
  for (const nodeId of [undefined, 'root']) {
    const result = buildGraphChatContext(workspace([]), 'graph', nodeId);
    assert.ok(result.reference.startsWith('如果使用标题，'));
    assert.ok(!result.reference.includes('完整参考路径'));
    assert.deepEqual(result.context.images, []);
  }
  assert.throws(() => buildGraphChatContext(workspace([]), 'graph', 'missing-card'));
});

test('重复提交不复制批注子卡，独立任务遵守并发上限并保留批注顺序', { timeout: 5000 }, async t => {
  const value = workspace([node('root', null, { images: [sourceImage], annotations: annotations(4) })]);
  const { store, model, jobs } = arrange(t, value, 2);
  await Promise.all([jobs.generate(request()), jobs.generate(request())]);
  await eventually(() => model.calls.length === 2);
  const created = await store.nodes();
  assert.equal(created.length, 5);
  const childIds = created[0].annotations.map(item => item.childId);
  assert.equal(new Set(childIds).size, 4);
  assert.deepEqual(created.slice(1).map(item => item.source?.annotationId), annotations(4).map(item => item.id));
  assert.ok(created.slice(1).every(item => item.title === '生成中'));
  model.calls[1].finish('### 第二个先完成\n\n第二个回答。');
  await eventually(() => model.calls.length === 3);
  model.calls[0].finish('### 第一个稍后完成\n\n第一个回答。');
  await eventually(() => model.calls.length === 4);
  model.calls[2].finish('### 第三个\n\n第三个回答。');
  model.calls[3].finish('### 第四个\n\n第四个回答。');
  await jobs.idle();
  assert.equal(model.maximum, 2);
  const completed = await store.nodes();
  assert.deepEqual(completed[0].annotations.map(item => item.childId), childIds);
  assert.equal(completed.find(item => item.id === childIds[0])?.title, '第一个稍后完成');
  assert.equal(completed.find(item => item.id === childIds[1])?.title, '第二个先完成');
  assert.ok(completed.slice(1).every(item => item.status === 'idle' && !!item.markdown));
});

test('关闭画布期间生成的卡片，在不同卡片尺寸下仍紧邻父卡且同列不重叠', { timeout: 5000 }, async () => {
  for (const unit of [220, 500]) {
    const root = node('root', null, { x: 60, y: 80, annotations: annotations(2) });
    const initial = workspace([root]);
    initial.graphs[0].layoutInitialized = true;
    initial.graphs[0].layoutUnit = unit;
    const store = new MemoryStore(initial);
    const jobs = new GraphJobs(store, () => settings, { run: async (req, _settings, options) => {
      options.onEvent({ id: req.id, type: 'done', text: '### 解释\n\n选区的解释。' });
    } });
    // 全程没有渲染器参与，重新打开工作区后直接使用持久化坐标。
    await jobs.generate(request());
    await jobs.idle();
    const children = (await store.open('workspace')).graphs[0].nodes.filter(item => item.parentId === root.id);
    assert.equal(children.length, 2);
    const horizontalGap = children[0].x - (root.x + unit);
    assert.ok(horizontalGap > 0 && horizontalGap < unit * .13, '连接间距应随卡宽变化，且不超过约一成牌宽');
    assert.equal(children[0].x, children[1].x, '同批子卡保持列对齐');
    assert.ok(children[1].y - children[0].y >= unit * 4 / 3, '竖向间距容纳完整的长宽 4:3 卡片');
    assert.ok(children[1].y - children[0].y < unit * (4 / 3 + .11), '普通卡之间只保留约一成牌宽的竖向空隙');
  }
});

test('停止一张卡不打断其它卡，停止后的迟到输出不会提交', { timeout: 5000 }, async t => {
  const { store, model, jobs } = arrange(t);
  await jobs.generate(request());
  await eventually(() => model.calls.length === 2);
  const children = (await store.nodes()).filter(item => item.kind === 'card');
  const first = model.calls.find(call => call.request.text.includes('批注问题 0'))!;
  const second = model.calls.find(call => call !== first)!;
  assert.ok(first);
  jobs.cancel(request(children[0].id));
  assert.equal(first.options.signal.aborted, true);
  assert.equal(second.options.signal.aborted, false);
  first.late('### 不应出现的迟到标题\n\n不应写入的迟到正文。');
  second.finish('### 正常完成\n\n另一个任务不受影响。');
  await jobs.idle();
  const result = await store.nodes();
  assert.equal(result.find(item => item.id === children[0].id)?.status, 'cancelled');
  assert.ok(!JSON.stringify(result).includes('不应写入的迟到正文'));
  assert.equal(result.find(item => item.id === children[1].id)?.title, '正常完成');
});

test('排队中的卡片可独立停止，释放并发槽后不会再发送这个请求', { timeout: 5000 }, async t => {
  const { store, model, jobs } = arrange(t, workspace([node('root', null, { images: [sourceImage], annotations: annotations(3) })]), 1);
  await jobs.generate(request());
  await eventually(() => model.calls.length === 1);
  const children = (await store.nodes()).filter(item => item.kind === 'card');
  jobs.cancel(request(children[1].id));
  await eventually(async () => (await store.nodes()).find(item => item.id === children[1].id)?.status === 'cancelled');
  model.calls[0].finish('### 第一张\n\n完成。');
  await eventually(() => model.calls.length === 2);
  assert.ok(model.calls[1].request.text.includes('批注问题 2'));
  model.calls[1].finish('### 第三张\n\n完成。');
  await jobs.idle();
  assert.equal(model.calls.length, 2);
  assert.equal((await store.nodes()).find(item => item.id === children[1].id)?.status, 'cancelled');
});

test('生成进度只记录真实开始和工具次数，排队等待不计时也不补搜索次数', { timeout: 5000 }, async t => {
  const store = new MemoryStore(), model = modelHarness(false);
  const jobs = new GraphJobs(store, () => settings, { run: model.run, concurrency: 1, streamInterval: 1 });
  t.after(async () => { jobs.cancelAll(); model.calls.forEach(call => call.fail('测试清理')); await jobs.idle(); });
  await jobs.generate(request());
  await eventually(() => model.calls.length === 1);
  const [first, queued] = (await store.nodes()).slice(1);
  assert.ok(first.generation?.id);
  assert.equal(queued.status, 'queued');
  for (const item of [first, queued]) {
    assert.equal(item.generation?.startedAt, undefined);
    assert.equal(item.generation?.finishedAt, undefined);
    assert.deepEqual(item.generation?.toolCounts ?? {}, {});
  }
  const readFirst = async () => (await store.nodes()).find(item => item.id === first.id)!;
  model.calls[0].start();
  await eventually(async () => !!(await readFirst()).generation?.startedAt);
  const startedAt = (await readFirst()).generation!.startedAt!;
  assert.ok(startedAt > 0 && startedAt <= Date.now());
  model.calls[0].progress();
  model.calls[0].delta('### 第一张\n\n开始解释');
  await eventually(async () => !!(await readFirst()).draft);
  assert.deepEqual((await readFirst()).generation?.toolCounts ?? {}, {});
  model.calls[0].progress({ 搜索: 2, 未使用: 0, 无效: -1 });
  await eventually(async () => (await readFirst()).generation?.toolCounts?.搜索 === 2);
  assert.deepEqual((await readFirst()).generation?.toolCounts, { 搜索: 2 });
  assert.equal((await readFirst()).generation?.startedAt, startedAt);
  model.calls[0].finish('### 第一张\n\n开始解释并完成。');
  await eventually(() => model.calls.length === 2);
  const finished = await readFirst();
  assert.equal(finished.generation?.id, first.generation.id);
  assert.equal(finished.generation?.startedAt, startedAt);
  assert.ok(finished.generation!.finishedAt! >= startedAt);
  assert.deepEqual(finished.generation?.toolCounts, { 搜索: 2 });
  const next = (await store.nodes()).find(item => item.id === queued.id)!;
  assert.ok(next.generation?.id); assert.notEqual(next.generation.id, first.generation.id);
  assert.equal(next.generation.startedAt, undefined);
  model.calls[1].start(); model.calls[1].finish('### 第二张\n\n独立完成。');
  await jobs.idle();
});

test('停止后进度冻结且迟到指标无效，重试使用新一轮标识并清空旧统计', { timeout: 5000 }, async t => {
  const value = workspace([node('root', null), node('answer', 'root', { title: '旧标题', markdown: '保留的旧正文', source: {
    nodeId: 'root', selection: { kind: 'text', text: '原文' }, comment: '解释', revision: 0,
  } })]);
  const store = new MemoryStore(value), model = modelHarness(false);
  const jobs = new GraphJobs(store, () => settings, { run: model.run, streamInterval: 1 });
  t.after(async () => { jobs.cancelAll(); model.calls.forEach(call => call.fail('测试清理')); await jobs.idle(); });
  const answer = async () => (await store.nodes()).find(item => item.id === 'answer')!;
  await jobs.regenerate(request('answer'));
  await eventually(() => model.calls.length === 1);
  model.calls[0].start(); model.calls[0].progress({ 搜索: 3 }); model.calls[0].delta('### 草稿标题\n\n尚未完成');
  await eventually(async () => (await answer()).generation?.toolCounts?.搜索 === 3);
  assert.equal((await answer()).markdown, '保留的旧正文');
  jobs.cancel(request('answer')); await jobs.idle();
  const stopped = await answer(), frozen = structuredClone(stopped.generation!);
  assert.equal(stopped.status, 'cancelled');
  assert.ok(frozen.finishedAt! >= frozen.startedAt!);
  model.calls[0].start(); model.calls[0].progress({ 搜索: 99 }); model.calls[0].late('### 迟到结果\n\n不应覆盖。');
  await jobs.idle();
  assert.deepEqual((await answer()).generation, frozen);
  assert.equal((await answer()).markdown, '保留的旧正文');
  await jobs.regenerate(request('answer'));
  await eventually(() => model.calls.length === 2);
  const retry = (await answer()).generation!;
  assert.notEqual(retry.id, frozen.id);
  assert.equal(retry.startedAt, undefined); assert.equal(retry.finishedAt, undefined);
  assert.deepEqual(retry.toolCounts ?? {}, {});
  model.calls[0].progress({ 搜索: 100 });
  model.calls[1].start(); model.calls[1].progress({ 搜索: 1 }); model.calls[1].finish('### 重试结果\n\n新的完整正文。');
  await jobs.idle();
  const completed = await answer();
  assert.equal(completed.generation?.id, retry.id);
  assert.deepEqual(completed.generation?.toolCounts, { 搜索: 1 });
  assert.ok(completed.generation!.finishedAt! >= completed.generation!.startedAt!);
  assert.equal(completed.markdown, '新的完整正文。');
});

test('排队期间手动修改正文也保留为主稿，随后生成结果进入候选稿', { timeout: 5000 }, async t => {
  const source = { nodeId: 'root', selection: { kind: 'text' as const, text: '选中内容' }, comment: '解释', revision: 0 };
  const { store, model, jobs } = arrange(t, workspace([
    node('root', null), node('blocker', 'root', { source }),
    node('answer', 'root', { title: '旧标题', markdown: '排队前的正文', contentRevision: 7, source }),
  ]), 1);
  await jobs.regenerate(request('blocker'));
  await eventually(() => model.calls.length === 1);
  await jobs.regenerate(request('answer'));
  const queued = (await store.nodes()).find(item => item.id === 'answer')!;
  assert.equal(queued.status, 'queued'); assert.equal(queued.generation?.contentRevision, 7);
  const edited = await store.update('workspace', draft => {
    const item = draft.graphs[0].nodes.find(item => item.id === 'answer')!;
    item.title = '排队时手写标题'; item.markdown = '排队时手写的新正文';
  });
  jobs.reconcile(edited);
  model.calls[0].finish('### 占位任务\n\n完成后释放队列。');
  await eventually(() => model.calls.length === 2);
  model.calls[1].finish('### 生成的新标题\n\n模型生成的新正文。');
  await jobs.idle();
  const result = (await store.nodes()).find(item => item.id === 'answer')!;
  assert.equal(result.title, '排队时手写标题'); assert.equal(result.markdown, '排队时手写的新正文');
  assert.equal(result.contentRevision, 8); assert.equal(result.generation?.contentRevision, 7);
  assert.deepEqual(result.candidate, { title: '生成的新标题', markdown: '模型生成的新正文。' });
});

test('重新生成期间保留旧稿，手动修改后的结果进入候选稿', { timeout: 5000 }, async t => {
  const value = workspace([
    node('root', null, { images: [sourceImage] }),
    node('answer', 'root', { title: '旧标题', markdown: '旧正文', pinned: true, source: {
      nodeId: 'root', selection: { kind: 'text', text: '原来的选区' }, comment: '解释这里', revision: 0,
    } }),
  ]);
  const { store, model, jobs } = arrange(t, value);
  await jobs.regenerate(request('answer'));
  await eventually(() => model.calls.length === 1);
  model.calls[0].delta('### 新标题\n\n完整');
  assert.equal((await store.nodes()).find(item => item.id === 'answer')?.markdown, '旧正文');
  await store.update('workspace', draft => {
    const item = draft.graphs[0].nodes.find(item => item.id === 'answer')!;
    item.title = '我的标题'; item.markdown = '手动修订后的正文';
  });
  jobs.reconcile(await store.open('workspace'));
  assert.equal(model.calls[0].options.signal.aborted, false);
  model.calls[0].finish('### 新标题\n\n完整新正文。');
  await jobs.idle();
  const result = (await store.nodes()).find(item => item.id === 'answer')!;
  assert.equal(result.title, '我的标题');
  assert.equal(result.markdown, '手动修订后的正文');
  assert.equal(result.pinned, true);
  assert.deepEqual(result.candidate, { title: '新标题', markdown: '完整新正文。' });
});

test('生成中删除节点后，迟到完成不会把节点重新创建', { timeout: 5000 }, async t => {
  const { store, model, jobs } = arrange(t, workspace([node('root', null, { images: [sourceImage], annotations: annotations(1) })]));
  await jobs.generate(request());
  await eventually(() => model.calls.length === 1);
  const childId = (await store.nodes()).find(item => item.kind === 'card')!.id;
  await store.update('workspace', draft => { draft.graphs[0].nodes = draft.graphs[0].nodes.filter(item => item.id !== childId); });
  model.calls[0].finish('### 迟到结果\n\n不能复活。');
  await jobs.idle();
  assert.ok(!(await store.nodes()).some(item => item.id === childId));
});

test('删除后以同一 ID 撤销恢复的卡片不会接收旧任务结果', { timeout: 5000 }, async t => {
  const value = workspace([
    node('root', null, { images: [sourceImage] }),
    node('answer', 'root', { title: '原标题', markdown: '原正文', source: {
      nodeId: 'root', selection: { kind: 'text', text: '原选区' }, comment: '解释', revision: 0,
    } }),
  ]);
  const { store, model, jobs } = arrange(t, value);
  await jobs.regenerate(request('answer'));
  await eventually(() => model.calls.length === 1);
  const snapshot = (await store.nodes()).find(item => item.id === 'answer')!;
  await store.update('workspace', draft => { draft.graphs[0].nodes = draft.graphs[0].nodes.filter(item => item.id !== 'answer'); });
  await store.update('workspace', draft => {
    draft.graphs[0].nodes.push({ ...snapshot, status: 'cancelled', title: '撤销恢复的标题', markdown: '撤销恢复的正文' });
  });
  // 模拟外部编辑与撤销，故意不调用任务管理器的 cancel。
  model.calls[0].finish('### 过期模型标题\n\n过期模型正文。');
  await jobs.idle();
  const restored = (await store.nodes()).find(item => item.id === 'answer')!;
  assert.equal(restored.title, '撤销恢复的标题');
  assert.equal(restored.markdown, '撤销恢复的正文');
  assert.equal(restored.status, 'cancelled');
  assert.equal(restored.candidate, undefined);
  assert.equal(model.calls[0].options.signal.aborted, true);
});

test('重新关联后使用新的祖先路径，同时保留原选区作为讲解目标', { timeout: 5000 }, async t => {
  const value = workspace([
    node('root', null, { images: [sourceImage], markdown: '根的参考上下文' }),
    node('old-parent', 'root', { markdown: '旧父全文不应发送' }),
    node('new-parent', 'root', { markdown: '新父完整参考内容' }),
    node('answer', 'new-parent', { markdown: '保留的原回答', source: {
      nodeId: 'old-parent', selection: { kind: 'text', text: '原始选区快照' }, comment: '只解释这一句', revision: 0,
    } }),
  ]);
  const { model, jobs } = arrange(t, value);
  await jobs.regenerate(request('answer'));
  await eventually(() => model.calls.length === 1);
  const sent = JSON.stringify({ request: model.calls[0].request, context: model.calls[0].options.context });
  for (const expected of ['根的参考上下文', '新父完整参考内容', '原始选区快照', '只解释这一句']) assert.ok(sent.includes(expected));
  assert.ok(!sent.includes('旧父全文不应发送'));
  model.calls[0].finish('### 新路径下的说明\n\n说明原来的选区。');
  await jobs.idle();
});

test('图片批注的选区裁图与补充截图分别发送，并保留完整原图作为参考', { timeout: 5000 }, async t => {
  const rect = { x: .2, y: .1, width: .4, height: .3 };
  const supplement = { id: 'supplement-image', title: '补充符号定义', imageDataUrl: 'data:image/jpeg;base64,c3VwcGxlbWVudA==' };
  const value = workspace([node('root', null, { images: [sourceImage], annotations: [{
    id: 'image-note', selection: { kind: 'image', imageId: sourceImage.id, rect }, comment: '只解释框里的符号',
    images: [supplement],
  }] })]);
  const store = new MemoryStore(value), model = modelHarness(), crops: unknown[] = [];
  const jobs = new GraphJobs(store, () => settings, { run: model.run, crop: async (image, selection) => {
    crops.push({ image: image.id, rect: selection });
    return { id: 'selected-image', title: '所选区域', imageDataUrl: 'data:image/png;base64,Y3JvcC1tYXJrZXI=' };
  } });
  t.after(async () => { jobs.cancelAll(); model.calls.forEach(call => call.fail('测试清理')); await jobs.idle(); });
  await jobs.generate(request());
  await eventually(() => model.calls.length === 1);
  assert.deepEqual(crops, [{ image: 'image-root', rect }]);
  const attachments = model.calls[0].request.attachments!;
  assert.equal(attachments.length, 2);
  assert.equal(attachments[0].id, 'selected-image');
  assert.equal(attachments[1].id, supplement.id);
  assert.equal(attachments[1].dataUrl, supplement.imageDataUrl);
  assert.equal(attachments[1].mimeType, 'image/jpeg');
  assert.notEqual(attachments[0].name, attachments[1].name);
  const child = (await store.nodes())[1];
  assert.deepEqual(child.source?.images, [supplement]);
  assert.deepEqual(child.source?.selectionImage, sourceImage);
  const sent = JSON.stringify({ request: model.calls[0].request, context: model.calls[0].options.context });
  assert.ok(sent.includes('Y3JvcC1tYXJrZXI='));
  assert.ok(sent.includes(sourceImage.imageDataUrl));
  assert.ok(sent.includes('只解释框里的符号'));
  model.calls[0].finish('### 符号含义\n\n仅解释矩形内的内容。');
  await jobs.idle();
});

test('来源图删除后使用选区图片快照，优先于工作区同 ID 的图片', { timeout: 5000 }, async t => {
  const rect = { x: .1, y: .2, width: .3, height: .4 };
  const snapshot = { ...sourceImage, imageDataUrl: 'data:image/png;base64,c25hcHNob3Q=' };
  const value = workspace([node('root', null, { kind: 'card', source: {
    selection: { kind: 'image', imageId: sourceImage.id, rect }, selectionImage: snapshot,
    comment: '解释保存下来的区域', revision: 0,
  } })]);
  value.graphs.push({ ...structuredClone(value.graphs[0]), id: 'other-graph', rootId: 'other-root',
    nodes: [node('other-root', null, { images: [sourceImage] })] });
  const store = new MemoryStore(value), model = modelHarness(), crops: CaptureImage[] = [];
  const jobs = new GraphJobs(store, () => settings, { run: model.run, crop: async image => {
    crops.push(image);
    return { id: 'snapshot-crop', title: '快照选区', imageDataUrl: 'data:image/png;base64,c25hcHNob3QtY3JvcA==' };
  } });
  t.after(async () => { jobs.cancelAll(); model.calls.forEach(call => call.fail('测试清理')); await jobs.idle(); });
  await jobs.regenerate(request());
  await eventually(() => model.calls.length === 1);
  assert.deepEqual(crops, [snapshot]);
  assert.deepEqual(model.calls[0].options.context?.images, [snapshot]);
  assert.equal(model.calls[0].request.attachments?.[0].id, 'snapshot-crop');
  model.calls[0].finish('### 快照区域\n\n基于保留的选区说明。');
  await jobs.idle();
  assert.equal((await store.nodes())[0].markdown, '基于保留的选区说明。');
});

test('没有选区快照时能从工作区其它图找到原图', { timeout: 5000 }, async t => {
  const rect = { x: .1, y: .2, width: .3, height: .4 };
  const value = workspace([node('root', null, { kind: 'card', source: {
    selection: { kind: 'image', imageId: sourceImage.id, rect }, comment: '说明跨图选区', revision: 0,
  } })]);
  value.graphs.push({ ...structuredClone(value.graphs[0]), id: 'other-graph', rootId: 'other-root',
    nodes: [node('other-root', null, { images: [sourceImage] })] });
  const store = new MemoryStore(value), model = modelHarness(), crops: CaptureImage[] = [];
  const jobs = new GraphJobs(store, () => settings, { run: model.run, crop: async image => {
    crops.push(image); return { ...image, id: 'cross-graph-crop' };
  } });
  t.after(async () => { jobs.cancelAll(); model.calls.forEach(call => call.fail('测试清理')); await jobs.idle(); });
  await jobs.regenerate(request());
  await eventually(() => model.calls.length === 1);
  assert.deepEqual(crops, [sourceImage]);
  assert.equal(model.calls[0].request.attachments?.[0].id, 'cross-graph-crop');
  assert.ok(!model.calls[0].request.text.includes('other-root 的正文'));
  model.calls[0].finish('### 跨图区域\n\n原选区仍可讲解。');
  await jobs.idle();
});

for (const nodeId of ['root', 'custom']) test(`${nodeId === 'root' ? '根资料' : '自定义资料卡'}拒绝重新生成，保留正文、图片及批注`, { timeout: 5000 }, async t => {
  const original = node(nodeId, nodeId === 'root' ? null : 'root', {
    kind: 'source', markdown: '用户写入的原始正文', images: [sourceImage], annotations: annotations(1),
    source: { nodeId: 'root', selection: { kind: 'text', text: '旧的来源选区' }, comment: '已有来源也不能覆盖资料', revision: 0 },
  });
  const { store, model, jobs } = arrange(t, workspace(nodeId === 'root' ? [original] : [node('root', null), original]));
  const before = await store.open('workspace');
  await assert.rejects(jobs.regenerate(request(nodeId)), /原始资料不能重新生成/);
  await jobs.idle();
  jobs.cancelAll();
  await jobs.idle();
  assert.equal(model.calls.length, 0);
  assert.deepEqual(await store.open('workspace'), before);
});

test('自定义资料卡的批注生成子卡，参考完整祖先资料并保留用户原文', { timeout: 5000 }, async t => {
  const custom = node('custom', 'root', { kind: 'source', markdown: '用户补充的自定义原文', images: [sourceImage], annotations: annotations(1) });
  const { store, model, jobs } = arrange(t, workspace([node('root', null, { markdown: '根资料的完整内容' }), custom]));
  await jobs.generate(request('custom'));
  await eventually(() => model.calls.length === 1);
  const call = model.calls[0];
  for (const text of ['根资料的完整内容', '用户补充的自定义原文', '选区内容 0', '批注问题 0']) assert.ok(call.request.text.includes(text));
  assert.deepEqual(call.options.context?.images, [sourceImage]);
  call.finish('### 自定义资料说明\n\n只解释用户批注所选的内容。');
  await jobs.idle();
  const nodes = await store.nodes(), original = nodes.find(item => item.id === 'custom')!, child = nodes.find(item => item.parentId === 'custom')!;
  assert.equal(original.kind, 'source');
  assert.equal(original.markdown, custom.markdown);
  assert.deepEqual(original.images, custom.images);
  assert.equal(original.annotations[0].childId, child.id);
  assert.equal(child.kind, 'card');
  assert.equal(child.status, 'idle');
  assert.equal(child.source?.nodeId, custom.id);
  assert.equal(child.markdown, '只解释用户批注所选的内容。');
});

test('没有来源批注的生成卡提升为根后仍能以自身正文重新生成', { timeout: 5000 }, async t => {
  const { store, model, jobs } = arrange(t, workspace([node('root', null, { kind: 'card', markdown: '用户写入的原始正文' })]));
  await jobs.regenerate(request());
  await eventually(() => model.calls.length === 1);
  assert.ok(model.calls[0].request.text.includes('用户写入的原始正文'));
  assert.deepEqual(model.calls[0].options.context?.images, []);
  assert.equal((await store.nodes())[0].markdown, '用户写入的原始正文');
  model.calls[0].finish('### 根卡说明\n\n对原始正文的说明。');
  await jobs.idle();
  const root = (await store.nodes())[0];
  assert.equal(root.title, '根卡说明');
  assert.equal(root.markdown, '对原始正文的说明。');
  assert.equal(root.status, 'idle');
});

test('一张卡片失败时保留旧稿，另一张卡片仍可完成', { timeout: 5000 }, async t => {
  const source = { nodeId: 'root', selection: { kind: 'text' as const, text: '原句' }, comment: '解释', revision: 0 };
  const value = workspace([node('root', null, { images: [sourceImage] }), node('a', 'root', { markdown: '旧稿 A', source }), node('b', 'root', { markdown: '旧稿 B', source })]);
  const { store, model, jobs } = arrange(t, value);
  await jobs.regenerate(request('a'));
  await jobs.regenerate(request('b'));
  await eventually(() => model.calls.length === 2);
  model.calls[0].fail('模拟接口失败');
  model.calls[1].finish('### 新稿 B\n\n新的 B 正文。');
  await jobs.idle();
  const result = await store.nodes();
  assert.equal(result.find(item => item.id === 'a')?.markdown, '旧稿 A');
  assert.equal(result.find(item => item.id === 'a')?.status, 'error');
  assert.match(result.find(item => item.id === 'a')?.error ?? '', /模拟接口失败/);
  assert.equal(result.find(item => item.id === 'b')?.markdown, '新的 B 正文。');
});

test('没有批注时不会自动分析截图或生成子卡', { timeout: 5000 }, async t => {
  const { store, model, jobs } = arrange(t, workspace([node('root', null, { images: [sourceImage], markdown: '' })]));
  await jobs.generate(request());
  await assert.rejects(jobs.regenerate(request()), /原始资料不能重新生成/);
  await jobs.idle();
  assert.equal(model.calls.length, 0);
  const result = await store.nodes();
  assert.equal(result.length, 1);
  assert.equal(result[0].annotations.length, 0);
  assert.equal(result[0].status, 'idle');
  assert.deepEqual(result[0].images, [sourceImage]);
});

test('只生成指定批注，未提交的其它批注保持等待', { timeout: 5000 }, async t => {
  const { store, model, jobs } = arrange(t, workspace([node('root', null, { images: [sourceImage], annotations: annotations(3) })]));
  await jobs.generate({ ...request(), annotationIds: ['annotation-1'] });
  await eventually(() => model.calls.length === 1);
  assert.ok(model.calls[0].request.text.includes('批注问题 1'));
  assert.ok(!model.calls[0].request.text.includes('批注问题 0'));
  assert.ok(!model.calls[0].request.text.includes('批注问题 2'));
  model.calls[0].finish('### 指定批注\n\n只解释已提交的选区。');
  await jobs.idle();
  const result = await store.nodes();
  assert.equal(model.calls.length, 1);
  assert.equal(result.length, 2);
  assert.equal(result[0].annotations[0].childId, undefined);
  assert.equal(result[0].annotations[1].childId, result[1].id);
  assert.equal(result[0].annotations[2].childId, undefined);
});

test('旧空批注生成被拒绝且不留下子卡，补充附图后可生成', { timeout: 5000 }, async t => {
  const { store, model, jobs } = arrange(t, workspace([node('root', null, { annotations: [{
    id: 'empty-note', comment: ' \n\t\u3000', selection: { kind: 'text', text: '仅有选区' },
  }] })]));
  await assert.rejects(jobs.generate(request()), /请填写批注或附加截图/);
  await jobs.idle();
  assert.equal(model.calls.length, 0);
  const rejected = await store.nodes();
  assert.equal(rejected.length, 1); assert.equal(rejected[0].annotations[0].childId, undefined);
  await store.update('workspace', draft => { draft.graphs[0].nodes[0].annotations[0].images = [sourceImage]; });
  await jobs.generate(request());
  await eventually(() => model.calls.length === 1);
  model.calls[0].finish('### 附图批注\n\n结合附图解释选区。');
  await jobs.idle();
  assert.equal((await store.nodes()).length, 2);
});

test('越界图片批注被拒绝，修改选区后可正常提交', { timeout: 5000 }, async t => {
  const { store, model, jobs } = arrange(t, workspace([node('root', null, { images: [sourceImage], annotations: [{
    id: 'invalid-note', comment: '解释选区',
    selection: { kind: 'image', imageId: 'image-root', rect: { x: .9, y: .2, width: .4, height: .2 } },
  }] })]));
  await assert.rejects(jobs.generate(request()));
  await jobs.idle();
  const rejected = await store.nodes();
  assert.equal(rejected.length, 1);
  assert.equal(model.calls.length, 0);
  assert.equal(rejected[0].annotations[0].childId, undefined);
  assert.deepEqual(rejected[0].images, [sourceImage]);
  await store.update('workspace', draft => {
    draft.graphs[0].nodes[0].annotations[0].selection = { kind: 'text', text: '修正后的选区原文' };
  });
  await jobs.generate(request());
  await eventually(() => model.calls.length === 1);
  assert.ok(model.calls[0].request.text.includes('修正后的选区原文'));
  model.calls[0].finish('### 修正选区\n\n选区解释。');
  await jobs.idle();
  assert.equal((await store.nodes()).length, 2);
});

for (const scope of ['全部任务', '单张卡片']) test(`等待读取期间停止${scope}会取消重新生成，idle 等待准备阶段收尾`, { timeout: 5000 }, async t => {
  const store = new MemoryStore(workspace([node('root', null, { kind: 'card', markdown: '保留已写好的正文' })])), model = modelHarness();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const jobs = new GraphJobs({
    open: async id => { entered(); await gate; return store.open(id); },
    update: (id, change) => store.update(id, change),
  }, () => settings, { run: model.run });
  t.after(async () => { jobs.cancelAll(); release(); model.calls.forEach(call => call.fail('测试清理')); await jobs.idle(); });
  const preparing = jobs.regenerate(request());
  await reached;
  if (scope === '单张卡片') jobs.cancel(request()); else jobs.cancelAll();
  let settled = false;
  const idle = jobs.idle().then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  release();
  await Promise.all([preparing, idle]);
  assert.equal(model.calls.length, 0);
  assert.equal((await store.nodes())[0].status, 'cancelled');
  assert.equal((await store.nodes())[0].markdown, '保留已写好的正文');
});

test('批注事务等待期间关闭工作区不会发起模型请求，idle 等待占位清理', { timeout: 5000 }, async t => {
  const store = new MemoryStore(workspace([node('root', null, { images: [sourceImage], annotations: annotations(1) })])), model = modelHarness();
  let release!: () => void, entered!: () => void, firstUpdate = true;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const jobs = new GraphJobs({
    open: id => store.open(id),
    update: async (id, change) => {
      if (firstUpdate) { firstUpdate = false; entered(); await gate; }
      return store.update(id, change);
    },
  }, () => settings, { run: model.run });
  t.after(async () => { jobs.cancelAll(); release(); model.calls.forEach(call => call.fail('测试清理')); await jobs.idle(); });
  const preparing = jobs.generate(request());
  await reached;
  jobs.cancelWorkspace('workspace');
  let settled = false;
  const idle = jobs.idle().then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  release();
  await Promise.all([preparing, idle]);
  assert.equal(model.calls.length, 0);
  const children = (await store.nodes()).filter(item => item.kind === 'card');
  assert.equal(children.length, 1);
  assert.equal(children[0].status, 'cancelled');
});

test('祖先重新关联时立即停止后代任务，旧路径的迟到回答不提交', { timeout: 5000 }, async t => {
  const value = workspace([
    node('root', null, { images: [sourceImage] }),
    node('branch-a', 'root', { markdown: '原祖先分支' }),
    node('branch-b', 'root', { markdown: '新的祖先分支' }),
    node('middle', 'branch-a', { markdown: '直接父节点' }),
    node('answer', 'middle', { markdown: '保留原回答', source: {
      nodeId: 'middle', selection: { kind: 'text', text: '原选区' }, comment: '解释这里', revision: 0,
    } }),
  ]);
  const { store, model, jobs } = arrange(t, value);
  await jobs.regenerate(request('answer'));
  await eventually(() => model.calls.length === 1);
  const updated = await store.update('workspace', draft => {
    draft.graphs[0].nodes.find(item => item.id === 'branch-a')!.parentId = 'branch-b';
  });
  jobs.reconcile(updated);
  assert.equal(model.calls[0].options.signal.aborted, true);
  model.calls[0].late('### 旧路径的回答\n\n不能覆盖原回答。');
  await jobs.idle();
  const answer = (await store.nodes()).find(item => item.id === 'answer')!;
  assert.equal(answer.markdown, '保留原回答');
  assert.equal(answer.status, 'cancelled');
  assert.equal(answer.candidate, undefined);
});

test('修改批注会立即停止旧任务，重试采用新批注并保留原选区引用', { timeout: 5000 }, async t => {
  const value = workspace([
    node('root', null, { images: [sourceImage] }),
    node('answer', 'root', { markdown: '保留原回答', source: {
      nodeId: 'root', selection: { kind: 'text', text: '原始选区引用' }, comment: '旧批注内容', revision: 0,
    } }),
  ]);
  const { store, model, jobs } = arrange(t, value);
  await jobs.regenerate(request('answer'));
  await eventually(() => model.calls.length === 1);
  const updated = await store.update('workspace', draft => {
    draft.graphs[0].nodes.find(item => item.id === 'answer')!.source!.comment = '新的批注要求：解释必要条件';
  });
  jobs.reconcile(updated);
  assert.equal(model.calls[0].options.signal.aborted, true);
  model.calls[0].late('### 旧批注回复\n\n旧任务不应覆盖。');
  await jobs.idle();
  assert.equal((await store.nodes()).find(item => item.id === 'answer')?.markdown, '保留原回答');
  await jobs.regenerate(request('answer'));
  await eventually(() => model.calls.length === 2);
  const next = model.calls[1];
  assert.ok(next.request.text.includes('新的批注要求：解释必要条件'));
  assert.ok(next.request.text.includes('原始选区引用'));
  assert.ok(!next.request.text.includes('旧批注内容'));
  assert.deepEqual(next.options.context?.images.map(image => image.id), ['image-root']);
  next.finish('### 新批注解释\n\n按照新批注解释原选区。');
  await jobs.idle();
  const answer = (await store.nodes()).find(item => item.id === 'answer')!;
  assert.equal(answer.title, '新批注解释');
  assert.equal(answer.markdown, '按照新批注解释原选区。');
});

test('替换批注补充截图会停止旧任务，重试发送新截图并保留原选区', { timeout: 5000 }, async t => {
  const original = { id: 'original-supplement', title: '旧的补充截图', imageDataUrl: 'data:image/png;base64,b2xk' };
  const replacement = { id: 'new-supplement', title: '新的补充截图', imageDataUrl: 'data:image/png;base64,bmV3' };
  const value = workspace([
    node('root', null, { images: [sourceImage] }),
    node('answer', 'root', { markdown: '保留原回答', source: {
      nodeId: 'root', selection: { kind: 'text', text: '始终不变的原选区' }, comment: '参照补充截图说明', revision: 0,
      images: [original],
    } }),
  ]);
  const { store, model, jobs } = arrange(t, value);
  await jobs.regenerate(request('answer'));
  await eventually(() => model.calls.length === 1);
  assert.equal(model.calls[0].request.attachments?.[0].dataUrl, original.imageDataUrl);
  const updated = await store.update('workspace', draft => {
    draft.graphs[0].nodes.find(item => item.id === 'answer')!.source!.images = [replacement];
  });
  jobs.reconcile(updated);
  assert.equal(model.calls[0].options.signal.aborted, true);
  model.calls[0].late('### 旧截图解释\n\n迟到的解释不能覆盖。');
  await jobs.idle();
  assert.equal((await store.nodes()).find(item => item.id === 'answer')?.markdown, '保留原回答');
  await jobs.regenerate(request('answer'));
  await eventually(() => model.calls.length === 2);
  const next = model.calls[1];
  assert.ok(next.request.text.includes('始终不变的原选区'));
  assert.deepEqual(next.request.attachments?.map(item => item.dataUrl), [replacement.imageDataUrl]);
  next.finish('### 新截图解释\n\n参考新截图说明原选区。');
  await jobs.idle();
  const answer = (await store.nodes()).find(item => item.id === 'answer')!;
  assert.equal(answer.markdown, '参考新截图说明原选区。');
  assert.equal(answer.status, 'idle');
});
