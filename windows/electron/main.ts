import { app, BrowserWindow, clipboard, ClipboardItem, dialog, globalShortcut, ipcMain, Menu, nativeImage, screen, shell, Tray, type IpcMainEvent, type IpcMainInvokeEvent, type NativeImage } from 'electron';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SettingsStore, validateSettingsPatch } from './settings.js';
import { createTrayIcon } from './tray-icon.js';
import { markCaptureCursor } from './capture-marker.js';
import { createWindowsNative, type WindowsNative } from './windows-native.js';
import { createAgentConversation, runAgent, type AgentConversation } from './agent.js';
import { HistoryStore, type HistoryRun } from './history.js';
import { GraphStore } from './graph-store.js';
import { resolveGraphDirectory } from './graph-location.js';
import { GraphJobs, buildGraphChatContext } from './graph-jobs.js';
import type { GraphCaptureRequest, GraphMutation, GraphNodeRequest, GraphWorkspace } from './graph-contracts.js';
import { selectionRect, imageCropRect, unionBounds, type CapturePoint, type CaptureRect } from './capture-geometry.js';
import { CaptureOverlays, type CaptureViewport } from './capture-overlays.js';
import { CaptureWorker } from './capture-worker.js';
import { ActivationEffectWindow } from './activation-effect-window.js';
import { ClipboardStore, type ClipboardSnapshot } from './clipboard.js';
import { nativeShortcut, shortcutToAccelerator, formatShortcut } from './shortcut.js';
import type { Activation, AgentEvent, AgentRequest, Attachment, CaptureContext, CaptureEvent, CaptureImage, CursorPoint, GraphPinInteraction, PointerPoint } from './contracts.js';

const here = path.dirname(fileURLToPath(import.meta.url));
let window: BrowserWindow;
let activationEffect: ActivationEffectWindow | undefined;
let tray: Tray;
let store: SettingsStore;
let historyStore: HistoryStore;
let graphStore: GraphStore;
let graphJobs: GraphJobs;
let graphWorkspaceId: string | undefined;
const graphImageCache = new Map<string, Map<string, string>>();
let quitting = false;
let panelView: Activation['view'] | undefined;
let interactive = false;
let windowMode: { focusable: boolean; ignoreMouse: boolean } | undefined;
let graphPinRegions: Electron.Rectangle[] = [];
let graphPinHover = false;
let graphPinPressed = false;
let activationEpoch = 0;
let promptActivation: { epoch: number; phase: 'pending' | 'ready'; focus?: Promise<boolean> } | undefined;
let suspended = false;
let windowsNative: WindowsNative | undefined;
let shortcutRecording = false;
let recordingReady = Promise.resolve();
let registeredShortcut: string | undefined;
interface NativeCaptureContext extends CaptureContext {
  focusScreenBounds?: Electron.Rectangle;
}
let currentContext: NativeCaptureContext | undefined;
let captureOverlays: CaptureOverlays | undefined;
interface CaptureSession {
  id: string;
  nativeId?: number;
  controller: AbortController;
  viewports: CaptureViewport[];
  physicalBounds: Electron.Rectangle;
  regions: CaptureRect[];
  dragStart?: CapturePoint;
  context?: NativeCaptureContext;
  background?: NativeImage;
  defaultClipboard?: NativeImage;
  clipboardSnapshot: ClipboardSnapshot;
  hasSelection: boolean;
  holdReady: boolean;
  released: boolean;
  visible: boolean;
  finishing: boolean;
  target: 'prompt' | 'graph' | 'images';
  workspaceId?: string;
  graphId?: string;
  owner?: number;
  imageResult?: (images: CaptureImage[] | null) => void;
  fillEmptyGraph?: boolean;
  graphAction?: Activation['graphAction'];
}
let captureSession: CaptureSession | undefined;
let clipboardQueue = Promise.resolve();
const preservedClipboard = new ClipboardStore(clipboard, data => new ClipboardItem(data));
let activeRequest: { id: string; conversationId: string; controller: AbortController; history?: HistoryRun } | undefined;
let currentConversation: { id: string; conversation: AgentConversation } | undefined;
let cursorTimer: ReturnType<typeof setInterval> | undefined;
let petTransitionEpoch = 0;
let petTransition: number | undefined;

function debugWindow(reason: string): void {
  if (process.env.RABBITBALL_WINDOW_DEBUG !== '1' || !window || window.isDestroyed()) return;
  console.info('[RabbitBall window]', JSON.stringify({ reason, view: panelView ?? 'pet', suspended, interactive, visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable(), alwaysOnTop: window.isAlwaysOnTop() }));
}

function applyWindowMode(point?: CursorPoint): void {
  if (!graphPinsAvailable()) graphPinPressed = false;
  graphPinHover = hitsGraphPins(point);
  const available = !quitting && !captureSession && petTransition === undefined && (!suspended || panelView === 'settings');
  // 沿用本体的悬停穿透逻辑；插件只贡献自身命中，不裁剪或隐藏兔球画面。
  const acceptsPointer = panelView === 'graph' || interactive || graphPinHover || graphPinPressed;
  const ignoreMouse = !available || promptActivation?.phase === 'pending' || !acceptsPointer;
  // 可见固定卡提前允许系统点击激活；悬停不主动获取焦点。
  const focusable = petTransition === undefined && !captureSession && (panelView === 'settings' || promptActivation?.phase === 'ready' || graphPinsAvailable() || panelView === undefined && interactive);
  // 几何变化不重复切换未改变的窗口样式。
  if (windowMode?.focusable !== focusable) { window.setFocusable(focusable); window.setSkipTaskbar(true); }
  if (windowMode?.ignoreMouse !== ignoreMouse) window.setIgnoreMouseEvents(ignoreMouse, { forward: true });
  // 避免 floating 级别为绕到任务栏后方而改写原生窗口的 Z 序。
  if (!windowMode) window.setAlwaysOnTop(true, 'screen-saver');
  windowMode = { focusable, ignoreMouse };
}

function mainDisplayAvailable(): boolean {
  return !quitting && !captureSession && petTransition === undefined && (!suspended || panelView === 'settings');
}

function showMainWindow(activate = false): void {
  if (!mainDisplayAvailable()) return;
  if (activate) window.show();
  else window.showInactive();
}

function hideMainWindow(): void {
  window.hide();
}

function raiseMainWindow(): void {
  if (window.isDestroyed() || !window.isVisible()) return;
  window.moveTop();
}

function graphPinsVisible(): boolean {
  return panelView === undefined && !suspended && !quitting && !captureSession && petTransition === undefined && store.getPublic().graphPluginEnabled;
}

function graphPinsAvailable(): boolean {
  return graphPinsVisible() && !!graphPinRegions.length;
}

function hitsGraphPins(point?: PointerPoint): boolean {
  if (!graphPinsAvailable()) return false;
  const cursor = point ?? desktopCursor();
  return graphPinRegions.some(rect => cursor.x >= rect.x && cursor.y >= rect.y && cursor.x < rect.x + rect.width && cursor.y < rect.y + rect.height);
}

function updateGraphPinHover(point: CursorPoint): void {
  if (hitsGraphPins(point) !== graphPinHover) applyWindowMode(point);
}

function windowRegions(value: unknown): Electron.Rectangle[] | undefined {
  if (!Array.isArray(value) || value.length > 256 || value.some(rect => !rect || typeof rect !== 'object' ||
    !['x', 'y', 'width', 'height'].every(key => typeof rect[key] === 'number' && Number.isFinite(rect[key])) || rect.width <= 0 || rect.height <= 0)) return;
  return value.map(({ x, y, width, height }) => ({ x, y, width, height }));
}

function setGraphPinRegions(value: unknown): void {
  const packet = value as { rects?: unknown } | null;
  const rects = windowRegions(packet?.rects);
  if (!rects) return;
  // 只接收可见卡片的局部矩形；与宠物命中分开，悬停不会主动取得键盘焦点。
  graphPinRegions = store.getPublic().graphPluginEnabled ? rects : [];
  applyWindowMode();
}

function setInteractive(value: unknown): void {
  if (typeof value !== 'boolean') return;
  interactive = value;
  applyWindowMode();
  debugWindow('interactive-' + interactive);
}

