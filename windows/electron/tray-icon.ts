import { app, nativeImage, type NativeImage } from 'electron';
import path from 'node:path';

// 托盘与程序图标共用默认兔球形态，透明区域保留原轮廓。
export function createTrayIcon(): NativeImage {
  return nativeImage.createFromPath(path.join(app.getAppPath(), 'resources', 'icons', 'rabbitball.png'))
    .resize({ width: 32, height: 32, quality: 'best' });
}
