// src/components/Sidebar.tsx
//
// Barra lateral esquerda — onde o usuário spawna novos terminais.
// Em Fase 3 isso vira "Roles": presets reutilizáveis com instruções salvas.

import {
  Bot,
  Code2,
  Plus,
  Sparkles,
  TerminalSquare,
} from "lucide-react";

import { useCanvasStore } from "@/store/canvas-store";
import { cn } from "@/lib/cn";
import type { AgentRole } from "@/types/pty";

interface AgentPreset {
  id: string;
  label: string;
  command: string;
  role: AgentRole;
  icon: typeof Bot;
  description: string;
}

const PRESETS: AgentPreset[] = [
  {
    id: "shell",
    label: "Shell",
    command: detectShell(),
    role: "shell",
    icon: TerminalSquare,
    description: "Terminal puro do sistema",
  },
  {
    id: "claude",
    label: "Claude Code",
    command: "claude",
    role: "claude-code",
    icon: Sparkles,
    description: "Anthropic Claude Code CLI",
  },
  {
    id: "codex",
    label: "Codex",
    command: "codex",
    role: "codex",
    icon: Code2,
    description: "OpenAI Codex CLI",
  },
  {
    id: "opencode",
    label: "OpenCode",
    command: "opencode",
    role: "opencode",
    icon: Bot,
    description: "OpenCode (sst.dev)",
  },
];

/** Detecta o shell padrão a partir do user-agent — feature-flag rudimentar.
 *  Em Fase 0.5 trocamos por um comando Tauri que lê $SHELL ou %ComSpec%. */
function detectShell(): string {
  if (typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent)) {
    return "powershell.exe";
  }
  return "bash";
}

export function Sidebar() {
  const addTerminal = useCanvasStore((s) => s.addTerminal);

  return (
    <aside
      className={cn(
        "flex flex-col w-60 shrink-0 border-r border-border bg-surface1",
        "text-text",
      )}
    >
      <header className="px-4 py-3 border-b border-border">
        <h1 className="text-sm font-medium flex items-center gap-2">
          <span className="inline-block w-2 h-2 rounded-full bg-brand" />
          Omni Canvas
        </h1>
        <p className="text-[11px] text-textMuted mt-0.5">
          Canvas infinito · OmniForge
        </p>
      </header>

      <section className="flex-1 overflow-y-auto px-2 py-3 space-y-1">
        <h2 className="px-2 text-[11px] uppercase tracking-wider text-textMuted mb-1">
          Novo agente
        </h2>

        {PRESETS.map((preset) => {
          const Icon = preset.icon;
          return (
            <button
              key={preset.id}
              onClick={() =>
                addTerminal({
                  command: preset.command,
                  role: preset.role,
                  label: preset.label,
                })
              }
              className={cn(
                "w-full text-left flex items-start gap-3 px-2 py-2 rounded-md",
                "hover:bg-surface2 transition-colors group",
              )}
            >
              <Icon
                size={16}
                className="mt-0.5 text-textMuted group-hover:text-brand transition-colors"
              />
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium truncate">
                  {preset.label}
                </div>
                <div className="text-[10px] text-textMuted truncate">
                  {preset.description}
                </div>
              </div>
              <Plus
                size={12}
                className="mt-1 text-textMuted opacity-0 group-hover:opacity-100 transition-opacity"
              />
            </button>
          );
        })}
      </section>

      <footer className="px-4 py-3 border-t border-border text-[10px] text-textMuted">
        Fase 1 — PTY + canvas
        <div className="opacity-70 mt-0.5">v0.1.0 · build local</div>
      </footer>
    </aside>
  );
}
