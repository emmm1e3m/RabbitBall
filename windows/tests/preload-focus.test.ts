import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import type { RabbitDesktop } from '../electron/contracts.ts';

test('焦点和关闭 IPC 保留调用方持有的激活轮次', async () => {
  const events = new EventEmitter();
  const calls: Array<{ channel: string; value: unknown }> = [];
  const sends: Array<{ channel: string; value: unknown; owner?: unknown; color?: unknown }> = [];
  let bridge: RabbitDesktop | undefined;
  const source = readFileSync(new URL('../electron/preload.cts', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '');
  const javascript = stripTypeScriptTypes(source);
  vm.runInNewContext(javascript, {
    contextBridge: { exposeInMainWorld(_name: string, desktop: RabbitDesktop) { bridge = desktop; } },
    ipcRenderer: {
      on: events.on.bind(events), removeListener: events.removeListener.bind(events),
      send(channel: string, value: unknown, ...args: unknown[]) { sends.push({ channel, value, ...(args.length ? { owner: args[0] } : {}), ...(args.length > 1 ? { color: args[1] } : {}) }); },
      async invoke(channel: string, value: unknown) { calls.push({ channel, value }); return false; },
    },
    process: { platform: 'win32' },
  });
  assert.ok(bridge);
  bridge.onActivate(() => {});
  events.emit('rabbit:activate', {}, { activationId: 1, view: 'prompt' });
  await bridge.focusInput(1);
  assert.equal(calls.at(-1)?.value, 1);
  // 新事件送达也不会替旧动画或旧关闭事件换成新轮次。
  events.emit('rabbit:activate', {}, { activationId: 2, view: 'prompt' });
  await bridge.focusInput(1);
  assert.equal(calls.at(-1)?.value, 1);
  bridge.hidePanel(1);
  assert.deepEqual(sends.at(-1), { channel: 'rabbit:hide-panel', value: 1 });
  const origin = { x: 640, y: 360 };
  bridge.playActivationEffect(origin, 1, '#8844cc');
  assert.deepEqual(sends.at(-1), { channel: 'rabbit:activation-effect', value: origin, owner: 1, color: '#8844cc' });
  await bridge.focusInput(2);
  assert.equal(calls.at(-1)?.value, 2);
  events.emit('rabbit:activate', {}, { activationId: 3, view: 'settings' });
  bridge.hidePanel(2);
  assert.deepEqual(sends.at(-1), { channel: 'rabbit:hide-panel', value: 2 });
  bridge.setInteractive(false, 2);
  assert.deepEqual(sends.at(-1), { channel: 'rabbit:set-interactive', value: false, owner: 2 });
  bridge.setInteractive(true);
  assert.deepEqual(sends.at(-1), { channel: 'rabbit:set-interactive', value: true, owner: 3 });
  // 固定卡片在面板关闭后继续存在，命中区域不绑定上一面板的激活轮次。
  const pins = { rects: [{ x: 120, y: 0, width: 180, height: 42 }] };
  bridge.setGraphPinRegions(pins);
  assert.deepEqual(sends.at(-1), { channel: 'rabbit:set-graph-pin-regions', value: pins });
  const interaction = { phase: 'down' as const, point: { x: 150, y: 20 } };
  assert.equal(await bridge.graphPinInteraction(interaction), false);
  assert.deepEqual(calls.at(-1), { channel: 'rabbit:graph-pin-interaction', value: interaction });
});
