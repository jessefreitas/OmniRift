// src/components/GraphImportButton.tsx
//
// OmniGraph F2 + F4b + F5 — botões DISCRETOS do knowledge graph de código (canto sup. direito do
// Canvas). Ponte de entrada própria (nada no TOOL_DEFS/Arquiteto), único ponto de montagem:
//
//   1. "Mapa do código ▾" (F5) — dropdown com as 4 VISÕES do mesmo graph.json (comunidades /
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
import { Network, Loader2, Sparkles, ChevronDown, Share2, Boxes, Flame, GitCompare, Eraser, GripVertical } from "lucide-react";

import { useCanvasStore } from "@/store/canvas-store";
import { omnigraphGraphJson, omnigraphReport } from "@/lib/pipeline-client";
import { importGraph, extractDocFiles, VIEW_META, type GraphJson, type GraphView } from "@/lib/omnigraph-graph";
import { topAmbiguousEdges, buildAmbiguityResolverBrief } from "@/lib/omnigraph-client";
import { OmniGraphDiffModal } from "@/components/OmniGraphDiffModal";
import { OmniGraphReportModal } from "@/components/OmniGraphReportModal";
import { notify } from "@/lib/notify";
import { useFlag } from "@/lib/feature-flags";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { useDraggable } from "@/lib/use-draggable";

/** Máx. de arestas AMBIGUOUS que viram sub-task num subagente só (as top por "surpresa"). */
const AMBIGUOUS_TOP_K = 8;

/** localStorage: última visão escolhida (o clique no corpo do botão repete essa). */
const LAST_VIEW_KEY = "omnirift-graph-view-v1";

/** Marca de origem dos nós da seção "Explorar docs no canvas" (Group + PreviewNodes) — pro
 *  "Limpar docs do canvas" achar e remover só eles. */
