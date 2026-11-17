(() => {
  'use strict';
  if (window.RabbitGraph) return;
  const bridge = window.rabbitDesktop ?? window.RabbitGraphDemo;
  const scene = document.getElementById('scene');
  const graphSurface=bridge?.surface==='graph';
  const NS = 'http://www.w3.org/2000/svg';
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const uid = () => crypto.randomUUID();
  const icons = {
    folder:'M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z',
    down:'m8 10 4 4 4-4', more:'M5 12h.01M12 12h.01M19 12h.01', close:'m6 6 12 12M6 18 18 6',
    arrow:'M7 17 17 7M7 7h10v10', pin:'m16 3 5 5-4 2-3 5-2-2-5 5M12 13l-3-3 5-3 2-4Z',
    refresh:'M20 8a8 8 0 1 0 0 8M20 3v5h-5', check:'m5 12 4 4L19 6', stop:'M6 6h12v12H6Z',
    edit:'m15 4 5 5M4 20l5-1L21 7a2 2 0 0 0-5-5L4 14v6Z',
    document:'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8L14 2ZM14 2v6h6',
    plus:'M12 5v14M5 12h14', undo:'M4 10h9a6 6 0 0 1 0 12M4 10l5-5M4 10l5 5',
    settings:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2',
    camera:'M4 6h4l2-3h4l2 3h4a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2ZM12 9a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z'
  };
  icons.chat='M4 4h16v12H9l-5 4V4Z';
  icons.usage='M5 20V12M12 20V4M19 20V8';
  icons.trash='M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7';
  function el(tag, className, text) { const item = document.createElement(tag); if (className) item.className = className; if (text !== undefined) item.textContent = text; return item; }
  function icon(name) { const svg = document.createElementNS(NS, 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');if(name==='more'){for(const x of [5,12,19]){const circle=document.createElementNS(NS,'circle');circle.setAttribute('cx',String(x));circle.setAttribute('cy','12');circle.setAttribute('r','1');circle.setAttribute('fill','currentColor');svg.append(circle);}}else{const path = document.createElementNS(NS, 'path'); path.setAttribute('d', icons[name]); svg.append(path);}return svg; }
  function button(name, label, action, className = 'rg-action') {
    const item=el('button',className);item.type='button';item.title=label;item.setAttribute('aria-label',label);item.append(icon(name));
    if(action){
      let press=null;
      // 卡片滑入时固定按下的控件，避免松开落到卡片背景；主动拖开仍取消点击。
      item.addEventListener('pointerdown',event=>{if(event.button!==0||item.disabled)return;press={id:event.pointerId,x:event.clientX,y:event.clientY,cancelled:false};item.setPointerCapture(event.pointerId);});
      item.addEventListener('pointermove',event=>{if(press?.id===event.pointerId&&Math.hypot(event.clientX-press.x,event.clientY-press.y)>8)press.cancelled=true;});
      item.addEventListener('pointercancel',()=>{press=null;});
      item.addEventListener('click',event=>{event.stopPropagation();const cancelled=event.detail!==0&&press?.cancelled;press=null;if(!cancelled)action(event);});
    }
    return item;
  }
  function emit(name, detail) { document.dispatchEvent(new CustomEvent(name, { detail })); }
  function rich(target, markdown) { window.RabbitRender.render(target, markdown); }
  function busy(node) { return node.status === 'queued' || node.status === 'generating'; }
  function showingDraft(node) { return busy(node)&&node.kind==='card'&&(!node.markdown||node.generation?.contentRevision===node.contentRevision); }
  function cardTitle(node,preview=false) {
    if(preview&&node.candidate)return node.candidate.title;
    if(showingDraft(node)){const heading=node.draft?.match(/^###\s+([^\n]+)\n/);return heading?heading[1].trim():'生成中';}
    return node.title;
  }
  function generationText(node,now=Date.now()) {
    const generation=node.generation,parts=[];
    if(node.status==='queued')return '等待生成…';
    if(!busy(node)){
      if(node.status==='error'||node.status==='cancelled')return node.error||(node.status==='cancelled'?'已停止生成':'生成失败');
      return node.candidate?'新版本已生成':'';
    }
    if(Number.isFinite(generation?.startedAt))parts.push(`生成 ${Math.max(0,Math.floor((now-generation.startedAt)/1000))} 秒`);
    for(const [name,count] of Object.entries(generation?.toolCounts||{}))if(Number.isSafeInteger(count)&&count>0)parts.push(`${count} 次${name}`);
    return parts.length?parts.join(' · '):'正在生成…';
  }
  function cardHeight(node,width) {
    if(node.kind!=='source')return width*4/3;
    if(!node.images.length){const count=node.attachments?.length||0;if(!count)return width*4/3;const columns=Math.max(1,Math.floor((width-19)/121));return clamp(64+Math.ceil(count/columns)*120+(node.markdown?76:0),width*.65,width*1.8);}
    const pictureWidth=Math.max(1,width-28),pictures=node.images.reduce((sum,image)=>sum+pictureWidth*(image.pixelSize?image.pixelSize.height/image.pixelSize.width:.75),0);
    return clamp((node.parentId===null?25:41)+pictures+Math.max(0,node.images.length-1)*12+(node.attachments?.length?130:0)+(node.markdown?60:0),width*.65,width*1.8);
  }
  function intersects(a,b) { return a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top; }
  function normalizedRect(start, end, bounds) {
    const x1 = clamp((start.x - bounds.left) / bounds.width, 0, 1), y1 = clamp((start.y - bounds.top) / bounds.height, 0, 1);
    const x2 = clamp((end.x - bounds.left) / bounds.width, 0, 1), y2 = clamp((end.y - bounds.top) / bounds.height, 0, 1);
    return { x:Math.min(x1,x2), y:Math.min(y1,y2), width:Math.abs(x2-x1), height:Math.abs(y2-y1) };
  }
  function zoomAt(view, point, nextZoom) { const zoom = clamp(nextZoom, .4, 1.8), ratio = zoom / view.zoom; return { x:point.x-(point.x-view.x)*ratio, y:point.y-(point.y-view.y)*ratio, zoom }; }
  function touchView(view,start,points) {
    const center=list=>list.length>1?{x:(list[0].x+list[1].x)/2,y:(list[0].y+list[1].y)/2}:list[0],from=center(start),to=center(points);
    const distance=list=>Math.hypot(list[1].x-list[0].x,list[1].y-list[0].y),ratio=start.length>1&&points.length>1?distance(points)/Math.max(1,distance(start)):1;
    const next=zoomAt(view,from,view.zoom*ratio);return{...next,x:next.x+to.x-from.x,y:next.y+to.y-from.y};
  }
  function viewProgress(progress) {
    if(progress<=0||progress>=1)return clamp(progress,0,1);
    // 与兔球 cubic-bezier(.22,1,.36,1) 同曲线，直接推进实际视角而非仅变换画面。
    let low=0,high=1;for(let step=0;step<18;step++){const t=(low+high)/2,inverse=1-t,x=3*inverse*inverse*t*.22+3*inverse*t*t*.36+t*t*t;if(x<progress)low=t;else high=t;}
    return 1-(1-(low+high)/2)**3;
  }
  function rootView(rootNode,width,viewport) { return {x:viewport.width/2-(rootNode.x+width/2),y:viewport.height/2-(rootNode.y+rootNode.height/2),zoom:1}; }
  // 两端节点都能移到画布中心；有限留白避免把整张图拖进无限空白区。
  function constrainView(view,nodes,width,viewport) {
    const zoom=clamp(view.zoom,.4,1.8);if(!nodes.length)return{x:0,y:0,zoom};
    const left=Math.min(...nodes.map(node=>node.x)),right=Math.max(...nodes.map(node=>node.x+width)),top=Math.min(...nodes.map(node=>node.y)),bottom=Math.max(...nodes.map(node=>node.y+node.height));
    const centers=nodes.map(node=>node.y+node.height/2),minCenterY=Math.min(...centers),maxCenterY=Math.max(...centers),slackX=viewport.width*.2,slackY=viewport.height*.2;
    const minX=Math.min(viewport.width/2-(right-width/2)*zoom-slackX,viewport.width-32-right*zoom),maxX=Math.max(viewport.width/2-(left+width/2)*zoom+slackX,32-left*zoom);
    const minY=Math.min(viewport.height/2-maxCenterY*zoom-slackY,viewport.height-32-bottom*zoom),maxY=Math.max(viewport.height/2-minCenterY*zoom+slackY,32-top*zoom);
    return{x:clamp(view.x,minX,maxX),y:clamp(view.y,minY,maxY),zoom};
  }
  // WheelEvent 不提供设备类型，同一段连续手势沿用首次明确的输入特征。
  function wheelGesture(previous,event,time) {
    if(event.ctrlKey)return{mode:'zoom',pinch:true,time};
    if(previous&&!previous.pinch&&time-previous.time<180)return{...previous,time};
    const pixel=event.deltaMode===0||event.deltaMode===undefined,magnitude=Math.max(Math.abs(event.deltaX||0),Math.abs(event.deltaY||0));
    const trackpad=pixel&&(Math.abs(event.deltaX||0)>0||magnitude<40||!Number.isInteger(magnitude));
    return{mode:trackpad||event.shiftKey?'pan':'zoom',pinch:false,time};
  }
  function titlePreview(value,width,lines=1) {
    const budget=Math.max(10,Math.floor((width-50)/16)*lines-2),tokens=value.match(/\$\$[\s\S]*?\$\$|\$[^$\n]+\$|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]|[\s\S]/gu)||[];let used=0,result='';
    for(const token of tokens){const math=token.length>1,cost=math?Math.min(budget,Math.max(3,token.length*.45)):1;if(used+cost>budget&&result)return result.trimEnd()+'…';result+=token;used+=cost;}
    return result;
  }
  function edgePath(from,to,width,height) {
    const fromHeight=from.height??height,toHeight=to.height??height,inset=22;
    const overlapTop=Math.max(from.y+inset,to.y+inset),overlapBottom=Math.min(from.y+fromHeight-inset,to.y+toHeight-inset),aligned=overlapTop<=overlapBottom;
    const start={x:from.x+width,y:aligned?(overlapTop+overlapBottom)/2:clamp(to.y+toHeight/2,from.y+inset,from.y+fromHeight-inset)},end={x:to.x,y:aligned?start.y:clamp(from.y+fromHeight/2,to.y+inset,to.y+toHeight-inset)};
    const distance=end.x-start.x,reach=Math.min(Math.max(8,distance*.4),distance*.48);
    return `M${start.x},${start.y} C${start.x+reach},${start.y} ${end.x-reach},${end.y} ${end.x},${end.y}`;
  }
  // 层级固定为列，深度优先的叶分支固定为行；同一行使用最高卡片的实际高度。
  function layoutTree(nodes,width) {
    if(!nodes.length)return[];
    const children=new Map(nodes.map(node=>[node.id,[]]));
    for(const node of nodes)if(node.parentId!==null)children.get(node.parentId).push(node);
    const rootNode=nodes.find(node=>node.parentId===null),spots=new Map(),rowHeights=[],stack=[{node:rootNode,depth:0}];let row=0;
    while(stack.length){const {node,depth}=stack.pop();spots.set(node.id,{depth,row});rowHeights[row]=Math.max(rowHeights[row]||0,node.height);const branch=children.get(node.id);if(branch.length){for(let index=branch.length-1;index>=0;index--)stack.push({node:branch[index],depth:depth+1});}else row++;}
    const rowTops=[];let top=rootNode.y;for(const height of rowHeights){rowTops.push(top);top+=height+Math.max(28,width*.10);}
    return nodes.map(node=>{const spot=spots.get(node.id);return{id:node.id,x:rootNode.x+spot.depth*width*1.12,y:rowTops[spot.row]};});
  }

  const style = el('style');
  style.textContent = `
    #rabbit-graph-root{position:absolute;inset:0;z-index:5;overflow:hidden;display:none;color:var(--rb-text);font-family:var(--rabbit-font);font-size:15px;user-select:none;--rg-stroke:2px;--rg-card-radius:22px;--rg-width:20vw;--rg-height:26.6667vw;--rg-ease:cubic-bezier(.22,1,.36,1);--rabbit-ink:var(--rb-text);--rabbit-muted:var(--rb-text-muted);--rabbit-accent:var(--rb-accent)}
    #rabbit-graph-root.is-open,#rabbit-graph-root.has-pins,#rabbit-graph-root.has-toast{display:block}#rabbit-graph-root:not(.is-open){pointer-events:none}#rabbit-graph-root:not(.is-open)>:not(.rg-pin-window):not(.rg-toast){display:none}#rabbit-graph-root.capture-suspended{visibility:hidden;pointer-events:none}#rabbit-graph-root *{box-sizing:border-box}#rabbit-graph-root [hidden]{display:none!important}#rabbit-graph-root button,#rabbit-graph-root input,#rabbit-graph-root textarea{font:inherit}#rabbit-graph-root button{cursor:pointer;touch-action:manipulation}#rabbit-graph-root button:disabled{opacity:.4;cursor:default}#rabbit-graph-root button:focus-visible,#rabbit-graph-root input:focus-visible,#rabbit-graph-root textarea:focus-visible{outline:2px solid var(--rb-accent);outline-offset:3px}#rabbit-graph-root button>svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:var(--rg-stroke);stroke-linecap:round;stroke-linejoin:round;flex:none}
    #rabbit-graph-root button>svg,#rabbit-graph-root button>svg>*{stroke-width:1.5px;vector-effect:non-scaling-stroke}
    #rabbit-graph-root .rg-background{position:absolute;inset:-22px;width:calc(100% + 44px);height:calc(100% + 44px);object-fit:cover;filter:blur(18px);pointer-events:none}
    #rabbit-graph-root .rg-viewport{position:absolute;inset:0;overflow:hidden;touch-action:auto;cursor:grab}#rabbit-graph-root .rg-viewport.is-panning{cursor:grabbing}#rabbit-graph-root .rg-world{position:absolute;left:0;top:0;transform-origin:0 0}#rabbit-graph-root .rg-edges{position:absolute;left:0;top:0;width:1px;height:1px;overflow:visible;pointer-events:none}#rabbit-graph-root .rg-edges path{fill:none;stroke:color-mix(in srgb,var(--rb-accent) 32%,var(--rb-line));stroke-width:var(--rg-stroke);vector-effect:non-scaling-stroke}
    #rabbit-graph-root .rg-card{position:absolute;width:var(--rg-width);height:var(--rg-height);display:flex;flex-direction:column;padding:calc(var(--rg-title-height,34px)/2 + 8px) 9px 14px;border:var(--rg-stroke) solid var(--rb-line);border-radius:var(--rg-card-radius);background:#fff;box-shadow:0 8px 30px #a4678210;cursor:default;transition:border-color .2s,box-shadow .3s,left .34s var(--rg-ease),top .34s var(--rg-ease);overflow:visible}#rabbit-graph-root .rg-card.is-root{padding-top:9px}#rabbit-graph-root .rg-pin>.rg-card.is-root{padding-bottom:14px}#rabbit-graph-root .rg-card.is-selected{border-color:color-mix(in srgb,var(--rb-accent) 48%,var(--rb-line))}#rabbit-graph-root .rg-card.is-target{outline:2px solid var(--rb-accent);outline-offset:5px}#rabbit-graph-root .rg-card-tools{position:absolute;right:-17px;top:23px;display:flex;flex-direction:column;gap:6px;z-index:3}#rabbit-graph-root .rg-state-actions{display:flex;flex-direction:column;gap:6px}#rabbit-graph-root .rg-state-actions:empty{display:none}#rabbit-graph-root .rg-action{border:0;padding:0;width:25px;height:25px;border-radius:7px;color:var(--rb-text-muted);background:#fff;display:grid;place-items:center;flex:none;transition:background .2s,color .2s}#rabbit-graph-root .rg-action:hover,#rabbit-graph-root .rg-action.is-active{background:var(--rb-soft);color:var(--rb-accent)}#rabbit-graph-root .rg-action.is-danger:hover{color:#a33753}#rabbit-graph-root .rg-title{position:absolute;left:50%;top:-1px;transform:translate(-50%,-50%);width:max-content;max-width:calc(100% - 20px);font-size:16px;font-weight:600;line-height:1.5;white-space:normal;overflow-wrap:anywhere;margin:0;padding:4px 9px;border:var(--rg-stroke) solid var(--rb-line);border-radius:17px;align-self:flex-start;text-align:left;background:var(--rb-soft);color:var(--rb-text);flex:none}#rabbit-graph-root .rg-card-scroll{position:relative;touch-action:auto;margin-inline:4px;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:var(--rb-line) transparent;flex:1;min-height:0}#rabbit-graph-root .rg-content{position:relative;font-size:15px;line-height:1.8;overflow-wrap:anywhere;user-select:text;cursor:text}#rabbit-graph-root .rg-content .rabbit-rich-text{font-size:15px;line-height:1.8}#rabbit-graph-root .rg-content .rabbit-rich-text h1,#rabbit-graph-root .rg-content .rabbit-rich-text h2,#rabbit-graph-root .rg-content .rabbit-rich-text h3{font-size:16px;font-weight:500;line-height:1.55}#rabbit-graph-root .rg-content ::selection{background:color-mix(in srgb,var(--rb-accent) 24%,transparent)}
    #rabbit-graph-root .rg-card-tools{pointer-events:auto}#rabbit-graph-root .rg-title.rabbit-rich-text{font-size:16px;font-weight:600;line-height:1.5;max-width:calc(100% - 20px);overflow:visible}#rabbit-graph-root .rg-title.rabbit-rich-text>p{margin:0;white-space:nowrap}#rabbit-graph-root .rg-title .rabbit-math{vertical-align:middle;padding-block:2px}#rabbit-graph-root .rg-card.is-focus-origin{visibility:hidden;pointer-events:none}#rabbit-graph-root .rg-world .rg-note-number,#rabbit-graph-root .rg-pin .rg-note-number{display:none}#rabbit-graph-root .rg-card-tools{transform:scale(var(--rg-control-scale,1));transform-origin:top right;right:calc(-17px * var(--rg-control-scale,1));top:calc(13px * var(--rg-control-scale,1))}#rabbit-graph-root .rg-note-number{transform:scale(var(--rg-control-scale,1));transform-origin:top left}
    #rabbit-graph-root .rg-image{position:relative;margin:0 0 12px;user-select:none;touch-action:auto;cursor:crosshair}#rabbit-graph-root .rg-card-focus .rg-image{touch-action:none}#rabbit-graph-root .rg-image img{display:block;width:100%;height:auto;border-radius:10px;-webkit-user-drag:none;user-select:none}#rabbit-graph-root .rg-image figcaption{font-size:11px;color:var(--rb-text-muted);margin-top:5px;cursor:default}#rabbit-graph-root .rg-marks{position:absolute;inset:0;pointer-events:none}#rabbit-graph-root .rg-mark{position:absolute;background:color-mix(in srgb,var(--rb-accent) 18%,transparent);border-radius:3px;pointer-events:none}#rabbit-graph-root .rg-mark.image{border:var(--rg-stroke) solid var(--rb-accent);background:color-mix(in srgb,var(--rb-accent) 12%,transparent)}#rabbit-graph-root .rg-note-number{position:absolute;width:18px;height:18px;display:grid;place-items:center;border:0;padding:0;border-radius:50%;background:var(--rb-accent);color:#fff;font-size:10px;line-height:1;pointer-events:auto;z-index:2}
    #rabbit-graph-root .rg-card-focus .rg-card-scroll{margin-bottom:40px}#rabbit-graph-root .rg-world .rg-card{cursor:grab}#rabbit-graph-root .rg-world .rg-content,#rabbit-graph-root .rg-world .rg-image{cursor:grab;user-select:none}
    #rabbit-graph-root .rg-image:last-child{margin-bottom:0}
    #rabbit-graph-root .rg-card-tools .rg-action,#rabbit-graph-root .rg-pin-toggle{width:34px;height:34px;border:var(--rg-stroke) solid var(--rb-line);border-radius:50%;box-shadow:0 3px 12px #a4678210}#rabbit-graph-root .rg-pin-toggle{position:absolute;z-index:4;left:calc(50% + var(--rg-title-width,0px)/2 + 6px * var(--rg-control-scale,1));right:auto;top:-1px;transform:scale(var(--rg-control-scale,1)) translateY(-50%);transform-origin:top left;opacity:0;pointer-events:auto;transition:opacity .18s,background .18s,color .18s}#rabbit-graph-root .rg-card:hover .rg-pin-toggle,#rabbit-graph-root .rg-card:has(:focus-visible) .rg-pin-toggle,#rabbit-graph-root .rg-pin-toggle.is-active,#rabbit-graph-root .rg-card-focus .rg-pin-toggle{opacity:1}#rabbit-graph-root .rg-card.is-root>.rg-pin-toggle{left:auto;right:calc(-17px * var(--rg-control-scale,1));top:calc(-17px * var(--rg-control-scale,1));transform:scale(var(--rg-control-scale,1));transform-origin:top right}#rabbit-graph-root .rg-pin .rg-card-tools{display:none}#rabbit-graph-root .rg-pin .rg-pin-toggle{top:auto;bottom:-1px;transform:translateY(50%);opacity:1;pointer-events:auto}#rabbit-graph-root .rg-pin .rg-card.is-root>.rg-pin-toggle{right:-17px;top:auto;bottom:-17px;transform:none}#rabbit-graph-root .rg-pin>.rg-card .rg-title{max-width:calc(100% - 84px)}#rabbit-graph-root .rg-pin .rg-title>p{overflow:hidden;text-overflow:ellipsis}
    #rabbit-graph-root .rg-card-tools{top:calc(23px * var(--rg-control-scale,1))}#rabbit-graph-root .rg-pin-window>.rg-pins{gap:24px;padding-inline:20px}
    #rabbit-graph-root .rg-status{display:grid;grid-template-rows:1fr;font-size:13px;line-height:1.6;color:var(--rb-text-muted);margin:0 0 6px;opacity:1;transition:grid-template-rows .22s cubic-bezier(.22,1,.36,1),margin .22s cubic-bezier(.22,1,.36,1),opacity .16s ease}#rabbit-graph-root .rg-status[hidden]{display:grid!important;grid-template-rows:0fr;margin-bottom:0;opacity:0}#rabbit-graph-root .rg-progress{min-height:0;overflow:hidden}#rabbit-graph-root .rg-card.is-busy .rg-progress:before{content:'';display:inline-block;width:5px;height:5px;border-radius:50%;background:var(--rb-accent);margin-right:6px;animation:rg-pulse 1.1s ease-in-out infinite}#rabbit-graph-root .rg-body.is-streaming::after{content:'';display:inline-block;width:3px;height:11px;margin-left:3px;border-radius:2px;background:var(--rb-accent);animation:rg-pulse .8s infinite}#rabbit-graph-root .rg-content.is-generating .rg-marks{visibility:hidden}
    #rabbit-graph-root .rg-sidebar{position:absolute;top:24px;left:24px;width:132px;bottom:24px;display:flex;flex-direction:column;z-index:11;pointer-events:none}#rabbit-graph-root .rg-folder{width:100%;min-height:38px;flex:none;border:var(--rg-stroke) solid var(--rb-line);border-radius:14px;background:#fff;color:var(--rb-text);box-shadow:0 8px 30px #a4678210;display:flex;align-items:center;gap:7px;text-align:left;padding:7px 10px;font-size:12px;font-weight:500;min-width:0;pointer-events:auto;transition:border-color .2s var(--rg-ease),background .2s var(--rg-ease)}#rabbit-graph-root .rg-folder:hover{background:var(--rb-soft);border-color:var(--rb-accent)}#rabbit-graph-root .rg-folder span{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#rabbit-graph-root .rg-folder svg:first-child{width:15px;height:15px;color:var(--rb-text-secondary)}#rabbit-graph-root .rg-folder svg:last-child{width:11px;height:11px}#rabbit-graph-root .rg-thumbs{display:flex;flex-direction:column;gap:10px;overflow:auto;scrollbar-width:none;pointer-events:auto;padding:4px 0}#rabbit-graph-root .rg-thumb{width:100%;flex:none;min-width:0;border:var(--rg-stroke) solid var(--rb-line);border-radius:14px;padding:7px;background:#fff;text-align:left;color:var(--rb-text);font-size:12px;line-height:1.5;box-shadow:0 8px 30px #a4678210;transition:border-color .2s var(--rg-ease),background .2s var(--rg-ease)}#rabbit-graph-root .rg-thumb:hover{border-color:color-mix(in srgb,var(--rb-accent) 55%,var(--rb-line))}#rabbit-graph-root .rg-thumb-preview{display:block;position:relative;height:70px;border-radius:7px;background:var(--rb-soft);overflow:hidden;margin-bottom:7px}#rabbit-graph-root .rg-thumb-caption{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 2px;font-weight:500}#rabbit-graph-root .rg-thumb.is-active{border-color:var(--rb-accent);color:var(--rb-text)}#rabbit-graph-root .rg-add-graph{width:100%;height:38px;flex:none;display:flex;align-items:center;justify-content:center;gap:6px;pointer-events:auto;border:var(--rg-stroke) solid var(--rb-line);border-radius:14px;background:#fff;color:var(--rb-text);font-size:12px;box-shadow:0 8px 30px #a4678210}#rabbit-graph-root .rg-add-graph:hover{border-color:var(--rb-accent);background:var(--rb-soft);color:var(--rb-accent)}
    #rabbit-graph-root .rg-graph-list{display:flex;flex-direction:column;justify-content:center;min-height:0;flex:1;pointer-events:none;padding:28px 0}#rabbit-graph-root .rg-graph-list .rg-thumbs{flex:0 1 auto;min-height:0;margin:0;max-height:calc(100% - 164px)}#rabbit-graph-root .rg-graph-list .rg-add-graph{margin-top:10px}#rabbit-graph-root .rg-thumb.is-target{outline:2px solid var(--rb-accent);outline-offset:-2px}#rabbit-graph-root .rg-thumb-preview>svg{width:100%;height:100%;display:block}#rabbit-graph-root .rg-thumb-preview>svg path{fill:none;stroke:color-mix(in srgb,var(--rb-accent) 28%,var(--rb-line));stroke-width:var(--rg-stroke);vector-effect:non-scaling-stroke}#rabbit-graph-root .rg-mini-card{fill:#fff;stroke:color-mix(in srgb,var(--rb-accent) 24%,var(--rb-line));stroke-width:var(--rg-stroke);vector-effect:non-scaling-stroke}#rabbit-graph-root .rg-mini-heading{fill:var(--rb-accent);opacity:.48;stroke:none}#rabbit-graph-root .rg-mini-line{fill:var(--rb-text-secondary);opacity:.22;stroke:none}
    #rabbit-graph-root .rg-plugin{position:absolute;right:24px;top:24px;z-index:11;display:flex;gap:7px}#rabbit-graph-root .rg-plugin>.rg-action,#rabbit-graph-root .rg-generate{width:40px;height:40px;border-radius:50%;background:#fff;box-shadow:0 3px 12px #a4678207}#rabbit-graph-root .rg-plugin>.rg-action svg,#rabbit-graph-root .rg-generate svg{width:18.75px;height:18.75px}#rabbit-graph-root .rg-generate{position:absolute;right:10px;bottom:10px;z-index:4;border:var(--rg-stroke) solid var(--rb-line);background:var(--rb-soft);color:var(--rb-accent)}#rabbit-graph-root .rg-generate:disabled{background:#f2f2f2;color:var(--rb-text-muted);opacity:1}#rabbit-graph-root .rg-pin-window{position:absolute;left:180px;right:116px;top:0;height:calc(var(--rg-pin-max-height,var(--rg-height)) + 25px);z-index:6;pointer-events:none;overflow:hidden}#rabbit-graph-root .rg-pins{display:flex;gap:14px;padding:0 16px;align-items:flex-start;width:max-content;transform:translateX(0)}#rabbit-graph-root .rg-pin{position:relative;width:var(--rg-width);height:40px;flex:none;pointer-events:auto}#rabbit-graph-root .rg-pin>.rg-card{left:0;top:calc(40px - var(--rg-pin-height));transition:top .4s var(--rg-ease);pointer-events:auto}#rabbit-graph-root .rg-pin.is-revealed{height:var(--rg-pin-height)}#rabbit-graph-root .rg-pin.is-revealed>.rg-card{top:0;box-shadow:0 12px 38px #a4678212}
    #rabbit-graph-root .rg-menu{position:absolute;z-index:18;min-width:180px;max-width:calc(100% - 20px);padding:7px;border:var(--rg-stroke) solid var(--rb-line);border-radius:12px;background:#fff;box-shadow:0 8px 30px #a4678210}#rabbit-graph-root .rg-menu button{width:100%;border:0;background:transparent;color:var(--rb-text-secondary);border-radius:7px;padding:9px 10px;text-align:left;display:flex;gap:9px;align-items:center;font-size:13px}#rabbit-graph-root .rg-menu button:hover{background:var(--rb-soft);color:var(--rb-accent)}#rabbit-graph-root .rg-menu hr{border:0;border-top:var(--rg-stroke) solid var(--rb-line);margin:5px}
    #rabbit-graph-root .rg-pin>.rg-card{padding-top:9px;padding-bottom:24px}#rabbit-graph-root .rg-pin>.rg-card.is-reading-press{transition:none}#rabbit-graph-root .rg-pin .rg-title{position:absolute;left:50%;top:auto;bottom:-1px;transform:translate(-50%,50%);margin:0;height:34px;max-width:calc(100% - 10px);max-height:34px;border-radius:17px;line-height:24px;white-space:nowrap}#rabbit-graph-root .rg-pin .rg-title>p{white-space:nowrap}#rabbit-graph-root .rg-world .rg-image{cursor:grab}#rabbit-graph-root .rg-folder{margin-top:10px;align-self:flex-start}#rabbit-graph-root .rg-drag-ghost,#rabbit-graph-root .rg-drag-ghost *{pointer-events:none!important}#rabbit-graph-root .rg-drag-ghost{z-index:25;opacity:.9;box-shadow:0 18px 60px var(--rb-shadow);transition:none}#rabbit-graph-root .rg-drag-ghost .rg-card-tools{display:none}#rabbit-graph-root .rg-card.is-drag-source{opacity:.2}
    #rabbit-graph-root .rg-focus{position:absolute;inset:0;z-index:10;pointer-events:none}#rabbit-graph-root .rg-focus.is-open{pointer-events:auto}#rabbit-graph-root .rg-focus>.rg-card{pointer-events:auto;box-shadow:0 12px 38px #a4678212;transition:border-color .2s,box-shadow .3s}#rabbit-graph-root .rg-focus .rg-title{max-width:calc(var(--rg-width) - 20px)}
    #rabbit-graph-root .rg-note-editor{position:absolute;z-index:22;display:flex;align-items:center;gap:7px;max-width:calc(100% - 20px);padding:6px 7px 6px 12px;border:var(--rg-stroke) solid var(--rb-line);border-radius:20px;background:#fff;box-shadow:0 8px 30px #a4678210}#rabbit-graph-root .rg-note-editor textarea{width:220px;max-width:calc(100vw - 100px);border:0;outline:none;background:transparent;color:var(--rb-text);font-size:13px;line-height:20px;padding:3px 0;resize:none;field-sizing:content;min-height:26px;max-height:120px;overflow:auto}#rabbit-graph-root .rg-note-editor .rg-confirm{width:30px;height:30px;border-radius:50%;background:var(--rb-soft);color:var(--rb-accent)}
    #rabbit-graph-root .rg-note-editor{flex-wrap:wrap;width:340px}#rabbit-graph-root .rg-note-editor textarea{flex:1;min-width:80px;width:auto}#rabbit-graph-root .rg-note-attachments{display:flex;gap:7px;flex-basis:100%;overflow:auto;max-height:75px}#rabbit-graph-root .rg-note-attachments:empty{display:none}#rabbit-graph-root .rg-note-attachment{position:relative;flex:none}#rabbit-graph-root .rg-note-attachment img{width:72px;height:48px;object-fit:cover;border-radius:7px;border:var(--rg-stroke) solid var(--rb-line)}#rabbit-graph-root .rg-note-attachment .rg-action{position:absolute;right:0;top:0;width:18px;height:18px;border-radius:50%}#rabbit-graph-root .rg-note-attachment .rg-action svg{width:11px;height:11px}#rabbit-graph-root .rg-empty-add{width:56px;height:56px;border:var(--rg-stroke) solid var(--rb-line);border-radius:50%;box-shadow:0 8px 30px #a4678210;background:#fff;color:var(--rb-accent);display:grid;place-items:center}#rabbit-graph-root .rg-empty-add svg{width:22px;height:22px}
    #rabbit-graph-root .rg-dialog-shade{position:absolute;inset:0;z-index:19;display:grid;place-items:center;pointer-events:auto;background:color-mix(in srgb,var(--rb-soft) 20%,transparent)}#rabbit-graph-root .rg-dialog{width:min(410px,calc(100% - 32px));border:var(--rg-stroke) solid var(--rb-line);border-radius:20px;background:#fff;box-shadow:0 18px 60px var(--rb-shadow);padding:22px;display:flex;flex-direction:column;gap:16px;max-height:calc(100% - 40px)}#rabbit-graph-root .rg-dialog h2{font-size:17px;font-weight:500;margin:0}#rabbit-graph-root .rg-dialog input,#rabbit-graph-root .rg-dialog textarea{width:100%;border:var(--rg-stroke) solid var(--rb-line);background:#fff;color:var(--rb-text);border-radius:9px;padding:10px 12px;resize:vertical}#rabbit-graph-root .rg-dialog-actions{display:flex;justify-content:flex-end;gap:8px}#rabbit-graph-root .rg-text-button{border:0;border-radius:9px;padding:8px 13px;background:var(--rb-soft);color:var(--rb-accent);font-size:13px}#rabbit-graph-root .rg-dialog-error{font-size:13px;color:#a33753;white-space:pre-wrap}
    #rabbit-graph-root .rg-toast{pointer-events:auto;position:absolute;left:50%;bottom:24px;transform:translateX(-50%);z-index:23;max-width:calc(100% - 30px);background:#fff;box-shadow:0 8px 30px #a4678210;border:var(--rg-stroke) solid var(--rb-line);border-radius:12px;padding:10px 14px;font-size:13px;color:var(--rb-text-secondary);display:flex;gap:12px;align-items:center}#rabbit-graph-root .rg-toast button{border:0;background:transparent;color:var(--rb-accent);white-space:nowrap}#rabbit-graph-root .rg-empty{position:absolute;inset:0;display:grid;place-content:center;justify-items:center;gap:16px;color:var(--rb-text-secondary);font-size:14px;pointer-events:none}#rabbit-graph-root .rg-empty button{pointer-events:auto}
    #rabbit-graph-root .rg-content-hint{margin:24px 0;color:var(--rb-text-muted);font-size:14px;text-align:center;user-select:none;cursor:default}
    #rabbit-graph-root .rg-background-button{pointer-events:auto;flex:none;margin-top:10px;width:100%;border:var(--rg-stroke) solid var(--rb-line);border-radius:14px;padding:8px 10px;text-align:left;background:#fff;box-shadow:0 8px 30px #a4678210;color:var(--rb-text);display:flex;align-items:center;gap:7px;font-size:12px;font-weight:500;transition:border-color .2s var(--rg-ease),background .2s var(--rg-ease)}#rabbit-graph-root .rg-background-button:hover{border-color:var(--rb-accent);background:var(--rb-soft);color:var(--rb-accent)}#rabbit-graph-root .rg-background-copy{display:flex;flex-direction:column;gap:3px;min-width:0}#rabbit-graph-root .rg-background-summary{font-size:11px;font-weight:400;color:var(--rb-text-muted);line-height:1.45;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#rabbit-graph-root .rg-background-button.is-dirty .rg-background-summary{color:var(--rb-accent)}
    #rabbit-graph-root:has(.rg-dialog-shade){z-index:27}
    #rabbit-graph-root .rg-graph-list>.rg-add-graph,#rabbit-graph-root .rg-graph-list>.rg-background-button,#rabbit-graph-root .rg-graph-list>.rg-folder{justify-content:flex-start;text-align:left;gap:7px;min-height:38px;padding:7px 10px}#rabbit-graph-root .rg-graph-list>.rg-add-graph>svg:first-child,#rabbit-graph-root .rg-graph-list>.rg-background-button>svg:first-child,#rabbit-graph-root .rg-graph-list>.rg-folder>svg:first-child{width:15px;height:15px;flex:none}
    #rabbit-graph-root .rg-background-files{scrollbar-width:thin;scrollbar-color:var(--rb-line) transparent}
    #rabbit-graph-root .rg-background-files:not(.is-empty)>.rg-background-attach{grid-column:1/-1;height:40px;flex-direction:row;gap:7px;padding:7px 12px}#rabbit-graph-root .rg-background-files:not(.is-empty)>.rg-background-attach>svg{width:16px;height:16px}
    #rabbit-graph-root .rg-background-dialog{width:min(560px,calc(100% - 32px));overflow:auto;gap:12px}#rabbit-graph-root .rg-background-description{margin:0;font-size:12px;line-height:1.6;color:var(--rb-text-muted)}#rabbit-graph-root .rg-background-dialog textarea{min-height:76px;max-height:140px;flex:none;line-height:1.65;font-size:13px}#rabbit-graph-root .rg-background-files{display:grid;grid-template-columns:repeat(auto-fill,minmax(136px,1fr));gap:12px;min-height:156px;max-height:42vh;overflow:auto;flex:none;align-content:start;padding:3px}#rabbit-graph-root .rg-background-files>.rabbit-attachment-tile{width:100%;height:140px}#rabbit-graph-root .rg-background-attach{height:140px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;border:var(--rg-stroke) dashed var(--rb-line);border-radius:15px;background:var(--rb-soft);color:var(--rb-text-secondary);font-size:12px;padding:14px}#rabbit-graph-root .rg-background-files.is-empty>.rg-background-attach{grid-column:1/-1;height:150px}#rabbit-graph-root .rg-background-attach:hover{border-color:var(--rb-accent);color:var(--rb-accent)}#rabbit-graph-root .rg-background-attach>svg{width:24px;height:24px}#rabbit-graph-root .rg-background-status{font-size:12px;line-height:1.6;color:var(--rb-text-muted);margin:0;white-space:pre-line}#rabbit-graph-root .rg-background-status:empty{display:none}#rabbit-graph-root .rg-background-status.is-error{color:#a33753}
    #rabbit-graph-root .rg-node-files,#rabbit-graph-root .rg-source-pending{display:grid;grid-template-columns:repeat(auto-fill,minmax(112px,1fr));gap:9px;margin-bottom:12px}#rabbit-graph-root .rg-node-files:empty,#rabbit-graph-root .rg-source-pending:empty{display:none}#rabbit-graph-root .rg-node-files>.rabbit-attachment-tile,#rabbit-graph-root .rg-source-pending>.rabbit-attachment-tile{width:100%;height:108px;user-select:none}#rabbit-graph-root .rg-card-focus .rg-node-files{grid-template-columns:repeat(auto-fill,minmax(132px,1fr))}#rabbit-graph-root .rg-card-focus .rg-node-files>.rabbit-attachment-tile{height:128px}#rabbit-graph-root .rg-source-actions{display:flex;flex-wrap:wrap;gap:7px;margin:8px 0 12px;user-select:none}#rabbit-graph-root .rg-source-actions>.rg-action{display:flex;align-items:center;justify-content:center;gap:5px;width:auto;height:32px;padding:0 9px;border:var(--rg-stroke) solid var(--rb-line);border-radius:10px;background:#fff;box-shadow:none;font-size:12px;color:var(--rb-text-secondary)}#rabbit-graph-root .rg-source-actions>.rg-action:first-child{background:var(--rb-soft);color:var(--rb-accent)}#rabbit-graph-root .rg-source-actions>.rg-action:hover{border-color:var(--rb-accent)}#rabbit-graph-root .rg-source-upload-status{font-size:12px;line-height:1.6;color:#a33753;white-space:pre-line;user-select:none}#rabbit-graph-root .rg-source-upload-status:empty{display:none}#rabbit-graph-root .rg-source-upload-actions{display:flex;gap:7px;margin:6px 0 10px}#rabbit-graph-root .rg-source-upload-actions:empty{display:none}#rabbit-graph-root .rg-card.is-source .rg-body{font-size:13px;color:var(--rb-text-secondary)}#rabbit-graph-root .rg-card.is-source .rg-body .rabbit-rich-text{font-size:13px}
    #rabbit-graph-root .rg-image.rabbit-attachment-tile{width:100%;height:auto;display:flex;flex-direction:column;border-radius:15px;margin:0 0 12px}#rabbit-graph-root .rg-image .rabbit-attachment-preview{flex:none;display:block;margin:5px 5px 0}#rabbit-graph-root .rg-image .rabbit-attachment-preview>img{width:100%;height:auto;border-radius:10px;object-fit:contain}#rabbit-graph-root .rg-image .rabbit-attachment-meta{min-height:29px}#rabbit-graph-root .rg-world .rg-image .rabbit-attachment-meta,#rabbit-graph-root .rg-pin .rg-image .rabbit-attachment-meta{display:none}#rabbit-graph-root .rg-world .rg-image .rabbit-attachment-preview,#rabbit-graph-root .rg-pin .rg-image .rabbit-attachment-preview{margin:4px}
    #rabbit-graph-root .rg-source-actions.is-empty>.rg-action:first-child{flex:1 0 100%;height:140px;flex-direction:column;gap:12px;border-style:dashed;border-radius:15px;font-size:13px}#rabbit-graph-root .rg-source-actions.is-empty>.rg-action:first-child>svg{width:24px;height:24px}#rabbit-graph-root .rg-card-focus .rg-source-actions.is-empty>.rg-action:first-child{height:180px}#rabbit-graph-root .rg-card-focus .rg-content-hint{margin:10px 0;font-size:12px}
    #rabbit-graph-root .rg-source-input{display:block;width:100%;min-height:180px;resize:vertical;padding:16px;border:1.5px solid var(--rb-line);border-radius:15px;background:var(--rb-soft);color:var(--rb-text);font:inherit;font-size:14px;line-height:1.75;outline:none;margin:8px 0 10px}#rabbit-graph-root .rg-source-input:focus{border-color:var(--rb-accent)}#rabbit-graph-root .rg-source-input:focus-visible{outline:none}#rabbit-graph-root .rg-source-input::placeholder{color:var(--rb-text-muted)}#rabbit-graph-root .rg-source-input[hidden]{display:none}#rabbit-graph-root .rg-source-actions>.rg-action:first-child{background:#fff;color:var(--rb-text-secondary)}
    #rabbit-graph-root .rg-thumb{position:relative}#rabbit-graph-root .rg-thumb-open{display:block;width:100%;padding:0;border:0;background:none;text-align:left;color:inherit;font:inherit;cursor:pointer}#rabbit-graph-root .rg-thumb-controls{position:absolute;right:4px;top:4px;display:flex;gap:3px;opacity:0;pointer-events:none;transition:opacity .15s}#rabbit-graph-root .rg-thumb:hover .rg-thumb-controls,#rabbit-graph-root .rg-thumb:focus-within .rg-thumb-controls{opacity:1;pointer-events:auto}#rabbit-graph-root .rg-thumb-controls>.rg-action{width:24px;height:24px;border:1px solid var(--rb-line);border-radius:8px;background:#fff;color:var(--rb-text-secondary);padding:4px}#rabbit-graph-root .rg-thumb-controls>.rg-action>svg{width:14px;height:14px}#rabbit-graph-root .rg-thumb-controls>.rg-action:hover{background:var(--rb-soft);color:var(--rb-accent)}@media(hover:none){#rabbit-graph-root .rg-thumb-controls{opacity:1;pointer-events:auto}}
    @media(any-pointer:coarse){#rabbit-graph-root .rg-card-tools,#rabbit-graph-root .rg-pin-toggle{opacity:1}}
    @keyframes rg-pulse{50%{opacity:.3}}@media(max-width:600px){#rabbit-graph-root .rg-sidebar{left:12px;top:12px;width:86px;bottom:12px}#rabbit-graph-root .rg-thumbs{gap:8px}#rabbit-graph-root .rg-thumb{padding:5px}#rabbit-graph-root .rg-thumb-preview{height:48px;margin-bottom:5px}#rabbit-graph-root .rg-folder{padding:7px;gap:4px}#rabbit-graph-root .rg-add-graph{gap:3px}#rabbit-graph-root .rg-plugin{right:12px;top:12px}#rabbit-graph-root .rg-pin-window{left:112px;right:94px}}
    @media(prefers-reduced-motion:reduce){#rabbit-graph-root *,#rabbit-graph-root *:before{animation:none!important;transition:none!important}}
  `;
  document.head.append(style);
  const root = el('div'); root.id = 'rabbit-graph-root'; root.setAttribute('aria-label','大爆炸知识图谱');
  const background = el('img','rg-background'); background.alt = ''; background.hidden = true;
  const viewport = el('div','rg-viewport'), world = el('div','rg-world'), edges = document.createElementNS(NS,'svg'); edges.classList.add('rg-edges');
  world.append(edges); viewport.append(world);
  const sidebar = el('aside','rg-sidebar'), folder = el('button','rg-folder'), folderName = el('span'); folder.append(icon('folder'),folderName,icon('down'));
  const thumbs = el('div','rg-thumbs'), addGraph = button('plus','新建空白图谱',()=>safe(createGraph),'rg-action rg-add-graph'),graphList=el('div','rg-graph-list');addGraph.append(el('span','','新建图谱'));
  const backgroundButton=el('button','rg-background-button'),backgroundSummary=el('span','rg-background-summary'),backgroundCopy=el('span','rg-background-copy');backgroundButton.type='button';backgroundButton.setAttribute('aria-label','背景信息');backgroundCopy.append(el('span','','背景信息'),backgroundSummary);backgroundButton.append(icon('document'),backgroundCopy);backgroundButton.onclick=()=>showBackground();
  graphList.append(thumbs,addGraph,backgroundButton,folder);sidebar.append(graphList);
  const plugin = el('div','rg-plugin'), chatButton=button('chat','图谱对话',()=>{if(window.RabbitChat?.getSnapshot().open)window.RabbitChat.close();else window.RabbitChat?.activateGraph({activationId:state.activation?.activationId});}), exitButton = button('close','退出知识图谱',()=>close()); plugin.append(chatButton,exitButton);
  const pinWindow = el('div','rg-pin-window'), pins = el('div','rg-pins'); pinWindow.append(pins);
  const focusLayer = el('div','rg-focus'), empty = el('div','rg-empty'); root.append(background,viewport,sidebar,pinWindow,plugin,empty,focusLayer); (scene || document.body).append(root);
  const state = { open:false,epoch:0,activation:null,workspace:null,workspaces:[],graphId:null,selectedId:null,focusId:null,width:0,height:0,view:{x:0,y:0,zoom:1},menu:null,dialog:null,note:null,toast:null,pinOffset:0,drag:null };
  const cards = new Map(), pinCards = new Map(), layoutPending = new Set(),layoutSignatures=new Map(),backgroundDrafts=new Map(),sourceImports=new Map();
  let focusCard = null, viewTimer, viewMotion=null, toastTimer, resizeFrame, thumbnailSignature,pinFrame,pendingPin=null,pinPress=null,pinRegionsSignature='',chatContextKey=null;
  const activeAnimations=new WeakMap(),reducedMotion=window.matchMedia('(prefers-reduced-motion: reduce)').matches,pinPanels=new Set();
  let pluginEnabled=window.RabbitSettings?.getSnapshot().settings.graphPluginEnabled!==false;
  function motion(element,frames,duration=300) { activeAnimations.get(element)?.cancel();if(reducedMotion)return Promise.resolve();const animation=element.animate(frames,{duration,easing:'cubic-bezier(.22,1,.36,1)',fill:'none'});activeAnimations.set(element,animation);return animation.finished.catch(()=>{}).then(()=>{if(activeAnimations.get(element)===animation)activeAnimations.delete(element);}); }
  function arrive(element) { return motion(element,[{opacity:0,translate:'0 9px'},{opacity:1,translate:'0 0'}]); }
  function depart(element) { if(!element)return; element.style.pointerEvents='none';element.inert=true;element.setAttribute('aria-hidden','true');return motion(element,[{opacity:1,translate:'0 0'},{opacity:0,translate:'0 7px'}],180).then(()=>element.remove()); }
  const graph = () => state.workspace?.graphs.find(item=>item.id===state.graphId);
  const nodeById = (id, graphId=state.graphId) => state.workspace?.graphs.find(item=>item.id===graphId)?.nodes.find(item=>item.id===id);
  const key = (graphId,nodeId) => `${state.workspace?.id}/${graphId}/${nodeId}`;
  const viewStates=new Map();
  function viewStateKey() { return `rabbitball.graph-view:${JSON.stringify([state.workspace?.id,state.graphId])}`; }
  function readViewState() {
    if(!graph())return null;const key=viewStateKey();if(viewStates.has(key))return viewStates.get(key);
    try{const saved=JSON.parse(window.localStorage?.getItem(key)||'null');if(saved&&['x','y','zoom'].every(name=>Number.isFinite(saved.view?.[name]))&&saved.view.zoom>0&&(saved.focusId===null||typeof saved.focusId==='string')){viewStates.set(key,saved);return saved;}}catch{}
    return null;
  }
  function rememberView(focusId=readViewState()?.focusId??null) {
    if(!graph())return;const key=viewStateKey(),saved={view:{...state.view},focusId};viewStates.set(key,saved);
    try{window.localStorage?.setItem(key,JSON.stringify(saved));}catch{}
  }
  const currentRequest = nodeId => ({workspaceId:state.workspace.id,graphId:state.graphId,nodeId});
  const noteWrites=new Map();
  function notify(message, action, label) {
    if(!pluginEnabled)return;
    state.toast?.remove();clearTimeout(toastTimer);
    const toast=el('div','rg-toast',message);toast.setAttribute('role','status');
    if(action){const item=el('button','',label);item.onclick=action;toast.append(item);}
    const failed=[...noteWrites.values()].filter(write=>write.failed);
    if(failed.length){
      toast.dataset.noteFailures='true';
      const retry=el('button','','重试保存');
      retry.onclick=()=>{for(const write of failed)write.retry();notify('正在保存批注…');};toast.append(retry);
    }
    state.toast=toast;root.classList.add('has-toast');root.append(toast);arrive(toast);trackPinRegions();
    if(!failed.length)toastTimer=setTimeout(()=>{toast.remove();if(state.toast===toast){state.toast=null;root.classList.remove('has-toast');reportPinRegions();}},action?7000:4500);
  }
  function fail(error) { notify(error?.message || String(error)); }
  async function mutate(mutation, workspaceId=state.workspace?.id) { const result=hydrate(await bridge.graphMutate(workspaceId,mutation)); applyWorkspace(result); return result; }
  function safe(task) { Promise.resolve().then(task).catch(fail); }
  function dimensions() { const bounds=root.getBoundingClientRect();state.width=bounds.width*(bounds.width<600?.74:.2);state.height=state.width*4/3;root.style.setProperty('--rg-width',`${state.width}px`);root.style.setProperty('--rg-height',`${state.height}px`); }
  function boundedView(view) { const current=graph();return constrainView(view,current?.nodes.map(node=>position(node,current))||[],state.width,root.getBoundingClientRect()); }
  function paintView(view) { state.view={...view};world.style.setProperty('--rg-control-scale',String(1/view.zoom));world.style.transform=`translate(${view.x}px,${view.y}px) scale(${view.zoom})`;if(state.workspace&&state.graphId)renderPins(); }
  function cancelViewMotion() { if(viewMotion){cancelAnimationFrame(viewMotion.frame);viewMotion=null;}activeAnimations.get(viewport)?.cancel(); }
  function setView(view, persist=false) { cancelViewMotion();paintView(boundedView(view));if(persist)scheduleView(); }
  function animateView(view,slide=0) {
    cancelViewMotion();clearTimeout(viewTimer);const target=boundedView(view),from={...state.view,y:state.view.y+slide};
    if(reducedMotion||Math.abs(from.x-target.x)+Math.abs(from.y-target.y)+Math.abs(from.zoom-target.zoom)<.01){paintView(target);scheduleView();return;}
    const pending={frame:null,started:performance.now()};viewMotion=pending;paintView(from);
    const frame=time=>{if(viewMotion!==pending)return;const progress=clamp((time-pending.started)/420,0,1),amount=viewProgress(progress);paintView({x:from.x+(target.x-from.x)*amount,y:from.y+(target.y-from.y)*amount,zoom:from.zoom+(target.zoom-from.zoom)*amount});if(progress<1)pending.frame=requestAnimationFrame(frame);else{viewMotion=null;paintView(target);scheduleView();}};
    pending.frame=requestAnimationFrame(frame);
  }
  function scheduleView() { clearTimeout(viewTimer);rememberView();const workspaceId=state.workspace.id,graphId=state.graphId,view={...state.view};viewTimer=setTimeout(()=>safe(()=>mutate({type:'view',graphId,view},workspaceId)),220); }
  function flushView() { if(!state.workspace||!state.graphId)return;clearTimeout(viewTimer);rememberView();const view={...state.view},workspaceId=state.workspace.id,graphId=state.graphId;safe(()=>mutate({type:'view',graphId,view},workspaceId)); }
  function selected(id) { state.selectedId=id;for(const [nodeId,card] of cards)card.element.classList.toggle('is-selected',nodeId===id);emit('graph:selection',getChatContext()); }
  function getChatContext() { const current=graph();return state.open&&current?{workspaceId:state.workspace.id,graphId:current.id,nodeId:state.selectedId||current.rootId}:null; }
  function announceContext() { const context=getChatContext(),next=context?`${context.workspaceId}/${context.graphId}`:null;if(next===chatContextKey)return;chatContextKey=next;emit('graph:contextchange',context?{workspaceId:context.workspaceId,graphId:context.graphId}:null); }
  function getSnapshot() { return {open:state.open,workspaceId:state.workspace?.id??null,graphId:state.graphId,nodeId:state.selectedId,view:{...state.view},workspace:state.workspace?structuredClone(state.workspace):null}; }
  async function open(activation={}) {
    if(!bridge)throw new Error('桌面图谱服务不可用');
    if(bridge.surface==='pet')return bridge.graphActivate(activation.graphSelection?{workspaceId:activation.workspaceId,...activation.graphSelection}:activation.graphAction);
    const alreadyOpen=state.open,epoch=++state.epoch,pinTarget=pendingPin?.activating?pendingPin:null;if(alreadyOpen){cancelViewMotion();flushView();}pendingPin=null;state.activation=activation;state.open=true;root.classList.add('is-open');dimensions();
    background.hidden=!activation.backgroundImageDataUrl;if(activation.backgroundImageDataUrl)background.src=activation.backgroundImageDataUrl;
    let workspace;try{workspace=hydrate(await bridge.graphOpen(activation.workspaceId));}catch(error){if(epoch===state.epoch)close();throw error;}if(epoch!==state.epoch||!state.open)return;
    resetWorkspace(workspace,alreadyOpen);emit('graph:open',{activationId:activation.activationId,...getChatContext()});
    if(activation.graphSelection)visitGraph(activation.graphSelection.graphId,activation.graphSelection.nodeId);
    else if(pinTarget?.workspaceId===workspace.id)visitGraph(pinTarget.graphId,pinTarget.nodeId);
    bridge.graphList().then(items=>{if(epoch===state.epoch)state.workspaces=items;}).catch(fail);
    if(activation.graphAction){try{await execute(activation.graphAction);}catch(error){fail(error);}}
  }
  function close() { pendingPin=null;if(!state.open)return;state.drag?.cancel?.({restore:false});cancelViewMotion();flushView();state.open=false;state.epoch++;closeFocus(false,false);closeMenu();closeDialog();closeNote();root.classList.remove('is-open');renderPins();announceContext();emit('graph:close',{activationId:state.activation?.activationId}); }
  function resetWorkspace(workspace,animate=false) { state.drag?.cancel?.({restore:false});cancelViewMotion();closeFocus(false,false);closeNote();closeMenu();closeDialog();state.workspace=hydrate(workspace);state.graphId=workspace.lastGraphId||workspace.graphs[0]?.id||null;state.selectedId=null;cards.forEach(card=>card.element.remove());cards.clear();layoutSignatures.clear();const initial=graph()&&!graph().layoutInitialized&&!readViewState();render(true);restoreView(initial);announceContext(); }
  function applyWorkspace(workspace) {
    if(!state.workspace||workspace.id!==state.workspace.id||workspace.revision<state.workspace.revision)return;
    const previousGraphId=state.graphId;state.workspace=workspace;if(!graph())state.graphId=workspace.lastGraphId||workspace.graphs[0]?.id||null;
    if(previousGraphId!==state.graphId){if(!state.drag?.committing)state.drag?.cancel?.({restore:false});cancelViewMotion();clearTimeout(viewTimer);closeFocus(false,false);closeNote();cards.forEach(card=>card.element.remove());cards.clear();}
    if(state.selectedId&&!nodeById(state.selectedId))state.selectedId=null;
    if(state.focusId&&!nodeById(state.focusId))closeFocus();
    if(state.note&&!nodeById(state.note.nodeId,state.note.graphId))closeNote();
    if(state.open){const initial=graph()&&!graph().layoutInitialized&&!readViewState();render(previousGraphId!==state.graphId);if(previousGraphId!==state.graphId)restoreView(initial);}else renderPins();announceContext();
  }
  function restoreView(initial=false,restoreFocus=true) { const current=graph();if(!current)return;const saved=readViewState(),rootNode=current.nodes.find(node=>node.id===current.rootId),target=saved?.view||(initial&&rootNode?rootView(position(rootNode,current),state.width,root.getBoundingClientRect()):current.view);setView(target,true);if(saved?.focusId&&!nodeById(saved.focusId))rememberView(null);else if(restoreFocus&&!state.drag&&saved?.focusId)openFocus(saved.focusId); }
  async function switchWorkspace(id) { state.drag?.cancel?.({restore:false});cancelViewMotion();flushView();const epoch=++state.epoch;closeMenu();const workspace=await bridge.graphOpen(id);if(epoch===state.epoch&&state.open)resetWorkspace(workspace,true); }
  function graphDirection(id) { const items=state.workspace.graphs;return Math.sign(items.findIndex(item=>item.id===id)-items.findIndex(item=>item.id===state.graphId))||1; }
  function graphTransition(direction,initial=false,restoreFocus=true) { restoreView(initial,restoreFocus);motion(viewport,[{opacity:.25,translate:`0 ${direction*24}px`},{opacity:1,translate:'0 0'}],420); }
  function visitGraph(id, nodeId) { if(!state.drag?.committing)state.drag?.cancel?.({restore:false});if(id!==state.graphId){const direction=graphDirection(id);cancelViewMotion();flushView();closeFocus(false,false);closeNote();state.graphId=id;state.selectedId=null;cards.forEach(card=>card.element.remove());cards.clear();layoutSignatures.delete(`${state.workspace.id}/${id}`);const initial=graph()&&!graph().layoutInitialized&&!readViewState();render(true);graphTransition(direction,initial,!nodeId);announceContext();safe(()=>mutate({type:'visit',graphId:id}));}if(nodeId){closeFocus(false);locate(nodeId);} }
  function position(node,current=graph()) { const ratio=state.width/current.layoutUnit;return{x:node.x*ratio,y:node.y*ratio,height:cardHeight(node,state.width)}; }
  function locate(nodeId) { const node=nodeById(nodeId);if(!node)return;const point=position(node),bounds=root.getBoundingClientRect();setView({x:bounds.width*.56-(point.x+state.width/2)*state.view.zoom,y:bounds.height*.52-(point.y+point.height/2)*state.view.zoom,zoom:state.view.zoom},true);selected(nodeId); }
  async function createGraph() { const workspaceId=state.workspace.id,epoch=state.epoch,workspace=await mutate({type:'create-graph'},workspaceId);if(state.open&&state.epoch===epoch&&state.workspace.id===workspaceId&&workspace.lastGraphId)visitGraph(workspace.lastGraphId); }
  // 截图与写入共用一次挂起周期，三种入口都在取消或失败后恢复界面。
  async function captureInto(request,consume) {
    if(root.classList.contains('capture-suspended'))return;
    root.classList.add('capture-suspended');
    try{const images=await bridge.graphCaptureImages(request);if(images?.length)return await consume(images);}
    finally{root.classList.remove('capture-suspended');}
  }
  async function capture() {
    if(!state.workspace||!state.graphId||root.classList.contains('capture-suspended'))return;
    const workspaceId=state.workspace.id,graphId=state.graphId,epoch=state.epoch;
    await captureInto({workspaceId,graphId},async images=>{
      const saved=await mutate({type:'add-root',graphId,markdown:'',images},workspaceId);
      if(state.open&&state.epoch===epoch&&state.workspace?.id===workspaceId&&state.graphId===graphId)openFocus(saved.graphs.find(item=>item.id===graphId).rootId);
    });
  }
  async function createCustomCard(card) {
    if(card.addCustom.disabled)return;
    const workspaceId=state.workspace.id,graphId=card.graphId,parentId=card.nodeId,epoch=state.epoch,focused=focusCard,existing=new Set(graph().nodes.map(node=>node.id));card.addCustom.disabled=true;
    try{
      const saved=await mutate({type:'add-custom-node',graphId,parentId,markdown:'',images:[]},workspaceId);
      const child=saved.graphs.find(item=>item.id===graphId)?.nodes.findLast(node=>node.parentId===parentId&&node.kind==='source'&&!existing.has(node.id));
      if(child&&state.open&&state.epoch===epoch&&state.workspace?.id===workspaceId&&state.graphId===graphId&&focusCard===focused)openFocus(child.id);
    }finally{card.addCustom.disabled=false;}
  }
  async function appendNodeImages(card) {
    if(card.addImages.disabled||root.classList.contains('capture-suspended'))return;
    const workspaceId=state.workspace.id,graphId=card.graphId,nodeId=card.nodeId;card.addImages.disabled=true;
    try{await captureInto({workspaceId,graphId,nodeId},images=>mutate({type:'append-node-images',graphId,nodeId,images},workspaceId));}
    finally{card.addImages.disabled=false;}
  }
  const sourceImportKey=(workspaceId,graphId,nodeId)=>`${workspaceId}/${graphId}/${nodeId}`;
  function refreshSourceImport(entry) {
    if(state.workspace?.id!==entry.workspaceId)return;
    for(const card of [...cards.values(),focusCard,...[...pinCards.values()].map(value=>value.card)])if(card?.nodeId===entry.nodeId&&card.graphId===entry.graphId)renderSourceImport(card);
  }
  function renderSourceImport(card) {
    if(!card.sourceActions)return;
    const entry=sourceImports.get(sourceImportKey(card.workspaceId,card.graphId,card.nodeId)),pending=entry?.importing||entry?.saving;
    card.addFiles.disabled=!!pending||card.removingAssets.size>0;
    if(card.addImages)card.addImages.disabled=!!pending||card.removingAssets.size>0;
    card.sourcePending.replaceChildren();card.uploadActions.replaceChildren();
    card.uploadStatus.textContent=entry?.error||(entry?.importing?'正在读取文件…':entry?.saving?'正在保存资料…':'');
    for(const attachment of entry?.attachments||[])card.sourcePending.append(window.RabbitDocuments.createTile(attachment,{removeDisabled:!!pending,onRemove:()=>{entry.attachments=entry.attachments.filter(value=>value!==attachment);refreshSourceImport(entry);}}));
    if(entry&&!pending){if(entry.attachments.length){const retry=textButton('重试保存',()=>saveSourceImport(entry));retry.disabled=card.removingAssets.size>0;card.uploadActions.append(retry);}card.uploadActions.append(textButton('取消导入',()=>{sourceImports.delete(sourceImportKey(entry.workspaceId,entry.graphId,entry.nodeId));refreshSourceImport(entry);}));}
  }
  async function saveSourceImport(entry) {
    if(entry.saveTask)return entry.saveTask;if(entry.importing||!entry.attachments.length)return;
    entry.saving=true;entry.error=entry.readError||'';refreshSourceImport(entry);
    entry.saveTask=(async()=>{try{
      while(entry.attachments.length){
        const images=!!entry.attachments[0].dataUrl,selected=[];
        for(const attachment of entry.attachments){if(!!attachment.dataUrl!==images)break;selected.push(attachment);}
        const mutation=images?{type:'append-node-images',images:selected.map(attachment=>({id:attachment.id,title:attachment.name,imageDataUrl:attachment.dataUrl}))}:{type:'append-node-attachments',attachments:selected};
        await mutate({...mutation,graphId:entry.graphId,nodeId:entry.nodeId},entry.workspaceId);
        entry.attachments=entry.attachments.filter(attachment=>!selected.includes(attachment));refreshSourceImport(entry);
      }
      if(!entry.error)sourceImports.delete(sourceImportKey(entry.workspaceId,entry.graphId,entry.nodeId));
    }catch(error){entry.error=`保存失败：${error?.message||String(error)}`;}
    finally{entry.saving=false;refreshSourceImport(entry);}})();
    try{await entry.saveTask;}finally{entry.saveTask=null;}
  }
  async function importSourceFiles(card,files) {
    if(!files.length)return;
    const entryKey=sourceImportKey(card.workspaceId,card.graphId,card.nodeId);
    let entry=sourceImports.get(entryKey);if(entry?.importing||entry?.saving)return;
    if(!entry){entry={workspaceId:card.workspaceId,graphId:card.graphId,nodeId:card.nodeId,attachments:[],importing:false,saving:false,error:''};sourceImports.set(entryKey,entry);}
    entry.importing=true;entry.error='';refreshSourceImport(entry);const errors=[];
    entry.task=(async()=>{try{for(const file of files){if(sourceImports.get(entryKey)!==entry)break;try{const attachment=await window.RabbitDocuments.readFile(file,{workspaceId:entry.workspaceId});if(sourceImports.get(entryKey)===entry)entry.attachments.push(attachment);}catch(error){errors.push(`${file.name}：${error?.message||String(error)}`);}refreshSourceImport(entry);}}
    finally{entry.importing=false;entry.readError=errors.join('\n');entry.error=entry.readError;refreshSourceImport(entry);}
    if(sourceImports.get(entryKey)===entry)await saveSourceImport(entry);
    })();try{await entry.task;}finally{entry.task=null;}
    if(document.activeElement===card.filePicker||!document.activeElement?.closest('input,textarea,select,[contenteditable="true"]'))focusSourceInput(card);
  }
  async function removeSourceAsset(card,type,id) {
    const node=state.workspace?.id===card.workspaceId?nodeById(card.nodeId,card.graphId):null,assetKey=`${type}:${id}`;if(!node||card.assetRemovalTask||card.latestRemovalTask)return;card.removingAssets.add(assetKey);updateCard(card,node);
    card.assetRemovalTask=mutate({type,graphId:card.graphId,nodeId:card.nodeId,...(type==='remove-node-image'?{imageId:id}:{attachmentId:id})},card.workspaceId);
    try{await card.assetRemovalTask;}
    finally{card.assetRemovalTask=null;card.removingAssets.delete(assetKey);if(state.workspace?.id===card.workspaceId){const node=nodeById(card.nodeId,card.graphId);if(node&&card.element.isConnected)updateCard(card,node);}}
  }
  function focusSourceInput(card) {
    if(!state.open||state.dialog||focusCard!==card||state.note?.card===card)return;
    if(card.sourceInput&&!card.sourcePreview)card.sourceInput.focus({preventScroll:true});
    else if(card.addFiles.disabled){card.element.tabIndex=-1;card.element.focus({preventScroll:true});}
    else card.addFiles.focus({preventScroll:true});
  }
  function sourceBackspace(card,event) {
    if(event.key!=='Backspace'||event.ctrlKey||event.altKey||event.metaKey||card.sourceComposing||event.isComposing||event.keyCode===229||focusCard!==card||!state.open||state.dialog||state.note?.card===card)return;
    const node=state.workspace?.id===card.workspaceId?nodeById(card.nodeId,card.graphId):null,input=card.sourceInput;
    const target=event.target.closest('input,textarea,select,[contenteditable="true"]');
    if(!node||(target&&target!==input&&target!==card.filePicker)||input.value!=='')return;
    const entry=sourceImports.get(sourceImportKey(card.workspaceId,card.graphId,card.nodeId));
    if(entry?.importing||entry?.saving)return;
    if(entry?.attachments.length){event.preventDefault();event.stopPropagation();entry.attachments.pop();entry.error='';refreshSourceImport(entry);focusSourceInput(card);return;}
    if(card.removingAssets.size&&!card.latestRemovalTask||node.images.length+(node.attachments?.length||0)<=(card.latestRemovalCount||0))return;
    event.preventDefault();event.stopPropagation();card.latestRemovalCount=(card.latestRemovalCount||0)+1;
    if(card.latestRemovalTask)return;
    card.removingAssets.add('latest');updateCard(card,node);
    // 每次退格在上一笔写入完成后再取当前尾项；不重复删除同一份旧快照。
    card.latestRemovalTask=(async()=>{
      try{
        while(card.latestRemovalCount&&focusCard===card&&state.workspace?.id===card.workspaceId){
          await mutate({type:'remove-latest-node-asset',graphId:card.graphId,nodeId:card.nodeId},card.workspaceId);
          card.latestRemovalCount--;
          focusSourceInput(card);
        }
        return true;
      }catch(problem){fail(problem);return false;}
      finally{card.latestRemovalCount=0;card.latestRemovalTask=null;card.removingAssets.delete('latest');if(state.workspace?.id===card.workspaceId){const current=nodeById(card.nodeId,card.graphId);if(current&&card.element.isConnected)updateCard(card,current);}focusSourceInput(card);}
    })();
  }
  const sourceDrafts=new Map();
  function sourceDraftKey(card) { return `${card.workspaceId}/${card.graphId}/${card.nodeId}`; }
  function sourceValue(card,node) { return sourceDrafts.get(sourceDraftKey(card))?.value ?? node.markdown; }
  async function saveSourceText(card) {
    const entry=sourceDrafts.get(sourceDraftKey(card));if(!entry)return;
    clearTimeout(entry.timer);if(entry.task)return entry.task;
    entry.task=(async()=>{
      while(sourceDrafts.get(sourceDraftKey(card))===entry){
        await card.latestRemovalTask;await card.assetRemovalTask;
        const pending=sourceImports.get(sourceDraftKey(card));await pending?.task;await pending?.saveTask;
        const value=entry.value,node=(state.workspace?.id===card.workspaceId?nodeById(card.nodeId,card.graphId):null)||card.lastNode;if(!node)return;
        if(node.markdown!==value){
          const saved=await mutate({type:'edit',graphId:card.graphId,nodeId:card.nodeId,title:node.title,markdown:value,contentRevision:node.contentRevision},card.workspaceId);
          card.lastNode=saved.graphs.find(graph=>graph.id===card.graphId)?.nodes.find(node=>node.id===card.nodeId);
        }
        if(entry.value===value){sourceDrafts.delete(sourceDraftKey(card));return;}
      }
    })();
    try{await entry.task;}finally{entry.task=null;}
  }
  function createSourceInput(card,node) {
    const input=el('textarea','rg-source-input');input.value=sourceValue(card,node);input.placeholder='输入问题或粘贴内容';input.setAttribute('aria-label','输入问题或粘贴内容');input.rows=6;card.sourceInput=input;
    input.addEventListener('input',()=>{
      const key=sourceDraftKey(card);let entry=sourceDrafts.get(key);if(!entry){entry={value:input.value};sourceDrafts.set(key,entry);}entry.value=input.value;clearTimeout(entry.timer);
      entry.timer=setTimeout(()=>safe(()=>saveSourceText(card)),600);card.sourcePreviewButton.hidden=!input.value.trim();syncSourceGenerate(card,nodeById(card.nodeId,card.graphId)||card.lastNode);
    });
    input.addEventListener('blur',()=>safe(()=>saveSourceText(card)));
    input.addEventListener('keydown',event=>{if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)&&!event.isComposing&&event.keyCode!==229&&!card.sourceComposing){event.preventDefault();if(!event.repeat)safe(()=>generateAnnotations(nodeById(card.nodeId,card.graphId),card.graphId,card.workspaceId));}});
    const preview=button('document','预览内容并添加批注',()=>safe(async()=>{
      await saveSourceText(card);card.sourcePreview=!card.sourcePreview;input.hidden=card.sourcePreview;card.text.hidden=!card.sourcePreview;preview.setAttribute('aria-pressed',String(card.sourcePreview));if(!card.sourcePreview)input.focus({preventScroll:true});
    }));preview.append(el('span','','预览'));card.sourcePreviewButton=preview;
    card.content.insertBefore(input,card.sourceActions);card.sourceActions.append(preview);card.text.hidden=true;
  }
  function syncSourceGenerate(card,node) {
    if(card.generate)card.generate.disabled=busy(node)||(!node.annotations.some(item=>!item.childId)&&!(node.kind==='source'&&(card.sourceInput?card.sourceInput.value:node.markdown).trim()));
  }
  function arrangeLayout(current) {
    const graphKey=`${state.workspace.id}/${current.id}`;if(layoutPending.has(graphKey))return;
    const projected=current.nodes.map(node=>({...node,...position(node,current)})),rootNode=projected.find(node=>node.parentId===null),signature=JSON.stringify([state.width,rootNode?.x,rootNode?.y,projected.map(node=>[node.id,node.parentId,node.height])]);
    if(layoutSignatures.get(graphKey)===signature)return;layoutSignatures.set(graphKey,signature);
    const positions=layoutTree(projected,state.width),initial=!current.layoutInitialized,changed=initial||positions.some(point=>{const before=projected.find(node=>node.id===point.id);return Math.abs(point.x-before.x)>.5||Math.abs(point.y-before.y)>.5;});if(!changed)return;
    const workspaceId=state.workspace.id,unit=state.width;for(const point of positions)Object.assign(current.nodes.find(node=>node.id===point.id),point);current.layoutUnit=unit;current.layoutInitialized=true;layoutPending.add(graphKey);
    safe(async()=>{try{await mutate({type:'layout',graphId:current.id,positions,unit},workspaceId);}finally{layoutPending.delete(graphKey);if(state.open&&state.workspace?.id===workspaceId&&state.graphId===current.id)render();}});
  }
  function render(preserveView=false) {
    dimensions();folderName.textContent=state.workspace?.name||'工作区';folder.title=folderName.textContent;renderBackgroundSummary();renderThumbnails();renderPins();const current=graph();
    empty.replaceChildren();if(!current||!current.nodes.length){cards.forEach(card=>card.element.remove());cards.clear();edges.replaceChildren();empty.append(button('plus',current?'添加根节点':'新建空白图谱',()=>safe(current?capture:createGraph),'rg-empty-add'));return;}
    if(!state.drag||state.drag.committing)arrangeLayout(current);const ids=new Set(current.nodes.map(node=>node.id));for(const [id,card] of cards)if(!ids.has(id)){depart(card.element);cards.delete(id);}
    const existing=cards.size>0,branches=new Set();
    for(const node of current.nodes){let card=cards.get(node.id);if(!card){card=createCard(node,current.id,'world');cards.set(node.id,card);world.append(card.element);if(existing&&node.parentId){branches.add(node.id);motion(card.element,[{opacity:0,transform:'translateX(-48px) scale(.94)'},{opacity:1,transform:'translateX(0) scale(1)'}],480);}else arrive(card.element);}updateCard(card,node);const point=position(node);card.element.style.left=`${point.x}px`;card.element.style.top=`${point.y}px`;}
    drawEdges(branches);if(!preserveView&&!viewMotion)paintView(boundedView(state.view));if(branches.size)revealBranches(branches);if(focusCard){const node=nodeById(state.focusId);if(node)updateCard(focusCard,node);}
  }
  function graphThumbnail(current) {
    const svg=document.createElementNS(NS,'svg');svg.setAttribute('aria-hidden','true');const nodes=current.nodes.map(node=>({...node,...position(node,current)}));for(const point of layoutTree(nodes,state.width))Object.assign(nodes.find(node=>node.id===point.id),point);
    if(!nodes.length){svg.setAttribute('viewBox','0 0 132 76');const path=document.createElementNS(NS,'path');path.setAttribute('d','M59 38h14M66 31v14');svg.append(path);return svg;}
    const margin=state.width*.2,minX=Math.min(...nodes.map(node=>node.x))-margin,minY=Math.min(...nodes.map(node=>node.y))-margin,maxX=Math.max(...nodes.map(node=>node.x))+state.width+margin,maxY=Math.max(...nodes.map(node=>node.y+node.height))+margin;
    svg.setAttribute('viewBox',`${minX} ${minY} ${maxX-minX} ${maxY-minY}`);
    const previewScale=Math.min((root.clientWidth<600?74:116)/(maxX-minX),(root.clientWidth<600?48:70)/(maxY-minY)),detailed=state.width*previewScale>=14;
    const shape=(tag,attributes)=>{const item=document.createElementNS(NS,tag);for(const [name,value] of Object.entries(attributes))item.setAttribute(name,String(value));return item;};
    for(const node of nodes){const parent=nodes.find(item=>item.id===node.parentId);if(parent){const path=document.createElementNS(NS,'path');path.setAttribute('d',edgePath(parent,node,state.width,state.height));svg.append(path);}}
    for(const node of nodes){
      const group=shape('g',{}),inset=state.width*.12,bodyWidth=state.width-2*inset;group.append(shape('rect',{class:'rg-mini-card',x:node.x,y:node.y,width:state.width,height:node.height,rx:22}));
      if(node.kind==='source'&&node.images.length){const image=node.images[0];group.append(shape('image',{href:image.imageDataUrl,x:node.x+inset,y:node.y+inset,width:bodyWidth,height:node.height-2*inset,preserveAspectRatio:'xMidYMid meet'}));}
      else if(node.kind==='source'&&node.attachments?.length){const x=node.x+state.width*.28,y=node.y+state.width*.16,w=state.width*.44,h=Math.min(node.height-state.width*.32,state.width*.56);group.append(shape('rect',{x,y,width:w,height:h,rx:4,fill:'var(--rb-soft)',stroke:'var(--rb-line)','stroke-width':2}));const label=shape('text',{x:x+w/2,y:y+h*.65,'text-anchor':'middle','font-size':state.width*.085,fill:'var(--rb-accent)'});label.textContent=(node.attachments[0].format||node.attachments[0].name.split('.').at(-1)||'FILE').toUpperCase().slice(0,6);group.append(label);}
      else if(detailed){
        group.append(shape('rect',{class:'rg-mini-heading',x:node.x+inset,y:node.y+inset,width:bodyWidth*.66,height:state.width*.055,rx:state.width*.025}));
        for(let line=0;line<4;line++)group.append(shape('rect',{class:'rg-mini-line',x:node.x+inset,y:node.y+inset+state.width*(.14+line*.13),width:bodyWidth*(line===3?.56:line===1?.88:1),height:state.width*.027,rx:state.width*.013}));
      }else group.append(shape('rect',{class:'rg-mini-heading',x:node.x+inset,y:node.y+inset,width:bodyWidth*.7,height:state.width*.06,rx:state.width*.03}));
      svg.append(group);
    }return svg;
  }
  async function deleteGraph(id) {
    const workspaceId=state.workspace.id;
    if(id===state.graphId){state.drag?.cancel?.({restore:false});cancelViewMotion();clearTimeout(viewTimer);rememberView();}
    await mutate({type:'delete-graph',graphId:id},workspaceId);
    if(state.workspace?.id!==workspaceId)return;
    notify('已删除图谱',()=>safe(async()=>{const epoch=state.epoch;const workspace=await mutate({type:'undo'},workspaceId);if(state.open&&state.epoch===epoch&&state.workspace?.id===workspaceId&&workspace.graphs.some(item=>item.id===id))visitGraph(id);}), '撤销');
  }
  function renderThumbnails() {
    const signature=JSON.stringify([state.graphId,state.width,...(state.workspace?.graphs||[]).map(item=>[item.id,item.title,item.layoutUnit,item.nodes.map(node=>[node.id,node.parentId,node.x,node.y,cardHeight(node,state.width),node.attachments?.map(attachment=>[attachment.name,attachment.format])])])]);if(signature===thumbnailSignature)return;thumbnailSignature=signature;thumbs.replaceChildren();
    for(const item of state.workspace?.graphs||[]){
      const thumb=el('div','rg-thumb'+(item.id===state.graphId?' is-active':''));thumb.dataset.graphId=item.id;thumb.setAttribute('role','group');thumb.setAttribute('aria-label',item.title);
      const open=el('button','rg-thumb-open');open.type='button';open.title=item.title;open.setAttribute('aria-label',`打开图谱：${item.title}`);const preview=el('span','rg-thumb-preview');preview.append(graphThumbnail(item));open.append(preview,el('span','rg-thumb-caption',item.title));
      const controls=el('div','rg-thumb-controls');controls.append(button('usage',`查看图谱用量：${item.title}`,()=>window.RabbitUsage?.open({kind:'graph',workspaceId:state.workspace.id,graphId:item.id},{title:item.title})),button('trash',`删除图谱：${item.title}`,()=>safe(()=>deleteGraph(item.id))));thumb.append(open,controls);thumb.onclick=event=>{if(!event.target.closest('.rg-thumb-controls'))visitGraph(item.id);};thumbs.append(thumb);
    }
  }
  function revealBranches(ids) {
    const current=graph(),nodes=current.nodes.filter(node=>ids.has(node.id)||current.nodes.some(child=>ids.has(child.id)&&child.parentId===node.id)),points=nodes.map(node=>position(node)),bounds=root.getBoundingClientRect();
    const left=Math.min(...points.map(point=>point.x)),right=Math.max(...points.map(point=>point.x+state.width)),top=Math.min(...points.map(point=>point.y)),bottom=Math.max(...points.map(point=>point.y+point.height));
    if(left*state.view.zoom+state.view.x>=24&&right*state.view.zoom+state.view.x<=bounds.width-24&&top*state.view.zoom+state.view.y>=24&&bottom*state.view.zoom+state.view.y<=bounds.height-24)return;
    const zoom=clamp(Math.min(state.view.zoom,(bounds.width-64)/(right-left),(bounds.height-64)/(bottom-top)),.4,1.8);
    animateView({x:bounds.width/2-(left+right)/2*zoom,y:bounds.height/2-(top+bottom)/2*zoom,zoom});
  }
  function drawEdges(branches=new Set()) {
    const previous=new Map(Array.from(edges.children).map(path=>[path.dataset.nodeId,path])),current=graph();
    for(const node of current?.nodes||[]){
      if(!node.parentId||state.drag?.nodeId===node.id&&state.drag.graphId===current.id)continue;
      const parent=current.nodes.find(item=>item.id===node.parentId);if(!parent)continue;
      let path=previous.get(node.id);if(path)previous.delete(node.id);else{path=document.createElementNS(NS,'path');path.dataset.nodeId=node.id;edges.append(path);}
      path.style.removeProperty('opacity');path.setAttribute('d',edgePath(position(parent),position(node),state.width,state.height));
      if(branches.has(node.id)){path.setAttribute('pathLength','1');motion(path,[{strokeDasharray:'1',strokeDashoffset:1},{strokeDasharray:'1',strokeDashoffset:0}],420);}
    }
    for(const path of previous.values())path.remove();
  }
  function createCard(node, graphId, mode) {
    const element=el('article','rg-card'+(mode==='focus'?' rg-card-focus':'')),tools=el('div','rg-card-tools'),title=el('button','rg-title'),scroll=el('div','rg-card-scroll'),content=el('div','rg-content'),images=el('div'),documents=el('div','rg-node-files'),text=el('div'),marks=el('div','rg-marks'),status=el('div','rg-status');
    element.dataset.nodeId=node.id;element.dataset.graphId=graphId;element.setAttribute('aria-label',node.title);title.type='button';text.className='rg-body';content.append(images,documents,text,marks);scroll.append(content,status);element.append(tools,title,scroll);
    const hint=el('p','rg-content-hint','添加文件、截图或文字说明');hint.hidden=true;content.append(hint);
    const card={element,tools,title,scroll,content,images,documents,text,marks,status,hint,workspaceId:state.workspace.id,nodeId:node.id,graphId,mode,signature:null,imageSources:null,preview:false,removingAssets:new Set()};
    const action=(name,label,handler)=>{const item=button(name,label,()=>safe(()=>handler(nodeById(card.nodeId,card.graphId))), 'rg-action');tools.append(item);return item;};
    if(mode==='focus'){card.generate=action('arrow','根据批注生成卡片',item=>generateAnnotations(item,graphId));card.generate.classList.add('rg-generate');card.generate.addEventListener('keydown',event=>{if(event.key==='Enter'&&event.repeat)event.preventDefault();});element.append(card.generate);}
    card.pin=action('pin','固定卡片',item=>mutate({type:'pin',graphId,nodeId:item.id,pinned:!item.pinned}));
    card.pin.classList.add('rg-pin-toggle');element.append(card.pin);
    if(mode==='pin')card.pin.classList.add('rg-unpin');
    else{if(node.parentId!==null&&node.kind!=='source')card.regenerate=action('refresh','重新生成',item=>bridge.graphRegenerate({workspaceId:state.workspace.id,graphId,nodeId:item.id}));card.remove=action('trash','删除卡片及其子卡片',item=>deleteNode(item,graphId));card.remove.classList.add('is-danger');}
    if(mode==='world'||mode==='focus')card.addCustom=action('plus','添加自定义卡片',()=>createCustomCard(card));
    if(mode!=='pin'&&node.kind==='source'){
      const picker=el('input');picker.type='file';picker.multiple=true;picker.hidden=true;picker.setAttribute('aria-label','添加卡片文件');card.filePicker=picker;
      card.sourceActions=el('div','rg-source-actions');card.sourcePending=el('div','rg-source-pending');card.uploadStatus=el('div','rg-source-upload-status');card.uploadStatus.setAttribute('role','status');card.uploadActions=el('div','rg-source-upload-actions');
      card.addFiles=button('document','添加文件或图片',()=>picker.click());card.addFiles.append(el('span','','文件'));card.sourceActions.append(card.addFiles);
      if(mode==='focus'){card.addImages=button('camera','添加截图',()=>safe(()=>appendNodeImages(card)));card.addImages.append(el('span','','截图'));card.sourceActions.append(card.addImages);}
      content.insertBefore(card.sourceActions,images);content.insertBefore(card.sourcePending,images);content.insertBefore(card.uploadStatus,images);content.insertBefore(card.uploadActions,images);content.append(picker);
      if(mode==='focus')createSourceInput(card,node);
      picker.onchange=()=>{const files=Array.from(picker.files||[]);picker.value='';return importSourceFiles(card,files);};
      if(mode==='focus'){element.addEventListener('compositionstart',()=>{card.sourceComposing=true;});element.addEventListener('compositionend',()=>{card.sourceComposing=false;});element.addEventListener('keydown',event=>sourceBackspace(card,event));}
    }
    card.stateActions=el('div','rg-state-actions');if(mode!=='pin')tools.append(card.stateActions);
    if(mode==='world')element.addEventListener('pointerdown',event=>beginCardDrag(event,card));
    if(mode==='pin'){element.tabIndex=-1;element.addEventListener('pointerdown',event=>beginPinInteraction(event,card),true);}
    title.onclick=event=>{if(!clickFrom(event,title))return;if(mode==='pin')safe(()=>activatePin(graphId,node.id));else openFocus(node.id);};
    element.addEventListener('click',event=>{const selection=window.getSelection();if(!clickFrom(event,element)||card.suppressClickUntil>Date.now()||event.target.closest('button,a,input,textarea')||selection?.toString()&&element.contains(selection.anchorNode))return;if(mode==='pin'){if(!event.target.closest('.rg-body,.rg-status'))safe(()=>activatePin(graphId,node.id));return;}selected(node.id);if(mode==='world')openFocus(node.id);});
    text.addEventListener('pointerup',event=>{if(event.button!==0||mode!=='focus')return;setTimeout(()=>captureTextSelection(card),0);});
    scroll.addEventListener('scroll',()=>{if(state.note?.card===card)state.note.reposition();});
    element.addEventListener('transitionend',event=>{if(event.propertyName==='width'||event.propertyName==='height')paintAnnotations(card);});
    return card;
  }
  function bodyMotion(card,frames,duration) {
    card.bodyAnimation?.cancel();if(reducedMotion)return Promise.resolve();
    const animation=card.content.animate(frames,{duration,easing:'cubic-bezier(.22,1,.36,1)',fill:'none'});card.bodyAnimation=animation;
    return animation.finished.catch(()=>{}).then(()=>{if(card.bodyAnimation===animation)card.bodyAnimation=null;});
  }
  function paintCardBody(card,reveal=false) {
    const target=card.bodyTarget;if(!target)return;
    const firstDraft=target.streaming&&!card.renderedMarkdown&&!!target.markdown;
    card.content.classList.toggle('is-generating',target.streaming);card.text.classList.toggle('is-streaming',target.streaming&&!!target.markdown);
    card.images.hidden=target.streaming&&target.node.kind==='card';
    if(card.renderedMarkdown!==target.markdown){card.renderedMarkdown=target.markdown;rich(card.text,target.markdown);}
    if((reveal||firstDraft)&&(target.markdown||!card.images.hidden&&target.node.images.length))void bodyMotion(card,[{opacity:0,transform:'translateY(6px)'},{opacity:1,transform:'translateY(0)'}],280);
    requestAnimationFrame(()=>paintAnnotations(card));
  }
  function renderCardBody(card,node,markdown,streaming) {
    const key=streaming?`draft:${node.generation?.id||node.id}`:card.preview?'candidate':'saved';
    card.bodyTarget={node,markdown,streaming};
    if(card.bodyKey?.startsWith('draft:')&&key==='saved'&&node.status==='idle'&&!node.candidate){
      card.bodyKey=key;
      if(card.bodyTransition){card.bodyTransition.key=key;return;}
      paintCardBody(card,!card.renderedMarkdown);return;
    }
    if(card.bodyTransition?.key===key)return;
    const changed=card.bodyKey!==undefined&&card.bodyKey!==key;card.bodyKey=key;
    if(card.bodyTransition){card.bodyTransition=null;card.bodyAnimation?.cancel();}
    if(changed&&card.renderedMarkdown&&card.renderedMarkdown!==markdown){
      const transition={key};card.bodyTransition=transition;const opacity=Number(getComputedStyle(card.content).opacity);
      void bodyMotion(card,[{opacity:Number.isFinite(opacity)?opacity:1,transform:'translateY(0)'},{opacity:0,transform:'translateY(-6px)'}],170).then(()=>{
        if(card.bodyTransition!==transition||!card.element.isConnected)return;card.bodyTransition=null;paintCardBody(card,true);
      });
    }else paintCardBody(card,changed&&card.renderedMarkdown!==markdown);
  }
  function updateCardProgress(card,node) {
    clearTimeout(card.progressTimer);const text=generationText(node);card.status.hidden=!text;
    if(!card.progress){card.progress=el('span','rg-progress');card.status.replaceChildren(card.progress);card.scroll.insertBefore(card.status,card.content);}
    if(text&&card.progress.textContent!==text)card.progress.textContent=text;
    if(busy(node)&&node.status!=='queued'&&Number.isFinite(node.generation?.startedAt)&&node.generation.finishedAt===undefined){
      card.progressTimer=setTimeout(()=>{const current=nodeById(card.nodeId,card.graphId),visible=card.mode==='pin'?root.classList.contains('has-pins'):state.open&&state.graphId===card.graphId;if(card.element.isConnected&&visible&&current)updateCardProgress(card,current);},1000);
    }
  }
  function updateCard(card,node) {
    card.lastNode=node;if(card.sourceInput){if(!sourceDrafts.has(sourceDraftKey(card)))card.sourceInput.value=node.markdown;card.sourceInput.hidden=!!card.sourcePreview;card.text.hidden=!card.sourcePreview;card.sourcePreviewButton.hidden=!sourceValue(card,node).trim();}
    if(!node.candidate)card.preview=false;
    card.title.hidden=node.parentId===null;card.element.classList.toggle('is-root',node.parentId===null);card.element.classList.toggle('is-source',node.kind==='source');
    if(card.mode!=='focus')card.element.style.height=`${cardHeight(node,state.width)}px`;
    const title=cardTitle(node,card.preview);card.element.setAttribute('aria-label',title);card.element.classList.toggle('is-selected',state.selectedId===node.id);card.element.classList.toggle('is-busy',busy(node));const preview=titlePreview(title,state.width);card.title.title=title;if(card.titleSource!==preview){card.titleSource=preview;rich(card.title,preview);}card.element.style.setProperty('--rg-title-height',`${card.title.offsetHeight||34}px`);card.element.style.setProperty('--rg-title-width',`${card.title.offsetWidth}px`);
    card.pin.classList.toggle('is-active',node.pinned);card.pin.setAttribute('aria-pressed',String(node.pinned));card.pin.title=node.pinned?'取消固定':'固定卡片';card.pin.setAttribute('aria-label',card.pin.title);if(card.regenerate){card.regenerate.disabled=busy(node);card.regenerate.title=node.kind==='source'?'重新分析':'重新生成';card.regenerate.setAttribute('aria-label',card.regenerate.title);}if(card.generate)syncSourceGenerate(card,node);

    const hasSourceContent=!!node.markdown.trim()||node.images.length>0||!!node.attachments?.length;
    card.hint.hidden=!!card.sourceInput||node.kind!=='source'||hasSourceContent;
    if(card.sourceActions){card.sourceActions.hidden=card.mode!=='focus'&&hasSourceContent;card.sourceActions.classList.toggle('is-empty',!hasSourceContent&&!card.sourceInput);renderSourceImport(card);}
    const streaming=showingDraft(node),draft=node.draft?.match(/^###\s+[^\n]+\n([\s\S]*)$/);
    const markdown=card.preview&&node.candidate?node.candidate.markdown:streaming?(draft?.[1]?.trim()||''):node.markdown;
    const imageSignature=node.images.map(item=>`${item.id}:${card.removingAssets.has(`remove-node-image:${item.id}`)}`).join('/');
    const imagesChanged=imageSignature!==card.imageSignature||!card.imageSources||node.images.some((item,index)=>item.imageDataUrl!==card.imageSources[index]?.data);
    if(imagesChanged){card.imageSignature=imageSignature;card.imageSources=node.images.map(item=>({id:item.id,data:item.imageDataUrl}));card.images.replaceChildren();for(const source of node.images){const figure=window.RabbitDocuments.createTile({id:source.id,name:source.title,mimeType:'image/png',dataUrl:source.imageDataUrl},{...(card.mode==='focus'&&node.kind==='source'?{onRemove:()=>safe(()=>removeSourceAsset(card,'remove-node-image',source.id)),removeDisabled:card.removingAssets.has(`remove-node-image:${source.id}`)}:{})});figure.classList.add('rg-image');figure.dataset.imageId=source.id;const img=figure.querySelector('img');if(img){img.draggable=false;img.addEventListener('load',()=>paintAnnotations(card));if(card.mode==='focus')figure.addEventListener('pointerdown',event=>{if(!event.target.closest('button'))startImageSelection(event,card,source.id,img);});}card.images.append(figure);}}
    const documentSignature=JSON.stringify((node.attachments||[]).map(item=>[item.id,item.name,item.format,card.removingAssets.has(`remove-node-attachment:${item.id}`)]));
    if(documentSignature!==card.documentSignature){card.documentSignature=documentSignature;card.documents.replaceChildren();for(const attachment of node.attachments||[])card.documents.append(window.RabbitDocuments.createTile(attachment,{...(card.mode==='focus'?{onRemove:()=>safe(()=>removeSourceAsset(card,'remove-node-attachment',attachment.id)),removeDisabled:card.removingAssets.has(`remove-node-attachment:${attachment.id}`)}:{})}));}
    renderCardBody(card,node,markdown,streaming);updateCardProgress(card,node);
    const actions=`${node.status}/${!!node.candidate}/${card.preview}`;
    if(card.actionSignature!==actions){card.actionSignature=actions;card.stateActions.replaceChildren();
      if(busy(node)){if(card.mode!=='pin')card.stateActions.append(button('stop','停止生成',()=>bridge.graphCancel({workspaceId:state.workspace.id,graphId:card.graphId,nodeId:node.id})));}
      else if(node.status==='error'||node.status==='cancelled'){if(card.mode!=='pin')card.stateActions.append(button('refresh','重试生成',()=>safe(()=>bridge.graphRegenerate({workspaceId:state.workspace.id,graphId:card.graphId,nodeId:node.id}))));}
      else if(node.candidate&&card.mode!=='pin')card.stateActions.append(button('document',card.preview?'返回原卡片':'查看新版本',()=>{card.preview=!card.preview;updateCard(card,nodeById(node.id,card.graphId));}),button('check','采用新版本',()=>safe(()=>mutate({type:'accept-candidate',graphId:card.graphId,nodeId:node.id}))));
    }
    requestAnimationFrame(()=>paintAnnotations(card));
  }
  async function generateAnnotations(node,graphId,workspaceId=state.workspace.id) {
    if(!node||busy(node))return;
    const card=focusCard?.workspaceId===workspaceId&&focusCard.nodeId===node.id&&focusCard.graphId===graphId?focusCard:null;
    if(card?.generating)return;if(card)card.generating=true;
    try{
      if(card){await card.latestRemovalTask;await saveSourceText(card);node=card.lastNode;}
      if(!node)return;
      const ids=node.annotations.filter(item=>!item.childId).map(item=>item.id),question=node.kind==='source'?(card?.sourceInput?card.sourceInput.value:node.markdown).trim():'';
      if(!ids.length&&!question)return;
      if(state.open&&state.workspace?.id===workspaceId&&state.graphId===graphId&&state.focusId===node.id&&(!card||focusCard===card))await closeFocus();
      await bridge.graphGenerate({workspaceId,graphId,nodeId:node.id,...(ids.length?{annotationIds:ids}:{question})});
    }finally{if(card)card.generating=false;}
  }
  async function deleteNode(node,graphId) { if(!node)return;const workspaceId=state.workspace.id;await mutate({type:'delete',graphId,nodeId:node.id},workspaceId);notify('已删除卡片及其分支',()=>safe(()=>mutate({type:'undo'},workspaceId)),'撤销'); }
  function visibleNode(node,current) { if(!state.open||current.id!==state.graphId)return false;const point=position(node,current),bounds=root.getBoundingClientRect(),left=bounds.left+state.view.x+point.x*state.view.zoom,top=bounds.top+state.view.y+point.y*state.view.zoom;return intersects({left,top,right:left+state.width*state.view.zoom,bottom:top+point.height*state.view.zoom},bounds); }
  function pinBoxes(entry) { return[entry.card.element,entry.card.title,entry.card.pin].filter(element=>!element.hidden).map(element=>element.getBoundingClientRect()); }
  function beginPinInteraction(event,card) {
    if(![0,2].includes(event.button)||pinPress||card.element.parentElement?.inert)return;
    const press={card,pointerId:event.pointerId,native:!state.open};pinPress=press;
    // 按住正文期间固定当前预览位置，避免入场动画把文字从选区起点移走。
    if(event.target.closest('.rg-body,.rg-status')){const top=getComputedStyle(card.element).top;card.element.style.top=top;card.element.classList.add('is-reading-press');}
    if(!event.target.closest('button,a,input,textarea'))card.element.focus({preventScroll:true});
    if(press.native&&bridge?.graphPinInteraction)safe(async()=>{const accepted=await bridge.graphPinInteraction({phase:'down',point:{x:event.clientX,y:event.clientY}});if(!accepted&&pinPress===press)endPinInteraction();});
  }
  function endPinInteraction(event) {
    if(!pinPress||event&&event.pointerId!==pinPress.pointerId)return;const press=pinPress;pinPress=null;
    press.card.element.classList.remove('is-reading-press');press.card.element.style.removeProperty('top');
    if(press.native&&bridge?.graphPinInteraction)safe(()=>bridge.graphPinInteraction({phase:'up',point:{x:event?.clientX??0,y:event?.clientY??0}}));
  }
  window.addEventListener('pointerup',endPinInteraction,true);window.addEventListener('pointercancel',endPinInteraction,true);window.addEventListener('pagehide',()=>endPinInteraction());
  window.addEventListener('blur',()=>{endPinInteraction();if(!state.open)for(const entry of pinCards.values()){entry.card.element.blur?.();entry.card.pin.blur?.();entry.card.title.blur?.();setPinReveal(entry,false);}});
  function reportPinRegions() {
    if(graphSurface)return;
    const clip=pinWindow.getBoundingClientRect(),rects=[];
    if(pluginEnabled&&(state.open||!pinPanels.size)){
      for(const entry of pinCards.values())if(!entry.departing)for(const box of pinBoxes(entry)){const left=Math.max(clip.left,box.left,0),top=Math.max(clip.top,box.top,0),right=Math.min(clip.right,box.right,window.innerWidth),bottom=Math.min(clip.bottom,box.bottom,window.innerHeight);if(right>left&&bottom>top)rects.push({x:left,y:top,width:right-left,height:bottom-top});}
      if(state.toast){const box=state.toast.getBoundingClientRect();rects.push({x:box.left,y:box.top,width:box.width,height:box.height});}
    }
    const signature=JSON.stringify(rects);if(signature!==pinRegionsSignature){pinRegionsSignature=signature;bridge?.setGraphPinRegions?.({rects});}
  }
  function trackPinRegions() { const until=Date.now()+450;cancelAnimationFrame(pinFrame);const track=()=>{reportPinRegions();if(Date.now()<until)pinFrame=requestAnimationFrame(track);};pinFrame=requestAnimationFrame(track); }
  function revealPin(entry,reveal) { if(entry.departing)return;if(reveal){clearTimeout(entry.timer);entry.timer=null;setPinReveal(entry,true);}else if(entry.holder.classList.contains('is-revealed')&&!entry.timer){entry.timer=setTimeout(()=>{entry.timer=null;if(!entry.holder.contains(document.activeElement))setPinReveal(entry,false);},160);} }
  function hoverPin(entry,point) {
    if(entry.departing||pinPress?.card===entry.card)return;
    const clip=pinWindow.getBoundingClientRect(),contains=box=>point.x>=Math.max(box.left,clip.left)&&point.x<=Math.min(box.right,clip.right)&&point.y>=Math.max(box.top,clip.top)&&point.y<=Math.min(box.bottom,clip.bottom);
    // 取消固定是独立热区；悬停或聚焦它时保留当前牌面位置，避免按钮逃离鼠标。
    if(contains(entry.card.pin.getBoundingClientRect())){clearTimeout(entry.timer);entry.timer=null;return;}
    revealPin(entry,pinBoxes(entry).some(contains));
  }
  function setPinReveal(entry,reveal) { if(entry.departing)return;if(entry.holder.classList.contains('is-revealed')===reveal)return;entry.holder.classList.toggle('is-revealed',reveal);trackPinRegions(); }
  async function activatePin(graphId,nodeId) {
    if(!nodeById(nodeId,graphId)?.pinned)return;if(state.open){visitGraph(graphId,nodeId);return;}
    const target={workspaceId:state.workspace.id,graphId,nodeId,epoch:state.epoch};pendingPin=target;
    const isCurrent=()=>pendingPin===target&&state.epoch===target.epoch&&!state.open&&pluginEnabled&&state.workspace?.id===target.workspaceId&&nodeById(nodeId,graphId)?.pinned;
    try{
      await bridge.graphOpen(target.workspaceId);if(!isCurrent())return;
      await mutate({type:'visit',graphId},target.workspaceId);if(!isCurrent())return;
      target.activating=true;await bridge.graphActivate(bridge.surface==='pet'?{workspaceId:target.workspaceId,graphId,nodeId}:undefined);if(bridge.surface==='pet'&&pendingPin===target)pendingPin=null;
    }catch(error){if(pendingPin===target)pendingPin=null;throw error;}
    finally{if(pendingPin===target&&!target.activating)pendingPin=null;}
  }
  function removePinEntry(id,entry) {
    if(pinPress?.card===entry.card)endPinInteraction();
    entry.departing=null;clearTimeout(entry.timer);activeAnimations.get(entry.holder)?.cancel();entry.holder.remove();pinCards.delete(id);
  }
  function renderPins() {
    if(graphSurface)return;
    for(const [id,entry] of pinCards)if(entry.workspaceId!==state.workspace?.id)removePinEntry(id,entry);
    const desired=new Set();let maxHeight=0;
    if(!state.open&&pluginEnabled&&!pinPanels.size&&state.workspace?.graphs.some(item=>item.nodes.some(node=>node.pinned))){root.classList.add('has-pins');dimensions();}
    if(pluginEnabled&&(state.open||!pinPanels.size))for(const item of state.workspace?.graphs||[])for(const node of item.nodes.filter(value=>value.pinned&&!visibleNode(value,item))){const id=key(item.id,node.id);desired.add(id);let entry=pinCards.get(id),created=false;if(!entry){const holder=el('div','rg-pin'),card=createCard(node,item.id,'pin');holder.append(card.element);entry={holder,card,timer:null,workspaceId:state.workspace.id,departing:null};const hover=event=>hoverPin(entry,{x:event.clientX,y:event.clientY});holder.addEventListener('pointerenter',hover);holder.addEventListener('pointermove',hover);holder.addEventListener('pointerleave',()=>revealPin(entry,false));holder.addEventListener('focusin',event=>{clearTimeout(entry.timer);entry.timer=null;if(event.target!==card.pin)revealPin(entry,true);});holder.addEventListener('focusout',()=>revealPin(entry,false));pinCards.set(id,entry);pins.append(holder);arrive(holder);created=true;}if(entry.departing){entry.departing=null;activeAnimations.get(entry.holder)?.cancel();entry.holder.inert=false;entry.holder.style.removeProperty('pointer-events');entry.holder.removeAttribute('aria-hidden');entry.card.pin.disabled=false;}const height=cardHeight(node,state.width);entry.holder.style.setProperty('--rg-pin-height',`${height}px`);maxHeight=Math.max(maxHeight,height);updateCard(entry.card,node);if(created)motion(entry.card.title,[{transform:`translate(-50%,calc(50% - ${Math.max(0,height-62)}px))`},{transform:'translate(-50%,50%)'}],420);}
    for(const [id,entry] of pinCards)if(!desired.has(id)){
      if(pinPress?.card===entry.card)endPinInteraction();clearTimeout(entry.timer);entry.timer=null;
      const node=nodeById(entry.card.nodeId,entry.card.graphId);
      if(state.open||!pluginEnabled||pinPanels.size||!node||node.pinned){removePinEntry(id,entry);continue;}
      maxHeight=Math.max(maxHeight,cardHeight(node,state.width));
      if(!entry.departing){
        const leaving={};entry.departing=leaving;entry.holder.inert=true;entry.holder.style.pointerEvents='none';entry.holder.setAttribute('aria-hidden','true');entry.card.pin.disabled=true;
        // 离场期间保留牌面和布局占位，等动画结束再移除牌面。
        motion(entry.holder,[{opacity:1,transform:'translateY(0)'},{opacity:0,transform:'translateY(7px)'}],180).then(()=>{if(entry.departing!==leaving)return;removePinEntry(id,entry);renderPins();});
        trackPinRegions();
      }
    }
    root.classList.toggle('has-pins',pinCards.size>0);root.style.setProperty('--rg-pin-max-height',`${maxHeight}px`);clampPins();reportPinRegions();if(activeAnimations.has(pins.lastElementChild))trackPinRegions();
  }
  function clampPins() { state.pinOffset=clamp(state.pinOffset,0,Math.max(0,pins.scrollWidth-pinWindow.clientWidth));pins.style.transform=`translateX(${-state.pinOffset}px)`; }
  pinWindow.addEventListener('wheel',event=>{if(event.target.closest('.rg-card-scroll')&&event.target.closest('.is-revealed'))return;event.preventDefault();state.pinOffset+=event.deltaY||event.deltaX;clampPins();reportPinRegions();},{passive:false});
  function focusGeometry() { const bounds=root.getBoundingClientRect(),node=nodeById(state.focusId),maxHeight=bounds.height*.85;let width=bounds.width*.86;if(node.kind==='source'&&!node.images.length&&node.attachments?.length){width=Math.min(width,640);const height=Math.min(maxHeight,Math.max(340,cardHeight(node,width)));return{width,height,left:(bounds.width-width)/2,top:(bounds.height-height)/2};}if(cardHeight(node,width)>maxHeight){let low=0,high=width;for(let i=0;i<20;i++){const mid=(low+high)/2;if(cardHeight(node,mid)>maxHeight)high=mid;else low=mid;}width=low;}const height=cardHeight(node,width);return{width,height,left:(bounds.width-width)/2,top:(bounds.height-height)/2}; }
  function setFocusGeometry(card,geometry) { for(const property of ['left','top','width','height'])card.element.style[property]=`${geometry[property]}px`;const node=nodeById(card.nodeId,card.graphId);if(node)updateCard(card,node); }
  function cancelFocusMotion(card) {
    const pending=card.focusMotion;if(!pending)return;card.focusMotion=null;cancelAnimationFrame(pending.frame);
    for(const element of pending.elements)activeAnimations.get(element)?.cancel();
  }
  function focusVisualScale(card) { const pending=card.focusMotion;if(!pending)return 1;const progress=activeAnimations.get(card.element)?.effect?.getComputedTiming().progress??0;return pending.fromScale+(pending.toScale-pending.fromScale)*progress; }
  function focusTransition(card,frames,fromScale,toScale,duration) {
    cancelFocusMotion(card);const pending={frame:null,elements:[],fromScale,toScale};card.focusMotion=pending;const scales=[fromScale,toScale],top=card.title.hidden?9:(card.title.offsetHeight||34)/2+8;
    const animate=(element,keyframes)=>{pending.elements.push(element);return motion(element,keyframes,duration);};
    const moving=[animate(card.element,frames.map((frame,index)=>({...frame,borderRadius:`${22*scales[index]}px`,borderWidth:`${2*scales[index]}px`,paddingTop:`${top*scales[index]}px`,paddingRight:`${9*scales[index]}px`,paddingBottom:`${14*scales[index]}px`,paddingLeft:`${9*scales[index]}px`}))),animate(card.scroll,scales.map(scale=>({marginLeft:`${4*scale}px`,marginRight:`${4*scale}px`})) )];
    for(const element of [card.content,card.text])moving.push(animate(element,scales.map(scale=>({fontSize:`${15*scale}px`,lineHeight:`${27*scale}px`}))));
    for(const element of card.text.querySelectorAll('h1,h2,h3'))moving.push(animate(element,scales.map(scale=>({fontSize:`${16*scale}px`,lineHeight:`${24.8*scale}px`}))));
    moving.push(animate(card.status,scales.map(scale=>({fontSize:`${12*scale}px`,lineHeight:`${19.2*scale}px`}))));
    if(!card.title.hidden){moving.push(animate(card.title,scales.map(scale=>({transform:`translate(-50%,-50%) scale(${scale})`}))));moving.push(animate(card.pin,scales.map(scale=>({left:`calc(50% + ${card.title.offsetWidth*scale/2+6}px)`}))));}
    // 胶囊和牌面共用时间轴；选区跟随这一张卡片的实际中间布局。
    const start=document.timeline?.currentTime;for(const element of pending.elements){const animation=activeAnimations.get(element);if(animation&&typeof start==='number')animation.startTime=start;}
    const repaint=()=>{if(card.focusMotion!==pending||!card.element.isConnected)return;card.scroll.scrollTop=(card.focusScroll||0)*focusVisualScale(card);paintAnnotations(card);pending.frame=requestAnimationFrame(repaint);};repaint();
    return Promise.all(moving).then(()=>{if(card.focusMotion!==pending)return false;card.focusMotion=null;cancelAnimationFrame(pending.frame);card.scroll.scrollTop=(card.focusScroll||0)*toScale;paintAnnotations(card);return true;});
  }
  function openFocus(id) {
    if(state.focusId===id)return;closeFocus(false,false);const node=nodeById(id);if(!node)return;selected(id);state.focusId=id;rememberView(id);focusCard=createCard(node,state.graphId,'focus');updateCard(focusCard,node);focusLayer.classList.add('is-open');focusLayer.append(focusCard.element);
    const sourceCard=cards.get(id),source=sourceCard?.element,origin=source?.getBoundingClientRect(),bounds=root.getBoundingClientRect(),geometry=focusGeometry(),card=focusCard;card.originElement=source;card.focusScroll=sourceCard?.scroll.scrollTop||0;source?.classList.add('is-focus-origin');setFocusGeometry(card,geometry);
    const ready=()=>{if(focusCard!==card)return;card.element.inert=false;if(card.addFiles&&!document.activeElement?.closest('input,textarea,select,[contenteditable="true"]'))focusSourceInput(card);};
    if(origin){card.element.inert=true;focusTransition(card,[{left:`${origin.left-bounds.left}px`,top:`${origin.top-bounds.top}px`,width:`${origin.width}px`,height:`${origin.height}px`},{left:`${geometry.left}px`,top:`${geometry.top}px`,width:`${geometry.width}px`,height:`${geometry.height}px`}],origin.width/state.width,1,400).then(completed=>{if(completed)ready();});}else ready();
  }
  function closeFocus(animate=true,remember=true) { closeNote();const old=focusCard,target=old?.originElement?.getBoundingClientRect();state.focusId=null;if(remember)rememberView(null);focusCard=null;focusLayer.classList.remove('is-open');if(old){old.element.style.pointerEvents='none';old.element.inert=true;const finish=()=>{old.element.remove();if(focusCard?.originElement!==old.originElement)old.originElement?.classList.remove('is-focus-origin');},from=old.element.getBoundingClientRect(),bounds=root.getBoundingClientRect(),titleScale=focusVisualScale(old);old.focusScroll=old.scroll.scrollTop/titleScale;const sourceCard=cards.get(old.nodeId);if(sourceCard?.element===old.originElement)sourceCard.scroll.scrollTop=old.focusScroll;if(animate&&target&&state.open)return focusTransition(old,[{left:`${from.left-bounds.left}px`,top:`${from.top-bounds.top}px`,width:`${from.width}px`,height:`${from.height}px`},{left:`${target.left-bounds.left}px`,top:`${target.top-bounds.top}px`,width:`${target.width}px`,height:`${target.height}px`}],titleScale,target.width/state.width,320).then(completed=>{if(completed)finish();});else{cancelFocusMotion(old);activeAnimations.get(old.element)?.cancel();finish();}} }
  focusLayer.addEventListener('click',event=>{if(event.target===focusLayer&&clickFrom(event,focusLayer,true))closeFocus();});
  // 选区按正文与完整公式建立语义偏移，覆盖层不参与后续文本定位。
  function captureTextSelection(card) {
    if(card!==focusCard||!card.element.isConnected)return;
    const node=nodeById(card.nodeId,card.graphId),selection=window.getSelection();if(!node||busy(node)||card.preview||!selection||selection.isCollapsed||!selection.rangeCount)return;
    const range=selection.getRangeAt(0);if(!card.text.contains(range.commonAncestorContainer))return;
    const captured=window.RabbitGraphSelection.capture(card.text,range);if(!captured)return;
    openNote(card,captured.selection,captured.anchor);selection.removeAllRanges();
  }
  function startImageSelection(event,card,imageId,img) {
    if(event.button!==0||event.isPrimary===false||card.imageSelection||state.drag||event.target.closest('button'))return;const node=nodeById(card.nodeId,card.graphId);if(!node||busy(node)||card.preview)return;
    event.preventDefault();event.stopPropagation();const start={x:event.clientX,y:event.clientY},bounds=img.getBoundingClientRect();let last=start,active=true;
    const current=()=>state.open&&focusCard===card&&card.element.isConnected;
    const move=pointer=>{if(pointer.pointerId!==event.pointerId||!active)return;if(!current()){cancel();return;}last={x:pointer.clientX,y:pointer.clientY};paintAnnotations(card,{kind:'image',imageId,rect:normalizedRect(start,last,bounds)});};
    const cleanup=()=>{if(!active)return false;active=false;card.imageSelection=null;img.removeEventListener('pointermove',move);img.removeEventListener('pointerup',end);img.removeEventListener('pointercancel',cancel);img.removeEventListener('lostpointercapture',cancel);window.removeEventListener('blur',cancel);document.removeEventListener('graph:contextchange',cancel);if(img.hasPointerCapture(event.pointerId))img.releasePointerCapture(event.pointerId);return true;};
    const end=pointer=>{if(pointer.pointerId!==event.pointerId||!cleanup())return;last={x:pointer.clientX,y:pointer.clientY};const rect=normalizedRect(start,last,bounds);if(current()&&rect.width*bounds.width>5&&rect.height*bounds.height>5){card.suppressClickUntil=Date.now()+300;openNote(card,{kind:'image',imageId,rect},{left:Math.min(start.x,last.x),right:Math.max(start.x,last.x),top:Math.min(start.y,last.y),bottom:Math.max(start.y,last.y)});}else paintAnnotations(card);};
    const cancel=pointer=>{if(pointer?.pointerId!==undefined&&pointer.pointerId!==event.pointerId||!cleanup())return;card.marks.replaceChildren();paintAnnotations(card);};card.imageSelection=cancel;img.addEventListener('pointermove',move);img.addEventListener('pointerup',end);img.addEventListener('pointercancel',cancel);img.addEventListener('lostpointercapture',cancel);window.addEventListener('blur',cancel);document.addEventListener('graph:contextchange',cancel);img.setPointerCapture(event.pointerId);
  }
  function selectionRects(card,selection) {
    if(selection.kind==='image'){const img=Array.from(card.images.querySelectorAll('.rg-image')).find(item=>item.dataset.imageId===selection.imageId)?.querySelector('img');if(!img)return[];const box=img.getBoundingClientRect(),rect=selection.rect;return[{left:box.left+rect.x*box.width,top:box.top+rect.y*box.height,width:rect.width*box.width,height:rect.height*box.height}];}
    return window.RabbitGraphSelection.rects(card.text,selection);
  }
  function paintAnnotations(card,temporary) {
    if(!card.element.isConnected)return;const node=nodeById(card.nodeId,card.graphId);if(!node)return;card.marks.replaceChildren();const bounds=card.content.getBoundingClientRect(),scale=bounds.width/card.content.offsetWidth||1;
    const annotations=node.annotations.map((item,index)=>({...item,index}));const draft=temporary||state.note?.card===card&&state.note.selection;if(draft)annotations.push({selection:draft,index:-1});
    for(const annotation of annotations){const rects=selectionRects(card,annotation.selection);for(const rect of rects){const mark=el('span','rg-mark'+(annotation.selection.kind==='image'?' image':''));Object.assign(mark.style,{left:`${(rect.left-bounds.left)/scale}px`,top:`${(rect.top-bounds.top)/scale}px`,width:`${rect.width/scale}px`,height:`${rect.height/scale}px`});card.marks.append(mark);}if(rects.length&&annotation.index>=0){const rect=rects[0],number=el('button','rg-note-number',String(annotation.index+1));number.title=annotation.comment;number.setAttribute('aria-label',`批注 ${annotation.index+1}：${annotation.comment}`);number.style.left=`${clamp((rect.left-bounds.left)/scale-3,0,card.content.offsetWidth-18)}px`;number.style.top=`${Math.max(0,(rect.top-bounds.top)/scale-8)}px`;number.onclick=event=>{event.stopPropagation();if(card.mode==='pin')safe(()=>activatePin(card.graphId,card.nodeId));else if(card.mode==='world')openFocus(card.nodeId);else openNote(card,annotation.selection,number.getBoundingClientRect(),annotation);};card.marks.append(number);}}
  }
  function openNote(card,selection,anchor,existing) {
    closeNote();const node=nodeById(card.nodeId,card.graphId);if(!node)return;const editor=el('form','rg-note-editor'),input=el('textarea'),attachments=el('div','rg-note-attachments');input.rows=1;input.placeholder='填写批注或附加截图…';input.setAttribute('aria-label','批注');input.value=existing?.comment||'';const confirm=button('check','保存批注',()=>safe(save),'rg-action rg-confirm'),camera=button('camera','截图附加到批注',()=>safe(captureImages));editor.append(input,camera,confirm,attachments);root.append(editor);
    const note={editor,input,card,nodeId:card.nodeId,graphId:card.graphId,workspaceId:state.workspace.id,selection,images:[...(existing?.images||[])],revision:node.contentRevision,id:existing?.id||uid(),childId:existing?.childId};state.note=note;paintAnnotations(card);if(existing)editor.insertBefore(button('trash','删除批注',()=>safe(async()=>{await mutate({type:'remove-annotation',graphId:note.graphId,nodeId:note.nodeId,annotationId:note.id},note.workspaceId);if(state.note===note)closeNote();})),confirm);arrive(editor);
    function placeEditor(){const selectedRect=selectionRects(card,selection)[0],near=selectedRect?{left:selectedRect.left,top:selectedRect.top,bottom:selectedRect.top+selectedRect.height}:anchor,bounds=root.getBoundingClientRect(),box=editor.getBoundingClientRect(),below=(near.bottom||near.top)-bounds.top+9;editor.style.left=`${clamp(near.left-bounds.left,10,Math.max(10,bounds.width-box.width-10))}px`;editor.style.top=`${clamp(below+box.height<=bounds.height-10?below:near.top-bounds.top-box.height-9,10,Math.max(10,bounds.height-box.height-10))}px`;}
    note.reposition=placeEditor;
    const hasContent=()=>!!input.value.trim()||note.images.length>0;
    const syncConfirm=()=>{confirm.disabled=camera.disabled||!hasContent();};input.addEventListener('input',()=>{syncConfirm();placeEditor();});
    function showImages(){attachments.replaceChildren();for(const source of note.images){const frame=el('div','rg-note-attachment'),img=el('img');img.src=source.imageDataUrl;img.alt=source.title;frame.append(img,button('close','移除附加截图',()=>{note.images=note.images.filter(item=>item.id!==source.id);showImages();}));attachments.append(frame);}syncConfirm();placeEditor();}
    async function captureImages(){
      if(camera.disabled)return;camera.disabled=true;syncConfirm();
      try{await captureInto({workspaceId:note.workspaceId,graphId:note.graphId,nodeId:note.nodeId},images=>{if(state.note===note){note.images.push(...images);showImages();}});}
      finally{camera.disabled=false;syncConfirm();if(state.note===note){placeEditor();input.focus({preventScroll:true});}}
    }
    function save(){
      if(state.note!==note||camera.disabled||!hasContent())return;
      const current=nodeById(note.nodeId,note.graphId);
      if(!current||current.contentRevision!==note.revision){notify('卡片内容已变化，请重新选择需要批注的内容');return;}
      // 外部按下后可能立即切图；先固定草稿及归属，异步完成不再操作新的编辑器或选区。
      const mutation={type:'annotation',graphId:note.graphId,nodeId:note.nodeId,annotation:structuredClone({id:note.id,selection:note.selection,comment:input.value.trim(),images:note.images,...(note.childId?{childId:note.childId}:{})})};
      closeNote();window.getSelection()?.removeAllRanges();
      const writeKey=`${note.workspaceId}/${note.id}`,write={pending:false,failed:false,retry:persist};
      noteWrites.set(writeKey,write);
      async function persist(){
        if(noteWrites.get(writeKey)!==write||write.pending)return;
        write.pending=true;write.failed=false;
        try{const saved=await mutate(mutation,note.workspaceId);if(noteWrites.get(writeKey)===write)noteWrites.delete(writeKey);if(state.toast?.dataset.noteFailures&&!Array.from(noteWrites.values()).some(item=>item.failed))notify('批注已保存');return saved;}
        catch(error){if(noteWrites.get(writeKey)===write){write.failed=true;notify(`批注保存失败：${error?.message||String(error)}`);}}
        finally{write.pending=false;}
      }
      return persist();
    }
    async function submit(){const saved=await save();if(saved&&!state.note&&state.open&&state.workspace?.id===note.workspaceId&&state.graphId===note.graphId&&focusCard===note.card&&!focusCard.generate.disabled)focusCard.generate.focus({preventScroll:true});}
    note.save=save;
    showImages();
    editor.onsubmit=event=>{event.preventDefault();safe(submit);};editor.addEventListener('keydown',event=>{if(event.isComposing||event.keyCode===229)return;if(event.key==='Enter'&&event.target===input&&!event.shiftKey){event.preventDefault();event.stopPropagation();if(!event.repeat)safe(submit);}else if(event.key==='Escape'){event.stopPropagation();closeNote();}});input.focus({preventScroll:true});
  }
  function closeNote() { const old=state.note;state.note=null;if(old){depart(old.editor);paintAnnotations(old.card);} }
  let pointerPress=null;
  // 点击由按下位置和整段移动决定；拖选到牌面外不能变成遮罩点击。
  function clickFrom(event,surface,exact=false) {
    if(event.detail===0)return true;
    return !!pointerPress&&!pointerPress.moved&&!pointerPress.cancelled&&(exact?pointerPress.target===surface:surface.contains(pointerPress.target))&&Math.hypot(event.clientX-pointerPress.x,event.clientY-pointerPress.y)<=8;
  }
  function clearGraphSelection() { const selection=window.getSelection();if(selection?.anchorNode&&root.contains(selection.anchorNode))selection.removeAllRanges(); }
  root.addEventListener('pointerdown',event=>{
    if(event.button===0){pointerPress={id:event.pointerId,target:event.target,x:event.clientX,y:event.clientY,moved:false,cancelled:false};cancelViewMotion();}
  },true);
  document.addEventListener('pointerdown',event=>{
    if(state.note&&!root.classList.contains('capture-suspended')&&!state.note.editor.contains(event.target)){
      if(state.note.input.value.trim()||state.note.images.length)state.note.save();else closeNote();
    }
  },true);
  root.addEventListener('pointermove',event=>{if(pointerPress?.id===event.pointerId&&Math.hypot(event.clientX-pointerPress.x,event.clientY-pointerPress.y)>8)pointerPress.moved=true;},true);
  root.addEventListener('pointercancel',event=>{if(pointerPress?.id===event.pointerId)pointerPress.cancelled=true;},true);
  function descendants(current,id) { const result=new Set([id]);let changed=true;while(changed){changed=false;for(const node of current.nodes)if(result.has(node.parentId)&&!result.has(node.id)){result.add(node.id);changed=true;}}return result; }
  function canReparent(current,nodeId,parentId) { return !!current&&!!parentId&&current.nodes.some(node=>node.id===nodeId)&&current.nodes.some(node=>node.id===parentId)&&nodeId!==current.rootId&&!descendants(current,nodeId).has(parentId); }
  async function reparentNode(nodeId,parentId) { await mutate({type:'reparent',graphId:state.graphId,nodeId,parentId}); }
  async function moveToGraph(graphId,nodeId,targetGraphId,targetNodeId) { if(graphId===targetGraphId||!nodeById(nodeId,graphId)||!state.workspace.graphs.some(item=>item.id===targetGraphId))return;const workspaceId=state.workspace.id,epoch=state.epoch,workspace=await mutate({type:'move-subtree',graphId,nodeId,targetGraphId,...(targetNodeId?{targetNodeId}:{})},workspaceId);if(state.open&&state.epoch===epoch&&state.workspace.id===workspaceId){visitGraph(targetGraphId,nodeId);} }
  function previewGraph(id) { if(id===state.graphId)return;const direction=graphDirection(id);cancelViewMotion();rememberView();closeFocus(false,false);state.graphId=id;state.selectedId=null;cards.forEach(card=>card.element.remove());cards.clear();const initial=graph()&&!graph().layoutInitialized&&!readViewState();render(true);graphTransition(direction,initial,false);announceContext(); }
  function beginCardDrag(event,card) {
    if(event.pointerType==='touch'||event.button!==0||event.isPrimary===false||state.drag||event.target.closest('a,input,textarea,select')||event.target.closest('button')&&!event.target.closest('.rg-title'))return;
    event.preventDefault();
    const cleanup=()=>{document.removeEventListener('pointermove',move);document.removeEventListener('pointerup',end);document.removeEventListener('pointercancel',end);window.removeEventListener('blur',cleanup);};
    const end=pointer=>{if(pointer.pointerId===event.pointerId)cleanup();};
    const move=pointer=>{
      if(pointer.pointerId!==event.pointerId)return;
      if(!state.open||state.drag||!card.element.isConnected||state.graphId!==card.graphId){cleanup();return;}
      if(Math.hypot(pointer.clientX-event.clientX,pointer.clientY-event.clientY)<=6)return;
      cleanup();if(pointerPress)pointerPress.moved=true;clearGraphSelection();startReparent(event,card,pointer);
    };
    // 轻微抖动仍算单击；确认拖动后才创建浮动卡片并接管指针。
    document.addEventListener('pointermove',move);document.addEventListener('pointerup',end);document.addEventListener('pointercancel',end);window.addEventListener('blur',cleanup);
  }
  function startReparent(event,card,firstMove) {
    if(event.button!==0||event.isPrimary===false||state.drag)return;event.preventDefault();event.stopPropagation();closeNote();
    const workspaceId=state.workspace.id,source=nodeById(card.nodeId,card.graphId),bounds=card.element.getBoundingClientRect(),rootBounds=root.getBoundingClientRect(),ghost=createCard(source,card.graphId,'drag'),originalView={...state.view};updateCard(ghost,source);ghost.element.classList.add('rg-drag-ghost');Object.assign(ghost.element.style,{left:`${bounds.left-rootBounds.left}px`,top:`${bounds.top-rootBounds.top}px`,width:`${bounds.width}px`,height:`${bounds.height}px`});root.append(ghost.element);card.element.classList.add('is-drag-source');root.setPointerCapture(event.pointerId);
    const drag={nodeId:card.nodeId,graphId:card.graphId,ghost,originalView,point:{x:bounds.left-rootBounds.left,y:bounds.top-rootBounds.top},target:{x:bounds.left-rootBounds.left,y:bounds.top-rootBounds.top},targetId:null,targetGraphId:null,hoverId:null,hoverTimer:null,frame:null,cancel:null};state.drag=drag;const oldEdge=Array.from(edges.children).find(path=>path.dataset.nodeId===card.nodeId);if(oldEdge){oldEdge.style.opacity='0';motion(oldEdge,[{opacity:1},{opacity:0}],140);}
    const tick=()=>{const amount=reducedMotion?1:.28;drag.point.x+=(drag.target.x-drag.point.x)*amount;drag.point.y+=(drag.target.y-drag.point.y)*amount;ghost.element.style.left=`${drag.point.x}px`;ghost.element.style.top=`${drag.point.y}px`;drag.frame=requestAnimationFrame(tick);};drag.frame=requestAnimationFrame(tick);
    const clear=()=>{cards.forEach(item=>item.element.classList.remove('is-target'));for(const item of thumbs.children)item.classList.remove('is-target');};
    const validTarget=id=>graph()?.nodes.some(node=>node.id===id);
    let active=true;
    const move=pointer=>{if(pointer.pointerId!==event.pointerId||!active)return;drag.target={x:pointer.clientX-rootBounds.left-(event.clientX-bounds.left),y:pointer.clientY-rootBounds.top-(event.clientY-bounds.top)};clear();const hovered=document.elementFromPoint(pointer.clientX,pointer.clientY),thumb=hovered?.closest('.rg-thumb'),target=hovered?.closest('.rg-world .rg-card');drag.targetGraphId=thumb?.dataset.graphId||null;drag.targetId=target?.dataset.nodeId||null;if(drag.hoverId!==drag.targetGraphId){clearTimeout(drag.hoverTimer);drag.hoverId=drag.targetGraphId;if(drag.hoverId&&drag.hoverId!==state.graphId)drag.hoverTimer=setTimeout(()=>{if(state.drag===drag)previewGraph(drag.hoverId);},450);}if(drag.targetGraphId&&drag.targetGraphId!==drag.graphId)thumb.classList.add('is-target');else if(drag.targetId&&(state.graphId===drag.graphId?canReparent(graph(),drag.nodeId,drag.targetId):validTarget(drag.targetId)))cards.get(drag.targetId)?.element.classList.add('is-target');};
    const cleanup=()=>{if(!active)return false;active=false;clearTimeout(drag.hoverTimer);cancelAnimationFrame(drag.frame);root.removeEventListener('pointermove',move);root.removeEventListener('pointerup',end);root.removeEventListener('pointercancel',cancel);root.removeEventListener('lostpointercapture',cancel);window.removeEventListener('blur',cancel);if(root.hasPointerCapture(event.pointerId))root.releasePointerCapture(event.pointerId);clear();return true;};
    const removeGhost=()=>{activeAnimations.get(ghost.element)?.cancel();ghost.element.remove();card.element.classList.remove('is-drag-source');if(state.drag===drag)state.drag=null;};
    const ownsContext=()=>state.drag===drag&&state.open&&state.workspace?.id===workspaceId;
    const settle=async(success)=>{if(!ownsContext())return;if(!success&&state.workspace.graphs.some(item=>item.id===drag.graphId)){previewGraph(drag.graphId);setView(originalView);}const target=cards.get(drag.nodeId)?.element.getBoundingClientRect()||bounds,from=ghost.element.getBoundingClientRect();await motion(ghost.element,[{left:`${from.left-rootBounds.left}px`,top:`${from.top-rootBounds.top}px`,width:`${from.width}px`,height:`${from.height}px`,opacity:.9},{left:`${target.left-rootBounds.left}px`,top:`${target.top-rootBounds.top}px`,width:`${target.width}px`,height:`${target.height}px`,opacity:0}],320);if(!ownsContext())return;removeGhost();render();};
    const end=pointer=>{if(pointer.pointerId!==event.pointerId||!cleanup())return;let operation;if(drag.targetGraphId&&drag.targetGraphId!==drag.graphId)operation=()=>moveToGraph(drag.graphId,drag.nodeId,drag.targetGraphId);else if(drag.targetId&&state.graphId!==drag.graphId&&validTarget(drag.targetId))operation=()=>moveToGraph(drag.graphId,drag.nodeId,state.graphId,drag.targetId);else if(state.graphId===drag.graphId&&canReparent(graph(),drag.nodeId,drag.targetId))operation=()=>reparentNode(drag.nodeId,drag.targetId);safe(async()=>{try{if(operation){drag.committing=true;await operation();}await settle(!!operation);}catch(error){await settle(false);throw error;}});};
    const cancel=pointer=>{if(pointer?.pointerId!==undefined&&pointer.pointerId!==event.pointerId)return;if(pointer?.restore===false){cleanup();removeGhost();return;}if(cleanup())safe(()=>settle(false));};drag.cancel=cancel;root.addEventListener('pointermove',move);root.addEventListener('pointerup',end);root.addEventListener('pointercancel',cancel);root.addEventListener('lostpointercapture',cancel);window.addEventListener('blur',cancel);if(firstMove)move(firstMove);
  }
  function closeMenu() { depart(state.menu);state.menu=null; }
  function showMenu(anchor,items) {
    closeMenu();const menu=el('div','rg-menu');menu.setAttribute('role','menu');for(const item of items){if(!item){menu.append(el('hr'));continue;}const entry=el('button');entry.setAttribute('role','menuitem');if(item.icon)entry.append(icon(item.icon));entry.append(el('span','',item.label));entry.onclick=()=>{closeMenu();safe(item.action);};menu.append(entry);}root.append(menu);state.menu=menu;const box=anchor.getBoundingClientRect(),bounds=root.getBoundingClientRect();menu.style.left=`${clamp(box.left-bounds.left,10,bounds.width-menu.offsetWidth-10)}px`;menu.style.top=`${Math.min(bounds.height-menu.offsetHeight-10,box.bottom-bounds.top+7)}px`;arrive(menu);
  }
  folder.onclick=()=>showMenu(folder,[...state.workspaces.map(item=>({icon:'folder',label:item.name,action:()=>switchWorkspace(item.id)})),null,{icon:'plus',label:'新建工作区',action:()=>nameDialog('新建工作区','',async name=>{const workspace=await bridge.graphCreate(name);resetWorkspace(workspace);state.workspaces=await bridge.graphList();})},{icon:'edit',label:'重命名工作区',action:()=>nameDialog('重命名工作区',state.workspace.name,async name=>{await mutate({type:'rename-workspace',name});state.workspaces=await bridge.graphList();})}]);
  async function execute(action) {
    if(action==='undo'||action==='redo'){if(state.drag){state.drag.cancel?.();return;}closeNote();const workspaceId=state.workspace.id,result=await mutate({type:action},workspaceId);if(state.open&&state.workspace.id===workspaceId&&result.lastGraphId&&result.lastGraphId!==state.graphId)visitGraph(result.lastGraphId);return;}
    if(action==='rename-graph'&&graph()){const graphId=state.graphId;return nameDialog('重命名图谱',graph().title,title=>mutate({type:'rename-graph',graphId,title}));}
  }
  function dialog(title,className='') { closeDialog();const shade=el('div','rg-dialog-shade'),panel=el('section',`rg-dialog ${className}`);panel.setAttribute('role','dialog');panel.setAttribute('aria-modal','true');panel.setAttribute('aria-label',title);shade.append(panel);root.append(shade);state.dialog={shade,panel};shade.addEventListener('pointerdown',event=>{if(event.target===shade)closeDialog();});arrive(panel);return panel; }
  function closeDialog() { const previous=state.dialog;state.dialog=null;if(previous){previous.onClose?.();previous.shade.style.pointerEvents='none';depart(previous.panel)?.then(()=>previous.shade.remove());} }
  function textButton(text,handler) { const item=el('button','rg-text-button',text);item.type='button';item.onclick=()=>safe(handler);return item; }
  function nameDialog(title,initial,save) { const panel=dialog(title),input=el('input'),error=el('div','rg-dialog-error'),actions=el('div','rg-dialog-actions');input.value=initial;input.setAttribute('aria-label',title);const submit=textButton('保存',async()=>{if(!input.value.trim())return;submit.disabled=true;try{await save(input.value.trim());if(state.dialog?.panel===panel)closeDialog();}catch(problem){error.textContent=problem.message;submit.disabled=false;}});actions.append(textButton('取消',closeDialog),submit);panel.append(el('h2','',title),input,error,actions);input.onkeydown=event=>{if(event.key==='Enter')submit.click();};input.focus();input.select(); }
  function renderBackgroundSummary() {
    const draft=backgroundDrafts.get(state.workspace?.id),value=draft||state.workspace?.background;
    const pending=draft?.dirty||draft?.importing||draft?.saving;
    backgroundButton.classList.toggle('is-dirty',!!pending);
    backgroundSummary.textContent=draft?.saving?'正在保存…':draft?.importing?'正在读取…':draft?.dirty?'未保存，继续编辑':[value?.text?.trim()?'文字说明':'',value?.attachments?.length?`${value.attachments.length} 个附件`:''].filter(Boolean).join(' · ');
    backgroundSummary.hidden=!backgroundSummary.textContent;
  }
  function refreshBackgroundDraft(draft) {
    draft.dirty=draft.text!==draft.original.text||draft.attachments.length!==draft.original.attachments.length||draft.attachments.some((item,index)=>item.id!==draft.original.attachments[index]?.id);
    renderBackgroundSummary();
    if(state.dialog?.backgroundDraft===draft)state.dialog.refresh();
  }
  function showBackground() {
    if(!state.workspace)return;
    closeDialog();
    const workspaceId=state.workspace.id,workspaceName=state.workspace.name;
    let draft=backgroundDrafts.get(workspaceId);
    if(!draft){const original=structuredClone(state.workspace.background||{text:'',attachments:[]});draft={...structuredClone(original),original,dirty:false,importing:false,saving:false,error:''};backgroundDrafts.set(workspaceId,draft);}
    const panel=dialog('背景信息','rg-background-dialog'),input=el('textarea'),files=el('div','rg-background-files'),picker=el('input'),status=el('p','rg-background-status'),actions=el('div','rg-dialog-actions');
    input.value=draft.text;input.rows=3;input.placeholder='补充说明（可选），例如学习目标、已有知识…';input.setAttribute('aria-label','背景说明');
    picker.type='file';picker.multiple=true;picker.hidden=true;picker.setAttribute('aria-label','添加背景附件');
    status.setAttribute('role','status');status.setAttribute('aria-live','polite');
    const attach=button('plus','添加文件或图片',()=>picker.click(),'rg-background-attach');attach.append(el('span','','添加文件或图片'));
    const cancel=textButton('取消',()=>{if(draft.saving)return;backgroundDrafts.delete(workspaceId);if(state.dialog?.panel===panel)closeDialog();renderBackgroundSummary();});
    const submit=textButton('保存',async()=>{
      if(!draft.dirty||draft.saving||draft.importing)return;
      draft.saving=true;draft.error='';refreshBackgroundDraft(draft);
      try{
        await mutate({type:'set-background',background:{text:draft.text,attachments:structuredClone(draft.attachments)}},workspaceId);
        if(backgroundDrafts.get(workspaceId)===draft)backgroundDrafts.delete(workspaceId);
        if(state.dialog?.backgroundDraft===draft)closeDialog();
      }catch(error){draft.error=`保存失败：${error?.message||String(error)}`;}
      finally{draft.saving=false;refreshBackgroundDraft(draft);}
    });
    const refresh=()=>{
      input.disabled=draft.saving;attach.disabled=draft.importing||draft.saving;cancel.disabled=draft.saving;submit.disabled=!draft.dirty||draft.importing||draft.saving;submit.textContent=draft.saving?'保存中…':'保存';
      status.textContent=draft.error|| (draft.importing?'正在读取附件…':draft.saving?'正在保存背景信息…':draft.dirty?'未保存，关闭后可继续编辑。':'');status.classList.toggle('is-error',!!draft.error);
      files.replaceChildren();files.classList.toggle('is-empty',!draft.attachments.length);
      for(const attachment of draft.attachments)files.append(window.RabbitDocuments.createTile(attachment,{removeDisabled:draft.saving,onRemove:()=>{if(draft.saving)return;draft.attachments=draft.attachments.filter(item=>item!==attachment);draft.error='';refreshBackgroundDraft(draft);}}));
      files.append(attach);
    };
    Object.assign(state.dialog,{backgroundDraft:draft,refresh,onClose:()=>{if(!draft.dirty&&!draft.importing&&!draft.saving&&backgroundDrafts.get(workspaceId)===draft)backgroundDrafts.delete(workspaceId);renderBackgroundSummary();}});
    let composing=false;
    panel.addEventListener('compositionstart',()=>{composing=true;});panel.addEventListener('compositionend',()=>{composing=false;});
    panel.addEventListener('keydown',event=>{if(event.key!=='Backspace'||input.value!==''||composing||event.isComposing||event.keyCode===229||event.ctrlKey||event.altKey||event.metaKey||draft.saving||!draft.attachments.length)return;event.preventDefault();event.stopPropagation();draft.attachments.pop();draft.error='';refreshBackgroundDraft(draft);input.focus({preventScroll:true});});
    input.oninput=()=>{draft.text=input.value;draft.error='';refreshBackgroundDraft(draft);};
    picker.onchange=async()=>{
      const selected=Array.from(picker.files||[]);picker.value='';if(!selected.length||draft.importing||draft.saving)return;
      draft.importing=true;draft.error='';refreshBackgroundDraft(draft);const errors=[];
      try{for(const file of selected){if(backgroundDrafts.get(workspaceId)!==draft)break;try{const attachment=await window.RabbitDocuments.readFile(file,{workspaceId});if(backgroundDrafts.get(workspaceId)===draft)draft.attachments.push(attachment);}catch(error){errors.push(`${file.name}：${error?.message||String(error)}`);}refreshBackgroundDraft(draft);}}
      finally{
        draft.importing=false;draft.error=errors.join('\n');refreshBackgroundDraft(draft);
        const active=document.activeElement;
        if(state.dialog?.panel===panel&&(!active||active===document.body||panel.contains(active))&&(!active?.closest('input,textarea,select,[contenteditable="true"]')||active===input||active===picker))input.focus({preventScroll:true});
      }
    };
    actions.append(cancel,submit);panel.append(el('h2','','背景信息'),el('p','rg-background-description',`“${workspaceName}”中的图谱共用这些资料。`),files,input,picker,status,actions);refresh();attach.focus();
  }
  function workspaceImages(workspace) { return workspace.graphs.flatMap(current=>current.nodes.flatMap(node=>[...node.images,...node.annotations.flatMap(annotation=>annotation.images||[]),...(node.source?.images||[]),...(node.source?.selectionImage?[node.source.selectionImage]:[])])); }
  let canvasWheel=null;
  viewport.addEventListener('wheel',event=>{
    if(!graph()||!event.ctrlKey&&event.target.closest('.rg-card-scroll'))return;event.preventDefault();closeNote();canvasWheel=wheelGesture(canvasWheel,event,Date.now());
    const unit=event.deltaMode===1?16:event.deltaMode===2?viewport.clientHeight:1,dx=event.deltaX*unit,dy=event.deltaY*unit;
    if(canvasWheel.mode==='pan'){setView({...state.view,x:state.view.x-(event.shiftKey&&!dx?dy:dx),y:state.view.y-(event.shiftKey&&!dx?0:dy)},true);return;}
    const box=viewport.getBoundingClientRect(),point={x:event.clientX-box.left,y:event.clientY-box.top};setView(zoomAt(state.view,point,state.view.zoom*Math.exp(-dy*(event.ctrlKey?.006:.0015))),true);
  },{passive:false});
  let touchClickSuppressed=false;
  function canvasTouchPoints(event) {
    const touches=Array.from(event.touches);if(touches.some(touch=>!viewport.contains(touch.target)||touch.target.closest('button,input,textarea,select,a,[contenteditable="true"]')))return null;
    const box=viewport.getBoundingClientRect();return touches.slice(0,2).map(touch=>({x:touch.clientX-box.left,y:touch.clientY-box.top}));
  }
  function touchDrag() { return state.drag?.kind==='pan'&&state.drag.input==='touch'?state.drag:null; }
  function claimCanvasTouch(event,drag) {
    event.preventDefault();touchClickSuppressed=true;if(pointerPress)pointerPress.cancelled=true;clearGraphSelection();closeMenu();closeNote();drag.moved=true;viewport.classList.add('is-panning');
  }
  function beginCanvasTouch(points) {
    const drag={kind:'pan',input:'touch',points,view:{...state.view},moved:false,graphId:state.graphId,workspaceId:state.workspace.id,cancel:()=>{if(state.drag!==drag)return;state.drag=null;viewport.classList.remove('is-panning');if(drag.moved&&state.open&&state.graphId===drag.graphId&&state.workspace.id===drag.workspaceId)scheduleView();}};
    state.drag=drag;cancelViewMotion();return drag;
  }
  viewport.addEventListener('touchstart',event=>{
    if(event.touches.length===1)touchClickSuppressed=false;if(!state.open||!graph()||state.drag&&!touchDrag())return;const points=canvasTouchPoints(event),drag=touchDrag();
    if(!points){drag?.cancel();return;}if(!event.cancelable)return;
    // 正文单指保留原生选字和内滚；双指才接管画布，不依赖已被浏览器取消的 PointerEvent。
    if(points.length<2&&!drag&&event.target.closest('.rg-card-scroll,.rg-content'))return;
    const active=drag||beginCanvasTouch(points);active.points=points;active.view={...state.view};if(points.length>1)claimCanvasTouch(event,active);
  },{passive:false});
  viewport.addEventListener('touchmove',event=>{
    const points=canvasTouchPoints(event),drag=touchDrag();if(!points){drag?.cancel();return;}
    if(!event.cancelable){drag?.cancel();return;}if(!drag)return;
    if(points.length!==drag.points.length){drag.points=points;drag.view={...state.view};}
    if(!drag.moved&&points.length===1&&Math.hypot(points[0].x-drag.points[0].x,points[0].y-drag.points[0].y)<4)return;
    claimCanvasTouch(event,drag);setView(touchView(drag.view,drag.points,points));
  },{passive:false});
  const endCanvasTouch=event=>{const drag=touchDrag();if(!drag)return;if(drag.moved){if(event.cancelable)event.preventDefault();touchClickSuppressed=true;if(pointerPress)pointerPress.cancelled=true;}const points=canvasTouchPoints(event);if(event.type==='touchcancel'||!points?.length){drag.cancel();return;}drag.points=points;drag.view={...state.view};};
  viewport.addEventListener('touchend',endCanvasTouch,{passive:false});viewport.addEventListener('touchcancel',endCanvasTouch,{passive:false});
  viewport.addEventListener('click',event=>{if(touchClickSuppressed&&(event.pointerType==='touch'||event.sourceCapabilities?.firesTouchEvents)){event.preventDefault();event.stopImmediatePropagation();}},true);
  viewport.addEventListener('pointerdown',event=>{
    if(event.pointerType==='touch'||event.button!==0||event.defaultPrevented||event.target.closest('.rg-card')||state.drag||!graph())return;
    event.preventDefault();clearGraphSelection();closeMenu();closeNote();const start={x:event.clientX,y:event.clientY},view={...state.view},graphId=state.graphId,workspaceId=state.workspace.id;
    const drag={kind:'pan',pointerId:event.pointerId,moved:false,cancel:()=>end()};state.drag=drag;viewport.setPointerCapture(event.pointerId);
    const move=pointer=>{if(pointer.pointerId!==drag.pointerId)return;const dx=pointer.clientX-start.x,dy=pointer.clientY-start.y;if(!drag.moved&&Math.hypot(dx,dy)<4)return;drag.moved=true;viewport.classList.add('is-panning');setView({...view,x:view.x+dx,y:view.y+dy});};
    const end=pointer=>{if(pointer&&pointer.pointerId!==drag.pointerId||state.drag!==drag)return;viewport.removeEventListener('pointermove',move);viewport.removeEventListener('pointerup',end);viewport.removeEventListener('pointercancel',end);viewport.removeEventListener('lostpointercapture',end);if(viewport.hasPointerCapture(drag.pointerId))viewport.releasePointerCapture(drag.pointerId);viewport.classList.remove('is-panning');state.drag=null;if(drag.moved&&state.open&&state.graphId===graphId&&state.workspace.id===workspaceId)scheduleView();};
    viewport.addEventListener('pointermove',move);viewport.addEventListener('pointerup',end);viewport.addEventListener('pointercancel',end);viewport.addEventListener('lostpointercapture',end);
  });
  window.addEventListener('blur',()=>{pointerPress=null;if(state.drag?.kind==='pan')state.drag.cancel();});
  document.addEventListener('graph:contextchange',()=>{if(state.drag?.kind==='pan')state.drag.cancel();});
  let thumbWheel={time:0,delta:0,switched:false};
  thumbs.addEventListener('wheel',event=>{if(event.ctrlKey){event.preventDefault();return;}if(state.workspace?.graphs.length<2)return;event.preventDefault();const time=Date.now(),delta=event.deltaY||event.deltaX;if(time-thumbWheel.time>220||Math.sign(delta)!==Math.sign(thumbWheel.delta))thumbWheel={time,delta:0,switched:false};thumbWheel.time=time;thumbWheel.delta+=delta*(event.deltaMode===1?16:event.deltaMode===2?thumbs.clientHeight:1);if(thumbWheel.switched||Math.abs(thumbWheel.delta)<60)return;thumbWheel.switched=true;const items=state.workspace.graphs,index=items.findIndex(item=>item.id===state.graphId),next=items[clamp(index+Math.sign(thumbWheel.delta),0,items.length-1)];if(next&&next.id!==state.graphId)visitGraph(next.id);},{passive:false});
  root.addEventListener('wheel',event=>{if(event.ctrlKey&&!viewport.contains(event.target))event.preventDefault();},{passive:false});
  root.addEventListener('pointerdown',event=>{if(state.menu&&!state.menu.contains(event.target)&&!event.target.closest('.rg-plugin,.rg-folder'))closeMenu();});
  document.addEventListener('keydown',event=>{
    if(!state.open||root.classList.contains('capture-suspended')||event.defaultPrevented||event.isComposing||event.keyCode===229)return;
    const key=event.key.toLowerCase(),historyAction=(event.ctrlKey||event.metaKey)&&!event.altKey?(key==='z'?(event.shiftKey?'redo':'undo'):key==='y'?'redo':null):null;
    if(historyAction){if(event.target?.closest('input,textarea,select,[contenteditable="true"],#rabbit-settings-root,#rabbit-chat-root'))return;event.preventDefault();safe(()=>execute(historyAction));return;}
    if(event.key!=='Escape')return;event.preventDefault();if(state.drag?.cancel)state.drag.cancel();else if(state.note)closeNote();else if(state.dialog)closeDialog();else if(state.menu)closeMenu();else if(state.focusId)closeFocus();else close();
  });
  window.addEventListener('resize',()=>{cancelAnimationFrame(resizeFrame);resizeFrame=requestAnimationFrame(()=>{if(state.open){render();if(viewMotion)setView(state.view,true);}else if(root.classList.contains('has-pins')){dimensions();renderPins();}clampPins();if(focusCard)setFocusGeometry(focusCard,focusGeometry());});});
  for(const name of ['settings:change','settings:saved'])document.addEventListener(name,event=>{const settings=event.detail?.settings;if(!settings)return;pluginEnabled=settings.graphPluginEnabled!==false;if(!pluginEnabled){state.toast?.remove();state.toast=null;root.classList.remove('has-toast');close();}renderPins();});
  for(const panel of ['chat','settings','capture','usage']){document.addEventListener(`${panel}:open`,()=>{pinPanels.add(panel);if(!state.open)renderPins();});document.addEventListener(`${panel}:close`,()=>{pinPanels.delete(panel);if(!state.open)renderPins();});}
  document.addEventListener('desktop:cursor',event=>{if(state.open||!root.classList.contains('has-pins'))return;for(const entry of pinCards.values())hoverPin(entry,event.detail);reportPinRegions();});
  const imageCache=new Map(),backgroundCache=new Map(),cacheRevisions=new Map();
  function hydrate(workspace) {
    const current=workspace.revision>=(cacheRevisions.get(workspace.id)??-1);if(current)cacheRevisions.set(workspace.id,workspace.revision);
    const images=workspaceImages(workspace);for(const image of images)if(image.imageDataUrl&&current)imageCache.set(image.id,image.imageDataUrl);for(const image of images)if(!image.imageDataUrl)image.imageDataUrl=imageCache.get(image.id)||'';
    for(const attachment of workspace.background?.attachments||[]){const key=`background:${workspace.id}:${attachment.id}`;if(attachment.text!==undefined){if(current)backgroundCache.set(key,{text:attachment.text});}else if(attachment.dataUrl!==undefined){if(current)backgroundCache.set(key,{dataUrl:attachment.dataUrl});}else Object.assign(attachment,backgroundCache.get(key));}
    for(const graph of workspace.graphs)for(const node of graph.nodes)for(const attachment of node.attachments||[]){const key=`node:${workspace.id}:${node.id}:${attachment.id}`;if(attachment.text!==undefined){if(current)backgroundCache.set(key,{text:attachment.text});}else Object.assign(attachment,backgroundCache.get(key));}
    return workspace;
  }
  if(bridge?.surface==='pet'){
    bridge.onGraphVisibilityChanged(visible=>{if(visible)pinPanels.add('graph-window');else pinPanels.delete('graph-window');renderPins();});
    bridge.onGraphWorkspaceChanged(workspace=>{if(workspace.id===state.workspace?.id){applyWorkspace(hydrate(workspace));return;}state.epoch++;state.workspace=hydrate(workspace);state.graphId=workspace.lastGraphId||workspace.graphs[0]?.id||null;state.selectedId=null;cards.forEach(card=>card.element.remove());cards.clear();renderPins();});
  }
  if(bridge){bridge.onGraphChanged(workspace=>applyWorkspace(hydrate(workspace)));bridge.onGraphError(error=>{if(!error.workspaceId||error.workspaceId===state.workspace?.id)fail(error.message);});}
  window.RabbitGraph=Object.freeze({open,close,isOpen:()=>state.open,getSnapshot,getChatContext,execute});
  async function restorePins(){const epoch=state.epoch,items=await bridge.graphList();if(state.open||state.epoch!==epoch||!items.length)return;const workspace=hydrate(await bridge.graphOpen());if(state.open||state.epoch!==epoch)return;state.workspace=workspace;state.workspaces=items;state.graphId=workspace.lastGraphId||workspace.graphs[0]?.id||null;if(pluginEnabled&&workspace.graphs.some(current=>current.nodes.some(node=>node.pinned))){root.classList.add('has-pins');dimensions();renderPins();}}
  if(bridge&&!graphSurface)safe(restorePins);
})();
