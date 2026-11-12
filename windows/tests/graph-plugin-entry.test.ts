import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { DEFAULT_PROMPTS } from '../electron/prompts.ts';
import * as shortcut from '../electron/shortcut.ts';

// 执行完整设置组件，只替换浏览器与桌面桥边界。
function settings(initial: Record<string, unknown> = {}) {
  const events: any[] = [], patches: any[] = [], listeners = new Map<string, Array<(event: any) => void>>();
  let document: any, stored = { graphPluginEnabled: true, ...initial };
  class Element {
    children: Element[] = []; parentElement: Element | null = null; id = ''; value = ''; textContent = '';
    inert = false; disabled = false; checked = false; hidden = false; tabIndex = 0;
    attributes: Record<string, string> = {}; dataset: Record<string, string> = {};
    classes = new Set<string>(); handlers = new Map<string, Array<(event: any) => unknown>>();
    style: any = { setProperty(name: string, value: string) { this[name] = value; } };
    tagName: string;
    constructor(tagName: string) { this.tagName = tagName; }
    get className() { return [...this.classes].join(' '); }
    set className(value: string) { this.classes = new Set(value.split(/\s+/).filter(Boolean)); }
    classList = {
      add: (...names: string[]) => names.forEach(name => this.classes.add(name)),
      remove: (...names: string[]) => names.forEach(name => this.classes.delete(name)),
      contains: (name: string) => this.classes.has(name),
      toggle: (name: string, force = !this.classes.has(name)) => force ? this.classes.add(name) : this.classes.delete(name)
    };
    get isConnected() { return document.body.contains(this); }
    contains(node: Element): boolean { return this === node || this.children.some(child => child.contains(node)); }
    setAttribute(name: string, value: string) {
      this.attributes[name] = value;
      if (name === 'id') this.id = value;
      if (name === 'class') this.className = value;
      if (name === 'inert') this.inert = true;
      if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
    }
    removeAttribute(name: string) { delete this.attributes[name]; }
    appendChild(child: Element) { child.parentElement = this; this.children.push(child); return child; }
    replaceChildren(...children: Element[]) { this.children = []; children.forEach(child => this.appendChild(child)); }
    querySelectorAll(selector: string): Element[] {
      const matches = (node: Element) => selector.split(',').some(part => part.startsWith('.') ? node.classes.has(part.slice(1)) : part.startsWith('#') ? node.id === part.slice(1) : node.tagName === part);
      return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
    }
    querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
    set innerHTML(markup: string) {
      this.children = []; const stack: Element[] = [this];
      for (const tag of markup.matchAll(/<\/?([a-z][\w-]*)([^>]*)>/gi)) {
        if (tag[0].startsWith('</')) { if (stack.length > 1) stack.pop(); continue; }
        const element = new Element(tag[1]);
        for (const attr of tag[2].matchAll(/([\w:-]+)(?:="([^"]*)")?/g)) element.setAttribute(attr[1], attr[2] ?? '');
        stack.at(-1)!.appendChild(element);
        if (!tag[0].endsWith('/>') && !['input', 'img', 'br'].includes(tag[1])) stack.push(element);
      }
    }
    addEventListener(type: string, listener: (event: any) => unknown) { const handlers = this.handlers.get(type) ?? []; handlers.push(listener); this.handlers.set(type, handlers); }
    getBoundingClientRect() { return { x: 0, y: 0, width: 1200, height: 800 }; }
    focus() { document.activeElement = this; }
    click() { if (!this.disabled) return this.fire('click'); }
    fire(type: string) { return Promise.all((this.handlers.get(type) ?? []).map(handler => handler({ type, preventDefault() {}, stopPropagation() {} }))); }
  }
  const body = new Element('body'), scene = new Element('div'); scene.id = 'scene'; body.appendChild(scene);
  document = { body, head: new Element('head'), documentElement: body, activeElement: body,
    createElement: (tag: string) => new Element(tag), getElementById: (id: string) => body.querySelector('#' + id),
    querySelector: (selector: string) => body.querySelector(selector), querySelectorAll: (selector: string) => body.querySelectorAll(selector),
    addEventListener(type: string, listener: (event: any) => void) { const callbacks = listeners.get(type) ?? []; callbacks.push(listener); listeners.set(type, callbacks); },
    dispatchEvent(event: any) { events.push(event); for (const listener of listeners.get(event.type) ?? []) listener(event); }
  };
  const window: any = { RabbitShortcut: shortcut, RabbitPromptDefaults: DEFAULT_PROMPTS, addEventListener() {}, rabbitDesktop: {
    loadSettings: async () => stored,
    saveSettings: async (patch: any) => { patches.push(patch); stored = { ...stored, ...patch }; return stored; }
  } };
  const context = vm.createContext({ window, document, requestAnimationFrame() {}, ResizeObserver: class { observe() {} },
    CustomEvent: class { type: string; detail: unknown; constructor(type: string, options: any) { this.type = type; this.detail = options.detail; } }
  });
  for (const file of ['prompts.js', 'settings-ui.js']) vm.runInContext(readFileSync(new URL('../prototype/' + file, import.meta.url), 'utf8'), context, { filename: file });
  return { api: window.RabbitSettings, window, document, events, patches,
    loadAssistant() {
      for (const name of ['onCaptureEvent','onDismiss','onActivate','onCursor','onPointerDown','onSuspended','onSettingsChanged']) window.rabbitDesktop[name]=()=>{};
      vm.runInContext(readFileSync(new URL('../prototype/assistant.js', import.meta.url),'utf8'),context,{filename:'assistant.js'});
    },
    buttons: () => scene.querySelectorAll('.rs-plugin-action'), find: (selector: string) => scene.querySelector(selector)! };
}

test('插件页图标入口含撤销重做，经统一事件分发并保留未保存草稿', async () => {
  const page = settings(); await page.api.open({ tab: 'plugins' });
  assert.equal(page.api.getSnapshot().tab, 'plugins');
  const expected = [
    ['open', '进入图谱', 'graph:activate', undefined],
    ['reveal', '打开文档文件夹', 'graph:reveal', 'reveal'], ['rename-graph', '重命名当前图谱', 'graph:activate', 'rename-graph'],
    ['undo', '撤销（Ctrl+Z）', 'graph:activate', 'undo'], ['redo', '重做（Ctrl+Shift+Z / Ctrl+Y）', 'graph:activate', 'redo']
  ];
  const model = page.find('#rabbit-model'); model.value = 'deepseek-v4-pro'; await model.fire('input');
  const buttons = page.buttons(); assert.equal(buttons.length, expected.length);
  for (const [index, button] of buttons.entries()) {
    const [action, label, type, detail] = expected[index];
    assert.equal(button.dataset.graphAction, action); assert.equal(button.attributes['aria-label'], label);
    assert.equal(button.attributes.title, label); assert.ok(button.querySelector('svg'));
    await button.click(); assert.equal(page.events.at(-1).type, type); assert.equal(page.events.at(-1).detail.action, detail);
  }
  assert.equal(page.api.getSnapshot().open, true, '入口把关闭与激活交由宿主管理');
  assert.equal(page.api.getSnapshot().draft.model, 'deepseek-v4-pro');
  assert.equal(page.api.getSnapshot().settings.model, 'deepseek-flash');
  assert.equal(page.patches.length, 0, '入口不能顺便保存设置');
});

test('插件入口只在已保存启用且当前草稿未停用时可操作', async () => {
  const page = settings({ graphPluginEnabled: false }); await page.api.open({ tab: 'plugins' });
  assert.ok(page.buttons().every(button => button.disabled));
  const toggle = page.find('#rabbit-graph-plugin'); toggle.checked = true; await toggle.fire('change');
  assert.ok(page.buttons().every(button => button.disabled), '勾选但未保存不能绕过插件开关');
  await page.find('#rabbit-settings-form').fire('submit'); await page.api.open({ tab: 'plugins' });
  assert.ok(page.buttons().every(button => !button.disabled));
  toggle.checked = false; await toggle.fire('change');
  assert.ok(page.buttons().every(button => button.disabled));
  const before = page.events.length; await page.buttons()[0].click(); assert.equal(page.events.length, before);
  page.api.close(); await page.api.open({ tab: 'plugins' });
  assert.ok(page.buttons().every(button => !button.disabled), '取消停用草稿后恢复入口');
});

test('保存期间不能从插件入口重入图谱，保存完成后恢复', async () => {
  const page = settings(); await page.api.open({ tab: 'plugins' });
  let finish!: (value: any) => void;
  page.window.rabbitDesktop.saveSettings = (patch: any) => new Promise(resolve => { finish = () => resolve(patch); });
  const saving = page.find('#rabbit-settings-form').fire('submit');
  await Promise.resolve(); assert.equal(page.api.getSnapshot().saving, true);
  assert.ok(page.buttons().every(button => button.disabled));
  finish({}); await saving; await page.api.open({ tab: 'plugins' });
  assert.ok(page.buttons().every(button => !button.disabled));
});

test('插件入口失败显示在设置状态区，重试清除旧错误且迟到错误不重新打开设置', async () => {
  const page = settings(); await page.api.open({ tab: 'plugins' });
  await page.buttons()[1].click();
  page.document.dispatchEvent({ type: 'graph:entry-error', detail: { message: '无法打开工作区文件夹。' } });
  const status = page.find('.rs-status');
  assert.equal(status.textContent, '无法打开工作区文件夹。');
  assert.equal(status.attributes['aria-live'], 'polite');
  await page.buttons()[1].click(); assert.equal(status.textContent, '');
  page.api.close();
  page.document.dispatchEvent({ type: 'graph:entry-error', detail: { message: '迟到错误' } });
  assert.equal(page.api.getSnapshot().open, false); assert.equal(status.textContent, '');
  assert.equal(page.patches.length, 0);
});

test('打开文档文件夹直接调用当前工作区目录入口，不激活图谱或截图', async () => {
  const page=settings(),calls:any[]=[];
  page.window.RabbitGraph={getSnapshot:()=>({workspaceId:'reading'}),isOpen:()=>false};
  Object.assign(page.window.rabbitDesktop,{
    graphOpen:async(id:string)=>{calls.push(['open',id]);return{id};},
    graphRevealDocument:async(id:string)=>{calls.push(['folder',id]);},
    graphActivate:async()=>{calls.push(['activate']);},graphCapture:async()=>{calls.push(['capture']);}
  });
  page.loadAssistant();await page.api.open({tab:'plugins'});
  const folder=page.buttons().find(button=>button.attributes['aria-label']==='打开文档文件夹')!;
  await folder.click();await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(calls,[['open','reading'],['folder','reading']]);
  assert.equal(page.api.getSnapshot().open,true);
  assert.equal(page.events.filter(event=>event.type==='graph:activate').length,0);
});
