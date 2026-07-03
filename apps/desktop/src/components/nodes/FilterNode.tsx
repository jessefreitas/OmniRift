// src/components/nodes/FilterNode.tsx
//
// Fase 2c — roteamento por CONTEÚDO. Fica na linha entre nós e só deixa passar o payload que
// casa a condição. 4 modos:
//   - por tipo   (kind):  out.kind === valor            [diff/result/text]
//   - por regex  (regex): regex casa no texto+diff
//   - por caminho(path):  substring no path do diff
//   - por IA     (ai):    um LLM da Central decide por SIGNIFICADO (async; segura o payload em
//                         store.filterPending, avalia aqui, e re-emite se aprovar)
// Os 3 primeiros são síncronos (useConnectionRouting/passesFilter); o `ai` é async, aqui no nó.

import { memo, useEffect, useRef, useState } from "react";
import { Handle, NodeResizer, Position, type Node, type NodeProps } from "@xyflow/react";
import { Filter, Sparkles, X } from "lucide-react";

import { useCanvasStore } from "@/store/canvas-store";
import { llmProvidersList, llmProviderResolve, type LlmProvider as CentralProvider } from "@/lib/llm-providers-client";
import { llmChat, type LlmConfig, type LlmProvider } from "@/lib/llm-client";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import type { FilterNode as FilterNodeData } from "@/types/canvas";

type FilterRfNode = Node<FilterNodeData & Record<string, unknown>, "filter">;

/** Exemplos prontos (preenchem modo+valor com 1 clique). */
const EXAMPLES: { label: string; mode: FilterNodeData["mode"]; value: string }[] = [
  { label: "só código (diff)", mode: "kind", value: "diff" },
  { label: "só src/", mode: "path", value: "src/" },
  { label: "erros", mode: "regex", value: "error|erro|fail" },
  { label: "TODOs", mode: "regex", value: "TODO|FIXME" },
  { label: "só testes", mode: "path", value: "test" },
];

