// src/components/ReviewPolicyModal.tsx
//
// Editor visual da política de review (por projeto ou global): métricas
// (categorias/pesos/blocking), gates (thresholds), coverage, contratos, limites
// de PR, e o modo de gate. Salvo em localStorage por escopo.

import { useEffect, useState } from "react";
import { SafeInput, SafeTextarea } from "@/components/SafeInput";
import { createPortal } from "react-dom";
import { Plus, Sliders, Trash2, X } from "lucide-react";

import { loadPolicy, savePolicy, type ReviewPolicy, type ReviewCategory } from "@/lib/review-policy";
import { persistReviewConfig } from "@/lib/review-config-sync";
import { reviewContextRead, reviewContextWrite, reviewSuppressRead, reviewSuppressWrite, reviewPathrulesRead, reviewPathrulesWrite, type SuppressRule, type PathRule } from "@/lib/review-meta-client";
import { useT } from "@/lib/i18n";

interface Props {
  scope?: string;
  scopeLabel?: string;
  /** cwd do projeto — pra editar o contexto/supressões committed em .forgejo. */
  cwd?: string | null;
  onClose: () => void;
  /** Embute sem backdrop/portal próprio (painel unificado Code Review IA). */
  embedded?: boolean;
}

// Presets de rigor: aplicam thresholds + quais categorias bloqueiam + coverage
// (template inicial — tudo editável depois).
const PRESETS: { id: string; label: string; labelKey: string; block: string[]; maxCritical: number; maxWarning: number; coverage: number }[] = [
  { id: "frouxo", label: "Frouxo", labelKey: "reviewPolicy.presetLoose", block: ["security"], maxCritical: 0, maxWarning: 5, coverage: 60 },
  { id: "padrao", label: "Padrão", labelKey: "reviewPolicy.presetDefault", block: ["security"], maxCritical: 0, maxWarning: 1, coverage: 80 },
  { id: "rigido", label: "Rígido", labelKey: "reviewPolicy.presetStrict", block: ["security", "quality"], maxCritical: 0, maxWarning: 0, coverage: 90 },
];

