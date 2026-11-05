(() => {
  'use strict';
  const defaults = Object.freeze({ ...window.RabbitPromptDefaults });
  const keys = Object.keys(defaults);
  function resolve(values = {}) {
    const result = {};
    for (const key of keys) result[key] = typeof values[key] === 'string' && values[key].trim() ? values[key] : defaults[key];
    return result;
  }
  function overrides(values = {}) {
    const result = {};
    for (const key of keys) if (typeof values[key] === 'string' && values[key] !== defaults[key]) result[key] = values[key];
    return result;
  }
  let current = resolve();
  const commit = values => { current = resolve(values); return { ...current }; };
  const sync = event => commit(event.detail.settings.prompts);
  document.addEventListener('settings:saved', sync);
  window.RabbitPrompts = Object.freeze({
    defaults, resolve, overrides, commit, get: () => ({ ...current }),
    attachment: () => current.fallback
  });
})();
