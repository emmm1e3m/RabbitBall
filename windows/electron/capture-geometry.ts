export interface CapturePoint { x: number; y: number }
export interface CaptureRect extends CapturePoint { width: number; height: number }

export function unionBounds(rectangles: readonly CaptureRect[]): CaptureRect {
  const x = Math.min(...rectangles.map(rect => rect.x));
  const y = Math.min(...rectangles.map(rect => rect.y));
  const right = Math.max(...rectangles.map(rect => rect.x + rect.width));
  const bottom = Math.max(...rectangles.map(rect => rect.y + rect.height));
  return { x, y, width: right - x, height: bottom - y };
}

// 每屏独立投影，允许超出本屏的部分由窗口裁切；不能对混合 DPI 桌面使用单一比例。
export function viewportRect(rect: CaptureRect, physicalBounds: CaptureRect, bounds: CaptureRect): CaptureRect {
  return {
    x: (rect.x - physicalBounds.x) * bounds.width / physicalBounds.width,
    y: (rect.y - physicalBounds.y) * bounds.height / physicalBounds.height,
    width: rect.width * bounds.width / physicalBounds.width,
    height: rect.height * bounds.height / physicalBounds.height,
  };
}

// 所有裁图运算先使用物理坐标，只在展示拖框时转换成 DIP。
export function selectionRect(start: CapturePoint, end: CapturePoint, bounds: CaptureRect): CaptureRect | undefined {
  const left = Math.max(bounds.x, Math.min(start.x, end.x));
  const top = Math.max(bounds.y, Math.min(start.y, end.y));
  const right = Math.min(bounds.x + bounds.width, Math.max(start.x, end.x));
  const bottom = Math.min(bounds.y + bounds.height, Math.max(start.y, end.y));
  return right > left && bottom > top ? { x: left, y: top, width: right - left, height: bottom - top } : undefined;
}

export function imageCropRect(rect: CaptureRect, bounds: CaptureRect, size: { width: number; height: number }): CaptureRect {
  const left = Math.max(0, Math.floor((rect.x - bounds.x) / bounds.width * size.width));
  const top = Math.max(0, Math.floor((rect.y - bounds.y) / bounds.height * size.height));
  const right = Math.min(size.width, Math.ceil((rect.x + rect.width - bounds.x) / bounds.width * size.width));
  const bottom = Math.min(size.height, Math.ceil((rect.y + rect.height - bounds.y) / bounds.height * size.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}
