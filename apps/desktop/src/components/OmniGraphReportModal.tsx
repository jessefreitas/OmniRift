// src/components/OmniGraphReportModal.tsx
//
// OmniGraph — PAINEL DE LEITURA do "Mapa do código". A engine (omnigraph_report_full) já gera um
// GRAPH_REPORT.md riquíssimo (god nodes, conexões surpresa, ciclos de import, peças soltas,
// perguntas). O canvas ANTES ignorava tudo isso e só despejava as comunidades como bolhas sem
// nome — "sujava o canvas e não dizia nada". Aqui a gente LÊ o relatório e mostra num painel
// legível: "onde está o coração do teu código e o risco", em 30s.
//
// Parser leve (o relatório é markdown com `## Seções`): agrupa por header, extrai os números pro
// HERO e mostra só as seções que agregam (god nodes / surpresas / ciclos / gaps / perguntas). As
// comunidades detalhadas (muito verbosas) ficam de fora — o número delas vai no hero.
//
// UI in-DOM (WebKitGTK não tem diálogo nativo — memória do projeto): overlay próprio, fecha no X,
// no ESC e no clique fora. Sem window.open/alert/confirm.

import { useEffect, useState } from "react";
import {
  Loader2, X, Sparkles, Share2, GitBranch, AlertTriangle, HelpCircle, Boxes, RefreshCw,
} from "lucide-react";

import { omnigraphReportFull } from "@/lib/pipeline-client";
import { notify } from "@/lib/notify";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/cn";

interface Props {
  cwd: string;
  open: boolean;
  onClose: () => void;
}

interface Section {
  /** rótulo humano (PT) resolvido por keyword do header original */
  title: string;
  icon: typeof Sparkles;
  /** cor de acento do card */
  tone: string;
  /** linhas do corpo (já sem o header) */
  lines: string[];
}

/** Números-chave pro hero, extraídos do Corpus Check + Summary. */
interface Hero {
  files?: string;
  nodes?: string;
  edges?: string;
  communities?: string;
  verdict?: string;
}

/** Limpa a sintaxe markdown feia pra texto legível: wikilinks `[[_COMMUNITY_x|y]]` → `y`,
 *  remove marcadores de lista, colapsa espaços. */