function interactGraphPin(value: unknown): boolean {
  const interaction = value as Partial<GraphPinInteraction> | null;
  const point = interaction?.point;
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y) || !['down', 'up'].includes(interaction?.phase ?? '')) return false;
  if (interaction?.phase === 'up') {
    if (!graphPinPressed) return false;
    graphPinPressed = false;
    // 松开后区域外恢复穿透，保留选中文字的键盘焦点直到真正失焦。
    applyWindowMode();
    return true;
  }
  if (!hitsGraphPins(point)) return false;
  // 持续按压只由有序的原生 down/up 管理，迟到的 renderer down 不能重新锁住桌面。
  return true;
}

function nativePointerDown(screenPoint: PointerPoint): void {
  if (captureSession || suspended || !window || window.isDestroyed()) return;
  // 使用按下时的原生坐标，不能把异步送达期间移动后的鼠标当作点击位置。
  const point = desktopCursor(screen.screenToDipPoint(screenPoint));
  graphPinPressed = hitsGraphPins(point);
  if (panelView === undefined && graphPinRegions.length) applyWindowMode(point);
  if (panelView === 'prompt' || panelView === undefined && graphPinRegions.length) {
    window.webContents.send('rabbit:pointer-down', { x: point.x, y: point.y });
  }
}

function nativePointerUp(): void {
  // renderer 可能因失焦、页面切换或原生输入丢失而没有收到 pointerup。
  // 物理鼠标释放后立即清除卡片按压状态。
  if (!graphPinPressed || !window || window.isDestroyed()) return;
  graphPinPressed = false;
  applyWindowMode();
}

function invalidateInput(): void {
  activationEffect?.clear();
  graphPinPressed = false;
  activationEpoch++;
  promptActivation = undefined;
  windowsNative?.cancelFocus();
}

function configureNative(shortcut = store.getPublic().activationShortcut): Promise<void> {
  return windowsNative?.configure({ pauseOnFullscreen: store.getPublic().pauseOnFullscreen, inputEnabled: !suspended && !!window && !window.isDestroyed(), allowOwnForeground: panelView !== 'settings', recording: shortcutRecording, shortcut: nativeShortcut(shortcut) }) ?? Promise.resolve();
}

function registerPlatformShortcut(shortcut: readonly string[]): void {
  const accelerator = shortcutToAccelerator(shortcut, process.platform);
  if (!accelerator) throw new Error('当前平台无法注册此物理按键组合，请选择其他普通按键或组合键。');
  if (accelerator === registeredShortcut && globalShortcut.isRegistered(accelerator)) return;
  if (!globalShortcut.register(accelerator, activatePrompt)) throw new Error('启动键 ' + formatShortcut(shortcut, process.platform) + ' 已被其他应用占用，请选择其他组合。');
  if (registeredShortcut && registeredShortcut !== accelerator) globalShortcut.unregister(registeredShortcut);
  registeredShortcut = accelerator;
  // globalShortcut 无法逐次旁路事件；自有窗口聚焦时解除，保留输入框的正常按键。
  if (window && !window.isDestroyed() && window.isFocused()) globalShortcut.unregister(accelerator);
}

function setShortcutRecording(recording: boolean): Promise<void> {
  if (shortcutRecording === recording) return recordingReady;
  shortcutRecording = recording;
  if (recording) cancelCapture();
  recordingReady = process.platform === 'win32' ? configureNative() : Promise.resolve().then(() => {
    if (recording) { if (registeredShortcut) globalShortcut.unregister(registeredShortcut); registeredShortcut = undefined; }
    else registerPlatformShortcut(store.getPublic().activationShortcut);
  });
  return recordingReady;
}

function finishShortcutRecording(): void {
  if (!shortcutRecording || quitting) return;
  void setShortcutRecording(false).catch(error => { if (!quitting) dialog.showErrorBox('启动键恢复失败', error instanceof Error ? error.message : '请在设置中重新选择启动键。'); });
}



function trusted(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame;
}

function assertTrusted(event: IpcMainInvokeEvent): void {
  if (!trusted(event)) throw new Error('请求来源无效。');
}

function activateWindow(): void {
  if (!mainDisplayAvailable()) return;
  showMainWindow(true);
  window.focus();
  window.webContents.focus();
}

function desktopCursor(point = screen.getCursorScreenPoint()): CursorPoint {
  const bounds = window.getBounds();
  const physical = process.platform === 'win32' ? screen.dipToScreenRect(null, bounds) : bounds;
  const cursor = process.platform === 'win32' ? screen.dipToScreenPoint(point) : point;
  const area = screen.getDisplayNearestPoint(point).workArea;
  const target = process.platform === 'win32' ? screen.dipToScreenRect(null, area) : area;
  const scale = physical.width / bounds.width;
  return {
    x: (cursor.x - physical.x) / scale, y: (cursor.y - physical.y) / scale,
    displayOrigin: { x: bounds.x, y: bounds.y }, screen: point,
    viewport: { x: physical.x, y: physical.y, scale },
    followBounds: { x: (target.x - physical.x) / scale, y: (target.y - physical.y) / scale, width: target.width / scale, height: target.height / scale },
    ...(petTransition !== undefined ? { transitionId: petTransition } : {}),
  };
}

function movePetViewport(area: Electron.Rectangle, cursor = screen.getCursorScreenPoint()): boolean {
  const current = window.getBounds();
  const changing = petTransition !== undefined || current.x !== area.x || current.y !== area.y;
  if (changing) {
    // 先明确旧坐标基准；首次跨屏激活也不能把旧屏局部坐标当作新屏位置。
    window.webContents.send('rabbit:cursor', desktopCursor(cursor));
    petTransition = ++petTransitionEpoch;
    window.setOpacity(0);
    // 原生窗口在换屏、DPI及样式更新期间保持隐藏，不向系统提交旧画面。
    hideMainWindow();
  } else window.setOpacity(1);
  applyWindowMode();
  window.setBounds(area);
  window.webContents.send('rabbit:cursor', desktopCursor(cursor));
  return changing;
}

