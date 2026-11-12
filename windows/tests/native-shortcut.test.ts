import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createWindowsNative } from '../electron/windows-native.ts';

const windows = process.platform === 'win32';

test('原生启动键状态机通过按压、释放、取消与配置校验', { skip: !windows }, () => {
  const script = fileURLToPath(new URL('../electron/windows-native.ps1', import.meta.url));
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script, '-ValidateOnly'], {
    encoding: 'utf8', windowsHide: true, timeout: 15000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const validation = JSON.parse(result.stdout.trim());
  assert.equal(validation.type, 'validated');
  assert.ok(validation.tests > 0);
});

test('原生助手启动并确认启动键配置', { skip: !windows, timeout: 15000 }, async () => {
  let nativeFailure = false;
  const native = createWindowsNative({
    onTriggerBegin() {}, onTriggerHold() {}, onTriggerEnd() {}, onTriggerCancel() {},
    onSelectionPointer() {}, onPointerDown() {}, onPointerUp() {}, onFullscreen() {},
    onError() { nativeFailure = true; },
  });
  try {
    await native.ready;
    // 只验证配置回执，不启用输入拦截或改变任何窗口。
    await native.configure({
      pauseOnFullscreen: false, inputEnabled: false, allowOwnForeground: false, recording: false,
      shortcut: [{ code: 'AltLeft', key: 0x38, modifier: true }],
    });
    await assert.rejects(native.beginSelection(), /无法开始屏幕框选/, '禁用输入时不能暗中进入手动框选');
    assert.equal(await native.prepareOverlayWindow('0'), false);
    assert.equal(await native.prepareOverlayWindow('not-a-handle'), false);
    assert.equal(nativeFailure, false);
  } finally {
    native.stop();
  }
});
