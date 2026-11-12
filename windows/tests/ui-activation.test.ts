import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import { DEFAULT_PROMPTS } from '../electron/prompts.ts';
import * as shortcut from '../electron/shortcut.ts';
import { GraphStore } from '../electron/graph-store.ts';

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

// 只替换浏览器边界；被测行为始终执行完整组件源码。
function browser(reducedMotion = false) {
  let now = 0, serial = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const frames = new Map<number, () => void>();
  const resizeListeners: Array<() => void> = [];
  const events: any[] = [], listeners = new Map<string, Array<(event: any) => void>>();
  let document: any;
  class Element {
    tagName: string; children: Element[] = []; parentElement: Element | null = null;
    attributes: Record<string, string> = {}; dataset: Record<string, string> = {};
    style: any = { setProperty(name: string, value: string) { this[name] = value; } };
    classes = new Set<string>(); handlers = new Map<string, Array<(event: any) => void>>();
    inert = false; value = ''; textContent = ''; id = ''; disabled = false;
    clientWidth = 1200; clientHeight = 800; clientLeft = 1; scrollHeight = 0; scrollTop = 0;
    constructor(tag: string) { this.tagName = tag.toUpperCase(); }
    get className() { return [...this.classes].join(' '); }
    set className(value: string) { this.classes = new Set(value.split(/\s+/).filter(Boolean)); }
    classList = {
      add: (...values: string[]) => values.forEach(value => this.classes.add(value)),
      remove: (...values: string[]) => values.forEach(value => this.classes.delete(value)),
      contains: (value: string) => this.classes.has(value),
      toggle: (value: string, force = !this.classes.has(value)) => { if (force) this.classes.add(value); else this.classes.delete(value); },
    };
    setAttribute(name: string, value: string) {
      this.attributes[name] = value;
      if (name === 'id') this.id = value;
      if (name === 'class') this.className = value;
      if (name === 'inert') this.inert = true;
      if (name.startsWith('data-')) this.dataset[name.slice(5)] = value;
    }
    removeAttribute(name: string) { delete this.attributes[name]; }
    appendChild(child: Element) { child.parentElement = this; this.children.push(child); return child; }
    append(...children: Element[]) { children.forEach(child => this.appendChild(child)); }
    prepend(child: Element) { child.parentElement = this; this.children.unshift(child); }
    replaceChildren(...children: Element[]) { this.children = []; this.append(...children); }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; }
    contains(child: Element): boolean { return child === this || this.children.some(node => node.contains(child)); }
    get isConnected() { return document.body.contains(this); }
    get offsetLeft() { return this.classes.has('chat-input') ? 50 : 0; }
    get offsetTop() { return 10; }
    get offsetWidth() { return this.classes.has('chat-send') ? 32 : 180; }
    get offsetHeight() { return this.tagName === 'FORM' ? 55 : this.tagName === 'INPUT' ? 34 : 56; }
    getBoundingClientRect() { return { left: 0, top: 0, width: this.id === 'pet' ? 92.25 : this.clientWidth, height: this.clientHeight }; }
    querySelectorAll(selector: string): Element[] {
      const matches = (node: Element) => selector.split(',').some(part => part.startsWith('.') ? node.classes.has(part.slice(1)) : part.startsWith('#') ? node.id === part.slice(1) : node.tagName.toLowerCase() === part);
      return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
    }
    querySelector(selector: string) { return this.querySelectorAll(selector)[0] || null; }
    set innerHTML(markup: string) {
      this.children = [];
      const stack: Element[] = [this];
      for (const match of markup.matchAll(/<\/?([a-z][\w-]*)([^>]*)>/gi)) {
        if (match[0].startsWith('</')) { if (stack.length > 1) stack.pop(); continue; }
        const node = new Element(match[1]);
        for (const attr of match[2].matchAll(/([\w:-]+)(?:="([^"]*)")?/g)) node.setAttribute(attr[1], attr[2] || '');
        stack.at(-1)!.appendChild(node);
        if (!match[0].endsWith('/>') && !['input', 'img', 'br'].includes(match[1])) stack.push(node);
      }
    }
    addEventListener(type: string, listener: (event: any) => void) { if (!this.handlers.has(type)) this.handlers.set(type, []); this.handlers.get(type)!.push(listener); }
    focus() { for (let node: Element | null = this; node; node = node.parentElement) if (node.inert) return; document.activeElement = this; }
    blur() { if (document.activeElement === this) document.activeElement = document.body; }
    hasPointerCapture() { return false; }
    setPointerCapture() {}
    releasePointerCapture() {}
    getAnimations() { return []; }
    getContext() { return { putImageData: (image: unknown) => { (this as any).imageData = image; } }; }
    animate() { return { finished: Promise.resolve(), cancel() {} }; }
  }
  const head = new Element('head'), body = new Element('body'), scene = new Element('div'), pet = new Element('div');
  scene.id = 'scene'; pet.id = 'pet'; scene.appendChild(pet); body.appendChild(scene);
  document = {
    head, body, documentElement: body, activeElement: body,
    createElement: (tag: string) => new Element(tag),
    getElementById: (id: string) => body.id === id ? body : body.querySelector('#' + id),
    querySelector: (selector: string) => body.querySelector(selector),
    querySelectorAll: (selector: string) => body.querySelectorAll(selector),
    addEventListener(type: string, listener: (event: any) => void) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type)!.push(listener); },
    dispatchEvent(event: any) { events.push(event); for (const listener of listeners.get(event.type) || []) { listener(event); if (event.stopped) break; } },
  };
  const windowListeners = new Map<string, Array<(event: any) => void>>(), storage = new Map<string, string>();
  const window: any = { addEventListener(type: string, listener: (event: any) => void) { if (!windowListeners.has(type)) windowListeners.set(type, []); windowListeners.get(type)!.push(listener); } };
  const context = vm.createContext({
    window, document, innerWidth: 1200, innerHeight: 800, crypto: { randomUUID }, AbortController, DOMException, structuredClone,
    ImageData: class {
      data: Uint8ClampedArray; width: number; height: number;
      constructor(data: Uint8ClampedArray, width: number, height: number) { this.data = data; this.width = width; this.height = height; }
    },
    FileReader: class {
      result = ''; onload?: () => void;
      readAsDataURL(file: { dataUrl: string }) { this.result = file.dataUrl; this.onload?.(); }
    },
    performance: { now: () => now }, matchMedia: () => ({ matches: reducedMotion }),
    getComputedStyle: () => ({ columnGap: '8', paddingRight: '10', getPropertyValue: (name: string) => name === '--rb-accent' ? ' #8844cc ' : '' }),
    ResizeObserver: class { constructor(listener: () => void) { resizeListeners.push(listener); } observe() {} },
    CustomEvent: class { type: string; detail: unknown; constructor(type: string, options: any) { this.type = type; this.detail = options.detail; } },
    requestAnimationFrame: (run: () => void) => { frames.set(++serial, run); return serial; }, cancelAnimationFrame: (id: number) => frames.delete(id),
    setTimeout: (run: () => void, delay: number) => { timers.set(++serial, { at: now + delay, run }); return serial; }, clearTimeout: (id: number) => timers.delete(id),
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
  });
  window.RabbitShortcut = shortcut;
  window.RabbitPromptDefaults = DEFAULT_PROMPTS;
  vm.runInContext(readFileSync(new URL('../prototype/prompts.js', import.meta.url), 'utf8'), context, { filename: 'prompts.js' });
  return {
    window, document, events,
    resize() { resizeListeners.forEach(listener => listener()); },
    load(name: string) { vm.runInContext(readFileSync(new URL('../prototype/' + name, import.meta.url), 'utf8'), context, { filename: name }); },
    emit(type: string, detail: any = {}) { const event = { type, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...detail }; document.dispatchEvent(event); return event; },
    bubble(target: Element, type: string, detail: any = {}) {
      const event: any = { type, target, defaultPrevented: false, stopped: false,
        preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, stopImmediatePropagation() { this.stopped = true; this.immediate = true; }, ...detail };
      for (let node: Element | null = target; node; node = node.parentElement) {
        for (const listener of node.handlers.get(type) ?? []) { listener(event); if (event.immediate) break; }
        if (event.stopped) break;
      }
      if (!event.stopped) document.dispatchEvent(event);
      return event;
    },
    emitWindow(type: string) { for (const listener of windowListeners.get(type) || []) listener({ type }); },
    tick(ms: number) { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.run(); } },
  };
}

function chat() {
  const page = browser(), flights: ReturnType<typeof deferred>[] = [], focuses: number[] = [];
  page.window.RabbitBallDemo = {
    getSnapshot: () => ({ cursor: { x: 300, y: 300, inside: true }, position: { x: 100, y: 120 } }),
    approach: () => { const flight = deferred(); flights.push(flight); return flight.promise; },
    cancelApproach: () => flights.forEach(flight => flight.resolve()),
  };
  page.window.RabbitAssistant = { captureContext: async () => null, focusInput: async (id: number) => { focuses.push(id); return false; } };
  page.load('chat-ui.js');
  return { ...page, flights, focuses, api: page.window.RabbitChat };
}

test('设置随兔球整体拖动，限制组合边界，松手与缩窗后保留布局', async () => {
  const page = browser(); page.load('settings-ui.js');
  const api = page.window.RabbitSettings, scene = page.document.querySelector('#scene');
  const root = page.document.querySelector('#rabbit-settings-root'), panel = root.querySelector('.rs-panel');
  scene.getBoundingClientRect = () => ({ x: 0, y: 0, width: scene.clientWidth, height: scene.clientHeight });
  // 用浏览器边界模拟居中排版和 CSS translate，执行完整设置组件。
  panel.getBoundingClientRect = () => {
    const [dx, dy] = (panel.style.translate || '0px 0px').split(' ').map(parseFloat);
    const width = Math.min(360, scene.clientWidth - 32), height = Math.min(500, scene.clientHeight - 32);
    return { x: (scene.clientWidth - width) / 2 + dx, y: (scene.clientHeight - height) / 2 + dy, width, height };
  };
  await api.open();
  const latest = () => page.events.filter(event => event.type === 'settings:layout').at(-1).detail;
  assert.equal(latest().petPosition, null);
  assert.equal(panel.getBoundingClientRect().x, 420);
  assert.equal(scene.classList.contains('is-settings-open'), true);
  api.beginPetDrag({ x: 200, y: 415 });
  const moved = api.movePetDrag({ x: 260, y: 455 });
  assert.equal(moved.x, 260); assert.equal(moved.y, 455);
  assert.equal(latest().bounds.x, 480); assert.equal(latest().bounds.y, 190);
  assert.equal(root.classList.contains('is-pet-dragging'), true);
  api.endPetDrag(); page.resize();
  assert.equal(latest().bounds.x, 480); assert.equal(latest().petPosition.x, 260);
  assert.equal(root.classList.contains('is-pet-dragging'), false);
  const checkVisible = () => {
    const { bounds, petPosition } = latest();
    assert.ok(bounds.x >= -1e-8 && bounds.y >= -1e-8);
    assert.ok(bounds.x + bounds.width <= scene.clientWidth + 1e-8);
    assert.ok(bounds.y + bounds.height <= scene.clientHeight + 1e-8);
    assert.ok(petPosition.x >= 92.25 * .43 - 1e-8);
    assert.ok(petPosition.x <= scene.clientWidth - 92.25 * .43 + 1e-8);
    assert.ok(petPosition.y >= 20 + 92.25 * .48 - 1e-8);
    assert.ok(petPosition.y <= scene.clientHeight - 24 - 92.25 * .41 + 1e-8);
  };
  api.beginPetDrag(moved);
  for (const position of [{ x: -9999, y: -9999 }, { x: 9999, y: 9999 }]) {
    const actual = api.movePetDrag(position);
    assert.equal(actual.x, latest().petPosition.x); assert.equal(actual.y, latest().petPosition.y);
    checkVisible();
  }
  api.endPetDrag(); scene.clientWidth = 390; scene.clientHeight = 480; page.resize(); checkVisible();
  api.close(); assert.equal(scene.classList.contains('is-settings-open'), false);
  await api.open(); assert.equal(latest().petPosition, null);
  assert.equal(panel.getBoundingClientRect().x, 16);
});

