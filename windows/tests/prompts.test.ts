import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PROMPTS, PROMPT_KEYS, normalizePromptOverrides, resolvePrompts } from '../electron/prompts.ts';
import type { PromptOverrides } from '../electron/contracts.ts';

const expectedKeys = ['system', 'search', 'extract', 'translate', 'fallback', 'searchTool'];

test('功能与搜索工具各仅保留一项提示词，共六项有效配置', () => {
  assert.deepEqual([...PROMPT_KEYS].sort(), [...expectedKeys].sort());
  assert.deepEqual(Object.keys(DEFAULT_PROMPTS).sort(), [...expectedKeys].sort());
  for (const key of PROMPT_KEYS) assert.ok(typeof DEFAULT_PROMPTS[key] === 'string' && DEFAULT_PROMPTS[key].trim().length > 0);
  assert.deepEqual(normalizePromptOverrides(DEFAULT_PROMPTS), {});
});

test('覆盖集必须是对象且不接受数组和空值', () => {
  for (const invalid of [null, undefined, [], 'system', 12, true]) {
    assert.throws(() => normalizePromptOverrides(invalid));
  }
  assert.deepEqual(normalizePromptOverrides({}), {});
});

test('未知键与原型相关键都不能进入覆盖集', () => {
  for (const key of ['unknown', 'constructor', '__proto__', 'toString']) {
    assert.throws(() => normalizePromptOverrides(JSON.parse(JSON.stringify({ [key]: '自定义' }))));
  }
});

test('每项必须是非空白字符串', () => {
  for (const invalid of ['', ' \n\t\r', '\u3000\u00a0', undefined, null, 1, false, [], {}]) {
    assert.throws(() => normalizePromptOverrides({ search: invalid }));
  }
});

test('归一化保留原文空格与换行并剔除等于默认值的项', () => {
  const text = '  自定义第一行\n第二行\r\n  ';
  const input = { system: DEFAULT_PROMPTS.system, search: text };
  assert.deepEqual(normalizePromptOverrides(input), { search: text });
  assert.equal(input.system, DEFAULT_PROMPTS.system);
  assert.equal(input.search, text);
  assert.deepEqual(normalizePromptOverrides(normalizePromptOverrides(input)), { search: text });
});

test('单项上限包含二万字且拒绝超过上限', () => {
  const text = '文'.repeat(20_000);
  assert.deepEqual(normalizePromptOverrides({ search: text }), { search: text });
  assert.throws(() => normalizePromptOverrides({ search: text + '文' }));
});

test('全量有效提示词总长允许八万字且拒绝多一字', () => {
  const exact: PromptOverrides = Object.fromEntries(PROMPT_KEYS.map((key, index) => [key, '文'.repeat(index < 2 ? 20000 : 10000)]));
  assert.equal(Object.values(resolvePrompts(normalizePromptOverrides(exact))).reduce((total, text) => total + text.length, 0), 80_000);
  assert.throws(() => normalizePromptOverrides({ ...exact, extract: exact.extract + '文' }));
});

test('部分覆盖的总长计算包含仍生效的默认文字', () => {
  const changedKeys = ['system', 'search', 'extract', 'translate'] as const;
  const unchangedLength = PROMPT_KEYS.filter(key => !(changedKeys as readonly string[]).includes(key))
    .reduce((total, key) => total + DEFAULT_PROMPTS[key].length, 0);
  const lastLength = 80_000 - unchangedLength - 60_000;
  assert.ok(lastLength > 0 && lastLength <= 20_000);
  const exact = { system: '文'.repeat(20_000), search: '文'.repeat(20_000), extract: '文'.repeat(20_000), translate: '文'.repeat(lastLength) };
  assert.doesNotThrow(() => normalizePromptOverrides(exact));
  assert.throws(() => normalizePromptOverrides({ ...exact, translate: exact.translate + '文' }));
});

test('解析覆盖集返回完整设置且空覆盖恢复默认', () => {
  const overrides = normalizePromptOverrides({ search: '简洁搜索' });
  const resolved = resolvePrompts(overrides);
  assert.deepEqual(Object.keys(resolved).sort(), [...expectedKeys].sort());
  assert.equal(resolved.search, '简洁搜索');
  assert.equal(resolved.system, DEFAULT_PROMPTS.system);
  assert.deepEqual(resolvePrompts(), DEFAULT_PROMPTS);
  assert.deepEqual(resolvePrompts({}), DEFAULT_PROMPTS);
});

test('解析结果互相独立且不会改动默认提示词', () => {
  const first = resolvePrompts();
  const second = resolvePrompts();
  first.system = '只影响本次解析';
  assert.equal(second.system, DEFAULT_PROMPTS.system);
  assert.notEqual(first.system, DEFAULT_PROMPTS.system);
});
