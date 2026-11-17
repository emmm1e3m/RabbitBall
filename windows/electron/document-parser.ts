import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { OfficeIssue, SupportedFileType } from 'officeparser';

export const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;
export const MAX_DOCUMENT_CHARACTERS = 1_000_000;
const PARSE_TIMEOUT_MS = 60_000;

export interface DocumentAttachmentInput {
  name: string;
  bytes: Uint8Array;
}

export interface ParsedDocumentAttachment {
  name: string;
  mimeType: string;
  text: string;
  format: string;
  language?: string;
}

const documentFormats: Record<string, { type: SupportedFileType; mimeType: string }> = {
  pdf: { type: 'pdf', mimeType: 'application/pdf' },
  docx: { type: 'docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  pptx: { type: 'pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
  xlsx: { type: 'xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  html: { type: 'html', mimeType: 'text/html' },
  htm: { type: 'html', mimeType: 'text/html' },
  odt: { type: 'odt', mimeType: 'application/vnd.oasis.opendocument.text' },
  odp: { type: 'odp', mimeType: 'application/vnd.oasis.opendocument.presentation' },
  ods: { type: 'ods', mimeType: 'application/vnd.oasis.opendocument.spreadsheet' },
  rtf: { type: 'rtf', mimeType: 'application/rtf' },
  epub: { type: 'epub', mimeType: 'application/epub+zip' },
};

const textLanguages: Record<string, string> = {
  txt: 'text', text: 'text', log: 'text', md: 'markdown', markdown: 'markdown',
  csv: 'csv', tsv: 'tsv', json: 'json', jsonl: 'jsonl', ndjson: 'jsonl', ipynb: 'json',
  yaml: 'yaml', yml: 'yaml', xml: 'xml', xsd: 'xml', xsl: 'xml', svg: 'xml',
  tex: 'latex', latex: 'latex', ltx: 'latex', bib: 'bibtex', typ: 'typst',
  py: 'python', pyw: 'python', js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  jsx: 'jsx', ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hxx: 'cpp',
  cs: 'csharp', java: 'java', kt: 'kotlin', kts: 'kotlin', go: 'go', rs: 'rust',
  rb: 'ruby', php: 'php', swift: 'swift', dart: 'dart', scala: 'scala', lua: 'lua', lean: 'lean',
  r: 'r', jl: 'julia', m: 'matlab', f: 'fortran', f90: 'fortran', sql: 'sql',
  sh: 'bash', bash: 'bash', zsh: 'bash', ps1: 'powershell', bat: 'batch', cmd: 'batch',
  css: 'css', scss: 'scss', sass: 'sass', less: 'less', vue: 'vue', svelte: 'svelte',
  toml: 'toml', ini: 'ini', cfg: 'ini', conf: 'text', properties: 'properties',
  rst: 'rst', adoc: 'asciidoc', asciidoc: 'asciidoc', diff: 'diff', patch: 'diff',
};

function textMimeType(language: string | undefined): string {
  if (language === 'json') return 'application/json';
  if (language === 'xml') return 'application/xml';
  if (language === 'csv') return 'text/csv';
  if (language === 'tsv') return 'text/tab-separated-values';
  if (language === 'markdown') return 'text/markdown';
  return 'text/plain';
}

function decodeText(bytes: Uint8Array): string {
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le'
    : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
  let text: string;
  try {
    text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    throw new Error('无法解码文本，请将文件另存为 UTF-8 或带 BOM 的 UTF-16 后重试。');
  }
  if (/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/u.test(text)) {
    throw new Error('文件包含二进制内容，无法作为文本读取。');
  }
  return text;
}

function checkText(text: string): void {
  if (!text.trim()) throw new Error('文件中没有可读取的文字；扫描件请先识别为文字后再导入。');
  if (text.length > MAX_DOCUMENT_CHARACTERS) throw new Error('解析后的文字超过 100 万字符，请拆分文件后重试。');
}

function parserError(error: unknown): Error {
  const code = (error as { officeIssue?: { code?: string } })?.officeIssue?.code;
  if (code === 'PASSWORD_REQUIRED' || code === 'PASSWORD_INCORRECT' || code === 'DOCUMENT_DECRYPTION_FAILED') {
    return new Error('文档已加密，请解除密码保护后重试。');
  }
  if (code?.includes('LIMIT_EXCEEDED') || code === 'OUTPUT_TOO_LARGE') {
    return new Error('文档内容过大或结构过于复杂，请拆分后重试。');
  }
  return new Error('文档解析失败，请确认文件未损坏且内容与扩展名一致。');
}

function checkWarnings(issues: OfficeIssue[]): void {
  if (issues.some(issue => issue.code === 'PDF_NO_TEXT_EXTRACTED')) {
    throw new Error('PDF 中没有足够的可读取文字；扫描件请先识别为文字后再导入。');
  }
  if (issues.some(issue => /LIMIT_EXCEEDED|TRUNCATED/.test(issue.code))) {
    throw new Error('文档超出完整解析的限制，请拆分后重试；未导入被截断的内容。');
  }
  const incomplete = new Set([
    'PAGE_LOAD_FAILED', 'CONTENT_PART_NOT_READ', 'ALT_CHUNK_NOT_READ', 'BUFFER_TYPE_MISMATCH',
    'PDF_ASSET_UNAVAILABLE', 'PDF_FONT_UNMAPPED', 'PDF_TEXT_ENCODING_SUSPECT',
    'CHART_DATA_EXTRACTION_FAILED', 'DEPENDENCY_LOAD_FAILED',
  ]);
  if (issues.some(issue => incomplete.has(issue.code))) {
    throw new Error('无法完整读取文档文字，请检查文件或另存为其他格式后重试。');
  }
}

async function parseInWorker(input: DocumentAttachmentInput): Promise<ParsedDocumentAttachment> {
  const name = path.basename(input.name.replaceAll('\\', '/')).replace(/[\u0000-\u001f\u007f]/gu, '').trim();
  const format = path.extname(name).slice(1).toLowerCase() || 'text';
  const document = Object.hasOwn(documentFormats, format) ? documentFormats[format] : undefined;
  if (!document) {
    // 扩展名只用于选择文档解析器和标注语言；其他文件能完整解码为文本即可导入。
    const language = Object.hasOwn(textLanguages, format) ? textLanguages[format] : undefined;
    const text = decodeText(input.bytes);
    checkText(text);
    return { name, mimeType: textMimeType(language), text, format, language };
  }
  // 文档始终以字节解析；不向解析器传入文件路径，也不执行文档内容或获取远程资源。
  const bytes = document.type === 'html' ? new TextEncoder().encode(decodeText(input.bytes)) : input.bytes;
  const { parseOffice } = await import('officeparser');
  const issues: OfficeIssue[] = [];
  let text: string;
  try {
    const ast = await parseOffice(bytes, {
      fileType: document.type,
      allowRemoteAssets: false,
      extractAttachments: false,
      ocr: false,
      includeRawContent: false,
      onWarning: issue => issues.push(issue),
      // 外层进程已隔离解析，不再让 pdf.js 通过 Electron 可执行文件启动第二层子进程。
      pdfParserConfig: { separateProcess: false, extractTextColor: false },
      decompressionLimits: { maxUncompressedBytes: 128 * 1024 * 1024 },
    });
    const pending = [...ast.content];
    let hasContent = false;
    while (pending.length && !hasContent) {
      const node = pending.pop()!;
      if (node.type === 'image') continue;
      hasContent = Boolean(node.text?.trim()) || node.type === 'chart';
      if (node.children) pending.push(...node.children);
    }
    if (!hasContent) throw new Error('EMPTY_DOCUMENT');
    // 默认 Markdown 只用分隔线区分页、幻灯片和工作表，补上来源标签以便模型引用。
    ast.content = ast.content.flatMap(node => {
      let label: string | undefined;
      if (node.type === 'sheet' && node.metadata) label = `工作表：${node.metadata.sheetName}`;
      if (node.type === 'slide' && node.metadata) label = `幻灯片 ${node.metadata.slideNumber}`;
      if (node.type === 'page' && node.metadata) label = `第 ${node.metadata.pageNumber} 页`;
      return label ? [{ type: 'heading' as const, metadata: { level: 2 }, children: [{ type: 'text' as const, text: label }] }, node] : [node];
    });
    const result = await ast.to('md', { includeImages: false, onWarning: issue => issues.push(issue) });
    text = result.value;
  } catch (error) {
    if (error instanceof Error && error.message === 'EMPTY_DOCUMENT') {
      throw new Error('文档中没有可读取的文字；扫描件请先识别为文字后再导入。');
    }
    throw parserError(error);
  }
  checkWarnings(issues);
  checkText(text);
  return { name, mimeType: document.mimeType, text, format: document.type };
}

export async function parseDocumentAttachment(input: DocumentAttachmentInput): Promise<ParsedDocumentAttachment> {
  if (!input || typeof input.name !== 'string' || !input.name.trim() || !(input.bytes instanceof Uint8Array)) {
    throw new Error('文件信息无效，请重新选择文件。');
  }
  if (!input.bytes.byteLength) throw new Error('文件为空。');
  if (input.bytes.byteLength > MAX_DOCUMENT_BYTES) throw new Error('文件不能超过 50 MiB，请拆分后重试。');
  return new Promise((resolve, reject) => {
    // Electron 的 Node 子进程可直接读取 ASAR；线程的 ESM 入口无法读取 ASAR。
    const worker = fork(fileURLToPath(import.meta.url), [], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', RABBITBALL_DOCUMENT_WORKER: '1' },
      execArgv: ['--experimental-strip-types', '--max-old-space-size=512'],
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      windowsHide: true,
    });
    let settled = false;
    const timer = setTimeout(() => finish(new Error('文档解析超过 60 秒，请拆分文件后重试。')), PARSE_TIMEOUT_MS);
    const finish = (error?: Error, value?: ParsedDocumentAttachment) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.kill();
      if (error) reject(error);
      else resolve(value!);
    };
    worker.once('message', (message: { value?: ParsedDocumentAttachment; error?: string }) => {
      finish(message.error ? new Error(message.error) : undefined, message.value);
    });
    worker.once('error', () => finish(new Error('文档解析失败，文件可能过大或结构过于复杂。')));
    worker.once('exit', () => finish(new Error('文档解析意外结束，请重新选择文件。')));
    worker.send(input);
  });
}

if (process.env.RABBITBALL_DOCUMENT_WORKER === '1' && process.send) {
  process.once('disconnect', () => process.exit(0));
  process.once('message', (input: DocumentAttachmentInput) => {
    void parseInWorker(input).then(
      value => process.send!({ value }),
      error => process.send!({ error: error instanceof Error ? error.message : '文档解析失败。' }),
    );
  });
}
