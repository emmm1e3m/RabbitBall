import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';

const directory = path.resolve(import.meta.dirname, '../release/win-unpacked');
const executable = path.join(directory, 'RabbitBall.exe');
await access(executable).catch(() => { throw new Error('请先执行 npm run pack:win 生成 Windows 版兔球。'); });
// 启动有兔球图标的正式程序，避免开发用 Electron 外壳出现在任务栏。
const child = spawn(executable, [], { cwd: directory, detached: true, stdio: 'ignore' });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.unref();
