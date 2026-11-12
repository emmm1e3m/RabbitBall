import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import type { GraphNode, GraphWorkspace } from '../electron/graph-contracts.ts';
import type { CaptureImage } from '../electron/contracts.ts';

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function workspace(id: string, revision = 1): GraphWorkspace {
  const node: GraphNode = { id: 'root', parentId: null, kind: 'source', title: '资料', markdown: '',
    images: [], annotations: [], pinned: false, x: 300, y: 300, contentRevision: 0, status: 'idle' };
  return { id, name: id, revision, updatedAt: revision, lastGraphId: 'graph-' + id,
    graphs: [{ id: 'graph-' + id, title: '图', rootId: node.id, nodes: [node],
      view: { x: 0, y: 0, zoom: 1 }, updatedAt: revision, layoutInitialized: true, layoutUnit: 238 }] };
}

function geometry() {
  const source = readFileSync(new URL('../prototype/graph-ui.js', import.meta.url), 'utf8');
  const boundary = source.indexOf('  const style =');
  assert.ok(boundary > 0, '几何函数必须在挂载浏览器界面前定义');
  const window: any = {};
  // 只让 VM 提取真实闭包函数；不向生产 API 加入测试入口。
  vm.runInNewContext(source.slice(0, boundary) + '\nwindow.geometry = { normalizedRect, zoomAt, touchView, rootView, constrainView, edgePath, cardHeight, layoutTree, wheelGesture };\n})();', {
    window, document: { getElementById: () => null }, crypto: { randomUUID },
  });
  return window.geometry;
}

test('图片框选在画布变焦、放大阅读和反向拖动下保持相同归一化范围', () => {
  const { normalizedRect } = geometry();
  for (const scale of [.6, 1, 1.5, 2]) {
    const bounds = { left: 71, top: 123, width: 600 * scale, height: 400 * scale };
    const start = { x: bounds.left + .2 * bounds.width, y: bounds.top + .25 * bounds.height };
    const end = { x: bounds.left + .7 * bounds.width, y: bounds.top + .75 * bounds.height };
    for (const points of [[start, end], [end, start]]) {
      const actual = normalizedRect(...points, bounds);
      for (const [key, expected] of Object.entries({ x: .2, y: .25, width: .5, height: .5 })) assert.ok(Math.abs(actual[key] - expected) < 1e-10);
    }
  }
  const clipped = normalizedRect({ x: 0, y: 0 }, { x: 400, y: 500 }, { left: 100, top: 100, width: 100, height: 100 });
  assert.deepEqual(JSON.parse(JSON.stringify(clipped)), { x: 0, y: 0, width: 1, height: 1 });
});

test('缩放保持鼠标下世界坐标固定，并在最小最大缩放处保持锚点', () => {
  const { zoomAt } = geometry(), initial = { x: 60, y: -30, zoom: .8 }, point = { x: 413, y: 278 };
  const world = { x: (point.x - initial.x) / initial.zoom, y: (point.y - initial.y) / initial.zoom };
  for (const requested of [.01, .7, 1.6, 7]) {
    const changed = zoomAt(initial, point, requested);
    assert.ok(changed.zoom >= .4 && changed.zoom <= 1.8);
    assert.ok(Math.abs(world.x * changed.zoom + changed.x - point.x) < 1e-10);
    assert.ok(Math.abs(world.y * changed.zoom + changed.y - point.y) < 1e-10);
  }
});

test('触摸视角以双指中心为锚同时平移缩放，单指和缩放极限保持连续', () => {
  const { touchView } = geometry(), view = { x: 180, y: -60, zoom: 1 };
  assert.deepEqual(JSON.parse(JSON.stringify(touchView(view, [{ x: 400, y: 300 }], [{ x: 430, y: 320 }]))), { x: 210, y: -40, zoom: 1 });
  const start = [{ x: 400, y: 300 }, { x: 600, y: 300 }], anchor = { x: 320, y: 360 };
  for (const span of [20, 300, 1600]) {
    const points = [{ x: 520 - span / 2, y: 330 }, { x: 520 + span / 2, y: 330 }], next = touchView(view, start, points);
    assert.equal(next.zoom, Math.max(.4, Math.min(1.8, span / 200)));
    assert.ok(Math.abs(next.x + anchor.x * next.zoom - 520) < 1e-9);
    assert.ok(Math.abs(next.y + anchor.y * next.zoom - 330) < 1e-9);
  }
});

test('默认视角以原始比例居中根节点，边界允许根和最远节点分别移到中心', () => {
  const { rootView, constrainView } = geometry(), viewport = { width: 1200, height: 800 }, width = 240;
  const nodes = [{ x: -200, y: 100, height: 320 }, { x: 5000, y: 2400, height: 700 }];
  const centered = rootView(nodes[0], width, viewport);
  assert.equal(centered.zoom, 1);
  assert.equal(centered.x + nodes[0].x + width / 2, viewport.width / 2);
  assert.equal(centered.y + nodes[0].y + nodes[0].height / 2, viewport.height / 2);
  for (const zoom of [.4, 1, 1.8]) for (const node of nodes) {
    const requested = { x: viewport.width / 2 - (node.x + width / 2) * zoom, y: viewport.height / 2 - (node.y + node.height / 2) * zoom, zoom };
    assert.deepEqual(JSON.parse(JSON.stringify(constrainView(requested, nodes, width, viewport))), requested);
  }
  for (const sign of [-1, 1]) {
    const limited = constrainView({ x: sign * 1e6, y: sign * 1e6, zoom: 1 }, nodes, width, viewport);
    assert.ok(Math.abs(limited.x) < 10000 && Math.abs(limited.y) < 10000);
    assert.deepEqual(JSON.parse(JSON.stringify(constrainView(limited, nodes, width, viewport))), JSON.parse(JSON.stringify(limited)));
    const edge = sign > 0 ? nodes[0] : nodes[1], x = limited.x + edge.x + width / 2, y = limited.y + edge.y + edge.height / 2;
    assert.ok(x >= 0 && x <= viewport.width && y >= 0 && y <= viewport.height, '拖动到边界时最远端节点仍可见');
  }
});

test('超出屏幕的大卡两端均可移入安全边，空图和越界缩放保持有限视角', () => {
  const { constrainView } = geometry(), viewport = { width: 640, height: 480 }, width = 1600, node = { x: 50, y: 100, height: 2400 };
  for (const zoom of [.4, 1, 1.8]) for (const opposite of [false, true]) {
    const x = opposite ? viewport.width - 32 - (node.x + width) * zoom : 32 - node.x * zoom;
    const y = opposite ? viewport.height - 32 - (node.y + node.height) * zoom : 32 - node.y * zoom;
    assert.deepEqual(JSON.parse(JSON.stringify(constrainView({ x, y, zoom }, [node], width, viewport))), { x, y, zoom });
  }
  for (const [requested, expected] of [[.01, .4], [9, 1.8]]) {
    const view = constrainView({ x: 1e6, y: -1e6, zoom: requested }, [], width, viewport);
    assert.deepEqual(JSON.parse(JSON.stringify(view)), { x: 0, y: 0, zoom: expected });
  }
});

test('统一树布局按稳定DFS叶行向右展开，支持父节点后置并固定根锚点', () => {
  const { layoutTree } = geometry(), width = 240;
  const nodes = [
    { id: 'a1', parentId: 'a', x: -480, y: 600, height: 200 },
    { id: 'b', parentId: 'root', x: 480, y: -600, height: 320 },
    { id: 'root', parentId: null, x: 100, y: 200, height: 360 },
    { id: 'a', parentId: 'root', x: -480, y: -600, height: 300 },
    { id: 'a2', parentId: 'a', x: 0, y: 600, height: 250 },
    { id: 'b1', parentId: 'b', x: 0, y: 0, height: 400 },
    { id: 'b2', parentId: 'b', x: 960, y: 600, height: 180 },
  ];
  const original = structuredClone(nodes), positions = layoutTree(nodes, width);
  assert.deepEqual(nodes, original, '计算布局不会就地更改模型');
  assert.deepEqual(Array.from(positions, (position: any) => position.id), nodes.map(node => node.id));
  const expected: Record<string, [number, number]> = {
    root: [100, 200], b: [368.8, 200], b1: [637.6, 200], b2: [637.6, 628],
    a: [368.8, 836], a1: [637.6, 836], a2: [637.6, 1164],
  };
  for (const position of positions) {
    const [x, y] = expected[position.id];
    assert.ok(Math.abs(position.x - x) < 1e-9); assert.ok(Math.abs(position.y - y) < 1e-9);
    Object.assign(nodes.find(node => node.id === position.id)!, position);
  }
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    const a = nodes[i], b = nodes[j];
    assert.ok(a.x + width <= b.x || b.x + width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);
  }
  assert.equal(layoutTree([], width).length, 0);
});

test('截图按比例变高后由统一布局推开后续行，普通牌保持4:3', () => {
  const { cardHeight, layoutTree } = geometry(), root = workspace('A').graphs[0].nodes[0];
  const source = (width: number, height: number): GraphNode => ({ ...structuredClone(root), x: 0, y: 0,
    images: [{ id: 'screenshot', title: '截图', imageDataUrl: 'data:image/png;base64,AA==', pixelSize: { width, height } }] });
  const landscape = source(1600, 900), portrait = source(800, 1600), ordinary = { ...root, kind: 'card' as const };
  assert.equal(cardHeight(ordinary, 240), 320);
  assert.ok(cardHeight(landscape, 240) < cardHeight(ordinary, 240));
  assert.equal(cardHeight(landscape, 240), Math.max(240 * .65, 25 + (240 - 28) * 900 / 1600));
  assert.equal(cardHeight({ ...landscape, parentId: 'another-root' }, 240), 41 + (240 - 28) * 900 / 1600);
  assert.ok(cardHeight(portrait, 240) > cardHeight(ordinary, 240));
  assert.equal(cardHeight(landscape, 240), cardHeight(source(3200, 1800), 240));
  const nodes = [landscape, ...['a', 'b'].map(id => ({ ...structuredClone(ordinary), id, parentId: 'root' }))].map(node => ({ ...node, height: cardHeight(node, 240) }));
  const before = layoutTree(nodes, 240);
  nodes[0].height = cardHeight(portrait, 240);
  const after = layoutTree(nodes, 240);
  assert.equal(after[0].x, 0); assert.equal(after[0].y, 0); assert.equal(after[1].y, 0);
  assert.ok(after[2].y > before[2].y);
  assert.equal(after[2].y, Math.max(nodes[0].height, nodes[1].height) + 28);
});

test('删除分支后重新布局收紧空行，不移动根锚点', () => {
  const { layoutTree } = geometry();
  const nodes = [
    { id: 'root', parentId: null, x: 50, y: 75, height: 320 },
    { id: 'a', parentId: 'root', x: 0, y: 0, height: 320 },
    { id: 'a1', parentId: 'a', x: 0, y: 0, height: 320 },
    { id: 'a2', parentId: 'a', x: 0, y: 0, height: 320 },
    { id: 'b', parentId: 'root', x: 0, y: 0, height: 320 },
    { id: 'b1', parentId: 'b', x: 0, y: 0, height: 320 },
  ];
  const before = layoutTree(nodes, 240), after = layoutTree(nodes.filter(node => node.id !== 'a2'), 240);
  const oldB = before.find((node: any) => node.id === 'b'), newB = after.find((node: any) => node.id === 'b');
  assert.equal(oldB.y - newB.y, 348);
  assert.equal(newB.y, 75 + 348);
  assert.equal(after[0].x, 50); assert.equal(after[0].y, 75);
  assert.equal(after.find((node: any) => node.id === 'b1').y, newB.y);
});

test('贝塞尔连线沿父卡右边到子卡左边，控制点留在列间通道', () => {
  const { edgePath } = geometry();
  for (const [fromHeight, toHeight] of [[320, 320], [190, 432]]) for (const target of [{ x: 450, y: 0 }, { x: 450, y: 120 }, { x: 450, y: 600 }]) {
    const values = edgePath({ x: 0, y: 0, height: fromHeight }, { ...target, height: toHeight }, 240, 320).match(/-?\d+(?:\.\d+)?/g).map(Number);
    const [sx, sy, ax, ay, bx, by, ex, ey] = values;
    assert.equal(sx, 240); assert.equal(ex, target.x);
    assert.ok(sy >= 22 && sy <= fromHeight - 22);
    assert.ok(ey >= target.y + 22 && ey <= target.y + toHeight - 22);
    assert.ok(sx < ax && ax <= bx && bx < ex);
    assert.equal(ay, sy); assert.equal(by, ey);
  }
});

test('重新关联后整棵子树按新深度向右排列，父子第一行保持对齐', () => {
  const { layoutTree } = geometry(), width = 240;
  const nodes = [
    { id: 'root', parentId: null, x: 50, y: 75, height: 320 },
    { id: 'a', parentId: 'root', x: 0, y: 0, height: 320 },
    { id: 'a1', parentId: 'a', x: 0, y: 0, height: 320 },
    { id: 'a2', parentId: 'a', x: 0, y: 0, height: 320 },
    { id: 'b', parentId: 'root', x: 0, y: 0, height: 320 },
    { id: 'b1', parentId: 'b', x: 0, y: 0, height: 320 },
  ];
  const before = layoutTree(nodes, width);
  nodes[4].parentId = 'a1';
  const after = layoutTree(nodes, width), root = after[0], b = after[4], b1 = after[5];
  assert.equal(root.x, 50); assert.equal(root.y, 75);
  assert.ok(Math.abs(b.x - root.x - width * 1.12 * 3) < 1e-9);
  assert.ok(Math.abs(b1.x - root.x - width * 1.12 * 4) < 1e-9);
  assert.ok(b.x > before[4].x);
  assert.equal(b.y, after[2].y); assert.equal(b1.y, b.y);
  assert.equal(after[3].y, 75 + 348);
});

test('12至30像素短连线的控制点保持在端点之间且不回折', () => {
  const { edgePath } = geometry();
  for (const gap of [12, 30]) for (const y of [0, 344, 720]) {
    const from = { x: 0, y: 0, height: 320 }, to = { x: 240 + gap, y, height: 432 };
    const values = edgePath(from, to, 240, 320).match(/-?\d+(?:\.\d+)?/g).map(Number);
    const coordinates = [values[0], values[2], values[4], values[6]];
    assert.equal(coordinates[3] - coordinates[0], gap);
    for (let i = 1; i < coordinates.length; i++) assert.ok(coordinates[i] >= coordinates[i - 1]);
  }
});

test('连续滚轮手势保持设备判别，触控板平移、鼠标滚轮缩放、Ctrl捏合立即缩放', () => {
  const { wheelGesture } = geometry();
  const event = (deltaY: number, values: Record<string, unknown> = {}) => ({ deltaX: 0, deltaY, deltaMode: 0, ctrlKey: false, shiftKey: false, ...values });
  let gesture = wheelGesture(null, event(8), 0);
  assert.equal(gesture.mode, 'pan');
  gesture = wheelGesture(gesture, event(80), 80);
  assert.equal(gesture.mode, 'pan', '连续触控板手势不能因加速变成缩放');
  gesture = wheelGesture(gesture, event(120), 300);
  assert.equal(gesture.mode, 'zoom');
  gesture = wheelGesture(gesture, event(4), 340);
  assert.equal(gesture.mode, 'zoom', '连续滚轮尾部小幅度仍保持缩放');
  gesture = wheelGesture(gesture, event(1, { ctrlKey: true }), 350);
  assert.equal(gesture.mode, 'zoom'); assert.equal(gesture.pinch, true);
  assert.equal(wheelGesture(gesture, event(3), 360).mode, 'pan', '捏合结束后立即识别平移');
  for (const input of [event(50.5), event(120, { deltaX: 2 }), event(120, { shiftKey: true })]) assert.equal(wheelGesture(null, input, 0).mode, 'pan');
  for (const input of [event(120), event(3, { deltaMode: 1 }), event(1, { deltaMode: 2 })]) assert.equal(wheelGesture(null, input, 0).mode, 'zoom');
});

