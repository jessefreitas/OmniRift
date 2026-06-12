import type { CanvasEdge, CanvasNode } from "./canvas";

export interface WorkspaceFile {
  version: 1;
  name: string;
  cwd: string | null;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}
