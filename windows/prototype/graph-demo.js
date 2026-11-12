(() => {
  'use strict';
  if (window.rabbitDesktop || window.RabbitGraphDemo) return;

  // 浏览器预览复用生产界面，数据与桌面文档完全分开，也不调用模型。
  const key = 'rabbitball.graph.demo.v1';
  const copy = value => structuredClone(value);
  const uid = () => crypto.randomUUID();
  const listeners = new Set(), errorListeners = new Set(), jobs = new Map(), histories = new Map();
  let state = { active: null, workspaces: [] }, loadError = null;
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const saved = JSON.parse(raw);
      if (!Array.isArray(saved.workspaces) || saved.workspaces.some(w => !w || typeof w.id !== 'string' || typeof w.name !== 'string' || !Array.isArray(w.graphs))) throw new Error('记录格式无效');
      state = saved;
      // 页面关闭时的演示任务不会在新页面中偷偷继续。
      for (const w of state.workspaces) for (const g of w.graphs) {
        if (!Number.isFinite(g.layoutUnit) || g.layoutUnit <= 0) g.layoutUnit = 238;
        for (const n of g.nodes) if (n.status === 'generating' || n.status === 'queued') { n.status = 'cancelled'; delete n.draft; }
      }
    }
  } catch (error) { loadError = '浏览器演示记录暂时无法读取：' + error.message; }

  function report(message, workspaceId) {
    const error = { message: String(message), ...(workspaceId ? { workspaceId } : {}) };
    for (const listener of errorListeners) listener(error);
  }
  function persist(next) {
    try { localStorage.setItem(key, JSON.stringify(next)); }
    catch { throw new Error('浏览器演示存储空间不足，当前修改未能保存。'); }
    state = next;
  }
  function workspace(id = state.active) {
    const value = state.workspaces.find(w => w.id === id);
    if (!value) throw new Error('找不到这个工作区。');
    return copy(value);
  }
  function graph(w, id) {
    const value = w.graphs.find(g => g.id === id);
    if (!value) throw new Error('找不到这张图。');
    return value;
  }
  function node(g, id) {
    const value = g.nodes.find(n => n.id === id);
    if (!value) throw new Error('这张卡片已不存在。');
    return value;
  }
  function label(value, fallback = '') {
    if (typeof value !== 'string' || value.length > 240) throw new Error('名称应为不超过 240 个字的文字。');
    return value.trim() || fallback;
  }
  function text(value) {
    if (typeof value !== 'string' || value.length > 1_000_000) throw new Error('内容格式无效或过长。');
    return value;
  }
  function changed(w, before, active = state.active) {
    w.revision++; w.updatedAt = Date.now();
    const workspaces = state.workspaces.filter(item => item.id !== w.id);
    const index = state.workspaces.findIndex(item => item.id === w.id);
    workspaces.splice(index < 0 ? workspaces.length : index, 0, w);
    // 写入成功后才发布内存、历史和任务变化，配额失败不会留下半次操作。
    persist({ ...state, active, workspaces });
    for (const job of [...jobs.values()]) if (job.request.workspaceId === w.id) {
      const target = w.graphs.find(g => g.id === job.request.graphId)?.nodes.find(n => n.id === job.request.nodeId);
      if (!target || !['queued', 'generating'].includes(target.status)) stopJob(job);
    }
    if (before) {
      const patch = historyPatch(before, w);
      if (patch) { const history = historyFor(w.id); pushHistory(history.undo, patch); history.redo.length = 0; }
    }
    for (const listener of listeners) listener(copy(w));
    return copy(w);
  }
  function addWorkspace(name) {
    const w = { id: uid(), name: label(name, '未命名工作区'), revision: 0, updatedAt: Date.now(), graphs: [] };
    return changed(w, undefined, w.id);
  }
  function newNode(parentId, title, markdown = '', kind = 'card') {
    return { id: uid(), parentId, kind, title, markdown, images: [], annotations: [], pinned: false,
      x: 0, y: 0, contentRevision: 0, status: 'idle' };
  }
  function newGraph(title = '未命名图谱') {
    return { id: uid(), title: label(title, '未命名图谱'), rootId: uid(), nodes: [], view: { x: 0, y: 0, zoom: 1 }, layoutUnit: 238, layoutInitialized: false, updatedAt: Date.now() };
  }
  function saveImages(images) {
    if (!Array.isArray(images)) throw new Error('截图格式无效。');
    return images.map(image => {
      if (typeof image?.imageDataUrl !== 'string' || !/^data:image\/(?:png|jpeg|webp|svg\+xml)[;,]/.test(image.imageDataUrl)) throw new Error('演示截图格式无效。');
      const extension = image.imageDataUrl.startsWith('data:image/svg+xml') ? 'svg' : image.imageDataUrl.startsWith('data:image/jpeg') ? 'jpg' : image.imageDataUrl.startsWith('data:image/webp') ? 'webp' : 'png';
      const id = uid(); return { ...copy(image), id, file: 'assets/' + id + '.' + extension };
    });
  }
  function preserveSources(w) {
    const nodes = w.graphs.flatMap(g => g.nodes), byId = new Map(nodes.map(n => [n.id, n]));
    for (const n of nodes) {
      for (const annotation of n.annotations) if (annotation.childId && !byId.has(annotation.childId)) delete annotation.childId;
      if (!n.source) continue;
      const parent = byId.get(n.source.nodeId), annotation = parent?.annotations.find(a => a.id === n.source.annotationId);
      if (!n.source.images && annotation?.images) n.source.images = copy(annotation.images);
      if (!n.source.selectionImage && n.source.selection.kind === 'image') {
        const image = parent?.images.find(image => image.id === n.source.selection.imageId);
        if (image) n.source.selectionImage = copy(image);
      }
      if (!parent) { delete n.source.nodeId; delete n.source.annotationId; }
    }
  }
  function descendants(g, id) {
    const result = new Set([id]);
    for (let previous = -1; previous !== result.size;) {
      previous = result.size;
      for (const n of g.nodes) if (result.has(n.parentId)) result.add(n.id);
    }
    return result;
  }
  function selection(value, g) {
    if (value?.kind === 'text' && typeof value.text === 'string' && value.text.trim() && value.text.length <= 100_000) {
      const result = { kind: 'text', text: value.text };
      if (Number.isSafeInteger(value.start) && value.start >= 0 && Number.isSafeInteger(value.end) && value.end > value.start) {
        result.start = value.start; result.end = value.end;
      }
      return result;
    }
    if (value?.kind === 'image' && g.nodes.some(n => n.images.some(image => image.id === value.imageId))) {
      const r = value.rect;
      if (r && [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.x >= 0 && r.y >= 0 && r.width > 0 && r.height > 0 && r.x + r.width <= 1.000001 && r.y + r.height <= 1.000001) {
        return { kind: 'image', imageId: value.imageId, rect: { x: r.x, y: r.y, width: r.width, height: r.height } };
      }
    }
    throw new Error('请选择有效的文字或图片区域。');
  }
  function taskKey(request) { return [request.workspaceId, request.graphId, request.nodeId].join(':'); }
  function stopJob(job) {
    clearTimeout(job.timer); jobs.delete(taskKey(job.request));
  }
  function cancel(request) {
    if (!jobs.has(taskKey(request))) return;
    const w = workspace(request.workspaceId), n = node(graph(w, request.graphId), request.nodeId);
    n.status = 'cancelled'; delete n.draft; changed(w);
  }
  // 历史仅保存发生变化的字段；大截图不会随每次固定、重命名重复入栈。
  function historyFor(id) {
    if (!histories.has(id)) histories.set(id, { undo: [], redo: [] });
    return histories.get(id);
  }
  function pushHistory(stack, patch) { stack.push(patch); if (stack.length > 20) stack.shift(); }
  function fields(before, after, ignored = [], path = []) {
    if (JSON.stringify(before) === JSON.stringify(after)) return [];
    if (path.length === 1 && path[0] === 'annotations' && Array.isArray(before) && Array.isArray(after)) {
      return fields(Object.fromEntries(before.map(note => [note.id, note])), Object.fromEntries(after.map(note => [note.id, note])), [], path);
    }
    if (before && after && typeof before === 'object' && typeof after === 'object' && !Array.isArray(before) && !Array.isArray(after)) {
      return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(key => path.length || !ignored.includes(key))
        .flatMap(key => fields(before[key], after[key], [], [...path, key]));
    }
    return [{ path, before: copy(before), after: copy(after) }];
  }
  function graphMeta(g) { const { nodes, updatedAt, ...meta } = g; return meta; }
  function nodeMap(w) { return new Map(w.graphs.flatMap(g => g.nodes.map((n, index) => [n.id, { graphId: g.id, unit: g.layoutUnit, index, node: n }]))); }
  function historyPatch(before, after) {
    const patch = { fields: fields({ name: before.name }, { name: after.name }), graphs: [], nodes: [], orders: [] };
    const order = (a, b, graphId) => {
      const common = new Set(a.filter(id => b.includes(id)));
      if (JSON.stringify(a.filter(id => common.has(id))) !== JSON.stringify(b.filter(id => common.has(id)))) patch.orders.push({ graphId, before: a, after: b });
    };
    const previousGraphs = new Map(before.graphs.map((g, index) => [g.id, { graph: g, index }]));
    const nextGraphs = new Map(after.graphs.map((g, index) => [g.id, { graph: g, index }]));
    for (const id of new Set([...previousGraphs.keys(), ...nextGraphs.keys()])) {
      const a = previousGraphs.get(id), b = nextGraphs.get(id);
      if (!a || !b) patch.graphs.push({ id, before: a ? copy(graphMeta(a.graph)) : null, after: b ? copy(graphMeta(b.graph)) : null, beforeIndex: a?.index, afterIndex: b?.index });
      else {
        const changes = fields({ title: a.graph.title, rootId: a.graph.rootId }, { title: b.graph.title, rootId: b.graph.rootId });
        if (changes.length) patch.graphs.push({ id, fields: changes });
        order(a.graph.nodes.map(n => n.id), b.graph.nodes.map(n => n.id), id);
      }
    }
    const previousNodes = nodeMap(before), nextNodes = nodeMap(after);
    for (const id of new Set([...previousNodes.keys(), ...nextNodes.keys()])) {
      const a = previousNodes.get(id), b = nextNodes.get(id);
      if (!a || !b) patch.nodes.push({ id, before: a ? copy(a) : null, after: b ? copy(b) : null });
      else {
        const changes = fields(a.node, b.node, ['contentRevision', 'status', 'draft', 'error', 'generation', 'x', 'y']);
        if (changes.length || a.graphId !== b.graphId) patch.nodes.push({ id, fields: changes, beforeGraphId: a.graphId, afterGraphId: b.graphId, beforeIndex: a.index, afterIndex: b.index });
      }
    }
    order(before.graphs.map(g => g.id), after.graphs.map(g => g.id));
    return patch.fields.length || patch.graphs.length || patch.nodes.length || patch.orders.length ? patch : null;
  }
  function restoreFields(target, changes) {
    for (const change of changes) {
      let value = target;
      for (const key of change.path.slice(0, -1)) {
        value = Array.isArray(value) ? value.find(item => item.id === key) : value?.[key];
        if (value === undefined) throw new Error('内容已更新，无法撤销这项修改。');
      }
      const key = change.path.at(-1);
      const existing = Array.isArray(value) ? value.find(item => item.id === key) : value[key];
      if (JSON.stringify(existing) !== JSON.stringify(change.after)) throw new Error('内容已更新，无法撤销这项修改。');
      if (Array.isArray(value)) {
        const index = value.findIndex(item => item.id === key);
        if (change.before === undefined) { if (index >= 0) value.splice(index, 1); }
        else if (index >= 0) value[index] = copy(change.before); else value.push(copy(change.before));
      } else if (change.before === undefined) delete value[key]; else value[key] = copy(change.before);
    }
  }
  function restoreHistory(w, patch) {
    const next = copy(w), currentNodes = nodeMap(w), removed = new Set(), affected = new Set();
    restoreFields(next, patch.fields);
    for (const change of patch.graphs) {
      const current = next.graphs.find(g => g.id === change.id);
      if (change.fields) { if (current) restoreFields(current, change.fields); }
      else if (!change.before) { if (current) for (const n of current.nodes) removed.add(n.id); next.graphs = next.graphs.filter(g => g.id !== change.id); }
      else {
        if (current) throw new Error('原图已存在，无法恢复重复的图。');
        next.graphs.splice(Math.min(change.beforeIndex, next.graphs.length), 0, { ...copy(change.before), nodes: [], updatedAt: Date.now() });
      }
    }
    for (const change of patch.nodes) if (!change.fields && !change.before) removed.add(change.id);
    for (let size = -1; size !== removed.size;) {
      size = removed.size;
      for (const { node: n } of currentNodes.values()) if (removed.has(n.parentId)) removed.add(n.id);
    }
    for (const g of next.graphs) { if (g.nodes.some(n => removed.has(n.id))) g.layoutInitialized = false; g.nodes = g.nodes.filter(n => !removed.has(n.id)); }
    for (const change of patch.nodes) {
      if (!change.fields && !change.before) continue;
      const current = currentNodes.get(change.id);
      let restored, targetId, index;
      if (change.fields) {
        if (!current) throw new Error('卡片已在之后删除，无法应用这次撤销或重做。');
        if (current.graphId !== change.afterGraphId) throw new Error('卡片已移动，无法撤销这项修改。');
        restored = copy(current.node); restoreFields(restored, change.fields);
        targetId = change.beforeGraphId; index = change.beforeIndex;
        if (change.beforeGraphId !== change.afterGraphId || change.fields.some(field => ['parentId', 'source', 'title', 'markdown', 'images', 'kind'].includes(field.path[0]))) affected.add(restored.id);
        if (restored.title !== current.node.title || restored.markdown !== current.node.markdown) restored.contentRevision = current.node.contentRevision + 1;
      } else {
        if (current) throw new Error('原卡片已存在，无法恢复重复的卡片。');
        restored = copy(change.before.node); targetId = change.before.graphId; index = change.before.index;
        restored.contentRevision = Math.max(restored.contentRevision, current?.node.contentRevision ?? -1) + 1; affected.add(restored.id);
      }
      const target = next.graphs.find(g => g.id === targetId);
      if (!target) continue;
      if (!change.fields) { const ratio = target.layoutUnit / change.before.unit; restored.x *= ratio; restored.y *= ratio; }
      const existing = target.nodes.findIndex(n => n.id === restored.id);
      for (const g of next.graphs) g.nodes = g.nodes.filter(n => n.id !== restored.id);
      target.nodes.splice(Math.min(existing < 0 ? index : existing, target.nodes.length), 0, restored);
    }
    for (const g of next.graphs) for (const n of g.nodes) if (affected.has(n.id)) {
      g.layoutInitialized = false;
      if (n.status === 'queued' || n.status === 'generating') { n.status = 'cancelled'; delete n.draft; }
    }
    for (const change of patch.orders) {
      const items = change.graphId ? graph(next, change.graphId).nodes : next.graphs, ids = new Set(change.before);
      const ordered = change.before.map(id => items.find(item => item.id === id)).filter(Boolean);
      let index = 0; for (let slot = 0; slot < items.length; slot++) if (ids.has(items[slot].id)) items[slot] = ordered[index++];
    }
    if (!next.graphs.some(g => g.id === next.lastGraphId)) next.lastGraphId = next.graphs.at(-1)?.id;
    preserveSources(next); return next;
  }

  async function mutate(id, operation) {
    const w = workspace(id);
    if (!operation || typeof operation !== 'object') throw new Error('操作格式无效。');
    if (operation.type === 'undo' || operation.type === 'redo') {
      const history = historyFor(id), stack = history[operation.type], patch = stack.at(-1);
      if (!patch) throw new Error(operation.type === 'undo' ? '没有可以撤销的操作。' : '没有可以重做的操作。');
      const restored = restoreHistory(w, patch), result = changed(restored), inverse = historyPatch(w, restored);
      stack.pop(); if (inverse) pushHistory(history[operation.type === 'undo' ? 'redo' : 'undo'], inverse);
      return result;
    }
    const before = ['view', 'layout', 'visit'].includes(operation.type) ? null : copy(w);
    if (operation.type === 'rename-workspace') { w.name = label(operation.name, '未命名工作区'); return changed(w, before); }
    if (operation.type === 'create-graph') {
      const created = newGraph(operation.title); w.graphs.push(created); w.lastGraphId = created.id; return changed(w, before);
    }
    const g = graph(w, operation.graphId);
    switch (operation.type) {
      case 'add-root': {
        if (g.nodes.length) throw new Error('当前图谱已有根节点，请先新建空白图谱。');
        const markdown = text(operation.markdown).replace(/\r\n?/g, '\n').trim();
        if (!Array.isArray(operation.images) || operation.images.length > 64) throw new Error('图片附件格式无效。');
        if (!markdown && !operation.images.length) throw new Error('请输入文字或添加截图。');
        const root = { ...newNode(null, g.title, markdown, 'source'), id: g.rootId, images: saveImages(operation.images) };
        g.nodes.push(root); w.lastGraphId = g.id; break;
      }
      case 'add-custom-node': {
        const parent = node(g, operation.parentId);
        if (!Array.isArray(operation.images) || operation.images.length > 64) throw new Error('图片附件格式无效。');
        const n = newNode(parent.id, '自定义卡片', text(operation.markdown), 'source');
        n.images = saveImages(operation.images);
        n.x = parent.x + g.layoutUnit * 1.12;
        n.y = parent.y + g.nodes.filter(item => item.parentId === parent.id).length * g.layoutUnit * (4 / 3 + .1);
        g.nodes.push(n); break;
      }
      case 'append-node-images': {
        const n = node(g, operation.nodeId);
        if (!Array.isArray(operation.images) || !operation.images.length || n.images.length + operation.images.length > 64) throw new Error('请添加截图，卡片最多保留 64 张图片。');
        n.images.push(...saveImages(operation.images)); n.contentRevision++; break;
      }
      case 'rename-graph': g.title = label(operation.title, '未命名图谱'); break;
      case 'visit': w.lastGraphId = g.id; break;
      case 'view': {
        const v = operation.view;
        if (!v || ![v.x, v.y, v.zoom].every(Number.isFinite) || v.zoom < .05 || v.zoom > 8) throw new Error('画布视角无效。');
        g.view = { x: v.x, y: v.y, zoom: v.zoom }; break;
      }
      case 'layout': {
        if (!Array.isArray(operation.positions) || operation.positions.some(p => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y))) throw new Error('卡片位置无效。');
        if (!Number.isFinite(operation.unit) || operation.unit <= 0) throw new Error('卡片尺寸无效。');
        const scale = operation.unit / g.layoutUnit;
        for (const n of g.nodes) { n.x *= scale; n.y *= scale; }
        for (const position of operation.positions) { const n = node(g, position.id); n.x = position.x; n.y = position.y; }
        g.layoutUnit = operation.unit; g.layoutInitialized = true; break;
      }
      case 'add-card': {
        const parent = node(g, operation.parentId), n = newNode(parent.id, label(operation.title, '对话摘录'), text(operation.markdown));
        n.x = parent.x + g.layoutUnit * 1.12; n.y = parent.y + g.nodes.filter(n => n.parentId === parent.id).length * g.layoutUnit * (4 / 3 + .1);
        g.nodes.push(n); break;
      }
      case 'edit': {
        const n = node(g, operation.nodeId);
        if (n.contentRevision !== operation.contentRevision) throw new Error('卡片已经更新，请重新打开后编辑。');
        const title = label(operation.title, '未命名卡片'), markdown = text(operation.markdown);
        if (title !== n.title || markdown !== n.markdown) { n.title = title; n.markdown = markdown; n.contentRevision++; }
        break;
      }
      case 'annotation': {
        const n = node(g, operation.nodeId), input = operation.annotation;
        if (!input || typeof input.id !== 'string' || !input.id || input.id.length > 128) throw new Error('批注标识无效。');
        const annotation = { id: input.id, selection: selection(input.selection, g), comment: text(input.comment), ...(input.images ? { images: saveImages(input.images) } : {}) };
        if (!annotation.comment.trim() && !annotation.images?.length) throw new Error('请填写批注或附加截图。');
        const index = n.annotations.findIndex(a => a.id === annotation.id);
        if (index < 0) n.annotations.push(annotation);
        else {
          const childId = n.annotations[index].childId;
          n.annotations[index] = { ...annotation, ...(childId ? { childId } : {}) };
          const child = w.graphs.flatMap(item => item.nodes).find(item => item.id === childId);
          if (child) child.source = annotationSource(n, annotation);
        }
        break;
      }
      case 'remove-annotation': {
        const n = node(g, operation.nodeId), childId = n.annotations.find(a => a.id === operation.annotationId)?.childId;
        const childGraph = w.graphs.find(item => item.nodes.some(child => child.id === childId));
        const child = childGraph?.nodes.find(item => item.id === childId);
        if (child) {
          if (child.status === 'queued' || child.status === 'generating') { child.status = 'cancelled'; delete child.draft; }
          if (child.source?.annotationId === operation.annotationId) delete child.source.annotationId;
        }
        n.annotations = n.annotations.filter(a => a.id !== operation.annotationId); break;
      }
      case 'pin': {
        if (typeof operation.pinned !== 'boolean') throw new Error('固定状态无效。');
        node(g, operation.nodeId).pinned = operation.pinned; break;
      }
      case 'reparent': {
        const n = node(g, operation.nodeId), parent = node(g, operation.parentId);
        if (n.id === g.rootId) throw new Error('根节点不能重新关联。');
        if (descendants(g, n.id).has(parent.id)) throw new Error('不能关联到自己或自己的子节点。');
        n.parentId = parent.id; break;
      }
      case 'move-subtree': {
        const n = node(g, operation.nodeId), target = graph(w, operation.targetGraphId);
        if (target === g) throw new Error('请选择另一张图谱。');
        const targetRoot = target.nodes.find(item => item.id === target.rootId);
        const targetParent = operation.targetNodeId === undefined ? targetRoot : node(target, operation.targetNodeId);
        const ids = descendants(g, n.id); preserveSources(w);
        const moved = g.nodes.filter(item => ids.has(item.id));
        const originY = n.y, ratio = target.layoutUnit / g.layoutUnit, movedById = new Map(moved.map(item => [item.id, item]));
        const baseX = targetParent ? targetParent.x + target.layoutUnit * 1.12 : 0;
        const baseY = targetParent?.y ?? 0;
        for (const item of moved) {
          let depth = 0, ancestor = item;
          while (movedById.has(ancestor.parentId)) { ancestor = movedById.get(ancestor.parentId); depth++; }
          item.x = baseX + depth * target.layoutUnit * 1.12; item.y = baseY + (item.y - originY) * ratio;
          if (item.status === 'queued' || item.status === 'generating') { item.status = 'cancelled'; delete item.draft; }
        }
        n.parentId = targetParent?.id ?? null;
        if (!targetRoot) { target.rootId = n.id; target.layoutInitialized = false; }
        target.nodes.push(n, ...moved.filter(item => item.id !== n.id)); target.updatedAt = Date.now();
        g.nodes = g.nodes.filter(item => !ids.has(item.id));
        if (!g.nodes.length) { g.rootId = uid(); g.layoutInitialized = false; g.view = { x: 0, y: 0, zoom: 1 }; }
        w.lastGraphId = target.id; break;
      }
      case 'delete': {
        const n = node(g, operation.nodeId), ids = descendants(g, n.id);
        preserveSources(w);
        if (n.id === g.rootId) {
          w.graphs = w.graphs.filter(item => item !== g);
          if (w.lastGraphId === g.id) w.lastGraphId = w.graphs.at(-1)?.id;
        } else {
          g.nodes = g.nodes.filter(item => !ids.has(item.id));
          for (const remaining of g.nodes) for (const a of remaining.annotations) if (ids.has(a.childId)) delete a.childId;
        }
        preserveSources(w); break;
      }
      case 'accept-candidate': {
        const n = node(g, operation.nodeId);
        if (!n.candidate) throw new Error('这张卡片没有待采用的新稿。');
        n.title = n.candidate.title; n.markdown = n.candidate.markdown; n.contentRevision++; delete n.candidate; break;
      }
      default: throw new Error('不支持这项图谱操作。');
    }
    g.updatedAt = Date.now(); return changed(w, before);
  }

  function escapeXml(value) { return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]); }
  function screenshot(title, formula, body) {
    const id = uid();
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="480" viewBox="0 0 800 480"><rect width="800" height="480" fill="white"/><text x="48" y="65" font-family="Segoe UI,Microsoft YaHei,sans-serif" font-size="26" fill="#372831">${escapeXml(title)}</text><path d="M48 86H752" stroke="#FEEDF2" stroke-width="2"/><text x="400" y="218" text-anchor="middle" font-family="Georgia,serif" font-size="54" fill="#DD6283">${escapeXml(formula)}</text><text x="48" y="305" font-family="Segoe UI,Microsoft YaHei,sans-serif" font-size="23" fill="#785D6A">${escapeXml(body)}</text><text x="752" y="446" text-anchor="end" font-family="Segoe UI,Microsoft YaHei,sans-serif" font-size="16" fill="#9E808F">浏览器演示资料</text></svg>`;
    return { id, title, source: 'window', file: 'assets/' + id + '.svg', pixelSize: { width: 800, height: 480 }, imageDataUrl: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg) };
  }
  async function captureContext(request, context, backgroundImageDataUrl) {
    if (!context?.images?.length) throw new Error('请先截取至少一张演示图片。');
    const w = workspace(request.workspaceId), before = copy(w), g = graph(w, request.graphId);
    if (g.nodes.length) throw new Error('当前图谱已有内容，请新建空白图谱后截图。');
    const root = { ...newNode(null, '屏幕资料', '', 'source'), id: g.rootId, images: saveImages(context.images) };
    g.nodes.push(root); g.layoutInitialized = false; g.updatedAt = Date.now();
    w.lastGraphId = g.id; changed(w, before, w.id);
    await window.RabbitGraph?.open({ activationId: Date.now(), view: 'graph', workspaceId: w.id, context: { ...context, images: copy(root.images), demo: true }, backgroundImageDataUrl: backgroundImageDataUrl || root.images[0].imageDataUrl });
  }
  async function capture(request) {
    const images = [screenshot('牛顿第二定律', 'F = ma', '力、质量和加速度之间的关系。')];
    await captureContext(request, { id: uid(), title: '牛顿第二定律', images, capturedAt: Date.now(), demo: true });
  }
  async function captureImages(request) {
    const target = graph(workspace(request.workspaceId), request.graphId);
    if (request.nodeId !== undefined) node(target, request.nodeId);
    else if (target.nodes.length) throw new Error('当前图谱已有根节点，请先新建空白图谱。');
    if (!window.RabbitCapture?.captureImages) throw new Error('截图工具尚未准备好，请刷新后重试。');
    return window.RabbitCapture.captureImages();
  }
  async function activate(action) {
    if (action !== undefined && !['rename-graph', 'undo', 'redo'].includes(action)) throw new Error('图谱操作无效。');
    window.RabbitSettings?.close();
    if (window.RabbitSettings?.getSnapshot().settings.graphPluginEnabled === false) throw new Error('请先启用大爆炸插件。');
    window.RabbitChat?.close();
    let w = await window.RabbitGraphDemo.graphOpen();
    if (action === undefined) {
      let g = w.graphs.find(g => g.id === w.lastGraphId) || w.graphs[0];
      if (!g) { w = await mutate(w.id, { type: 'create-graph' }); g = graph(w, w.lastGraphId); }
      if (!g.nodes.length) { await capture({ workspaceId: w.id, graphId: g.id }); return; }
    }
    await window.RabbitGraph?.open({ activationId: Date.now(), view: 'graph', workspaceId: w.id, ...(action ? { graphAction: action } : {}) });
  }

  function startJob(request, result) {
    const w = workspace(request.workspaceId), g = graph(w, request.graphId), n = node(g, request.nodeId);
    const token = taskKey(request), job = { request: copy(request), revision: n.contentRevision, offset: 0, timer: null };
    n.status = 'generating'; n.draft = ''; n.generation = { id: uid(), contentRevision: n.contentRevision };
    delete n.error; changed(w);
    const previous = jobs.get(token); if (previous) stopJob(previous);
    jobs.set(token, job);
    const output = '### ' + result.title + '\n\n' + result.markdown;
    const next = () => {
      if (jobs.get(token) !== job) return;
      const saved = state.workspaces.find(item => item.id === request.workspaceId), current = saved && copy(saved);
      const target = current?.graphs.find(item => item.id === request.graphId)?.nodes.find(item => item.id === request.nodeId);
      if (!target) { jobs.delete(token); return; }
      job.offset = Math.min(output.length, job.offset + 24);
      target.draft = output.slice(0, job.offset);
      if (job.offset === output.length) {
        if (target.contentRevision === job.revision) { target.title = result.title; target.markdown = result.markdown; target.contentRevision++; }
        else target.candidate = result;
        target.status = 'idle'; delete target.draft; jobs.delete(token);
      }
      try { changed(current); }
      catch (error) {
        stopJob(job);
        // 草稿保存失败时恢复最后已保存正文，仅在当前页面显示任务错误。
        const failed = saved.graphs.find(g => g.id === request.graphId)?.nodes.find(n => n.id === request.nodeId);
        if (failed) { failed.status = 'error'; failed.error = error.message; delete failed.draft; }
        for (const listener of listeners) listener(copy(saved));
        report(error.message, current.id); return;
      }
      if (jobs.get(token) === job) job.timer = setTimeout(next, 35);
    };
    job.timer = setTimeout(next, 35);
  }
  function answer(source) {
    const quote = source.selection.kind === 'text' ? source.selection.text : '所选图片区域';
    return { title: source.selection.kind === 'image' ? '图片解读' : '选区含义',
      markdown: '这是浏览器中的生成演示，未调用模型。\n\n> ' + quote.replace(/\n/g, '\n> ') + '\n\n桌面版会只解释这处选区，并按批注的侧重，结合从资料根节点到当前卡片的参考内容生成这一张卡片。' };
  }
  function annotationSource(parent, annotation) {
    const source = { nodeId: parent.id, annotationId: annotation.id, selection: copy(annotation.selection), comment: annotation.comment, revision: parent.contentRevision };
    if (annotation.images) source.images = copy(annotation.images);
    if (annotation.selection.kind === 'image') source.selectionImage = copy(parent.images.find(image => image.id === annotation.selection.imageId));
    return source;
  }
  async function generate(request) {
    const w = workspace(request.workspaceId), before = copy(w), g = graph(w, request.graphId), parent = node(g, request.nodeId);
    if (request.annotationIds !== undefined && (!Array.isArray(request.annotationIds) || request.annotationIds.some(id => typeof id !== 'string'))) throw new Error('批注列表无效。');
    const selected = parent.annotations.filter(a => !a.childId && (!request.annotationIds || request.annotationIds.includes(a.id)));
    if (!selected.length) throw new Error('请先选择内容并添加批注。');
    for (const annotation of selected) {
      if (!annotation.comment.trim() && !annotation.images?.length) throw new Error('请填写批注或附加截图。');
      const source = annotationSource(parent, annotation);
      const n = newNode(parent.id, '生成中'); n.status = 'queued'; n.source = source;
      n.x = parent.x + g.layoutUnit * 1.12; n.y = parent.y + g.nodes.filter(n => n.parentId === parent.id).length * g.layoutUnit * (4 / 3 + .1);
      annotation.childId = n.id; g.nodes.push(n);
    }
    changed(w, before);
    for (const annotation of selected) startJob({ ...request, nodeId: annotation.childId }, answer(node(g, annotation.childId).source));
  }
  async function regenerate(request) {
    const w = workspace(request.workspaceId), g = graph(w, request.graphId), n = node(g, request.nodeId);
    if (n.kind === 'source') throw new Error('本源卡片不能重新生成，请通过批注生成子节点。');
    startJob(request, n.source ? answer(n.source) : { title: n.title, markdown: '这是浏览器中的重新生成演示。\n\n' + n.markdown.replace(/^这是浏览器中的重新生成演示。\n\n/, '') });
  }

  window.RabbitGraphDemo = Object.freeze({
    graphList: async () => state.workspaces.map(w => ({ id: w.id, name: w.name, updatedAt: w.updatedAt, graphCount: w.graphs.length })),
    graphOpen: async id => {
      if (loadError) throw new Error(loadError);
      const w = !state.workspaces.length && !id ? addWorkspace('未命名工作区') : workspace(id);
      if (state.active !== w.id) persist({ ...state, active: w.id });
      return w;
    },
    graphCreate: async name => copy(addWorkspace(name)),
    graphMutate: mutate,
    graphRevealDocument: async () => { throw new Error('浏览器演示保存在此浏览器中；桌面版可打开真实文档文件夹。'); },
    graphActivate: activate,
    graphCapture: capture,
    graphCaptureContext: captureContext,
    graphCaptureImages: captureImages,
    graphGenerate: generate,
    graphRegenerate: regenerate,
    graphCancel: request => { try { cancel(request); } catch (error) { report(error.message, request.workspaceId); } },
    onGraphChanged: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    onGraphError: listener => { errorListeners.add(listener); if (loadError) listener({ message: loadError }); return () => errorListeners.delete(listener); }
  });
})();
