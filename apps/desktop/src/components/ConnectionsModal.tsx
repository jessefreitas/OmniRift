// src/components/ConnectionsModal.tsx
//
// Área de Conexões (Fase 1b) — gerencia os providers de memória plugáveis.
// Adiciona/testa/alterna OmniMemory / Local / Obsidian. O provider ativo aqui é
// o que injeta nos agentes (Brain Connect) e o que as views consultam.

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { BadgeCheck, Brain, Database, FileText, Plug, RefreshCw, Waypoints, X } from "lucide-react";

import {
  providersList,
  providerActive,
  providerConnect,
  providerTest,
  providerSetActive,
  memoryMigrate,
  memoryMigratePreview,
  type ConnectionConfig,
  type MigrateResult,
  type ProviderHealth,
  type ProviderKind,
} from "@/lib/providers-client";
import { cn } from "@/lib/cn";
import { useT } from "@/lib/i18n";
import { useCanvasStore } from "@/store/canvas-store";
import { validateOutputAgainstSchema } from "@/lib/response-schema";
import { notify } from "@/lib/notify";
import type { EdgeValidation } from "@/types/canvas";

/** Uma conexão "generic" (agente→agente) do paralelo ativo, achatada p/ a UI de schema. */
interface TypedEdgeRow {
  id: string;
  source: string;
  target: string;
  srcLabel: string;
  dstLabel: string;
  responseSchema: string;
  lastValidation?: EdgeValidation;
}

/** Uma linha editável: textarea do responseSchema + validação manual da última saída. */
function TypedConnectionRow({ edge }: { edge: TypedEdgeRow }) {
  const t = useT();
  const updateEdge = useCanvasStore((s) => s.updateEdge);
  const agentOutputs = useCanvasStore((s) => s.agentOutputs);
  const [draft, setDraft] = useState(edge.responseSchema);
  // Resync quando o store muda por fora (ex: outro editor, restore).
  useEffect(() => { setDraft(edge.responseSchema); }, [edge.responseSchema]);
  const dirty = draft !== edge.responseSchema;

  function save() { updateEdge(edge.id, { responseSchema: draft }); }

  function validateNow() {
    if (dirty) updateEdge(edge.id, { responseSchema: draft });
    if (!draft.trim()) {
      void notify(t("connections.typedNeedSchema", "Cole um schema (ou exemplo JSON) primeiro."), "info");
      return;
    }
    const out = agentOutputs[edge.source];
    if (!out) {
      void notify(t("connections.typedNoOutput", "Ainda não há saída registrada para a origem desta conexão."), "info");
      return;
    }
    const result = validateOutputAgainstSchema(out, draft);
    if (!result) {
      void notify(t("connections.typedFreeText", "Texto livre — cole um JSON Schema ou exemplo JSON para validar estruturalmente."), "info");
      return;
    }
    updateEdge(edge.id, { lastValidation: result });
    void notify(
      result.ok
        ? t("connections.typedOk", "Saída válida — bate com o schema.")
        : `${t("connections.typedFail", "Schema não bateu")}: ${result.error}`,
      result.ok ? "info" : "error",
    );
  }

  const v = edge.lastValidation;
  return (
    <div className="rounded border border-border/70 bg-surface1/40 p-2">
      <div className="flex items-center gap-1.5 text-[11px] text-text mb-1">
        <span className="font-medium truncate max-w-[42%]" title={edge.srcLabel}>{edge.srcLabel}</span>
        <span className="text-textMuted">→</span>
        <span className="font-medium truncate max-w-[42%]" title={edge.dstLabel}>{edge.dstLabel}</span>
        <div className="flex-1" />
        {v && (
          <span className={cn("text-[10px]", v.ok ? "text-green-400" : "text-danger")} title={v.error}>
            {v.ok ? "✓" : "✗"} {v.ok ? t("connections.typedValid", "válido") : t("connections.typedInvalid", "inválido")}
          </span>
        )}
      </div>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        rows={3}
        spellCheck={false}
        placeholder={'{ "type": "object", "required": ["ok"], "properties": { "ok": { "type": "boolean" } } }'}
        className="w-full px-2 py-1 rounded text-[11px] bg-bg border border-border text-text placeholder:text-textMuted/60 focus:outline-none focus:border-brand font-mono resize-y"
      />
      <div className="flex items-center gap-2 mt-1.5">
        <button
          onClick={save}
          disabled={!dirty}
          className="px-2.5 py-1 rounded text-[11px] bg-surface2 text-text hover:text-brand border border-border disabled:opacity-40"
        >
          {t("common.save", "Salvar")}
        </button>
        <button
          onClick={validateNow}
          className="px-2.5 py-1 rounded text-[11px] bg-surface2 text-text hover:text-brand border border-border"
        >
          {t("connections.typedValidateNow", "Validar última saída")}
        </button>
        {v && !v.ok && v.error && (
          <span className="text-[10px] text-danger truncate flex-1" title={v.error}>{v.error}</span>
        )}
      </div>
    </div>
  );
}