function followPetPosition(value: unknown): void {
  if (suspended || quitting || captureSession || panelView || !store.getPublic().followMouse) return;
  const point = value as Partial<{ x: number; y: number }> | null;
  if (!point || typeof point.x !== 'number' || typeof point.y !== 'number' || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
  const { x, y } = point;
  // 只在兔球中心真正进入另一屏时换窗；屏间空隙不提前选最近屏。
  const display = screen.getAllDisplays().find(display => {
    const bounds = process.platform === 'win32' ? screen.dipToScreenRect(null, display.bounds) : display.bounds;
    return x >= bounds.x && x < bounds.x + bounds.width && y >= bounds.y && y < bounds.y + bounds.height;
  });
  if (!display) return;
  const current = window.getBounds(), area = display.workArea;
  if (current.x === area.x && current.y === area.y && current.width === area.width && current.height === area.height) return;
  movePetViewport(area);
}

function showPanel(view: Activation['view'], context?: NativeCaptureContext, extra: Pick<Activation, 'workspaceId' | 'backgroundImageDataUrl' | 'graphAction'> = {}): void {
  if (!window || window.isDestroyed()) return;
  if (suspended && view !== 'settings') return;
  invalidateInput();
  panelView = view;
  void configureNative().catch(() => {});
  interactive = view === 'settings' || view === 'graph';
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  if (view === 'prompt' || view === 'graph') promptActivation = { epoch: activationEpoch, phase: 'pending' };
  const transitioning = movePetViewport(display.workArea, cursor);
  if (!transitioning) {
    if (view === 'settings') activateWindow();
    else showMainWindow();
  }
  debugWindow('show-' + view);
  const [x, y] = window.getPosition();
  const activation: Activation = { activationId: activationEpoch, view, ...extra, ...(context ? { context: rendererContext(context) } : {}), anchor: { x: cursor.x - x, y: cursor.y - y } };
  window.webContents.send('rabbit:activate', activation);
}

function focusInput(observedEpoch: unknown): Promise<boolean> {
  const activation = promptActivation;
  if (!activation || observedEpoch !== activation.epoch || !['prompt', 'graph'].includes(panelView ?? '') || suspended || quitting) return Promise.resolve(false);
  activation.phase = 'ready';
  applyWindowMode();
  if (captureSession || petTransition !== undefined) return Promise.resolve(false);
  if (activation.focus) return activation.focus;
  activation.focus = (async () => {
    activateWindow();
    let focused: boolean;
    if (process.platform === 'win32') {
      const bytes = window.getNativeWindowHandle();
      const handle = bytes.length >= 8 ? bytes.readBigUInt64LE().toString() : bytes.readUInt32LE().toString();
      focused = await windowsNative?.focusWindow(handle) ?? false;
    } else {
      window.focus();
      focused = window.isFocused();
    }
    if (promptActivation !== activation || activation.epoch !== activationEpoch || !['prompt', 'graph'].includes(panelView ?? '') || captureSession || suspended || quitting) return false;
    applyWindowMode();
    if (focused) window.webContents.focus();
    if (process.env.RABBITBALL_WINDOW_DEBUG === '1') {
      console.info('[RabbitBall focus]', JSON.stringify({ epoch: activation.epoch, foregroundFocused: focused, windowFocused: window.isFocused() }));
      void window.webContents.executeJavaScript('({hasFocus:document.hasFocus(),activeElement:document.activeElement?document.activeElement.tagName.toLowerCase()+(document.activeElement.id?"#"+document.activeElement.id:""):null})').then(state => console.info('[RabbitBall focus DOM]', JSON.stringify({ epoch: activation.epoch, ...state }))).catch(() => {});
    }
    return focused;
  })();
  const request = activation.focus;
  const clearRequest = () => { if (activation.focus === request) activation.focus = undefined; };
  void request.then(clearRequest, clearRequest);
  return request;
}

function rendererContext(context: NativeCaptureContext): CaptureContext {
  const { focusScreenBounds, ...result } = context;
  if (focusScreenBounds) {
    const [x, y] = window.getPosition();
    result.focusBounds = { ...focusScreenBounds, x: focusScreenBounds.x - x, y: focusScreenBounds.y - y };
  }
  return result;
}

function hidePanel(reason = 'renderer-hide'): void {
  finishShortcutRecording();
  invalidateInput();
  // 关闭面板不撤销进行中的坐标同步；就绪后只恢复宠物，不恢复旧面板。
  if (petTransition === undefined) window.setOpacity(1);
  panelView = undefined;
  void configureNative().catch(() => {});
  interactive = false;
  applyWindowMode();
  window.webContents.send('rabbit:cursor', { ...desktopCursor(), resetEntry: true });
  if (suspended) hideMainWindow();
  debugWindow(reason);
}

function openSettings(): void { cancelCapture(); showPanel('settings'); }

function setSuspended(value: boolean): void {
  if (suspended === value) return;
  suspended = value;
  void configureNative().catch(() => {});
  if (value) {
    activationEffect?.clear();
    graphPinPressed = false;
    cancelActiveRequest();
    cancelCapture();
    if (panelView === 'prompt' || panelView === 'graph') hidePanel('suspend-fullscreen');
    else windowsNative?.cancelFocus();
  }
  if (!window || window.isDestroyed()) return;
  applyWindowMode();
  if (value) {
    if (panelView !== 'settings') hideMainWindow();
  } else {
    if (petTransition === undefined && !window.isVisible()) showMainWindow();
  }
  window.webContents.send('rabbit:suspended', value);
  debugWindow(value ? 'suspend-fullscreen' : 'resume-fullscreen');
}

async function configureFullscreen(enabled: boolean): Promise<void> {
  if (!enabled || process.platform !== 'win32') setSuspended(false);
  await configureNative();
}

function configureLoginItem(enabled: boolean): void {
  if (process.platform !== 'win32' && process.platform !== 'darwin') throw new Error('当前平台暂未接入开机启动设置。');
  app.setLoginItemSettings({ openAtLogin: enabled, enabled, name: 'RabbitBall', path: process.execPath, args: app.isPackaged ? [] : ['"' + app.getAppPath() + '"'] });
}

interface CaptureSnapshot {
  context: NativeCaptureContext;
  background?: NativeImage;
  defaultClipboard?: NativeImage;
}

const captureWorker = new CaptureWorker();

function captureViewports(): CaptureViewport[] {
  return screen.getAllDisplays().map(display => ({ bounds: display.bounds, physicalBounds: process.platform === 'win32' ? screen.dipToScreenRect(null, display.bounds) : display.bounds }));
}

async function captureDesktop(signal: AbortSignal, bounds: CaptureRect): Promise<CaptureSnapshot> {
  const context: NativeCaptureContext = { id: randomUUID(), title: '屏幕选区', images: [], capturedAt: Date.now() };
  const snapshot: CaptureSnapshot = { context };
  try {
    if (process.platform !== 'win32') throw new Error('此平台暂未接入屏幕框选。');
    const result = await captureWorker.capture({ type: 'desktop', bounds }, signal);
    const background = result.desktopBitmap ? nativeImage.createFromBitmap(result.desktopBitmap, { width: result.desktopWidth!, height: result.desktopHeight!, scaleFactor: 1 }) : nativeImage.createEmpty();
    if (background.isEmpty()) throw new Error(result.desktopError || '屏幕选区暂不能截取，请重试。');
    snapshot.background = background;
  } catch (error) {
    context.error = (error as Error).message;
  }
  return snapshot;
}

async function captureForeground(signal: AbortSignal, backgroundBounds?: CaptureRect, clean = false): Promise<CaptureSnapshot> {
  const context: NativeCaptureContext = { id: randomUUID(), title: '当前窗口', images: [], capturedAt: Date.now() };
  const snapshot: CaptureSnapshot = { context };
  if (process.platform !== 'win32') {
    context.error = '此平台暂未接入焦点窗口捕获，可直接提问或添加附件。';
    return snapshot;
  }
  try {
    const foreground = await captureWorker.capture({ type: 'window', ...(backgroundBounds ? { backgroundBounds } : {}) }, signal);
    if (foreground.desktopBitmap) {
      const background = nativeImage.createFromBitmap(foreground.desktopBitmap, { width: foreground.desktopWidth!, height: foreground.desktopHeight!, scaleFactor: 1 });
      if (!background.isEmpty()) snapshot.background = background;
    }
    if (!/^\d+$/.test(foreground.handle) || foreground.handle === '0' || foreground.bounds.width <= 0 || foreground.bounds.height <= 0) {
      context.error = foreground.captureError || undefined;
      return snapshot;
    }
    if (foreground.processId === process.pid) {
      context.error = '请先切换到需要查看的窗口，再按启动键。';
      return snapshot;
    }
    context.title = foreground.title || '当前窗口';
    context.focusScreenBounds = screen.screenToDipRect(null, foreground.bounds);
    // 沿用0.1.2的目标窗口截图；图谱背景单独读取，不能替代或裁剪窗口内容。
    const image = foreground.imageBase64 ? nativeImage.createFromBuffer(Buffer.from(foreground.imageBase64, 'base64')) : nativeImage.createEmpty();
    if (image.isEmpty()) {
      context.error = foreground.captureError || '当前窗口暂不能截取，可长按启动键拖选屏幕区域。';
      return snapshot;
    }
    const size = image.getSize();
    const { bounds, cursor: screenCursor } = foreground;
    const x = (screenCursor.x - bounds.x) / bounds.width * size.width;
    const y = (screenCursor.y - bounds.y) / bounds.height * size.height;
    const cursor: NonNullable<CaptureImage['cursor']> = { x: Math.round(x), y: Math.round(y), width: size.width, height: size.height, inside: x >= 0 && y >= 0 && x < size.width && y < size.height };
    const marked = clean ? image : markCaptureCursor(image, cursor, store.getPublic().eyeColor);
    context.images = [{ id: randomUUID(), title: context.title, source: 'window', appName: foreground.appName, processName: foreground.processName, pixelSize: size, imageDataUrl: 'data:image/jpeg;base64,' + marked.toJPEG(88).toString('base64'), cursor }];
    snapshot.defaultClipboard = image;
  } catch (error) {
    const failure = error as { killed?: boolean };
    context.error = failure.killed ? '读取窗口超时，请稍后重试。' : '当前窗口暂不能截取，请切换窗口后重试。';
  }
  return snapshot;
}

function emitGraphError(error: unknown, workspaceId?: string): void {
  if (window && !window.isDestroyed()) window.webContents.send('rabbit:graph-error', { workspaceId, message: error instanceof Error ? error.message : String(error) });
}

function graphChanged(workspace: GraphWorkspace): void {
  graphJobs?.reconcile(workspace);
  if (window && !window.isDestroyed()) {
    const previousImages = graphImageCache.get(workspace.id), images = new Map<string, string>();
    const compactImage = <T extends CaptureImage>(image: T): T => {
      images.set(image.id, image.imageDataUrl);
      return previousImages?.get(image.id) === image.imageDataUrl ? { ...image, imageDataUrl: '' } : image;
    };
    const packet = { ...workspace, graphs: workspace.graphs.map(graph => ({ ...graph, nodes: graph.nodes.map(node => ({ ...node,
      images: node.images.map(compactImage),
      annotations: node.annotations.map(annotation => ({ ...annotation, ...(annotation.images ? { images: annotation.images.map(compactImage) } : {}) })),
      ...(node.source ? { source: { ...node.source, ...(node.source.images ? { images: node.source.images.map(compactImage) } : {}), ...(node.source.selectionImage ? { selectionImage: compactImage(node.source.selectionImage) } : {}) } } : {})
    })) })) };
    graphImageCache.set(workspace.id, images);
    window.webContents.send('rabbit:graph-changed', packet);
  }
}

async function captureWorkspace(session: CaptureSession, createGraph = true): Promise<GraphWorkspace | undefined> {
  let workspace = await graphStore.open(session.workspaceId);
  if (captureSession !== session || session.controller.signal.aborted) return;
  session.workspaceId = workspace.id;
  const current = workspace.graphs.find(graph => graph.id === (session.graphId ?? workspace.lastGraphId)) ?? (!session.graphId ? workspace.graphs[0] : undefined);
  if (!current && session.graphId) throw new Error('当前图谱已被删除。');
  if (!createGraph || session.fillEmptyGraph === false) { session.graphId = current?.id; return workspace; }
  if (!current || session.holdReady && session.target === 'graph' && current.nodes.length > 0) {
    workspace = await graphStore.mutate(workspace.id, { type: 'create-graph' });
    session.graphId = workspace.lastGraphId;
  } else session.graphId = current.id;
  return workspace;
}

async function captureShortPress(session: CaptureSession): Promise<void> {
  try {
    if (session.target === 'prompt') {
      acceptCaptureSnapshot(session, await captureForeground(session.controller.signal));
      return;
    }
    const workspace = await captureWorkspace(session, false);
    if (!workspace || captureSession !== session || session.controller.signal.aborted) return;
    const needsImage = session.fillEmptyGraph !== false && !workspace.graphs.find(graph => graph.id === session.graphId)?.nodes.length;
    const snapshot = needsImage
      ? await captureForeground(session.controller.signal, session.physicalBounds, true)
      : await captureDesktop(session.controller.signal, session.physicalBounds);
    if (captureSession !== session || session.controller.signal.aborted) return;
    if (!needsImage) snapshot.context.title = workspace.name;
    acceptCaptureSnapshot(session, snapshot);
  } catch (error) {
    if (captureSession === session) { cancelCapture(); emitGraphError(error, session.workspaceId); }
  }
}

function graphBackground(session: CaptureSession): string | undefined {
  if (!session.background) return undefined;
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const bounds = process.platform === 'win32' ? screen.dipToScreenRect(null, display.workArea) : display.workArea;
  const crop = session.background.crop(imageCropRect(bounds, session.physicalBounds, session.background.getSize()));
  if (crop.isEmpty()) return undefined;
  const size = crop.getSize(), ratio = Math.min(1, 1600 / size.width);
  const image = ratio < 1 ? crop.resize({ width: Math.round(size.width * ratio), height: Math.round(size.height * ratio) }) : crop;
  return 'data:image/jpeg;base64,' + image.toJPEG(78).toString('base64');
}

async function completeGraphCapture(session: CaptureSession): Promise<void> {
  try {
    let workspace = await captureWorkspace(session);
    if (!workspace || captureSession !== session || session.controller.signal.aborted) return;
    const create = session.fillEmptyGraph !== false && !workspace.graphs.find(graph => graph.id === session.graphId)?.nodes.length;
    let captureError: string | undefined;
    if (create) {
      if (!session.context?.images.length) captureError = session.context?.error || (session.holdReady ? '没有选取截图，可再次长按激活键框选。' : '当前窗口未能截图，请切换应用或长按激活键框选。');
      else {
        try {
          workspace = await graphStore.attachCapture(workspace.id, session.graphId!, session.context);
        } catch (error) { captureError = error instanceof Error ? error.message : '图谱暂未保存，请在菜单中检查文档。'; }
      }
    }
    if (captureSession !== session || session.controller.signal.aborted) return;
    graphWorkspaceId = workspace.id;
    const backgroundImageDataUrl = graphBackground(session);
    captureSession = undefined;
    captureOverlays?.close();
    emitCapture({ type: 'end', sessionId: session.id });
    showPanel('graph', undefined, { workspaceId: workspace.id, backgroundImageDataUrl, graphAction: session.graphAction });
    if (captureError) emitGraphError(new Error(captureError), workspace.id);
  } catch (error) {
    if (captureSession === session) cancelCapture();
    emitGraphError(error, session.workspaceId);
  }
}

function restoreGraphImageCapture(session: CaptureSession, images: CaptureImage[] | null): void {
  session.imageResult?.(images);
  if (window && !window.isDestroyed() && !quitting && !suspended && store.getPublic().graphPluginEnabled && panelView === 'graph' && activationEpoch === session.owner) {
    applyWindowMode();
    showMainWindow();
    void focusInput(session.owner);
  }
}

function emitCapture(event: CaptureEvent): void {
  if (window && !window.isDestroyed()) window.webContents.send('rabbit:capture-event', event);
}

function copyScreenshot(session: CaptureSession, image: NativeImage): void {
  if (!store.getPublic().autoCopyScreenshots) return;
  clipboardQueue = preservedClipboard.writeScreenshot(image.toPNG(), session.clipboardSnapshot,
    () => !session.controller.signal.aborted && store.getPublic().autoCopyScreenshots
  ).catch(() => { if (session.context) session.context.error = '截图已加入上下文，但暂未复制到剪贴板。'; });
}

function drainCaptureRegions(session: CaptureSession): void {
  if (captureSession !== session || !session.context || !session.background) return;
  while (session.regions.length) {
    const rect = session.regions.shift()!;
    const source = session.background;
    const crop = source.crop(imageCropRect(rect, session.physicalBounds, source.getSize()));
    const size = crop.getSize();
    const scale = session.target !== 'prompt' ? 1 : Math.min(1, 1920 / size.width, 1200 / size.height);
    const modelImage = scale < 1 ? crop.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) }) : crop;
    const image: CaptureImage = { id: randomUUID(), title: '选区 ' + (session.context.images.length + 1), source: 'region', pixelSize: size, imageDataUrl: 'data:image/jpeg;base64,' + modelImage.toJPEG(88).toString('base64') };
    session.context.images.push(image);
    copyScreenshot(session, crop);
    if (session.visible) captureOverlays?.image(rendererContext(session.context), rect);
  }
}

