// src/components/RoleEditModal.tsx
//
// Modal pra editar/criar um role de agente (nome + CLI + skills + persona). Usado
// pela biblioteca de Roles na sidebar. As skills marcadas são curadas de
// .claude/skills e injetadas na persona do agente no spawn. Renderiza em portal.

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Download, FileUp, Sparkles, X } from "lucide-react";

import { ROLE_CLIS, type AgentRoleDef } from "@/lib/agent-roles";
import { skillsList, skillsImportMd, skillsImportGithub, type SkillInfo } from "@/lib/skills-client";
import { loadGitProviders } from "@/lib/git-providers";
import { useT } from "@/lib/i18n";

interface Props {
  role: AgentRoleDef;
  /** cwd do projeto ativo — pra listar as skills de .claude/skills. */
  cwd?: string | null;
  onSave: (name: string, prompt: string, cli: string, startupCmd: string, skills: string[], compressor: string, selfSystemPrompt: boolean) => void;
  onClose: () => void;
}

export function RoleEditModal({ role, cwd, onSave, onClose }: Props) {
  const t = useT();
  const [name, setName] = useState(role.name);
  const [prompt, setPrompt] = useState(role.prompt);
  const [cli, setCli] = useState(role.cli ?? "claude");
  const [startupCmd, setStartupCmd] = useState(role.startupCmd ?? "");
  const [skills, setSkills] = useState<string[]>(role.skills ?? []);
  const [available, setAvailable] = useState<SkillInfo[]>([]);
  const [compressor, setCompressor] = useState(role.compressor ?? "none");
  const [selfSystemPrompt, setSelfSystemPrompt] = useState(role.selfSystemPrompt ?? false);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const isShell = cli === "shell";

  const loadSkills = useCallback(async () => {
    if (!cwd) { setAvailable([]); return; }
    try { setAvailable(await skillsList(cwd)); } catch { setAvailable([]); }
  }, [cwd]);
  useEffect(() => { void loadSkills(); }, [loadSkills]);

  function toggleSkill(n: string) {
    setSkills((cur) => (cur.includes(n) ? cur.filter((x) => x !== n) : [...cur, n]));
  }

  // Importa um .md avulso → vira skill do projeto e já entra marcada.
  async function importMd() {
    if (!cwd) { setImportMsg(t("roleEdit.openProjectFirst", "abra um projeto primeiro")); return; }
    const sel = await openDialog({ multiple: false, filters: [{ name: "Skill (.md)", extensions: ["md"] }] });
    if (typeof sel !== "string") return;
    setImporting(true); setImportMsg(null);
    try {
      const info = await skillsImportMd(cwd, sel);
      await loadSkills();
      setSkills((s) => [...new Set([...s, info.name])]);
      setImportMsg(`✓ + ${info.name}`);
    } catch (e) { setImportMsg(`✗ ${String(e)}`); }
    finally { setImporting(false); }
  }

  // Importa todos os SKILL.md de um repo GitHub (público dispensa token).
  async function importGithub() {
    if (!cwd) { setImportMsg(t("roleEdit.openProjectFirst", "abra um projeto primeiro")); return; }
    const url = window.prompt(t("roleEdit.githubRepoPrompt", "URL do repo GitHub com SKILL.md (ex.: github.com/owner/repo):"));
    if (!url?.trim()) return;
    setImporting(true); setImportMsg(null);
    try {
      const token = loadGitProviders().find((p) => p.kind === "github")?.token;
      const infos = await skillsImportGithub(cwd, url.trim(), token);
      await loadSkills();
      setSkills((s) => [...new Set([...s, ...infos.map((i) => i.name)])]);
      setImportMsg(`✓ + ${infos.length} ${t("roleEdit.skillsFromGithub", "skill(s) do GitHub")}`);
    } catch (e) { setImportMsg(`✗ ${String(e)}`); }
    finally { setImporting(false); }
  }

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="w-[560px] max-w-[92vw] max-h-[90vh] rounded-lg border border-border bg-surface1 shadow-2xl flex flex-col" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center gap-2 px-4 py-2.5 border-b border-border shrink-0">
          <span className="text-sm font-medium text-text flex-1">
            {role.builtin ? `${t("roleEdit.editRole", "Editar role")} · ${role.name}` : role.name ? t("roleEdit.editRole", "Editar role") : t("roleEdit.newRole", "Novo role")}
          </span>
          <button onClick={onClose} className="text-textMuted hover:text-text" title={t("common.close", "Fechar")}>
            <X size={16} />
          </button>
        </header>
        <div className="p-4 space-y-3 overflow-auto">
          <div>
            <label className="text-[11px] uppercase tracking-wider text-textMuted">{t("roleEdit.name", "Nome")}</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("roleEdit.namePlaceholder", "ex: DevOps")}
              className="mt-1 w-full px-2 py-1.5 rounded-md text-sm bg-bg border border-border text-text focus:outline-none focus:border-brand"
            />
          </div>
          <div>
            <label className="text-[11px] uppercase tracking-wider text-textMuted">CLI / LLM</label>
            <select
              value={cli}
              onChange={(e) => setCli(e.target.value)}
              className="mt-1 w-full px-2 py-1.5 rounded-md text-sm bg-bg border border-border text-text focus:outline-none focus:border-brand"
            >
              {ROLE_CLIS.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-[11px] uppercase tracking-wider text-textMuted">{t("roleEdit.tokenCompressor", "Compressor de token")}</label>
            <select
              value={compressor}
              onChange={(e) => setCompressor(e.target.value)}
              className="mt-1 w-full px-2 py-1.5 rounded-md text-sm bg-bg border border-border text-text focus:outline-none focus:border-brand"
            >
              <option value="none">{t("roleEdit.none", "Nenhum")}</option>
              <option value="rtk">{t("roleEdit.rtkOption", "RTK · Rust Token Killer (saída de comando)")}</option>
              <option value="headroom">{t("roleEdit.headroomOption", "Headroom (chamada ao LLM)")}</option>
            </select>
            <p className="mt-1 text-[10px] text-textMuted opacity-60">
              {t("roleEdit.compressorHint", "Aplicado só via env no spawn (não toca command/args). Instale-o em Ferramentas → Compressores.")}
            </p>
          </div>
          {isShell && (
            <div>
              <label className="text-[11px] uppercase tracking-wider text-textMuted">{t("roleEdit.startupCmd", "Comando ao abrir (opcional)")}</label>
              <input
                value={startupCmd}
                onChange={(e) => setStartupCmd(e.target.value)}
                placeholder={t("roleEdit.startupCmdPlaceholder", "ex: npm run dev")}
                className="mt-1 w-full px-2 py-1.5 rounded-md text-xs bg-bg border border-border text-text focus:outline-none focus:border-brand font-mono"
              />
              <p className="mt-1 text-[10px] text-textMuted opacity-60">
                {t("roleEdit.startupCmdHint", "Roda ao abrir. Se for um CLI Claude (ex.: claude-ollama), a persona abaixo entra nativa via --append-system-prompt.")}
              </p>
            </div>
          )}
          {isShell && (
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={selfSystemPrompt}
                onChange={(e) => setSelfSystemPrompt(e.target.checked)}
                className="mt-0.5 accent-brand"
              />
              <span className="text-xs text-text">
                {t("roleEdit.selfSystemPrompt", "Este comando injeta o próprio system-prompt")}
                <span className="block text-[10px] text-textMuted opacity-60">
                  {t("roleEdit.selfSystemPromptHint", "Marque pra wrappers de Claude (ex.: claude-ollama) que já passam --append-system-prompt(-file). O OmniRift não anexa o seu — a persona vai como 1ª mensagem. Evita o erro \"Cannot use both --append-system-prompt and --append-system-prompt-file\".")}
                </span>
              </span>
            </label>
          )}
          <div>
            <label className="text-[11px] uppercase tracking-wider text-textMuted">
              {isShell ? t("roleEdit.personaLabel", "Persona (injetada no CLI que o comando abrir)") : t("roleEdit.promptLabel", "Prompt (persona / instruções)")}
            </label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={7}
              placeholder={t("roleEdit.promptPlaceholder", "Você é um especialista em… Foque em…")}
              className="mt-1 w-full px-2 py-1.5 rounded-md text-xs bg-bg border border-border text-text resize-y focus:outline-none focus:border-brand font-mono"
            />
            <p className="mt-1 text-[10px] text-textMuted opacity-60">
              {isShell
                ? t("roleEdit.personaHint", "CLI Claude (claude-ollama): vai nativa via --append-system-prompt. Sem comando de início, é ignorada.")
                : t("roleEdit.promptHint", "Injetado como --append-system-prompt num Claude Code.")}
            </p>
          </div>
          {/* Skills curadas → injetadas na persona no spawn (#13/#14). */}
          <div>
            <div className="flex items-center gap-1.5">
              <Sparkles size={12} className="text-brand" />
              <label className="text-[11px] uppercase tracking-wider text-textMuted">{t("roleEdit.agentSkills", "Skills do agente")}</label>
              {skills.length > 0 && <span className="text-[10px] text-brand">{skills.length} {t("roleEdit.selectedCount", "selecionada(s)")}</span>}
              <div className="flex-1" />
              <button
                onClick={() => void importMd()}
                disabled={!cwd || importing}
                title={t("roleEdit.importMdTitle", "Importar uma skill de um arquivo .md")}
                className="flex items-center gap-1 text-[10px] text-textMuted hover:text-brand disabled:opacity-40"
              >
                <FileUp size={12} /> .md
              </button>
              <button
                onClick={() => void importGithub()}
                disabled={!cwd || importing}
                title={t("roleEdit.importGithubTitle", "Importar skills de um repositório GitHub")}
                className="flex items-center gap-1 text-[10px] text-textMuted hover:text-brand disabled:opacity-40"
              >
                <Download size={12} /> GitHub
              </button>
            </div>
            {importMsg && (
              <p className={`text-[10px] ${importMsg.startsWith("✓") ? "text-green-400" : "text-danger"}`}>{importMsg}</p>
            )}
            {available.length === 0 ? (
              <p className="mt-1 text-[10px] text-textMuted opacity-60">
                {cwd
                  ? t("roleEdit.noSkills", "Nenhuma skill em .claude/skills (projeto) nem em ~/.claude/skills.")
                  : t("roleEdit.openProjectToList", "Abra um projeto pra listar as skills de .claude/skills.")}
              </p>
            ) : (
              <div className="mt-1 max-h-36 overflow-auto rounded-md border border-border divide-y divide-border/40">
                {available.map((s) => (
                  <label key={`${s.source}:${s.name}`} className="flex items-start gap-2 px-2 py-1.5 hover:bg-surface2 cursor-pointer">
                    <input type="checkbox" checked={skills.includes(s.name)} onChange={() => toggleSkill(s.name)} className="mt-0.5" />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="text-[12px] text-text font-medium">{s.name}</span>
                        <span className="text-[8px] uppercase px-1 rounded bg-surface2 text-textMuted">{s.source === "project" ? t("roleEdit.sourceProject", "projeto") : t("roleEdit.sourceGlobal", "global")}</span>
                      </span>
                      {s.description && <span className="block text-[10px] text-textMuted opacity-70 truncate">{s.description}</span>}
                    </span>
                  </label>
                ))}
              </div>
            )}
            <p className="mt-1 text-[10px] text-textMuted opacity-60">{t("roleEdit.skillsFooter", "As marcadas entram na persona do agente no spawn (ele prioriza usá-las).")}</p>
          </div>
        </div>
        <footer className="flex justify-end gap-2 px-4 py-3 border-t border-border shrink-0">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-md text-xs text-textMuted hover:bg-surface2 transition-colors"
          >
            {t("common.cancel", "Cancelar")}
          </button>
          <button
            onClick={() => onSave(name.trim() || "Role", prompt, cli, startupCmd, skills, compressor, selfSystemPrompt)}
            disabled={!isShell && !prompt.trim()}
            className="px-3 py-1.5 rounded-md text-xs bg-brand text-bg hover:bg-brand-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {t("common.save", "Salvar")}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
