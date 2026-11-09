(() => {
  'use strict';
  const messages = document.getElementById('messages');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const activeAnimations = new Set(), visible = new Set(), leaving = new Set();
  const shiftAnimations = new WeakMap();
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (entry.isIntersecting) visible.add(entry.target);
      else visible.delete(entry.target);
    }
  });
  let current = null, raw = '', busy = false, follow = true, resizing = false, interacting = false;
  let scrollMotion = null, scrollFrame = 0, paintFrame = 0, pendingPaint = null, lastPaint = 0;
  let progressRun = null, activityVisible = true;
  const bodyOf = node => node.querySelector('.bubble-content');
  const surfaceOf = node => node.querySelector('.bubble-surface');
  const selected = () => !window.getSelection().isCollapsed;
  const maximumScroll = () => Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  const atBottom = () => window.scrollY >= maximumScroll() - 8;
  // 入场采用有限的阻尼弹簧关键帧，流式更新不重复播放。
  const spring = time => {
    const frequency = 18, damping = .66, damped = frequency * Math.sqrt(1 - damping * damping);
    return 1 - Math.exp(-damping * frequency * time) *
      (Math.cos(damped * time) + damping * frequency / damped * Math.sin(damped * time));
  };
  const frames = (duration, pose) => Array.from({ length:25 }, (_, index) => {
    const progress = index === 24 ? 1 : spring(index / 24 * duration / 1000);
    return { ...pose(progress), offset:index / 24 };
  });
  const animate = (node, id, keyframes, duration, delay = 0, finished = () => {}) => {
    if (reducedMotion.matches) { finished(); return null; }
    const animation = node.animate(keyframes, { duration, delay, easing:'linear', fill:'backwards' });
    animation.id = id;
    activeAnimations.add(animation);
    animation.finished.then(() => { activeAnimations.delete(animation); finished(); }, () => activeAnimations.delete(animation));
    return animation;
  };
  const arrive = (node, assistant = false) => {
    const content = surfaceOf(node), distance = assistant ? 14 : 32, scale = assistant ? .96 : .88;
    animate(content, 'rabbit-message-arrive', frames(450, progress => ({
      opacity:Math.max(0, Math.min(1, progress * 1.5)),
      transform:`translate3d(${(assistant ? -4 : 10) * (1 - progress)}px,${distance * (1 - progress)}px,0) scale(${scale + (1 - scale) * progress})`
    })), 450, assistant ? 70 : 0);
  };
  const arriving = body => [body.parentElement, body].some(node => node.getAnimations().some(animation =>
    animation.playState === 'running' && (animation.id === 'rabbit-message-arrive' || animation.id === 'rabbit-first-token')));
  const positions = () => reducedMotion.matches || selected() ? new Map() :
    new Map(Array.from(visible).filter(node => node.isConnected && !leaving.has(node)).map(node => [node, node.getBoundingClientRect().top]));
  const shift = before => {
    for (const [node, top] of before) {
      if (!node.isConnected) continue;
      shiftAnimations.get(node)?.cancel();
      const delta = top - node.getBoundingClientRect().top;
      if (Math.abs(delta) < .5) continue;
      const animation = animate(node, 'rabbit-message-shift', frames(420, progress => ({
        transform:`translate3d(0,${delta * (1 - progress)}px,0)`
      })), 420);
      if (animation) shiftAnimations.set(node, animation);
    }
  };
  const cancelScroll = () => {
    cancelAnimationFrame(scrollFrame);
    scrollFrame = 0;
    scrollMotion = null;
  };
  // 滚动始终只有一个可追踪新高度的弹簧，用户接管时立即结束。
  const bottom = (immediate = false) => {
    if (interacting || selected()) return;
    const target = maximumScroll();
    if (immediate || reducedMotion.matches) {
      cancelScroll();
      window.scrollTo(0, target);
      return;
    }
    if (scrollMotion) return;
    if (Math.abs(target - window.scrollY) < .5) return;
    scrollMotion = { position:window.scrollY, velocity:0, last:performance.now() };
    const tick = now => {
      if (!scrollMotion) return;
      const state = scrollMotion, target = maximumScroll();
      const dt = Math.min(.04, Math.max(0, (now - state.last) / 1000));
      state.last = now;
      const steps = Math.max(1, Math.ceil(dt * 120)), step = dt / steps;
      for (let index = 0; index < steps; index++) {
        state.velocity += (17 * 17 * (target - state.position) - 2 * .88 * 17 * state.velocity) * step;
        state.position += state.velocity * step;
      }
      state.position = Math.max(0, Math.min(target, state.position));
      window.scrollTo(0, state.position);
      if (Math.abs(target - state.position) < .4 && Math.abs(state.velocity) < 4) {
        window.scrollTo(0, target);
        cancelScroll();
      } else scrollFrame = requestAnimationFrame(tick);
    };
    scrollFrame = requestAnimationFrame(tick);
  };
  const update = (action, { force = false, flow = false, immediate = false } = {}) => {
    const shouldFollow = (force || follow || atBottom()) && !interacting && !selected();
    const before = flow ? positions() : new Map();
    action();
    if (flow) shift(before);
    if (shouldFollow) { follow = true; bottom(immediate); }
  };
  const remove = node => {
    observer.unobserve(node);
    visible.delete(node);
    leaving.delete(node);
    node.getAnimations({ subtree:true }).forEach(animation => animation.cancel());
    node.remove();
  };
  const bubble = (role, content) => {
    const node = document.createElement('article');
    node.className = 'bubble ' + (role === 'user' ? 'user' : 'assistant');
    node.dataset.role = role;
    node.dataset.source = content;
    node.setAttribute('aria-label', (role === 'user' ? '我：' : '兔球：') + content);
    const surface = document.createElement('div');
    surface.className = 'bubble-surface';
    const body = document.createElement('div');
    body.className = 'bubble-content';
    surface.appendChild(body);
    node.appendChild(surface);
    if (role === 'user') body.textContent = content;
    else window.RabbitRender.render(body, content);
    messages.appendChild(node);
    observer.observe(node);
    return node;
  };
  const suspendProgress = () => {
    if (!progressRun) return;
    clearTimeout(progressRun.timer);
    progressRun.timer = 0;
    progressRun.progress?.remove();
    progressRun.progress = null;
  };
  const clearProgress = (keepSurface = false) => {
    if (keepSurface) clearTimeout(progressRun?.timer);
    else suspendProgress();
    progressRun = null;
  };
  // 与 PC 相同，时间覆盖整个请求；搜索数只由真实工具调用事件更新。
  const syncProgress = () => {
    if (!activityVisible || document.hidden) leaving.forEach(remove);
    const run = progressRun;
    if (!run) return;
    clearTimeout(run.timer);
    run.timer = 0;
    if (!busy || run.node !== current || !current?.isConnected) { clearProgress(); return; }
    if (!activityVisible || document.hidden) { suspendProgress(); return; }
    const seconds = Math.floor((performance.now() - run.startedAt) / 1000);
    const text = '思考 ' + seconds + ' 秒' + (run.searchCount ? ' · ' + run.searchCount + ' 次搜索' : '');
    const entering = !run.progress;
    update(() => {
      if (entering) {
        run.progress = document.createElement('div');
        run.progress.className = 'bubble-progress';
        run.progress.setAttribute('aria-live', 'off');
        surfaceOf(run.node).prepend(run.progress);
      }
      run.progress.textContent = text;
    }, { flow:entering });
    run.timer = setTimeout(() => { if (progressRun === run) syncProgress(); }, 1000);
  };
  const setSearchCount = count => {
    if (!busy || !progressRun) return;
    progressRun.searchCount = Math.max(0, Math.floor(Number(count) || 0));
    syncProgress();
  };
  const setActivityVisible = value => {
    const visible = Boolean(value);
    if (activityVisible === visible) return;
    activityVisible = visible;
    syncProgress();
  };
  const reset = () => {
    clearProgress();
    cancelScroll();
    cancelAnimationFrame(paintFrame);
    paintFrame = 0; pendingPaint = null;
    activeAnimations.forEach(animation => animation.cancel());
    activeAnimations.clear(); observer.disconnect(); visible.clear(); leaving.clear();
    messages.replaceChildren(); current = null; raw = ''; busy = false; follow = true;
    window.scrollTo(0, 0);
  };
  const beginTurn = text => {
    flushResponse();
    clearProgress();
    busy = false;
    update(() => {
      leaving.forEach(remove);
      if (current && !raw) remove(current);
      arrive(bubble('user', String(text)));
      current = bubble('assistant', '…');
      current.classList.add('pending');
      current.dataset.source = '';
      current.dataset.state = 'pending';
      arrive(current, true);
      raw = '';
    }, { force:true, flow:true });
  };
  const restore = turns => {
    reset();
    for (const turn of turns) {
      const node = bubble(turn.role, String(turn.content));
      node.dataset.state = 'complete';
      if (turn.role !== 'user') { current = node; raw = String(turn.content); }
    }
    bottom(true);
  };
  const flushResponse = () => {
    cancelAnimationFrame(paintFrame);
    paintFrame = 0;
    const paint = pendingPaint;
    pendingPaint = null;
    if (!paint || paint.node !== current) return;
    const first = !raw, wasError = current.classList.contains('error');
    update(() => {
      raw = paint.value;
      current.classList.remove('pending');
      current.classList.toggle('error', paint.error);
      current.dataset.source = raw;
      current.dataset.state = paint.error ? 'error' : busy ? 'streaming' : 'complete';
      current.setAttribute('aria-label', '兔球：' + raw);
      const body = bodyOf(current);
      body.hidden = false;
      if (paint.error) clearProgress();
      window.RabbitRender.render(body, raw);
      const entering = arriving(body);
      if (first && !entering) {
        animate(body, 'rabbit-first-token', frames(260, progress => ({
          opacity:.68 + Math.max(0, Math.min(1, progress)) * .32,
          transform:`translate3d(0,${4 * (1 - progress)}px,0) scale(${.985 + .015 * progress})`
        })), 260);
      } else if (paint.error && !wasError && !entering) {
        animate(body, 'rabbit-response-settle', [{ opacity:.76 }, { opacity:1 }], 180);
      }
    }, { flow:first });
    lastPaint = performance.now();
  };
  const showResponse = (value, error = false) => {
    if (!current) return;
    pendingPaint = { node:current, value:String(value), error:Boolean(error) };
    if (!busy || error) { flushResponse(); return; }
    if (paintFrame) return;
    const paint = now => {
      if (now - lastPaint < 42) paintFrame = requestAnimationFrame(paint);
      else flushResponse();
    };
    paintFrame = requestAnimationFrame(paint);
  };
  const setBusy = value => {
    const wasBusy = busy;
    busy = Boolean(value);
    if (busy) {
      if (!current) return;
      if (!progressRun || progressRun.node !== current) {
        clearProgress();
        progressRun = { node:current, startedAt:performance.now(), searchCount:0, timer:0, progress:null };
      }
      if (!raw) {
        const body = bodyOf(current);
        body.textContent = '';
        body.hidden = true;
        current.setAttribute('aria-label', '兔球正在思考');
      }
      syncProgress();
      return;
    }
    flushResponse();
    if (wasBusy && current && !raw) {
      const node = current, surface = surfaceOf(node);
      current = null;
      clearProgress(true);
      leaving.add(node);
      node.dataset.state = 'cancelled';
      node.setAttribute('aria-hidden', 'true');
      const visual = getComputedStyle(surface);
      const from = { opacity:visual.opacity, transform:visual.transform };
      surface.getAnimations({ subtree:true }).forEach(animation => animation.cancel());
      const finish = () => update(() => remove(node), { flow:true });
      if (!activityVisible || document.hidden || !surface.querySelector('.bubble-progress')) finish();
      else animate(surface, 'rabbit-message-leave', [
        from,
        { opacity:0, transform:'translate3d(0,-4px,0) scale(.96)' }
      ], 130, 0, finish);
      return;
    }
    update(clearProgress, { flow:wasBusy });
    if (wasBusy && current) {
      current.dataset.state = current.classList.contains('error') ? 'error' : 'complete';
      const body = bodyOf(current);
      if (!arriving(body)) {
        animate(body, 'rabbit-response-settle', [{ opacity:.92 }, { opacity:1 }], 160);
      }
    }
  };
  // PC 图标使用 target=_blank；本地页面统一受控导航，由原生端打开浏览器。
  document.addEventListener('click', event => {
    const link = event.target.closest('a[href]');
    if (!link) return;
    event.preventDefault();
    const target = link.getAttribute('href');
    if (/^https?:\/\//i.test(target || '')) window.location.href = target;
  });
  const beginInteraction = () => { interacting = true; follow = false; cancelScroll(); };
  const endInteraction = () => { interacting = false; follow = atBottom(); };
  window.addEventListener('pointerdown', beginInteraction, { passive:true });
  window.addEventListener('pointerup', endInteraction, { passive:true });
  window.addEventListener('pointercancel', endInteraction, { passive:true });
  window.addEventListener('wheel', () => { follow = false; cancelScroll(); }, { passive:true });
  document.addEventListener('selectionchange', () => { if (selected()) { follow = false; cancelScroll(); } });
  window.addEventListener('scroll', () => {
    if (scrollMotion && Math.abs(window.scrollY - scrollMotion.position) > 2) cancelScroll();
    if (!scrollMotion && !resizing && !interacting) follow = atBottom();
  }, { passive:true });
  window.addEventListener('resize', () => {
    resizing = true;
    if (follow) bottom();
    requestAnimationFrame(() => { resizing = false; });
  });
  document.fonts.ready.then(() => { if (follow) bottom(); });
  document.fonts.addEventListener('loadingdone', () => { if (follow) bottom(); });
  reducedMotion.addEventListener('change', () => {
    if (!reducedMotion.matches) return;
    activeAnimations.forEach(animation => animation.cancel());
    leaving.forEach(remove);
    if (follow) bottom(true); else cancelScroll();
  });
  document.addEventListener('visibilitychange', syncProgress);
  window.addEventListener('pagehide', () => { clearProgress(); leaving.forEach(remove); });
  window.RabbitConversation = Object.freeze({ reset, beginTurn, restore, showResponse, setBusy, setSearchCount, setActivityVisible });
  document.documentElement.dataset.ready = 'true';
})();
