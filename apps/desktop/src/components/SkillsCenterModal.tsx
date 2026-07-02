// src/components/SkillsCenterModal.tsx
//
// Central de Skills dos agentes — LISTA por skill (seleção múltipla de agentes).
//   Cada skill é UMA linha: toggle 🌐 Global (todo agente recebe) + "aplica a:"
//   EXPANSÍVEL com seleção MÚLTIPLA de quais agentes a recebem. Só a skill aberta
//   renderiza os checkboxes dos agentes → leve (a grade cheia travava o WebKitGTK).
//   "Agentes" = roles (personas) + CLIs personalizados; cada um persiste suas skills
//   no seu lugar (role.skills via onUpdateRoleSkills; customCli.skills via
//   onUpdateCliSkills). Globais persistem em localStorage. Reusa skillsList +
//   importação (.md / GitHub). Portal.

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Sparkles, FileUp, Download, RefreshCw, X, Search, ChevronRight, ChevronDown, Globe } from "lucide-react";

import { skillsList, skillsImportMd, skillsImportGithub, type SkillInfo } from "@/lib/skills-client";
import { loadGlobalSkills, saveGlobalSkills } from "@/lib/global-skills";
import { githubToken } from "@/lib/git-providers";
import { PromptModal } from "@/components/PromptModal";
import type { AgentRoleDef } from "@/lib/agent-roles";
import type { CustomCli } from "@/lib/custom-clis";
import { cn } from "@/lib/cn";
import { useT } from "@/lib/i18n";

/** Alvo de skill na lista de agentes: um role (persona) ou um CLI personalizado. */
interface SkillTarget {
  id: string;
  name: string;
  skills: string[];
  kind: "role" | "cli";
}

interface Props {
  cwd?: string | null;
  roles: AgentRoleDef[];
  /** CLIs personalizados (NOVO AGENTE → +) — também recebem skills próprias. */
  customClis: CustomCli[];
  /** Persiste as skills de um ROLE (Sidebar faz setRoles + saveRoles). */
  onUpdateRoleSkills: (roleId: string, skills: string[]) => void;
  /** Persiste as skills de um CLI personalizado (Sidebar faz setCustomClis + save). */
  onUpdateCliSkills: (cliId: string, skills: string[]) => void;
  onClose: () => void;
}

