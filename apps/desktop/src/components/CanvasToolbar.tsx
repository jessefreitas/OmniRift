// src/components/CanvasToolbar.tsx
//
// Barra flutuante no topo do canvas pra criar nodes (Fase 4). Cada botão chama
// um criador do store; o node nasce numa posição default e o usuário arrasta.

import type { LucideIcon } from "lucide-react";
import { Activity, Braces, Brain, Database, FileCode2, FileText, Filter, FolderTree, Frame, GitPullRequestArrow, Globe, Pencil, ScrollText, StickyNote, TerminalSquare, Webhook, Wrench, Zap } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";

import { useCanvasStore } from "@/store/canvas-store";
import { Tooltip } from "@/components/Tooltip";
import { WorkflowTemplatesMenu } from "@/components/WorkflowTemplatesMenu";
import { useT } from "@/lib/i18n";
import { isNodeKindAllowed, isPocket, useProductProfile } from "@/lib/product-profile";

function ToolBtn({
  label,
  icon: Icon,
  onClick,
  disabled,
}: {
  label: string;
  icon: LucideIcon;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <Tooltip label={label} side="bottom">
      <button
        onClick={onClick}
        disabled={disabled}
        className="p-1.5 rounded-lg text-textMuted hover:text-brand hover:bg-surface1 transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:text-textMuted disabled:hover:bg-transparent"
      >
        <Icon size={16} />
      </button>
    </Tooltip>
  );
}

export function CanvasToolbar() {
  const t = useT();
  const profile = useProductProfile();
  const pocket = isPocket(profile);
  const allow = (kind: Parameters<typeof isNodeKindAllowed>[0]) => isNodeKindAllowed(kind, profile);
  const addTerminal = useCanvasStore((s) => s.addTerminal);
  const addNote = useCanvasStore((s) => s.addNote);
  const addGroup = useCanvasStore((s) => s.addGroup);
  const addFileTree = useCanvasStore((s) => s.addFileTree);
  const addSketch = useCanvasStore((s) => s.addSketch);
  const addPortal = useCanvasStore((s) => s.addPortal);
  const addApiNode = useCanvasStore((s) => s.addApiNode);
  const addDbNode = useCanvasStore((s) => s.addDbNode);
  const addDevToolsNode = useCanvasStore((s) => s.addDevToolsNode);
  const addJsonNode = useCanvasStore((s) => s.addJsonNode);
  const addExplainNode = useCanvasStore((s) => s.addExplainNode);
  const addPreviewNode = useCanvasStore((s) => s.addPreviewNode);
  const addCodeNode = useCanvasStore((s) => s.addCodeNode);
  const addAgent = useCanvasStore((s) => s.addAgent);
  const addReviewNode = useCanvasStore((s) => s.addReviewNode);
  const addFilterNode = useCanvasStore((s) => s.addFilterNode);
  const currentCwd = useCanvasStore((s) => s.currentCwd);

  async function pickAndAddCode() {
    const sel = await open({ multiple: false, defaultPath: currentCwd ?? undefined });
    if (typeof sel === "string") addCodeNode({ filePath: sel });
  }

  return (
    <div className="absolute top-3 left-1/2 -translate-x-1/2 z-30 flex items-center gap-0.5 px-1.5 py-1 rounded-xl bg-surface2/90 backdrop-blur border border-border shadow-lg">
      {allow("terminal") && (
        <ToolBtn
          label={t("toolbar.terminal", "Terminal (shell)")}
          icon={TerminalSquare}
          onClick={() => addTerminal({ command: "bash", role: "shell", label: "shell" })}
        />
      )}
      {allow("agent") && (
        <ToolBtn
          label={t("toolbar.agent", "Agente (ACP — estruturado)")}
          icon={Brain}
          onClick={() => addAgent({})}
        />
      )}
      {allow("review") && (
        <ToolBtn label={t("toolbar.review", "Review (gate de diff na linha)")} icon={GitPullRequestArrow} onClick={() => addReviewNode()} />
      )}
      {allow("filter") && (
        <ToolBtn label={t("toolbar.filter", "Filtro (roteamento por conteúdo)")} icon={Filter} onClick={() => addFilterNode()} />
      )}
      {/* Workflow templates = orquestração avançada — some no Pocket. */}
      {!pocket && <WorkflowTemplatesMenu />}
      {allow("note") && <ToolBtn label={t("toolbar.note", "Nota")} icon={StickyNote} onClick={() => addNote()} />}
      {allow("group") && <ToolBtn label={t("toolbar.group", "Grupo (frame)")} icon={Frame} onClick={() => addGroup()} />}
      {allow("filetree") && (
        <ToolBtn
          label={currentCwd ? t("toolbar.fileTree", "Árvore de arquivos do projeto") : t("toolbar.openProjectFirst", "Abra um projeto primeiro")}
          icon={FolderTree}
          disabled={!currentCwd}
          onClick={() => currentCwd && addFileTree({ rootPath: currentCwd })}
        />
      )}
      {allow("sketch") && <ToolBtn label={t("toolbar.sketch", "Sketch (tldraw)")} icon={Pencil} onClick={() => addSketch()} />}
      {allow("portal") && <ToolBtn label={t("toolbar.portal", "Portal (browser)")} icon={Globe} onClick={() => addPortal()} />}
      {allow("api") && <ToolBtn label={t("toolbar.api", "API (cliente HTTP)")} icon={Webhook} onClick={() => addApiNode()} />}
      {allow("db") && <ToolBtn label={t("toolbar.db", "DB (SQLite)")} icon={Database} onClick={() => addDbNode()} />}
      {allow("devtools") && <ToolBtn label={t("toolbar.devtools", "DevTools (base64/JWT/hash/JSON⇄YAML…)")} icon={Wrench} onClick={() => addDevToolsNode()} />}
      {allow("json") && <ToolBtn label={t("toolbar.json", "JSON (formatar + árvore)")} icon={Braces} onClick={() => addJsonNode()} />}
      {allow("explain") && <ToolBtn label={t("toolbar.explain", "explainshell (explica comandos)")} icon={ScrollText} onClick={() => addExplainNode()} />}
      {allow("preview") && <ToolBtn label={t("toolbar.preview", "Preview (.md / .html)")} icon={FileText} onClick={() => addPreviewNode()} />}
      {allow("code") && <ToolBtn label={t("toolbar.code", "Código (editor Monaco)")} icon={FileCode2} onClick={() => void pickAndAddCode()} />}
      {!pocket && (
        <ToolBtn
          label={currentCwd ? t("toolbar.health", "Saúde do Projeto") : t("toolbar.openProjectFirst", "Abra um projeto primeiro")}
          icon={Activity}
          disabled={!currentCwd}
          onClick={() => currentCwd && window.dispatchEvent(new CustomEvent("omnirift:open-tool", { detail: "project-health" }))}
        />
      )}
      {!pocket && (
        <ToolBtn
          label={currentCwd ? t("toolbar.turbo", "TURBO (loop autônomo)") : t("toolbar.openProjectFirst", "Abra um projeto primeiro")}
          icon={Zap}
          disabled={!currentCwd}
          onClick={() => currentCwd && window.dispatchEvent(new CustomEvent("omnirift:open-tool", { detail: "turbo" }))}
        />
      )}
    </div>
  );
}
