// src/types/canvas.ts
//
// Tipagem dos nós que vivem no canvas (React Flow).
// Cada nó tem um `kind` discriminador para que tipos distintos possam viver no mesmo store.

import type { AgentRole, SessionId } from "./pty";

export type NodeKind =
  | "terminal"
  | "note"
  | "sketch"
  | "portal"
  | "filetree"
  | "group"
  | "api"
  | "db"
  | "devtools"
  | "json"
  | "explain"
  | "preview"
  | "code"
  | "pdf"
  | "html";

export interface BaseCanvasNode {
  id: string;
  kind: NodeKind;
  position: { x: number; y: number };
  size: { width: number; height: number };
  /** Id do GroupNode pai — quando setado, `position` é relativa ao pai (move junto). */
  parentId?: string;
  /** Comentário/anotação livre do usuário sobre este nó. */
  comment?: string;
}

export interface TerminalNode extends BaseCanvasNode {
  kind: "terminal";
  /** Id da sessão PTY no backend. */
  session_id: SessionId;
  /** Comando spawnado — apenas para exibição/serialização. */
  command: string;
  /** Argumentos do comando (ex.: claude --append-system-prompt "..."). */
  args?: string[];
  /** Papel atribuído ao agente (Fase 3). */
  role: AgentRole;
  /** Nome amigável que o usuário deu — opcional. */
  label?: string;
  /** Pasta de trabalho do processo. */
  cwd?: string;
  /** Env extra injetada no spawn (ex.: decoração do compressor — só env). */
  env?: Array<[string, string]>;
  /** Compressor de token ativo neste agente (kind: "rtk"|"headroom"|"none"). */
  compressor?: string;
}

export interface NoteNode extends BaseCanvasNode {
  kind: "note";
  content: string;
  /** Cor do sticky (hex). */
  color?: string;
}

export interface SketchNode extends BaseCanvasNode {
  kind: "sketch";
  /** Estado serializado do tldraw (Fase 4). */
  snapshot?: string;
}

export interface PortalNode extends BaseCanvasNode {
  kind: "portal";
  url: string;
}

export interface FileTreeNode extends BaseCanvasNode {
  kind: "filetree";
  /** Raiz da árvore exibida (default = cwd do floor). */
  rootPath: string;
}

export interface GroupNode extends BaseCanvasNode {
  kind: "group";
  /** Rótulo do frame de agrupamento. */
  label?: string;
  /** Cor da borda/realce (hex). */
  color?: string;
}

export interface ApiNode extends BaseCanvasNode {
  kind: "api";
  url: string;
  method: string; // GET | POST | PUT | PATCH | DELETE | ...
  body?: string;
}

export interface DbNode extends BaseCanvasNode {
  kind: "db";
  /** Caminho do arquivo SQLite. */
  dbPath: string;
  /** Última query rodada — persistida no node. */
  sql: string;
}

export interface DevToolsNode extends BaseCanvasNode {
  kind: "devtools";
  /** Id da ferramenta selecionada (ver DEV_TOOLS). */
  tool: string;
  /** Texto de entrada persistido. */
  input: string;
}

export interface JsonNode extends BaseCanvasNode {
  kind: "json";
  /** Documento JSON cru (texto). */
  text: string;
}

export interface ExplainNode extends BaseCanvasNode {
  kind: "explain";
  /** Linha de comando shell a explicar. */
  command: string;
}

export interface PreviewNode extends BaseCanvasNode {
  kind: "preview";
  /** Caminho do arquivo a pré-visualizar (.md renderizado, .html em iframe). */
  path: string;
}

export interface CodeNode extends BaseCanvasNode {
  kind: "code";
  /** Caminho do arquivo aberto no editor Monaco. */
  filePath: string;
}

export interface PdfNode extends BaseCanvasNode {
  kind: "pdf";
  /** Caminho do arquivo .pdf renderizado via pdf.js (canvas). */
  filePath: string;
}

export interface HtmlNode extends BaseCanvasNode {
  kind: "html";
  /** Caminho do arquivo .html exibido via asset protocol (iframe local). */
  filePath: string;
}

export type CanvasNode =
  | TerminalNode
  | NoteNode
  | SketchNode
  | PortalNode
  | FileTreeNode
  | GroupNode
  | ApiNode
  | DbNode
  | DevToolsNode
  | JsonNode
  | ExplainNode
  | PreviewNode
  | CodeNode
  | PdfNode
  | HtmlNode;

/**
 * Patch parcial pra `patchNode` — todos os campos editáveis de qualquer node,
 * opcionais. (A interseção `Partial<A & B>` colapsaria pra `never` por causa do
 * `kind` conflitante, então listamos explícito.)
 */
export interface CanvasNodePatch {
  position?: { x: number; y: number };
  size?: { width: number; height: number };
  label?: string;
  content?: string;
  color?: string;
  command?: string;
  args?: string[];
  role?: AgentRole;
  cwd?: string;
  url?: string;
  snapshot?: string;
  rootPath?: string;
  method?: string;
  body?: string;
  dbPath?: string;
  sql?: string;
  tool?: string;
  input?: string;
  text?: string;
  path?: string;
  filePath?: string;
  comment?: string;
}

/** Conexão entre nós. */
export interface CanvasEdge {
  id: string;
  source: string;
  target: string;
  /** Para terminais conectados, o output do source vai como input do target. */
  kind: "pty-pipe" | "note-link" | "generic";
}
