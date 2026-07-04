// src/components/nodes/SubagentNode.tsx
//
// Nó-FILHO de SUBAGENTE: representa um subagente NATIVO do Claude Code plugado num agente
// CLI pai. Materializa um `.claude/agents/<slug>.md` na pasta do pai (escrito no spawn via
// subagent_write). É PRIVADO do pai — só aquele Claude o invoca (Task tool); NÃO entra no
// time MCP. É uma DEFINIÇÃO (arquivo), não um processo vivo: nó leve, sem PTY/ACP.

import { memo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { UserRoundCheck, Pencil, X } from "lucide-react";

import { useCanvasStore } from "@/store/canvas-store";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import type { SubagentNode as SubagentNodeData } from "@/types/canvas";

type SubagentRfNode = Node<SubagentNodeData & Record<string, unknown>, "subagent">;

/** Modelos do Claude Code p/ subagente (frontmatter `model:`). "" = herda do pai. */
const SUB_MODELS = ["", "haiku", "sonnet", "opus"];

function SubagentNodeImpl({ data, selected }: NodeProps<SubagentRfNode>) {
  const removeNode = useCanvasStore((s) => s.removeNode);
  const patchNode = useCanvasStore((s) => s.patchNode);
  const t = useT();
  const [saving, setSaving] = useState(false);
  // Modelo PERSONALIZADO: quem roda claude via wrapper/proxy (ex: claude-glm52 → glm-5.2)
  // opera um modelo fora de haiku/sonnet/opus — o frontmatter `model:` aceita qualquer string.
  const [customEditing, setCustomEditing] = useState(false);
  const [customDraft, setCustomDraft] = useState("");

  // Troca o modelo do subagente: persiste no nó + RE-ESCREVE o .claude/agents/<slug>.md com o
  // novo `model:` (ex: haiku pra tarefa barata). "" = remove o campo → herda o modelo do pai.
  async function changeModel(model: string) {
    patchNode(data.id, { model });
    if (!data.prompt) return; // sem o prompt guardado não dá pra re-escrever (subagente antigo)
    setSaving(true);
    try {
      await invoke("subagent_write", {
        dir: data.cwd ?? "",
        name: data.label,
        description: data.description ?? "",
        prompt: data.prompt,
        tools: null,
        model: model || null,
      });
    } catch {
      /* falha ao gravar → o nó já reflete a escolha; tenta de novo no próximo change */
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className={cn(
        "node-drag-handle flex h-full w-full flex-col rounded-lg border bg-bg/95 text-xs",
        selected ? "border-amber-400" : "border-amber-500/30",
      )}
    >
      {/* Recebe a linha vertical do pai (alça de baixo do agente). */}
      <Handle type="target" position={Position.Top} className="!bg-amber-400 !border-surface1" />

      <div className="flex items-center gap-1.5 border-b border-amber-500/20 px-2 py-1.5">
        <UserRoundCheck size={13} className="shrink-0 text-amber-400" />
        <span className="min-w-0 flex-1 truncate font-semibold text-text">{data.label}</span>
        <span className="shrink-0 rounded bg-amber-500/15 px-1 py-0.5 text-[8px] uppercase tracking-wide text-amber-300">
          {t("subagent.badge", "subagente")}
        </span>
        {/* Editor completo: papel/persona + LLM (galeria de providers) + templates. */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            window.dispatchEvent(
              new CustomEvent("omnirift:edit-subagent", {
                detail: {
                  nodeId: data.id,
                  label: data.label,
                  description: data.description,
                  prompt: data.prompt,
                  model: data.model,
                  cwd: data.cwd,
                },
              }),
            );
          }}
          className="shrink-0 rounded p-0.5 text-text/50 hover:bg-white/10 hover:text-amber-300"
          title={t("subagent.edit", "Editar papel, persona e LLM do subagente")}
        >
          <Pencil size={12} />
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); removeNode(data.id); }}
          className="shrink-0 rounded p-0.5 text-text/50 hover:bg-white/10 hover:text-text"
          title={t("common.close", "Fechar")}
        >
          <X size={12} />
        </button>
      </div>

      {/* min-h-0: sem isso o flex estica e a linha do modelo vaza do card (nós antigos têm 120px). */}
      <div className="min-h-0 flex-1 space-y-1 overflow-hidden p-2">
        {/* Escopo HONESTO: global (~/.claude/agents, todos veem) vs privado de um projeto.
            "privado de <pai>" só vale quando o subagente está num cwd próprio (project). */}
        {data.scope === "global" ? (
          <div className="flex items-center gap-1 text-[10px] text-amber-300/90" title={t("subagent.globalTip", "Está em ~/.claude/agents — qualquer agente Claude no seu PC enxerga. Abra um projeto p/ deixá-lo privado.")}>
            <span className="rounded bg-amber-500/20 px-1 py-0.5 text-[8px] font-semibold uppercase tracking-wide">{t("subagent.global", "global")}</span>
            {t("subagent.globalScope", "visível a TODOS os agentes")}
          </div>
        ) : data.scope === "project" ? (
          <div className="text-[10px] text-text/50">
            {t("subagent.privateProject", "privado do projeto")}{" "}
            <span className="font-medium text-text/80">{(data.cwd ?? "").split("/").filter(Boolean).pop() ?? data.parentLabel}</span>
          </div>
        ) : data.parentLabel ? (
          <div className="text-[10px] text-text/50">
            {t("subagent.privateOf", "privado de")}{" "}
            <span className="font-medium text-text/80">{data.parentLabel}</span>
          </div>
        ) : null}
        {data.description && (
          <div className="line-clamp-2 text-[10px] leading-snug text-text/60">{data.description}</div>
        )}
        <div className="truncate text-[9px] font-mono text-text/35" title={data.filePath}>
          {data.filePath ? `.claude/agents/${data.filePath.split("/").pop()}` : ".claude/agents/…"}
        </div>
        {/* Modelo do subagente — rode barato (haiku) numa tarefa simples em vez do modelo caro do pai. */}
        <div className="nodrag flex items-center gap-1 pt-0.5" onPointerDown={(e) => e.stopPropagation()}>
          <span className="text-[9px] text-text/40">{t("subagent.model", "modelo")}</span>
          {customEditing ? (
            <input
              autoFocus
              value={customDraft}
              onChange={(e) => setCustomDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") { void changeModel(customDraft.trim()); setCustomEditing(false); }
                if (e.key === "Escape") setCustomEditing(false);
                e.stopPropagation();
              }}
              onBlur={() => { if (customDraft.trim()) void changeModel(customDraft.trim()); setCustomEditing(false); }}
              placeholder={t("subagent.modelCustomPh", "ex: glm-5.2, kimi-k2.7…")}
              className="flex-1 rounded border border-amber-400/50 bg-black/30 px-1 py-0.5 text-[10px] text-text outline-none"
            />
          ) : (
            <select
              value={data.model ?? ""}
              onChange={(e) => {
                if (e.target.value === "__custom") { setCustomDraft(data.model ?? ""); setCustomEditing(true); return; }
                void changeModel(e.target.value);
              }}
              className="flex-1 rounded bg-black/20 px-1 py-0.5 text-[10px] text-text outline-none"
              title={t("subagent.modelTip", "Modelo do subagente (frontmatter). Vazio = herda o do pai; personalizado aceita QUALQUER modelo (wrappers/proxies como claude-glm52).")}
            >
              {SUB_MODELS.map((m) => (
                <option key={m || "inherit"} value={m}>{m || t("subagent.modelInherit", "herda do pai")}</option>
              ))}
              {/* Valor atual fora da lista (wrapper/proxy) → aparece selecionável */}
              {data.model && !SUB_MODELS.includes(data.model) && (
                <option value={data.model}>{data.model}</option>
              )}
              <option value="__custom">{t("subagent.modelCustom", "personalizado…")}</option>
            </select>
          )}
          {saving && <span className="text-[9px] text-amber-300/70">…</span>}
        </div>
      </div>
    </div>
  );
}

export const SubagentNode = memo(SubagentNodeImpl);