// 替换浏览器与 IPC 边界，生命周期仍执行完整生产组件。
function fixture(savedSettings?: { graphPluginEnabled: boolean; graphModeEnabled: boolean }, options: { manualFrames?: boolean; reducedMotion?: boolean } = {}) {
  const events: any[] = [], listeners = new Map<string, Array<(event: any) => void>>(), documentCapture = new Map<string, Array<(event: any) => void>>();
  const timers = new Map<number, { at: number; run: () => void }>();
  const frames = new Map<number, { run: (timestamp: number) => void; handle?: ReturnType<typeof setImmediate> }>();
  const pointerCapture = new Map<number, Element>();
  const animations: Array<{ element: Element; keyframes: any[]; options: any; pending: ReturnType<typeof deferred<void>>; cancelled: boolean; startTime: number | null }> = [];
  let holdAnimations = false;
  let serial = 0, now = 0, animationNow = 0, document: any;
  class Element {
    tagName: string; nodeType = 1; children: Element[] = []; parentElement: Element | null = null;
    dataset: Record<string, string> = {}; attributes: Record<string, string> = {};
    classes = new Set<string>(); handlers = new Map<string, Array<(event: any) => void>>(); captureHandlers = new Map<string, Array<(event: any) => void>>();
    style: any = { setProperty(name: string, value: string) { this[name] = value; }, removeProperty(name: string) { delete this[name]; } };
    id = ''; value = ''; disabled = false; hidden = false; inert = false; scrollTop = 0; scrollLeft = 0;
    clientWidth = 1200; clientHeight = 800; scrollHeight = 0; private content = '';
    constructor(tag: string) { this.tagName = tag.toUpperCase(); }
    get ownerDocument() { return document; }
    get parentNode() { return this.parentElement; }
    get childNodes() { return this.children; }
    get firstChild() { return this.children[0] || null; }
    get lastChild() { return this.children.at(-1) || null; }
    get offsetWidth() { return this.getBoundingClientRect().width; }
    get offsetHeight() { return this.getBoundingClientRect().height; }
    get isConnected() { return document.body.contains(this) || document.head.contains(this); }
    get className() { return [...this.classes].join(' '); }
    set className(value: string) { this.classes = new Set(value.split(/\s+/).filter(Boolean)); }
    classList = {
      add: (...values: string[]) => values.forEach(value => this.classes.add(value)),
      remove: (...values: string[]) => values.forEach(value => this.classes.delete(value)),
      contains: (value: string) => this.classes.has(value),
      toggle: (value: string, force = !this.classes.has(value)) => { if (force) this.classes.add(value); else this.classes.delete(value); return force; },
    };
    get textContent(): string { return this.content + this.children.map(child => child.textContent).join(''); }
    set textContent(value: string) { this.content = String(value); this.children = []; }
    setAttribute(name: string, value: string) {
      this.attributes[name] = String(value);
      if (name === 'id') this.id = value;
      if (name === 'class') this.className = value;
      if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
    }
    getAttribute(name: string) {
      if (name.startsWith('data-')) return this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] ?? null;
      return this.attributes[name] ?? null;
    }
    removeAttribute(name: string) { delete this.attributes[name]; }
    appendChild(child: Element) { child.remove(); child.parentElement = this; this.children.push(child); return child; }
    append(...children: Element[]) { children.forEach(child => this.appendChild(child)); }
    insertBefore(child: Element, reference: Element | null) { if (!reference) return this.appendChild(child); child.remove(); child.parentElement = this; const index = this.children.indexOf(reference); this.children.splice(index < 0 ? this.children.length : index, 0, child); return child; }
    prepend(child: Element) { child.remove(); child.parentElement = this; this.children.unshift(child); }
    replaceChildren(...children: Element[]) { this.children.forEach(child => { child.parentElement = null; }); this.children = []; this.content = ''; this.append(...children); }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; }
    contains(child: Element): boolean { return child === this || this.children.some(node => node.contains(child)); }
    cloneNode(deep = false): Element {
      const result = new Element(this.tagName);
      Object.assign(result.style, this.style); result.className = this.className; result.content = this.content;
      for (const [name, value] of Object.entries(this.attributes)) result.setAttribute(name, value);
      Object.assign(result.dataset, this.dataset);
      if (deep) for (const child of this.children) result.appendChild(child.cloneNode(true));
      return result;
    }
    matches(selector: string): boolean {
      return selector.split(',').some(part => {
        part = part.trim();
        const descendant = part.match(/^(.*)\s+([.#][\w-]+)$/);
        if (descendant) return this.matches(descendant[2]) && !!this.parentElement?.closest(descendant[1]);
        const attr = part.match(/\[([\w-]+)(?:=["']?([^\]"']+)["']?)?\]/);
        if (attr && (this.getAttribute(attr[1]) === null || attr[2] !== undefined && this.getAttribute(attr[1]) !== attr[2])) return false;
        const base = part.replace(/\[[^\]]+\]/g, '');
        const id = base.match(/#([\w-]+)/)?.[1], classes = [...base.matchAll(/\.([\w-]+)/g)].map(match => match[1]);
        const tag = base.match(/^[\w-]+/)?.[0];
        return (!id || this.id === id) && classes.every(name => this.classes.has(name)) && (!tag || this.tagName.toLowerCase() === tag.toLowerCase());
      });
    }
    closest(selector: string): Element | null { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
    querySelectorAll(selector: string): Element[] { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
    querySelector(selector: string) { return this.querySelectorAll(selector)[0] || null; }
    set innerHTML(markup: string) {
      this.replaceChildren();
      const stack: Element[] = [this];
      for (const match of markup.matchAll(/<\/?([a-z][\w-]*)([^>]*)>/gi)) {
        if (match[0].startsWith('</')) { if (stack.length > 1) stack.pop(); continue; }
        const node = new Element(match[1]);
        for (const attr of match[2].matchAll(/([\w:-]+)(?:="([^"]*)")?/g)) node.setAttribute(attr[1], attr[2] || '');
        stack.at(-1)!.appendChild(node);
        if (!match[0].endsWith('/>') && !['input', 'img', 'br', 'hr'].includes(match[1])) stack.push(node);
      }
    }
    addEventListener(type: string, listener: (event: any) => void, options?: boolean | { capture?: boolean }) { const handlers = options === true || typeof options === 'object' && options.capture ? this.captureHandlers : this.handlers; if (!handlers.has(type)) handlers.set(type, []); handlers.get(type)!.push(listener); }
    removeEventListener(type: string, listener: (event: any) => void) { for (const handlers of [this.handlers, this.captureHandlers]) handlers.set(type, (handlers.get(type) || []).filter(value => value !== listener)); }
    dispatchEvent(event: any) {
      event.target ||= this;
      if (!event.captureDispatched) {
        if (this.isConnected) document.dispatchCapture(event);
        if (event.stopped) return !event.defaultPrevented;
        event.captureDispatched = true; const path: Element[] = [];
        for (let element: Element | null = this; element; element = element.parentElement) path.unshift(element);
        for (const element of path) { event.currentTarget = element; for (const listener of element.captureHandlers.get(event.type) || []) { listener(event); if (event.immediateStopped) break; } if (event.stopped) return !event.defaultPrevented; }
      }
      event.currentTarget = this; (this as any)['on' + event.type]?.(event);
      for (const listener of this.handlers.get(event.type) || []) { if (event.immediateStopped) break; listener(event); }
      if (event.bubbles && !event.stopped) this.parentElement?.dispatchEvent(event); return !event.defaultPrevented;
    }
    focus() { document.activeElement = this; }
    blur() { if (document.activeElement === this) document.activeElement = document.body; }
    select() { this.focus(); }
    setSelectionRange() {}
    setPointerCapture(id: number) { pointerCapture.set(id, this); }
    releasePointerCapture(id: number) { if (pointerCapture.get(id) === this) pointerCapture.delete(id); }
    hasPointerCapture(id: number) { return pointerCapture.get(id) === this; }
    getBoundingClientRect() {
      const x = parseFloat(this.style.left) || 0, y = parseFloat(this.style.top) || 0;
      const width = parseFloat(this.style.width) || this.clientWidth, height = parseFloat(this.style.height) || this.clientHeight;
      return { x, y, left: x, top: y, width, height, right: x + width, bottom: y + height };
    }
    animate(keyframes: any[], options: any) {
      const pending = deferred<void>(), record = { element: this, keyframes, options, pending, cancelled: false, startTime: null as number | null,
        finished: pending.promise, cancel() { record.cancelled = true; pending.resolve(); } };
      animations.push(record);
      if (!holdAnimations) pending.resolve();
      return record;
    }
    scrollIntoView() {}
  }
  const body = new Element('body'), head = new Element('head'), scene = new Element('div'); scene.id = 'scene'; body.append(scene);
  let hitTarget: Element | null = null;
  document = {
    body, head, documentElement: body, activeElement: body, timeline: { get currentTime() { return now; } },
    createElement: (tag: string) => new Element(tag), createElementNS: (_: string, tag: string) => new Element(tag),
    getElementById: (id: string) => body.querySelector('#' + id),
    querySelector: (selector: string) => body.querySelector(selector), querySelectorAll: (selector: string) => body.querySelectorAll(selector),
    addEventListener(type: string, listener: (event: any) => void, options?: boolean | { capture?: boolean }) { const handlers = options === true || typeof options === 'object' && options.capture ? documentCapture : listeners; if (!handlers.has(type)) handlers.set(type, []); handlers.get(type)!.push(listener); },
    removeEventListener(type: string, listener: (event: any) => void) { for (const handlers of [listeners, documentCapture]) handlers.set(type, (handlers.get(type) || []).filter(value => value !== listener)); },
    dispatchCapture(event: any) { if (event.documentCaptureDispatched) return; event.documentCaptureDispatched = true; event.currentTarget = document; for (const listener of documentCapture.get(event.type) || []) { listener(event); if (event.immediateStopped) break; } },
    dispatchEvent(event: any) { document.dispatchCapture(event); if (event.stopped) return; events.push(event); event.currentTarget = document; for (const listener of listeners.get(event.type) || []) { listener(event); if (event.immediateStopped) break; } },
    getSelection: () => ({ rangeCount: 0, toString: () => '', removeAllRanges() {} }),
    createTreeWalker: () => ({ nextNode: () => null }),
    elementFromPoint: () => hitTarget,
  };
  const windowListeners = new Map<string, Array<(event: any) => void>>();
  const window: any = {
    innerWidth: 1200, innerHeight: 800, getSelection: document.getSelection,
    matchMedia: () => ({ matches: options.reducedMotion ?? false }),
    addEventListener(type: string, listener: (event: any) => void) { if (!windowListeners.has(type)) windowListeners.set(type, []); windowListeners.get(type)!.push(listener); },
    removeEventListener(type: string, listener: (event: any) => void) { windowListeners.set(type, (windowListeners.get(type) || []).filter(item => item !== listener)); },
    RabbitRender: {
      render(target: Element, text: string) { target.textContent = text; },
      renderInline(target: Element, text: string) { target.textContent = text; },
    },
  };
  if (savedSettings) window.RabbitSettings = { getSnapshot: () => ({ settings: savedSettings }) };
  const requests: Array<{ workspaceId?: string; pending: ReturnType<typeof deferred<GraphWorkspace>> }> = [];
  const mutations: any[] = [], cancelled: any[] = [], regenerated: any[] = [], generated: any[] = [];
  const pinRegions: any[] = [], pinInteractions: any[] = [], activations: any[] = [];
  const bridgeCalls: any[] = [];
  const captures: any[] = [], imageCaptures: Array<{ request: unknown; pending: ReturnType<typeof deferred<CaptureImage[] | null>> }> = [];
  let changed: (workspace: GraphWorkspace) => void = () => {}, error: (error: any) => void = () => {};
  let active = workspace('default');
  let mutationResult: ((mutation: any) => GraphWorkspace) | null = null;
  window.rabbitDesktop = {
    graphOpen(workspaceId?: string) { bridgeCalls.push({ method: 'graphOpen', workspaceId }); const pending = deferred<GraphWorkspace>(); requests.push({ workspaceId, pending }); return pending.promise; },
    graphList: async () => [], graphCreate: async () => active,
    graphMutate: async (workspaceId: string, mutation: unknown) => { bridgeCalls.push({ method: 'graphMutate', workspaceId, mutation }); mutations.push({ workspaceId, mutation }); if (mutationResult) active = mutationResult(mutation); return active; },
    graphRevealDocument: async () => {}, graphCapture: async (request: unknown) => { captures.push(request); },
    graphCaptureImages: (request: unknown) => { const pending = deferred<CaptureImage[] | null>(); imageCaptures.push({ request, pending }); return pending.promise; },
    graphActivate: async (action: unknown) => { bridgeCalls.push({ method: 'graphActivate' }); activations.push(action); },
    setGraphPinRegions: (request: unknown) => { pinRegions.push(structuredClone(request)); },
    graphPinInteraction: async (request: unknown) => { pinInteractions.push(structuredClone(request)); return true; },
    graphGenerate: async (request: unknown) => { generated.push(request); },
    graphRegenerate: async (request: unknown) => { regenerated.push(request); },
    graphCancel: (request: unknown) => { cancelled.push(request); },
    onGraphChanged(listener: typeof changed) { changed = listener; return () => {}; },
    onGraphError(listener: typeof error) { error = listener; return () => {}; },
  };
  const context = vm.createContext({ window, document, innerWidth: 1200, innerHeight: 800, structuredClone,
    crypto: { randomUUID }, console, DOMException, AbortController, URL, Date: class extends Date { static now() { return now; } }, performance: { now: () => animationNow },
    HTMLElement: Element, Element, Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 }, NodeFilter: { SHOW_TEXT: 4 },
    getComputedStyle: () => ({ getPropertyValue: () => '', fontSize: '15px', top: '-110px' }),
    ResizeObserver: class { observe() {} disconnect() {} },
    CustomEvent: class { type: string; detail: unknown; constructor(type: string, options: any) { this.type = type; this.detail = options?.detail; } },
    requestAnimationFrame: (run: (timestamp: number) => void) => {
      const id = ++serial, frame: { run: (timestamp: number) => void; handle?: ReturnType<typeof setImmediate> } = { run };
      if (!options.manualFrames) { frame.handle = setImmediate(() => { frames.delete(id); animationNow += 1000; run(animationNow); }); frame.handle.unref(); }
      frames.set(id, frame); return id;
    },
    cancelAnimationFrame: (id: number) => { const frame = frames.get(id); if (frame?.handle) clearImmediate(frame.handle); frames.delete(id); },
    setTimeout: (run: () => void, delay = 0) => { timers.set(++serial, { at: now + delay, run }); return serial; }, clearTimeout: (id: number) => timers.delete(id),
  });
  vm.runInContext(readFileSync(new URL('../prototype/graph-selection.js', import.meta.url), 'utf8'), context, { filename: 'graph-selection.js' });
  const source = readFileSync(new URL('../prototype/graph-ui.js', import.meta.url), 'utf8');
  vm.runInContext(source, context, { filename: 'graph-ui.js' });
  return { window, document, events, requests, mutations, cancelled, regenerated, generated, captures, imageCaptures, pinRegions, pinInteractions, activations, bridgeCalls, animations, api: window.RabbitGraph,
    async resolve(index: number, value: GraphWorkspace) { active = value; requests[index].pending.resolve(value); await flush(); await flush(); },
    changed(value: GraphWorkspace) { active = value; changed(value); },
    mutateWith(handler: (mutation: any) => GraphWorkspace) { mutationResult = handler; },
    pointAt(target: Element) { hitTarget = target; },
    holdAnimations() { holdAnimations = true; },
    frame(ms: number) {
      animationNow += ms;
      for (const [id, frame] of [...frames]) { if (!frames.has(id)) continue; if (frame.handle) clearImmediate(frame.handle); frames.delete(id); frame.run(animationNow); }
    },
    resize(width: number, height: number) {
      for (const selector of ['#rabbit-graph-root', '.rg-viewport']) { const element = document.querySelector(selector); element.clientWidth = width; element.clientHeight = height; }
      window.innerWidth = width; window.innerHeight = height;
      for (const listener of windowListeners.get('resize') || []) listener({ type: 'resize' });
    },
    emit(type: string, detail: any = {}) { document.dispatchEvent({ type, detail }); },
    emitWindow(type: string, detail: any = {}) { for (const listener of windowListeners.get(type) || []) listener({ type, ...detail }); },
    tick(ms: number) { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.run(); } },
    click(target: Element, values: Record<string, unknown> = {}) { const event: any = { type: 'click', target, bubbles: true, detail: 0, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, stopImmediatePropagation() { this.stopped = true; this.immediateStopped = true; }, ...values }; target.dispatchEvent(event); return event; },
    wheel(target: Element, values: Record<string, unknown> = {}) {
      const event: any = { type: 'wheel', target, bubbles: true, deltaX: 0, deltaY: 0, deltaMode: 0, ctrlKey: false, shiftKey: false, clientX: 400, clientY: 300,
        preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...values };
      target.dispatchEvent(event); return event;
    },
    touch(target: Element, type: string, points: Array<{ identifier: number; clientX: number; clientY: number; target?: Element }>, changed = points, values: Record<string, unknown> = {}) {
      const touches = points.map(point => ({ ...point, target: point.target || target }));
      const event: any = { type, target, bubbles: true, cancelable: true, defaultPrevented: false, touches,
        targetTouches: touches.filter(point => target.contains(point.target)), changedTouches: changed.map(point => ({ ...point, target: point.target || target })),
        preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, stopImmediatePropagation() { this.stopped = true; this.immediateStopped = true; }, ...values };
      target.dispatchEvent(event);
      if (!event.stopped) document.dispatchEvent(event);
      if (!event.stopped) for (const listener of windowListeners.get(type) || []) listener(event);
      return event;
    },
    pointer(target: Element, type: string, values: Record<string, unknown> = {}) {
      if (type !== 'pointerdown') target = pointerCapture.get(Number(values.pointerId ?? 1)) || target;
      const event: any = { type, target, bubbles: true, pointerId: 1, button: 0, clientX: 10, clientY: 10, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, stopImmediatePropagation() { this.stopped = true; this.immediateStopped = true; }, ...values };
      target.dispatchEvent(event);
      if (!event.stopped) document.dispatchEvent(event);
      if (!event.stopped) for (const listener of windowListeners.get(type) || []) listener(event);
      if (type === 'pointerup' || type === 'pointercancel') pointerCapture.delete(event.pointerId);
      return event;
    },
  };
}

test('切换工作区时迟到的旧 open 结果不覆盖新激活', async () => {
  const app = fixture();
  const openingA = app.api.open({ activationId: 11, workspaceId: 'A', view: 'graph' });
  const openingB = app.api.open({ activationId: 12, workspaceId: 'B', view: 'graph' });
  await app.resolve(1, workspace('B'));
  await openingB;
  await app.resolve(0, workspace('A'));
  await openingA;
  assert.equal(app.api.isOpen(), true);
  assert.equal(app.api.getSnapshot().workspaceId, 'B');
  assert.equal(app.api.getSnapshot().graphId, 'graph-B');
  assert.equal(app.api.getChatContext().workspaceId, 'B');
});

test('等待 graphOpen 时关闭后，迟到结果不能重新打开界面', async () => {
  const app = fixture();
  const opening = app.api.open({ activationId: 21, workspaceId: 'A', view: 'graph' });
  app.api.close();
  await app.resolve(0, workspace('A'));
  await opening;
  assert.equal(app.api.isOpen(), false);
  assert.equal(app.api.getSnapshot().open, false);
  const closing = app.events.filter(event => event.type === 'graph:close');
  assert.equal(closing.length, 1);
  assert.equal(closing[0].detail.activationId, 21);
});

test('工作区更新只接收当前文档的新修订，陈旧或其它工作区消息不覆盖画布', async () => {
  const app = fixture();
  const opening = app.api.open({ activationId: 31, workspaceId: 'A', view: 'graph' });
  await app.resolve(0, workspace('A', 5)); await opening;
  const latest = workspace('A', 7); latest.graphs[0].nodes[0].title = '最新标题';
  app.changed(latest);
  app.changed(workspace('A', 6));
  app.changed(workspace('B', 100));
  const snapshot = app.api.getSnapshot();
  assert.equal(snapshot.workspaceId, 'A');
  assert.equal(snapshot.workspace.revision, 7);
  assert.equal(snapshot.workspace.graphs[0].nodes[0].title, '最新标题');
});

test('流式正文和状态更新不反复提交相同树布局', async () => {
  const app = fixture(), data = workspace('A'), root = data.graphs[0].nodes[0];
  data.graphs[0].nodes.push({ ...structuredClone(root), id: 'child', parentId: root.id, kind: 'card', x: -500, y: 900, status: 'generating' });
  const opening = app.api.open({ activationId: 35, workspaceId: 'A', view: 'graph' });
  await app.resolve(0, data); await opening; await flush();
  assert.equal(app.mutations.filter(item => item.mutation.type === 'layout').length, 1);
  for (let revision = 2; revision <= 5; revision++) {
    const updated = app.api.getSnapshot().workspace;
    updated.revision = revision; updated.graphs[0].nodes[1].draft = '### 标题\n' + '内容'.repeat(revision);
    app.changed(updated); await flush();
  }
  assert.equal(app.mutations.filter(item => item.mutation.type === 'layout').length, 1);
  const positions = app.api.getSnapshot().workspace.graphs[0].nodes;
  assert.ok(positions[1].x > positions[0].x); assert.equal(positions[1].y, positions[0].y);
});

test('触控板平移和Ctrl缩放经过画布入口生效，卡内阅读滚动不被劫持', async () => {
  const app = fixture(), opening = app.api.open({ activationId: 36, workspaceId: 'A', view: 'graph' });
  await app.resolve(0, workspace('A')); await opening;
  const viewport = app.document.querySelector('.rg-viewport'), world = app.document.querySelector('.rg-world');
  const initial = app.api.getSnapshot().view;
  app.wheel(viewport, { deltaX: 14, deltaY: 9 });
  const panned = app.api.getSnapshot().view;
  assert.deepEqual(JSON.parse(JSON.stringify(panned)), { x: initial.x - 14, y: initial.y - 9, zoom: initial.zoom });
  app.tick(50); app.wheel(viewport, { deltaY: 100 });
  assert.equal(app.api.getSnapshot().view.zoom, initial.zoom);
  const beforePinch = app.api.getSnapshot().view, point = { x: 400, y: 300 };
  app.wheel(viewport, { deltaY: -8, ctrlKey: true, clientX: point.x, clientY: point.y });
  const zoomed = app.api.getSnapshot().view;
  assert.ok(zoomed.zoom > beforePinch.zoom);
  assert.ok(Math.abs((point.x - zoomed.x) / zoomed.zoom - (point.x - beforePinch.x) / beforePinch.zoom) < 1e-9);
  assert.ok(Math.abs((point.y - zoomed.y) / zoomed.zoom - (point.y - beforePinch.y) / beforePinch.zoom) < 1e-9);
  assert.equal(Number(world.style['--rg-control-scale']), 1 / zoomed.zoom);
  const event = app.wheel(world.querySelector('.rg-card-scroll'), { deltaY: 120 });
  assert.equal(event.defaultPrevented, undefined); assert.deepEqual(app.api.getSnapshot().view, zoomed);
  app.tick(250); app.wheel(viewport, { deltaY: 120 });
  assert.ok(app.api.getSnapshot().view.zoom < zoomed.zoom);
});

test('进入和切图居中根节点，拖动缩放与窗口缩小时统一约束视角', async () => {
  const app = fixture(), data = workspace('A'), original = data.graphs[0]; original.layoutUnit = 240;
  original.view = { x: 5000, y: -5000, zoom: .4 };
  original.nodes.push(...[['a', 'root'], ['b', 'a']].map(([id, parentId]) => ({ ...structuredClone(original.nodes[0]), id, parentId, kind: 'card' as const })));
  data.graphs.push({ ...structuredClone(original), id: 'second-graph', title: '第二张图', view: { x: -9000, y: 7000, zoom: 1.8 } });
  const opening = app.api.open({ activationId: 365, workspaceId: 'A', view: 'graph' }); await app.resolve(0, data); await opening;
  const viewport = app.document.querySelector('.rg-viewport'), root = app.document.getElementById('rabbit-graph-root');
  const assertRootCentered = () => {
    const snapshot = app.api.getSnapshot(), graph = snapshot.workspace.graphs.find((item: any) => item.id === snapshot.graphId), card = app.document.querySelector('.rg-world').querySelectorAll('.rg-card').find((item: any) => item.dataset.nodeId === graph.rootId);
    const width = parseFloat(root.style['--rg-width']);
    assert.equal(snapshot.view.zoom, 1);
    assert.ok(Math.abs(snapshot.view.x + parseFloat(card.style.left) + width / 2 - viewport.clientWidth / 2) < 1e-9);
    assert.ok(Math.abs(snapshot.view.y + parseFloat(card.style.top) + parseFloat(card.style.height) / 2 - viewport.clientHeight / 2) < 1e-9);
  };
  const dragFar = () => { app.pointer(viewport, 'pointerdown'); app.pointer(viewport, 'pointermove', { clientX: -1e6, clientY: -1e6 }); app.pointer(viewport, 'pointerup', { clientX: -1e6, clientY: -1e6 }); return app.api.getSnapshot().view; };
  assertRootCentered();
  const limited = dragFar(); assert.ok(Math.abs(limited.x) < 10000 && Math.abs(limited.y) < 10000);
  assert.deepEqual(dragFar(), limited);
  app.wheel(viewport, { deltaY: 1000, ctrlKey: true }); assert.equal(app.api.getSnapshot().view.zoom, .4);
  const zoomedEdge = dragFar(); assert.deepEqual(dragFar(), zoomedEdge);
  app.resize(600, 400); await flush(); await flush();
  assert.equal(app.api.getSnapshot().view.zoom, .4, 'resize保留当前缩放');
  const resizedEdge = dragFar(); assert.deepEqual(dragFar(), resizedEdge);
  assert.notEqual(resizedEdge.x, zoomedEdge.x, '窗口变化后边界按新viewport重新计算');
  app.click(app.document.querySelector('[aria-label="打开图谱：第二张图"]')); await flush(); assertRootCentered();
  app.wheel(viewport, { deltaX: 30, deltaY: 20 });
  app.click(app.document.querySelector('[aria-label="打开图谱：图"]')); await flush(); assertRootCentered();
});

test('当前图回正逐帧更新真实视角，流式刷新不中断平滑到根中心', async () => {
  const app = fixture(undefined, { manualFrames: true }), data = workspace('A'); data.graphs[0].layoutUnit = 240;
  const opening = app.api.open({ activationId: 366, workspaceId: 'A', view: 'graph' }); await app.resolve(0, data); await opening;
  const target = { x: 180, y: -60, zoom: 1 }, viewport = app.document.querySelector('.rg-viewport'), world = app.document.querySelector('.rg-world');
  assert.deepEqual(JSON.parse(JSON.stringify(app.api.getSnapshot().view)), target, '首次打开直接居中');
  app.pointer(viewport, 'pointerdown'); app.pointer(viewport, 'pointermove', { clientX: 90, clientY: 60 }); app.pointer(viewport, 'pointerup', { clientX: 90, clientY: 60 });
  const before = app.api.getSnapshot().view;
  app.click(app.document.querySelector('[aria-label="打开图谱：图"]')); app.frame(0);
  assert.deepEqual(app.api.getSnapshot().view, before);
  app.frame(120); const middle = app.api.getSnapshot().view;
  assert.ok(middle.x < before.x && middle.x > target.x); assert.ok(middle.y < before.y && middle.y > target.y);
  assert.ok((before.x - middle.x) / (before.x - target.x) > 120 / 420, '使用非线性减速曲线');
  assert.equal(world.style.transform, `translate(${middle.x}px,${middle.y}px) scale(${middle.zoom})`);
  const updated = app.api.getSnapshot().workspace; updated.revision++; updated.graphs[0].nodes[0].title = '更新中'; app.changed(updated);
  app.frame(300);
  assert.deepEqual(JSON.parse(JSON.stringify(app.api.getSnapshot().view)), target);
  assert.equal(world.style.transform, 'translate(180px,-60px) scale(1)');
});

test('快速切图只有最后一次回正完成，手动平移中断后不被迟到动画复位', async () => {
  const app = fixture(undefined, { manualFrames: true }), data = workspace('A'); data.graphs[0].layoutUnit = 240;
  for (const [id, x] of [['B', 1000], ['C', -500]] as const) {
    const graph = structuredClone(data.graphs[0]); graph.id = id; graph.title = id; graph.nodes[0].x = x; data.graphs.push(graph);
  }
  const opening = app.api.open({ activationId: 367, workspaceId: 'A', view: 'graph' }); await app.resolve(0, data); await opening;
  app.click(app.document.querySelector('[aria-label="打开图谱：B"]')); app.frame(120);
  app.click(app.document.querySelector('[aria-label="打开图谱：C"]')); app.frame(120); app.frame(300); await flush();
  assert.equal(app.api.getSnapshot().graphId, 'C');
  assert.deepEqual(JSON.parse(JSON.stringify(app.api.getSnapshot().view)), { x: 980, y: -60, zoom: 1 });
  app.frame(1000); assert.deepEqual(JSON.parse(JSON.stringify(app.api.getSnapshot().view)), { x: 980, y: -60, zoom: 1 });
  const viewport = app.document.querySelector('.rg-viewport'); app.wheel(viewport, { deltaX: -60, deltaY: -40 });
  app.click(app.document.querySelector('[aria-label="打开图谱：C"]')); app.frame(120);
  app.wheel(viewport, { deltaX: 8, deltaY: 4 }); const interrupted = app.api.getSnapshot().view;
  app.frame(1000); await flush(); app.frame(1000);
  assert.deepEqual(app.api.getSnapshot().view, interrupted);
});

test('减少动态效果时回正和切图直接到位且不留下延迟视角修改', async () => {
  const app = fixture(undefined, { manualFrames: true, reducedMotion: true }), data = workspace('A'); data.graphs[0].layoutUnit = 240;
  const second = structuredClone(data.graphs[0]); second.id = 'second'; second.title = '第二张图'; second.nodes[0].x = 1000; data.graphs.push(second);
  const opening = app.api.open({ activationId: 368, workspaceId: 'A', view: 'graph' }); await app.resolve(0, data); await opening;
  app.wheel(app.document.querySelector('.rg-viewport'), { deltaX: 30, deltaY: 20 });
  app.click(app.document.querySelector('[aria-label="打开图谱：图"]'));
  assert.deepEqual(JSON.parse(JSON.stringify(app.api.getSnapshot().view)), { x: 180, y: -60, zoom: 1 });
  app.click(app.document.querySelector('[aria-label="打开图谱：第二张图"]'));
  const target = { x: -520, y: -60, zoom: 1 };
  assert.deepEqual(JSON.parse(JSON.stringify(app.api.getSnapshot().view)), target);
  app.frame(1000); await flush(); assert.deepEqual(JSON.parse(JSON.stringify(app.api.getSnapshot().view)), target);
});

test('正文单指保留原生手势，双指平移缩放不受pointercancel影响且松一指无跳变', async () => {
  const app = fixture(), data = workspace('A'); data.graphs[0].layoutUnit = 240; data.graphs[0].nodes[0].markdown = '可选正文';
  const opening = app.api.open({ workspaceId: 'A' }); await app.resolve(0, data); await opening;
  const body = app.document.querySelector('.rg-world .rg-body'), viewport = app.document.querySelector('.rg-viewport');
  const point = (identifier: number, clientX: number, clientY: number) => ({ identifier, clientX, clientY, target: body });
  const before = app.api.getSnapshot().view, first = point(1, 400, 300);
  assert.equal(app.pointer(body, 'pointerdown', { pointerType: 'touch' }).defaultPrevented, undefined);
  assert.equal(viewport.hasPointerCapture(1), false);
  assert.equal(app.touch(body, 'touchstart', [first]).defaultPrevented, false);
  assert.equal(app.touch(body, 'touchmove', [point(1, 420, 310)]).defaultPrevented, false);
  assert.deepEqual(app.api.getSnapshot().view, before); app.touch(body, 'touchend', [], [first]);
  app.touch(body, 'touchstart', [first]);
  assert.equal(app.touch(body, 'touchstart', [first, point(2, 600, 300)], [point(2, 600, 300)]).defaultPrevented, true);
  app.pointer(body, 'pointercancel', { pointerId: 1, pointerType: 'touch' });
  assert.equal(viewport.classList.contains('is-panning'), true);
  assert.equal(app.touch(body, 'touchmove', [point(1, 350, 330), point(2, 650, 330)]).defaultPrevented, true);
  assert.deepEqual(JSON.parse(JSON.stringify(app.api.getSnapshot().view)), { x: 20, y: -210, zoom: 1.5 });
  const pinched = app.api.getSnapshot().view, remaining = point(2, 650, 330);
  app.touch(body, 'touchend', [remaining], [point(1, 350, 330)]);
  app.touch(body, 'touchmove', [remaining]); assert.deepEqual(app.api.getSnapshot().view, pinched);
  app.touch(body, 'touchmove', [point(2, 670, 345)]);
  assert.deepEqual(JSON.parse(JSON.stringify(app.api.getSnapshot().view)), { x: 40, y: -195, zoom: 1.5 });
  app.touch(body, 'touchend', [], [point(2, 670, 345)]);
  assert.equal(viewport.classList.contains('is-panning'), false);
});

test('外壳单指平移后抑制合成点击，新触摸开始恢复点击，控件触摸不接管画布', async () => {
  const app = fixture(), data = workspace('A'), opening = app.api.open({ workspaceId: 'A' }); await app.resolve(0, data); await opening;
  const card = app.document.querySelector('.rg-world .rg-card'), viewport = app.document.querySelector('.rg-viewport');
  const point = (x: number) => ({ identifier: 1, clientX: x, clientY: 300, target: card });
  const before = app.api.getSnapshot().view;
  app.pointer(card, 'pointerdown', { pointerType: 'touch', clientX: 400, clientY: 300 });
  app.touch(card, 'touchstart', [point(400)]);
  assert.equal(app.touch(card, 'touchmove', [point(430)]).defaultPrevented, true);
  assert.ok(Math.abs(app.api.getSnapshot().view.x - before.x - 30) < 1e-9);
  app.touch(card, 'touchend', [], [point(430)]);
  assert.equal(app.click(card, { detail: 1, pointerType: 'touch', clientX: 430, clientY: 300 }).defaultPrevented, true);
  assert.equal(app.document.querySelector('.rg-focus .rg-card'), null);
  app.pointer(card, 'pointerdown', { pointerType: 'touch', clientX: 430, clientY: 300 });
  app.touch(card, 'touchstart', [point(430)]); app.pointer(card, 'pointerup', { pointerType: 'touch', clientX: 430, clientY: 300 }); app.touch(card, 'touchend', [], [point(430)]);
  app.click(card, { detail: 1, pointerType: 'touch', clientX: 430, clientY: 300 }); await flush();
  assert.ok(app.document.querySelector('.rg-focus .rg-card')); app.click(app.document.querySelector('.rg-focus')); await flush();
  const button = card.querySelector('[aria-label="固定卡片"]'), control = { identifier: 2, clientX: 500, clientY: 300, target: button }, unchanged = app.api.getSnapshot().view;
  assert.equal(app.touch(button, 'touchstart', [point(430), control]).defaultPrevented, false);
  assert.equal(app.touch(button, 'touchmove', [point(450), { ...control, clientX: 600 }]).defaultPrevented, false);
  assert.deepEqual(app.api.getSnapshot().view, unchanged); assert.equal(viewport.classList.contains('is-panning'), false);
});

test('触摸取消、失焦、切图和关闭清理手势，原生接管内滚后不再写入视角', async () => {
  for (const ending of ['touchcancel', 'blur', 'context', 'close', 'native-scroll']) {
    const app = fixture(), data = workspace('A'); data.graphs.push({ ...structuredClone(data.graphs[0]), id: 'second', title: '第二张图' });
    const opening = app.api.open({ workspaceId: 'A' }); await app.resolve(0, data); await opening;
    const viewport = app.document.querySelector('.rg-viewport'), points = [{ identifier: 1, clientX: 400, clientY: 300 }, { identifier: 2, clientX: 600, clientY: 300 }];
    app.touch(viewport, 'touchstart', points);
    app.touch(viewport, 'touchmove', points.map(point => ({ ...point, clientX: point.clientX + 20 })));
    if (ending === 'touchcancel') app.touch(viewport, 'touchcancel', [], points);
    else if (ending === 'blur') app.emitWindow('blur');
    else if (ending === 'context') app.click(app.document.querySelector('[aria-label="打开图谱：第二张图"]'));
    else if (ending === 'close') app.api.close();
    else {
      const before = app.api.getSnapshot().view;
      const native = app.touch(viewport, 'touchmove', points, points, { cancelable: false });
      assert.equal(native.defaultPrevented, false); assert.deepEqual(app.api.getSnapshot().view, before);
    }
    await flush(); assert.equal(viewport.classList.contains('is-panning'), false, ending);
    const stopped = app.api.getSnapshot().view;
    app.touch(viewport, 'touchmove', points.map(point => ({ ...point, clientX: point.clientX + 50 })));
    assert.deepEqual(app.api.getSnapshot().view, stopped, ending);
    assert.equal(viewport.classList.contains('is-panning'), false, ending);
  }
});

test('放大从原牌实际边界展开，收回完成才恢复原牌，快速重开不被旧动画撤销', async () => {
  const app = fixture(), opening = app.api.open({ activationId: 37, workspaceId: 'A', view: 'graph' });
  await app.resolve(0, workspace('A')); await opening;
  const root = app.document.getElementById('rabbit-graph-root'), origin = app.document.querySelector('.rg-world').querySelector('.rg-card');
  const bounds = (left: number, top: number, width: number, height: number) => ({ x: left, y: top, left, top, width, height, right: left + width, bottom: top + height });
  root.getBoundingClientRect = () => bounds(20, 30, 1200, 800);
  origin.getBoundingClientRect = () => bounds(330, 200, 240, 320);
  assert.equal(origin.querySelector('.rg-title').hidden, true);
  assert.equal(origin.classList.contains('is-root'), true);
  const moving = (element: any) => app.animations.filter(animation => animation.element === element).at(-1)!;
  const finishMotions = (element: any) => app.animations.filter(animation => element.contains(animation.element)).forEach(animation => animation.pending.resolve());
  app.holdAnimations(); app.click(origin);
  const focused = app.document.querySelector('.rg-focus').querySelector('.rg-card'), expand = moving(focused);
  assert.equal(origin.querySelector('.rg-handle'), null, '画布卡片本身可拖动，不显示手柄');
  assert.equal(focused.querySelector('.rg-handle'), null, '放大阅读牌无需拖动手柄');
  assert.equal(root.querySelector('.rg-focus-close'), null, '放大阅读使用空白或Escape收回，不增加专用关闭按钮');
  assert.equal(root.querySelector('[aria-label="收回卡片"]'), null);
  assert.equal(focused.querySelector('.rg-pin-toggle').parentElement, focused, '固定按钮独立于卡片工具栏');
  assert.equal(focused.querySelector('.rg-title').hidden, true);
  assert.equal(origin.classList.contains('is-focus-origin'), true);
  assert.equal(expand.element, focused);
  for (const [property, value] of Object.entries({ left: '310px', top: '170px', width: '240px', height: '320px' })) assert.equal(expand.keyframes[0][property], value);
  for (const frame of expand.keyframes) assert.equal('transform' in frame, false, '牌面通过真实尺寸变化而非整体缩放');
  for (const property of ['left', 'top', 'width', 'height']) assert.equal(expand.keyframes[1][property], focused.style[property]);
  for (const animation of app.animations.filter(item => item.element === focused.querySelector('.rg-content') || item.element === focused.querySelector('.rg-body'))) {
    for (const frame of animation.keyframes) { assert.equal(frame.fontSize, '15px'); assert.equal(frame.lineHeight, '27px'); }
  }
  assert.ok(parseFloat(focused.style.width) > 240);
  finishMotions(focused); await flush();
  focused.getBoundingClientRect = () => bounds(20 + parseFloat(focused.style.left), 30 + parseFloat(focused.style.top), parseFloat(focused.style.width), parseFloat(focused.style.height));
  origin.getBoundingClientRect = () => bounds(400, 250, 240, 320);
  app.click(app.document.querySelector('.rg-focus'));
  const retract = moving(focused);
  assert.equal(origin.classList.contains('is-focus-origin'), true); assert.equal(focused.isConnected, true);
  assert.equal(focused.inert, true, '退场中的卡片及其工具不能再接收操作');
  for (const [property, value] of Object.entries({ left: '380px', top: '220px', width: '240px', height: '320px' })) assert.equal(retract.keyframes[1][property], value);
  finishMotions(focused); await flush();
  assert.equal(origin.classList.contains('is-focus-origin'), false); assert.equal(focused.isConnected, false);
  app.click(origin); const closing = app.document.querySelector('.rg-focus').querySelector('.rg-card'); finishMotions(closing); await flush();
  app.document.dispatchEvent({ type: 'keydown', key: 'Escape', preventDefault() {} });
  app.click(origin); const newest = app.document.querySelector('.rg-focus').querySelectorAll('.rg-card').at(-1);
  finishMotions(closing); await flush();
  assert.equal(origin.classList.contains('is-focus-origin'), true); assert.equal(newest.isConnected, true);
  finishMotions(newest); await flush();
  app.api.close(); await flush();
  assert.equal(origin.classList.contains('is-focus-origin'), false);
});

test('放大胶囊与批注按同一时间轴跟随中间布局，完成或切换卡片后停止旧帧', async () => {
  const app = fixture(), data = workspace('A'), rootNode = data.graphs[0].nodes[0];
  data.graphs[0].nodes.push({ ...structuredClone(rootNode), id: 'answer', parentId: 'root', kind: 'card', title: '带批注的卡片',
    images: [{ id: 'screen', title: '截图', imageDataUrl: 'data:image/png;base64,AA==' }],
    annotations: [{ id: 'note', comment: '解释', selection: { kind: 'image', imageId: 'screen', rect: { x: .2, y: .2, width: .3, height: .3 } } }] });
  const opening = app.api.open({ activationId: 371, workspaceId: 'A', view: 'graph' }); await app.resolve(0, data); await opening;
  const card = (id: string) => app.document.querySelector('.rg-world').querySelectorAll('.rg-card').find((item: any) => item.dataset.nodeId === id);
  const origin = card('answer'), bounds = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height });
  origin.getBoundingClientRect = () => bounds(330, 200, 180, 240);
  const motions = (element: any, after = 0) => app.animations.slice(after).filter(animation => element.contains(animation.element));
  const finish = (items: typeof app.animations) => items.forEach(animation => animation.pending.resolve());
  app.holdAnimations(); app.tick(18); const first = app.animations.length; app.click(origin);
  const focused = app.document.querySelector('.rg-focus').querySelector('.rg-card'), title = focused.querySelector('.rg-title');
  const openingMotions = motions(focused, first), geometry = openingMotions.find(animation => animation.element === focused)!, capsule = openingMotions.find(animation => animation.element === title)!;
  assert.ok(capsule); assert.equal(focused.inert, true);
  assert.ok(openingMotions.every(animation => animation.options.duration === 400 && animation.startTime === 18));
  assert.equal(capsule.keyframes[0].transform, 'translate(-50%,-50%) scale(0.75)');
  assert.equal(capsule.keyframes[1].transform, 'translate(-50%,-50%) scale(1)');
  for (const element of [focused.querySelector('.rg-content'), focused.querySelector('.rg-body')]) {
    const text = openingMotions.find(animation => animation.element === element)!;
    assert.deepEqual(JSON.parse(JSON.stringify(text.keyframes)), [{ fontSize: '11.25px', lineHeight: '20.25px' }, { fontSize: '15px', lineHeight: '27px' }]);
  }
  let width = 180, reads = 0;
  const content = focused.querySelector('.rg-content'), image = focused.querySelector('.rg-image').querySelector('img');
  content.getBoundingClientRect = () => bounds(20, 30, width, width * 4 / 3);
  image.getBoundingClientRect = () => { reads++; return bounds(34, 55, width - 28, (width - 28) * .6); };
  await flush();
  assert.ok(Math.abs(parseFloat(focused.querySelector('.rg-mark').style.width) - (180 - 28) * .3) < 1e-9);
  width = 360; await flush();
  assert.ok(Math.abs(parseFloat(focused.querySelector('.rg-mark').style.width) - (360 - 28) * .3) < 1e-9);
  geometry.pending.resolve(); await flush(); assert.equal(focused.inert, true, '所有同步部件完成之前不提前解锁');
  finish(openingMotions); await flush(); assert.equal(focused.inert, false);
  const settledReads = reads; width = 420; await flush(); await flush(); assert.equal(reads, settledReads, '完成后不再运行逐帧重绘');
  const closingStart = app.animations.length; app.click(app.document.querySelector('.rg-focus'));
  const closingMotions = motions(focused, closingStart);
  assert.ok(closingMotions.every(animation => animation.options.duration === 320));
  assert.equal(closingMotions.find(animation => animation.element === title)!.keyframes[1].transform, 'translate(-50%,-50%) scale(0.75)');
  finish(closingMotions); await flush(); assert.equal(focused.isConnected, false);
  const second = app.animations.length; app.click(origin);
  const interrupted = app.document.querySelector('.rg-focus').querySelector('.rg-card'), interruptedMotions = motions(interrupted, second);
  app.click(card('root')); await flush();
  assert.ok(interruptedMotions.every(animation => animation.cancelled)); assert.equal(interrupted.isConnected, false);
  assert.equal(origin.classList.contains('is-focus-origin'), false);
  const latest = app.document.querySelector('.rg-focus').querySelector('.rg-card');
  assert.equal(latest.dataset.nodeId, 'root'); assert.equal(card('root').classList.contains('is-focus-origin'), true);
  finish(motions(latest)); await flush(); app.api.close(); await flush();
});

