import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

// 事件夹具保留捕获/冒泡顺序，原生编辑由调用记录替代，不模拟第二套撤销栈。
function fixture(nativeBridge = true) {
  type Listener = { run: (event: any) => void; capture: boolean };
  const documentListeners = new Map<string, Listener[]>(), windowListeners = new Map<string, Array<() => void>>();
  const calls: Array<{ action: string; active: Element; start: number | null; end: number | null; bridge: boolean }> = [];
  const enabled = new Map([['undo', true], ['redo', true]]);
  let document: any;
  class Element {
    tagName: string; id = ''; type = ''; value = ''; hidden = false; disabled = false; readOnly = false;
    selectionStart: number | null = 1; selectionEnd: number | null = 3; textContent = ''; clientWidth = 800; clientHeight = 600;
    offsetWidth = 156; offsetHeight = 220; style: any = {}; dataset: Record<string, string> = {};
    parentElement: Element | null = null; children: Element[] = []; attributes: Record<string, string> = {};
    handlers = new Map<string, Array<(event: any) => void>>(); classes = new Set<string>();
    classList = { remove: (name: string) => this.classes.delete(name), toggle: (name: string, force: boolean) => force ? this.classes.add(name) : this.classes.delete(name) };
    constructor(tag: string) { this.tagName = tag.toUpperCase(); }
    get isConnected() { return document.body.contains(this); }
    appendChild(child: Element) { child.parentElement = this; this.children.push(child); return child; }
    contains(child: Element): boolean { return this === child || this.children.some(node => node.contains(child)); }
    setAttribute(name: string, value: string) { this.attributes[name] = value; if (name.startsWith('data-')) this.dataset[name.slice(5)] = value; }
    matches(selector: string): boolean {
      return selector.split(',').some(part => {
        if (part === '.chat-input') return this.classes.has('chat-input');
        if (part === 'input:not([type])') return this.tagName === 'INPUT' && !this.type;
        const input = part.match(/^input\[type="([^"]+)"\]$/);
        return input ? this.tagName === 'INPUT' && this.type === input[1] : this.tagName.toLowerCase() === part;
      });
    }
    closest(selector: string): Element | null { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
    querySelectorAll(selector: string): Element[] { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
    set innerHTML(markup: string) {
      this.children = [];
      for (const match of markup.matchAll(/<button\b[^>]*data-action="([^"]+)"[^>]*>([\s\S]*?)<\/button>/g)) {
        const button = new Element('button'); button.dataset.action = match[1]; button.textContent = match[2].replace(/<[^>]*>/g, ''); this.appendChild(button);
      }
    }
    addEventListener(type: string, run: (event: any) => void) { if (!this.handlers.has(type)) this.handlers.set(type, []); this.handlers.get(type)!.push(run); }
    focus() { document.activeElement = this; }
    getBoundingClientRect() { return { left: 0, top: 0, right: this.clientWidth, bottom: this.clientHeight, width: this.clientWidth, height: this.clientHeight }; }
  }
  const body = new Element('body'), head = new Element('head'), scene = new Element('div'); scene.id = 'scene'; body.appendChild(scene);
  function record(action: string, bridge: boolean) {
    const active = document.activeElement as Element;
    calls.push({ action, active, start: active.selectionStart, end: active.selectionEnd, bridge });
  }
  document = {
    body, head, activeElement: body, createElement: (tag: string) => new Element(tag), getElementById: () => scene,
    queryCommandEnabled: (action: string) => enabled.get(action) ?? true,
    execCommand: (action: string) => { record(action, false); return true; },
    addEventListener(type: string, run: (event: any) => void, capture = false) { if (!documentListeners.has(type)) documentListeners.set(type, []); documentListeners.get(type)!.push({ run, capture }); },
    dispatchEvent(event: any) { for (const listener of documentListeners.get(event.type) || []) listener.run(event); },
  };
  const window: any = {
    addEventListener(type: string, run: () => void) { if (!windowListeners.has(type)) windowListeners.set(type, []); windowListeners.get(type)!.push(run); },
  };
  if (nativeBridge) window.rabbitDesktop = { editText: async (action: string) => record(action, true), readClipboardForPaste: async () => ({ text: '' }) };
  vm.runInNewContext(readFileSync(new URL('../prototype/edit-menu.js', import.meta.url), 'utf8'), {
    document, window, console, navigator: { clipboard: { readText: async () => '' } },
    CustomEvent: class { type: string; detail: unknown; constructor(type: string, options: any) { this.type = type; this.detail = options?.detail; } },
  }, { filename: 'edit-menu.js' });
  const menu = scene.children.find(child => child.id === 'rabbit-edit-menu')!;
  function emit(type: string, target: Element, values: Record<string, unknown> = {}) {
    const event: any = { type, target, key: '', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, clientX: 40, clientY: 40,
      defaultPrevented: false, stopped: false, immediate: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; },
      stopImmediatePropagation() { this.stopped = true; this.immediate = true; }, ...values };
    for (const listener of documentListeners.get(type) || []) if (listener.capture) { listener.run(event); if (event.immediate) break; }
    if (!event.stopped) for (let element: Element | null = target; element; element = element.parentElement) {
      for (const run of element.handlers.get(type) || []) { run(event); if (event.immediate) break; }
      if (event.stopped) break;
    }
    if (!event.stopped) for (const listener of documentListeners.get(type) || []) if (!listener.capture) { listener.run(event); if (event.immediate) break; }
    if (type === 'pointerdown' && !event.defaultPrevented) target.focus();
    return event;
  }
  return { document, window, scene, menu, calls, enabled, emit,
    input(tag = 'textarea', type = '') { const input = new Element(tag); input.type = type; input.value = '原始文字'; scene.appendChild(input); input.focus(); return input; },
    action(name: string) { return menu.querySelectorAll('button').find(button => button.dataset.action === name)!; },
    blur() { for (const run of windowListeners.get('blur') || []) run(); },
  };
}

