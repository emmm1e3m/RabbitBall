(() => {
  'use strict';
  if (window.RabbitChat) return;
  const scene = document.getElementById('scene');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const style = document.createElement('style');
  style.textContent = `
    #rabbit-chat-root { position:absolute;inset:0;z-index:8;pointer-events:none;font:inherit;--chat-ink:var(--rb-text,var(--rabbit-ink,#765366));--chat-secondary:var(--rb-text-secondary,#a98396);--chat-muted:var(--rb-text-muted,var(--rabbit-muted,#c0a4b1));--chat-accent:var(--rb-accent,var(--rabbit-accent,#de88ad));--chat-line:var(--rb-line,#f0e4ea);--chat-soft:var(--rb-soft,var(--rabbit-soft,#fbf0f5)); }
    #rabbit-chat-root * { box-sizing:border-box; }
    #rabbit-chat-root button,#rabbit-chat-root input { font:inherit;-webkit-tap-highlight-color:transparent; }
    #rabbit-chat-root button { cursor:pointer; }
    #rabbit-chat-root button svg { width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2.25;stroke-linecap:round;stroke-linejoin:round;flex:none; }
    #rabbit-chat-root .chat-shell { position:absolute;opacity:0;transform:translateY(9px) scale(.98);pointer-events:none;transition:opacity .22s,transform .36s cubic-bezier(.22,1,.36,1),width .35s cubic-bezier(.22,1,.36,1),left .35s cubic-bezier(.22,1,.36,1),top .35s cubic-bezier(.22,1,.36,1); }
    #rabbit-chat-root.is-open .chat-shell { opacity:1;transform:translateY(0) scale(1);pointer-events:auto; }
    #rabbit-chat-root.is-pet-dragging .chat-shell { transition:none; }
    #rabbit-chat-root.capture-suspended .chat-shell { opacity:0;pointer-events:none; }
    #rabbit-chat-root .chat-panel { position:absolute;left:0;right:0;bottom:0;height:56px;overflow:hidden;border:1px solid var(--chat-line);border-radius:22px;background:#fff;box-shadow:0 8px 30px #a4678210;transition:height .42s cubic-bezier(.22,1,.36,1),box-shadow .3s; }
    #rabbit-chat-root.is-expanded .chat-panel { height:var(--expanded-height);box-shadow:0 12px 38px #a4678212; }
    #rabbit-chat-root .chat-history { position:absolute;left:19px;right:19px;top:35px;bottom:70px;overflow-y:auto;overscroll-behavior:contain;touch-action:auto;scrollbar-width:thin;scrollbar-color:var(--chat-line) transparent;opacity:0;transform:translateY(10px);pointer-events:none;transition:opacity .2s,transform .3s; }
    #rabbit-chat-root.is-expanded .chat-history { opacity:1;transform:translateY(0);pointer-events:auto;transition-delay:.12s; }
    #rabbit-chat-root .chat-collapse { position:absolute;z-index:2;right:9px;top:8px;width:25px;height:25px;display:grid;place-items:center;border:0;border-radius:50%;background:#fff;color:var(--chat-muted);opacity:0;pointer-events:none;transition:opacity .18s,background .2s; }
    #rabbit-chat-root .chat-collapse svg { width:16px;height:16px; }
    #rabbit-chat-root.is-expanded .chat-collapse { opacity:1;pointer-events:auto; }
    #rabbit-chat-root .chat-collapse:hover { background:var(--chat-soft);color:var(--chat-accent); }
    #rabbit-chat-root .chat-message { margin:0 0 19px;color:var(--chat-ink);font-size:15px;line-height:1.8;overflow-wrap:anywhere;animation:rb-message-arrive .28s ease both; }
    #rabbit-chat-root .chat-message:last-child { margin-bottom:0; }
    #rabbit-chat-root .chat-message.user { margin-left:35px;color:var(--chat-secondary);text-align:right;white-space:pre-wrap; }
    #rabbit-chat-root .chat-message.assistant { margin-right:8px; }
    #rabbit-chat-root .chat-response-actions { display:flex;gap:5px;margin-top:7px; }
    #rabbit-chat-root .chat-response-action { display:grid;place-items:center;width:25px;height:25px;padding:0;border:0;border-radius:7px;background:#fff;color:var(--chat-muted);transition:color .18s,background .18s,opacity .18s; }
    #rabbit-chat-root .chat-response-action svg { width:15px;height:15px;stroke-width:2.25; }
    #rabbit-chat-root .chat-response-action:hover { color:var(--chat-accent);background:var(--chat-soft); }
    #rabbit-chat-root .chat-response-action:disabled { opacity:.35;cursor:default;background:#fff; }
    #rabbit-chat-root .chat-message.assistant > :first-child { margin-top:0; }
    #rabbit-chat-root .chat-message.assistant > :last-child { margin-bottom:0; }
    #rabbit-chat-root .chat-message p { margin:.65em 0; }
    #rabbit-chat-root .chat-message h1,#rabbit-chat-root .chat-message h2,#rabbit-chat-root .chat-message h3 { font-size:16px;line-height:1.55;font-weight:500;margin:1em 0 .4em; }
    #rabbit-chat-root .chat-message ul,#rabbit-chat-root .chat-message ol { padding-left:1.5em;margin:.6em 0; }
    #rabbit-chat-root .chat-message blockquote { margin:.7em 0;padding-left:10px;border-left:2px solid var(--chat-line);color:var(--chat-secondary); }
    #rabbit-chat-root .chat-message pre { margin:.7em 0;padding:10px;border-radius:9px;background:var(--chat-soft);overflow:auto;font-size:13px; }
    #rabbit-chat-root .chat-message code { font-size:.9em; }
    #rabbit-chat-root .chat-message a { color:var(--chat-accent);text-decoration-color:var(--chat-line);text-underline-offset:3px; }
    #rabbit-chat-root .chat-message .katex-display { overflow:auto;overflow-y:hidden;padding:2px 0; }
    #rabbit-chat-root .chat-message.is-streaming::after { content:'';display:inline-block;width:3px;height:11px;margin-left:3px;border-radius:2px;background:var(--chat-accent);animation:rb-chat-cursor .8s infinite; }
    #rabbit-chat-root .chat-progress { margin-bottom:6px;color:var(--chat-muted);font-size:13px;line-height:1.6; }
    #rabbit-chat-root .chat-message.is-error { color:var(--chat-secondary);font-size:14px; }
    #rabbit-chat-root .chat-demo-label { display:block;margin-bottom:5px;color:var(--chat-muted);font-size:12px; }
    #rabbit-chat-root .chat-composer { position:absolute;left:0;right:0;bottom:0;height:55px;display:flex;align-items:center;gap:8px;padding:9px 10px 9px 13px;border:0;background:#fff; }
    #rabbit-chat-root .chat-add { flex:none;display:grid;place-items:center;width:25px;height:29px;padding:0;border:0;border-radius:9px;background:#fff;color:var(--chat-muted);transition:color .2s,background .2s; }
    #rabbit-chat-root .chat-add svg { width:20px;height:20px; }
    #rabbit-chat-root .chat-add:hover { color:var(--chat-accent);background:var(--chat-soft); }
    #rabbit-chat-root .chat-input { min-width:0;width:0;flex:1;height:34px;margin:0;padding:3px 0;border:0;outline:0;background:#fff;color:var(--chat-ink);font-size:15px;line-height:1.5; }
    #rabbit-chat-root .chat-send { flex:none;display:grid;place-items:center;width:32px;height:32px;padding:0;border:0;border-radius:50%;background:var(--chat-soft);color:var(--chat-accent);transition:background .2s,transform .2s,opacity .2s; }
    #rabbit-chat-root .chat-send svg { width:18px;height:18px;stroke-width:2.25; }
    #rabbit-chat-root .chat-send:hover { transform:translateY(-1px); }
    #rabbit-chat-root .chat-send:disabled { opacity:.48;cursor:default;transform:none; }
    #rabbit-chat-root .chat-contexts { flex:none;display:flex;gap:5px;align-items:center;max-width:38%;padding:5px 4px;overflow-x:auto;overflow-y:hidden;scrollbar-width:none; }
    #rabbit-chat-root .chat-contexts:empty { display:none; }
    #rabbit-chat-root .chat-context-chip { position:relative;display:flex;flex:none;align-items:center;justify-content:center;gap:3px;max-width:74px;min-width:28px;height:26px;padding:3px 5px;border-radius:6px;background:var(--chat-soft);color:var(--chat-secondary);font-size:11px;white-space:nowrap; }
    #rabbit-chat-root .chat-context-chip.has-image { width:32px;padding:0;background:#fff; }
    #rabbit-chat-root .chat-context-chip img { display:block;width:32px;height:26px;object-fit:cover;border-radius:5px; }
    #rabbit-chat-root .chat-context-chip > svg { width:12px;height:12px;fill:none;stroke:currentColor;stroke-width:1.5; }
    #rabbit-chat-root .chat-context-chip > span { overflow:hidden;text-overflow:ellipsis; }
    #rabbit-chat-root .chat-context-remove { position:absolute;right:-4px;top:-5px;width:13px;height:13px;display:grid;place-items:center;border:0;border-radius:50%;padding:0;background:#fff;color:var(--chat-muted);box-shadow:0 0 0 1px var(--chat-line); }
    #rabbit-chat-root .chat-context-remove svg { width:8px;height:8px;stroke-width:1.8; }
    #rabbit-chat-root .chat-shortcuts { position:absolute;left:8px;top:9px;display:flex;align-items:center;gap:5px;transition:opacity .16s,transform .26s; }
    #rabbit-chat-root.is-expanded .chat-shortcuts { opacity:0;transform:translateY(-6px);pointer-events:none; }
    #rabbit-chat-root .chat-shortcut { display:grid;place-items:center;width:32px;height:32px;padding:0;border:0;border-radius:50%;background:#F4F4F6;color:var(--chat-secondary);transition:color .2s,background .2s,transform .2s; }
    #rabbit-chat-root .chat-shortcut:hover { color:var(--chat-accent);background:var(--chat-soft);transform:translateY(-1px); }
    #rabbit-chat-root .chat-shortcut[hidden],#rabbit-chat-root .chat-response-action[hidden] { display:none; }
    #rabbit-chat-root .chat-shortcut[aria-pressed="true"] { color:var(--chat-accent);background:var(--chat-soft); }
    #rabbit-chat-root .chat-shortcut:disabled { opacity:.45;cursor:default;transform:none; }
    #rabbit-chat-root.is-graph-chat { z-index:24; }
    #rabbit-chat-root .chat-shortcut svg { width:16px;height:16px; }
    #rabbit-chat-root .chat-shortcut svg > * { stroke-width:2px;vector-effect:non-scaling-stroke; }
    #rabbit-chat-root .chat-shortcut .letter-t { font-family:var(--rabbit-font);font-size:19px;font-weight:500;line-height:1; }
    #rabbit-chat-root .chat-history-toggle { position:absolute;right:8px;top:9px; }
    #rabbit-chat-root .chat-history-toggle[hidden] { display:none; }
    #rabbit-chat-root .chat-history-toggle svg { width:18px;height:18px;transform:scale(.9); }
    #rabbit-chat-root .chat-history-toggle[aria-expanded="true"] { color:var(--chat-accent);background:var(--chat-soft); }
    #rabbit-chat-root .chat-archive { position:absolute;inset:0;opacity:0;transform:translateY(10px);pointer-events:none;transition:opacity .2s,transform .3s; }
    #rabbit-chat-root.is-choosing-history .chat-archive { opacity:1;transform:none;pointer-events:auto;transition-delay:.1s; }
    #rabbit-chat-root.is-choosing-history .chat-history,#rabbit-chat-root.is-choosing-history .chat-composer { opacity:0;visibility:hidden;pointer-events:none; }
    #rabbit-chat-root .chat-archive-title { margin:15px 20px 0;font-size:15px;font-weight:500;color:var(--chat-secondary); }
    #rabbit-chat-root .chat-archive-list { position:absolute;inset:46px 12px 14px;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:var(--chat-line) transparent; }
    #rabbit-chat-root .chat-archive-row { position:relative;margin:0 0 5px;border-radius:12px; }
    #rabbit-chat-root .chat-archive-open { display:flex;align-items:center;gap:11px;width:100%;min-height:72px;padding:10px 39px 10px 10px;text-align:left;border:0;border-radius:12px;background:transparent;color:var(--chat-ink); }
    #rabbit-chat-root .chat-archive-open:hover,#rabbit-chat-root .chat-archive-row:focus-within { background:var(--chat-soft); }
    #rabbit-chat-root .chat-archive-thumb { order:1;width:66px;height:48px;object-fit:cover;border:1px solid var(--chat-line);border-radius:7px;flex:none; }
    #rabbit-chat-root .chat-archive-copy { flex:1;min-width:0;display:grid;gap:5px; }
    #rabbit-chat-root .chat-archive-name { overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px; }
    #rabbit-chat-root .chat-archive-date { color:var(--chat-muted);font-size:12px; }
    #rabbit-chat-root .chat-archive-delete { position:absolute;right:7px;top:23px;display:grid;place-items:center;width:26px;height:26px;padding:0;border:0;border-radius:7px;background:transparent;color:var(--chat-muted);opacity:0;transition:opacity .15s,background .15s; }
    #rabbit-chat-root .chat-archive-row:hover .chat-archive-delete,#rabbit-chat-root .chat-archive-row:focus-within .chat-archive-delete { opacity:1; }
    #rabbit-chat-root .chat-archive-delete:hover { background:#fff;color:var(--chat-accent); }
    #rabbit-chat-root .chat-archive-delete svg { width:15px;height:15px; }
    #rabbit-chat-root .chat-archive-empty { padding:42px 12px;text-align:center;font-size:14px;color:var(--chat-muted); }
    #rabbit-chat-root .chat-original-shot { display:block;max-width:100%;max-height:160px;margin:0 0 18px;object-fit:contain;border:1px solid var(--chat-line);border-radius:10px; }
    @media(hover:none) { #rabbit-chat-root .chat-archive-delete { opacity:1; } }
    #rabbit-chat-root .chat-inline-note { position:absolute;left:10px;right:4px;top:45px;color:var(--chat-muted);font-size:12px;line-height:1.5; }
    #rabbit-chat-root.is-expanded .chat-inline-note { display:none; }
    #rabbit-chat-root .chat-file-input { display:none; }
    #rabbit-chat-root .chat-announcement { position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0; }
    @keyframes rb-message-arrive { from { opacity:0;transform:translateY(7px); } to { opacity:1;transform:translateY(0); } }
    @keyframes rb-chat-cursor { 50% { opacity:0; } }
    @media(max-width:619px) { #rabbit-chat-root .chat-input { font-size:18px; } #rabbit-chat-root .chat-composer { gap:6px;padding-left:10px; } #rabbit-chat-root .chat-context-chip { max-width:58px;font-size:10px; } }
    @media(prefers-reduced-motion:reduce) { #rabbit-chat-root *,#rabbit-chat-root *::after { animation:none!important;transition-duration:.01ms!important; } }
  `;
  document.head.appendChild(style);
  const paths = {
    plus:'<path d="M12 5v14M5 12h14"/>',
    send:'<path d="M12 19V5m-6 6 6-6 6 6"/>',
    stop:'<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>',
    close:'<path d="m6 6 12 12M18 6 6 18"/>',
    down:'<path d="m6 9 6 6 6-6"/>',
    search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/>',
    history:'<path d="M3 12a9 9 0 1 0 9-9 9 9 0 0 0-6.4 2.6L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',
    graph:'<rect x="9" y="2" width="6" height="6" rx="1.5"/><rect x="2" y="16" width="6" height="6" rx="1.5"/><rect x="16" y="16" width="6" height="6" rx="1.5"/><path d="M12 8v4M5 16v-4h14v4"/>',
    trash:'<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7m4-7v7"/>',
    type:'<path d="M4 8V5h16v3M12 5v15m-4 0h8"/>',
    translate:'<path d="M3 5h11M8 3v2m-3 0c0 5 4 8 7 10M12 5c0 5-4 8-7 10m8 6 4.5-11L22 21m-7-4h5"/>',
    regenerate:'<path d="M20 7v5h-5M4 17v-5h5M6.1 8a6.5 6.5 0 0 1 10.7-2L20 12M4 12l3.2 6A6.5 6.5 0 0 0 17.9 16"/>',
    copy:'<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
    check:'<path d="m5 12 4 4L19 6"/>',
    window:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 8h18"/>',
    file:'<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8l-5-5Z"/><path d="M14 3v5h5M8 13h8m-8 4h6"/>'
  };
  const icon = name => '<svg viewBox="0 0 24 24" aria-hidden="true">' + paths[name] + '</svg>';
  const root = document.createElement('div'); root.id = 'rabbit-chat-root';
  root.innerHTML = `
    <div class="chat-shell">
      <section class="chat-panel" id="rabbit-chat-panel" role="region" aria-label="聊天输入" aria-hidden="true" inert>
        <button class="chat-collapse" type="button" aria-label="收起对话" title="收起对话">${icon('down')}</button>
        <div class="chat-history" role="log" aria-label="对话记录" aria-live="off" inert></div>
        <div class="chat-archive" aria-hidden="true" inert><h2 class="chat-archive-title">历史记录</h2><div class="chat-archive-list" role="list" aria-label="选择历史对话"></div></div>
        <form class="chat-composer">
          <button class="chat-add" type="button" aria-label="添加图片或文本附件" title="添加图片或文本附件">${icon('plus')}</button>
          <div class="chat-contexts"></div>
          <input class="chat-input" type="text" maxlength="4000" aria-label="提问" autocomplete="off">
          <button class="chat-send" type="submit" aria-label="发送消息" title="发送消息" disabled>${icon('send')}</button>
        </form>
      </section>
      <div class="chat-shortcuts"><button class="chat-shortcut" data-intent="search" type="button" aria-label="搜索与解释" title="搜索与解释">${icon('search')}</button><button class="chat-shortcut" data-intent="extract" type="button" aria-label="提取文字" title="提取文字">${icon('type')}</button><button class="chat-shortcut" data-intent="translate" type="button" aria-label="翻译" title="翻译">${icon('translate')}</button><button class="chat-shortcut chat-graph-toggle" type="button" aria-label="大爆炸模式" title="大爆炸模式" aria-pressed="false">${icon('graph')}</button></div>
      <button class="chat-shortcut chat-history-toggle" type="button" aria-label="历史记录" title="历史记录" aria-expanded="false">${icon('history')}</button>
      <div class="chat-inline-note" aria-live="polite"></div>
      <input class="chat-file-input" type="file" accept="image/*,.txt,.md,text/plain,text/markdown" aria-label="选择附件">
    </div><div class="chat-announcement" aria-live="polite"></div>
  `;
  scene.appendChild(root);
  const $ = selector => root.querySelector(selector);
  const shell = $('.chat-shell'), panel = $('.chat-panel'), history = $('.chat-history');
  shell.inert = true;
  const input = $('.chat-input'), form = $('.chat-composer'), sendButton = $('.chat-send');
  const contexts = $('.chat-contexts'), note = $('.chat-inline-note'), fileInput = $('.chat-file-input');
  const collapseButton = $('.chat-collapse'), shortcuts = $('.chat-shortcuts');
  const graphButton = $('.chat-graph-toggle');
  const historyButton=$('.chat-history-toggle'),archive=$('.chat-archive'),archiveList=$('.chat-archive-list');
  const announcement = $('.chat-announcement');
  const state = { open:false, opening:false, presentation:'compact', busy:false, selecting:false, context:null, contextConsumed:false, conversationId:null, attachments:[], messages:[], bounds:null, layout:null, anchor:null, petPosition:null, run:null, demo:null, activation:0, activationId:null, capture:null, pickingFile:false, historyOpen:false, historyRequest:0, dragging:false, graph:false, graphKey:null, graphMode:false, switchingGraphMode:false };
  let boundsKey = '', layoutFrame = 0, focusFrame = 0, latestClientX = null, latestClientY = null, composing = false;
  const composingKey = event => composing || event.isComposing || event.keyCode === 229;
  const emit = (name, detail = {}) => document.dispatchEvent(new CustomEvent('chat:' + name, { detail }));
  const service = () => window.RabbitAssistant;
  const activity = (phase, busy) => emit('activity', {mode:phase,busy,source:state.demo?'demo':'chat'});
  const graphContextKey = context => context ? context.workspaceId+'/'+context.graphId : null;
  const currentGraphContext = () => window.RabbitGraph?.isOpen() ? window.RabbitGraph.getChatContext() : null;
  function invalidateGraphChat() { close();state.graphKey=null; }
  function graphChatContext() {
    const context=currentGraphContext();
    if(!state.graph||!state.graphKey||graphContextKey(context)!==state.graphKey){if(state.graph)invalidateGraphChat();return null;}
    return context;
  }

  const clamp = (value,min,max) => Math.max(min,Math.min(max,value));
  function activationPointer(pointer) {
    if(pointer)return {x:pointer.x,y:pointer.y};
    const snapshot = window.RabbitBallDemo.getSnapshot();
    const sceneRect = scene.getBoundingClientRect();
    const origin=window.rabbitDesktop&&snapshot.cursor?snapshot.cursor:latestClientX!==null?{x:latestClientX-sceneRect.left,y:latestClientY-sceneRect.top}:snapshot.cursor?.inside?snapshot.cursor:{x:scene.clientWidth*.5,y:scene.clientHeight*.5};
    return {x:origin.x,y:origin.y};
  }
  function petAnchor(pointer) {
    pointer=activationPointer(pointer);
    const narrow = scene.clientWidth<620;
    const size = document.getElementById('pet').getBoundingClientRect().width;
    const radius = Math.min(size,narrow?51:size)*137/360;
    const side=pointer.x<scene.clientWidth*.5?'left':'right';
    return {x:pointer.x+(side==='left'?1:-1)*(radius+20),y:pointer.y-24,radius,side};
  }
  function focusBounds() {
    if (!state.open || state.opening || !state.layout || state.selecting || state.historyOpen || state.dragging) return;
    // 使用目标布局与未变换的局部尺寸，避免开合动画中发出上一帧的屏幕坐标。
    const layout = state.layout, composerStyle = getComputedStyle(form);
    const gap = parseFloat(composerStyle.columnGap), paddingRight = parseFloat(composerStyle.paddingRight);
    const left = input.offsetLeft, border = panel.clientLeft;
    emit('focus', {bounds:{x:layout.left+border+left,y:layout.bottom-border-form.offsetHeight+input.offsetTop,
      width:Math.max(0,layout.width-border*2-left-gap-sendButton.offsetWidth-paddingRight),height:input.offsetHeight},active:true});
  }
  function focusComposer() {
    if(!state.open||state.opening||state.pickingFile||state.selecting||state.historyOpen||state.dragging)return;
    input.focus({preventScroll:true});focusBounds();
  }
  function measure() {
    const width = scene.clientWidth, height = scene.clientHeight, narrow = width < 620;
    const sceneRect = scene.getBoundingClientRect(), dock = scene.querySelector('.mode-dock');
    const anchor = state.anchor || petAnchor(), margin = narrow?12:16, gap = narrow?12:20;
    const radius = Math.min(anchor.radius,narrow?51*137/360:anchor.radius);
    const expanded=state.historyOpen||state.presentation==='expanded';
    const panelWidth = Math.min(380,width-margin*2-radius*2-gap);
    const pairWidth = panelWidth+gap+radius*2;
    const rawPairLeft = anchor.side==='left'?anchor.x-radius-gap-panelWidth:anchor.x-radius;
    const pairLeft = clamp(rawPairLeft,margin,width-margin-pairWidth);
    const left = anchor.side==='left'?pairLeft:pairLeft+radius*2+gap;
    const petX = anchor.side==='left'?pairLeft+panelWidth+gap+radius:pairLeft+radius;
    const bottomLimit = dock&&dock.getClientRects().length?dock.getBoundingClientRect().top-sceneRect.top-20:height-margin;
    const shortcutsHeight = 38;
    const maxBottom = Math.min(bottomLimit-shortcutsHeight,bottomLimit-radius+40);
    const expandedHeight = Math.min(narrow?340:408,maxBottom-margin);
    const panelHeight = expanded?expandedHeight:56;
    const bottom = clamp(anchor.y+40,Math.max(panelHeight+margin,40+radius*1.45+margin,40+(narrow?20:margin)+radius*360/137*.48),maxBottom);
    Object.assign(shell.style,{left:left+'px',top:bottom+'px',width:panelWidth+'px'});
    panel.style.setProperty('--expanded-height',expandedHeight+'px');
    state.layout={left,bottom,width:panelWidth,panelHeight};
    state.petPosition={x:petX,y:bottom-40};
    state.bounds = {x:left,y:bottom-panelHeight,width:panelWidth,height:panelHeight+38};
    const key = JSON.stringify({bounds:state.bounds,petPosition:state.petPosition});
    if (state.open && !state.opening && key!==boundsKey) emit('layout',{bounds:{...state.bounds},presentation:state.presentation,petPosition:{...state.petPosition}});
    boundsKey = key;
    cancelAnimationFrame(layoutFrame); layoutFrame = requestAnimationFrame(focusBounds);
  }
  function setPresentation(value) {
    state.presentation = value; root.classList.toggle('is-expanded',state.historyOpen||value==='expanded');
    history.inert = state.historyOpen||value!=='expanded'; collapseButton.inert = !state.historyOpen&&value!=='expanded'; shortcuts.inert = state.historyOpen||value==='expanded';
    measure();focusComposer();
  }
  function beginPetDrag() {
    if(!state.open||state.selecting)return;
    state.dragging=true;root.classList.add('is-pet-dragging');
    cancelAnimationFrame(focusFrame);focusFrame=0;
    emit('focus',{bounds:null,active:false});
  }
  function movePetDrag(position) {
    if(!state.open||!state.dragging)return state.petPosition;
    state.anchor={...state.anchor,x:position.x,y:position.y};measure();
    state.anchor.x=state.petPosition.x;state.anchor.y=state.petPosition.y;
    return {...state.petPosition};
  }
  function endPetDrag() { state.dragging=false;root.classList.remove('is-pet-dragging');focusComposer(); }
  function setHistoryOpen(value) {
    if(value&&historyButton.hidden)return;
    state.historyOpen=value;state.historyRequest++;
    root.classList.toggle('is-choosing-history',value);
    archive.inert=!value;archive.setAttribute('aria-hidden',String(!value));form.inert=value;
    historyButton.setAttribute('aria-expanded',String(value));
    collapseButton.setAttribute('aria-label',value?'返回对话':'收起对话');collapseButton.title=value?'返回对话':'收起对话';
    if(value){input.blur();emit('focus',{bounds:null,active:false});}
    setPresentation(state.presentation);
  }
  function applyHistorySettings(settings) {
    if(!Number.isSafeInteger(settings.historyLimit)||settings.historyLimit<0)return;
    historyButton.hidden=settings.historyLimit===0;
    if(historyButton.hidden){
      if(state.historyOpen)setHistoryOpen(false);
      archiveList.replaceChildren();
    }
  }
  function archiveStatus(text) {
    const status=document.createElement('div');status.className='chat-archive-empty';status.textContent=text;archiveList.replaceChildren(status);
  }
  async function chooseHistory(id) {
    const request=++state.historyRequest;
    try {
      const entry=await service().getHistory(id);
      if(request!==state.historyRequest||!state.open||!state.historyOpen)return;
      if(!entry){await loadHistory();return;}
      abortGeneration();cancelDemo();state.activation++;state.capture=null;
      clearMessages();input.value='';state.attachments=[];state.context=null;state.contextConsumed=true;state.conversationId=entry.id;note.textContent='';drawContexts();
      if(entry.firstScreenshot){
        const image=document.createElement('img');image.className='chat-original-shot';image.src=entry.firstScreenshot.imageDataUrl;image.alt='最开始的截图';history.appendChild(image);
      }
      for(const saved of entry.messages){
        const message=addMessage(saved.role,saved.content,saved.turn,!!saved.hidden);message.status=saved.status;
        if(saved.role==='assistant'&&message.element){
          if(saved.status==='complete')answerActions(message);
          else if(saved.status==='error')message.element.classList.add('is-error');
        }
      }
      setHistoryOpen(false);setPresentation('expanded');sync();scrollToBottom();
    } catch(error){if(request===state.historyRequest)archiveStatus(error.message||'暂时无法读取历史记录。');}
  }
  async function loadHistory() {
    const request=++state.historyRequest;
    archiveStatus('正在读取…');
    try {
      const entries=await service().listHistory();
      if(request!==state.historyRequest||!state.open||!state.historyOpen)return;
      archiveList.replaceChildren();
      if(!entries.length){archiveStatus('还没有历史对话');return;}
      for(const entry of entries){
        const row=document.createElement('div');row.className='chat-archive-row';row.setAttribute('role','listitem');
        const open=document.createElement('button');open.type='button';open.className='chat-archive-open';
        if(entry.thumbnail){const image=document.createElement('img');image.className='chat-archive-thumb';image.src=entry.thumbnail;image.alt='最开始的截图';open.appendChild(image);}
        const copy=document.createElement('span');copy.className='chat-archive-copy';
        const title=document.createElement('span');title.className='chat-archive-name';title.textContent=entry.title;open.title=entry.title;
        const date=document.createElement('span');date.className='chat-archive-date';date.textContent=new Date(entry.updatedAt).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
        copy.append(title,date);open.appendChild(copy);open.addEventListener('click',()=>chooseHistory(entry.id));
        const remove=document.createElement('button');remove.type='button';remove.className='chat-archive-delete';remove.innerHTML=icon('trash');remove.title='删除记录';remove.setAttribute('aria-label','删除记录：'+entry.title);
        remove.addEventListener('click',async()=>{
          remove.disabled=true;open.disabled=true;state.historyRequest++;
          // 立即换掉待删会话，写盘期间返回输入框也不能用旧 ID 重新创建它。
          if(entry.id===state.conversationId){abortGeneration();state.activation++;state.capture=null;clearMessages();state.conversationId=crypto.randomUUID();state.context=null;state.contextConsumed=false;state.attachments=[];input.value='';drawContexts();sync();}
          try {
            await service().deleteHistory(entry.id);
            if(state.historyOpen)await loadHistory();
          }
          catch(error){remove.disabled=false;open.disabled=false;announcement.textContent=error.message||'删除失败，请重试。';}
        });
        row.append(open,remove);archiveList.appendChild(row);
      }
    } catch(error){if(request===state.historyRequest)archiveStatus(error.message||'暂时无法读取历史记录。');}
  }
  function sync() {
    sendButton.disabled = !state.busy&&!input.value.trim()&&!state.attachments.length;
    sendButton.setAttribute('aria-label',state.busy?'停止回复':'发送消息'); sendButton.title=state.busy?'停止回复':'发送消息';
    sendButton.innerHTML = icon(state.busy?'stop':'send');
    shortcuts.querySelectorAll('.chat-shortcut').forEach(button=>{button.disabled=button===graphButton?state.switchingGraphMode:state.busy;});
    const sameGraph=state.graph&&state.graphKey&&graphContextKey(currentGraphContext())===state.graphKey;
    for(const message of state.messages)if(message.actions){
      message.regenerateButton.disabled=state.busy||!!message.addingToGraph;
      message.copyButton.disabled=state.busy||!!message.copying;
      message.graphButton.hidden=!sameGraph||graphContextKey(message.turn.graphContext)!==state.graphKey;
      message.graphButton.disabled=state.busy||!!message.addingToGraph||!!message.addedToGraph;
    }
  }
  function applyGraphSettings(settings) {
    if(typeof settings.graphPluginEnabled==='boolean')graphButton.hidden=!settings.graphPluginEnabled;
    if(typeof settings.graphModeEnabled==='boolean')state.graphMode=settings.graphModeEnabled;
    graphButton.setAttribute('aria-pressed',String(state.graphMode));
    graphButton.title=state.graphMode?'大爆炸已开启 · 启动键进入或退出图谱':'开启大爆炸并进入图谱';
    graphButton.setAttribute('aria-label',state.graphMode?'关闭大爆炸模式':'开启大爆炸模式');
  }
  function drawContexts() {
    contexts.replaceChildren();
    const values = [];
    if(state.context)for(const image of state.context.images)values.push({value:image,kind:'context',name:image.title,image:image.imageDataUrl});
    for (const attachment of state.attachments) values.push({value:attachment,kind:'attachment',name:attachment.name,image:attachment.mimeType.startsWith('image/')?attachment.dataUrl:null});
    for (const item of values) {
      const chip = document.createElement('span'); chip.className='chat-context-chip'; chip.title=item.kind==='context'?item.name+' · '+item.value.title:item.name;
      if (item.image) { chip.classList.add('has-image'); const image=document.createElement('img'); image.src=item.image; image.alt=item.name; chip.appendChild(image); }
      else { chip.innerHTML=icon(item.kind==='context'?'window':'file'); const name=document.createElement('span'); name.textContent=item.name; chip.appendChild(name); }
      const remove=document.createElement('button'); remove.type='button';remove.className='chat-context-remove';remove.setAttribute('aria-label','移除'+item.name);remove.title='移除'+item.name;remove.innerHTML=icon('close');
      remove.addEventListener('click',()=>{
        if(item.kind==='context')state.context={...state.context,images:state.context.images.filter(image=>image.id!==item.value.id)};
        else state.attachments=[];
        drawContexts();sync();
      });
      chip.appendChild(remove);contexts.appendChild(chip);
    }
    focusBounds();
  }
  function scrollToBottom() { history.scrollTop=history.scrollHeight; }
  function renderAssistant(element,text) {
    if (window.RabbitRender) window.RabbitRender.render(element,text);
    else element.textContent=text;
  }
  function removeMessage(message) { message.copyAnimation?.cancel();message.element?.remove(); }
  function addMessage(role,text,turn,hidden=false) {
    const message={role,content:text,turn,element:null,body:null,status:role==='assistant'?'pending':'complete',actions:null};
    if(!hidden){
      const element=document.createElement('div');element.className='chat-message '+role;message.element=element;
      if(role==='assistant'){
        message.body=document.createElement('div');message.body.className='chat-answer';element.appendChild(message.body);
        if(text)renderAssistant(message.body,text);
      }else element.textContent=text;
      history.appendChild(element);
    }
    state.messages.push(message);
    scrollToBottom();return message;
  }
  function clearMessages() { state.messages.forEach(removeMessage);state.messages=[];history.replaceChildren(); }
  function cardMarkdown(markdown) {
    const lines=markdown.replace(/\r\n?/g,'\n').split('\n'),headings=[];
    let fence=null;
    for(const [index,line] of lines.entries()){
      const marker=line.trim().match(/^(`{3,}|~{3,})(.*)$/);
      if(fence){
        if(marker&&marker[1][0]===fence.char&&marker[1].length>=fence.length&&!marker[2].trim())fence=null;
        continue;
      }
      if(marker){fence={char:marker[1][0],length:marker[1].length};continue;}
      const heading=line.match(/^( {0,3})(#{1,6})([ \t]+.*)$/);
      if(heading)headings.push({index,indent:heading[1],level:heading[2].length,text:heading[3]});
    }
    // 卡片占用三级标题；保留正文小标题的相对层级，代码示例保持原文。
    const shift=Math.max(0,4-Math.min(4,...headings.map(heading=>heading.level)));
    for(const heading of headings)lines[heading.index]=heading.indent+'#'.repeat(Math.min(6,heading.level+shift))+heading.text;
    return lines.join('\n');
  }
  function answerActions(message) {
    const actions=document.createElement('div');actions.className='chat-response-actions';
    const button=(name,label)=>{const value=document.createElement('button');value.type='button';value.className='chat-response-action';value.title=label;value.setAttribute('aria-label',label);value.innerHTML=icon(name);return value;};
    const regenerateButton=button('regenerate','重新生成'),copyButton=button('copy','复制回复'),graphButton=button('graph','回答加入图谱');
    message.actions=actions;message.regenerateButton=regenerateButton;message.copyButton=copyButton;message.graphButton=graphButton;
    regenerateButton.addEventListener('click',()=>regenerate(message));
    copyButton.addEventListener('click',async()=>{
      message.copying=true;sync();
      try{
        await navigator.clipboard.writeText(message.content);
        if(!message.element.isConnected||message.status!=='complete')return;
        copyButton.innerHTML=icon('check');copyButton.title='已复制';copyButton.setAttribute('aria-label','已复制');
        message.copyAnimation?.cancel();
        const animation=copyButton.animate([{opacity:.65},{opacity:1}],{duration:reducedMotion?600:1100});message.copyAnimation=animation;
        animation.finished.then(()=>{if(message.element.isConnected){copyButton.innerHTML=icon('copy');copyButton.title='复制回复';copyButton.setAttribute('aria-label','复制回复');}},()=>{});
      }catch(error){copyButton.title='复制失败，请重试';copyButton.setAttribute('aria-label','复制失败，请重试');}
      finally{message.copying=false;sync();}
    });
    graphButton.addEventListener('click',async()=>{
      if(!state.open||!state.messages.includes(message)||message.addingToGraph||message.addedToGraph)return;
      const current=graphChatContext(),context=message.turn.graphContext;
      if(!current||graphContextKey(context)!==state.graphKey)return;
      message.addingToGraph=true;sync();
      try{
        const content=message.content.trim(),heading=content.match(/^#{1,6}\s+(.+?)(?:\r?\n|$)/);
        const title=heading?heading[1].replace(/\s+#+\s*$/,'').trim():'对话摘录';
        const markdown=cardMarkdown(heading?content.slice(heading[0].length).trim():content);
        await (window.rabbitDesktop??window.RabbitGraphDemo).graphMutate(context.workspaceId,{type:'add-card',graphId:context.graphId,parentId:context.nodeId,title,markdown});
        message.addedToGraph=true;graphButton.innerHTML=icon('check');graphButton.title='已加入图谱';graphButton.setAttribute('aria-label','已加入图谱');
      }catch(error){graphButton.title=error.message||'未能加入图谱，请重试。';graphButton.setAttribute('aria-label','加入图谱失败，点击重试');}
      finally{message.addingToGraph=false;sync();}
    });
    actions.append(regenerateButton,copyButton,graphButton);message.element.appendChild(actions);sync();
  }
  function paintRun(run) {
    if(state.run!==run)return;
    run.renderFrame=0;run.lastPaint=performance.now();run.message.element.classList.remove('is-waiting');run.message.element.classList.add('is-streaming');
    renderAssistant(run.message.body,run.text);scrollToBottom();
  }
  function schedulePaint(run) {
    if(run.renderFrame)return;
    const paint=now=>{if(state.run!==run)return;if(now-run.lastPaint<42){run.renderFrame=requestAnimationFrame(paint);return;}paintRun(run);};
    run.renderFrame=requestAnimationFrame(paint);
  }
  function updateProgress(run) {
    if(state.run!==run)return;
    const seconds=Math.floor((performance.now()-run.startedAt)/1000);
    run.progress.textContent=['思考 '+seconds+' 秒',...Object.entries(run.toolCounts).map(([name,count])=>count+' 次'+name)].join(' · ');
  }
  function stopProgress(run) { clearTimeout(run.progressTimer);run.progress.remove(); }
  function abortGeneration() {
    const run=state.run;if(!run)return;
    state.run=null;state.busy=false;run.controller.abort();cancelAnimationFrame(run.renderFrame);stopProgress(run);
    run.message.element.classList.remove('is-waiting','is-streaming');
    if(run.text){run.message.content=run.text;run.message.status='cancelled';renderAssistant(run.message.body,run.text);}
    else {removeMessage(run.message);state.messages=state.messages.filter(message=>message!==run.message);}
    activity('idle',false);sync();
  }
  function finishDemo() {
    if(!state.demo)return;
    state.demo.controller.abort();state.demo=null;emit('demo',{playing:false});
  }
  function cancelDemo() { if(!state.demo)return;if(state.run&&state.run.demo)abortGeneration();finishDemo(); }
  function contextFrom(value) {
    if(value?.error){note.textContent=value.error;if(!value.images.length)return null;}
    return value||null;
  }
  async function captureContext(version) {
    if(!service()||!service().captureContext)return null;
    try {
      const value=await service().captureContext();
      if(version!==state.activation||(!state.open&&!state.opening)||state.contextConsumed)return null;
      state.context=contextFrom(value);drawContexts();return state.context;
    } catch(error) {
      if(version===state.activation&&(state.open||state.opening))note.textContent='未取得窗口截图，仍可直接提问。';
      return null;
    }
  }
  async function activate(context,options={}) {
    abortGeneration();
    const graph=options.graph===true,graphContext=graph?currentGraphContext():null;
    if(graph&&!graphContext){invalidateGraphChat();return;}
    const version=++state.activation;
    const origin=activationPointer(options.anchor);
    const graphKey=graphContextKey(graphContext);
    const resume=options.resume&&state.graph&&graph&&graphKey===state.graphKey;
    state.graph=graph;state.graphKey=graphKey;root.classList.toggle('is-graph-chat',graph);
    state.activationId=options.activationId;state.opening=true;state.selecting=false;composing=false;state.anchor=petAnchor(origin);
    state.dragging=false;root.classList.remove('is-pet-dragging');setHistoryOpen(false);
    cancelAnimationFrame(focusFrame);focusFrame=0;
    root.classList.remove('is-open','capture-suspended');shell.inert=true;panel.inert=true;panel.setAttribute('aria-hidden','true');input.blur();
    emit('focus',{bounds:null,active:false});
    if(!resume){clearMessages();input.value='';state.attachments=[];state.context=null;state.contextConsumed=false;state.capture=null;state.conversationId=crypto.randomUUID();note.textContent='';}
    drawContexts();setPresentation(resume?state.presentation:'compact');
    if(context!==undefined||graph){
      state.contextConsumed=false;state.context=contextFrom(context);drawContexts();state.capture=null;
    }
    else state.capture=captureContext(version);
    sync();
    // 飞行、开框和光效同时开始，输入不等待角色到位。
    window.RabbitBallDemo.approach({...state.petPosition});
    if(version!==state.activation||!state.opening)return;
    shell.inert=false;panel.inert=false;panel.setAttribute('aria-hidden','false');
    state.opening=false;state.open=true;root.classList.add('is-open');panel.setAttribute('aria-hidden','false');
    emit('open',{activationId:state.activationId,bounds:{...state.bounds},presentation:state.presentation,petPosition:{...state.petPosition},origin,focusBounds:context?.focusBounds||state.context?.focusBounds,graph});measure();focusComposer();
    try { await service().focusInput(state.activationId); } catch { /* 原生自动聚焦失败不撤销输入界面。 */ }
    if(version!==state.activation||!state.open)return;
    focusComposer();
    focusFrame=requestAnimationFrame(()=>{focusFrame=0;if(state.open&&state.activation===version)focusComposer();});
    if(state.capture)await state.capture;
  }
  function close(automatic=false) {
    if(!state.open&&!state.opening)return;
    const opening=state.opening,activationId=state.activationId;composing=false;
    abortGeneration();if(!automatic)finishDemo();state.activation++;state.capture=null;state.open=false;state.opening=false;state.selecting=false;cancelAnimationFrame(focusFrame);focusFrame=0;
    state.dragging=false;root.classList.remove('is-pet-dragging');setHistoryOpen(false);
    window.RabbitBallDemo.cancelApproach();
    root.classList.remove('is-open','capture-suspended');shell.inert=true;panel.inert=true;panel.setAttribute('aria-hidden','true');
    emit('focus',{bounds:null,active:false});emit('close',{bounds:{...state.bounds},automatic,opening,activationId,graph:state.graph});input.blur();
  }
  function fold() { if(state.historyOpen)setHistoryOpen(false);else setPresentation('compact'); }
  function wait(ms,signal) {
    return new Promise(resolve=>{
      if(signal.aborted){resolve(false);return;}
      const stop=()=>{clearTimeout(timer);resolve(false);};
      const timer=setTimeout(()=>{signal.removeEventListener('abort',stop);resolve(true);},ms);
      signal.addEventListener('abort',stop,{once:true});
    });
  }
  async function localDemo(request) {
    request.onPhase(request.intent==='chat'?'think':'scan');
    if(!await wait(500,request.signal))throw new DOMException('Aborted','AbortError');
    request.onPhase('think');
    const text=request.intent==='extract'?'**演示回复**\n\n这里会提取所附窗口中的文字，并保留原有段落。':request.intent==='translate'?'**演示回复**\n\n这里会将所附窗口中的文字翻译成中文。':request.intent==='search'?'**演示回复**\n\n这里会结合所附窗口，搜索并解释你关注的内容。':'**演示回复**\n\n已收到你的问题。可以继续追问，或使用下方快捷操作处理当前窗口。';
    for(const char of text){if(!await wait(reducedMotion?1:22,request.signal))throw new DOMException('Aborted','AbortError');request.onDelta(char);}
    return {text};
  }
  async function generate(message,{attachments=[],demo=false,regenerate=false}={}) {
    const turn=message.turn;
    if(state.graph&&(!graphChatContext()||graphContextKey(turn.graphContext)!==state.graphKey))return false;
    message.copyAnimation?.cancel();message.actions?.remove();message.actions=null;message.content='';message.status='pending';message.addedToGraph=false;
    message.element.classList.remove('is-error','is-streaming');message.element.classList.add('is-waiting');message.body.replaceChildren();
    const progress=document.createElement('div');progress.className='chat-progress';message.element.prepend(progress);
    const run={controller:new AbortController(),message,text:'',lastPaint:0,renderFrame:0,demo,progress,startedAt:performance.now(),toolCounts:{},progressTimer:0};
    state.run=run;state.busy=true;activity(turn.intent==='chat'?'think':'scan',true);sync();
    const tick=()=>{if(state.run!==run)return;updateProgress(run);run.progressTimer=setTimeout(tick,1000);};tick();
    try {
      const activation=state.activation;
      if(!regenerate&&state.capture)await state.capture;
      if(state.run!==run||run.controller.signal.aborted)return false;
      if(activation!==state.activation){abortGeneration();return false;}
      const context=regenerate?null:state.context;
      if(!regenerate){state.context=null;state.contextConsumed=true;state.capture=null;drawContexts();}
      const request={conversationId:state.conversationId,turnId:turn.id,text:turn.text,intent:turn.intent,context,attachments,regenerate,graphContext:turn.graphContext,signal:run.controller.signal,
        onDelta:chunk=>{if(state.run!==run||run.controller.signal.aborted)return;run.text+=chunk;schedulePaint(run);},
        onProgress:({toolCounts})=>{if(state.run===run){run.toolCounts=toolCounts;updateProgress(run);}},
        onPhase:phase=>{if(state.run===run&&['scan','think','idle'].includes(phase))activity(phase,true);}};
      const result=await (service()&&service().send?service().send(request):localDemo(request));
      if(state.run!==run||run.controller.signal.aborted)return false;
      if(result&&typeof result.text==='string')run.text=result.text;
      cancelAnimationFrame(run.renderFrame);message.element.classList.remove('is-waiting','is-streaming');renderAssistant(message.body,run.text);
      message.content=run.text;message.status='complete';answerActions(message);
      announcement.textContent=run.text;scrollToBottom();return true;
    } catch(error) {
      if(state.run!==run||run.controller.signal.aborted)return false;
      cancelAnimationFrame(run.renderFrame);message.element.classList.remove('is-waiting','is-streaming');message.element.classList.add('is-error');message.status='error';
      message.body.textContent=error.message||'暂时没有收到回复，请重试。';return false;
    } finally {
      stopProgress(run);
      if(state.run===run){state.run=null;state.busy=false;activity('idle',false);sync();}
    }
  }
  async function send(intent='chat',demo=false) {
    const graphContext=state.graph?graphChatContext():null;
    if(state.graph&&!graphContext)return false;
    const typed=input.value.trim(),action=['search','extract','translate'].includes(intent);
    const text=typed||(!action&&state.attachments.length?window.RabbitPrompts.attachment():'');
    if(!text&&!action)return false;
    if(!demo)cancelDemo();abortGeneration();setPresentation('expanded');
    const turn={id:crypto.randomUUID(),text,intent,graphContext:graphContext?{...graphContext}:undefined};
    const attachments=state.attachments.map(value=>({...value}));input.value='';state.attachments=[];drawContexts();note.textContent='';
    addMessage('user',text,turn,!typed&&intent!=='chat');
    const message=addMessage('assistant','',turn);
    return generate(message,{attachments,demo});
  }
  function regenerate(message) {
    if(state.busy||message.addingToGraph||message.status!=='complete')return;
    const index=state.messages.indexOf(message);if(index<0)return;
    cancelDemo();abortGeneration();setPresentation('expanded');
    state.messages.splice(index+1).forEach(removeMessage);
    return generate(message,{regenerate:true});
  }
  async function playDemo() {
    cancelDemo();abortGeneration();const demo={controller:new AbortController()};state.demo=demo;emit('demo',{playing:true});
    await activate();if(state.demo!==demo)return;
    input.value='解释一下当前窗口的内容。';sync();
    if(!await wait(400,demo.controller.signal))return;
    const completed=await send('search',true);
    if(!completed||state.demo!==demo){if(state.demo===demo)finishDemo();return;}
    if(!await wait(1300,demo.controller.signal))return;
    close(true);finishDemo();
  }
  async function addAttachment(file) {
    if(!file)return;
    const activation=state.activation;
    note.textContent='';
    try {
      const attachment={id:'attachment-'+Date.now(),name:file.name,mimeType:file.type||'text/plain'};
      if(file.type.startsWith('image/'))attachment.dataUrl=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('未能读取图片，请重新选择。'));reader.readAsDataURL(file);});
      else attachment.text=await file.text();
      if(activation!==state.activation||!state.open)return;
      state.attachments=[attachment];drawContexts();sync();input.focus({preventScroll:true});
    } catch(error){if(activation===state.activation)note.textContent=error.message;}
  }
  document.addEventListener('clipboard:image',event=>{
    if(!state.open||state.selecting)return;
    state.attachments=[{id:'attachment-'+crypto.randomUUID(),name:'剪贴板图片.png',mimeType:'image/png',dataUrl:event.detail.imageDataUrl}];
    note.textContent='';drawContexts();sync();input.focus({preventScroll:true});
  });
  form.addEventListener('submit',event=>{event.preventDefault();if(state.busy){abortGeneration();finishDemo();}else send();});
  input.addEventListener('input',()=>{sync();focusBounds();});
  input.addEventListener('focus',focusBounds);
  input.addEventListener('keydown',event=>{
    if(composingKey(event))return;
    if(event.key==='Backspace'&&!input.value&&!event.ctrlKey&&!event.altKey&&!event.metaKey){
      const index=state.attachments.findLastIndex(attachment=>attachment.mimeType.startsWith('image/'));
      if(index>=0)state.attachments.splice(index,1);
      else if(state.context?.images.length)state.context={...state.context,images:state.context.images.slice(0,-1)};
      else return;
      event.preventDefault();drawContexts();sync();return;
    }
    if(event.key==='Enter'){event.preventDefault();if(state.busy&&!input.value.trim()){abortGeneration();finishDemo();}else send();}
  });
  collapseButton.addEventListener('click',fold);
  $('.chat-add').addEventListener('click',()=>{state.pickingFile=true;fileInput.click();});
  fileInput.addEventListener('change',()=>{state.pickingFile=false;addAttachment(fileInput.files[0]);fileInput.value='';});
  fileInput.addEventListener('cancel',()=>{state.pickingFile=false;if(state.open)input.focus({preventScroll:true});});
   shortcuts.querySelectorAll('.chat-shortcut').forEach(button=>{if(button.dataset.intent)button.addEventListener('click',()=>send(button.dataset.intent));});
   graphButton.addEventListener('click',async()=>{
     if(state.switchingGraphMode)return;
     state.switchingGraphMode=true;sync();
     try{applyGraphSettings(await window.RabbitSettings.setGraphMode(!state.graphMode));note.textContent='';}
     catch(error){note.textContent=error.message||'未能切换大爆炸模式，请重试。';}
     finally{state.switchingGraphMode=false;sync();}
   });
  historyButton.addEventListener('click',()=>{setHistoryOpen(!state.historyOpen);if(state.historyOpen)void loadHistory();});
  for(const name of ['settings:change','settings:saved'])document.addEventListener(name,event=>{applyHistorySettings(event.detail.settings);applyGraphSettings(event.detail.settings);});
  applyHistorySettings(window.RabbitSettings?.getSnapshot().settings??{historyLimit:10});
  applyGraphSettings(window.RabbitSettings?.getSnapshot().settings??{graphPluginEnabled:true,graphModeEnabled:false});
  document.addEventListener('graph:open',sync);
  document.addEventListener('graph:contextchange',event=>{if(state.graph&&graphContextKey(event.detail)!==state.graphKey)invalidateGraphChat();sync();});
  document.addEventListener('graph:close',()=>{if(state.graph)close();sync();});
  for(const name of ['pointerdown','pointerup','pointermove','click','dblclick'])root.addEventListener(name,event=>{if(name==='pointerdown')cancelDemo();event.stopPropagation();});
  root.addEventListener('compositionstart',()=>{composing=true;});
  root.addEventListener('compositionend',()=>{composing=false;});
  root.addEventListener('keydown',event=>{cancelDemo();if(event.key==='Escape'&&!composingKey(event)){event.preventDefault();close();}event.stopPropagation();});
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!composingKey(event)&&(state.open||state.opening)&&!state.selecting){event.preventDefault();close();}});
  // 捕获整个页面的鼠标位置，包含页头；半屏方向仅在激活时锁定。
  const rememberPointer=event=>{latestClientX=event.clientX;latestClientY=event.clientY;};
  document.addEventListener('pointermove',rememberPointer,{capture:true,passive:true});
  document.addEventListener('pointerdown',rememberPointer,{capture:true,passive:true});
  document.addEventListener('pointerdown',event=>{if((state.open||state.opening)&&!state.selecting&&!state.pickingFile&&!document.getElementById('pet').contains(event.target)&&!document.getElementById('rabbit-edit-menu')?.contains(event.target)&&(state.opening||!shell.contains(event.target)))close();},true);
  // 原生透明区域会穿透点击，使用主进程转发的场景坐标判断外部点击。
  document.addEventListener('desktop:pointerdown',event=>{
    if((!state.open&&!state.opening)||state.selecting||state.pickingFile||window.RabbitEditMenu?.containsPoint(event.detail))return;
    const {x,y}=event.detail,b=state.bounds;
    const pet=document.getElementById('pet').getBoundingClientRect(),sceneBounds=scene.getBoundingClientRect();
    if(state.dragging||(x>=pet.left-sceneBounds.left&&x<=pet.right-sceneBounds.left&&y>=pet.top-sceneBounds.top&&y<=pet.bottom-sceneBounds.top))return;
    if(state.opening||x<b.x||x>b.x+b.width||y<b.y||y>b.y+b.height)close();
  });
  document.addEventListener('selection:open',()=>{
    if(state.opening){state.activation++;state.opening=false;state.capture=null;window.RabbitBallDemo.cancelApproach();}
    state.selecting=true;cancelDemo();cancelAnimationFrame(focusFrame);root.classList.add('capture-suspended');
    shell.inert=true;panel.setAttribute('aria-hidden','true');input.blur();emit('focus',{bounds:null,active:false});
  });
  document.addEventListener('selection:close',event=>{
    if(!event.detail.cancelled)return;
    state.selecting=false;root.classList.remove('capture-suspended');shell.inert=!state.open;
    root.classList.toggle('is-open',state.open);panel.inert=!state.open;
    panel.setAttribute('aria-hidden',String(!state.open));focusComposer();
  });
  if(!window.rabbitDesktop)window.addEventListener('blur',()=>{if((state.open||state.opening)&&!state.selecting&&!state.pickingFile)close();});
  document.addEventListener('desktop:suspended',event=>{if(event.detail)close();});
  const observer=new ResizeObserver(measure);observer.observe(scene);const dock=scene.querySelector('.mode-dock');if(dock)observer.observe(dock);
  window.addEventListener('focus',focusComposer);
  window.addEventListener('blur',()=>{composing=false;});
  window.addEventListener('pagehide',()=>{close();cancelAnimationFrame(layoutFrame);cancelAnimationFrame(focusFrame);});
  shell.addEventListener('transitionend',event=>{if(['height','width','left','top'].includes(event.propertyName))focusBounds();});
  measure();sync();setPresentation('compact');
  window.RabbitChat=Object.freeze({activate,activateGraph:options=>activate(null,{...options,graph:true,resume:true}),open:activate,close:()=>close(),toggle:()=>state.open||state.opening?close():activate(),playDemo,cancelDemo,beginPetDrag,movePetDrag,endPetDrag,
    getSnapshot:()=>({open:state.open,opening:state.opening,activation:state.activation,presentation:state.presentation,historyOpen:state.historyOpen,busy:state.busy,selecting:state.selecting,graph:state.graph,demo:!!state.demo,stage:state.opening?'opening':state.busy?'generating':'idle',messageCount:state.messages.length,context:state.context?{id:state.context.id,title:state.context.title,demo:!!state.context.demo,imageIds:state.context.images.map(image=>image.id)}:null,attachmentCount:state.attachments.length,bounds:{...state.bounds}})});
})();
