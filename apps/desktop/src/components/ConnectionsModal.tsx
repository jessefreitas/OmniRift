// src/components/ConnectionsModal.tsx
//
// Área de Conexões (Fase 1b) — gerencia os providers de memória plugáveis.
// Adiciona/testa/alterna OmniMemory / Local / Obsidian. O provider ativo aqui é
// o que injeta nos agentes (Brain Connect) e o que as views consultam.

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { BadgeCheck, Brain, Database, FileText, Plug, RefreshCw, X } from "lucide-react";

import {
  providersList,
  providerActive,
  providerConnect,
  providerTest,
  providerSetActive,
  type ConnectionConfig,
  type ProviderHealth,
  type ProviderKind,
} from "@/lib/providers-client";
import { cn } from "@/lib/cn";

interface Props {
  onClose: () => void;
}

export function ConnectionsModal({ onClose }: Props) {
  const [conns, setConns] = useState<ConnectionConfig[]>([]);
  const [active, setActive] = useState<ProviderKind | null>(null);
  const [omniEndpoint, setOmniEndpoint] = useState("");
  const [omniToken, setOmniToken] = useState("");
  const [health, setHealth] = useState<Record<string, ProviderHealth>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const [list, act] = await Promise.all([providersList(), providerActive()]);
      setConns(list);
      setActive(act);
      const omni = list.find((c) => c.kind === "omnimemory");
      if (omni?.endpoint) setOmniEndpoint(omni.endpoint);
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => { void load(); }, []);

  const configured = (k: ProviderKind) => conns.some((c) => c.kind === k);

  async function test(kind: ProviderKind) {
    setBusy(`test:${kind}`);
    try {
      const h = await providerTest(kind);
      setHealth((prev) => ({ ...prev, [kind]: h }));
    } catch (e) {
      setHealth((prev) => ({ ...prev, [kind]: { ok: false, detail: String(e) } }));
    } finally {
      setBusy(null);
    }
  }

  async function activate(kind: ProviderKind) {
    setBusy(`active:${kind}`);
    setError(null);
    try {
      await providerSetActive(kind);
      setActive(kind);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function connectOmni() {
    setBusy("connect:omnimemory");
    setError(null);
    try {
      const ep = omniEndpoint.trim();
      await providerConnect({ kind: "omnimemory", endpoint: ep, token: omniToken.trim() });
      setOmniToken("");
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  function HealthLine({ kind }: { kind: ProviderKind }) {
    const h = health[kind];
    if (busy === `test:${kind}`) return <span className="text-[11px] text-textMuted">testando…</span>;
    if (!h) return null;
    return (
      <span className={cn("text-[11px]", h.ok ? "text-green-400" : "text-danger")}>
        {h.ok ? "✓" : "✗"} {h.detail}
      </span>
    );
  }

  function ActiveBadge({ kind }: { kind: ProviderKind }) {
    if (active !== kind) return null;
    return (
      <span className="flex items-center gap-1 text-[10px] text-brand bg-brand/15 px-1.5 py-0.5 rounded">
        <BadgeCheck size={11} /> ativo
      </span>
    );
  }

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="w-[640px] max-w-[94vw] max-h-[88vh] rounded-lg border border-border bg-surface1 shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-2 px-4 py-2.5 border-b border-border shrink-0">
          <Plug size={15} className="text-brand" />
          <span className="text-sm font-medium text-text flex-1">Memória — Conexões</span>
          <button onClick={() => void load()} title="Recarregar" className="text-textMuted hover:text-brand p-1">
            <RefreshCw size={14} />
          </button>
          <button onClick={onClose} className="text-textMuted hover:text-text p-1" title="Fechar">
            <X size={16} />
          </button>
        </header>

        {error && (
          <p className="px-4 py-2 text-[11px] text-danger border-b border-border break-words">{error}</p>
        )}

        <div className="flex-1 overflow-auto p-3 space-y-3">
          {/* Local */}
          <div className="rounded-md border border-border bg-bg/40 p-3">
            <div className="flex items-center gap-2 mb-1">
              <Database size={14} className="text-brand" />
              <span className="text-sm text-text font-medium flex-1">Local (SQLite)</span>
              <ActiveBadge kind="local" />
            </div>
            <p className="text-[11px] text-textMuted mb-2">Blackboard offline, zero-config — o default. Sempre disponível.</p>
            <div className="flex items-center gap-2">
              <button onClick={() => void activate("local")} disabled={active === "local"} className="px-2.5 py-1 rounded text-[11px] bg-brand text-bg hover:bg-brand-hover disabled:opacity-40 transition-colors">Usar</button>
              <button onClick={() => void test("local")} className="px-2.5 py-1 rounded text-[11px] bg-surface2 text-text hover:text-brand border border-border">Testar</button>
              <HealthLine kind="local" />
            </div>
          </div>

          {/* OmniMemory */}
          <div className="rounded-md border border-border bg-bg/40 p-3">
            <div className="flex items-center gap-2 mb-1">
              <Brain size={14} className="text-brand" />
              <span className="text-sm text-text font-medium flex-1">OmniMemory</span>
              {configured("omnimemory") && <span className="text-[10px] text-green-400/70">configurado</span>}
              <ActiveBadge kind="omnimemory" />
            </div>
            <p className="text-[11px] text-textMuted mb-2">Cérebro remoto (entidades + relações tipadas). Token escopado, ofuscado em repouso.</p>
            <div className="space-y-1.5">
              <input
                value={omniEndpoint}
                onChange={(e) => setOmniEndpoint(e.target.value)}
                placeholder="https://memory.omnimemory.com.br/mcp"
                className="w-full px-2 py-1 rounded text-[11px] bg-bg border border-border text-text placeholder:text-textMuted focus:outline-none focus:border-brand font-mono"
              />
              <input
                value={omniToken}
                onChange={(e) => setOmniToken(e.target.value)}
                type="password"
                placeholder={configured("omnimemory") ? "token (re-digite p/ atualizar)" : "token escopado"}
                className="w-full px-2 py-1 rounded text-[11px] bg-bg border border-border text-text placeholder:text-textMuted focus:outline-none focus:border-brand font-mono"
              />
            </div>
            <div className="flex items-center gap-2 mt-2">
              <button
                onClick={() => void connectOmni()}
                disabled={busy === "connect:omnimemory" || !omniEndpoint.trim() || !omniToken.trim()}
                className="px-2.5 py-1 rounded text-[11px] bg-brand text-bg hover:bg-brand-hover disabled:opacity-40 transition-colors"
              >
                {busy === "connect:omnimemory" ? "salvando…" : "Conectar"}
              </button>
              <button onClick={() => void test("omnimemory")} disabled={!configured("omnimemory")} className="px-2.5 py-1 rounded text-[11px] bg-surface2 text-text hover:text-brand border border-border disabled:opacity-40">Testar</button>
              <button onClick={() => void activate("omnimemory")} disabled={!configured("omnimemory") || active === "omnimemory"} className="px-2.5 py-1 rounded text-[11px] bg-surface2 text-text hover:text-brand border border-border disabled:opacity-40">Usar</button>
              <HealthLine kind="omnimemory" />
            </div>
          </div>

          {/* Obsidian — Fase 1c */}
          <div className="rounded-md border border-border bg-bg/40 p-3 opacity-60">
            <div className="flex items-center gap-2 mb-1">
              <FileText size={14} className="text-textMuted" />
              <span className="text-sm text-text font-medium flex-1">Obsidian</span>
              <span className="text-[10px] text-textMuted">em breve · Fase 1c</span>
            </div>
            <p className="text-[11px] text-textMuted">Vault local (notas + <code>[[links]]</code>). Provider ainda não implementado — cai no Local.</p>
          </div>
        </div>

        <footer className="px-4 py-2 border-t border-border text-[10px] text-textMuted opacity-60 shrink-0">
          O provider <b>ativo</b> é injetado nos agentes claude (Brain Connect) e consultado pelas tools de memória.
        </footer>
      </div>
    </div>,
    document.body,
  );
}
