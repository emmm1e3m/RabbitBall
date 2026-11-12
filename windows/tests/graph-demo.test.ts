import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import type { GraphCaptureRequest, GraphDesktop, GraphWorkspace } from '../electron/graph-contracts.ts';
import type { CaptureImage } from '../electron/contracts.ts';

type DemoDesktop = GraphDesktop & {
  graphCaptureContext(request: GraphCaptureRequest, context: { id: string; title: string; images: CaptureImage[]; demo: boolean }, background?: string): Promise<void>;
};

const source = readFileSync(new URL('../prototype/graph-demo.js', import.meta.url), 'utf8');
function fixture(storage = new Map<string, string>()) {
  let nextTimer = 0;
  const timers = new Map<number, () => void>(), opened: unknown[] = [];
  const window: { RabbitGraphDemo?: DemoDesktop; RabbitGraph: { open(value: unknown): void; getSnapshot?(): unknown }; RabbitCapture?: { captureImages(): Promise<CaptureImage[] | null> }; RabbitSettings?: { close(): void; getSnapshot(): unknown }; RabbitChat?: { close(): void } } = { RabbitGraph: { open(value) { opened.push(value); } } };
  vm.runInNewContext(source, { window, structuredClone, crypto: { randomUUID },
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
    setTimeout: (callback: () => void) => { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout: (id: number) => timers.delete(id)
  });
  const api = window.RabbitGraphDemo!;
  function drain() {
    for (let round = 0; timers.size && round < 500; round++) {
      const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(callback => callback());
    }
    assert.equal(timers.size, 0, '演示任务应当结束');
  }
  async function captured(): Promise<GraphWorkspace> {
    const w = await api.graphOpen(), blank = await api.graphMutate(w.id, { type: 'create-graph' });
    await api.graphCapture({ workspaceId: w.id, graphId: blank.lastGraphId! }); return api.graphOpen(w.id);
  }
  async function addCard(workspaceId: string, graphId: string, parentId: string, title: string) {
    const w = await api.graphMutate(workspaceId, { type: 'add-card', graphId, parentId, title, markdown: title + '的正文。' });
    return w.graphs.find(g => g.id === graphId)!.nodes.at(-1)!;
  }
  return { api, window, opened, storage, drain, captured, addCard };
}

test('桌面桥存在时不创建演示桥或读取浏览器数据', () => {
  const window = { rabbitDesktop: {}, RabbitGraphDemo: undefined };
  vm.runInNewContext(source, { window });
  assert.equal(window.RabbitGraphDemo, undefined);
});

test('设置入口先取消草稿，再按动作进入当前图，只有普通进入才填空图', async () => {
  const app = fixture(), calls: string[] = []; let draftEnabled = false;
  app.window.RabbitSettings = { close() { calls.push('close-settings'); draftEnabled = true; }, getSnapshot: () => ({ settings: { graphPluginEnabled: draftEnabled } }) };
  app.window.RabbitChat = { close() { calls.push('close-chat'); } };
  const originalOpen = app.window.RabbitGraph.open;
  app.window.RabbitGraph.open = activation => { calls.push('open-graph'); originalOpen(activation); };
  const workspace = await app.api.graphOpen();
  await app.api.graphMutate(workspace.id, { type: 'create-graph' });
  for (const action of ['rename-graph', 'undo', 'redo'] as const) {
    await app.api.graphActivate(action);
    assert.equal((app.opened.at(-1) as any).graphAction, action);
    assert.equal((await app.api.graphOpen()).graphs[0].nodes.length, 0);
  }
  assert.deepEqual(calls.slice(0, 3), ['close-settings', 'close-chat', 'open-graph']);
  await app.api.graphActivate();
  const filled = await app.api.graphOpen();
  assert.equal(filled.graphs.length, 1); assert.equal(filled.graphs[0].nodes.length, 1);
  const revision = filled.revision;
  await app.api.graphActivate();
  assert.equal((await app.api.graphOpen()).revision, revision, '恢复已有图不重新截图或添加卡片');
  const selected = await app.api.graphCreate('固定卡片所在工作区');
  app.window.RabbitGraph.getSnapshot = () => ({ workspaceId: workspace.id });
  await app.api.graphOpen(selected.id); await app.api.graphActivate('rename-graph');
  assert.equal((app.opened.at(-1) as any).workspaceId, selected.id, '关闭图谱后的固定卡片入口应采用刚选择的工作区');
  assert.equal('graphReadDocument' in app.api, false); assert.equal('graphWriteDocument' in app.api, false);
  await assert.rejects(Reflect.apply(app.api.graphActivate, app.api, ['document']), /图谱操作无效/);
  await assert.rejects(app.api.graphRevealDocument(workspace.id), /浏览器演示保存在此浏览器中/);
});

test('新建图谱保持空白，截图只填预留根节点且不会自动生成子卡', async () => {
  const app = fixture();
  const initial = await app.api.graphOpen();
  assert.equal(initial.graphs.length, 0);
  const blank = await app.api.graphMutate(initial.id, { type: 'create-graph', title: '学习笔记' }), empty = blank.graphs[0];
  assert.equal(empty.nodes.length, 0); assert.ok(empty.rootId);
  assert.equal(app.opened.length, 0, '新建空图不触发截图或开启');
  await app.api.graphCapture({ workspaceId: initial.id, graphId: empty.id });
  const w = await app.api.graphOpen(initial.id), g = w.graphs[0];
  assert.equal(w.graphs.length, 1); assert.equal(g.nodes.length, 1);
  assert.equal(g.nodes[0].id, empty.rootId); assert.equal(g.nodes[0].kind, 'source');
  assert.equal(g.nodes[0].images.length, 1); assert.equal(g.nodes[0].annotations.length, 0);
  assert.equal(g.layoutInitialized, false);
  assert.equal(app.opened.length, 1);
  await assert.rejects(app.api.graphCapture({ workspaceId: w.id, graphId: g.id }), /已有内容/);
  await assert.rejects(app.api.graphGenerate({ workspaceId: w.id, graphId: g.id, nodeId: g.rootId }), /先选择内容/);
  await assert.rejects(app.api.graphRegenerate({ workspaceId: w.id, graphId: g.id, nodeId: g.rootId }), /本源卡片不能重新生成/);
  app.drain();
  assert.equal((await app.api.graphOpen(w.id)).graphs[0].nodes.length, 1);
});

test('截图、空图与卡片Markdown编辑可保存并在浏览器重载恢复', async () => {
  const app = fixture(), w = await app.captured(), g = w.graphs[0];
  const card = await app.addCard(w.id, g.id, g.rootId, '加速度如何由力决定');
  await app.api.graphMutate(w.id, { type: 'create-graph', title: '尚未整理' });
  const markdown = '**核心含义**\n\n- 合力决定加速度。\n- 质量影响响应。';
  const edit = { type: 'edit' as const, graphId: g.id, nodeId: card.id, title: '改过的标题', markdown, contentRevision: card.contentRevision };
  const edited = await app.api.graphMutate(w.id, edit);
  assert.equal(edited.graphs[0].nodes.find(n => n.id === card.id)!.title, '改过的标题');
  assert.equal(edited.graphs[0].nodes.find(n => n.id === card.id)!.contentRevision, 1);
  assert.equal(edited.graphs[1].nodes.length, 0);
  const reloaded = await fixture(app.storage).api.graphOpen();
  assert.equal(reloaded.id, w.id); assert.equal(reloaded.graphs[1].nodes.length, 0);
  assert.equal(reloaded.graphs[0].nodes.find(n => n.id === card.id)!.markdown, markdown);
  assert.deepEqual(reloaded.graphs[0].nodes[0].images, g.nodes[0].images);
  await assert.rejects(app.api.graphMutate(w.id, edit), /卡片已经更新/);
});

test('演示选区截图按原图保存到指定空图，不替换为预设资料', async () => {
  const app = fixture(), w = await app.api.graphOpen();
  const blank = await app.api.graphMutate(w.id, { type: 'create-graph' }), g = blank.graphs[0];
  const images = [
    { id: 'one', title: '第一个选区', imageDataUrl: 'data:image/png;base64,AQ==' },
    { id: 'two', title: '第二个选区', imageDataUrl: 'data:image/png;base64,Ag==' },
  ];
  await app.api.graphCaptureContext({ workspaceId: w.id, graphId: g.id }, { id: 'selected', title: '选区资料', images, demo: true }, 'frozen-background');
  const captured = (await app.api.graphOpen(w.id)).graphs[0];
  assert.equal(captured.nodes.length, 1);
  assert.deepEqual(Array.from(captured.nodes[0].images, image => image.imageDataUrl), images.map(image => image.imageDataUrl));
  assert.equal((app.opened[0] as { backgroundImageDataUrl: string }).backgroundImageDataUrl, 'frozen-background');
  const persisted = (await fixture(app.storage).api.graphOpen(w.id)).graphs[0].nodes[0].images;
  assert.deepEqual(persisted.map(image => image.title), images.map(image => image.title));
  assert.deepEqual(persisted.map(image => image.imageDataUrl), images.map(image => image.imageDataUrl));
});

test('两条批注分别生成；停止一张不会停止另一张', async () => {
  const app = fixture(), w = await app.captured(), g = w.graphs[0], root = g.nodes[0];
  await app.api.graphMutate(w.id, { type: 'annotation', graphId: g.id, nodeId: root.id,
    annotation: { id: 'a', comment: '解释力', selection: { kind: 'text', text: 'F', start: 0, end: 1 } } });
  await app.api.graphMutate(w.id, { type: 'annotation', graphId: g.id, nodeId: root.id,
    annotation: { id: 'b', comment: '解释公式', selection: { kind: 'image', imageId: root.images[0].id, rect: { x: .2, y: .2, width: .4, height: .4 } } } });
  await app.api.graphGenerate({ workspaceId: w.id, graphId: g.id, nodeId: root.id });
  let current = (await app.api.graphOpen(w.id)).graphs[0];
  const [a, b] = current.nodes[0].annotations.map(note => note.childId!);
  const firstRun = current.nodes.find(n => n.id === a)!.generation!;
  assert.deepEqual(Object.keys(firstRun).sort(), ['contentRevision', 'id']);
  assert.equal(firstRun.contentRevision, current.nodes.find(n => n.id === a)!.contentRevision);
  assert.notEqual(firstRun.id, current.nodes.find(n => n.id === b)!.generation!.id);
  app.api.graphCancel({ workspaceId: w.id, graphId: g.id, nodeId: a });
  app.drain();
  current = (await app.api.graphOpen(w.id)).graphs[0];
  assert.equal(current.nodes.find(n => n.id === a)!.status, 'cancelled');
  assert.equal(current.nodes.find(n => n.id === a)!.generation!.id, firstRun.id);
  assert.equal(current.nodes.find(n => n.id === b)!.status, 'idle');
  assert.equal(current.nodes.find(n => n.id === b)!.title, '图片解读');
  assert.match(current.nodes.find(n => n.id === b)!.markdown, /未调用模型/);
  await assert.rejects(app.api.graphGenerate({ workspaceId: w.id, graphId: g.id, nodeId: root.id }), /先选择内容/);
  const body = current.nodes.find(n => n.id === b)!.markdown;
  await app.api.graphRegenerate({ workspaceId: w.id, graphId: g.id, nodeId: b });
  await app.api.graphMutate(w.id, { type: 'remove-annotation', graphId: g.id, nodeId: root.id, annotationId: 'b' }); app.drain();
  const stopped = (await app.api.graphOpen(w.id)).graphs[0].nodes.find(n => n.id === b)!;
  assert.equal(stopped.status, 'cancelled'); assert.equal(stopped.draft, undefined); assert.equal(stopped.markdown, body);
  assert.equal(stopped.source?.annotationId, undefined); assert.equal(stopped.source?.selectionImage?.imageDataUrl, root.images[0].imageDataUrl);
  await app.api.graphRegenerate({ workspaceId: w.id, graphId: g.id, nodeId: a });
  const retried = (await app.api.graphOpen(w.id)).graphs[0].nodes.find(n => n.id === a)!;
  assert.notEqual(retried.generation!.id, firstRun.id); assert.equal(retried.generation!.contentRevision, retried.contentRevision);
  assert.equal(retried.draft, ''); assert.equal(retried.generation!.toolCounts, undefined);
  app.drain();
  assert.equal((await app.api.graphOpen(w.id)).graphs[0].nodes.find(n => n.id === a)!.title, '选区含义');
});

test('生成途中手动编辑保留手稿，生成结果留作候选', async () => {
  const app = fixture(), w = await app.captured(), g = w.graphs[0];
  const n = await app.addCard(w.id, g.id, g.rootId, '原始标题');
  await app.api.graphRegenerate({ workspaceId: w.id, graphId: g.id, nodeId: n.id });
  const started = (await app.api.graphOpen(w.id)).graphs[0].nodes.find(item => item.id === n.id)!;
  assert.equal(started.generation!.contentRevision, n.contentRevision); assert.equal(started.markdown, n.markdown); assert.equal(started.draft, '');
  await app.api.graphMutate(w.id, { type: 'edit', graphId: g.id, nodeId: n.id, title: '我的标题', markdown: '我的手稿', contentRevision: n.contentRevision });
  app.drain();
  const updated = (await app.api.graphOpen(w.id)).graphs[0].nodes.find(item => item.id === n.id)!;
  assert.equal(updated.markdown, '我的手稿');
  assert.ok(updated.candidate?.markdown.includes('重新生成演示'));
});

test('子树可回根节点，禁止自连和循环，删除及撤销不复活旧任务', async () => {
  const app = fixture(), w = await app.captured(), g = w.graphs[0];
  const a = await app.addCard(w.id, g.id, g.rootId, '第一张'), b = await app.addCard(w.id, g.id, g.rootId, '第二张');
  await app.api.graphMutate(w.id, { type: 'reparent', graphId: g.id, nodeId: a.id, parentId: b.id });
  await assert.rejects(app.api.graphMutate(w.id, { type: 'reparent', graphId: g.id, nodeId: b.id, parentId: a.id }), /自己或自己的子节点/);
  await assert.rejects(app.api.graphMutate(w.id, { type: 'reparent', graphId: g.id, nodeId: a.id, parentId: a.id }), /自己或自己的子节点/);
  const returned = await app.api.graphMutate(w.id, { type: 'reparent', graphId: g.id, nodeId: a.id, parentId: g.rootId });
  assert.equal(returned.graphs[0].nodes.find(n => n.id === a.id)!.parentId, g.rootId);
  await app.api.graphMutate(w.id, { type: 'reparent', graphId: g.id, nodeId: a.id, parentId: b.id });
  await app.api.graphRegenerate({ workspaceId: w.id, graphId: g.id, nodeId: a.id });
  await app.api.graphMutate(w.id, { type: 'delete', graphId: g.id, nodeId: b.id });
  app.drain();
  assert.equal((await app.api.graphOpen(w.id)).graphs[0].nodes.length, 1);
  const restored = await app.api.graphMutate(w.id, { type: 'undo' });
  assert.equal(restored.graphs[0].nodes.length, 3);
  assert.equal(restored.graphs[0].nodes.find(n => n.id === a.id)!.status, 'cancelled');
});

test('批注图片与选区独立快照保存，保存修改后的批注会更新子卡片的重新生成来源', async () => {
  const app = fixture(), w = await app.captured(), g = w.graphs[0], root = g.nodes[0];
  const image = { id: 'attachment', title: '补充截图', imageDataUrl: 'data:image/png;base64,Aw==' };
  const selection = { kind: 'image' as const, imageId: root.images[0].id, rect: { x: .1, y: .2, width: .4, height: .3 } };
  await app.api.graphMutate(w.id, { type: 'annotation', graphId: g.id, nodeId: root.id,
    annotation: { id: 'with-image', comment: '结合这张图解释', selection, images: [image] } });
  await app.api.graphGenerate({ workspaceId: w.id, graphId: g.id, nodeId: root.id }); app.drain();
  const generated = (await app.api.graphOpen(w.id)).graphs[0].nodes.find(n => n.source?.annotationId === 'with-image')!;
  assert.equal(generated.source!.images?.[0].imageDataUrl, image.imageDataUrl);
  assert.equal(generated.source!.selectionImage?.imageDataUrl, root.images[0].imageDataUrl);
  assert.equal(generated.source!.nodeId, root.id);
  const imageDataUrl = image.imageDataUrl;
  image.imageDataUrl = 'data:image/png;base64,Bg=='; selection.rect.x = .4;
  const unchanged = (await app.api.graphOpen(w.id)).graphs[0].nodes.find(n => n.id === generated.id)!.source!;
  assert.equal(unchanged.images?.[0].imageDataUrl, imageDataUrl, '调用方直接修改对象不应改写已存快照');
  assert.equal(unchanged.selection.kind === 'image' && unchanged.selection.rect.x, .1);
  await app.api.graphMutate(w.id, { type: 'annotation', graphId: g.id, nodeId: root.id,
    annotation: { id: 'with-image', comment: '新的批注', selection, images: [] } });
  const current = (await app.api.graphOpen(w.id)).graphs[0];
  assert.equal(current.nodes[0].annotations[0].images?.length ?? 0, 0);
  const updated = current.nodes.find(n => n.id === generated.id)!.source!;
  assert.equal(updated.images?.length ?? 0, 0);
  assert.equal(updated.comment, '新的批注');
  assert.equal(updated.selection.kind === 'image' && updated.selection.rect.x, .4);
  assert.equal(updated.selectionImage?.imageDataUrl, root.images[0].imageDataUrl);
});

test('跨图移动保留整棵子树与资料快照，空图成为新根，非空图接原根，来源删除后快照仍可用', async () => {
  const app = fixture(), w = await app.captured(), from = w.graphs[0], root = from.nodes[0];
  const attachment = { id: 'reference', title: '参考图', imageDataUrl: 'data:image/png;base64,BA==' };
  await app.api.graphMutate(w.id, { type: 'annotation', graphId: from.id, nodeId: root.id,
    annotation: { id: 'move-note', comment: '解释选区', images: [attachment], selection: { kind: 'image', imageId: root.images[0].id, rect: { x: .2, y: .2, width: .3, height: .4 } } } });
  await app.api.graphGenerate({ workspaceId: w.id, graphId: from.id, nodeId: root.id }); app.drain();
  const child = (await app.api.graphOpen(w.id)).graphs[0].nodes.find(n => n.source?.annotationId === 'move-note')!;
  const descendant = await app.addCard(w.id, from.id, child.id, '子卡片');
  const blank = await app.api.graphMutate(w.id, { type: 'create-graph', title: '新主题' }), targetId = blank.lastGraphId!;
  await app.api.graphRegenerate({ workspaceId: w.id, graphId: from.id, nodeId: child.id });
  const moved = await app.api.graphMutate(w.id, { type: 'move-subtree', graphId: from.id, nodeId: child.id, targetGraphId: targetId });
  app.drain();
  const target = moved.graphs.find(g => g.id === targetId)!;
  assert.equal(target.rootId, child.id); assert.equal(target.nodes.find(n => n.id === child.id)!.parentId, null);
  assert.equal(target.nodes.find(n => n.id === descendant.id)!.parentId, child.id);
  assert.equal(target.nodes.length, 2);
  assert.equal(target.nodes.find(n => n.id === child.id)!.source!.nodeId, root.id);
  assert.equal(target.nodes.find(n => n.id === child.id)!.status, 'cancelled');
  assert.equal(moved.graphs.find(g => g.id === from.id)!.nodes.length, 1);

  const thirdBlank = await app.api.graphMutate(w.id, { type: 'create-graph', title: '已有资料' }), thirdId = thirdBlank.lastGraphId!;
  await app.api.graphCapture({ workspaceId: w.id, graphId: thirdId });
  const thirdRootId = (await app.api.graphOpen(w.id)).graphs.find(g => g.id === thirdId)!.rootId;
  const movedAgain = await app.api.graphMutate(w.id, { type: 'move-subtree', graphId: targetId, nodeId: child.id, targetGraphId: thirdId });
  const emptied = movedAgain.graphs.find(g => g.id === targetId)!;
  assert.equal(emptied.nodes.length, 0); assert.notEqual(emptied.rootId, child.id);
  assert.equal(movedAgain.graphs.find(g => g.id === thirdId)!.nodes.find(n => n.id === child.id)!.parentId, thirdRootId);
  await app.api.graphMutate(w.id, { type: 'delete', graphId: from.id, nodeId: root.id });
  const surviving = (await app.api.graphOpen(w.id)).graphs.find(g => g.id === thirdId)!.nodes.find(n => n.id === child.id)!;
  assert.equal(surviving.source!.nodeId, undefined); assert.equal(surviving.source!.annotationId, undefined);
  assert.equal(surviving.source!.images?.[0].imageDataUrl, attachment.imageDataUrl);
  assert.equal(surviving.source!.selectionImage?.imageDataUrl, root.images[0].imageDataUrl);
  const restored = await fixture(app.storage).api.graphOpen(w.id);
  assert.equal(restored.graphs.find(g => g.id === targetId)!.nodes.length, 0);
  assert.equal(restored.graphs.find(g => g.id === thirdId)!.nodes.find(n => n.id === child.id)!.source!.selectionImage?.imageDataUrl, root.images[0].imageDataUrl);
});

test('跨图拖动可接已有分支卡片，非法目标不改图且保留整棵子树', async () => {
  const app = fixture(), w = await app.captured(), source = w.graphs[0];
  const child = await app.addCard(w.id, source.id, source.rootId, '待移动卡片');
  const grandchild = await app.addCard(w.id, source.id, child.id, '子卡片');
  const created = await app.api.graphMutate(w.id, { type: 'create-graph' }), targetId = created.lastGraphId!;
  await app.api.graphCapture({ workspaceId: w.id, graphId: targetId });
  const target = (await app.api.graphOpen()).graphs.find(g => g.id === targetId)!;
  const leaf = await app.addCard(w.id, targetId, target.rootId, '已有分支的目标');
  await app.addCard(w.id, targetId, leaf.id, '已有子卡');
  await app.api.graphMutate(w.id, { type: 'layout', graphId: targetId, unit: 238, positions: [{ id: leaf.id, x: 300, y: 450 }] });
  const operation = { type: 'move-subtree' as const, graphId: source.id, nodeId: child.id, targetGraphId: targetId };
  const before = await app.api.graphOpen();
  await assert.rejects(app.api.graphMutate(w.id, { ...operation, targetNodeId: 'missing' }), /不存在/);
  assert.equal((await app.api.graphOpen()).revision, before.revision);
  const moved = await app.api.graphMutate(w.id, { ...operation, targetNodeId: leaf.id });
  const nodes = moved.graphs.find(g => g.id === targetId)!.nodes;
  assert.equal(nodes.find(n => n.id === child.id)!.parentId, leaf.id);
  assert.equal(nodes.find(n => n.id === child.id)!.x, 300 + target.layoutUnit * 1.12);
  assert.equal(nodes.find(n => n.id === child.id)!.y, 450);
  assert.equal(nodes.find(n => n.id === grandchild.id)!.parentId, child.id);
  assert.ok(Math.abs(nodes.find(n => n.id === grandchild.id)!.x - (300 + target.layoutUnit * 1.12 * 2)) < 1e-8);
  assert.equal(moved.graphs.find(g => g.id === source.id)!.nodes.length, 1);
});

test('批注截图只返回覆盖层选区或取消，不开启图谱或创建节点', async () => {
  const app = fixture(), w = await app.captured(), g = w.graphs[0], request = { workspaceId: w.id, graphId: g.id, nodeId: g.rootId };
  const image = { id: 'selection', title: '选区', imageDataUrl: 'data:image/png;base64,BQ==' };
  let calls = 0;
  app.window.RabbitCapture = { captureImages: async () => { calls++; return [image]; } };
  const before = await app.api.graphOpen(w.id), opened = app.opened.length;
  const images = await app.api.graphCaptureImages(request);
  assert.equal(images?.[0].imageDataUrl, image.imageDataUrl);
  assert.equal(calls, 1); assert.equal(app.opened.length, opened);
  assert.equal((await app.api.graphOpen(w.id)).revision, before.revision);
  app.window.RabbitCapture.captureImages = async () => null;
  assert.equal(await app.api.graphCaptureImages(request), null);
  await assert.rejects(app.api.graphCaptureImages({ ...request, nodeId: 'missing' }), /不存在/);
});

test('布局尺寸改变会换算未提交的位置，跨图移动按深度列并保留纵向比例', async () => {
  const app = fixture(), w = await app.captured(), g = w.graphs[0];
  assert.equal(g.layoutUnit, 238);
  const child = await app.addCard(w.id, g.id, g.rootId, '父卡片');
  const grandchild = await app.addCard(w.id, g.id, child.id, '子卡片');
  await app.api.graphMutate(w.id, { type: 'layout', graphId: g.id, unit: 238, positions: [
    { id: g.rootId, x: 20, y: 30 }, { id: child.id, x: 238, y: 119 }, { id: grandchild.id, x: 476, y: 238 },
  ] });
  const resized = await app.api.graphMutate(w.id, { type: 'layout', graphId: g.id, unit: 476, positions: [{ id: g.rootId, x: 25, y: 40 }] });
  const current = resized.graphs[0];
  const position = (id: string) => { const n = current.nodes.find(n => n.id === id)!; return [n.x, n.y]; };
  assert.equal(current.layoutUnit, 476); assert.equal(current.layoutInitialized, true);
  assert.deepEqual(position(g.rootId), [25, 40], '显式提交的新位置应覆盖换算结果');
  assert.deepEqual(position(child.id), [476, 238]); assert.deepEqual(position(grandchild.id), [952, 476]);
  for (const unit of [0, -1, Number.NaN]) {
    await assert.rejects(app.api.graphMutate(w.id, { type: 'layout', graphId: g.id, unit, positions: [] }), /尺寸无效/);
  }
  assert.equal((await app.api.graphOpen(w.id)).revision, resized.revision);

  const blank = await app.api.graphMutate(w.id, { type: 'create-graph' }), targetId = blank.lastGraphId!;
  await app.api.graphMutate(w.id, { type: 'layout', graphId: targetId, unit: 119, positions: [] });
  const moved = await app.api.graphMutate(w.id, { type: 'move-subtree', graphId: g.id, nodeId: child.id, targetGraphId: targetId });
  const target = moved.graphs.find(g => g.id === targetId)!;
  assert.equal(target.layoutUnit, 119);
  const movedChild = target.nodes.find(n => n.id === child.id)!, movedGrandchild = target.nodes.find(n => n.id === grandchild.id)!;
  assert.deepEqual([movedGrandchild.x - movedChild.x, movedGrandchild.y - movedChild.y], [119 * 1.12, 59.5]);
  assert.deepEqual(moved.graphs.find(graph => graph.id === g.id)!.nodes.map(n => [n.x, n.y]), [[25, 40]]);
  assert.equal((await fixture(app.storage).api.graphOpen()).graphs.find(g => g.id === targetId)!.layoutUnit, 119);
});

test('空批注不能保存或覆盖已有批注，仅附图的批注可以保存并生成', async () => {
  const app = fixture(), w = await app.captured(), g = w.graphs[0], n = g.nodes[0];
  const selection = { kind: 'text' as const, text: '选区不算批注内容' };
  for (const comment of ['', ' \n\t\u3000']) {
    await assert.rejects(app.api.graphMutate(w.id, { type: 'annotation', graphId: g.id, nodeId: n.id,
      annotation: { id: 'empty', comment, selection, images: [] } }), /请填写批注或附加截图/);
  }
  assert.equal((await app.api.graphOpen(w.id)).revision, w.revision);
  const saved = await app.api.graphMutate(w.id, { type: 'annotation', graphId: g.id, nodeId: n.id,
    annotation: { id: 'image-note', comment: '', selection, images: [n.images[0]] } });
  await assert.rejects(app.api.graphMutate(w.id, { type: 'annotation', graphId: g.id, nodeId: n.id,
    annotation: { id: 'image-note', comment: ' ', selection, images: [] } }), /请填写批注或附加截图/);
  const restored = await fixture(app.storage).api.graphOpen(w.id);
  assert.equal(restored.revision, saved.revision); assert.equal(restored.graphs[0].nodes[0].annotations.length, 1);
  assert.equal(restored.graphs[0].nodes[0].annotations[0].images?.length, 1);
  await app.api.graphGenerate({ workspaceId: w.id, graphId: g.id, nodeId: n.id }); app.drain();
  assert.equal((await app.api.graphOpen(w.id)).graphs[0].nodes.length, 2);
});

test('旧空批注仍可读取，但生成前必须补充文字或附图', async () => {
  const app = fixture(), w = await app.captured(), g = w.graphs[0];
  const stored = JSON.parse(app.storage.get('rabbitball.graph.demo.v1')!);
  stored.workspaces[0].graphs[0].nodes[0].annotations = [{ id: 'legacy-empty', comment: '  ', selection: { kind: 'text', text: '旧选区' } }];
  app.storage.set('rabbitball.graph.demo.v1', JSON.stringify(stored));
  const restored = fixture(app.storage);
  await assert.rejects(restored.api.graphGenerate({ workspaceId: w.id, graphId: g.id, nodeId: g.rootId }), /请填写批注或附加截图/);
  const current = await restored.api.graphOpen(w.id);
  assert.equal(current.graphs[0].nodes.length, 1); assert.equal(current.graphs[0].nodes[0].annotations[0].childId, undefined);
});

test('无效图片框选和不存在的图片来源不会改写已存图谱', async () => {
  const app = fixture(), w = await app.captured(), g = w.graphs[0], n = g.nodes[0];
  await assert.rejects(app.api.graphMutate(w.id, { type: 'annotation', graphId: g.id, nodeId: n.id,
    annotation: { id: 'bad', comment: '', selection: { kind: 'image', imageId: n.images[0].id, rect: { x: .9, y: 0, width: .3, height: .5 } } } }), /有效的文字或图片区域/);
  await assert.rejects(app.api.graphMutate(w.id, { type: 'annotation', graphId: g.id, nodeId: n.id,
    annotation: { id: 'missing-image', comment: '', selection: { kind: 'image', imageId: 'missing', rect: { x: 0, y: 0, width: .3, height: .5 } } } }), /有效的文字或图片区域/);
  const reloaded = await fixture(app.storage).api.graphOpen(w.id);
  assert.equal(reloaded.revision, w.revision); assert.equal(reloaded.graphs[0].nodes[0].annotations.length, 0);
  assert.deepEqual(reloaded.graphs[0].nodes[0].images, n.images);
});

test('重新关联可撤销重做，视角与布局不清重做，新的内容编辑清重做', async () => {
  const app = fixture(), w = await app.captured(), g = w.graphs[0];
  const a = await app.addCard(w.id, g.id, g.rootId, '待关联卡片');
  const b = await app.addCard(w.id, g.id, g.rootId, '已有分支');
  await app.addCard(w.id, g.id, b.id, '原有子卡');
  const moved = await app.api.graphMutate(w.id, { type: 'reparent', graphId: g.id, nodeId: a.id, parentId: b.id });
  const reverted = await app.api.graphMutate(w.id, { type: 'undo' });
  assert.equal(reverted.graphs[0].nodes.find(n => n.id === a.id)!.parentId, g.rootId);
  assert.ok(reverted.revision > moved.revision);
  const view = { x: 71, y: -32, zoom: .8 };
  await app.api.graphMutate(w.id, { type: 'view', graphId: g.id, view });
  await app.api.graphMutate(w.id, { type: 'layout', graphId: g.id, unit: 238, positions: [{ id: b.id, x: 420, y: 120 }] });
  await app.api.graphMutate(w.id, { type: 'visit', graphId: g.id });
  const redone = await app.api.graphMutate(w.id, { type: 'redo' });
  assert.equal(redone.graphs[0].nodes.find(n => n.id === a.id)!.parentId, b.id);
  assert.deepEqual(redone.graphs[0].view, view);
  assert.deepEqual([redone.graphs[0].nodes.find(n => n.id === b.id)!.x, redone.graphs[0].nodes.find(n => n.id === b.id)!.y], [420, 120]);
  const back = await app.api.graphMutate(w.id, { type: 'undo' }), current = back.graphs[0].nodes.find(n => n.id === a.id)!;
  const edited = await app.api.graphMutate(w.id, { type: 'edit', graphId: g.id, nodeId: a.id, title: '新的标题', markdown: current.markdown, contentRevision: current.contentRevision });
  await assert.rejects(app.api.graphMutate(w.id, { type: 'redo' }), /重做/);
  assert.equal((await app.api.graphOpen(w.id)).revision, edited.revision);
  assert.equal((await app.api.graphOpen(w.id)).graphs[0].nodes.find(n => n.id === a.id)!.title, '新的标题');
});

test('撤销固定只修改固定状态，保留随后完成的生成正文及版本', async () => {
  const app = fixture(), w = await app.captured(), g = w.graphs[0];
  const card = await app.addCard(w.id, g.id, g.rootId, '待生成卡片');
  await app.api.graphRegenerate({ workspaceId: w.id, graphId: g.id, nodeId: card.id });
  await app.api.graphMutate(w.id, { type: 'pin', graphId: g.id, nodeId: card.id, pinned: true });
  const firstUndo = await app.api.graphMutate(w.id, { type: 'undo' });
  assert.equal(firstUndo.graphs[0].nodes.find(n => n.id === card.id)!.pinned, false);
  app.drain();
  const complete = (await app.api.graphOpen(w.id)).graphs[0].nodes.find(n => n.id === card.id)!;
  assert.notEqual(complete.markdown, card.markdown); assert.equal(complete.status, 'idle');
  const redone = await app.api.graphMutate(w.id, { type: 'redo' }), pinned = redone.graphs[0].nodes.find(n => n.id === card.id)!;
  assert.equal(pinned.pinned, true); assert.equal(pinned.markdown, complete.markdown);
  assert.equal(pinned.status, 'idle'); assert.ok(pinned.contentRevision >= complete.contentRevision);
  const undone = await app.api.graphMutate(w.id, { type: 'undo' }), unpinned = undone.graphs[0].nodes.find(n => n.id === card.id)!;
  assert.equal(unpinned.pinned, false); assert.equal(unpinned.markdown, complete.markdown);
  assert.equal(unpinned.status, 'idle'); assert.ok(unpinned.contentRevision >= pinned.contentRevision);
  assert.ok(undone.revision > redone.revision && redone.revision > firstUndo.revision);
});

test('批量生成只记一次历史，撤销移除整批，重做恢复同ID且不复活任务', async () => {
  const app = fixture(), w = await app.captured(), g = w.graphs[0];
  for (const id of ['first', 'second']) await app.api.graphMutate(w.id, {
    type: 'annotation', graphId: g.id, nodeId: g.rootId,
    annotation: { id, comment: '解释' + id, selection: { kind: 'text', text: id } },
  });
  await app.api.graphGenerate({ workspaceId: w.id, graphId: g.id, nodeId: g.rootId });
  const generated = await app.api.graphOpen(w.id), children = generated.graphs[0].nodes.filter(n => n.id !== g.rootId);
  assert.equal(children.length, 2); assert.ok(children.every(n => n.status === 'generating'));
  const undone = await app.api.graphMutate(w.id, { type: 'undo' });
  assert.equal(undone.graphs[0].nodes.length, 1);
  assert.equal(undone.graphs[0].nodes[0].annotations.length, 2);
  assert.ok(undone.graphs[0].nodes[0].annotations.every(a => !a.childId));
  app.drain(); assert.equal((await app.api.graphOpen(w.id)).graphs[0].nodes.length, 1);
  const redone = await app.api.graphMutate(w.id, { type: 'redo' });
  const restored = redone.graphs[0].nodes.filter(n => n.id !== g.rootId);
  assert.deepEqual(restored.map(n => n.id).sort(), children.map(n => n.id).sort());
  assert.ok(restored.every(n => n.status === 'cancelled' && n.draft === undefined));
  assert.deepEqual(redone.graphs[0].nodes[0].annotations.map(a => a.childId).sort(), children.map(n => n.id).sort());
  app.drain();
  assert.equal((await app.api.graphOpen(w.id)).revision, redone.revision, '重做恢复的任务不会继续流式写入');
  assert.ok(redone.revision > undone.revision && undone.revision > generated.revision);
});

test('截图填根与卡片Markdown编辑可撤销重做，节点ID稳定且内容版本不倒退', async () => {
  const app = fixture(), w = await app.captured(), g = w.graphs[0], original = g.nodes[0];
  const empty = await app.api.graphMutate(w.id, { type: 'undo' });
  assert.equal(empty.graphs.length, 1); assert.equal(empty.graphs[0].nodes.length, 0);
  assert.equal(empty.graphs[0].rootId, g.rootId);
  const restored = await app.api.graphMutate(w.id, { type: 'redo' });
  assert.equal(restored.graphs[0].nodes[0].id, original.id);
  assert.equal(restored.graphs[0].nodes[0].images[0].imageDataUrl, original.images[0].imageDataUrl);
  assert.ok(restored.revision > empty.revision && empty.revision > w.revision);
  const card = await app.addCard(w.id, g.id, g.rootId, '原文标题');
  const markdown = '**编辑后的正文。**\n\n> 保留 Markdown。';
  const edited = await app.api.graphMutate(w.id, { type: 'edit', graphId: g.id, nodeId: card.id, title: '编辑标题', markdown, contentRevision: card.contentRevision });
  const modified = edited.graphs[0].nodes.find(n => n.id === card.id)!;
  const undone = await app.api.graphMutate(w.id, { type: 'undo' }), old = undone.graphs[0].nodes.find(n => n.id === card.id)!;
  assert.equal(old.title, card.title); assert.equal(old.markdown, card.markdown);
  assert.ok(old.contentRevision > modified.contentRevision);
  const redone = await app.api.graphMutate(w.id, { type: 'redo' }), current = redone.graphs[0].nodes.find(n => n.id === card.id)!;
  assert.equal(current.title, '编辑标题'); assert.equal(current.markdown, markdown);
  assert.ok(current.contentRevision > old.contentRevision);
  assert.ok(redone.revision > undone.revision && undone.revision > edited.revision);
  const reloaded = await fixture(app.storage).api.graphOpen(w.id);
  assert.equal(reloaded.graphs[0].nodes.find(n => n.id === card.id)!.markdown, markdown);
});

test('跨图移动与整图删除可连续撤销重做，子树和目标原有内容分别恢复', async () => {
  const app = fixture(), w = await app.captured(), from = w.graphs[0];
  const child = await app.addCard(w.id, from.id, from.rootId, '迁移父卡');
  const grandchild = await app.addCard(w.id, from.id, child.id, '迁移子卡');
  const created = await app.api.graphMutate(w.id, { type: 'create-graph', title: '目标图' }), targetId = created.lastGraphId!;
  await app.api.graphCapture({ workspaceId: w.id, graphId: targetId });
  const target = (await app.api.graphOpen(w.id)).graphs.find(g => g.id === targetId)!;
  const original = await app.addCard(w.id, targetId, target.rootId, '目标原有卡');
  await app.api.graphMutate(w.id, { type: 'move-subtree', graphId: from.id, nodeId: child.id, targetGraphId: targetId, targetNodeId: original.id });
  await app.api.graphMutate(w.id, { type: 'layout', graphId: targetId, unit: 300, positions: [{ id: child.id, x: 650, y: 500 }] });
  const deleted = await app.api.graphMutate(w.id, { type: 'delete', graphId: targetId, nodeId: target.rootId });
  assert.equal(deleted.graphs.some(g => g.id === targetId), false);
  const restoredGraph = await app.api.graphMutate(w.id, { type: 'undo' });
  const restoredTarget = restoredGraph.graphs.find(g => g.id === targetId)!;
  assert.equal(restoredTarget.nodes.length, 4);
  assert.equal(restoredTarget.nodes.find(n => n.id === child.id)!.parentId, original.id);
  assert.equal(restoredTarget.nodes.find(n => n.id === grandchild.id)!.parentId, child.id);
  assert.equal(restoredTarget.nodes.find(n => n.id === target.rootId)!.images[0].imageDataUrl, target.nodes[0].images[0].imageDataUrl);
  const restoredMove = await app.api.graphMutate(w.id, { type: 'undo' });
  const sourceNodes = restoredMove.graphs.find(g => g.id === from.id)!.nodes;
  assert.equal(sourceNodes.length, 3);
  assert.equal(sourceNodes.find(n => n.id === child.id)!.parentId, from.rootId);
  assert.equal(sourceNodes.find(n => n.id === grandchild.id)!.parentId, child.id);
  assert.deepEqual(restoredMove.graphs.find(g => g.id === targetId)!.nodes.map(n => n.id).sort(), [target.rootId, original.id].sort());
  const remadeMove = await app.api.graphMutate(w.id, { type: 'redo' });
  assert.equal(remadeMove.graphs.find(g => g.id === from.id)!.nodes.length, 1);
  assert.equal(remadeMove.graphs.find(g => g.id === targetId)!.nodes.find(n => n.id === child.id)!.parentId, original.id);
  const remadeDeletion = await app.api.graphMutate(w.id, { type: 'redo' });
  assert.equal(remadeDeletion.graphs.some(g => g.id === targetId), false);
  assert.ok(remadeDeletion.revision > remadeMove.revision && remadeMove.revision > restoredMove.revision && restoredMove.revision > restoredGraph.revision);
});

test('同一字段已被生成结果改写时拒绝旧撤销，保留新正文且不推进版本', async () => {
  const app = fixture(), w = await app.captured(), g = w.graphs[0];
  const card = await app.addCard(w.id, g.id, g.rootId, '解释');
  await app.api.graphMutate(w.id, { type: 'edit', graphId: g.id, nodeId: card.id, title: '编辑后的标题', markdown: '编辑后的正文', contentRevision: card.contentRevision });
  await app.api.graphRegenerate({ workspaceId: w.id, graphId: g.id, nodeId: card.id }); app.drain();
  const generated = await app.api.graphOpen(w.id), result = generated.graphs[0].nodes.find(n => n.id === card.id)!;
  await assert.rejects(app.api.graphMutate(w.id, { type: 'undo' }), /内容已更新/);
  const preserved = await app.api.graphOpen(w.id);
  assert.equal(preserved.revision, generated.revision);
  assert.equal(preserved.graphs[0].nodes.find(n => n.id === card.id)!.markdown, result.markdown);
});


test('演示根节点支持纯文本、多图和组合，创建前不自动保存截图，支持撤销和重载', async () => {
  const app = fixture(), initial = await app.api.graphOpen();
  const images = [{ id: 'one', title: '第一页', imageDataUrl: 'data:image/png;base64,AQ==' }, { id: 'two', title: '第二页', imageDataUrl: 'data:image/png;base64,Ag==' }];
  app.window.RabbitCapture = { captureImages: async () => images };
  for (const [markdown, attachments] of [['文字根', []], ['', images], ['混合根', images]] as const) {
    const empty = await app.api.graphMutate(initial.id, { type: 'create-graph' }), graph = empty.graphs.at(-1)!;
    const request = { workspaceId: initial.id, graphId: graph.id };
    assert.deepEqual(await app.api.graphCaptureImages(request), images);
    assert.equal((await app.api.graphOpen(initial.id)).graphs.at(-1)!.nodes.length, 0);
    const filled = await app.api.graphMutate(initial.id, { type: 'add-root', graphId: graph.id, markdown, images: structuredClone([...attachments]) });
    const root = filled.graphs.at(-1)!.nodes[0];
    assert.equal(root.id, graph.rootId); assert.equal(root.kind, 'source'); assert.equal(root.parentId, null);
    assert.equal(root.markdown, markdown); assert.equal(root.images.length, attachments.length);
    await assert.rejects(app.api.graphCaptureImages(request), /已有根节点/);
    await assert.rejects(app.api.graphMutate(initial.id, { type: 'add-root', graphId: graph.id, markdown: '覆盖', images: [] }), /已有根节点/);
    const undone = await app.api.graphMutate(initial.id, { type: 'undo' }); assert.equal(undone.graphs.at(-1)!.nodes.length, 0);
    const redone = await app.api.graphMutate(initial.id, { type: 'redo' }); assert.ok(redone.graphs.at(-1)!.nodes[0].contentRevision > root.contentRevision);
    assert.deepEqual(redone.graphs.at(-1)!.nodes[0], { ...root, contentRevision: redone.graphs.at(-1)!.nodes[0].contentRevision });
  }
  const restored = await fixture(app.storage).api.graphOpen(initial.id);
  assert.deepEqual(Array.from(restored.graphs, graph => [graph.nodes[0].markdown, graph.nodes[0].images.length]), [['文字根', 0], ['', 2], ['混合根', 2]]);
});

test('演示根节点拒绝空输入与坏图，截图取消保持空图', async () => {
  const app = fixture(), initial = await app.api.graphOpen(), empty = await app.api.graphMutate(initial.id, { type: 'create-graph' }), graph = empty.graphs[0];
  app.window.RabbitCapture = { captureImages: async () => null };
  assert.equal(await app.api.graphCaptureImages({ workspaceId: initial.id, graphId: graph.id }), null);
  await assert.rejects(app.api.graphMutate(initial.id, { type: 'add-root', graphId: graph.id, markdown: ' \n　 ', images: [] }), /请输入文字或添加截图/);
  await assert.rejects(app.api.graphMutate(initial.id, { type: 'add-root', graphId: graph.id, markdown: '', images: [{ id: 'bad', title: '坏图', imageDataUrl: 'bad' }] }), /截图格式无效/);
  assert.equal((await app.api.graphOpen(initial.id)).graphs[0].nodes.length, 0);
});


test('演示根追加截图保留原图、正文和批注，撤销重做及重载保持稳定标识', async () => {
  const app = fixture(), initial = await app.captured(), graph = initial.graphs[0], original = graph.nodes[0];
  await app.api.graphMutate(initial.id, { type: 'edit', graphId: graph.id, nodeId: original.id, title: original.title, markdown: '已经补充的文字。', contentRevision: original.contentRevision });
  const current = await app.api.graphMutate(initial.id, { type: 'annotation', graphId: graph.id, nodeId: original.id,
    annotation: { id: 'saved-note', selection: { kind: 'image', imageId: original.images[0].id, rect: { x: 0, y: 0, width: .5, height: .5 } }, comment: '保留批注' } });
  const before = current.graphs[0].nodes[0];
  const filled = await app.api.graphMutate(initial.id, { type: 'append-node-images', graphId: graph.id, nodeId: graph.rootId, images: [original.images[0], original.images[0]] });
  const root = filled.graphs[0].nodes[0];
  assert.equal(root.id, original.id); assert.equal(root.markdown, before.markdown); assert.deepEqual(root.annotations, before.annotations);
  assert.deepEqual(root.images[0], original.images[0]); assert.equal(root.images.length, 3);
  assert.equal(new Set(root.images.map(image => image.id)).size, 3);
  const undone = (await app.api.graphMutate(initial.id, { type: 'undo' })).graphs[0].nodes[0];
  assert.deepEqual(undone, { ...before, contentRevision: undone.contentRevision });
  const redone = (await app.api.graphMutate(initial.id, { type: 'redo' })).graphs[0].nodes[0];
  assert.deepEqual(redone, { ...root, contentRevision: redone.contentRevision });
  const restored = (await fixture(app.storage).api.graphOpen(initial.id)).graphs[0].nodes[0];
  assert.deepEqual(restored, redone);
});

test('演示根追加图片拒绝空图、空截图、坏图和累计超限', async () => {
  const app = fixture(), initial = await app.captured(), graph = initial.graphs[0], root = graph.nodes[0];
  await assert.rejects(app.api.graphMutate(initial.id, { type: 'append-node-images', graphId: graph.id, nodeId: graph.rootId, images: [] }), /请添加截图/);
  await assert.rejects(app.api.graphMutate(initial.id, { type: 'append-node-images', graphId: graph.id, nodeId: graph.rootId, images: [{ id: 'bad', title: '坏图', imageDataUrl: 'bad' }] }), /截图格式无效/);
  await assert.rejects(app.api.graphMutate(initial.id, { type: 'append-node-images', graphId: graph.id, nodeId: graph.rootId, images: Array.from({ length: 64 }, () => root.images[0]) }), /64 张/);
  assert.deepEqual((await app.api.graphOpen(initial.id)).graphs[0].nodes[0], root);
  const empty = await app.api.graphMutate(initial.id, { type: 'create-graph' });
  await assert.rejects(app.api.graphMutate(initial.id, { type: 'append-node-images', graphId: empty.lastGraphId!, nodeId: empty.graphs.find(g => g.id === empty.lastGraphId)!.rootId, images: root.images }), /卡片已不存在/);
  assert.equal((await app.api.graphOpen(initial.id)).graphs.at(-1)!.nodes.length, 0);
});

test('演示空白自定义卡片可撤销恢复、重载、编辑并用批注生成子节点', async () => {
  const app = fixture(), w = await app.captured(), g = w.graphs[0];
  const parent = await app.addCard(w.id, g.id, g.rootId, '现有卡片');
  const created = await app.api.graphMutate(w.id, { type: 'add-custom-node', graphId: g.id, parentId: parent.id, markdown: '', images: [] });
  const custom = created.graphs[0].nodes.at(-1)!;
  assert.equal(custom.kind, 'source'); assert.equal(custom.parentId, parent.id); assert.equal(custom.markdown, ''); assert.equal(custom.images.length, 0);
  assert.equal((await app.api.graphMutate(w.id, { type: 'undo' })).graphs[0].nodes.some(n => n.id === custom.id), false);
  await app.api.graphMutate(w.id, { type: 'redo' });
  const reloaded = fixture(app.storage), blank = (await reloaded.api.graphOpen(w.id)).graphs[0].nodes.find(n => n.id === custom.id)!;
  assert.equal(blank.kind, 'source'); assert.equal(blank.markdown, ''); assert.equal(blank.source, undefined);
  const appended = await reloaded.api.graphMutate(w.id, { type: 'append-node-images', graphId: g.id, nodeId: custom.id, images: [g.nodes[0].images[0], g.nodes[0].images[0]] });
  const updated = appended.graphs[0].nodes.find(n => n.id === custom.id)!;
  assert.equal(new Set(updated.images.map(i => i.id)).size, 2);
  await reloaded.api.graphMutate(w.id, { type: 'edit', graphId: g.id, nodeId: custom.id, title: '自选资料', markdown: '自己的文字', contentRevision: updated.contentRevision });
  await reloaded.api.graphMutate(w.id, { type: 'annotation', graphId: g.id, nodeId: custom.id, annotation: { id: 'custom-note', comment: '解释资料', selection: { kind: 'text', text: '自己的文字' } } });
  await assert.rejects(reloaded.api.graphRegenerate({ workspaceId: w.id, graphId: g.id, nodeId: custom.id }), /本源卡片不能重新生成/);
  await reloaded.api.graphGenerate({ workspaceId: w.id, graphId: g.id, nodeId: custom.id }); reloaded.drain();
  const result = (await reloaded.api.graphOpen(w.id)).graphs[0], source = result.nodes.find(n => n.id === custom.id)!;
  const child = result.nodes.find(n => n.id === source.annotations[0].childId)!;
  assert.equal(source.markdown, '自己的文字'); assert.equal(source.kind, 'source'); assert.equal(source.images.length, 2);
  assert.equal(child.parentId, custom.id); assert.equal(child.source!.nodeId, custom.id); assert.equal(child.status, 'idle');
  const target = await reloaded.api.graphMutate(w.id, { type: 'create-graph' });
  await reloaded.api.graphMutate(w.id, { type: 'move-subtree', graphId: g.id, nodeId: custom.id, targetGraphId: target.lastGraphId! });
  const moved = (await fixture(app.storage).api.graphOpen(w.id)).graphs.find(graph => graph.id === target.lastGraphId)!;
  assert.equal(moved.rootId, custom.id); assert.equal(moved.nodes[0].kind, 'source'); assert.equal(moved.nodes[0].markdown, '自己的文字');
  assert.equal(moved.nodes[1].source!.nodeId, custom.id);
});

test('演示自定义卡片支持初始图文并拒绝无效父节点和附件', async () => {
  const app = fixture(), w = await app.captured(), g = w.graphs[0];
  const base = { type: 'add-custom-node' as const, graphId: g.id, parentId: g.rootId, markdown: '我的说明', images: g.nodes[0].images };
  await assert.rejects(app.api.graphMutate(w.id, { ...base, parentId: 'missing' }), /卡片已不存在/);
  await assert.rejects(app.api.graphMutate(w.id, { ...base, images: [{ id: 'bad', title: '坏图', imageDataUrl: 'bad' }] }), /截图格式无效/);
  await assert.rejects(app.api.graphMutate(w.id, { ...base, images: Array.from({ length: 65 }, () => g.nodes[0].images[0]) }), /图片附件格式无效/);
  assert.equal((await app.api.graphOpen(w.id)).graphs[0].nodes.length, 1);
  const created = await app.api.graphMutate(w.id, base), custom = created.graphs[0].nodes.at(-1)!;
  assert.equal(custom.kind, 'source'); assert.equal(custom.markdown, '我的说明'); assert.equal(custom.images.length, 1);
});


class QuotaStorage extends Map<string, string> {
  full = false;
  override set(key: string, value: string) {
    if (this.full) throw new Error('QuotaExceededError');
    return super.set(key, value);
  }
}

test('演示写入失败不提交名称、工作区或当前选择，读取不会补写失败操作', async () => {
  const storage = new QuotaStorage(), app = fixture(storage);
  const first = await app.api.graphCreate('第一工作区'), second = await app.api.graphCreate('第二工作区');
  await app.api.graphOpen(first.id);
  const saved = storage.get('rabbitball.graph.demo.v1');
  let changes = 0; app.api.onGraphChanged(() => changes++);
  storage.full = true;
  await assert.rejects(app.api.graphMutate(first.id, { type: 'rename-workspace', name: '不应提交' }), /存储空间不足/);
  await assert.rejects(app.api.graphCreate('不应创建'), /存储空间不足/);
  await assert.rejects(app.api.graphOpen(second.id), /存储空间不足/);
  assert.equal(changes, 0);
  assert.deepEqual(Array.from(await app.api.graphList(), w => w.name), ['第一工作区', '第二工作区']);
  assert.deepEqual(await app.api.graphOpen(), first, '读取当前工作区不需要写入，存储满时仍可阅读');
  assert.equal(storage.get('rabbitball.graph.demo.v1'), saved);
  storage.full = false;
  assert.deepEqual(await app.api.graphOpen(), first);
  assert.equal(storage.get('rabbitball.graph.demo.v1'), saved, '恢复存储后读取不会悄悄提交失败修改');
  assert.deepEqual(await fixture(storage).api.graphOpen(), first);
});

test('演示写入失败保留撤销重做栈，重试只提交一次历史', async () => {
  const storage = new QuotaStorage(), app = fixture(storage), w = await app.api.graphCreate('原名');
  await app.api.graphMutate(w.id, { type: 'rename-workspace', name: '新名' });
  storage.full = true;
  await assert.rejects(app.api.graphMutate(w.id, { type: 'undo' }), /存储空间不足/);
  assert.equal((await app.api.graphOpen()).name, '新名');
  storage.full = false;
  await app.api.graphMutate(w.id, { type: 'undo' });
  storage.full = true;
  await assert.rejects(app.api.graphMutate(w.id, { type: 'rename-workspace', name: '失败编辑' }), /存储空间不足/);
  await assert.rejects(app.api.graphMutate(w.id, { type: 'redo' }), /存储空间不足/);
  assert.equal((await app.api.graphOpen()).name, '原名');
  storage.full = false;
  assert.equal((await app.api.graphMutate(w.id, { type: 'redo' })).name, '新名');
  await app.api.graphMutate(w.id, { type: 'undo' });
  await assert.rejects(app.api.graphMutate(w.id, { type: 'undo' }), /没有可以撤销/);
});

test('演示删卡或撤销保存失败不会提前停止生成任务，重试生成失败保留原任务', async () => {
  for (const action of ['delete', 'undo', 'regenerate'] as const) {
    const storage = new QuotaStorage(), app = fixture(storage), w = await app.captured(), g = w.graphs[0];
    const card = await app.addCard(w.id, g.id, g.rootId, '正在生成');
    await app.api.graphRegenerate({ workspaceId: w.id, graphId: g.id, nodeId: card.id });
    const before = await app.api.graphOpen(w.id);
    storage.full = true;
    const failed = action === 'regenerate'
      ? app.api.graphRegenerate({ workspaceId: w.id, graphId: g.id, nodeId: card.id })
      : app.api.graphMutate(w.id, action === 'undo' ? { type: 'undo' } : { type: 'delete', graphId: g.id, nodeId: card.id });
    await assert.rejects(failed, /存储空间不足/);
    assert.deepEqual(await app.api.graphOpen(), before, action + ' 失败不提交节点与任务状态');
    storage.full = false; app.drain();
    const completed = (await app.api.graphOpen()).graphs[0].nodes.find(n => n.id === card.id)!;
    assert.equal(completed.status, 'idle', action + ' 失败后原任务应正常完成');
    assert.match(completed.markdown, /这是浏览器中的重新生成演示/);
  }
});


test('演示生成写入失败保留已保存正文并结束任务，不把失败草稿混入后续保存', async () => {
  const storage = new QuotaStorage(), app = fixture(storage), w = await app.captured(), g = w.graphs[0];
  const card = await app.addCard(w.id, g.id, g.rootId, '已有正文');
  const errors: string[] = []; app.api.onGraphError(error => errors.push(error.message));
  await app.api.graphRegenerate({ workspaceId: w.id, graphId: g.id, nodeId: card.id });
  const saved = storage.get('rabbitball.graph.demo.v1');
  storage.full = true; app.drain();
  const failed = (await app.api.graphOpen()).graphs[0].nodes.find(n => n.id === card.id)!;
  assert.equal(failed.status, 'error'); assert.equal(failed.draft, undefined);
  assert.equal(failed.markdown, card.markdown); assert.equal(failed.contentRevision, card.contentRevision);
  assert.match(errors[0], /存储空间不足/); assert.equal(storage.get('rabbitball.graph.demo.v1'), saved);
  storage.full = false;
  const pinned = await app.api.graphMutate(w.id, { type: 'pin', graphId: g.id, nodeId: card.id, pinned: true });
  assert.equal(pinned.graphs[0].nodes.find(n => n.id === card.id)!.markdown, card.markdown);
});
