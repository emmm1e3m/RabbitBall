(() => {
  'use strict';
  if (window.RabbitSettings) return;
  const bridge = window.rabbitDesktop;
  const scene = document.getElementById('scene');
  const promptStore = window.RabbitPrompts;
  const shortcut = window.RabbitShortcut;
  const modelChoices = [
    { value: 'deepseek-flash', label: 'DeepSeek Flash' },
    { value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' }
  ];
  const promptFields = [
    { key: 'system', group: '系统', label: '回答方式', hint: '定义回答风格、基本要求和行为。' },
    { key: 'fallback', group: '系统', label: '仅有附件时', hint: '没有填写问题、只附上内容时使用。' },
    { key: 'search', group: '功能', label: '搜索与解释', hint: '规定搜索与解释的要求；填写问题或直接点击快捷操作时均适用。' },
    { key: 'extract', group: '功能', label: '提取文字', hint: '规定原文提取与格式保留要求；填写问题或直接点击快捷操作时均适用。' },
    { key: 'translate', group: '功能', label: '翻译', hint: '规定翻译语言、格式和范围；填写问题或直接点击快捷操作时均适用。' },
    { key: 'searchTool', group: '搜索工具', label: '联网搜索', hint: '统一规定何时联网搜索，以及如何组织搜索关键词。' }
  ];
  const defaults = { bodyColor: '#F58DAA', eyeColor: '#F90040', petSize: 1, reasoning: 'medium', launchAtLogin: false, pauseOnFullscreen: true, followMouse: true, autoCopyScreenshots: true, activationShortcut: [...shortcut.DEFAULT_ACTIVATION_SHORTCUT], apiBaseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', hasApiKey: false };
  const storeKey = 'rabbitball.appearance.v1';
  const emit = (name, detail = {}) => document.dispatchEvent(new CustomEvent('settings:' + name, { detail }));
  const validHex = value => typeof value === 'string' && /^#[\da-f]{6}$/i.test(value);
  const rgb = hex => [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16));
  const hex = values => '#' + values.map(value => Math.round(Math.max(0, Math.min(255, value))).toString(16).padStart(2, '0')).join('').toUpperCase();
  const mix = (a, b, ratio) => hex(rgb(a).map((value, index) => value * (1 - ratio) + rgb(b)[index] * ratio));
  const darken = (color, factor) => hex(rgb(color).map(value => value * factor));
  const alpha = (color, opacity) => `rgba(${rgb(color).join(',')},${opacity})`;
  const luminance = color => rgb(color).map(value => { const s = value / 255; return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4; }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
  function readable(color, contrast) {
    let result = color;
    for (let i = 0; i < 18 && 1.05 / (luminance(result) + .05) < contrast; i++) result = darken(result, .9);
    return result;
  }
  function derive(body, eye) {
    body = validHex(body) ? body.toUpperCase() : defaults.bodyColor;
    eye = validHex(eye) ? eye.toUpperCase() : defaults.eyeColor;
    const seed = mix(body, eye, .23), accent = readable(seed, 3.3);
    return {
      body, eye, accent, text: mix(readable(seed, 8), '#25252B', .78), secondary: mix(readable(seed, 5), '#66666E', .7), muted: mix(readable(mix(body, eye, .12), 3.1), '#8C8C96', .7),
      line: mix(seed, '#FFFFFF', .88), soft: mix(seed, '#FFFFFF', .96), bg: mix(body, '#FFFFFF', .993),
      ear: mix(body, '#FFFFFF', .6), signal: mix(body, eye, .62), glow: alpha(body, .12), ambient: alpha(body, .07), shadow: alpha(readable(seed, 8), .065),
      sphere: [mix(body, '#FFFFFF', .65), mix(body, '#FFFFFF', .35), mix(body, '#FFFFFF', .08), darken(body, .96), mix(body, '#FFFFFF', .14)],
      flower: mix(body, '#FFFFFF', .45), leaf: mix(body, '#FFFFFF', .7), center: mix(body, eye, .24)
    };
  }
  let palette = derive(defaults.bodyColor, defaults.eyeColor);
  function applyPalette(body, eye) {
    palette = derive(body, eye);
    const variables = {
      '--rb-body': palette.body, '--rb-eye': palette.eye, '--rb-accent': palette.accent, '--rb-text': palette.text,
      '--rb-text-secondary': palette.secondary, '--rb-text-muted': palette.muted, '--rb-line': palette.line,
      '--rb-soft': palette.soft, '--rb-bg': palette.bg, '--rb-ear': palette.ear, '--rb-signal': palette.signal,
      '--rb-glow': palette.glow, '--rb-ambient': palette.ambient, '--rb-shadow': palette.shadow,
      '--rabbit-accent': palette.accent, '--rabbit-ink': palette.text, '--rabbit-muted': palette.muted, '--rabbit-soft': palette.soft,
      '--ink': palette.text, '--muted': palette.muted, '--pink': palette.accent, '--deep-pink': palette.secondary, '--line': palette.line
    };
    for (const [name, value] of Object.entries(variables)) document.documentElement.style.setProperty(name, value);
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', palette.bg);
    [...document.querySelectorAll('#sphere-fill stop')].forEach((stop, index) => stop.setAttribute('stop-color', palette.sphere[index]));
    document.getElementById('ear-pill')?.setAttribute('fill', palette.ear);
    for (const element of document.querySelectorAll('.eye-open,#expression-mouth')) element.setAttribute('fill', palette.eye);
    for (const element of document.querySelectorAll('.eye-squeezed,.eye-sleep')) element.setAttribute('stroke', palette.eye);
    const brand = document.querySelector('.brand-mark');
    brand?.querySelector('ellipse')?.setAttribute('fill', palette.body);
    brand?.querySelectorAll('rect').forEach(element => element.setAttribute('fill', palette.ear));
    brand?.querySelector('path')?.setAttribute('stroke', palette.eye);
    const flower = document.querySelector('.paper-flower');
    flower?.querySelector('path')?.setAttribute('fill', palette.leaf);
    flower?.querySelector('path')?.setAttribute('stroke', palette.muted);
    flower?.querySelector('g')?.setAttribute('fill', palette.flower);
    flower?.querySelector('circle')?.setAttribute('fill', palette.center);
    document.documentElement.style.setProperty('--rb-heart-alt', mix(palette.body, '#FFFFFF', .32));
    document.documentElement.style.setProperty('--rb-heart-deep', mix(palette.body, palette.eye, .38));
    return { ...palette, sphere: [...palette.sphere] };
  }
  window.RabbitPalette = Object.freeze({ derive, apply: applyPalette });

  const themeStyle = document.createElement('style');
  themeStyle.textContent = `
    html,body { background:var(--rb-bg);color:var(--rb-text); }
    .app { background:#fff; }
    .app::before { opacity:0; }
    button:focus-visible { outline-color:var(--rb-accent); }
    .brand-name,.intro h1 { color:var(--rb-text); }
    .brand-note,.intro p,.footer,.pet-caption { color:var(--rb-text-muted); }
    .eyebrow { color:var(--rb-text-secondary); }
    .eyebrow::before,.eyebrow::after,.pet-caption::before { background:var(--rb-line); }
    .auto-button,.pause-button,.settings-launch { color:var(--rb-text-secondary);background:#fff;border-color:var(--rb-line); }
    .auto-button[aria-pressed='true'] { background:#fff;color:var(--rb-accent);border-color:var(--rb-line); }
    .auto-button:hover,.pause-button:hover { box-shadow:0 4px 16px var(--rb-shadow); }
    .halo { background:radial-gradient(circle,var(--rb-glow),transparent 70%); }
    .orbit,.orbit::after { border-color:var(--rb-line);opacity:.45; }
    .dust { background:var(--rb-accent); }
    .tiny-star { color:var(--rb-accent); }
    .pet:focus-visible::after { border-color:var(--rb-accent); }
    .pet .jelly-aura { background:radial-gradient(ellipse,var(--rb-glow),transparent 69%); }
    .scan-card { background:#fff;border-color:var(--rb-line);box-shadow:0 14px 38px var(--rb-shadow); }
    .paper-heading,.paper-title { color:var(--rb-text-secondary); }
    .paper-dot { background:var(--rb-accent); }
    .paper-line { background:var(--rb-line); }
    .scan-sweep { background:linear-gradient(0deg,var(--rb-soft),transparent);border-color:var(--rb-accent); }
    .scan-corners { border-color:var(--rb-accent); }
    #wifi-pool,#scan-glint { stroke:var(--rb-signal); }
    #wifi-pool circle { fill:var(--rb-signal); }
    #heart-pool > g:nth-child(3n+1) { fill:var(--rb-accent); }
    #heart-pool > g:nth-child(3n+2) { fill:var(--rb-heart-alt); }
    #heart-pool > g:nth-child(3n) { fill:var(--rb-heart-deep); }
    .mode-dock { background:#fff;border-color:var(--rb-line);box-shadow:0 12px 42px var(--rb-shadow); }
    .mode-button { color:var(--rb-text-muted); }
    .mode-button:hover { background:var(--rb-soft);color:var(--rb-accent); }
    .mode-button[aria-pressed='true'] { background:var(--rb-soft);color:var(--rb-accent); }
    .mode-button[aria-pressed='true']::after { background:var(--rb-accent); }
    .footer kbd { background:#fff;border-color:var(--rb-line); }
    .settings-launch { display:grid;place-items:center;width:35px;height:35px;border:1px solid var(--rb-line);border-radius:50%;cursor:pointer; }
    .settings-launch svg { width:16px;height:16px; }
  `;
  document.head.appendChild(themeStyle);
  applyPalette(defaults.bodyColor, defaults.eyeColor);

  const style = document.createElement('style');
  style.textContent = `
    #rabbit-settings-root { position:absolute;inset:0;z-index:30;display:grid;place-items:center;pointer-events:none; }
    #rabbit-settings-root * { box-sizing:border-box; }
    #rabbit-settings-root .rs-backdrop { position:absolute;inset:0;border:0;background:rgba(255,255,255,.82);opacity:0;transition:opacity .24s;pointer-events:none; }
    #rabbit-settings-root.is-open .rs-backdrop { opacity:1;pointer-events:auto; }
    #rabbit-settings-root .rs-panel { position:relative;width:min(360px,calc(100% - 32px));max-height:calc(100% - 32px);display:flex;flex-direction:column;background:#fff;border:1px solid var(--rb-line);border-radius:20px;box-shadow:0 18px 60px var(--rb-shadow);opacity:0;transform:translateY(12px) scale(.97);transform-origin:center;transition:opacity .2s,transform .34s cubic-bezier(.22,1,.36,1);pointer-events:none;overflow:hidden; }
    #rabbit-settings-root.is-open .rs-panel { opacity:1;transform:translateY(0) scale(1);pointer-events:auto; }
    #rabbit-settings-root .rs-header { display:flex;align-items:center;justify-content:space-between;padding:20px 22px 14px;flex:none; }
    #rabbit-settings-root h2 { margin:0;color:var(--rb-text);font-size:17px;font-weight:500; }
    #rabbit-settings-root .rs-close { display:grid;place-items:center;width:28px;height:28px;border:0;border-radius:50%;background:#fff;color:var(--rb-text-muted);cursor:pointer; }
    #rabbit-settings-root .rs-close:hover { background:var(--rb-soft);color:var(--rb-accent); }
    #rabbit-settings-root button svg { width:16px;height:16px;stroke:currentColor;stroke-width:2.25;fill:none;stroke-linecap:round;stroke-linejoin:round; }
    #rabbit-settings-root .rs-tabs { display:flex;gap:18px;padding:0 22px;flex:none; }
    #rabbit-settings-root .rs-tab { display:flex;align-items:center;justify-content:center;gap:6px;flex:1;padding:8px 0 11px;border:0;border-bottom:2px solid transparent;background:#fff;color:var(--rb-text-muted);font-size:14px;cursor:pointer;transition:color .2s,border-color .24s; }
    #rabbit-settings-root .rs-tab svg { width:15px;height:15px; }
    #rabbit-settings-root .rs-tab:hover { color:var(--rb-text-secondary); }
    #rabbit-settings-root .rs-tab[aria-selected='true'] { color:var(--rb-text);border-bottom-color:var(--rb-text-secondary); }
    #rabbit-settings-root .rs-fields { padding:0;overflow-y:auto;min-height:0;scrollbar-width:thin;scrollbar-color:var(--rb-line) transparent; }
    #rabbit-settings-root .rs-pages { display:grid;padding:19px 22px 6px; }
    #rabbit-settings-root .rs-tab-panel { grid-area:1 / 1;display:grid;align-content:start;gap:20px;min-width:0;opacity:0;visibility:hidden;transform:translateX(7px);pointer-events:none;transition:opacity .2s,transform .3s cubic-bezier(.22,1,.36,1),visibility 0s .2s; }
    #rabbit-settings-root .rs-tab-panel.is-active { opacity:1;visibility:visible;transform:translateX(0);pointer-events:auto;transition:opacity .2s,transform .3s cubic-bezier(.22,1,.36,1),visibility 0s; }
    #rabbit-settings-root .rs-tabs { gap:12px; }
    #rabbit-settings-root .rs-prompts { gap:12px; }
    #rabbit-settings-root .rs-prompt-editor { display:block;width:100%;height:160px;resize:vertical;min-height:110px;max-height:260px;padding:10px 11px;border:1px solid var(--rb-line);border-radius:9px;background:#fff;color:var(--rb-text);font:inherit;font-size:14px;line-height:1.7;outline:none; }
    #rabbit-settings-root .rs-prompt-editor:focus { border-color:var(--rb-accent); }
    #rabbit-settings-root .rs-prompt-actions { display:flex;align-items:center;justify-content:space-between;gap:12px; }
    #rabbit-settings-root .rs-prompt-reset { padding:3px 0;border:0;background:#fff;color:var(--rb-text-secondary);font-size:12px;cursor:pointer; }
    #rabbit-settings-root .rs-prompt-reset:hover { color:var(--rb-text); }
    #rabbit-settings-root .rs-field { display:grid;gap:8px; }
    #rabbit-settings-root .rs-label { display:flex;align-items:center;justify-content:space-between;gap:12px;color:var(--rb-text-secondary);font-size:14px; }
    #rabbit-settings-root .rs-label output { color:var(--rb-text-muted);font-size:13px; }
    #rabbit-settings-root input,#rabbit-settings-root select,#rabbit-settings-root button { font:inherit; }
    #rabbit-settings-root .rs-key-wrap { position:relative; }
    #rabbit-settings-root .rs-key,#rabbit-settings-root select { width:100%;height:37px;border:1px solid var(--rb-line);border-radius:9px;background:#fff;color:var(--rb-text);font-size:14px;padding:0 11px;outline:none; }
    #rabbit-settings-root .rs-key { padding-right:36px; }
    #rabbit-settings-root .rs-key::placeholder { color:var(--rb-text-muted); }
    #rabbit-settings-root .rs-key:focus,#rabbit-settings-root select:focus { border-color:var(--rb-accent); }
    #rabbit-settings-root .rs-clear-key { position:absolute;right:4px;top:4px;display:grid;place-items:center;width:29px;height:29px;border:0;background:#fff;color:var(--rb-text-muted);border-radius:7px;cursor:pointer; }
    #rabbit-settings-root .rs-clear-key[hidden] { display:none; }
    #rabbit-settings-root .rs-hint { margin:0;color:var(--rb-text-muted);font-size:12px;line-height:1.6; }
    #rabbit-settings-root .rs-size { -webkit-appearance:none;appearance:none;width:100%;height:20px;margin:0;background:transparent;accent-color:var(--rb-accent);cursor:pointer; }
    #rabbit-settings-root .rs-size::-webkit-slider-runnable-track { height:4px;border:0;border-radius:4px;background:var(--rb-line); }
    #rabbit-settings-root .rs-size::-webkit-slider-thumb { -webkit-appearance:none;appearance:none;width:14px;height:14px;margin-top:-5px;border:0;border-radius:50%;background:var(--rb-accent); }
    #rabbit-settings-root .rs-size:focus-visible { outline:2px solid var(--rb-accent);outline-offset:4px;border-radius:5px; }
    #rabbit-settings-root .rs-toggles { display:grid;gap:16px; }
    #rabbit-settings-root .rs-toggle { display:flex;align-items:center;justify-content:space-between;gap:16px;cursor:pointer; }
    #rabbit-settings-root .rs-toggle-copy { display:grid;gap:4px; }
    #rabbit-settings-root .rs-toggle-copy > span { color:var(--rb-text-secondary);font-size:14px; }
    #rabbit-settings-root .rs-toggle-copy small { color:var(--rb-text-muted);font-size:12px; }
    #rabbit-settings-root .rs-toggle-copy small[hidden] { display:none; }
    #rabbit-settings-root .rs-shortcut-row { display:flex;align-items:center;gap:7px;min-width:0; }
    #rabbit-settings-root .rs-shortcut { flex:1;display:flex;align-items:center;gap:9px;min-width:0;min-height:38px;padding:7px 10px;border:1px solid var(--rb-line);border-radius:10px;background:#fff;color:var(--rb-text-secondary);font-size:13px;text-align:left;cursor:pointer;transition:border-color .2s,background .2s; }
    #rabbit-settings-root .rs-shortcut.is-recording { border-color:var(--rb-accent);background:var(--rb-soft); }
    #rabbit-settings-root .rs-shortcut-keys { display:flex;align-items:center;gap:4px;flex-wrap:wrap; }
    #rabbit-settings-root .rs-shortcut kbd { padding:2px 6px;border:1px solid var(--rb-line);border-radius:5px;background:#fff;color:var(--rb-text);font:inherit;line-height:1.4; }
    #rabbit-settings-root .rs-shortcut-reset { display:grid;place-items:center;flex:none;width:30px;height:30px;padding:0;border:0;border-radius:8px;background:#fff;color:var(--rb-text-muted);cursor:pointer; }
    #rabbit-settings-root .rs-shortcut-reset:hover { color:var(--rb-accent);background:var(--rb-soft); }
    #rabbit-settings-root .rs-shortcut:focus-visible,#rabbit-settings-root .rs-shortcut-reset:focus-visible { outline:2px solid var(--rb-accent);outline-offset:3px; }
    #rabbit-settings-root .rs-switch { position:relative;flex:none;display:block;width:34px;height:20px; }
    #rabbit-settings-root .rs-switch input { position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;cursor:pointer; }
    #rabbit-settings-root .rs-switch i { position:absolute;inset:0;pointer-events:none;border:1px solid var(--rb-line);border-radius:20px;background:#fff;transition:border-color .2s; }
    #rabbit-settings-root .rs-switch i::after { content:'';position:absolute;left:3px;top:3px;width:12px;height:12px;border-radius:50%;background:var(--rb-line);transition:transform .24s cubic-bezier(.22,1,.36,1),background .2s; }
    #rabbit-settings-root .rs-switch input:checked + i { border-color:var(--rb-accent); }
    #rabbit-settings-root .rs-switch input:checked + i::after { background:var(--rb-accent);transform:translateX(14px); }
    #rabbit-settings-root .rs-switch input:focus-visible + i { outline:2px solid var(--rb-accent);outline-offset:3px; }
    #rabbit-settings-root .rs-switch input:disabled { cursor:default; }
    #rabbit-settings-root .rs-switch input:disabled + i { opacity:.5; }
    #rabbit-settings-root .rs-colors { display:grid;grid-template-columns:1fr 1fr;gap:18px; }
    #rabbit-settings-root .rs-color-field { display:flex;align-items:center;gap:9px; }
    #rabbit-settings-root input[type='color'] { flex:none;width:34px;height:34px;padding:0;border:0;background:none;cursor:pointer; }
    #rabbit-settings-root input[type='color']::-webkit-color-swatch-wrapper { padding:2px; }
    #rabbit-settings-root input[type='color']::-webkit-color-swatch { border:1px solid var(--rb-line);border-radius:50%; }
    #rabbit-settings-root .rs-color-copy { display:grid;gap:4px; }
    #rabbit-settings-root .rs-color-copy label { font-size:13px;color:var(--rb-text-secondary); }
    #rabbit-settings-root .rs-color-copy output { color:var(--rb-text-muted);font-size:12px;font-variant-numeric:tabular-nums; }
    #rabbit-settings-root .rs-footer { display:flex;align-items:center;justify-content:space-between;gap:16px;padding:19px 22px 20px;flex:none; }
    #rabbit-settings-root .rs-status { min-height:15px;margin:0;color:var(--rb-text-muted);font-size:13px;line-height:1.5; }
    #rabbit-settings-root .rs-save { flex:none;border:1px solid var(--rb-line);border-radius:10px;background:#fff;color:var(--rb-accent);font-size:14px;padding:8px 18px;cursor:pointer;transition:background .2s; }
    #rabbit-settings-root .rs-save:hover { background:var(--rb-soft); }
    #rabbit-settings-root .rs-save:disabled { opacity:.45;cursor:default; }
    @media(max-width:420px) { #rabbit-settings-root .rs-key,#rabbit-settings-root select { font-size:18px; } }
    @media(prefers-reduced-motion:reduce) { #rabbit-settings-root * { transition-duration:.01ms!important; } }
  `;
  document.head.appendChild(style);
  const root = document.createElement('div');
  root.id = 'rabbit-settings-root';
  const closeIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';
  root.innerHTML = `
    <button class="rs-backdrop" type="button" aria-label="取消设置" tabindex="-1"></button>
    <section class="rs-panel" role="dialog" aria-modal="true" aria-label="设置" aria-hidden="true" inert>
      <header class="rs-header"><h2>设置</h2><button class="rs-close" type="button" aria-label="关闭设置，放弃未保存的修改" title="关闭设置">${closeIcon}</button></header>
      <nav class="rs-tabs" role="tablist" aria-label="设置分类">
        <button class="rs-tab" id="rabbit-tab-model" type="button" role="tab" aria-selected="true" aria-controls="rabbit-page-model" tabindex="0"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="4"/><path d="M9 1v4m6-4v4M9 19v4m6-4v4M1 9h4m-4 6h4m14-6h4m-4 6h4M9 9h6v6H9z"/></svg><span>模型</span></button>
        <button class="rs-tab" id="rabbit-tab-appearance" type="button" role="tab" aria-selected="false" aria-controls="rabbit-page-appearance" tabindex="-1"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a9 9 0 1 0 0 18h2a2 2 0 0 0 1-3.7 1.6 1.6 0 0 1 .8-3h1.4A3.8 3.8 0 0 0 21 10.5C21 6.4 17 3 12 3Z"/><path d="M7 11h.01M10 7h.01M15 7h.01" stroke-width="3.5"/></svg><span>外观</span></button>
        <button class="rs-tab" id="rabbit-tab-general" type="button" role="tab" aria-selected="false" aria-controls="rabbit-page-general" tabindex="-1"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3" fill="white"/><circle cx="15" cy="17" r="3" fill="white"/></svg><span>通用</span></button>
        <button class="rs-tab" id="rabbit-tab-prompts" type="button" role="tab" aria-selected="false" aria-controls="rabbit-page-prompts" tabindex="-1"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h14v13H9l-4 4V4ZM9 8h6m-6 4h4"/></svg><span>提示词</span></button>
      </nav>
      <form class="rs-fields" id="rabbit-settings-form">
        <div class="rs-pages">
        <section class="rs-tab-panel is-active" id="rabbit-page-model" role="tabpanel" aria-labelledby="rabbit-tab-model">
        <div class="rs-field"><label class="rs-label" for="rabbit-api-key">API Key</label><div class="rs-key-wrap"><input class="rs-key" id="rabbit-api-key" type="password" autocomplete="off" spellcheck="false" aria-describedby="rabbit-key-hint"><button class="rs-clear-key" type="button" aria-label="清除密钥" title="清除密钥" hidden>${closeIcon}</button></div><p class="rs-hint" id="rabbit-key-hint"></p></div>
        <div class="rs-field"><label class="rs-label" for="rabbit-model">模型</label><select id="rabbit-model"></select></div>
        <div class="rs-field"><label class="rs-label" for="rabbit-reasoning">思考强度</label><select id="rabbit-reasoning"><option value="low">low</option><option value="medium">high</option><option value="high">max</option></select></div>
        </section>
        <section class="rs-tab-panel" id="rabbit-page-appearance" role="tabpanel" aria-labelledby="rabbit-tab-appearance" aria-hidden="true" inert>
        <div class="rs-field"><label class="rs-label" for="rabbit-pet-size">宠物尺寸<output id="rabbit-size-value" for="rabbit-pet-size">100%</output></label><input class="rs-size" id="rabbit-pet-size" type="range" min="0.6" max="1.6" step="0.05" value="1"></div>
        <div class="rs-field"><span class="rs-label">调色板</span><div class="rs-colors"><div class="rs-color-field"><input id="rabbit-body-color" type="color" value="#F58DAA" aria-label="球色"><div class="rs-color-copy"><label for="rabbit-body-color">球色</label><output id="rabbit-body-value">#F58DAA</output></div></div><div class="rs-color-field"><input id="rabbit-eye-color" type="color" value="#F90040" aria-label="眼睛色"><div class="rs-color-copy"><label for="rabbit-eye-color">眼睛色</label><output id="rabbit-eye-value">#F90040</output></div></div></div><p class="rs-hint">其他颜色会自动匹配。</p></div>
        </section>
        <section class="rs-tab-panel" id="rabbit-page-general" role="tabpanel" aria-labelledby="rabbit-tab-general" aria-hidden="true" inert>
        <div class="rs-field"><span class="rs-label" id="rabbit-shortcut-label">启动键</span><div class="rs-shortcut-row"><button class="rs-shortcut" id="rabbit-activation-shortcut" type="button" aria-labelledby="rabbit-shortcut-label rabbit-shortcut-value" aria-describedby="rabbit-shortcut-hint"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="18" height="12" rx="3"/><path d="M7 10h.01M11 10h.01M15 10h.01M7 14h.01M11 14h6"/></svg><span class="rs-shortcut-keys" id="rabbit-shortcut-value"></span></button><button class="rs-shortcut-reset" id="rabbit-shortcut-reset" type="button" aria-label="恢复默认启动键" title="恢复默认启动键"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10a8 8 0 1 1 1 7M4 4v6h6"/></svg></button></div><p class="rs-hint" id="rabbit-shortcut-hint" aria-live="polite">点击后按下单键或组合键。</p></div>
        <div class="rs-toggles">
          <label class="rs-toggle"><span class="rs-toggle-copy"><span>开机自启动</span><small id="rabbit-startup-note">桌面版可用</small></span><span class="rs-switch"><input id="rabbit-launch-at-login" type="checkbox" role="switch" aria-label="开机自启动" aria-describedby="rabbit-startup-note"><i aria-hidden="true"></i></span></label>
          <label class="rs-toggle"><span class="rs-toggle-copy"><span>全屏时暂停</span></span><span class="rs-switch"><input id="rabbit-pause-fullscreen" type="checkbox" role="switch" aria-label="全屏时暂停" checked><i aria-hidden="true"></i></span></label>
          <label class="rs-toggle"><span class="rs-toggle-copy"><span>截图后自动复制</span></span><span class="rs-switch"><input id="rabbit-auto-copy-screenshots" type="checkbox" role="switch" aria-label="截图后自动复制" checked><i aria-hidden="true"></i></span></label>
          <label class="rs-toggle"><span class="rs-toggle-copy"><span>鼠标跟随</span><small id="rabbit-follow-hint">关闭后收起到屏幕边缘，可拖动调整。</small></span><span class="rs-switch"><input id="rabbit-follow-mouse" type="checkbox" role="switch" aria-label="鼠标跟随" aria-describedby="rabbit-follow-hint" checked><i aria-hidden="true"></i></span></label>
        </div>
        </section>
        <section class="rs-tab-panel rs-prompts" id="rabbit-page-prompts" role="tabpanel" aria-labelledby="rabbit-tab-prompts" aria-hidden="true" inert>
          <div class="rs-field"><label class="rs-label" for="rabbit-prompt-key">用途</label><select id="rabbit-prompt-key">${['系统', '功能', '搜索工具'].map(group => `<optgroup label="${group}">${promptFields.filter(field => field.group === group).map(field => `<option value="${field.key}">${field.label}</option>`).join('')}</optgroup>`).join('')}</select></div>
          <textarea class="rs-prompt-editor" id="rabbit-prompt-editor" aria-label="提示词内容" aria-describedby="rabbit-prompt-hint" maxlength="20000" spellcheck="false"></textarea>
          <p class="rs-hint" id="rabbit-prompt-hint"></p>
          <div class="rs-prompt-actions"><button class="rs-prompt-reset" id="rabbit-prompt-reset" type="button">恢复这项默认</button><button class="rs-prompt-reset" id="rabbit-prompts-reset" type="button">全部恢复默认</button></div>
          <p class="rs-hint">保存后在新对话中生效。</p>
        </section>
        </div>
      </form>
      <footer class="rs-footer"><p class="rs-status" role="status" aria-live="polite"></p><button class="rs-save" type="submit" form="rabbit-settings-form">保存</button></footer>
    </section>
  `;
  scene.appendChild(root);
  const $ = selector => root.querySelector(selector);
  const panel = $('.rs-panel'), keyInput = $('.rs-key'), clearKey = $('.rs-clear-key');
  const model = $('#rabbit-model'), reasoning = $('#rabbit-reasoning'), size = $('#rabbit-pet-size'), bodyInput = $('#rabbit-body-color'), eyeInput = $('#rabbit-eye-color');
  const startup = $('#rabbit-launch-at-login'), fullscreen = $('#rabbit-pause-fullscreen'), follow = $('#rabbit-follow-mouse'), autoCopy = $('#rabbit-auto-copy-screenshots');
  const shortcutButton = $('#rabbit-activation-shortcut'), shortcutKeys = $('.rs-shortcut-keys'), shortcutHint = $('#rabbit-shortcut-hint');
  const saveButton = $('.rs-save'), status = $('.rs-status');
  const promptKey = $('#rabbit-prompt-key'), promptEditor = $('#rabbit-prompt-editor'), promptHint = $('#rabbit-prompt-hint');
  promptKey.value = promptFields[0].key;
  const tabs = [...root.querySelectorAll('.rs-tab')], pages = [...root.querySelectorAll('.rs-tab-panel')];
  let activeTab = 0, openVersion = 0, recording = false, recordingReady = false, recordingVersion = 0;
  const recordingKeys = new Set();
  let saved = { ...defaults, prompts: {} }, draft = { ...defaults, prompts: {} }, openState = false, saving = false, keyCleared = false, sessionApiKey = '', returnFocus = null, loadError = '';
  const copySettings = value => ({ ...value, activationShortcut: [...value.activationShortcut], prompts: { ...value.prompts } });
  function normalize(value = {}) {
    return {
      bodyColor: validHex(value.bodyColor) ? value.bodyColor.toUpperCase() : defaults.bodyColor,
      eyeColor: validHex(value.eyeColor) ? value.eyeColor.toUpperCase() : defaults.eyeColor,
      petSize: Number.isFinite(value.petSize) ? Math.max(.6, Math.min(1.6, value.petSize)) : defaults.petSize,
      reasoning: ['low', 'medium', 'high'].includes(value.reasoning) ? value.reasoning : defaults.reasoning,
      launchAtLogin: !!bridge && typeof value.launchAtLogin === 'boolean' ? value.launchAtLogin : defaults.launchAtLogin,
      pauseOnFullscreen: typeof value.pauseOnFullscreen === 'boolean' ? value.pauseOnFullscreen : defaults.pauseOnFullscreen,
      followMouse: typeof value.followMouse === 'boolean' ? value.followMouse : defaults.followMouse,
      autoCopyScreenshots: typeof value.autoCopyScreenshots === 'boolean' ? value.autoCopyScreenshots : defaults.autoCopyScreenshots,
      activationShortcut: shortcut.normalizeShortcut(value.activationShortcut ?? defaults.activationShortcut),
      apiBaseUrl: typeof value.apiBaseUrl === 'string' ? value.apiBaseUrl : defaults.apiBaseUrl,
      model: typeof value.model === 'string' ? value.model : defaults.model,
      prompts: promptStore.overrides(value.prompts),
      hasApiKey: !!value.hasApiKey
    };
  }
  function applySettings(value) {
    const settings = normalize(value);
    applyPalette(settings.bodyColor, settings.eyeColor);
    emit('change', { settings: { ...settings } });
    return settings;
  }
  function layout() {
    if (!openState) return;
    const bounds = panel.getBoundingClientRect(), parent = scene.getBoundingClientRect();
    emit('layout', { bounds: { x: bounds.x - parent.x, y: bounds.y - parent.y, width: bounds.width, height: bounds.height } });
  }
  function selectTab(index, focus = false) {
    stopRecording();
    activeTab = (index + tabs.length) % tabs.length;
    tabs.forEach((tab, number) => {
      const selected = number === activeTab;
      tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
      pages[number].classList.toggle('is-active', selected); pages[number].inert = !selected;
      if (selected) pages[number].removeAttribute('aria-hidden'); else pages[number].setAttribute('aria-hidden', 'true');
    });
    if (focus) tabs[activeTab].focus({ preventScroll: true });
  }
  function fillForm() {
    keyInput.value = '';
    keyInput.placeholder = saved.hasApiKey ? '已配置，输入以替换' : '填写 DeepSeek API Key';
    $('#rabbit-key-hint').textContent = bridge ? '密钥加密保存在本机。' : '密钥仅在当前浏览器会话保留。';
    const choices = modelChoices.some(choice => choice.value === draft.model) ? modelChoices : [...modelChoices, { value: draft.model, label: draft.model }];
    model.replaceChildren(...choices.map(choice => {
      const option = document.createElement('option'); option.value = choice.value; option.textContent = choice.label; return option;
    }));
    model.value = draft.model;
    reasoning.value = draft.reasoning; size.value = String(draft.petSize);
    bodyInput.value = draft.bodyColor; eyeInput.value = draft.eyeColor;
    startup.checked = draft.launchAtLogin; startup.disabled = !bridge;
    fullscreen.checked = draft.pauseOnFullscreen; follow.checked = draft.followMouse;
    autoCopy.checked = draft.autoCopyScreenshots;
    renderShortcut();
    $('#rabbit-startup-note').hidden = !!bridge;
    syncOutputs(); clearKey.hidden = !saved.hasApiKey;
    fillPrompt();
  }
  function renderShortcut() {
    const codes = recording && recordingKeys.size ? [...recordingKeys] : draft.activationShortcut;
    shortcutKeys.replaceChildren(...codes.map(code => {
      const key = document.createElement('kbd'); key.textContent = shortcut.formatShortcut([code]); return key;
    }));
    shortcutButton.classList.toggle('is-recording', recording);
    shortcutButton.setAttribute('aria-pressed', String(recording));
    shortcutHint.textContent = recording ? (recordingReady ? '请按下启动键，松开完成 · Esc 取消' : '准备录制…') : '点击后按下单键或组合键。';
  }
  function stopRecording() {
    if (!recording) return Promise.resolve(true);
    recording = false; recordingReady = false; recordingVersion++; recordingKeys.clear();
    renderShortcut(); emit('recording', { recording: false });
    return bridge ? bridge.setShortcutRecording(false).then(() => true, () => { status.textContent = '未能结束录制，请重新打开设置。'; return false; }) : Promise.resolve(true);
  }
  async function startRecording() {
    if (recording) { stopRecording(); return; }
    if (!openState || saving) return;
    const version = ++recordingVersion;
    recording = true; recordingReady = !bridge; recordingKeys.clear(); renderShortcut();
    status.textContent = '';
    emit('recording', { recording: true }); shortcutButton.focus({ preventScroll: true });
    if (!bridge) return;
    try {
      await bridge.setShortcutRecording(true);
      if (recording && version === recordingVersion) { recordingReady = true; renderShortcut(); }
    } catch {
      if (version !== recordingVersion) return;
      stopRecording(); status.textContent = '未能开始录制，请重试。';
    }
  }
  function fillPrompt() {
    promptEditor.value = draft.prompts[promptKey.value] ?? promptStore.defaults[promptKey.value];
    promptHint.textContent = promptFields.find(field => field.key === promptKey.value).hint;
  }
  function editPrompt() {
    const prompts = { ...draft.prompts };
    if (promptEditor.value === promptStore.defaults[promptKey.value]) delete prompts[promptKey.value];
    else prompts[promptKey.value] = promptEditor.value;
    draft = { ...draft, prompts };
  }
  function syncOutputs() {
    $('#rabbit-size-value').textContent = Math.round(draft.petSize * 100) + '%';
    $('#rabbit-body-value').textContent = draft.bodyColor;
    $('#rabbit-eye-value').textContent = draft.eyeColor;
  }
  function preview() {
    draft = { ...draft, model: model.value, reasoning: reasoning.value, petSize: Number(size.value), bodyColor: bodyInput.value.toUpperCase(), eyeColor: eyeInput.value.toUpperCase(), launchAtLogin: !!bridge && startup.checked, pauseOnFullscreen: fullscreen.checked, followMouse: follow.checked, autoCopyScreenshots: autoCopy.checked };
    syncOutputs(); applySettings(draft);
  }
  const ready = (async () => {
    try {
      if (bridge) saved = normalize(await bridge.loadSettings());
      else {
        const stored = localStorage.getItem(storeKey);
        if (stored) saved = normalize({ ...JSON.parse(stored), hasApiKey: false });
      }
    } catch { loadError = '未能读取设置，可以重新保存。'; }
    draft = copySettings(saved); promptStore.commit(saved.prompts); applySettings(saved); fillForm();
    return copySettings(saved);
  })();
  async function open() {
    const version = ++openVersion;
    await ready;
    if (version !== openVersion || openState) return;
    returnFocus = document.activeElement; draft = copySettings(saved); keyCleared = false; status.textContent = loadError; fillForm();
    openState = true; root.classList.add('is-open'); panel.inert = false; panel.setAttribute('aria-hidden', 'false');
    emit('open', { bounds: (() => { const r = panel.getBoundingClientRect(), p = scene.getBoundingClientRect(); return { x: r.x - p.x, y: r.y - p.y, width: r.width, height: r.height }; })() });
    layout(); requestAnimationFrame(() => {
      if (openState) { layout(); pages[activeTab].querySelector('input:not([disabled]),select:not([disabled]),textarea:not([disabled])')?.focus({ preventScroll: true }); }
    });
  }
  function close(commit = false) {
    openVersion++;
    if (!openState || saving) return;
    stopRecording();
    if (!commit) applySettings(saved);
    openState = false; root.classList.remove('is-open'); panel.inert = true; panel.setAttribute('aria-hidden', 'true'); keyInput.value = '';
    emit('close', { saved: commit });
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  }
  async function save(event) {
    event.preventDefault(); if (saving) return;
    const recordingFinished = stopRecording();
    const invalid = promptFields.find(field => typeof draft.prompts[field.key] === 'string' && (!draft.prompts[field.key].trim() || draft.prompts[field.key].length > 20000));
    if (invalid || Object.values(promptStore.resolve(draft.prompts)).reduce((total, text) => total + text.length, 0) > 80000) {
      selectTab(3); if (invalid) { promptKey.value = invalid.key; fillPrompt(); }
      status.textContent = invalid ? `${invalid.label}不能为空，且需在 20000 字以内。` : '提示词总长度需在 80000 字以内。';
      promptEditor.focus({ preventScroll: true }); return;
    }
    preview(); saving = true; saveButton.disabled = true; saveButton.textContent = '保存中'; status.textContent = '';
    try {
      if (!await recordingFinished) throw new Error('未能结束录制，请重新打开设置。');
      const patch = { bodyColor: draft.bodyColor, eyeColor: draft.eyeColor, petSize: draft.petSize, model: draft.model, reasoning: draft.reasoning, launchAtLogin: draft.launchAtLogin, pauseOnFullscreen: draft.pauseOnFullscreen, followMouse: draft.followMouse, autoCopyScreenshots: draft.autoCopyScreenshots, activationShortcut: [...draft.activationShortcut], prompts: { ...draft.prompts } };
      const enteredKey = keyInput.value.trim();
      if (enteredKey) patch.apiKey = enteredKey;
      else if (keyCleared) patch.apiKey = '';
      if (bridge) saved = normalize(await bridge.saveSettings(patch));
      else {
        const nextKey = 'apiKey' in patch ? patch.apiKey : sessionApiKey;
        const nextSettings = normalize({ ...draft, hasApiKey: !!nextKey });
        const { hasApiKey, ...publicConfig } = nextSettings;
        localStorage.setItem(storeKey, JSON.stringify(publicConfig));
        saved = nextSettings; sessionApiKey = nextKey;
      }
      loadError = '';
      applySettings(saved);
      emit('saved', { settings: bridge ? { ...saved } : { ...saved, apiKey: sessionApiKey } });
      saving = false; close(true);
    } catch (error) { status.textContent = error instanceof Error ? error.message : '未能保存，请重试。'; }
    finally { saving = false; saveButton.disabled = false; saveButton.textContent = '保存'; }
  }
  root.querySelector('form').addEventListener('submit', save);
  $('.rs-close').addEventListener('click', () => close());
  $('.rs-backdrop').addEventListener('click', () => close());
  shortcutButton.addEventListener('click', startRecording);
  $('#rabbit-shortcut-reset').addEventListener('click', () => { stopRecording(); draft = { ...draft, activationShortcut: [...shortcut.DEFAULT_ACTIVATION_SHORTCUT] }; renderShortcut(); });
  for (const type of ['keydown', 'keyup']) document.addEventListener(type, event => {
    if (!recording) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (event.key === 'Escape') { stopRecording(); return; }
    if (!recordingReady || event.repeat) return;
    if (event.getModifierState?.('AltGraph')) {
      // Windows 的 AltGr 会先合成左 Ctrl；明确录制右 Alt 时只保留实际按键。
      if (event.code === 'AltRight') recordingKeys.delete('ControlLeft');
      else if (!recordingKeys.has('AltRight')) { stopRecording(); status.textContent = '请先按下要录制的启动键。'; return; }
    }
    if (type === 'keydown') {
      if (!shortcut.isSupportedShortcutCode(event.code)) { stopRecording(); status.textContent = '这个按键无法用作启动键，请重新输入。'; return; }
      recordingKeys.add(event.code); renderShortcut();
    } else if (recordingKeys.has(event.code)) {
      try { draft = { ...draft, activationShortcut: shortcut.normalizeShortcut([...recordingKeys]) }; stopRecording(); }
      catch (error) { stopRecording(); status.textContent = error.message; }
    }
  }, true);
  shortcutButton.addEventListener('blur', stopRecording);
  window.addEventListener('blur', stopRecording);
  window.addEventListener('pagehide', stopRecording);
  keyInput.addEventListener('input', () => {
    if (keyInput.value.trim()) { keyCleared = false; keyInput.placeholder = saved.hasApiKey ? '已配置，输入以替换' : '填写 DeepSeek API Key'; }
    clearKey.hidden = !keyInput.value && (!saved.hasApiKey || keyCleared);
  });
  clearKey.addEventListener('click', () => { keyCleared = true; keyInput.value = ''; keyInput.placeholder = '保存后清除密钥'; clearKey.hidden = true; });
  for (const input of [model, reasoning, size, bodyInput, eyeInput]) input.addEventListener('input', preview);
  for (const input of [startup, fullscreen, follow, autoCopy]) input.addEventListener('change', preview);
  promptKey.addEventListener('change', fillPrompt);
  promptEditor.addEventListener('input', editPrompt);
  $('#rabbit-prompt-reset').addEventListener('click', () => { const prompts = { ...draft.prompts }; delete prompts[promptKey.value]; draft = { ...draft, prompts }; fillPrompt(); });
  $('#rabbit-prompts-reset').addEventListener('click', () => { draft = { ...draft, prompts: {} }; fillPrompt(); });
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectTab(index));
    tab.addEventListener('keydown', event => {
      let next = activeTab;
      if (event.key === 'ArrowRight') next++;
      else if (event.key === 'ArrowLeft') next--;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = tabs.length - 1;
      else return;
      event.preventDefault(); selectTab(next, true);
    });
  });
  for (const type of ['pointerdown', 'pointerup', 'pointermove', 'click', 'dblclick']) root.addEventListener(type, event => event.stopPropagation());
  root.addEventListener('keydown', event => {
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    if (event.key === 'Tab') {
      const targets = [...panel.querySelectorAll('button:not([disabled]):not([hidden]),input:not([disabled]),select:not([disabled]),textarea:not([disabled])')].filter(element => element.tabIndex >= 0 && !element.closest('[inert]'));
      const first = targets[0], last = targets[targets.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });
  panel.addEventListener('transitionend', event => { if (event.propertyName === 'transform') layout(); });
  const observer = new ResizeObserver(layout); observer.observe(scene); observer.observe(panel);
  const header = document.querySelector('.header-actions');
  if (!bridge && header) {
    const button = document.createElement('button'); button.className = 'settings-launch'; button.type = 'button'; button.setAttribute('aria-label', '设置'); button.title = '设置';
    button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 3-1 3-3 1v4l-2 1 2 2v4l3 1 1 2h6l1-2 3-1v-4l2-2-2-1V7l-3-1-1-3H9Z"/><circle cx="12" cy="12" r="3"/></svg>';
    button.addEventListener('click', () => openState ? close() : open()); header.appendChild(button);
  }
  window.RabbitSettings = Object.freeze({ open, close: () => close(), toggle: () => openState ? close() : open(),
    applySettings: value => { saved = normalize(value); if (!openState) draft = copySettings(saved); promptStore.commit(saved.prompts); return applySettings(saved); }, ready,
    getSnapshot: () => ({ open: openState, saving, recording, tab: ['model', 'appearance', 'general', 'prompts'][activeTab], settings: copySettings(saved), draft: copySettings(draft), palette: { ...palette, sphere: [...palette.sphere] } }) });
})();
