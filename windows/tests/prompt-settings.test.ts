import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';
import { DEFAULT_PROMPTS, normalizePromptOverrides, resolvePrompts } from '../electron/prompts.ts';
import { DEFAULT_ACTIVATION_SHORTCUT, normalizeShortcut } from '../electron/shortcut.ts';
import type { PrivateSettings, PublicSettings } from '../electron/contracts.ts';

interface SettingsStoreView {
  load(): Promise<PublicSettings>;
  save(value: unknown): Promise<PublicSettings>;
  getPublic(): PublicSettings;
  getPrivate(): PrivateSettings;
}

async function settingsFixture(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), 'rabbitball-prompt-settings-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // 使用真实设置层和临时文件；只替换 Electron 边界，不读取用户设置或密钥。
  const source = readFileSync(new URL('../electron/settings.ts', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
  const module = vm.runInNewContext(stripTypeScriptTypes(source) + '\n({SettingsStore})', {
    app: { getPath(name: string) { assert.equal(name, 'userData'); return directory; } },
    safeStorage: new Proxy({}, { get() { throw new Error('无密钥的提示词测试不得调用系统安全存储'); } }),
    readFile, writeFile, mkdir, rename, path, DEFAULT_PROMPTS, normalizePromptOverrides, resolvePrompts,
    DEFAULT_ACTIVATION_SHORTCUT, normalizeShortcut,
    Buffer, URL, process: { platform: 'win32' },
  }) as { SettingsStore: new () => SettingsStoreView };
  const file = path.join(directory, 'settings.json');
  return { Store: module.SettingsStore, file, disk: async () => JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown> };
}

test('历史保留条数默认为十条，接受零和非负安全整数并持久保存', async t => {
  const { Store, disk } = await settingsFixture(t);
  const store = new Store();
  assert.equal((await store.load()).historyLimit, 10);
  for (const historyLimit of [-1, 1.5, '10', '', null, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(store.save({ historyLimit }), /非负整数/);
  }
  assert.equal((await store.save({ historyLimit: 6 })).historyLimit, 6);
  assert.equal((await disk()).historyLimit, 6);
  assert.equal((await new Store().load()).historyLimit, 6);
  assert.equal((await store.save({ historyLimit: 0 })).historyLimit, 0);
  assert.equal((await disk()).historyLimit, 0);
  const reloaded = new Store();
  assert.equal((await reloaded.load()).historyLimit, 0);
  await reloaded.save({ petSize: 1.2 });
  assert.equal((await new Store().load()).historyLimit, 0);
});

test('提示词覆盖保存、未传保留、整组替换和空组恢复默认', async t => {
  const { Store, disk } = await settingsFixture(t);
  const store = new Store();
  assert.deepEqual({ ...(await store.load()).prompts }, DEFAULT_PROMPTS);
  await store.save({ prompts: { system: '自定义系统\n保留换行', search: '自定义搜索' } });
  assert.deepEqual((await disk()).prompts, { system: '自定义系统\n保留换行', search: '自定义搜索' });
  const reloaded = new Store();
  const effective = (await reloaded.load()).prompts;
  assert.equal(effective.system, '自定义系统\n保留换行');
  assert.equal(effective.extract, DEFAULT_PROMPTS.extract);

  await reloaded.save({ petSize: 1.2 });
  assert.deepEqual((await disk()).prompts, { system: '自定义系统\n保留换行', search: '自定义搜索' });
  const replaced = await reloaded.save({ prompts: { translate: '只保留这项覆盖' } });
  assert.equal(replaced.prompts.system, DEFAULT_PROMPTS.system);
  assert.equal(replaced.prompts.search, DEFAULT_PROMPTS.search);
  assert.equal(replaced.prompts.translate, '只保留这项覆盖');
  assert.deepEqual((await disk()).prompts, { translate: '只保留这项覆盖' });

  assert.deepEqual({ ...(await reloaded.save({ prompts: {} })).prompts }, DEFAULT_PROMPTS);
  assert.deepEqual((await disk()).prompts ?? {}, {});
  assert.deepEqual({ ...(await new Store().load()).prompts }, DEFAULT_PROMPTS);
});

test('磁盘仅保存非默认项且无效覆盖不破坏已存设置', async t => {
  const { Store, disk } = await settingsFixture(t);
  const store = new Store();
  await store.save({ prompts: { system: DEFAULT_PROMPTS.system, extract: '忠实提取' } });
  assert.deepEqual((await disk()).prompts, { extract: '忠实提取' });
  const before = await disk();
  await assert.rejects(store.save({ prompts: { search: '  ' } }));
  await assert.rejects(store.save({ prompts: { unknown: '未知项' } }));
  assert.deepEqual(await disk(), before);
  assert.equal(store.getPublic().prompts.extract, '忠实提取');
});

test('公开与私有设置各自克隆提示词，调用方不能改动存储或默认值', async t => {
  const { Store } = await settingsFixture(t);
  const store = new Store();
  await store.save({ prompts: { search: '已保存搜索' } });
  const publicSettings = store.getPublic();
  const privateSettings = store.getPrivate();
  publicSettings.prompts.search = '修改公开副本';
  privateSettings.prompts.system = '修改私有副本';
  assert.equal(store.getPublic().prompts.search, '已保存搜索');
  assert.equal(store.getPrivate().prompts.system, DEFAULT_PROMPTS.system);
  assert.equal(new Store().getPublic().prompts.system, DEFAULT_PROMPTS.system);
});

test('旧设置没有提示词字段时补齐当前默认项', async t => {
  const { Store, file } = await settingsFixture(t);
  await writeFile(file, JSON.stringify({ bodyColor: '#ABCDEF' }), 'utf8');
  const settings = await new Store().load();
  assert.equal(settings.bodyColor, '#ABCDEF');
  assert.deepEqual({ ...settings.prompts }, DEFAULT_PROMPTS);
  assert.deepEqual([...settings.activationShortcut], DEFAULT_ACTIVATION_SHORTCUT);
});

test('触发键默认、规范保存、未传保留与数组副本相互独立', async t => {
  const { Store, disk } = await settingsFixture(t);
  const store = new Store();
  assert.deepEqual([...(await store.load()).activationShortcut], ['AltLeft']);
  const input = ['KeyK', 'ControlRight'];
  const saved = await store.save({ activationShortcut: input });
  assert.deepEqual([...saved.activationShortcut], ['ControlRight', 'KeyK']);
  input.push('ShiftLeft');
  saved.activationShortcut.push('MetaLeft');
  store.getPublic().activationShortcut.push('AltRight');
  store.getPrivate().activationShortcut.push('ShiftRight');
  assert.deepEqual([...store.getPublic().activationShortcut], ['ControlRight', 'KeyK']);
  assert.deepEqual((await disk()).activationShortcut, ['ControlRight', 'KeyK']);
  await store.save({ petSize: 1.1 });
  assert.deepEqual([...(await new Store().load()).activationShortcut], ['ControlRight', 'KeyK']);
  const before = await disk();
  await assert.rejects(store.save({ activationShortcut: ['Escape'] }));
  assert.deepEqual(await disk(), before);
  await store.save({ activationShortcut: [...DEFAULT_ACTIVATION_SHORTCUT] });
  assert.deepEqual([...(await new Store().load()).activationShortcut], ['AltLeft']);
  assert.deepEqual(DEFAULT_ACTIVATION_SHORTCUT, ['AltLeft']);
});


test('工具轮数上限默认3，保存重载有效，拒绝非正整数且不影响已有设置', async t => {
  const {Store,file,disk}=await settingsFixture(t);
  await writeFile(file,JSON.stringify({model:'deepseek-flash'}),'utf8');
  const store=new Store();assert.equal((await store.load()).maxToolRounds,3);
  await store.save({maxToolRounds:7});assert.equal((await disk()).maxToolRounds,7);
  assert.equal((await new Store().load()).maxToolRounds,7);
  for(const invalid of [0,-1,1.5,'4',null,Number.MAX_SAFE_INTEGER+1]) {
    await assert.rejects(store.save({maxToolRounds:invalid}),/正整数/);
    assert.equal(store.getPrivate().maxToolRounds,7);
  }
});

test('内置字体默认关闭，旧配置补齐，开关保存重载且无关更新保留选择', async t => {
  const { Store, file, disk } = await settingsFixture(t);
  assert.equal((await new Store().load()).useBuiltinFont, false);
  await writeFile(file, JSON.stringify({ bodyColor: '#ABCDEF' }), 'utf8');
  const store = new Store();
  assert.equal((await store.load()).useBuiltinFont, false);
  assert.equal((await store.save({ useBuiltinFont: true })).useBuiltinFont, true);
  assert.equal((await disk()).useBuiltinFont, true);
  assert.equal((await new Store().load()).useBuiltinFont, true);
  await store.save({ petSize: 1.2 });
  assert.equal((await new Store().load()).useBuiltinFont, true);
  assert.equal((await store.save({ useBuiltinFont: false })).useBuiltinFont, false);
  assert.equal((await disk()).useBuiltinFont, false);
  assert.equal((await new Store().load()).useBuiltinFont, false);
});

test('内置字体只接受布尔值，无效修改不改变内存或磁盘设置', async t => {
  const { Store, disk } = await settingsFixture(t);
  const store = new Store();
  await store.save({ useBuiltinFont: true, bodyColor: '#ABCDEF' });
  const before = await disk();
  for (const value of [null, 0, 1, 'true', 'false', [], {}]) {
    await assert.rejects(store.save({ useBuiltinFont: value, bodyColor: '#000000' }), /开关设置无效/);
    assert.equal(store.getPublic().useBuiltinFont, true);
    assert.equal(store.getPrivate().bodyColor, '#ABCDEF');
    assert.deepEqual(await disk(), before);
  }
});
