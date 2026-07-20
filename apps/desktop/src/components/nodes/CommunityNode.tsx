// src/components/nodes/CommunityNode.tsx
//
// OmniGraph F2 — uma COMUNIDADE Leiden do knowledge graph de código como nó COLAPSÁVEL no
// canvas. Colapsado: nome + nº de membros + nº de god nodes + nº de arquivos. Expandido:
// os GOD NODES destacados (zona quente / review) + os TOP membros — NUNCA o grafo interno
// inteiro (a memória do projeto registra que renderizar o grafo de entidade completo MATA o
// WebKitGTK; por isso o importer já corta em `topMembers`/`godNodes` e aqui só listamos texto).
//
// Visual no padrão dos outros nós (ReviewNode/FilterNode): header com ícone + título + X,
// handles esquerda/direita pras arestas de acoplamento (kind "graph-edge"). É um retrato
// ESTÁTICO — não é processo vivo, não spawna nada.

import { memo, useEffect, useRef, useState } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { Network, ChevronDown, ChevronRight, Flame, FileCode, X } from "lucide-react";

import { useCanvasStore } from "@/store/canvas-store";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { useFlag } from "@/lib/feature-flags";
import { SymbolBodyModal } from "@/components/SymbolBodyModal";
import type { CommunityNode as CommunityNodeData } from "@/types/canvas";

type CommunityRfNode = Node<CommunityNodeData & Record<string, unknown>, "community">;

