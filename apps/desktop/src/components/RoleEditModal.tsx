// src/components/RoleEditModal.tsx
//
// Modal pra editar/criar um role de agente (nome + CLI + skills + persona). Usado
// pela biblioteca de Roles na sidebar. As skills marcadas são curadas de
// .claude/skills e injetadas na persona do agente no spawn. Renderiza em portal.

import { useCallback, useEffect, useState } from "react";
import { SafeInput, SafeTextarea } from "@/components/SafeInput";
import { createPortal } from "react-dom";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { Download, FileUp, Gauge, Sparkles, X } from "lucide-react";

import {
  ROLE_CLIS,
  matchPresetId,
  presetsForCli,
  type AgentRoleDef,
  type ImportedRole,
} from "@/lib/agent-roles";
import { skillsList, skillsImportMd, skillsImportGithub, type SkillInfo } from "@/lib/skills-client";
import { mcpInventory, type McpInventoryItem } from "@/lib/mcp-client";
import { githubToken } from "@/lib/git-providers";
import { isCompressorEnabled } from "@/lib/compress-client";
import { PromptModal } from "@/components/PromptModal";
import { useT } from "@/lib/i18n";

interface Props {
  role: AgentRoleDef;
  /** cwd do projeto ativo — pra listar as skills de .claude/skills. */
  cwd?: string | null;
  onSave: (name: string, prompt: string, cli: string, startupCmd: string, skills: string[], compressor: string, selfSystemPrompt: boolean, mcpServers?: string[]) => void;
  onClose: () => void;
}

