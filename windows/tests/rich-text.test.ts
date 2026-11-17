import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test('真实 Chromium 保留根号与伸缩公式字形，并隔离图标样式和不可信输入', () => {
  const prefix = path.join(path.resolve(tmpdir()), 'rabbitball-rich-text-'), directory = mkdtempSync(prefix);
  try {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const result = spawnSync(createRequire(import.meta.url)('electron'), [fileURLToPath(new URL('./rich-text-browser.cjs', import.meta.url)), directory],
      { env, windowsHide: true, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
    assert.match(result.stdout, /PASS 64 组真实公式渲染/);
  } finally {
    assert.ok(path.resolve(directory).startsWith(prefix));
    rmSync(directory, { recursive: true, force: true });
  }
});