test('卡片拖动超过阈值才开始，小幅移动仍单击展开且工具按钮不触发拖动', async () => {
  const app = fixture(), data = workspace('A');
  const opening = app.api.open({ workspaceId: 'A' }); await app.resolve(0, data); await opening;
  const card = app.document.querySelector('.rg-world .rg-card'), overlay = app.document.querySelector('#rabbit-graph-root');
  assert.equal(card.querySelector('.rg-handle'), null);
  app.pointer(card, 'pointerdown');
  app.pointer(card, 'pointermove', { clientX: 16 });
  assert.equal(app.document.querySelector('.rg-drag-ghost'), null, '6px内不开始拖动');
  assert.equal(overlay.hasPointerCapture(1), false);
  app.pointer(card, 'pointerup', { clientX: 14 }); app.click(card, { detail: 1, clientX: 14, clientY: 10 }); await flush();
  assert.ok(app.document.querySelector('.rg-focus .rg-card'), '轻微抖动仍按单击展开');
  app.click(app.document.querySelector('.rg-focus')); await flush();
  for (const button of card.querySelectorAll('button').filter((item: any) => !item.classList.contains('rg-title'))) {
    app.pointer(button, 'pointerdown'); app.pointer(button, 'pointermove', { clientX: 30 });
    assert.equal(app.document.querySelector('.rg-drag-ghost'), null, '卡片工具按钮不能成为拖动入口');
    app.pointer(button, 'pointercancel');
  }
  app.pointer(card, 'pointerdown'); app.pointer(card, 'pointermove', { clientX: 17 });
  assert.ok(app.document.querySelector('.rg-drag-ghost'), '超过6px后开始拖动');
  assert.equal(overlay.hasPointerCapture(1), true);
  app.pointer(card, 'pointercancel'); await flush(); await flush();
  assert.equal(app.document.querySelector('.rg-drag-ghost'), null);
  assert.equal(app.mutations.some(item => ['reparent', 'move-subtree'].includes(item.mutation.type)), false);
});

test('尚未开始的卡片拖动在松开、取消或失焦后不被迟到移动唤起', async () => {
  for (const ending of ['pointerup', 'pointercancel', 'blur', 'close']) {
    const app = fixture(), data = workspace('A');
    const opening = app.api.open({ workspaceId: 'A' }); await app.resolve(0, data); await opening;
    const card = app.document.querySelector('.rg-world .rg-card');
    app.pointer(card, 'pointerdown'); app.pointer(card, 'pointermove', { clientX: 12 });
    if (ending === 'blur') app.emitWindow('blur');
    else if (ending === 'close') app.api.close();
    else app.pointer(card, ending);
    app.pointer(card, 'pointermove', { clientX: 100 }); app.pointer(card, 'pointerup', { clientX: 100 });
    await flush(); await flush();
    assert.equal(app.document.querySelector('.rg-drag-ghost'), null, ending);
    assert.equal(app.mutations.some(item => ['reparent', 'move-subtree'].includes(item.mutation.type)), false);
  }
});

test('子树可重新挂到根或已有子卡的节点，仍拒绝自连和挂到后代', async () => {
  for (const [moving, target, accepted] of [['b', 'root', true], ['b', 'c', true], ['a', 'a', false], ['a', 'b', false]] as const) {
    const app = fixture(), data = workspace('A'), graph = data.graphs[0], root = graph.nodes[0];
    graph.nodes.push(...[['a', 'root'], ['b', 'a'], ['c', 'root'], ['d', 'c']].map(([id, parentId]) => ({ ...structuredClone(root), id, parentId, kind: 'card' as const })));
    const opening = app.api.open({ activationId: 38, workspaceId: 'A', view: 'graph' });
    await app.resolve(0, data); await opening;
    const card = (id: string) => app.document.querySelector('.rg-world').querySelectorAll('.rg-card').find((item: any) => item.dataset.nodeId === id);
    const handle = card(moving), destination = card(target);
    app.pointAt(destination); app.pointer(handle, 'pointerdown'); app.pointer(handle, 'pointermove', { clientX: 30, clientY: 30 });
    assert.equal(destination.classList.contains('is-target'), accepted, `${moving} → ${target}`);
    app.pointer(handle, 'pointerup'); await flush(); await flush();
    const mutations = app.mutations.filter(item => item.mutation.type === 'reparent');
    assert.deepEqual(JSON.parse(JSON.stringify(mutations)), accepted ? [{ workspaceId: 'A', mutation: { type: 'reparent', graphId: 'graph-A', nodeId: moving, parentId: target } }] : []);
  }
});

test('跨图拖动来源子树可挂到已有子卡的非叶节点', async () => {
  const app = fixture(), data = workspace('A'), original = data.graphs[0].nodes[0];
  data.graphs.push({ ...structuredClone(data.graphs[0]), id: 'target-graph', title: '目标图', rootId: 'target-root', nodes: [
    { ...structuredClone(original), id: 'target-root' },
    { ...structuredClone(original), id: 'target-branch', parentId: 'target-root', kind: 'card' },
    { ...structuredClone(original), id: 'target-leaf', parentId: 'target-branch', kind: 'card' },
  ] });
  const opening = app.api.open({ activationId: 39, workspaceId: 'A', view: 'graph' });
  await app.resolve(0, data); await opening;
  let current = data;
  app.mutateWith(mutation => {
    if (mutation.type === 'move-subtree') {
      current = app.api.getSnapshot().workspace;
      const source = current.graphs.find(graph => graph.id === mutation.graphId)!, target = current.graphs.find(graph => graph.id === mutation.targetGraphId)!;
      const node = source.nodes.find(node => node.id === mutation.nodeId)!;
      source.nodes = source.nodes.filter(item => item !== node); node.parentId = mutation.targetNodeId; target.nodes.push(node);
      current.lastGraphId = target.id; current.revision++;
    }
    return current;
  });
  assert.equal(app.document.querySelector('.rg-world').querySelector('.rg-title').hidden, true);
  const handle = app.document.querySelector('.rg-world').querySelector('.rg-card');
  app.pointAt(app.document.querySelector('[aria-label="打开图谱：目标图"]'));
  app.pointer(handle, 'pointerdown'); app.pointer(handle, 'pointermove', { clientX: 30, clientY: 30 }); app.tick(450); await flush();
  const destination = app.document.querySelector('.rg-world').querySelectorAll('.rg-card').find((item: any) => item.dataset.nodeId === 'target-branch');
  app.pointAt(destination); app.pointer(handle, 'pointermove', { clientX: 30, clientY: 30 });
  assert.equal(destination.classList.contains('is-target'), true);
  app.pointer(handle, 'pointerup'); await flush(); await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(app.mutations.filter(item => item.mutation.type === 'move-subtree'))), [{ workspaceId: 'A', mutation: {
    type: 'move-subtree', graphId: 'graph-A', nodeId: 'root', targetGraphId: 'target-graph', targetNodeId: 'target-branch',
  } }]);
  const moved = app.document.querySelector('.rg-world').querySelectorAll('.rg-card').find((item: any) => item.dataset.nodeId === 'root');
  assert.equal(moved.querySelector('.rg-title').hidden, false, '来源根移为子节点后恢复标题');
  assert.equal(moved.classList.contains('is-root'), false);
});

test('结构撤销重做只接管画布快捷键，输入、IME、聊天和设置仍走自身路径', async () => {
  const app = fixture(), opening = app.api.open({ activationId: 40, workspaceId: 'A', view: 'graph' });
  await app.resolve(0, workspace('A')); await opening;
  const viewport = app.document.querySelector('.rg-viewport');
  function key(target: any, values: Record<string, unknown> = {}) {
    const event = { type: 'keydown', key: 'z', ctrlKey: true, target, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; }, ...values };
    app.document.dispatchEvent(event); return event;
  }
  for (const values of [{}, { shiftKey: true }, { key: 'y' }]) assert.equal(key(viewport, values).defaultPrevented, true);
  await flush();
  assert.deepEqual(Array.from(app.mutations, item => item.mutation.type), ['undo', 'redo', 'redo']);
  const excluded = ['input', 'textarea', 'select'].map(tag => app.document.createElement(tag));
  const editable = app.document.createElement('div'); editable.setAttribute('contenteditable', 'true');
  const inner = app.document.createElement('span'); editable.append(inner); excluded.push(inner);
  for (const id of ['rabbit-chat-root', 'rabbit-settings-root']) {
    const panel = app.document.createElement('div'); panel.id = id;
    const child = app.document.createElement('button'); panel.append(child); excluded.push(child);
  }
  for (const target of excluded) assert.equal(key(target).defaultPrevented, false);
  for (const values of [{ isComposing: true }, { keyCode: 229 }, { altKey: true }, { ctrlKey: false }]) assert.equal(key(viewport, values).defaultPrevented, false);
  key(viewport, { defaultPrevented: true });
  app.document.getElementById('rabbit-graph-root').classList.add('capture-suspended');
  assert.equal(key(viewport).defaultPrevented, false); await flush();
  assert.equal(app.mutations.length, 3);
  app.document.getElementById('rabbit-graph-root').classList.remove('capture-suspended'); app.api.close(); await flush();
  const mutations = app.mutations.length; assert.equal(key(viewport).defaultPrevented, false); await flush(); assert.equal(app.mutations.length, mutations);
});

test('聊天上下文只在工作区或图谱切换时通知，同图选卡和流式更新不重复发出', async () => {
  const app = fixture(), data = workspace('A');
  data.graphs.push({ ...structuredClone(data.graphs[0]), id: 'second-graph', title: '第二张图' });
  const contexts = () => JSON.parse(JSON.stringify(app.events.filter(event => event.type === 'graph:contextchange').map(event => event.detail)));
  const opening = app.api.open({ activationId: 42, workspaceId: 'A', view: 'graph' });
  await app.resolve(0, data); await opening;
  app.click(app.document.querySelector('.rg-world').querySelector('.rg-card')); await flush();
  const update = app.api.getSnapshot().workspace; update.revision++; update.graphs[0].nodes[0].title = '流式更新'; app.changed(update); await flush();
  assert.deepEqual(contexts(), [{ workspaceId: 'A', graphId: 'graph-A' }]);
  app.click(app.document.querySelector('[aria-label="打开图谱：第二张图"]')); await flush();
  app.click(app.document.querySelector('.rg-world').querySelector('.rg-card')); await flush();
  assert.deepEqual(contexts(), [{ workspaceId: 'A', graphId: 'graph-A' }, { workspaceId: 'A', graphId: 'second-graph' }]);
  const next = app.api.open({ activationId: 43, workspaceId: 'B', view: 'graph' }); await app.resolve(1, workspace('B')); await next;
  app.api.close(); app.api.close(); await flush();
  assert.deepEqual(contexts(), [{ workspaceId: 'A', graphId: 'graph-A' }, { workspaceId: 'A', graphId: 'second-graph' }, { workspaceId: 'B', graphId: 'graph-B' }, null]);
});

test('更新移除当前图时清除旧牌并居中接替图根节点，无图上下文只通知一次', async () => {
  const app = fixture(), data = workspace('A'); data.graphs[0].layoutUnit = 240;
  const second = { ...structuredClone(data.graphs[0]), id: 'second-graph', title: '第二张图', view: { x: 42, y: -15, zoom: .75 } };
  second.nodes[0].title = '第二张图的根'; data.graphs.push(second);
  const opening = app.api.open({ activationId: 44, workspaceId: 'A', view: 'graph' }); await app.resolve(0, data); await opening;
  const oldCard = app.document.querySelector('.rg-world').querySelector('.rg-card');
  app.click(oldCard); await flush();
  app.wheel(app.document.querySelector('.rg-viewport'), { deltaX: 5, deltaY: 8 });
  const replacement = structuredClone(data); replacement.revision++; replacement.graphs.shift(); replacement.lastGraphId = second.id;
  app.changed(replacement); await flush(); app.tick(300); await flush();
  const newCard = app.document.querySelector('.rg-world').querySelector('.rg-card');
  assert.notEqual(newCard, oldCard); assert.equal(oldCard.isConnected, false);
  assert.equal(newCard.dataset.graphId, second.id); assert.equal(newCard.querySelector('.rg-title').title, '第二张图的根');
  assert.equal(app.document.querySelector('.rg-focus').querySelector('.rg-card'), null);
  const view = app.api.getSnapshot().view;
  assert.equal(view.zoom, 1);
  assert.equal(view.x + parseFloat(newCard.style.left) + 120, 600);
  assert.equal(view.y + parseFloat(newCard.style.top) + parseFloat(newCard.style.height) / 2, 400);
  assert.equal(app.mutations.some(item => item.mutation.type === 'view' && item.mutation.graphId === 'graph-A'), false);
  const empty = structuredClone(replacement); empty.revision++; empty.graphs = []; delete empty.lastGraphId;
  app.changed(empty); app.changed({ ...empty, revision: empty.revision + 1 }); await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(app.events.filter(event => event.type === 'graph:contextchange').map(event => event.detail))), [
    { workspaceId: 'A', graphId: 'graph-A' }, { workspaceId: 'A', graphId: 'second-graph' }, null,
  ]);
});

