(() => {
  'use strict';

  function indexContent(container) {
    const parts = []; let text = '';
    const append = (node, value, math = false, display = false) => {
      if (!value) return;
      const start = text.length; text += value;
      parts.push({ node, text: value, start, end: text.length, math, display });
    };
    const visit = node => {
      if (node.nodeType === 3) { append(node, node.textContent); return; }
      if (node.nodeType !== 1) return;
      // 公式只占一个语义单元，隐藏的 MathML 与可见排版不能各算一次。
      if (node.matches('.rabbit-math,.katex')) {
        const tex = node.getAttribute('data-latex') ?? node.querySelector('annotation[encoding="application/x-tex"]')?.textContent ?? node.querySelector('.katex-html')?.textContent ?? node.textContent;
        const display = node.matches('.rabbit-math-display') || !!node.closest('.katex-display');
        append(node, display ? `$$\n${tex}\n$$` : `$${tex}$`, true, display);
        return;
      }
      if (node.matches('script,style,[hidden],.katex-mathml') || node.getAttribute('aria-hidden') === 'true') return;
      for (const child of node.childNodes) visit(child);
    };
    for (const child of container.childNodes) visit(child);
    return { parts, text };
  }

  function bounds(rect) {
    return { left: rect.left, top: rect.top, right: rect.left + rect.width,
      bottom: rect.top + rect.height, width: rect.width, height: rect.height };
  }

  function mergedRects(values) {
    const rows = [];
    for (const value of values.filter(rect => rect.width > 0 && rect.height > 0).sort((a, b) => a.top - b.top || a.left - b.left)) {
      const rect = { ...bounds(value), display: !!value.display };
      // 公式的基线与文字不同，最后加入的公式也可能把两个文字行段连成一片。
      for (let index = 0; !rect.display && index < rows.length;) {
        const row = rows[index], gap = Math.max(4, Math.min(row.height, rect.height) * .5);
        if (row.display || Math.min(row.bottom, rect.bottom) - Math.max(row.top, rect.top) < Math.min(row.height, rect.height) * .45 ||
          rect.left > row.right + gap || rect.right < row.left - gap) { index++; continue; }
        rect.left = Math.min(row.left, rect.left); rect.top = Math.min(row.top, rect.top);
        rect.right = Math.max(row.right, rect.right); rect.bottom = Math.max(row.bottom, rect.bottom);
        rect.width = rect.right - rect.left; rect.height = rect.bottom - rect.top;
        rows.splice(index, 1); index = 0;
      }
      rows.push(rect);
    }
    return rows.sort((a, b) => a.top - b.top || a.left - b.left).map(({ display, ...rect }) => rect);
  }

  function mathRect(part) {
    const visual = part.node.querySelector('.katex-html') || part.node.querySelector('.katex-error') || part.node;
    // 行间公式外壳占满整行；只合并顶层排版块，保留分式的真实高度。
    const boxes = Array.from(visual.children, child => child.getBoundingClientRect());
    if (!boxes.length) boxes.push(visual.getBoundingClientRect());
    const clip = part.node.getBoundingClientRect();
    const left = Math.max(Math.min(...boxes.map(rect => rect.left)), clip.left);
    const top = Math.max(Math.min(...boxes.map(rect => rect.top)), clip.top);
    const right = Math.min(Math.max(...boxes.map(rect => rect.right)), clip.right);
    const bottom = Math.min(Math.max(...boxes.map(rect => rect.bottom)), clip.bottom);
    return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top), display: part.display };
  }

  function selectionGeometry(container, index, selection) {
    const rects = [];
    for (const part of index.parts) {
      if (part.end <= selection.start || part.start >= selection.end) continue;
      if (part.math) { rects.push(mathRect(part)); continue; }
      const range = container.ownerDocument.createRange();
      range.setStart(part.node, Math.max(0, selection.start - part.start));
      range.setEnd(part.node, Math.min(part.text.length, selection.end - part.start));
      rects.push(...range.getClientRects());
    }
    return mergedRects(rects);
  }

  function result(container, index, start, end) {
    const text = index.text.slice(start, end);
    if (!text.trim()) return null;
    const selection = { kind: 'text', text, start, end }, rects = selectionGeometry(container, index, selection);
    if (!rects.length) return null;
    const left = Math.min(...rects.map(rect => rect.left)), top = Math.min(...rects.map(rect => rect.top));
    const right = Math.max(...rects.map(rect => rect.right)), bottom = Math.max(...rects.map(rect => rect.bottom));
    return { selection, rects, anchor: { left, top, right, bottom, width: right - left, height: bottom - top } };
  }

  function capture(container, range) {
    if (!range || range.collapsed || !container.contains(range.commonAncestorContainer)) return null;
    const index = indexContent(container); let start, end;
    for (const part of index.parts) {
      if (!range.intersectsNode(part.node)) continue;
      const from = part.math ? 0 : range.startContainer === part.node ? range.startOffset : 0;
      const to = part.math ? part.text.length : range.endContainer === part.node ? range.endOffset : part.text.length;
      if (to <= from) continue;
      if (start === undefined) start = part.start + from;
      end = part.start + to;
    }
    return start === undefined ? null : result(container, index, start, end);
  }

  function legacyRange(container, selection) {
    if (!Number.isInteger(selection.start) || !Number.isInteger(selection.end) || selection.start < 0 || selection.end <= selection.start) return null;
    const doc = container.ownerDocument, walker = doc.createTreeWalker(container, 4);
    let offset = 0, node, first, last, firstOffset, lastOffset;
    while ((node = walker.nextNode())) {
      const next = offset + node.textContent.length;
      if (!first && selection.start >= offset && selection.start <= next) { first = node; firstOffset = selection.start - offset; }
      if (selection.end >= offset && selection.end <= next) { last = node; lastOffset = selection.end - offset; break; }
      offset = next;
    }
    if (!first || !last) return null;
    const range = doc.createRange(); range.setStart(first, firstOffset); range.setEnd(last, lastOffset);
    return range.toString() === selection.text ? range : null;
  }

  function rects(container, selection) {
    const index = indexContent(container);
    if (Number.isInteger(selection.start) && Number.isInteger(selection.end) &&
      selection.start >= 0 && selection.end > selection.start && index.text.slice(selection.start, selection.end) === selection.text)
      return selectionGeometry(container, index, selection);
    // 已有批注在内容相同但排版变化时，优先用唯一的语义文本恢复。
    const start = selection.text ? index.text.indexOf(selection.text) : -1;
    if (start >= 0 && index.text.indexOf(selection.text, start + 1) < 0)
      return selectionGeometry(container, index, { start, end: start + selection.text.length });
    // 旧资料使用原始 DOM 偏移；核对原文后进入同一条公式/高亮处理路径。
    const range = legacyRange(container, selection);
    return range ? capture(container, range)?.rects || [] : [];
  }

  window.RabbitGraphSelection = Object.freeze({ capture, rects });
})();
