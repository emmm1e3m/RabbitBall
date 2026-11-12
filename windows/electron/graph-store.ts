import { watch, type FSWatcher } from 'node:fs';
import { mkdir, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { CaptureContext, CaptureImage } from './contracts.js';
import type { GraphAnnotation, GraphDocument, GraphImage, GraphMutation, GraphNode, GraphSelection, GraphSource, GraphWorkspace, GraphWorkspaceSummary, KnowledgeGraph } from './graph-contracts.js';

const LEGACY_DOCUMENT = 'document.md';
const MAX_DOCUMENT = 8 * 1024 * 1024;
const MAX_IMAGE = 24 * 1024 * 1024;
const ID = /^[a-zA-Z0-9_-]{1,100}$/;
const GRAPH_MARKER = /^<!-- rabbitball:graph (.+) -->$/;
const NODE_MARKER = /^<!-- rabbitball:node (.+) -->$/;
const DEFAULT_LAYOUT_UNIT = 238;

type StoredImage = Omit<GraphImage, 'imageDataUrl'> & { file: string };
type StoredAnnotation = Omit<GraphAnnotation, 'images'> & { images?: StoredImage[] };
type StoredSource = Omit<GraphSource, 'images' | 'selectionImage'> & { images?: StoredImage[]; selectionImage?: StoredImage };
type StoredNode = Omit<GraphNode, 'title' | 'markdown' | 'images' | 'annotations' | 'source'> & {
  images: StoredImage[];
  annotations: StoredAnnotation[];
  source?: StoredSource;
  fingerprint: string;
};
interface StoredState {
  version: 1;
  id?: string;
  revision: number;
  updatedAt: number;
  lastGraphId?: string;
  documentHash: string;
  graphs: Array<{ id: string; view: KnowledgeGraph['view']; layoutInitialized: boolean; layoutUnit: number; updatedAt: number; nodes: StoredNode[] }>;
}
type FieldChanges = Record<string, { before: unknown; after: unknown }>;
type GraphHeader = Omit<KnowledgeGraph, 'nodes'>;
interface SavedEntity { value: GraphHeader | GraphNode | GraphAnnotation; index: number; graphId?: string; unit?: number; nodeId?: string }
type HistoryStep =
  | { type: 'entity'; entity: 'graph' | 'node' | 'annotation'; id: string; before?: SavedEntity; after?: SavedEntity }
  | { type: 'fields'; entity: 'workspace' | 'graph' | 'node' | 'annotation' | 'source'; id?: string; nodeId?: string; changes: FieldChanges }
  | { type: 'move'; id: string; before: { graphId: string; index: number }; after: { graphId: string; index: number } }
  | { type: 'order'; graphId?: string; before: string[]; after: string[] };
type HistoryEntry = HistoryStep[];
interface WorkspaceRecord {
  workspace: GraphWorkspace;
  documentRevision: number;
  markdown: string;
  canonical: string;
  parseError?: Error;
  recoveryState?: StoredState;
  watcher?: FSWatcher;
  timer?: ReturnType<typeof setTimeout>;
  undo: HistoryEntry[];
  redo: HistoryEntry[];
  deleted: Set<string>;
}
interface WorkspaceLocation { directory: string; document: string }

function fileStem(name: string): string {
  const replacements: Record<string, string> = { '<': '＜', '>': '＞', ':': '：', '"': '＂', '/': '／', '\\': '＼', '|': '｜', '?': '？', '*': '＊' };
  let stem = Array.from(name.replace(/[<>:"/\\|?*]/g, char => replacements[char]).replace(/[\x00-\x1f]/g, '').trim()).slice(0, 80).join('').replace(/[. ]+$/, '');
  if (!stem) stem = '未命名工作区';
  if (/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(stem)) stem = '_' + stem;
  return stem;
}

function digest(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
function copy<T>(value: T): T { return structuredClone(value); }
function validId(value: unknown): value is string { return typeof value === 'string' && ID.test(value); }
function label(value: unknown, fallback?: string): string {
  if (typeof value !== 'string') throw new Error('名称必须是文字。');
  const result = value.trim() || fallback;
  if (!result || result.length > 240 || /[\r\n]/.test(result)) throw new Error('名称不能为空，且最多 240 字。');
  return result;
}
function body(value: unknown, max = MAX_DOCUMENT): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > max) throw new Error('内容过长或格式无效。');
  return value.replace(/\r\n?/g, '\n').trim();
}
function cardBodyValid(markdown: string): void {
  let fence: { char: string; length: number } | undefined;
  for (const line of markdown.split('\n')) {
    const trimmed = line.trim(), opening = /^(`{3,}|~{3,})/.exec(trimmed);
    if (fence) {
      if (new RegExp(`^${fence.char}{${fence.length},}\\s*$`).test(trimmed)) fence = undefined;
    } else if (opening) fence = { char: opening[1][0], length: opening[1].length };
    else if (/^#{1,3}\s/.test(line) || /^<!-- rabbitball:(?:graph|node) /.test(trimmed)) throw new Error('卡片标题请单独填写，正文中的小标题从 #### 开始。');
  }
  if (fence) throw new Error('卡片中的代码块尚未结束。');
}
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e7; }
function viewValid(value: KnowledgeGraph['view']): boolean {
  return !!value && finite(value.x) && finite(value.y) && finite(value.zoom) && value.zoom >= .05 && value.zoom <= 8;
}
function fingerprint(node: GraphNode): string {
  return digest(JSON.stringify([node.title, node.markdown, node.images.map(image => [image.file, image.title])]));
}
function freshNode(id: string, kind: GraphNode['kind'], parentId: string | null, title: string): GraphNode {
  return { id, kind, parentId, title, markdown: '', images: [], annotations: [], pinned: false,
    x: 0, y: 0, contentRevision: 1, status: 'idle' };
}
function freshGraph(title = '新图谱'): KnowledgeGraph {
  return { id: randomUUID(), title: label(title), rootId: randomUUID(), nodes: [], view: { x: 0, y: 0, zoom: 1 },
    layoutUnit: DEFAULT_LAYOUT_UNIT, layoutInitialized: false, updatedAt: Date.now() };
}
function storedImage(image: GraphImage): StoredImage {
  const { imageDataUrl: _data, ...metadata } = image;
  if (!image.file) throw new Error('图片附件尚未保存。');
  return { ...metadata, file: image.file };
}
function getGraph(workspace: GraphWorkspace, id: string): KnowledgeGraph {
  const graph = workspace.graphs.find(item => item.id === id);
  if (!graph) throw new Error('找不到这张图。');
  return graph;
}
function getNode(graph: KnowledgeGraph, id: string): GraphNode {
  const node = graph.nodes.find(item => item.id === id);
  if (!node) throw new Error('这张卡片已被删除。');
  return node;
}
function descendants(graph: KnowledgeGraph, id: string): Set<string> {
  const children = new Map<string, string[]>();
  for (const node of graph.nodes) if (node.parentId !== null) {
    const siblings = children.get(node.parentId);
    if (siblings) siblings.push(node.id); else children.set(node.parentId, [node.id]);
  }
  const result = new Set([id]);
  for (const parentId of result) for (const childId of children.get(parentId) ?? []) result.add(childId);
  return result;
}
function retainSources(workspace: GraphWorkspace, previous?: GraphWorkspace): void {
  const nodes = new Map(workspace.graphs.flatMap(graph => graph.nodes.map(node => [node.id, node] as const)));
  const oldNodes = new Map(previous?.graphs.flatMap(graph => graph.nodes.map(node => [node.id, node] as const)) ?? []);
  for (const node of nodes.values()) {
    for (const annotation of node.annotations) if (annotation.childId && !nodes.has(annotation.childId)) delete annotation.childId;
    const source = node.source;
    if (!source) continue;
    if (source.selection.kind === 'image' && source.selectionImage?.id !== source.selection.imageId) {
      const imageId = source.selection.imageId;
      const origin = source.nodeId ? nodes.get(source.nodeId) ?? oldNodes.get(source.nodeId) : undefined;
      const image = origin?.images.find(item => item.id === imageId)
        ?? [...nodes.values(), ...oldNodes.values()].flatMap(item => item.images).find(item => item.id === imageId);
      if (image) source.selectionImage = copy(image);
    }
    if (source.nodeId && !nodes.has(source.nodeId)) delete source.nodeId;
    if (!source.nodeId || source.annotationId && !nodes.get(source.nodeId)?.annotations.some(annotation => annotation.id === source.annotationId)) delete source.annotationId;
  }
}
function validateSelection(value: GraphSelection, node: GraphNode): void {
  if (!value || typeof value !== 'object') throw new Error('选区格式无效。');
  if (value.kind === 'text') {
    if (!body(value.text, 128 * 1024)) throw new Error('请先选择需要解释的文字。');
    if (value.start !== undefined && (!Number.isInteger(value.start) || value.start < 0)) throw new Error('文字选区位置无效。');
    if (value.end !== undefined && (!Number.isInteger(value.end) || value.end < (value.start ?? 0))) throw new Error('文字选区位置无效。');
  } else if (value.kind === 'image') {
    const rect = value.rect;
    if (!node.images.some(image => image.id === value.imageId) || !rect || ![rect.x, rect.y, rect.width, rect.height].every(finite)
      || rect.x < 0 || rect.y < 0 || rect.width <= 0 || rect.height <= 0 || rect.x + rect.width > 1.000001 || rect.y + rect.height > 1.000001) throw new Error('截图选区超出图片范围。');
  } else throw new Error('选区类型无效。');
}
function annotationValid(annotation: GraphAnnotation, node: GraphNode): void {
  if (!annotation || !validId(annotation.id)) throw new Error('批注编号无效。');
  const comment = body(annotation.comment, 64 * 1024);
  validateSelection(annotation.selection, node);
  if (annotation.images !== undefined && (!Array.isArray(annotation.images) || annotation.images.length > 32)) throw new Error('批注最多附加 32 张截图。');
  if (!comment && !annotation.images?.length) throw new Error('请填写批注或附加截图。');
}
function validateWorkspace(workspace: GraphWorkspace): void {
  workspace.name = label(workspace.name);
  if (!Array.isArray(workspace.graphs) || workspace.graphs.length > 1000) throw new Error('工作区中的图过多。');
  const graphIds = new Set<string>(), nodeIds = new Set<string>();
  for (const graph of workspace.graphs) {
    if (!validId(graph.id) || graphIds.has(graph.id)) throw new Error('图编号重复或无效。');
    graphIds.add(graph.id); graph.title = label(graph.title);
    if (!viewValid(graph.view) || !Array.isArray(graph.nodes) || graph.nodes.length > 10000 || !validId(graph.rootId)
      || !finite(graph.layoutUnit) || graph.layoutUnit <= 0) throw new Error('图的视角或卡片数量无效。');
    if (!graph.nodes.length) continue;
    const root = getNode(graph, graph.rootId);
    if (root.parentId !== null) throw new Error('图的根节点不能有父节点。');
    const nodes = new Map(graph.nodes.map(node => [node.id, node]));
    const connected = new Set([root.id]);
    for (const node of graph.nodes) {
      if (!validId(node.id) || nodeIds.has(node.id)) throw new Error('卡片编号重复或无效。');
      nodeIds.add(node.id); node.title = label(node.title); node.markdown = body(node.markdown);
      cardBodyValid(node.markdown);
      if (!finite(node.x) || !finite(node.y) || !Array.isArray(node.images) || !Array.isArray(node.annotations)) throw new Error('卡片数据无效。');
      if (!['source', 'card'].includes(node.kind)) throw new Error('卡片类型无效。');
      if (node.id !== root.id && (!node.parentId || !nodes.has(node.parentId))) throw new Error('卡片缺少有效的父节点。');
      // 已确认连到根的祖先不再重复遍历，流式更新也只需线性校验整棵树。
      const seen = new Set<string>();
      for (let id: string | null = node.id; id !== null && !connected.has(id); id = nodes.get(id)!.parentId) {
        if (seen.has(id)) throw new Error('卡片关系不能形成循环。');
        if (!nodes.has(id)) throw new Error('卡片缺少有效的父节点。');
        seen.add(id);
      }
      for (const id of seen) connected.add(id);
    }
  }
}
function serialize(workspace: GraphWorkspace): string {
  const lines = [`# ${workspace.name}`, ''];
  for (const graph of workspace.graphs) {
    lines.push(`<!-- rabbitball:graph ${JSON.stringify({ id: graph.id, rootId: graph.rootId })} -->`, `## ${graph.title}`, '');
    if (!graph.nodes.length) continue;
    const root = getNode(graph, graph.rootId);
    for (const node of [root, ...graph.nodes.filter(item => item.id !== root.id)]) {
      lines.push(`<!-- rabbitball:node ${JSON.stringify({ id: node.id, parentId: node.parentId, kind: node.kind, ...(node.kind === 'source' ? { title: node.title } : {}) })} -->`);
      if (node.kind === 'card') lines.push(`### ${node.title}`);
      for (const image of node.images) {
        if (!image.file) throw new Error('截图尚未保存。');
        lines.push(`![${image.title.replace(/([\\\[\]])/g, '\\$1').replace(/[\r\n]/g, ' ')}](${image.file})`);
      }
      if (node.markdown) lines.push(node.markdown);
      lines.push('');
    }
  }
  return lines.join('\n').trimEnd() + '\n';
}

function equalValue(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function graphHeader(graph: KnowledgeGraph): GraphHeader { const { nodes: _nodes, ...header } = graph; return header; }
function indexedNodes(workspace: GraphWorkspace) {
  return new Map(workspace.graphs.flatMap(graph => graph.nodes.map((node, index) => [node.id, { node, index, graphId: graph.id, unit: graph.layoutUnit }] as const)));
}
function introducedNodes(before: GraphWorkspace, after: GraphWorkspace): Set<string> {
  const existing = indexedNodes(before);
  return new Set([...indexedNodes(after).keys()].filter(id => !existing.has(id)));
}
function historyDiff(before: GraphWorkspace, after: GraphWorkspace): HistoryEntry {
  const steps: HistoryEntry = [];
  const fields = (entity: 'workspace' | 'graph' | 'node' | 'annotation' | 'source', id: string | undefined, left: object, right: object, keys: string[], nodeId?: string) => {
    const a = left as Record<string, unknown>, b = right as Record<string, unknown>, changes: FieldChanges = {};
    for (const key of keys) if (!equalValue(a[key], b[key])) changes[key] = { before: copy(a[key]), after: copy(b[key]) };
    if (Object.keys(changes).length) steps.push({ type: 'fields', entity, id, nodeId, changes });
  };
  const order = (left: string[], right: string[], graphId?: string) => {
    const common = new Set(left.filter(id => right.includes(id)));
    if (!equalValue(left.filter(id => common.has(id)), right.filter(id => common.has(id)))) steps.push({ type: 'order', graphId, before: left, after: right });
  };
  fields('workspace', undefined, before, after, ['name']);
  for (const id of new Set([...before.graphs, ...after.graphs].map(graph => graph.id))) {
    const a = before.graphs.find(graph => graph.id === id), b = after.graphs.find(graph => graph.id === id);
    if (!a || !b) steps.push({ type: 'entity', entity: 'graph', id,
      before: a ? { value: copy(graphHeader(a)), index: before.graphs.indexOf(a) } : undefined,
      after: b ? { value: copy(graphHeader(b)), index: after.graphs.indexOf(b) } : undefined });
    else { fields('graph', id, a, b, ['title', 'rootId']); order(a.nodes.map(node => node.id), b.nodes.map(node => node.id), id); }
  }
  const left = indexedNodes(before), right = indexedNodes(after);
  for (const id of new Set([...left.keys(), ...right.keys()])) {
    const a = left.get(id), b = right.get(id);
    if (!a || !b) {
      steps.push({ type: 'entity', entity: 'node', id,
        before: a ? { value: copy(a.node), graphId: a.graphId, index: a.index, unit: a.unit } : undefined,
        after: b ? { value: copy(b.node), graphId: b.graphId, index: b.index, unit: b.unit } : undefined });
      continue;
    }
    if (a.graphId !== b.graphId) steps.push({ type: 'move', id, before: { graphId: a.graphId, index: a.index }, after: { graphId: b.graphId, index: b.index } });
    // 位置和生成状态属于派生状态，不让自动布局或流式更新污染输入历史。
    fields('node', id, a.node, b.node, ['parentId', 'kind', 'title', 'markdown', 'images', 'pinned', 'candidate']);
    fields('source', id, a.node.source ?? {}, b.node.source ?? {}, ['nodeId', 'annotationId', 'selection', 'comment', 'revision', 'images', 'selectionImage']);
    for (const annotationId of new Set([...a.node.annotations, ...b.node.annotations].map(annotation => annotation.id))) {
      const x = a.node.annotations.find(annotation => annotation.id === annotationId), y = b.node.annotations.find(annotation => annotation.id === annotationId);
      if (!x || !y) steps.push({ type: 'entity', entity: 'annotation', id: annotationId,
        before: x ? { value: copy(x), nodeId: id, index: a.node.annotations.indexOf(x) } : undefined,
        after: y ? { value: copy(y), nodeId: id, index: b.node.annotations.indexOf(y) } : undefined });
      else fields('annotation', annotationId, x, y, ['selection', 'comment', 'images', 'childId'], id);
    }
  }
  order(before.graphs.map(graph => graph.id), after.graphs.map(graph => graph.id));
  return steps;
}

function applyHistory(workspace: GraphWorkspace, steps: HistoryEntry, forward: boolean): Set<string> {
  const from = forward ? 'before' : 'after', to = forward ? 'after' : 'before';
  const restored = new Set<string>(), affected = new Set<string>(), changedAnnotations = new Map<string, Set<string>>();
  const locate = (id: string) => { const entry = indexedNodes(workspace).get(id); if (!entry) throw new Error('卡片已在之后删除，无法应用这次撤销或重做。'); return entry; };
  const noteChanged = (nodeId: string, id: string) => {
    const ids = changedAnnotations.get(nodeId) ?? new Set<string>(); ids.add(id); changedAnnotations.set(nodeId, ids);
    const childId = locate(nodeId).node.annotations.find(annotation => annotation.id === id)?.childId;
    if (childId) affected.add(childId);
  };
  // 先恢复容器和卡片，再改关联，最后删除，跨图移动不会暂时吞掉仍要保留的子树。
  for (const step of steps) if (step.type === 'entity' && step.entity === 'graph' && !step[from] && step[to]) {
    if (workspace.graphs.some(graph => graph.id === step.id)) throw new Error('原图已存在，无法恢复重复的图。');
    const saved = step[to]!; workspace.graphs.splice(Math.min(saved.index, workspace.graphs.length), 0, { ...copy(saved.value as GraphHeader), nodes: [] });
  }
  for (const step of steps) if (step.type === 'entity' && step.entity === 'node' && !step[from] && step[to]) {
    if (indexedNodes(workspace).has(step.id)) throw new Error('原卡片已存在，无法恢复重复的卡片。');
    const saved = step[to]!, graph = getGraph(workspace, saved.graphId!), node = copy(saved.value as GraphNode);
    const ratio = graph.layoutUnit / saved.unit!; node.x *= ratio; node.y *= ratio; node.contentRevision++;
    if (node.status === 'queued' || node.status === 'generating') node.status = 'cancelled';
    delete node.draft; graph.nodes.splice(Math.min(saved.index, graph.nodes.length), 0, node); graph.layoutInitialized = false; restored.add(node.id);
  }
  for (const step of steps) {
    if (step.type === 'move') {
      const located = locate(step.id), source = getGraph(workspace, located.graphId), destination = getGraph(workspace, step[to].graphId);
      if (source.id !== step[from].graphId) throw new Error('卡片已在之后移到其它图，请先处理新的修改。');
      source.nodes = source.nodes.filter(node => node.id !== step.id); destination.nodes.splice(Math.min(step[to].index, destination.nodes.length), 0, located.node);
      source.layoutInitialized = false; destination.layoutInitialized = false; affected.add(step.id);
    } else if (step.type === 'entity' && step.entity === 'annotation') {
      const saved = step[to] ?? step[from]!, parent = locate(saved.nodeId!).node;
      noteChanged(parent.id, step.id);
      if (!step[to]) parent.annotations = parent.annotations.filter(annotation => annotation.id !== step.id);
      else {
        if (parent.annotations.some(annotation => annotation.id === step.id)) throw new Error('批注已存在，无法恢复重复的批注。');
        parent.annotations.splice(Math.min(step[to]!.index, parent.annotations.length), 0, copy(step[to]!.value as GraphAnnotation));
      }
    } else if (step.type === 'fields') {
      let target: object;
      if (step.entity === 'workspace') target = workspace;
      else if (step.entity === 'graph') target = getGraph(workspace, step.id!);
      else if (step.entity === 'node') target = locate(step.id!).node;
      else if (step.entity === 'source') { const node = locate(step.id!).node; target = node.source ?? (node.source = {} as GraphSource); affected.add(node.id); }
      else {
        const parent = locate(step.nodeId!).node, annotation = parent.annotations.find(item => item.id === step.id);
        if (!annotation) throw new Error('批注已在之后删除，无法应用这次撤销或重做。');
        target = annotation;
        if (['selection', 'comment', 'images'].some(key => key in step.changes)) noteChanged(parent.id, annotation.id);
      }
      const fields = target as Record<string, unknown>;
      for (const [key, change] of Object.entries(step.changes)) {
        if (!equalValue(fields[key], change[from])) throw new Error('这部分内容已在之后更新，已保留新内容；无法应用这次撤销或重做。');
        if (change[to] === undefined) delete fields[key]; else fields[key] = copy(change[to]);
        if (step.entity === 'node' && ['parentId', 'kind', 'title', 'markdown', 'images'].includes(key)) affected.add(step.id!);
      }
    }
  }
  for (const step of steps) if (step.type === 'entity' && step.entity === 'node' && !step[to]) {
    const located = indexedNodes(workspace).get(step.id);
    if (located) { const graph = getGraph(workspace, located.graphId), ids = descendants(graph, step.id); graph.nodes = graph.nodes.filter(node => !ids.has(node.id)); graph.layoutInitialized = false; }
  }
  for (const step of steps) if (step.type === 'entity' && step.entity === 'graph' && !step[to]) workspace.graphs = workspace.graphs.filter(graph => graph.id !== step.id);
  for (const step of steps) if (step.type === 'order') {
    const items = step.graphId ? getGraph(workspace, step.graphId).nodes : workspace.graphs;
    const ids = new Set(step[to]), ordered = step[to].map(id => items.find(item => item.id === id)).filter(item => item !== undefined);
    let index = 0; for (let slot = 0; slot < items.length; slot++) if (ids.has(items[slot].id)) items[slot] = ordered[index++]! as GraphNode & KnowledgeGraph;
  }
  const remaining = indexedNodes(workspace);
  for (const [nodeId, annotationIds] of changedAnnotations) {
    const parent = remaining.get(nodeId)?.node;
    for (const annotation of parent?.annotations ?? []) if (annotationIds.has(annotation.id) && annotation.childId) {
      const child = remaining.get(annotation.childId)?.node;
      if (!child) continue;
      child.source = { ...child.source, nodeId, annotationId: annotation.id, selection: copy(annotation.selection), comment: annotation.comment,
        revision: child.source?.revision ?? parent!.contentRevision, images: copy(annotation.images) };
      if (annotation.selection.kind !== 'image' || child.source.selectionImage?.id !== annotation.selection.imageId) delete child.source.selectionImage;
      affected.add(child.id);
    }
  }
  for (const { node, graphId } of remaining.values()) {
    if (node.source && !node.source.selection) delete node.source;
    if (affected.has(node.id)) {
      if (node.status === 'queued' || node.status === 'generating') { node.status = 'cancelled'; delete node.draft; }
      getGraph(workspace, graphId).layoutInitialized = false;
    }
  }
  if (!workspace.graphs.some(graph => graph.id === workspace.lastGraphId)) workspace.lastGraphId = workspace.graphs.at(-1)?.id;
  return restored;
}

/** Markdown 保存正文及树关系；旁存文件只记录界面、批注和生成状态。 */
export class GraphStore {
  private readonly directory: string;
  private readonly records = new Map<string, WorkspaceRecord>();
  private readonly locations = new Map<string, WorkspaceLocation>();
  private queue: Promise<unknown> = Promise.resolve();
  private lastWorkspaceId?: string;
  private disposed = false;
  private readonly onChange: (workspace: GraphWorkspace) => void;
  private readonly onError?: (error: Error & { workspaceId?: string }) => void;

  constructor(directory: string, onChange: (workspace: GraphWorkspace) => void,
    onError?: (error: Error & { workspaceId?: string }) => void) {
    this.directory = path.resolve(directory); this.onChange = onChange; this.onError = onError;
  }

  async load(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    try {
      const index = JSON.parse(await readFile(path.join(this.directory, 'index.json'), 'utf8')) as { lastWorkspaceId?: string };
      if (validId(index.lastWorkspaceId)) this.lastWorkspaceId = index.lastWorkspaceId;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.report(error); }
    for (const entry of await readdir(this.directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = path.join(this.directory, entry.name);
      let markdown: string | undefined, state: StoredState | undefined, id = entry.name;
      let record: WorkspaceRecord | undefined;
      try {
        state = JSON.parse(await this.readText(path.join(directory, 'state.json'), MAX_DOCUMENT)) as StoredState;
        if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('工作区状态格式无效。');
        if (!validId(state.id) && !validId(entry.name)) throw new Error('工作区状态缺少稳定编号。');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`无法读取工作区“${entry.name}”的状态，原文件已保留。${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
      try {
        const files = await readdir(directory);
        const candidates = [`${entry.name}.md`, LEGACY_DOCUMENT];
        const document = candidates.find(file => files.includes(file)) ?? (files.filter(file => /\.md$/i.test(file)).length === 1 ? files.find(file => /\.md$/i.test(file)) : undefined);
        if (!document) { if (state) throw new Error(`无法确定工作区“${entry.name}”的 Markdown 文档，请保留一份明确命名的文档。`); continue; }
        id = validId(state?.id) ? state.id : validId(entry.name) ? entry.name : randomUUID();
        if (this.records.has(id)) throw new Error(`工作区编号重复，已保留文件夹“${entry.name}”，请检查重复副本。`);
        this.locations.set(id, { directory, document: path.join(directory, document) });
        markdown = await this.readText(this.location(id).document, MAX_DOCUMENT);
        const { workspace, needsMarkers } = await this.parse(id, markdown, undefined, state);
        const canonical = serialize(workspace), savedMarkdown = needsMarkers ? canonical : markdown;
        if (needsMarkers) {
          if (await this.readText(this.location(id).document, MAX_DOCUMENT) !== markdown) throw new Error('文档正在保存，请稍后重新打开。');
          await this.atomic(this.location(id).document, savedMarkdown);
        }
        record = { workspace, documentRevision: workspace.revision, markdown: savedMarkdown, canonical, undo: [], redo: [], deleted: new Set() };
        // 目录改名前先保存稳定编号，中途退出后仍能认回同一工作区。
        if (state?.id !== id || needsMarkers || (Array.isArray(state?.graphs) && state.graphs.some(graph => !finite(graph.layoutUnit) || graph.layoutUnit <= 0))) await this.writeState(workspace, savedMarkdown);
      } catch (error) {
        if (markdown !== undefined) {
          // 解析失败的手稿仍留在列表中；只有文档编辑能修复，截图和生成不能覆盖它。
          const firstLine = markdown.replace(/^\uFEFF/, '').trimStart().split(/\r?\n/, 1)[0];
          const title = /^#\s+(.+)$/.exec(firstLine)?.[1]?.trim();
          const revision = Number.isSafeInteger(state?.revision) && state!.revision > 0 ? state!.revision + 1 : 1;
          const workspace: GraphWorkspace = { id, name: title && title.length <= 240 ? title : '待修复工作区', revision, updatedAt: Date.now(), graphs: [] };
          record = { workspace, documentRevision: revision, markdown, canonical: serialize(workspace),
            parseError: error instanceof Error ? error : new Error(String(error)), recoveryState: state, undo: [], redo: [], deleted: new Set() };
          if (state?.id !== id) await this.atomic(path.join(directory, 'state.json'), JSON.stringify({ ...state, id }));
        }
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || markdown !== undefined) this.report(error, validId(id) ? id : undefined);
        if (markdown === undefined && state) throw error;
      }
      if (record) {
        await this.relocate(record.workspace.id, record.workspace.name);
        this.records.set(record.workspace.id, record); this.observe(record);
      }
    }
  }

  list(): GraphWorkspaceSummary[] {
    return [...this.records.values()].map(({ workspace }) => ({ id: workspace.id, name: workspace.name, updatedAt: workspace.updatedAt, graphCount: workspace.graphs.length }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async open(id?: string): Promise<GraphWorkspace> {
    const target = id ?? (this.records.has(this.lastWorkspaceId ?? '') ? this.lastWorkspaceId : this.list()[0]?.id);
    if (!target) return this.create('未命名工作区');
    return this.enqueue(async () => {
      const record = this.record(target);
      try { await this.syncExternal(record); }
      catch (error) { if (!record.parseError) throw error; this.report(error, target); }
      await this.remember(target);
      return copy(record.workspace);
    });
  }

  create(name: string): Promise<GraphWorkspace> {
    return this.enqueue(async () => {
      const id = randomUUID(), workspace: GraphWorkspace = { id, name: label(name, '未命名工作区'), revision: 1, updatedAt: Date.now(), graphs: [] };
      const location = await this.availableLocation(workspace.name);
      await mkdir(location.directory); this.locations.set(id, location);
      await mkdir(path.join(location.directory, 'assets'));
      const markdown = serialize(workspace);
      await this.atomic(location.document, markdown);
      await this.writeState(workspace, markdown);
      const record: WorkspaceRecord = { workspace, documentRevision: workspace.revision, markdown, canonical: markdown, undo: [], redo: [], deleted: new Set() };
      this.records.set(id, record); this.observe(record); await this.remember(id); this.onChange(copy(workspace));
      return copy(workspace);
    });
  }

  getDirectory(id: string): string { this.record(id); return this.location(id).directory; }

  attachCapture(id: string, graphId: string, context: CaptureContext): Promise<GraphWorkspace> {
    return this.update(id, workspace => {
      if (!context || !Array.isArray(context.images) || !context.images.length || context.images.length > 64) throw new Error(context?.error || '请先截图。');
      const graph = getGraph(workspace, graphId);
      if (!graph.nodes.length) graph.nodes.push(freshNode(graph.rootId, 'source', null, label(context.title, '屏幕截图')));
      const root = getNode(graph, graph.rootId), used = new Set(root.images.map(image => image.id));
      for (const image of copy(context.images)) {
        if (used.has(image.id)) image.id = randomUUID();
        used.add(image.id); root.images.push(image);
      }
      workspace.lastGraphId = graph.id;
    }, true);
  }

  update(id: string, callback: (workspace: GraphWorkspace) => void, recordHistory = false): Promise<GraphWorkspace> {
    return this.enqueue(async () => {
      const record = this.record(id); await this.syncExternal(record);
      const before = record.workspace, next = copy(before); callback(next);
      const result = await this.commit(record, next, recordHistory ? introducedNodes(before, next) : undefined);
      if (recordHistory) this.rememberChange(record, before);
      return result;
    });
  }

  mutate(id: string, operation: GraphMutation): Promise<GraphWorkspace> {
    return this.enqueue(async () => {
      const record = this.record(id); await this.syncExternal(record);
      if (!operation || typeof operation !== 'object') throw new Error('图谱操作无效。');
      if (operation.type === 'undo' || operation.type === 'redo') return this.replayHistory(record, operation.type === 'redo');
      const before = record.workspace, next = copy(before);
      if (operation.type === 'rename-workspace') next.name = label(operation.name);
      else if (operation.type === 'create-graph') {
        const graph = freshGraph(operation.title === undefined ? '新图谱' : label(operation.title));
        next.graphs.push(graph); next.lastGraphId = graph.id;
      }
      else {
        const graph = getGraph(next, operation.graphId);
        if (operation.type === 'add-root') {
          if (graph.nodes.length) throw new Error('当前图谱已有根节点，请先新建空白图谱。');
          const markdown = body(operation.markdown);
          if (!Array.isArray(operation.images) || operation.images.length > 64) throw new Error('图片附件格式无效。');
          if (!markdown && !operation.images.length) throw new Error('请输入文字或添加截图。');
          const root = freshNode(graph.rootId, 'source', null, graph.title);
          root.markdown = markdown; root.images = copy(operation.images);
          graph.nodes.push(root); next.lastGraphId = graph.id;
        }
        else if (operation.type === 'add-custom-node') {
          const parent = getNode(graph, operation.parentId);
          if (!Array.isArray(operation.images) || operation.images.length > 64) throw new Error('图片附件格式无效。');
          const node = freshNode(randomUUID(), 'source', parent.id, '自定义卡片');
          node.markdown = body(operation.markdown); node.images = copy(operation.images);
          node.x = parent.x + graph.layoutUnit * 1.12;
          node.y = parent.y + graph.nodes.filter(item => item.parentId === parent.id).length * graph.layoutUnit * (4 / 3 + .1);
          graph.nodes.push(node);
        }
        else if (operation.type === 'append-node-images') {
          const node = getNode(graph, operation.nodeId);
          if (!Array.isArray(operation.images) || !operation.images.length || node.images.length + operation.images.length > 64) throw new Error('请添加截图，卡片最多保留 64 张图片。');
          const used = new Set(node.images.map(image => image.id));
          for (const image of copy(operation.images)) {
            if (used.has(image.id)) image.id = randomUUID();
            used.add(image.id); node.images.push(image);
          }
        }
        else if (operation.type === 'rename-graph') graph.title = label(operation.title);
        else if (operation.type === 'visit') next.lastGraphId = graph.id;
        else if (operation.type === 'view') {
          if (!viewValid(operation.view)) throw new Error('画布视角无效。');
          graph.view = copy(operation.view);
        } else if (operation.type === 'layout') {
          if (!Array.isArray(operation.positions) || operation.positions.length > graph.nodes.length) throw new Error('卡片位置无效。');
          if (!finite(operation.unit) || operation.unit <= 0) throw new Error('卡片尺寸基准无效。');
          const scale = operation.unit / graph.layoutUnit;
          for (const node of graph.nodes) { node.x *= scale; node.y *= scale; }
          for (const position of operation.positions) {
            if (!finite(position.x) || !finite(position.y)) throw new Error('卡片位置无效。');
            Object.assign(getNode(graph, position.id), { x: position.x, y: position.y });
          }
          graph.layoutInitialized = true;
          graph.layoutUnit = operation.unit;
        } else if (operation.type === 'add-card') {
          const empty = !graph.nodes.length && operation.parentId === graph.rootId, parent = empty ? undefined : getNode(graph, operation.parentId);
          const node = freshNode(empty ? graph.rootId : randomUUID(), 'card', parent?.id ?? null, label(operation.title));
          node.markdown = body(operation.markdown);
          if (parent) { node.x = parent.x + graph.layoutUnit * 1.12; node.y = parent.y + graph.nodes.filter(item => item.parentId === parent.id).length * graph.layoutUnit * (4 / 3 + .1); }
          graph.nodes.push(node);
        } else {
          const node = getNode(graph, operation.nodeId);
          switch (operation.type) {
            case 'edit':
              if (operation.contentRevision !== node.contentRevision) throw new Error('卡片已更新，请保留当前编辑并重新打开。');
              node.title = label(operation.title); node.markdown = body(operation.markdown); break;
            case 'annotation': {
              annotationValid(operation.annotation, node);
              const index = node.annotations.findIndex(item => item.id === operation.annotation.id);
              const old = node.annotations[index], annotation = copy(operation.annotation);
              // 子卡关联由生成/删除维护，编辑批注时不接受界面传来的新关联。
              if (old?.childId) annotation.childId = old.childId; else delete annotation.childId;
              if (index < 0) node.annotations.push(annotation); else node.annotations[index] = annotation;
              if (old && (old.comment !== annotation.comment || JSON.stringify(old.selection) !== JSON.stringify(annotation.selection) || JSON.stringify(old.images) !== JSON.stringify(annotation.images))) {
                const child = next.graphs.flatMap(item => item.nodes).find(item => item.id === old.childId);
                if (child) child.source = { nodeId: node.id, annotationId: annotation.id, selection: copy(annotation.selection), comment: annotation.comment, revision: node.contentRevision, images: copy(annotation.images) };
              }
              break;
            }
            case 'remove-annotation': {
              const annotation = node.annotations.find(item => item.id === operation.annotationId);
              const child = next.graphs.flatMap(item => item.nodes).find(item => item.id === annotation?.childId);
              if (child && (child.status === 'queued' || child.status === 'generating')) { child.status = 'cancelled'; delete child.draft; }
              node.annotations = node.annotations.filter(item => item.id !== operation.annotationId);
              break;
            }
            case 'pin':
              if (typeof operation.pinned !== 'boolean') throw new Error('固定状态无效。');
              node.pinned = operation.pinned; break;
            case 'reparent': {
              const parent = getNode(graph, operation.parentId);
              if (node.id === graph.rootId) throw new Error('截图根节点不能重新关联。');
              if (descendants(graph, node.id).has(parent.id)) throw new Error('不能关联到自己或自己的后代。');
              node.parentId = parent.id; break;
            }
            case 'move-subtree': {
              const target = getGraph(next, operation.targetGraphId);
              if (target.id === graph.id) throw new Error('请选择另一张图。');
              const ids = descendants(graph, node.id), moved = graph.nodes.filter(item => ids.has(item.id));
              const targetRoot = target.nodes.find(item => item.id === target.rootId);
              const targetParent = operation.targetNodeId === undefined ? targetRoot : getNode(target, operation.targetNodeId);
              const originY = node.y, ratio = target.layoutUnit / graph.layoutUnit;
              const gapX = target.layoutUnit * 1.12;
              const baseX = targetParent ? targetParent.x + gapX : 0;
              const baseY = targetParent?.y ?? 0;
              // 横向严格按父子层级递增；纵向保留初始行序，界面按实际卡高统一排齐。
              const children = new Map<string, GraphNode[]>();
              for (const item of moved) if (item.id !== node.id) children.set(item.parentId!, [...(children.get(item.parentId!) ?? []), item]);
              const levels = [{ item: node, depth: 0 }];
              for (let index = 0; index < levels.length; index++) {
                const { item, depth } = levels[index]; item.x = baseX + depth * gapX;
                for (const child of children.get(item.id) ?? []) levels.push({ item: child, depth: depth + 1 });
              }
              for (const item of moved) {
                item.y = baseY + (item.y - originY) * ratio;
                if (item.status === 'queued' || item.status === 'generating') item.status = 'cancelled';
                delete item.draft;
              }
              node.parentId = targetParent?.id ?? null;
              if (!targetRoot) { target.rootId = node.id; target.layoutInitialized = false; }
              target.nodes.push(node, ...moved.filter(item => item.id !== node.id)); graph.nodes = graph.nodes.filter(item => !ids.has(item.id));
              if (!graph.nodes.length) { graph.rootId = randomUUID(); graph.layoutInitialized = false; graph.view = { x: 0, y: 0, zoom: 1 }; }
              next.lastGraphId = target.id;
              break;
            }
            case 'delete': {
              const ids = descendants(graph, node.id);
              if (node.id === graph.rootId) next.graphs = next.graphs.filter(item => item.id !== graph.id);
              else graph.nodes = graph.nodes.filter(item => !ids.has(item.id));
              for (const remaining of graph.nodes) for (const annotation of remaining.annotations) if (annotation.childId && ids.has(annotation.childId)) delete annotation.childId;
              if (!next.graphs.some(item => item.id === next.lastGraphId)) next.lastGraphId = next.graphs.at(-1)?.id;
              break;
            }
            case 'accept-candidate':
              if (!node.candidate) throw new Error('没有待采用的新稿。');
              node.title = label(node.candidate.title); node.markdown = body(node.candidate.markdown); delete node.candidate; break;
            default: throw new Error('未知图谱操作。');
          }
        }
      }
      const result = await this.commit(record, next, introducedNodes(before, next));
      if (!['view', 'layout', 'visit'].includes(operation.type)) this.rememberChange(record, before);
      return result;
    });
  }

  readDocument(id: string): Promise<GraphDocument> {
    return this.enqueue(async () => {
      const record = this.record(id);
      try { await this.syncExternal(record); } catch (error) { if (!record.parseError) throw error; }
      return { markdown: record.markdown, revision: record.documentRevision, path: this.location(id).document };
    });
  }

  writeDocument(id: string, markdown: string, revision: number): Promise<GraphWorkspace> {
    return this.enqueue(async () => {
      const record = this.record(id);
      try { await this.syncExternal(record); } catch (error) { if (!record.parseError) throw error; }
      if (record.documentRevision !== revision) throw new Error('文档已发生变化，请保留编辑内容并重新载入。');
      const before = record.workspace;
      const { workspace: next, needsMarkers } = await this.parse(id, markdown, record.recoveryState ? undefined : record.workspace, record.recoveryState);
      const result = await this.commit(record, next, new Set(next.graphs.flatMap(graph => graph.nodes.map(node => node.id))), needsMarkers ? serialize(next) : markdown);
      this.rememberChange(record, before); return result;
    });
  }

  async flush(): Promise<void> {
    await this.enqueue(async () => {
      for (const record of this.records.values()) if (record.timer) {
        clearTimeout(record.timer); record.timer = undefined;
        try { await this.syncExternal(record); } catch (error) { this.report(error, record.workspace.id); }
      }
    });
  }

  async dispose(): Promise<void> {
    for (const record of this.records.values()) { record.watcher?.close(); if (record.timer) clearTimeout(record.timer); record.timer = undefined; }
    await this.queue; this.disposed = true;
  }

  private location(id: string): WorkspaceLocation {
    const location = this.locations.get(id);
    if (!location) throw new Error('找不到工作区文件夹。');
    return location;
  }

  private async availableLocation(name: string, current?: WorkspaceLocation): Promise<WorkspaceLocation> {
    const occupied = new Set((await readdir(this.directory)).map(value => value.toLowerCase()));
    if (current) occupied.delete(path.basename(current.directory).toLowerCase());
    const files = new Set(current ? (await readdir(current.directory)).map(value => value.toLowerCase()) : []);
    if (current) files.delete(path.basename(current.document).toLowerCase());
    const base = fileStem(name);
    for (let suffix = 1; ; suffix++) {
      const stem = suffix === 1 ? base : `${base} (${suffix})`, filename = `${stem}.md`;
      if (occupied.has(stem.toLowerCase()) || files.has(filename.toLowerCase())) continue;
      const directory = path.join(this.directory, stem);
      return { directory, document: path.join(directory, filename) };
    }
  }

  private async relocate(id: string, name: string, record?: WorkspaceRecord): Promise<void> {
    const current = this.location(id), next = await this.availableLocation(name, current);
    if (current.directory === next.directory && current.document === next.document) return;
    record?.watcher?.close();
    if (record?.timer) { clearTimeout(record.timer); record.timer = undefined; }
    const renamedDocument = path.join(current.directory, path.basename(next.document));
    let documentMoved = false;
    try {
      if (current.document !== renamedDocument) { await rename(current.document, renamedDocument); documentMoved = true; }
      if (current.directory !== next.directory) await rename(current.directory, next.directory);
      this.locations.set(id, next);
    } catch (error) {
      if (documentMoved) await rename(renamedDocument, current.document);
      throw new Error(`工作区文件改名失败，原文件仍保留。${error instanceof Error ? error.message : String(error)}`, { cause: error });
    } finally {
      if (record) this.observe(record);
    }
  }

  private record(id: string): WorkspaceRecord {
    const record = this.records.get(id);
    if (!record) throw new Error('找不到这个工作区。');
    return record;
  }

  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('图谱存储已关闭。'));
    const result = this.queue.then(run); this.queue = result.catch(() => {}); return result;
  }

  private rememberChange(record: WorkspaceRecord, before: GraphWorkspace): void {
    const patch = historyDiff(before, record.workspace);
    if (!patch.length) return;
    record.undo.push(patch); if (record.undo.length > 20) record.undo.shift(); record.redo = [];
  }

  private async replayHistory(record: WorkspaceRecord, forward: boolean): Promise<GraphWorkspace> {
    const source = forward ? record.redo : record.undo, destination = forward ? record.undo : record.redo, entry = source.at(-1);
    if (!entry) return copy(record.workspace);
    const before = record.workspace, next = copy(before), restored = applyHistory(next, entry, forward);
    const result = await this.commit(record, next, restored);
    // 使用撤销瞬间的实际内容构造逆操作，重做能恢复稍后完成的模型正文和依赖子树。
    const reverse = forward ? historyDiff(before, record.workspace) : historyDiff(record.workspace, before);
    source.pop(); if (reverse.length) { destination.push(reverse); if (destination.length > 20) destination.shift(); }
    return result;
  }

  private async commit(record: WorkspaceRecord, next: GraphWorkspace, restored?: Set<string>, exactMarkdown?: string): Promise<GraphWorkspace> {
    const previous = record.workspace;
    if (next.id !== previous.id) throw new Error('工作区编号不能修改。');
    retainSources(next, previous);
    validateWorkspace(next);
    const oldNodes = new Map(previous.graphs.flatMap(graph => graph.nodes.map(node => [node.id, node] as const)));
    for (const graph of next.graphs) for (const node of graph.nodes) {
      if (!oldNodes.has(node.id) && record.deleted.has(node.id) && !restored?.has(node.id)) throw new Error('已删除卡片的生成任务已失效。');
      const before = oldNodes.get(node.id);
      // 用户直接编辑卡片时，也需把新插入的本地图片纳入同一资源校验。
      if (/^!\[/m.test(node.markdown)) await this.extractImages(next.id, node, before?.images ?? []);
      await this.saveImages(next.id, node.images, before?.images);
      for (const annotation of node.annotations) await this.saveImages(next.id, annotation.images ?? [], before?.annotations.find(item => item.id === annotation.id)?.images);
      if (node.source) {
        await this.saveImages(next.id, node.source.images ?? [], before?.source?.images);
        if (node.source.selectionImage) await this.saveImages(next.id, [node.source.selectionImage], before?.source?.selectionImage ? [before.source.selectionImage] : []);
      }
      node.contentRevision = before ? before.contentRevision + Number(fingerprint(before) !== fingerprint(node)) : Math.max(1, node.contentRevision || 1);
    }
    const canonical = serialize(next), markdown = exactMarkdown ?? (canonical === record.canonical ? record.markdown : canonical);
    if (Buffer.byteLength(markdown, 'utf8') > MAX_DOCUMENT) throw new Error('工作区文档超过 8 MB，请拆分工作区。');
    // 比较和旁存都排除图片的 base64，避免每个流式片段重复序列化全部截图。
    const nextState = this.stateFor(next, canonical), oldState = this.stateFor(previous, record.canonical);
    if (JSON.stringify(nextState) === JSON.stringify(oldState) && markdown === record.markdown && !record.parseError) return copy(previous);
    next.revision = previous.revision + 1; next.updatedAt = Math.max(Date.now(), previous.updatedAt + 1);
    for (const graph of next.graphs) {
      const old = oldState.graphs.find(item => item.id === graph.id), current = nextState.graphs.find(item => item.id === graph.id);
      if (!old || JSON.stringify(current) !== JSON.stringify(old) || graph.title !== previous.graphs.find(item => item.id === graph.id)?.title) graph.updatedAt = next.updatedAt;
    }
    // 即使监听事件尚未到达，也不能用内存快照覆盖已经在磁盘改过的手稿。
    const disk = await this.readText(this.location(next.id).document, MAX_DOCUMENT);
    if (disk !== record.markdown) { await this.syncExternal(record); throw new Error('文档刚刚在外部更新，请重试本次操作。'); }
    if (next.name !== previous.name) await this.relocate(next.id, next.name, record);
    if (markdown !== record.markdown) await this.atomic(this.location(next.id).document, markdown);
    await this.writeState(next, markdown);
    const nextIds = new Set(next.graphs.flatMap(graph => graph.nodes.map(node => node.id)));
    for (const id of oldNodes.keys()) if (!nextIds.has(id)) record.deleted.add(id);
    for (const id of restored ?? []) record.deleted.delete(id);
    if (markdown !== record.markdown) record.documentRevision++;
    record.workspace = next; record.markdown = markdown; record.canonical = canonical; record.parseError = undefined; record.recoveryState = undefined;
    this.onChange(copy(next)); return copy(next);
  }

  private observe(record: WorkspaceRecord): void {
    const location = this.location(record.workspace.id);
    record.watcher = watch(location.directory, (_event, file) => {
      if (file && file.toString() !== path.basename(location.document)) return;
      if (record.timer) clearTimeout(record.timer);
      record.timer = setTimeout(() => {
        record.timer = undefined;
        void this.enqueue(() => this.syncExternal(record)).catch(error => this.report(error, record.workspace.id));
      }, 180);
      record.timer.unref();
    });
    record.watcher.on('error', error => this.report(error, record.workspace.id)); record.watcher.unref();
  }

  private async syncExternal(record: WorkspaceRecord): Promise<void> {
    const markdown = await this.readText(this.location(record.workspace.id).document, MAX_DOCUMENT);
    if (markdown === record.markdown) { if (record.parseError) throw record.parseError; return; }
    record.documentRevision++;
    try {
      const { workspace: next, needsMarkers } = await this.parse(record.workspace.id, markdown, record.recoveryState ? undefined : record.workspace, record.recoveryState);
      const canonical = serialize(next), savedMarkdown = needsMarkers ? canonical : markdown;
      if (needsMarkers) {
        if (await this.readText(this.location(next.id).document, MAX_DOCUMENT) !== markdown) throw new Error('文档正在保存，请稍后重试。');
        await this.atomic(this.location(next.id).document, savedMarkdown);
      }
      if (next.name !== record.workspace.name) await this.relocate(next.id, next.name, record);
      const nextIds = new Set(next.graphs.flatMap(graph => graph.nodes.map(node => node.id)));
      for (const graph of record.workspace.graphs) for (const node of graph.nodes) if (!nextIds.has(node.id)) record.deleted.add(node.id);
      for (const id of nextIds) record.deleted.delete(id);
      next.revision = record.workspace.revision + 1; next.updatedAt = Math.max(Date.now(), record.workspace.updatedAt + 1);
      record.workspace = next; record.markdown = savedMarkdown; record.canonical = canonical; record.parseError = undefined; record.recoveryState = undefined;
      await this.writeState(next, savedMarkdown); this.onChange(copy(next));
    } catch (error) {
      // 无效手稿仍可通过外部编辑器修正；任何图谱写操作都会停止，避免吞掉手稿。
      record.markdown = markdown; record.parseError = error instanceof Error ? error : new Error(String(error));
      record.workspace = { ...record.workspace, revision: record.workspace.revision + 1 };
      this.onChange(copy(record.workspace)); throw record.parseError;
    }
  }

  private async parse(id: string, input: string, previous?: GraphWorkspace, state?: StoredState): Promise<{ workspace: GraphWorkspace; needsMarkers: boolean }> {
    if (typeof input !== 'string' || !input.trim() || Buffer.byteLength(input, 'utf8') > MAX_DOCUMENT) throw new Error('Markdown 文档为空或超过 8 MB。');
    const lines = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
    const first = lines.findIndex(line => line.trim());
    if (first < 0 || !/^#\s+\S/.test(lines[first])) throw new Error('文档需要以 # 工作区名称 开始。');
    const savedGraphs = state?.version === 1 && Array.isArray(state.graphs) ? state.graphs : [];
    const oldNodes = new Map(previous?.graphs.flatMap(graph => graph.nodes.map(node => [node.id, node] as const)) ?? []);
    const savedNodes = new Map(savedGraphs.flatMap(graph => Array.isArray(graph.nodes) ? graph.nodes.map(node => [node.id, node] as const) : []));
    const workspace: GraphWorkspace = { id, name: label(lines[first].replace(/^#\s+/, '')), revision: previous?.revision ?? Math.max(1, state?.revision ?? 1),
      updatedAt: previous?.updatedAt ?? state?.updatedAt ?? Date.now(), lastGraphId: previous?.lastGraphId ?? state?.lastGraphId, graphs: [] };
    let graph: KnowledgeGraph | undefined, node: GraphNode | undefined, pendingGraph: { id: string; rootId: string } | undefined;
    let pendingNode: { id: string; parentId: string | null; kind: 'source' | 'card'; title?: string } | undefined;
    let content: string[] = [], fence: { char: string; length: number } | undefined, needsMarkers = false;
    const finishNode = () => { if (node) node.markdown = content.join('\n').trim(); content = []; };
    const startGraph = (title: string) => {
      finishNode();
      if (!pendingGraph) needsMarkers = true;
      const graphId = pendingGraph?.id ?? randomUUID(), rootId = pendingGraph?.rootId ?? randomUUID();
      const old = previous?.graphs.find(item => item.id === graphId), saved = savedGraphs.find(item => item.id === graphId);
      const savedUnit = saved?.layoutUnit;
      graph = { id: graphId, title: label(title), rootId, nodes: [], view: copy(old?.view ?? saved?.view ?? { x: 0, y: 0, zoom: 1 }), layoutInitialized: old?.layoutInitialized ?? saved?.layoutInitialized ?? false,
        layoutUnit: old?.layoutUnit ?? (finite(savedUnit) && savedUnit > 0 ? savedUnit : DEFAULT_LAYOUT_UNIT), updatedAt: old?.updatedAt ?? saved?.updatedAt ?? Date.now() };
      workspace.graphs.push(graph); node = undefined; pendingGraph = undefined;
    };
    const ensureBodyNode = () => {
      if (!graph) startGraph('图谱 1');
      if (!node) { node = freshNode(graph!.rootId, 'source', null, graph!.title); graph!.nodes.push(node); needsMarkers = true; }
    };
    for (let index = first + 1; index < lines.length; index++) {
      const line = lines[index], trimmed = line.trim();
      if (fence) {
        content.push(line);
        if (new RegExp(`^${fence.char === '`' ? '`' : '~'}{${fence.length},}\\s*$`).test(trimmed)) fence = undefined;
        continue;
      }
      const opening = /^(`{3,}|~{3,})/.exec(trimmed);
      if (opening) { ensureBodyNode(); fence = { char: opening[1][0], length: opening[1].length }; content.push(line); continue; }
      const graphMarker = GRAPH_MARKER.exec(trimmed), nodeMarker = NODE_MARKER.exec(trimmed);
      if (graphMarker) {
        if (pendingGraph || pendingNode) throw new Error('结构标记后缺少标题。');
        pendingGraph = JSON.parse(graphMarker[1]);
        if (!pendingGraph || !validId(pendingGraph.id) || !validId(pendingGraph.rootId)) throw new Error('图结构标记无效。');
        continue;
      }
      if (/^##\s+/.test(line)) {
        if (pendingNode) throw new Error('卡片标记后缺少 ### 标题。');
        startGraph(line.replace(/^##\s+/, '')); continue;
      }
      if (pendingGraph && trimmed) throw new Error('图结构标记后需要 ## 图名称。');
      if (nodeMarker) {
        if (!graph || pendingNode) throw new Error('卡片结构标记位置无效。');
        pendingNode = JSON.parse(nodeMarker[1]);
        if (!pendingNode || !validId(pendingNode.id) || !(pendingNode.parentId === null || validId(pendingNode.parentId)) || !['source', 'card'].includes(pendingNode.kind)) throw new Error('卡片结构标记无效。');
        if (pendingNode.kind === 'source') {
          finishNode();
          node = freshNode(pendingNode.id, 'source', pendingNode.parentId, label(pendingNode.title ?? graph.title));
          graph.nodes.push(node); pendingNode = undefined;
        }
        continue;
      }
      if (/^###\s+/.test(line)) {
        if (!graph) startGraph('图谱 1');
        finishNode();
        if (!pendingNode) needsMarkers = true;
        const firstNode = !graph!.nodes.length;
        node = freshNode(pendingNode?.id ?? (firstNode ? graph!.rootId : randomUUID()), 'card', pendingNode ? pendingNode.parentId : firstNode ? null : graph!.rootId, label(line.replace(/^###\s+/, '')));
        graph!.nodes.push(node); pendingNode = undefined; continue;
      }
      if (pendingNode && trimmed) throw new Error('卡片结构标记后需要 ### 标题。');
      if (!node && !trimmed) continue;
      ensureBodyNode();
      content.push(line);
    }
    if (pendingGraph || pendingNode || fence) throw new Error('文档结构尚未完整，请完成标题或代码块后再保存。');
    finishNode();
    for (const currentGraph of workspace.graphs) {
      const ids = new Set(currentGraph.nodes.map(item => item.id));
      if (currentGraph.nodes.length && !ids.has(currentGraph.rootId)) {
        currentGraph.rootId = currentGraph.nodes[0].id; currentGraph.nodes[0].parentId = null; needsMarkers = true;
      }
      for (const current of currentGraph.nodes) {
        const old = oldNodes.get(current.id), saved = savedNodes.get(current.id);
        const stored = old ?? saved;
        if (stored) {
          Object.assign(current, { annotations: copy(stored.annotations ?? []), source: copy(stored.source), pinned: stored.pinned === true,
            x: finite(stored.x) ? stored.x : 0, y: finite(stored.y) ? stored.y : 0, contentRevision: Math.max(1, stored.contentRevision || 1),
            status: stored.status ?? 'idle', draft: stored.draft, candidate: copy(stored.candidate), error: stored.error, generation: copy(stored.generation) });
          if (!previous && (current.status === 'queued' || current.status === 'generating')) current.status = 'cancelled';
          for (const annotation of current.annotations) if (annotation.images) annotation.images = await this.hydrateImages(id, annotation.images);
          if (current.source?.images) current.source.images = await this.hydrateImages(id, current.source.images);
          if (current.source?.selectionImage) current.source.selectionImage = (await this.hydrateImages(id, [current.source.selectionImage]))[0];
          if (current.source?.selection.kind === 'image' && !current.source.selectionImage) {
            const imageId = current.source.selection.imageId;
            const original = [...savedNodes.values()].flatMap(item => item.images).find(image => image.id === imageId);
            if (original) current.source.selectionImage = (await this.hydrateImages(id, [original]))[0];
          }
        }
        await this.extractImages(id, current, old?.images ?? saved?.images ?? []);
        const oldFingerprint = old ? fingerprint(old) : saved?.fingerprint;
        if (oldFingerprint && oldFingerprint !== fingerprint(current)) current.contentRevision++;
        if (current.id !== currentGraph.rootId && (!current.parentId || !ids.has(current.parentId))) {
          current.parentId = currentGraph.rootId;
          needsMarkers = true;
          this.report(new Error(`“${current.title}”的父节点已删除，正文已保留并接回截图根节点。`), id);
        }
      }
    }
    retainSources(workspace, previous);
    if (!workspace.graphs.some(item => item.id === workspace.lastGraphId)) workspace.lastGraphId = workspace.graphs.at(-1)?.id;
    if (!previous && state?.documentHash && state.documentHash !== digest(input)) { workspace.revision++; workspace.updatedAt = Date.now(); }
    validateWorkspace(workspace); return { workspace, needsMarkers };
  }

  private async extractImages(workspaceId: string, node: GraphNode, oldImages: Array<{ id: string; file?: string } & Partial<CaptureImage>>): Promise<void> {
    const lines = node.markdown.split('\n'), remaining: string[] = [];
    const used = new Set<number>();
    let fence: { char: string; length: number } | undefined;
    for (const line of lines) {
      const opening = /^\s*(`{3,}|~{3,})/.exec(line);
      if (fence) {
        if (new RegExp(`^${fence.char}{${fence.length},}\\s*$`).test(line.trim())) fence = undefined;
        remaining.push(line); continue;
      }
      if (opening) { fence = { char: opening[1][0], length: opening[1].length }; remaining.push(line); continue; }
      const image = /^!\[((?:\\.|[^\]])*)\]\(([^\r\n)]+)\)\s*$/.exec(line);
      if (!image) { remaining.push(line); continue; }
      const file = image[2].replace(/^<|>$/g, '');
      const result = await this.readImage(workspaceId, file);
      const title = image[1].replace(/\\([\\\[\]])/g, '$1') || '截图';
      let previousIndex = oldImages.findIndex((item, index) => !used.has(index) && item.file === result.file && item.title === title);
      if (previousIndex < 0) previousIndex = oldImages.findIndex((item, index) => !used.has(index) && item.file === result.file);
      if (previousIndex >= 0) used.add(previousIndex);
      const old = oldImages[previousIndex];
      node.images.push({ ...copy(old), id: old?.id ?? randomUUID(), title, file: result.file, imageDataUrl: result.dataUrl });
    }
    node.markdown = remaining.join('\n').trim();
  }

  private async hydrateImages(workspaceId: string, images: Array<GraphImage | StoredImage>): Promise<GraphImage[]> {
    const result: GraphImage[] = [];
    if (!Array.isArray(images) || images.length > 64) throw new Error('图片附件格式无效。');
    for (const image of images) {
      if (typeof image.file !== 'string') throw new Error('图片附件缺少本地资源路径。');
      const stored = await this.readImage(workspaceId, image.file);
      result.push({ ...copy(image), file: stored.file, imageDataUrl: stored.dataUrl });
    }
    return result;
  }

  private async saveImages(workspaceId: string, images: GraphImage[], previous: GraphImage[] = []): Promise<void> {
    if (!Array.isArray(images) || images.length > 64) throw new Error('图片附件格式无效。');
    for (const image of images) {
      if (image.file) {
        if (previous.some(old => old.id === image.id && old.file === image.file && old.imageDataUrl === image.imageDataUrl)) continue;
        // 即使已有 data URL，也检查引用实际落在本工作区资源目录，防止外部 Markdown 越界。
        const result = await this.readImage(workspaceId, image.file); image.file = result.file; image.imageDataUrl = result.dataUrl; continue;
      }
      if (typeof image.imageDataUrl !== 'string' || image.imageDataUrl.length > MAX_IMAGE * 1.4) throw new Error('截图过大。');
      const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]*={0,2})$/.exec(image.imageDataUrl);
      if (!match) throw new Error('截图格式无效，仅支持 PNG、JPEG 和 WebP。');
      const bytes = Buffer.from(match[2], 'base64');
      this.checkImage(bytes, match[1]);
      image.id = typeof image.id === 'string' && image.id.length <= 240 ? image.id : randomUUID(); image.title = label(image.title, '截图');
      image.file = `assets/${digest(bytes)}.${match[1] === 'jpeg' ? 'jpg' : match[1]}`;
      const target = path.join(this.location(workspaceId).directory, image.file);
      await mkdir(path.dirname(target), { recursive: true });
      const workspaceReal = await realpath(this.location(workspaceId).directory);
      const assetsReal = await realpath(path.dirname(target));
      if (!this.inside(workspaceReal, assetsReal)) throw new Error('资源目录不能指向工作区外部。');
      await writeFile(target, bytes, { flag: 'wx' }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
      // 已存在的同名文件也必须通过真实路径检查，不能沿同名链接写入或读取。
      const result = await this.readImage(workspaceId, image.file); image.imageDataUrl = result.dataUrl;
    }
  }

  private checkImage(bytes: Buffer, type: string): void {
    if (!bytes.length || bytes.length > MAX_IMAGE) throw new Error('截图为空或超过 24 MB。');
    const valid = type === 'png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : type === 'jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
    if (!valid) throw new Error('图片内容与扩展名不一致。');
  }

  private inside(root: string, target: string): boolean { const relative = path.relative(root, target); return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); }

  private async readImage(workspaceId: string, reference: string): Promise<{ file: string; dataUrl: string }> {
    let file: string;
    try { file = decodeURIComponent(reference); } catch { throw new Error('图片路径编码无效。'); }
    if (!/^assets\/[a-zA-Z0-9_./-]+\.(png|jpe?g|webp)$/i.test(file) || file.split('/').some(part => part === '..' || part === '.' || !part)) throw new Error('图片只能引用本工作区 assets 目录中的文件。');
    const workspacePath = this.location(workspaceId).directory, assetsPath = path.join(workspacePath, 'assets');
    const root = await realpath(workspacePath), assets = await realpath(assetsPath), target = await realpath(path.join(workspacePath, file));
    if (!this.inside(root, assets) || !this.inside(assets, target)) throw new Error('图片路径不能超出本工作区 assets 目录。');
    const info = await stat(target);
    if (!info.isFile() || info.size > MAX_IMAGE) throw new Error('图片过大或不是普通文件。');
    const bytes = await readFile(target), extension = path.extname(file).toLowerCase();
    const type = extension === '.jpg' || extension === '.jpeg' ? 'jpeg' : extension.slice(1);
    this.checkImage(bytes, type);
    return { file, dataUrl: `data:image/${type};base64,${bytes.toString('base64')}` };
  }

  private async readText(file: string, maximum: number): Promise<string> {
    const before = await stat(file);
    if (!before.isFile() || before.size > maximum) throw new Error('文档或状态文件过大。');
    const value = await readFile(file, 'utf8'), after = await stat(file);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('文档正在保存，请稍后重试。');
    if (Buffer.byteLength(value, 'utf8') > maximum) throw new Error('文档过大。');
    return value;
  }

  private stateFor(workspace: GraphWorkspace, markdown: string): StoredState {
    return { version: 1, id: workspace.id, revision: workspace.revision, updatedAt: workspace.updatedAt, lastGraphId: workspace.lastGraphId, documentHash: digest(markdown),
      graphs: workspace.graphs.map(graph => ({ id: graph.id, view: graph.view, layoutInitialized: graph.layoutInitialized, layoutUnit: graph.layoutUnit, updatedAt: graph.updatedAt, nodes: graph.nodes.map(node => {
        const { title: _title, markdown: _markdown, images, annotations, source, ...rest } = node;
        return { ...rest, fingerprint: fingerprint(node), images: images.map(storedImage),
          annotations: annotations.map(annotation => ({ ...annotation, images: annotation.images?.map(storedImage) })),
          ...(source ? { source: { ...source, images: source.images?.map(storedImage), selectionImage: source.selectionImage ? storedImage(source.selectionImage) : undefined } } : {}) };
      }) })) };
  }

  private async writeState(workspace: GraphWorkspace, markdown: string): Promise<void> {
    await this.atomic(path.join(this.location(workspace.id).directory, 'state.json'), JSON.stringify(this.stateFor(workspace, markdown)));
  }

  private async remember(id: string): Promise<void> {
    if (this.lastWorkspaceId === id) return;
    this.lastWorkspaceId = id; await this.atomic(path.join(this.directory, 'index.json'), JSON.stringify({ lastWorkspaceId: id }));
  }

  private async atomic(file: string, content: string): Promise<void> {
    const temporary = file + '.tmp'; await writeFile(temporary, content, 'utf8'); await rename(temporary, file);
  }

  private report(error: unknown, workspaceId?: string): void {
    const value = error instanceof Error ? error : new Error(String(error));
    this.onError?.(Object.assign(value, { workspaceId }));
  }
}
