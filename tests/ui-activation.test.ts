import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import { DEFAULT_PROMPTS } from '../electron/prompts.ts';
import * as shortcut from '../electron/shortcut.ts';

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

// 只替换浏览器边界；被测行为始终执行完整组件源码。
function browser() {
  let now = 0, serial = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const frames = new Map<number, () => void>();
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
    window, document, innerWidth: 1200, innerHeight: 800, crypto: { randomUUID }, AbortController, DOMException,
    ImageData: class {
      data: Uint8ClampedArray; width: number; height: number;
      constructor(data: Uint8ClampedArray, width: number, height: number) { this.data = data; this.width = width; this.height = height; }
    },
    FileReader: class {
      result = ''; onload?: () => void;
      readAsDataURL(file: { dataUrl: string }) { this.result = file.dataUrl; this.onload?.(); }
    },
    performance: { now: () => now }, matchMedia: () => ({ matches: false }),
    getComputedStyle: () => ({ columnGap: '8', paddingRight: '10' }),
    ResizeObserver: class { observe() {} },
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
    load(name: string) { vm.runInContext(readFileSync(new URL('../prototype/' + name, import.meta.url), 'utf8'), context, { filename: name }); },
    emit(type: string, detail: any = {}) { const event = { type, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...detail }; document.dispatchEvent(event); return event; },
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
    assert.equal(rightAlt.defaultPrevented, codes.length === 1 && codes[0] === 'AltRight');
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

test('组合触发时无关键取消整个按键序列，后续松键不打开对话框', async () => {
  for (const duration of [499, 500]) {
    const page = browser(), activated: unknown[] = [];
    page.window.RabbitSettings = { getSnapshot: () => ({ settings: { activationShortcut: ['ControlRight', 'Space'] } }), ready: Promise.resolve() };
    page.window.RabbitAssistant = {
      demoCaptureStart: () => ({ sessionId: 'one', context: { images: [] }, backgroundImageDataUrl: 'demo' }),
      demoCaptureEnd: async () => ({ id: 'one', images: [] }), demoCaptureCancel() {},
    };
    page.window.RabbitChat = { activate: async (context: unknown) => activated.push(context), getSnapshot: () => ({ open: false }) };
    page.load('capture-ui.js');
    page.emit('keydown', { code: 'ControlRight', key: 'Control', ctrlKey: true });
    page.emit('keydown', { code: 'Space', key: ' ', ctrlKey: true }); page.tick(duration);
    page.emit('keydown', { code: 'KeyA', key: 'a', ctrlKey: true });
    for (const code of ['KeyA', 'Space', 'ControlRight']) page.emit('keyup', { code });
    await flush();
    assert.equal(page.window.RabbitCapture.getSnapshot().active, false);
    assert.equal(activated.length, 0);
  }
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