test('节点停止、重试和批量生成分别使用所属节点与未生成批注', async () => {
  const app = fixture(), data = workspace('A'), graph = data.graphs[0], root = graph.nodes[0];
  root.annotations = [
    { id: 'new', selection: { kind: 'text', text: '文字' }, comment: '解释' },
    { id: 'done', selection: { kind: 'text', text: '已有' }, comment: '已有结果', childId: 'a' },
  ];
  graph.nodes.push({ ...structuredClone(root), id: 'a', parentId: 'root', kind: 'card', annotations: [], status: 'generating', x: 650 },
    { ...structuredClone(root), id: 'b', parentId: 'root', kind: 'card', annotations: [], status: 'error', error: '服务暂时不可用', x: -50 });
  const opening = app.api.open({ activationId: 41, workspaceId: 'A', view: 'graph' });
  await app.resolve(0, data); await opening;
  const card = (id: string) => app.document.querySelector('.rg-world').querySelectorAll('.rg-card').find((item: any) => item.dataset.nodeId === id);
  app.click(card('a').querySelector('[aria-label="停止生成"]'));
  app.click(card('b').querySelector('[aria-label="重试生成"]'));
  assert.equal(card('root').querySelector('[aria-label="根据批注生成卡片"]'), null);
  app.click(card('root'));
  const generate = app.document.querySelector('.rg-focus').querySelector('[aria-label="根据批注生成卡片"]');
  assert.equal(generate.hidden, false); app.click(generate);
  await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(app.cancelled)), [{ workspaceId: 'A', graphId: 'graph-A', nodeId: 'a' }]);
  assert.deepEqual(JSON.parse(JSON.stringify(app.regenerated)), [{ workspaceId: 'A', graphId: 'graph-A', nodeId: 'b' }]);
  assert.deepEqual(JSON.parse(JSON.stringify(app.generated)), [{ workspaceId: 'A', graphId: 'graph-A', nodeId: 'root', annotationIds: ['new'] }]);
});

test('根节点没有重新生成入口，展开卡片的批注生成随未生成批注启用', async () => {
  const app = fixture(), data = workspace('A'), root = data.graphs[0].nodes[0];
  data.graphs[0].nodes.push({ ...structuredClone(root), id: 'child', parentId: 'root', kind: 'card' });
  const opening = app.api.open({ workspaceId: 'A' }); await app.resolve(0, data); await opening;
  const world = app.document.querySelector('.rg-world');
  const rootCard = world.querySelectorAll('.rg-card').find((card: any) => card.dataset.nodeId === 'root');
  const childCard = world.querySelectorAll('.rg-card').find((card: any) => card.dataset.nodeId === 'child');
  assert.equal(rootCard.querySelector('[aria-label="重新生成"]'), null);
  assert.equal(rootCard.querySelector('[aria-label="重新分析"]'), null);
  app.click(childCard.querySelector('[aria-label="重新生成"]')); await flush();
  assert.equal(app.regenerated[0].nodeId, 'child');
  app.click(rootCard); await flush();
  const focus = app.document.querySelector('.rg-focus .rg-card');
  assert.equal(focus.querySelector('[aria-label="重新生成"]'), null);
  assert.equal(focus.querySelector('[aria-label="重新分析"]'), null);
  const generate = focus.querySelector('[aria-label="根据批注生成卡片"]');
  assert.equal(generate.parentElement, focus, '批注生成入口独立于侧边工具栏');
  assert.equal(generate.disabled, true);
  const annotated = structuredClone(data); annotated.revision++;
  annotated.graphs[0].nodes[0].annotations = [{ id: 'note', selection: { kind: 'text', text: '原文' }, comment: '解释' }];
  app.changed(annotated);
  assert.equal(generate.disabled, false);
  app.click(generate); await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(app.generated)), [{ workspaceId: 'A', graphId: 'graph-A', nodeId: 'root', annotationIds: ['note'] }]);
  const generated = structuredClone(annotated); generated.revision++;
  generated.graphs[0].nodes[0].annotations[0].childId = 'child'; app.changed(generated);
  app.click(rootCard); await flush();
  assert.equal(app.document.querySelector('.rg-focus .rg-card').querySelector('[aria-label="根据批注生成卡片"]').disabled, true, '已有结果的批注不会再次入队');
});

test('生成按钮等待展开卡片收回完成，再提交原批注并为新增卡片及连接线播放入场', async () => {
  const app = fixture(), data = workspace('A'), root = data.graphs[0].nodes[0];
  root.annotations = [{ id: 'note', comment: '解释', selection: { kind: 'text', text: '原文' } }];
  const opening = app.api.open({ workspaceId: 'A' }); await app.resolve(0, data); await opening;
  app.click(app.document.querySelector('.rg-world .rg-card')); await flush();
  const focus = app.document.querySelector('.rg-focus .rg-card');
  app.holdAnimations(); const after = app.animations.length;
  app.click(focus.querySelector('[aria-label="根据批注生成卡片"]')); await flush();
  assert.equal(app.generated.length, 0, '收回期间不提交生成');
  assert.equal(focus.inert, true);
  const retract = app.animations.slice(after).filter(animation => focus.contains(animation.element));
  assert.ok(retract.some(animation => animation.element === focus));
  retract.forEach(animation => animation.pending.resolve()); await flush();
  assert.equal(focus.isConnected, false);
  assert.deepEqual(JSON.parse(JSON.stringify(app.generated)), [{ workspaceId: 'A', graphId: 'graph-A', nodeId: 'root', annotationIds: ['note'] }]);
  const childData = structuredClone(data); childData.revision++;
  childData.graphs[0].nodes.push({ ...structuredClone(root), id: 'child', parentId: 'root', kind: 'card', title: '生成中', status: 'queued', annotations: [] });
  childData.graphs[0].nodes[0].annotations[0].childId = 'child';
  const beforeChild = app.animations.length; app.changed(childData);
  const child = app.document.querySelector('.rg-world').querySelectorAll('.rg-card').find((item: any) => item.dataset.nodeId === 'child');
  const line = app.document.querySelector('.rg-edges').querySelector('[data-node-id="child"]');
  assert.ok(app.animations.slice(beforeChild).some(animation => animation.element === child), '新卡片有入场动画');
  assert.ok(app.animations.slice(beforeChild).some(animation => animation.element === line), '新连接线有入场动画');
  const afterChild = app.animations.length, streamed = structuredClone(childData); streamed.revision++;
  streamed.graphs[0].nodes[1].draft = '解释正文'; app.changed(streamed);
  assert.equal(app.animations.slice(afterChild).some(animation => animation.element === child || animation.element.dataset.nodeId === 'child' && animation.element.tagName.toLowerCase() === 'path'), false, '流式更新不重复播放整卡和连线入场');
});

test('生成卡片只在标题行完整后更新标题，并随最终结果结束生成状态', async () => {
  const app = fixture(), data = workspace('A');
  data.graphs[0].nodes.push({ ...structuredClone(data.graphs[0].nodes[0]), id: 'answer', parentId: 'root', kind: 'card', title: '',
    status: 'generating', draft: '### 未完成的标', markdown: '', x: 650 });
  const opening = app.api.open({ activationId: 45, workspaceId: 'A', view: 'graph' });
  await app.resolve(0, data); await opening;
  const card = app.document.querySelector('.rg-world').querySelectorAll('.rg-card').find((item: any) => item.dataset.nodeId === 'answer');
  assert.equal(card.querySelector('.rg-title').textContent, '生成中');
  const streamed = structuredClone(data); streamed.revision = 2; streamed.graphs[0].nodes[1].draft = '### $F=ma$ 的含义\n\n正在解释';
  app.changed(streamed);
  assert.equal(card.querySelector('.rg-title').textContent, '$F=ma$ 的含义');
  const finished = structuredClone(streamed); finished.revision = 3;
  Object.assign(finished.graphs[0].nodes[1], { status: 'idle', title: '$F=ma$ 的含义', markdown: '正文', contentRevision: 1 });
  delete finished.graphs[0].nodes[1].draft;
  app.changed(finished);
  assert.equal(card.querySelector('.rg-title').textContent, '$F=ma$ 的含义');
  assert.equal(card.classList.contains('is-busy'), false);
});

test('卡片进度只在生成期间显示真实统计，结束后收起并仅保留结果提示', async () => {
  const app = fixture(), data = workspace('A');
  data.graphs[0].nodes.push({ ...structuredClone(data.graphs[0].nodes[0]), id: 'answer', parentId: 'root', kind: 'card',
    title: '等待中的卡片', status: 'queued', generation: { id: 'generation-one', contentRevision: 0 }, x: 650 });
  const opening = app.api.open({ activationId: 45, workspaceId: 'A', view: 'graph' });
  await app.resolve(0, data); await opening;
  const card = app.document.querySelector('.rg-world').querySelectorAll('.rg-card').find((item: any) => item.dataset.nodeId === 'answer');
  const progress = () => card.querySelector('.rg-progress').textContent;
  assert.equal(progress(), '等待生成…');
  app.tick(5000); assert.equal(progress(), '等待生成…');
  const waiting = structuredClone(data); waiting.revision = 2; waiting.graphs[0].nodes[1].status = 'generating';
  app.changed(waiting); app.tick(5000);
  assert.equal(progress(), '正在生成…'); assert.ok(!progress().includes('搜索'));
  const started = structuredClone(waiting); started.revision = 3; started.graphs[0].nodes[1].generation!.startedAt = 10000;
  app.changed(started); assert.equal(progress(), '生成 0 秒');
  app.tick(2500); assert.equal(progress(), '生成 2 秒');
  const searching = structuredClone(started); searching.revision = 4;
  searching.graphs[0].nodes[1].generation!.toolCounts = { 搜索: 2, 未使用: 0 };
  app.changed(searching); assert.equal(progress(), '生成 2 秒 · 2 次搜索');
  const completed = structuredClone(searching); completed.revision = 5;
  completed.graphs[0].nodes[1].status = 'idle'; completed.graphs[0].nodes[1].generation!.finishedAt = 12500;
  app.changed(completed);
  assert.equal(card.querySelector('.rg-status').hidden, true);
  app.tick(20000); assert.equal(card.querySelector('.rg-status').hidden, true);
  const stopped = structuredClone(completed); stopped.revision = 6; stopped.graphs[0].nodes[1].status = 'cancelled';
  app.changed(stopped); assert.equal(progress(), '已停止生成');
  assert.equal(card.querySelector('.rg-status').hidden, false);
  app.tick(20000); assert.equal(progress(), '已停止生成');
  const failed = structuredClone(completed); failed.revision = 7;
  Object.assign(failed.graphs[0].nodes[1], { status: 'error', error: '服务暂时不可用' });
  app.changed(failed); assert.equal(progress(), '服务暂时不可用');
  const candidate = structuredClone(completed); candidate.revision = 8;
  candidate.graphs[0].nodes[1].candidate = { title: '新标题', markdown: '等待采用的新正文' };
  app.changed(candidate); assert.equal(progress(), '新版本已生成');
  assert.deepEqual(app.api.getSnapshot().workspace.graphs[0].nodes[1].generation, completed.graphs[0].nodes[1].generation, '收起统计不删除生成记录');
  const scroll = card.querySelector('.rg-card-scroll');
  assert.equal(scroll.children[0], card.querySelector('.rg-status'), '进度位于正文上方');
});

test('重新生成先淡出旧正文，再显示最新流式正文，停止后恢复保存的原稿', async () => {
  const app = fixture(), data = workspace('A'); app.holdAnimations();
  data.graphs[0].nodes.push({ ...structuredClone(data.graphs[0].nodes[0]), id: 'answer', parentId: 'root', kind: 'card',
    title: '旧标题', markdown: '保存好的旧正文', contentRevision: 4, x: 650 });
  const opening = app.api.open({ activationId: 45, workspaceId: 'A', view: 'graph' });
  await app.resolve(0, data); await opening;
  const card = app.document.querySelector('.rg-world').querySelectorAll('.rg-card').find((item: any) => item.dataset.nodeId === 'answer');
  const content = card.querySelector('.rg-content'), body = card.querySelector('.rg-body');
  const bodyAnimations = () => app.animations.filter(animation => animation.element === content);
  const queued = structuredClone(data); queued.revision = 2;
  Object.assign(queued.graphs[0].nodes[1], { status: 'queued', generation: { id: 'first', contentRevision: 4 } });
  app.changed(queued);
  assert.equal(body.textContent, '保存好的旧正文');
  const fadingOut = bodyAnimations().at(-1)!;
  assert.equal(fadingOut.keyframes.at(-1).opacity, 0);
  const streaming = structuredClone(queued); streaming.revision = 3;
  Object.assign(streaming.graphs[0].nodes[1], { status: 'generating', draft: '### 新标题\n\n正在生成的新正文' });
  app.changed(streaming); assert.equal(body.textContent, '保存好的旧正文');
  assert.equal(bodyAnimations().at(-1), fadingOut, '淡出期间收到正文时继续使用本次过渡');
  fadingOut.pending.resolve(); await flush();
  assert.match(body.textContent, /正在生成的新正文/); assert.ok(!body.textContent.includes('保存好的旧正文'));
  assert.equal(body.classList.contains('is-streaming'), true);
  const fadingIn = bodyAnimations().at(-1)!;
  assert.notEqual(fadingIn, fadingOut); assert.equal(fadingIn.keyframes[0].opacity, 0); assert.equal(fadingIn.keyframes.at(-1).opacity, 1);
  fadingIn.pending.resolve(); await flush();
  const animationCount = bodyAnimations().length;
  const delta = structuredClone(streaming); delta.revision = 4; delta.graphs[0].nodes[1].draft += '继续补充。';
  app.changed(delta); assert.match(body.textContent, /继续补充/);
  assert.equal(bodyAnimations().length, animationCount, '同一轮流式增量不反复淡出整个正文');
  assert.equal(app.api.getSnapshot().workspace.graphs[0].nodes[1].markdown, '保存好的旧正文');
  const stopped = structuredClone(delta); stopped.revision = 5; stopped.graphs[0].nodes[1].status = 'cancelled'; delete stopped.graphs[0].nodes[1].draft;
  app.changed(stopped); bodyAnimations().at(-1)!.pending.resolve(); await flush();
  assert.equal(body.textContent, '保存好的旧正文'); assert.equal(body.classList.contains('is-streaming'), false);
  bodyAnimations().at(-1)!.pending.resolve(); await flush();
  const retry = structuredClone(stopped); retry.revision = 6;
  Object.assign(retry.graphs[0].nodes[1], { status: 'generating', generation: { id: 'second', contentRevision: 4 }, draft: '### 再试标题\n\n第二轮正文' });
  const beforeRetry = bodyAnimations().length; app.changed(retry);
  assert.equal(bodyAnimations().length, beforeRetry + 1);
  bodyAnimations().at(-1)!.pending.resolve(); await flush();
  assert.match(body.textContent, /第二轮正文/); assert.equal(body.classList.contains('is-streaming'), true);
  bodyAnimations().at(-1)!.pending.resolve(); await flush();
  const beforeComplete = bodyAnimations().length, completed = structuredClone(retry); completed.revision = 7;
  Object.assign(completed.graphs[0].nodes[1], { status: 'idle', title: '再试标题', markdown: '第二轮正文补充完整。', contentRevision: 5 });
  delete completed.graphs[0].nodes[1].draft; app.changed(completed); await flush();
  assert.equal(body.textContent, '第二轮正文补充完整。');
  assert.equal(body.classList.contains('is-streaming'), false);
  assert.equal(card.querySelector('.rg-status').hidden, true);
  assert.equal(bodyAnimations().length, beforeComplete, '成功完成只补齐末次正文，不让整篇再次淡出淡入');
});

test('生成期间已被手动修改的卡片继续显示主稿，新结果作为可预览候选稿', async () => {
  const app = fixture(), data = workspace('A');
  data.graphs[0].nodes.push({ ...structuredClone(data.graphs[0].nodes[0]), id: 'answer', parentId: 'root', kind: 'card',
    title: '我写的标题', markdown: '我编辑的新正文', contentRevision: 5, status: 'generating',
    generation: { id: 'generation-one', contentRevision: 4 }, draft: '### 模型标题\n\n模型仍在生成', x: 650 });
  const opening = app.api.open({ activationId: 45, workspaceId: 'A', view: 'graph' });
  await app.resolve(0, data); await opening;
  const card = app.document.querySelector('.rg-world').querySelectorAll('.rg-card').find((item: any) => item.dataset.nodeId === 'answer');
  assert.equal(card.querySelector('.rg-title').textContent, '我写的标题');
  assert.equal(card.querySelector('.rg-body').textContent, '我编辑的新正文');
  assert.equal(card.querySelector('.rg-body').classList.contains('is-streaming'), false);
  const finished = structuredClone(data); finished.revision = 2;
  Object.assign(finished.graphs[0].nodes[1], { status: 'idle', candidate: { title: '模型标题', markdown: '模型生成的完整正文' } });
  delete finished.graphs[0].nodes[1].draft; app.changed(finished);
  assert.equal(card.querySelector('.rg-body').textContent, '我编辑的新正文');
  const preview = card.querySelector('[aria-label="查看新版本"]'); assert.ok(preview);
  app.click(preview); await flush();
  assert.equal(card.querySelector('.rg-title').textContent, '模型标题');
  assert.equal(card.querySelector('.rg-body').textContent, '模型生成的完整正文');
  assert.equal(app.api.getSnapshot().workspace.graphs[0].nodes[1].markdown, '我编辑的新正文');
});

test('图谱打开失败退出所属遮层，并将真实错误交给调用方', async () => {
  const app = fixture();
  const opening = app.api.open({ activationId: 61, workspaceId: 'A', view: 'graph' });
  const rejected = assert.rejects(opening, /服务不可用/);
  app.requests[0].pending.reject(new Error('服务不可用'));
  await rejected;
  assert.equal(app.api.isOpen(), false);
  assert.equal(app.document.querySelector('#rabbit-graph-root').classList.contains('is-open'), false);
});

test('采用候选后结束预览状态，下次候选仍需用户主动查看', async () => {
  const app = fixture(), data = workspace('A');
  const cardNode: GraphNode = { ...structuredClone(data.graphs[0].nodes[0]), id: 'a', parentId: 'root', kind: 'card',
    title: '原卡片', markdown: '原正文', candidate: { title: '采用后的卡片', markdown: '采用后的正文' } };
  data.graphs[0].nodes.push(cardNode);
  const opening = app.api.open({ activationId: 71, workspaceId: 'A', view: 'graph' });
  await app.resolve(0, data); await opening;
  const card = app.document.querySelector('.rg-world').querySelectorAll('.rg-card').find((item: any) => item.dataset.nodeId === 'a');
  app.click(card.querySelector('[aria-label="查看新版本"]'));
  assert.equal(card.querySelector('.rg-title').textContent, '采用后的卡片');
  const adopted = structuredClone(data); adopted.revision = 2;
  Object.assign(adopted.graphs[0].nodes[1], { title: '采用后的卡片', markdown: '采用后的正文', contentRevision: 1 });
  delete adopted.graphs[0].nodes[1].candidate;
  app.changed(adopted);
  const next = structuredClone(adopted); next.revision = 3;
  next.graphs[0].nodes[1].candidate = { title: '尚未查看的新候选', markdown: '下一版' };
  app.changed(next);
  assert.equal(card.querySelector('.rg-title').textContent, '采用后的卡片');
  assert.ok(card.querySelector('[aria-label="查看新版本"]'));
});

test('当前图谱被删除后清除牌面和连线，保留空工作区入口', async () => {
  const app = fixture(), data = workspace('A');
  data.graphs[0].nodes.push({ ...structuredClone(data.graphs[0].nodes[0]), id: 'a', parentId: 'root', kind: 'card', x: 600 });
  const opening = app.api.open({ activationId: 81, workspaceId: 'A', view: 'graph' });
  await app.resolve(0, data); await opening;
  assert.equal(app.document.querySelector('.rg-world').querySelectorAll('.rg-card').length, 2);
  const emptied = structuredClone(data); emptied.revision = 2; emptied.graphs = []; delete emptied.lastGraphId;
  app.changed(emptied);
  assert.equal(app.document.querySelector('.rg-world').querySelectorAll('.rg-card').length, 0);
  assert.equal(app.document.querySelector('.rg-edges').children.length, 0);
  assert.equal(app.api.getChatContext(), null);
  assert.ok(app.document.querySelector('.rg-empty').querySelector('button'));
});

test('新建图保持空图，中央按钮直接截图，取消和失败均不创建根节点', async () => {
  const app = fixture(), initial = workspace('A');
  const created = structuredClone(initial); created.revision++; created.lastGraphId = 'new-graph';
  created.graphs = [{ id: 'new-graph', title: '新图谱', rootId: 'new-root', nodes: [], view: { x: 0, y: 0, zoom: 1 }, updatedAt: 2, layoutInitialized: true, layoutUnit: 238 }];
  const opening = app.api.open({ workspaceId: 'A' }); await app.resolve(0, initial); await opening;
  app.mutateWith(() => created);
  app.click(app.document.querySelector('.rg-add-graph')); await flush();
  assert.equal(app.mutations.filter(item => item.mutation.type === 'create-graph').length, 1);
  assert.equal(app.imageCaptures.length, 0);
  assert.equal(app.document.querySelector('.rg-world').querySelectorAll('.rg-card').length, 0);
  const add = app.document.querySelector('.rg-empty').querySelector('[aria-label="添加根节点"]');
  app.click(add); await flush(); app.click(add); await flush();
  assert.equal(app.imageCaptures.length, 1, '截图进行中不重复启动');
  assert.equal(app.document.querySelector('.rg-dialog'), null, '截图前不打开根编辑对话框');
  assert.equal(app.document.querySelector('#rabbit-graph-root').classList.contains('capture-suspended'), true);
  assert.deepEqual(JSON.parse(JSON.stringify(app.imageCaptures[0].request)), { workspaceId: 'A', graphId: 'new-graph' });
  app.imageCaptures[0].pending.resolve(null); await flush();
  assert.equal(app.document.querySelector('#rabbit-graph-root').classList.contains('capture-suspended'), false);
  assert.equal(app.mutations.some(item => item.mutation.type === 'add-root'), false);
  app.click(app.document.querySelector('.rg-empty').querySelector('button')); await flush();
  app.imageCaptures[1].pending.reject(new Error('截图失败')); await flush();
  assert.equal(app.document.querySelector('#rabbit-graph-root').classList.contains('capture-suspended'), false);
  assert.equal(app.mutations.some(item => item.mutation.type === 'add-root'), false);
  app.click(app.document.querySelector('.rg-empty').querySelector('button')); await flush();
  assert.equal(app.imageCaptures.length, 3, '失败后可重新截图');
  app.imageCaptures[2].pending.resolve([]); await flush();
  assert.equal(app.mutations.some(item => item.mutation.type === 'add-root'), false);
});

test('首次截图直接创建根并展开，后续截图追加到同一根且保持展开', async () => {
  const app = fixture(), data = workspace('A'), root = structuredClone(data.graphs[0].nodes[0]); data.graphs[0].nodes = [];
  const first = { id: 'one', title: '第一张', imageDataUrl: 'data:image/png;base64,AA==' };
  const second = { id: 'two', title: '第二张', imageDataUrl: 'data:image/png;base64,AQ==' };
  let current = structuredClone(data);
  app.mutateWith(mutation => {
    current = structuredClone(current); current.revision++;
    if (mutation.type === 'add-root') current.graphs[0].nodes = [{ ...structuredClone(root), images: structuredClone(mutation.images), markdown: mutation.markdown }];
    if (mutation.type === 'append-node-images') current.graphs[0].nodes[0].images.push(...structuredClone(mutation.images));
    return current;
  });
  const opening = app.api.open({ workspaceId: 'A' }); await app.resolve(0, data); await opening;
  app.click(app.document.querySelector('.rg-empty').querySelector('button')); await flush();
  app.imageCaptures[0].pending.resolve([first]); await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(app.mutations.filter(item => item.mutation.type === 'add-root'))), [{ workspaceId: 'A', mutation: {
    type: 'add-root', graphId: 'graph-A', markdown: '', images: [first],
  } }]);
  const focus = app.document.querySelector('.rg-focus .rg-card'); assert.ok(focus);
  assert.equal(focus.dataset.nodeId, 'root'); assert.equal(focus.querySelectorAll('img').length, 1);
  const camera = focus.querySelector('[aria-label="添加截图"]'); assert.ok(camera);
  app.click(camera); await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(app.imageCaptures[1].request)), { workspaceId: 'A', graphId: 'graph-A', nodeId: 'root' });
  app.imageCaptures[1].pending.resolve(null); await flush();
  assert.equal(app.mutations.some(item => item.mutation.type === 'append-node-images'), false);
  assert.equal(app.document.querySelector('.rg-focus .rg-card'), focus);
  app.click(camera); await flush(); app.imageCaptures[2].pending.resolve([second]); await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(app.mutations.filter(item => item.mutation.type === 'append-node-images'))), [{ workspaceId: 'A', mutation: {
    type: 'append-node-images', graphId: 'graph-A', nodeId: 'root', images: [second],
  } }]);
  assert.equal(app.document.querySelector('.rg-focus .rg-card'), focus);
  assert.equal(focus.querySelectorAll('img').length, 2);
});

