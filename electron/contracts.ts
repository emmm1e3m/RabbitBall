export type ReasoningLevel = 'low' | 'medium' | 'high';

export interface PromptSettings {
  system: string;
  search: string;
  extract: string;
  translate: string;
  fallback: string;
  searchTool: string;
}

export type PromptOverrides = Partial<PromptSettings>;

export interface SettingsFields {
  apiBaseUrl: string;
  model: string;
  reasoning: ReasoningLevel;
  petSize: number;
  bodyColor: string;
  eyeColor: string;
  launchAtLogin: boolean;
  pauseOnFullscreen: boolean;
  followMouse: boolean;
  autoCopyScreenshots: boolean;
  activationShortcut: string[];
  prompts: PromptSettings;
}

export interface PublicSettings extends SettingsFields {
  hasApiKey: boolean;
}

export interface PrivateSettings extends SettingsFields {
  apiKey: string;
}

export type SettingsPatch = Omit<Partial<SettingsFields>, 'prompts'> & { apiKey?: string; prompts?: PromptOverrides };

export interface CaptureImage {
  id: string;
  title: string;
  source?: 'window' | 'region';
  appName?: string;
  processName?: string;
  pixelSize?: { width: number; height: number };
  imageDataUrl: string;
  cursor?: { x: number; y: number; width: number; height: number; inside: boolean };
}

export interface CaptureContext {
  id: string;
  title: string;
  images: CaptureImage[];
  error?: string;
  capturedAt: number;
  // 发送到 renderer 时，以宠物窗口左上角为原点的 DIP 矩形。
  focusBounds?: { x: number; y: number; width: number; height: number };
}

export interface Attachment {
  id: string;
  name: string;
  mimeType: string;
  dataUrl?: string;
  text?: string;
}

export interface AgentRequest {
  id: string;
  text: string;
  action?: 'ask' | 'search' | 'extract' | 'translate';
  contextId?: string;
  imageIds?: string[];
  conversationId: string;
  turnId: string;
  regenerate?: boolean;
  attachments?: Attachment[];
}

export interface AgentEvent {
  id: string;
  type: 'start' | 'delta' | 'tool' | 'done' | 'error' | 'cancelled';
  text?: string;
  name?: string;
  message?: string;
  sources?: Array<{ title: string; url: string }>;
  toolCounts?: Record<string, number>;
}

export interface Activation {
  activationId: number;
  view: 'prompt' | 'settings';
  context?: CaptureContext;
  anchor?: { x: number; y: number };
}

export interface CursorPoint {
  x: number;
  y: number;
  displayOrigin: { x: number; y: number };
  screen: { x: number; y: number };
  viewport: { x: number; y: number; scale: number };
  followBounds: { x: number; y: number; width: number; height: number };
  transitionId?: number;
  resetEntry?: boolean;
}

export interface PointerPoint {
  x: number;
  y: number;
}

export type CaptureEvent =
  | { type: 'start'; sessionId: string; context: CaptureContext; backgroundImageDataUrl?: string; backgroundBitmap?: { data: Uint8Array; width: number; height: number }; width: number; height: number; dragStart?: PointerPoint; shortcut?: string[]; color?: string }
  | { type: 'frame'; sessionId: string; rect?: { x: number; y: number; width: number; height: number } }
  | { type: 'pointer'; sessionId: string; phase: 'down' | 'up'; x: number; y: number }
  | { type: 'image'; sessionId: string; context: CaptureContext; rect: { x: number; y: number; width: number; height: number } }
  | { type: 'end' | 'cancel'; sessionId: string };

export interface RabbitDesktop {
  platform: NodeJS.Platform;
  loadSettings(): Promise<PublicSettings>;
  saveSettings(patch: SettingsPatch): Promise<PublicSettings>;
  sendMessage(request: AgentRequest): Promise<void>;
  cancelMessage(id: string): void;
  onActivate(listener: (activation: Activation) => void): () => void;
  onDismiss(listener: (activationId: number) => void): () => void;
  onAgentEvent(listener: (event: AgentEvent) => void): () => void;
  onSettingsChanged(listener: (settings: PublicSettings) => void): () => void;
  onCursor(listener: (point: CursorPoint) => void): () => void;
  onPointerDown(listener: (point: PointerPoint) => void): () => void;
  onCaptureEvent(listener: (event: CaptureEvent) => void): () => void;
  onSuspended(listener: (suspended: boolean) => void): () => void;
  cancelCapture(): void;
  focusInput(activationId: number): Promise<boolean>;
  setShortcutRecording(recording: boolean): Promise<void>;
  hidePanel(activationId: number): void;
  openSettings(): void;
  setInteractive(enabled: boolean, activationId?: number): void;
  reportPetPosition(point: PointerPoint): void;
  petViewportReady(transitionId: number): Promise<boolean>;
}
