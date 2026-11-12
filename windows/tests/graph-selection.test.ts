import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../prototype/graph-selection.js', import.meta.url), 'utf8');
function adapter() {
  const window: any = {};
  vm.runInNewContext(source, { window });
  return window.RabbitGraphSelection;
}
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const box = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height });

class Text {
  nodeType = 3; parentElement: Element | null = null; ownerDocument!: Doc;
  textContent: string; left: number; top: number;
  constructor(textContent: string, left = 0, top = 0) { this.textContent = textContent; this.left = left; this.top = top; }
}
class Element {
  nodeType = 1; parentElement: Element | null = null; ownerDocument!: Doc;
  childNodes: Array<Text | Element> = [];
  className: string; tag: string; rect: ReturnType<typeof box>; attrs: Record<string, string>;
  constructor(className = '', tag = 'span', rect = box(0, 0, 200, 20), attrs: Record<string, string> = {}) { this.className = className; this.tag = tag; this.rect = rect; this.attrs = attrs; }
  append(...children: Array<Text | Element>) { for (const child of children) { child.parentElement = this; this.childNodes.push(child); } return this; }
  get children() { return this.childNodes.filter(child => child instanceof Element); }
  get textContent(): string { return this.childNodes.map(node => node.textContent).join(''); }
  getAttribute(name: string) { return this.attrs[name] ?? null; }
  matches(selector: string): boolean {
    return selector.split(',').some(item => item[0] === '.' ? this.className.split(' ').includes(item.slice(1)) : item === '[hidden]' ? 'hidden' in this.attrs : item === this.tag);
  }
  closest(selector: string): Element | null { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null; }
  querySelector(selector: string): Element | null {
    for (const child of this.childNodes) if (child instanceof Element) {
      const match = selector.startsWith('annotation[') ? child.tag === 'annotation' && child.attrs.encoding === 'application/x-tex' : child.matches(selector);
      if (match) return child;
      const nested = child.querySelector(selector); if (nested) return nested;
    }
    return null;
  }
  contains(node: Text | Element): boolean { return node === this || this.childNodes.some(child => child === node || child instanceof Element && child.contains(node)); }
  getBoundingClientRect() { return this.rect; }
}
class Doc {
  textNodes: Text[] = [];
  root: Element;
  constructor(root: Element) {
    this.root = root;
    const visit = (node: Text | Element) => { node.ownerDocument = this; if (node instanceof Text) this.textNodes.push(node); else node.childNodes.forEach(visit); };
    visit(root);
  }
  offset(node: Text | Element, within = 0): number {
    let offset = 0;
    for (const text of this.textNodes) { if (text === node || node instanceof Element && node.contains(text)) return offset + within; offset += text.textContent.length; }
    throw new Error('节点不在文档中');
  }
  createTreeWalker() { let index = 0; return { nextNode: () => this.textNodes[index++] ?? null }; }
  createRange() { return new Range(this); }
}
class Range {
  startContainer!: Text | Element; endContainer!: Text | Element; startOffset = 0; endOffset = 0;
  doc: Doc;
  constructor(doc: Doc) { this.doc = doc; }
  setStart(node: Text | Element, offset: number) { this.startContainer = node; this.startOffset = offset; }
  setEnd(node: Text | Element, offset: number) { this.endContainer = node; this.endOffset = offset; }
  get start() { return this.doc.offset(this.startContainer, this.startOffset); }
  get end() { return this.doc.offset(this.endContainer, this.endOffset); }
  get collapsed() { return this.start === this.end; }
  get commonAncestorContainer() { return this.doc.root; }
  intersectsNode(node: Text | Element) { const start = this.doc.offset(node); return this.end > start && this.start < start + node.textContent.length; }
  toString() { return this.doc.root.textContent.slice(this.start, this.end); }
  getClientRects() {
    assert.equal(this.startContainer, this.endContainer, '普通文本几何仅读取自己的Text节点');
    const node = this.startContainer as Text;
    return [box(node.left + this.startOffset * 8, node.top, (this.endOffset - this.startOffset) * 8, 20)];
  }
}
function math(tex: string, visible: string, rect = box(48, 0, 16, 20), display = false) {
  const annotation = new Element('', 'annotation', undefined, { encoding: 'application/x-tex' }).append(new Text(tex));
  const visualText = new Text(visible);
  const visual = new Element('katex-html', 'span', rect, { 'aria-hidden': 'true' }).append(visualText);
  const wrapper = new Element('rabbit-math' + (display ? ' rabbit-math-display' : ''), 'span', rect, { 'data-latex': tex }).append(
    new Element('katex').append(new Element('katex-mathml').append(new Text(visible), annotation), visual));
  return { wrapper, visualText };
}