test('创建或追加截图期间切到另一工作区，迟到结果保存原图且不打扰新卡片', async () => {
  for (const existing of [false, true]) {
    const app = fixture(), data = workspace('A'), root = structuredClone(data.graphs[0].nodes[0]);
    if (!existing) data.graphs[0].nodes = [];
    const opening = app.api.open({ workspaceId: 'A' }); await app.resolve(0, data); await opening;
    if (existing) {
      app.click(app.document.querySelector('.rg-world .rg-card')); await flush();
      app.click(app.document.querySelector('.rg-focus .rg-card').querySelector('[aria-label="添加截图"]'));
    } else app.click(app.document.querySelector('.rg-empty').querySelector('button'));
    await flush();
    const next = app.api.open({ workspaceId: 'B' }); await app.resolve(1, workspace('B')); await next;
    app.click(app.document.querySelector('.rg-world .rg-card')); await flush();
    const focus = app.document.querySelector('.rg-focus .rg-card');
    const picture = { id: 'late', title: '迟到截图', imageDataUrl: 'data:image/png;base64,AA==' };
    const saved = structuredClone(data); saved.revision++; saved.graphs[0].nodes = [{ ...root, images: [picture] }];
    app.mutateWith(() => saved);
    app.imageCaptures[0].pending.resolve([picture]); await flush();
    const mutations = app.mutations.filter(item => ['add-root', 'append-node-images'].includes(item.mutation.type));
    assert.equal(mutations.length, 1); assert.equal(mutations[0].workspaceId, 'A'); assert.equal(mutations[0].mutation.graphId, 'graph-A');
    assert.equal(mutations[0].mutation.type, existing ? 'append-node-images' : 'add-root');
    assert.equal(app.api.getSnapshot().workspaceId, 'B');
    assert.equal(app.document.querySelector('.rg-focus .rg-card'), focus); assert.equal(focus.inert, false);
    assert.equal(focus.querySelectorAll('img').length, 0);
    assert.equal(app.document.querySelector('#rabbit-graph-root').classList.contains('capture-suspended'), false);
  }
});

test('普通及展开的根、模型卡和自定义卡均可直接添加空白自定义子卡', async () => {
  for (const mode of ['world', 'focus']) for (const parentId of ['root', 'answer', 'manual']) {
    const app = fixture(), data = workspace('A'), root = data.graphs[0].nodes[0];
    data.graphs[0].nodes.push({ ...structuredClone(root), id: 'answer', parentId: 'root', kind: 'card', title: '模型解释' },
      { ...structuredClone(root), id: 'manual', parentId: 'answer', kind: 'source', title: '已有自定义卡' });
    let current = structuredClone(data);
    app.mutateWith(mutation => {
      if (mutation.type === 'add-custom-node') {
        current = structuredClone(current); current.revision++;
        current.graphs[0].nodes.push({ ...structuredClone(root), id: 'created-custom', parentId: mutation.parentId, kind: 'source', title: '自定义卡片', images: structuredClone(mutation.images), markdown: mutation.markdown });
      }
      if (mutation.type === 'edit') { current = structuredClone(current); current.revision++; const custom = current.graphs[0].nodes.find(item => item.id === mutation.nodeId)!; custom.markdown = mutation.markdown; custom.contentRevision++; }
      return current;
    });
    const opening = app.api.open({ workspaceId: 'A' }); await app.resolve(0, data); await opening;
    const parent = app.document.querySelector('.rg-world').querySelectorAll('.rg-card').find((item: any) => item.dataset.nodeId === parentId);
    if (mode === 'focus') { app.click(parent); await flush(); }
    const entryCard = mode === 'focus' ? app.document.querySelector('.rg-focus .rg-card') : parent;
    const add = entryCard.querySelector('[aria-label="添加自定义卡片"]'); assert.ok(add, mode + '：存在直接添加入口');
    assert.equal(add.hidden, false); assert.equal(add.disabled, false);
    if (parentId === 'root') { assert.equal(entryCard.querySelector('[aria-label="重新生成"]'), null); assert.equal(entryCard.querySelector('[aria-label="重新分析"]'), null); }
    app.pointer(add, 'pointerdown'); app.pointer(add, 'pointerup'); app.click(add, { detail: 1, clientX: 10, clientY: 10 }); await flush();
    assert.deepEqual(JSON.parse(JSON.stringify(app.mutations.filter(item => item.mutation.type === 'add-custom-node'))), [{ workspaceId: 'A', mutation: {
      type: 'add-custom-node', graphId: 'graph-A', parentId, images: [], markdown: '',
    } }]);
    assert.equal(app.imageCaptures.length, 0, '创建自定义卡片无需先截图');
    const custom = app.document.querySelector('.rg-focus .rg-card');
    assert.equal(custom.dataset.nodeId, 'created-custom'); assert.equal(custom.querySelectorAll('img').length, 0);
    assert.ok(custom.textContent.includes('添加截图或文本'));
    assert.ok(custom.querySelector('[aria-label="添加截图"]')); assert.ok(custom.querySelector('[aria-label="添加文本"]'));
    assert.ok(custom.querySelector('[aria-label="添加自定义卡片"]'));
    assert.equal(custom.querySelector('[aria-label="重新生成"]'), null); assert.equal(custom.querySelector('[aria-label="重新分析"]'), null);
    app.click(custom.querySelector('[aria-label="添加文本"]')); await flush();
    const editor = custom.querySelector('.rg-root-text'); editor.querySelector('textarea').value = '纯文本自定义资料';
    app.click(editor.querySelector('[aria-label="保存文本"]')); await flush();
    assert.equal(current.graphs[0].nodes.find(item => item.id === 'created-custom')!.markdown, '纯文本自定义资料');
    assert.equal(app.imageCaptures.length, 0); assert.equal(custom.querySelectorAll('img').length, 0);
  }
});

test('普通卡片工具栏默认可见，创建未完成时切换阅读卡片不被迟到结果拉回', async () => {
  const app = fixture(), data = workspace('A'), root = data.graphs[0].nodes[0];
  data.graphs[0].nodes.push({ ...structuredClone(root), id: 'reading', parentId: 'root', kind: 'card' });
  const opening = app.api.open({ workspaceId: 'A' }); await app.resolve(0, data); await opening;
  const css = app.document.head.querySelectorAll('style').map((item: any) => item.textContent).join('\n');
  const baseToolsRules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(match => match[1].split(',').some(selector => selector.trim() === '#rabbit-graph-root .rg-card-tools'));
  const opacity = baseToolsRules.flatMap(match => [...match[2].matchAll(/(?:^|;)\s*opacity\s*:\s*([^;]+)/g)]).at(-1)?.[1].trim() ?? '1';
  assert.equal(opacity, '1', '工具栏在未悬停、未聚焦时默认可见');
  const parent = app.document.querySelector('.rg-world').querySelectorAll('.rg-card').find((item: any) => item.dataset.nodeId === 'root');
  const pending = deferred<GraphWorkspace>(); app.window.rabbitDesktop.graphMutate = async () => pending.promise;
  app.click(parent.querySelector('[aria-label="添加自定义卡片"]')); await flush();
  app.click(app.document.querySelector('.rg-world').querySelectorAll('.rg-card').find((item: any) => item.dataset.nodeId === 'reading')); await flush();
  const focus = app.document.querySelector('.rg-focus .rg-card'); focus.querySelector('.rg-pin-toggle').focus();
  const active = app.document.activeElement, saved = structuredClone(data); saved.revision++;
  saved.graphs[0].nodes.push({ ...structuredClone(root), id: 'created', parentId: 'root', kind: 'source', title: '自定义卡片' });
  pending.resolve(saved); await flush();
  assert.ok(app.document.querySelector('.rg-focus .rg-card') === focus);
  assert.ok(app.document.activeElement === active);
  assert.equal(app.api.getSnapshot().workspace.graphs[0].nodes.find((node: any) => node.id === 'created').parentId, 'root');
});

test('自定义子卡可追加截图和编辑文字，再以两次Enter完成批注并生成子卡', async () => {
  const app = fixture(), data = workspace('A'), root = data.graphs[0].nodes[0];
  const first = { id: 'one', title: '原图', imageDataUrl: 'data:image/png;base64,AA==' }, second = { id: 'two', title: '补图', imageDataUrl: 'data:image/png;base64,AQ==' };
  data.graphs[0].nodes.push({ ...structuredClone(root), id: 'custom', parentId: 'root', kind: 'source', title: '自定义卡片', images: [first] });
  let current = structuredClone(data);
  app.mutateWith(mutation => {
    current = structuredClone(current); current.revision++; const node = current.graphs[0].nodes[1];
    if (mutation.type === 'append-node-images') node.images.push(...structuredClone(mutation.images));
    if (mutation.type === 'edit') { node.markdown = mutation.markdown; node.contentRevision++; }
    if (mutation.type === 'annotation') node.annotations.push(structuredClone(mutation.annotation));
    return current;
  });
  const opening = app.api.open({ workspaceId: 'A' }); await app.resolve(0, data); await opening;
  app.click(app.document.querySelector('.rg-world').querySelectorAll('.rg-card').find((item: any) => item.dataset.nodeId === 'custom')); await flush();
  const focus = app.document.querySelector('.rg-focus .rg-card');
  app.click(focus.querySelector('[aria-label="添加截图"]')); await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(app.imageCaptures[0].request)), { workspaceId: 'A', graphId: 'graph-A', nodeId: 'custom' });
  app.imageCaptures[0].pending.resolve([second]); await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(app.mutations.find(item => item.mutation.type === 'append-node-images'))), { workspaceId: 'A', mutation: {
    type: 'append-node-images', graphId: 'graph-A', nodeId: 'custom', images: [second],
  } });
  assert.equal(app.document.querySelector('.rg-focus .rg-card'), focus); assert.equal(focus.querySelectorAll('img').length, 2);
  app.click(focus.querySelector('[aria-label="添加文本"]')); await flush();
  const editor = focus.querySelector('.rg-root-text'), text = editor.querySelector('[aria-label="自定义卡片文本"]'); assert.ok(text);
  text.value = '用于比较的自定义资料'; app.click(editor.querySelector('[aria-label="保存文本"]')); await flush();
  const edit = app.mutations.find(item => item.mutation.type === 'edit');
  assert.equal(edit.mutation.nodeId, 'custom'); assert.equal(edit.mutation.markdown, '用于比较的自定义资料');
  const image = focus.querySelector('img');
  app.pointer(image, 'pointerdown', { clientX: 20, clientY: 20 }); app.pointer(image, 'pointerup', { clientX: 200, clientY: 160 });
  const input = app.document.querySelector('.rg-note-editor').querySelector('textarea'); input.value = '解释这一部分';
  input.dispatchEvent({ type: 'keydown', key: 'Enter', bubbles: true, preventDefault() {}, stopPropagation() { this.stopped = true; } }); await flush();
  assert.equal(app.generated.length, 0); const generate = focus.querySelector('[aria-label="根据批注生成卡片"]');
  assert.ok(app.document.activeElement === generate); app.click(generate); await flush();
  const annotation = app.mutations.find(item => item.mutation.type === 'annotation').mutation.annotation;
  assert.deepEqual(JSON.parse(JSON.stringify(app.generated)), [{ workspaceId: 'A', graphId: 'graph-A', nodeId: 'custom', annotationIds: [annotation.id] }]);
});

test('自定义卡片创建迟到成功仍保存原父节点，但不抢走另一工作区焦点', async () => {
  const app = fixture(), data = workspace('A'), root = data.graphs[0].nodes[0];
  data.graphs[0].nodes.push({ ...structuredClone(root), id: 'parent', parentId: 'root', kind: 'card' });
  const opening = app.api.open({ workspaceId: 'A' }); await app.resolve(0, data); await opening;
  app.click(app.document.querySelector('.rg-world').querySelectorAll('.rg-card').find((item: any) => item.dataset.nodeId === 'parent')); await flush();
  const pending = deferred<GraphWorkspace>(), mutations: any[] = [];
  app.window.rabbitDesktop.graphMutate = async (workspaceId: string, mutation: any) => { mutations.push({ workspaceId, mutation }); return pending.promise; };
  const add = app.document.querySelector('.rg-focus .rg-card').querySelector('[aria-label="添加自定义卡片"]');
  app.click(add); app.click(add); await flush();
  assert.equal(mutations.length, 1, '创建尚未完成不重复提交');
  const next = app.api.open({ workspaceId: 'B' }); await app.resolve(1, workspace('B')); await next;
  app.click(app.document.querySelector('.rg-world .rg-card')); await flush();
  const focus = app.document.querySelector('.rg-focus .rg-card'), control = focus.querySelector('[aria-label="添加文本"]'); control.focus();
  const saved = structuredClone(data); saved.revision++; saved.graphs[0].nodes.push({ ...structuredClone(root), id: 'custom', parentId: 'parent', title: '自定义卡片' });
  pending.resolve(saved); await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(mutations)), [{ workspaceId: 'A', mutation: {
    type: 'add-custom-node', graphId: 'graph-A', parentId: 'parent', images: [], markdown: '',
  } }]);
  assert.equal(app.api.getSnapshot().workspaceId, 'B'); assert.ok(app.document.querySelector('.rg-focus .rg-card') === focus);
  assert.ok(app.document.activeElement === control); assert.equal(focus.querySelectorAll('img').length, 0);
});

test('自定义卡片创建失败或父卡删除后，不展开幽灵卡片且可继续创建', async () => {
  const app = fixture(), data = workspace('A'), root = data.graphs[0].nodes[0];
  data.graphs[0].nodes.push({ ...structuredClone(root), id: 'parent', parentId: 'root', kind: 'card' });
  const opening = app.api.open({ workspaceId: 'A' }); await app.resolve(0, data); await opening;
  app.click(app.document.querySelector('.rg-world').querySelectorAll('.rg-card').find((item: any) => item.dataset.nodeId === 'parent')); await flush();
  const pending = deferred<GraphWorkspace>();
  app.window.rabbitDesktop.graphMutate = async () => pending.promise;
  app.click(app.document.querySelector('.rg-focus .rg-card').querySelector('[aria-label="添加自定义卡片"]')); await flush();
  const removed = structuredClone(data); removed.revision++; removed.graphs[0].nodes.pop(); app.changed(removed); await flush();
  pending.reject(new Error('父卡片不存在')); await flush();
  assert.equal(app.document.querySelector('.rg-focus .rg-card'), null);
  assert.equal(app.document.querySelector('.rg-world').querySelectorAll('.rg-card').length, 1);
  app.click(app.document.querySelector('.rg-world .rg-card')); await flush();
  const focus = app.document.querySelector('.rg-focus .rg-card'), add = focus.querySelector('[aria-label="添加自定义卡片"]');
  app.window.rabbitDesktop.graphMutate = async () => { throw new Error('写入失败'); };
  app.click(add); await flush();
  assert.equal(add.disabled, false); assert.ok(app.document.querySelector('.rg-focus .rg-card') === focus);
  assert.equal(app.imageCaptures.length, 0);
});

test('根节点内联编辑支持添加、修改和取消，子卡不出现根资料工具', async () => {
  const app = fixture(), data = workspace('A'), root = data.graphs[0].nodes[0];
  data.graphs[0].nodes.push({ ...structuredClone(root), id: 'child', parentId: 'root', kind: 'card' });
  let current = structuredClone(data);
  app.mutateWith(mutation => {
    if (mutation.type === 'edit') { current = structuredClone(current); current.revision++; Object.assign(current.graphs[0].nodes[0], { markdown: mutation.markdown, contentRevision: mutation.contentRevision + 1 }); }
    return current;
  });
  const opening = app.api.open({ workspaceId: 'A' }); await app.resolve(0, data); await opening;
  const world = app.document.querySelector('.rg-world'), cards = world.querySelectorAll('.rg-card');
  app.click(cards.find((item: any) => item.dataset.nodeId === 'root')); await flush();
  const focus = app.document.querySelector('.rg-focus .rg-card');
  app.click(focus.querySelector('[aria-label="添加文本"]')); await flush();
  const editor = focus.querySelector('.rg-root-text'), input = editor.querySelector('[aria-label="根节点文本"]');
  assert.equal(editor.parentElement, focus.querySelector('.rg-content'));
  assert.equal(app.document.querySelector('.rg-dialog'), null);
  input.value = '补充的根节点文本'; input.dispatchEvent({ type: 'input', bubbles: true });
  app.click(editor.querySelector('[aria-label="保存文本"]')); await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(app.mutations.filter(item => item.mutation.type === 'edit'))), [{ workspaceId: 'A', mutation: {
    type: 'edit', graphId: 'graph-A', nodeId: 'root', title: root.title, markdown: '补充的根节点文本', contentRevision: root.contentRevision,
  } }]);
  assert.equal(focus.querySelector('.rg-root-text'), null);
  assert.equal(app.document.querySelector('.rg-focus .rg-card'), focus);
  app.click(focus.querySelector('[aria-label="编辑文本"]')); await flush();
  const editing = focus.querySelector('.rg-root-text');
  assert.equal(editing.querySelector('textarea').value, '补充的根节点文本');
  editing.querySelector('textarea').value = '取消这一版';
  app.click(editing.querySelector('[aria-label="取消编辑"]')); await flush();
  assert.equal(focus.querySelector('.rg-root-text'), null);
  assert.equal(app.mutations.filter(item => item.mutation.type === 'edit').length, 1);
  app.click(app.document.querySelector('.rg-focus')); await flush();
  app.click(cards.find((item: any) => item.dataset.nodeId === 'child')); await flush();
  const child = app.document.querySelector('.rg-focus .rg-card');
  assert.equal(child.querySelector('[aria-label="添加截图"]'), null);
  assert.equal(child.querySelector('[aria-label="添加文本"]'), null);
  assert.equal(child.querySelector('[aria-label="编辑文本"]'), null);
});

test('根文本Enter保存，Shift+Enter和输入法保持输入，失败保留编辑器可重试', async () => {
  const app = fixture(), data = workspace('A'); data.graphs[0].nodes[0].markdown = '原文';
  const opening = app.api.open({ workspaceId: 'A' }); await app.resolve(0, data); await opening;
  app.click(app.document.querySelector('.rg-world .rg-card')); await flush();
  const focus = app.document.querySelector('.rg-focus .rg-card');
  app.click(focus.querySelector('[aria-label="编辑文本"]')); await flush();
  const editor = focus.querySelector('.rg-root-text'), input = editor.querySelector('textarea'); input.value = '第一行\n第二行';
  const enter = (values: Record<string, unknown> = {}) => {
    const event: any = { type: 'keydown', key: 'Enter', bubbles: true, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...values };
    input.dispatchEvent(event); return event;
  };
  assert.equal(enter({ shiftKey: true }).defaultPrevented, false);
  assert.equal(enter({ isComposing: true }).defaultPrevented, false);
  assert.equal(enter({ keyCode: 229 }).defaultPrevented, false);
  assert.equal(app.mutations.filter(item => item.mutation.type === 'edit').length, 0);
  let attempts = 0;
  app.mutateWith(mutation => { if (mutation.type === 'edit' && ++attempts === 1) throw new Error('保存失败'); return data; });
  assert.equal(enter().defaultPrevented, true); await flush();
  assert.equal(focus.querySelector('.rg-root-text'), editor);
  assert.equal(input.value, '第一行\n第二行');
  assert.equal(editor.querySelector('[aria-label="保存文本"]').disabled, false);
  enter(); await flush();
  const edits = app.mutations.filter(item => item.mutation.type === 'edit');
  assert.equal(edits.length, 2); assert.deepEqual(edits[1], edits[0]);
  assert.equal(edits[0].mutation.markdown, '第一行\n第二行');
  assert.equal(focus.querySelector('.rg-root-text'), null);
  assert.equal(app.generated.length, 0, '编辑根文字不自动触发批注生成');
});

test('来源和普通卡片悬停预览目标图后，释放到末端只提交一次跨图移动', async () => {
  for (const nodeId of ['root', 'branch']) {
    const app = fixture(), data = workspace('A'), source = data.graphs[0];
    source.nodes.push({ ...structuredClone(source.nodes[0]), id: 'branch', parentId: 'root', kind: 'card', title: '分支', x: 650 });
    const targetRoot = { ...structuredClone(source.nodes[0]), id: 'target-root', title: '目标资料' };
    const targetLeaf = { ...structuredClone(source.nodes[1]), id: 'target-leaf', parentId: targetRoot.id, title: '末端' };
    data.graphs.push({ id: 'target-graph', title: '目标图', rootId: targetRoot.id, nodes: [targetRoot, targetLeaf], view: { x: 0, y: 0, zoom: 1 }, updatedAt: 1, layoutInitialized: true, layoutUnit: 238 });
    const opening = app.api.open({ activationId: 101, workspaceId: 'A', view: 'graph' });
    await app.resolve(0, data); await opening;
    const cards = app.document.querySelector('.rg-world').querySelectorAll('.rg-card');
    const handle = cards.find((item: any) => item.dataset.nodeId === nodeId);
    assert.ok(handle, '根截图也支持直接跨图拖动');
    app.pointAt(app.document.querySelector('[aria-label="打开图谱：目标图"]'));
    app.pointer(handle, 'pointerdown'); app.pointer(handle, 'pointermove', { clientX: 20, clientY: 20 });
    app.tick(449); await flush();
    assert.equal(app.api.getSnapshot().graphId, 'graph-A');
    app.tick(1); await flush();
    assert.equal(app.api.getSnapshot().graphId, 'target-graph');
    assert.equal(app.mutations.filter(item => item.mutation.type === 'move-subtree').length, 0);
    const leaf = app.document.querySelector('.rg-world').querySelectorAll('.rg-card').find((item: any) => item.dataset.nodeId === 'target-leaf');
    app.pointAt(leaf);
    app.pointer(handle, 'pointermove', { clientX: 30, clientY: 30 }); app.pointer(handle, 'pointerup', { clientX: 30, clientY: 30 });
    await flush();
    const moves = app.mutations.filter(item => item.mutation.type === 'move-subtree');
    assert.deepEqual(JSON.parse(JSON.stringify(moves)), [{ workspaceId: 'A', mutation: { type: 'move-subtree', graphId: 'graph-A', nodeId, targetGraphId: 'target-graph', targetNodeId: 'target-leaf' } }]);
  }
});

test('悬停切图后取消、丢失捕获或失焦恢复原图且不写入树或访问记录', async () => {
  for (const cause of ['pointercancel', 'lostpointercapture', 'blur']) {
    const app = fixture(), data = workspace('A');
    data.graphs.push({ ...structuredClone(data.graphs[0]), id: 'target-graph', title: '目标图', rootId: 'target-root',
      nodes: [{ ...structuredClone(data.graphs[0].nodes[0]), id: 'target-root' }] });
    const opening = app.api.open({ activationId: 106, workspaceId: 'A', view: 'graph' });
    await app.resolve(0, data); await opening;
    const handle = app.document.querySelector('.rg-world').querySelector('.rg-card'), overlay = app.document.querySelector('#rabbit-graph-root');
    app.pointAt(app.document.querySelector('[aria-label="打开图谱：目标图"]'));
    app.pointer(handle, 'pointerdown'); app.pointer(handle, 'pointermove', { clientX: 30, clientY: 30 }); app.tick(450); await flush();
    assert.equal(app.api.getSnapshot().graphId, 'target-graph');
    app.pointer(overlay, 'pointercancel', { pointerId: 2 });
    assert.equal(overlay.hasPointerCapture(1), true, '旁路触点不能取消主动拖动');
    if (cause === 'blur') app.emitWindow('blur'); else app.pointer(overlay, cause);
    app.pointer(overlay, 'pointerup'); await flush(); await flush();
    assert.equal(app.api.getSnapshot().graphId, 'graph-A');
    assert.equal(overlay.hasPointerCapture(1), false);
    assert.equal(app.document.querySelector('.rg-drag-ghost'), null);
    assert.equal(app.mutations.some(item => ['layout', 'visit', 'move-subtree', 'reparent'].includes(item.mutation.type)), false);
  }
});