function queueCaptureRegion(session: CaptureSession, end: CapturePoint): void {
  const start = session.dragStart;
  session.dragStart = undefined;
  if (!start) return;
  const rect = selectionRect(start, end, session.physicalBounds);
  if (!rect || rect.width < 4 || rect.height < 4) return;
  session.hasSelection = true;
  session.regions.push(rect);
  drainCaptureRegions(session);
}

function completeCapture(session: CaptureSession): void {
  if (captureSession !== session || !session.released || !session.context || session.finishing || suspended || quitting) return;
  session.finishing = true;
  if (session.hasSelection && !session.background) {
    session.context.images = [];
    session.context.error = '屏幕选区暂不能截取，请重试。';
  } else drainCaptureRegions(session);
  // 只有短按的应用窗口图需要在此复制；框选图在确认区域时独立复制。
  if (!session.hasSelection && session.defaultClipboard) copyScreenshot(session, session.defaultClipboard);
  if (session.target === 'graph') {
    void completeGraphCapture(session);
    return;
  }
  captureSession = undefined;
  captureOverlays?.close();
  emitCapture({ type: 'end', sessionId: session.id });
  if (session.target === 'images') {
    restoreGraphImageCapture(session, session.context.images.length ? session.context.images : null);
    return;
  }
  currentContext = session.context;
  showPanel('prompt', currentContext);
}