test('文字与公式批注只保存一份LaTeX语义文本，并合并同一行相邻高亮', () => {
  const first = new Text('跃迁作用于 ', 0), formula = math('e', 'e', box(48, 0, 16, 20)), last = new Text('。', 64);
  const root = new Element().append(first, formula.wrapper, last), doc = new Doc(root), range = doc.createRange();
  range.setStart(first, 0); range.setEnd(last, 1);
  const captured = adapter().capture(root, range);
  assert.equal(captured.selection.text, '跃迁作用于 $e$。');
  assert.equal(captured.selection.end, captured.selection.text.length);
  assert.deepEqual(plain(captured.rects), [box(0, 0, 72, 20)]);
  assert.deepEqual(plain(adapter().rects(root, captured.selection)), plain(captured.rects));
});

test('从分式内部开始选择会吸附完整公式，不产生内部竖条或隐藏MathML高亮', () => {
  const formula = math('\\frac{x}{y}', 'xy', box(48, -8, 30, 36)), root = new Element().append(formula.wrapper), doc = new Doc(root), range = doc.createRange();
  range.setStart(formula.visualText, 0); range.setEnd(formula.visualText, 1);
  const captured = adapter().capture(root, range);
  assert.equal(captured.selection.text, '$\\frac{x}{y}$');
  assert.deepEqual(plain(captured.rects), [box(48, -8, 30, 36)]);
});

test('清理后的公式保留原始LaTeX，错开基线的相邻文字仍合并为一条高亮', () => {
  const first = new Text('前文 ', 0), formula = math('x^2', 'x2', box(24, 2, 30, 20)), last = new Text(' 后文', 54);
  const mathml = formula.wrapper.querySelector('.katex-mathml')!;
  mathml.childNodes = [new Text('x2x^2')];
  const root = new Element().append(first, formula.wrapper, last), doc = new Doc(root), range = doc.createRange();
  range.setStart(first, 0); range.setEnd(last, 3);
  const captured = adapter().capture(root, range);
  assert.equal(captured.selection.text, '前文 $x^2$ 后文');
  assert.deepEqual(plain(captured.rects), [box(0, 0, 78, 22)]);
});

test('跨行文字与独立公式分别保留行框，宽公式只高亮可见区域', () => {
  const first = new Text('前文', 0, 0), formula = math('A+B', 'A+B', box(0, 30, 300, 40), true), last = new Text('后文', 0, 85);
  formula.wrapper.rect = box(0, 30, 180, 40);
  const root = new Element().append(first, formula.wrapper, last), doc = new Doc(root), range = doc.createRange();
  range.setStart(first, 0); range.setEnd(last, 2);
  const captured = adapter().capture(root, range);
  assert.equal(captured.selection.text, '前文$$\nA+B\n$$后文');
  assert.deepEqual(plain(captured.rects), [box(0, 0, 16, 20), box(0, 30, 180, 40), box(0, 85, 16, 20)]);
});

test('行间公式只高亮实际排版宽度，分式高度取自顶层排版块', () => {
  const formula = math('\\frac{x}{y}', 'xy', box(0, 0, 600, 18), true);
  formula.wrapper.rect = box(0, -8, 600, 38);
  const visual = formula.wrapper.querySelector('.katex-html')!;
  const base = new Element('katex-base', 'span', box(0, -6, 28, 34)).append(formula.visualText);
  visual.childNodes = []; visual.append(base);
  const root = new Element().append(formula.wrapper), doc = new Doc(root), range = doc.createRange();
  range.setStart(formula.visualText, 0); range.setEnd(formula.visualText, 1);
  assert.deepEqual(plain(adapter().capture(root, range).rects), [box(0, -6, 28, 34)]);
});

test('已有原始DOM偏移的公式批注恢复到同一条单框高亮路径', () => {
  const first = new Text('前文 ', 0), formula = math('x^2', 'x2', box(24, -3, 24, 23)), last = new Text(' 后文', 48);
  const root = new Element().append(first, formula.wrapper, last), doc = new Doc(root), range = doc.createRange();
  range.setStart(first, 0); range.setEnd(last, 3);
  const selection = { kind: 'text', text: range.toString(), start: range.start, end: range.end };
  assert.match(selection.text, /x2x\^2x2/);
  assert.deepEqual(plain(adapter().rects(root, selection)), [box(0, -3, 72, 23)]);
});

test('无法核对的旧偏移与重复文字不猜测高亮目标', () => {
  const root = new Element().append(new Text('重复'), new Text('内容'), new Text('重复')), doc = new Doc(root);
  assert.deepEqual(plain(adapter().rects(root, { kind: 'text', text: '重复', start: 2, end: 4 })), []);
  const range = doc.createRange(); range.setStart(doc.textNodes[0], 0); range.setEnd(doc.textNodes[0], 0);
  assert.equal(adapter().capture(root, range), null);
});