test('输入撤销快捷键在捕获阶段阻断图谱撤销，只转发原生undo和redo', async () => {
  for (const nativeBridge of [true, false]) {
    const app = fixture(nativeBridge), input = app.input(); let graphUndo = 0, laterCapture = 0;
    app.document.addEventListener('keydown', () => graphUndo++);
    app.document.addEventListener('keydown', () => laterCapture++, true);
    for (const [key, modifiers, action] of [
      ['z', { ctrlKey: true }, 'undo'], ['Z', { ctrlKey: true, shiftKey: true }, 'redo'],
      ['y', { ctrlKey: true }, 'redo'], ['z', { metaKey: true }, 'undo'],
    ] as const) {
      const event = app.emit('keydown', input, { key, ...modifiers }); await flush();
      assert.equal(event.defaultPrevented, true); assert.equal(event.immediate, true);
      assert.equal(app.calls.at(-1)?.action, action); assert.equal(app.calls.at(-1)?.active, input);
      assert.equal(app.calls.at(-1)?.bridge, nativeBridge);
    }
    assert.equal(app.calls.length, 4); assert.equal(graphUndo, 0); assert.equal(laterCapture, 0);
    assert.equal(input.value, '原始文字'); assert.equal(input.selectionStart, 1); assert.equal(input.selectionEnd, 3);
  }
});

test('IME合成中的撤销保留原生输入法行为并阻断图谱，合成结束或失焦后恢复', async () => {
  const app = fixture(), input = app.input(); let graphUndo = 0;
  app.document.addEventListener('keydown', () => graphUndo++);
  for (const composing of [{ isComposing: true }, { keyCode: 229 }]) {
    const event = app.emit('keydown', input, { key: 'z', ctrlKey: true, ...composing });
    assert.equal(event.defaultPrevented, false); assert.equal(event.immediate, true);
  }
  app.emit('compositionstart', input);
  const active = app.emit('keydown', input, { key: 'y', ctrlKey: true });
  assert.equal(active.defaultPrevented, false); assert.equal(active.immediate, true);
  assert.equal(app.calls.length, 0); assert.equal(graphUndo, 0);
  app.emit('contextmenu', input); assert.equal(app.action('undo').disabled, true); assert.equal(app.action('redo').disabled, true);
  app.emit('compositionend', input); app.emit('keydown', input, { key: 'z', ctrlKey: true }); await flush();
  assert.equal(app.calls.at(-1)?.action, 'undo');
  app.emit('compositionstart', input); app.blur(); app.emit('keydown', input, { key: 'y', ctrlKey: true }); await flush();
  assert.equal(app.calls.at(-1)?.action, 'redo'); assert.equal(app.calls.length, 2);
});