test('激活即开框与聚焦，光效固定在激活鼠标坐标，不等待飞行到位', async () => {
  for (const origin of [undefined, { x: 640, y: 360 }, { x: 1180, y: 20 }]) {
    const page = chat();
    page.load('activation-effect.js');
    const activation = page.api.activate({ id: 'one', images: [], focusBounds: { x: 40, y: 70, width: 1100, height: 650 } }, { activationId: 10, anchor: origin });
    assert.equal(page.api.getSnapshot().open, true);
    const root = page.document.querySelector('#rabbit-chat-root'), input = root.querySelector('.chat-input');
    assert.equal(root.classList.contains('is-open'), true);
    assert.equal(root.querySelector('.chat-shell').inert, false);
    assert.equal(root.querySelector('.chat-panel').inert, false);
    page.document.activeElement = page.document.body; input.focus();
    assert.equal(page.document.activeElement, input);
    assert.deepEqual(page.focuses, [10]);
    const light = page.document.querySelector('.rabbit-activation-light');
    assert.ok(light);
    assert.equal(light.style.width, light.style.height);
    assert.equal(parseFloat(light.style.left) + parseFloat(light.style.width) / 2, (origin?.x ?? 300) - 40);
    assert.equal(parseFloat(light.style.top) + parseFloat(light.style.height) / 2, (origin?.y ?? 300) - 70);
    assert.equal(page.events.filter(event => event.type === 'chat:close').length, 0);
    await activation;
  }
});

test('桌面开框转发光效原点与激活轮次，主页面不再绘制被shape裁剪的光层', async () => {
  const page = chat(), requests: unknown[] = [];
  page.window.rabbitDesktop = { playActivationEffect: (origin: unknown, activationId: number, color: string) => requests.push({ origin, activationId, color }) };
  page.load('activation-effect.js');
  const origin = { x: 640, y: 360 };
  await page.api.activate({ id: 'one', images: [], focusBounds: { x: 40, y: 70, width: 1100, height: 650 } }, { activationId: 17, anchor: origin });
  assert.deepEqual(JSON.parse(JSON.stringify(requests)), [{ origin, activationId: 17, color: '#8844cc' }]);
  assert.equal(page.document.querySelector('.rabbit-activation-window'), null);
  assert.equal(page.events.find(event => event.type === 'chat:open').detail.activationId, 17);
  assert.equal(page.api.getSnapshot().open, true);
});

test('独立光效播放器沿用几何和动画，完成或清理后移除图层并结束Promise', async () => {
  for (const reduced of [false, true]) {
    const page = browser(reduced), animations: Array<{ frames: any[]; options: any; done: ReturnType<typeof deferred>; cancelled: boolean }> = [];
    const createElement = page.document.createElement;
    page.document.createElement = (tag: string) => {
      const element = createElement(tag);
      element.animate = (frames: any[], options: any) => {
        const animation = { frames, options, done: deferred(), cancelled: false }; animations.push(animation);
        return { finished: animation.done.promise, cancel() { animation.cancelled = true; animation.done.resolve(); } };
      };
      return element;
    };
    page.load('activation-effect.js');
    const player = page.window.RabbitActivationEffect, origin = { x: 360, y: 240 }, focusBounds = { x: 40, y: 70, width: 1100, height: 650 };
    let completed = false;
    const first = player.play({ origin, focusBounds, color: '#8844cc' }).then(() => { completed = true; });
    const container = page.document.querySelector('.rabbit-activation-window'), light = page.document.querySelector('.rabbit-activation-light');
    assert.equal(container.style.left, '40px'); assert.equal(container.style.top, '70px'); assert.equal(container.style.width, '1100px'); assert.equal(container.style.height, '650px');
    assert.equal(container.style['--rb-accent'], '#8844cc'); assert.equal(container.dataset.preview, 'false');
    assert.equal(parseFloat(light.style.left) + parseFloat(light.style.width) / 2, origin.x - focusBounds.x);
    assert.equal(parseFloat(light.style.top) + parseFloat(light.style.height) / 2, origin.y - focusBounds.y);
    assert.equal(animations[0].options.duration, reduced ? 920 : 2100);
    assert.equal(animations[0].options.easing, 'cubic-bezier(.18,.7,.28,1)');
    if (reduced) assert.equal(animations[0].frames[1].opacity, .5);
    else assert.equal(animations[0].frames[2].transform, 'scale(1.03)');
    await Promise.resolve(); assert.equal(completed, false);
    const second = player.play({ origin, focusBounds });
    await first;
    assert.equal(animations[0].cancelled, true); assert.equal(page.document.querySelectorAll('.rabbit-activation-window').length, 1);
    animations[1].done.resolve(); await second;
    assert.equal(page.document.querySelector('.rabbit-activation-window'), null);
    const third = player.play({ origin, focusBounds }); player.clear(); await third;
    assert.equal(animations[2].cancelled, true); assert.equal(page.document.querySelector('.rabbit-activation-window'), null);
  }
});

test('实际聊天模块的聚焦异常不撤销输入，旧聚焦完成也不重开已关闭界面', async () => {
  const page = chat(), ack = deferred<boolean>();
  page.window.RabbitAssistant.focusInput = () => ack.promise;
  const activation = page.api.activate({ id: 'one', images: [] }, { activationId: 10 });
  assert.equal(page.api.getSnapshot().open, true);
  page.emit('keydown', { key: 'Escape' }); ack.resolve(true); await activation;
  assert.equal(page.api.getSnapshot().open, false);
  assert.equal(page.events.find(event => event.type === 'chat:close').detail.activationId, 10);

  page.window.RabbitAssistant.focusInput = async () => { throw new Error('IPC unavailable'); };
  const next = page.api.activate({ id: 'two', images: [] }, { activationId: 11 });
  await next;
  assert.equal(page.api.getSnapshot().open, true);
});

test('实际聊天模块取消飞行后，旧聚焦回执不干扰新一轮输入', async () => {
  const page = chat(), ack = deferred<boolean>();
  page.window.RabbitAssistant.focusInput = async (id: number) => { page.focuses.push(id); return id === 10 ? ack.promise : false; };
  const old = page.api.activate({ id: 'one', images: [] }, { activationId: 10 });
  page.api.close();
  const next = page.api.activate({ id: 'two', images: [] }, { activationId: 11 });
  ack.resolve(true); await old; await next;
  assert.deepEqual(page.focuses, [10, 11]); assert.equal(page.api.getSnapshot().open, true);
});

test('实际聊天模块在飞行中外点或全屏暂停时关闭，不会迟到重开', async () => {
  for (const [type, detail] of [['desktop:pointerdown', { x: 0, y: 0 }], ['desktop:suspended', true]] as const) {
    const page = chat(), activation = page.api.activate({ id: 'one', images: [] }, { activationId: 10 });
    page.emit(type, { detail }); await activation;
    assert.equal(page.api.getSnapshot().opening, false);
    assert.equal(page.api.getSnapshot().open, false);
    assert.deepEqual(page.focuses, [10]);
    assert.equal(page.events.find(event => event.type === 'chat:close').detail.activationId, 10);
  }
});

test('实际截图模块499ms只取默认图，500ms才进入连续截图，Esc不误激活', async () => {
  for (const duration of [499, 500]) {
    const page = browser(), activated: unknown[] = [];
    page.window.RabbitAssistant = {
      demoCaptureStart: () => ({ sessionId: 'one', context: { images: [] }, backgroundImageDataUrl: 'demo' }),
      demoCaptureEnd: async () => ({ id: 'one', images: [] }), demoCaptureCancel() {},
    };
    page.window.RabbitChat = { activate: async (context: unknown) => activated.push(context), getSnapshot: () => ({ open: false }) };
    page.load('capture-ui.js');
    page.emit('keydown', { code: 'AltLeft', key: 'Alt' }); page.tick(duration);
    assert.equal(page.document.querySelector('#rabbit-capture-root').classList.contains('is-active'), duration === 500);
    page.emit('keyup', { code: 'AltLeft', key: 'Alt' }); await flush();
    assert.equal(activated.length, 1);
    assert.equal(page.events.filter(event => event.type === 'selection:open').length, duration === 500 ? 1 : 0);

    page.emit('keydown', { code: 'AltLeft', key: 'Alt' }); page.tick(duration);
    page.emit('keydown', { code: 'Escape', key: 'Escape' });
    page.emit('keyup', { code: 'AltLeft', key: 'Alt' }); await flush();
    assert.equal(activated.length, 1);
  }
});

function graphCaptureDemo(graphModeEnabled = true) {
  const page = browser(), activations: any[] = [], chats: any[] = [], captured: any[] = [];
  const settings = { graphPluginEnabled: true, graphModeEnabled, activationShortcut: ['AltLeft'] };
  let open = false, workspaceId: string | null = null, ended = 0, cancelled = 0, regions: any[] = [];
  const image = { id: 'default', title: '演示窗口', imageDataUrl: 'data:image/png;base64,AA==' };
  page.window.RabbitSettings = { ready: Promise.resolve(), getSnapshot: () => ({ settings }) };
  page.window.RabbitAssistant = {
    demoCaptureStart: () => { regions = []; return { sessionId: randomUUID(), context: { images: [image], demo: true }, backgroundImageDataUrl: 'frozen-demo-desktop' }; },
    demoCaptureRegion: async (rect: any) => {
      regions.push({ ...image, id: 'region-' + regions.length, imageDataUrl: 'data:image/png;base64,' + regions.length, rect });
      return { context: { images: [...regions], demo: true }, rect };
    },
    demoCaptureEnd: async () => { ended++; const context = { id: randomUUID(), title: '演示窗口', images: regions.length ? [...regions] : [image], demo: true }; captured.push(context); return context; },
    demoCaptureCancel: () => { cancelled++; },
  };
  page.window.RabbitChat = { activate: async (context: any) => chats.push(context), getSnapshot: () => ({ open: false }) };
  page.window.RabbitGraph = {
    getSnapshot: () => ({ workspaceId }), isOpen: () => open, close: () => { open = false; },
    open: async (activation: any) => { open = true; workspaceId = activation.workspaceId; activations.push(activation); },
  };
  page.load('graph-demo.js'); page.load('capture-ui.js');
  return { ...page, settings, activations, chats, captured, counts: () => ({ ended, cancelled }),
    press(duration = 0) { page.emit('keydown', { code: 'AltLeft', key: 'Alt' }); page.tick(duration); },
    release() { page.emit('keyup', { code: 'AltLeft', key: 'Alt' }); },
    region(x: number, y: number, width: number, height: number) {
      const root = page.document.querySelector('#rabbit-capture-root');
      root.handlers.get('pointerdown')[0]({ button: 0, pointerId: 1, clientX: x, clientY: y, preventDefault() {} });
      root.handlers.get('pointerup')[0]({ pointerId: 1, clientX: x + width, clientY: y + height });
    },
  };
}

