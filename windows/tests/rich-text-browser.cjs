const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow } = require('electron');

// 在隔离的 Chromium 文档中加载生产样式与真实渲染库，覆盖假 DOM 无法发现的 SVG 清理和级联问题。
const directory = process.argv[2], root = path.resolve(__dirname, '..');
app.setPath('userData', path.join(directory, 'profile'));
app.on('window-all-closed', () => {});
let window;
const evaluate = (fn, ...args) => window.webContents.executeJavaScript(`(${fn.toString()})(${args.map(value => JSON.stringify(value)).join(',')})`);

async function main() {
  const prototype = path.join(root, 'prototype');
  const html = await fs.readFile(path.join(prototype, 'index.html'), 'utf8');
  const styles = [html.match(/<style>([\s\S]*?)<\/style>/)[1]];
  for (const name of ['chat-ui.js', 'graph-ui.js']) {
    const source = await fs.readFile(path.join(prototype, name), 'utf8');
    styles.push(source.match(/style\.textContent\s*=\s*`([\s\S]*?)`/)[1]);
  }
  const url = relative => pathToFileURL(path.join(root, relative)).href;
  const script = relative => `<script src="${url(relative)}"></script>`;
  await fs.writeFile(path.join(directory, 'render.html'), `<!doctype html><html><head>
    <link rel="stylesheet" href="${url('node_modules/katex/dist/katex.css')}">
    <style>${styles.join('\n')}</style>
    ${script('node_modules/markdown-it/dist/browser/markdown-it.umd.min.js')}
    ${script('node_modules/dompurify/dist/purify.min.js')}
    ${script('node_modules/katex/dist/katex.min.js')}${script('prototype/rich-text.js')}
    </head><body><div id="plain"></div><div id="rabbit-chat-root"><div class="chat-message assistant" id="chat"></div></div>
    <div id="rabbit-graph-root" class="is-open"><div class="rg-body" id="card"></div><button class="rg-title" id="title"></button></div></body></html>`);
  await app.whenReady();
  window = new BrowserWindow({ show: false, width: 1000, height: 800, webPreferences: { sandbox: true, offscreen: true } });
  await window.loadFile(path.join(directory, 'render.html'));
  const formulas = [String.raw`\sqrt{x}`, String.raw`\sqrt[3]{1+\sqrt{x^2}}`, String.raw`\sqrt{\frac{a+b}{c+d}}`,
    String.raw`\overbrace{a+b+c}^{n}`, String.raw`\underbrace{x+y}_{n}`, String.raw`\widehat{ABC}`, String.raw`\widetilde{xyz}`, String.raw`A\xrightarrow{f}B`];
  const results = await evaluate(async formulas => {
    const results = [];
    for (const id of ['plain', 'chat', 'card', 'title']) for (const formula of formulas) for (const display of [false, true]) {
      const target = document.getElementById(id), source = display ? `$$${formula}$$` : `$${formula}$`;
      window.RabbitRender.render(target, source);
      const reference = document.createElement('div');
      reference.innerHTML = window.katex.renderToString(formula, { displayMode: display, output: 'htmlAndMathml' });
      const geometry = element => [...element.querySelectorAll('.katex svg')].map(svg => ({
        attributes: ['width', 'height', 'viewBox', 'preserveAspectRatio'].map(name => [name, svg.getAttribute(name)]),
        paths: [...svg.querySelectorAll('path')].map(node => node.getAttribute('d')),
      }));
      const svgs = [...target.querySelectorAll('.katex svg')];
      results.push({ id, formula, display, expected: geometry(reference), actual: geometry(target),
        visible: svgs.every(svg => getComputedStyle(svg).fill !== 'none' && svg.getBoundingClientRect().width > 0 && svg.getBoundingClientRect().height > 0),
        latex: target.querySelector('.rabbit-math')?.dataset.latex,
        mathml: !!target.querySelector('.katex-mathml math'),
      });
    }
    await document.fonts.ready;
    return results;
  }, formulas);
  for (const result of results) {
    const label = `${result.id} ${result.display ? 'display' : 'inline'} ${result.formula}`;
    assert.ok(result.expected.length > 0, label + ' 使用 SVG 字形');
    assert.deepEqual(result.actual, result.expected, label + ' 必须保留 KaTeX SVG 路径和尺寸');
    assert.equal(result.visible, true, label + ' SVG 保持可见填充与尺寸');
    assert.equal(result.latex, result.formula, label + ' 保留批注使用的 LaTeX 原文');
    assert.equal(result.mathml, true, label + ' 保留辅助阅读的 MathML');
  }
  const safety = await evaluate(() => {
    const target = document.getElementById('plain');
    window.RabbitRender.render(target, '[正常来源](https://example.com/paper) [脚本](javascript:alert(1)) [邮件](mailto:a@example.com) <img src=x onerror=alert(1)> ![替代文字](https://example.com/image.png) $\\href{javascript:alert(1)}{危险链接}$ $\\htmlStyle{color:red}{x}$');
    const links = [...target.querySelectorAll('a[href]')].map(link => link.getAttribute('href'));
    const forbidden = target.querySelectorAll('script,img,image,iframe,[onerror],[onload]').length;
    window.RabbitRender.render(target, '未闭合 $\\sqrt{x_1}');
    const partial = target.textContent;
    window.RabbitRender.render(target, '已完成 $\\sqrt{x_1}$');
    const complete = !!target.querySelector('.katex svg path[d]');
    window.RabbitRender.render(target, '```tex\n$\\sqrt{x}$\n```');
    return { links, forbidden, partial, complete, code: target.querySelector('code')?.textContent, codeMath: target.querySelectorAll('.rabbit-math').length };
  });
  assert.deepEqual(safety.links, ['https://example.com/paper']);
  assert.equal(safety.forbidden, 0);
  assert.equal(safety.partial.trimEnd(), '未闭合 $\\sqrt{x_1}');
  assert.equal(safety.complete, true);
  assert.equal(safety.code.trim(), '$\\sqrt{x}$');
  assert.equal(safety.codeMath, 0);
  console.log(`PASS ${results.length} 组真实公式渲染，链接清理、流式闭合及代码原文检查`);
}

main().then(() => { window?.destroy(); app.exit(0); }).catch(error => { console.error(error); window?.destroy(); app.exit(1); });
