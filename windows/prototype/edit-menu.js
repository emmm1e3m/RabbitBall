(() => {
  'use strict';
  if (window.RabbitEditMenu) return;
  const bridge = window.rabbitDesktop, scene = document.getElementById('scene');
  const style = document.createElement('style');
  style.textContent = `
    #rabbit-edit-menu { position:absolute;z-index:10001;min-width:156px;padding:5px;border:1px solid var(--rb-line,#f0e4ea);border-radius:13px;background:#fff;box-shadow:0 8px 28px var(--rb-shadow,#30253014);font:13px/1.5 var(--rabbit-font, sans-serif);color:var(--rb-text,#765366);user-select:none; }
    #rabbit-edit-menu[hidden] { display:none; }
    #rabbit-edit-menu button { display:flex;align-items:center;justify-content:space-between;gap:28px;width:100%;padding:7px 10px;border:0;border-radius:8px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer; }
    #rabbit-edit-menu button:hover,#rabbit-edit-menu button.is-active { background:var(--rb-soft,#fbf0f5);color:var(--rb-accent,#de88ad); }
    #rabbit-edit-menu button:disabled { color:var(--rb-text-muted,#c0a4b1);opacity:.55;cursor:default;background:transparent; }
    #rabbit-edit-menu kbd { color:var(--rb-text-muted,#c0a4b1);font:11px var(--rabbit-font, sans-serif); }
  `;
  document.head.appendChild(style);
  const menu = document.createElement('div');
  menu.id = 'rabbit-edit-menu'; menu.hidden = true; menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', '编辑');
  const actions = [['undo', '撤销', 'Ctrl+Z'], ['redo', '重做', 'Ctrl+Shift+Z / Ctrl+Y'], ['cut', '剪切', 'Ctrl+X'], ['copy', '复制', 'Ctrl+C'], ['paste', '粘贴', 'Ctrl+V'], ['selectAll', '全选', 'Ctrl+A']];
  menu.innerHTML = actions.map(([action, label, key]) => `<button type="button" role="menuitem" tabindex="-1" data-action="${action}"><span>${label}</span><kbd>${key}</kbd></button>`).join('');
  scene.appendChild(menu);
  const buttons = [...menu.querySelectorAll('button')];
  let target = null, epoch = 0, editVersion = 0, activeIndex = -1, compositionTarget = null;
  const editable = element => element?.matches('textarea,input:not([type]),input[type="text"],input[type="search"],input[type="url"],input[type="tel"],input[type="email"],input[type="password"],input[type="number"]') && !element.disabled;
  const session = element => element.matches('.chat-input') ? window.RabbitChat?.getSnapshot().activation : null;
  function close() { menu.hidden = true; target = null; activeIndex = -1; }
  function containsPoint({ x, y }) {
    if (menu.hidden) return false;
    const rect = menu.getBoundingClientRect(), parent = scene.getBoundingClientRect();
    return x >= rect.left - parent.left && x <= rect.right - parent.left && y >= rect.top - parent.top && y <= rect.bottom - parent.top;
  }
  async function paste(element) {
    if (!editable(element) || element.readOnly) return;
    const pending = { epoch, editVersion, session: session(element), value: element.value, start: element.selectionStart, end: element.selectionEnd };
    const content = bridge ? await bridge.readClipboardForPaste() : { text: await navigator.clipboard.readText() };
    // 剪贴板读取可能跨越一次关闭或重新激活，只写回发起操作时的输入与选区。
    if (!element.isConnected || document.activeElement !== element || pending.epoch !== epoch || pending.editVersion !== editVersion || pending.session !== session(element) || pending.value !== element.value || pending.start !== element.selectionStart || pending.end !== element.selectionEnd) return;
    if (content.imageDataUrl && element.matches('.chat-input')) {
      document.dispatchEvent(new CustomEvent('clipboard:image', { detail: { imageDataUrl: content.imageDataUrl } }));
    } else if (typeof content.text === 'string' && content.text) {
      document.execCommand('insertText', false, content.text);
    }
  }
  async function run(action, element = target) {
    close();
    if (!element?.isConnected || !editable(element)) return;
    if (['undo', 'redo', 'cut', 'paste'].includes(action) && (element.readOnly || compositionTarget === element)) return;
    element.focus({ preventScroll: true });
    if (action === 'paste') await paste(element);
    else if (bridge) await bridge.editText(action);
    else document.execCommand(action);
  }
  function reportFailure(error) {
    // 编辑失败不改变原文与选区，便于用户重试。
    console.warn('编辑操作未完成', error);
  }
  document.addEventListener('contextmenu', event => {
    if (!editable(event.target)) { close(); return; }
    event.preventDefault(); event.stopPropagation();
    target = event.target; target.focus({ preventScroll: true });
    const selected = Number.isInteger(target.selectionStart) && Number.isInteger(target.selectionEnd) ? target.selectionStart !== target.selectionEnd : null;
    buttons.forEach(button => {
      const action = button.dataset.action;
      button.disabled = ((action === 'cut' || action === 'copy') && !(selected ?? document.queryCommandEnabled(action))) || ((action === 'cut' || action === 'paste') && target.readOnly) || (action === 'selectAll' && !target.value) || (['undo', 'redo'].includes(action) && (target.readOnly || compositionTarget === target || !document.queryCommandEnabled(action)));
      button.classList.remove('is-active');
    });
    activeIndex = -1; menu.hidden = false;
    const parent = scene.getBoundingClientRect();
    const input = target.getBoundingClientRect();
    const x = event.clientX || input.left, y = event.clientY || input.bottom;
    menu.style.left = Math.max(0, Math.min(scene.clientWidth - menu.offsetWidth, x - parent.left)) + 'px';
    menu.style.top = Math.max(0, Math.min(scene.clientHeight - menu.offsetHeight, y - parent.top)) + 'px';
  }, true);
  menu.addEventListener('pointerdown', event => { event.preventDefault(); event.stopPropagation(); });
  menu.addEventListener('click', event => {
    event.stopPropagation();
    const button = event.target.closest('button');
    if (button && !button.disabled) void run(button.dataset.action).catch(reportFailure);
  });
  document.addEventListener('pointerdown', event => {
    if (menu.contains(event.target)) return;
    editVersion++; close();
  }, true);
  document.addEventListener('desktop:pointerdown', event => { if (!containsPoint(event.detail)) { editVersion++; close(); } });
  document.addEventListener('paste', event => {
    if (!bridge || !editable(event.target)) return;
    event.preventDefault(); event.stopPropagation();
    close(); void paste(event.target).catch(reportFailure);
  }, true);
  document.addEventListener('keydown', event => {
    const element = event.target, key = event.key.toLowerCase();
    const historyAction = (event.ctrlKey || event.metaKey) && !event.altKey ? key === 'z' ? event.shiftKey ? 'redo' : 'undo' : key === 'y' ? 'redo' : null : null;
    if (historyAction && editable(element)) {
      // 输入历史只交给浏览器原生编辑栈，不让同一按键触发画布结构撤销。
      event.stopImmediatePropagation();
      if (event.isComposing || event.keyCode === 229 || compositionTarget === element) return;
      event.preventDefault(); editVersion++; close();
      if (!element.readOnly) void run(historyAction, element).catch(reportFailure);
      return;
    }
    if (event.isComposing || event.keyCode === 229 || compositionTarget === element) { close(); return; }
    if (menu.hidden) { editVersion++; return; }
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(); return; }
    if (['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)) {
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.key === 'Enter') { if (activeIndex >= 0) void run(buttons[activeIndex].dataset.action).catch(reportFailure); return; }
      const enabled = buttons.map((button, index) => button.disabled ? -1 : index).filter(index => index >= 0);
      const current = enabled.indexOf(activeIndex), next = event.key === 'ArrowDown' ? current + 1 : current < 0 ? enabled.length - 1 : current - 1;
      activeIndex = enabled[(next + enabled.length) % enabled.length] ?? -1;
      buttons.forEach((button, index) => button.classList.toggle('is-active', index === activeIndex));
    } else { editVersion++; close(); }
  }, true);
  document.addEventListener('compositionstart', event => { if (editable(event.target)) { compositionTarget = event.target; editVersion++; } }, true);
  document.addEventListener('compositionend', event => { if (compositionTarget === event.target) compositionTarget = null; }, true);
  for (const name of ['input', 'select']) document.addEventListener(name, () => { editVersion++; }, true);
  for (const name of ['chat:open', 'chat:close', 'settings:open', 'settings:close', 'selection:open', 'selection:close', 'graph:open', 'graph:close', 'graph:contextchange']) document.addEventListener(name, () => { epoch++; close(); });
  window.addEventListener('resize', close);
  window.addEventListener('blur', () => { epoch++; compositionTarget = null; close(); });
  window.RabbitEditMenu = Object.freeze({ paste, close, containsPoint });
})();
