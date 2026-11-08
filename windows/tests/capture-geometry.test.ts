import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imageCropRect, selectionRect, unionBounds, viewportRect } from '../electron/capture-geometry.ts';

test('不同缩放与负坐标屏幕用物理并集跨屏裁图', () => {
  const left = { x: -1920, y: -200, width: 1920, height: 1080 };
  const right = { x: 0, y: 0, width: 3840, height: 2160 };
  const bounds = unionBounds([left, right]);
  assert.deepEqual(bounds, { x: -1920, y: -200, width: 5760, height: 2360 });
  const rect = selectionRect({ x: -500, y: 100 }, { x: 1200, y: 900 }, bounds)!;
  assert.deepEqual(rect, { x: -500, y: 100, width: 1700, height: 800 });
  assert.deepEqual(imageCropRect(rect, bounds, bounds), { x: 1420, y: 300, width: 1700, height: 800 });
});

test('同一跨屏物理选区分别投影到100%与200%窗口，不用全局比例', () => {
  const rect = { x: -500, y: 100, width: 1700, height: 800 };
  assert.deepEqual(viewportRect(rect, { x: -1920, y: -200, width: 1920, height: 1080 }, { x: -1920, y: -200, width: 1920, height: 1080 }),
    { x: 1420, y: 300, width: 1700, height: 800 });
  assert.deepEqual(viewportRect(rect, { x: 0, y: 0, width: 3840, height: 2160 }, { x: 0, y: 0, width: 1920, height: 1080 }),
    { x: -250, y: 50, width: 850, height: 400 });
});

test('负坐标显示器上的选区保持物理偏移', () => {
  const monitor = { x: -3840, y: -2160, width: 3840, height: 2160 };
  const rect = selectionRect({ x: -3650, y: -2040 }, { x: -2900, y: -1440 }, monitor);
  assert.deepEqual(rect, { x: -3650, y: -2040, width: 750, height: 600 });
  assert.deepEqual(imageCropRect(rect!, monitor, { width: 1920, height: 1080 }), { x: 95, y: 60, width: 375, height: 300 });
});

test('逆向拖动与正向拖动生成同一个选区', () => {
  const monitor = { x: 0, y: 0, width: 400, height: 400 };
  assert.deepEqual(selectionRect({ x: 100, y: 200 }, { x: 30, y: 40 }, monitor),
    selectionRect({ x: 30, y: 40 }, { x: 100, y: 200 }, monitor));
});

test('跨显示器拖动只裁剪冻结显示器内的部分', () => {
  const monitor = { x: 1920, y: 0, width: 2560, height: 1440 };
  const rect = selectionRect({ x: 1800, y: -100 }, { x: 5000, y: 1600 }, monitor);
  assert.deepEqual(rect, monitor);
  assert.deepEqual(imageCropRect(rect!, monitor, { width: 1280, height: 720 }), { x: 0, y: 0, width: 1280, height: 720 });
});

test('下采样图片裁剪使用真实图像比例并保留边缘像素', () => {
  const monitor = { x: 0, y: 0, width: 3840, height: 2160 };
  const rect = selectionRect({ x: 150, y: 75 }, { x: 1050, y: 675 }, monitor);
  assert.deepEqual(imageCropRect(rect!, monitor, { width: 1920, height: 1080 }), { x: 75, y: 37, width: 450, height: 301 });
});

test('完全在显示器外与零面积拖动不生成裁图', () => {
  const monitor = { x: 0, y: 0, width: 1920, height: 1080 };
  assert.equal(selectionRect({ x: -200, y: 50 }, { x: -20, y: 90 }, monitor), undefined);
  assert.equal(selectionRect({ x: 20, y: 50 }, { x: 20, y: 90 }, monitor), undefined);
});

test('非整数缩放比例的显示器边缘不会越出原图', () => {
  const monitor = { x: -1706, y: -300, width: 1706, height: 960 };
  const rect = selectionRect({ x: -10, y: 650 }, { x: 20, y: 700 }, monitor);
  const crop = imageCropRect(rect!, monitor, { width: 1024, height: 576 });
  assert.ok(crop.x >= 0 && crop.y >= 0 && crop.width > 0 && crop.height > 0);
  assert.equal(crop.x + crop.width, 1024);
  assert.equal(crop.y + crop.height, 576);
});
