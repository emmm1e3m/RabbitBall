const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');

const workspace = path.resolve(__dirname, '../..');
const assets = path.join(workspace, 'assets');
const windowsIcons = path.join(workspace, 'windows/resources/icons');
const androidRes = path.join(workspace, 'android/app/src/main/res');

function ico(images) {
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, index) => {
    const entry = 6 + index * 16;
    header[entry] = size === 256 ? 0 : size;
    header[entry + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map(image => image.png)]);
}

async function renderSvg(window, svg) {
  // Canvas 从 SVG 原样光栅化，透明区域不会混入窗口合成背景。
  const svgUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  const pngUrl = await window.webContents.executeJavaScript(`new Promise((resolve,reject) => { const image=new Image(); image.onload=()=>{const canvas=document.createElement('canvas');canvas.width=1024;canvas.height=1024;canvas.getContext('2d').drawImage(image,0,0,1024,1024);resolve(canvas.toDataURL('image/png'));};image.onerror=reject;image.src=${JSON.stringify(svgUrl)}; })`);
  const master = nativeImage.createFromDataURL(pngUrl).resize({ width: 512, height: 512, quality: 'best' });
  const pixels = master.toBitmap();
  if (pixels[3] !== 0 || pixels[(512 * 511 + 511) * 4 + 3] !== 0) throw new Error('图标背景必须透明');
  return master;
}

app.whenReady().then(async () => {
  const source = await fs.readFile(path.join(workspace, 'windows/prototype/rabbit-character.svg'), 'utf8');
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  await window.loadURL('about:blank');
  if (!process.argv.includes('--android-only')) {
    await fs.mkdir(assets, { recursive: true });
    await fs.mkdir(windowsIcons, { recursive: true });
    // 共用桌面角色的默认姿态，不改变 Windows 已定稿图标的留白与比例。
    const svg = source.replace('width="360" height="400" viewBox="0 0 360 400"', 'width="512" height="512" viewBox="4 50 352 352"');
    await fs.writeFile(path.join(assets, 'rabbitball.svg'), svg);
    const master = await renderSvg(window, svg);
    await fs.writeFile(path.join(assets, 'rabbitball.png'), master.toPNG());
    const png256 = master.resize({ width: 256, height: 256, quality: 'best' }).toPNG();
    await fs.writeFile(path.join(assets, 'rabbitball-256.png'), png256);
    const icoBuffer = ico([16, 24, 32, 48, 64, 128, 256].map(size => ({ size, png: master.resize({ width: size, height: size, quality: 'best' }).toPNG() })));
    await fs.writeFile(path.join(assets, 'rabbitball.ico'), icoBuffer);
    await fs.writeFile(path.join(windowsIcons, 'rabbitball.png'), png256);
    await fs.writeFile(path.join(windowsIcons, 'rabbitball.ico'), icoBuffer);
  }
  // Android 以球心 (180,240) 为画布中心，耳朵完整落在 66dp 圆形安全区内。
  // 现有 16.67% inset 将这张前景映射到 adaptive 图层中的 72×72dp。
  const androidSvg = source.replace('width="360" height="400" viewBox="0 0 360 400"', 'width="512" height="512" viewBox="-8 52 376 376"');
  const androidMaster = await renderSvg(window, androidSvg);
  const androidPixels = androidMaster.toBitmap();
  const safeRadius = 512 * 33 / 72;
  let furthestPixel = 0;
  for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) {
    if (androidPixels[(y * 512 + x) * 4 + 3]) furthestPixel = Math.max(furthestPixel, Math.hypot(x + .5 - 256, y + .5 - 256));
  }
  if (furthestPixel > safeRadius) throw new Error('Android 图标超出圆形安全区');
  const androidForeground = path.join(androidRes, 'drawable-nodpi');
  await fs.mkdir(androidForeground, { recursive: true });
  await fs.writeFile(path.join(androidForeground, 'rabbitball_icon.png'), androidMaster.toPNG());
  window.destroy();
  console.log(`Android 球心=(256,256)，最远可见像素半径=${furthestPixel.toFixed(2)}px，安全区半径=${safeRadius.toFixed(2)}px`);
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