export function ReviewPolicyModal({ scope, scopeLabel, cwd, onClose, embedded }: Props) {
  const t = useT();
  const [p, setP] = useState<ReviewPolicy>(() => loadPolicy(scope));
  const [ctx, setCtx] = useState("");
  const [suppress, setSuppress] = useState<SuppressRule[]>([]);
  const [pathrules, setPathrules] = useState<PathRule[]>([]);

  useEffect(() => {
    if (!cwd) return;
    reviewContextRead(cwd).then(setCtx).catch(() => {});
    reviewSuppressRead(cwd).then(setSuppress).catch(() => {});
    reviewPathrulesRead(cwd).then(setPathrules).catch(() => {});
  }, [cwd]);

  const patch = (u: Partial<ReviewPolicy>) => setP((cur) => ({ ...cur, ...u }));
  const patchCat = (i: number, u: Partial<ReviewCategory>) =>
    setP((cur) => ({ ...cur, categories: cur.categories.map((c, j) => (j === i ? { ...c, ...u } : c)) }));
  const addCat = () =>
    setP((cur) => ({ ...cur, categories: [...cur.categories, { key: `cat${cur.categories.length}`, label: t("reviewPolicy.newCategory", "Nova"), weight: 3, blocking: false }] }));
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
    if (cwd) {
      void reviewContextWrite(cwd, ctx).catch(() => {});
      void reviewSuppressWrite(cwd, suppress.filter((s) => s.file.trim())).catch(() => {});
      void reviewPathrulesWrite(cwd, pathrules.filter((r) => r.glob.trim())).catch(() => {});
    }
    onClose();
  }

  const inp = "px-1.5 py-0.5 rounded text-[11px] bg-bg border border-border text-text focus:outline-none focus:border-brand";

  const card = (
      <div className={embedded ? "flex flex-col max-h-[76vh] overflow-hidden" : "w-[680px] max-w-[94vw] max-h-[90vh] rounded-lg border border-border bg-surface1 shadow-2xl flex flex-col overflow-hidden"} onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center gap-2 px-4 py-2.5 border-b border-border shrink-0">
          <Sliders size={15} className="text-brand" />
          <span className="text-sm font-medium text-text flex-1">{t("reviewPolicy.title", "Política de Review")} {scopeLabel && <span className="text-[11px] text-textMuted">· {scopeLabel}</span>}</span>
          {!embedded && <button onClick={onClose} className="text-textMuted hover:text-text p-1" title={t("reviewPolicy.close", "Fechar")}><X size={16} /></button>}
        </header>

        <div className="flex-1 overflow-auto p-4 space-y-4 text-[12px]">
          {/* Liga/gate */}
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-1.5 text-text">
              <input type="checkbox" checked={p.enabled} onChange={(e) => patch({ enabled: e.target.checked })} /> {t("reviewPolicy.reviewActive", "Review ativo")}
            </label>
            <label className="flex items-center gap-1.5 text-text">
              {t("reviewPolicy.gateOnLand", "Gate no Land:")}
              <select value={p.gate} onChange={(e) => patch({ gate: e.target.value as ReviewPolicy["gate"] })} className={inp}>
                <option value="block">{t("reviewPolicy.gateBlock", "bloqueia")}</option>
                <option value="warn">{t("reviewPolicy.gateWarn", "só avisa")}</option>
                <option value="off">{t("reviewPolicy.gateOff", "desligado")}</option>
              </select>
            </label>
          </div>

          {/* Presets de rigor */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[11px] uppercase tracking-wider text-textMuted">{t("reviewPolicy.preset", "Preset")}</span>
            {PRESETS.map((pr) => (
              <button key={pr.id} onClick={() => applyPreset(pr.id)} className="px-2 py-0.5 rounded text-[11px] border border-border text-textMuted hover:text-brand hover:border-brand transition-colors">
                {t(pr.labelKey, pr.label)}
              </button>
            ))}
            <span className="text-[10px] text-textMuted opacity-50">{t("reviewPolicy.presetHint", "aplica thresholds + o que bloqueia (editável depois)")}</span>
          </div>

          {/* Categorias (métricas) */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-[11px] uppercase tracking-wider text-textMuted">{t("reviewPolicy.metrics", "Métricas (categorias)")}</span>
              <button onClick={addCat} className="flex items-center gap-1 text-[11px] text-textMuted hover:text-brand"><Plus size={12} /> {t("reviewPolicy.category", "categoria")}</button>
            </div>
            <div className="space-y-1">
              <div className="grid grid-cols-[1fr_70px_60px_60px_28px] gap-2 text-[10px] text-textMuted opacity-60 px-1">
                <span>{t("reviewPolicy.colLabel", "label")}</span><span>{t("reviewPolicy.colKey", "key")}</span><span>{t("reviewPolicy.colWeight", "peso")}</span><span>{t("reviewPolicy.colBlocking", "bloqueia")}</span><span></span>
              </div>
              {p.categories.map((c, i) => (
                <div key={i} className="grid grid-cols-[1fr_70px_60px_60px_28px] gap-2 items-center">
                  <SafeInput value={t("reviewCategory." + c.key, c.label)} onChange={(e) => patchCat(i, { label: e.target.value })} className={inp} />
                  <SafeInput value={c.key} onChange={(e) => patchCat(i, { key: e.target.value })} className={`${inp} font-mono`} />
                  <input type="number" value={c.weight} onChange={(e) => patchCat(i, { weight: Number(e.target.value) })} className={inp} />
                  <input type="checkbox" checked={c.blocking} onChange={(e) => patchCat(i, { blocking: e.target.checked })} className="justify-self-center" />
                  <button onClick={() => delCat(i)} className="text-textMuted hover:text-danger justify-self-center"><Trash2 size={12} /></button>
                </div>
              ))}
            </div>
          </div>

          {/* Thresholds + coverage */}
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-1.5 text-text">{t("reviewPolicy.maxCritical", "máx CRITICAL")} <input type="number" value={p.thresholds.maxCritical} onChange={(e) => patch({ thresholds: { ...p.thresholds, maxCritical: Number(e.target.value) } })} className={`${inp} w-16`} /></label>
            <label className="flex items-center gap-1.5 text-text">{t("reviewPolicy.maxWarning", "máx WARNING")} <input type="number" value={p.thresholds.maxWarning} onChange={(e) => patch({ thresholds: { ...p.thresholds, maxWarning: Number(e.target.value) } })} className={`${inp} w-16`} /></label>
            <label className="flex items-center gap-1.5 text-text">{t("reviewPolicy.coverage", "coverage %")} <input type="number" min={0} max={100} value={p.coverage} onChange={(e) => patch({ coverage: Number(e.target.value) })} className={`${inp} w-16`} /></label>
          </div>

          {/* Limites de PR */}
          <div className="flex flex-wrap items-center gap-4">
            <span className="text-[11px] uppercase tracking-wider text-textMuted">{t("reviewPolicy.prLimits", "Limites de PR")}</span>
            <label className="flex items-center gap-1.5 text-text">{t("reviewPolicy.maxFiles", "máx arquivos")} <input type="number" value={p.prLimits.maxFiles ?? ""} onChange={(e) => patch({ prLimits: { ...p.prLimits, maxFiles: num(e.target.value) } })} className={`${inp} w-16`} /></label>
            <label className="flex items-center gap-1.5 text-text">{t("reviewPolicy.maxLines", "máx linhas")} <input type="number" value={p.prLimits.maxLines ?? ""} onChange={(e) => patch({ prLimits: { ...p.prLimits, maxLines: num(e.target.value) } })} className={`${inp} w-20`} /></label>
            <label className="flex items-center gap-1.5 text-text">{t("reviewPolicy.maxFileLines", "máx linhas/arquivo")} <input type="number" value={p.prLimits.maxFileLines ?? ""} onChange={(e) => patch({ prLimits: { ...p.prLimits, maxFileLines: num(e.target.value) } })} className={`${inp} w-20`} /></label>
          </div>

          {/* Contratos */}
          <div>
            <label className="text-[11px] uppercase tracking-wider text-textMuted">{t("reviewPolicy.contracts", "Contratos / regras extras (vão no prompt)")}</label>
            <SafeTextarea value={p.contracts} onChange={(e) => patch({ contracts: e.target.value })} rows={4} placeholder={t("reviewPolicy.contractsPlaceholder", "ex: nenhum console.log; toda função pública documentada; sem any em TS…")} className="mt-1 w-full px-2 py-1.5 rounded-md text-[11px] bg-bg border border-border text-text resize-y focus:outline-none focus:border-brand font-mono" />
          </div>

          {/* Contexto de design (committed em .forgejo/review-context.md) */}
          {cwd && (
            <div>
              <label className="text-[11px] uppercase tracking-wider text-textMuted">{t("reviewPolicy.designContext", "Contexto de design (o reviewer respeita)")}</label>
              <SafeTextarea value={ctx} onChange={(e) => setCtx(e.target.value)} rows={5} placeholder={t("reviewPolicy.designContextPlaceholder", "Decisões INTENCIONAIS que o reviewer NÃO deve flagar (threat model, chave pública embutida, ofuscação documentada…)")} className="mt-1 w-full px-2 py-1.5 rounded-md text-[11px] bg-bg border border-border text-text resize-y focus:outline-none focus:border-brand font-mono" />
              <p className="mt-0.5 text-[10px] text-textMuted opacity-50">{t("reviewPolicy.savedInPrefix", "Salvo em")} <code>.forgejo/review-context.md</code> {t("reviewPolicy.designContextNote", "— usado pelo review do CI e local.")}</p>
            </div>
          )}

          {/* Achados aceitos (supressões geríveis) */}
          {cwd && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-[11px] uppercase tracking-wider text-textMuted">{t("reviewPolicy.acceptedFindings", "Achados aceitos (supressão)")}</span>
                <button onClick={() => setSuppress((s) => [...s, { file: "", keywords: [], reason: "" }])} className="flex items-center gap-1 text-[11px] text-textMuted hover:text-brand"><Plus size={12} /> {t("reviewPolicy.rule", "regra")}</button>
              </div>
              <div className="space-y-1">
                {suppress.length === 0 && <p className="text-[10px] text-textMuted opacity-50">{t("reviewPolicy.noSuppress", "Nenhuma. Adicione pra silenciar um falso-positivo reconhecido (exige motivo).")}</p>}
                {suppress.map((s, i) => (
                  <div key={i} className="grid grid-cols-[110px_1fr_1fr_28px] gap-2 items-center">
                    <SafeInput value={s.file} onChange={(e) => setSuppress((arr) => arr.map((x, j) => (j === i ? { ...x, file: e.target.value } : x)))} placeholder={t("reviewPolicy.filePlaceholder", "arquivo.rs")} className={`${inp} font-mono`} />
                    <SafeInput value={s.keywords.join(", ")} onChange={(e) => setSuppress((arr) => arr.map((x, j) => (j === i ? { ...x, keywords: e.target.value.split(",").map((k) => k.trim()).filter(Boolean) } : x)))} placeholder={t("reviewPolicy.keywordsPlaceholder", "palavras (vírgula)")} className={inp} />
                    <SafeInput value={s.reason} onChange={(e) => setSuppress((arr) => arr.map((x, j) => (j === i ? { ...x, reason: e.target.value } : x)))} placeholder={t("reviewPolicy.reasonPlaceholder", "motivo")} className={inp} />
                    <button onClick={() => setSuppress((arr) => arr.filter((_, j) => j !== i))} className="text-textMuted hover:text-danger justify-self-center"><Trash2 size={12} /></button>
                  </div>
                ))}
              </div>
              <p className="mt-0.5 text-[10px] text-textMuted opacity-50">{t("reviewPolicy.suppressNotePrefix", "Casa por arquivo + palavra no título do achado.")} {t("reviewPolicy.savedInPrefix", "Salvo em")} <code>.forgejo/review-suppress.json</code>.</p>
            </div>
          )}

          {/* Regras por path */}
          {cwd && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-[11px] uppercase tracking-wider text-textMuted">{t("reviewPolicy.pathRules", "Regras por path")}</span>
                <button onClick={() => setPathrules((r) => [...r, { glob: "", requireTest: true, severity: "WARNING", message: "" }])} className="flex items-center gap-1 text-[11px] text-textMuted hover:text-brand"><Plus size={12} /> {t("reviewPolicy.rule", "regra")}</button>
              </div>
              <div className="space-y-1">
                {pathrules.length === 0 && <p className="text-[10px] text-textMuted opacity-50">{t("reviewPolicy.pathRulesExample", 'Ex.: "src/api/** exige teste"; "**/migrations/** → aviso de DBA".')}</p>}
                {pathrules.map((r, i) => (
                  <div key={i} className="grid grid-cols-[1fr_64px_64px_1fr_28px] gap-2 items-center">
                    <SafeInput value={r.glob} onChange={(e) => setPathrules((arr) => arr.map((x, j) => (j === i ? { ...x, glob: e.target.value } : x)))} placeholder="src/api/**" className={`${inp} font-mono`} />
                    <label className="flex items-center gap-1 text-[10px] text-textMuted"><input type="checkbox" checked={r.requireTest} onChange={(e) => setPathrules((arr) => arr.map((x, j) => (j === i ? { ...x, requireTest: e.target.checked } : x)))} /> {t("reviewPolicy.test", "teste")}</label>
                    <select value={r.severity} onChange={(e) => setPathrules((arr) => arr.map((x, j) => (j === i ? { ...x, severity: e.target.value } : x)))} className={inp}><option value="WARNING">WARN</option><option value="INFO">INFO</option></select>
                    <SafeInput value={r.message} onChange={(e) => setPathrules((arr) => arr.map((x, j) => (j === i ? { ...x, message: e.target.value } : x)))} placeholder={t("reviewPolicy.messagePlaceholder", "mensagem")} className={inp} />
                    <button onClick={() => setPathrules((arr) => arr.filter((_, j) => j !== i))} className="text-textMuted hover:text-danger justify-self-center"><Trash2 size={12} /></button>
                  </div>
                ))}
              </div>
              <p className="mt-0.5 text-[10px] text-textMuted opacity-50">{t("reviewPolicy.pathRulesNotePrefix", '"teste" = arquivos que casam exigem um teste no diff.')} {t("reviewPolicy.savedInPrefix", "Salvo em")} <code>.forgejo/review-pathrules.json</code> (advisory).</p>
            </div>
          )}
        </div>

        <footer className="flex justify-end gap-2 px-4 py-3 border-t border-border shrink-0">
          <button onClick={onClose} className="px-3 py-1.5 rounded-md text-xs text-textMuted hover:bg-surface2">{t("reviewPolicy.cancel", "Cancelar")}</button>
          <button onClick={save} className="px-3 py-1.5 rounded-md text-xs bg-brand text-bg hover:bg-brand-hover">{t("reviewPolicy.save", "Salvar")}</button>
        </footer>
      </div>
  );
  return embedded ? card : createPortal(
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>{card}</div>,
    document.body,
  );
}
