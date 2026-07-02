// src/components/GraphImportButton.tsx
//
// OmniGraph F2 + F4b — botões DISCRETOS do knowledge graph de código (canto sup. direito do
// Canvas). Ponte de entrada própria (nada no TOOL_DEFS/Arquiteto), único ponto de montagem:
//
//   1. "grafo de código" (F2) — lê o graph.json cru (omnigraph_graph_json), destila as
//      COMUNIDADES Leiden (importCommunities) e as adiciona ao floor ativo como CommunityNodes.
//   2. "limpar grafo" (F4b) — extrai as top-K arestas AMBIGUOUS (topAmbiguousEdges) e cria UM
//      subagente nativo (.claude/agents via addSubagent + subagent_write, o MESMO par do Montar)
//      que confirma/nega essas relações incertas no código. NÃO spawna processo (respeita o gate
//      de licença de agentes) — só materializa o nó + o arquivo; o usuário invoca quando quiser.
//
// ESCOLHA DE UI (documentada): o ponto de MENOR invasão. Este componente já é o único dono do
// OmniGraph no Canvas, já está montado, já lê o graph.json — adicionar um 2º botão IRMÃO aqui
// (vs. um OmniGraphPanel novo ou tocar o OmniFsModal) reusa 100% do caminho de dados e NÃO cria
// mount point novo. Ambos degradam limpo: sem grafo → notify, sem subagente órfão.
//
// ⚠️ zustand v5: seleciona SÓ primitivas (`currentCwd`: string|null) e refs de função estáveis
// (`importCommunityNodes`, `addSubagent`) — nunca um array/objeto novo (re-render em loop).

import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Network, Loader2, Sparkles } from "lucide-react";

import { useCanvasStore } from "@/store/canvas-store";
import { omnigraphGraphJson } from "@/lib/pipeline-client";
import { importCommunities, type GraphJson } from "@/lib/omnigraph-graph";
import { topAmbiguousEdges, buildAmbiguityResolverBrief } from "@/lib/omnigraph-client";
import { notify } from "@/lib/notify";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/cn";

/** Máx. de arestas AMBIGUOUS que viram sub-task num subagente só (as top por "surpresa"). */
const AMBIGUOUS_TOP_K = 8;

export function GraphImportButton() {
  const currentCwd = useCanvasStore((s) => s.currentCwd);
  const importCommunityNodes = useCanvasStore((s) => s.importCommunityNodes);
  const addSubagent = useCanvasStore((s) => s.addSubagent);
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [busyClean, setBusyClean] = useState(false);

  async function handleImport() {
    if (busy) return;
    const cwd = currentCwd?.trim();
    if (!cwd) {
      void notify(t("graph.noCwd", "Abra uma pasta de projeto antes de importar o grafo de código."), "error");
      return;
    }
    setBusy(true);
    try {
      const raw = await omnigraphGraphJson(cwd); // Err (grafo grande demais) sobe pro catch
      if (!raw) {
        void notify(
          t("graph.none", "Nenhum grafo de código encontrado. Rode o OmniGraph (Arquiteto de Pipeline ancorado) primeiro."),
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

  // F4b — "limpar grafo": AMBIGUOUS → sub-task num subagente que confirma/nega as relações.
  async function handleCleanAmbiguities() {
    if (busyClean) return;
    const cwd = currentCwd?.trim();
    if (!cwd) {
      void notify(t("graph.noCwd", "Abra uma pasta de projeto antes de importar o grafo de código."), "error");
      return;
    }
    setBusyClean(true);
    try {
      const raw = await omnigraphGraphJson(cwd); // Err (grafo grande demais) sobe pro catch
      if (!raw) {
        void notify(
          t("graph.none", "Nenhum grafo de código encontrado. Rode o OmniGraph (Arquiteto de Pipeline ancorado) primeiro."),
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
      const edges = topAmbiguousEdges(parsed, AMBIGUOUS_TOP_K);
      if (edges.length === 0) {
        void notify(
          t("graph.noAmbiguous", "Grafo sem relações AMBIGUOUS — nada a limpar 🎉"),
          "info",
        );
        return;
      }
      const prompt = buildAmbiguityResolverBrief(edges);
      const desc = t("graph.cleanDesc", "confirma/nega {n} relações arquiteturais incertas do grafo")
        .replace("{n}", String(edges.length));
      const name = "resolver-ambiguidades-grafo";
      // Nó no canvas (NÃO spawna — só materializa o subagente; respeita o gate de licença).
      addSubagent({
        role: name,
        label: t("graph.cleanRole", "Resolver Ambiguidades (grafo)"),
        description: desc,
        prompt,
        cwd,
        scope: "project",
      });
      // Materializa `.claude/agents/<slug>.md` (mesmo par do Montar; best-effort).
      await invoke("subagent_write", {
        dir: cwd,
        name,
        description: desc,
        prompt,
        tools: null,
        model: null,
      }).catch(() => {});
      void notify(
        t("graph.cleanCreated", "Subagente criado: confirmar/negar {n} relações incertas. Invoque-o quando quiser limpar o grafo.")
          .replace("{n}", String(edges.length)),
        "info",
      );
    } catch (e) {
      void notify(String(e), "error");
    } finally {
      setBusyClean(false);
    }
  }

  const btn =
    "flex items-center gap-1.5 rounded-md border border-border bg-surface1/90 px-2.5 py-1 text-[11px] text-textMuted backdrop-blur transition-colors hover:border-brand/50 hover:text-text disabled:cursor-wait disabled:opacity-60";

  return (
    <div className="absolute top-3 right-3 z-30 flex items-center gap-1.5">
      <button
        onClick={handleImport}
        disabled={busy}
        title={t("graph.importTip", "Importa as comunidades do knowledge graph de código (OmniGraph) como nós no canvas")}
        className={cn(btn)}
      >
        {busy ? <Loader2 size={13} className="animate-spin" /> : <Network size={13} />}
        {t("graph.import", "grafo de código")}
      </button>
      <button
        onClick={handleCleanAmbiguities}
        disabled={busyClean}
        title={t("graph.cleanTip", "Cria um subagente que confirma/nega as relações AMBIGUOUS (acoplamento incerto) do grafo no código — as confirmadas viram EXTRACTED no próximo rebuild. Não spawna: só cria o subagente pra você invocar.")}
        className={cn(btn)}
      >
        {busyClean ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
        {t("graph.clean", "limpar grafo")}
      </button>
    </div>
  );
}
