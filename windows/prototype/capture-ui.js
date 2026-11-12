(() => {
  'use strict';
  if(window.RabbitCapture)return;
  const shortcut=window.RabbitShortcut;
  let activationShortcut=shortcut.normalizeShortcut(window.RabbitSettings?.getSnapshot().settings.activationShortcut??shortcut.DEFAULT_ACTIVATION_SHORTCUT);
  const shortcutLabel=()=>shortcut.formatShortcut(activationShortcut);
  const style=document.createElement('style');
  style.textContent=`
    #rabbit-capture-root { position:fixed;inset:0;z-index:10000;display:none;overflow:hidden;cursor:crosshair;touch-action:none;user-select:none;--capture-accent:var(--rb-accent,var(--rabbit-accent,#de88ad));--capture-ink:var(--rb-text,var(--rabbit-ink,#765366));--capture-veil:color-mix(in srgb,var(--capture-ink) 12%,transparent); }
    #rabbit-capture-root.is-active { display:block; }
    #rabbit-capture-root .capture-background { position:absolute;inset:0;width:100%;height:100%;object-fit:fill;pointer-events:none; }
    #rabbit-capture-root .capture-shade { position:absolute;inset:0;z-index:1;background:var(--capture-veil);pointer-events:none; }
    #rabbit-capture-root.is-selecting .capture-shade { display:none; }
    #rabbit-capture-root .capture-status { position:absolute;z-index:3;left:50%;top:18px;transform:translateX(-50%);display:flex;align-items:center;gap:10px;max-width:calc(100% - 24px);padding:9px 15px 9px 9px;border:1px solid #fff;border-radius:21px;background:#fff;color:var(--capture-ink);font:14px/1.5 var(--rabbit-font);box-shadow:0 0 0 1px var(--rb-line,#f0e4ea),0 6px 24px #3025300b;pointer-events:none; }
    #rabbit-capture-root .capture-status > svg { flex:none;box-sizing:content-box;width:18px;height:18px;padding:8px;border-radius:12px;background:var(--rb-soft,#fbf0f5);fill:none;stroke:var(--capture-accent);stroke-width:2.25;stroke-linecap:round;stroke-linejoin:round; }
    #rabbit-capture-root .capture-status-title { white-space:nowrap;font-weight:500; }
    #rabbit-capture-root .capture-status-detail { margin-top:2px;color:var(--rb-text-muted,var(--rabbit-muted,#b59cab));font-size:12px; }
    #rabbit-capture-root .capture-status-count { color:var(--capture-accent);font-variant-numeric:tabular-nums; }
    #rabbit-capture-root .capture-status-count:not(:empty)::after { content:' · '; }
    #rabbit-capture-root .capture-box,#rabbit-capture-root .capture-confirm { position:absolute;z-index:2;box-sizing:border-box;border:1.5px solid var(--capture-accent);border-radius:10px;background:transparent;pointer-events:none; }
    #rabbit-capture-root .capture-box { display:none;box-shadow:0 0 0 2px #fffffff5,0 0 0 100vmax var(--capture-veil); }
    #rabbit-capture-root .capture-box::after { content:'';position:absolute;inset:0;border:1px solid #ffffffa8;border-radius:inherit; }
    #rabbit-capture-root .capture-confirm { box-shadow:0 0 0 2px #fffffff5;background:color-mix(in srgb,var(--capture-accent) 4%,transparent); }
    @media(prefers-reduced-motion:no-preference) { #rabbit-capture-root.is-active .capture-status { animation:rb-capture-arrive .2s cubic-bezier(.22,1,.36,1) both; } }
    @keyframes rb-capture-arrive { from { opacity:0;transform:translate(-50%,-5px); } to { opacity:1;transform:translate(-50%,0); } }
    #rabbit-capture-root .capture-announcement { position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap; }
  `;
  document.head.appendChild(style);
  const root=document.createElement('div');root.id='rabbit-capture-root';root.setAttribute('role','region');root.setAttribute('aria-label','连续选区截图');
  root.innerHTML='<img class="capture-background" alt=""><canvas class="capture-background" hidden></canvas><div class="capture-shade"></div><div class="capture-status"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H5a2 2 0 0 0-2 2v3m13-5h3a2 2 0 0 1 2 2v3M3 16v3a2 2 0 0 0 2 2h3m8 0h3a2 2 0 0 0 2-2v-3M7 12h10"/></svg><div><div class="capture-status-title"></div><div class="capture-status-detail"><span class="capture-status-count"></span><span>Esc 取消</span></div></div></div><div class="capture-box"></div><div class="capture-announcement" aria-live="polite"></div>';
  document.body.appendChild(root);
  const background=root.querySelector('.capture-background'),box=root.querySelector('.capture-box'),announcement=root.querySelector('.capture-announcement');
  const bitmap=root.querySelector('canvas');
  const statusTitle=root.querySelector('.capture-status-title'),statusCount=root.querySelector('.capture-status-count');
  let session=null,lastPoint=null,paintFrame=0;
  const emit=(name,detail)=>document.dispatchEvent(new CustomEvent('selection:'+name,{detail}));
  const facade=()=>window.RabbitAssistant;
  const graphMode=()=>{const settings=window.RabbitSettings?.getSnapshot().settings;return !window.rabbitDesktop&&settings?.graphPluginEnabled!==false&&settings?.graphModeEnabled===true;};
  const clamp=(value,max)=>Math.max(0,Math.min(max,value));
  function point(x,y){return{x:clamp(x,innerWidth),y:clamp(y,innerHeight)};}
  function rectangle(drag){return{x:Math.min(drag.start.x,drag.end.x),y:Math.min(drag.start.y,drag.end.y),width:Math.abs(drag.end.x-drag.start.x),height:Math.abs(drag.end.y-drag.start.y)};}
  const valid=rect=>rect.width>=4&&rect.height>=4;
  function completionLabel(){return session?.purpose==='images'?'松开鼠标完成':session?.graph?'松开进入图谱':'松开提问';}
  function updateStatus(){
    statusTitle.textContent=(session?.context?.demo?'演示 · ':'')+(session?.purpose==='images'?'拖动选择截图':'按住 '+shortcutLabel()+' 连续截图')+' · '+completionLabel();
    statusCount.textContent=session?.count?'已选 '+session.count+' 张':'';
  }
  function renderBox(){
    paintFrame=0;
    const rect=session?.frame??(session?.drag?rectangle(session.drag):null);
    const visible=!!rect&&(session?.native?rect.width>0&&rect.height>0:valid(rect))&&rect.x<innerWidth&&rect.y<innerHeight&&rect.x+rect.width>0&&rect.y+rect.height>0;
    root.classList.toggle('is-selecting',visible);
    if(!visible){box.style.display='none';return;}
    placeFrame(box,rect);box.style.display='block';

  }
  function placeFrame(element,rect){Object.assign(element.style,{left:rect.x+'px',top:rect.y+'px',width:rect.width+'px',height:rect.height+'px',borderRadius:Math.min(10,rect.width*.2,rect.height*.2)+'px'});}
  function schedulePaint(){if(!paintFrame)paintFrame=requestAnimationFrame(renderBox);}
  function confirm(rect){
    const flash=document.createElement('div');flash.className='capture-confirm';
    placeFrame(flash,rect);root.appendChild(flash);
    const animation=flash.animate([{opacity:.9},{opacity:0}],{duration:matchMedia('(prefers-reduced-motion: reduce)').matches?100:200,easing:'ease-out'});
    animation.finished.then(()=>flash.remove(),()=>flash.remove());
  }
  function releasePointer(current){
    const pointerId=current.pointerId;current.pointerId=null;
    if(pointerId!==null&&root.hasPointerCapture(pointerId))root.releasePointerCapture(pointerId);
  }
  function discardDrag(current){
    current.drag=null;releasePointer(current);renderBox();
  }
  function hide(cancelled){
    const previous=session;if(!previous)return;
    session=null;cancelAnimationFrame(paintFrame);paintFrame=0;
    releasePointer(previous);
    for(const pointerId of previous.touches)if(root.hasPointerCapture(pointerId))root.releasePointerCapture(pointerId);
    previous.touches.clear();
    root.classList.remove('is-active','is-selecting');background.removeAttribute('src');bitmap.width=bitmap.height=0;box.style.display='none';
    root.querySelectorAll('.capture-confirm').forEach(element=>{element.getAnimations().forEach(animation=>animation.cancel());element.remove();});
    if(previous.visible)emit('close',{sessionId:previous.id,cancelled});
    if(cancelled)previous.resolveCapture?.(null);
  }
  function show(data,native,visible=true){
    if(session)hide(true);
    if(data.shortcut)activationShortcut=shortcut.normalizeShortcut(data.shortcut);
    if(data.color)root.style.setProperty('--capture-accent',data.color);
    if(typeof data.useBuiltinFont==='boolean')document.documentElement.dataset.builtinFont=String(data.useBuiltinFont);
    const current={id:data.sessionId,native,visible,purpose:data.purpose,graph:data.purpose==='graph'||!native&&graphMode(),backgroundImageDataUrl:data.backgroundImageDataUrl,context:data.context,drag:null,frame:null,pointerId:null,touches:new Set(),pending:Promise.resolve(),finishing:false,failed:false,count:data.purpose==='images'?0:data.context?.images?.length??0};
    session=current;background.hidden=!!data.backgroundBitmap;bitmap.hidden=!data.backgroundBitmap;root.dataset.demo=String(!!data.context?.demo);
    if(data.backgroundBitmap){
      const {data:pixels,width,height}=data.backgroundBitmap;
      // 原生快照为 BGRA，收到的独立缓冲区原地转换后直接绘制，避免图片编解码。
      for(let index=0;index<pixels.length;index+=4){const blue=pixels[index];pixels[index]=pixels[index+2];pixels[index+2]=blue;}
      bitmap.width=width;bitmap.height=height;
      bitmap.getContext('2d',{alpha:false}).putImageData(new ImageData(new Uint8ClampedArray(pixels.buffer,pixels.byteOffset,pixels.byteLength),width,height),0,0);
    }else background.src=data.backgroundImageDataUrl;
    if(visible){
      root.classList.add('is-active');updateStatus();announcement.textContent=current.purpose==='images'?'拖动选择截图，松开鼠标完成，Esc 取消。':'截图模式已开启，按住 '+shortcutLabel()+' 拖动选择，'+completionLabel()+'。';
      emit('open',{sessionId:current.id,context:data.context,demo:!native});
    }
    if(data.dragStart){const start=point(data.dragStart.x,data.dragStart.y);current.drag={start,end:lastPoint||start};schedulePaint();}
    return current;
  }
  function queueRegion(current,rect){
    if(!valid(rect))return;
    current.pending=current.pending.then(async()=>{
      if(session!==current)return;
      const result=await facade().demoCaptureRegion(rect);
      if(session!==current)return;
      current.context=result.context;current.count=result.context.images.length;updateStatus();confirm(result.rect);announcement.textContent='已添加选区 '+current.count;
    }).catch(error=>{
      if(session!==current||error.name==='AbortError')return;
      current.failed=true;emit('error',{message:error.message});
    });
  }
  function commitDrag(current){
    if(!current.drag)return;
    const rect=rectangle(current.drag);current.drag=null;releasePointer(current);renderBox();
    if(!current.native)queueRegion(current,rect);
  }
  function startDemo(visible=true){
    if(session)return;
    try{show(facade().demoCaptureStart(),false,visible);}
    catch(error){emit('error',{message:error.message});}
  }
  function captureImages(){
    if(window.rabbitDesktop)return Promise.reject(new Error('请使用桌面截图服务。'));
    cancel();
    return new Promise((resolve,reject)=>{
      try{const current=show({...facade().demoCaptureStart(),purpose:'images'},false);current.resolveCapture=resolve;}
      catch(error){reject(error);}
    });
  }
  async function finishDemo(){
    const current=session;if(!current||current.native||current.finishing)return;
    current.finishing=true;commitDrag(current);
    await current.pending;
    if(session!==current)return;
    if(current.failed){cancel();return;}
    try{
      if(current.purpose==='images'){
        if(!current.count){cancel();return;}
        const context=await facade().demoCaptureEnd();if(session!==current)return;
        hide(false);current.resolveCapture(context.images);return;
      }
      let workspace,target;
      if(current.graph){
        if(!window.RabbitGraphDemo||!window.RabbitGraph)throw new Error('图谱演示尚未准备好，请刷新后重试。');
        workspace=await window.RabbitGraphDemo.graphOpen(window.RabbitGraph.getSnapshot().workspaceId||undefined);
        if(session!==current)return;
        target=workspace.graphs.find(g=>g.id===workspace.lastGraphId)||workspace.graphs[0];
        if(!target||current.visible&&target.nodes.length){
          workspace=await window.RabbitGraphDemo.graphMutate(workspace.id,{type:'create-graph'});
          if(session!==current)return;
          target=workspace.graphs.find(g=>g.id===workspace.lastGraphId);
        }
        if(target.nodes.length){
          facade().demoCaptureCancel();hide(false);
          window.RabbitChat?.close?.();window.RabbitSettings?.close?.();
          await window.RabbitGraph.open({activationId:Date.now(),view:'graph',workspaceId:workspace.id,backgroundImageDataUrl:current.backgroundImageDataUrl});return;
        }
      }
      const context=await facade().demoCaptureEnd();if(session!==current)return;
      hide(false);
      if(current.graph){
        window.RabbitChat?.close?.();window.RabbitSettings?.close?.();
        await window.RabbitGraphDemo.graphCaptureContext({workspaceId:workspace.id,graphId:target.id},context,current.backgroundImageDataUrl);
      }
      else await window.RabbitChat.activate(context);
    }catch(error){if(error.name!=='AbortError')emit('error',{message:error.message});if(session===current)cancel();}
  }
  function cancel(notify=true){
    const current=session;if(!current)return;
    hide(true);
    if(current.native){if(notify)window.rabbitDesktop.cancelCapture();}
    else facade().demoCaptureCancel();
  }
  function finishNative(){if(session?.native)hide(false);}
  function handleEvent(event){
    if(event.type==='start'){show(event,true);return;}
    const current=session;if(!current||!current.native||current.id!==event.sessionId)return;
    if(event.type==='frame'){
      // 主进程给出未裁切的本屏局部矩形；跨屏边界由视口自然裁切。
      current.drag=null;current.frame=event.rect??null;schedulePaint();
    }else if(event.type==='pointer'){
      lastPoint=point(event.x,event.y);
      if(event.phase==='down')current.drag={start:lastPoint,end:lastPoint};
      else {if(current.drag)current.drag.end=lastPoint;commitDrag(current);}
      schedulePaint();
    }else if(event.type==='image'){
      current.context=event.context;current.count=event.context.images.length;updateStatus();confirm(event.rect);announcement.textContent='已添加选区 '+current.count;
    }else if(event.type==='end')finishNative();
    else if(event.type==='cancel')cancel(false);
  }
  root.addEventListener('pointerdown',event=>{
    if(!session||session.native||session.finishing||event.button!==0)return;
    const current=session;event.preventDefault();
    if(event.pointerType==='touch'){
      current.touches.add(event.pointerId);
      // 双指操作放弃当前触屏选框，余下触点抬起前不能启动另一张截图。
      if(current.touches.size>1){if(current.drag?.pointerType==='touch')discardDrag(current);return;}
    }
    if(current.pointerId!==null||event.isPrimary===false||current.touches.size&&event.pointerType!=='touch')return;
    lastPoint=point(event.clientX,event.clientY);current.drag={start:lastPoint,end:lastPoint,pointerType:event.pointerType};current.pointerId=event.pointerId;root.setPointerCapture(event.pointerId);schedulePaint();
  });
  root.addEventListener('pointermove',event=>{
    if(!session||session.native||event.pointerId!==session.pointerId||!session.drag||session.finishing)return;
    lastPoint=point(event.clientX,event.clientY);session.drag.end=lastPoint;schedulePaint();
  });
  root.addEventListener('pointerup',event=>{
    if(!session||session.native||session.finishing)return;
    session.touches.delete(event.pointerId);
    if(event.pointerId!==session.pointerId)return;
    if(session.drag)session.drag.end=point(event.clientX,event.clientY);
    const current=session;commitDrag(current);
    if(current.purpose==='images')finishDemo();
  });
  const cancelPointer=event=>{
    if(!session||session.native)return;
    if(event.type==='pointercancel')session.touches.delete(event.pointerId);
    if(event.pointerId===session.pointerId)discardDrag(session);
  };
  root.addEventListener('pointercancel',cancelPointer);
  root.addEventListener('lostpointercapture',cancelPointer);
  root.addEventListener('contextmenu',event=>event.preventDefault());
  document.addEventListener('desktop:cursor',event=>{
    lastPoint=point(event.detail.x,event.detail.y);
    if(session?.native&&session.drag){session.drag.end=lastPoint;schedulePaint();}
  });
  document.addEventListener('keydown',event=>{
    if((!session?.native&&session?.purpose!=='images')||event.key!=='Escape')return;
    event.preventDefault();event.stopImmediatePropagation();cancel();
  },true);
  if(!window.rabbitDesktop){
    let held=false,blocked=false,recording=false,holdTimer=0,previousGraphMode=graphMode();
    const pressed=new Set();
    const clearHold=()=>{clearTimeout(holdTimer);holdTimer=0;};
    const cancelPress=()=>{blocked=true;held=false;clearHold();cancel();};
    const resetPress=()=>{pressed.clear();held=false;blocked=false;clearHold();cancel();};
    document.addEventListener('settings:recording',event=>{recording=event.detail.recording;resetPress();});
    document.addEventListener('settings:open',resetPress);
    document.addEventListener('settings:saved',()=>{
      const enabled=graphMode(),activate=enabled&&!previousGraphMode;previousGraphMode=enabled;resetPress();
      if(activate){startDemo(false);finishDemo();}
    });
    document.addEventListener('keydown',event=>{
      if(session?.purpose==='images')return;
      if(recording||window.RabbitSettings?.getSnapshot().open)return;
      if(event.key==='Escape'&&(held||session)){cancelPress();event.preventDefault();event.stopImmediatePropagation();return;}
      if(!activationShortcut.includes(event.code))return;
      event.preventDefault();event.stopImmediatePropagation();
      pressed.add(event.code);
      if(event.repeat||held||blocked||!shortcut.matchesShortcut(activationShortcut,pressed))return;
      if(window.RabbitGraph?.isOpen()){blocked=true;window.RabbitGraph.close();return;}
      const chat=window.RabbitChat?.getSnapshot();
      if(chat?.open||chat?.opening){blocked=true;window.RabbitChat.close();return;}
      held=true;
      holdTimer=setTimeout(()=>{holdTimer=0;if(held&&!blocked)startDemo();},500);
    },true);
    document.addEventListener('keyup',event=>{
      if(session?.purpose==='images')return;
      if(recording||window.RabbitSettings?.getSnapshot().open||!activationShortcut.includes(event.code))return;
      event.preventDefault();event.stopImmediatePropagation();
      pressed.delete(event.code);
      if(held){
        held=false;blocked=true;clearHold();if(!session)startDemo(false);finishDemo();
      }
      if(!pressed.size)blocked=false;
    },true);
    window.addEventListener('blur',resetPress);
    window.addEventListener('pagehide',resetPress);
  }
  function refreshShortcut(){
    activationShortcut=shortcut.normalizeShortcut(window.RabbitSettings?.getSnapshot().settings.activationShortcut??shortcut.DEFAULT_ACTIVATION_SHORTCUT);
    const button=document.getElementById('autoplay'),label=button?.querySelector('span');
    if(label)label.textContent=shortcutLabel()+' 提问';
    if(button)button.setAttribute('aria-label','启动提问（'+shortcutLabel()+'）');
    if(session)updateStatus();
  }
  refreshShortcut();
  window.RabbitSettings?.ready.then(refreshShortcut);
  document.addEventListener('settings:change',refreshShortcut);
  document.addEventListener('settings:saved',refreshShortcut);
  window.addEventListener('pagehide',()=>cancel());
  window.RabbitCapture=Object.freeze({handleEvent,finishNative,cancel,captureImages,
    getSnapshot:()=>({active:!!session,native:!!session?.native,finishing:!!session?.finishing,count:session?.count||0,sessionId:session?.id||null})});
})();