function FilterNodeImpl({ data, selected }: NodeProps<FilterRfNode>) {
  const removeNode = useCanvasStore((s) => s.removeNode);
  const updateFilterNode = useCanvasStore((s) => s.updateFilterNode);
  const emitAgentOutput = useCanvasStore((s) => s.emitAgentOutput);
  const setFilterPending = useCanvasStore((s) => s.setFilterPending);
  const updateNodeSize = useCanvasStore((s) => s.updateNodeSize);
  const pending = useCanvasStore((s) => s.filterPending[data.id]);
  const t = useT();

  // Nós criados antes do default maior (240×130) nascem espremidos — o modo IA nem
  // cabe. Cresce UMA vez pro mínimo do modo atual (guardado: só sobe se está menor,
  // então não re-dispara nem entra em loop). Conserta filtros já no canvas sem migração.
  useEffect(() => {
    const minH = data.mode === "ai" ? 250 : 160;
    if (data.size.height < minH || data.size.width < 300) {
      updateNodeSize(data.id, {
        width: Math.max(data.size.width, 300),
        height: Math.max(data.size.height, minH),
      });
    }
  }, [data.mode, data.size.height, data.size.width, data.id, updateNodeSize]);

  const [providers, setProviders] = useState<CentralProvider[]>([]);
  const [evalStatus, setEvalStatus] = useState<"idle" | "evaluating" | "pass" | "block">("idle");
  const evaluatedSeqRef = useRef(-1);

  // Providers da Central (pro modo IA).
  useEffect(() => {
    llmProvidersList().then(setProviders).catch(() => setProviders([]));
  }, []);

  // Modo IA: chegou um payload retido → resolve o provider da Central, pergunta ao LLM se casa
  // o critério (PASS/BLOCK) e re-emite se aprovar. seq evita reavaliar o mesmo payload.
  useEffect(() => {
    if (!pending || data.mode !== "ai" || !data.providerId) return;
    if (pending.seq === evaluatedSeqRef.current) return;
    evaluatedSeqRef.current = pending.seq;
    const providerId = data.providerId;
    void (async () => {
      setEvalStatus("evaluating");
      try {
        const r = await llmProviderResolve(providerId);
        const cfg: LlmConfig = {
          provider: (r.kind === "anthropic" ? "anthropic" : "openai") as LlmProvider,
          baseUrl: r.baseUrl,
          apiKey: r.key || undefined,
          model: data.model || r.model,
        };
        const verdict = await llmChat(
          cfg,
          "Você é um filtro binário. Responda APENAS com uma palavra: PASS ou BLOCK. Nada mais.",
          `CRITÉRIO: ${data.criterion ?? ""}\n\nCONTEÚDO:\n${pending.text}\n${pending.diff ?? ""}\n\nO conteúdo casa o critério? Responda PASS (deixa passar) ou BLOCK (bloqueia).`,
          { kind: "filter" },
        );
        const pass = /\bPASS\b/i.test(verdict) && !/\bBLOCK\b/i.test(verdict);
        if (pass) {
          emitAgentOutput(data.id, pending.text, { kind: pending.kind, diff: pending.diff, path: pending.path });
          setEvalStatus("pass");
        } else {
          setEvalStatus("block");
        }
      } catch {
        setEvalStatus("block");
      } finally {
        setFilterPending(data.id, null);
      }
    })();
  }, [pending, data.mode, data.providerId, data.model, data.criterion, data.id, emitAgentOutput, setFilterPending]);

  const ai = data.mode === "ai";
  const sel = "rounded bg-black/20 px-1.5 py-1 text-[11px] text-text outline-none";

  return (
    <div
      className={cn(
        "flex h-full w-full flex-col overflow-hidden rounded-lg border bg-bg text-xs",
        selected ? "border-brand" : "border-white/10",
      )}
    >
      <NodeResizer isVisible={selected} minWidth={260} minHeight={180} color="rgb(56 189 248)" handleStyle={{ width: 8, height: 8, borderRadius: 2 }} />
      <Handle type="target" position={Position.Left} className="!bg-sky-400 !border-surface1" />
      <Handle type="source" position={Position.Right} className="!bg-sky-400 !border-surface1" />

      <div className="node-drag-handle flex items-center gap-1.5 border-b border-white/10 px-2 py-1.5">
        <Filter size={13} className="text-sky-400" />
        <span className="flex-1 truncate font-semibold text-text">{data.label ?? "Filtro"}</span>
        {evalStatus === "evaluating" && <Sparkles size={11} className="animate-pulse text-purple-400" />}
        {evalStatus === "pass" && <span className="text-[10px] text-green-400">✅ passou</span>}
        {evalStatus === "block" && <span className="text-[10px] text-red-400">⛔ bloqueou</span>}
        <button onClick={(e) => { e.stopPropagation(); removeNode(data.id); }} className="p-0.5 text-text/50 hover:text-text" title={t("common.close", "Fechar")}>
          <X size={13} />
        </button>
      </div>

      <div className="nodrag flex flex-1 flex-col gap-1.5 overflow-auto p-2" onPointerDown={(e) => e.stopPropagation()}>
        {/* Explicação (empty-state) */}
        <p className="text-[10px] leading-snug text-text/50">
          {t("filter.help", "Fica na linha entre agentes e só deixa passar o que casa. Ligue Agente → Filtro → outro nó.")}
        </p>

        <select
          value={data.mode}
          onChange={(e) => updateFilterNode(data.id, { mode: e.target.value as FilterNodeData["mode"] })}
          className={sel}
        >
          <option value="kind">{t("filter.byKind", "por tipo (diff/result/text)")}</option>
          <option value="regex">{t("filter.byRegex", "por regex (texto+diff)")}</option>
          <option value="path">{t("filter.byPath", "por caminho (substring)")}</option>
          <option value="ai">{t("filter.byAi", "por IA (modelo decide) ✨")}</option>
        </select>

        {data.mode === "kind" && (
          <select value={data.value} onChange={(e) => updateFilterNode(data.id, { value: e.target.value })} className={sel}>
            <option value="diff">diff — só edições de código</option>
            <option value="result">result — só resultados</option>
            <option value="text">text — só chat/explicação</option>
          </select>
        )}
        {(data.mode === "regex" || data.mode === "path") && (
          <input
            value={data.value}
            onChange={(e) => updateFilterNode(data.id, { value: e.target.value })}
            placeholder={data.mode === "regex" ? t("filter.regexPh", "ex: TODO|FIXME") : t("filter.pathPh", "ex: src/api/")}
            className="rounded bg-black/20 px-1.5 py-1 text-[11px] text-text outline-none placeholder:text-textMuted"
          />
        )}

        {ai && (
          <div className="flex flex-col gap-1.5 rounded border border-purple-500/30 bg-purple-500/5 p-1.5">
            <select
              value={data.providerId ?? ""}
              onChange={(e) => updateFilterNode(data.id, { providerId: e.target.value })}
              className={sel}
            >
              <option value="">{t("filter.aiPickProvider", "— provider (Central de API) —")}</option>
              {providers.map((p) => (<option key={p.id} value={p.id}>{p.label}{p.hasKey ? " 🔑" : ""}</option>))}
            </select>
            <input
              value={data.model ?? ""}
              onChange={(e) => updateFilterNode(data.id, { model: e.target.value })}
              placeholder={t("filter.aiModel", "modelo (ex: kimi-k2.7-code) — vazio = default")}
              className="rounded bg-black/20 px-1.5 py-1 font-mono text-[10px] text-text outline-none placeholder:text-textMuted"
            />
            <textarea
              value={data.criterion ?? ""}
              onChange={(e) => updateFilterNode(data.id, { criterion: e.target.value })}
              placeholder={t("filter.aiCriterion", "critério em linguagem natural: ex 'só mudanças de segurança/auth'")}
              rows={2}
              className="resize-none rounded bg-black/20 px-1.5 py-1 text-[11px] text-text outline-none placeholder:text-textMuted"
            />
            {providers.length === 0 && (
              <span className="text-[9px] text-amber-300/80">{t("filter.aiNoProviders", "cadastre uma chave em Ferramentas → Central de API")}</span>
            )}
          </div>
        )}

        {/* Exemplos prontos (modos determinísticos) */}
        {!ai && (
          <div className="flex flex-wrap gap-1">
            {EXAMPLES.map((ex) => (
              <button
                key={ex.label}
                onClick={() => updateFilterNode(data.id, { mode: ex.mode, value: ex.value })}
                className="rounded bg-sky-500/10 px-1.5 py-0.5 text-[9px] text-sky-300 hover:bg-sky-500/20"
              >
                {ex.label}
              </button>
            ))}
          </div>
        )}

        <div className="text-[9px] text-text/40">
          {ai
            ? t("filter.aiHint", "o modelo lê cada payload e decide passar/bloquear pelo significado")
            : t("filter.hint", "só passa o que casar (o resto é dropado)")}
        </div>
      </div>
    </div>
  );
}

export const FilterNode = memo(FilterNodeImpl);