/** Seção "Conexões tipadas": lista as edges agente→agente do paralelo ativo e deixa colar
 *  o responseSchema de cada uma. Fase 2 — conexões semânticas (roubada do LangChain). */
function TypedConnectionsSection() {
  const t = useT();
  const parallels = useCanvasStore((s) => s.parallels);
  const activeParallelId = useCanvasStore((s) => s.activeParallelId);
  const rows = useMemo<TypedEdgeRow[]>(() => {
    const f = parallels.find((p) => p.id === activeParallelId);
    if (!f) return [];
    const labelOf = (id: string): string => {
      const n = f.nodes.find((x) => x.id === id);
      if (!n) return id.slice(0, 6);
      return "label" in n && n.label ? n.label : n.kind;
    };
    return f.edges
      .filter((e) => e.kind === "generic")
      .map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        srcLabel: labelOf(e.source),
        dstLabel: labelOf(e.target),
        responseSchema: e.responseSchema ?? "",
        lastValidation: e.lastValidation,
      }));
  }, [parallels, activeParallelId]);

  return (
    <div className="rounded-md border border-border bg-bg/40 p-3">
      <div className="flex items-center gap-2 mb-1">
        <Waypoints size={14} className="text-brand" />
        <span className="text-sm text-text font-medium flex-1">{t("connections.typedTitle", "Conexões tipadas (schema de resposta)")}</span>
      </div>
      <p className="text-[11px] text-textMuted mb-2">
        {t("connections.typedDesc", "Cole um JSON Schema (ou um exemplo JSON) que a saída do agente de ORIGEM deve satisfazer. A cada turno a saída é validada; se não bater, a linha marca ✗ e você é avisado. Vazio = sem contrato (comportamento normal).")}
      </p>
      {rows.length === 0 ? (
        <p className="text-[11px] text-textMuted opacity-70">
          {t("connections.typedEmpty", "Nenhuma conexão entre agentes neste paralelo. Ligue um agente a outro no canvas.")}
        </p>
      ) : (
        <div className="space-y-2">
          {rows.map((r) => <TypedConnectionRow key={r.id} edge={r} />)}
        </div>
      )}
    </div>
  );
}

interface Props {
  onClose: () => void;
}

