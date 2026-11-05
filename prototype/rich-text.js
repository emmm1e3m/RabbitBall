(() => {
  'use strict';
  if (window.RabbitRender) return;

  const style = document.createElement('style');
  style.textContent = `
    .rabbit-rich-text { min-width:0;max-width:100%;color:var(--rabbit-ink);line-height:1.75;white-space:normal;overflow-wrap:anywhere; }
    .rabbit-rich-text p { margin:0 0 .6em; }
    .rabbit-rich-text > :last-child { margin-bottom:0; }
    .rabbit-rich-text h1,.rabbit-rich-text h2,.rabbit-rich-text h3,.rabbit-rich-text h4,.rabbit-rich-text h5,.rabbit-rich-text h6 { margin:.8em 0 .35em;font-size:1em;line-height:1.5;font-weight:600; }
    .rabbit-rich-text ul,.rabbit-rich-text ol { margin:.45em 0;padding-left:1.4em; }
    .rabbit-rich-text li { margin:.15em 0; }
    .rabbit-rich-text li > p { margin:.15em 0; }
    .rabbit-rich-text a { color:var(--rabbit-accent);text-decoration:none;overflow-wrap:anywhere; }
    .rabbit-rich-text a:hover { text-decoration:underline; }
    .rabbit-rich-text blockquote { margin:.6em 0;padding-left:.9em;border-left:2px solid color-mix(in srgb,var(--rabbit-accent) 24%,white);color:var(--rabbit-muted); }
    .rabbit-rich-text code { font-family:var(--rabbit-font);font-size:.92em; }
    .rabbit-rich-text :not(pre) > code { padding:.12em .3em;border-radius:4px;background:color-mix(in srgb,var(--rabbit-ink) 5%,white); }
    .rabbit-rich-text pre { max-width:100%;margin:.6em 0;padding:10px 12px;border-radius:10px;overflow:auto;background:color-mix(in srgb,var(--rabbit-ink) 4%,white);line-height:1.6; }
    .rabbit-rich-text pre code { white-space:pre;overflow-wrap:normal;word-break:normal; }
    .rabbit-rich-text table { display:block;max-width:100%;overflow-x:auto;border-collapse:collapse;margin:.6em 0; }
    .rabbit-rich-text th,.rabbit-rich-text td { padding:.3em .6em;border-bottom:1px solid color-mix(in srgb,var(--rabbit-ink) 10%,white);text-align:left; }
    .rabbit-rich-text hr { margin:.8em 0;border:0;border-top:1px solid color-mix(in srgb,var(--rabbit-ink) 10%,white); }
    .rabbit-rich-text .rabbit-math { display:inline-block;max-width:100%;overflow-x:auto;overflow-y:hidden;vertical-align:middle; }
    .rabbit-rich-text .rabbit-math-display { display:block;margin:.55em 0; }
    .rabbit-rich-text .katex { font-size:1.05em; }
    .rabbit-rich-text .katex-display { margin:0;padding:3px 0;text-align:left; }
    .rabbit-rich-text .katex-display > .katex { text-align:left; }
    .rabbit-rich-text .katex-error { color:var(--rabbit-muted)!important; }
  `;
  document.head.appendChild(style);

  const delimiters = [
    { open: '\\[', close: '\\]', display: true },
    { open: '\\(', close: '\\)', display: false },
    { open: '$$', close: '$$', display: true },
    { open: '$', close: '$', display: false }
  ];
  let markdown;

  function escapedAt(source, index) {
    let slashes = 0;
    while (index > 0 && source[--index] === '\\') slashes++;
    return slashes % 2 === 1;
  }

  function closingIndex(source, delimiter, from, end = source.length) {
    let index = source.indexOf(delimiter, from);
    while (index !== -1 && index + delimiter.length <= end) {
      const partOfDouble = delimiter === '$' && (source[index - 1] === '$' || source[index + 1] === '$');
      if (!escapedAt(source, index) && !partOfDouble) return index;
      index = source.indexOf(delimiter, index + delimiter.length);
    }
    return -1;
  }

  function mathMarkup(tokens, index) {
    const token = tokens[index];
    if (!token.content.trim()) return markdown.utils.escapeHtml(token.meta.source);
    // 每个公式独立持有宏，外部输入不能建立跨消息的宏状态或注入 HTML。
    const formula = window.katex.renderToString(token.content, {
      displayMode: token.meta.display,
      output: 'htmlAndMathml',
      trust: false,
      throwOnError: false,
      strict: 'ignore',
      maxSize: 12,
      maxExpand: 1000,
      macros: Object.create(null)
    });
    return '<span class="rabbit-math' + (token.meta.display ? ' rabbit-math-display' : '') + '">' + formula + '</span>';
  }

  function inlineMath(state, silent) {
    const start = state.pos;
    const pair = delimiters.find(pair => state.src.startsWith(pair.open, start));
    if (!pair || (pair.open === '$' && /\s/.test(state.src[start + 1] || ' '))) return false;
    const end = closingIndex(state.src, pair.close, start + pair.open.length, state.posMax);
    if (end === -1) {
      // 流式公式尚未闭合时保持整段原文，避免反斜杠和下划线被 Markdown 吞掉。
      if (!silent) state.push('text', '', 0).content = state.src.slice(start, state.posMax);
      state.pos = state.posMax;
      return true;
    }
    if (!silent) {
      const token = state.push('rabbit_math', '', 0);
      token.content = state.src.slice(start + pair.open.length, end);
      token.meta = { display: pair.display, source: state.src.slice(start, end + pair.close.length) };
    }
    state.pos = end + pair.close.length;
    return true;
  }

  function blockMath(state, startLine, endLine, silent) {
    if (state.sCount[startLine] - state.blkIndent >= 4) return false;
    const begin = state.bMarks[startLine] + state.tShift[startLine];
    const first = state.src.slice(begin, state.eMarks[startLine]);
    const pair = delimiters.find(pair => pair.display && first.startsWith(pair.open));
    if (!pair) return false;
    const lines = [];
    let closed = false, nextLine = startLine;
    for (; nextLine < endLine; nextLine++) {
      const from = state.bMarks[nextLine] + state.tShift[nextLine];
      const line = state.src.slice(from, state.eMarks[nextLine]);
      const content = nextLine === startLine ? line.slice(pair.open.length) : line;
      const end = closingIndex(content, pair.close, 0);
      if (end !== -1) {
        if (content.slice(end + pair.close.length).trim()) return false;
        lines.push(content.slice(0, end)); closed = true; break;
      }
      lines.push(content);
    }
    if (!closed) return false;
    if (silent) return true;
    const token = state.push('rabbit_math', '', 0);
    token.block = true; token.map = [startLine, nextLine + 1]; token.content = lines.join('\n');
    token.meta = { display: true, source: pair.open + token.content + pair.close };
    state.line = nextLine + 1;
    return true;
  }

  function parser() {
    if (markdown) return markdown;
    markdown = window.markdownit({ html: false, linkify: true, breaks: true, typographer: false });
    const validate = markdown.validateLink.bind(markdown);
    markdown.validateLink = url => /^https?:\/\//i.test(url) && validate(url);
    const linkOpen = markdown.renderer.rules.link_open;
    markdown.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
      tokens[index].attrSet('target', '_blank');
      tokens[index].attrSet('rel', 'noopener noreferrer');
      return linkOpen ? linkOpen(tokens, index, options, env, renderer) : renderer.renderToken(tokens, index, options);
    };
    // 图片附件由应用单独管理，模型回复中的图片不触发外部资源请求。
    markdown.renderer.rules.image = (tokens, index) => markdown.utils.escapeHtml(tokens[index].content);
    markdown.inline.ruler.before('escape', 'rabbit_math', inlineMath);
    markdown.block.ruler.before('fence', 'rabbit_math', blockMath, { alt: ['paragraph', 'blockquote', 'list'] });
    markdown.renderer.rules.rabbit_math = mathMarkup;
    return markdown;
  }

  function render(element, text) {
    const source = String(text ?? '');
    element.classList.add('rabbit-rich-text');
    if (!window.markdownit || !window.DOMPurify || !window.katex) {
      element.style.whiteSpace = 'pre-wrap';
      element.textContent = source;
      return;
    }
    element.style.whiteSpace = 'normal';
    // KaTeX 和 Markdown 的最终输出一起清理，不在清理后拼接用户内容。
    element.innerHTML = window.DOMPurify.sanitize(parser().render(source), {
      USE_PROFILES: { html: true, mathMl: true, svg: true },
      ADD_ATTR: ['target'],
      FORBID_TAGS: ['img', 'image'],
      ALLOW_UNKNOWN_PROTOCOLS: false,
      ALLOWED_URI_REGEXP: /^https?:\/\//i
    });
  }

  window.RabbitRender = Object.freeze({ render });
})();