export function SkillsCenterModal({ cwd, roles, customClis, onUpdateRoleSkills, onUpdateCliSkills, onClose }: Props) {
  const t = useT();
  const [available, setAvailable] = useState<SkillInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [globalSel, setGlobalSel] = useState<string[]>(() => loadGlobalSkills());
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [askGithub, setAskGithub] = useState(false);

  // Agentes = roles (personas) + CLIs personalizados, unificados como alvos de skill.
  const agents: SkillTarget[] = useMemo(() => [
    ...roles.map((r) => ({ id: r.id, name: r.name, skills: r.skills ?? [], kind: "role" as const })),
    ...customClis.map((c) => ({ id: c.id, name: c.label, skills: c.skills ?? [], kind: "cli" as const })),
  ], [roles, customClis]);

  const loadSkills = useCallback(async () => {
    setLoading(true);
    try { setAvailable(await skillsList(cwd ?? "")); } catch { setAvailable([]); }
    finally { setLoading(false); }
  }, [cwd]);
  useEffect(() => { void loadSkills(); }, [loadSkills]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return available;
    return available.filter(
      (s) => s.name.toLowerCase().includes(q) || (s.description ?? "").toLowerCase().includes(q),
    );
  }, [available, query]);

  function toggleGlobal(name: string) {
    setGlobalSel((cur) => {
      const next = cur.includes(name) ? cur.filter((x) => x !== name) : [...cur, name];
      saveGlobalSkills(next);
      return next;
    });
  }

  function toggleAgentSkill(target: SkillTarget, name: string) {
    const next = target.skills.includes(name) ? target.skills.filter((x) => x !== name) : [...target.skills, name];
    if (target.kind === "role") onUpdateRoleSkills(target.id, next);
    else onUpdateCliSkills(target.id, next);
  }

  function toggleExpand(name: string) {
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  /** Quantos agentes recebem a skill no spawn (global = todos). */
  function agentCount(name: string): number {
    if (globalSel.includes(name)) return agents.length;
    return agents.filter((a) => a.skills.includes(name)).length;
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
      const token = await githubToken();
      const infos = await skillsImportGithub(cwd, url.trim(), token);
      await loadSkills();
      setImportMsg(`✓ + ${infos.length} ${t("skills.fromGithub", "skill(s) do GitHub")}`);
    } catch (e) { setImportMsg(`✗ ${String(e)}`); }
    finally { setImporting(false); }
  }

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="w-[640px] max-w-[94vw] max-h-[86vh] rounded-lg border border-border bg-surface1 shadow-2xl flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center gap-2 px-4 py-2.5 border-b border-border shrink-0">
          <Sparkles size={15} className="text-brand" />
          <span className="text-sm font-medium text-text">{t("skills.title", "Skills dos agentes")}</span>
          <div className="flex-1" />
          <button onClick={() => void importMd()} disabled={!cwd || importing} title={t("skills.importMd", "Importar uma skill .md")} className="flex items-center gap-1 text-[11px] text-textMuted hover:text-brand disabled:opacity-40"><FileUp size={13} /> .md</button>
          <button onClick={() => { if (!cwd) { setImportMsg(t("skills.openProjectFirst", "abra um projeto primeiro")); return; } setAskGithub(true); }} disabled={!cwd || importing} title={t("skills.importGithub", "Importar skills de um repo GitHub")} className="flex items-center gap-1 text-[11px] text-textMuted hover:text-brand disabled:opacity-40"><Download size={13} /> GitHub</button>
          <button onClick={() => void loadSkills()} title={t("common.refresh", "Recarregar")} className="text-textMuted hover:text-brand p-1"><RefreshCw size={13} className={loading ? "animate-spin" : ""} /></button>
          <button onClick={onClose} className="text-textMuted hover:text-text p-1" title={t("common.close", "Fechar")}><X size={16} /></button>
        </header>

        <div className="px-4 py-2 border-b border-border bg-surface2/30 shrink-0 flex items-center gap-3">
          <span className="text-[11px] text-textMuted flex-1">{t("skills.introList", "🌐 = todo agente recebe. Senão, clique em \"agentes\" pra escolher (seleção múltipla) quem recebe cada skill. O agente recebe a UNIÃO no spawn.")}</span>
          <div className="flex items-center gap-1.5 rounded-md border border-border bg-bg px-2 py-1 shrink-0">
            <Search size={12} className="text-textMuted" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("skills.search", "buscar skill...")}
              className="bg-transparent text-[11px] text-text placeholder:text-textMuted focus:outline-none w-36"
            />
          </div>
        </div>

        {importMsg && <p className={`px-4 py-1 text-[11px] ${importMsg.startsWith("✓") ? "text-green-400" : "text-danger"}`}>{importMsg}</p>}

        <div className="flex-1 overflow-auto p-3 space-y-1">
          {available.length === 0 ? (
            <p className="text-[12px] text-textMuted opacity-70 p-1">
              {cwd ? t("skills.empty", "Nenhuma skill em .claude/skills (projeto) nem em ~/.claude/skills. Importe uma acima (.md / GitHub).")
                   : t("skills.openProjectToList", "Abra um projeto pra listar as skills do projeto. As globais (~/.claude/skills) aparecem mesmo sem projeto.")}
            </p>
          ) : filtered.length === 0 ? (
            <p className="text-[12px] text-textMuted opacity-60 p-1">{t("skills.noMatch", "Nenhuma skill bate com a busca.")}</p>
          ) : (
            filtered.map((s) => {
              const isGlobal = globalSel.includes(s.name);
              const isOpen = expanded.has(s.name);
              const count = agentCount(s.name);
              return (
                <div key={`${s.source}:${s.name}`} className="rounded-md border border-border/60 bg-surface2/20">
                  <div className="flex items-center gap-2 px-2 py-1.5">
                    {/* Toggle Global (todo agente) */}
                    <button
                      onClick={() => toggleGlobal(s.name)}
                      title={isGlobal ? t("skills.globalOn", "Todo agente recebe — clique pra desligar") : t("skills.globalOff", "Aplicar a todo agente")}
                      className={cn(
                        "flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded shrink-0 border transition-colors",
                        isGlobal ? "bg-brand/20 text-brand border-brand/40" : "text-textMuted border-border hover:text-brand",
                      )}
                    >
                      <Globe size={11} /> {t("skills.all", "todos")}
                    </button>
                    {/* Nome + origem + descrição */}
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="text-[12px] text-text font-medium truncate">{s.name}</span>
                        <span className="text-[8px] uppercase px-1 rounded bg-surface2 text-textMuted shrink-0">{s.source === "project" ? t("skills.srcProject", "projeto") : t("skills.srcGlobal", "global")}</span>
                      </span>
                      {s.description && <span className="block text-[10px] text-textMuted opacity-60 truncate">{s.description}</span>}
                    </span>
                    {/* "aplica a: N agentes" — expansor (desabilitado quando global) */}
                    <button
                      onClick={() => { if (!isGlobal) toggleExpand(s.name); }}
                      disabled={isGlobal}
                      title={isGlobal ? t("skills.viaGlobalAll", "via global (todos os agentes)") : t("skills.chooseAgents", "escolher quais agentes recebem")}
                      className={cn(
                        "flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded shrink-0 tabular-nums",
                        isGlobal ? "text-textMuted opacity-50" : "text-textMuted hover:text-brand",
                      )}
                    >
                      {isGlobal ? t("skills.allAgents", "todos") : `${count} ${t("skills.agents", "agentes")}`}
                      {!isGlobal && (isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />)}
                    </button>
                  </div>
                  {/* Seleção múltipla de agentes — só renderiza se aberta E não-global (leve) */}
                  {isOpen && !isGlobal && (
                    <div className="px-2 pb-2 pt-1 flex flex-wrap gap-x-3 gap-y-1.5 border-t border-border/40">
                      {agents.length === 0 ? (
                        <span className="text-[10px] text-textMuted opacity-60">{t("skills.noAgents", "(nenhum agente — crie um role ou CLI personalizado)")}</span>
                      ) : (
                        agents.map((a) => {
                          const checked = a.skills.includes(s.name);
                          return (
                            <label key={`${a.kind}:${a.id}`} className="flex items-center gap-1 text-[11px] cursor-pointer select-none">
                              <input type="checkbox" checked={checked} onChange={() => toggleAgentSkill(a, s.name)} />
                              <span className={checked ? "text-text" : "text-textMuted"}>{a.name}</span>
                              {a.kind === "cli" && <span className="text-[7px] uppercase px-0.5 rounded bg-brand/15 text-brand">cli</span>}
                            </label>
                          );
                        })
                      )}
                    </div>
                  )}
                </div>
              );
            })
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