export function RoleEditModal({ role, cwd, onSave, onClose }: Props) {
  const t = useT();
  const [name, setName] = useState(role.name);
  const [prompt, setPrompt] = useState(role.prompt);
  const [cli, setCli] = useState(role.cli ?? "claude");
  const [startupCmd, setStartupCmd] = useState(role.startupCmd ?? "");
  const [cmdPreset, setCmdPreset] = useState(() => matchPresetId(role.cli ?? "claude", role.startupCmd));
  const [skills, setSkills] = useState<string[]>(role.skills ?? []);
  const [skillQuery, setSkillQuery] = useState("");
  const [available, setAvailable] = useState<SkillInfo[]>([]);
  const [mcpInv, setMcpInv] = useState<McpInventoryItem[]>([]);
  // null = role sem curadoria de MCP (undefined no disco). Vira lista concreta quando
  // o inventário carrega (todos os disponíveis marcados = comportamento atual).
  const [mcpSel, setMcpSel] = useState<string[] | null>(role.mcpServers ?? null);
  const [compressor, setCompressor] = useState(role.compressor ?? "none");
  const [selfSystemPrompt, setSelfSystemPrompt] = useState(role.selfSystemPrompt ?? false);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  // window.prompt é no-op no WebKitGTK → modal próprio pra pedir a URL do repo.
  const [askGithub, setAskGithub] = useState(false);
  const isShell = cli === "shell";
  const cmdPresets = presetsForCli(cli);
  const isCustomCmd = isShell || cmdPreset === "custom";
  const omniOn = isCompressorEnabled("omnicompress"); // nativo, global (Ferramentas → Compressores)

  function onCliChange(nextCli: string) {
    setCli(nextCli);
    // Ao trocar o CLI, volta pro preset default desse CLI (não herda flags de outro).
    const presets = presetsForCli(nextCli);
    const def = presets.find((p) => p.id === "default") ?? presets[0];
    setCmdPreset(def?.id ?? "custom");
    setStartupCmd(def && def.id !== "custom" ? def.line : "");
    if (nextCli !== "shell") setSelfSystemPrompt(false);
  }

  function onCmdPresetChange(presetId: string) {
    setCmdPreset(presetId);
    if (presetId === "custom") return; // mantém o texto atual pra o user editar
    const p = cmdPresets.find((x) => x.id === presetId);
    setStartupCmd(p?.line ?? "");
  }

  const loadSkills = useCallback(async () => {
    if (!cwd) { setAvailable([]); return; }
    try { setAvailable(await skillsList(cwd)); } catch { setAvailable([]); }
  }, [cwd]);
  useEffect(() => { void loadSkills(); }, [loadSkills]);

  function toggleSkill(n: string) {
    setSkills((cur) => (cur.includes(n) ? cur.filter((x) => x !== n) : [...cur, n]));
  }

  // Inventário de MCP servers (+ custo de contexto) → seção MCP + medidor de budget.
  useEffect(() => {
    void mcpInventory()
      .then((inv) => {
        setMcpInv(inv);
        // Role sem curadoria → começa com TODOS os disponíveis marcados (= hoje).
        setMcpSel((cur) => cur ?? inv.filter((i) => i.available).map((i) => i.key));
      })
      .catch(() => setMcpInv([]));
  }, []);

  function toggleMcp(key: string) {
    setMcpSel((cur) => {
      const base = cur ?? mcpInv.filter((i) => i.available).map((i) => i.key);
      return base.includes(key) ? base.filter((k) => k !== key) : [...base, key];
    });
  }

  // Budget de contexto estimado (skills curadas + MCP selecionados) vs 200k.
  const SKILL_TOKENS = 150; // ~frontmatter de um SKILL.md carregado no contexto
  const mcpTokens = mcpInv
    .filter((i) => i.available && (mcpSel ?? []).includes(i.key))
    .reduce((sum, i) => sum + i.estTokens, 0);
  const budgetTokens = mcpTokens + skills.length * SKILL_TOKENS;
  const budgetPct = Math.min(100, Math.round((budgetTokens / 200000) * 100));
  const budgetColor =
    budgetTokens > 180000 ? "text-danger" : budgetTokens > 120000 ? "text-amber-400" : "text-green-400";
  const budgetBar =
    budgetTokens > 180000 ? "bg-danger" : budgetTokens > 120000 ? "bg-amber-400" : "bg-green-400";

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
  // Abre o modal de input (window.prompt não funciona no WebKitGTK).
  function importGithub() {
    if (!cwd) { setImportMsg(t("roleEdit.openProjectFirst", "abra um projeto primeiro")); return; }
    setAskGithub(true);
  }

  // Roda após o usuário confirmar a URL no PromptModal.
  async function importGithubSubmit(url: string) {
    setAskGithub(false);
    if (!cwd || !url.trim()) return;
    setImporting(true); setImportMsg(null);
    try {
      const token = await githubToken();
      const infos = await skillsImportGithub(cwd, url.trim(), token);
      await loadSkills();
      setSkills((s) => [...new Set([...s, ...infos.map((i) => i.name)])]);
      setImportMsg(`✓ + ${infos.length} ${t("roleEdit.skillsFromGithub", "skill(s) do GitHub")}`);
    } catch (e) { setImportMsg(`✗ ${String(e)}`); }
    finally { setImporting(false); }
  }

  // Importa um agente pronto (.toml Codex / .md Claude) e PRÉ-PREENCHE o form
  // (nome/cli/persona) — o usuário ajusta e salva. Reusa role_import_file (#1).
  async function importFromFile() {
    const sel = await openDialog({ multiple: false, filters: [{ name: t("roleEdit.agentFilter", "Agente (.toml/.md)"), extensions: ["toml", "md"] }] });
    if (typeof sel !== "string") return;
    setImporting(true); setImportMsg(null);
    try {
      const r = await invoke<ImportedRole>("role_import_file", { path: sel });
      setName(r.name); setCli(r.cli); setPrompt(r.prompt);
      setImportMsg(`✓ ${r.name} (${r.format})`);
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
          <button
            onClick={() => void importFromFile()}
            disabled={importing}
            title={t("roleEdit.importFromFile", "Importar de um arquivo (.toml Codex / .md Claude) — preenche o form")}
            className="flex items-center gap-1 text-[11px] text-textMuted hover:text-brand disabled:opacity-40"
          >
            <FileUp size={13} /> {t("roleEdit.fromFile", "de arquivo")}
          </button>
          <button onClick={onClose} className="text-textMuted hover:text-text" title={t("common.close", "Fechar")}>
            <X size={16} />
          </button>
        </header>
        <div className="p-4 space-y-3 overflow-auto">
          <div>
            <label className="text-[11px] uppercase tracking-wider text-textMuted">{t("roleEdit.name", "Nome")}</label>
            <SafeInput
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
              onChange={(e) => onCliChange(e.target.value)}
              className="mt-1 w-full px-2 py-1.5 rounded-md text-sm bg-bg border border-border text-text focus:outline-none focus:border-brand"
            >
              {ROLE_CLIS.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
            <p className="mt-1 text-[10px] text-textMuted opacity-60">
              {t(
                "roleEdit.cliHint",
                "Escolha o agente. Em seguida o comando (presets estilo Agent Grid, ou Custom).",
              )}
            </p>
          </div>
          <div>
            <label className="text-[11px] uppercase tracking-wider text-textMuted">
              {t("roleEdit.command", "Command")}
            </label>
            {!isShell && (
              <select
                value={cmdPreset}
                onChange={(e) => onCmdPresetChange(e.target.value)}
                className="mt-1 w-full px-2 py-1.5 rounded-md text-sm bg-bg border border-border text-text focus:outline-none focus:border-brand font-mono"
              >
                {cmdPresets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            )}
            {isCustomCmd && (
              <SafeInput
                value={startupCmd}
                onChange={(e) => {
                  setStartupCmd(e.target.value);
                  if (!isShell) setCmdPreset("custom");
                }}
                placeholder={
                  isShell
                    ? t("roleEdit.startupCmdPlaceholder", "ex: npm run dev")
                    : t(
                        "roleEdit.customCmdPlaceholder",
                        "ex: claude --dangerously-skip-permissions  ·  ou alias: claudefast",
                      )
                }
                className="mt-1.5 w-full px-2 py-1.5 rounded-md text-xs bg-bg border border-border text-text focus:outline-none focus:border-brand font-mono"
              />
            )}
            <p className="mt-1 text-[10px] text-textMuted opacity-60">
              {isShell
                ? t(
                    "roleEdit.startupCmdHint",
                    "Opcional. Roda ao abrir o shell. Wrappers Claude (alias/função no zsh) também funcionam.",
                  )
                : t(
                    "roleEdit.commandHint",
                    "Flags do CLI neste role. System-prompt/MCP do OmniRift são anexados automaticamente (exceto se marcar self system-prompt).",
                  )}
            </p>
          </div>
          {(isShell || cmdPreset === "custom") && (
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
                  {t(
                    "roleEdit.selfSystemPromptHint",
                    "Marque pra wrappers (ex.: claude-ollama) que já passam --append-system-prompt(-file). O OmniRift não anexa o seu — a persona vai como 1ª mensagem.",
                  )}
                </span>
              </span>
            </label>
          )}
          <div>
            <label className="text-[11px] uppercase tracking-wider text-textMuted">{t("roleEdit.tokenCompressor", "Compressor de token")}</label>
            <select
              value={compressor}
              onChange={(e) => setCompressor(e.target.value)}
              className="mt-1 w-full px-2 py-1.5 rounded-md text-sm bg-bg border border-border text-text focus:outline-none focus:border-brand"
            >
              <option value="none">{t("roleEdit.compressorNoneExtra", "Nenhum (extra)")}</option>
              <option value="rtk">{t("roleEdit.rtkOption", "RTK · Rust Token Killer (saída de comando)")}</option>
              <option value="headroom">{t("roleEdit.headroomOption", "Headroom (chamada ao LLM)")}</option>
            </select>
            <p className="mt-1 text-[10px] opacity-80">
              {omniOn ? (
                <span className="text-brand">● OmniCompress (nativo) ativo globalmente</span>
              ) : (
                <span className="text-textMuted">○ OmniCompress (nativo) desligado</span>
              )}
              <span className="text-textMuted">
                {omniOn
                  ? " — já cuida dos tokens em todo agente. Este campo é um compressor EXTRA por role."
                  : " — este campo escolhe um compressor por role."}
                {" "}Liga/desliga em Ferramentas → Compressores.
              </span>
            </p>
          </div>
          <div>
            <label className="text-[11px] uppercase tracking-wider text-textMuted">
              {isShell ? t("roleEdit.personaLabel", "Persona (injetada no CLI que o comando abrir)") : t("roleEdit.promptLabel", "Prompt (persona / instruções)")}
            </label>
            <SafeTextarea
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
              <>
                {available.length > 6 && (
                  <input
                    value={skillQuery}
                    onChange={(e) => setSkillQuery(e.target.value)}
                    placeholder={t("roleEdit.searchSkills", "buscar skill (nome ou descrição)…")}
                    className="mt-1 w-full rounded-md border border-border bg-bg px-2 py-1 text-[11px] text-text outline-none focus:border-brand"
                  />
                )}
                <div className="mt-1 max-h-36 overflow-auto rounded-md border border-border divide-y divide-border/40">
                  {available
                    .filter((s) => {
                      const q = skillQuery.trim().toLowerCase();
                      return !q || s.name.toLowerCase().includes(q) || (s.description ?? "").toLowerCase().includes(q);
                    })
                    .map((s) => (
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
              </>
            )}
            <p className="mt-1 text-[10px] text-textMuted opacity-60">{t("roleEdit.skillsFooter", "As marcadas entram na persona do agente no spawn (ele prioriza usá-las).")}</p>
          </div>
          {/* MCP servers do agente + medidor de budget de contexto (resolve o 200k). */}
          <div>
            <div className="flex items-center gap-1.5">
              <Gauge size={12} className="text-brand" />
              <label className="text-[11px] uppercase tracking-wider text-textMuted">{t("roleEdit.agentMcp", "MCP do agente · contexto")}</label>
              <div className="flex-1" />
              <span className={`text-[10px] font-semibold ${budgetColor}`}>≈ {(budgetTokens / 1000).toFixed(1)}k / 200k</span>
            </div>
            <div className="mt-1 h-1.5 w-full rounded-full bg-surface3 overflow-hidden">
              <div className={`h-full ${budgetBar} transition-all`} style={{ width: `${budgetPct}%` }} />
            </div>
            {mcpInv.length > 0 && (
              <div className="mt-1.5 max-h-40 overflow-auto rounded-md border border-border divide-y divide-border/40">
                {mcpInv.map((m) => {
                  const on = (mcpSel ?? []).includes(m.key) && m.available;
                  return (
                    <label key={m.key} className={`flex items-start gap-2 px-2 py-1.5 ${m.available ? "hover:bg-surface2 cursor-pointer" : "opacity-50 cursor-not-allowed"}`}>
                      <input type="checkbox" disabled={!m.available} checked={on} onChange={() => m.available && toggleMcp(m.key)} className="mt-0.5" />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          <span className="text-[12px] text-text font-medium truncate">{m.label}</span>
                          <span className="text-[8px] uppercase px-1 rounded bg-surface2 text-textMuted shrink-0">{m.source}</span>
                        </span>
                        <span className="block text-[10px] text-textMuted opacity-70">≈ {(m.estTokens / 1000).toFixed(1)}k tokens{m.available ? "" : ` · ${t("roleEdit.mcpNotInstalled", "não instalado")}`}</span>
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
            <p className="mt-1 text-[10px] text-textMuted opacity-60">{t("roleEdit.mcpFooter", "Desmarque o que este agente não precisa pra enxugar o contexto. omnimemory e playwright são os mais pesados.")}</p>
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
            onClick={() => {
              // Tudo marcado = sem curadoria → grava undefined (back-compat + future-proof).
              const allAvail = mcpInv.filter((i) => i.available).map((i) => i.key);
              const mcpToSave =
                mcpSel && allAvail.length && allAvail.every((k) => mcpSel.includes(k))
                  ? undefined
                  : mcpSel ?? undefined;
              onSave(name.trim() || "Role", prompt, cli, startupCmd, skills, compressor, selfSystemPrompt, mcpToSave);
            }}
            disabled={!isShell && !prompt.trim()}
            className="px-3 py-1.5 rounded-md text-xs bg-brand text-bg hover:bg-brand-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {t("common.save", "Salvar")}
          </button>
        </footer>
      </div>
      {askGithub && (
        <PromptModal
          title={t("roleEdit.githubRepoPrompt", "URL do repo GitHub com SKILL.md (ex.: github.com/owner/repo):")}
          placeholder="github.com/owner/repo"
          onSubmit={(v) => void importGithubSubmit(v)}
          onCancel={() => setAskGithub(false)}
        />
      )}
    </div>,
    document.body,
  );
}