const DOCS_TAG = "omnigraph-docs";

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
  const clearGraphNodes = useCanvasStore((s) => s.clearGraphNodes);
  const addSubagent = useCanvasStore((s) => s.addSubagent);
  const addGroup = useCanvasStore((s) => s.addGroup);
  const addPreviewNode = useCanvasStore((s) => s.addPreviewNode);
  const updateNodeSize = useCanvasStore((s) => s.updateNodeSize);
  const patchNode = useCanvasStore((s) => s.patchNode);
  const clearTaggedNodes = useCanvasStore((s) => s.clearTaggedNodes);
  const t = useT();
  // Painel flutuante: arrastável pelo grip, posição salva. Sem posição → default top-3 right-3.
  const drag = useDraggable("omnirift-graph-panel-pos");
  const [busy, setBusy] = useState(false);
  const [busyClean, setBusyClean] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const [showReport, setShowReport] = useState(false);
  const [lastView, setLastView] = useState<GraphView>(loadLastView);
  // Feature flag: o dono pode ocultar o atalho do OmniGraph na toolbar (kill-switch).
  const omnigraphEnabled = useFlag("omnigraph-import");

  function viewLabel(view: GraphView): string {
    return t(`graph.view.${view}`, VIEW_META[view].label);
  }

  // Lê o graph.json; se ainda não existe, GERA na hora (1ª vez) e relê — em vez do
  // antigo dead-end "Rode o OmniGraph primeiro" (mensagem circular: o botão É o OmniGraph).
  // O grafo demora ~1-2min só na primeira vez; depois o loop F4 mantém fresco.
  async function loadOrBuildGraph(cwd: string): Promise<string | null> {
    // 1ª leitura: se já existe um grafo, o backend pode barrar por tamanho (repo
    // guarda-chuva → graph.json gigante que trava o WebKitGTK). Nesse caso o Err já
    // vem com a orientação certa (abrir um subprojeto) — não tentamos regerar.
    let raw: string | null;
    try {
      raw = await omnigraphGraphJson(cwd);
    } catch (e) {
      void notify(String(e), "error");
      return null;
    }
    if (raw) return raw;

    void notify(
      t("graph.building", "Gerando o grafo de código pela primeira vez… (~1-2 min, roda uma vez só)"),
      "info",
    );
    try {
      // GERA o 1º grafo via omnigraph_report (roda a engine → run_build). ANTES chamava
      // omnigraphRebuild, que é NO-OP quando o grafo ainda NÃO existe (ele só RE-builda um grafo
      // já presente) → dead-end circular: o "gerar pela 1ª vez" nunca gerava e caía sempre em
      // "grafo vazio". O rebuild segue no loop F4 (god nodes), só não serve pra 1ª geração.
      await omnigraphReport(cwd);
    } catch (e) {
      const msg = String(e);
      // Timeout do build (300s) = repo grande demais, não engine quebrada.
      const isTimeout = /timeout|estourou|passou de/i.test(msg);
      void notify(
        isTimeout
          ? t(
              "graph.buildTimeout",
              "A geração passou do tempo limite — esse repo é grande demais (muito código/vendor, ex: node_modules). Abra um SUBPROJETO específico (uma subpasta com o código) em vez da pasta-mãe inteira.",
            )
          : t("graph.buildFail", "Não consegui gerar o grafo: {e}").replace("{e}", msg),
        "error",
      );
      return null;
    }
    // 2ª leitura pós-build: pode vir vazio (sem código) OU grande demais (Err).
    try {
      raw = await omnigraphGraphJson(cwd);
    } catch (e) {
      void notify(String(e), "error");
      return null;
    }
    if (!raw) {
      void notify(
        t(
          "graph.stillNone",
          "O grafo veio vazio — esse diretório pode não ter código indexável (ou o build não completou a tempo).",
        ),
        "error",
      );
    }
    return raw;
  }

  async function handleImport(view: GraphView) {
    if (busy) return;
    const cwd = currentCwd?.trim();
    if (!cwd) {
      void notify(t("graph.noCwd", "Abra uma pasta de projeto antes de gerar o mapa do código."), "error");
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
      const raw = await loadOrBuildGraph(cwd); // gera na hora se ainda não existe (era dead-end circular)
      if (!raw) return; // loadOrBuildGraph já avisou o usuário
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
      void notify(t("graph.noCwd", "Abra uma pasta de projeto antes de gerar o mapa do código."), "error");
      return;
    }
    setBusyClean(true);
    try {
      const raw = await loadOrBuildGraph(cwd); // gera na hora se ainda não existe (era dead-end circular)
      if (!raw) return; // loadOrBuildGraph já avisou o usuário
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

  // "Explorar docs no canvas" — os arquivos .md que o grafo conhece viram uma SEÇÃO (Group) de
  // PreviewNodes no canvas, num grid, pro usuário abrir e ler. É o destino dos nós de doc que o
  // painel filtra do "coração do código": não some, vira material explorável.
  async function handleExploreDocs() {
    if (busy) return;
    const cwd = currentCwd?.trim();
    if (!cwd) {
      void notify(t("graph.noCwd", "Abra uma pasta de projeto antes de gerar o mapa do código."), "error");
      return;
    }
    setBusy(true);
    try {
      const raw = await loadOrBuildGraph(cwd);
      if (!raw) return;
      let parsed: GraphJson;
      try {
        parsed = JSON.parse(raw) as GraphJson;
      } catch {
        void notify(t("graph.badJson", "graph.json inválido — regenere o grafo."), "error");
        return;
      }
      const docs = extractDocFiles(parsed);
      if (docs.length === 0) {
        void notify(t("graph.noDocs", "O grafo não achou arquivos de documentação (.md) neste projeto."), "info");
        return;
      }
      // Grid de previews (3 colunas) com um Group atrás englobando tudo (a "seção").
      const cols = Math.min(3, docs.length);
      const rows = Math.ceil(docs.length / cols);
      const CW = 560;
      const CH = 500;
      const baseX = 140;
      const baseY = 150;
      const base = cwd.replace(/\/+$/, "");
      const grp = addGroup({
        position: { x: baseX - 40, y: baseY - 70 },
        label: t("graph.docsGroup", "📄 Documentação ({n})").replace("{n}", String(docs.length)),
      });
      patchNode(grp.id, { tag: DOCS_TAG }); // pra o "limpar docs" achar tudo depois
      docs.forEach((rel, i) => {
        const c = i % cols;
        const r = Math.floor(i / cols);
        const path = rel.startsWith("/") ? rel : `${base}/${rel}`;
        const pv = addPreviewNode({ path, position: { x: baseX + c * CW, y: baseY + r * CH } });
        patchNode(pv.id, { tag: DOCS_TAG });
      });
      updateNodeSize(grp.id, { width: cols * CW + 40, height: rows * CH + 90 });
      void notify(
        t("graph.docsAdded", "{n} documentos abertos no canvas pra explorar").replace("{n}", String(docs.length)),
        "info",
      );
    } catch (e) {
      void notify(String(e), "error");
    } finally {
      setBusy(false);
      setMenuOpen(false);
    }
  }

  // "Limpar grafo do canvas" — remove as bolhas (kind:"community") que o "ver no canvas" despejou,
  // sem tocar nos agentes. Resolve o "gerou e sujou o canvas".
  function handleClearCanvas() {
    const n = clearGraphNodes();
    void notify(
      n > 0
        ? t("graph.cleared", "{n} nós do grafo removidos do canvas").replace("{n}", String(n))
        : t("graph.nothingToClear", "Não há grafo no canvas pra limpar."),
      "info",
    );
    setMenuOpen(false);
  }

  // "Limpar docs do canvas" — some com a seção de docs (Group + PreviewNodes) depois de analisar.
  function handleClearDocs() {
    const n = clearTaggedNodes(DOCS_TAG);
    void notify(
      n > 0
        ? t("graph.docsCleared", "Seção de documentação removida do canvas ({n} nós)").replace("{n}", String(n))
        : t("graph.noDocsToClear", "Não há seção de docs no canvas pra limpar."),
      "info",
    );
    setMenuOpen(false);
  }

  const btn =
    "flex items-center gap-1.5 rounded-md border border-border bg-surface1/90 px-2.5 py-1 text-[11px] text-textMuted backdrop-blur transition-colors hover:border-brand/50 hover:text-text disabled:cursor-wait disabled:opacity-60";

  // Flag off → sem atalho do OmniGraph na toolbar (early return DEPOIS de todos os hooks).
  if (!omnigraphEnabled) return null;

  return (
    <div
      ref={drag.ref}
      style={drag.style}
      className={cn("absolute z-30 flex items-center gap-1.5", !drag.floating && "top-3 right-3")}
    >
      {/* Grip de arraste (flutuante): segura e solta onde não atrapalha a barra de ícones. */}
      <button
        onPointerDown={drag.onPointerDown}
        title={t("graph.dragHandle", "Arrastar este painel")}
        className="flex cursor-move items-center rounded-md border border-border bg-surface1/90 px-1 py-1 text-textMuted backdrop-blur hover:text-text"
      >
        <GripVertical size={13} />
      </button>
      {/* Dropdown de VISÕES (F5): corpo repete a última; a seta abre as 4. */}
      <div className="relative">
        <div className="flex items-stretch">
          <button
            onClick={() => setShowReport(true)}
            title={t(
              "graph.importTip",
              "Abre o mapa de leitura deste projeto: coração do código, conexões surpresa, ciclos de import e peças soltas — a 1ª geração leva ~1-2 min.",
            )}
            className={cn(btn, "rounded-r-none")}
          >
            {busy ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <span aria-hidden className="text-[13px] leading-none">🕸️</span>
            )}
            <span>{t("graph.codeMap", "Mapa do código")}</span>
          </button>
          <button
            onClick={() => setMenuOpen((v) => !v)}
            disabled={busy}
            title={t("graph.pickView", "Ver o grafo no canvas / limpar / comparar")}
            className={cn(btn, "rounded-l-none border-l-0 px-1.5")}
          >
            <ChevronDown size={13} className={cn("transition-transform", menuOpen && "rotate-180")} />
          </button>
        </div>
        {menuOpen && (
          <div className="absolute right-0 top-full z-40 mt-1 w-56 overflow-hidden rounded-md border border-border bg-surface1 shadow-xl">
            <div className="px-2.5 pt-2 pb-1 text-[9px] font-semibold uppercase tracking-wide text-textMuted">
              {t("graph.viewOnCanvas", "Ver no canvas")}
            </div>
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
            <div className="my-1 border-t border-border" />
            <button
              onClick={() => void handleExploreDocs()}
              disabled={busy}
              className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11px] text-text hover:bg-white/5 disabled:opacity-50"
            >
              <span aria-hidden className="text-[12px] leading-none">📄</span>
              <span className="flex-1">{t("graph.exploreDocs", "Explorar docs no canvas")}</span>
            </button>
            <button
              onClick={handleClearCanvas}
              className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11px] text-text hover:bg-white/5"
            >
              <Eraser size={13} className="text-textMuted" />
              <span className="flex-1">{t("graph.clearCanvas", "Limpar grafo do canvas")}</span>
            </button>
            <button
              onClick={handleClearDocs}
              className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11px] text-text hover:bg-white/5"
            >
              <Eraser size={13} className="text-textMuted" />
              <span className="flex-1">{t("graph.clearDocs", "Limpar docs do canvas")}</span>
            </button>
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
      <OmniGraphReportModal
        cwd={currentCwd?.trim() ?? ""}
        open={showReport}
        onClose={() => setShowReport(false)}
        onExploreDocs={() => {
          setShowReport(false);
          void handleExploreDocs();
        }}
      />
    </div>
  );
}
