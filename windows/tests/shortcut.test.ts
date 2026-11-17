import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_ACTIVATION_SHORTCUT, effectiveShortcutBindings, formatShortcut, isModifierCode, isSupportedShortcutCode, matchesShortcut, nativeShortcut, normalizeShortcut, shortcutAcceleratorBindings, shortcutToAccelerator } from '../electron/shortcut.ts';

test('默认触发键为左 Alt，规范化按固定修饰键顺序排列', () => {
  assert.deepEqual(DEFAULT_ACTIVATION_SHORTCUT, ['AltLeft']);
  const codes = ['KeyK', 'ShiftRight', 'MetaLeft', 'AltLeft', 'ControlRight'];
  assert.deepEqual(normalizeShortcut(codes), ['ControlRight', 'AltLeft', 'ShiftRight', 'MetaLeft', 'KeyK']);
  assert.deepEqual(codes, ['KeyK', 'ShiftRight', 'MetaLeft', 'AltLeft', 'ControlRight']);
});

test('支持单字母、数字、F24及仅修饰键组合', () => {
  for (const code of ['KeyA', 'Digit0', 'F24', 'AltRight']) assert.deepEqual(normalizeShortcut([code]), [code]);
  assert.deepEqual(normalizeShortcut(['MetaRight', 'ShiftRight', 'AltRight', 'ControlRight', 'ControlLeft']), ['ControlLeft', 'ControlRight', 'AltRight', 'ShiftRight', 'MetaRight']);
});

