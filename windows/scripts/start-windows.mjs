import { execFile, spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';

const directory = path.resolve(import.meta.dirname, '../release/win-unpacked');
const executable = path.join(directory, 'RabbitBall.exe');
const releaseDirectory = path.resolve(directory, '..') + path.sep;
const quitOnly = process.argv.includes('--quit-only');
const execute = promisify(execFile);
// 规范化后的完整路径必须位于本项目 release 内，结尾分隔符排除同名前缀目录。
const running = `@(Get-CimInstance Win32_Process -Filter "Name = 'RabbitBall.exe' OR Name = 'electron.exe'" | Where-Object { $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath).StartsWith($env:RABBITBALL_START_RELEASE, [StringComparison]::OrdinalIgnoreCase) })`;

async function powershell(source) {
  return execute('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference = 'Stop'\n${source}`], {
    windowsHide: true,
    env: { ...process.env, RABBITBALL_START_RELEASE: releaseDirectory },
    timeout: 20000,
  });
}

function launch(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: directory, detached: true, windowsHide: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

async function main() {
  const { stdout } = await powershell(`[Console]::Write((${running}).Count)`);
  const hasRunningVersion = Number(stdout.trim()) > 0;
  if (hasRunningVersion || !quitOnly) await access(executable).catch(() => { throw new Error('请先执行 npm run pack:win 生成 Windows 版兔球。'); });
  if (hasRunningVersion) {
    console.log('正在退出旧版兔球并保存对话…');
    await launch(['--rabbitball-quit']);
    const { stdout: stopped } = await powershell(`
$deadline = [DateTime]::UtcNow.AddSeconds(15)
while ((${running}).Count -gt 0) {
    if ([DateTime]::UtcNow -ge $deadline) { [Console]::Write('timeout'); exit 0 }
    Start-Sleep -Milliseconds 200
}
[Console]::Write('stopped')`);
    if (stopped.trim() !== 'stopped') throw new Error('旧版兔球未响应退出请求，已停止启动新版。请从旧版托盘菜单退出后重试；旧版可能尚不支持自动退出。');
  }
  if (quitOnly) { console.log(hasRunningVersion ? '旧版兔球已退出。' : '本项目没有正在运行的兔球。'); return; }
  // 等历史记录落盘、进程退出后，再启动带正式兔球图标的新版。
  await launch([]);
  console.log('已启动新版兔球。');
}

await main().catch(error => { console.error(error.message); process.exitCode = 1; });
