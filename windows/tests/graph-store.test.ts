import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir, symlink, rename, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GraphStore } from '../electron/graph-store.ts';
import type { CaptureContext } from '../electron/contracts.ts';
import type { GraphNode, GraphWorkspace } from '../electron/graph-contracts.ts';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jTQAAAABJRU5ErkJggg==';
const capture: CaptureContext = { id: 'capture-1', title: '阅读中的论文', capturedAt: 1,
  images: [{ id: 'screen-1', title: '第一页', imageDataUrl: PNG, pixelSize: { width: 1, height: 1 } },
    { id: 'screen-2', title: '第二页', imageDataUrl: PNG }] };

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), 'rabbitball-graph-'));
  const changes: GraphWorkspace[] = [], errors: Error[] = [], stores: GraphStore[] = [];
  const load = async () => {
    const store = new GraphStore(directory, workspace => changes.push(workspace), error => errors.push(error));
    stores.push(store); await store.load(); return store;
  };
  t.after(async () => { for (const store of stores) await store.dispose(); await rm(directory, { recursive: true, force: true }); });
  const store = await load();
  const workspace = await store.create('物理阅读');
  const empty = await store.mutate(workspace.id, { type: 'create-graph', title: capture.title });
  const populated = await store.attachCapture(workspace.id, empty.lastGraphId!, capture);
  return { directory, store, workspace: populated, changes, errors, load };
}

async function addCard(store: GraphStore, workspace: GraphWorkspace, title: string, parentId?: string) {
  const graph = workspace.graphs[0];
  const result = await store.mutate(workspace.id, { type: 'add-card', graphId: graph.id, parentId: parentId ?? graph.rootId, title, markdown: `${title}的正文。` });
  return { workspace: result, node: result.graphs[0].nodes.at(-1)! };
}

test('直接提问来源可撤销重做并重载，原问题与父资料分开保留', async t => {
  const { store, workspace, load } = await fixture(t);
  const child = await addCard(store, workspace, '直接提问的回答');
  const question = '为什么可以采用这个近似？';
  await store.update(workspace.id, draft => {
    draft.graphs[0].nodes.find(node => node.id === child.node.id)!.source = {
      nodeId: workspace.graphs[0].rootId, selection: { kind: 'text', text: '' }, comment: '', question, revision: 0,
    };
  }, true);
  const undone = await store.mutate(workspace.id, { type: 'undo' });
  assert.equal(undone.graphs[0].nodes.find(node => node.id === child.node.id)?.source, undefined);
  const restored = await store.mutate(workspace.id, { type: 'redo' });
  assert.equal(restored.graphs[0].nodes.find(node => node.id === child.node.id)?.source?.question, question);
  await store.dispose();
  const reloaded = await (await load()).open(workspace.id);
  const source = reloaded.graphs[0].nodes.find(node => node.id === child.node.id)?.source;
  assert.equal(source?.question, question);
  assert.equal(source?.annotationId, undefined);
  assert.deepEqual(reloaded.graphs[0].nodes[0].annotations, []);
});

test('删除整张图谱同步移除Markdown及节点，撤销完整恢复资料且不恢复旧任务', async t => {
  const { store, workspace, load } = await fixture(t);
  const graphId = workspace.graphs[0].id, rootId = workspace.graphs[0].rootId;
  const { node: child } = await addCard(store, workspace, '需要保留的回答');
  await store.mutate(workspace.id, { type: 'append-node-attachments', graphId, nodeId: rootId,
    attachments: [{ id: 'document', name: '推导.md', mimeType: 'text/markdown', format: 'markdown', text: '完整推导 $x^2$' }] });
  await store.update(workspace.id, draft => {
    const node = draft.graphs[0].nodes.find(node => node.id === child.id)!;
    node.pinned = true; node.status = 'generating'; node.draft = '尚未完成';
    node.source = { nodeId: rootId, question: '为什么成立？', selection: { kind: 'text', text: '' }, comment: '', revision: 0 };
  });
  const withOther = await store.mutate(workspace.id, { type: 'create-graph', title: '保留的空图' });
  const otherId = withOther.lastGraphId!;
  await store.mutate(workspace.id, { type: 'visit', graphId });
  const removed = await store.mutate(workspace.id, { type: 'delete-graph', graphId });
  assert.deepEqual(removed.graphs.map(graph => graph.id), [otherId]);
  assert.equal(removed.lastGraphId, otherId);
  const deletedDocument = await store.readDocument(workspace.id);
  assert.ok(!deletedDocument.markdown.includes(graphId));
  assert.ok(!deletedDocument.markdown.includes('需要保留的回答'));
  assert.ok(!deletedDocument.markdown.includes('推导.md'));
  const restored = await store.mutate(workspace.id, { type: 'undo' });
  assert.deepEqual(restored.graphs.map(graph => graph.id), [graphId, otherId]);
  assert.equal(restored.lastGraphId, otherId, '撤销不覆盖仍然有效的当前图谱选择');
  const root = restored.graphs[0].nodes.find(node => node.id === rootId)!;
  assert.deepEqual(root.images.map(image => image.imageDataUrl), [PNG, PNG]);
  assert.equal(root.attachments?.[0].text, '完整推导 $x^2$');
  const answer = restored.graphs[0].nodes.find(node => node.id === child.id)!;
  assert.equal(answer.markdown, '需要保留的回答的正文。');
  assert.equal(answer.source?.question, '为什么成立？');
  assert.equal(answer.pinned, true);
  assert.equal(answer.status, 'cancelled');
  assert.equal(answer.draft, undefined);
  assert.ok((await store.readDocument(workspace.id)).markdown.includes('推导.md'));
  const redone = await store.mutate(workspace.id, { type: 'redo' });
  assert.deepEqual(redone.graphs.map(graph => graph.id), [otherId]);
  await store.dispose();
  const reloaded = await (await load()).open(workspace.id);
  assert.deepEqual(reloaded.graphs.map(graph => graph.id), [otherId]);
  assert.equal(reloaded.lastGraphId, otherId);
});

test('整图删除选择相邻图，非当前图不切换，全删及重载后仍可新建', async t => {
  const { store, workspace, load } = await fixture(t);
  const first = workspace.graphs[0].id;
  const second = (await store.mutate(workspace.id, { type: 'create-graph', title: '第二张' })).lastGraphId!;
  const third = (await store.mutate(workspace.id, { type: 'create-graph', title: '第三张' })).lastGraphId!;
  await store.mutate(workspace.id, { type: 'visit', graphId: second });
  let current = await store.mutate(workspace.id, { type: 'delete-graph', graphId: second });
  assert.equal(current.lastGraphId, third, '优先选择删除位置后的图谱');
  current = await store.mutate(workspace.id, { type: 'delete-graph', graphId: third });
  assert.equal(current.lastGraphId, first, '尾图删除后选择前一张');
  await store.mutate(workspace.id, { type: 'undo' });
  current = await store.mutate(workspace.id, { type: 'delete-graph', graphId: third });
  assert.equal(current.lastGraphId, first, '删除非当前图保留选择');
  await assert.rejects(store.mutate(workspace.id, { type: 'delete-graph', graphId: 'missing' }), /找不到/);
  assert.deepEqual(await store.open(workspace.id), current);
  current = await store.mutate(workspace.id, { type: 'delete-graph', graphId: first });
  assert.deepEqual(current.graphs, []);
  assert.equal(current.lastGraphId, undefined);
  assert.equal((await store.readDocument(workspace.id)).markdown.trim(), '# 物理阅读');
  await store.dispose();
  const reloadedStore = await load(), empty = await reloadedStore.open(workspace.id);
  assert.deepEqual(empty.graphs, []); assert.equal(empty.lastGraphId, undefined);
  const created = await reloadedStore.mutate(workspace.id, { type: 'create-graph', title: '新的开始' });
  assert.equal(created.graphs.length, 1);
  assert.equal(created.graphs[0].title, '新的开始');
  assert.equal(created.lastGraphId, created.graphs[0].id);
});

test('工作区背景跨图共享，公式与完整附件可撤销重做和重启恢复', async t => {
  const { store, workspace, load } = await fixture(t);
  await store.mutate(workspace.id, { type: 'create-graph', title: '另一个主题' });
  const background = { text: '# 阅读背景\n\n$$E=mc^2$$\n```markdown\n## 原文标题\n```\n<!-- rabbitball:node {} -->\n', attachments: [
    { id: 'paper', name: '公式材料.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', format: 'markdown', text: '# 原文\n' + '完整公式 $\\alpha_i^2$。'.repeat(3000) },
    { id: 'background-image', name: '符号表.png', mimeType: 'image/png', dataUrl: PNG },
    { id: 'plain-readme', name: 'README', mimeType: 'text/plain', format: 'text', text: '无后缀资料\n' },
    { id: 'unknown-type', name: '资料.' + 'custom'.repeat(20), mimeType: 'text/plain', format: 'custom'.repeat(20), text: '未知长后缀仍保留完整类型和正文\n' },
  ] };
  const updated = await store.mutate(workspace.id, { type: 'set-background', background });
  assert.equal(updated.graphs.length, 2);
  assert.equal(updated.background?.text, background.text);
  assert.deepEqual(updated.background?.attachments.map(({ file: _file, ...attachment }) => attachment), background.attachments);
  const document = await store.readDocument(workspace.id);
  assert.ok(document.markdown.includes(background.text));
  assert.ok(!document.markdown.includes('base64,'));
  assert.ok(!document.markdown.includes(background.attachments[0].text!));
  const empty = await store.mutate(workspace.id, { type: 'undo' });
  assert.equal(empty.background, undefined);
  await store.mutate(workspace.id, { type: 'redo' });
  const other = await store.create('独立工作区');
  assert.equal(other.background, undefined);
  await store.dispose();
  const reloaded = await (await load()).open(workspace.id);
  assert.equal(reloaded.background?.text, background.text);
  assert.deepEqual(reloaded.background?.attachments.map(({ file: _file, ...attachment }) => attachment), background.attachments);
  assert.equal(reloaded.graphs.length, 2);
});

test('外部编辑背景只更新背景，附件越界与超限输入不会覆盖已有资料', async t => {
  const { store, workspace } = await fixture(t);
  const background = { text: '原背景', attachments: [{ id: 'source-file', name: '资料.md', mimeType: 'text/markdown', text: '$\\psi$ 的定义' }] };
  await store.mutate(workspace.id, { type: 'set-background', background });
  const document = await store.readDocument(workspace.id);
  const edited = await store.writeDocument(workspace.id, document.markdown.replace('原背景', '更新后的背景'), document.revision);
  assert.equal(edited.background?.text, '更新后的背景');
  assert.equal(edited.graphs[0].nodes[0].images.length, 2);
  await assert.rejects(store.mutate(workspace.id, { type: 'set-background', background: { text: '不应覆盖', attachments: [{ ...background.attachments[0], text: 'x'.repeat(1_000_001) }] } }), /100 万字符/);
  const current = await store.readDocument(workspace.id);
  const escaped = current.markdown.replace(/assets\/[a-f0-9]{64}\.txt/, '../outside.txt');
  await assert.rejects(store.writeDocument(workspace.id, escaped, current.revision), /资源路径无效/);
  assert.equal((await store.open(workspace.id)).background?.text, '更新后的背景');
  assert.equal((await store.readDocument(workspace.id)).markdown, current.markdown);
});