function showCapture(session: CaptureSession): void {
  if (captureSession !== session || !session.holdReady || session.released || session.visible || !session.context || !session.background) return;
  session.visible = true;
  const settings = store.getPublic();
  void captureOverlays!.show({ sessionId: session.id, viewports: session.viewports, background: session.background, physicalBounds: session.physicalBounds, context: rendererContext(session.context), purpose: session.target, shortcut: settings.activationShortcut, color: settings.eyeColor, useBuiltinFont: settings.useBuiltinFont }).then(() => {
    if (captureSession === session) updateCaptureFrame(session);
  }).catch(() => {
    if (captureSession === session) cancelCapture();
  });
}

function updateCaptureFrame(session: CaptureSession): void {
  const point = screen.getCursorScreenPoint();
  captureOverlays?.frame(session.dragStart, process.platform === 'win32' ? screen.dipToScreenPoint(point) : point);
}

function acceptCaptureSnapshot(session: CaptureSession, snapshot: CaptureSnapshot): void {
  if (captureSession !== session || session.controller.signal.aborted || suspended || quitting) return;
  if (session.holdReady && !snapshot.background) {
    cancelCapture();
    emitGraphError(new Error(snapshot.context.error || '无法读取屏幕，请稍后重试。'), session.workspaceId);
    return;
  }
  session.context = snapshot.context;
  session.background = snapshot.background;
  session.defaultClipboard = snapshot.defaultClipboard;
  drainCaptureRegions(session);
  if (session.released) completeCapture(session);
  else showCapture(session);
}

function holdCapture(session: CaptureSession): void {
  if (captureSession !== session || session.holdReady || session.released) return;
  session.holdReady = true;
  // 长按只冻结屏幕，不读取、选择或截取应用窗口。
  void captureDesktop(session.controller.signal, session.physicalBounds).then(snapshot => acceptCaptureSnapshot(session, snapshot));
}

function beginCapture(released = false, nativeId?: number, graph?: { workspaceId: string; graphId?: string; target?: 'graph' | 'images'; imageResult?: CaptureSession['imageResult']; fillEmptyGraph?: boolean; graphAction?: Activation['graphAction'] }): CaptureSession | undefined {
  if (suspended || quitting || !window || window.isDestroyed()) return;
  activationEffect?.clear();
  cancelCapture(false);
  graphPinPressed = false;
  windowsNative?.cancelFocus();
  const viewports = captureViewports();
  const clipboardSnapshot = store.getPublic().autoCopyScreenshots ? preservedClipboard.beginActivation() : Promise.resolve(null);
  const settings = store.getPublic();
  const target = graph?.target ?? (graph || settings.graphPluginEnabled && settings.graphModeEnabled ? 'graph' : 'prompt');
  const session: CaptureSession = { id: randomUUID(), nativeId, controller: new AbortController(), clipboardSnapshot, viewports, physicalBounds: unionBounds(viewports.map(viewport => viewport.physicalBounds)), regions: [], hasSelection: false, holdReady: false, released, visible: false, finishing: false, target, workspaceId: graph?.workspaceId ?? graphWorkspaceId, graphId: graph?.graphId, owner: activationEpoch, imageResult: graph?.imageResult, fillEmptyGraph: graph?.fillEmptyGraph, graphAction: graph?.graphAction };
  captureSession = session;
  // 隐藏宠物后再采集；原生按键释放或长按事件决定使用哪条截图流程。
  hideMainWindow();
  if (released) void captureShortPress(session);
  return session;
}

function endCapture(): void {
  const session = captureSession;
  if (!session) return;
  const point = screen.getCursorScreenPoint();
  queueCaptureRegion(session, process.platform === 'win32' ? screen.dipToScreenPoint(point) : point);
  session.released = true;
  if (session.holdReady) completeCapture(session);
  else void captureShortPress(session);
}

function selectionPointer(phase: 'down' | 'up', point: CapturePoint): void {
  const session = captureSession;
  if (!session || session.released) return;
  if (phase === 'down') session.dragStart = point;
  else queueCaptureRegion(session, point);
  if (session.visible) captureOverlays?.frame(session.dragStart, point);
}

function cancelCapture(notifyNative = true): void {
  const session = captureSession;
  if (!session) return;
  captureSession = undefined;
  captureOverlays?.close();
  session.controller.abort();
  if (notifyNative && session.nativeId !== undefined) windowsNative?.cancelCapture(session.nativeId);
  emitCapture({ type: 'cancel', sessionId: session.id });
  if (session.target === 'images') { restoreGraphImageCapture(session, null); return; }
  if (window && !window.isDestroyed() && !quitting) {
    applyWindowMode();
    if (!suspended && petTransition === undefined) showMainWindow();
  }
}

function activatePrompt(released = true, nativeId?: number): void {
  const settings = store.getPublic();
  if (panelView === 'graph' || panelView === 'prompt' && !(settings.graphPluginEnabled && settings.graphModeEnabled)) {
    window.webContents.send('rabbit:dismiss', activationEpoch);
    hidePanel('shortcut-cancel');
    return;
  }
  if (panelView === 'prompt') window.webContents.send('rabbit:dismiss', activationEpoch);
  cancelCapture();
  beginCapture(released, nativeId);
}

function validateAttachment(value: unknown): Attachment {
  if (!value || typeof value !== 'object') throw new Error('附件格式无效。');
  const attachment = value as Partial<Attachment>;
  if (typeof attachment.id !== 'string' || typeof attachment.name !== 'string' || attachment.name.length > 240 || typeof attachment.mimeType !== 'string') throw new Error('附件格式无效。');
  if (attachment.text !== undefined) {
    if (typeof attachment.text !== 'string' || attachment.text.length > 20_000) throw new Error('文字附件不能超过两万字。');
  } else {
    if (typeof attachment.dataUrl !== 'string' || !/^data:image\/(png|jpeg|webp|gif);base64,[a-z0-9+/=]+$/i.test(attachment.dataUrl)) throw new Error('请选择支持的图片附件。');
    if (Buffer.byteLength(attachment.dataUrl.split(',')[1]!, 'base64') > 5 * 1024 * 1024) throw new Error('图片附件不能超过 5 MiB。');
  }
  return { id: attachment.id, name: attachment.name, mimeType: attachment.mimeType, ...(attachment.text !== undefined ? { text: attachment.text } : { dataUrl: attachment.dataUrl }) };
}

function validateRequest(value: unknown): AgentRequest {
  if (!value || typeof value !== 'object') throw new Error('消息格式无效。');
  const input = value as Partial<AgentRequest>;
  if (typeof input.id !== 'string' || !input.id || input.id.length > 128 || typeof input.text !== 'string' || input.text.length > 20_000) throw new Error('消息格式无效。');
  if (input.action !== undefined && !['ask', 'search', 'extract', 'translate'].includes(input.action)) throw new Error('快捷操作无效。');
  if (input.contextId !== undefined && (typeof input.contextId !== 'string' || input.contextId !== currentContext?.id)) throw new Error('窗口上下文已更新，请重新发送。');
  if (input.contextId !== undefined) {
    if (!Array.isArray(input.imageIds) || input.imageIds.some(id => typeof id !== 'string' || !currentContext?.images.some(image => image.id === id)) || new Set(input.imageIds).size !== input.imageIds.length) throw new Error('截图选择已更新，请重新发送。');
  } else if (input.imageIds !== undefined) throw new Error('截图上下文无效。');
  for (const id of [input.conversationId, input.turnId]) {
    if (typeof id !== 'string' || !id || id.length > 128) throw new Error('会话标识无效。');
  }
  if (input.regenerate !== undefined && typeof input.regenerate !== 'boolean') throw new Error('重新生成参数无效。');
  if (input.attachments !== undefined && (!Array.isArray(input.attachments) || input.attachments.length > 1)) throw new Error('每次最多添加一个附件。');
  return { id: input.id, text: input.text, conversationId: input.conversationId!, turnId: input.turnId!, ...(input.action ? { action: input.action } : {}), ...(input.contextId ? { contextId: input.contextId, imageIds: input.imageIds! } : {}), ...(input.regenerate !== undefined ? { regenerate: input.regenerate } : {}), ...(input.attachments ? { attachments: input.attachments.map(validateAttachment) } : {}), ...(input.graphContext ? { graphContext: graphRequest(input.graphContext) } : {}) };
}

