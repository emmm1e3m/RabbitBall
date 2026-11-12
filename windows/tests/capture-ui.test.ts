import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as shortcut from '../electron/shortcut.ts';

const source = readFileSync(new URL('../prototype/capture-ui.js', import.meta.url), 'utf8');
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

// 仅模拟 DOM、截图服务与指针捕获；执行完整截图组件的事件处理。
function harness(native = false) {
  const captured = new Set<number>(), events: any[] = [], rectangles: any[] = [], images: any[] = [];
  const documentEvents = new Map<string, Array<(event: any) => void>>(), windowEvents = new Map<string, Array<() => void>>();
  const frames = new Map<number, () => void>();
  let frameId = 0, ended = 0, cancelled = 0;
  class Element {
    id = ''; className = ''; style: any = { setProperty() {} }; dataset = {}; textContent = '';
    children: Element[] = []; parent: Element | null = null; handlers = new Map<string, Array<(event: any) => void>>();
    captures = captured; tag: string; classes = new Set<string>();
    constructor(tag: string) { this.tag = tag; }
    classList = {
      add: (...values: string[]) => values.forEach(value => this.classes.add(value)),
      remove: (...values: string[]) => values.forEach(value => this.classes.delete(value)),
      toggle: (value: string, enabled: boolean) => enabled ? this.classes.add(value) : this.classes.delete(value),
    };
    setAttribute() {} removeAttribute() {}
    appendChild(child: Element) { this.children.push(child); child.parent = this; return child; }
    set innerHTML(_html: string) {
      for (const [tag, className] of [['img', 'capture-background'], ['canvas', 'capture-background'], ['div', 'capture-box'], ['div', 'capture-announcement'], ['div', 'capture-status-title'], ['div', 'capture-status-count']]) {
        const child = new Element(tag); child.className = className; this.appendChild(child);
      }
    }
    querySelectorAll(selector: string): Element[] {
      return this.children.flatMap(child => [...((selector.startsWith('.') ? child.className === selector.slice(1) : child.tag === selector) ? [child] : []), ...child.querySelectorAll(selector)]);
    }
    querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
    addEventListener(type: string, listener: (event: any) => void) { if (!this.handlers.has(type)) this.handlers.set(type, []); this.handlers.get(type)!.push(listener); }
    setPointerCapture(id: number) { captured.add(id); }
    hasPointerCapture(id: number) { return captured.has(id); }
    releasePointerCapture(id: number) {
      captured.delete(id);
      this.handlers.get('lostpointercapture')?.forEach(listener => listener({ type: 'lostpointercapture', pointerId: id }));
    }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
    getAnimations() { return []; }
    animate() { return { finished: Promise.resolve() }; }
  }
  const body = new Element('body'), head = new Element('head');
  const document = {
    body, head, documentElement: body, createElement: (tag: string) => new Element(tag), getElementById: () => null,
    addEventListener(type: string, listener: (event: any) => void) { if (!documentEvents.has(type)) documentEvents.set(type, []); documentEvents.get(type)!.push(listener); },
    dispatchEvent(event: any) { events.push(event); documentEvents.get(event.type)?.forEach(listener => listener(event)); },
  };
  const context = () => ({ images: [...images], demo: true });
  const window: any = {
    RabbitShortcut: shortcut,
    RabbitAssistant: {
      demoCaptureStart: () => ({ sessionId: 'demo', backgroundImageDataUrl: 'fixture', context: context() }),
      demoCaptureRegion: async (rect: any) => { rectangles.push({ ...rect }); images.push({ id: String(images.length + 1) }); return { rect, context: context() }; },
      demoCaptureEnd: async () => { ended++; return context(); }, demoCaptureCancel: () => { cancelled++; },
    },
    addEventListener(type: string, listener: () => void) { if (!windowEvents.has(type)) windowEvents.set(type, []); windowEvents.get(type)!.push(listener); },
  };
  if (native) window.rabbitDesktop = { cancelCapture: () => { cancelled++; } };
  vm.runInNewContext(source, {
    window, document, innerWidth: 1200, innerHeight: 800, setTimeout, clearTimeout,
    requestAnimationFrame: (callback: () => void) => { frames.set(++frameId, callback); return frameId; }, cancelAnimationFrame: (id: number) => frames.delete(id),
    matchMedia: () => ({ matches: false }),
    CustomEvent: class { type: string; detail: unknown; constructor(type: string, init: any) { this.type = type; this.detail = init.detail; } },
  });
  const root = body.children[0], box = root.querySelector('.capture-box')!;
  return {
    api: window.RabbitCapture, root, box, captured, rectangles, events, counts: () => ({ ended, cancelled }),
    pointer(type: string, values: Record<string, unknown> = {}) {
      const event: any = { type, pointerId: 1, pointerType: 'touch', isPrimary: true, button: 0, clientX: 20, clientY: 30, preventDefault() {}, ...values };
      if (type === 'pointerdown' && event.pointerType === 'touch') captured.add(event.pointerId);
      root.handlers.get(type)?.forEach(listener => listener(event));
      if (type === 'pointerup' || type === 'pointercancel') captured.delete(event.pointerId);
      for (const [id, callback] of [...frames]) { frames.delete(id); callback(); }
    },
    blur() { windowEvents.get('blur')?.forEach(listener => listener()); },
  };
}