function CommunityNodeImpl({ data, selected }: NodeProps<CommunityRfNode>) {
  const removeNode = useCanvasStore((s) => s.removeNode);
  const t = useT();
  const [open, setOpen] = useState(false);

  const color = data.color ?? "#a78bfa";
  const godCount = data.godNodes?.length ?? 0;

  // OmniGraph F2: clicar num símbolo (god/top) abre o corpo daquela função/classe (sob demanda).
  const symbolBodyEnabled = useFlag("omnigraph-symbol-body");
  const symbolFiles = data.symbolFiles ?? {};
  const [openSymbol, setOpenSymbol] = useState<{ symbol: string; sourceFile: string } | null>(null);
  function openBody(symbol: string) {
    const sourceFile = symbolFiles[symbol];
    if (sourceFile) setOpenSymbol({ symbol, sourceFile });
  }

  // GRAFO INTEGRADO (#30): a comunidade ACENDE quando um agente edita um arquivo dela. O store
  // guarda um contador transiente por nó (communityActivity — seletor primitivo, zustand-v5 safe);
  // a cada incremento realçamos ~4s e desvanecemos (box-shadow com transition). prevSeqRef evita
  // flash no mount/remount (só acende em atividade NOVA, não no valor inicial herdado).
  const activitySeq = useCanvasStore((s) => s.communityActivity[data.id] ?? 0);
  const [hot, setHot] = useState(false);
  const prevSeqRef = useRef(activitySeq);
  useEffect(() => {
    if (activitySeq === prevSeqRef.current) return; // sem atividade nova (inclui o 1º render)
    prevSeqRef.current = activitySeq;
    setHot(true);
    const timer = window.setTimeout(() => setHot(false), 4000);
    return () => window.clearTimeout(timer);
  }, [activitySeq]);

  return (
    <>
    <div
      className={cn(
        "flex h-full w-full flex-col overflow-hidden rounded-lg border bg-bg text-xs",
        hot ? "border-transparent" : selected ? "border-brand" : "border-white/10",
      )}
      style={{
        borderLeft: `3px solid ${color}`,
        // Realce transiente (#30): anel + glow na cor da comunidade quando um agente mexe nela;
        // ao esfriar, o box-shadow desvanece em 0.8s (fade-out). Sem atividade = intocado.
        boxShadow: hot ? `0 0 0 2px ${color}, 0 0 18px 3px ${color}` : undefined,
        transition: "box-shadow 0.8s ease",
      }}
    >
      <Handle type="target" position={Position.Left} className="!border-surface1" style={{ background: color }} />
      <Handle type="source" position={Position.Right} className="!border-surface1" style={{ background: color }} />

      <div className="node-drag-handle flex items-center gap-1.5 border-b border-white/10 px-2 py-1.5 cursor-grab active:cursor-grabbing select-none">
        <Network size={13} style={{ color }} />
        <span className="flex-1 truncate font-semibold text-text" title={data.name}>
          {data.name}
        </span>
        <span
          className="shrink-0 rounded bg-white/5 px-1 py-0.5 text-[8px] font-semibold uppercase tracking-wide text-text/60"
          title={t("community.members", "membros (nós do grafo) nesta comunidade")}
        >
          {data.memberCount} {t("community.membersShort", "nós")}
        </span>
        <button
          onClick={(e) => { e.stopPropagation(); removeNode(data.id); }}
          className="p-0.5 text-text/50 hover:text-text"
          title={t("common.close", "Fechar")}
        >
          <X size={13} />
        </button>
      </div>

      {/* Linha de resumo (sempre visível) + toggle de expandir. */}
      <button
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        className="nodrag flex items-center gap-1.5 px-2 py-1.5 text-left text-[10px] text-text/70 hover:bg-white/5"
        onPointerDown={(e) => e.stopPropagation()}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span className="flex items-center gap-1" title={t("community.godNodes", "god nodes: código muito conectado (zona de review)")}>
          <Flame size={11} className="text-amber-400" /> {godCount}
        </span>
        {data.fileCount != null && (
          <span className="flex items-center gap-1 text-text/50" title={t("community.files", "arquivos-fonte distintos")}>
            <FileCode size={11} /> {data.fileCount}
          </span>
        )}
        <span className="ml-auto text-text/40">
          {open ? t("community.collapse", "colapsar") : t("community.expand", "expandir")}
        </span>
      </button>

      {open && (
        <div className="nodrag nowheel flex-1 overflow-auto border-t border-white/10 p-2" onPointerDown={(e) => e.stopPropagation()}>
          {godCount > 0 && (
            <div className="mb-2">
              <div className="mb-1 flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wider text-amber-400/80">
                <Flame size={10} /> {t("community.godNodesTitle", "god nodes")}
              </div>
              <div className="flex flex-wrap gap-1">
                {data.godNodes.map((g, i) => {
                  const clickable = symbolBodyEnabled && !!symbolFiles[g];
                  return (
                    <button
                      key={`${g}-${i}`}
                      onClick={(e) => { e.stopPropagation(); if (clickable) openBody(g); }}
                      onPointerDown={(e) => e.stopPropagation()}
                      disabled={!clickable}
                      className={cn(
                        "truncate rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10px] text-amber-200",
                        clickable ? "cursor-pointer hover:bg-amber-500/30" : "cursor-default",
                      )}
                      title={clickable ? t("community.viewBody", "Ver o código deste símbolo") : g}
                    >
                      {g}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          <div className="mb-1 text-[9px] font-semibold uppercase tracking-wider text-text/50">
            {t("community.topMembers", "top membros")}
          </div>
          <ul className="space-y-0.5">
            {data.topMembers.map((m, i) => {
              const clickable = symbolBodyEnabled && !!symbolFiles[m];
              return (
                <li
                  key={`${m}-${i}`}
                  onClick={(e) => { if (clickable) { e.stopPropagation(); openBody(m); } }}
                  className={cn(
                    "truncate font-mono text-[10px] text-text/70",
                    clickable && "cursor-pointer hover:text-brand",
                  )}
                  title={clickable ? t("community.viewBody", "Ver o código deste símbolo") : m}
                >
                  {m}
                </li>
              );
            })}
          </ul>
          {data.memberCount > data.topMembers.length && (
            <div className="mt-1 text-[9px] italic text-text/40">
              {t("community.andMore", "… mais {n} membros (ocultos pra não travar o canvas)").replace(
                "{n}",
                String(data.memberCount - data.topMembers.length),
              )}
            </div>
          )}
        </div>
      )}
    </div>
    {openSymbol && (
      <SymbolBodyModal
        sourceFile={openSymbol.sourceFile}
        symbol={openSymbol.symbol}
        onClose={() => setOpenSymbol(null)}
      />
    )}
    </>
  );
}

export const CommunityNode = memo(CommunityNodeImpl);
