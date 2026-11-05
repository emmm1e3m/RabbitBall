import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { NativeShortcutKey } from './shortcut.js';

export interface NativeConfiguration {
  pauseOnFullscreen: boolean;
  inputEnabled: boolean;
  recording: boolean;
  shortcut: NativeShortcutKey[];
}

export interface WindowsNative {
  ready: Promise<void>;
  configure(configuration: NativeConfiguration): Promise<void>;
  cancelCapture(captureId: number): void;
  focusWindow(handle: string): Promise<boolean>;
  cancelFocus(): void;
  stop(): void;
}

interface NativeCallbacks {
  onTriggerBegin(captureId: number): void;
  onTriggerHold(captureId: number): void;
  onTriggerEnd(captureId: number): void;
  onTriggerCancel(captureId: number): void;
  onSelectionPointer(captureId: number, phase: 'down' | 'up', point: { x: number; y: number }): void;
  onPointerDown(): void;
  onFullscreen(fullscreen: boolean): void;
  onError(): void;
}

// 键盘拦截、鼠标点击和全屏检测共用一个隐藏进程；只接收语义事件，不传递按键内容。
export function createWindowsNative(callbacks: NativeCallbacks): WindowsNative {
  const script = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'windows-native.ps1'), 'utf8').replace(/^\uFEFF/, '');
  // 脚本经 stdin 首行送入，避免 C# 声明超过 Windows 命令行长度限制，也兼容 asar。
  const bootstrap = '$source=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::ReadLine())); & ([ScriptBlock]::Create($source)) -IgnoreProcessId ' + process.pid;
  const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', bootstrap], { windowsHide: true, stdio: 'pipe' });
  let stopped = false, initialized = false, buffer = '';
  let pendingFocus: { id: string; resolve(focused: boolean): void; timer: ReturnType<typeof setTimeout> } | undefined;
  const configurations = new Map<string, { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  let finish: () => void;
  let fail: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
  const timer = setTimeout(failure, 7000);
  function closeChild(): void {
    // EOF 让原生线程先解除钩子并释放可能回放的 Alt，再由超时兜底终止。
    child.stdin.end();
    const killTimer = setTimeout(() => child.kill(), 1500);
    killTimer.unref();
    child.once('exit', () => clearTimeout(killTimer));
  }
  function failure(): void {
    if (stopped) return;
    stopped = true;
    if (pendingFocus) { clearTimeout(pendingFocus.timer); pendingFocus.resolve(false); pendingFocus = undefined; }
    for (const pending of configurations.values()) { clearTimeout(pending.timer); pending.reject(new Error('全局触发配置未能应用。')); }
    configurations.clear();
    clearTimeout(timer);
    closeChild();
    if (!initialized) fail(new Error('Windows 全局启动键未能启动。'));
    else callbacks.onError();
  }
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    if (stopped) return;
    buffer += chunk;
    let separator: number;
    while ((separator = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, separator).trim(); buffer = buffer.slice(separator + 1);
      if (!line) continue;
      try {
        const event = JSON.parse(line) as { type?: unknown; fullscreen?: unknown; phase?: unknown; x?: unknown; y?: unknown; captureId?: unknown; requestId?: unknown; focused?: unknown };
        const captureId = typeof event.captureId === 'number' && Number.isSafeInteger(event.captureId) && event.captureId > 0 ? event.captureId : undefined;
        if (event.type === 'ready' && !initialized) { initialized = true; clearTimeout(timer); finish(); }
        else if (event.type === 'fullscreen' && typeof event.fullscreen === 'boolean') callbacks.onFullscreen(event.fullscreen);
        else if (event.type === 'trigger-begin' && captureId !== undefined) callbacks.onTriggerBegin(captureId);
        else if (event.type === 'trigger-hold' && captureId !== undefined) callbacks.onTriggerHold(captureId);
        else if (event.type === 'trigger-end' && captureId !== undefined) callbacks.onTriggerEnd(captureId);
        else if (event.type === 'trigger-cancel' && captureId !== undefined) callbacks.onTriggerCancel(captureId);
        else if (event.type === 'selection-pointer' && captureId !== undefined && (event.phase === 'down' || event.phase === 'up') && typeof event.x === 'number' && Number.isFinite(event.x) && typeof event.y === 'number' && Number.isFinite(event.y)) callbacks.onSelectionPointer(captureId, event.phase, { x: event.x, y: event.y });
        else if (event.type === 'pointer-down') callbacks.onPointerDown();
        else if (event.type === 'focus-result' && typeof event.requestId === 'string' && typeof event.focused === 'boolean') {
          if (pendingFocus?.id === event.requestId) { clearTimeout(pendingFocus.timer); pendingFocus.resolve(event.focused); pendingFocus = undefined; }
        }
        else if (event.type === 'configured' && typeof event.requestId === 'string') {
          const pending = configurations.get(event.requestId);
          if (pending) { clearTimeout(pending.timer); configurations.delete(event.requestId); pending.resolve(); }
        }
        else { failure(); return; }
      } catch { failure(); return; }
    }
  });
  child.stdin.on('error', failure);
  child.on('error', failure);
  child.on('exit', failure);
  child.stdin.write(Buffer.from(script, 'utf8').toString('base64') + '\n');
  function cancelFocus(): void {
    if (pendingFocus) { clearTimeout(pendingFocus.timer); pendingFocus.resolve(false); pendingFocus = undefined; }
    if (!stopped) child.stdin.write('{"type":"cancel-focus"}\n');
  }
  return {
    ready,
    configure(configuration) {
      if (stopped) return Promise.reject(new Error('全局触发助手不可用。'));
      const id = randomUUID();
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(failure, 7000); timer.unref();
        configurations.set(id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ type: 'configure', requestId: id, ...configuration }) + '\n');
      });
    },
    cancelCapture(captureId) { if (!stopped) child.stdin.write(JSON.stringify({ type: 'cancel-capture', captureId }) + '\n'); },
    focusWindow(handle) {
      if (stopped) return Promise.resolve(false);
      cancelFocus();
      const id = randomUUID();
      return new Promise<boolean>(resolve => {
        const timer = setTimeout(() => { if (pendingFocus?.id === id) cancelFocus(); }, 3000);
        timer.unref();
        pendingFocus = { id, resolve, timer };
        child.stdin.write(JSON.stringify({ type: 'focus-window', requestId: id, handle }) + '\n');
      });
    },
    cancelFocus,
    stop() { if (stopped) return; cancelFocus(); for (const pending of configurations.values()) { clearTimeout(pending.timer); pending.reject(new Error('全局触发助手已关闭。')); } configurations.clear(); stopped = true; clearTimeout(timer); closeChild(); if (!initialized) finish(); },
  };
}
