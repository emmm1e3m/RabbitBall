import { nativeImage, type NativeImage } from 'electron';
import { deflateSync } from 'node:zlib';

type Color = [number, number, number];
const white: Color = [255, 255, 255];

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type);
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length, 0);
  name.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([name, data])), data.length + 8);
  return result;
}

function rgb(hex: string): Color {
  return [1, 3, 5].map(index => Number.parseInt(hex.slice(index, index + 2), 16)) as Color;
}

function capsule(x: number, y: number, cx: number, cy: number, width: number, height: number, angle = 0): boolean {
  const radians = angle * Math.PI / 180;
  const dx = x - cx, dy = y - cy;
  const localX = dx * Math.cos(radians) + dy * Math.sin(radians);
  const localY = -dx * Math.sin(radians) + dy * Math.cos(radians);
  return Math.hypot(localX, Math.max(0, Math.abs(localY) - (height - width) / 2)) <= width / 2;
}

// 托盘图标直接从两种用户颜色绘制，缩小后仍保留白边、短耳和眼睛。
export function createTrayIcon(bodyHex: string, eyeHex: string): NativeImage {
  const body = rgb(bodyHex), eye = rgb(eyeHex);
  const ear = body.map((value, index) => Math.round(value * 0.32 + white[index]! * 0.68)) as Color;
  const size = 32, samples = 4;
  const rows = Buffer.alloc((size * 4 + 1) * size);
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      const sum = [0, 0, 0, 0];
      for (let sy = 0; sy < samples; sy++) for (let sx = 0; sx < samples; sx++) {
        const x = column + (sx + 0.5) / samples, y = row + (sy + 0.5) / samples;
        let color: Color | undefined;
        const radius = Math.hypot(x - 16, y - 20);
        if (radius <= 11.4) color = white;
        if (radius <= 10.15) color = body;
        if (capsule(x, y, 13, 7.5, 3.7, 8.2, 15) || capsule(x, y, 19.5, 7.8, 3.7, 8.2, 30)) color = ear;
        if (capsule(x, y, 12.7, 17.1, 1.9, 3.1) || capsule(x, y, 17.2, 17.1, 1.9, 3.1)) color = eye;
        const angle = Math.atan2(y - 20, x - 16);
        if ((Math.abs(radius - 8.8) < 0.55 && angle > 0.11 && angle < 0.91) || Math.hypot(x - 24.6, y - 18) < 0.65) color = white;
        if (color) { for (let channel = 0; channel < 3; channel++) sum[channel]! += color[channel]!; sum[3]! += 255; }
      }
      const index = row * (size * 4 + 1) + 1 + column * 4;
      const alpha = sum[3]! / (samples * samples);
      for (let channel = 0; channel < 3; channel++) rows[index + channel] = alpha ? Math.round(sum[channel]! * 255 / sum[3]!) : 0;
      rows[index + 3] = Math.round(alpha);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
  return nativeImage.createFromBuffer(png);
}
