import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const vendor = path.join(root, 'prototype/vendor');
await mkdir(vendor, { recursive: true });
for (const [source, name] of [
  ['markdown-it/dist/browser/markdown-it.umd.min.js', 'markdown-it.min.js'],
  ['dompurify/dist/purify.min.js', 'purify.min.js'],
  ['katex/dist/katex.min.js', 'katex.min.js'],
  ['katex/dist/contrib/auto-render.min.js', 'auto-render.min.js'],
  ['katex/dist/katex.min.css', 'katex.min.css'],
  ['katex/dist/fonts', 'fonts']
]) await cp(path.join(root, 'node_modules', source), path.join(vendor, name), { recursive: true });

await cp(path.join(root, 'electron/active-window.ps1'), path.join(root, 'dist-electron/active-window.ps1'));
await cp(path.join(root, 'electron/windows-native.ps1'), path.join(root, 'dist-electron/windows-native.ps1'));
// 轻量截图页与主界面使用同一份快捷键模块。
await cp(path.join(root, 'dist-electron/shortcut.js'), path.join(root, 'prototype/shortcut.js'));

// 独立预览与桌面版共用一份页面，源组件在构建时同步内联。
const file = path.join(root, 'prototype/index.html');
let html = await readFile(file, 'utf8');
for (const id of ['rabbit-shortcut-script', 'rabbit-prompt-defaults-script', 'rabbit-prompts-script', 'rabbit-rich-text-script', 'rabbit-assistant-script', 'rabbit-chat-script', 'rabbit-settings-script', 'rabbit-activation-effect-script', 'rabbit-capture-ui-script']) {
  html = html.replace(new RegExp(`\\s*<script id="${id}">[\\s\\S]*?<\\/script>`), '');
}
// 键名、校验与组合匹配共用原生端的纯模块。
const shortcutSource = (await readFile(path.join(root, 'dist-electron/shortcut.js'), 'utf8')).replace(/^export /gm, '');
const shortcutTag = `<script id="rabbit-shortcut-script">\n(() => {\n${shortcutSource}\nwindow.RabbitShortcut=Object.freeze({DEFAULT_ACTIVATION_SHORTCUT,normalizeShortcut,formatShortcut,matchesShortcut,isSupportedShortcutCode,isModifierCode});\n})();\n  </script>`;
html = html.replace('</body>', () => `  ${shortcutTag}\n</body>`);
// 默认提示词来自同一份后台资源，预览不维护第二份文案。
const { DEFAULT_PROMPTS } = await import(pathToFileURL(path.join(root, 'dist-electron/prompts.js')).href);
const defaultsTag = `<script id="rabbit-prompt-defaults-script">\nwindow.RabbitPromptDefaults=Object.freeze(${JSON.stringify(DEFAULT_PROMPTS).replaceAll('<', '\\u003c')});\n  </script>`;
html = html.replace('</body>', () => `  ${defaultsTag}\n</body>`);
for (const [name, id] of [['prompts', 'rabbit-prompts-script'], ['rich-text', 'rabbit-rich-text-script'], ['assistant', 'rabbit-assistant-script'], ['chat-ui', 'rabbit-chat-script'], ['settings-ui', 'rabbit-settings-script'], ['activation-effect', 'rabbit-activation-effect-script'], ['capture-ui', 'rabbit-capture-ui-script']]) {
  const source = await readFile(path.join(root, `prototype/${name}.js`), 'utf8');
  const tag = `<script id="${id}">\n${source.trim()}\n  </script>`;
  html = html.replace('</body>', () => `  ${tag}\n</body>`);
}
await writeFile(file, html);
