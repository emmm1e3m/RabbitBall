import { randomUUID } from 'node:crypto';
import type { Clipboard, ClipboardItem } from 'electron';

const AUTO_SCREENSHOT = 'web application/x.rabbitball-auto-screenshot';

export interface PasteContent {
  text?: string;
  imageDataUrl?: string;
}

export type ClipboardSnapshot = Promise<PasteContent | null>;
type ClipboardPort = Pick<Clipboard, 'read' | 'write'>;
type MakeItem = (data: Record<string, string | Blob>) => ClipboardItem;

async function content(items: ClipboardItem[]): Promise<PasteContent> {
  const text = items.find(item => item.types.includes('text/plain'));
  if (text) return { text: await (await text.getType('text/plain')).text() };
  const image = items.find(item => item.types.includes('image/png'));
  if (image) {
    const png = await image.getType('image/png');
    return { imageDataUrl: `data:image/png;base64,${Buffer.from(await png.arrayBuffer()).toString('base64')}` };
  }
  return {};
}

async function marker(items: ClipboardItem[]): Promise<string | undefined> {
  const item = items.find(value => value.types.includes(AUTO_SCREENSHOT));
  return item ? (await item.getType(AUTO_SCREENSHOT)).text() : undefined;
}

export class ClipboardStore {
  private operations: Promise<unknown> = Promise.resolve();
  private automatic: { token: string; original: PasteContent } | undefined;

  private readonly clipboard: ClipboardPort;
  private readonly makeItem: MakeItem;

  constructor(clipboard: ClipboardPort, makeItem: MakeItem) {
    this.clipboard = clipboard; this.makeItem = makeItem;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operations.then(operation);
    this.operations = result.catch(() => {});
    return result;
  }

  private async read(): Promise<PasteContent> {
    const items = await this.clipboard.read();
    if (this.automatic && await marker(items) === this.automatic.token) return { ...this.automatic.original };
    return content(items);
  }

  beginActivation(): ClipboardSnapshot {
    // 立即排入读取，原内容只驻留内存；失败时禁止用截图覆盖无法保留的内容。
    return this.enqueue(() => this.read()).catch(() => null);
  }

  writeScreenshot(png: Uint8Array, snapshot: ClipboardSnapshot, shouldWrite: () => boolean = () => true): Promise<void> {
    return this.enqueue(async () => {
      if (!shouldWrite()) return;
      const original = await snapshot;
      if (original === null) throw new Error('未能保留激活前的剪贴板，截图未自动复制。');
      const items = await this.clipboard.read();
      // 用户在截图完成前又复制过内容时，保存最新内容；连续截图沿用激活前的原内容。
      const latest = this.automatic && await marker(items) === this.automatic.token ? this.automatic.original : await content(items);
      if (!shouldWrite()) return;
      const token = randomUUID();
      await this.clipboard.write([this.makeItem({
        'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }),
        [AUTO_SCREENSHOT]: token,
      })]);
      this.automatic = { token, original: latest };
    });
  }

  readForPaste(): Promise<PasteContent> {
    // 右键和快捷键共用此入口，不临时改写系统剪贴板，也不轮询。
    return this.enqueue(() => this.read());
  }
}
