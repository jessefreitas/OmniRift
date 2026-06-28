// src/components/SkillsCenterModal.tsx
//
// Central de Skills dos agentes. Dois níveis:
//   - GLOBAIS: valem pra TODO agente (união com as skills do role no spawn).
//   - POR AGENTE: extras só daquele role (escolhe o role num dropdown).
// Reusa skillsList (.claude/skills do projeto + ~/.claude/skills) + a importação
// (.md avulso / repo GitHub). As globais persistem em localStorage; as por-agente
// gravam no próprio role (onUpdateRoleSkills → saveRoles no Sidebar). Portal.

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Sparkles, FileUp, Download, RefreshCw, X } from "lucide-react";

import { skillsList, skillsImportMd, skillsImportGithub, type SkillInfo } from "@/lib/skills-client";
import { loadGlobalSkills, saveGlobalSkills } from "@/lib/global-skills";
import { loadGitProviders } from "@/lib/git-providers";
import { PromptModal } from "@/components/PromptModal";
import type { AgentRoleDef } from "@/lib/agent-roles";
import { useT } from "@/lib/i18n";

interface Props {
  cwd?: string | null;
  roles: AgentRoleDef[];
  /** Persiste as skills por-agente (Sidebar faz setRoles + saveRoles). */
  onUpdateRoleSkills: (roleId: string, skills: string[]) => void;
  onClose: () => void;
}

