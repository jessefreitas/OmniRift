// src/components/McpServersModal.tsx
//
// MCP Servers (tools) — registra MCPs custom (Postgres/GitHub/filesystem/…) que
// o agent_mcp_config mescla nos agentes claude. Liga/desliga por servidor.
// É DIFERENTE de "MCP Agents" (que registra terminais como alvos de dispatch).

import { useEffect, useState } from "react";
import { SafeInput, SafeTextarea } from "@/components/SafeInput";
import { createPortal } from "react-dom";
import { Plus, Server, Trash2, X } from "lucide-react";

import {
  mcpServersList,
  mcpServerUpsert,
  mcpServerRemove,
  mcpServerSetEnabled,
  mcpServersImportGlobal,
  specSummary,
  MCP_PRESETS,
  type McpServerEntry,
  type McpPreset,
} from "@/lib/mcp-servers-client";
import { cn } from "@/lib/cn";
import { useT } from "@/lib/i18n";

interface Props {
  onClose: () => void;
}

const DEFAULTS = "Serena · Context7 · Playwright + memória ativa";

export function McpServersModal({ onClose }: Props) {
  const t = useT();
  const [servers, setServers] = useState<McpServerEntry[]>([]);
  const [picked, setPicked] = useState<McpPreset | "custom" | null>(null);
  const [param, setParam] = useState("");
  const [customName, setCustomName] = useState("");
  const [customJson, setCustomJson] = useState("");
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    try { setServers(await mcpServersList()); } catch (e) { setErr(String(e)); }
  }
  useEffect(() => {
    let mounted = true;
    async function run() {
      try { 
        const list = await mcpServersList();
        if (!mounted) return;
        setServers(list);
      } catch (e) { 
        if (!mounted) return;
        setErr(String(e)); 
      }
    }
    void run();
    return () => { mounted = false; };
  }, []);

  function reset() {
    setPicked(null); setParam(""); setCustomName(""); setCustomJson(""); setErr(null);
  }

  async function addPreset(p: McpPreset) {
    setErr(null);
    if (p.paramLabel && !param.trim()) { setErr(`${t("mcpServers.fillIn", "Preencha")}: ${p.paramLabel}`); return; }
    try {
      await mcpServerUpsert(p.name, p.build(param.trim()), true);
      await load(); reset();
    } catch (e) { setErr(String(e)); }
  }

  async function addCustom() {
    setErr(null);
    const name = customName.trim();
    if (!name) { setErr(t("mcpServers.nameRequired", "Nome obrigatório.")); return; }
    let spec: Record<string, unknown>;
    try { spec = JSON.parse(customJson); } catch { setErr(t("mcpServers.invalidJson", "JSON inválido.")); return; }
    if (typeof spec !== "object" || spec === null || Array.isArray(spec)) { setErr(t("mcpServers.specMustBeObject", "O spec deve ser um objeto JSON.")); return; }
    try {
      await mcpServerUpsert(name, spec, true);
      await load(); reset();
    } catch (e) { setErr(String(e)); }
  }

  async function toggle(s: McpServerEntry) {
    try { await mcpServerSetEnabled(s.name, !s.enabled); await load(); } catch (e) { setErr(String(e)); }
  }
  // Importa os MCPs do Claude global como DESLIGADOS (o spawn usa --strict-mcp-config
  // e não herda mais o ~/.claude.json — aqui o usuário reativa o que quiser).
  const [importMsg, setImportMsg] = useState<string | null>(null);
  async function importGlobal() {
    setErr(null);
    try {
      const n = await mcpServersImportGlobal();
      setImportMsg(n > 0
        ? t("mcpServers.importedN", "Importados (desligados): ") + n
        : t("mcpServers.importedNone", "Nada novo pra importar."));
      await load();
    } catch (e) { setErr(String(e)); }
  }
  async function remove(name: string) {
    try { await mcpServerRemove(name); await load(); } catch (e) { setErr(String(e)); }
  }

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="w-[680px] max-w-[94vw] max-h-[88vh] rounded-lg border border-border bg-surface1 shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-2 px-4 py-2.5 border-b border-border shrink-0">
          <Server size={15} className="text-brand" />
          <span className="text-sm font-medium text-text flex-1">{t("mcpServers.title", "MCP Servers (tools dos agentes)")}</span>
          <button onClick={onClose} className="text-textMuted hover:text-text p-1" title={t("common.close", "Fechar")}><X size={16} /></button>
        </header>

        {err && <p className="px-4 py-1.5 text-[11px] text-danger border-b border-border break-words shrink-0">{err}</p>}

        <div className="flex-1 overflow-auto p-3 space-y-3">
          <p className="text-[11px] text-textMuted">
            {t("mcpServers.introBefore", "Todo agente Claude já nasce com")} <b>{t("mcpServers.defaults", DEFAULTS)}</b>. {t("mcpServers.introAfter", "Aqui você adiciona MCPs extras — ligados ou desligados por servidor.")} <span className="opacity-70">{t("mcpServers.introNote", "Quanto mais MCP, mais processos por agente e mais tools pro modelo: mantenha enxuto.")}</span>
          </p>

          {/* Import do Claude global: o spawn não herda mais o ~/.claude.json (strict). */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => void importGlobal()}
              className="flex items-center gap-1 px-2.5 py-1 rounded text-[11px] border border-border text-textMuted hover:text-brand hover:border-brand/50 transition-colors"
              title={t("mcpServers.importGlobalTip", "Lê os mcpServers do ~/.claude.json e ~/.claude/settings.json e adiciona aqui DESLIGADOS — você liga só o que quiser (os agentes não herdam mais o global automaticamente)")}
            >
              <Plus size={12} /> {t("mcpServers.importGlobal", "Importar do Claude global")}
            </button>
            {importMsg && <span className="text-[11px] text-textMuted">{importMsg}</span>}
          </div>

          {/* Lista */}
          {servers.length === 0 ? (
            <p className="px-1 py-2 text-[12px] text-textMuted opacity-60">{t("mcpServers.emptyCustom", "Nenhum MCP custom ainda.")}</p>
          ) : (
            servers.map((s) => (
              <div key={s.name} className="flex items-center gap-2 rounded-md border border-border bg-bg/40 p-2.5">
                <label className="flex items-center gap-1.5 shrink-0" title={s.enabled ? t("mcpServers.enabled", "Ligado") : t("mcpServers.disabled", "Desligado")}>
                  <input type="checkbox" checked={s.enabled} onChange={() => void toggle(s)} />
                </label>
                <div className="min-w-0 flex-1">
                  <div className={cn("text-[12px] font-medium truncate", s.enabled ? "text-text" : "text-textMuted")}>{s.name}</div>
                  <div className="text-[10px] text-textMuted opacity-70 truncate font-mono">{specSummary(s.spec)}</div>
                </div>
                <button onClick={() => void remove(s.name)} title={t("common.remove", "Remover")} className="text-textMuted hover:text-danger p-1 shrink-0"><Trash2 size={13} /></button>
              </div>
            ))
          )}

          {/* Adicionar */}
          <div className="rounded-md border border-brand/40 bg-brand/5 p-2.5 space-y-2">
            <span className="text-[12px] font-medium text-text">{t("common.add", "Adicionar")}</span>
            <div className="flex flex-wrap gap-1.5">
              {MCP_PRESETS.map((p) => (
                <button
                  key={p.id}
                  onClick={() => { setPicked(p); setParam(""); setErr(null); }}
                  title={p.desc}
                  className={cn("px-2 py-1 rounded text-[11px] border transition-colors",
                    picked !== "custom" && picked?.id === p.id ? "border-brand text-brand bg-brand/10" : "border-border text-textMuted hover:text-text")}
                >
                  {p.label}
                </button>
              ))}
              <button
                onClick={() => { setPicked("custom"); setErr(null); }}
                className={cn("px-2 py-1 rounded text-[11px] border transition-colors",
                  picked === "custom" ? "border-brand text-brand bg-brand/10" : "border-border text-textMuted hover:text-text")}
              >
                {t("mcpServers.custom", "Custom")}
              </button>
            </div>

            {picked && picked !== "custom" && (
              <div className="space-y-1.5">
                <p className="text-[10px] text-textMuted">{picked.desc}</p>
                {picked.paramLabel && (
                  <SafeInput
                    value={param}
                    onChange={(e) => setParam(e.target.value)}
                    type={picked.secret ? "password" : "text"}
                    placeholder={picked.paramLabel}
                    className="w-full px-2 py-1 rounded text-[11px] bg-bg border border-border text-text placeholder:text-textMuted focus:outline-none focus:border-brand font-mono"
                  />
                )}
                <button onClick={() => void addPreset(picked)} className="flex items-center gap-1 px-2.5 py-1 rounded text-[11px] bg-brand text-bg hover:bg-brand-hover">
                  <Plus size={12} /> {t("common.add", "Adicionar")} {picked.label}
                </button>
              </div>
            )}

            {picked === "custom" && (
              <div className="space-y-1.5">
                <SafeInput
                  value={customName}
                  onChange={(e) => setCustomName(e.target.value)}
                  placeholder={t("mcpServers.customNamePlaceholder", "nome (chave do mcpServers, ex: meu-mcp)")}
                  className="w-full px-2 py-1 rounded text-[11px] bg-bg border border-border text-text placeholder:text-textMuted focus:outline-none focus:border-brand font-mono"
                />
                <SafeTextarea
                  value={customJson}
                  onChange={(e) => setCustomJson(e.target.value)}
                  placeholder={t("mcpServers.customJsonPlaceholder", '{ "command": "npx", "args": ["-y", "pacote"], "env": { "TOKEN": "..." } }\nou { "type": "http", "url": "https://...", "headers": { "Authorization": "Bearer ..." } }')}
                  rows={4}
                  className="w-full px-2 py-1.5 rounded text-[11px] bg-bg border border-border text-text placeholder:text-textMuted focus:outline-none focus:border-brand font-mono resize-none"
                />
                <button onClick={() => void addCustom()} className="flex items-center gap-1 px-2.5 py-1 rounded text-[11px] bg-brand text-bg hover:bg-brand-hover">
                  <Plus size={12} /> {t("mcpServers.addCustom", "Adicionar custom")}
                </button>
              </div>
            )}
          </div>
        </div>

        <footer className="px-4 py-2 border-t border-border text-[10px] text-textMuted opacity-60 shrink-0">
          {t("mcpServers.footerBefore", "Os MCPs")} <b>{t("mcpServers.footerEnabled", "ligados")}</b> {t("mcpServers.footerAfter", "são injetados em todo agente Claude (merge no agent-mcp.json). Tokens são ofuscados em repouso.")}
        </footer>
      </div>
    </div>,
    document.body,
  );
}