function graphRequest(value: unknown): GraphNodeRequest {
  if (!value || typeof value !== 'object') throw new Error('卡片标识无效。');
  const input = value as Partial<GraphNodeRequest>;
  for (const id of [input.workspaceId, input.graphId, input.nodeId]) if (typeof id !== 'string' || !id || id.length > 128) throw new Error('卡片标识无效。');
  return { workspaceId: input.workspaceId!, graphId: input.graphId!, nodeId: input.nodeId! };
}

function graphCaptureRequest(value: unknown): GraphCaptureRequest {
  if (!value || typeof value !== 'object') throw new Error('图谱标识无效。');
  const input = value as Partial<GraphCaptureRequest>;
  return { workspaceId: historyId(input.workspaceId), graphId: historyId(input.graphId) };
}

function emitAgent(event: AgentEvent): void {
  if (!window.isDestroyed()) window.webContents.send('rabbit:agent-event', event);
}

function cancelActiveRequest(): void {
  const request = activeRequest;
  if (!request) return;
  request.controller.abort();
  request.history?.onEvent({ id: request.id, type: 'cancelled' });
  if (request.history) void request.history.save().catch(error => console.error('保存历史记录失败：', error));
  else emitAgent({ id: request.id, type: 'cancelled' });
  activeRequest = undefined;
}

function historyId(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 128) throw new Error('历史记录标识无效。');
  return value;
}

function historyThumbnail(image: CaptureImage | undefined): string | undefined {
  if (!image) return undefined;
  const bitmap = nativeImage.createFromDataURL(image.imageDataUrl);
  if (bitmap.isEmpty()) return undefined;
  const size = bitmap.getSize(), scale = Math.min(160 / size.width, 100 / size.height, 1);
  const small = bitmap.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)), quality: 'good' });
  return 'data:image/jpeg;base64,' + small.toJPEG(75).toString('base64');
}