test('文件解析后立即暂存资源，卡片仅引用附件，撤销重做、跨图和重载保留全文', async t => {
  const { store, workspace, load } = await fixture(t);
  const originalDocument = await store.readDocument(workspace.id);
  const text = '# 独立文档\r\n\r\n$\\frac{H}{2}$\r\n' + '完整资料不可截断。'.repeat(4000);
  const staged = await store.stageAttachment(workspace.id, { name: '讲义[公式].docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', format: 'docx', text });
  assert.match(staged.file!, /^assets\/[a-f0-9]{64}\.txt$/);
  assert.equal(await readFile(path.join(store.getDirectory(workspace.id), staged.file!), 'utf8'), text);
  assert.equal((await store.readDocument(workspace.id)).markdown, originalDocument.markdown, '暂存不修改工作区正文或背景草稿');
  assert.equal((await store.open(workspace.id)).background, undefined);
  assert.equal((await store.open(workspace.id)).revision, workspace.revision);
  const graphId = workspace.graphs[0].id;
  const customWorkspace = await store.mutate(workspace.id, { type: 'add-custom-node', graphId, parentId: workspace.graphs[0].rootId, markdown: '卡片说明', images: [] });
  const custom = customWorkspace.graphs[0].nodes.at(-1)!;
  const attachments = [{ id: 'lecture', ...staged }, { id: 'source', name: 'analysis.py', mimeType: 'text/plain', format: 'py', language: 'python', text: '# 完整代码\nprint(42)\n' }];
  const added = await store.mutate(workspace.id, { type: 'append-node-attachments', graphId, nodeId: custom.id, attachments });
  const node = added.graphs[0].nodes.find(node => node.id === custom.id)!;
  assert.equal(node.markdown, '卡片说明');
  assert.equal(node.contentRevision, custom.contentRevision + 1);
  assert.equal(node.attachments![0].text, text);
  const document = await store.readDocument(workspace.id);
  assert.ok(document.markdown.includes(`[讲义\\[公式\\].docx](${staged.file})`));
  assert.ok(!document.markdown.includes(text));
  assert.ok(!document.markdown.includes('print(42)'));
  const state = await readFile(path.join(store.getDirectory(workspace.id), 'state.json'), 'utf8');
  assert.ok(!state.includes('完整资料不可截断'));
  assert.equal((await store.mutate(workspace.id, { type: 'undo' })).graphs[0].nodes.find(node => node.id === custom.id)!.attachments, undefined);
  await store.mutate(workspace.id, { type: 'redo' });
  const removed = await store.mutate(workspace.id, { type: 'remove-node-attachment', graphId, nodeId: custom.id, attachmentId: 'lecture' });
  assert.deepEqual(removed.graphs[0].nodes.find(node => node.id === custom.id)!.attachments!.map(item => item.id), ['source']);
  assert.equal(await readFile(path.join(store.getDirectory(workspace.id), staged.file!), 'utf8'), text, '移除引用保留资源供撤销和其它引用使用');
  await store.mutate(workspace.id, { type: 'undo' });
  const other = await store.mutate(workspace.id, { type: 'create-graph', title: '新主题' });
  const targetGraphId = other.lastGraphId!;
  await store.mutate(workspace.id, { type: 'move-subtree', graphId, nodeId: custom.id, targetGraphId });
  await store.dispose();
  const reloaded = await (await load()).open(workspace.id);
  const restored = reloaded.graphs.find(graph => graph.id === targetGraphId)!.nodes[0];
  assert.equal(restored.id, custom.id);
  assert.equal(restored.markdown, '卡片说明');
  assert.equal(restored.attachments![0].text, text);
  assert.equal(restored.attachments![1].language, 'python');
  assert.equal(restored.attachments![1].text, attachments[1].text);
});

test('卡片附件拒绝未解析内容、超限和外部资源路径，失败保持原资料', async t => {
  const { store, workspace } = await fixture(t), graph = workspace.graphs[0];
  const mutation = { type: 'append-node-attachments' as const, graphId: graph.id, nodeId: graph.rootId };
  const attachment = { id: 'file', name: 'README', mimeType: 'text/plain', format: 'text', text: '文档全文' };
  await assert.rejects(store.mutate(workspace.id, { ...mutation, attachments: [{ id: 'image', name: '图.png', mimeType: 'image/png', dataUrl: PNG }] }), /先解析为文字/);
  await assert.rejects(store.mutate(workspace.id, { ...mutation, attachments: [{ ...attachment, text: 'x'.repeat(1_000_001) }] }), /100 万字符/);
  await assert.rejects(store.mutate(workspace.id, { ...mutation, attachments: Array.from({ length: 65 }, (_, index) => ({ ...attachment, id: `file-${index}` })) }), /64/);
  const added = await store.mutate(workspace.id, { ...mutation, attachments: [attachment] });
  const document = await store.readDocument(workspace.id);
  await assert.rejects(store.writeDocument(workspace.id, document.markdown.replace(/assets\/[a-f0-9]{64}\.txt/g, '../outside.txt'), document.revision), /资源路径无效/);
  assert.equal((await store.open(workspace.id)).graphs[0].nodes[0].attachments![0].text, '文档全文');
  assert.equal((await store.readDocument(workspace.id)).markdown, document.markdown);
  const duplicated = await store.mutate(workspace.id, { ...mutation, attachments: [attachment] });
  assert.equal(new Set(duplicated.graphs[0].nodes[0].attachments!.map(item => item.id)).size, 2);
  assert.equal(added.graphs[0].nodes[0].markdown, workspace.graphs[0].nodes[0].markdown);
});

test('背景附件在 Markdown 中有可读链接，正文与图谱结构保持独立', async t => {
  const { store, workspace, load } = await fixture(t);
  const attachment = { id: 'background-file', name: '说明.md', mimeType: 'text/markdown', format: 'md', text: '# 附件全文\n$$H=E$$' };
  const updated = await store.mutate(workspace.id, { type: 'set-background', background: { text: '背景说明', attachments: [attachment] } });
  const document = await store.readDocument(workspace.id);
  assert.ok(document.markdown.includes(`[说明.md](${updated.background!.attachments[0].file})`));
  assert.ok(!document.markdown.includes(attachment.text));
  await store.dispose();
  const reloaded = await (await load()).open(workspace.id);
  assert.equal(reloaded.background!.text, '背景说明');
  assert.equal(reloaded.background!.attachments[0].text, attachment.text);
  assert.equal(reloaded.graphs.length, workspace.graphs.length);
  assert.equal(reloaded.graphs[0].nodes[0].markdown, workspace.graphs[0].nodes[0].markdown);
});

test('移除节点图片保留已有批注子卡的来源图片快照，支持撤销', async t => {
  const { store, workspace, load } = await fixture(t), graph = workspace.graphs[0], image = graph.nodes[0].images[0];
  const child = await addCard(store, workspace, '图片解释');
  await store.update(workspace.id, current => {
    current.graphs[0].nodes.find(node => node.id === child.node.id)!.source = { nodeId: graph.rootId,
      selection: { kind: 'image', imageId: image.id, rect: { x: 0, y: 0, width: 1, height: 1 } }, comment: '解释图', revision: 1 };
  });
  const removed = await store.mutate(workspace.id, { type: 'remove-node-image', graphId: graph.id, nodeId: graph.rootId, imageId: image.id });
  assert.equal(removed.graphs[0].nodes[0].images.some(item => item.id === image.id), false);
  assert.equal(removed.graphs[0].nodes[1].source!.selectionImage!.imageDataUrl, image.imageDataUrl);
  const undone = await store.mutate(workspace.id, { type: 'undo' });
  assert.equal(undone.graphs[0].nodes[0].images.some(item => item.id === image.id), true);
  await store.mutate(workspace.id, { type: 'redo' });
  await store.dispose();
  const reloaded = await (await load()).open(workspace.id);
  assert.equal(reloaded.graphs[0].nodes[1].source!.selectionImage!.imageDataUrl, image.imageDataUrl);
});

test('卡片混合文件按真实添加顺序撤回，重开和撤销重做保留顺序', async t => {
  const { store, workspace, load } = await fixture(t), graph = workspace.graphs[0];
  const custom = await store.mutate(workspace.id, { type: 'add-custom-node', graphId: graph.id, parentId: graph.rootId, markdown: '', images: [] });
  const nodeId = custom.graphs[0].nodes.at(-1)!.id;
  const target = { graphId: graph.id, nodeId };
  const file = (id: string) => ({ id, name: `${id}.md`, mimeType: 'text/markdown', format: 'md', text: `完整内容 ${id}` });
  await store.mutate(workspace.id, { type: 'append-node-attachments', ...target, attachments: [file('first')] });
  // 图片与文件可拥有相同的旧 ID，顺序键仍能区分各自的素材。
  await store.mutate(workspace.id, { type: 'append-node-images', ...target, images: [{ ...capture.images[0], id: 'first' }] });
  const appended = await store.mutate(workspace.id, { type: 'append-node-attachments', ...target, attachments: [file('last')] });
  const order = ['attachment:first', 'image:first', 'attachment:last'];
  assert.deepEqual(appended.graphs[0].nodes.at(-1)!.materialOrder, order);
  const document = await store.readDocument(workspace.id);
  assert.ok(document.markdown.includes(`"materialOrder":${JSON.stringify(order)}`));
  await store.dispose();
  const reopened = await load();
  assert.deepEqual((await reopened.open(workspace.id)).graphs[0].nodes.at(-1)!.materialOrder, order);
  const removed = await reopened.mutate(workspace.id, { type: 'remove-latest-node-asset', ...target });
  assert.deepEqual(removed.graphs[0].nodes.at(-1)!.materialOrder, order.slice(0, 2));
  assert.deepEqual(removed.graphs[0].nodes.at(-1)!.attachments!.map(item => item.id), ['first']);
  assert.equal(removed.graphs[0].nodes.at(-1)!.images.length, 1);
  assert.deepEqual((await reopened.mutate(workspace.id, { type: 'undo' })).graphs[0].nodes.at(-1)!.materialOrder, order);
  await reopened.mutate(workspace.id, { type: 'redo' });
  const repeats = await Promise.all([
    reopened.mutate(workspace.id, { type: 'remove-latest-node-asset', ...target }),
    reopened.mutate(workspace.id, { type: 'remove-latest-node-asset', ...target }),
  ]);
  assert.deepEqual(repeats[0].graphs[0].nodes.at(-1)!.materialOrder, ['attachment:first']);
  assert.equal(repeats[0].graphs[0].nodes.at(-1)!.images.length, 0);
  assert.equal(repeats[1].graphs[0].nodes.at(-1)!.attachments, undefined);
  assert.equal(repeats[1].graphs[0].nodes.at(-1)!.materialOrder, undefined);
  const empty = await reopened.mutate(workspace.id, { type: 'remove-latest-node-asset', ...target });
  assert.equal(empty.revision, repeats[1].revision, '空卡片不产生无意义的写入或历史');
});

