import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveGraphDirectory } from '../electron/graph-location.ts';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), 'rabbitball-graph-location-'));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const userData = path.join(directory, 'user-data'), documents = path.join(directory, 'documents');
  const legacy = path.join(userData, 'knowledge'), destination = path.join(documents, 'RabbitBall', '知识图谱');
  await mkdir(userData); await mkdir(documents);
  return { directory, userData, documents, legacy, destination };
}

test('首次迁移保留全部工作区编号、Markdown、图片和旁存，旧目录保持不变', async t => {
  const { userData, documents, legacy, destination } = await fixture(t);
  const files = new Map<string, string | Buffer>([
    ['index.json', '{"lastWorkspaceId":"workspace-1"}'],
    ['workspace-1/document.md', '# 物理阅读\n\n## 图谱\n\n![截图](assets/screen.png)\n'],
    ['workspace-1/state.json', '{"id":"workspace-1","revision":7}'],
    ['workspace-1/assets/screen.png', Buffer.from([137, 80, 78, 71, 0, 1, 2])],
    ['workspace-2/document.md', '# 第二份手稿\n正文与批注原样保留\n'],
  ]);
  for (const [relative, content] of files) {
    const file = path.join(legacy, relative); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, content);
  }
  assert.equal(await resolveGraphDirectory(userData, documents), destination);
  for (const [relative, content] of files) {
    const expected = Buffer.isBuffer(content) ? content : Buffer.from(content);
    assert.deepEqual(await readFile(path.join(destination, relative)), expected);
    assert.deepEqual(await readFile(path.join(legacy, relative)), expected);
  }
  assert.deepEqual(await readdir(path.dirname(destination)), ['知识图谱']);
});

test('已有新库优先，旧库变化不再导入，也不要求旧库仍有效', async t => {
  const { userData, documents, legacy, destination } = await fixture(t);
  await mkdir(destination, { recursive: true });
  await writeFile(path.join(destination, 'existing.md'), '新库手稿');
  await writeFile(legacy, '旧路径已不是目录');
  assert.equal(await resolveGraphDirectory(userData, documents), destination);
  assert.deepEqual(await readdir(destination), ['existing.md']);
  assert.equal(await readFile(path.join(destination, 'existing.md'), 'utf8'), '新库手稿');
});

test('没有旧库时建立唯一新目录，之后直接使用同一目录', async t => {
  const { userData, documents, destination } = await fixture(t);
  assert.equal(await resolveGraphDirectory(userData, documents), destination);
  assert.ok((await stat(destination)).isDirectory());
  await writeFile(path.join(destination, 'kept.md'), '已保存');
  assert.equal(await resolveGraphDirectory(userData, documents), destination);
  assert.equal(await readFile(path.join(destination, 'kept.md'), 'utf8'), '已保存');
});

test('旧路径异常会中止迁移，不用空库掩盖原始数据', async t => {
  const { userData, documents, legacy, destination } = await fixture(t);
  await writeFile(legacy, '必须保留的原始数据');
  await assert.rejects(resolveGraphDirectory(userData, documents), /不是文件夹/);
  await assert.rejects(stat(destination), { code: 'ENOENT' });
  assert.equal(await readFile(legacy, 'utf8'), '必须保留的原始数据');
});

test('目标路径不可创建时抛错并保留旧库，已有同名文件也不会被覆盖', async t => {
  const { userData, documents, legacy, destination } = await fixture(t);
  await mkdir(legacy); await writeFile(path.join(legacy, 'original.md'), '唯一原稿');
  await writeFile(path.dirname(destination), '阻挡路径的现有文件');
  await assert.rejects(resolveGraphDirectory(userData, documents));
  assert.equal(await readFile(path.join(legacy, 'original.md'), 'utf8'), '唯一原稿');
  assert.equal(await readFile(path.dirname(destination), 'utf8'), '阻挡路径的现有文件');
  await rm(path.dirname(destination)); await mkdir(path.dirname(destination)); await writeFile(destination, '同名文件');
  await assert.rejects(resolveGraphDirectory(userData, documents), /不是文件夹/);
  assert.equal(await readFile(destination, 'utf8'), '同名文件');
});