test('重挂由最初的主指针选择目标并提交，第二触点不移动或释放卡片', async () => {
  const app = fixture(), data = workspace('A'), source = data.graphs[0];
  source.nodes.push({ ...structuredClone(source.nodes[0]), id: 'branch', parentId: 'root', kind: 'card', x: 650 });
  source.nodes.push({ ...structuredClone(source.nodes[0]), id: 'target', parentId: 'root', kind: 'card', x: 1100 });
  const opening = app.api.open({ activationId: 107, workspaceId: 'A', view: 'graph' });
  await app.resolve(0, data); await opening;
  const cards = app.document.querySelector('.rg-world').querySelectorAll('.rg-card');
  const handle = cards.find((item: any) => item.dataset.nodeId === 'branch');
  const target = cards.find((item: any) => item.dataset.nodeId === 'target');
  app.pointer(handle, 'pointerdown', { pointerType: 'touch', isPrimary: false });
  assert.equal(app.document.querySelector('.rg-drag-ghost'), null);
  app.pointer(handle, 'pointerdown', { pointerType: 'pen', isPrimary: true });
  app.pointAt(target); app.pointer(handle, 'pointermove', { pointerId: 2, clientX: 900 });
  assert.equal(target.classList.contains('is-target'), false);
  app.pointer(handle, 'pointermove', { clientX: 900 });
  assert.equal(target.classList.contains('is-target'), true);
  app.pointer(handle, 'pointerup', { pointerId: 2 }); await flush();
  assert.equal(app.mutations.some(item => item.mutation.type === 'reparent'), false);
  app.pointer(handle, 'pointerup'); await flush(); await flush();
  assert.deepEqual(app.mutations.filter(item => item.mutation.type === 'reparent').map(item => [item.mutation.nodeId, item.mutation.parentId]), [['branch', 'target']]);
});

test('重挂回位动画期间关闭或切换工作区立即清理，迟到动画不恢复旧图', async () => {
  for (const ending of ['close', 'workspace', 'reset']) {
    const app = fixture(), data = workspace('A');
    app.window.rabbitDesktop.graphList = async () => [{ id: 'B', name: '工作区 B' }];
    const opening = app.api.open({ activationId: 1071, workspaceId: 'A', view: 'graph' });
    await app.resolve(0, data); await opening; await flush();
    const handle = app.document.querySelector('.rg-world').querySelector('.rg-card'), overlay = app.document.querySelector('#rabbit-graph-root');
    app.holdAnimations(); app.pointer(handle, 'pointerdown'); app.pointer(handle, 'pointermove', { clientX: 100, clientY: 100 });
    app.pointer(overlay, 'pointercancel'); await flush();
    assert.ok(app.document.querySelector('.rg-drag-ghost'), '先停在旧图的回位动画中');
    let next: Promise<void> | undefined;
    if (ending === 'workspace') {
      app.click(app.document.querySelector('.rg-folder'));
      const entry = app.document.querySelector('.rg-menu').querySelectorAll('button').find((item: any) => item.textContent.includes('工作区 B'));
      app.click(entry); await flush();
      assert.equal(app.document.querySelector('.rg-drag-ghost'), null);
    } else {
      if (ending === 'close') { app.api.close(); assert.equal(app.document.querySelector('.rg-drag-ghost'), null); }
      next = app.api.open({ activationId: 1072, workspaceId: 'B', view: 'graph' });
    }
    await app.resolve(1, workspace('B')); if (next) await next;
    app.animations.forEach(item => item.pending.resolve()); await flush(); await flush();
    assert.equal(app.api.getSnapshot().workspaceId, 'B'); assert.equal(app.api.getSnapshot().graphId, 'graph-B');
    assert.equal(app.document.querySelector('.rg-drag-ghost'), null); assert.equal(overlay.hasPointerCapture(1), false);
    assert.equal(app.mutations.some(item => ['move-subtree', 'reparent'].includes(item.mutation.type)), false);
  }
});

test('重挂途中主动切图或当前图被移除会终止旧手势，迟到抬手不修改新图', async () => {
  for (const ending of ['visit', 'removed']) {
    const app = fixture(), data = workspace('A');
    data.graphs.push({ ...structuredClone(data.graphs[0]), id: 'target-graph', title: '目标图', rootId: 'target-root',
      nodes: [{ ...structuredClone(data.graphs[0].nodes[0]), id: 'target-root' }] });
    const opening = app.api.open({ activationId: 1073, workspaceId: 'A', view: 'graph' });
    await app.resolve(0, data); await opening;
    const handle = app.document.querySelector('.rg-world').querySelector('.rg-card'), overlay = app.document.querySelector('#rabbit-graph-root');
    const target = app.document.querySelector('[aria-label="打开图谱：目标图"]');
    app.pointAt(target); app.pointer(handle, 'pointerdown'); app.pointer(handle, 'pointermove', { clientX: 30, clientY: 30 });
    if (ending === 'visit') app.click(target);
    else { const changed = structuredClone(data); changed.revision++; changed.graphs.shift(); changed.lastGraphId = 'target-graph'; app.changed(changed); }
    assert.equal(app.document.querySelector('.rg-drag-ghost'), null); assert.equal(overlay.hasPointerCapture(1), false);
    app.pointer(overlay, 'pointerup'); app.tick(500); await flush(); await flush();
    assert.equal(app.api.getSnapshot().graphId, 'target-graph');
    assert.equal(app.mutations.some(item => ['move-subtree', 'reparent'].includes(item.mutation.type)), false);
  }
});

test('画布图片先放大，放大牌内框选才打开批注并可取消', async () => {
  const app = fixture(), data = workspace('A');
  data.graphs[0].nodes[0].images = [{ id: 'screen', title: '截图', imageDataUrl: 'data:image/png;base64,AA==', pixelSize: { width: 1600, height: 900 } }];
  const opening = app.api.open({ activationId: 108, workspaceId: 'A', view: 'graph' });
  await app.resolve(0, data); await opening;
  const worldImage = app.document.querySelector('.rg-world').querySelector('.rg-image').querySelector('img');
  app.pointer(worldImage, 'pointerdown'); app.pointer(worldImage, 'pointermove', { clientX: 100, clientY: 100 }); app.pointer(worldImage, 'pointerup', { clientX: 100, clientY: 100 });
  assert.equal(app.document.querySelector('.rg-note-editor'), null);
  await flush(); await flush(); app.tick(1000);
  app.pointer(worldImage, 'pointerdown'); app.pointer(worldImage, 'pointerup'); app.click(worldImage, { detail: 1, clientX: 10, clientY: 10 }); await flush();
  const focused = app.document.querySelector('.rg-focus').querySelector('.rg-card'), image = focused.querySelector('.rg-image').querySelector('img');
  app.pointer(image, 'pointerdown', { clientX: 20, clientY: 20 }); app.pointer(image, 'pointermove', { clientX: 200, clientY: 160 }); app.pointer(image, 'pointerup', { clientX: 200, clientY: 160 });
  assert.ok(app.document.querySelector('.rg-note-editor'));
  app.document.dispatchEvent({ type: 'keydown', key: 'Escape', preventDefault() {} });
  await flush();
  assert.ok(app.document.querySelector('.rg-note-editor') === null);
  assert.equal(app.document.querySelector('.rg-focus').querySelector('.rg-card'), focused);
  assert.equal(app.mutations.filter(item => item.mutation.type === 'annotation').length, 0);
});

test('图片框选保留主笔起点并采用其最终抬起位置，旁路触点不打开批注', async () => {
  const app = fixture(), data = workspace('A');
  data.graphs[0].nodes[0].images = [{ id: 'screen', title: '截图', imageDataUrl: 'data:image/png;base64,AA==' }];
  const opening = app.api.open({ activationId: 109, workspaceId: 'A', view: 'graph' });
  await app.resolve(0, data); await opening;
  app.click(app.document.querySelector('.rg-world').querySelector('.rg-card')); await flush();
  const image = app.document.querySelector('.rg-focus').querySelector('img'), bounds = image.getBoundingClientRect();
  app.pointer(image, 'pointerdown', { pointerType: 'touch', isPrimary: false });
  assert.equal(image.hasPointerCapture(1), false);
  app.pointer(image, 'pointerdown', { pointerType: 'pen', clientX: 20, clientY: 20 });
  app.pointer(image, 'pointerdown', { pointerId: 2, pointerType: 'touch', clientX: 300, clientY: 300 });
  app.pointer(image, 'pointermove', { pointerId: 2, clientX: 500, clientY: 500 });
  app.pointer(image, 'pointerup', { pointerId: 2 });
  assert.equal(app.document.querySelector('.rg-note-editor'), null);
  assert.equal(image.hasPointerCapture(1), true);
  app.pointer(image, 'pointerup', { clientX: 200, clientY: 160 });
  assert.equal(image.hasPointerCapture(1), false);
  const editor = app.document.querySelector('.rg-note-editor'); assert.ok(editor);
  editor.querySelector('textarea').value = '解释框选区域';
  app.click(editor.querySelector('[aria-label="保存批注"]')); await flush();
  const selection = app.mutations.find(item => item.mutation.type === 'annotation').mutation.annotation.selection;
  assert.equal(selection.imageId, 'screen');
  assert.equal(selection.rect.x, 20 / bounds.width); assert.equal(selection.rect.y, 20 / bounds.height);
  assert.ok(Math.abs(selection.rect.width - 180 / bounds.width) < 1e-9); assert.ok(Math.abs(selection.rect.height - 140 / bounds.height) < 1e-9);
});

test('图片框选取消、丢失捕获与失焦清理高亮，迟到抬手不恢复批注', async () => {
  for (const cause of ['pointercancel', 'lostpointercapture', 'blur', 'close']) {
    const app = fixture(), data = workspace('A');
    data.graphs[0].nodes[0].images = [{ id: 'screen', title: '截图', imageDataUrl: 'data:image/png;base64,AA==' }];
    const opening = app.api.open({ activationId: 110, workspaceId: 'A', view: 'graph' });
    await app.resolve(0, data); await opening;
    app.click(app.document.querySelector('.rg-world').querySelector('.rg-card')); await flush();
    const focused = app.document.querySelector('.rg-focus').querySelector('.rg-card'), image = focused.querySelector('img');
    app.pointer(image, 'pointerdown', { clientX: 20, clientY: 20 });
    app.pointer(image, 'pointermove', { clientX: 200, clientY: 160 });
    assert.ok(focused.querySelector('.rg-mark'));
    app.pointer(image, 'pointercancel', { pointerId: 2 }); assert.equal(image.hasPointerCapture(1), true);
    if (cause === 'blur') app.emitWindow('blur'); else if (cause === 'close') app.api.close(); else app.pointer(image, cause);
    app.pointer(image, 'pointerup', { clientX: 200, clientY: 160 }); await flush();
    assert.equal(image.hasPointerCapture(1), false);
    assert.equal(app.document.querySelector('.rg-note-editor'), null);
    assert.equal(focused.querySelector('.rg-mark'), null);
    if (cause !== 'close') {
      app.pointer(image, 'pointerdown', { pointerId: 3, clientX: 20, clientY: 20 });
      app.pointer(image, 'pointerup', { pointerId: 3, clientX: 200, clientY: 160 });
      assert.ok(app.document.querySelector('.rg-note-editor'), '结束取消后可重新圈选');
    }
  }
});

test('批注截图取消保留输入和旧附件，保存时带上后续截图与原选区', async () => {
  const app = fixture(), data = workspace('A'), root = data.graphs[0].nodes[0];
  const image: CaptureImage = { id: 'screen', title: '截图', imageDataUrl: 'data:image/png;base64,AA==' };
  const attachment: CaptureImage = { id: 'attachment-old', title: '已有附件', imageDataUrl: 'data:image/png;base64,AQ==' };
  root.images = [image];
  const selection = { kind: 'image' as const, imageId: image.id, rect: { x: .2, y: .2, width: .3, height: .3 } };
  root.annotations = [{ id: 'note', selection, comment: '原批注', images: [attachment] }];
  const opening = app.api.open({ activationId: 111, workspaceId: 'A', view: 'graph' });
  await app.resolve(0, data); await opening;
  app.click(app.document.querySelector('.rg-world').querySelector('.rg-card')); await flush();
  app.click(app.document.querySelector('.rg-focus').querySelector('.rg-note-number'));
  const editor = app.document.querySelector('.rg-note-editor'), input = editor.querySelector('textarea'); input.value = '保留我的补充问题';
  const capture = editor.querySelectorAll('button').find((item: any) => /截图/.test(item.getAttribute('aria-label') || ''));
  assert.ok(capture);
  app.click(capture); await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(app.imageCaptures[0].request)), { workspaceId: 'A', graphId: 'graph-A', nodeId: 'root' });
  app.pointer(app.document.querySelector('.rg-focus').querySelector('.rg-body'), 'pointerdown');
  app.document.dispatchEvent({ type: 'keydown', key: 'Escape', preventDefault() {} });
  assert.equal(app.document.querySelector('.rg-note-editor'), editor, '截图接管期间的鼠标和Esc不应取消批注草稿');
  app.imageCaptures[0].pending.resolve(null); await flush();
  assert.equal(app.document.querySelector('.rg-note-editor'), editor);
  assert.equal(input.value, '保留我的补充问题');
  app.click(capture); await flush();
  const nextImage: CaptureImage = { id: 'attachment-new', title: '新附件', imageDataUrl: 'data:image/png;base64,Ag==' };
  app.imageCaptures[1].pending.resolve([nextImage]); await flush();
  app.click(editor.querySelector('[aria-label="保存批注"]')); await flush();
  const saved = app.mutations.find(item => item.mutation.type === 'annotation');
  assert.equal(saved.workspaceId, 'A');
  assert.equal(saved.mutation.graphId, 'graph-A');
  assert.equal(saved.mutation.nodeId, 'root');
  assert.equal(saved.mutation.annotation.comment, '保留我的补充问题');
  assert.deepEqual(JSON.parse(JSON.stringify(saved.mutation.annotation.selection)), selection);
  assert.deepEqual(Array.from(saved.mutation.annotation.images, (value: any) => value.id), ['attachment-old', 'attachment-new']);
  app.click(app.document.querySelector('.rg-focus').querySelector('.rg-note-number'));
  const another = app.document.querySelector('.rg-note-editor'); another.querySelector('textarea').value = '未保存的修改';
  app.pointer(another.querySelector('textarea'), 'pointerdown');
  assert.equal(app.document.querySelector('.rg-note-editor'), another);
  const outside = app.document.querySelector('.rg-focus').querySelector('.rg-body');
  app.pointer(outside, 'pointerdown'); app.pointer(outside, 'pointerup'); app.click(outside, { detail: 1, clientX: 10, clientY: 10 }); await flush();
  assert.equal(app.document.querySelector('.rg-note-editor'), null);
  const annotations = app.mutations.filter(item => item.mutation.type === 'annotation');
  assert.equal(annotations.length, 2, '点击外侧自动保存有内容的批注');
  assert.equal(annotations[1].mutation.annotation.comment, '未保存的修改');
});

test('空批注不能以确认或Enter提交，输入与截图共同决定保存按钮状态', async () => {
  const app = fixture(), data = workspace('A');
  data.graphs[0].nodes[0].images = [{ id: 'screen', title: '截图', imageDataUrl: 'data:image/png;base64,AA==' }];
  const opening = app.api.open({ workspaceId: 'A' }); await app.resolve(0, data); await opening;
  app.click(app.document.querySelector('.rg-world .rg-card')); await flush();
  const image = app.document.querySelector('.rg-focus').querySelector('img');
  app.pointer(image, 'pointerdown', { clientX: 20, clientY: 20 });
  app.pointer(image, 'pointerup', { clientX: 200, clientY: 160 });
  const editor = app.document.querySelector('.rg-note-editor'), input = editor.querySelector('textarea');
  const confirm = editor.querySelector('[aria-label="保存批注"]'), camera = editor.querySelector('[aria-label="截图附加到批注"]');
  const inputText = (value: string) => { input.value = value; input.dispatchEvent({ type: 'input', bubbles: true }); };
  assert.equal(confirm.disabled, true);
  inputText(' \n　 '); app.click(confirm); editor.onsubmit({ preventDefault() {} }); await flush();
  assert.equal(app.mutations.some(item => item.mutation.type === 'annotation'), false);
  assert.equal(app.document.querySelector('.rg-note-editor'), editor);
  inputText('解释这一段'); assert.equal(confirm.disabled, false);
  inputText(''); assert.equal(confirm.disabled, true);
  app.click(camera); await flush(); app.imageCaptures[0].pending.resolve(null); await flush();
  assert.equal(confirm.disabled, true, '取消截图不启用空批注保存');
  app.click(camera); await flush();
  app.imageCaptures[1].pending.resolve([{ id: 'attachment', title: '附图', imageDataUrl: 'data:image/png;base64,AA==' }]); await flush();
  assert.equal(confirm.disabled, false, '仅附图也是有效批注');
  app.click(editor.querySelector('[aria-label="移除附加截图"]')); assert.equal(confirm.disabled, true);
  inputText('已填写的批注'); editor.onsubmit({ preventDefault() {} }); await flush();
  assert.equal(app.mutations.filter(item => item.mutation.type === 'annotation').length, 1);
});

test('批注Enter保存多行内容，Shift+Enter和输入法确认保持编辑', async () => {
  const app = fixture(), data = workspace('A');
  data.graphs[0].nodes[0].images = [{ id: 'screen', title: '截图', imageDataUrl: 'data:image/png;base64,AA==' }];
  const opening = app.api.open({ workspaceId: 'A' }); await app.resolve(0, data); await opening;
  app.click(app.document.querySelector('.rg-world .rg-card')); await flush();
  const image = app.document.querySelector('.rg-focus').querySelector('img');
  app.pointer(image, 'pointerdown', { clientX: 20, clientY: 20 });
  app.pointer(image, 'pointerup', { clientX: 200, clientY: 160 });
  const editor = app.document.querySelector('.rg-note-editor'), input = editor.querySelector('textarea');
  const enter = (values: Record<string, unknown> = {}) => {
    const event: any = { type: 'keydown', key: 'Enter', bubbles: true, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...values };
    input.dispatchEvent(event); return event;
  };
  enter(); await flush();
  assert.equal(app.document.querySelector('.rg-note-editor'), editor, '空批注回车不提交');
  input.value = '第一行'; input.dispatchEvent({ type: 'input', bubbles: true });
  assert.equal(enter({ shiftKey: true }).defaultPrevented, false, '允许textarea执行原生换行');
  assert.equal(enter({ isComposing: true }).defaultPrevented, false);
  assert.equal(enter({ keyCode: 229 }).defaultPrevented, false);
  assert.equal(enter({ repeat: true }).defaultPrevented, true, '长按回车不完成批注');
  assert.equal(app.mutations.filter(item => item.mutation.type === 'annotation').length, 0);
  assert.equal(app.document.querySelector('.rg-note-editor'), editor);
  input.value = '第一行\n第二行'; input.dispatchEvent({ type: 'input', bubbles: true });
  assert.equal(enter().defaultPrevented, true); await flush();
  const annotations = app.mutations.filter(item => item.mutation.type === 'annotation');
  assert.equal(annotations.length, 1);
  assert.equal(annotations[0].mutation.annotation.comment, '第一行\n第二行');
  assert.equal(app.document.querySelector('.rg-note-editor'), null);
});

test('第一次Enter保存批注并聚焦生成按钮，第二次激活才收回并生成', async () => {
  const app = fixture(), data = workspace('A'), root = data.graphs[0].nodes[0];
  root.images = [{ id: 'screen', title: '截图', imageDataUrl: 'data:image/png;base64,AA==' }];
  root.annotations = [{ id: 'pending', comment: '已有待生成批注', selection: { kind: 'text', text: '原文' } },
    { id: 'done', comment: '已有结果', selection: { kind: 'text', text: '结果' }, childId: 'child' }];
  const opening = app.api.open({ workspaceId: 'A' }); await app.resolve(0, data); await opening;
  app.click(app.document.querySelector('.rg-world .rg-card')); await flush();
  const focus = app.document.querySelector('.rg-focus .rg-card'), image = focus.querySelector('img');
  app.pointer(image, 'pointerdown', { clientX: 20, clientY: 20 }); app.pointer(image, 'pointerup', { clientX: 200, clientY: 160 });
  const input = app.document.querySelector('.rg-note-editor').querySelector('textarea'); input.value = '新批注';
  const saved = deferred<GraphWorkspace>(); let submitted: any;
  app.window.rabbitDesktop.graphMutate = async (_workspaceId: string, mutation: any) => { submitted = mutation; return saved.promise; };
  app.holdAnimations();
  input.dispatchEvent({ type: 'keydown', key: 'Enter', bubbles: true, preventDefault() {}, stopPropagation() { this.stopped = true; } }); await flush();
  assert.equal(app.generated.length, 0);
  assert.equal(focus.inert, false, '保存尚未成功时不提前收回');
  const updated = structuredClone(data); updated.revision++; updated.graphs[0].nodes[0].annotations.push(submitted.annotation);
  saved.resolve(updated); await flush();
  const generate = focus.querySelector('[aria-label="根据批注生成卡片"]');
  assert.equal(app.generated.length, 0, '第一次Enter只保存批注');
  assert.equal(focus.inert, false);
  assert.equal(app.document.activeElement, generate, '保存成功把焦点交给原卡片生成按钮');
  const repeat: any = { type: 'keydown', key: 'Enter', repeat: true, bubbles: true, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } };
  generate.dispatchEvent(repeat); await flush();
  assert.equal(repeat.defaultPrevented, true, '长按回车不跨过第二次确认');
  assert.equal(app.generated.length, 0);
  const after = app.animations.length; app.click(generate); await flush();
  assert.equal(app.generated.length, 0, '第二次激活后仍须等收回完成');
  assert.equal(focus.inert, true);
  app.animations.slice(after).filter(animation => focus.contains(animation.element)).forEach(animation => animation.pending.resolve()); await flush();
  assert.equal(focus.isConnected, false);
  assert.deepEqual(JSON.parse(JSON.stringify(app.generated)), [{ workspaceId: 'A', graphId: 'graph-A', nodeId: 'root', annotationIds: ['pending', submitted.annotation.id] }]);
});

test('勾选仅保存批注，Enter保存失败不生成且仍可重试保存', async () => {
  for (const failure of [false, true]) {
    const app = fixture(), data = workspace('A');
    data.graphs[0].nodes[0].images = [{ id: 'screen', title: '截图', imageDataUrl: 'data:image/png;base64,AA==' }];
    const opening = app.api.open({ workspaceId: 'A' }); await app.resolve(0, data); await opening;
    app.click(app.document.querySelector('.rg-world .rg-card')); await flush();
    const focus = app.document.querySelector('.rg-focus .rg-card'), image = focus.querySelector('img');
    app.pointer(image, 'pointerdown', { clientX: 20, clientY: 20 }); app.pointer(image, 'pointerup', { clientX: 200, clientY: 160 });
    const editor = app.document.querySelector('.rg-note-editor'), input = editor.querySelector('textarea'); input.value = '保留批注';
    input.dispatchEvent({ type: 'input', bubbles: true });
    if (failure) {
      app.window.rabbitDesktop.graphMutate = async () => { throw new Error('写入失败'); };
      input.dispatchEvent({ type: 'keydown', key: 'Enter', bubbles: true, preventDefault() {}, stopPropagation() { this.stopped = true; } });
    } else app.click(editor.querySelector('[aria-label="保存批注"]'));
    await flush();
    assert.equal(app.generated.length, 0);
    assert.equal(app.document.querySelector('.rg-focus .rg-card'), focus);
    assert.equal(focus.inert, false);
    assert.notEqual(app.document.activeElement, focus.querySelector('[aria-label="根据批注生成卡片"]'), '勾选保存或保存失败不转交生成焦点');
    if (failure) assert.ok(app.document.querySelector('.rg-toast').querySelectorAll('button').some((item: any) => item.textContent === '重试保存'));
    else assert.equal(app.mutations.filter(item => item.mutation.type === 'annotation').length, 1);
  }
});

test('Enter保存期间切换工作区，迟到成功不生成、不收起或抢走新卡片焦点', async () => {
  const app = fixture(), data = workspace('A');
  data.graphs[0].nodes[0].images = [{ id: 'screen', title: '截图', imageDataUrl: 'data:image/png;base64,AA==' }];
  const opening = app.api.open({ workspaceId: 'A' }); await app.resolve(0, data); await opening;
  app.click(app.document.querySelector('.rg-world .rg-card')); await flush();
  const image = app.document.querySelector('.rg-focus .rg-card').querySelector('img');
  app.pointer(image, 'pointerdown', { clientX: 20, clientY: 20 }); app.pointer(image, 'pointerup', { clientX: 200, clientY: 160 });
  const input = app.document.querySelector('.rg-note-editor').querySelector('textarea'); input.value = 'A的批注';
  const saved = deferred<GraphWorkspace>(); let submitted: any;
  app.window.rabbitDesktop.graphMutate = async (_workspaceId: string, mutation: any) => { submitted = mutation; return saved.promise; };
  input.dispatchEvent({ type: 'keydown', key: 'Enter', bubbles: true, preventDefault() {}, stopPropagation() { this.stopped = true; } }); await flush();
  const next = app.api.open({ workspaceId: 'B' }); await app.resolve(1, workspace('B')); await next;
  app.click(app.document.querySelector('.rg-world .rg-card')); await flush();
  const focusB = app.document.querySelector('.rg-focus .rg-card');
  const focusedControl = focusB.querySelector('[aria-label="添加文本"]'); focusedControl.focus();
  const updated = structuredClone(data); updated.revision++; updated.graphs[0].nodes[0].annotations.push(submitted.annotation);
  saved.resolve(updated); await flush();
  assert.equal(app.api.getSnapshot().workspaceId, 'B');
  assert.equal(app.document.querySelector('.rg-focus .rg-card'), focusB);
  assert.equal(focusB.inert, false);
  assert.equal(app.generated.length, 0);
  assert.equal(app.document.activeElement, focusedControl);
});

