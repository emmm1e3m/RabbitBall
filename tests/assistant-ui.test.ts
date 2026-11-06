import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';

interface Activation { activationId: number; view: 'prompt' | 'settings'; context?: unknown; anchor?: { x: number; y: number } }
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function loadAssistant() {
  const events = new EventEmitter();
  const ui = { chat: false, opening: false, settings: false, capture: false };
  const hides: number[] = [], appliedHides: number[] = [], focusCalls: number[] = [];
  const chatCalls: Array<{ context: unknown; options: { activationId: number; anchor?: unknown } }> = [];
  let mainEpoch = 0, chatEpoch: number | undefined;
  let activationListener!: (activation: Activation) => Promise<void>;
  let dismissListener!: (id: number) => void;
  let captureListener!: (event: unknown) => void;
  let suspendedListener!: (suspended: boolean) => void;
  let activateChat = async () => { ui.opening = false; ui.chat = true; };
  let openSettings = async () => { ui.settings = true; };
  const document = {
    addEventListener: events.on.bind(events),
    dispatchEvent(event: { type: string; detail: unknown }) { events.emit(event.type, event); },
    querySelector(selector: string) {
      return (selector.includes('#rabbit-chat-root.is-open') && ui.chat ||
        selector.includes('#rabbit-settings-root.is-open') && ui.settings ||
        selector.includes('#rabbit-capture-root.is-active') && ui.capture) ? {} : null;
    },
  };
  const chat = {
    getSnapshot: () => ({ opening: ui.opening }),
    async activate(context: unknown, options: { activationId: number; anchor?: unknown }) {
      chatEpoch = options.activationId; ui.chat = false; ui.opening = true;
      chatCalls.push({ context, options });
      await activateChat();
    },
    close() {
      const opening = ui.opening;
      if (!ui.chat && !opening) return;
      ui.chat = false; ui.opening = false;
      document.dispatchEvent({ type: 'chat:close', detail: { activationId: chatEpoch, opening } });
    },
  };
  const bridge = {
    onActivate(listener: typeof activationListener) { activationListener = listener; },
    onDismiss(listener: typeof dismissListener) { dismissListener = listener; },
    onCaptureEvent(listener: typeof captureListener) { captureListener = listener; },
    onSuspended(listener: typeof suspendedListener) { suspendedListener = listener; },
    onCursor() {}, onPointerDown() {}, onSettingsChanged() {},
    async focusInput(activationId: number) { focusCalls.push(activationId); return activationId === mainEpoch; },
    hidePanel(activationId: number) {
      hides.push(activationId);
      if (activationId === mainEpoch) { appliedHides.push(activationId); mainEpoch++; }
    },
  };
  const window = {
    rabbitDesktop: bridge, RabbitChat: chat,
    RabbitCapture: { finishNative() {}, handleEvent() {} },
    RabbitSettings: {
      open: () => openSettings(), applySettings() {},
      close() { if (ui.settings) { ui.settings = false; document.dispatchEvent({ type: 'settings:close', detail: {} }); } },
    },
    RabbitAssistant: undefined as unknown as { focusInput(activationId: number): Promise<boolean> },
  };
  vm.runInNewContext(readFileSync(new URL('../prototype/assistant.js', import.meta.url), 'utf8'), {
    window, document, DOMException, setTimeout, clearTimeout,
    CustomEvent: class {
      type: string; detail: unknown;
      constructor(type: string, options: { detail: unknown }) { this.type = type; this.detail = options.detail; }
    },
  });
  return {
    ui, hides, appliedHides, focusCalls, chatCalls, chat, settings: window.RabbitSettings,
    assistant: window.RabbitAssistant,
    onSuspended(listener: (event: { detail: boolean }) => void) { events.on('desktop:suspended', listener); },
    dismiss(id: number) { dismissListener(id); },
    suspend(value: boolean) { suspendedListener(value); },
    closeWithoutOwnership() { ui.chat = false; ui.opening = false; document.dispatchEvent({ type: 'chat:close', detail: {} }); },
    activate(activation: Activation) { mainEpoch = activation.activationId; return activationListener(activation); },
    showNative(activationId: number) { mainEpoch = activationId; },
    waitForChat(promise: Promise<void>) { activateChat = () => promise; },
    waitForSettings(promise: Promise<void>) { openSettings = async () => { await promise; ui.settings = true; }; },
  };
}

