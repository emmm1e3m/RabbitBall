import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_ACTIVATION_SHORTCUT, formatShortcut, isModifierCode, isSupportedShortcutCode, matchesShortcut, nativeShortcut, normalizeShortcut, shortcutToAccelerator } from '../electron/shortcut.ts';

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

test('触发匹配要求按住集合完全相同，左右键和额外按键均有区别', () => {
  const shortcut = ['AltLeft', 'KeyK'];
  const pressed = new Set(['KeyK', 'AltLeft']);
  assert.equal(matchesShortcut(shortcut, pressed), true);
  assert.equal(matchesShortcut(shortcut, new Set(['KeyK', 'AltRight'])), false);
  assert.equal(matchesShortcut(shortcut, new Set(['AltLeft'])), false);
  assert.equal(matchesShortcut(shortcut, new Set(['AltLeft', 'KeyK', 'ShiftLeft'])), false);
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