test('拒绝空组合、重复键、多个普通键及超过五键', () => {
  for (const invalid of [[], ['AltLeft', 'AltLeft'], ['KeyA', 'Digit1'], ['ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'ShiftLeft', 'KeyK']]) {
    assert.throws(() => normalizeShortcut(invalid));
  }
});

test('拒绝非数组、非字符串、Esc和不支持的 code', () => {
  for (const invalid of [null, undefined, 'AltLeft', {}, [1], ['Escape'], ['F25'], ['Digit10'], ['Alt'], ['a'], ['Unidentified'], ['constructor'], ['__proto__']]) {
    assert.throws(() => normalizeShortcut(invalid));
  }
});

test('显示文字明确区分左右修饰键和数字区', () => {
  assert.equal(formatShortcut(['AltLeft']), '左 Alt');
  assert.equal(formatShortcut(['AltRight']), '右 Alt');
  assert.equal(formatShortcut(['KeyK', 'ShiftRight', 'ControlLeft']), '左 Ctrl + 右 Shift + K');
  assert.equal(formatShortcut(['MetaRight'], 'darwin'), '右 ⌘');
  assert.equal(formatShortcut(['MetaLeft'], 'win32'), '左 Win');
  assert.equal(formatShortcut(['Numpad5']), '数字区 5');
  assert.equal(formatShortcut(['Digit0']), '0');
  assert.equal(formatShortcut(['F24']), 'F24');
});

test('触发匹配只要求配置成员按下，区分左右键并忽略额外按键', () => {
  const shortcut = ['AltLeft', 'KeyK'];
  const pressed = new Set(['KeyK', 'AltLeft']);
  assert.equal(matchesShortcut(shortcut, pressed), true);
  assert.equal(matchesShortcut(shortcut, new Set(['KeyK', 'AltRight'])), false);
  assert.equal(matchesShortcut(shortcut, new Set(['AltLeft'])), false);
  assert.equal(matchesShortcut(shortcut, new Set(['AltLeft', 'KeyK', 'ShiftLeft'])), true);
  assert.deepEqual([...pressed], ['KeyK', 'AltLeft']);
  assert.deepEqual(shortcut, ['AltLeft', 'KeyK']);
});

test('支持键与修饰键查询不把原型名称或相似名称视为有效键', () => {
  for (const code of ['ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'ShiftLeft', 'ShiftRight', 'MetaLeft', 'MetaRight']) {
    assert.equal(isModifierCode(code), true);
    assert.equal(isSupportedShortcutCode(code), true);
  }
  for (const code of ['KeyA', 'Digit1', 'F24', 'NumpadEnter']) {
    assert.equal(isModifierCode(code), false);
    assert.equal(isSupportedShortcutCode(code), true);
  }
  for (const code of ['Control', 'Escape', 'constructor', 'toString']) {
    assert.equal(isModifierCode(code), false);
    assert.equal(isSupportedShortcutCode(code), false);
  }
});

test('原生描述使用物理扫描码，区分扩展修饰键及数字区', () => {
  assert.deepEqual(nativeShortcut(['KeyQ']), [{ code: 'KeyQ', key: 0x10, modifier: false }]);
  assert.deepEqual(nativeShortcut(['KeyA']), [{ code: 'KeyA', key: 0x1e, modifier: false }]);
  assert.deepEqual(nativeShortcut(['AltRight', 'ControlLeft']), [
    { code: 'ControlLeft', key: 0x1d, modifier: true }, { code: 'AltRight', key: 0x138, modifier: true },
  ]);
  assert.equal(nativeShortcut(['ControlRight'])[0].key, 0x11d);
  assert.equal(nativeShortcut(['Enter'])[0].key, 0x1c);
  assert.equal(nativeShortcut(['NumpadEnter'])[0].key, 0x11c);
  assert.equal(nativeShortcut(['ArrowDown'])[0].key, 0x150);
  assert.equal(nativeShortcut(['Numpad2'])[0].key, 0x50);
  assert.equal(nativeShortcut(['F24'])[0].key, 0x76);
  // code 是物理位置，布局给出的字符不能冒充 code。
  assert.throws(() => nativeShortcut(['q']));
});

test('查询与描述生成不修改冻结输入，也不共享可变描述对象', () => {
  const codes = Object.freeze(['KeyK', 'AltRight']);
  const first = nativeShortcut(codes);
  first[0].key = -1;
  assert.equal(nativeShortcut(codes)[0].key, 0x138);
  assert.equal(formatShortcut(codes), '右 Alt + K');
  assert.equal(shortcutToAccelerator(codes, 'linux'), 'Alt+K');
  assert.deepEqual(codes, ['KeyK', 'AltRight']);
  assert.deepEqual(DEFAULT_ACTIVATION_SHORTCUT, ['AltLeft']);
});

test('非 Windows 普通键组合转换为对应平台 accelerator', () => {
  assert.equal(shortcutToAccelerator(['KeyK'], 'linux'), 'K');
  assert.equal(shortcutToAccelerator(['Digit0', 'ControlRight'], 'linux'), 'Control+0');
  assert.equal(shortcutToAccelerator(['KeyP', 'MetaRight', 'ShiftLeft', 'AltRight'], 'darwin'), 'Alt+Shift+Command+P');
  assert.equal(shortcutToAccelerator(['KeyP', 'MetaRight', 'ShiftLeft', 'AltRight'], 'linux'), 'Alt+Shift+Super+P');
  assert.equal(shortcutToAccelerator(['F24', 'ControlLeft'], 'darwin'), 'Control+F24');
  assert.equal(shortcutToAccelerator(['ArrowLeft', 'AltLeft'], 'linux'), 'Alt+Left');
});

test('非 Windows 不可表达的仅修饰键、同类双侧及数字区组合返回空值', () => {
  for (const platform of ['darwin', 'linux']) {
    assert.equal(shortcutToAccelerator(['AltLeft'], platform), undefined);
    assert.equal(shortcutToAccelerator(['ShiftLeft', 'ControlRight'], platform), undefined);
    assert.equal(shortcutToAccelerator(['KeyK', 'ControlLeft', 'ControlRight'], platform), undefined);
    assert.equal(shortcutToAccelerator(['KeyK', 'MetaLeft', 'MetaRight'], platform), undefined);
    assert.equal(shortcutToAccelerator(['Numpad1'], platform), undefined);
    assert.equal(shortcutToAccelerator(['IntlBackslash'], platform), undefined);
  }
});

test('图谱默认跟随本体组合，同键时仍保留两组原生绑定', () => {
  assert.deepEqual(effectiveShortcutBindings({ activationShortcut: DEFAULT_ACTIVATION_SHORTCUT, graphActivationShortcut: null, graphPluginEnabled: true }), {
    prompt: ['AltLeft'], graph: ['AltLeft'],
  });
  assert.deepEqual(effectiveShortcutBindings({ activationShortcut: ['KeyK', 'AltRight'], graphActivationShortcut: null, graphPluginEnabled: true }), {
    prompt: ['AltRight', 'KeyK'], graph: ['AltRight', 'KeyK'],
  });
});

test('本体和图谱独立保留左右按键，关闭图谱后仅恢复本体绑定', () => {
  const settings = { activationShortcut: ['KeyK', 'AltLeft'], graphActivationShortcut: ['KeyK', 'AltRight'], graphPluginEnabled: true };
  assert.deepEqual(effectiveShortcutBindings(settings), { prompt: ['AltLeft', 'KeyK'], graph: ['AltRight', 'KeyK'] });
  assert.deepEqual(effectiveShortcutBindings({ ...settings, graphPluginEnabled: false }), { prompt: ['AltLeft', 'KeyK'] });
  assert.deepEqual(shortcutAcceleratorBindings(effectiveShortcutBindings({ ...settings, graphPluginEnabled: false }), 'linux'), [
    { target: 'prompt', accelerator: 'Alt+K' },
  ]);
});

test('有效组合返回独立数组且不修改冻结设置', () => {
  const original = Object.freeze(['KeyK', 'ControlRight']);
  const settings = Object.freeze({ activationShortcut: original, graphActivationShortcut: null, graphPluginEnabled: true });
  const first = effectiveShortcutBindings(settings);
  first.prompt[0] = 'AltLeft';
  assert.deepEqual(first.graph, ['ControlRight', 'KeyK']);
  first.graph!.push('ShiftLeft');
  assert.deepEqual(effectiveShortcutBindings(settings), { prompt: ['ControlRight', 'KeyK'], graph: ['ControlRight', 'KeyK'] });
  assert.deepEqual(original, ['KeyK', 'ControlRight']);
});

test('相同组合的 accelerator 仅注册图谱路由', () => {
  for (const platform of ['darwin', 'linux']) {
    assert.deepEqual(shortcutAcceleratorBindings({ prompt: ['KeyK', 'ControlLeft'], graph: ['ControlLeft', 'KeyK'] }, platform), [
      { target: 'graph', accelerator: 'Control+K' },
    ]);
  }
});

test('非 Windows 左右修饰键折叠造成冲突时图谱优先', () => {
  for (const platform of ['darwin', 'linux']) {
    assert.deepEqual(shortcutAcceleratorBindings({ prompt: ['AltLeft', 'KeyK'], graph: ['AltRight', 'KeyK'] }, platform), [
      { target: 'graph', accelerator: 'Alt+K' },
    ]);
  }
});

test('不同 accelerator 分别保留对应路由并按图谱优先排序', () => {
  assert.deepEqual(shortcutAcceleratorBindings({ prompt: ['ControlLeft', 'KeyP'], graph: ['MetaRight', 'KeyG'] }, 'darwin'), [
    { target: 'graph', accelerator: 'Command+G' }, { target: 'prompt', accelerator: 'Control+P' },
  ]);
});

test('不可表达的组合独立略过，不影响另一组或制造备用快捷键', () => {
  assert.deepEqual(shortcutAcceleratorBindings({ prompt: ['AltLeft'], graph: ['AltRight'] }, 'linux'), []);
  assert.deepEqual(shortcutAcceleratorBindings({ prompt: ['ControlLeft', 'KeyP'], graph: ['ControlLeft', 'ControlRight', 'KeyG'] }, 'linux'), [
    { target: 'prompt', accelerator: 'Control+P' },
  ]);
  assert.deepEqual(shortcutAcceleratorBindings({ prompt: ['Numpad1'], graph: ['KeyG'] }, 'linux'), [
    { target: 'graph', accelerator: 'G' },
  ]);
});
