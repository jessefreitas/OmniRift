// Core domain types shared between frontend packages and Tauri commands

export interface PtySession {
  id: string;
  title: string;
  role?: string;
}

export interface AgentNode {
  id: string;
  label: string;
  role?: string;
  ptyId?: string;
  position: { x: number; y: number };
}

export interface AgentEdge {
  id: string;
  source: string;
  target: string;
}

export interface CanvasWorkspace {
  id: string;
  name: string;
  nodes: AgentNode[];
  edges: AgentEdge[];
  createdAt: string;
  updatedAt: string;
}

export type NodeOutputEvent = {
  sessionId: string;
  data: string;
};
