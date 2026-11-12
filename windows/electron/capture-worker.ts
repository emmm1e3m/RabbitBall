import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { CaptureRect } from './capture-geometry.js';

export interface NativeCaptureResult {
  handle: string;
  title: string;
  processId: number;
  appName?: string;
  processName?: string;
  bounds: CaptureRect;
  cursor: { x: number; y: number };
  imageBase64?: string;
  imageWidth?: number;
  imageHeight?: number;
  captureError?: string;
  desktopBitmap?: Buffer;
  desktopWidth?: number;
  desktopHeight?: number;
  desktopError?: string;
}

type CaptureRequest = { type: 'window'; backgroundBounds?: CaptureRect } | { type: 'desktop'; bounds: CaptureRect };

// 截图阻塞操作独立于低级键鼠钩子；一个按需恢复的常驻进程复用编译结果。
export class CaptureWorker {
  private child?: ChildProcessWithoutNullStreams;
  private starting?: Promise<void>;
  private fail?: (error: Error) => void;
  private pending?: { id: string; resolve(result: NativeCaptureResult): void; reject(error: Error): void };
  private stopped = false;

  prepare(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('截图助手已关闭。'));
    if (this.starting) return this.starting;
    const script = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'active-window.ps1'), 'utf8').replace(/^\uFEFF/, '');
    const bootstrap = '$source=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::ReadLine())); & ([ScriptBlock]::Create($source)) -IgnoreProcessId ' + process.pid;
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', bootstrap], { windowsHide: true, stdio: 'pipe' });
    this.child = child;
    this.starting = new Promise<void>((resolve, reject) => {
      let ready = false;
      let header: Buffer[] = [];
      let payload: { event: { requestId: string; result: NativeCaptureResult }; remaining: number; chunks: Buffer[] } | undefined;
      const timer = setTimeout(() => failure(new Error('截图助手启动超时。')), 8000);
      const failure = (error: Error) => {
        if (this.child !== child) return;
        clearTimeout(timer);
        this.child = undefined;
        this.starting = undefined;
        this.fail = undefined;
        const pending = this.pending;
        this.pending = undefined;
        child.kill();
        pending?.reject(error);
        if (!ready) reject(error);
      };
      this.fail = failure;
      const finishResult = (event: { requestId: string; result?: NativeCaptureResult; error?: string }) => {
        if (!this.pending || event.requestId !== this.pending.id) throw new Error('截图助手响应无效。');
        const pending = this.pending; this.pending = undefined;
        if (event.error) pending.reject(new Error(event.error));
        else pending.resolve(event.result!);
      };
      child.stdout.on('data', (chunk: Buffer) => {
        if (this.child !== child) return;
        try {
          let offset = 0;
          while (offset < chunk.length) {
            if (payload) {
              const length = Math.min(payload.remaining, chunk.length - offset);
              payload.chunks.push(chunk.subarray(offset, offset + length));
              offset += length; payload.remaining -= length;
              if (!payload.remaining) {
                payload.event.result.desktopBitmap = Buffer.concat(payload.chunks);
                finishResult(payload.event); payload = undefined;
              }
              continue;
            }
            const separator = chunk.indexOf(10, offset);
            if (separator === -1) { header.push(chunk.subarray(offset)); break; }
            const line = Buffer.concat([...header, chunk.subarray(offset, separator)]).toString('utf8').trim();
            header = []; offset = separator + 1;
            if (!line) continue;
            const event = JSON.parse(line);
            if (event.type === 'ready' && !ready) { ready = true; clearTimeout(timer); resolve(); }
            else if (event.type === 'result') {
              if (event.bitmapBytes !== undefined) {
                const bytes = event.result.desktopWidth * event.result.desktopHeight * 4;
                if (!Number.isSafeInteger(bytes) || bytes <= 0 || event.bitmapBytes !== bytes) throw new Error('截图像素范围无效。');
                payload = { event, remaining: bytes, chunks: [] };
              } else finishResult(event);
            } else { failure(new Error('截图助手响应无效。')); return; }
          }
        } catch { failure(new Error('截图助手响应无效。')); }
      });
      // 错误由 exit/error 统一结束请求；持续排空 stderr，避免管道写满。
      child.stderr.resume();
      child.stdin.on('error', () => failure(new Error('截图助手连接已中断。')));
      child.on('error', error => failure(error));
      child.on('exit', () => failure(new Error('截图助手已退出。')));
      child.stdin.write(Buffer.from(script, 'utf8').toString('base64') + '\n');
    });
    return this.starting;
  }

  async capture(request: CaptureRequest, signal: AbortSignal): Promise<NativeCaptureResult> {
    signal.throwIfAborted();
    await this.prepare();
    signal.throwIfAborted();
    if (this.pending) throw new Error('已有截图正在进行。');
    return new Promise<NativeCaptureResult>((resolve, reject) => {
      const id = randomUUID();
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
      // 取消时结束正在采集像素的助手，不让旧请求拖住下一次截图。
      const abort = () => this.fail?.(new Error('截图已取消。'));
      const timer = setTimeout(() => this.fail?.(new Error('读取窗口超时，请稍后重试。')), 8000);
      this.pending = {
        id,
        resolve: result => { cleanup(); resolve(result); },
        reject: error => { cleanup(); reject(error); },
      };
      signal.addEventListener('abort', abort, { once: true });
      this.child!.stdin.write(JSON.stringify({ ...request, requestId: id }) + '\n');
    });
  }

  stop(): void {
    this.stopped = true;
    this.fail?.(new Error('截图助手已关闭。'));
  }
}