test('单指圈选由同一触点提交一次，结束释放捕获', async () => {
  const app = harness(), result = app.api.captureImages();
  app.pointer('pointerdown'); app.pointer('pointermove', { clientX: 160, clientY: 100 });
  assert.equal(app.box.style.width, '140px');
  app.pointer('pointerup', { clientX: 180, clientY: 130 });
  assert.equal((await result).length, 1);
  assert.deepEqual(app.rectangles, [{ x: 20, y: 30, width: 160, height: 100 }]);
  assert.equal(app.counts().ended, 1); assert.equal(app.captured.size, 0);
});

test('第二指放弃当前框，任何剩余触点移动与抬起均不生成截图', async () => {
  const app = harness(), result = app.api.captureImages();
  app.pointer('pointerdown'); app.pointer('pointermove', { clientX: 160, clientY: 100 });
  app.pointer('pointerdown', { pointerId: 2, isPrimary: false, clientX: 250 });
  assert.equal(app.box.style.display, 'none');
  app.pointer('pointerup', { pointerId: 1 });
  app.pointer('pointermove', { pointerId: 2, clientX: 400 });
  app.pointer('pointerdown', { pointerId: 3, isPrimary: false });
  app.pointer('pointerup', { pointerId: 3 }); app.pointer('pointerup', { pointerId: 2 });
  await flush(); assert.deepEqual(app.rectangles, []); assert.equal(app.counts().ended, 0);
  app.pointer('pointerdown', { pointerId: 4 }); app.pointer('pointerup', { pointerId: 4, clientX: 140, clientY: 150 });
  assert.equal((await result).length, 1); assert.equal(app.captured.size, 0);
});

test('无主触点与非左键不能启动框选', async () => {
  const app = harness(), result = app.api.captureImages();
  app.pointer('pointerdown', { isPrimary: false }); app.pointer('pointerup', { clientX: 200, clientY: 200 });
  app.pointer('pointerdown', { pointerType: 'pen', button: 2 }); app.pointer('pointerup', { pointerType: 'pen', button: 2, clientX: 200, clientY: 200 });
  await flush(); assert.equal(app.rectangles.length, 0); assert.equal(app.counts().ended, 0);
  app.api.cancel(); assert.equal(await result, null);
});

test('笔圈选不被手掌触点或异源pointerup污染', async () => {
  const app = harness(), result = app.api.captureImages();
  app.pointer('pointerdown', { pointerType: 'pen' });
  app.pointer('pointerdown', { pointerId: 2 }); app.pointer('pointerdown', { pointerId: 3, isPrimary: false });
  app.pointer('pointermove', { pointerId: 2, clientX: 900, clientY: 700 });
  app.pointer('pointerup', { pointerId: 3, clientX: 900, clientY: 700 });
  app.pointer('pointerup', { pointerId: 2, clientX: 900, clientY: 700 });
  await flush(); assert.equal(app.rectangles.length, 0);
  app.pointer('pointerup', { pointerType: 'pen', clientX: 150, clientY: 160 });
  await result; assert.deepEqual(app.rectangles, [{ x: 20, y: 30, width: 130, height: 130 }]);
});

test('pointercancel和丢失捕获放弃选框，迟到up不提交，后续重新圈选可用', async () => {
  for (const type of ['pointercancel', 'lostpointercapture']) {
    const app = harness(), result = app.api.captureImages();
    app.pointer('pointerdown'); app.pointer('pointermove', { clientX: 150, clientY: 150 });
    app.pointer(type, { pointerId: 2 }); assert.equal(app.box.style.display, 'block');
    app.pointer(type); assert.equal(app.box.style.display, 'none'); assert.equal(app.captured.has(1), false);
    app.pointer('pointerup', { clientX: 150, clientY: 150 }); await flush(); assert.equal(app.rectangles.length, 0);
    app.pointer('pointerdown', { pointerId: 3 }); app.pointer('pointerup', { pointerId: 3, clientX: 150, clientY: 150 });
    assert.equal((await result).length, 1);
  }
});

test('取消与失焦清空全部触点捕获并结清待选批注', async () => {
  for (const close of ['cancel', 'blur']) {
    const app = harness(), result = app.api.captureImages();
    app.pointer('pointerdown'); app.pointer('pointerdown', { pointerId: 2, isPrimary: false });
    if (close === 'cancel') app.api.cancel(); else app.blur();
    assert.equal(await result, null); assert.equal(app.captured.size, 0); assert.equal(app.api.getSnapshot().active, false);
    app.pointer('pointerup', { pointerId: 2, clientX: 200, clientY: 200 }); await flush(); assert.equal(app.rectangles.length, 0);
  }
});

test('原生截图展示层不消费DOM圈选，不与原生指针路径重复提交', () => {
  const app = harness(true);
  app.api.handleEvent({ type: 'start', sessionId: 'native', context: { images: [] }, backgroundImageDataUrl: 'fixture' });
  app.api.handleEvent({ type: 'frame', sessionId: 'native', rect: { x: 20, y: 30, width: 120, height: 90 } });
  app.pointer('pointerdown'); app.pointer('pointermove', { clientX: 500, clientY: 300 });
  app.pointer('pointerup', { clientX: 500, clientY: 300 }); app.pointer('pointercancel');
  assert.equal(app.box.style.width, '120px'); assert.equal(app.rectangles.length, 0); assert.equal(app.counts().ended, 0);
  app.api.handleEvent({ type: 'cancel', sessionId: 'native' }); assert.equal(app.api.getSnapshot().active, false);
});