test('adapter 将所属激活轮次显式传给聊天和焦点 IPC', async () => {
  const app = loadAssistant();
  const anchor = { x: 120, y: 240 };
  await app.activate({ activationId: 7, view: 'prompt', anchor });
  assert.equal(app.chatCalls[0].options.activationId, 7);
  assert.deepEqual(app.chatCalls[0].options.anchor, anchor);
  assert.equal(await app.assistant.focusInput(7), true);
  assert.equal(await app.assistant.focusInput(6), false);
  assert.deepEqual(app.focusCalls, [7, 6]);
});

test('旧 A 取消和异步收尾只关闭 A，不撤销尚未送达 renderer 的 B', async () => {
  const app = loadAssistant(), pending = deferred();
  app.waitForChat(pending.promise);
  const activationA = app.activate({ activationId: 11, view: 'prompt' });
  // B 已在主进程展示，但它的 onActivate 尚未到达 renderer。
  app.showNative(12);
  app.chat.close();
  assert.deepEqual(app.hides, [11]);
  assert.deepEqual(app.appliedHides, []);
  pending.resolve(); await activationA;
  assert.ok(app.hides.every(id => id === 11));
  assert.deepEqual(app.appliedHides, []);
});

test('切换 settings 内部关闭旧 prompt 不隐藏新 settings', async () => {
  const app = loadAssistant(), pending = deferred();
  app.waitForChat(pending.promise);
  const activationA = app.activate({ activationId: 21, view: 'prompt' });
  await app.activate({ activationId: 22, view: 'settings' });
  assert.equal(app.ui.settings, true);
  assert.deepEqual(app.hides, []);
  pending.resolve(); await activationA;
  assert.deepEqual(app.hides, []);
  app.settings.close();
  assert.deepEqual(app.appliedHides, [22]);
});

test('异步焦点等待期间用户关闭 prompt 立即发送所属轮次 hide', async () => {
  const app = loadAssistant(), pending = deferred();
  app.waitForChat(pending.promise);
  const activation = app.activate({ activationId: 31, view: 'prompt' });
  app.ui.opening = false; app.ui.chat = true;
  app.chat.close();
  assert.deepEqual(app.appliedHides, [31]);
  pending.resolve(); await activation;
});

test('旧 handler 收尾不清理新 handler 正在激活的视图', async () => {
  const app = loadAssistant(), pendingA = deferred(), pendingB = deferred();
  app.waitForChat(pendingA.promise);
  const activationA = app.activate({ activationId: 41, view: 'prompt' });
  app.waitForSettings(pendingB.promise);
  const activationB = app.activate({ activationId: 42, view: 'settings' });
  pendingA.resolve(); await activationA;
  assert.deepEqual(app.hides, []);
  pendingB.resolve(); await activationB;
  assert.equal(app.ui.settings, true);
  assert.deepEqual(app.hides, []);
});

test('原生暂停仅转发明确的 suspended 事件', () => {
  const app = loadAssistant(), values: boolean[] = [];
  app.onSuspended(event => values.push(event.detail));
  app.suspend(true); app.suspend(false);
  assert.deepEqual(values, [true, false]);
  assert.deepEqual(app.hides, []);
});

test('无所属轮次的聊天关闭不会借用最新 native 激活', async () => {
  const app = loadAssistant();
  await app.activate({ activationId: 51, view: 'prompt' });
  app.closeWithoutOwnership();
  assert.deepEqual(app.hides, []);
});


test('再次激活的取消通知只关闭所属对话框，旧通知不能关闭新对话框', async () => {
  const app = loadAssistant();
  await app.activate({ activationId: 1, view: 'prompt' });
  app.dismiss(1);
  assert.equal(app.ui.chat, false);
  await app.activate({ activationId: 2, view: 'prompt' });
  app.dismiss(1);
  assert.equal(app.ui.chat, true);
  app.dismiss(2);
  assert.equal(app.ui.chat, false);
});
