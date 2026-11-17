(() => {
  'use strict';
  if(window.RabbitUsage)return;
  const bridge=window.rabbitDesktop;
  const style=document.createElement('style');style.textContent=`
    .rabbit-usage-shade{position:absolute;inset:0;z-index:40;display:grid;place-items:center;background:#59465426;pointer-events:auto}
    .rabbit-usage-panel{width:min(440px,calc(100% - 32px));max-height:calc(100% - 32px);overflow:auto;padding:24px;border:1.5px solid var(--rb-line,#f3dce5);border-radius:22px;background:#fff;color:var(--rb-text,#594654);box-shadow:0 18px 65px #59465416;font-size:13px}
    .rabbit-usage-header{display:flex;align-items:center;justify-content:space-between;gap:16px}.rabbit-usage-header h2{margin:0;font-size:18px;font-weight:500}
    .rabbit-usage-close{border:0;border-radius:50%;background:var(--rb-soft,#fcf5f8);color:var(--rb-text-muted,#a68c99);width:28px;height:28px;display:grid;place-items:center;cursor:pointer}
    .rabbit-usage-close>svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:1.5px;stroke-linecap:round}
    .rabbit-usage-title{color:var(--rb-text-muted,#a68c99);margin:9px 0 20px;overflow-wrap:anywhere}.rabbit-usage-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
    .rabbit-usage-metric{border-radius:13px;background:var(--rb-soft,#fcf5f8);padding:14px}.rabbit-usage-metric span{display:block;font-size:12px;color:var(--rb-text-muted,#a68c99)}.rabbit-usage-metric strong{display:block;margin-top:7px;font-size:22px;font-weight:500;font-variant-numeric:tabular-nums}
    .rabbit-usage-note{margin:17px 0 0;color:var(--rb-text-muted,#a68c99);line-height:1.7}.rabbit-usage-total{margin-top:16px;padding:7px 0;border:0;background:none;color:var(--rb-accent,#df5a91);cursor:pointer;font:inherit}
  `;document.head.append(style);
  let active=null;
  const el=(tag,className,text)=>{const node=document.createElement(tag);node.className=className;if(text!==undefined)node.textContent=text;return node;};
  function close(){if(!active)return;const old=active;active=null;old.shade.remove();old.returnFocus?.isConnected&&old.returnFocus.focus({preventScroll:true});document.dispatchEvent(new CustomEvent('usage:close'));}
  async function refresh(){
    const target=active;if(!target)return;const requestId=target.requestId=(target.requestId||0)+1;
    try{
      const data=await bridge?.usageQuery(target.scope);if(active!==target||target.requestId!==requestId)return;target.body.replaceChildren();
      if(!data||!data.requestCount){target.note.textContent='暂无用量记录';return;}
      const number=value=>Number(value||0).toLocaleString('zh-CN'),tokens=value=>data.reportedRequestCount?number(value):'—';
      const cacheTotal=(data.cacheHitTokens??0)+(data.cacheMissTokens??0),rate=data.cacheReportedRequestCount&&cacheTotal>0?`${(100*data.cacheHitTokens/cacheTotal).toFixed(1)}%`:'—';
      for(const [label,value] of [['输入 Token',tokens(data.promptTokens)],['输出 Token',tokens(data.completionTokens)],['总 Token',tokens(data.totalTokens)],['缓存命中率',rate]]){const box=el('div','rabbit-usage-metric');box.append(el('span','',label),el('strong','',value));target.body.append(box);}
      target.note.textContent=`${number(data.requestCount)} 次模型请求，${number(data.reportedRequestCount)} 次返回用量。`+(data.cacheReportedRequestCount?`其中 ${number(data.cacheReportedRequestCount)} 次报告缓存：缓存命中 ${number(data.cacheHitTokens)} Token，未命中 ${number(data.cacheMissTokens)} Token。`:'服务未返回缓存用量。');
    }catch(error){if(active===target&&target.requestId===requestId)target.note.textContent=error.message||'暂时无法读取用量';}
  }
  function open(scope,options={}){
    close();const shade=el('div','rabbit-usage-shade'),panel=el('section','rabbit-usage-panel'),header=el('div','rabbit-usage-header'),dismiss=el('button','rabbit-usage-close');dismiss.type='button';dismiss.setAttribute('aria-label','关闭用量统计');dismiss.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6"/></svg>';dismiss.onclick=close;
    header.append(el('h2','','用量统计'),dismiss);const body=el('div','rabbit-usage-grid'),note=el('p','rabbit-usage-note','正在读取…');note.setAttribute('role','status');panel.append(header,el('p','rabbit-usage-title',options.title||'兔球全部用量'),body,note);
    if(scope){const total=el('button','rabbit-usage-total','查看兔球全部用量');total.type='button';total.onclick=()=>open();panel.append(total);}
    panel.setAttribute('role','dialog');panel.setAttribute('aria-modal','true');panel.setAttribute('aria-label','用量统计');shade.append(panel);shade.onclick=event=>{if(event.target===shade)close();};active={shade,body,note,scope,returnFocus:document.activeElement};(document.getElementById('scene')||document.body).append(shade);document.dispatchEvent(new CustomEvent('usage:open'));dismiss.focus({preventScroll:true});void refresh();
  }
  document.addEventListener('keydown',event=>{if(active&&event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();close();}},true);
  bridge?.onUsageChanged?.(scope=>{if(active&&(!active.scope||JSON.stringify(active.scope)===JSON.stringify(scope)))void refresh();});
  window.RabbitUsage=Object.freeze({open,close});
})();
