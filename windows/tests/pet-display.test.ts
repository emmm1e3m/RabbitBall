import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

type Point = { x: number; y: number };
type Viewport = Point & { scale: number };
const primary: Viewport = { x: 0, y: 0, scale: 2 };
const secondary: Viewport = { x: 2880, y: -766, scale: 1.25 };
const otherScreen = { x: 1440, y: -383, width: 1720, height: 720 };
const physical = (point: Point, viewport: Viewport) => ({ x: viewport.x + point.x * viewport.scale, y: viewport.y + point.y * viewport.scale });
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} 应接近 ${expected}`);
const samePoint = (actual: Point, expected: Point) => { near(actual.x, expected.x); near(actual.y, expected.y); };
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

function animation(sceneOrigin: Point = { x: 0, y: 0 }) {
  let width = 1440, height = 900, now = 0, nextFrame = 0;
  const frames = new Map<number, (time: number) => void>();
  const listeners = new Map<string, Array<(event: any) => void>>();
  const windowListeners = new Map<string, Array<(event: any) => void>>();
  const reports: Array<{ time: number; point: Point }> = [];
  const interactiveChanges: boolean[] = [];
  const hitTests: Point[] = [];
  let hitAncestors: string[] = [];
  const ready: number[] = [];
  const acknowledgements = new Map<number, (accepted: boolean) => void>();
  class Element {
    textContent = ''; innerHTML = ''; dataset = {}; style: any = {}; computed: any = {}; hidden = false; inert = false; parentElement: Element | null = null;
    handlers = new Map<string, Array<(event: any) => void>>();
    captured = new Set<number>();
    bounds?: {left:number;top:number;width:number;height:number};
    classList = { add() {}, remove() {}, toggle() {} };
    setAttribute() {} removeAttribute() {} appendChild(node: Element) { return node; }
    addEventListener(type: string, handler: (event: any) => void) {
      if (!this.handlers.has(type)) this.handlers.set(type, []);
      this.handlers.get(type)!.push(handler);
    }
    querySelector() { return new Element(); }
    getBoundingClientRect() { return this.bounds ?? { left: sceneOrigin.x, top: sceneOrigin.y, width, height }; }
    setPointerCapture(id: number) { this.captured.add(id); }
    hasPointerCapture(id: number) { return this.captured.has(id); }
    releasePointerCapture(id: number) { this.captured.delete(id); }
  }
  const elements = new Map<string, Element>();
  const window: any = {
    addEventListener(type: string, handler: (event: any) => void) {
      if (!windowListeners.has(type)) windowListeners.set(type, []);
      windowListeners.get(type)!.push(handler);
    },
    rabbitDesktop: {
      setInteractive(value: boolean) { interactiveChanges.push(value); },
      reportPetPosition(point: Point) { reports.push({ time: now, point: { ...point } }); },
      petViewportReady(id: number) {
        ready.push(id);
        return new Promise<boolean>(resolve => acknowledgements.set(id, resolve));
      },
    },
  };
  const document = {
    documentElement: new Element(),
    getElementById(id: string) { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); },
    querySelectorAll: (selector: string) => selector === '.eye-open' ? [new Element(), new Element()] : [],
    createElementNS: () => new Element(), elementFromPoint: (x: number,y: number) => { hitTests.push({x,y});return hitAncestors.length ? { closest: (selectors: string) => selectors.split(',').some(selector => hitAncestors.includes(selector)) } : null; },
    addEventListener(type: string, handler: (event: any) => void) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type)!.push(handler);
    },
  };
  const html = readFileSync(new URL('../prototype/index.html', import.meta.url), 'utf8');
  const script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].find(match => match[1].includes('window.RabbitBallDemo=Object.freeze'))?.[1];
  assert.ok(script, '必须执行页面实际兔球动画，而不是复制算法');
  const instrumented = script.replace("window.addEventListener('pagehide'", "window.__motionTest={state:()=>JSON.parse(JSON.stringify(S)),hearts:()=>hearts.map(({birth,scale})=>({birth,scale})),rebase:rebaseViewport,measure};\n    window.addEventListener('pagehide'");
  vm.runInNewContext(instrumented, {
    window, document, performance: { now: () => now }, matchMedia: () => ({ matches: false }),
    getComputedStyle: (element: Element) => ({ display:'block',visibility:'visible',opacity:'1',overflowX:'visible',overflowY:'visible',...element.computed,...element.style }),
    ResizeObserver: class { observe() {} }, setTimeout: () => 1, clearTimeout() {},
    requestAnimationFrame(run: (time: number) => void) { frames.set(++nextFrame, run); return nextFrame; },
    cancelAnimationFrame(id: number) { frames.delete(id); },
  }, { filename: 'rabbit-animation.js' });
  return {
    reports, ready, interactiveChanges, hitTests,
    hover(ancestors: string[]) { hitAncestors = ancestors; },
    acknowledge(id: number, accepted: boolean) {
      assert.ok(acknowledgements.has(id), '先等待真实就绪请求，再返回主进程确认');
      acknowledgements.get(id)!(accepted); acknowledgements.delete(id);
    },
    opacity: () => Number(elements.get('pet')!.style.opacity ?? 1),
    state: () => JSON.parse(JSON.stringify(window.__motionTest.state())),
    setChat(chat: any) { window.RabbitChat = chat; },
    setSettings(settings: any) { window.RabbitSettings = settings; },
    pause() { window.RabbitBallDemo.pause(); },
    hearts: () => window.__motionTest.hearts(),
    petEvent(type: string, point: Point, values: Record<string, unknown> = {}) {
      const element = elements.get('pet')!;
      const event = { pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, detail: 1, currentTarget: element,
        clientX: point.x + sceneOrigin.x, clientY: point.y + sceneOrigin.y,
        preventDefault() {}, stopPropagation() {}, ...values };
      for (const handler of element.handlers.get(type) ?? []) handler(event);
    },
    dispatch(type: string, detail: unknown) {
      for (const handler of listeners.get(type) ?? []) handler({ detail });
    },
    windowEvent(type: string) { for (const handler of windowListeners.get(type) ?? []) handler({}); },
    approach(point: Point) { window.RabbitBallDemo.approach(point); },
    cursor(x: number, y: number, viewport = primary, followBounds = otherScreen, transitionId?: number, resetEntry = false) {
      for (const handler of listeners.get('desktop:cursor') ?? []) handler({ detail: { x, y, viewport, followBounds, transitionId, resetEntry } });
    },
    measure() { window.__motionTest.measure(); },
    rebase(viewport: Viewport) { window.__motionTest.rebase(viewport); },
    resize(w: number, h: number) { width = w; height = h; window.__motionTest.measure(); },
    tick(count: number) {
      for (let i = 0; i < count; i++) {
        now += 1000 / 60;
        for (const [id, run] of [...frames]) { frames.delete(id); run(now); }
      }
    },
  };
}

test('聊天外置历史按钮及其SVG参与原生鼠标命中，离开组件恢复穿透', () => {
  const app=animation();
  app.dispatch('chat:open',{bounds:{x:100,y:100,width:360,height:94},petPosition:{x:500,y:150}});
  for(const ancestors of [['.chat-history-toggle','.chat-shell'],['path','svg','.chat-history-toggle','.chat-shell'],['.chat-panel','.chat-shell']]){
    app.hover(ancestors);app.tick(1);assert.equal(app.interactiveChanges.at(-1),true);
    app.hover([]);app.tick(1);assert.equal(app.interactiveChanges.at(-1),false);
  }
});

test('动画暂停后仍更新系统命中，进入与离开兔球都不依赖视觉渲染', () => {
  const app=animation();app.pause();const frame=app.state().frame;
  app.hover(['#pet']);app.tick(1);assert.equal(app.interactiveChanges.at(-1),true);
  app.hover([]);app.tick(1);assert.equal(app.interactiveChanges.at(-1),false);
  assert.equal(app.state().frame,frame);
});

test('原生命中只上报布尔状态，按住兔球与激活图谱时维持输入', () => {
  const app=animation(),point={x:240,y:200};app.tick(1);
  assert.equal(app.interactiveChanges.at(-1),false);
  const reports=app.interactiveChanges.length;app.tick(3);assert.equal(app.interactiveChanges.length,reports);
  app.petEvent('pointerdown',point,{pointerType:'touch',pointerId:8});
  assert.equal(app.interactiveChanges.at(-1),true,'按下立即接收拖动，不等待下一帧');
  app.petEvent('pointerup',point,{pointerType:'touch',pointerId:8});
  assert.equal(app.interactiveChanges.at(-1),false);
  app.dispatch('graph:open',{activationId:8});app.tick(1);
  assert.equal(app.interactiveChanges.at(-1),true);
  app.dispatch('graph:close',{});app.tick(1);
  assert.equal(app.interactiveChanges.at(-1),false);
});

test('鼠标停在另一显示器后兔球沿动画飞出旧视口，重新测量不把目标夹回旧屏', () => {
  const app = animation();
  app.cursor(2300, -150);
  app.tick(25);
  const before = app.state();
  assert.ok(before.flight, '停鼠后应启动跟随路径');
  assert.ok(before.tx > before.w && before.ty < 0, '目标应允许超出旧显示器边界');
  app.measure();
  const measured = app.state();
  samePoint({ x: measured.tx, y: measured.ty }, { x: before.tx, y: before.ty });
  app.tick(75);
  const arrived = app.state();
  assert.ok(arrived.x.x > 1440 && arrived.y.x < 0, '兔球本身必须越界，不能只改变目标后停在旧屏边缘');
});

test('混合 DPI 换窗保持物理位置、速度、整条路径及大小连续，随后平滑恢复逻辑尺寸', () => {
  const app = animation();
  app.cursor(2300, -150); app.tick(25);
  const before = app.state();
  assert.ok(Math.hypot(before.x.v, before.y.v) > 0 && before.flight);
  app.rebase(secondary);
  const after = app.state();
  samePoint(physical({ x: after.x.x, y: after.y.x }, secondary), physical({ x: before.x.x, y: before.y.x }, primary));
  samePoint({ x: after.x.v * secondary.scale, y: after.y.v * secondary.scale }, { x: before.x.v * primary.scale, y: before.y.v * primary.scale });
  samePoint(physical({ x: after.tx, y: after.ty }, secondary), physical({ x: before.tx, y: before.ty }, primary));
  for (const key of ['from', 'to', 'c1', 'c2']) samePoint(physical(after.flight[key], secondary), physical(before.flight[key], primary));
  near(after.flight.progress, before.flight.progress);
  near(after.renderSize.x * secondary.scale, before.renderSize.x * primary.scale);
  near(after.renderSize.v * secondary.scale, before.renderSize.v * primary.scale);
  app.resize(2752, 1154); app.tick(15);
  assert.ok(Math.abs(app.state().renderSize.x - 92.25) < Math.abs(after.renderSize.x - 92.25), '尺寸应继续由既有弹簧平滑收敛');
});

test('物理鼠标未移动时换屏不重新计时或重启跟随路径', () => {
  const app = animation();
  app.cursor(2300, -150); app.tick(25);
  const before = app.state();
  const cursor = physical(before.pointer, primary);
  app.cursor((cursor.x - secondary.x) / secondary.scale, (cursor.y - secondary.y) / secondary.scale,
    secondary, { x: 0, y: 0, width: 2752, height: 1154 });
  app.resize(2752, 1154);
  const after = app.state();
  assert.equal(after.pointerVersion, before.pointerVersion);
  near(after.lastPointer, before.lastPointer);
  near(after.flight.progress, before.flight.progress);
  app.tick(1);
  assert.ok(app.state().flight.progress > before.flight.progress, '继续推进原路径，不能将进度清零');
});

test('停鼠后的动画仍会报告越界物理位置，屏内不报告且频率不超过30Hz', () => {
  const app = animation();
  app.cursor(2300, -150); app.tick(25);
  assert.equal(app.reports.length, 0, '屏内动画不应产生额外位置 IPC');
  app.tick(45);
  assert.ok(app.reports.length >= 2, '鼠标静止后仍需由动画检测越界');
  for (const report of app.reports) assert.ok(report.point.x >= 2880 || report.point.y < 0 || report.point.y >= 1800);
  for (let i = 1; i < app.reports.length; i++) assert.ok(app.reports[i].time - app.reports[i - 1].time >= 1000 / 30 - 1e-8);
});

test('跨屏飞行只在靠近实际出口边时渐隐，到达边界前不会提前闪烁', () => {
  const app = animation();
  // 先停在上沿附近，再向右跨屏；上沿不是本次出口，不能据此提前淡出。
  app.cursor(650, 0, primary, { x: 0, y: 0, width: 1440, height: 900 }); app.tick(100);
  assert.ok(app.state().y.x < 100);
  app.cursor(2300, 0, primary, { x: 1440, y: 0, width: 1720, height: 900 });
  const fading: number[] = [];
  let crossed = false;
  for (let frame = 0; frame < 100; frame++) {
    app.tick(1);
    const state = app.state(), opacity = app.opacity();
    assert.ok(opacity >= 0 && opacity <= 1);
    if (state.x.x < state.w * .55) near(opacity, 1);
    if (state.x.x < state.w && opacity > 0 && opacity < 1) fading.push(opacity);
    if (state.x.x >= state.w) { crossed = true; near(opacity, 0); break; }
  }
  assert.ok(crossed && fading.length >= 2, '必须经过多帧渐隐，不能直接从1跳到0');
  assert.ok(fading.at(-1)! < fading[0]);
});

test('同屏跟随接近边缘仍保持可见，不误用跨屏淡出', () => {
  const app = animation();
  app.cursor(1439, 450, primary, { x: 0, y: 0, width: 1440, height: 900 });
  let nearEdge = false;
  for (let frame = 0; frame < 100; frame++) {
    app.tick(1);
    const state = app.state();
    if (state.w - state.x.x < Math.max(48, state.renderSize.x * .9)) nearEdge = true;
    near(app.opacity(), 1);
  }
  assert.ok(nearEdge, '场景必须实际进入淡出距离，才能证明同屏边缘不误淡出');
});

test('换屏隔两帧申请就绪，ACK未到时保持透明，确认后才从零淡入', async () => {
  const app = animation();
  app.cursor(2300, 300, primary, { x: 1440, y: 0, width: 1720, height: 900 });
  for (let frame = 0; frame < 100 && app.state().x.x < 1440; frame++) app.tick(1);
  const pointer = physical(app.state().pointer, primary);
  app.cursor((pointer.x - secondary.x) / secondary.scale, (pointer.y - secondary.y) / secondary.scale,
    secondary, { x: 0, y: 0, width: 2752, height: 1154 }, 17);
  app.resize(2752, 1154);
  near(app.state().screenFade, 0);
  near(app.opacity(), 0);
  assert.deepEqual(app.ready, []);
  app.tick(1);
  near(app.opacity(), 0);
  assert.deepEqual(app.ready, []);
  app.tick(1);
  assert.deepEqual(app.ready, [17]);
  const waiting = app.state();
  app.tick(20);
  const stillWaiting = app.state();
  samePoint({ x: stillWaiting.x.x, y: stillWaiting.y.x }, { x: waiting.x.x, y: waiting.y.x });
  near(stillWaiting.flight.progress, waiting.flight.progress);
  near(app.opacity(), 0);
  near(app.state().screenFade, 0);
  app.acknowledge(17, true); await flush();
  app.tick(1);
  for (let frame = 0; frame < 60 && app.opacity() === 0; frame++) app.tick(1);
  assert.ok(app.opacity() > 0 && app.opacity() < 1, '新屏必须在确认之后逐渐恢复可见');
  app.tick(20);
  near(app.opacity(), 1);
  app.cursor((pointer.x - secondary.x) / secondary.scale, (pointer.y - secondary.y) / secondary.scale,
    secondary, { x: 0, y: 0, width: 2752, height: 1154 }, 17);
  near(app.state().screenFade, 1);
  app.tick(3);
  assert.deepEqual(app.ready, [17], '重复通知同一切换不能重新淡入或重复确认');
});

test('新屏已确认但尚未起飞时保持透明，实际飞行后才开始渐入', async () => {
  const app = animation();
  const initial = app.state(), bounds = { x: 0, y: 0, width: 1440, height: 900 };
  app.cursor(initial.x.x, initial.y.x, primary, bounds, 41);
  app.tick(2); app.acknowledge(41, true); await flush();
  for (let i = 0; i < 6; i++) {
    app.cursor(initial.x.x + i * 2, initial.y.x, primary, bounds, 41);
    app.tick(1);
    near(app.opacity(), 0);
    assert.equal(app.state().flight, null);
  }
  let flying = false;
  for (let i = 0; i < 60; i++) {
    app.tick(1);
    if (app.opacity() > 0) { assert.ok(app.state().flight); flying = true; break; }
  }
  assert.ok(flying, '停鼠后真正启动飞行，才推进渐入');
});

test('过期或拒绝的就绪响应不恢复新切换的可见性', async () => {
  for (const staleAccepted of [false, true]) {
    const app = animation();
    app.cursor(2300, 300, primary, { x: 1440, y: 0, width: 1720, height: 900 });
    for (let frame = 0; frame < 100 && app.state().x.x < 1440; frame++) app.tick(1);
    const pointer = physical(app.state().pointer, primary);
    const local = { x: (pointer.x - secondary.x) / secondary.scale, y: (pointer.y - secondary.y) / secondary.scale };
    const bounds = { x: 0, y: 0, width: 2752, height: 1154 };
    app.cursor(local.x, local.y, secondary, bounds, 17);
    app.cursor(local.x, local.y, secondary, bounds, 18);
    app.resize(2752, 1154); app.tick(2);
    assert.deepEqual(app.ready, [17, 18]);
    app.acknowledge(17, staleAccepted); await flush(); app.tick(15);
    assert.equal(app.state().viewportReady, false);
    near(app.opacity(), 0);
    app.acknowledge(18, false); await flush(); app.tick(15);
    assert.equal(app.state().viewportReady, false);
    near(app.state().screenFade, 0);
    near(app.opacity(), 0);
  }
});

test('关闭跟随后跨屏激活从真实停靠位置起飞，进入目标屏前不提前渐入', async () => {
  const app = animation();
  app.cursor(20, 350, primary, { x: 0, y: 0, width: 1440, height: 900 }); app.tick(100);
  app.dispatch('settings:change', { settings: { petSize: 1, followMouse: false } }); app.tick(100);
  const parked = app.state();
  assert.equal(parked.followEnabled, false);
  assert.ok(parked.x.x < 0, '场景必须实际停靠在旧屏左侧');
  const before = physical({ x: parked.x.x, y: parked.y.x }, primary);
  const target = { x: 500, y: 450 };
  app.cursor(target.x, target.y, secondary, { x: 0, y: 0, width: 2752, height: 1154 }, 31);
  app.resize(2752, 1154);
  app.approach(target);
  app.dispatch('chat:open', { bounds: { x: 550, y: 450, width: 280, height: 160 }, petPosition: target });
  const activated = app.state();
  assert.equal(activated.chatOpen, true);
  assert.equal(activated.followEnabled, false);
  samePoint(physical({ x: activated.x.x, y: activated.y.x }, secondary), before);
  samePoint(physical(activated.flight.from, secondary), before);
  samePoint(activated.flight.to, target);
  app.tick(2); app.acknowledge(31, true); await flush();
  let outside = 0, entered = false;
  for (let frame = 0; frame < 150; frame++) {
    app.tick(1);
    const state = app.state();
    const inside = state.x.x >= 0 && state.x.x < state.w && state.y.x >= 0 && state.y.x < state.h;
    if (!inside) { outside++; near(app.opacity(), 0); }
    else { entered = true; assert.ok(app.opacity() < .2, '进入时才从透明开始，不能在屏外耗完淡入'); break; }
  }
  assert.ok(entered && outside >= 4, '必须验证一段真实屏外飞行后进入目标屏');
  app.tick(20);
  near(app.opacity(), 1);
  assert.equal(app.state().chatOpen, true);
  samePoint(app.state().approach?.target || { x: app.state().tx, y: app.state().ty }, target);
});

test('关闭跟后的同屏激活仍从当前停靠点直接飞向面板，不增加跨屏渐变', () => {
  const app = animation();
  const bounds = { x: 0, y: 0, width: 1440, height: 900 };
  app.cursor(20, 350, primary, bounds); app.tick(100);
  app.dispatch('settings:change', { settings: { petSize: 1, followMouse: false } }); app.tick(100);
  const parked = app.state(), target = { x: 500, y: 450 };
  app.cursor(target.x, target.y, primary, bounds);
  app.approach(target);
  app.dispatch('chat:open', { bounds: { x: 550, y: 450, width: 280, height: 160 }, petPosition: target });
  samePoint(app.state().flight.from, { x: parked.x.x, y: parked.y.x });
  for (let frame = 0; frame < 100; frame++) { app.tick(1); near(app.opacity(), 1); }
  assert.deepEqual(app.ready, [], '同屏激活不应等待跨屏坐标ACK');
});

test('跨屏入场前关闭提问会结束入屏等待，迟到ACK不会让停靠球帽永久透明', async () => {
  const app = animation();
  app.cursor(20, 350, primary, { x: 0, y: 0, width: 1440, height: 900 }); app.tick(100);
  app.dispatch('settings:change', { settings: { petSize: 1, followMouse: false } }); app.tick(100);
  const target = { x: 500, y: 450 };
  app.cursor(target.x, target.y, secondary, { x: 0, y: 0, width: 2752, height: 1154 }, 33);
  app.resize(2752, 1154); app.approach(target);
  app.dispatch('chat:open', { bounds: { x: 550, y: 450, width: 280, height: 160 }, petPosition: target });
  app.tick(2);
  assert.ok(app.state().x.x < 0, '取消必须发生在角色仍在新屏外时');
  near(app.opacity(), 0);
  app.dispatch('chat:close', {});
  app.cursor(target.x, target.y, secondary, { x: 0, y: 0, width: 2752, height: 1154 }, undefined, true);
  app.acknowledge(33, false); await flush(); app.tick(100);
  const docked = app.state();
  assert.equal(docked.chatOpen, false);
  assert.equal(docked.approach, null);
  assert.ok(docked.x.x < 0, '左侧停靠球帽的中心本来就在屏外');
  near(app.opacity(), 1);
});

test('旧面板关闭不能清除新跨屏入场，只有主进程取消通知才结束等待', async () => {
  const app = animation();
  app.cursor(20, 350, primary, { x: 0, y: 0, width: 1440, height: 900 }); app.tick(100);
  app.dispatch('settings:change', { settings: { petSize: 1, followMouse: false } }); app.tick(100);
  const target = { x: 500, y: 450 }, bounds = { x: 0, y: 0, width: 2752, height: 1154 };
  app.cursor(target.x, target.y, secondary, bounds, 34);
  app.resize(2752, 1154); app.approach(target);
  app.dispatch('chat:open', { bounds: { x: 550, y: 450, width: 280, height: 160 }, petPosition: target });
  app.tick(2);
  app.dispatch('chat:close', {});
  app.dispatch('settings:close', {});
  assert.equal(app.state().viewportEntry, true, '组件关闭事件没有取消本次主进程激活的权限');
  assert.equal(app.state().viewportReady, false);
  app.acknowledge(34, true); await flush(); app.tick(4);
  assert.ok(app.state().x.x < 0);
  assert.equal(app.state().viewportEntry, true, 'ACK只证明坐标已就绪，屏外角色仍须等待入屏');
  near(app.opacity(), 0);
  app.cursor(target.x, target.y, secondary, bounds, undefined, true); app.tick(20);
  assert.equal(app.state().viewportEntry, false);
  near(app.opacity(), 1);
});


test('取消面板仍在等待换屏合成时保持透明，不能提前恢复收起画面', async () => {
  const app = animation();
  app.cursor(500, 300, primary, { x: 0, y: 0, width: 1440, height: 900 });
  app.cursor(500, 300, secondary, { x: 0, y: 0, width: 2752, height: 1154 }, 71);
  app.resize(2752, 1154); app.tick(2);
  app.cursor(500, 300, secondary, { x: 0, y: 0, width: 2752, height: 1154 }, 71, true);
  app.tick(10);
  assert.equal(app.state().viewportReady, false);
  near(app.opacity(), 0);
  app.acknowledge(71, true); await flush(); app.tick(20);
  near(app.opacity(), 1);
});

for (const followMouse of [true, false]) {
  test(`聊天激活时整体拖动遵守布局约束，释放后保留生成动画与位置（跟随${followMouse ? '开' : '关'}）`, () => {
    const app = animation({ x: 75, y: 110 }), requested: Point[] = [];
    let begins = 0, ends = 0;
    const initial = { x: 550, y: 450 };
    app.setChat({
      cancelDemo() {}, beginPetDrag() { begins++; }, endPetDrag() { ends++; },
      movePetDrag(point: Point) {
        requested.push({ ...point });
        // 模拟展开会话的整体边界；实际布局由 chat-ui 测试覆盖。
        const petPosition = { x: Math.max(450, Math.min(1300, point.x)), y: Math.max(400, Math.min(820, point.y)) };
        app.dispatch('chat:layout', { bounds: { x: petPosition.x - 420, y: petPosition.y - 360, width: 380, height: 408 }, petPosition });
        return petPosition;
      },
    });
    app.dispatch('settings:change', { settings: { petSize: 1, followMouse } });
    app.dispatch('chat:open', { bounds: { x: 130, y: 90, width: 380, height: 408 }, petPosition: initial });
    app.tick(120);
    app.dispatch('chat:activity', { mode: 'think', busy: true });
    const start = { x: app.state().x.x, y: app.state().y.x }, dockBefore = app.state().dock;
    app.petEvent('pointerdown', start);
    app.petEvent('pointermove', { x: start.x + 3, y: start.y + 2 });
    assert.equal(begins, 0, '轻点不能提前开始移动面板');
    app.petEvent('pointermove', { x: start.x + 120, y: start.y + 80 });
    assert.equal(begins, 1);
    samePoint(requested[0], { x: start.x + 120, y: start.y + 80 });
    const moving = app.state();
    assert.equal(moving.chatOpen, true);
    assert.equal(moving.mode, 'think');
    assert.equal(moving.drag.active, true);
    samePoint({ x: moving.x.x, y: moving.y.x }, moving.chatAnchor);
    assert.ok(Math.hypot(moving.x.v, moving.y.v) > 0, '拖动速度继续驱动既有果冻和耳朵动画');
    app.tick(3);
    samePoint({ x: app.state().x.x, y: app.state().y.x }, moving.chatAnchor);
    assert.ok(Math.abs(app.state().tilt.x - moving.tilt.x) > .01);
    app.petEvent('pointermove', { x: -1000, y: -1000 });
    samePoint({ x: app.state().x.x, y: app.state().y.x }, { x: 450, y: 400 });
    app.petEvent('pointerup', { x: -1000, y: -1000 });
    assert.equal(ends, 1);
    app.petEvent('click', { x: 450, y: 400 });
    app.tick(120);
    const settled = app.state();
    assert.equal(settled.chatOpen, true);
    assert.equal(settled.mode, 'think');
    assert.equal(settled.drag, null);
    assert.equal(settled.flight, null);
    samePoint({ x: settled.x.x, y: settled.y.x }, { x: 450, y: 400 });
    assert.deepEqual(settled.dock, dockBefore, '聊天拖动不修改未激活停靠位置');
    assert.equal(app.reports.length, 0, '同屏聊天拖动不触发跨屏迁移');
  });
}

test('聊天中轻点保留激活和思考模式，同时触发点击表情；失去捕获结束拖动', () => {
  const app = animation();
  let begins = 0, ends = 0;
  app.setChat({ cancelDemo() {}, beginPetDrag() { begins++; }, endPetDrag() { ends++; }, movePetDrag: (point: Point) => point });
  app.dispatch('chat:open', { bounds: { x: 200, y: 200, width: 380, height: 408 }, petPosition: { x: 640, y: 450 } });
  app.tick(120);
  app.dispatch('chat:activity', { mode: 'think', busy: true });
  const point = { x: app.state().x.x, y: app.state().y.x };
  app.petEvent('pointerdown', point); app.petEvent('pointerup', point); app.petEvent('click', point);
  assert.equal(begins, 0);
  assert.equal(app.state().chatOpen, true);
  assert.equal(app.state().mode, 'think');
  assert.ok(app.state().happy > .7 && app.state().squash.v < 0);
  app.petEvent('pointerdown', point); app.petEvent('pointermove', { x: point.x + 70, y: point.y });
  app.petEvent('lostpointercapture', point);
  assert.equal(ends, 1);
  assert.equal(app.state().drag, null);
  assert.equal(app.state().chatOpen, true);
  samePoint({ x: app.state().x.v, y: app.state().y.v }, { x: 0, y: 0 });
});

test('未激活时开启跟随也可以拖动，关闭跟随仍以弹簧追随并重新停靠', () => {
  const app = animation();
  const initial = { x: app.state().x.x, y: app.state().y.x };
  app.petEvent('pointerdown', initial);
  app.petEvent('pointermove', { x: initial.x + 120, y: initial.y + 60 });
  assert.equal(app.state().drag.active, true);
  app.tick(30);app.petEvent('pointerup', initial);app.tick(120);
  assert.equal(app.state().drag, null);
  assert.equal(app.state().flight, null);
  near(app.state().x.x, initial.x + 120);
  app.dispatch('settings:change', { settings: { petSize: 1, followMouse: false } }); app.tick(120);
  const docked = { x: app.state().x.x, y: app.state().y.x };
  app.petEvent('pointerdown', docked); app.petEvent('pointermove', { x: docked.x - 500, y: docked.y + 100 });
  const moving = app.state();
  assert.equal(moving.drag.active, true);
  samePoint({ x: moving.x.x, y: moving.y.x }, docked);
  assert.notEqual(moving.tx, moving.x.x);
  app.tick(30); app.petEvent('pointerup', { x: docked.x - 500, y: docked.y + 100 }); app.tick(120);
  assert.equal(app.state().drag, null);
  assert.ok(app.state().tuck.x > .95);
});

test('连续点击每次产生五颗双倍爱心，复用固定粒子池，拖动不误触发', () => {
  const app=animation(),point={x:600,y:450};
  for(let detail=1;detail<=12;detail++){
    app.tick(2);app.petEvent('pointerdown',point);app.petEvent('pointerup',point);app.petEvent('click',point,{detail});
    const hearts=app.hearts();
    assert.equal(hearts.length,14);
    const newest=hearts.filter((heart:any)=>heart.birth===app.state().t);
    assert.equal(newest.length,5);
    assert.ok(newest.every((heart:any)=>heart.scale>=.64&&heart.scale<1.4));
  }
  const before=JSON.stringify(app.hearts());
  app.petEvent('pointerdown',point);app.petEvent('pointermove',{x:700,y:450});app.tick(2);
  app.petEvent('pointerup',{x:700,y:450});app.petEvent('click',point);
  assert.equal(JSON.stringify(app.hearts()),before);
});

test('设置打开时拖动兔球带动面板并保留位置，轻点不关闭设置', () => {
  const app=animation();let starts=0,ends=0;
  app.setSettings({beginPetDrag(){starts++;},endPetDrag(){ends++;},movePetDrag(p:Point){
    app.dispatch('settings:layout',{bounds:{x:p.x+100,y:p.y-200,width:360,height:500},petPosition:p});return p;
  }});
  app.dispatch('settings:open',{bounds:{x:540,y:200,width:360,height:500}});app.tick(120);
  const start={x:app.state().x.x,y:app.state().y.x};
  app.petEvent('pointerdown',start);app.petEvent('pointerup',start);app.petEvent('click',start);assert.equal(app.state().settingsOpen,true);
  app.petEvent('pointerdown',start);const end={x:start.x+120,y:start.y+60};
  app.petEvent('pointermove',end);app.tick(3);samePoint({x:app.state().x.x,y:app.state().y.x},end);
  app.petEvent('pointerup',end);app.measure();app.tick(120);
  assert.equal(starts,1);assert.equal(ends,1);assert.equal(app.state().settingsOpen,true);
  samePoint({x:app.state().x.x,y:app.state().y.x},end);
});

test('兔球轻点只由所属主指针触发，第二触点和取消不能开关图谱会话', () => {
  const app=animation(),point={x:600,y:450};let opened=0;
  app.setChat({getSnapshot:()=>({open:false,opening:false}),activateGraph(){opened++;}});
  app.dispatch('graph:open',{activationId:7});
  const first={pointerId:11,pointerType:'touch',isPrimary:true},second={pointerId:12,pointerType:'touch',isPrimary:false};
  app.petEvent('pointerdown',point,first);
  app.petEvent('pointerdown',point,second);app.petEvent('pointerup',point,second);app.petEvent('click',point,second);
  assert.equal(opened,0);assert.equal(app.state().drag.id,11);
  app.petEvent('pointercancel',point,first);app.petEvent('click',point,first);
  assert.equal(opened,0);assert.equal(app.state().drag,null);
  for(const pointerType of ['mouse','touch','pen']){
    const pointer={pointerId:21,pointerType,isPrimary:true};
    app.petEvent('pointerdown',point,pointer);app.petEvent('pointermove',{x:point.x+20,y:point.y},pointer);
    app.petEvent('pointerup',{x:point.x+20,y:point.y},pointer);app.petEvent('click',point,pointer);
    const before=opened;
    // 新轻点不受上一次拖动后的任意时间窗口影响。
    app.petEvent('pointerdown',point,pointer);app.petEvent('pointerup',point,pointer);app.petEvent('click',point,pointer);
    assert.equal(opened,before+1);
  }
  assert.equal(opened,3);
  app.petEvent('click',point,{detail:0,pointerId:-1,pointerType:''});assert.equal(opened,4,'键盘点击继续工作');
});

test('兔球拖动在失焦、暂停和离页时结束，迟到移动不恢复拖动', () => {
  for(const transition of ['blur','suspended','pagehide','pause','graph-close']){
    const app=animation(),point={x:600,y:450};let ended=0;
    app.setChat({close(){},beginPetDrag(){},endPetDrag(){ended++;},movePetDrag:(value:Point)=>value});
    app.dispatch('chat:open',{bounds:{x:100,y:100,width:360,height:94},petPosition:point});
    app.petEvent('pointerdown',point);app.petEvent('pointermove',{x:650,y:480});
    if(transition==='suspended')app.dispatch('desktop:suspended',true);
    else if(transition==='pause')app.pause();
    else if(transition==='graph-close')app.dispatch('graph:close',{});
    else app.windowEvent(transition);
    assert.equal(ended,1);assert.equal(app.state().drag,null);
    const settled={x:app.state().tx,y:app.state().ty};
    app.petEvent('pointermove',{x:900,y:700});app.petEvent('pointerup',{x:900,y:700});
    assert.equal(ended,1);samePoint({x:app.state().tx,y:app.state().ty},settled);
  }
});

test('命中查询使用当前场景的DOM坐标，设置与编辑菜单沿用本体输入机制', () => {
  const origin={x:80,y:45},app=animation(origin);app.cursor(500,300);app.tick(1);
  const pointer=app.state().pointer;
  samePoint(app.hitTests.at(-1)!,{x:pointer.x+origin.x,y:pointer.y+origin.y});
  for(const target of ['#rabbit-settings-root.is-open','#rabbit-edit-menu']){
    app.hover([target]);app.tick(1);assert.equal(app.interactiveChanges.at(-1),true);
    app.hover([]);app.tick(1);assert.equal(app.interactiveChanges.at(-1),false);
  }
});
