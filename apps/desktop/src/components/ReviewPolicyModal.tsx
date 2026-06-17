// src/components/ReviewPolicyModal.tsx
//
// Editor visual da política de review (por projeto ou global): métricas
// (categorias/pesos/blocking), gates (thresholds), coverage, contratos, limites
// de PR, e o modo de gate. Salvo em localStorage por escopo.

import { useState } from "react";
import { createPortal } from "react-dom";
import { Plus, Sliders, Trash2, X } from "lucide-react";

import { loadPolicy, savePolicy, type ReviewPolicy, type ReviewCategory } from "@/lib/review-policy";
import { persistReviewConfig } from "@/lib/review-config-sync";

interface Props {
  scope?: string;
  scopeLabel?: string;
  onClose: () => void;
}

// Presets de rigor: aplicam thresholds + quais categorias bloqueiam + coverage
// (template inicial — tudo editável depois).
const PRESETS: { id: string; label: string; block: string[]; maxCritical: number; maxWarning: number; coverage: number }[] = [
  { id: "frouxo", label: "Frouxo", block: ["security"], maxCritical: 0, maxWarning: 5, coverage: 60 },
  { id: "padrao", label: "Padrão", block: ["security"], maxCritical: 0, maxWarning: 1, coverage: 80 },
  { id: "rigido", label: "Rígido", block: ["security", "quality"], maxCritical: 0, maxWarning: 0, coverage: 90 },
];

