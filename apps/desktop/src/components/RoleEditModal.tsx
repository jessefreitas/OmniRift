// src/components/RoleEditModal.tsx
//
// Modal pra editar/criar um role de agente (nome + prompt). Usado pela biblioteca
// de Roles na sidebar. Renderiza em portal no body.

import { useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

import { ROLE_CLIS, type AgentRoleDef } from "@/lib/agent-roles";

interface Props {
  role: AgentRoleDef;
  onSave: (name: string, prompt: string, cli: string, startupCmd: string) => void;
  onClose: () => void;
}

export function RoleEditModal({ role, onSave, onClose }: Props) {
  const [name, setName] = useState(role.name);
  const [prompt, setPrompt] = useState(role.prompt);
  const [cli, setCli] = useState(role.cli ?? "claude");
  const [startupCmd, setStartupCmd] = useState(role.startupCmd ?? "");
  const isShell = cli === "shell";

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="w-[560px] max-w-[92vw] rounded-lg border border-border bg-surface1 shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-2 px-4 py-2.5 border-b border-border">
          <span className="text-sm font-medium text-text flex-1">
            {role.builtin ? `Editar role · ${role.name}` : role.name ? "Editar role" : "Novo role"}
          </span>
          <button onClick={onClose} className="text-textMuted hover:text-text" title="Fechar">
            <X size={16} />
          </button>
        </header>
        <div className="p-4 space-y-3">
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
                Shell é terminal puro (sem LLM/persona). O comando roda ao abrir o terminal.
              </p>
            </div>
          )}
          {!isShell && (
          <div>
            <label className="text-[11px] uppercase tracking-wider text-textMuted">
              Prompt (persona / instruções)
            </label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={8}
              placeholder="Você é um especialista em… Foque em…"
              className="mt-1 w-full px-2 py-1.5 rounded-md text-xs bg-bg border border-border text-text resize-y focus:outline-none focus:border-brand font-mono"
            />
            <p className="mt-1 text-[10px] text-textMuted opacity-60">
              Injetado como <code>--append-system-prompt</code> num Claude Code.
            </p>
          </div>
          )}
        </div>
        <footer className="flex justify-end gap-2 px-4 py-3 border-t border-border">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-md text-xs text-textMuted hover:bg-surface2 transition-colors"
          >
            Cancelar
          </button>
          <button
            onClick={() => onSave(name.trim() || "Role", prompt, cli, startupCmd)}
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
