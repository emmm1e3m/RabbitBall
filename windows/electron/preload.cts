import { contextBridge, ipcRenderer } from 'electron';
import type { Activation, AgentEvent, AgentRequest, CaptureEvent, CaptureImage, CursorPoint, GraphPinInteraction, GraphPinRegions, HistoryEntry, HistorySummary, PointerPoint, PublicSettings, RabbitDesktop, SettingsPatch } from './contracts.js';
import type { GraphCaptureRequest, GraphGenerateRequest, GraphMutation, GraphNodeRequest, GraphWorkspace, GraphWorkspaceSummary } from './graph-contracts.js';

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, value: T) => listener(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

let observedPanelOwner: number | undefined;

const desktop: RabbitDesktop = {
  platform: process.platform,
  graphList: () => ipcRenderer.invoke('rabbit:graph-list') as Promise<GraphWorkspaceSummary[]>,
  graphOpen: (id?: string) => ipcRenderer.invoke('rabbit:graph-open', id) as Promise<GraphWorkspace>,
  graphActivate: (action?: 'rename-graph' | 'undo' | 'redo') => ipcRenderer.invoke('rabbit:graph-activate', action) as Promise<void>,
  graphCreate: (name: string) => ipcRenderer.invoke('rabbit:graph-create', name) as Promise<GraphWorkspace>,
  graphMutate: (id: string, mutation: GraphMutation) => ipcRenderer.invoke('rabbit:graph-mutate', id, mutation) as Promise<GraphWorkspace>,
  graphRevealDocument: (id: string) => ipcRenderer.invoke('rabbit:graph-reveal-document', id) as Promise<void>,
  graphCapture: (request: GraphCaptureRequest) => ipcRenderer.invoke('rabbit:graph-capture', request) as Promise<void>,
  graphCaptureImages: (request: GraphCaptureRequest & { nodeId?: string }) => ipcRenderer.invoke('rabbit:graph-capture-images', request) as Promise<CaptureImage[] | null>,
  graphGenerate: (request: GraphGenerateRequest) => ipcRenderer.invoke('rabbit:graph-generate', request) as Promise<void>,
  graphRegenerate: (request: GraphNodeRequest) => ipcRenderer.invoke('rabbit:graph-regenerate', request) as Promise<void>,
  graphCancel: (request: GraphNodeRequest) => ipcRenderer.send('rabbit:graph-cancel', request),
  onGraphChanged: (listener: (workspace: GraphWorkspace) => void) => subscribe('rabbit:graph-changed', listener),
  onGraphError: (listener: (error: { workspaceId?: string; message: string }) => void) => subscribe('rabbit:graph-error', listener),
  editText: (action: 'cut' | 'copy' | 'selectAll' | 'undo' | 'redo') => ipcRenderer.invoke('rabbit:edit-text', action) as Promise<void>,
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
  playActivationEffect: (origin: PointerPoint, activationId: number, color: string) => ipcRenderer.send('rabbit:activation-effect', origin, activationId, color),
  setShortcutRecording: (recording: boolean) => ipcRenderer.invoke('rabbit:shortcut-recording', recording) as Promise<void>,
  hidePanel: (activationId: number) => ipcRenderer.send('rabbit:hide-panel', activationId),
  openSettings: () => ipcRenderer.send('rabbit:open-settings'),
  // 全局鼠标命中检测跟随当前呈现的面板；显式视图清理由调用方携带自己的轮次。
  setInteractive: (enabled: boolean, activationId?: number) => ipcRenderer.send('rabbit:set-interactive', enabled, activationId ?? observedPanelOwner),
  setGraphPinRegions: (regions: GraphPinRegions) => ipcRenderer.send('rabbit:set-graph-pin-regions', regions),
  graphPinInteraction: (interaction: GraphPinInteraction) => ipcRenderer.invoke('rabbit:graph-pin-interaction', interaction) as Promise<boolean>,
  reportPetPosition: (point: PointerPoint) => ipcRenderer.send('rabbit:pet-position', point),
  petViewportReady: (transitionId: number) => ipcRenderer.invoke('rabbit:pet-viewport-ready', transitionId) as Promise<boolean>,
};

contextBridge.exposeInMainWorld('rabbitDesktop', desktop);
