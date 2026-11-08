export const DEFAULT_ACTIVATION_SHORTCUT = Object.freeze(['AltLeft']);

const modifierCodes = ['ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'ShiftLeft', 'ShiftRight', 'MetaLeft', 'MetaRight'];
// Windows Set 1 扫描码与 DOM code 对应；0x100 表示扩展键，不依赖当前输入法布局。
const physicalKeys: Record<string, number> = {
  ControlLeft: 0x1d, ControlRight: 0x11d, AltLeft: 0x38, AltRight: 0x138,
  ShiftLeft: 0x2a, ShiftRight: 0x36, MetaLeft: 0x15b, MetaRight: 0x15c,
  KeyQ: 0x10, KeyW: 0x11, KeyE: 0x12, KeyR: 0x13, KeyT: 0x14, KeyY: 0x15, KeyU: 0x16, KeyI: 0x17, KeyO: 0x18, KeyP: 0x19,
  KeyA: 0x1e, KeyS: 0x1f, KeyD: 0x20, KeyF: 0x21, KeyG: 0x22, KeyH: 0x23, KeyJ: 0x24, KeyK: 0x25, KeyL: 0x26,
  KeyZ: 0x2c, KeyX: 0x2d, KeyC: 0x2e, KeyV: 0x2f, KeyB: 0x30, KeyN: 0x31, KeyM: 0x32,
  Digit1: 0x02, Digit2: 0x03, Digit3: 0x04, Digit4: 0x05, Digit5: 0x06, Digit6: 0x07, Digit7: 0x08, Digit8: 0x09, Digit9: 0x0a, Digit0: 0x0b,
  Enter: 0x1c, Space: 0x39, Tab: 0x0f, Backspace: 0x0e, CapsLock: 0x3a,
  Insert: 0x152, Delete: 0x153, Home: 0x147, End: 0x14f, PageUp: 0x149, PageDown: 0x151,
  ArrowLeft: 0x14b, ArrowRight: 0x14d, ArrowUp: 0x148, ArrowDown: 0x150,
  Backquote: 0x29, Minus: 0x0c, Equal: 0x0d, BracketLeft: 0x1a, BracketRight: 0x1b, Backslash: 0x2b,
  Semicolon: 0x27, Quote: 0x28, Comma: 0x33, Period: 0x34, Slash: 0x35, IntlBackslash: 0x56,
  Numpad0: 0x52, Numpad1: 0x4f, Numpad2: 0x50, Numpad3: 0x51, Numpad4: 0x4b, Numpad5: 0x4c, Numpad6: 0x4d, Numpad7: 0x47, Numpad8: 0x48, Numpad9: 0x49,
  NumpadEnter: 0x11c, NumpadAdd: 0x4e, NumpadSubtract: 0x4a, NumpadMultiply: 0x37, NumpadDivide: 0x135, NumpadDecimal: 0x53,
};
for (let key = 1; key <= 10; key++) physicalKeys['F' + key] = 0x3a + key;
physicalKeys.F11 = 0x57; physicalKeys.F12 = 0x58;
for (let key = 13; key <= 23; key++) physicalKeys['F' + key] = 0x64 + key - 13;
physicalKeys.F24 = 0x76;

export function isModifierCode(code: string): boolean { return modifierCodes.includes(code); }
export function isSupportedShortcutCode(code: string): boolean { return Object.hasOwn(physicalKeys, code); }

export function normalizeShortcut(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 5 || value.some(code => typeof code !== 'string' || !isSupportedShortcutCode(code))) throw new Error('请选择 1 到 5 个受支持的按键，Esc 仅用于取消录制。');
  const codes = value as string[];
  if (new Set(codes).size !== codes.length) throw new Error('触发组合不能包含重复按键。');
  if (codes.filter(code => !isModifierCode(code)).length > 1) throw new Error('组合键最多包含一个普通键，其余应为修饰键。');
  return [...codes].sort((a, b) => {
    const first = modifierCodes.indexOf(a), second = modifierCodes.indexOf(b);
    return (first < 0 ? modifierCodes.length : first) - (second < 0 ? modifierCodes.length : second);
  });
}

export function formatShortcut(codes: readonly string[], platform = 'win32'): string {
  const labels: Record<string, string> = {
    ControlLeft: '左 Ctrl', ControlRight: '右 Ctrl', AltLeft: '左 Alt', AltRight: '右 Alt', ShiftLeft: '左 Shift', ShiftRight: '右 Shift',
    MetaLeft: platform === 'darwin' ? '左 ⌘' : '左 Win', MetaRight: platform === 'darwin' ? '右 ⌘' : '右 Win',
    Space: '空格', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', CapsLock: 'Caps Lock',
    ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓',
    Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
  };
  return normalizeShortcut(codes).map(code => labels[code] ?? code.replace(/^Key|^Digit/, '').replace(/^Numpad/, '数字区 ')).join(' + ');
}

export function matchesShortcut(shortcut: readonly string[], pressed: ReadonlySet<string>): boolean {
  return shortcut.every(code => pressed.has(code));
}

export interface NativeShortcutKey { code: string; key: number; modifier: boolean }
export function nativeShortcut(codes: readonly string[]): NativeShortcutKey[] {
  return normalizeShortcut(codes).map(code => ({ code, key: physicalKeys[code]!, modifier: isModifierCode(code) }));
}

export function shortcutToAccelerator(codes: readonly string[], platform: string): string | undefined {
  const normalized = normalizeShortcut(codes), ordinary = normalized.find(code => !isModifierCode(code));
  if (!ordinary) return undefined;
  const modifiers = normalized.filter(isModifierCode).map(code => code.startsWith('Control') ? 'Control' : code.startsWith('Shift') ? 'Shift' : code.startsWith('Alt') ? 'Alt' : platform === 'darwin' ? 'Command' : 'Super');
  if (new Set(modifiers).size !== modifiers.length) return undefined;
  const names: Record<string, string> = { ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down', Enter: 'Return', NumpadEnter: 'Return', Backspace: 'Backspace', Space: 'Space', Tab: 'Tab', CapsLock: 'Capslock', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`' };
  const key = /^Key[A-Z]$|^Digit[0-9]$/.test(ordinary) ? ordinary.replace(/^Key|^Digit/, '') : /^(F([1-9]|1[0-9]|2[0-4])|Insert|Delete|Home|End|PageUp|PageDown)$/.test(ordinary) ? ordinary : names[ordinary];
  return key ? [...modifiers, key].join('+') : undefined;
}
