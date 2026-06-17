// src/components/RoleEditModal.tsx
//
// Modal pra editar/criar um role de agente (nome + CLI + skills + persona). Usado
// pela biblioteca de Roles na sidebar. As skills marcadas são curadas de
// .claude/skills e injetadas na persona do agente no spawn. Renderiza em portal.

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Sparkles, X } from "lucide-react";

import { ROLE_CLIS, type AgentRoleDef } from "@/lib/agent-roles";
import { skillsList, type SkillInfo } from "@/lib/skills-client";

interface Props {
  role: AgentRoleDef;
  /** cwd do projeto ativo — pra listar as skills de .claude/skills. */
  cwd?: string | null;
  onSave: (name: string, prompt: string, cli: string, startupCmd: string, skills: string[]) => void;
  onClose: () => void;
}

export function RoleEditModal({ role, cwd, onSave, onClose }: Props) {
  const [name, setName] = useState(role.name);
  const [prompt, setPrompt] = useState(role.prompt);
  const [cli, setCli] = useState(role.cli ?? "claude");
  const [startupCmd, setStartupCmd] = useState(role.startupCmd ?? "");
  const [skills, setSkills] = useState<string[]>(role.skills ?? []);
  const [available, setAvailable] = useState<SkillInfo[]>([]);
  const isShell = cli === "shell";

  useEffect(() => {
    if (!cwd) { setAvailable([]); return; }
    skillsList(cwd).then(setAvailable).catch(() => setAvailable([]));
  }, [cwd]);

  function toggleSkill(n: string) {
    setSkills((cur) => (cur.includes(n) ? cur.filter((x) => x !== n) : [...cur, n]));
  }

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="w-[560px] max-w-[92vw] max-h-[90vh] rounded-lg border border-border bg-surface1 shadow-2xl flex flex-col" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center gap-2 px-4 py-2.5 border-b border-border shrink-0">
          <span className="text-sm font-medium text-text flex-1">
            {role.builtin ? `Editar role · ${role.name}` : role.name ? "Editar role" : "Novo role"}
          </span>
          <button onClick={onClose} className="text-textMuted hover:text-text" title="Fechar">
            <X size={16} />
          </button>
        </header>
        <div className="p-4 space-y-3 overflow-auto">
          <div>
            <label className="text-[11px] uppercase tracking-wider text-textMuted">Nome</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="ex: DevOps"
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
          {isShell && (
            <div>
              <label className="text-[11px] uppercase tracking-wider text-textMuted">Comando ao abrir (opcional)</label>
              <input
                value={startupCmd}
                onChange={(e) => setStartupCmd(e.target.value)}
                placeholder="ex: npm run dev"
                className="mt-1 w-full px-2 py-1.5 rounded-md text-xs bg-bg border border-border text-text focus:outline-none focus:border-brand font-mono"
              />
              <p className="mt-1 text-[10px] text-textMuted opacity-60">
                Roda ao abrir. Se for um CLI Claude (ex.: claude-ollama), a persona abaixo entra nativa via --append-system-prompt.
              </p>
            </div>
          )}
          <div>
            <label className="text-[11px] uppercase tracking-wider text-textMuted">
              {isShell ? "Persona (injetada no CLI que o comando abrir)" : "Prompt (persona / instruções)"}
            </label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={7}
              placeholder="Você é um especialista em… Foque em…"
              className="mt-1 w-full px-2 py-1.5 rounded-md text-xs bg-bg border border-border text-text resize-y focus:outline-none focus:border-brand font-mono"
            />
            <p className="mt-1 text-[10px] text-textMuted opacity-60">
              {isShell
                ? "CLI Claude (claude-ollama): vai nativa via --append-system-prompt. Sem comando de início, é ignorada."
                : "Injetado como --append-system-prompt num Claude Code."}
            </p>
          </div>
          {/* Skills curadas → injetadas na persona no spawn (#13/#14). */}
          <div>
            <div className="flex items-center gap-1.5">
              <Sparkles size={12} className="text-brand" />
              <label className="text-[11px] uppercase tracking-wider text-textMuted">Skills do agente</label>
              {skills.length > 0 && <span className="text-[10px] text-brand">{skills.length} selecionada(s)</span>}
            </div>
            {available.length === 0 ? (
              <p className="mt-1 text-[10px] text-textMuted opacity-60">
                {cwd
                  ? "Nenhuma skill em .claude/skills (projeto) nem em ~/.claude/skills."
                  : "Abra um projeto pra listar as skills de .claude/skills."}
              </p>
            ) : (
              <div className="mt-1 max-h-36 overflow-auto rounded-md border border-border divide-y divide-border/40">
                {available.map((s) => (
                  <label key={`${s.source}:${s.name}`} className="flex items-start gap-2 px-2 py-1.5 hover:bg-surface2 cursor-pointer">
                    <input type="checkbox" checked={skills.includes(s.name)} onChange={() => toggleSkill(s.name)} className="mt-0.5" />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="text-[12px] text-text font-medium">{s.name}</span>
                        <span className="text-[8px] uppercase px-1 rounded bg-surface2 text-textMuted">{s.source === "project" ? "projeto" : "global"}</span>
                      </span>
                      {s.description && <span className="block text-[10px] text-textMuted opacity-70 truncate">{s.description}</span>}
                    </span>
                  </label>
                ))}
              </div>
            )}
            <p className="mt-1 text-[10px] text-textMuted opacity-60">As marcadas entram na persona do agente no spawn (ele prioriza usá-las).</p>
          </div>
        </div>
        <footer className="flex justify-end gap-2 px-4 py-3 border-t border-border shrink-0">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-md text-xs text-textMuted hover:bg-surface2 transition-colors"
          >
            Cancelar
          </button>
          <button
            onClick={() => onSave(name.trim() || "Role", prompt, cli, startupCmd, skills)}
            disabled={!isShell && !prompt.trim()}
            className="px-3 py-1.5 rounded-md text-xs bg-brand text-bg hover:bg-brand-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Salvar
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
