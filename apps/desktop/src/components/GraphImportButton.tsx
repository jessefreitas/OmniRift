// src/components/GraphImportButton.tsx
//
// OmniGraph F2 + F4b + F5 — botões DISCRETOS do knowledge graph de código (canto sup. direito do
// Canvas). Ponte de entrada própria (nada no TOOL_DEFS/Arquiteto), único ponto de montagem:
//
//   1. "importar visão ▾" (F5) — dropdown com as 4 VISÕES do mesmo graph.json (comunidades /
//      callgraph / deps / risco). Cada uma lê o graph.json cru (omnigraph_graph_json), roda
//      importGraph(view) e ADICIONA ao floor ativo (pode empilhar várias visões no mesmo canvas).
//      A última visão escolhida fica em localStorage (o clique no corpo do botão repete essa).
//   2. "comparar" (F5) — abre o OmniGraphDiffModal (diff temporal entre 2 snapshots).
//   3. "limpar grafo" (F4b) — extrai as top-K arestas AMBIGUOUS (topAmbiguousEdges) e cria UM
//      subagente nativo (.claude/agents via addSubagent + subagent_write) que confirma/nega as
//      relações incertas no código. NÃO spawna (respeita o gate de licença) — só materializa.
//
// ESCOLHA DE UI (documentada): o ponto de MENOR invasão. Este componente já é o único dono do
// OmniGraph no Canvas, já lê o graph.json — o dropdown de visões + o botão comparar + o modal de
// diff vivem TODOS aqui (reusa 100% do caminho de dados, zero mount point novo).
//
// ⚠️ zustand v5: seleciona SÓ primitivas (`currentCwd`: string|null) e refs de função estáveis
// (`importCommunityNodes`, `addSubagent`) — nunca um array/objeto novo (re-render em loop).

import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Network, Loader2, Sparkles, ChevronDown, Share2, Boxes, Flame, GitCompare } from "lucide-react";

import { useCanvasStore } from "@/store/canvas-store";
import { omnigraphGraphJson } from "@/lib/pipeline-client";
import { importGraph, VIEW_META, type GraphJson, type GraphView } from "@/lib/omnigraph-graph";
import { topAmbiguousEdges, buildAmbiguityResolverBrief } from "@/lib/omnigraph-client";
import { OmniGraphDiffModal } from "@/components/OmniGraphDiffModal";
import { notify } from "@/lib/notify";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/cn";

/** Máx. de arestas AMBIGUOUS que viram sub-task num subagente só (as top por "surpresa"). */
const AMBIGUOUS_TOP_K = 8;

/** localStorage: última visão escolhida (o clique no corpo do botão repete essa). */
const LAST_VIEW_KEY = "omnirift-graph-view-v1";

/** Ícone + rótulo curto por visão (o rótulo humano fino; o técnico vem do VIEW_META). */
const VIEW_ICONS: Record<GraphView, typeof Network> = {
  communities: Network,
  callgraph: Share2,
  deps: Boxes,
  risk: Flame,
};

const VIEW_ORDER: GraphView[] = ["communities", "callgraph", "deps", "risk"];

function loadLastView(): GraphView {
  try {
    const v = localStorage.getItem(LAST_VIEW_KEY);
    if (v === "communities" || v === "callgraph" || v === "deps" || v === "risk") return v;
  } catch {
    /* localStorage off */
  }
  return "communities";
}

export function GraphImportButton() {
  const currentCwd = useCanvasStore((s) => s.currentCwd);
  const importCommunityNodes = useCanvasStore((s) => s.importCommunityNodes);
  const addSubagent = useCanvasStore((s) => s.addSubagent);
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [busyClean, setBusyClean] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const [lastView, setLastView] = useState<GraphView>(loadLastView);

  function viewLabel(view: GraphView): string {
    return t(`graph.view.${view}`, VIEW_META[view].label);
  }

  async function handleImport(view: GraphView) {
    if (busy) return;
    const cwd = currentCwd?.trim();
    if (!cwd) {
      void notify(t("graph.noCwd", "Abra uma pasta de projeto antes de importar o grafo de código."), "error");
      return;
    }
    // Persiste a visão escolhida (o corpo do botão passa a repetir essa).
    setLastView(view);
    try {
      localStorage.setItem(LAST_VIEW_KEY, view);
    } catch {
      /* off */
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
      const { nodes, edges, hidden, note } = importGraph(parsed, cwd, view);
      if (nodes.length === 0) {
        void notify(
          note ?? t("graph.empty", "Essa visão do grafo veio vazia (repo pequeno? sem os dados dessa visão)."),
          "info",
        );
        return;
      }
      const added = importCommunityNodes(nodes, edges);
      const extra = hidden > 0 ? ` (+${hidden} ${t("graph.hidden", "ocultos")})` : "";
      void notify(
        t("graph.importedView", "[{v}] {n} nós importados{x} · {e} conexões")
          .replace("{v}", viewLabel(view))
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
      {/* Dropdown de VISÕES (F5): corpo repete a última; a seta abre as 4. */}
      <div className="relative">
        <div className="flex items-stretch">
          <button
            onClick={() => handleImport(lastView)}
            disabled={busy}
            title={t("graph.importTip", "Importa uma visão do knowledge graph de código (OmniGraph) como nós no canvas")}
            className={cn(btn, "rounded-r-none")}
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Network size={13} />}
            {t("graph.importView", "importar visão")}: {viewLabel(lastView)}
          </button>
          <button
            onClick={() => setMenuOpen((v) => !v)}
            disabled={busy}
            title={t("graph.pickView", "Escolher a visão do grafo")}
            className={cn(btn, "rounded-l-none border-l-0 px-1.5")}
          >
            <ChevronDown size={13} className={cn("transition-transform", menuOpen && "rotate-180")} />
          </button>
        </div>
        {menuOpen && (
          <div className="absolute right-0 top-full z-40 mt-1 w-52 overflow-hidden rounded-md border border-border bg-surface1 shadow-xl">
            {VIEW_ORDER.map((view) => {
              const Icon = VIEW_ICONS[view];
              return (
                <button
                  key={view}
                  onClick={() => {
                    setMenuOpen(false);
                    void handleImport(view);
                  }}
                  className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11px] text-text hover:bg-white/5"
                >
                  <Icon size={13} style={{ color: VIEW_META[view].color }} />
                  <span className="flex-1">{viewLabel(view)}</span>
                  {view === lastView && <span className="text-[9px] text-text/40">•</span>}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Comparar arquitetura (F5 diff temporal). */}
      <button
        onClick={() => setShowDiff(true)}
        title={t("graph.compareTip", "Compara dois snapshots do grafo (o que mudou na arquitetura entre A e B)")}
        className={cn(btn)}
      >
        <GitCompare size={13} />
        {t("graph.compare", "comparar")}
      </button>

      {/* Limpar grafo (F4b). */}
      <button
        onClick={handleCleanAmbiguities}
        disabled={busyClean}
        title={t("graph.cleanTip", "Cria um subagente que confirma/nega as relações AMBIGUOUS (acoplamento incerto) do grafo no código — as confirmadas viram EXTRACTED no próximo rebuild. Não spawna: só cria o subagente pra você invocar.")}
        className={cn(btn)}
      >
        {busyClean ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
        {t("graph.clean", "limpar grafo")}
      </button>

      <OmniGraphDiffModal cwd={currentCwd?.trim() ?? ""} open={showDiff} onClose={() => setShowDiff(false)} />
    </div>
  );
}
