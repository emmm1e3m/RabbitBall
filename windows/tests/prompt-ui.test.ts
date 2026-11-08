import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { DEFAULT_PROMPTS } from '../electron/prompts.ts';

function prompts() {
  const listeners = new Map<string, (event: unknown) => void>();
  const window: any = { RabbitPromptDefaults: DEFAULT_PROMPTS };
  vm.runInNewContext(readFileSync(new URL('../prototype/prompts.js', import.meta.url), 'utf8'), {
    window, document: { addEventListener: (name: string, listener: (event: unknown) => void) => listeners.set(name, listener) },
  });
  return {
    api: window.RabbitPrompts,
    settings(type: string, values: Record<string, string>) { listeners.get(type)?.({ detail: { settings: { prompts: values } } }); },
  };
}

test('前端功能与附件默认文字来自同一默认源，并读取最新已保存配置', () => {
  const page = prompts();
  assert.equal(page.api.get().search, DEFAULT_PROMPTS.search);
  assert.equal(page.api.attachment(), DEFAULT_PROMPTS.fallback);
  page.settings('settings:saved', { search: '只查相关论文。', fallback: '解释附件。' });
  assert.equal(page.api.get().search, '只查相关论文。');
  assert.equal(page.api.attachment(), '解释附件。');
  assert.equal(page.api.get().extract, DEFAULT_PROMPTS.extract);
  assert.equal(page.api.shortcut, undefined);
});

test('草稿预览不提交提示词；空覆盖集恢复默认且默认字符串不被复制为永久覆盖', () => {
  const page = prompts();
  page.api.commit({ search: '原有设置。' });
  page.settings('settings:change', { search: '未保存草稿。' });
  assert.equal(page.api.get().search, '原有设置。');
  const overrides = page.api.overrides({ ...DEFAULT_PROMPTS, system: '自定义系统指令。' });
  assert.equal(JSON.stringify(overrides), JSON.stringify({ system: '自定义系统指令。' }));
  page.settings('settings:saved', {});
  assert.equal(page.api.get().search, DEFAULT_PROMPTS.search);
  assert.equal(JSON.stringify(page.api.overrides(DEFAULT_PROMPTS)), '{}');
});

test('提示词保留换行与特殊字符，读取快照不会修改已保存值', () => {
  const page = prompts(), text = '第一行\n\n$F=ma$ <example> 末尾空格  ';
  page.api.commit({ extract: text });
  assert.equal(page.api.get().extract, text);
  const snapshot = page.api.get(); snapshot.extract = '外部修改';
  assert.equal(page.api.get().extract, text);
  assert.equal(Object.isFrozen(page.api.defaults), true);
});
