(() => {
  'use strict';
  const bridge = window.rabbitDesktop;
  let currentContext = null, selectionSessionId = null, previousCaptureContext = null;
  let demoSession = null, autoCopyScreenshots = true;
  const abortError = () => new DOMException('已取消', 'AbortError');
  const delay = (ms, signal) => new Promise((resolve, reject) => {
    if (signal.aborted) { reject(abortError()); return; }
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, ms);
    function stop() { clearTimeout(timer); reject(abortError()); }
    signal.addEventListener('abort', stop, { once: true });
  });
  function demoContext() {
    const palette = window.RabbitPalette?.derive('#F58DAA', '#F90040');
    const ink = palette?.text || '#513943', accent = palette?.accent || '#C65481';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360"><rect width="640" height="360" rx="18" fill="white"/><text x="38" y="54" font-family="Segoe UI,sans-serif" font-size="18" fill="${ink}">Newton’s second law</text><path d="M38 75H600" stroke="#eee"/><text x="40" y="151" font-family="Georgia,serif" font-size="48" fill="${ink}">F = ma</text><text x="40" y="208" font-family="Segoe UI,sans-serif" font-size="20" fill="${ink}">Force equals mass times acceleration.</text><circle cx="119" cy="136" r="33" fill="none" stroke="${accent}" stroke-width="3"/><path d="M119 96v12m0 56v12m-40-40h12m56 0h12" stroke="${accent}" stroke-width="2"/></svg>`;
    return { id: crypto.randomUUID(), title: '示例窗口', demo: true, capturedAt: Date.now(), images: [{ id: crypto.randomUUID(), title: '示例窗口', imageDataUrl: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg), cursor: { x: 119, y: 136, width: 640, height: 360, inside: true } }] };
  }
  async function captureContext() {
    if (!bridge) currentContext = demoContext();
    return currentContext;
  }
  async function focusInput(activationId) {
    return bridge?bridge.focusInput(activationId):true;
  }
  function demoBitmap(dataUrl) {
    return new Promise((resolve,reject)=>{
      const bitmap=new Image();bitmap.onload=()=>resolve(bitmap);bitmap.onerror=()=>reject(new Error('未能载入示例画面。'));bitmap.src=dataUrl;
    });
  }
  async function copyDemoCanvas(canvas,session) {
    if(!autoCopyScreenshots)return false;
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
    if(demoSession!==session)throw abortError();
    try { await navigator.clipboard.write([new ClipboardItem({'image/png':blob})]);return true; }
    catch { return false; }
  }
  function demoCaptureStart() {
    demoCaptureCancel();
    const scene = document.getElementById('scene'), sceneRect=scene.getBoundingClientRect(), width=window.innerWidth, height=window.innerHeight;
    const context = demoContext(), scale=Math.min(740/640,width*.8/640,height*.72/360), windowWidth=640*scale, windowHeight=360*scale;
    const focusBounds = { x:(width-windowWidth)/2, y:(height-windowHeight)/2, width:windowWidth, height:windowHeight };
    context.focusBounds = {...focusBounds,x:focusBounds.x-sceneRect.left,y:focusBounds.y-sceneRect.top};
    const source = decodeURIComponent(context.images[0].imageDataUrl.split(',')[1]);
    const markup = source.replace(/^<svg[^>]*>/,'').replace(/<\/svg>$/,'');
    const background = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="#F7F6F8"/><svg x="${focusBounds.x}" y="${focusBounds.y}" width="${windowWidth}" height="${windowHeight}" viewBox="0 0 640 360">${markup}</svg></svg>`;
    const backgroundImageDataUrl = 'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(background);
    demoSession = { sessionId:crypto.randomUUID(), context, backgroundImageDataUrl, width, height, ready:null, count:0, previousContext:currentContext };
    currentContext = context;
    return { sessionId:demoSession.sessionId, context, backgroundImageDataUrl, width, height };
  }
  async function demoCaptureRegion(rect) {
    const session = demoSession;
    if (!session) throw abortError();
    const bitmap = await (session.ready ||= demoBitmap(session.backgroundImageDataUrl));
    if (demoSession!==session) throw abortError();
    const x = Math.max(0,Math.min(session.width,rect.x)), y = Math.max(0,Math.min(session.height,rect.y));
    const width = Math.min(rect.width,session.width-x), height = Math.min(rect.height,session.height-y);
    if (width<1 || height<1) throw new Error('选区太小，请重新框选。');
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1,Math.round(width));canvas.height = Math.max(1,Math.round(height));
    canvas.getContext('2d').drawImage(bitmap,x,y,width,height,0,0,canvas.width,canvas.height);
    const image = { id:crypto.randomUUID(), title:'示例选区 '+(session.count+1), imageDataUrl:canvas.toDataURL('image/png') };
    session.context = { ...session.context, images:[...(session.count?session.context.images:[]),image] };
    session.count++;currentContext = session.context;
    const copied=await copyDemoCanvas(canvas,session);
    if (demoSession!==session) throw abortError();
    return { context:session.context, image, rect:{x,y,width,height}, copied };
  }
  async function demoCaptureEnd() {
    if (!demoSession) return currentContext;
    const session=demoSession;
    if(!session.count&&autoCopyScreenshots){
      const bitmap=await demoBitmap(session.context.images[0].imageDataUrl);
      if(demoSession!==session)throw abortError();
      const canvas=document.createElement('canvas');canvas.width=bitmap.naturalWidth;canvas.height=bitmap.naturalHeight;
      canvas.getContext('2d').drawImage(bitmap,0,0);await copyDemoCanvas(canvas,session);
    }
    if(demoSession!==session)throw abortError();
    currentContext=session.context;demoSession=null;return currentContext;
  }
  function demoCaptureCancel() {
    if (!demoSession) return;
    currentContext = demoSession.previousContext;demoSession=null;
  }
  async function nativeSend(request) {
    if (request.signal.aborted) throw abortError();
    const id = crypto.randomUUID();
    const context = request.context;
    return new Promise((resolve, reject) => {
      let text = '', settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true; unsubscribe(); request.signal.removeEventListener('abort', cancel);
        request.onPhase('idle');
        if (error) reject(error);
        else resolve({ text });
      };
      const unsubscribe = bridge.onAgentEvent(event => {
        if (event.id !== id || settled) return;
        if (event.type === 'start' || event.type === 'tool') request.onPhase('think');
        else if (event.type === 'delta' && event.text) { text += event.text; request.onDelta(event.text); }
        else if (event.type === 'done') {
          if (!text && event.text) { text = event.text; request.onDelta(event.text); }
          finish();
        } else if (event.type === 'error') finish(new Error(event.message || '请求失败，请重试。'));
        else if (event.type === 'cancelled') finish(abortError());
      });
      function cancel() { bridge.cancelMessage(id); finish(abortError()); }
      request.signal.addEventListener('abort', cancel, { once: true });
      request.onPhase(context?.images.length ? 'scan' : 'think');
      bridge.sendMessage({ id, text: request.text, action: { chat: 'ask', search: 'search', extract: 'extract', translate: 'translate' }[request.intent] || 'ask',
        conversationId: request.conversationId, turnId: request.turnId, regenerate: !!request.regenerate,
        contextId: context?.id, imageIds:context?.images.map(image=>image.id), attachments: request.attachments || [] }).catch(finish);
    });
  }
  async function demoSend(request) {
    request.onPhase(request.context?.images.length ? 'scan' : 'think');
    await delay(360, request.signal); request.onPhase('think'); await delay(300, request.signal);
    let text;
    if (request.intent === 'extract') text = '演示回复\n\nNewton’s second law\nF = ma\nForce equals mass times acceleration.';
    else if (request.intent === 'translate') text = '演示回复\n\n牛顿第二定律：力等于质量乘以加速度。';
    else if (request.intent === 'search') text = '演示回复\n\n牛顿第二定律：$F=ma$。同样的质量下，力越大，加速度越大。';
    else if (request.context?.demo || /公式|数学|牛顿|加速度/.test(request.text)) text = '演示回复\n\n牛顿第二定律：$F=ma$，即力等于质量乘以加速度。\n\n$$a=\\frac{F}{m}$$';
    else text = '演示回复\n\n可以直接提问，也可以附上窗口后选择搜索、提取文字或翻译。';
    for (const character of text) { await delay(18, request.signal); request.onDelta(character); }
    request.onPhase('idle'); return { text };
  }
  const applySettings = event => { if (typeof event.detail.settings.autoCopyScreenshots==='boolean') autoCopyScreenshots=event.detail.settings.autoCopyScreenshots; };
  document.addEventListener('settings:change',applySettings);
  document.addEventListener('settings:saved',applySettings);
  window.RabbitAssistant = Object.freeze({ mode: bridge ? 'desktop' : 'demo', captureContext, focusInput, demoCaptureStart, demoCaptureRegion, demoCaptureEnd, demoCaptureCancel, send: request => bridge ? nativeSend(request) : demoSend(request) });
  if (bridge) {
    let activeActivation = null, changingView = false, settingsEpoch;
    const hideIfClosed = activationId => {
      if (activationId !== undefined && !changingView && !selectionSessionId && !window.RabbitChat?.getSnapshot().opening && !document.querySelector('#rabbit-capture-root.is-active,#rabbit-chat-root.is-open,#rabbit-settings-root.is-open')) bridge.hidePanel(activationId);
    };
    bridge.onCaptureEvent(event => {
      if (event.type==='start') { previousCaptureContext=currentContext;selectionSessionId=event.sessionId;currentContext=event.context; }
      if (event.sessionId!==selectionSessionId) return;
      if (event.type==='image') currentContext=event.context;
      if (event.type==='cancel') { currentContext=previousCaptureContext;previousCaptureContext=null; }
      window.RabbitCapture?.handleEvent(event);
      if (event.type==='cancel') { selectionSessionId=null;hideIfClosed(activeActivation?.activationId); }
    });
    bridge.onActivate(async activation => {
      activeActivation=activation;
      try {
        if (activation.view === 'settings') {
          settingsEpoch=activation.activationId;
          changingView=true;try { window.RabbitChat?.close(); } finally { changingView=false; }
          await window.RabbitSettings?.open();
        }
        else {
          currentContext=activation.context||null;previousCaptureContext=null;window.RabbitCapture?.finishNative();selectionSessionId=null;
          changingView=true;try { window.RabbitSettings?.close(); } finally { changingView=false; }
          await window.RabbitChat?.activate(currentContext,{anchor:activation.anchor,activationId:activation.activationId});
        }
      } finally {
        // 旧激活的异步收尾不能替当前视图发出关闭请求。
        if(activeActivation===activation)hideIfClosed(activation.activationId);
      }
    });
    bridge.onCursor(point => document.dispatchEvent(new CustomEvent('desktop:cursor', { detail: point })));
    bridge.onPointerDown(point => document.dispatchEvent(new CustomEvent('desktop:pointerdown', { detail: point })));
    bridge.onSuspended(suspended => document.dispatchEvent(new CustomEvent('desktop:suspended', { detail: suspended })));
    bridge.onSettingsChanged(settings => window.RabbitSettings?.applySettings(settings));
    document.addEventListener('chat:close',event=>hideIfClosed(event.detail.activationId));
    document.addEventListener('settings:close',()=>hideIfClosed(settingsEpoch));
  }
})();