test('Enter保存迟到完成不抢走同卡下一条批注或重新展开卡片的焦点', async () => {
  for (const transition of ['next-note', 'reopen']) {
    const app = fixture(), data = workspace('A');
    data.graphs[0].nodes[0].images = [{ id: 'screen', title: '截图', imageDataUrl: 'data:image/png;base64,AA==' }];
    const opening = app.api.open({ workspaceId: 'A' }); await app.resolve(0, data); await opening;
    app.click(app.document.querySelector('.rg-world .rg-card')); await flush();
    const oldFocus = app.document.querySelector('.rg-focus .rg-card'), image = oldFocus.querySelector('img');
    app.pointer(image, 'pointerdown', { clientX: 20, clientY: 20 }); app.pointer(image, 'pointerup', { clientX: 200, clientY: 160 });
    const input = app.document.querySelector('.rg-note-editor').querySelector('textarea'); input.value = '先保存这一条';
    const saved = deferred<GraphWorkspace>(); let submitted: any;
    app.window.rabbitDesktop.graphMutate = async (_workspaceId: string, mutation: any) => { submitted = mutation; return saved.promise; };
    input.dispatchEvent({ type: 'keydown', key: 'Enter', bubbles: true, preventDefault() {}, stopPropagation() { this.stopped = true; } }); await flush();
    let active: any;
    if (transition === 'next-note') {
      app.pointer(image, 'pointerdown', { clientX: 40, clientY: 40 }); app.pointer(image, 'pointerup', { clientX: 220, clientY: 180 });
      active = app.document.querySelector('.rg-note-editor').querySelector('textarea'); active.value = '正在写下一条';
    } else {
      app.click(app.document.querySelector('.rg-focus')); await flush();
      app.click(app.document.querySelector('.rg-world .rg-card')); await flush();
      const reopened = app.document.querySelector('.rg-focus .rg-card'); assert.notEqual(reopened, oldFocus);
      active = reopened.querySelector('[aria-label="添加文本"]'); active.focus();
    }
    const updated = structuredClone(data); updated.revision++; updated.graphs[0].nodes[0].annotations.push(submitted.annotation);
    saved.resolve(updated); await flush();
    assert.ok(app.document.activeElement === active, transition + '：迟到保存不转移当前焦点');
    assert.equal(app.generated.length, 0);
    if (transition === 'next-note') assert.equal(active.value, '正在写下一条');
  }
});

test('批注外点取消空草稿、自动保存单独附件，Escape取消有内容的草稿', async () => {
  for (const action of ['empty', 'attachment', 'escape']) {
    const app = fixture(), data = workspace('A');
    data.graphs[0].nodes[0].images = [{ id: 'screen', title: '截图', imageDataUrl: 'data:image/png;base64,AA==' }];
    const opening = app.api.open({ workspaceId: 'A' }); await app.resolve(0, data); await opening;
    const click = (target: any) => { app.pointer(target, 'pointerdown'); app.pointer(target, 'pointerup'); app.click(target, { detail: 1, clientX: 10, clientY: 10 }); };
    click(app.document.querySelector('.rg-world .rg-card')); await flush();
    const focused = app.document.querySelector('.rg-focus .rg-card'), image = focused.querySelector('img');
    app.pointer(image, 'pointerdown', { clientX: 20, clientY: 20 }); app.pointer(image, 'pointerup', { clientX: 200, clientY: 160 });
    const editor = app.document.querySelector('.rg-note-editor'); assert.ok(editor);
    editor.querySelector('textarea').value = action === 'escape' ? '按Escape放弃这条批注' : '  ';
    if (action !== 'empty') {
      click(editor.querySelector('[aria-label="截图附加到批注"]')); await flush();
      app.imageCaptures[0].pending.resolve([{ id: 'attachment', title: '附加截图', imageDataUrl: 'data:image/png;base64,AQ==' }]); await flush();
    }
    if (action === 'escape') editor.dispatchEvent({ type: 'keydown', key: 'Escape', bubbles: true, stopPropagation() { this.stopped = true; } });
    else click(focused.querySelector('.rg-body'));
    await flush();
    assert.equal(app.document.querySelector('.rg-note-editor'), null);
    assert.equal(app.document.querySelector('.rg-focus .rg-card'), focused, '结束批注不额外收回卡片');
    const saved = app.mutations.filter(item => item.mutation.type === 'annotation');
    assert.equal(saved.length, action === 'attachment' ? 1 : 0);
    if (action === 'attachment') {
      assert.equal(saved[0].mutation.annotation.comment, '');
      assert.equal(saved[0].mutation.annotation.selection.imageId, 'screen');
      assert.deepEqual(Array.from(saved[0].mutation.annotation.images, (item: any) => item.id), ['attachment']);
    }
    app.api.close();
  }
});

test('外点保存迟到成功时不影响关闭重开或新工作区中的批注与选区', async () => {
  for (const transition of ['reopen', 'workspace']) {
    const app = fixture(), data = workspace('A');
    data.graphs[0].nodes[0].images = [{ id: 'screen', title: '截图', imageDataUrl: 'data:image/png;base64,AA==' }];
    const opening = app.api.open({ workspaceId: 'A' }); await app.resolve(0, data); await opening;
    const click = (target: any) => { app.pointer(target, 'pointerdown'); app.pointer(target, 'pointerup'); app.click(target, { detail: 1, clientX: 10, clientY: 10 }); };
    click(app.document.querySelector('.rg-world .rg-card')); await flush();
    const image = app.document.querySelector('.rg-focus').querySelector('img');
    app.pointer(image, 'pointerdown', { clientX: 20, clientY: 20 }); app.pointer(image, 'pointerup', { clientX: 200, clientY: 160 });
    const oldEditor = app.document.querySelector('.rg-note-editor'); oldEditor.querySelector('textarea').value = '旧工作区批注';
    const pending = deferred<GraphWorkspace>(), requests: any[] = [], originalMutate = app.window.rabbitDesktop.graphMutate;
    app.window.rabbitDesktop.graphMutate = (workspaceId: string, mutation: any) => {
      if (mutation.type !== 'annotation') return originalMutate(workspaceId, mutation);
      requests.push({ workspaceId, mutation: structuredClone(mutation) }); return pending.promise;
    };
    click(app.document.querySelector('.rg-focus .rg-body')); await flush();
    assert.equal(app.document.querySelector('.rg-note-editor'), null, '保存发出即结束旧编辑器');
    assert.equal(requests.length, 1); assert.equal(requests[0].workspaceId, 'A');
    const next = transition === 'workspace' ? workspace('B') : structuredClone(data);
    next.graphs[0].nodes[0].images = structuredClone(data.graphs[0].nodes[0].images);
    if (transition === 'reopen') app.api.close();
    const reopening = app.api.open({ workspaceId: next.id }); await app.resolve(1, next); await reopening; await flush();
    click(app.document.querySelector('.rg-world .rg-card')); await flush();
    const newImage = app.document.querySelector('.rg-focus').querySelector('img');
    app.pointer(newImage, 'pointerdown', { clientX: 40, clientY: 40 }); app.pointer(newImage, 'pointerup', { clientX: 220, clientY: 170 });
    const currentEditor = app.document.querySelector('.rg-note-editor'), input = currentEditor.querySelector('textarea'); input.value = '当前尚未保存的批注';
    let cleared = 0;
    const selection = { anchorNode: app.document.querySelector('.rg-focus .rg-body'), rangeCount: 1, toString: () => '当前新选区', removeAllRanges() { cleared++; } };
    app.window.getSelection = () => selection;
    const saved = structuredClone(data); saved.revision++; saved.graphs[0].nodes[0].annotations.push(requests[0].mutation.annotation);
    pending.resolve(saved); await flush(); await flush();
    assert.equal(app.api.getSnapshot().workspaceId, next.id);
    assert.equal(app.document.querySelector('.rg-note-editor'), currentEditor);
    assert.equal(input.value, '当前尚未保存的批注'); assert.equal(app.document.activeElement, input);
    assert.equal(cleared, 0, '旧保存结果不能清空新选区');
    assert.equal(requests.length, 1, '旧请求完成不额外提交当前草稿');
    app.api.close();
  }
});

test('自动保存失败保留重试入口，切工作区后仍按原批注快照重试', async () => {
  const app = fixture(), data = workspace('A'), root = data.graphs[0].nodes[0];
  root.images = [{ id: 'screen', title: '截图', imageDataUrl: 'data:image/png;base64,AA==' }];
  root.annotations = [{ id: 'existing', comment: '原批注', childId: 'child',
    selection: { kind: 'image', imageId: 'screen', rect: { x: .2, y: .2, width: .3, height: .3 } },
    images: [{ id: 'attachment', title: '附加截图', imageDataUrl: 'data:image/png;base64,AQ==' }] }];
  const opening = app.api.open({ workspaceId: 'A' }); await app.resolve(0, data); await opening;
  const click = (target: any) => { app.pointer(target, 'pointerdown'); app.pointer(target, 'pointerup'); app.click(target, { detail: 1, clientX: 10, clientY: 10 }); };
  click(app.document.querySelector('.rg-world .rg-card')); await flush();
  click(app.document.querySelector('.rg-focus .rg-note-number'));
  const editor = app.document.querySelector('.rg-note-editor'), input = editor.querySelector('textarea'); input.value = '  应重试的原始内容  ';
  const requests: Array<{ workspaceId: string; mutation: any; pending: ReturnType<typeof deferred<GraphWorkspace>> }> = [], originalMutate = app.window.rabbitDesktop.graphMutate;
  app.window.rabbitDesktop.graphMutate = (workspaceId: string, mutation: any) => {
    if (mutation.type !== 'annotation') return originalMutate(workspaceId, mutation);
    const pending = deferred<GraphWorkspace>(); requests.push({ workspaceId, mutation: structuredClone(mutation), pending }); return pending.promise;
  };
  click(app.document.querySelector('.rg-focus .rg-body')); await flush();
  input.value = '保存后发生的输入变化';
  const savedSnapshot = structuredClone(requests[0].mutation);
  const next = app.api.open({ workspaceId: 'B' }); await app.resolve(1, workspace('B')); await next;
  requests[0].pending.reject(new Error('连接断开')); await flush(); await flush();
  let retry = app.document.querySelector('.rg-toast').querySelector('button'); assert.equal(retry.textContent, '重试保存');
  app.tick(60000); await flush();
  retry = app.document.querySelector('.rg-toast').querySelector('button'); assert.equal(retry.textContent, '重试保存', '失败快照等待用户重试，不自动过期');
  click(retry); await flush();
  assert.equal(requests.length, 2); assert.equal(requests[1].workspaceId, 'A');
  assert.deepEqual(requests[1].mutation, savedSnapshot);
  assert.equal(requests[1].mutation.annotation.comment, '应重试的原始内容');
  assert.equal(requests[1].mutation.annotation.childId, 'child');
  assert.equal(requests[1].mutation.annotation.images[0].id, 'attachment');
  const saved = structuredClone(data); saved.revision++; saved.graphs[0].nodes[0].annotations = [requests[1].mutation.annotation];
  requests[1].pending.resolve(saved); await flush(); await flush();
  assert.equal(app.api.getSnapshot().workspaceId, 'B');
  assert.equal(app.document.querySelector('.rg-note-editor'), null, '成功重试不恢复已结束的旧编辑器');
  app.api.close();
});

test('图谱外同文档控件的真实点击也保存批注且仍执行自身操作', async () => {
  const app = fixture(), data = workspace('A'), root = data.graphs[0].nodes[0];
  root.images = [{ id: 'screen', title: '截图', imageDataUrl: 'data:image/png;base64,AA==' }];
  root.annotations = [{ id: 'note', comment: '原批注', selection: { kind: 'image', imageId: 'screen', rect: { x: .2, y: .2, width: .3, height: .3 } } }];
  const opening = app.api.open({ workspaceId: 'A' }); await app.resolve(0, data); await opening;
  const click = (target: any) => { app.pointer(target, 'pointerdown'); app.pointer(target, 'pointerup'); return app.click(target, { detail: 1, clientX: 10, clientY: 10 }); };
  click(app.document.querySelector('.rg-world .rg-card')); await flush(); click(app.document.querySelector('.rg-focus .rg-note-number'));
  app.document.querySelector('.rg-note-editor').querySelector('textarea').value = '点击兔球后也保留';
  const external = app.document.createElement('button'); app.document.body.append(external);
  let activated = 0; external.onclick = () => { activated++; };
  const event = click(external); await flush();
  const saved = app.mutations.filter(item => item.mutation.type === 'annotation');
  assert.equal(saved.length, 1, 'document capture仅派发一次，不重复保存');
  assert.equal(saved[0].mutation.annotation.comment, '点击兔球后也保留');
  assert.equal(app.document.querySelector('.rg-note-editor'), null);
  assert.equal(activated, 1); assert.equal(event.defaultPrevented, undefined);
  app.api.close();
});

test('连续两条自动保存失败后，其他提示和工作区切换不丢失任何重试快照', async () => {
  const app = fixture(), data = workspace('A'), root = data.graphs[0].nodes[0];
  root.images = [{ id: 'screen', title: '截图', imageDataUrl: 'data:image/png;base64,AA==' }];
  root.annotations = [1, 2].map(index => ({ id: `note-${index}`, comment: `原批注${index}`, selection: { kind: 'image' as const, imageId: 'screen', rect: { x: .1 * index, y: .2, width: .2, height: .2 } } }));
  const opening = app.api.open({ workspaceId: 'A' }); await app.resolve(0, data); await opening;
  const click = (target: any) => { app.pointer(target, 'pointerdown'); app.pointer(target, 'pointerup'); app.click(target, { detail: 1, clientX: 10, clientY: 10 }); };
  click(app.document.querySelector('.rg-world .rg-card')); await flush();
  const requests: Array<{ workspaceId: string; mutation: any; pending: ReturnType<typeof deferred<GraphWorkspace>> }> = [], originalMutate = app.window.rabbitDesktop.graphMutate;
  app.window.rabbitDesktop.graphMutate = (workspaceId: string, mutation: any) => {
    if (mutation.type !== 'annotation') return originalMutate(workspaceId, mutation);
    const pending = deferred<GraphWorkspace>(); requests.push({ workspaceId, mutation: structuredClone(mutation), pending }); return pending.promise;
  };
  for (let index = 0; index < 2; index++) {
    click(app.document.querySelector('.rg-focus').querySelectorAll('.rg-note-number')[index]);
    app.document.querySelector('.rg-note-editor').querySelector('textarea').value = `分别保存的草稿${index + 1}`;
    click(app.document.querySelector('.rg-focus .rg-body')); await flush();
  }
  assert.equal(requests.length, 2);
  requests[0].pending.reject(new Error('第一条失败')); await flush();
  requests[1].pending.reject(new Error('第二条失败')); await flush();
  app.window.rabbitDesktop.graphGenerate = async () => { throw new Error('另一项操作失败'); };
  click(app.document.querySelector('.rg-focus').querySelector('[aria-label="根据批注生成卡片"]')); await flush();
  const next = app.api.open({ workspaceId: 'B' }); await app.resolve(1, workspace('B')); await next;
  app.tick(60000); await flush();
  const retry = app.document.querySelector('.rg-toast').querySelectorAll('button').find((item: any) => item.textContent === '重试保存'); assert.ok(retry);
  click(retry); await flush();
  assert.equal(requests.length, 4);
  for (let index = 0; index < 2; index++) {
    assert.equal(requests[index + 2].workspaceId, 'A'); assert.deepEqual(requests[index + 2].mutation, requests[index].mutation);
    const saved = structuredClone(data); saved.revision += index + 1;
    saved.graphs[0].nodes[0].annotations = requests.slice(2, index + 3).map(request => request.mutation.annotation);
    requests[index + 2].pending.resolve(saved); await flush();
  }
  assert.equal(app.api.getSnapshot().workspaceId, 'B');
  assert.equal(app.document.querySelector('.rg-toast')?.querySelectorAll('button').some((item: any) => item.textContent === '重试保存'), false);
  app.api.close();
});

test('删除已有批注只提交移除批注操作，不删除其已生成子卡', async () => {
  const app = fixture(), data = workspace('A'), root = data.graphs[0].nodes[0];
  root.images = [{ id: 'screen', title: '截图', imageDataUrl: 'data:image/png;base64,AA==' }];
  root.annotations = [{ id: 'note', selection: { kind: 'image', imageId: 'screen', rect: { x: .2, y: .2, width: .3, height: .3 } }, comment: '已生成', childId: 'branch' }];
  data.graphs[0].nodes.push({ ...structuredClone(root), id: 'branch', parentId: 'root', kind: 'card', images: [], annotations: [], markdown: '已有子卡', x: 650 });
  const opening = app.api.open({ activationId: 116, workspaceId: 'A', view: 'graph' });
  await app.resolve(0, data); await opening;
  app.click(app.document.querySelector('.rg-world').querySelector('.rg-card')); await flush();
  app.click(app.document.querySelector('.rg-focus').querySelector('.rg-note-number'));
  const remove = app.document.querySelector('.rg-note-editor').querySelectorAll('button').find((item: any) => /删除批注/.test(item.getAttribute('aria-label') || ''));
  assert.ok(remove); app.click(remove); await flush();
  const removed = app.mutations.filter(item => item.mutation.type === 'remove-annotation');
  assert.deepEqual(JSON.parse(JSON.stringify(removed)), [{ workspaceId: 'A', mutation: { type: 'remove-annotation', graphId: 'graph-A', nodeId: 'root', annotationId: 'note' } }]);
  assert.equal(app.mutations.some(item => item.mutation.type === 'delete'), false);
  assert.ok(app.api.getSnapshot().workspace.graphs[0].nodes.some((node: GraphNode) => node.id === 'branch'));
});

test('模式已关闭时从设置进入图谱，重复通知和未保存草稿回滚都不关闭图谱', async () => {
  const saved = { graphPluginEnabled: true, graphModeEnabled: false }, app = fixture(saved);
  const opening = app.api.open({ activationId: 121, workspaceId: 'A', view: 'graph', graphAction: 'rename-graph' });
  await app.resolve(0, workspace('A')); await opening;
  for (const type of ['settings:change', 'settings:saved']) app.emit(type, { settings: { ...saved } });
  assert.equal(app.api.isOpen(), true);
  app.emit('settings:change', { settings: { ...saved, graphModeEnabled: true } });
  app.emit('settings:change', { settings: { ...saved, graphModeEnabled: false } });
  assert.equal(app.api.isOpen(), true);
  assert.ok(app.document.querySelector('[aria-label="重命名图谱"]'));
  assert.equal(app.events.filter(event => event.type === 'graph:close').length, 0);
});

test('已保存的大爆炸模式从开启变为关闭时退出所属图谱', async () => {
  const saved = { graphPluginEnabled: true, graphModeEnabled: true }, app = fixture(saved);
  const opening = app.api.open({ activationId: 131, workspaceId: 'A', view: 'graph' });
  await app.resolve(0, workspace('A')); await opening;
  saved.graphModeEnabled = false;
  app.emit('settings:saved', { settings: { ...saved } });
  app.emit('settings:change', { settings: { ...saved } });
  assert.equal(app.api.isOpen(), false);
  const closed = app.events.filter(event => event.type === 'graph:close');
  assert.equal(closed.length, 1);
  assert.equal(closed[0].detail.activationId, 131);
});

test('禁用插件立即关闭图谱并保留工作区数据', async () => {
  const saved = { graphPluginEnabled: true, graphModeEnabled: false }, app = fixture(saved);
  const opening = app.api.open({ activationId: 141, workspaceId: 'A', view: 'graph' });
  await app.resolve(0, workspace('A')); await opening;
  app.emit('settings:change', { settings: { ...saved, graphPluginEnabled: false } });
  assert.equal(app.api.isOpen(), false);
  assert.equal(app.api.getSnapshot().workspaceId, 'A');
  assert.equal(app.api.getSnapshot().workspace.graphs.length, 1);
});

test('可见卡片不重复固定，移出视口和退出后保留预览，禁用插件清空命中区', async () => {
  const saved = { graphPluginEnabled: true, graphModeEnabled: false }, app = fixture(saved), data = workspace('A');
  data.graphs[0].nodes.push({ ...structuredClone(data.graphs[0].nodes[0]), id: 'pinned-child', parentId: 'root', kind: 'card', pinned: true });
  for (let index = 0; index < 6; index++) data.graphs[0].nodes.push({ ...structuredClone(data.graphs[0].nodes[0]), id: 'far-' + index,
    parentId: index ? 'far-' + (index - 1) : 'pinned-child', kind: 'card', x: 800 + index * 480, pinned: false });
  const opening = app.api.open({ activationId: 151, workspaceId: 'A', view: 'graph' });
  await app.resolve(0, data); await opening;
  assert.equal(app.document.querySelector('.rg-pins').children.length, 0);
  const viewport = app.document.querySelector('.rg-viewport');
  app.pointer(viewport, 'pointerdown'); app.pointer(viewport, 'pointermove', { clientX: -1990 }); app.pointer(viewport, 'pointerup', { clientX: -1990 });
  assert.equal(app.document.querySelector('.rg-pins').children.length, 1);
  app.api.close(); await flush();
  const root = app.document.querySelector('#rabbit-graph-root'), holder = app.document.querySelector('.rg-pin'), card = holder.querySelector('.rg-card');
  assert.equal(card.querySelector('.rg-title').hidden, false, '非根固定牌保留底部标题胶囊');
  assert.equal(root.classList.contains('has-pins'), true);
  app.document.querySelector('.rg-pin-window').getBoundingClientRect = () => ({ left: 180, top: 0, right: 980, bottom: 400, width: 800, height: 400 });
  card.getBoundingClientRect = () => { const top = holder.classList.contains('is-revealed') ? 0 : -280; return { left: 200, top, right: 440, bottom: top + 320, width: 240, height: 320 }; };
  card.querySelector('.rg-title').getBoundingClientRect = () => { const top = card.getBoundingClientRect().bottom - 17; return { left: 260, top, right: 380, bottom: top + 34, width: 120, height: 34 }; };
  const tools = card.querySelector('.rg-card-tools'), unpin = card.querySelector('[aria-label="取消固定"]');
  assert.equal(tools.children.length, 0, '固定牌不再显示普通工具栏');
  assert.deepEqual(card.querySelectorAll('.rg-action').map((item: any) => item.getAttribute('aria-label')), ['取消固定'], '固定预览仅保留取消固定动作');
  assert.equal(card.querySelector('[aria-label="添加自定义卡片"]'), null);
  assert.equal(card.querySelector('[aria-label="删除卡片及其子卡片"]'), null);
  assert.equal(card.querySelector('[aria-label="根据批注生成卡片"]'), null);
  assert.equal(unpin.parentElement, card); assert.equal(unpin.classList.contains('rg-pin-toggle'), true); assert.equal(unpin.classList.contains('is-active'), true);
  unpin.getBoundingClientRect = () => { const title = card.querySelector('.rg-title').getBoundingClientRect(), left = title.right + 6; return { left, top: title.top, right: left + 34, bottom: title.top + 34, width: 34, height: 34 }; };
  assert.equal(card.querySelector('.rg-handle'), null, '顶部固定牌无需拖动手柄');
  app.emit('desktop:cursor', { x: 403, y: 40 });
  assert.equal(holder.classList.contains('is-revealed'), false, '悬停取消固定按钮不让牌面展开或按钮位移');
  assert.deepEqual(app.pinRegions.at(-1).rects, [
    { x: 200, y: 0, width: 240, height: 40 }, { x: 260, y: 23, width: 120, height: 34 }, { x: 386, y: 23, width: 34, height: 34 },
  ], '收起时标题右侧34像素按钮仍向原生窗口上报热区');
  unpin.focus(); unpin.dispatchEvent({ type: 'focusin', target: unpin, bubbles: true });
  assert.equal(holder.classList.contains('is-revealed'), false, '键盘聚焦取消固定按钮也保持当前位置');
  unpin.blur(); unpin.dispatchEvent({ type: 'focusout', target: unpin, bubbles: true });
  app.emit('desktop:cursor', { x: 320, y: 50 });
  assert.equal(holder.classList.contains('is-revealed'), true);
  assert.deepEqual(app.pinRegions.at(-1).rects, [
    { x: 200, y: 0, width: 240, height: 320 }, { x: 260, y: 303, width: 120, height: 34 },
    { x: 386, y: 303, width: 34, height: 34 },
  ]);
  app.emit('desktop:cursor', { x: 320, y: 330 }); app.tick(160); await flush();
  assert.equal(holder.classList.contains('is-revealed'), true, '胶囊露出牌面的下半部保持展开');
  assert.equal(app.pinRegions.at(-1).rects.some((rect: any) => 220 >= rect.x && 220 <= rect.x + rect.width && 330 >= rect.y && 330 <= rect.y + rect.height), false);
  app.emit('desktop:cursor', { x: 220, y: 330 }); app.tick(160); await flush();
  assert.equal(holder.classList.contains('is-revealed'), false, '胶囊旁的空白不保持展开或占用桌面命中');
  app.emit('desktop:cursor', { x: 320, y: 50 });
  app.emit('desktop:cursor', { x: 403, y: 320 }); app.tick(160); await flush();
  assert.equal(holder.classList.contains('is-revealed'), true, '移到展开牌的取消固定按钮时保留当前展开位置');
  app.emit('desktop:cursor', { x: 1500, y: 700 }); app.tick(160); await flush();
  assert.equal(holder.classList.contains('is-revealed'), false);
  assert.deepEqual(app.pinRegions.at(-1).rects, [{ x: 200, y: 0, width: 240, height: 40 }, { x: 260, y: 23, width: 120, height: 34 }, { x: 386, y: 23, width: 34, height: 34 }]);
  const title = card.querySelector('.rg-title'); title.focus(); title.dispatchEvent({ type: 'focusin', target: title, bubbles: true });
  assert.equal(holder.classList.contains('is-revealed'), true, '标题仍可通过键盘聚焦展开预览');
  title.blur(); title.dispatchEvent({ type: 'focusout', target: title, bubbles: true }); app.tick(160); await flush();
  assert.equal(holder.classList.contains('is-revealed'), false);
  saved.graphPluginEnabled = false; app.emit('settings:saved', { settings: { ...saved } });
  assert.equal(root.classList.contains('has-pins'), false);
  assert.deepEqual(app.pinRegions.at(-1).rects, []);
});

