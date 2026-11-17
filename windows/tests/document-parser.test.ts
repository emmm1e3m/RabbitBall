import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdtemp, mkdir, writeFile, rm, open } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { crc32 } from 'node:zlib';
import { renderToString } from 'katex';
import { parseOffice } from 'officeparser';
import { MAX_DOCUMENT_BYTES, MAX_DOCUMENT_CHARACTERS, parseDocumentAttachment } from '../electron/document-parser.ts';
import { patchMathSource, patchOfficeParser } from '../scripts/patch-officeparser.mjs';

const encode = (text: string) => new TextEncoder().encode(text);

// 构造真实 ZIP/OOXML 字节，独立于解析库的导出器，避免导出与读取相互掩盖问题。
function zip(files: Record<string, string>): Uint8Array {
  const body: Buffer[] = [], directory: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const filename = Buffer.from(name), data = Buffer.from(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(filename.length, 26);
    body.push(local, filename, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(offset, 42);
    directory.push(central, filename);
    offset += local.length + filename.length + data.length;
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(directory.length / 2, 8);
  end.writeUInt16LE(directory.length / 2, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...body, central, end]);
}

const contentTypes = (part: string, type: string) => `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/${part}" ContentType="application/vnd.openxmlformats-officedocument.${type}+xml"/></Types>`;
const relationships = (type: string, target: string) => `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/></Relationships>`;

function docx(equation = '<m:f><m:num><m:r><m:t>1</m:t></m:r></m:num><m:den><m:r><m:t>2</m:t></m:r></m:den></m:f>'): Uint8Array {
  return zip({
    '[Content_Types].xml': contentTypes('word/document.xml', 'wordprocessingml.document.main'),
    '_rels/.rels': relationships('officeDocument', 'word/document.xml'),
    'word/document.xml': `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><w:body><w:p><w:r><w:t>半数的表达式</w:t></w:r><m:oMath>${equation}</m:oMath></w:p><w:sectPr/></w:body></w:document>`,
  });
}

function pdf(text: string): Uint8Array {
  const stream = `BT /F1 12 Tf 50 750 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let value = '%PDF-1.4\n';
  const offsets = [0];
  for (const [i, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(value));
    value += `${i + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(value);
  value += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  value += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  value += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return encode(value);
}

test('Python、LaTeX、CSV 和 JSON 保留全文、换行与格式标签，不执行内容', async () => {
  for (const [name, language, text] of [
    ['analysis.py', 'python', '# 中文注释\r\nprint("hello")\r\n'],
    ['formula.tex', 'latex', '\\input{/local/file}\n$\\frac{a}{b}$\n'],
    ['data.csv', 'csv', '名称,数值\n"带,逗号",2\n'],
    ['data.json', 'json', '{\n  "count": 2\n}\n'],
  ]) {
    const result = await parseDocumentAttachment({ name, bytes: encode(text) });
    assert.equal(result.text, text);
    assert.equal(result.language, language);
  }
});

test('无后缀、隐藏文件和未知后缀按内容读取，扩展名只作为类型标签', async () => {
  const text = '# 中文配置\r\nVALUE=42\r\n';
  for (const [name, format] of [
    ['README', 'text'], ['Dockerfile', 'text'], ['.env', 'text'],
    ['资料.unlisted', 'unlisted'], ['notes.exe', 'exe'], ['notes.zip', 'zip'],
    ['notes.constructor', 'constructor'], ['notes.__proto__', '__proto__'],
  ]) {
    const result = await parseDocumentAttachment({ name, bytes: encode(text) });
    assert.equal(result.name, name);
    assert.equal(result.text, text);
    assert.equal(result.format, format);
    assert.equal(result.mimeType, 'text/plain');
    assert.equal(result.language, format === 'text' ? 'text' : undefined);
  }
});

test('带 BOM 的 UTF-16 正常读取，错误编码和伪装文本的二进制被明确拒绝', async () => {
  const result = await parseDocumentAttachment({ name: '中文.txt', bytes: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('完整内容\n', 'utf16le')]) });
  assert.equal(result.text, '完整内容\n');
  await assert.rejects(parseDocumentAttachment({ name: '错误.txt', bytes: Uint8Array.of(0xff, 0x31) }), /UTF-8/u);
  await assert.rejects(parseDocumentAttachment({ name: '伪装.txt', bytes: Uint8Array.of(77, 90, 0, 1, 2) }), /二进制/u);
});