export function SkillsCenterModal({ cwd, roles, onUpdateRoleSkills, onClose }: Props) {
  const t = useT();
  const [available, setAvailable] = useState<SkillInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [globalSel, setGlobalSel] = useState<string[]>(() => loadGlobalSkills());
  const [roleId, setRoleId] = useState<string>(roles[0]?.id ?? "");
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [askGithub, setAskGithub] = useState(false);

  const loadSkills = useCallback(async () => {
    setLoading(true);
    try { setAvailable(await skillsList(cwd ?? "")); } catch { setAvailable([]); }
    finally { setLoading(false); }
  }, [cwd]);
  useEffect(() => { void loadSkills(); }, [loadSkills]);

  const role = useMemo(() => roles.find((r) => r.id === roleId), [roles, roleId]);
  const roleSkills = role?.skills ?? [];

  function toggleGlobal(name: string) {
    setGlobalSel((cur) => {
      const next = cur.includes(name) ? cur.filter((x) => x !== name) : [...cur, name];
      saveGlobalSkills(next);
      return next;
    });
  }

  function toggleRole(name: string) {
    if (!role) return;
    const next = roleSkills.includes(name) ? roleSkills.filter((x) => x !== name) : [...roleSkills, name];
    onUpdateRoleSkills(role.id, next);
  }

  async function importMd() {
    if (!cwd) { setImportMsg(t("skills.openProjectFirst", "abra um projeto primeiro")); return; }
    const sel = await openDialog({ multiple: false, filters: [{ name: "Skill (.md)", extensions: ["md"] }] });
    if (typeof sel !== "string") return;
    setImporting(true); setImportMsg(null);
    try { const info = await skillsImportMd(cwd, sel); await loadSkills(); setImportMsg(`✓ + ${info.name}`); }
    catch (e) { setImportMsg(`✗ ${String(e)}`); }
    finally { setImporting(false); }
  }

  async function importGithubSubmit(url: string) {
    setAskGithub(false);
    if (!cwd || !url.trim()) return;
    setImporting(true); setImportMsg(null);
    try {
      const token = loadGitProviders().find((p) => p.kind === "github")?.token;
      const infos = await skillsImportGithub(cwd, url.trim(), token);
      await loadSkills();
      setImportMsg(`✓ + ${infos.length} ${t("skills.fromGithub", "skill(s) do GitHub")}`);
    } catch (e) { setImportMsg(`✗ ${String(e)}`); }
    finally { setImporting(false); }
  }

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="w-[620px] max-w-[94vw] max-h-[86vh] rounded-lg border border-border bg-surface1 shadow-2xl flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center gap-2 px-4 py-2.5 border-b border-border shrink-0">
          <Sparkles size={15} className="text-brand" />
          <span className="text-sm font-medium text-text">{t("skills.title", "Skills dos agentes")}</span>
          <div className="flex-1" />
          <button onClick={() => void importMd()} disabled={!cwd || importing} title={t("skills.importMd", "Importar uma skill .md")} className="flex items-center gap-1 text-[11px] text-textMuted hover:text-brand disabled:opacity-40"><FileUp size={13} /> .md</button>
          <button onClick={() => { if (!cwd) { setImportMsg(t("skills.openProjectFirst", "abra um projeto primeiro")); return; } setAskGithub(true); }} disabled={!cwd || importing} title={t("skills.importGithub", "Importar skills de um repo GitHub")} className="flex items-center gap-1 text-[11px] text-textMuted hover:text-brand disabled:opacity-40"><Download size={13} /> GitHub</button>
          <button onClick={() => void loadSkills()} title={t("common.refresh", "Recarregar")} className="text-textMuted hover:text-brand p-1"><RefreshCw size={13} className={loading ? "animate-spin" : ""} /></button>
          <button onClick={onClose} className="text-textMuted hover:text-text p-1" title={t("common.close", "Fechar")}><X size={16} /></button>
        </header>

        <div className="px-4 py-2 border-b border-border bg-surface2/30 shrink-0">
          <span className="text-[11px] text-textMuted">{t("skills.intro", "Globais valem pra TODO agente. Por agente = extras só daquele role. O agente recebe a UNIÃO das duas no spawn.")}</span>
        </div>

        {importMsg && <p className={`px-4 py-1 text-[11px] ${importMsg.startsWith("✓") ? "text-green-400" : "text-danger"}`}>{importMsg}</p>}

        <div className="flex-1 overflow-auto p-4 space-y-4">
          {available.length === 0 ? (
            <p className="text-[12px] text-textMuted opacity-70">
              {cwd ? t("skills.empty", "Nenhuma skill em .claude/skills (projeto) nem em ~/.claude/skills. Importe uma acima (.md / GitHub).")
                   : t("skills.openProjectToList", "Abra um projeto pra listar as skills do projeto. As globais (~/.claude/skills) aparecem mesmo sem projeto.")}
            </p>
          ) : (
            <>
              {/* Globais — todo agente recebe */}
              <div>
                <div className="flex items-center gap-1.5 mb-1">
                  <label className="text-[11px] uppercase tracking-wider text-textMuted">{t("skills.global", "Globais · todo agente recebe")}</label>
                  {globalSel.length > 0 && <span className="text-[10px] text-brand">{globalSel.length}</span>}
                </div>
                <div className="rounded-md border border-border divide-y divide-border/40">
                  {available.map((s) => (
                    <label key={`g:${s.source}:${s.name}`} className="flex items-start gap-2 px-2 py-1.5 hover:bg-surface2 cursor-pointer">
                      <input type="checkbox" checked={globalSel.includes(s.name)} onChange={() => toggleGlobal(s.name)} className="mt-0.5" />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          <span className="text-[12px] text-text font-medium">{s.name}</span>
                          <span className="text-[8px] uppercase px-1 rounded bg-surface2 text-textMuted">{s.source === "project" ? t("skills.srcProject", "projeto") : t("skills.srcGlobal", "global")}</span>
                        </span>
                        {s.description && <span className="block text-[10px] text-textMuted opacity-70 truncate">{s.description}</span>}
                      </span>
                    </label>
                  ))}
                </div>
              </div>

              {/* Por agente — extras só daquele role */}
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <label className="text-[11px] uppercase tracking-wider text-textMuted">{t("skills.perAgent", "Por agente")}</label>
                  <select value={roleId} onChange={(e) => setRoleId(e.target.value)} className="text-[11px] rounded bg-bg border border-border text-text px-1.5 py-0.5 focus:outline-none">
                    {roles.length === 0 && <option value="">{t("skills.noRoles", "(nenhum role)")}</option>}
                    {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                  </select>
                </div>
                {!role ? (
                  <p className="text-[10px] text-textMuted opacity-60">{t("skills.createRole", "Crie um role na biblioteca pra escolher skills por agente.")}</p>
                ) : (
                  <div className="rounded-md border border-border divide-y divide-border/40">
                    {available.map((s) => {
                      const isGlobal = globalSel.includes(s.name);
                      const checked = isGlobal || roleSkills.includes(s.name);
                      return (
                        <label key={`r:${s.source}:${s.name}`} className={`flex items-start gap-2 px-2 py-1.5 ${isGlobal ? "opacity-60" : "hover:bg-surface2 cursor-pointer"}`}>
                          <input type="checkbox" disabled={isGlobal} checked={checked} onChange={() => toggleRole(s.name)} className="mt-0.5" />
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-1.5">
                              <span className="text-[12px] text-text font-medium">{s.name}</span>
                              {isGlobal && <span className="text-[8px] uppercase px-1 rounded bg-brand/20 text-brand">{t("skills.viaGlobal", "via global")}</span>}
                            </span>
                            {s.description && <span className="block text-[10px] text-textMuted opacity-70 truncate">{s.description}</span>}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        <footer className="px-4 py-2 border-t border-border text-[10px] text-textMuted opacity-70 shrink-0">
          {t("skills.footer", "As marcadas são materializadas como um plugin curado e injetadas no agente no spawn (claude: --plugin-dir, codex: CODEX_HOME). Vale pro PRÓXIMO agente lançado.")}
        </footer>
      </div>
      {askGithub && (
        <PromptModal
          title={t("skills.githubPrompt", "URL do repo GitHub com SKILL.md (ex.: github.com/owner/repo):")}
          placeholder="github.com/owner/repo"
          onSubmit={(v) => void importGithubSubmit(v)}
          onCancel={() => setAskGithub(false)}
        />
      )}
    </div>,
    document.body,
  );
}
