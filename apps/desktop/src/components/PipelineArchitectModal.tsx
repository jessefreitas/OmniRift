// src/components/PipelineArchitectModal.tsx
//
// Arquiteto de Pipeline — descreve o projeto → um LLM da Central monta o TIME (agentes,
// subagentes, conexões, paralelos, ondas, caminho crítico). Renderiza tipo mini-canvas,
// GRAVA por projeto (revisitável) e pode MONTAR no canvas real.

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Network, Save, Sparkles, X } from "lucide-react";

import { useCanvasStore } from "@/store/canvas-store";
import { llmProvidersList, type LlmProvider } from "@/lib/llm-providers-client";
import {
  generatePipelinePlan,
  pipelineSave,
  pipelineLoad,
  type PipelinePlan,
} from "@/lib/pipeline-client";
import { useT } from "@/lib/i18n";

const MODEL_COLORS: Record<string, string> = {
  haiku: "bg-emerald-500/20 text-emerald-300",
  sonnet: "bg-sky-500/20 text-sky-300",
  opus: "bg-purple-500/20 text-purple-300",
};

export function PipelineArchitectModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const currentCwd = useCanvasStore((s) => s.currentCwd) ?? "";
  const addAgent = useCanvasStore((s) => s.addAgent);
  const addEdge = useCanvasStore((s) => s.addEdge);

  const [providers, setProviders] = useState<LlmProvider[]>([]);
  const [providerId, setProviderId] = useState("");
  const [model, setModel] = useState("");
  const [desc, setDesc] = useState("");
  const [plan, setPlan] = useState<PipelinePlan | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    llmProvidersList().then((ps) => {
      setProviders(ps);
      if (ps[0]) setProviderId((cur) => cur || ps[0].id);
    }).catch(() => setProviders([]));
    // revisita o plano salvo do projeto
    pipelineLoad(currentCwd).then((p) => { if (p) { setPlan(p); setSavedAt(p.createdAt ?? null); } }).catch(() => {});
  }, [currentCwd]);

  async function generate() {
    if (!desc.trim() || !providerId) { setErr(t("pipe.needDesc", "descreva o projeto e escolha um provider")); return; }
    setLoading(true); setErr(null);
    try {
      const p = await generatePipelinePlan(desc.trim(), providerId, model.trim() || undefined);
      setPlan(p);
      await pipelineSave(currentCwd, p).catch(() => {});
      setSavedAt(p.createdAt ?? Date.now());
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function save() {
    if (!plan) return;
    await pipelineSave(currentCwd, plan).catch(() => {});
    setSavedAt(Date.now());
  }

  // Monta a topologia no canvas: um OmniAgent por agente (label = role), posicionado por onda,
  // + as conexões. É um esqueleto visual — você refina (troca provider/modelo, vira terminal, etc).
  function build() {
    if (!plan) return;
    const idByRole = new Map<string, string>();
    const byWave = new Map<number, number>();
    for (const a of plan.agents) {
      const wave = a.wave ?? 1;
      const col = byWave.get(wave) ?? 0;
      byWave.set(wave, col + 1);
      const node = addAgent({
        label: a.role,
        persona: `Você é o ${a.role} deste time. ${a.why}`,
        position: { x: 80 + wave * 360, y: 80 + col * 200 },
      });
      idByRole.set(a.role.toLowerCase(), node.id);
    }
    for (const c of plan.connections) {
      const from = idByRole.get(c.from.toLowerCase());
      const to = idByRole.get(c.to.toLowerCase());
      if (from && to && from !== to) addEdge(from, to, "generic");
    }
    onClose();
  }

  const sel = "rounded-md border border-border bg-bg px-2 py-1.5 text-sm text-text outline-none focus:border-brand";
  const waves = plan ? [...new Set(plan.agents.map((a) => a.wave ?? 1))].sort((a, b) => a - b) : [];

  return createPortal(
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="flex max-h-[90vh] w-[720px] max-w-[95vw] flex-col rounded-lg border border-border bg-surface1 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
          <Network size={15} className="text-brand" />
          <span className="flex-1 text-sm font-medium text-text">{t("pipe.title", "Arquiteto de Pipeline")}</span>
          {savedAt && <span className="text-[10px] text-textMuted">{t("pipe.saved", "plano salvo")} ✓</span>}
          <button onClick={onClose} className="text-textMuted hover:text-text"><X size={16} /></button>
        </header>

        <div className="flex-1 space-y-3 overflow-auto p-4">
          {/* Entrada */}
          <div className="space-y-2">
            <textarea
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              placeholder={t("pipe.descPh", "Descreva o projeto: ex 'sistema que recebe payloads por API, uma IA lê os dados, gera um PDF e envia por email'")}
              rows={2}
              className="w-full resize-none rounded-md border border-border bg-bg px-2 py-1.5 text-sm text-text outline-none focus:border-brand"
            />
            <div className="flex flex-wrap items-center gap-2">
              <select value={providerId} onChange={(e) => setProviderId(e.target.value)} className={sel}>
                <option value="">{t("pipe.pickProvider", "— provider (Central de API) —")}</option>
                {providers.map((p) => (<option key={p.id} value={p.id}>{p.label}</option>))}
              </select>
              <input value={model} onChange={(e) => setModel(e.target.value)} placeholder={t("pipe.model", "modelo (opcional)")} className={`${sel} w-40 font-mono text-[11px]`} />
              <button onClick={() => void generate()} disabled={loading || !desc.trim() || !providerId}
                className="ml-auto flex items-center gap-1.5 rounded-md bg-brand px-3 py-1.5 text-xs text-bg hover:bg-brand-hover disabled:opacity-40">
                <Sparkles size={13} /> {loading ? t("pipe.thinking", "arquitetando…") : t("pipe.generate", "Gerar plano")}
              </button>
            </div>
            {providers.length === 0 && <p className="text-[11px] text-amber-300/80">{t("pipe.noProviders", "cadastre uma chave em Ferramentas → Central de API")}</p>}
            {err && <p className="break-words font-mono text-[11px] text-danger">✗ {err}</p>}
          </div>

          {/* Plano renderizado */}
          {plan && (
            <div className="space-y-3 rounded-md border border-border p-3">
              <p className="text-[13px] text-text">{plan.summary}</p>

              {plan.floors.length > 1 && (
                <div className="text-[11px] text-textMuted">
                  <span className="font-semibold text-text/80">{t("pipe.floors", "Paralelos")}:</span>{" "}
                  {plan.floors.map((f) => f.name).join(" · ")}
                </div>
              )}

              {/* Agentes por onda (colunas = mini-canvas) */}
              <div className="flex gap-3 overflow-x-auto pb-1">
                {waves.map((w) => (
                  <div key={w} className="min-w-[180px] flex-1 space-y-1.5">
                    <div className="text-[10px] uppercase tracking-wider text-textMuted">{t("pipe.wave", "onda")} {w}</div>
                    {plan.agents.filter((a) => (a.wave ?? 1) === w).map((a) => (
                      <div key={a.role} className="rounded-md border border-brand/30 bg-brand/5 p-2">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[12px] font-semibold text-text">{a.role}</span>
                          {a.model && <span className={`rounded px-1 py-0.5 text-[8px] uppercase ${MODEL_COLORS[a.model] ?? "bg-white/10 text-text/60"}`}>{a.model}</span>}
                          {a.floor && plan.floors.length > 1 && <span className="text-[8px] text-textMuted">▦ {a.floor}</span>}
                        </div>
                        <div className="text-[10px] leading-snug text-text/60">{a.why}</div>
                        {plan.subagents.filter((s) => s.parent.toLowerCase() === a.role.toLowerCase()).map((s) => (
                          <div key={s.role} className="mt-1 rounded border border-amber-500/25 bg-amber-500/5 px-1.5 py-0.5 text-[10px] text-amber-200/90">
                            ↳ {s.role}{s.model ? ` · ${s.model}` : ""} <span className="text-text/40">(sub)</span>
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                ))}
              </div>

              {/* Conexões */}
              {plan.connections.length > 0 && (
                <div>
                  <div className="mb-1 text-[10px] uppercase tracking-wider text-textMuted">{t("pipe.connections", "Conexões")}</div>
                  <div className="flex flex-wrap gap-1">
                    {plan.connections.map((c, i) => (
                      <span key={i} className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-text/80" title={c.why}>
                        {c.from} <span className="text-brand">→</span> {c.to}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Caminho crítico */}
              {plan.criticalPath.length > 0 && (
                <div className="text-[11px]">
                  <span className="font-semibold text-text/80">{t("pipe.critical", "Caminho crítico")}:</span>{" "}
                  <span className="font-mono text-orange-300">{plan.criticalPath.join(" → ")}</span>
                </div>
              )}

              {plan.collaboration && (
                <p className="text-[11px] leading-snug text-text/60"><span className="font-semibold text-text/80">{t("pipe.collab", "Colaboração")}:</span> {plan.collaboration}</p>
              )}
            </div>
          )}
        </div>

        {plan && (
          <footer className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
            <button onClick={() => void save()} className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs text-text hover:bg-surface2">
              <Save size={13} /> {t("pipe.saveBtn", "Salvar plano")}
            </button>
            <button onClick={build} className="flex items-center gap-1.5 rounded-md bg-brand px-3 py-1.5 text-xs text-bg hover:bg-brand-hover">
              <Network size={13} /> {t("pipe.build", "Montar no canvas")}
            </button>
          </footer>
        )}
      </div>
    </div>,
    document.body,
  );
}