export function ConnectionsModal({ onClose }: Props) {
  const t = useT();
  const [conns, setConns] = useState<ConnectionConfig[]>([]);
  const [active, setActive] = useState<ProviderKind | null>(null);
  const [omniEndpoint, setOmniEndpoint] = useState("");
  const [omniToken, setOmniToken] = useState("");
  const [obsEndpoint, setObsEndpoint] = useState("");
  const [obsToken, setObsToken] = useState("");
  const [health, setHealth] = useState<Record<string, ProviderHealth>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Migração de memórias entre providers (task #34)
  const [migrateFor, setMigrateFor] = useState<ProviderKind | null>(null);
  const [migratePreview, setMigratePreview] = useState<number | null>(null);
  const [migrateResult, setMigrateResult] = useState<MigrateResult | null>(null);
  const [migrateBusy, setMigrateBusy] = useState(false);
  const [migrateError, setMigrateError] = useState<string | null>(null);

  async function load() {
    try {
      const [list, act] = await Promise.all([providersList(), providerActive()]);
      setConns(list);
      setActive(act);
      const omni = list.find((c) => c.kind === "omnimemory");
      if (omni?.endpoint) setOmniEndpoint(omni.endpoint);
      const obs = list.find((c) => c.kind === "obsidian");
      if (obs?.endpoint) setObsEndpoint(obs.endpoint);
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

  async function connectObsidian() {
    setBusy("connect:obsidian");
    setError(null);
    try {
      const ep = obsEndpoint.trim();
      await providerConnect({ kind: "obsidian", endpoint: ep, token: obsToken.trim() });
      setObsToken("");
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  function HealthLine({ kind }: { kind: ProviderKind }) {
    const h = health[kind];
    if (busy === `test:${kind}`) return <span className="text-[11px] text-textMuted">{t("connections.testing", "testando…")}</span>;
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
        <BadgeCheck size={11} /> {t("connections.active", "ativo")}
      </span>
    );
  }

  function labelFor(kind: ProviderKind): string {
    switch (kind) {
      case "local":
        return t("connections.localTitle", "Local (SQLite)");
      case "omnimemory":
        return "OmniMemory";
      case "obsidian":
        return "Obsidian";
    }
  }

  async function openMigrate(kind: ProviderKind) {
    if (active === null) return;
    setMigrateFor(kind);
    setMigratePreview(null);
    setMigrateResult(null);
    setMigrateError(null);
    setMigrateBusy(false);
    try {
      const p = await memoryMigratePreview(active, kind);
      setMigratePreview(p.count);
    } catch (e) {
      setMigrateError(String(e));
    }
  }

  function closeMigrate() {
    setMigrateFor(null);
    setMigratePreview(null);
    setMigrateResult(null);
    setMigrateError(null);
    setMigrateBusy(false);
  }

  async function runMigrate(kind: ProviderKind, mode: "copy" | "move") {
    if (active === null) return;
    setMigrateBusy(true);
    setMigrateError(null);
    try {
      const r = await memoryMigrate(active, kind, mode);
      setMigrateResult(r);
    } catch (e) {
      setMigrateError(String(e));
    } finally {
      setMigrateBusy(false);
    }
  }

  // Botão "⇄ migrar do ativo pra cá" + painel inline de confirmação/resultado.
  // Só aparece nos cards que NÃO são o provider ativo. Destino desconectado →
  // botão desabilitado com dica "conecte primeiro". Sem diálogos nativos
  // (WebKitGTK não tem confirm/alert) — tudo inline.
  function MigrateSection({ kind }: { kind: ProviderKind }) {
    if (active === null || active === kind) return null;
    const canMigrate = configured(kind);
    const open = migrateFor === kind;
    if (!open) {
      return (
        <div className="mt-2 pt-2 border-t border-border/60">
          <button
            onClick={() => void openMigrate(kind)}
            disabled={!canMigrate}
            title={canMigrate ? undefined : t("connections.migrateConnectFirst", "conecte primeiro")}
            className="px-2.5 py-1 rounded text-[11px] bg-surface2 text-text hover:text-brand border border-border disabled:opacity-40"
          >
            ⇄ {t("connections.migrateFromActive", "migrar do ativo pra cá")}
          </button>
        </div>
      );
    }
    return (
      <div className="mt-2 pt-2 border-t border-border/60 space-y-1.5">
        {migrateBusy ? (
          <span className="text-[11px] text-textMuted">{t("connections.migrating", "migrando…")}</span>
        ) : migrateResult ? (
          <div className="text-[11px] text-text">
            <span className="text-green-400">
              ✓ {migrateResult.copied} {t("connections.migrateCopied", "copiadas")}
            </span>
            {", "}
            {migrateResult.skipped} {t("connections.migrateSkipped", "puladas")}
            {migrateResult.errors > 0 && (
              <span className="text-danger">
                {", "}
                {migrateResult.errors} {t("connections.migrateErrors", "erros")}
              </span>
            )}
            <button onClick={closeMigrate} className="ml-2 underline text-textMuted hover:text-text">
              {t("common.close", "Fechar")}
            </button>
          </div>
        ) : (
          <>
            <p className="text-[11px] text-text">
              {t("connections.migrateConfirm1", "Copiar")} {migratePreview ?? "…"}{" "}
              {t("connections.migrateConfirm2", "memórias de")} <b>{labelFor(active)}</b> → <b>{labelFor(kind)}</b>?
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => void runMigrate(kind, "copy")}
                disabled={migratePreview === null || migratePreview === 0}
                className="px-2.5 py-1 rounded text-[11px] bg-brand text-bg hover:bg-brand-hover disabled:opacity-40 transition-colors"
              >
                {t("connections.migrateCopy", "Copiar")}
              </button>
              <button
                onClick={() => void runMigrate(kind, "move")}
                disabled={migratePreview === null || migratePreview === 0}
                className="px-2.5 py-1 rounded text-[11px] bg-surface2 text-text hover:text-brand border border-border disabled:opacity-40"
              >
                {t("connections.migrateMove", "Mover")}
              </button>
              <button onClick={closeMigrate} className="px-2.5 py-1 rounded text-[11px] text-textMuted hover:text-text">
                {t("common.cancel", "Cancelar")}
              </button>
            </div>
          </>
        )}
        {migrateError && <p className="text-[11px] text-danger break-words">{migrateError}</p>}
      </div>
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
          <span className="text-sm font-medium text-text flex-1">{t("connections.title", "Memória — Conexões")}</span>
          <button onClick={() => void load()} title={t("common.reload", "Recarregar")} className="text-textMuted hover:text-brand p-1">
            <RefreshCw size={14} />
          </button>
          <button onClick={onClose} className="text-textMuted hover:text-text p-1" title={t("common.close", "Fechar")}>
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
              <span className="text-sm text-text font-medium flex-1">{t("connections.localTitle", "Local (SQLite)")}</span>
              <ActiveBadge kind="local" />
            </div>
            <p className="text-[11px] text-textMuted mb-2">{t("connections.localDesc", "Blackboard offline, zero-config — o default. Sempre disponível.")}</p>
            <div className="flex items-center gap-2">
              <button onClick={() => void activate("local")} disabled={active === "local"} className="px-2.5 py-1 rounded text-[11px] bg-brand text-bg hover:bg-brand-hover disabled:opacity-40 transition-colors">{t("connections.use", "Usar")}</button>
              <button onClick={() => void test("local")} className="px-2.5 py-1 rounded text-[11px] bg-surface2 text-text hover:text-brand border border-border">{t("common.test", "Testar")}</button>
              <HealthLine kind="local" />
            </div>
            <MigrateSection kind="local" />
          </div>

          {/* OmniMemory */}
          <div className="rounded-md border border-border bg-bg/40 p-3">
            <div className="flex items-center gap-2 mb-1">
              <Brain size={14} className="text-brand" />
              <span className="text-sm text-text font-medium flex-1">OmniMemory</span>
              {configured("omnimemory") && <span className="text-[10px] text-green-400/70">{t("connections.configured", "configurado")}</span>}
              <ActiveBadge kind="omnimemory" />
            </div>
            <p className="text-[11px] text-textMuted mb-2">{t("connections.omniDesc", "Cérebro remoto (entidades + relações tipadas). Token escopado, ofuscado em repouso.")}</p>
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
                placeholder={configured("omnimemory") ? t("connections.tokenUpdatePh", "token (re-digite p/ atualizar)") : t("connections.tokenScopedPh", "token escopado")}
                className="w-full px-2 py-1 rounded text-[11px] bg-bg border border-border text-text placeholder:text-textMuted focus:outline-none focus:border-brand font-mono"
              />
            </div>
            <div className="flex items-center gap-2 mt-2">
              <button
                onClick={() => void connectOmni()}
                disabled={busy === "connect:omnimemory" || !omniEndpoint.trim() || !omniToken.trim()}
                className="px-2.5 py-1 rounded text-[11px] bg-brand text-bg hover:bg-brand-hover disabled:opacity-40 transition-colors"
              >
                {busy === "connect:omnimemory" ? t("connections.saving", "salvando…") : t("connections.connect", "Conectar")}
              </button>
              <button onClick={() => void test("omnimemory")} disabled={!configured("omnimemory")} className="px-2.5 py-1 rounded text-[11px] bg-surface2 text-text hover:text-brand border border-border disabled:opacity-40">{t("common.test", "Testar")}</button>
              <button onClick={() => void activate("omnimemory")} disabled={!configured("omnimemory") || active === "omnimemory"} className="px-2.5 py-1 rounded text-[11px] bg-surface2 text-text hover:text-brand border border-border disabled:opacity-40">{t("connections.use", "Usar")}</button>
              <HealthLine kind="omnimemory" />
            </div>
            <MigrateSection kind="omnimemory" />
          </div>

          {/* Obsidian — vault via plugin "Local REST API" */}
          <div className="rounded-md border border-border bg-bg/40 p-3">
            <div className="flex items-center gap-2 mb-1">
              <FileText size={14} className="text-brand" />
              <span className="text-sm text-text font-medium flex-1">Obsidian</span>
              {configured("obsidian") && <span className="text-[10px] text-green-400/70">{t("connections.configured", "configurado")}</span>}
              <ActiveBadge kind="obsidian" />
            </div>
            <p className="text-[11px] text-textMuted mb-2">
              {t("connections.obsDesc1", "Vault local via plugin")} <b>Local REST API</b> {t("connections.obsDesc2", "(notas +")} <code>[[links]]</code>{t("connections.obsDesc3", "). Ative o plugin no Obsidian, copie a API key e use a URL HTTPS de")} <code>127.0.0.1</code>.
            </p>
            <div className="space-y-1.5">
              <input
                value={obsEndpoint}
                onChange={(e) => setObsEndpoint(e.target.value)}
                placeholder="https://127.0.0.1:27124"
                className="w-full px-2 py-1 rounded text-[11px] bg-bg border border-border text-text placeholder:text-textMuted focus:outline-none focus:border-brand font-mono"
              />
              <input
                value={obsToken}
                onChange={(e) => setObsToken(e.target.value)}
                type="password"
                placeholder={configured("obsidian") ? t("connections.apiKeyUpdatePh", "API key (re-digite p/ atualizar)") : t("connections.apiKeyPh", "API key do Local REST API")}
                className="w-full px-2 py-1 rounded text-[11px] bg-bg border border-border text-text placeholder:text-textMuted focus:outline-none focus:border-brand font-mono"
              />
            </div>
            <div className="flex items-center gap-2 mt-2">
              <button
                onClick={() => void connectObsidian()}
                disabled={busy === "connect:obsidian" || !obsEndpoint.trim() || !obsToken.trim()}
                className="px-2.5 py-1 rounded text-[11px] bg-brand text-bg hover:bg-brand-hover disabled:opacity-40 transition-colors"
              >
                {busy === "connect:obsidian" ? t("connections.saving", "salvando…") : t("connections.connect", "Conectar")}
              </button>
              <button onClick={() => void test("obsidian")} disabled={!configured("obsidian")} className="px-2.5 py-1 rounded text-[11px] bg-surface2 text-text hover:text-brand border border-border disabled:opacity-40">{t("common.test", "Testar")}</button>
              <button onClick={() => void activate("obsidian")} disabled={!configured("obsidian") || active === "obsidian"} className="px-2.5 py-1 rounded text-[11px] bg-surface2 text-text hover:text-brand border border-border disabled:opacity-40">{t("connections.use", "Usar")}</button>
              <HealthLine kind="obsidian" />
            </div>
            <MigrateSection kind="obsidian" />
          </div>

          {/* Conexões tipadas (Fase 2 — responseSchema por conexão do canvas) */}
          <TypedConnectionsSection />
        </div>

        <footer className="px-4 py-2 border-t border-border text-[10px] text-textMuted opacity-60 shrink-0">
          {t("connections.footer1", "O provider")} <b>{t("connections.active", "ativo")}</b> {t("connections.footer2", "é injetado nos agentes claude (Brain Connect) e consultado pelas tools de memória.")}
        </footer>
      </div>
    </div>,
    document.body,
  );
}
