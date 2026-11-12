import type { CaptureImage } from './contracts.js';

export type GraphImage = CaptureImage & { file?: string };

export type GraphSelection =
  | { kind: 'text'; text: string; start?: number; end?: number }
  | { kind: 'image'; imageId: string; rect: { x: number; y: number; width: number; height: number } };

export interface GraphAnnotation {
  id: string;
  selection: GraphSelection;
  comment: string;
  childId?: string;
  images?: GraphImage[];
}

export interface GraphSource {
  // 来源被删除后仍保留选区和图片快照，避免让跨图移动的卡片失去资料。
  nodeId?: string;
  annotationId?: string;
  selection: GraphSelection;
  comment: string;
  revision: number;
  images?: GraphImage[];
  selectionImage?: GraphImage;
}

export interface GraphGeneration {
  id: string;
  contentRevision: number;
  startedAt?: number;
  finishedAt?: number;
  toolCounts?: Record<string, number>;
}

export interface GraphNode {
  id: string;
  parentId: string | null;
  kind: 'source' | 'card';
  title: string;
  markdown: string;
  images: GraphImage[];
  annotations: GraphAnnotation[];
  source?: GraphSource;
  pinned: boolean;
  x: number;
  y: number;
  contentRevision: number;
  status: 'idle' | 'queued' | 'generating' | 'error' | 'cancelled';
  draft?: string;
  candidate?: { title: string; markdown: string };
  error?: string;
  generation?: GraphGeneration;
}

export interface KnowledgeGraph {
  id: string;
  title: string;
  rootId: string;
  nodes: GraphNode[];
  view: { x: number; y: number; zoom: number };
  updatedAt: number;
  layoutInitialized: boolean;
  layoutUnit: number;
}

export interface GraphWorkspace {
  id: string;
  name: string;
  revision: number;
  updatedAt: number;
  lastGraphId?: string;
  graphs: KnowledgeGraph[];
}

export interface GraphWorkspaceSummary {
  id: string;
  name: string;
  updatedAt: number;
  graphCount: number;
}

export type GraphMutation =
  | { type: 'rename-workspace'; name: string }
  | { type: 'create-graph'; title?: string }
  | { type: 'add-root'; graphId: string; markdown: string; images: GraphImage[] }
  | { type: 'add-custom-node'; graphId: string; parentId: string; markdown: string; images: GraphImage[] }
  | { type: 'append-node-images'; graphId: string; nodeId: string; images: GraphImage[] }
  | { type: 'rename-graph'; graphId: string; title: string }
  | { type: 'visit'; graphId: string }
  | { type: 'view'; graphId: string; view: KnowledgeGraph['view'] }
  | { type: 'layout'; graphId: string; unit: number; positions: Array<{ id: string; x: number; y: number }> }
  | { type: 'edit'; graphId: string; nodeId: string; title: string; markdown: string; contentRevision: number }
  | { type: 'annotation'; graphId: string; nodeId: string; annotation: GraphAnnotation }
  | { type: 'remove-annotation'; graphId: string; nodeId: string; annotationId: string }
  | { type: 'pin'; graphId: string; nodeId: string; pinned: boolean }
  | { type: 'reparent'; graphId: string; nodeId: string; parentId: string }
  | { type: 'move-subtree'; graphId: string; nodeId: string; targetGraphId: string; targetNodeId?: string }
  | { type: 'delete'; graphId: string; nodeId: string }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'accept-candidate'; graphId: string; nodeId: string }
  | { type: 'add-card'; graphId: string; parentId: string; title: string; markdown: string };

export interface GraphNodeRequest { workspaceId: string; graphId: string; nodeId: string }
export interface GraphCaptureRequest { workspaceId: string; graphId: string }
export interface GraphGenerateRequest extends GraphNodeRequest { annotationIds?: string[] }
export interface GraphDocument { markdown: string; revision: number; path: string }

export interface GraphDesktop {
  graphList(): Promise<GraphWorkspaceSummary[]>;
  graphOpen(workspaceId?: string): Promise<GraphWorkspace>;
  graphCreate(name: string): Promise<GraphWorkspace>;
  graphMutate(workspaceId: string, mutation: GraphMutation): Promise<GraphWorkspace>;
  graphRevealDocument(workspaceId: string): Promise<void>;
  graphCapture(request: GraphCaptureRequest): Promise<void>;
  graphCaptureImages(request: GraphCaptureRequest & { nodeId?: string }): Promise<CaptureImage[] | null>;
  graphActivate(action?: 'rename-graph' | 'undo' | 'redo'): Promise<void>;
  graphGenerate(request: GraphGenerateRequest): Promise<void>;
  graphRegenerate(request: GraphNodeRequest): Promise<void>;
  graphCancel(request: GraphNodeRequest): void;
  // 事件中的已发送图片可用空 dataURL 复用同 id 的缓存；直接查询始终返回完整图片。
  onGraphChanged(listener: (workspace: GraphWorkspace) => void): () => void;
  onGraphError(listener: (error: { workspaceId?: string; message: string }) => void): () => void;
}