test('截图、单项移除与旧记录补齐共用同一素材顺序', async t => {
  const { store, workspace, load } = await fixture(t), graph = workspace.graphs[0];
  const target = { graphId: graph.id, nodeId: graph.rootId };
  assert.deepEqual(graph.nodes[0].materialOrder, ['image:screen-1', 'image:screen-2']);
  await store.mutate(workspace.id, { type: 'append-node-attachments', ...target, attachments: [{ id: 'file', name: 'README', mimeType: 'text/plain', text: '全文' }] });
  const captured = await store.attachCapture(workspace.id, graph.id, { ...capture, images: [{ ...capture.images[0], id: 'recent-screen' }] });
  assert.deepEqual(captured.graphs[0].nodes[0].materialOrder, ['image:screen-1', 'image:screen-2', 'attachment:file', 'image:recent-screen']);
  const removed = await store.mutate(workspace.id, { type: 'remove-node-image', ...target, imageId: 'screen-2' });
  assert.deepEqual(removed.graphs[0].nodes[0].materialOrder, ['image:screen-1', 'attachment:file', 'image:recent-screen']);
  const latest = await store.mutate(workspace.id, { type: 'remove-latest-node-asset', ...target });
  assert.deepEqual(latest.graphs[0].nodes[0].materialOrder, ['image:screen-1', 'attachment:file']);
  const document = await store.readDocument(workspace.id), directory = store.getDirectory(workspace.id);
  await store.dispose();
  await writeFile(document.path, document.markdown.replace(/,"materialOrder":\[[^\]]*\]/g, ''), 'utf8');
  const saved = JSON.parse(await readFile(path.join(directory, 'state.json'), 'utf8'));
  for (const savedGraph of saved.graphs) for (const savedNode of savedGraph.nodes) delete savedNode.materialOrder;
  await writeFile(path.join(directory, 'state.json'), JSON.stringify(saved), 'utf8');
  const reloaded = await (await load()).open(workspace.id);
  assert.deepEqual(reloaded.graphs[0].nodes[0].materialOrder, ['image:screen-1', 'attachment:file']);
  assert.equal(reloaded.graphs[0].nodes[0].attachments![0].text, '全文');
});

