import { nativeImage, type NativeImage } from 'electron';
import type { CaptureImage } from './contracts.js';

function segmentDistance(x: number, y: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1, dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - x1 - t * dx, y - y1 - t * dy);
}

// Windows 的 N32 bitmap 为预乘 BGRA；仅修改指针周围的空心标记，保留中心文字。
export function markCaptureCursor(image: NativeImage, cursor: NonNullable<CaptureImage['cursor']>, eyeColor: string): NativeImage {
  if (!cursor.inside) return image;
  const { width, height } = image.getSize(1);
  const bitmap = image.toBitmap({ scaleFactor: 1 });
  const color = [1, 3, 5].map(index => Number.parseInt(eyeColor.slice(index, index + 2), 16));
  const blend = (index: number, rgb: number[], alpha: number) => {
    if (alpha <= 0) return;
    bitmap[index] = Math.round(rgb[2]! * alpha + bitmap[index]! * (1 - alpha));
    bitmap[index + 1] = Math.round(rgb[1]! * alpha + bitmap[index + 1]! * (1 - alpha));
    bitmap[index + 2] = Math.round(rgb[0]! * alpha + bitmap[index + 2]! * (1 - alpha));
    bitmap[index + 3] = Math.round(255 * alpha + bitmap[index + 3]! * (1 - alpha));
  };
  for (let y = Math.max(0, cursor.y - 25); y <= Math.min(height - 1, cursor.y + 25); y++) {
    for (let x = Math.max(0, cursor.x - 25); x <= Math.min(width - 1, cursor.x + 25); x++) {
      const dx = x - cursor.x, dy = y - cursor.y;
      const distance = Math.min(
        Math.abs(Math.hypot(dx, dy) - 11) - 1.1,
        segmentDistance(dx, dy, 16, 0, 21, 0) - 1,
        segmentDistance(dx, dy, -16, 0, -21, 0) - 1,
        segmentDistance(dx, dy, 0, 16, 0, 21) - 1,
        segmentDistance(dx, dy, 0, -16, 0, -21) - 1,
      );
      const index = (y * width + x) * 4;
      blend(index, [255, 255, 255], Math.max(0, Math.min(1, 1.9 - distance)));
      blend(index, color, Math.max(0, Math.min(1, 0.5 - distance)));
    }
  }
  return nativeImage.createFromBitmap(bitmap, { width, height, scaleFactor: 1 });
}
