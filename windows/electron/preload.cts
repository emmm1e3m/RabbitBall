import { contextBridge, ipcRenderer } from 'electron';
import type { Activation, AgentEvent, AgentRequest, CaptureEvent, CursorPoint, HistoryEntry, HistorySummary, PointerPoint, PublicSettings, RabbitDesktop, SettingsPatch } from './contracts.js';

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, value: T) => listener(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

let observedPanelOwner: number | undefined;

const desktop: RabbitDesktop = {
  platform: process.platform,
  editText: (action: 'cut' | 'copy' | 'selectAll') => ipcRenderer.invoke('rabbit:edit-text', action) as Promise<void>,
  readClipboardForPaste: () => ipcRenderer.invoke('rabbit:read-clipboard-for-paste') as Promise<{ text?: string; imageDataUrl?: string }>,
  loadSettings: () => ipcRenderer.invoke('rabbit:load-settings') as Promise<PublicSettings>,
  saveSettings: (patch: SettingsPatch) => ipcRenderer.invoke('rabbit:save-settings', patch) as Promise<PublicSettings>,
  listHistory: () => ipcRenderer.invoke('rabbit:list-history') as Promise<HistorySummary[]>,
  getHistory: (id: string) => ipcRenderer.invoke('rabbit:get-history', id) as Promise<HistoryEntry | null>,
  deleteHistory: (id: string) => ipcRenderer.invoke('rabbit:delete-history', id) as Promise<void>,
  sendMessage: (request: AgentRequest) => ipcRenderer.invoke('rabbit:send-message', request) as Promise<void>,
  cancelMessage: (id: string) => ipcRenderer.send('rabbit:cancel-message', id),
  onActivate: (listener: (activation: Activation) => void) => subscribe<Activation>('rabbit:activate', activation => {
    observedPanelOwner = activation.activationId;
    listener(activation);
  }),
  onAgentEvent: (listener: (event: AgentEvent) => void) => subscribe('rabbit:agent-event', listener),
  onDismiss: (listener: (activationId: number) => void) => subscribe('rabbit:dismiss', listener),
  onSettingsChanged: (listener: (settings: PublicSettings) => void) => subscribe('rabbit:settings-changed', listener),
  onCursor: (listener: (point: CursorPoint) => void) => subscribe('rabbit:cursor', listener),
  onPointerDown: (listener: (point: PointerPoint) => void) => subscribe('rabbit:pointer-down', listener),
  onCaptureEvent: (listener: (event: CaptureEvent) => void) => subscribe('rabbit:capture-event', listener),
  onSuspended: (listener: (suspended: boolean) => void) => subscribe('rabbit:suspended', listener),
  cancelCapture: () => ipcRenderer.send('rabbit:cancel-capture'),
  focusInput: (activationId: number) => ipcRenderer.invoke('rabbit:focus-input', activationId) as Promise<boolean>,
  setShortcutRecording: (recording: boolean) => ipcRenderer.invoke('rabbit:shortcut-recording', recording) as Promise<void>,
  hidePanel: (activationId: number) => ipcRenderer.send('rabbit:hide-panel', activationId),
  openSettings: () => ipcRenderer.send('rabbit:open-settings'),
  // 全局鼠标命中检测跟随当前呈现的面板；显式视图清理由调用方携带自己的轮次。
  setInteractive: (enabled: boolean, activationId?: number) => ipcRenderer.send('rabbit:set-interactive', enabled, activationId ?? observedPanelOwner),
  reportPetPosition: (point: PointerPoint) => ipcRenderer.send('rabbit:pet-position', point),
  petViewportReady: (transitionId: number) => ipcRenderer.invoke('rabbit:pet-viewport-ready', transitionId) as Promise<boolean>,
};

contextBridge.exposeInMainWorld('rabbitDesktop', desktop);