test('一个工作区一份 Markdown，根截图直接插入；正文、资源与界面状态可重启恢复', async t => {
  const { store, workspace, directory, load } = await fixture(t);
  const added = await addCard(store, workspace, '核心概念');
  const graph = added.workspace.graphs[0];
  await store.mutate(workspace.id, { type: 'pin', graphId: graph.id, nodeId: added.node.id, pinned: true });
  await store.mutate(workspace.id, { type: 'layout', graphId: graph.id, unit: 238, positions: [{ id: added.node.id, x: 100, y: -300 }] });
  const generation = { id: 'completed-generation', contentRevision: added.node.contentRevision, startedAt: 1000, finishedAt: 3500, toolCounts: { '搜索': 2 } };
  await store.update(workspace.id, draft => { draft.graphs[0].nodes[1].generation = generation; });
  const before = await store.mutate(workspace.id, { type: 'view', graphId: graph.id, view: { x: 20, y: 90, zoom: 1.3 } });
  assert.equal(before.graphs[0].nodes[1].contentRevision, added.node.contentRevision);
  const document = await store.readDocument(workspace.id);
  assert.match(document.markdown, /^# 物理阅读/m);
  assert.match(document.markdown, /^## 阅读中的论文/m);
  assert.match(document.markdown, /^### 核心概念/m);
  assert.doesNotMatch(document.markdown, /^### 阅读中的论文/m);
  assert.equal((document.markdown.match(/^!\[/gm) ?? []).length, 2);
  assert.equal(document.markdown.includes('base64,'), false);
  assert.equal((await readdir(path.join(store.getDirectory(workspace.id), 'assets'))).length, 1);
  const state = await readFile(path.join(store.getDirectory(workspace.id), 'state.json'), 'utf8');
  assert.equal(state.includes('核心概念的正文'), false);
  assert.equal(state.includes('base64,'), false);
  await store.dispose();
  const restored = await (await load()).open();
  assert.equal(restored.id, workspace.id);
  assert.equal(restored.graphs[0].nodes[0].images[0].imageDataUrl, PNG);
  assert.deepEqual(restored.graphs[0].nodes[0].images.map(image => image.id), ['screen-1', 'screen-2']);
  assert.equal(restored.graphs[0].layoutInitialized, true);
  assert.deepEqual(restored.graphs[0].view, before.graphs[0].view);
  assert.equal(restored.graphs[0].nodes[1].markdown, '核心概念的正文。');
  assert.equal(restored.graphs[0].nodes[1].pinned, true);
  assert.equal(restored.graphs[0].nodes[1].x, 100);
  assert.deepEqual(restored.graphs[0].nodes[1].generation, generation);
});

test('并发事务不丢写；状态更新不改变正文修订，过期卡片编辑被拒绝', async t => {
  const { store, workspace } = await fixture(t);
  const { node } = await addCard(store, workspace, '原题');
  const graphId = workspace.graphs[0].id;
  await Promise.all([
    store.update(workspace.id, draft => { draft.graphs[0].nodes.find(item => item.id === node.id)!.status = 'generating'; }),
    store.update(workspace.id, draft => { draft.graphs[0].nodes.find(item => item.id === node.id)!.draft = '正在生成'; }),
    store.mutate(workspace.id, { type: 'pin', graphId, nodeId: node.id, pinned: true }),
  ]);
  let updated = (await store.open(workspace.id)).graphs[0].nodes.find(item => item.id === node.id)!;
  assert.equal(updated.status, 'generating'); assert.equal(updated.draft, '正在生成'); assert.equal(updated.pinned, true);
  assert.equal(updated.contentRevision, node.contentRevision);
  await store.mutate(workspace.id, { type: 'edit', graphId, nodeId: node.id, title: '人工题目', markdown: '人工正文', contentRevision: node.contentRevision });
  await assert.rejects(store.mutate(workspace.id, { type: 'edit', graphId, nodeId: node.id, title: '过时题目', markdown: '过时正文', contentRevision: node.contentRevision }), /卡片已更新/);
  updated = (await store.open(workspace.id)).graphs[0].nodes.find(item => item.id === node.id)!;
  assert.equal(updated.contentRevision, node.contentRevision + 1);
  assert.equal(updated.markdown, '人工正文');
});

test('文档编辑只与正文修订冲突，画布、固定和生成进度不会阻止保存', async t => {
  const { store, workspace } = await fixture(t);
  const { node } = await addCard(store, workspace, '初稿'), graphId = workspace.graphs[0].id;
  const document = await store.readDocument(workspace.id);
  await store.mutate(workspace.id, { type: 'pin', graphId, nodeId: node.id, pinned: true });
  await store.mutate(workspace.id, { type: 'view', graphId, view: { x: 30, y: 80, zoom: .8 } });
  await store.update(workspace.id, draft => { draft.graphs[0].nodes.find(item => item.id === node.id)!.draft = '正在生成'; });
  assert.equal((await store.readDocument(workspace.id)).revision, document.revision);
  const saved = await store.writeDocument(workspace.id, document.markdown.replace('初稿的正文。', '人工修改正文。'), document.revision);
  assert.equal(saved.graphs[0].nodes.find(item => item.id === node.id)!.markdown, '人工修改正文。');
  assert.equal(saved.graphs[0].nodes.find(item => item.id === node.id)!.pinned, true);
  assert.equal(saved.graphs[0].nodes.find(item => item.id === node.id)!.draft, '正在生成');
  await assert.rejects(store.writeDocument(workspace.id, document.markdown, document.revision), /文档已发生变化/);
});

test('重新关联可挂已有分支但禁止循环，移动整棵子树；删除撤销不会恢复旧任务', async t => {
  const { store, workspace } = await fixture(t);
  const a = await addCard(store, workspace, 'A'), b = await addCard(store, workspace, 'B');
  const child = await addCard(store, workspace, 'A1', a.node.id), graphId = workspace.graphs[0].id;
  const branched = await store.mutate(workspace.id, { type: 'reparent', graphId, nodeId: b.node.id, parentId: a.node.id });
  assert.equal(branched.graphs[0].nodes.find(node => node.id === b.node.id)!.parentId, a.node.id);
  await store.mutate(workspace.id, { type: 'undo' });
  await assert.rejects(store.mutate(workspace.id, { type: 'reparent', graphId, nodeId: a.node.id, parentId: a.node.id }), /自己/);
  await assert.rejects(store.mutate(workspace.id, { type: 'reparent', graphId, nodeId: a.node.id, parentId: child.node.id }), /后代/);
  await store.mutate(workspace.id, { type: 'reparent', graphId, nodeId: a.node.id, parentId: b.node.id });
  let current = await store.open(workspace.id);
  assert.equal(current.graphs[0].nodes.find(item => item.id === child.node.id)!.parentId, a.node.id);
  await store.update(workspace.id, draft => { draft.graphs[0].nodes.find(item => item.id === child.node.id)!.status = 'generating'; });
  current = await store.mutate(workspace.id, { type: 'delete', graphId, nodeId: a.node.id });
  assert.deepEqual(current.graphs[0].nodes.map(node => node.id), [workspace.graphs[0].rootId, b.node.id]);
  await assert.rejects(store.update(workspace.id, draft => { draft.graphs[0].nodes.push({ ...a.node, parentId: b.node.id }); }), /已失效/);
  current = await store.mutate(workspace.id, { type: 'undo' });
  assert.equal(current.graphs[0].nodes.find(item => item.id === child.node.id)!.status, 'cancelled');
  assert.equal(current.graphs[0].nodes.find(item => item.id === a.node.id)!.parentId, b.node.id);
  await store.mutate(workspace.id, { type: 'delete', graphId, nodeId: workspace.graphs[0].rootId });
  assert.equal((await store.open(workspace.id)).graphs.length, 0);
  assert.equal((await store.mutate(workspace.id, { type: 'undo' })).graphs[0].nodes.length, 4);
});

test('外部改正文即时同步，界面操作不会覆盖手稿；删父节点保留剩余子卡正文', async t => {
  const { store, workspace, errors } = await fixture(t);
  const a = await addCard(store, workspace, '父卡'), b = await addCard(store, workspace, '子卡', a.node.id);
  const document = await store.readDocument(workspace.id);
  const edited = document.markdown.replace('### 子卡\n子卡的正文。', '### 新子卡\n外部撰写的正文。');
  await writeFile(document.path, edited, 'utf8');
  const synced = await store.mutate(workspace.id, { type: 'pin', graphId: workspace.graphs[0].id, nodeId: b.node.id, pinned: true });
  const card = synced.graphs[0].nodes.find(node => node.id === b.node.id)!;
  assert.equal(card.title, '新子卡'); assert.equal(card.markdown, '外部撰写的正文。');
  assert.equal(card.contentRevision, b.node.contentRevision + 1);
  assert.equal(await readFile(document.path, 'utf8'), edited);
  const marker = `<!-- rabbitball:node ${JSON.stringify({ id: a.node.id, parentId: workspace.graphs[0].rootId, kind: 'card' })} -->`;
  const parentStart = edited.indexOf(marker), childStart = edited.indexOf('<!-- rabbitball:node', parentStart + marker.length);
  await writeFile(document.path, edited.slice(0, parentStart) + edited.slice(childStart), 'utf8');
  const afterDelete = await store.open(workspace.id);
  assert.equal(afterDelete.graphs[0].nodes.some(node => node.id === a.node.id), false);
  assert.equal(afterDelete.graphs[0].nodes.find(node => node.id === b.node.id)!.parentId, workspace.graphs[0].rootId);
  assert.equal(afterDelete.graphs[0].nodes.find(node => node.id === b.node.id)!.markdown, '外部撰写的正文。');
  assert.equal(errors.some(error => /正文已保留/.test(error.message)), true);
});

test('外部新增标题补齐稳定编号；重排 Markdown 块保持父子关系和卡片身份', async t => {
  const { store, workspace, load } = await fixture(t);
  const a = await addCard(store, workspace, '第一张'), b = await addCard(store, workspace, '第二张');
  let document = await store.readDocument(workspace.id);
  const aStart = document.markdown.indexOf(`<!-- rabbitball:node {"id":"${a.node.id}"`);
  const bStart = document.markdown.indexOf(`<!-- rabbitball:node {"id":"${b.node.id}"`);
  await writeFile(document.path, document.markdown.slice(0, aStart) + document.markdown.slice(bStart) + '\n' + document.markdown.slice(aStart, bStart), 'utf8');
  let current = await store.open(workspace.id);
  assert.deepEqual(current.graphs[0].nodes.slice(1).map(node => node.id), [b.node.id, a.node.id]);
  assert.equal(current.graphs[0].nodes[1].parentId, workspace.graphs[0].rootId);
  document = await store.readDocument(workspace.id);
  await writeFile(document.path, document.markdown + '\n### 手写新增卡片\n这段手稿必须保留。\n', 'utf8');
  current = await store.open(workspace.id);
  const added = current.graphs[0].nodes.at(-1)!;
  assert.equal(added.title, '手写新增卡片');
  assert.match(await readFile(document.path, 'utf8'), new RegExp(added.id));
  await store.mutate(workspace.id, { type: 'pin', graphId: current.graphs[0].id, nodeId: added.id, pinned: true });
  await store.dispose();
  const restored = await (await load()).open(workspace.id);
  assert.equal(restored.graphs[0].nodes.at(-1)!.id, added.id);
  assert.equal(restored.graphs[0].nodes.at(-1)!.markdown, '这段手稿必须保留。');
  assert.equal(restored.graphs[0].nodes.at(-1)!.pinned, true);
});

test('文件监听独立应用外部保存，不依赖用户下一次操作', async t => {
  const { store, workspace, changes } = await fixture(t);
  const document = await store.readDocument(workspace.id), before = changes.length;
  await writeFile(document.path, document.markdown.replace('# 物理阅读', '# 外部改名'), 'utf8');
  await new Promise<void>((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      if (changes.slice(before).some(item => item.name === '外部改名')) { clearInterval(timer); resolve(); }
      else if (Date.now() - start > 3000) { clearInterval(timer); reject(new Error('文档监听没有通知变更')); }
    }, 30);
  });
  assert.equal(store.list()[0].name, '外部改名');
});

test('无效外部手稿不被覆盖，可读取并修正；旧文档修订不能覆盖新保存', async t => {
  const { store, workspace } = await fixture(t);
  const document = await store.readDocument(workspace.id);
  const invalid = document.markdown + '\n<!-- rabbitball:node {"id":"unfinished","parentId":null,"kind":"card"} -->\n';
  await writeFile(document.path, invalid, 'utf8');
  await assert.rejects(store.mutate(workspace.id, { type: 'rename-workspace', name: '不能覆盖' }), /尚未完整/);
  assert.equal(await readFile(document.path, 'utf8'), invalid);
  const draft = await store.readDocument(workspace.id);
  assert.equal(draft.markdown, invalid);
  await assert.rejects(store.writeDocument(workspace.id, document.markdown, document.revision), /文档已发生变化/);
  const restored = await store.writeDocument(workspace.id, document.markdown.replace('# 物理阅读', '# 手工恢复'), draft.revision);
  assert.equal(restored.name, '手工恢复');
  assert.equal((await store.open(workspace.id)).graphs[0].nodes.length, 1);
});

test('重启时无效手稿仍可见可修复，自动截图不能覆盖，修复后恢复原卡片和固定状态', async t => {
  const { store, workspace, load, errors } = await fixture(t);
  const { node } = await addCard(store, workspace, '恢复用卡片');
  await store.mutate(workspace.id, { type: 'pin', graphId: workspace.graphs[0].id, nodeId: node.id, pinned: true });
  const document = await store.readDocument(workspace.id);
  await store.dispose();
  const invalid = document.markdown + '\n```未写完的手稿\n';
  await writeFile(document.path, invalid, 'utf8');
  const restored = await load();
  assert.equal(restored.list()[0].id, workspace.id);
  assert.equal(restored.list()[0].name, '物理阅读');
  const before = errors.length, opened = await restored.open();
  assert.equal(opened.id, workspace.id); assert.equal(opened.graphs.length, 0);
  assert.equal(errors.length, before + 1);
  await assert.rejects(restored.attachCapture(workspace.id, workspace.graphs[0].id, capture), /尚未完整/);
  assert.equal(await readFile(document.path, 'utf8'), invalid);
  const draft = await restored.readDocument(workspace.id);
  assert.equal(draft.markdown, invalid);
  const fixed = await restored.writeDocument(workspace.id, document.markdown, draft.revision);
  assert.equal(fixed.graphs[0].nodes.find(item => item.id === node.id)!.pinned, true);
  assert.equal(fixed.graphs[0].nodes.find(item => item.id === node.id)!.markdown, '恢复用卡片的正文。');
  assert.equal(fixed.graphs[0].nodes[0].images[0].imageDataUrl, PNG);
});

test('Markdown 图片只能读取当前 assets，拒绝路径逃逸及目录符号链接', async t => {
  const { store, workspace, directory } = await fixture(t);
  const document = await store.readDocument(workspace.id);
  for (const reference of ['../secret.png', 'assets/../secret.png', 'assets/%2e%2e/secret.png', 'C:/secret.png', 'https://example.com/secret.png']) {
    await assert.rejects(store.writeDocument(workspace.id, document.markdown + `\n![外部](${reference})\n`, document.revision), /assets/);
  }
  const external = path.join(directory, 'external-images'); await mkdir(external);
  await writeFile(path.join(external, 'private.png'), Buffer.from(PNG.split(',')[1], 'base64'));
  await symlink(external, path.join(store.getDirectory(workspace.id), 'assets', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(store.writeDocument(workspace.id, document.markdown + '\n![外部](assets/linked/private.png)\n', document.revision), /超出/);
  assert.equal((await store.readDocument(workspace.id)).markdown, document.markdown);
});

test('深层树与代码块中的标题能往返，Markdown 标题本身不限制树深度', async t => {
  const { store, workspace, load } = await fixture(t);
  let parentId = workspace.graphs[0].rootId;
  const added: GraphNode[] = [];
  for (let index = 0; index < 8; index++) {
    const result = await addCard(store, workspace, '第 ' + index + ' 层', parentId); parentId = result.node.id; added.push(result.node);
  }
  const last = added.at(-1)!;
  await store.mutate(workspace.id, { type: 'edit', graphId: workspace.graphs[0].id, nodeId: last.id, title: last.title,
    markdown: '文字\n\n```markdown\n## 只是代码\n### 也是代码\n```\n\n#### 正文内的小标题', contentRevision: last.contentRevision });
  const document = await store.readDocument(workspace.id);
  const roundtrip = await store.writeDocument(workspace.id, document.markdown, document.revision);
  assert.equal(roundtrip.graphs.length, 1); assert.equal(roundtrip.graphs[0].nodes.length, 9);
  assert.equal(roundtrip.graphs[0].nodes.at(-1)!.parentId, added.at(-2)!.id);
  assert.match(roundtrip.graphs[0].nodes.at(-1)!.markdown, /## 只是代码/);
  await store.dispose();
  assert.equal((await (await load()).open(workspace.id)).graphs[0].nodes.length, 9);
});

test('逆序深树保留完整子树，循环与断链事务拒绝后仍可删除正确分支', async t => {
  const { store, workspace } = await fixture(t), graph = workspace.graphs[0];
  const nodes: GraphNode[] = Array.from({ length: 512 }, (_, index) => ({
    id: `depth-${index}`, parentId: index ? `depth-${index - 1}` : graph.rootId, kind: 'card',
    title: `第 ${index} 层`, markdown: '正文', images: [], annotations: [], pinned: false,
    x: 0, y: index, contentRevision: 1, status: 'idle',
  }));
  const sibling: GraphNode = { ...nodes[0], id: 'other-branch', title: '旁支' };
  const saved = await store.update(workspace.id, draft => { draft.graphs[0].nodes.push(...nodes.toReversed(), sibling); });
  assert.equal(saved.graphs[0].nodes.length, 514);
  for (const [parentId, message] of [['depth-511', /循环/], ['missing-parent', /父节点/]] as const) {
    await assert.rejects(store.update(workspace.id, draft => {
      draft.graphs[0].nodes.find(node => node.id === 'depth-0')!.parentId = parentId;
    }), message);
  }
  assert.equal((await store.open(workspace.id)).revision, saved.revision);
  const deleted = await store.mutate(workspace.id, { type: 'delete', graphId: graph.id, nodeId: 'depth-0' });
  assert.deepEqual(deleted.graphs[0].nodes.map(node => node.id), [graph.rootId, sibling.id]);
});

test('批注必须有文字或附图，空白保存不新增批注或覆盖已有内容', async t => {
  const { store, workspace, load } = await fixture(t), graph = workspace.graphs[0];
  const selection = { kind: 'text' as const, text: '选区本身不能替代批注' };
  for (const comment of ['', ' \n\t\u3000']) {
    await assert.rejects(store.mutate(workspace.id, { type: 'annotation', graphId: graph.id, nodeId: graph.rootId,
      annotation: { id: 'empty-note', comment, selection, images: [] } }), /请填写批注或附加截图/);
  }
  assert.equal((await store.open(workspace.id)).revision, workspace.revision);
  const saved = await store.mutate(workspace.id, { type: 'annotation', graphId: graph.id, nodeId: graph.rootId,
    annotation: { id: 'image-note', comment: '', selection, images: [capture.images[0]] } });
  await assert.rejects(store.mutate(workspace.id, { type: 'annotation', graphId: graph.id, nodeId: graph.rootId,
    annotation: { id: 'image-note', comment: '  ', selection, images: [] } }), /请填写批注或附加截图/);
  const restored = await (await load()).open(workspace.id);
  assert.equal(restored.revision, saved.revision);
  assert.equal(restored.graphs[0].nodes[0].annotations.length, 1);
  assert.equal(restored.graphs[0].nodes[0].annotations[0].images?.[0].imageDataUrl, PNG);
});

test('批注、候选稿与删除撤销保持同一关联；非法卡片正文不能破坏文档结构', async t => {
  const { store, workspace, load } = await fixture(t);
  const graphId = workspace.graphs[0].id, rootId = workspace.graphs[0].rootId;
  await store.mutate(workspace.id, { type: 'annotation', graphId, nodeId: rootId,
    annotation: { id: 'note-1', comment: '解释这里', selection: { kind: 'image', imageId: 'screen-1', rect: { x: .1, y: .1, width: .6, height: .5 } } } });
  const { node } = await addCard(store, workspace, '解释');
  await store.update(workspace.id, draft => {
    const root = draft.graphs[0].nodes[0]; root.annotations[0].childId = node.id;
    const child = draft.graphs[0].nodes.find(item => item.id === node.id)!;
    child.status = 'generating'; child.draft = '生成中'; child.candidate = { title: '候选标题', markdown: '候选正文' };
  });
  let edited = await store.mutate(workspace.id, { type: 'annotation', graphId, nodeId: rootId,
    annotation: { id: 'note-1', comment: '改成解释这个区域', selection: { kind: 'image', imageId: 'screen-1', rect: { x: .2, y: .2, width: .4, height: .5 } } } });
  assert.equal(edited.graphs[0].nodes[0].annotations[0].childId, node.id);
  assert.equal(edited.graphs[0].nodes.find(item => item.id === node.id)!.source?.comment, '改成解释这个区域');
  assert.equal(edited.graphs[0].nodes.find(item => item.id === node.id)!.source?.nodeId, rootId);
  let current = await store.mutate(workspace.id, { type: 'delete', graphId, nodeId: node.id });
  assert.equal(current.graphs[0].nodes[0].annotations[0].childId, undefined);
  current = await store.mutate(workspace.id, { type: 'undo' });
  assert.equal(current.graphs[0].nodes[0].annotations[0].childId, node.id);
  current = await store.mutate(workspace.id, { type: 'accept-candidate', graphId, nodeId: node.id });
  const adopted = current.graphs[0].nodes.find(item => item.id === node.id)!;
  assert.equal(adopted.markdown, '候选正文'); assert.equal(adopted.candidate, undefined);
  await assert.rejects(store.mutate(workspace.id, { type: 'edit', graphId, nodeId: node.id, title: adopted.title, markdown: '## 会被误解析成新图', contentRevision: adopted.contentRevision }), /小标题从/);
  await store.update(workspace.id, draft => { draft.graphs[0].nodes.find(item => item.id === node.id)!.status = 'generating'; });
  await store.dispose();
  current = await (await load()).open(workspace.id);
  assert.equal(current.graphs[0].nodes.find(item => item.id === node.id)!.status, 'cancelled');
  assert.equal(current.graphs[0].nodes.find(item => item.id === node.id)!.markdown, '候选正文');
});

test('新图为空白并保留预留根 ID，截图填入当前图，追加截图不重建根节点', async t => {
  const { store, workspace, load } = await fixture(t);
  const created = await store.mutate(workspace.id, { type: 'create-graph', title: '空白图' });
  const empty = created.graphs.at(-1)!;
  assert.equal(empty.nodes.length, 0);
  const document = await store.readDocument(workspace.id);
  assert.match(document.markdown, /## 空白图\s*$/);
  await store.dispose();
  const restored = await load(), reopened = await restored.open(workspace.id);
  assert.equal(reopened.graphs.at(-1)!.rootId, empty.rootId);
  assert.equal(reopened.graphs.at(-1)!.nodes.length, 0);
  let current = await restored.attachCapture(workspace.id, empty.id, capture);
  assert.equal(current.graphs.length, 2);
  assert.equal(current.graphs.at(-1)!.nodes[0].id, empty.rootId);
  assert.equal(current.graphs.at(-1)!.nodes[0].parentId, null);
  assert.equal(current.graphs.at(-1)!.title, '空白图');
  current = await restored.attachCapture(workspace.id, empty.id, capture);
  const root = current.graphs.at(-1)!.nodes[0];
  assert.equal(root.images.length, 4);
  assert.equal(new Set(root.images.map(image => image.id)).size, 4);
  assert.equal(root.id, empty.rootId);
});

test('子树移动到空图后成为卡片根，保留 ID、跨图批注与来源截图；删原图后仍能独立恢复', async t => {
  const { store, workspace, load, directory } = await fixture(t);
  const original = workspace.graphs[0], a = await addCard(store, workspace, '移出的父卡'), b = await addCard(store, workspace, '移出的子卡', a.node.id);
  const selection = { kind: 'image' as const, imageId: 'screen-1', rect: { x: .1, y: .2, width: .4, height: .5 } };
  const attachment = { id: 'annotation-shot', title: '批注附图', imageDataUrl: PNG };
  await store.mutate(workspace.id, { type: 'annotation', graphId: original.id, nodeId: original.rootId,
    annotation: { id: 'move-note', selection, comment: '保留这个原始选区', images: [attachment] } });
  await store.update(workspace.id, draft => {
    const graph = draft.graphs[0], root = graph.nodes[0]; root.annotations[0].childId = a.node.id;
    const child = graph.nodes.find(item => item.id === a.node.id)!;
    child.source = { nodeId: root.id, annotationId: 'move-note', selection, comment: '保留这个原始选区', revision: root.contentRevision, images: structuredClone(root.annotations[0].images) };
    child.status = 'generating'; child.draft = '未完成';
  });
  const created = await store.mutate(workspace.id, { type: 'create-graph', title: '新位置' }), targetId = created.lastGraphId!;
  let moved = await store.mutate(workspace.id, { type: 'move-subtree', graphId: original.id, nodeId: a.node.id, targetGraphId: targetId });
  const target = moved.graphs.find(graph => graph.id === targetId)!;
  assert.equal(target.rootId, a.node.id); assert.equal(target.nodes[0].kind, 'card'); assert.equal(target.nodes[0].parentId, null);
  assert.equal(target.nodes.find(node => node.id === b.node.id)!.parentId, a.node.id);
  assert.equal(target.nodes[0].status, 'cancelled'); assert.equal(target.nodes[0].draft, undefined);
  assert.equal(moved.graphs[0].nodes.some(node => node.id === a.node.id), false);
  assert.equal(moved.graphs[0].nodes[0].annotations[0].childId, a.node.id);
  assert.equal(target.nodes[0].source?.nodeId, original.rootId);
  assert.equal(target.nodes[0].source?.selectionImage?.id, 'screen-1');
  assert.equal(target.nodes[0].source?.images?.[0].id, 'annotation-shot');
  moved = await store.mutate(workspace.id, { type: 'annotation', graphId: original.id, nodeId: original.rootId,
    annotation: { id: 'move-note', selection, comment: '跨图编辑批注仍更新子卡', images: [attachment] } });
  assert.equal(moved.graphs.find(graph => graph.id === targetId)!.nodes[0].source?.comment, '跨图编辑批注仍更新子卡');
  await store.dispose();
  const restored = await load();
  const retained = await restored.open(workspace.id);
  assert.equal(retained.graphs[0].nodes[0].annotations[0].childId, a.node.id);
  assert.equal(retained.graphs.find(graph => graph.id === targetId)!.nodes[0].id, a.node.id);
  moved = await restored.mutate(workspace.id, { type: 'delete', graphId: original.id, nodeId: original.rootId });
  const independent = moved.graphs[0].nodes[0];
  assert.equal(independent.source?.nodeId, undefined); assert.equal(independent.source?.annotationId, undefined);
  assert.equal(independent.source?.selectionImage?.imageDataUrl, PNG);
  assert.equal(independent.source?.images?.[0].imageDataUrl, PNG);
  const state = await readFile(path.join(restored.getDirectory(workspace.id), 'state.json'), 'utf8');
  assert.equal(state.includes('base64,'), false); assert.match(state, /selectionImage/); assert.match(state, /annotation-shot/);
  await restored.dispose();
  const final = await (await load()).open(workspace.id);
  assert.equal(final.graphs[0].rootId, a.node.id);
  assert.equal(final.graphs[0].nodes[0].source?.selectionImage?.imageDataUrl, PNG);
  assert.equal(final.graphs[0].nodes[0].source?.images?.[0].id, 'annotation-shot');
});

test('整图移到已有图时挂在目标根下，原图留空；嵌套截图节点能往返', async t => {
  const { store, workspace, load } = await fixture(t);
  const child = await addCard(store, workspace, '随根移动');
  const created = await store.mutate(workspace.id, { type: 'create-graph', title: '目标图' });
  const targetId = created.lastGraphId!;
  const attached = await store.attachCapture(workspace.id, targetId, { ...capture, images: [{ ...capture.images[0], id: 'target-screen' }] });
  const targetRootId = attached.graphs[1].rootId;
  const moved = await store.mutate(workspace.id, { type: 'move-subtree', graphId: workspace.graphs[0].id, nodeId: workspace.graphs[0].rootId, targetGraphId: targetId });
  assert.equal(moved.graphs[0].nodes.length, 0); assert.notEqual(moved.graphs[0].rootId, workspace.graphs[0].rootId);
  assert.equal(moved.graphs[1].nodes.find(node => node.id === workspace.graphs[0].rootId)!.parentId, targetRootId);
  assert.equal(moved.graphs[1].nodes.find(node => node.id === child.node.id)!.parentId, workspace.graphs[0].rootId);
  await store.dispose();
  const restored = await (await load()).open(workspace.id);
  assert.equal(restored.graphs[0].nodes.length, 0);
  assert.equal(restored.graphs[1].nodes.length, 3);
  assert.equal(restored.graphs[1].nodes.find(node => node.id === workspace.graphs[0].rootId)!.images.length, 2);
});

test('旧布局单位仅加载时归一为238，部分布局更新会同步缩放其余节点', async t => {
  const { store, workspace, load, directory } = await fixture(t);
  const first = await addCard(store, workspace, '第一张'), second = await addCard(store, workspace, '第二张');
  await store.mutate(workspace.id, { type: 'layout', graphId: workspace.graphs[0].id, unit: 238,
    positions: [{ id: first.node.id, x: 100, y: 200 }, { id: second.node.id, x: -300, y: 400 }] });
  await store.dispose();
  const statePath = path.join(store.getDirectory(workspace.id), 'state.json'), legacy = JSON.parse(await readFile(statePath, 'utf8'));
  delete legacy.graphs[0].layoutUnit;
  await writeFile(statePath, JSON.stringify(legacy), 'utf8');
  const restored = await load();
  assert.equal((await restored.open(workspace.id)).graphs[0].layoutUnit, 238);
  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).graphs[0].layoutUnit, 238);
  const scaled = await restored.mutate(workspace.id, { type: 'layout', graphId: workspace.graphs[0].id, unit: 476, positions: [{ id: first.node.id, x: 900, y: 1000 }] });
  assert.equal(scaled.graphs[0].layoutUnit, 476);
  assert.deepEqual([scaled.graphs[0].nodes.find(node => node.id === first.node.id)!.x, scaled.graphs[0].nodes.find(node => node.id === first.node.id)!.y], [900, 1000]);
  assert.deepEqual([scaled.graphs[0].nodes.find(node => node.id === second.node.id)!.x, scaled.graphs[0].nodes.find(node => node.id === second.node.id)!.y], [-600, 800]);
  const appended = await restored.mutate(workspace.id, { type: 'add-card', graphId: workspace.graphs[0].id, parentId: workspace.graphs[0].rootId, title: '新单位下的卡片', markdown: '沿用当前布局基准' });
  assert.equal(appended.graphs[0].nodes.at(-1)!.x, 476 * 1.12);
  assert.equal(appended.graphs[0].nodes.at(-1)!.y, 2 * 476 * (4 / 3 + .1));
});

test('删除已生成批注保留子卡正文与完整来源，取消排队再生成并可重启恢复', async t => {
  const { store, workspace, load } = await fixture(t);
  const graph = workspace.graphs[0], { node } = await addCard(store, workspace, '已经生成的解释');
  const selection = { kind: 'image' as const, imageId: 'screen-1', rect: { x: .1, y: .1, width: .5, height: .5 } };
  await store.mutate(workspace.id, { type: 'annotation', graphId: graph.id, nodeId: graph.rootId,
    annotation: { id: 'removable-note', selection, comment: '保留的解释目标', images: [{ id: 'saved-note-image', title: '补充资料', imageDataUrl: PNG }] } });
  const before = await store.update(workspace.id, draft => {
    const root = draft.graphs[0].nodes[0], child = draft.graphs[0].nodes.find(item => item.id === node.id)!;
    root.annotations[0].childId = child.id;
    child.source = { nodeId: root.id, annotationId: 'removable-note', selection, comment: '保留的解释目标', revision: root.contentRevision, images: structuredClone(root.annotations[0].images) };
    child.status = 'queued'; child.draft = '等待中的新稿';
  });
  const prior = before.graphs[0].nodes.find(item => item.id === node.id)!;
  const after = await store.mutate(workspace.id, { type: 'remove-annotation', graphId: graph.id, nodeId: graph.rootId, annotationId: 'removable-note' });
  const kept = after.graphs[0].nodes.find(item => item.id === node.id)!;
  assert.equal(after.graphs[0].nodes[0].annotations.length, 0);
  assert.equal(kept.markdown, prior.markdown); assert.equal(kept.contentRevision, prior.contentRevision);
  assert.equal(kept.status, 'cancelled'); assert.equal(kept.draft, undefined);
  assert.equal(kept.source?.annotationId, undefined); assert.equal(kept.source?.nodeId, graph.rootId);
  assert.deepEqual(kept.source?.selection, selection); assert.equal(kept.source?.comment, '保留的解释目标');
  assert.equal(kept.source?.selectionImage?.imageDataUrl, PNG); assert.equal(kept.source?.images?.[0].id, 'saved-note-image');
  await store.dispose();
  const restored = (await (await load()).open(workspace.id)).graphs[0].nodes.find(item => item.id === node.id)!;
  assert.equal(restored.markdown, prior.markdown); assert.equal(restored.source?.annotationId, undefined);
  assert.equal(restored.source?.selectionImage?.imageDataUrl, PNG); assert.equal(restored.source?.images?.[0].imageDataUrl, PNG);
});

test('跨图可接根及已有分支，非法落点不改数据，子树按目标层级向右排齐', async t => {
  const { store, workspace, load } = await fixture(t);
  const source = workspace.graphs[0], a = await addCard(store, workspace, '要移动的卡片'), child = await addCard(store, workspace, '一起移动的子卡', a.node.id);
  const created = await store.mutate(workspace.id, { type: 'create-graph', title: '落点图' }), targetId = created.lastGraphId!;
  const attached = await store.attachCapture(workspace.id, targetId, capture), targetRoot = attached.graphs[1].rootId;
  const withLeaf = await store.mutate(workspace.id, { type: 'add-card', graphId: targetId, parentId: targetRoot, title: '指定叶子', markdown: '这里可以接入' });
  const leaf = withLeaf.graphs[1].nodes.at(-1)!;
  const withSide = await store.mutate(workspace.id, { type: 'add-card', graphId: targetId, parentId: targetRoot, title: '旁支', markdown: '保持原位' });
  const side = withSide.graphs[1].nodes.at(-1)!;
  await store.mutate(workspace.id, { type: 'add-card', graphId: targetId, parentId: side.id, title: '更深的旁支', markdown: '不能用最右列决定移动根的位置' });
  await store.mutate(workspace.id, { type: 'layout', graphId: source.id, unit: 238, positions: [{ id: a.node.id, x: -238, y: 0 }, { id: child.node.id, x: -714, y: 0 }] });
  const onRoot = await store.mutate(workspace.id, { type: 'move-subtree', graphId: source.id, nodeId: a.node.id, targetGraphId: targetId, targetNodeId: targetRoot });
  assert.equal(onRoot.graphs[1].nodes.find(node => node.id === a.node.id)!.parentId, targetRoot);
  await store.mutate(workspace.id, { type: 'undo' });
  const before = await store.readDocument(workspace.id);
  await assert.rejects(store.mutate(workspace.id, { type: 'move-subtree', graphId: source.id, nodeId: a.node.id, targetGraphId: targetId, targetNodeId: '不存在的卡片' }), /已被删除/);
  assert.deepEqual(await store.readDocument(workspace.id), before);
  const moved = await store.mutate(workspace.id, { type: 'move-subtree', graphId: source.id, nodeId: a.node.id, targetGraphId: targetId, targetNodeId: leaf.id });
  const target = moved.graphs[1], movedRoot = target.nodes.find(node => node.id === a.node.id)!;
  assert.equal(movedRoot.parentId, leaf.id);
  assert.equal(target.nodes.find(node => node.id === child.node.id)!.parentId, a.node.id);
  assert.equal(moved.graphs[0].nodes.some(node => node.id === a.node.id || node.id === child.node.id), false);
  assert.equal(target.nodes.find(node => node.id === leaf.id)!.x, leaf.x);
  assert.equal(movedRoot.x, leaf.x + target.layoutUnit * 1.12);
  assert.equal(target.nodes.find(node => node.id === child.node.id)!.x, movedRoot.x + target.layoutUnit * 1.12);
  await store.dispose();
  const restored = await (await load()).open(workspace.id);
  assert.equal(restored.graphs[1].nodes.find(node => node.id === a.node.id)!.parentId, leaf.id);
});

test('空图首张输入卡和截图可撤销重做，新输入清空重做栈且允许重新使用预留根', async t => {
  const { store, workspace } = await fixture(t);
  const created = await store.mutate(workspace.id, { type: 'create-graph', title: '输入区' }), graph = created.graphs.at(-1)!;
  const added = await store.mutate(workspace.id, { type: 'add-card', graphId: graph.id, parentId: graph.rootId, title: '输入标题', markdown: '手动输入的正文' });
  const root = added.graphs.at(-1)!.nodes[0];
  assert.equal(root.id, graph.rootId); assert.equal(root.kind, 'card'); assert.equal(root.parentId, null);
  assert.equal((await store.mutate(workspace.id, { type: 'undo' })).graphs.at(-1)!.nodes.length, 0);
  const redone = await store.mutate(workspace.id, { type: 'redo' });
  assert.equal(redone.graphs.at(-1)!.nodes[0].markdown, root.markdown);
  assert.ok(redone.graphs.at(-1)!.nodes[0].contentRevision > root.contentRevision);
  await store.mutate(workspace.id, { type: 'undo' });
  await store.mutate(workspace.id, { type: 'rename-graph', graphId: graph.id, title: '新的输入区' });
  assert.equal((await store.mutate(workspace.id, { type: 'redo' })).graphs.at(-1)!.nodes.length, 0);
  await store.attachCapture(workspace.id, graph.id, capture);
  assert.equal((await store.mutate(workspace.id, { type: 'undo' })).graphs.at(-1)!.nodes.length, 0);
  const screenshot = (await store.mutate(workspace.id, { type: 'redo' })).graphs.at(-1)!.nodes[0];
  assert.equal(screenshot.id, graph.rootId); assert.equal(screenshot.images[0].imageDataUrl, PNG);
});

test('批量生成只记录一次结构历史，撤销后重做恢复实际成稿与依赖子树且不重启任务', async t => {
  const { store, workspace } = await fixture(t), graph = workspace.graphs[0];
  for (let index = 0; index < 2; index++) await store.mutate(workspace.id, { type: 'annotation', graphId: graph.id, nodeId: graph.rootId,
    annotation: { id: 'batch-note-' + index, selection: { kind: 'text', text: '截图中的文本 ' + index }, comment: '请解释' } });
  await store.update(workspace.id, draft => {
    const current = draft.graphs[0], root = current.nodes[0];
    for (const [index, annotation] of root.annotations.entries()) {
      const id = 'batch-card-' + index; annotation.childId = id;
      current.nodes.push({ id, parentId: root.id, kind: 'card', title: '等待解释', markdown: '', images: [], annotations: [], pinned: false, x: 0, y: 0,
        contentRevision: 0, status: 'queued', source: { nodeId: root.id, annotationId: annotation.id, selection: structuredClone(annotation.selection), comment: annotation.comment, revision: root.contentRevision } });
    }
  }, true);
  const completed = await store.update(workspace.id, draft => {
    const current = draft.graphs[0], first = current.nodes.find(node => node.id === 'batch-card-0')!, second = current.nodes.find(node => node.id === 'batch-card-1')!;
    first.title = '已完成的模型标题'; first.markdown = '必须保留的完整模型正文'; first.status = 'idle';
    second.status = 'generating'; second.draft = '尚未完成';
    current.nodes.push({ ...structuredClone(first), id: 'dependent-card', parentId: first.id, title: '后续依赖', markdown: '依赖正文', source: undefined });
  });
  const undone = await store.mutate(workspace.id, { type: 'undo' });
  assert.equal(undone.graphs[0].nodes.length, 1); assert.ok(undone.graphs[0].nodes[0].annotations.every(annotation => !annotation.childId));
  await store.update(workspace.id, draft => { draft.graphs[0].nodes[0].markdown = '与这次撤销无关的新内容'; });
  await store.mutate(workspace.id, { type: 'view', graphId: graph.id, view: { x: 45, y: 80, zoom: 1.2 } });
  const redone = await store.mutate(workspace.id, { type: 'redo' }), nodes = redone.graphs[0].nodes;
  assert.equal(nodes.length, 4);
  assert.equal(nodes.find(node => node.id === 'batch-card-0')!.markdown, '必须保留的完整模型正文');
  assert.equal(nodes.find(node => node.id === 'dependent-card')!.markdown, '依赖正文');
  assert.equal(nodes.find(node => node.id === 'batch-card-1')!.status, 'cancelled');
  assert.equal(nodes.find(node => node.id === 'batch-card-1')!.draft, undefined);
  assert.equal(nodes[0].markdown, '与这次撤销无关的新内容'); assert.equal(redone.graphs[0].view.x, 45);
  assert.ok(nodes.find(node => node.id === 'batch-card-0')!.contentRevision > completed.graphs[0].nodes.find(node => node.id === 'batch-card-0')!.contentRevision);
});

test('撤销重挂合并保留后来生成的正文，自动布局不阻塞重做，固定撤销不打断无关任务', async t => {
  const { store, workspace } = await fixture(t), graph = workspace.graphs[0];
  const a = await addCard(store, workspace, 'A'), b = await addCard(store, workspace, 'B'), c = await addCard(store, workspace, 'B的原有分支', b.node.id);
  await store.mutate(workspace.id, { type: 'reparent', graphId: graph.id, nodeId: a.node.id, parentId: b.node.id });
  await store.update(workspace.id, draft => {
    const nodes = draft.graphs[0].nodes;
    Object.assign(nodes.find(node => node.id === a.node.id)!, { title: '新生成标题', markdown: '重挂之后完成的正文', status: 'generating', draft: '下一轮片段' });
    Object.assign(nodes.find(node => node.id === c.node.id)!, { markdown: '并行完成的旁支正文', status: 'generating', draft: '仍在继续' });
  });
  let current = await store.mutate(workspace.id, { type: 'undo' });
  assert.equal(current.graphs[0].nodes.find(node => node.id === a.node.id)!.parentId, graph.rootId);
  assert.equal(current.graphs[0].nodes.find(node => node.id === a.node.id)!.markdown, '重挂之后完成的正文');
  assert.equal(current.graphs[0].nodes.find(node => node.id === a.node.id)!.status, 'cancelled');
  assert.equal(current.graphs[0].nodes.find(node => node.id === c.node.id)!.status, 'generating');
  await store.mutate(workspace.id, { type: 'layout', graphId: graph.id, unit: 400, positions: [{ id: a.node.id, x: 1234, y: 456 }] });
  current = await store.mutate(workspace.id, { type: 'redo' });
  assert.equal(current.graphs[0].nodes.find(node => node.id === a.node.id)!.parentId, b.node.id);
  assert.equal(current.graphs[0].nodes.find(node => node.id === a.node.id)!.markdown, '重挂之后完成的正文');
  await store.mutate(workspace.id, { type: 'pin', graphId: graph.id, nodeId: c.node.id, pinned: true });
  current = await store.mutate(workspace.id, { type: 'undo' });
  assert.equal(current.graphs[0].nodes.find(node => node.id === c.node.id)!.status, 'generating');
  await store.update(workspace.id, draft => { Object.assign(draft.graphs[0].nodes.find(node => node.id === c.node.id)!, { status: 'idle', markdown: '最终旁支正文' }); });
  current = await store.mutate(workspace.id, { type: 'redo' });
  assert.equal(current.graphs[0].nodes.find(node => node.id === c.node.id)!.pinned, true);
  assert.equal(current.graphs[0].nodes.find(node => node.id === c.node.id)!.markdown, '最终旁支正文');
});

test('Markdown保存可撤销重做且保留无关模型结果，同字段外部修改会阻止覆盖', async t => {
  const { store, workspace } = await fixture(t);
  const a = await addCard(store, workspace, '文档编辑卡片'), b = await addCard(store, workspace, '并行模型卡片');
  let document = await store.readDocument(workspace.id);
  await store.writeDocument(workspace.id, document.markdown.replace('文档编辑卡片的正文。', '在Markdown窗口改过的正文'), document.revision);
  await store.update(workspace.id, draft => { draft.graphs[0].nodes.find(node => node.id === b.node.id)!.markdown = '异步模型新结果'; });
  let current = await store.mutate(workspace.id, { type: 'undo' });
  assert.equal(current.graphs[0].nodes.find(node => node.id === a.node.id)!.markdown, a.node.markdown);
  assert.equal(current.graphs[0].nodes.find(node => node.id === b.node.id)!.markdown, '异步模型新结果');
  current = await store.mutate(workspace.id, { type: 'redo' });
  assert.equal(current.graphs[0].nodes.find(node => node.id === a.node.id)!.markdown, '在Markdown窗口改过的正文');
  document = await store.readDocument(workspace.id);
  const external = document.markdown.replace('在Markdown窗口改过的正文', '外部编辑器刚写的新稿');
  await writeFile(document.path, external, 'utf8');
  await assert.rejects(store.mutate(workspace.id, { type: 'undo' }), /之后更新/);
  assert.equal(await readFile(document.path, 'utf8'), external);
  assert.equal((await store.open(workspace.id)).graphs[0].nodes.find(node => node.id === a.node.id)!.markdown, '外部编辑器刚写的新稿');
});

test('工作区改名、撤销重做与外部标题编辑同步文件路径，监听和稳定编号持续有效', async t => {
  const { store, workspace, directory, changes, load } = await fixture(t);
  const original = store.getDirectory(workspace.id);
  assert.equal(original, path.join(directory, '物理阅读'));
  assert.equal((await store.readDocument(workspace.id)).path, path.join(original, '物理阅读.md'));
  await store.mutate(workspace.id, { type: 'rename-workspace', name: '新名称' });
  assert.equal(store.getDirectory(workspace.id), path.join(directory, '新名称'));
  await assert.rejects(stat(original), { code: 'ENOENT' });
  await store.mutate(workspace.id, { type: 'undo' });
  assert.equal(store.getDirectory(workspace.id), original);
  await store.mutate(workspace.id, { type: 'redo' });
  let document = await store.readDocument(workspace.id);
  assert.equal(path.basename(document.path), '新名称.md');
  const changedCount = changes.length;
  await writeFile(document.path, document.markdown.replace('# 新名称', '# 外部名称'), 'utf8');
  await new Promise<void>((resolve, reject) => {
    const started = Date.now(), timer = setInterval(() => {
      if (changes.slice(changedCount).some(value => value.name === '外部名称')) { clearInterval(timer); resolve(); }
      else if (Date.now() - started > 3000) { clearInterval(timer); reject(new Error('改名后监听未同步')); }
    }, 20);
  });
  document = await store.readDocument(workspace.id);
  assert.equal(document.path, path.join(directory, '外部名称', '外部名称.md'));
  await store.writeDocument(workspace.id, document.markdown.replace('# 外部名称', '# 文档保存名称'), document.revision);
  assert.equal((await store.readDocument(workspace.id)).path, path.join(directory, '文档保存名称', '文档保存名称.md'));
  await store.dispose();
  const restored = await load(), reopened = await restored.open();
  assert.equal(reopened.id, workspace.id); assert.equal(reopened.name, '文档保存名称');
  assert.equal(reopened.graphs[0].nodes[0].images[0].imageDataUrl, PNG);
  assert.equal(JSON.parse(await readFile(path.join(restored.getDirectory(workspace.id), 'state.json'), 'utf8')).id, workspace.id);
});

test('磁盘名称兼容Windows规则，同名、清理后同名及已有文件均不覆盖', async t => {
  const { store, directory, workspace, load } = await fixture(t);
  const second = await store.create('物理阅读');
  assert.equal(path.basename(store.getDirectory(second.id)), '物理阅读 (2)');
  const invalid = await store.create('A:B?C*D/E\\F|G< H>". ');
  assert.equal(path.basename(store.getDirectory(invalid.id)), 'A：B？C＊D／E＼F｜G＜ H＞＂');
  const equivalent = await store.create('A：B？C＊D／E＼F｜G＜ H＞＂');
  assert.equal(path.basename(store.getDirectory(equivalent.id)), 'A：B？C＊D／E＼F｜G＜ H＞＂ (2)');
  assert.equal(path.basename(store.getDirectory((await store.create('CON.txt')).id)), '_CON.txt');
  assert.equal(path.basename(store.getDirectory((await store.create('报告'.repeat(100))).id)).length, 80);
  const upper = await store.create('Report'), lower = await store.create('report');
  assert.equal(path.basename(store.getDirectory(lower.id)), 'report (2)');
  await writeFile(path.join(directory, '占用名称'), '不能覆盖的文件');
  const blocked = await store.create('占用名称');
  assert.equal(path.basename(store.getDirectory(blocked.id)), '占用名称 (2)');
  assert.equal(await readFile(path.join(directory, '占用名称'), 'utf8'), '不能覆盖的文件');
  await store.mutate(upper.id, { type: 'rename-workspace', name: 'REPORT' });
  assert.equal(path.basename(store.getDirectory(upper.id)), 'REPORT');
  assert.equal((await store.open(workspace.id)).name, '物理阅读');
  await store.dispose();
  const restored = await load();
  assert.equal((await restored.open(second.id)).name, '物理阅读');
  assert.equal((await restored.open(invalid.id)).name, invalid.name);
});

test('旧UUID目录一次迁为名称目录，保留截图批注状态与最近ID，已有同名目录不覆盖', async t => {
  const { store, workspace, directory, load } = await fixture(t), graph = workspace.graphs[0];
  await store.mutate(workspace.id, { type: 'pin', graphId: graph.id, nodeId: graph.rootId, pinned: true });
  await store.mutate(workspace.id, { type: 'annotation', graphId: graph.id, nodeId: graph.rootId,
    annotation: { id: 'kept-annotation', selection: { kind: 'text', text: '需要理解' }, comment: '保留批注', images: [capture.images[0]] } });
  const oldDirectory = store.getDirectory(workspace.id), document = await store.readDocument(workspace.id);
  await store.dispose();
  const legacy = path.join(directory, workspace.id);
  await rename(document.path, path.join(oldDirectory, 'document.md')); await rename(oldDirectory, legacy);
  const state = JSON.parse(await readFile(path.join(legacy, 'state.json'), 'utf8')); delete state.id;
  await writeFile(path.join(legacy, 'state.json'), JSON.stringify(state));
  await mkdir(oldDirectory); await writeFile(path.join(oldDirectory, '保留.txt'), '其它资料');
  const restored = await load(), reopened = await restored.open();
  assert.equal(reopened.id, workspace.id);
  assert.equal(restored.getDirectory(workspace.id), path.join(directory, '物理阅读 (2)'));
  assert.equal(path.basename((await restored.readDocument(workspace.id)).path), '物理阅读 (2).md');
  assert.equal(reopened.graphs[0].nodes[0].pinned, true);
  assert.equal(reopened.graphs[0].nodes[0].annotations[0].comment, '保留批注');
  assert.equal(reopened.graphs[0].nodes[0].annotations[0].images?.[0].imageDataUrl, PNG);
  assert.equal(reopened.graphs[0].nodes[0].images[0].imageDataUrl, PNG);
  assert.equal(await readFile(path.join(oldDirectory, '保留.txt'), 'utf8'), '其它资料');
  await assert.rejects(stat(legacy), { code: 'ENOENT' });
});

test('旧库无效手稿迁移仍可修复，目录改名中断留下的单份Markdown能保持原ID恢复', async t => {
  const { store, workspace, directory, load } = await fixture(t);
  const document = await store.readDocument(workspace.id), original = store.getDirectory(workspace.id);
  const invalid = document.markdown + '\n<!-- rabbitball:node {"id":"unfinished","parentId":null,"kind":"card"} -->\n';
  await store.dispose();
  await writeFile(document.path, invalid);
  await rename(document.path, path.join(original, 'document.md'));
  const legacy = path.join(directory, workspace.id); await rename(original, legacy);
  const state = JSON.parse(await readFile(path.join(legacy, 'state.json'), 'utf8')); delete state.id;
  await writeFile(path.join(legacy, 'state.json'), JSON.stringify(state));
  let restored = await load();
  assert.equal(restored.list()[0].id, workspace.id);
  const draft = await restored.readDocument(workspace.id);
  assert.equal(draft.markdown, invalid); assert.equal(path.basename(draft.path), '物理阅读.md');
  await restored.writeDocument(workspace.id, document.markdown, draft.revision);
  await restored.dispose();
  // 模拟文件已改名而文件夹还没改名时中断，state里的稳定ID仍已落盘。
  await rename(draft.path, path.join(original, '中断时的新文件名.md'));
  restored = await load();
  const reopened = await restored.open();
  assert.equal(reopened.id, workspace.id); assert.equal(reopened.graphs[0].nodes[0].images[0].imageDataUrl, PNG);
  assert.equal((await restored.readDocument(workspace.id)).path, path.join(original, '物理阅读.md'));
});

test('已知工作区缺少明确文档或出现重复ID时中止加载，不用空工作区掩盖原稿', async t => {
  const { store, workspace, directory, load } = await fixture(t);
  const document = await store.readDocument(workspace.id), workspaceDirectory = store.getDirectory(workspace.id);
  await store.dispose();
  await rename(document.path, path.join(workspaceDirectory, '手稿一.md'));
  await writeFile(path.join(workspaceDirectory, '手稿二.md'), '# 另一份手稿\n');
  await assert.rejects(load(), /无法确定工作区/);
  assert.equal(await readFile(path.join(workspaceDirectory, '手稿一.md'), 'utf8'), document.markdown);
  await rename(path.join(workspaceDirectory, '手稿一.md'), document.path);
  const duplicate = path.join(directory, '重复副本'); await mkdir(duplicate);
  await writeFile(path.join(duplicate, '重复副本.md'), '# 重复副本\n');
  await writeFile(path.join(duplicate, 'state.json'), await readFile(path.join(workspaceDirectory, 'state.json')));
  await assert.rejects(load(), /编号重复/);
  assert.equal(await readFile(document.path, 'utf8'), document.markdown);
  assert.equal(await readFile(path.join(duplicate, '重复副本.md'), 'utf8'), '# 重复副本\n');
});

test('损坏的旁存状态中止加载，保留原始批注数据与名称目录，不重新分配工作区ID', async t => {
  const { store, workspace, load } = await fixture(t), directory = store.getDirectory(workspace.id);
  const document = await store.readDocument(workspace.id), statePath = path.join(directory, 'state.json');
  await store.dispose();
  const broken = '{"id":"' + workspace.id + '","graphs":[{"annotations":"未写完的批注';
  await writeFile(statePath, broken);
  await assert.rejects(load(), /无法读取工作区/);
  assert.equal(await readFile(statePath, 'utf8'), broken);
  assert.equal(await readFile(document.path, 'utf8'), document.markdown);
});


test('根节点支持纯文本和多图混合，沿用预留标识且可撤销、重做和重载', async t => {
  const { store, workspace, load } = await fixture(t);
  const rootIds: string[] = [];
  for (const [title, markdown, images] of [
    ['文字资料', '  第一段文字。\r\n\r\n第二段文字。  ', []],
    ['组合资料', '两张截图的补充说明。', capture.images],
  ] as const) {
    const empty = await store.mutate(workspace.id, { type: 'create-graph', title });
    const graph = empty.graphs.at(-1)!; rootIds.push(graph.rootId);
    const filled = await store.mutate(workspace.id, { type: 'add-root', graphId: graph.id, markdown, images: structuredClone([...images]) });
    const root = filled.graphs.at(-1)!.nodes[0];
    assert.equal(root.id, graph.rootId); assert.equal(root.kind, 'source'); assert.equal(root.parentId, null);
    assert.equal(root.markdown, markdown.replace(/\r\n?/g, '\n').trim());
    assert.equal(root.images.length, images.length);
    assert.equal(filled.lastGraphId, graph.id);
    const undone = await store.mutate(workspace.id, { type: 'undo' });
    assert.equal(undone.graphs.at(-1)!.rootId, graph.rootId); assert.equal(undone.graphs.at(-1)!.nodes.length, 0);
    const redone = await store.mutate(workspace.id, { type: 'redo' });
    assert.ok(redone.graphs.at(-1)!.nodes[0].contentRevision > root.contentRevision);
    assert.deepEqual(redone.graphs.at(-1)!.nodes[0], { ...root, contentRevision: redone.graphs.at(-1)!.nodes[0].contentRevision });
  }
  const document = await store.readDocument(workspace.id);
  assert.match(document.markdown, /第一段文字。\n\n第二段文字。/);
  assert.match(document.markdown, /两张截图的补充说明。/);
  assert.equal(document.markdown.includes('base64,'), false);
  await store.dispose();
  const restored = await (await load()).open(workspace.id), roots = restored.graphs.slice(-2).map(graph => graph.nodes[0]);
  assert.deepEqual(roots.map(root => root.id), rootIds);
  assert.equal(roots[0].markdown, '第一段文字。\n\n第二段文字。'); assert.equal(roots[0].images.length, 0);
  assert.equal(roots[1].markdown, '两张截图的补充说明。'); assert.equal(roots[1].images.length, 2);
  assert.ok(roots[1].images.every(image => image.imageDataUrl === PNG && image.file?.startsWith('assets/')));
});

test('根节点拒绝空白输入、无效图片和覆盖已有内容，拒绝后空图仍可正常创建', async t => {
  const { store, workspace } = await fixture(t);
  const empty = await store.mutate(workspace.id, { type: 'create-graph' }), graph = empty.graphs.at(-1)!;
  await assert.rejects(store.mutate(workspace.id, { type: 'add-root', graphId: graph.id, markdown: ' \n　 ', images: [] }), /请输入文字或添加截图/);
  await assert.rejects(store.mutate(workspace.id, { type: 'add-root', graphId: graph.id, markdown: '', images: [{ id: 'invalid', title: '坏图', imageDataUrl: 'not-an-image' }] }), /截图格式无效/);
  await assert.rejects(store.mutate(workspace.id, { type: 'add-root', graphId: graph.id, markdown: '', images: Array.from({ length: 65 }, () => capture.images[0]) }), /图片附件格式无效/);
  assert.equal((await store.open(workspace.id)).graphs.at(-1)!.nodes.length, 0);
  const filled = await store.mutate(workspace.id, { type: 'add-root', graphId: graph.id, markdown: '', images: structuredClone(capture.images) });
  assert.equal(filled.graphs.at(-1)!.nodes[0].images.length, 2, '多图根不要求额外文字');
  await assert.rejects(store.mutate(workspace.id, { type: 'add-root', graphId: graph.id, markdown: '覆盖原稿', images: [] }), /已有根节点/);
  assert.deepEqual((await store.open(workspace.id)).graphs.at(-1)!.nodes, filled.graphs.at(-1)!.nodes);
});


test('截图根追加图片保留正文、批注和原图片标识，追加可撤销重做并重载', async t => {
  const { store, workspace, load } = await fixture(t), graph = workspace.graphs[0], original = graph.nodes[0];
  let current = await store.mutate(workspace.id, { type: 'edit', graphId: graph.id, nodeId: original.id, title: original.title, markdown: '已有文字说明。', contentRevision: original.contentRevision });
  current = await store.mutate(workspace.id, { type: 'annotation', graphId: graph.id, nodeId: original.id,
    annotation: { id: 'saved-note', selection: { kind: 'image', imageId: original.images[0].id, rect: { x: 0, y: 0, width: .5, height: .5 } }, comment: '已有批注' } });
  const before = current.graphs[0].nodes[0];
  const filled = await store.mutate(workspace.id, { type: 'append-node-images', graphId: graph.id, nodeId: graph.rootId, images: structuredClone(capture.images) });
  const root = filled.graphs[0].nodes[0];
  assert.equal(filled.graphs[0].rootId, graph.rootId); assert.equal(root.id, original.id);
  assert.equal(root.markdown, before.markdown); assert.equal(root.title, before.title); assert.deepEqual(root.annotations, before.annotations);
  assert.deepEqual(root.images.slice(0, 2), before.images); assert.equal(root.images.length, 4);
  assert.equal(new Set(root.images.map(image => image.id)).size, 4, '重复传来的图片ID不能覆盖原图或批注来源');
  const undone = (await store.mutate(workspace.id, { type: 'undo' })).graphs[0].nodes[0];
  assert.deepEqual(undone, { ...before, contentRevision: undone.contentRevision });
  const redone = (await store.mutate(workspace.id, { type: 'redo' })).graphs[0].nodes[0];
  assert.deepEqual(redone, { ...root, contentRevision: redone.contentRevision });
  await store.dispose();
  const restored = (await (await load()).open(workspace.id)).graphs[0].nodes[0];
  assert.equal(restored.id, original.id); assert.equal(restored.markdown, before.markdown);
  assert.deepEqual(restored.annotations, before.annotations); assert.deepEqual(restored.images, root.images);
});

test('根图片追加拒绝空图、空截图、坏图和累计超限，失败不会改写根', async t => {
  const { store, workspace } = await fixture(t), graph = workspace.graphs[0];
  const before = graph.nodes[0];
  await assert.rejects(store.mutate(workspace.id, { type: 'append-node-images', graphId: graph.id, nodeId: graph.rootId, images: [] }), /请添加截图/);
  await assert.rejects(store.mutate(workspace.id, { type: 'append-node-images', graphId: graph.id, nodeId: graph.rootId, images: [{ id: 'bad', title: '坏图', imageDataUrl: 'bad' }] }), /截图格式无效/);
  await assert.rejects(store.mutate(workspace.id, { type: 'append-node-images', graphId: graph.id, nodeId: graph.rootId, images: Array.from({ length: 63 }, () => capture.images[0]) }), /64 张/);
  assert.deepEqual((await store.open(workspace.id)).graphs[0].nodes[0], before);
  const empty = await store.mutate(workspace.id, { type: 'create-graph' });
  await assert.rejects(store.mutate(workspace.id, { type: 'append-node-images', graphId: empty.lastGraphId!, nodeId: empty.graphs.find(g => g.id === empty.lastGraphId)!.rootId, images: capture.images }), /卡片已被删除/);
  assert.equal((await store.open(workspace.id)).graphs.at(-1)!.nodes.length, 0);
});

test('空白自定义卡片连接任意父节点，撤销重做与文档重载保留本源身份', async t => {
  const { store, workspace, load } = await fixture(t), graph = workspace.graphs[0];
  const parent = (await addCard(store, workspace, '已有生成节点')).node;
  const created = await store.mutate(workspace.id, { type: 'add-custom-node', graphId: graph.id, parentId: parent.id, markdown: '', images: [] });
  const custom = created.graphs[0].nodes.at(-1)!;
  assert.equal(custom.parentId, parent.id); assert.equal(custom.kind, 'source'); assert.equal(custom.title, '自定义卡片');
  assert.equal(custom.markdown, ''); assert.deepEqual(custom.images, []); assert.equal(custom.source, undefined);
  assert.equal(custom.x, parent.x + graph.layoutUnit * 1.12);
  assert.equal((await store.mutate(workspace.id, { type: 'undo' })).graphs[0].nodes.some(n => n.id === custom.id), false);
  assert.equal((await store.mutate(workspace.id, { type: 'redo' })).graphs[0].nodes.at(-1)!.id, custom.id);
  const following = (await addCard(store, workspace, '后续卡片', custom.id)).node;
  await store.dispose();
  const reloadedGraph = (await (await load()).open(workspace.id)).graphs[0];
  assert.equal(reloadedGraph.nodes.find(n => n.id === following.id)!.markdown, '后续卡片的正文。');
  assert.equal(reloadedGraph.nodes.find(n => n.id === following.id)!.parentId, custom.id);
  const restored = reloadedGraph.nodes.find(n => n.id === custom.id)!;
  assert.equal(restored.kind, 'source'); assert.equal(restored.parentId, parent.id); assert.equal(restored.markdown, ''); assert.deepEqual(restored.images, []);
});

test('自定义卡片追加图片和文字后可带批注跨图移动，重载保留资料', async t => {
  const { store, workspace, load } = await fixture(t), graph = workspace.graphs[0];
  const created = await store.mutate(workspace.id, { type: 'add-custom-node', graphId: graph.id, parentId: graph.rootId, markdown: '资料原文', images: structuredClone(capture.images) });
  const custom = created.graphs[0].nodes.at(-1)!;
  const appended = await store.mutate(workspace.id, { type: 'append-node-images', graphId: graph.id, nodeId: custom.id, images: structuredClone(capture.images) });
  const updated = appended.graphs[0].nodes.at(-1)!;
  assert.equal(updated.images.length, 4); assert.equal(new Set(updated.images.map(i => i.id)).size, 4);
  const undone = (await store.mutate(workspace.id, { type: 'undo' })).graphs[0].nodes.find(n => n.id === custom.id)!;
  assert.deepEqual(undone.images, custom.images); assert.equal(undone.kind, 'source');
  const redone = (await store.mutate(workspace.id, { type: 'redo' })).graphs[0].nodes.find(n => n.id === custom.id)!;
  assert.deepEqual(redone.images, updated.images); assert.equal(redone.parentId, graph.rootId);
  updated.contentRevision = redone.contentRevision;
  await store.mutate(workspace.id, { type: 'edit', graphId: graph.id, nodeId: custom.id, title: '我的资料', markdown: '补充的资料原文', contentRevision: updated.contentRevision });
  await store.mutate(workspace.id, { type: 'annotation', graphId: graph.id, nodeId: custom.id, annotation: { id: 'custom-note', comment: '分析这份资料', selection: { kind: 'text', text: '补充的资料原文' } } });
  const blank = await store.mutate(workspace.id, { type: 'create-graph' }), targetId = blank.lastGraphId!;
  const moved = await store.mutate(workspace.id, { type: 'move-subtree', graphId: graph.id, nodeId: custom.id, targetGraphId: targetId });
  assert.equal(moved.graphs.find(g => g.id === targetId)!.rootId, custom.id);
  await store.dispose();
  const restored = (await (await load()).open(workspace.id)).graphs.find(g => g.id === targetId)!.nodes[0];
  assert.equal(restored.kind, 'source'); assert.equal(restored.parentId, null); assert.equal(restored.source, undefined);
  assert.equal(restored.title, '我的资料'); assert.equal(restored.markdown, '补充的资料原文'); assert.deepEqual(restored.images, updated.images);
  assert.equal(restored.annotations[0].comment, '分析这份资料');
});

test('自定义卡片拒绝无效父节点、坏图片及超限附件，失败不留节点', async t => {
  const { store, workspace } = await fixture(t), graph = workspace.graphs[0];
  const base = { type: 'add-custom-node' as const, graphId: graph.id, parentId: graph.rootId, markdown: '', images: [] };
  await assert.rejects(store.mutate(workspace.id, { ...base, parentId: 'missing' }), /已被删除/);
  await assert.rejects(store.mutate(workspace.id, { ...base, images: [{ id: 'bad', title: '坏图', imageDataUrl: 'bad' }] }), /截图格式无效/);
  await assert.rejects(store.mutate(workspace.id, { ...base, images: Array.from({ length: 65 }, () => capture.images[0]) }), /图片附件格式无效/);
  assert.deepEqual((await store.open(workspace.id)).graphs[0], graph);
});