test('DOCX 原生 OMML 公式转成 LaTeX，并保留中文正文', async () => {
  const result = await parseDocumentAttachment({ name: '公式.docx', bytes: docx() });
  assert.match(result.text, /半数的表达式/u);
  assert.match(result.text, /\\frac(?:\{1\}|1)(?:\{2\}|2)/u);
  assert.equal(result.format, 'docx');
});

test('HTML MathML 保留数学结构，脚本与远程图片不执行、不访问', async t => {
  let requests = 0;
  const server = createServer((_request, response) => { requests++; response.end('unexpected'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const port = (server.address() as { port: number }).port;
  const html = `<h1>实验</h1><p>比例 <math><mfrac><mn>1</mn><mn>2</mn></mfrac></math></p><img src="http://127.0.0.1:${port}/image"><script src="http://127.0.0.1:${port}/script">fetch('http://127.0.0.1:${port}/run')</script>`;
  const result = await parseDocumentAttachment({ name: '实验.html', bytes: encode(html) });
  assert.match(result.text, /实验/u);
  assert.match(result.text, /\\frac(?:\{1\}|1)(?:\{2\}|2)/u);
  assert.doesNotMatch(result.text, /fetch\(/u);
  assert.equal(requests, 0);
});

test('公式补丁可重复执行，未知版本或源码会明确失败', async t => {
  const source = await readFile(new URL('../node_modules/officeparser/dist/utils/mathUtils.js', import.meta.url), 'utf8');
  assert.equal(patchMathSource(patchMathSource(source)), source);
  assert.throws(() => patchMathSource(`${source}\n// unexpected change`), /源码不匹配/u);
  const directory = await mkdtemp(path.join(tmpdir(), 'rabbitball-officeparser-patch-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'dist'), { recursive: true });
  await writeFile(path.join(directory, 'package.json'), '{"version":"8.7.2"}');
  await assert.rejects(patchOfficeParser(directory), /只支持已核验的 8.7.1/u);
});

test('HTML 单字母分式、根式、数集与运算符保留正确的 LaTeX 边界', async () => {
  const html = '<h1>模型</h1><p>Hamiltonian</p><math><mfrac><mi>H</mi><mn>2</mn></mfrac></math>'
    + '<math><msqrt><mi>x</mi></msqrt></math><math><mi>ℝ</mi></math>'
    + '<math><mi>x</mi><mo>∈</mo><mi>R</mi></math><math><mo>√</mo><mo>=</mo><mi>x</mi></math>';
  const result = await parseDocumentAttachment({ name: '模型.html', bytes: encode(html) });
  for (const formula of ['\\frac{H}{2}', '\\sqrt{x}', '\\mathbb{R}', 'x\\in R', '\\surd =x']) {
    assert.ok(result.text.includes(formula), `缺少正确公式：${formula}；实际为：${result.text}`);
    assert.doesNotThrow(() => renderToString(formula, { throwOnError: true }));
  }
});

test('DOCX OMML 单字母参数、无上下限求和与复合极限底部正确分组', async () => {
  const equation = '<m:f><m:num><m:r><m:t>H</m:t></m:r></m:num><m:den><m:r><m:t>2</m:t></m:r></m:den></m:f>'
    + '<m:rad><m:e><m:r><m:t>x</m:t></m:r></m:e></m:rad>'
    + '<m:r><m:rPr><m:scr m:val="double-struck"/></m:rPr><m:t>R</m:t></m:r>'
    + '<m:nary><m:naryPr><m:chr m:val="∑"/></m:naryPr><m:e><m:r><m:t>x</m:t></m:r></m:e></m:nary>'
    + '<m:limLow><m:e><m:r><m:t>x+y</m:t></m:r></m:e><m:lim><m:r><m:t>i</m:t></m:r></m:lim></m:limLow>'
    + '<m:limUpp><m:e><m:r><m:t>a+b</m:t></m:r></m:e><m:lim><m:r><m:t>j</m:t></m:r></m:lim></m:limUpp>';
  const result = await parseDocumentAttachment({ name: '模型.docx', bytes: docx(equation) });
  const expected = '\\frac{H}{2}\\sqrt{x}\\mathbb{R}\\sum x{x+y}_{i}{a+b}^{j}';
  assert.ok(result.text.includes(expected), result.text);
  assert.doesNotThrow(() => renderToString(expected, { throwOnError: true }));
});

test('MathML 的缩进和换行不占据分式、上下标或根式参数位置', async () => {
  const html = '<math><mfrac>\n  <mi>H</mi>\n  <mn>2</mn>\n</mfrac></math>'
    + '<math><msup>\n  <mi>x</mi>\n  <mn>2</mn>\n</msup></math>'
    + '<math><mroot>\n  <mi>x</mi>\n  <mn>3</mn>\n</mroot></math>';
  const result = await parseDocumentAttachment({ name: '缩进公式.html', bytes: encode(html) });
  for (const formula of ['\\frac{H}{2}', '{x}^{2}', '\\sqrt[3]{x}']) {
    assert.ok(result.text.includes(formula), result.text);
    assert.doesNotThrow(() => renderToString(formula, { throwOnError: true }));
  }
});

test('officeparser 的 ESM 与 CJS 公共入口共用修复后的公式转换器', async () => {
  const require = createRequire(import.meta.url);
  const cjs = require('officeparser') as typeof import('officeparser');
  const bytes = encode('<math><mfrac><mi>H</mi><mn>2</mn></mfrac></math>');
  for (const parse of [parseOffice, cjs.parseOffice]) {
    const ast = await parse(bytes, { fileType: 'html', allowRemoteAssets: false });
    assert.equal((await ast.to('md')).value.trim(), '$\\frac{H}{2}$');
  }
});

test('真实 PDF 字节使用本地 pdf.js 读取全文', async () => {
  const result = await parseDocumentAttachment({ name: 'report.pdf', bytes: pdf('RabbitBall complete PDF content 12345') });
  assert.match(result.text, /RabbitBall complete PDF content 12345/u);
  assert.equal(result.mimeType, 'application/pdf');
});

test('XLSX 表格和 PPTX 幻灯片按各自结构读取', async () => {
  const spreadsheet = zip({
    '[Content_Types].xml': contentTypes('xl/workbook.xml', 'spreadsheetml.sheet.main'),
    '_rels/.rels': relationships('officeDocument', 'xl/workbook.xml'),
    'xl/workbook.xml': '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="实验数据" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': relationships('worksheet', 'worksheets/sheet1.xml'),
    'xl/worksheets/sheet1.xml': '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>名称</t></is></c><c r="B1" t="inlineStr"><is><t>数值</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>样本</t></is></c><c r="B2"><v>42</v></c></row></sheetData></worksheet>',
  });
  const slides = zip({
    '[Content_Types].xml': contentTypes('ppt/presentation.xml', 'presentationml.presentation.main'),
    '_rels/.rels': relationships('officeDocument', 'ppt/presentation.xml'),
    'ppt/presentation.xml': '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>',
    'ppt/_rels/presentation.xml.rels': relationships('slide', 'slides/slide1.xml'),
    'ppt/slides/slide1.xml': '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="内容"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>幻灯片完整内容</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
  });
  const xlsx = await parseDocumentAttachment({ name: '数据.xlsx', bytes: spreadsheet });
  assert.match(xlsx.text, /实验数据/u);
  assert.match(xlsx.text, /样本/u);
  assert.match(xlsx.text, /42/u);
  const pptx = await parseDocumentAttachment({ name: '报告.pptx', bytes: slides });
  assert.match(pptx.text, /幻灯片完整内容/u);
});

test('真实压缩包和可执行文件的二进制内容、损坏文档与超限内容均失败', async () => {
  await assert.rejects(parseDocumentAttachment({ name: 'archive.zip', bytes: zip({ 'readme.txt': '完整内容' }) }), /二进制|无法解码文本/u);
  // 读取当前运行时的真实可执行文件头，不把仅有 ASCII 标记的文本误当作二进制夹具。
  const executable = await open(process.execPath, 'r');
  try {
    const bytes = Buffer.alloc(1024);
    const { bytesRead } = await executable.read(bytes, 0, bytes.length, 0);
    await assert.rejects(parseDocumentAttachment({ name: 'app.exe', bytes: bytes.subarray(0, bytesRead) }), /二进制|无法解码文本/u);
  } finally {
    await executable.close();
  }
  await assert.rejects(parseDocumentAttachment({ name: 'broken.docx', bytes: encode('not a Word file') }), /解析失败/u);
  await assert.rejects(parseDocumentAttachment({ name: 'large.txt', bytes: encode('x'.repeat(MAX_DOCUMENT_CHARACTERS + 1)) }), /100 万字符/u);
  await assert.rejects(parseDocumentAttachment({ name: 'huge.txt', bytes: new Uint8Array(MAX_DOCUMENT_BYTES + 1) }), /50 MiB/u);
});