export function ReviewPolicyModal({ scope, scopeLabel, onClose }: Props) {
  const [p, setP] = useState<ReviewPolicy>(() => loadPolicy(scope));

  const patch = (u: Partial<ReviewPolicy>) => setP((cur) => ({ ...cur, ...u }));
  const patchCat = (i: number, u: Partial<ReviewCategory>) =>
    setP((cur) => ({ ...cur, categories: cur.categories.map((c, j) => (j === i ? { ...c, ...u } : c)) }));
  const addCat = () =>
    setP((cur) => ({ ...cur, categories: [...cur.categories, { key: `cat${cur.categories.length}`, label: "Nova", weight: 3, blocking: false }] }));
  const delCat = (i: number) => setP((cur) => ({ ...cur, categories: cur.categories.filter((_, j) => j !== i) }));

  function applyPreset(id: string) {
    const pr = PRESETS.find((x) => x.id === id);
    if (!pr) return;
    setP((cur) => ({
      ...cur,
      thresholds: { maxCritical: pr.maxCritical, maxWarning: pr.maxWarning },
      coverage: pr.coverage,
      categories: cur.categories.map((c) => ({ ...c, blocking: pr.block.includes(c.key) })),
    }));
  }

  const num = (v: string): number | undefined => (v.trim() === "" ? undefined : Number(v));

  function save() {
    savePolicy(p, scope);
    void persistReviewConfig(); // espelha pro backend (Stop hook / MCP review)
    onClose();
  }

  const inp = "px-1.5 py-0.5 rounded text-[11px] bg-bg border border-border text-text focus:outline-none focus:border-brand";

  return createPortal(
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="w-[680px] max-w-[94vw] max-h-[90vh] rounded-lg border border-border bg-surface1 shadow-2xl flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center gap-2 px-4 py-2.5 border-b border-border shrink-0">
          <Sliders size={15} className="text-brand" />
          <span className="text-sm font-medium text-text flex-1">Política de Review {scopeLabel && <span className="text-[11px] text-textMuted">· {scopeLabel}</span>}</span>
          <button onClick={onClose} className="text-textMuted hover:text-text p-1" title="Fechar"><X size={16} /></button>
        </header>

        <div className="flex-1 overflow-auto p-4 space-y-4 text-[12px]">
          {/* Liga/gate */}
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-1.5 text-text">
              <input type="checkbox" checked={p.enabled} onChange={(e) => patch({ enabled: e.target.checked })} /> Review ativo
            </label>
            <label className="flex items-center gap-1.5 text-text">
              Gate no Land:
              <select value={p.gate} onChange={(e) => patch({ gate: e.target.value as ReviewPolicy["gate"] })} className={inp}>
                <option value="block">bloqueia</option>
                <option value="warn">só avisa</option>
                <option value="off">desligado</option>
              </select>
            </label>
          </div>

          {/* Presets de rigor */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[11px] uppercase tracking-wider text-textMuted">Preset</span>
            {PRESETS.map((pr) => (
              <button key={pr.id} onClick={() => applyPreset(pr.id)} className="px-2 py-0.5 rounded text-[11px] border border-border text-textMuted hover:text-brand hover:border-brand transition-colors">
                {pr.label}
              </button>
            ))}
            <span className="text-[10px] text-textMuted opacity-50">aplica thresholds + o que bloqueia (editável depois)</span>
          </div>

          {/* Categorias (métricas) */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-[11px] uppercase tracking-wider text-textMuted">Métricas (categorias)</span>
              <button onClick={addCat} className="flex items-center gap-1 text-[11px] text-textMuted hover:text-brand"><Plus size={12} /> categoria</button>
            </div>
            <div className="space-y-1">
              <div className="grid grid-cols-[1fr_70px_60px_60px_28px] gap-2 text-[10px] text-textMuted opacity-60 px-1">
                <span>label</span><span>key</span><span>peso</span><span>bloqueia</span><span></span>
              </div>
              {p.categories.map((c, i) => (
                <div key={i} className="grid grid-cols-[1fr_70px_60px_60px_28px] gap-2 items-center">
                  <input value={c.label} onChange={(e) => patchCat(i, { label: e.target.value })} className={inp} />
                  <input value={c.key} onChange={(e) => patchCat(i, { key: e.target.value })} className={`${inp} font-mono`} />
                  <input type="number" value={c.weight} onChange={(e) => patchCat(i, { weight: Number(e.target.value) })} className={inp} />
                  <input type="checkbox" checked={c.blocking} onChange={(e) => patchCat(i, { blocking: e.target.checked })} className="justify-self-center" />
                  <button onClick={() => delCat(i)} className="text-textMuted hover:text-danger justify-self-center"><Trash2 size={12} /></button>
                </div>
              ))}
            </div>
          </div>

          {/* Thresholds + coverage */}
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-1.5 text-text">máx CRITICAL <input type="number" value={p.thresholds.maxCritical} onChange={(e) => patch({ thresholds: { ...p.thresholds, maxCritical: Number(e.target.value) } })} className={`${inp} w-16`} /></label>
            <label className="flex items-center gap-1.5 text-text">máx WARNING <input type="number" value={p.thresholds.maxWarning} onChange={(e) => patch({ thresholds: { ...p.thresholds, maxWarning: Number(e.target.value) } })} className={`${inp} w-16`} /></label>
            <label className="flex items-center gap-1.5 text-text">coverage % <input type="number" min={0} max={100} value={p.coverage} onChange={(e) => patch({ coverage: Number(e.target.value) })} className={`${inp} w-16`} /></label>
          </div>

          {/* Limites de PR */}
          <div className="flex flex-wrap items-center gap-4">
            <span className="text-[11px] uppercase tracking-wider text-textMuted">Limites de PR</span>
            <label className="flex items-center gap-1.5 text-text">máx arquivos <input type="number" value={p.prLimits.maxFiles ?? ""} onChange={(e) => patch({ prLimits: { ...p.prLimits, maxFiles: num(e.target.value) } })} className={`${inp} w-16`} /></label>
            <label className="flex items-center gap-1.5 text-text">máx linhas <input type="number" value={p.prLimits.maxLines ?? ""} onChange={(e) => patch({ prLimits: { ...p.prLimits, maxLines: num(e.target.value) } })} className={`${inp} w-20`} /></label>
            <label className="flex items-center gap-1.5 text-text">máx linhas/arquivo <input type="number" value={p.prLimits.maxFileLines ?? ""} onChange={(e) => patch({ prLimits: { ...p.prLimits, maxFileLines: num(e.target.value) } })} className={`${inp} w-20`} /></label>
          </div>

          {/* Contratos */}
          <div>
            <label className="text-[11px] uppercase tracking-wider text-textMuted">Contratos / regras extras (vão no prompt)</label>
            <textarea value={p.contracts} onChange={(e) => patch({ contracts: e.target.value })} rows={4} placeholder="ex: nenhum console.log; toda função pública documentada; sem any em TS…" className="mt-1 w-full px-2 py-1.5 rounded-md text-[11px] bg-bg border border-border text-text resize-y focus:outline-none focus:border-brand font-mono" />
          </div>
        </div>

        <footer className="flex justify-end gap-2 px-4 py-3 border-t border-border shrink-0">
          <button onClick={onClose} className="px-3 py-1.5 rounded-md text-xs text-textMuted hover:bg-surface2">Cancelar</button>
          <button onClick={save} className="px-3 py-1.5 rounded-md text-xs bg-brand text-bg hover:bg-brand-hover">Salvar</button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
