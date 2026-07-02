// src/components/GraphImportButton.tsx
//
// Graphify F2 — botão DISCRETO "importar grafo de código". Lê o graph.json cru do projeto
// (comando Rust graphify_graph_json), destila as COMUNIDADES Leiden (importCommunities) e as
// adiciona ao floor ATIVO como CommunityNodes + arestas de acoplamento. Se não há grafo, avisa.
//
// Fica montado no Canvas (não no Sidebar — de propósito, pra não colidir com o worker do gate
// que mexe no Sidebar). Ponte de entrada própria: nada no TOOL_DEFS/Arquiteto.
//
// ⚠️ zustand v5: seleciona SÓ primitivas (`currentCwd`: string|null) e refs de função estáveis
// (`importCommunityNodes`) — nunca um array/objeto novo (re-render em loop). O import em lote
// entra num único `set` dentro da própria action.

import { useState } from "react";
import { Network, Loader2 } from "lucide-react";

import { useCanvasStore } from "@/store/canvas-store";
import { graphifyGraphJson } from "@/lib/pipeline-client";
import { importCommunities, type GraphJson } from "@/lib/graphify-graph";
import { notify } from "@/lib/notify";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/cn";

export function GraphImportButton() {
  const currentCwd = useCanvasStore((s) => s.currentCwd);
  const importCommunityNodes = useCanvasStore((s) => s.importCommunityNodes);
  const t = useT();
  const [busy, setBusy] = useState(false);

  async function handleImport() {
    if (busy) return;
    const cwd = currentCwd?.trim();
    if (!cwd) {
      void notify(t("graph.noCwd", "Abra uma pasta de projeto antes de importar o grafo de código."), "error");
      return;
    }
    setBusy(true);
    try {
      const raw = await graphifyGraphJson(cwd); // Err (grafo grande demais) sobe pro catch
      if (!raw) {
        void notify(
          t("graph.none", "Nenhum grafo de código encontrado. Rode o Graphify (Arquiteto de Pipeline ancorado) primeiro."),
          "error",
        );
        return;
      }
      let parsed: GraphJson;
      try {
        parsed = JSON.parse(raw) as GraphJson;
      } catch {
        void notify(t("graph.badJson", "graph.json inválido — regenere o grafo."), "error");
        return;
      }
      const { nodes, edges, truncatedCommunities } = importCommunities(parsed, cwd);
      if (nodes.length === 0) {
        void notify(
          t("graph.empty", "O grafo não tem comunidades detectadas (repo pequeno? a Serena já basta)."),
          "info",
        );
        return;
      }
      const added = importCommunityNodes(nodes, edges);
      const extra = truncatedCommunities > 0 ? ` (+${truncatedCommunities} ocultas)` : "";
      void notify(
        t("graph.imported", "{n} comunidades importadas{x} · {e} conexões")
          .replace("{n}", String(added))
          .replace("{x}", extra)
          .replace("{e}", String(edges.length)),
        "info",
      );
    } catch (e) {
      void notify(String(e), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      onClick={handleImport}
      disabled={busy}
      title={t("graph.importTip", "Importa as comunidades do knowledge graph de código (Graphify) como nós no canvas")}
      className={cn(
        "absolute top-3 right-3 z-30 flex items-center gap-1.5 rounded-md border border-border bg-surface1/90 px-2.5 py-1 text-[11px] text-textMuted backdrop-blur transition-colors",
        "hover:border-brand/50 hover:text-text disabled:cursor-wait disabled:opacity-60",
      )}
    >
      {busy ? <Loader2 size={13} className="animate-spin" /> : <Network size={13} />}
      {t("graph.import", "grafo de código")}
    </button>
  );
}