test('浏览器大爆炸短按首次建图，再按退出，重新进入复用最近图且不重复取图', async () => {
  const page = graphCaptureDemo();
  page.press(499); page.release(); await flush();
  assert.equal(page.chats.length, 0); assert.equal(page.activations.length, 1);
  const initial = await page.window.RabbitGraphDemo.graphOpen();
  assert.equal(initial.graphs.length, 1); assert.equal(page.counts().ended, 1);
  assert.equal(initial.graphs[0].nodes.length, 1, '首次截图不会自动生成解释卡片');
  assert.equal(initial.graphs[0].nodes[0].images[0].imageDataUrl, page.captured[0].images[0].imageDataUrl);
  assert.equal(page.activations[0].backgroundImageDataUrl, 'frozen-demo-desktop');
  page.press(600); page.release(); await flush();
  assert.equal(page.window.RabbitGraph.isOpen(), false);
  assert.equal(page.window.RabbitCapture.getSnapshot().active, false);
  assert.equal(page.activations.length, 1);
  page.press(); page.release(); await flush();
  assert.equal(page.activations.length, 2); assert.equal(page.counts().ended, 1); assert.equal(page.counts().cancelled, 1);
  const reopened = await page.window.RabbitGraphDemo.graphOpen();
  assert.equal(reopened.graphs.length, 1); assert.equal(reopened.lastGraphId, initial.lastGraphId);
});

test('浏览器大爆炸长按把多个实际选区写入同一新图，关闭插件后保留普通提问', async () => {
  const page = graphCaptureDemo();
  page.press(500);
  assert.match(page.document.querySelector('.capture-status-title').textContent, /松开进入图谱/);
  page.region(10, 20, 100, 80); page.region(250, 200, 150, 90);
  page.release(); await flush();
  const workspace = await page.window.RabbitGraphDemo.graphOpen();
  assert.equal(workspace.graphs.length, 1);
  const images = workspace.graphs[0].nodes[0].images;
  assert.equal(images.length, 2);
  assert.deepEqual(Array.from(images, (image: any) => image.imageDataUrl), page.captured[0].images.map((image: any) => image.imageDataUrl));
  assert.deepEqual(Array.from(images, (image: any) => image.rect), [{ x: 10, y: 20, width: 100, height: 80 }, { x: 250, y: 200, width: 150, height: 90 }]);
  assert.equal(page.chats.length, 0);
  page.press(); page.release(); await flush();
  page.press(500); page.region(40, 50, 120, 100); page.release(); await flush();
  const next = await page.window.RabbitGraphDemo.graphOpen();
  assert.equal(next.graphs.length, 2); assert.equal(next.graphs[0].id, workspace.graphs[0].id);
  assert.equal(next.graphs[1].nodes.length, 1); assert.equal(next.graphs[1].nodes[0].images.length, 1);
  page.press(); page.release(); await flush();
  page.settings.graphPluginEnabled = false;
  page.press(); page.release(); await flush();
  assert.equal(page.chats.length, 1); assert.equal(page.activations.length, 2);
});

test('浏览器开启大爆炸立即填当前空图，重复保存或恢复非空图不追加截图', async () => {
  const page = graphCaptureDemo(false), bridge = page.window.RabbitGraphDemo;
  const workspace = await bridge.graphOpen();
  const created = await bridge.graphMutate(workspace.id, { type: 'create-graph', title: '预建图谱' });
  const empty = created.graphs[0];
  assert.equal(empty.nodes.length, 0); assert.equal(page.counts().ended, 0);
  page.settings.graphModeEnabled = true;
  page.emit('settings:saved', { detail: { settings: page.settings } }); await flush();
  const filled = await bridge.graphOpen();
  assert.equal(page.activations.length, 1); assert.equal(filled.graphs.length, 1);
  assert.equal(filled.graphs[0].id, empty.id); assert.equal(filled.graphs[0].nodes[0].id, empty.rootId);
  assert.equal(filled.graphs[0].nodes.length, 1); assert.equal(page.counts().ended, 1);
  page.emit('settings:saved', { detail: { settings: page.settings } }); await flush();
  assert.equal(page.activations.length, 1);
  page.settings.graphModeEnabled = false; page.window.RabbitGraph.close();
  page.emit('settings:saved', { detail: { settings: page.settings } });
  page.settings.graphModeEnabled = true; page.emit('settings:saved', { detail: { settings: page.settings } }); await flush();
  assert.equal(page.activations.length, 2); assert.equal(page.counts().ended, 1);
});

test('浏览器图谱批注截图松开鼠标返回实际区域，取消不打开图谱或普通聊天', async () => {
  const page = graphCaptureDemo(); page.press(); page.release(); await flush();
  const workspace = await page.window.RabbitGraphDemo.graphOpen(), graph = workspace.graphs[0];
  const request = { workspaceId: workspace.id, graphId: graph.id, nodeId: graph.rootId };
  const result = page.window.RabbitGraphDemo.graphCaptureImages(request);
  assert.match(page.document.querySelector('.capture-status-title').textContent, /松开鼠标完成/);
  page.region(45, 55, 220, 130);
  const images = await result;
  assert.equal(images.length, 1); assert.deepEqual(JSON.parse(JSON.stringify(images[0].rect)), { x: 45, y: 55, width: 220, height: 130 });
  assert.equal(page.activations.length, 1); assert.equal(page.chats.length, 0);
  assert.equal(page.window.RabbitGraph.isOpen(), true);
  const cancelled = page.window.RabbitGraphDemo.graphCaptureImages(request);
  page.emit('keydown', { code: 'Escape', key: 'Escape' });
  assert.equal(await cancelled, null);
  assert.equal(page.activations.length, 1); assert.equal(page.window.RabbitGraph.isOpen(), true);
  assert.equal((await page.window.RabbitGraphDemo.graphOpen()).graphs[0].nodes.length, 1);
});

test('浏览器大爆炸取消长按或等待读取时退出，均不生成图或迟到重开', async () => {
  const page = graphCaptureDemo();
  page.press(500); page.region(20, 20, 100, 70);
  page.emit('keydown', { code: 'Escape', key: 'Escape' }); page.release(); await flush();
  assert.equal((await page.window.RabbitGraphDemo.graphOpen()).graphs.length, 0);
  assert.equal(page.activations.length, 0); assert.equal(page.counts().ended, 0);
  const pending = deferred<any>(), bridge = page.window.RabbitGraphDemo;
  page.window.RabbitGraphDemo = { ...bridge, graphOpen: () => pending.promise };
  page.press(); page.release(); await flush();
  page.emitWindow('blur');
  pending.resolve(await bridge.graphOpen()); await flush();
  assert.equal(page.activations.length, 0); assert.equal(page.counts().ended, 0);
  assert.equal((await bridge.graphOpen()).graphs.length, 0);
});

test('原生截图直接绘制 BGRA 像素，结束释放画布且后续演示仍显示图片', () => {
  const page = browser();
  page.window.rabbitDesktop = { cancelCapture() {} };
  page.load('capture-ui.js');
  const original = new Uint8Array([0, 0, 255, 255, 255, 0, 0, 255]);
  const pixels = structuredClone(original);
  page.window.RabbitCapture.handleEvent({ type: 'start', sessionId: 'native', context: { images: [] }, backgroundBitmap: { data: pixels, width: 2, height: 1 } });
  const root = page.document.querySelector('#rabbit-capture-root'), canvas = root.querySelector('canvas'), image = root.querySelector('img');
  assert.equal(canvas.hidden, false);
  assert.equal(image.hidden, true);
  assert.equal(canvas.width, 2);
  assert.equal(canvas.height, 1);
  assert.deepEqual([...canvas.imageData.data], [255, 0, 0, 255, 0, 0, 255, 255]);
  assert.deepEqual([...original], [0, 0, 255, 255, 255, 0, 0, 255], '跨进程副本的转换不影响原始截图');
  page.window.RabbitCapture.handleEvent({ type: 'end', sessionId: 'native' });
  assert.equal(canvas.width, 0);
  assert.equal(canvas.height, 0);
  page.window.RabbitCapture.handleEvent({ type: 'start', sessionId: 'demo', context: { demo: true, images: [] }, backgroundImageDataUrl: 'demo-image' });
  assert.equal(canvas.hidden, true);
  assert.equal(image.hidden, false);
  assert.equal(image.src, 'demo-image');
});

test('原生图谱与批注截图使用对应完成提示，Esc取消不会进入普通提问', () => {
  const page = browser(); let cancelled = 0;
  page.window.rabbitDesktop = { cancelCapture: () => cancelled++ }; page.load('capture-ui.js');
  for (const purpose of ['graph', 'images']) {
    page.window.RabbitCapture.handleEvent({ type: 'start', sessionId: purpose, purpose, context: { images: [] }, backgroundImageDataUrl: 'desktop' });
    const title = page.document.querySelector('.capture-status-title').textContent;
    assert.match(title, purpose === 'images' ? /拖动选择截图 · 松开鼠标完成/ : /松开进入图谱/);
    page.emit('keydown', { key: 'Escape', code: 'Escape' });
    assert.equal(page.window.RabbitCapture.getSnapshot().active, false);
  }
  assert.equal(cancelled, 2);
});

test('浏览器右 Alt 配置可消费 AltGr 序列，未选右 Alt 时保留文字输入', async () => {
  for (const codes of [['AltRight'], ['AltRight', 'KeyK'], ['AltLeft']]) {
    const page = browser(), activated: unknown[] = [];
    page.window.RabbitSettings = { ready: Promise.resolve(), getSnapshot: () => ({ settings: { activationShortcut: codes } }) };
    page.window.RabbitAssistant = {
      demoCaptureStart: () => ({ sessionId: 'one', context: { images: [] }, backgroundImageDataUrl: 'demo' }),
      demoCaptureEnd: async () => ({ id: 'one', images: [] }), demoCaptureCancel() {},
    };
    page.window.RabbitChat = { activate: async (context: unknown) => activated.push(context), getSnapshot: () => ({ open: false }) };
    page.load('capture-ui.js');
    page.emit('keydown', { code: 'ControlLeft', key: 'Control' });
    const rightAlt = page.emit('keydown', { code: 'AltRight', key: 'AltGraph', getModifierState: () => true });
    if (codes.includes('KeyK')) {
      const ordinary = page.emit('keydown', { code: 'KeyK', key: 'k', getModifierState: () => true });
      assert.equal(ordinary.defaultPrevented, true);
      page.emit('keyup', { code: 'KeyK' });
    }
    page.emit('keyup', { code: 'AltRight' }); page.emit('keyup', { code: 'ControlLeft' }); await flush();
    assert.equal(rightAlt.defaultPrevented, codes.includes('AltRight'));
    assert.equal(activated.length, codes.includes('AltRight') ? 1 : 0);
  }
});