function registerIpc(): void {
  ipcMain.handle('rabbit:graph-list', event => { assertTrusted(event); return graphStore.list(); });
  ipcMain.handle('rabbit:graph-open', async (event, value: unknown) => {
    assertTrusted(event);
    const workspace = await graphStore.open(value === undefined ? undefined : historyId(value));
    graphWorkspaceId = workspace.id;
    return workspace;
  });
  ipcMain.handle('rabbit:graph-create', async (event, name: unknown) => {
    assertTrusted(event);
    if (typeof name !== 'string') throw new Error('工作区名称无效。');
    const workspace = await graphStore.create(name);
    graphWorkspaceId = workspace.id;
    return workspace;
  });
  ipcMain.handle('rabbit:graph-mutate', (event, id: unknown, mutation: unknown) => {
    assertTrusted(event);
    return graphStore.mutate(historyId(id), mutation as GraphMutation);
  });
  ipcMain.handle('rabbit:graph-reveal-document', async (event, id: unknown) => {
    assertTrusted(event);
    const error = await shell.openPath(graphStore.getDirectory(historyId(id)));
    if (error) throw new Error(error);
  });
  ipcMain.handle('rabbit:graph-activate', async (event, action: unknown) => {
    assertTrusted(event);
    if (action !== undefined && !['rename-graph', 'undo', 'redo'].includes(action as string)) throw new Error('图谱操作无效。');
    if (!store.getPublic().graphPluginEnabled) throw new Error('请先启用大爆炸插件。');
    if (suspended) throw new Error('全屏应用运行中，兔球已暂停。');
    const owner = activationEpoch;
    const workspace = await graphStore.open(graphWorkspaceId);
    if (activationEpoch !== owner || suspended || !store.getPublic().graphPluginEnabled) return;
    beginCapture(true, undefined, { workspaceId: workspace.id, fillEmptyGraph: action === undefined, graphAction: action as Activation['graphAction'] });
  });
  ipcMain.handle('rabbit:graph-capture', async (event, value: unknown) => {
    assertTrusted(event);
    if (!store.getPublic().graphPluginEnabled) throw new Error('请先启用大爆炸插件。');
    if (suspended) throw new Error('全屏应用运行中，兔球已暂停。');
    const request = graphCaptureRequest(value);
    const owner = activationEpoch;
    const workspace = await graphStore.open(request.workspaceId);
    if (!store.getPublic().graphPluginEnabled || suspended || activationEpoch !== owner) return;
    const graph = workspace.graphs.find(graph => graph.id === request.graphId);
    if (!graph) throw new Error('当前图谱已被删除。');
    if (graph.nodes.length) throw new Error('请先新建空白图谱，再附加根截图。');
    graphWorkspaceId = workspace.id;
    beginCapture(true, undefined, request);
  });
  ipcMain.handle('rabbit:graph-capture-images', async (event, value: unknown) => {
    assertTrusted(event);
    if (!store.getPublic().graphPluginEnabled || suspended || panelView !== 'graph') return null;
    const request = { ...graphCaptureRequest(value), ...((value as { nodeId?: unknown }).nodeId !== undefined ? { nodeId: historyId((value as { nodeId?: unknown }).nodeId) } : {}) }, owner = activationEpoch;
    const workspace = await graphStore.open(request.workspaceId);
    if (activationEpoch !== owner || panelView !== 'graph' || suspended || !store.getPublic().graphPluginEnabled) return null;
    const graph = workspace.graphs.find(graph => graph.id === request.graphId);
    if (!graph) throw new Error('当前图谱已被删除。');
    if (request.nodeId !== undefined ? !graph.nodes.some(node => node.id === request.nodeId) : graph.nodes.length > 0) throw new Error(request.nodeId !== undefined ? '当前卡片已被删除。' : '此图谱已有根节点。');
    if (!windowsNative) throw new Error('当前平台暂不能框选屏幕。');
    let resolve!: (images: CaptureImage[] | null) => void;
    const result = new Promise<CaptureImage[] | null>(done => { resolve = done; });
    const session = beginCapture(false, undefined, { ...request, target: 'images', imageResult: resolve });
    if (!session) return null;
    try {
      const nativeId = await windowsNative.beginSelection();
      if (captureSession !== session || activationEpoch !== owner || !store.getPublic().graphPluginEnabled || suspended) {
        windowsNative?.cancelCapture(nativeId);
        if (captureSession === session) cancelCapture();
        return null;
      }
      session.nativeId = nativeId;
      holdCapture(session);
    } catch (error) {
      if (captureSession === session) cancelCapture();
      throw error;
    }
    return result;
  });
  ipcMain.handle('rabbit:graph-generate', (event, value: unknown) => {
    assertTrusted(event);
    if (!store.getPublic().graphPluginEnabled) throw new Error('大爆炸插件已停用。');
    const request = graphRequest(value), ids = (value as { annotationIds?: unknown }).annotationIds;
    if (ids !== undefined && (!Array.isArray(ids) || ids.length > 128 || ids.some(id => typeof id !== 'string' || !id || id.length > 128))) throw new Error('批注标识无效。');
    return graphJobs.generate({ ...request, ...(ids ? { annotationIds: ids as string[] } : {}) });
  });
  ipcMain.handle('rabbit:graph-regenerate', (event, value: unknown) => {
    assertTrusted(event);
    if (!store.getPublic().graphPluginEnabled) throw new Error('大爆炸插件已停用。');
    return graphJobs.regenerate(graphRequest(value));
  });
  ipcMain.on('rabbit:graph-cancel', (event, value: unknown) => {
    if (!trusted(event)) return;
    try { graphJobs.cancel(graphRequest(value)); } catch (error) { emitGraphError(error); }
  });
  ipcMain.handle('rabbit:edit-text', (event, action: unknown) => {
    assertTrusted(event);
    if (action !== 'cut' && action !== 'copy' && action !== 'selectAll' && action !== 'undo' && action !== 'redo') throw new Error('文本操作无效。');
    event.sender[action]();
  });
  ipcMain.handle('rabbit:read-clipboard-for-paste', event => { assertTrusted(event); return preservedClipboard.readForPaste(); });
  ipcMain.handle('rabbit:load-settings', event => { assertTrusted(event); return store.getPublic(); });
  ipcMain.handle('rabbit:list-history', event => { assertTrusted(event); return historyStore.list(); });
  ipcMain.handle('rabbit:get-history', (event, value: unknown) => { assertTrusted(event); return historyStore.get(historyId(value)); });
  ipcMain.handle('rabbit:delete-history', async (event, value: unknown) => {
    assertTrusted(event);
    const id = historyId(value);
    if (activeRequest?.conversationId === id) cancelActiveRequest();
    if (currentConversation?.id === id) currentConversation = undefined;
    await historyStore.delete(id);
  });
  ipcMain.handle('rabbit:focus-input', (event, observedEpoch: unknown) => { assertTrusted(event); return focusInput(observedEpoch); });
  ipcMain.handle('rabbit:shortcut-recording', (event, recording: unknown) => { assertTrusted(event); if (typeof recording !== 'boolean') throw new Error('录制状态无效。'); return setShortcutRecording(recording); });
  ipcMain.handle('rabbit:save-settings', async (event, value: unknown) => {
    assertTrusted(event);
    const previous = store.getPublic();
    const patch = validateSettingsPatch(value);
    const shortcutChanged = patch.activationShortcut !== undefined && JSON.stringify(patch.activationShortcut) !== JSON.stringify(previous.activationShortcut);
    if (shortcutChanged && process.platform !== 'win32') {
      if (shortcutRecording) await setShortcutRecording(false);
      registerPlatformShortcut(patch.activationShortcut!);
    }
    let settings;
    try { settings = await store.save(patch); }
    catch (error) {
      if (shortcutChanged && process.platform !== 'win32') registerPlatformShortcut(previous.activationShortcut);
      throw error;
    }
    if (settings.launchAtLogin !== previous.launchAtLogin) configureLoginItem(settings.launchAtLogin);
    if (settings.historyLimit !== previous.historyLimit) await historyStore.setLimit(settings.historyLimit);
    if (!settings.graphPluginEnabled) { graphJobs.cancelAll(); graphPinRegions = []; applyWindowMode(); }
    const graphDisabled = !settings.graphPluginEnabled || previous.graphModeEnabled && !settings.graphModeEnabled;
    if (captureSession && captureSession.target !== 'prompt' && graphDisabled) cancelCapture();
    if (panelView === 'graph' && graphDisabled) {
      window.webContents.send('rabbit:dismiss', activationEpoch);
      hidePanel('graph-disabled');
    }
    await configureFullscreen(settings.pauseOnFullscreen);
    window.webContents.send('rabbit:settings-changed', settings);
    if (!previous.graphModeEnabled && settings.graphModeEnabled && settings.graphPluginEnabled && !suspended) {
      if (panelView === 'prompt') window.webContents.send('rabbit:dismiss', activationEpoch);
      beginCapture(true);
    }
    return settings;
  });
  ipcMain.handle('rabbit:send-message', async (event, value: unknown) => {
    assertTrusted(event);
    if (suspended) throw new Error('全屏应用运行中，兔球已暂停。');
    const request = validateRequest(value);
    cancelActiveRequest();
    const conversationId = request.conversationId;
    if (currentConversation?.id !== conversationId) currentConversation = { id: conversationId, conversation: historyStore.getConversation(conversationId) ?? createAgentConversation() };
    const conversation = currentConversation.conversation;
    const controller = new AbortController();
    // 读取图谱也属于本次请求，取消或后续发送必须立即使它失效。
    const pending = { id: request.id, conversationId, controller } as NonNullable<typeof activeRequest>;
    activeRequest = pending;
    let context = request.contextId && currentContext ? { ...currentContext, images: request.imageIds!.map(id => currentContext!.images.find(image => image.id === id)!) } : undefined;
    let modelRequest = request;
    if (request.graphContext) {
      const selection = request.graphContext;
      let workspace: GraphWorkspace;
      try { workspace = await graphStore.open(selection.workspaceId); }
      catch (error) { if (activeRequest === pending) activeRequest = undefined; throw error; }
      if (controller.signal.aborted || activeRequest !== pending) return;
      const reference = buildGraphChatContext(workspace, selection.graphId, selection.nodeId);
      context = reference.context;
      modelRequest = { ...request, text: request.text + '\n\n' + reference.reference };
    }
    const firstScreenshot = context?.images[0];
    const thumbnail = store.getPublic().historyLimit > 0 && !historyStore.list().some(entry => entry.id === conversationId) ? historyThumbnail(firstScreenshot) : undefined;
    const history = historyStore.begin(request, conversation, firstScreenshot, thumbnail);
    pending.history = history;
    void runAgent(modelRequest, store.getPrivate(), { signal: controller.signal, conversation, context, onEvent: event => {
      history.onEvent(event);
      if (!controller.signal.aborted || event.type === 'cancelled') emitAgent(event);
    } }).catch(error => {
      const event: AgentEvent = { id: request.id, type: controller.signal.aborted ? 'cancelled' : 'error', message: error instanceof Error ? error.message : '请求未完成。' };
      history.onEvent(event); emitAgent(event);
    }).finally(async () => {
      if (activeRequest === pending) activeRequest = undefined;
      await history.save();
    }).catch(error => console.error('保存历史记录失败：', error));
    await history.save();
  });
  ipcMain.on('rabbit:cancel-message', (event, id: unknown) => { if (trusted(event) && activeRequest && activeRequest.id === id) cancelActiveRequest(); });
  ipcMain.on('rabbit:hide-panel', (event, owner: unknown) => { if (trusted(event) && !captureSession && panelView !== undefined && owner === activationEpoch) hidePanel(); });
  ipcMain.on('rabbit:cancel-capture', event => { if (trusted(event) || captureOverlays?.owns(event.sender) && event.senderFrame === event.sender.mainFrame) cancelCapture(); });
  ipcMain.on('rabbit:open-settings', event => { if (trusted(event)) openSettings(); });
  ipcMain.on('rabbit:activation-effect', (event, origin: unknown, owner: unknown, color: unknown) => {
    const point = origin as Partial<PointerPoint> | null, bounds = currentContext?.focusScreenBounds;
    if (!trusted(event) || owner !== activationEpoch || panelView !== 'prompt' || captureSession || suspended || quitting || !bounds ||
      !point || !Number.isFinite(point.x) || !Number.isFinite(point.y) || typeof color !== 'string' || !/^#[\da-f]{6}$/i.test(color)) return;
    const [x, y] = window.getPosition();
    void activationEffect?.play(bounds, { x: x + point.x!, y: y + point.y! }, color, raiseMainWindow).catch(() => {});
  });
  ipcMain.on('rabbit:set-interactive', (event, value: unknown, owner: unknown) => { if (trusted(event) && !captureSession && (panelView === undefined || owner === activationEpoch)) setInteractive(value); });
  ipcMain.on('rabbit:set-graph-pin-regions', (event, value: unknown) => { if (trusted(event)) setGraphPinRegions(value); });
  ipcMain.handle('rabbit:graph-pin-interaction', (event, value: unknown) => trusted(event) ? interactGraphPin(value) : false);
  ipcMain.on('rabbit:pet-position', (event, point: unknown) => { if (trusted(event)) followPetPosition(point); });
  ipcMain.handle('rabbit:pet-viewport-ready', async (event, id: unknown) => {
    if (!trusted(event) || id !== petTransition || petTransition === undefined) return false;
    // 保持原生透明且不可聚焦地挂回合成树，隐藏窗口可能不产出新帧。
    if (quitting || window.isDestroyed()) return false;
    window.showInactive();
    // RAF 只保证 DOM 已更新；等待合成器产出新帧，避免显示上一次收起的缓存画面。
    // 仅换屏时读取 1 像素，不编码、不保存，也不截取用户桌面。
    await window.webContents.capturePage({ x: 0, y: 0, width: 1, height: 1 }, { stayHidden: true });
    if (window.isDestroyed() || quitting || id !== petTransition) return false;
    const reveal = !captureSession && (!suspended || panelView === 'settings');
    if (!reveal) hideMainWindow();
    petTransition = undefined;
    window.setOpacity(1);
    applyWindowMode();
    if (reveal) {
      showMainWindow();
      if (panelView === 'settings') activateWindow();
      else if ((panelView === 'prompt' || panelView === 'graph') && promptActivation?.phase === 'ready') void focusInput(activationEpoch);
    }
    return true;
  });
}

async function registerActivationKey(): Promise<void> {
  if (process.platform !== 'win32') {
    registerPlatformShortcut(store.getPublic().activationShortcut);
    return;
  }
  const service = createWindowsNative({
    onTriggerBegin(captureId) { activatePrompt(false, captureId); },
    onTriggerHold(captureId) { if (captureSession?.nativeId === captureId) holdCapture(captureSession); },
    onTriggerEnd(captureId) { if (captureSession?.nativeId === captureId) endCapture(); },
    onTriggerCancel(captureId) { if (captureSession?.nativeId === captureId) cancelCapture(false); },
    onSelectionPointer(captureId, phase, point) { if (captureSession?.nativeId === captureId) selectionPointer(phase, point); },
    onPointerDown: nativePointerDown,
    onPointerUp: nativePointerUp,
    onFullscreen(fullscreen) { setSuspended(store.getPublic().pauseOnFullscreen && fullscreen); },
    onError() { windowsNative = undefined; cancelCapture(false); setSuspended(false); tray.setToolTip('RabbitBall · 全局启动键暂不可用'); },
  });
  windowsNative = service;
  const configured = configureNative();
  try { await Promise.all([service.ready, configured]); }
  catch (error) { service.stop(); if (windowsNative === service) windowsNative = undefined; throw error; }
}

async function createWindow(): Promise<void> {
  activationEffect = new ActivationEffectWindow();
  void activationEffect.prepare().catch(() => {});
  captureOverlays = new CaptureOverlays(() => cancelCapture());
  // 空闲预加载无图像的轻量页；真正截图仍在达到长按阈值之后开始。
  void captureOverlays.prepare(captureViewports()).catch(() => {});
  if (process.platform === 'win32') void captureWorker.prepare().catch(() => {});
  const area = screen.getPrimaryDisplay().workArea;
  window = new BrowserWindow({
    icon: path.join(app.getAppPath(), 'resources', 'icons', 'rabbitball.ico'),
    ...area, show: false, frame: false, transparent: true, resizable: false, thickFrame: false, backgroundColor: '#00000000', skipTaskbar: true, focusable: false,
    webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  if (process.platform === 'win32') {
    const bytes = window.getNativeWindowHandle();
    const handle = bytes.length >= 8 ? bytes.readBigUInt64LE().toString() : bytes.readUInt32LE().toString();
    if (!await windowsNative?.prepareOverlayWindow(handle)) throw new Error('无法初始化兔球悬浮窗口。');
  }
  applyWindowMode();
  window.setMenu(null);
  const openExternal = (url: string) => { if (/^https?:\/\//i.test(url)) void shell.openExternal(url); };
  window.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  window.webContents.on('will-navigate', (event, url) => { event.preventDefault(); openExternal(url); });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.on('close', event => { if (!quitting) { event.preventDefault(); hidePanel('window-close'); } });
  window.on('focus', () => {
    if (process.platform !== 'win32' && registeredShortcut) globalShortcut.unregister(registeredShortcut);
    debugWindow('focus');
  });
  window.on('blur', () => {
    if (graphPinPressed) { graphPinPressed = false; applyWindowMode(); }
    finishShortcutRecording();
    if (process.platform !== 'win32' && !shortcutRecording && !quitting) {
      try { registerPlatformShortcut(store.getPublic().activationShortcut); }
      catch (error) { dialog.showErrorBox('启动键注册失败', error instanceof Error ? error.message : '请在设置中重新选择启动键。'); }
    }
    debugWindow('blur');
  });
  window.webContents.on('render-process-gone', finishShortcutRecording);
  window.webContents.on('did-start-loading', () => { graphImageCache.clear(); graphPinRegions = []; interactive = false; graphPinPressed = false; applyWindowMode(); });
  window.webContents.on('destroyed', finishShortcutRecording);
  window.on('always-on-top-changed', () => debugWindow('always-on-top-changed'));
  await window.loadFile(path.join(app.getAppPath(), 'prototype', 'index.html'));
  await configureNative();
  window.webContents.send('rabbit:suspended', suspended);
  if (!suspended) showMainWindow();
  debugWindow('ready');
  let last = '';
  cursorTimer = setInterval(() => {
    if (window.isDestroyed() || suspended) return;
    const point = screen.getCursorScreenPoint();
    if (captureSession?.visible) updateCaptureFrame(captureSession);
    const [x, y] = window.getPosition();
    const key = point.x + ',' + point.y + ',' + x + ',' + y;
    if (key === last) return;
    last = key;
    const cursor = desktopCursor(point);
    updateGraphPinHover(cursor);
    window.webContents.send('rabbit:cursor', cursor);
  }, 1000 / 30);
}

const quitRequested = process.argv.includes('--rabbitball-quit');
if (!app.requestSingleInstanceLock({ command: quitRequested ? 'quit' : 'open' }) || quitRequested) app.quit();
else {
  app.on('second-instance', (_event, _argv, _directory, data) => {
    if ((data as { command?: unknown })?.command === 'quit') app.quit();
    else if (window && !window.isDestroyed()) openSettings();
  });
  app.on('before-quit', event => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    captureWorker.stop(); shortcutRecording = false; invalidateInput(); cancelActiveRequest(); graphJobs?.cancelAll();
    cancelCapture(); captureOverlays?.dispose(); activationEffect?.dispose(); windowsNative?.stop();
    // 等待已排队的历史写入完成再退出，停止生成的最后一段文字也能恢复。
    void Promise.all([historyStore?.flush(), graphJobs?.idle().then(() => graphStore.flush())]).catch(error => console.error('保存记录失败：', error)).finally(() => { graphStore?.dispose(); app.quit(); });
  });
  app.on('will-quit', () => { if (cursorTimer) clearInterval(cursorTimer); globalShortcut.unregisterAll(); });
  void app.whenReady().then(async () => {
    app.setAppUserModelId('com.rabbitball.desktop');
    store = new SettingsStore();
    const settings = await store.load();
    historyStore = new HistoryStore(app.getPath('userData'), settings.historyLimit);
    await historyStore.load();
    graphStore = new GraphStore(await resolveGraphDirectory(app.getPath('userData'), app.getPath('documents')), graphChanged, error => emitGraphError(error, (error as Error & { workspaceId?: string }).workspaceId));
    await graphStore.load();
    graphJobs = new GraphJobs(graphStore, () => store.getPrivate());
    const displaysChanged = () => {
      if (captureSession) cancelCapture();
      void captureOverlays?.prepare(captureViewports()).catch(() => {});
      if (window && !window.isDestroyed()) window.webContents.send('rabbit:cursor', desktopCursor());
    };
    screen.on('display-added', displaysChanged);
    screen.on('display-removed', displaysChanged);
    screen.on('display-metrics-changed', displaysChanged);
    tray = new Tray(createTrayIcon());
    tray.setToolTip('RabbitBall');
    tray.on('click', openSettings);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '设置', click: openSettings },
      { label: '快速提问', click: () => { void activatePrompt(); } },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ]));
    registerIpc();
    try { await registerActivationKey(); }
    catch (error) { dialog.showErrorBox('启动键注册失败', error instanceof Error ? error.message : '无法注册启动键，请通过托盘菜单打开。'); }
    if (quitting) return;
    await createWindow();
  }).catch(error => { dialog.showErrorBox('RabbitBall 启动失败', error instanceof Error ? error.message : String(error)); app.quit(); });
}