test('滑动固定牌的按钮捕获按下目标，拖开取消且键盘点击不受残留指针状态影响', async () => {
  for (const dragDistance of [0, 9]) {
    const app = fixture(), data = workspace('A'); data.graphs[0].nodes[0].pinned = true;
    const opening = app.api.open({ activationId: 156, workspaceId: 'A', view: 'graph' });
    await app.resolve(0, data); await opening; app.api.close(); await flush();
    app.mutateWith(mutation => {
      if (mutation.type === 'pin') { data.graphs[0].nodes[0].pinned = mutation.pinned; data.revision++; }
      return data;
    });
    const holder = app.document.querySelector('.rg-pin'), card = holder.querySelector('.rg-card'), unpin = card.querySelector('[aria-label="取消固定"]');
    app.pointer(unpin, 'pointerdown', { clientX: 430, clientY: 40 });
    assert.equal(unpin.hasPointerCapture(1), true);
    // 动画改变按钮位置后，几何命中已是牌面；捕获仍把后续事件送给按下的按钮。
    unpin.style.top = '200px';
    app.pointer(card, 'pointermove', { clientX: 430 + dragDistance, clientY: 40 });
    const release = app.pointer(card, 'pointerup', { clientX: 430 + dragDistance, clientY: 40 });
    assert.equal(release.target, unpin); assert.equal(unpin.hasPointerCapture(1), false);
    app.click(release.target, { detail: 1 }); await flush();
    assert.deepEqual(app.pinInteractions.map(item => item.phase), ['down', 'up'], '独立固定按钮同样完整通知原生按压周期');
    const pinMutations = () => app.mutations.filter(item => item.mutation.type === 'pin');
    if (dragDistance) {
      assert.equal(pinMutations().length, 0); assert.equal(data.graphs[0].nodes[0].pinned, true);
      // 新一次拖开后，以键盘激活同一控件，不能被指针的取消标记吞掉。
      app.pointer(unpin, 'pointerdown', { clientX: 430, clientY: 40 });
      app.pointer(card, 'pointermove', { clientX: 450, clientY: 40 });
      app.pointer(card, 'pointerup', { clientX: 450, clientY: 40 });
      app.click(unpin, { detail: 0 }); await flush();
    }
    assert.deepEqual(JSON.parse(JSON.stringify(pinMutations())), [{ workspaceId: 'A', mutation: { type: 'pin', graphId: 'graph-A', nodeId: 'root', pinned: false } }]);
    assert.equal(data.graphs[0].nodes[0].pinned, false); assert.equal(app.activations.length, 0);
    assert.equal(app.requests.length, 1, '按钮事件不能冒泡成固定牌激活');
  }
});

test('固定牌正文双击保持文字选择，原生交互按下松开配对且失焦收回预览', async () => {
  const app = fixture(), data = workspace('A'); data.graphs[0].nodes[0].pinned = true; data.graphs[0].nodes[0].markdown = '可以双击选择与复制的正文';
  const opening = app.api.open({ activationId: 158, workspaceId: 'A', view: 'graph' });
  await app.resolve(0, data); await opening; app.api.close(); await flush(); app.bridgeCalls.length = 0;
  const holder = app.document.querySelector('.rg-pin'), card = holder.querySelector('.rg-card'), body = card.querySelector('.rg-body');
  app.pointer(body, 'pointerdown', { pointerId: 3, clientX: 320, clientY: 120 });
  assert.equal(app.document.activeElement, card, '正文按下聚焦可选中文字的卡片，而非打开图谱');
  app.pointer(body, 'pointerup', { pointerId: 3, clientX: 350, clientY: 120 });
  app.click(body, { detail: 1 }); app.click(body, { detail: 2 });
  body.dispatchEvent({ type: 'dblclick', target: body, bubbles: true }); await flush();
  assert.deepEqual(app.pinInteractions, [{ phase: 'down', point: { x: 320, y: 120 } }, { phase: 'up', point: { x: 350, y: 120 } }]);
  assert.equal(app.activations.length, 0); assert.deepEqual(app.bridgeCalls, []); assert.equal(app.requests.length, 1);
  card.dispatchEvent({ type: 'focusin', target: card, bubbles: true }); assert.equal(holder.classList.contains('is-revealed'), true);
  app.pointer(body, 'pointerdown', { pointerId: 4, button: 2, clientX: 330, clientY: 160 });
  app.pointer(body, 'pointerup', { pointerId: 5, button: 2, clientX: 330, clientY: 160 });
  await flush();
  assert.deepEqual(app.pinInteractions.map(item => item.phase), ['down', 'up', 'down'], '其他指针的释放不能结束当前选择周期');
  app.emitWindow('blur'); await flush();
  assert.deepEqual(app.pinInteractions.at(-1), { phase: 'up', point: { x: 0, y: 0 } });
  assert.equal(holder.classList.contains('is-revealed'), false); assert.equal(app.document.activeElement, app.document.body);
  app.emitWindow('blur'); assert.equal(app.pinInteractions.length, 4, '失焦重复通知不重复结束原生交互');
});

test('退出后点击固定牌图片先打开所属工作区并访问目标图，再激活图谱', async () => {
  const app = fixture(), data = workspace('A');
  data.graphs[0].nodes[0].pinned = true;
  data.graphs[0].nodes[0].images = [{ id: 'image', title: '原始截图', imageDataUrl: 'data:image/png;base64,AA==' }];
  data.graphs.push({ id: 'empty-graph', title: '空图', rootId: 'empty-root', nodes: [], view: { x: 0, y: 0, zoom: 1 }, updatedAt: 2, layoutInitialized: true, layoutUnit: 238 });
  data.lastGraphId = 'empty-graph';
  const opening = app.api.open({ activationId: 161, workspaceId: 'A', view: 'graph' });
  await app.resolve(0, data); await opening;
  app.api.close(); await flush(); app.bridgeCalls.length = 0;
  const pin = app.document.querySelector('.rg-pin').querySelector('.rg-card');
  assert.equal(pin.querySelector('.rg-title').hidden, true, '固定根卡同样隐藏标题');
  app.click(pin.querySelector('.rg-image').querySelector('img')); await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(app.bridgeCalls)), [{ method: 'graphOpen', workspaceId: 'A' }]);
  await app.resolve(1, data); await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(app.bridgeCalls)), [
    { method: 'graphOpen', workspaceId: 'A' },
    { method: 'graphMutate', workspaceId: 'A', mutation: { type: 'visit', graphId: 'graph-A' } },
    { method: 'graphActivate' },
  ]);
  assert.equal(app.captures.length, 0);
});

test('连续点击不同固定卡只激活最后的目标，异步返回不串用请求上下文', async () => {
  const app = fixture(), data = workspace('A');
  data.graphs.push(workspace('B').graphs[0]);
  for (const graph of data.graphs) {
    graph.nodes[0].pinned = true;
    graph.nodes[0].images = [{ id: graph.id, title: '截图', imageDataUrl: 'data:image/png;base64,AA==' }];
  }
  const opening = app.api.open({ workspaceId: 'A' }); await app.resolve(0, data); await opening;
  app.api.close(); await flush(); app.bridgeCalls.length = 0;
  const pins = app.document.querySelectorAll('.rg-pin');
  const pinFor = (id: string) => pins.find((pin: any) => pin.querySelector('.rg-card').dataset.graphId === id);
  app.click(pinFor('graph-A').querySelector('img')); await flush();
  app.click(pinFor('graph-B').querySelector('img')); await flush();
  await app.resolve(1, structuredClone(data));
  assert.equal(app.activations.length, 0, '较早请求完成时不激活或写入旧目标');
  assert.equal(app.bridgeCalls.filter(call => call.method === 'graphMutate').length, 0);
  await app.resolve(2, structuredClone(data));
  assert.equal(app.activations.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(app.bridgeCalls.filter(call => call.method === 'graphMutate'))), [
    { method: 'graphMutate', workspaceId: 'A', mutation: { type: 'visit', graphId: 'graph-B' } },
  ]);
  const activated = app.api.open({ workspaceId: 'A' }); await app.resolve(3, structuredClone(data)); await activated;
  assert.equal(app.api.getSnapshot().graphId, 'graph-B');
  assert.equal(app.api.getSnapshot().nodeId, 'root');
});

test('固定卡激活在等待期间关闭、停用或打开其他图谱后不再迟到激活', async () => {
  for (const cancel of ['close', 'disable', 'open']) {
    const app = fixture(), data = workspace('A');
    data.graphs[0].nodes[0].pinned = true;
    data.graphs[0].nodes[0].images = [{ id: 'image', title: '截图', imageDataUrl: 'data:image/png;base64,AA==' }];
    const opening = app.api.open({ workspaceId: 'A' }); await app.resolve(0, data); await opening;
    app.api.close(); await flush(); app.bridgeCalls.length = 0;
    app.click(app.document.querySelector('.rg-pin').querySelector('img')); await flush();
    let nextOpening;
    if (cancel === 'close') app.api.close();
    else if (cancel === 'disable') app.emit('settings:change', { settings: { graphPluginEnabled: false } });
    else nextOpening = app.api.open({ workspaceId: 'B' });
    await app.resolve(1, data);
    if (nextOpening) { await app.resolve(2, workspace('B')); await nextOpening; }
    assert.equal(app.activations.length, 0, cancel);
    assert.equal(app.bridgeCalls.some(call => call.method === 'graphMutate' && call.mutation.type === 'visit'), false, cancel);
    assert.equal(app.document.querySelector('.rg-toast'), null, '失效请求正常结束，不产生读取空目标的错误提示');
  }
});

test('空白拖动排他接管指针，忽略抖动和其它指针，失焦或丢失捕获后恢复', async () => {
  const app = fixture(), data = workspace('A');
  const opening = app.api.open({ workspaceId: 'A' }); await app.resolve(0, data); await opening;
  const viewport = app.document.querySelector('.rg-viewport'), card = app.document.querySelector('.rg-world .rg-card');
  let cleared = 0;
  app.window.getSelection = () => ({ anchorNode: card, toString: () => '图内旧选区', removeAllRanges() { cleared++; } });
  const before = app.api.getSnapshot().view;
  assert.equal(app.pointer(viewport, 'pointerdown').defaultPrevented, true);
  assert.equal(cleared, 1);
  app.pointer(viewport, 'pointermove', { clientX: 12 });
  assert.deepEqual(app.api.getSnapshot().view, before);
  assert.equal(viewport.classList.contains('is-panning'), false);
  app.pointer(viewport, 'pointermove', { pointerId: 2, clientX: 90 });
  assert.deepEqual(app.api.getSnapshot().view, before);
  app.pointer(viewport, 'pointermove', { clientX: 50 });
  assert.equal(app.api.getSnapshot().view.x, before.x + 40);
  assert.equal(viewport.classList.contains('is-panning'), true);
  app.pointer(viewport, 'pointerup', { pointerId: 2 });
  assert.equal(viewport.classList.contains('is-panning'), true);
  app.emitWindow('blur');
  assert.equal(viewport.classList.contains('is-panning'), false);
  assert.equal(viewport.hasPointerCapture(1), false);
  const stopped = app.api.getSnapshot().view;
  app.pointer(viewport, 'pointermove', { clientX: 200 });
  assert.deepEqual(app.api.getSnapshot().view, stopped);
  app.window.getSelection = () => ({ anchorNode: app.document.body, removeAllRanges() { cleared++; } });
  app.pointer(viewport, 'pointerdown');
  assert.equal(cleared, 1, '不清理图谱外的选区');
  app.pointer(viewport, 'pointermove', { clientX: 30 });
  app.pointer(viewport, 'lostpointercapture');
  assert.equal(viewport.classList.contains('is-panning'), false);
  app.pointer(card, 'pointerdown');
  assert.equal(viewport.hasPointerCapture(1), false, '卡片内手势不能启动画布平移');
  app.api.close();
});

test('标题拖动不展开，正文拖选结束在遮罩不收回，真正点击遮罩才收回', async () => {
  const app = fixture(), data = workspace('A');
  data.graphs[0].nodes.push({ ...structuredClone(data.graphs[0].nodes[0]), id: 'answer', parentId: 'root', kind: 'card', title: '可读标题', markdown: '可选择的正文' });
  const opening = app.api.open({ workspaceId: 'A' }); await app.resolve(0, data); await opening;
  const title = app.document.querySelector('.rg-world').querySelectorAll('.rg-title').find((item: any) => !item.hidden);
  app.pointer(title, 'pointerdown'); app.pointer(title, 'pointermove', { clientX: 80 }); app.pointer(title, 'pointerup', { clientX: 80 });
  app.click(title, { detail: 1, clientX: 80, clientY: 10 });
  assert.equal(app.document.querySelector('.rg-focus .rg-card'), null);
  await flush(); await flush(); app.tick(1000);
  app.pointer(title, 'pointerdown'); app.pointer(title, 'pointerup'); app.click(title, { detail: 1, clientX: 10, clientY: 10 }); await flush();
  const focus = app.document.querySelector('.rg-focus'), card = focus.querySelector('.rg-card'), text = card.querySelector('.rg-body');
  assert.ok(card);
  app.pointer(text, 'pointerdown'); app.pointer(focus, 'pointermove', { clientX: 80 }); app.pointer(focus, 'pointerup', { clientX: 80 });
  app.click(focus, { detail: 1, clientX: 80, clientY: 10 }); await flush();
  assert.equal(focus.querySelector('.rg-card'), card);
  app.pointer(focus, 'pointerdown'); app.pointer(focus, 'pointerup'); app.click(focus, { detail: 1, clientX: 10, clientY: 10 }); await flush();
  assert.equal(focus.querySelector('.rg-card'), null);
  app.api.close();
});

test('其它区域的旧选区不阻塞卡片点击，收回后的延迟选择回调不再打开批注', async () => {
  const app = fixture(), data = workspace('A');
  const opening = app.api.open({ workspaceId: 'A' }); await app.resolve(0, data); await opening;
  app.window.getSelection = () => ({ anchorNode: app.document.body, toString: () => '其它区域选文' });
  app.click(app.document.querySelector('.rg-world .rg-card')); await flush();
  const focus = app.document.querySelector('.rg-focus'), card = focus.querySelector('.rg-card');
  assert.ok(card);
  app.pointer(card.querySelector('.rg-body'), 'pointerup');
  app.click(focus); await flush();
  app.window.getSelection = () => { throw new Error('失效卡片不应再读取选区'); };
  app.tick(0);
  assert.equal(app.document.querySelector('.rg-note-editor'), null);
  app.api.close();
});

test('普通卡正文按住拖动，展开后保持原生文字选择', async () => {
  const app = fixture(), data = workspace('A');
  data.graphs[0].nodes.push({ ...structuredClone(data.graphs[0].nodes[0]), id: 'answer', parentId: 'root', kind: 'card', title: '阅读卡片', markdown: '展开后可以选择的正文' });
  const opening = app.api.open({ workspaceId: 'A' }); await app.resolve(0, data); await opening;
  const card = app.document.querySelector('.rg-world').querySelectorAll('.rg-card').find((item: any) => item.dataset.nodeId === 'answer');
  const text = card.querySelector('.rg-body'), focus = app.document.querySelector('.rg-focus');
  app.pointer(text, 'pointerdown'); app.pointer(text, 'pointermove', { clientX: 70 });
  assert.ok(app.document.querySelector('.rg-drag-ghost'), '从正文按住移动也可拖动卡片');
  app.pointer(text, 'pointerup', { clientX: 70 }); app.click(text, { detail: 1, clientX: 70, clientY: 10 });
  assert.equal(focus.querySelector('.rg-card'), null);
  await flush(); await flush(); app.tick(1000);
  app.pointer(text, 'pointerdown'); app.pointer(text, 'pointerup'); app.click(text, { detail: 1, clientX: 10, clientY: 10 }); await flush();
  const focused = focus.querySelector('.rg-card'), focusedText = focused.querySelector('.rg-body');
  let selected = '可以选择的正文';
  app.window.getSelection = () => ({ anchorNode: focusedText, toString: () => selected, removeAllRanges() { selected = ''; } });
  const down = app.pointer(focusedText, 'pointerdown');
  app.pointer(focusedText, 'pointermove', { clientX: 70 }); app.pointer(focusedText, 'pointerup', { clientX: 70 });
  app.click(focusedText, { detail: 1, clientX: 70, clientY: 10 });
  assert.equal(down.defaultPrevented, undefined, '展开正文保留浏览器默认选择');
  assert.equal(selected, '可以选择的正文');
  assert.equal(app.document.querySelector('.rg-drag-ghost'), null);
  assert.equal(focus.querySelector('.rg-card'), focused);
  app.api.close();
});

test('固定预览按住正文冻结当前动画位置，结束或取消后释放且不启动图谱', async () => {
  for (const open of [true, false]) {
    const app = fixture(), data = workspace('A'), node = data.graphs[0].nodes[0]; node.pinned = true; node.markdown = '固定预览正文';
    data.graphs.push({ ...structuredClone(data.graphs[0]), id: 'empty', rootId: 'empty-root', nodes: [] }); data.lastGraphId = 'empty';
    const opening = app.api.open({ workspaceId: 'A' }); await app.resolve(0, data); await opening;
    if (!open) app.api.close();
    const card = app.document.querySelector('.rg-pin .rg-card'), text = card.querySelector('.rg-body');
    app.pointer(text, 'pointerdown', { pointerId: 4 }); await flush();
    assert.equal(card.classList.contains('is-reading-press'), true);
    assert.equal(card.style.top, '-110px', '读取过渡中的真实位置，不跳到动画终点');
    app.pointer(text, 'pointerup', { pointerId: 5 });
    assert.equal(card.classList.contains('is-reading-press'), true);
    app.pointer(text, 'pointercancel', { pointerId: 4 }); await flush();
    assert.equal(card.classList.contains('is-reading-press'), false); assert.equal(card.style.top, undefined);
    assert.deepEqual(app.pinInteractions.map(item => item.phase), open ? [] : ['down', 'up']);
    assert.equal(app.activations.length, 0);
    if (!open) {
      app.pointer(text, 'pointerdown', { pointerId: 6 }); await flush();
      app.emit('chat:open'); await flush();
      assert.equal(card.classList.contains('is-reading-press'), false, '面板盖住固定卡时同步结束输入归属');
      assert.deepEqual(app.pinInteractions.map(item => item.phase), ['down', 'up', 'down', 'up']);
    }
    app.api.close();
  }
});

test('桌面取消固定保留离场图层到动画结束，输入区域立即撤销', async () => {
  for (const revealed of [false, true]) {
    const app = fixture(undefined, { manualFrames: true }), data = workspace('A'); data.graphs[0].nodes[0].pinned = true;
    const opening = app.api.open({ workspaceId: 'A' }); await app.resolve(0, data); await opening; app.api.close(); await flush();
    const root = app.document.querySelector('#rabbit-graph-root'), holder = app.document.querySelector('.rg-pin'), card = holder.querySelector('.rg-card');
    if (revealed) holder.classList.add('is-revealed');
    app.holdAnimations();
    app.mutateWith(mutation => { if (mutation.type === 'pin') { data.revision++; data.graphs[0].nodes[0].pinned = mutation.pinned; } return data; });
    const unpin = card.querySelector('[aria-label="取消固定"]'); app.click(unpin); await flush();
    const departure = app.animations.filter(item => item.element === holder).at(-1)!;
    assert.equal(departure.options.duration, 180); assert.equal(departure.keyframes.at(-1).opacity, 0);
    assert.equal(holder.isConnected, true); assert.equal(holder.inert, true); assert.equal(unpin.disabled, true);
    assert.equal(root.classList.contains('has-pins'), true); assert.deepEqual(app.pinRegions.at(-1).rects, []);
    const requestCount = app.requests.length;
    app.click(card.querySelector('.rg-title')); app.pointer(card, 'pointerdown'); app.emit('desktop:cursor', { x: 300, y: 10 }); await flush();
    assert.equal(app.requests.length, requestCount); assert.equal(app.activations.length, 0); assert.equal(app.pinInteractions.length, 0);
    assert.equal(holder.classList.contains('is-revealed'), revealed, '离场时保持原展开状态，不再触发悬停收放');
    departure.pending.resolve(); await flush();
    assert.equal(holder.isConnected, false); assert.equal(root.classList.contains('has-pins'), false); assert.deepEqual(app.pinRegions.at(-1), {rects:[]});
  }
});

test('离场中快速重新固定复用原牌面，旧动画收尾不删除新固定且多卡占位稳定', async () => {
  const app = fixture(undefined, { manualFrames: true }), data = workspace('A'), original = data.graphs[0].nodes[0]; original.pinned = true;
  data.graphs[0].nodes.push({ ...structuredClone(original), id: 'second', parentId: 'root', kind: 'card' });
  const opening = app.api.open({ workspaceId: 'A' }); await app.resolve(0, data); await opening; app.api.close(); await flush();
  const holders = app.document.querySelectorAll('.rg-pin'), first = holders[0], second = holders[1]; app.holdAnimations();
  let current = structuredClone(data); current.revision++; current.graphs[0].nodes[0].pinned = false; app.changed(current); await flush();
  const departure = app.animations.filter(item => item.element === first).at(-1)!;
  assert.deepEqual(app.document.querySelector('.rg-pins').children, holders, '离场期间仍占据原位置，不提前挤动后面的卡片');
  current = structuredClone(current); current.revision++; current.graphs[0].nodes[0].pinned = true; app.changed(current); await flush();
  assert.equal(departure.cancelled, true); assert.equal(first.inert, false); assert.equal(first.querySelector('.rg-unpin').disabled, false);
  assert.deepEqual(app.document.querySelector('.rg-pins').children, holders, '重新固定不创建重复或跳到列表末尾');
  departure.pending.resolve(); await flush(); assert.equal(first.isConnected, true);
  current = structuredClone(current); current.revision++; current.graphs[0].nodes[0].pinned = false; app.changed(current); await flush();
  app.animations.filter(item => item.element === first).at(-1)!.pending.resolve(); await flush();
  assert.deepEqual(app.document.querySelector('.rg-pins').children, [second]); assert.equal(second.inert, false);
  assert.equal(app.document.querySelector('#rabbit-graph-root').classList.contains('has-pins'), true);
});

test('取消固定离场遇到停用插件、其他面板或工作区切换即清理，不遗留旧动画卡片', async () => {
  for (const reason of ['disabled', 'panel', 'workspace']) {
    const app = fixture(undefined, { manualFrames: true }), data = workspace('A'); data.graphs[0].nodes[0].pinned = true;
    const opening = app.api.open({ workspaceId: 'A' }); await app.resolve(0, data); await opening; app.api.close(); await flush();
    const holder = app.document.querySelector('.rg-pin'); app.holdAnimations();
    const unpinned = structuredClone(data); unpinned.revision++; unpinned.graphs[0].nodes[0].pinned = false; app.changed(unpinned); await flush();
    const departure = app.animations.filter(item => item.element === holder).at(-1)!;
    if (reason === 'disabled') app.emit('settings:saved', { settings: { graphPluginEnabled: false } });
    else if (reason === 'panel') app.emit('chat:open');
    else { const next = app.api.open({ workspaceId: 'B' }); await app.resolve(1, workspace('B')); await next; }
    assert.equal(holder.isConnected, false); assert.equal(departure.cancelled, true);
    departure.pending.resolve(); await flush();
    assert.equal(app.document.querySelector('.rg-pin'), null); assert.deepEqual(app.pinRegions.at(-1).rects, []);
  }
});