test('设置读取期间的关闭取消待展开界面，后续新打开仍正常', async () => {
  const page = browser(), settings = deferred<object>();
  page.window.rabbitDesktop = { loadSettings: () => settings.promise };
  page.load('settings-ui.js');
  const opening = page.window.RabbitSettings.open();
  page.window.RabbitSettings.close();
  settings.resolve({}); await opening;
  assert.equal(page.window.RabbitSettings.getSnapshot().open, false);
  assert.equal(page.events.some(event => event.type === 'settings:open'), false);
  await page.window.RabbitSettings.open();
  assert.equal(page.window.RabbitSettings.getSnapshot().open, true);
  assert.equal(page.events.filter(event => event.type === 'settings:open').length, 1);
});

test('模型选择保留跨页草稿，取消不提交，保存传给桌面设置', async () => {
  const page = browser(), patches: any[] = [];
  let stored = { model: 'deepseek-flash', reasoning: 'medium' };
  page.window.rabbitDesktop = {
    loadSettings: async () => stored,
    saveSettings: async (patch: any) => { patches.push(patch); stored = { ...stored, ...patch }; return stored; },
  };
  page.load('settings-ui.js'); await page.window.RabbitSettings.ready;
  await page.window.RabbitSettings.open();
  const model = page.document.querySelector('#rabbit-model');
  assert.equal(model.value, 'deepseek-flash');
  assert.deepEqual(model.children.map((option: any) => option.value), ['deepseek-flash', 'deepseek-v4-pro']);
  model.value = 'deepseek-v4-pro'; model.handlers.get('input')[0]();
  page.document.querySelector('#rabbit-tab-general').handlers.get('click')[0]();
  page.document.querySelector('#rabbit-tab-model').handlers.get('click')[0]();
  assert.equal(model.value, 'deepseek-v4-pro');
  assert.equal(page.window.RabbitSettings.getSnapshot().settings.model, 'deepseek-flash');
  page.window.RabbitSettings.close();
  await page.window.RabbitSettings.open();
  assert.equal(model.value, 'deepseek-flash');
  model.value = 'deepseek-v4-pro'; model.handlers.get('input')[0]();
  await page.document.querySelector('#rabbit-settings-form').handlers.get('submit')[0]({ preventDefault() {} });
  assert.equal(patches.length, 1);
  assert.equal(patches[0].model, 'deepseek-v4-pro');
  assert.equal(page.window.RabbitSettings.getSnapshot().settings.model, 'deepseek-v4-pro');
  await page.window.RabbitSettings.open();
  assert.equal(model.value, 'deepseek-v4-pro');
});

test('右 Alt 录制忽略 Windows 合成的左 Ctrl，并保留右 Alt 组合', async () => {
  for (const extraKey of [null, 'KeyK']) {
    const page = browser();
    page.load('settings-ui.js'); await page.window.RabbitSettings.ready;
    await page.window.RabbitSettings.open();
    page.document.querySelector('#rabbit-tab-general').handlers.get('click')[0]();
    await page.document.querySelector('#rabbit-activation-shortcut').handlers.get('click')[0]();
    page.emit('keydown', { code: 'ControlLeft', key: 'Control', ctrlKey: true });
    page.emit('keydown', { code: 'AltRight', key: 'AltGraph', ctrlKey: true, altKey: true, getModifierState: () => true });
    if (extraKey) page.emit('keydown', { code: extraKey, key: 'k', ctrlKey: true, altKey: true, getModifierState: () => true });
    page.emit('keyup', { code: extraKey || 'AltRight', getModifierState: () => !!extraKey });
    page.emit('keyup', { code: 'AltRight' }); page.emit('keyup', { code: 'ControlLeft' });
    assert.deepEqual(Array.from(page.window.RabbitSettings.getSnapshot().draft.activationShortcut), extraKey ? ['AltRight', extraKey] : ['AltRight']);
    await page.document.querySelector('#rabbit-settings-form').handlers.get('submit')[0]({ preventDefault() {} });
    assert.deepEqual(Array.from(page.window.RabbitSettings.getSnapshot().settings.activationShortcut), extraKey ? ['AltRight', extraKey] : ['AltRight']);
  }
});

test('启动键录制保留完整组合，保存前仍用原键，保存后立即按新键触发', async () => {
  const page = browser(), activated: unknown[] = [];
  page.window.RabbitAssistant = {
    demoCaptureStart: () => ({ sessionId: 'one', context: { images: [] }, backgroundImageDataUrl: 'demo' }),
    demoCaptureEnd: async () => ({ id: 'one', images: [] }), demoCaptureCancel() {},
  };
  page.window.RabbitChat = { activate: async (context: unknown) => activated.push(context), getSnapshot: () => ({ open: false }) };
  page.load('settings-ui.js'); await page.window.RabbitSettings.ready; page.load('capture-ui.js');
  await page.window.RabbitSettings.open();
  page.document.querySelector('#rabbit-tab-general').handlers.get('click')[0]();
  const recorder = page.document.querySelector('#rabbit-activation-shortcut');
  await recorder.handlers.get('click')[0]();
  page.emit('keydown', { code: 'ControlRight', key: 'Control', ctrlKey: true });
  page.emit('keydown', { code: 'Space', key: ' ', ctrlKey: true });
  page.tick(600);
  page.emit('keyup', { code: 'Space', key: ' ', ctrlKey: true });
  page.emit('keyup', { code: 'ControlRight', key: 'Control' });
  assert.deepEqual(Array.from(page.window.RabbitSettings.getSnapshot().draft.activationShortcut), ['ControlRight', 'Space']);
  assert.equal(page.window.RabbitSettings.getSnapshot().recording, false);
  assert.equal(activated.length, 0);

  page.emit('keydown', { code: 'AltLeft', key: 'Alt' });
  page.emit('keyup', { code: 'AltLeft', key: 'Alt' }); await flush();
  assert.equal(activated.length, 0);
  assert.deepEqual(Array.from(page.window.RabbitSettings.getSnapshot().settings.activationShortcut), ['AltLeft']);
  await page.document.querySelector('#rabbit-settings-form').handlers.get('submit')[0]({ preventDefault() {} });
  for (const code of ['AltLeft', 'ControlLeft']) {
    page.emit('keydown', { code, key: code === 'AltLeft' ? 'Alt' : 'Control' });
    if (code === 'ControlLeft') { page.emit('keydown', { code: 'Space', key: ' ' }); page.emit('keyup', { code: 'Space', key: ' ' }); }
    page.emit('keyup', { code });
  }
  await flush(); assert.equal(activated.length, 0);
  page.emit('keydown', { code: 'ControlRight', key: 'Control', ctrlKey: true }); page.tick(600);
  assert.equal(page.window.RabbitCapture.getSnapshot().active, false);
  page.emit('keydown', { code: 'Space', key: ' ', ctrlKey: true }); page.tick(499);
  assert.equal(page.window.RabbitCapture.getSnapshot().active, false);
  page.tick(1); assert.equal(page.window.RabbitCapture.getSnapshot().active, true);
  assert.ok(page.document.querySelector('.capture-status-title').textContent.includes(shortcut.formatShortcut(['ControlRight', 'Space'])));
  page.emit('keyup', { code: 'Space', key: ' ', ctrlKey: true });
  page.emit('keyup', { code: 'ControlRight', key: 'Control' }); await flush();
  assert.equal(activated.length, 1);
});

test('录制在 Esc、失焦、关闭、切页或直接输入 AltGr 字符时取消，并恢复原生触发', async () => {
  for (const exit of ['escape', 'blur', 'close', 'tab', 'altgraph']) {
    const page = browser(), recording: boolean[] = [];
    page.window.rabbitDesktop = { loadSettings: async () => ({}), setShortcutRecording: async (value: boolean) => { recording.push(value); } };
    page.load('settings-ui.js'); await page.window.RabbitSettings.open();
    page.document.querySelector('#rabbit-tab-general').handlers.get('click')[0]();
    await page.document.querySelector('#rabbit-activation-shortcut').handlers.get('click')[0]();
    page.emit('keydown', { code: 'ControlRight', key: 'Control', ctrlKey: true });
    if (exit === 'escape') page.emit('keydown', { code: 'Escape', key: 'Escape' });
    else if (exit === 'blur') page.emitWindow('blur');
    else if (exit === 'close') page.window.RabbitSettings.close();
    else if (exit === 'tab') page.document.querySelector('#rabbit-tab-model').handlers.get('click')[0]();
    else page.emit('keydown', { code: 'KeyQ', key: '@', getModifierState: (name: string) => name === 'AltGraph' });
    assert.equal(page.window.RabbitSettings.getSnapshot().recording, false, exit);
    assert.deepEqual(Array.from(page.window.RabbitSettings.getSnapshot().draft.activationShortcut), ['AltLeft'], exit);
    assert.deepEqual(recording, [true, false], exit);
  }
});

test('额外按键和鼠标不阻止或取消组合激活，配置成员按任意顺序凑齐即可', async () => {
  for (const duration of [499, 500]) for (const members of [['ControlRight', 'Space'], ['Space', 'ControlRight']]) {
    const page = browser(), activated: unknown[] = [];
    page.window.RabbitSettings = { getSnapshot: () => ({ settings: { activationShortcut: ['ControlRight', 'Space'] } }), ready: Promise.resolve() };
    page.window.RabbitAssistant = {
      demoCaptureStart: () => ({ sessionId: 'one', context: { images: [] }, backgroundImageDataUrl: 'demo' }),
      demoCaptureEnd: async () => ({ id: 'one', images: [] }), demoCaptureCancel() {},
    };
    page.window.RabbitChat = { activate: async (context: unknown) => activated.push(context), getSnapshot: () => ({ open: false }) };
    page.load('capture-ui.js');
    assert.equal(page.emit('keydown', { code: 'ShiftLeft', key: 'Shift' }).defaultPrevented, false);
    assert.equal(page.emit('pointerdown', { button: 2 }).defaultPrevented, false);
    assert.equal(page.emit('keydown', { code: members[0] }).defaultPrevented, true);
    page.tick(600);
    assert.equal(page.window.RabbitCapture.getSnapshot().active, false);
    assert.equal(page.emit('keydown', { code: members[1] }).defaultPrevented, true);
    page.tick(duration);
    assert.equal(page.window.RabbitCapture.getSnapshot().active, duration === 500);
    assert.equal(page.emit('keydown', { code: 'KeyA', key: 'a', ctrlKey: true }).defaultPrevented, false);
    assert.equal(page.emit('pointerup', { button: 2 }).defaultPrevented, false);
    assert.equal(page.emit('pointerdown', { button: 0 }).defaultPrevented, false);
    assert.equal(page.emit('keyup', { code: members[1] }).defaultPrevented, true);
    assert.equal(page.emit('keyup', { code: members[0] }).defaultPrevented, true);
    await flush();
    assert.equal(page.window.RabbitCapture.getSnapshot().active, false);
    assert.equal(activated.length, 1);
    assert.equal(page.emit('keyup', { code: 'KeyA' }).defaultPrevented, false);
    assert.equal(page.emit('keyup', { code: 'ShiftLeft' }).defaultPrevented, false);
  }
});