function cleanLine(raw: string): string {
  return raw
    .replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, "$1") // [[a|b]] → b
    .replace(/\[\[([^\]]*)\]\]/g, "$1") // [[a]] → a
    .replace(/^[-*]\s+/, "") // bullet
    .replace(/^\d+\.\s+/, "") // "1. "
    .replace(/`/g, "") // crases (mostramos plano; código destacado só via className)
    .replace(/\*\*/g, "")
    .trim();
}

/** Extrai os números do hero por regex nas linhas de Corpus/Summary. */
function parseHero(md: string): Hero {
  const h: Hero = {};
  const files = md.match(/(\d[\d,.]*)\s+files/i);
  if (files) h.files = files[1];
  const nodes = md.match(/(\d[\d,.]*)\s+nodes/i);
  if (nodes) h.nodes = nodes[1];
  const edges = md.match(/(\d[\d,.]*)\s+edges/i);
  if (edges) h.edges = edges[1];
  const comms = md.match(/(\d[\d,.]*)\s+communities/i);
  if (comms) h.communities = comms[1];
  const verdict = md.match(/Verdict:\s*(.+)/i);
  if (verdict) h.verdict = verdict[1].trim();
  return h;
}

/** Mapeia um header original (en) pro card humano (icon + título PT + tom). null = pular. */
function classify(header: string): Omit<Section, "lines"> | null {
  const h = header.toLowerCase();
  if (h.includes("god node"))
    return { title: "O coração do código (mais conectados)", icon: Sparkles, tone: "#f59e0b" };
  if (h.includes("surprising"))
    return { title: "Conexões que você talvez não saiba", icon: Share2, tone: "#8b5cf6" };
  if (h.includes("import cycle"))
    return { title: "Ciclos de import", icon: GitBranch, tone: "#22c55e" };
  if (h.includes("knowledge gap"))
    return { title: "Peças soltas (sem ligação)", icon: AlertTriangle, tone: "#eab308" };
  if (h.includes("suggested question"))
    return { title: "Perguntas que o grafo responde", icon: HelpCircle, tone: "#38bdf8" };
  if (h.includes("community hub"))
    return { title: "Módulos do projeto", icon: Boxes, tone: "#64748b" };
  return null; // Corpus/Summary → hero; Communities detalhadas/Freshness → cortadas
}

/** Parseia o GRAPH_REPORT.md em seções renderizáveis (só as que agregam). */
function parseSections(md: string): Section[] {
  const out: Section[] = [];
  let cur: Section | null = null;
  for (const line of md.split("\n")) {
    if (line.startsWith("## ")) {
      const meta = classify(line.slice(3));
      cur = meta ? { ...meta, lines: [] } : null;
      if (cur) out.push(cur);
      continue;
    }
    if (cur && line.trim()) cur.lines.push(line);
  }
  // dedup de linhas iguais consecutivas (Community Hubs repete README várias vezes) + limpa vazias
  for (const s of out) {
    const seen = new Set<string>();
    s.lines = s.lines
      .map(cleanLine)
      .filter((l) => l.length > 0 && !seen.has(l) && (seen.add(l), true))
      .slice(0, 12); // teto por card (o resto vira "+N")
  }
  return out.filter((s) => s.lines.length > 0);
}

export function OmniGraphReportModal({ cwd, open, onClose }: Props) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [md, setMd] = useState<string | null>(null);

  async function load(force = false) {
    const c = cwd.trim();
    if (!c) return;
    if (md && !force) return;
    setBusy(true);
    try {
      const raw = await omnigraphReportFull(c);
      if (!raw) {
        void notify(
          t("graph.reportNone", "Não há mapa de código gerado ainda (ou a engine está indisponível)."),
          "info",
        );
        onClose();
        return;
      }
      setMd(raw);
    } catch (e) {
      void notify(String(e), "error");
      onClose();
    } finally {
      setBusy(false);
    }
  }

  // Abre → carrega (gera na 1ª vez se preciso). ESC fecha.
  useEffect(() => {
    if (!open) return;
    void load();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const hero = md ? parseHero(md) : {};
  const sections = md ? parseSections(md) : [];

  const stat = (label: string, val?: string) =>
    val ? (
      <div className="flex flex-col items-center rounded-md bg-white/5 px-3 py-2">
        <span className="text-lg font-semibold text-text">{val}</span>
        <span className="text-[10px] uppercase tracking-wide text-textMuted">{label}</span>
      </div>
    ) : null;

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-[min(760px,92vw)] flex-col overflow-hidden rounded-lg border border-border bg-surface1 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <span aria-hidden className="text-[15px]">🕸️</span>
            <h2 className="text-sm font-semibold text-text">
              {t("graph.reportTitle", "Mapa do código — o que este projeto é")}
            </h2>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => void load(true)}
              disabled={busy}
              title={t("graph.reportRefresh", "Regerar o mapa (relê o código)")}
              className="rounded p-1 text-textMuted hover:bg-white/5 hover:text-text disabled:opacity-50"
            >
              <RefreshCw size={14} className={cn(busy && "animate-spin")} />
            </button>
            <button
              onClick={onClose}
              className="rounded p-1 text-textMuted hover:bg-white/5 hover:text-text"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-4 py-4">
          {busy && !md ? (
            <div className="flex flex-col items-center gap-3 py-12 text-textMuted">
              <Loader2 size={22} className="animate-spin" />
              <span className="text-xs">
                {t("graph.reportBuilding", "Lendo o código e montando o mapa… (a 1ª vez leva ~1-2 min)")}
              </span>
            </div>
          ) : md ? (
            <>
              {/* Hero — números-chave */}
              <div className="mb-4 grid grid-cols-4 gap-2">
                {stat(t("graph.statFiles", "arquivos"), hero.files)}
                {stat(t("graph.statNodes", "nós"), hero.nodes)}
                {stat(t("graph.statEdges", "conexões"), hero.edges)}
                {stat(t("graph.statComms", "módulos"), hero.communities)}
              </div>
              {hero.verdict && (
                <p className="mb-4 rounded-md border border-border bg-white/[0.03] px-3 py-2 text-[11px] text-textMuted">
                  {hero.verdict}
                </p>
              )}

              {/* Seções */}
              <div className="flex flex-col gap-3">
                {sections.map((s) => {
                  const Icon = s.icon;
                  return (
                    <div key={s.title} className="rounded-md border border-border bg-white/[0.02] p-3">
                      <div className="mb-2 flex items-center gap-2">
                        <Icon size={14} style={{ color: s.tone }} />
                        <h3 className="text-xs font-semibold text-text">{s.title}</h3>
                      </div>
                      <ul className="flex flex-col gap-1">
                        {s.lines.map((l, i) => (
                          <li key={i} className="flex gap-1.5 text-[11px] leading-relaxed text-textMuted">
                            <span style={{ color: s.tone }} className="mt-0.5 shrink-0">
                              ·
                            </span>
                            <span className="min-w-0 break-words">{l}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })}
              </div>
            </>
          ) : null}
        </div>

        <div className="border-t border-border px-4 py-2 text-[10px] text-textMuted">
          {t(
            "graph.reportFoot",
            "Gerado localmente do teu código (sem custo de IA). Use “ver no canvas” pra abrir os módulos como nós.",
          )}
        </div>
      </div>
    </div>
  );
}
