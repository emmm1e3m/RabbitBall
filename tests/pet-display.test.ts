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

function animation() {
  let width = 1440, height = 900, now = 0, nextFrame = 0;
  const frames = new Map<number, (time: number) => void>();
  const listeners = new Map<string, Array<(event: any) => void>>();
  const reports: Array<{ time: number; point: Point }> = [];
  const ready: number[] = [];
  const acknowledgements = new Map<number, (accepted: boolean) => void>();
  class Element {
    textContent = ''; innerHTML = ''; dataset = {}; style: any = {};
    classList = { add() {}, remove() {}, toggle() {} };
    setAttribute() {} removeAttribute() {} appendChild(node: Element) { return node; }
    addEventListener() {} querySelector() { return new Element(); }
    getBoundingClientRect() { return { left: 0, top: 0, width, height }; }
    hasPointerCapture() { return false; } releasePointerCapture() {}
  }
  const elements = new Map<string, Element>();
  const window: any = {
    addEventListener() {},
    rabbitDesktop: {
      setInteractive() {},
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
    createElementNS: () => new Element(), elementFromPoint: () => null,
    addEventListener(type: string, handler: (event: any) => void) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type)!.push(handler);
    },
  };
  const html = readFileSync(new URL('../prototype/index.html', import.meta.url), 'utf8');
  const script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].find(match => match[1].includes('window.RabbitBallDemo=Object.freeze'))?.[1];
  assert.ok(script, '必须执行页面实际兔球动画，而不是复制算法');
  const instrumented = script.replace("window.addEventListener('pagehide'", "window.__motionTest={state:()=>JSON.parse(JSON.stringify(S)),rebase:rebaseViewport,measure};\n    window.addEventListener('pagehide'");
  vm.runInNewContext(instrumented, {
    window, document, performance: { now: () => now }, matchMedia: () => ({ matches: false }),
    ResizeObserver: class { observe() {} }, setTimeout: () => 1, clearTimeout() {},
    requestAnimationFrame(run: (time: number) => void) { frames.set(++nextFrame, run); return nextFrame; },
    cancelAnimationFrame(id: number) { frames.delete(id); },
  }, { filename: 'rabbit-animation.js' });
  return {
    reports, ready,
    acknowledge(id: number, accepted: boolean) {
      assert.ok(acknowledgements.has(id), '先等待真实就绪请求，再返回主进程确认');
      acknowledgements.get(id)!(accepted); acknowledgements.delete(id);
    },
    opacity: () => Number(elements.get('pet')!.style.opacity ?? 1),
    state: () => JSON.parse(JSON.stringify(window.__motionTest.state())),
    dispatch(type: string, detail: unknown) {
      for (const handler of listeners.get(type) ?? []) handler({ detail });
    },
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