test('启动键的部分组合、重复按下和取消后抬手均被拦截，全部抬手后可再次激活', async () => {
  const page = browser(), activated: unknown[] = [];
  page.window.RabbitSettings = { getSnapshot: () => ({ settings: { activationShortcut: ['ControlRight', 'Space'] } }), ready: Promise.resolve() };
  page.window.RabbitAssistant = {
    demoCaptureStart: () => ({ sessionId: 'one', context: { images: [] }, backgroundImageDataUrl: 'demo' }),
    demoCaptureEnd: async () => ({ id: 'one', images: [] }), demoCaptureCancel() {},
  };
  page.window.RabbitChat = { activate: async (context: unknown) => activated.push(context), getSnapshot: () => ({ open: false }) };
  page.load('capture-ui.js');
  assert.equal(page.emit('keydown', { code: 'ControlRight' }).defaultPrevented, true);
  assert.equal(page.emit('keydown', { code: 'ControlRight', repeat: true }).defaultPrevented, true);
  assert.equal(page.emit('keyup', { code: 'ControlRight' }).defaultPrevented, true);
  await flush(); assert.equal(activated.length, 0);
  page.emit('keydown', { code: 'ControlRight' }); page.emit('keydown', { code: 'Space' });
  assert.equal(page.emit('keydown', { code: 'Escape', key: 'Escape' }).defaultPrevented, true);
  assert.equal(page.emit('keyup', { code: 'Space' }).defaultPrevented, true);
  assert.equal(page.emit('keydown', { code: 'Space' }).defaultPrevented, true);
  page.tick(600);
  assert.equal(page.window.RabbitCapture.getSnapshot().active, false);
  assert.equal(page.emit('keyup', { code: 'Space' }).defaultPrevented, true);
  assert.equal(page.emit('keyup', { code: 'ControlRight' }).defaultPrevented, true);
  await flush(); assert.equal(activated.length, 0);
  page.emit('keydown', { code: 'KeyA' });
  page.emit('keydown', { code: 'ControlRight' }); page.emit('keydown', { code: 'Space' });
  page.emit('keyup', { code: 'Space' }); page.emit('keyup', { code: 'ControlRight' });
  await flush(); assert.equal(activated.length, 1);
});

test('单字母启动键在设置中正常输入，在聊天中取消激活且长按不进入截图', async () => {
  const page = chat(); let captures = 0;
  Object.assign(page.window.RabbitAssistant, {
    demoCaptureStart: () => { captures++; return { sessionId: 'one', context: { images: [] }, backgroundImageDataUrl: 'demo' }; },
    demoCaptureEnd: async () => ({ id: 'one', images: [] }), demoCaptureCancel() {},
  });
  page.load('settings-ui.js'); await page.window.RabbitSettings.ready; page.load('capture-ui.js');
  await page.window.RabbitSettings.open();
  page.document.querySelector('#rabbit-tab-general').handlers.get('click')[0]();
  await page.document.querySelector('#rabbit-activation-shortcut').handlers.get('click')[0]();
  page.emit('keydown', { code: 'KeyK', key: 'k' }); page.emit('keyup', { code: 'KeyK', key: 'k' });
  await page.document.querySelector('#rabbit-settings-form').handlers.get('submit')[0]({ preventDefault() {} });
  assert.deepEqual(Array.from(page.window.RabbitSettings.getSnapshot().settings.activationShortcut), ['KeyK']);
  await page.window.RabbitSettings.open();
  const settingsKey = page.emit('keydown', { code: 'KeyK', key: 'k' }); page.tick(600);
  page.emit('keyup', { code: 'KeyK', key: 'k' }); await flush();
  assert.equal(settingsKey.defaultPrevented, false); assert.equal(captures, 0);
  page.window.RabbitSettings.close();
  await page.api.activate({ id: 'window', images: [] });
  const chatKey = page.emit('keydown', { code: 'KeyK', key: 'k' }); page.tick(600);
  page.emit('keyup', { code: 'KeyK', key: 'k' }); await flush();
  assert.equal(chatKey.defaultPrevented, true); assert.equal(captures, 0);
  assert.equal(page.api.getSnapshot().open, false);
  assert.equal(page.window.RabbitCapture.getSnapshot().active, false);
});

test('真实聊天快捷动作传空用户文字与意图，填写的问题不混入功能提示词', async () => {
  const page = chat(), sent: Array<{ intent: string; text: string }> = [];
  page.window.RabbitAssistant.send = async (request: { intent: string; text: string }) => { sent.push(request); return { text: '回答。' }; };
  await page.api.activate({ id: 'window', images: [] });
  const shortcuts = page.document.querySelectorAll('.chat-shortcut');
  const input = page.document.querySelector('.chat-input');
  for (const intent of ['search', 'extract', 'translate']) {
    const button = shortcuts.find((element: any) => element.dataset.intent === intent);
    await button.handlers.get('click')[0]();
    assert.equal(sent.at(-1)?.intent, intent);
    assert.equal(sent.at(-1)?.text, '');
  }
  input.value = '这个符号有什么含义？';
  await shortcuts.find((element: any) => element.dataset.intent === 'search').handlers.get('click')[0]();
  assert.equal(sent.at(-1)?.text, '这个符号有什么含义？');
  const count = sent.length;
  await page.document.querySelector('.chat-composer').handlers.get('submit')[0]({ preventDefault() {} });
  await flush();
  assert.equal(sent.length, count);
});

