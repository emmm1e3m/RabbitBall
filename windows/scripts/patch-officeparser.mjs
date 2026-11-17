import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 8.7.1 的 ESM 入口重导出 CJS，共用此模块。只修复结构化公式的分组与控制词边界，
// 不猜测或改写已生成的 LaTeX。升级依赖时必须重新核验补丁和公式夹具。
const originalDigest = '4862cc2dbab39b7de2bbcb6f67b31dc7c46a2dc2b84b6e90d6a030ce1ad46d0c';
const replacements = [
  [
    'const group = (latex) => /^[0-9a-zA-Z]$/.test(latex) ? latex : `{${latex}}`;',
    '// RabbitBall：命令参数始终分组，避免单字母被并入 \\frac、\\sqrt 等控制词。\nconst group = (latex) => `{${latex}}`;',
  ],
  [
    'return MATHML_OPERATORS[trimmed] ?? escapeLatex(raw);',
    "return MATHML_OPERATORS[trimmed] !== undefined ? MATHML_OPERATORS[trimmed] + ' ' : escapeLatex(raw);",
  ],
  [
    'const op = OMML_NARY_OPERATORS[chr] ?? escapeLatex(chr);',
    "const op = (OMML_NARY_OPERATORS[chr] ?? escapeLatex(chr)) + ' ';",
  ],
  [
    "'√': '\\\\sqrt',",
    "'√': '\\\\surd',",
  ],
  [
    "return `${part('e')}_${group(part('lim'))}`;",
    "return `${group(part('e'))}_${group(part('lim'))}`;",
  ],
  [
    "return `${part('e')}^${group(part('lim'))}`;",
    "return `${group(part('e'))}^${group(part('lim'))}`;",
  ],
  [
    "const arg = (index) => (kids[index] ? (0, exports.mathmlTreeToLatex)(kids[index], depth + 1) : '');",
    "const elements = kids.filter(child => child.tagName);\n    const arg = (index) => (elements[index] ? (0, exports.mathmlTreeToLatex)(elements[index], depth + 1) : '');",
  ],
];

const digest = source => createHash('sha256').update(source).digest('hex');

function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('officeparser 公式补丁与安装源码不匹配，请检查固定依赖。');
  return source.replace(before, after);
}

export function patchMathSource(source) {
  if (digest(source) === originalDigest) {
    return replacements.reduce((result, [before, after]) => replaceOnce(result, before, after), source);
  }
  // 通过反向还原核验整个文件，既允许重复执行，也拒绝未知或只应用了一部分的补丁。
  const restored = replacements.reduce((result, [before, after]) => replaceOnce(result, after, before), source);
  if (digest(restored) !== originalDigest) throw new Error('officeparser 公式补丁与安装源码不匹配，请检查固定依赖。');
  return source;
}

export async function patchOfficeParser(packageDirectory) {
  const metadata = JSON.parse(await readFile(path.join(packageDirectory, 'package.json'), 'utf8'));
  if (metadata.version !== '8.7.1') throw new Error('officeparser 公式补丁只支持已核验的 8.7.1，请重新核验依赖。');
  const entry = metadata.exports?.['.'];
  const esm = await readFile(path.join(packageDirectory, 'dist/index.mjs'), 'utf8');
  if (entry?.import !== './dist/index.mjs' || entry?.require !== './dist/index.js'
      || !esm.includes("import _module from './index.js';")) {
    throw new Error('officeparser 的 ESM/CJS 入口已改变，请重新核验公式补丁。');
  }
  const filename = path.join(packageDirectory, 'dist/utils/mathUtils.js');
  const source = await readFile(filename, 'utf8');
  const patched = patchMathSource(source);
  if (patched !== source) await writeFile(filename, patched);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await patchOfficeParser(fileURLToPath(new URL('../node_modules/officeparser', import.meta.url)));
}