test('只读输入不执行撤销写入，禁用原生历史的菜单操作不可触发', async () => {
  const app = fixture(), input = app.input(); input.readOnly = true;
  for (const key of ['z', 'y']) {
    const event = app.emit('keydown', input, { key, ctrlKey: true });
    assert.equal(event.defaultPrevented, true); assert.equal(event.immediate, true);
  }
  app.emit('contextmenu', input); assert.equal(app.action('undo').disabled, true); assert.equal(app.action('redo').disabled, true);
  app.emit('click', app.action('undo')); assert.equal(app.calls.length, 0);
  input.readOnly = false; app.enabled.set('undo', false); app.emit('contextmenu', input);
  assert.equal(app.action('undo').disabled, true); assert.equal(app.action('redo').disabled, false);
  app.emit('click', app.action('undo')); await flush(); assert.equal(app.calls.length, 0);
});

test('菜单撤销与重做保留输入焦点和选区，分别走桌面桥或浏览器原生命令', async () => {
  for (const nativeBridge of [true, false]) {
    const app = fixture(nativeBridge), input = app.input('input', 'text');
    for (const action of ['undo', 'redo']) {
      app.emit('contextmenu', input); assert.equal(app.menu.hidden, false);
      const button = app.action(action); assert.ok(button); assert.equal(button.disabled, false);
      const down = app.emit('pointerdown', button); assert.equal(down.defaultPrevented, true);
      assert.equal(app.document.activeElement, input);
      app.emit('click', button); await flush();
      assert.equal(app.menu.hidden, true);
      assert.deepEqual(app.calls.at(-1), { action, active: input, start: 1, end: 3, bridge: nativeBridge });
    }
    assert.equal(input.value, '原始文字');
  }
});

test('没有selectionStart的数字和邮箱输入按原生命令状态显示复制剪切', async () => {
  for(const type of ['number','email']){
    const app=fixture(),input=app.input('input',type);input.selectionStart=null;input.selectionEnd=null;
    app.enabled.set('copy',true);app.enabled.set('cut',true);app.emit('contextmenu',input);
    assert.equal(app.action('copy').disabled,false);assert.equal(app.action('cut').disabled,false);
    app.emit('click',app.action('copy'));await flush();assert.equal(app.calls.at(-1)?.action,'copy');
    input.readOnly=true;app.emit('contextmenu',input);assert.equal(app.action('copy').disabled,false);assert.equal(app.action('cut').disabled,true);
    input.readOnly=false;app.enabled.set('copy',false);app.enabled.set('cut',false);app.emit('contextmenu',input);
    assert.equal(app.action('copy').disabled,true);assert.equal(app.action('cut').disabled,true);
  }
  const text=fixture(),input=text.input('input','text');input.selectionEnd=input.selectionStart;
  text.enabled.set('copy',true);text.emit('contextmenu',input);assert.equal(text.action('copy').disabled,true,'普通文字输入仍使用实际选区');
});

test('图谱开关和上下文切换关闭编辑菜单并作废迟到粘贴，稳定刷新不打断输入', async () => {
  for(const type of ['graph:open','graph:close','graph:contextchange','graph:changed']){
    const app=fixture(),input=app.input();let resolve!:(value:{text:string})=>void;
    app.window.rabbitDesktop.readClipboardForPaste=()=>new Promise(done=>{resolve=done;});
    app.emit('contextmenu',input);assert.equal(app.menu.hidden,false);
    const pending=app.window.RabbitEditMenu.paste(input);
    app.document.dispatchEvent({type,detail:{}});resolve({text:'迟到的文字'});await pending;
    const stable=type==='graph:changed';
    assert.equal(app.menu.hidden,!stable,type);
    assert.equal(app.calls.filter(call=>call.action==='insertText').length,Number(stable),type);
  }
});

test('非编辑区、Alt组合和禁用输入仍交给原来的快捷键路径', () => {
  const app = fixture(), input = app.input(); let forwarded = 0;
  app.document.addEventListener('keydown', () => forwarded++);
  const outside = app.emit('keydown', app.scene, { key: 'z', ctrlKey: true });
  const alt = app.emit('keydown', input, { key: 'z', ctrlKey: true, altKey: true });
  input.disabled = true;
  const disabled = app.emit('keydown', input, { key: 'y', ctrlKey: true });
  for (const event of [outside, alt, disabled]) { assert.equal(event.defaultPrevented, false); assert.equal(event.immediate, false); }
  assert.equal(forwarded, 3); assert.equal(app.calls.length, 0);
});
