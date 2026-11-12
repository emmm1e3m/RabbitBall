(() => {
  'use strict';
  const scene = document.getElementById('scene');
  if (document.getElementById('rabbit-activation-style')) return;
  const style = document.createElement('style');
  style.id = 'rabbit-activation-style';
  style.textContent = `
    .rabbit-activation-window { position:absolute;z-index:5;overflow:hidden;contain:paint;border-radius:8px;pointer-events:none; }
    .rabbit-activation-light { position:absolute;pointer-events:none;opacity:0;will-change:transform,opacity; }
  `;
  document.head.appendChild(style);
  let active = null;
  function clear() {
    if (!active) return;
    const effect = active; active = null;
    effect.animation.cancel(); effect.element.remove();
  }
  function play({origin,focusBounds,color}) {
    clear();
    let bounds = focusBounds;
    const preview = !bounds;
    if (preview) {
      // 浏览器只用中间矩形预览焦点窗口，不代表实际屏幕采集。
      bounds = {x:scene.clientWidth*.12,y:scene.clientHeight*.16,width:scene.clientWidth*.76,height:scene.clientHeight*.63};
    }
    if (bounds.width<=0 || bounds.height<=0) return Promise.resolve();
    const x = origin.x-bounds.x, y = origin.y-bounds.y;
    const radius = Math.max(Math.hypot(x,y),Math.hypot(bounds.width-x,y),Math.hypot(x,bounds.height-y),Math.hypot(bounds.width-x,bounds.height-y));
    const element = document.createElement('div'); element.className = 'rabbit-activation-window';
    if(color)element.style.setProperty('--rb-accent',color);
    element.setAttribute('aria-hidden','true'); element.dataset.preview = String(preview);
    Object.assign(element.style,{left:bounds.x+'px',top:bounds.y+'px',width:bounds.width+'px',height:bounds.height+'px'});
    const light = document.createElement('div'); light.className = 'rabbit-activation-light';
    Object.assign(light.style,{left:(x-radius)+'px',top:(y-radius)+'px',width:(radius*2)+'px',height:(radius*2)+'px',transformOrigin:'center'});
    light.style.background = `radial-gradient(circle closest-side at center,rgba(255,255,255,.32) 0%,color-mix(in srgb,var(--rb-accent,var(--rabbit-accent,#e98ab0)) 18%,transparent) 24%,color-mix(in srgb,var(--rb-accent,var(--rabbit-accent,#e98ab0)) 8%,transparent) 55%,transparent 85%)`;
    element.appendChild(light); scene.appendChild(element);
    // 圆形光层固定在激活时的鼠标位置，焦点窗口仅裁剪窗内光效。
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const frames = reduced ? [{opacity:0},{opacity:.5,offset:.4},{opacity:0}] : [
      {transform:'scale(.035)',opacity:0},
      {opacity:1,offset:.13},
      {transform:'scale(1.03)',opacity:.92,offset:.66},
      {transform:'scale(1.14)',opacity:0}
    ];
    const animation = light.animate(frames,{duration:reduced?920:2100,easing:'cubic-bezier(.18,.7,.28,1)',fill:'forwards'});
    const effect = {element,animation}; active = effect;
    const done = () => {element.remove();if(active===effect)active=null;};
    return animation.finished.then(done,done);
  }
  window.RabbitActivationEffect = Object.freeze({play,clear});
  document.addEventListener('chat:open', event => {
    const {origin,activationId,focusBounds} = event.detail;
    if(window.rabbitDesktop){
      const color=getComputedStyle(scene).getPropertyValue('--rb-accent').trim();
      window.rabbitDesktop.playActivationEffect(origin,activationId,color);return;
    }
    void play({origin,focusBounds});
  });
  window.addEventListener('pagehide',clear);
})();