test('空输入Backspace逐张删除最后截图，长按repeat继续每次只删一张', async () => {
  const page = chat();
  await page.api.activate({ id: 'window', images: [
    { id: 'first', title: '截图1', imageDataUrl: 'first-image' },
    { id: 'second', title: '截图2', imageDataUrl: 'second-image' },
  ] });
  const input = page.document.querySelector('.chat-input');
  const press = (repeat: boolean) => {
    const event = { key: 'Backspace', repeat, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    input.handlers.get('keydown')[0](event); return event;
  };
  assert.equal(press(false).defaultPrevented, true);
  assert.deepEqual(Array.from(page.api.getSnapshot().context.imageIds), ['first']);
  assert.equal(page.document.querySelectorAll('.chat-context-chip').length, 1);
  assert.equal(press(true).defaultPrevented, true);
  assert.deepEqual(Array.from(page.api.getSnapshot().context.imageIds), []);
  assert.equal(page.document.querySelectorAll('.chat-context-chip').length, 0);
  assert.equal(press(true).defaultPrevented, false, '没有图片后保留普通按键处理');
});

test('文字、空格、IME和修饰键退格保留图片及正常文字处理', async () => {
  const page = chat();
  await page.api.activate({ id: 'window', images: [{ id: 'one', title: '截图', imageDataUrl: 'image' }] });
  const input = page.document.querySelector('.chat-input');
  for (const options of [
    { value: '正在输入' }, { value: ' ' }, { value: '', isComposing: true },
    { value: '', keyCode: 229 }, { value: '', ctrlKey: true }, { value: '', altKey: true }, { value: '', metaKey: true },
  ]) {
    input.value = options.value;
    const event = { key: 'Backspace', defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...options };
    input.handlers.get('keydown')[0](event);
    assert.equal(event.defaultPrevented, false);
    assert.deepEqual(Array.from(page.api.getSnapshot().context.imageIds), ['one']);
    assert.equal(input.value, options.value, '组件不替浏览器执行普通删字');
  }
});

test('聊天输入法组合拥有Enter和Escape，确认候选不发送、取消候选不关闭', async () => {
  const page=chat(),sent:any[]=[];
  page.window.RabbitAssistant.send=async(request:any)=>{sent.push(request);return{text:'回答'};};
  await page.api.activate(null);
  const input=page.document.querySelector('.chat-input');input.value='中文草稿';
  for(const flags of [{isComposing:true},{keyCode:229}]){
    for(const key of ['Enter','Escape']){
      const event=page.bubble(input,'keydown',{key,...flags});
      assert.equal(event.defaultPrevented,false);assert.equal(page.api.getSnapshot().open,true);
    }
  }
  page.bubble(input,'compositionstart');
  for(const key of ['Enter','Escape'])assert.equal(page.bubble(input,'keydown',{key}).defaultPrevented,false);
  assert.equal(sent.length,0);assert.equal(input.value,'中文草稿');assert.equal(page.api.getSnapshot().open,true);
  page.bubble(input,'compositionend');
  assert.equal(page.bubble(input,'keydown',{key:'Enter'}).defaultPrevented,true);await flush();
  assert.equal(sent.length,1);assert.equal(sent[0].text,'中文草稿');
  assert.equal(page.bubble(input,'keydown',{key:'Escape'}).defaultPrevented,true);assert.equal(page.api.getSnapshot().open,false);
});

test('设置输入法取消候选不关闭或丢草稿，组合结束后Escape正常关闭', async () => {
  const page=browser();page.load('settings-ui.js');const api=page.window.RabbitSettings;await api.open();
  const model=page.document.querySelector('#rabbit-model');model.value='deepseek-v4-pro';page.bubble(model,'input');
  const input=page.document.querySelector('#rabbit-api-key');
  for(const flags of [{isComposing:true},{keyCode:229}]){
    assert.equal(page.bubble(input,'keydown',{key:'Escape',...flags}).defaultPrevented,false);
    assert.equal(api.getSnapshot().open,true);
  }
  page.bubble(input,'compositionstart');
  assert.equal(page.bubble(input,'keydown',{key:'Escape'}).defaultPrevented,false);
  assert.equal(api.getSnapshot().draft.model,'deepseek-v4-pro');assert.equal(api.getSnapshot().open,true);
  page.bubble(input,'compositionend');
  assert.equal(page.bubble(input,'keydown',{key:'Escape'}).defaultPrevented,true);assert.equal(api.getSnapshot().open,false);
  await api.open();page.bubble(input,'compositionstart');api.close();await api.open();
  assert.equal(page.bubble(input,'keydown',{key:'Escape'}).defaultPrevented,true);assert.equal(api.getSnapshot().open,false);
});

test('空输入先删除上传图片，再删除截图，并保留文字附件', async () => {
  const page = chat();
  await page.api.activate({ id: 'window', images: [{ id: 'one', title: '截图', imageDataUrl: 'image' }] });
  const input = page.document.querySelector('.chat-input'), files = page.document.querySelector('.chat-file-input');
  files.files = [{ name: '上传.png', type: 'image/png', dataUrl: 'data:image/png;base64,dGVzdA==' }];
  files.handlers.get('change')[0](); await flush();
  assert.equal(page.api.getSnapshot().attachmentCount, 1);
  input.handlers.get('keydown')[0]({ key: 'Backspace', preventDefault() {} });
  assert.equal(page.api.getSnapshot().attachmentCount, 0);
  assert.deepEqual(Array.from(page.api.getSnapshot().context.imageIds), ['one'], '上传图片优先于先前截图');

  files.files = [{ name: '保留.txt', type: 'text/plain', text: async () => '附件内容' }];
  files.handlers.get('change')[0](); await flush();
  input.handlers.get('keydown')[0]({ key: 'Backspace', repeat: true, preventDefault() {} });
  assert.deepEqual(Array.from(page.api.getSnapshot().context.imageIds), []);
  assert.equal(page.api.getSnapshot().attachmentCount, 1, '删除截图不能带走文字附件');
  assert.equal(page.document.querySelectorAll('.chat-context-chip').length, 1);
  assert.equal(page.document.querySelector('.chat-context-chip').title, '保留.txt');
});


test('重新激活清空草稿、附件与消息并换新会话，同一次打开内追问仍沿用会话', async () => {
  const page=chat(), requests: any[]=[];
  page.window.RabbitAssistant.send=async(request: any)=>{requests.push(request);return {text:'回答'};};
  const input=page.document.querySelector('.chat-input'),files=page.document.querySelector('.chat-file-input');
  const submit=()=>page.document.querySelector('.chat-composer').handlers.get('submit')[0]({preventDefault(){}});
  await page.api.activate({id:'old',images:[]});
  input.value='第一问';submit();await flush();
  input.value='追问';submit();await flush();
  assert.equal(requests[0].conversationId,requests[1].conversationId);
  assert.ok(page.api.getSnapshot().messageCount>0);
  files.files=[{name:'旧.txt',type:'text/plain',text:async()=>'旧附件'}];
  files.handlers.get('change')[0]();await flush();input.value='未发送草稿';
  page.api.close();await page.api.activate({id:'new',images:[]});
  assert.equal(input.value,'');assert.equal(page.api.getSnapshot().messageCount,0);
  assert.equal(page.api.getSnapshot().attachmentCount,0);
  assert.equal(page.api.getSnapshot().context.id,'new');
  input.value='新问题';submit();await flush();
  assert.notEqual(requests[2].conversationId,requests[0].conversationId);
  assert.equal(requests[2].attachments.length,0);
});

test('上一轮未读完的附件不能进入重新激活的新对话', async () => {
  const page=chat();let finish!: (text:string)=>void;
  await page.api.activate({id:'old',images:[]});
  const files=page.document.querySelector('.chat-file-input');
  files.files=[{name:'旧.txt',type:'text/plain',text:()=>new Promise<string>(resolve=>finish=resolve)}];
  files.handlers.get('change')[0]();
  page.api.close();await page.api.activate({id:'new',images:[]});
  finish('迟到附件');await flush();
  assert.equal(page.api.getSnapshot().attachmentCount,0);
});


test('等待时每秒显示耗时，实际搜索后才显示计数，完成或取消后停止', async () => {
  for (const cancel of [false,true]) {
    const page=chat(), done=deferred<{text:string}>();let request:any;
    page.window.RabbitAssistant.send=(value:any)=>{request=value;return done.promise;};
    await page.api.activate({id:'progress',images:[]});
    page.document.querySelector('.chat-input').value='问题';
    page.document.querySelector('.chat-composer').handlers.get('submit')[0]({preventDefault(){}});
    await flush();
    const progress=page.document.querySelector('.chat-progress');
    assert.equal(progress.textContent,'思考 0 秒');
    page.tick(2100);assert.equal(progress.textContent,'思考 2 秒');
    request.onProgress({toolCounts:{搜索:2}});assert.equal(progress.textContent,'思考 2 秒 · 2 次搜索');
    request.onProgress({toolCounts:{搜索:2,读取文件:1}});assert.equal(progress.textContent,'思考 2 秒 · 2 次搜索 · 1 次读取文件');
    if(cancel)page.api.close();
    done.resolve({text:'回答'});await flush();
    assert.equal(page.document.querySelector('.chat-progress'),null);
    const stopped=progress.textContent;page.tick(3000);assert.equal(progress.textContent,stopped);
  }
});


test('工具轮数设置跨页保留草稿，取消恢复，保存后重新打开显示持久值', async () => {
  const page=browser(),patches:any[]=[];let stored:any={maxToolRounds:3};
  page.window.rabbitDesktop={loadSettings:async()=>stored,saveSettings:async(patch:any)=>{patches.push(patch);stored={...stored,...patch};return stored;}};
  page.load('settings-ui.js');await page.window.RabbitSettings.ready;await page.window.RabbitSettings.open();
  const input=page.document.querySelector('#rabbit-tool-rounds');
  assert.equal(input.value,'3');input.value='8';input.handlers.get('input')[0]();
  page.document.querySelector('#rabbit-tab-general').handlers.get('click')[0]();
  page.document.querySelector('#rabbit-tab-model').handlers.get('click')[0]();assert.equal(input.value,'8');
  page.window.RabbitSettings.close();await page.window.RabbitSettings.open();assert.equal(input.value,'3');
  input.value='8';input.handlers.get('input')[0]();
  await page.document.querySelector('#rabbit-settings-form').handlers.get('submit')[0]({preventDefault(){}});
  assert.equal(patches[0].maxToolRounds,8);
  await page.window.RabbitSettings.open();assert.equal(input.value,'8');
});

test('历史保留条数默认十条，取消恢复，零可预览保存但空值和负数无效', async () => {
  const page=browser(),patches:any[]=[];let stored:any={};
  page.window.rabbitDesktop={loadSettings:async()=>stored,saveSettings:async(patch:any)=>{patches.push(patch);stored={...stored,...patch};return stored;}};
  page.load('settings-ui.js');await page.window.RabbitSettings.ready;await page.window.RabbitSettings.open();
  page.document.querySelector('#rabbit-tab-general').handlers.get('click')[0]();
  const input=page.document.querySelector('#rabbit-history-limit');
  const submit=()=>page.document.querySelector('#rabbit-settings-form').handlers.get('submit')[0]({preventDefault(){}});
  assert.equal(input.attributes.min,'0');
  assert.equal(input.value,'10');input.value='25';input.handlers.get('input')[0]();
  page.document.querySelector('#rabbit-tab-model').handlers.get('click')[0]();
  page.document.querySelector('#rabbit-tab-general').handlers.get('click')[0]();assert.equal(input.value,'25');
  page.window.RabbitSettings.close();await page.window.RabbitSettings.open();assert.equal(input.value,'10');
  for(const value of ['', '-1', '1.5']) {
    input.value=value;input.handlers.get('input')[0]();await submit();
    assert.equal(patches.length,0);
    assert.match(page.document.querySelector('.rs-status').textContent,/非负整数/);
  }
  input.value='25';input.handlers.get('input')[0]();await submit();
  assert.equal(patches[0].historyLimit,25);
  await page.window.RabbitSettings.open();assert.equal(input.value,'25');
  assert.equal(page.window.RabbitSettings.getSnapshot().settings.historyLimit,25);
  input.value='0';input.handlers.get('input')[0]();
  assert.equal(page.window.RabbitSettings.getSnapshot().draft.historyLimit,0);
  assert.equal(page.events.filter(event=>event.type==='settings:change').at(-1).detail.settings.historyLimit,0);
  await submit();assert.equal(patches[1].historyLimit,0);
  await page.window.RabbitSettings.open();assert.equal(input.value,'0');
  assert.equal(page.window.RabbitSettings.getSnapshot().settings.historyLimit,0);
});

test('外观字体默认关闭，切换即时预览，取消恢复已存字体，保存后重载保留选择', async () => {
  const page = browser(), patches: any[] = [];
  let stored: any = {};
  const bridge = {
    loadSettings: async () => stored,
    saveSettings: async (patch: any) => { patches.push(patch); stored = { ...stored, ...patch }; return stored; },
  };
  page.window.rabbitDesktop = bridge;
  page.load('settings-ui.js');
  const api = page.window.RabbitSettings;
  await api.ready; await api.open();
  page.document.querySelector('#rabbit-tab-appearance').handlers.get('click')[0]();
  const input = page.document.querySelector('#rabbit-use-builtin-font');
  const submit = () => page.document.querySelector('#rabbit-settings-form').handlers.get('submit')[0]({ preventDefault() {} });
  assert.equal(page.document.querySelector('#rabbit-page-appearance').contains(input), true);
  assert.equal(input.checked, false);
  assert.equal(api.getSnapshot().settings.useBuiltinFont, false);
  assert.equal(page.document.documentElement.dataset.builtinFont, 'false');

  input.checked = true; input.handlers.get('change')[0]();
  assert.equal(api.getSnapshot().draft.useBuiltinFont, true);
  assert.equal(api.getSnapshot().settings.useBuiltinFont, false);
  assert.equal(page.document.documentElement.dataset.builtinFont, 'true');
  api.close();
  assert.equal(page.document.documentElement.dataset.builtinFont, 'false');
  assert.equal(patches.length, 0);
  await api.open();
  assert.equal(input.checked, false);

  input.checked = true; input.handlers.get('change')[0](); await submit();
  assert.equal(patches[0].useBuiltinFont, true);
  assert.equal(api.getSnapshot().settings.useBuiltinFont, true);
  assert.equal(page.document.documentElement.dataset.builtinFont, 'true');
  await api.open();
  assert.equal(input.checked, true);
  input.checked = false; input.handlers.get('change')[0]();
  assert.equal(page.document.documentElement.dataset.builtinFont, 'false');
  api.close();
  assert.equal(page.document.documentElement.dataset.builtinFont, 'true');

  await api.open();
  input.checked = false; input.handlers.get('change')[0](); await submit();
  assert.equal(patches[1].useBuiltinFont, false);
  assert.equal(page.document.documentElement.dataset.builtinFont, 'false');
  const reloaded = browser();
  reloaded.window.rabbitDesktop = bridge;
  reloaded.load('settings-ui.js'); await reloaded.window.RabbitSettings.ready;
  assert.equal(reloaded.window.RabbitSettings.getSnapshot().settings.useBuiltinFont, false);
  assert.equal(reloaded.document.querySelector('#rabbit-use-builtin-font').checked, false);
  assert.equal(reloaded.document.documentElement.dataset.builtinFont, 'false');
});

test('历史数量预览或保存为零立即隐藏入口并关闭列表，迟到列表不覆盖重新启用后的结果', async () => {
  for (const type of ['settings:change', 'settings:saved']) {
    const page=chat(),pending=deferred<any[]>();let reads=0;
    Object.assign(page.window.RabbitAssistant,{listHistory:()=>++reads===1?pending.promise:Promise.resolve([])});
    await page.api.activate(null);
    const toggle=page.document.querySelector('.chat-history-toggle');
    assert.notEqual(toggle.hidden,true);
    toggle.handlers.get('click')[0]();
    assert.equal(page.api.getSnapshot().historyOpen,true);
    page.emit(type,{detail:{settings:{historyLimit:0}}});
    assert.equal(toggle.hidden,true);
    assert.equal(page.api.getSnapshot().historyOpen,false);
    page.emit(type,{detail:{settings:{historyLimit:10}}});
    assert.equal(toggle.hidden,false);
    toggle.handlers.get('click')[0]();await flush();
    assert.equal(reads,2);
    assert.equal(page.api.getSnapshot().historyOpen,true);
    pending.resolve([{id:'stale',title:'关闭前的旧列表',updatedAt:1}]);await flush();
    assert.equal(page.document.querySelector('.chat-archive-open'),null);
    assert.equal(page.api.getSnapshot().historyOpen,true);
  }
});

test('历史设为零后再启用，先前已点选但迟到的历史内容不能恢复旧会话', async () => {
  const page=chat(),pending=deferred<any>();
  Object.assign(page.window.RabbitAssistant,{listHistory:async()=>[{id:'stale',title:'旧对话',updatedAt:1}],getHistory:()=>pending.promise});
  await page.api.activate(null);
  const toggle=page.document.querySelector('.chat-history-toggle'),input=page.document.querySelector('.chat-input');
  input.value='保留当前草稿';toggle.handlers.get('click')[0]();await flush();
  page.document.querySelector('.chat-archive-open').handlers.get('click')[0]();
  page.emit('settings:change',{detail:{settings:{historyLimit:0}}});
  page.emit('settings:change',{detail:{settings:{historyLimit:10}}});
  toggle.handlers.get('click')[0]();await flush();
  pending.resolve({id:'stale',messages:[{role:'assistant',content:'迟到内容',turn:{id:'old',text:'旧问题',intent:'chat'},status:'complete'}]});await flush();
  assert.equal(input.value,'保留当前草稿');
  assert.equal(page.api.getSnapshot().messageCount,0);
  assert.equal(page.api.getSnapshot().historyOpen,true);
});

test('历史选择恢复原会话与首图，追问沿用会话且不重复发送截图，删除不留下旧会话', async () => {
  const page=chat(),sent:any[]=[],removed:string[]=[];
  const entry={id:'past-session',title:'先前问题',updatedAt:1700000000000,thumbnail:'data:image/png;base64,preview',
    firstScreenshot:{id:'first',title:'原窗口',imageDataUrl:'data:image/png;base64,original'},messages:[
      {role:'user',content:'先前问题',turn:{id:'old-turn',text:'先前问题',intent:'chat'},status:'complete'},
      {role:'assistant',content:'先前回答',turn:{id:'old-turn',text:'先前问题',intent:'chat'},status:'complete'}]};
  Object.assign(page.window.RabbitAssistant,{listHistory:async()=>removed.length?[]:[entry],getHistory:async()=>entry,
    deleteHistory:async(id:string)=>{removed.push(id);},send:async(request:any)=>{sent.push(request);return {text:'继续回答'};}});
  await page.api.activate({id:'new-capture',images:[{id:'new-image',title:'新图',imageDataUrl:'data:image/png;base64,new'}]});
  const input=page.document.querySelector('.chat-input'),toggle=page.document.querySelector('.chat-history-toggle');
  input.value='未发送的草稿';toggle.handlers.get('click')[0]();await flush();
  assert.equal(page.api.getSnapshot().historyOpen,true);
  assert.equal(page.document.querySelector('.chat-archive-thumb').src,entry.thumbnail);
  toggle.handlers.get('click')[0]();assert.equal(input.value,'未发送的草稿');
  toggle.handlers.get('click')[0]();await flush();
  page.document.querySelector('.chat-archive-open').handlers.get('click')[0]();await flush();
  assert.equal(page.api.getSnapshot().historyOpen,false);assert.equal(page.api.getSnapshot().presentation,'expanded');
  assert.equal(page.api.getSnapshot().messageCount,2);assert.equal(page.api.getSnapshot().context,null);
  assert.equal(page.document.querySelector('.chat-original-shot').src,entry.firstScreenshot.imageDataUrl);
  input.value='继续';page.document.querySelector('.chat-composer').handlers.get('submit')[0]({preventDefault(){}});await flush();
  assert.equal(sent[0].conversationId,entry.id);assert.equal(sent[0].context,null);
  toggle.handlers.get('click')[0]();await flush();
  await page.document.querySelector('.chat-archive-delete').handlers.get('click')[0]();
  assert.deepEqual(removed,[entry.id]);assert.equal(page.api.getSnapshot().messageCount,0);
  assert.equal(page.document.querySelector('.chat-archive-empty').textContent,'还没有历史对话');
  toggle.handlers.get('click')[0]();input.value='新问题';page.document.querySelector('.chat-composer').handlers.get('submit')[0]({preventDefault(){}});await flush();
  assert.notEqual(sent[1].conversationId,entry.id);
});

test('历史异步读取结束前关闭或重新激活，不覆盖新对话', async () => {
  const page=chat(),pending=deferred<any>();
  Object.assign(page.window.RabbitAssistant,{listHistory:async()=>[{id:'old',title:'old',updatedAt:1}],getHistory:()=>pending.promise});
  await page.api.activate(null);
  page.document.querySelector('.chat-history-toggle').handlers.get('click')[0]();await flush();
  page.document.querySelector('.chat-archive-open').handlers.get('click')[0]();
  page.api.close();await page.api.activate(null);page.document.querySelector('.chat-input').value='新的草稿';
  pending.resolve({id:'old',messages:[]});await flush();
  assert.equal(page.document.querySelector('.chat-input').value,'新的草稿');assert.equal(page.api.getSnapshot().open,true);
});

test('删除当前历史尚未落盘时继续发送，立即使用新会话 ID', async () => {
  const page=chat(),deleted=deferred(),sent:any[]=[];
  Object.assign(page.window.RabbitAssistant,{listHistory:async()=>[{id:'deleting',title:'待删除',updatedAt:1}],
    getHistory:async()=>({id:'deleting',messages:[]}),deleteHistory:()=>deleted.promise,
    send:async(request:any)=>{sent.push(request);return {text:'新回答'};}});
  await page.api.activate(null);
  const toggle=page.document.querySelector('.chat-history-toggle');toggle.handlers.get('click')[0]();await flush();
  page.document.querySelector('.chat-archive-open').handlers.get('click')[0]();await flush();
  toggle.handlers.get('click')[0]();await flush();
  const removal=page.document.querySelector('.chat-archive-delete').handlers.get('click')[0]();
  toggle.handlers.get('click')[0]();page.document.querySelector('.chat-input').value='立即发送';
  page.document.querySelector('.chat-composer').handlers.get('submit')[0]({preventDefault(){}});await flush();
  assert.notEqual(sent[0].conversationId,'deleting');
  deleted.resolve();await removal;assert.equal(page.api.getSnapshot().messageCount,2);
});

test('点按兔球不关闭对话，拖动保持整体尺寸并限制在场景内', async () => {
  const page=chat();await page.api.activate(null,{anchor:{x:700,y:350}});
  const pet=page.document.getElementById('pet');
  pet.getBoundingClientRect=()=>({left:600,top:300,right:692,bottom:392,width:92,height:92});
  page.emit('pointerdown',{target:pet,clientX:640,clientY:340});
  page.emit('desktop:pointerdown',{detail:{x:640,y:340}});
  assert.equal(page.api.getSnapshot().open,true);
  const before=page.api.getSnapshot().bounds;
  page.api.beginPetDrag();page.api.movePetDrag({x:800,y:420});
  const moved=page.api.getSnapshot().bounds;
  assert.equal(moved.width,before.width);assert.notEqual(moved.x,before.x);
  page.emit('desktop:pointerdown',{detail:{x:0,y:0}});assert.equal(page.api.getSnapshot().open,true);
  page.api.movePetDrag({x:9999,y:-9999});page.api.endPetDrag();
  const bounds=page.api.getSnapshot().bounds;
  assert.ok(bounds.x>=0&&bounds.y>=0&&bounds.x+bounds.width<=1200&&bounds.y+bounds.height<=800);
  page.emit('desktop:pointerdown',{detail:{x:0,y:0}});assert.equal(page.api.getSnapshot().open,false);
});

test('插件页跨页保留草稿，取消恢复，保存关闭插件同时退出大爆炸模式', async () => {
  const page=browser(), patches:any[]=[];
  let saved:any={graphPluginEnabled:true,graphModeEnabled:true};
  page.window.rabbitDesktop={loadSettings:async()=>saved,saveSettings:async(patch:any)=>{patches.push(patch);saved={...saved,...patch};return saved;}};
  page.load('settings-ui.js');const api=page.window.RabbitSettings;
  await api.ready;await api.open({tab:'plugins'});assert.equal(api.getSnapshot().tab,'plugins');
  const toggle=page.document.querySelector('#rabbit-graph-plugin');
  const tabs=page.document.querySelectorAll('.rs-tab');
  tabs[4].handlers.get('click')[0]();assert.equal(api.getSnapshot().tab,'plugins');
  toggle.checked=false;toggle.handlers.get('change')[0]();
  tabs[0].handlers.get('click')[0]();tabs[4].handlers.get('click')[0]();
  assert.equal(api.getSnapshot().draft.graphPluginEnabled,false);
  assert.equal(api.getSnapshot().settings.graphPluginEnabled,true);
  api.close();assert.equal(api.getSnapshot().settings.graphModeEnabled,true);assert.equal(patches.length,0);
  await api.open();assert.equal(toggle.checked,true);
  toggle.checked=false;toggle.handlers.get('change')[0]();
  await page.document.querySelector('#rabbit-settings-form').handlers.get('submit')[0]({preventDefault(){}});
  assert.equal(patches[0].graphPluginEnabled,false);assert.equal(patches[0].graphModeEnabled,false);
  await api.open();assert.equal(toggle.checked,false);
  await api.open({tab:'general'});assert.equal(api.getSnapshot().tab,'general');
  await api.open({tab:'plugins'});assert.equal(api.getSnapshot().tab,'plugins');
});

test('功能栏大爆炸按钮单独保存模式、不发送问题，禁用插件隐藏入口', async () => {
  const page=chat(),patches:any[]=[],requests:any[]=[];
  let saved:any={graphPluginEnabled:true,graphModeEnabled:false};
  page.window.rabbitDesktop={loadSettings:async()=>saved,saveSettings:async(patch:any)=>{patches.push(patch);saved={...saved,...patch};return saved;}};
  page.window.RabbitAssistant.send=async(request:any)=>{requests.push(request);return {text:'回答'};};
  page.load('settings-ui.js');await page.window.RabbitSettings.ready;
  await page.api.activate(null,{activationId:5});
  const button=page.document.querySelector('.chat-graph-toggle');
  await button.handlers.get('click')[0]();
  assert.deepEqual(JSON.parse(JSON.stringify(patches)),[{graphModeEnabled:true}]);
  assert.equal(button.attributes['aria-pressed'],'true');assert.equal(requests.length,0);
  await button.handlers.get('click')[0]();assert.equal(button.attributes['aria-pressed'],'false');
  page.emit('settings:saved',{detail:{settings:{graphPluginEnabled:false,graphModeEnabled:false}}});
  assert.equal(button.hidden,true);
});

test('图谱快速会话不取普通截图、固定每轮节点上下文，再生成不会借用新选中节点', async () => {
  const page=chat(),requests:any[]=[];let captures=0,nodeId='node-one';
  page.window.RabbitGraph={isOpen:()=>true,getChatContext:()=>({workspaceId:'workspace',graphId:'graph',nodeId})};
  page.window.RabbitAssistant.captureContext=async()=>{captures++;return null;};
  page.window.RabbitAssistant.send=async(request:any)=>{requests.push(request);return {text:'### 关键解释\n\n选中内容的解释。'};};
  await page.api.activateGraph({activationId:8});
  const input=page.document.querySelector('.chat-input'),form=page.document.querySelector('.chat-composer');
  input.value='解释当前卡片';await form.handlers.get('submit')[0]({preventDefault(){}});await flush();
  assert.equal(captures,0);assert.equal(requests[0].context,null);
  assert.deepEqual(JSON.parse(JSON.stringify(requests[0].graphContext)),{workspaceId:'workspace',graphId:'graph',nodeId:'node-one'});
  nodeId='node-two';
  const regenerate=page.document.querySelectorAll('.chat-response-action').find((button:any)=>button.attributes['aria-label']==='重新生成');
  await regenerate.handlers.get('click')[0]();await flush();
  assert.equal(requests[1].regenerate,true);assert.equal(requests[1].graphContext.nodeId,'node-one');
  input.value='还没发送的草稿';page.api.close();
  assert.equal(page.events.filter(event=>event.type==='chat:close').at(-1).detail.graph,true);
  await page.api.activateGraph({activationId:8});
  assert.equal(input.value,'还没发送的草稿');assert.equal(page.api.getSnapshot().messageCount,2);
});

test('图谱切换会关闭并取消快速会话，迟到回复不写入下一张图的会话', async () => {
  const page=chat(),pending=deferred<any>(),requests:any[]=[];
  let current={workspaceId:'workspace',graphId:'graph-a',nodeId:'root-a'};
  page.window.RabbitGraph={isOpen:()=>true,getChatContext:()=>({...current})};
  page.window.RabbitAssistant.send=(request:any)=>{requests.push(request);return requests.length===1?pending.promise:Promise.resolve({text:'新图回答'});};
  await page.api.activateGraph({activationId:8});
  const input=page.document.querySelector('.chat-input'),form=page.document.querySelector('.chat-composer');
  input.value='解释第一张图';form.handlers.get('submit')[0]({preventDefault(){}});await flush();
  assert.equal(requests.length,1);assert.equal(requests[0].signal.aborted,false);
  page.emit('graph:contextchange',{detail:{workspaceId:current.workspaceId,graphId:current.graphId}});
  assert.equal(page.api.getSnapshot().open,true);assert.equal(requests[0].signal.aborted,false);
  current={workspaceId:'workspace',graphId:'graph-b',nodeId:'root-b'};
  page.emit('graph:contextchange',{detail:{workspaceId:current.workspaceId,graphId:current.graphId}});
  assert.equal(page.api.getSnapshot().open,false);assert.equal(requests[0].signal.aborted,true);
  await page.api.activateGraph({activationId:8});
  input.value='解释第二张图';await form.handlers.get('submit')[0]({preventDefault(){}});await flush();
  assert.notEqual(requests[1].conversationId,requests[0].conversationId);
  assert.equal(requests[1].graphContext.graphId,'graph-b');assert.equal(page.api.getSnapshot().messageCount,2);
  pending.resolve({text:'迟到的第一张图回答'});await flush();
  assert.equal(page.api.getSnapshot().messageCount,2);
  assert.equal(page.document.querySelectorAll('.chat-response-actions').length,1);
});

test('即使未收到换图事件，发送前也拒绝把旧会话续到另一张图', async () => {
  const page=chat(),requests:any[]=[];
  let current={workspaceId:'workspace-a',graphId:'graph',nodeId:'root-a'};
  page.window.RabbitGraph={isOpen:()=>true,getChatContext:()=>({...current})};
  page.window.RabbitAssistant.send=async(request:any)=>{requests.push(request);return{text:'回答'};};
  await page.api.activateGraph({activationId:8});
  const input=page.document.querySelector('.chat-input'),form=page.document.querySelector('.chat-composer');
  input.value='第一个工作区的问题';await form.handlers.get('submit')[0]({preventDefault(){}});await flush();
  current={workspaceId:'workspace-b',graphId:'graph',nodeId:'root-b'};
  input.value='另一个工作区的问题';await form.handlers.get('submit')[0]({preventDefault(){}});await flush();
  assert.equal(requests.length,1);assert.equal(page.api.getSnapshot().open,false);
  await page.api.activateGraph({activationId:8});
  assert.equal(input.value,'');assert.equal(page.api.getSnapshot().messageCount,0);
  input.value='新问题';await form.handlers.get('submit')[0]({preventDefault(){}});await flush();
  assert.equal(requests.length,2);assert.notEqual(requests[1].conversationId,requests[0].conversationId);
  page.emit('graph:contextchange',{detail:null});
  assert.equal(page.api.getSnapshot().open,false);
});

test('加入图谱使用回答产生时的节点，换图后即使事件未到也拒绝添加旧回答', async () => {
  const page=chat(),mutations:any[]=[];
  let current={workspaceId:'workspace',graphId:'graph-a',nodeId:'original-parent'};
  page.window.RabbitGraph={isOpen:()=>true,getChatContext:()=>({...current})};
  page.window.rabbitDesktop={graphMutate:async(workspaceId:string,mutation:any)=>{mutations.push({workspaceId,...mutation});}};
  page.window.RabbitAssistant.send=async()=>({text:'### 关键解释\n\n对应原选中卡片的回答。'});
  await page.api.activateGraph({activationId:8});
  const input=page.document.querySelector('.chat-input'),form=page.document.querySelector('.chat-composer');
  input.value='解释原节点';await form.handlers.get('submit')[0]({preventDefault(){}});await flush();
  const firstAdd=page.document.querySelectorAll('.chat-response-action').find((button:any)=>button.attributes['aria-label']==='回答加入图谱');
  current.nodeId='newly-selected-parent';
  await firstAdd.handlers.get('click')[0]();
  assert.equal(mutations.length,1);assert.equal(mutations[0].parentId,'original-parent');
  input.value='解释新节点';await form.handlers.get('submit')[0]({preventDefault(){}});await flush();
  const nextAdd=page.document.querySelectorAll('.chat-response-action').find((button:any)=>button.attributes['aria-label']==='回答加入图谱');
  current={workspaceId:'workspace',graphId:'graph-b',nodeId:'root-b'};
  await nextAdd.handlers.get('click')[0]();
  assert.equal(mutations.length,1);assert.equal(page.api.getSnapshot().open,false);
});

test('回答加入图谱只写一份标题，失败可重试、成功后不重复添加', async () => {
  const page=chat(),mutations:any[]=[];let fail=true;
  page.window.RabbitGraph={isOpen:()=>true,getChatContext:()=>({workspaceId:'workspace',graphId:'graph',nodeId:'parent'})};
  page.window.rabbitDesktop={graphMutate:async(workspaceId:string,mutation:any)=>{if(fail)throw new Error('写入失败');mutations.push({workspaceId,...mutation});}};
  page.window.RabbitAssistant.send=async()=>({text:'### 关键解释\n\n只保存一次正文。'});
  await page.api.activateGraph({activationId:9});
  page.document.querySelector('.chat-input').value='解释';
  await page.document.querySelector('.chat-composer').handlers.get('submit')[0]({preventDefault(){}});await flush();
  const add=page.document.querySelectorAll('.chat-response-action').find((button:any)=>button.attributes['aria-label']==='回答加入图谱');
  await add.handlers.get('click')[0]();assert.equal(add.disabled,false);assert.equal(mutations.length,0);
  fail=false;await add.handlers.get('click')[0]();await add.handlers.get('click')[0]();
  assert.deepEqual(JSON.parse(JSON.stringify(mutations)),[{workspaceId:'workspace',type:'add-card',graphId:'graph',parentId:'parent',title:'关键解释',markdown:'只保存一次正文。'}]);
  assert.equal(add.disabled,true);assert.equal(add.attributes['aria-label'],'已加入图谱');
});

test('多级快速回复可真实写入图谱并重读，小标题保持层级且代码围栏原样保留', async t => {
  const directory=await mkdtemp(path.join(tmpdir(),'rabbitball-chat-card-'));
  const store=new GraphStore(directory,()=>{});await store.load();
  t.after(async()=>{await store.dispose();await rm(directory,{recursive:true,force:true});});
  const created=await store.create('阅读');
  const empty=await store.mutate(created.id,{type:'create-graph'});
  const workspace=await store.attachCapture(created.id,empty.graphs[0].id,{id:'capture',title:'资料',capturedAt:1,images:[{id:'image',title:'原图',imageDataUrl:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jTQAAAABJRU5ErkJggg=='}]});
  const graph=workspace.graphs[0],page=chat();
  page.window.RabbitGraph={isOpen:()=>true,getChatContext:()=>({workspaceId:workspace.id,graphId:graph.id,nodeId:graph.rootId})};
  // 浏览器演示走同一入口，实际写入和重读交由真实文档存储检验。
  page.window.RabbitGraphDemo={graphMutate:store.mutate.bind(store)};
  page.window.RabbitAssistant.send=async()=>({text:'### 一次解释\n\n## 第一部分\n正文。\n\n### 细节\n说明。\n\n###### 附注\n尾注。\n\n````markdown\n# 示例一级\n```\n## 示例二级\n````\n\n~~~markdown\n### 示例三级\n~~~'});
  await page.api.activateGraph({activationId:9});page.document.querySelector('.chat-input').value='解释';
  await page.document.querySelector('.chat-composer').handlers.get('submit')[0]({preventDefault(){}});await flush();
  const add=page.document.querySelectorAll('.chat-response-action').find((button:any)=>button.attributes['aria-label']==='回答加入图谱');
  await add.handlers.get('click')[0]();assert.equal(add.attributes['aria-label'],'已加入图谱');
  const restored=await store.open(workspace.id),card=restored.graphs[0].nodes[1];
  assert.equal(restored.graphs.length,1);assert.equal(restored.graphs[0].nodes.length,2);
  assert.equal(card.title,'一次解释');
  assert.equal(card.markdown,'#### 第一部分\n正文。\n\n##### 细节\n说明。\n\n###### 附注\n尾注。\n\n````markdown\n# 示例一级\n```\n## 示例二级\n````\n\n~~~markdown\n### 示例三级\n~~~');
});

test('回答加入图谱保存期间不能重新生成，保存完成后新回答仍可加入', async () => {
  const page=chat(),saved=deferred();let calls=0;
  page.window.RabbitGraph={isOpen:()=>true,getChatContext:()=>({workspaceId:'workspace',graphId:'graph',nodeId:'parent'})};
  page.window.rabbitDesktop={graphMutate:()=>saved.promise};
  page.window.RabbitAssistant.send=async()=>({text:'### 解释\n\n第'+(++calls)+'版回答。'});
  await page.api.activateGraph({activationId:9});page.document.querySelector('.chat-input').value='解释';
  await page.document.querySelector('.chat-composer').handlers.get('submit')[0]({preventDefault(){}});await flush();
  const actions=()=>page.document.querySelectorAll('.chat-response-action');
  const add=actions().find((button:any)=>button.attributes['aria-label']==='回答加入图谱');
  const regenerate=actions().find((button:any)=>button.attributes['aria-label']==='重新生成');
  const saving=add.handlers.get('click')[0]();assert.equal(regenerate.disabled,true);
  await regenerate.handlers.get('click')[0]();assert.equal(calls,1);
  saved.resolve();await saving;assert.equal(regenerate.disabled,false);
  await regenerate.handlers.get('click')[0]();await flush();assert.equal(calls,2);
  const freshAdd=actions().find((button:any)=>button.attributes['aria-label']==='回答加入图谱');
  assert.equal(freshAdd.disabled,false);
});
