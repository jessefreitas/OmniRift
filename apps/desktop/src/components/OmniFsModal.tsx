// src/components/OmniFsModal.tsx
//
// OmniFS — Pasta de agentes (F1+F2): painel de ACOMPANHAMENTO do drive versionado.
// Seções: STATUS (binário/daemon/socket/mount + gerenciado × externo) · ESPAÇO
// (store.redb + backing) · SNAPSHOTS (timeline via omnifs_log, "Snapshot agora" e
// "Restaurar…" POR item — ÚNICO lugar do rollback, humano, confirmação em 2 passos)
// · ÍNDICE (reindexação semântica, full-scan). Padrão SkillsCenterModal (portal),
// estado 100% local (sem zustand).
//
// ⚠️ Restaurar reescreve o DRIVE INTEIRO — o daemon exige o hash COMPLETO (64 hex);
// o log só dá 12 chars, então o hash cheio vem do ledger local (snapshots tirados
// pelo OmniRift) ou colado pelo usuário.

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  HardDrive,
  RefreshCw,
  X,
  Camera,
  History,
  AlertTriangle,
  Undo2,
  ScanSearch,
  FolderCheck,
  Search,
  Copy,
  Check,
} from "lucide-react";

import {
  fmtBytes,
  omnifsLog,
  omnifsProvision,
  omnifsRecover,
  omnifsReindex,
  omnifsRollback,
  omnifsSearch,
  omnifsSnapshotNow,
  omnifsStatus,
  type OmniFsLogEntry,
  type OmniFsStatus,
  type SearchHit,
} from "@/lib/omnifs-client";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/cn";
import { useT } from "@/lib/i18n";

interface Props {
  onClose: () => void;
}

/** Alvo de restauração em andamento (painel de confirmação em 2 passos). */
interface RestoreTarget {
  entry: OmniFsLogEntry;
  /** 0 = aviso aberto; 1 = 1ª confirmação dada (falta o clique final). */
  step: 0 | 1;
  /** Hash completo colado pelo usuário (quando o ledger não conhece). */
  typedHash: string;
}

const FULL_HASH_RE = /^[0-9a-fA-F]{64}$/;

export function OmniFsModal({ onClose }: Props) {
  const t = useT();
  const [status, setStatus] = useState<OmniFsStatus | null>(null);
  const [log, setLog] = useState<OmniFsLogEntry[] | null>(null);
  const [logErr, setLogErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null); // "provision" | "snapshot" | "restore" | "reindex"
  const [msg, setMsg] = useState<string | null>(null);
  const [snapMsg, setSnapMsg] = useState("");
  const [restore, setRestore] = useState<RestoreTarget | null>(null);

  // BUSCA semântica — estado próprio (não passa pelo `run`/`msg` global: o retorno
  // é uma lista de hits, não uma string de status, e não deve disparar refresh).
  const [searchQuery, setSearchQuery] = useState("");
  const [searchHits, setSearchHits] = useState<SearchHit[] | null>(null);
  const [searchErr, setSearchErr] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [copiedFile, setCopiedFile] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const st = await omnifsStatus();
      setStatus(st);
      if (st.socketAlive) {
        try {
          setLog(await omnifsLog());
          setLogErr(null);
        } catch (e) {
          setLog(null);
          setLogErr(String(e));
        }
      } else {
        setLog(null);
        setLogErr(null);
      }
    } catch (e) {
      setMsg(`✗ ${String(e)}`);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function run(kind: string, fn: () => Promise<string>) {
    setBusy(kind);
    setMsg(null);
    try {
      const out = await fn();
      setMsg(`✓ ${out}`);
      await refresh();
    } catch (e) {
      setMsg(`✗ ${String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  const provision = () =>
    run("provision", async () => {
      const st = await omnifsProvision();
      return t("omnifs.provisioned", "Pasta de Projetos OmniFS pronta em ") + (st.mount ?? "?");
    });

  const snapshot = () =>
    run("snapshot", async () => {
      const out = await omnifsSnapshotNow(snapMsg.trim() || undefined);
      setSnapMsg("");
      return out;
    });

  const reindex = () => run("reindex", () => omnifsReindex());

  const recover = () =>
    run("recover", async () => {
      const st = await omnifsRecover();
      return st.socketAlive
        ? t("omnifs.recovered", "Drive OmniFS religado — mount respondendo de novo.")
        : t("omnifs.recoverPartial", "Daemon reiniciado, verificando o mount…");
    });

  const doSearch = useCallback(async () => {
    const q = searchQuery.trim();
    if (!q) return;
    setSearching(true);
    setSearchErr(null);
    setCopiedFile(null);
    try {
      setSearchHits(await omnifsSearch(q));
    } catch (e) {
      setSearchHits(null);
      setSearchErr(String(e));
    } finally {
      setSearching(false);
    }
  }, [searchQuery]);

  /** Clique no hit copia o caminho (sem window.open/diálogos nativos no WebKitGTK). */
  async function copyHit(file: string) {
    await copyText(file);
    setCopiedFile(file);
    setTimeout(() => setCopiedFile((f) => (f === file ? null : f)), 1500);
  }

  /** Hash completo efetivo do alvo de restauração (ledger OU colado + validado). */
  function restoreHash(r: RestoreTarget): string | null {
    if (r.entry.fullHash) return r.entry.fullHash;
    const typed = r.typedHash.trim();
    if (FULL_HASH_RE.test(typed) && typed.toLowerCase().startsWith(r.entry.short.toLowerCase()))
      return typed;
    return null;
  }

  function confirmRestore(r: RestoreTarget) {
    const hash = restoreHash(r);
    if (!hash) return;
    if (r.step === 0) {
      setRestore({ ...r, step: 1 }); // 1º clique — arma o gatilho final
      return;
    }
    setRestore(null);
    void run("restore", () => omnifsRollback(hash));
  }

  const alive = status?.socketAlive === true;
  const rowCls = "flex items-center justify-between gap-3 px-2 py-1 text-[11px]";
  const dotCls = (ok: boolean) =>
    cn("inline-block w-2 h-2 rounded-full shrink-0", ok ? "bg-green-500" : "bg-danger");

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="w-[640px] max-w-[94vw] max-h-[86vh] rounded-lg border border-border bg-surface1 shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-2 px-4 py-2.5 border-b border-border shrink-0">
          <HardDrive size={15} className="text-brand" />
          <span className="text-sm font-medium text-text">{t("omnifs.title", "OmniFS — Pasta de agentes")}</span>
          <div className="flex-1" />
          <button onClick={() => void refresh()} title={t("common.refresh", "Recarregar")} className="text-textMuted hover:text-brand p-1">
            <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
          </button>
          <button onClick={onClose} className="text-textMuted hover:text-text p-1" title={t("common.close", "Fechar")}>
            <X size={16} />
          </button>
        </header>

        {/* Benefícios em 3 linhas */}
        <div className="px-4 py-2 border-b border-border bg-surface2/30 shrink-0 text-[11px] text-textMuted leading-snug">
          <div>🔎 {t("omnifs.benefit1", "Busca semântica cross-projeto pros agentes — acham \"a lógica de auth\", não *.py.")}</div>
          <div>📸 {t("omnifs.benefit2", "Checkpoint automático: cada estado do drive vira snapshot restaurável.")}</div>
          <div>🔒 {t("omnifs.benefit3", "100% local — nada sai da sua máquina (embeddings offline).")}</div>
        </div>

        {msg && (
          <p className={cn("px-4 py-1 text-[11px] shrink-0", msg.startsWith("✓") ? "text-green-400" : "text-danger")}>{msg}</p>
        )}

        <div className="flex-1 overflow-auto p-3 space-y-3">
          {/* Binário ausente → como instalar */}
          {status && !status.binFound && (
            <div className="rounded-md border border-yellow-400/40 bg-yellow-400/10 px-3 py-2 text-[11px] text-yellow-200 flex items-start gap-2">
              <AlertTriangle size={13} className="shrink-0 mt-0.5" />
              <span>
                {t("omnifs.noBin", "Binário `omnifs-mcp` não encontrado. Instale o OmniFS:")}
                <code className="block mt-1 text-[10px] bg-black/30 rounded px-1.5 py-1">
                  sudo apt install fuse3 && cargo build --release && cp target/release/omnifs-mcp ~/.cargo/bin/
                </code>
              </span>
            </div>
          )}

          {/* Mount CONGELADO (daemon vivo mas FUSE preso — disco cheio/I-O travado):
              o incidente ENOTCONN. Oferece religar o mount sem reiniciar o app. */}
          {status?.stale && (
            <div className="rounded-md border border-danger/50 bg-danger/10 px-3 py-2 text-[11px] text-danger flex items-start gap-2">
              <AlertTriangle size={13} className="shrink-0 mt-0.5" />
              <div className="flex-1">
                <div className="font-medium">
                  {t("omnifs.staleTitle", "Drive travado (ENOTCONN)")}
                </div>
                <div className="text-danger/80 mt-0.5 leading-snug">
                  {t(
                    "omnifs.staleBody",
                    "O daemon está no ar mas o mount não responde — provável disco cheio ou I/O preso. Os arquivos ficam inacessíveis até religar.",
                  )}
                </div>
                <button
                  onClick={() => void recover()}
                  disabled={busy === "recover"}
                  className="mt-1.5 inline-flex items-center gap-1.5 rounded bg-danger/20 hover:bg-danger/30 px-2.5 py-1 text-[11px] font-medium disabled:opacity-50"
                >
                  {t("omnifs.reconnect", "Reconectar")}
                  {busy === "recover" && <RefreshCw size={12} className="animate-spin" />}
                </button>
              </div>
            </div>
          )}

          {/* Mount NEM EXISTE (ENOENT — pasta removida/nunca criada): estado diferente
              do congelado. Antes isto aparecia como "Drive travado / disco cheio" e
              mandava o usuário caçar a causa errada. A cura é RECRIAR (botão abaixo). */}
          {status?.mountMissing && !status?.stale && (
            <div className="rounded-md border border-yellow-400/40 bg-yellow-400/10 px-3 py-2 text-[11px] text-yellow-200 flex items-start gap-2">
              <AlertTriangle size={13} className="shrink-0 mt-0.5" />
              <div className="flex-1">
                <div className="font-medium">
                  {t("omnifs.missingTitle", "Pasta de Projetos não existe no disco")}
                </div>
                <div className="opacity-80 mt-0.5 leading-snug">
                  {t(
                    "omnifs.missingBody",
                    "O caminho configurado foi removido (ou nunca foi criado nesta máquina) — não é travamento nem disco cheio. Use o botão “Religar daemon / recriar Pasta de Projetos” abaixo para recriá-la.",
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Disco baixo (< 1 GB livre no store): avisa ANTES de encher e congelar
              o FUSE. Não bloqueia — abaixo de 256 MB o snapshot é recusado no backend. */}
          {status?.lowDisk && !status?.stale && (
            <div className="rounded-md border border-yellow-400/40 bg-yellow-400/10 px-3 py-2 text-[11px] text-yellow-200 flex items-start gap-2">
              <AlertTriangle size={13} className="shrink-0 mt-0.5" />
              <span>
                {t(
                  "omnifs.lowDisk",
                  "Disco quase cheio no store do OmniFS — libere espaço. Com disco cheio o snapshot é pulado pra não congelar o drive.",
                )}{" "}
                <span className="tabular-nums opacity-80">
                  ({fmtBytes(status?.storeFreeBytes ?? null)} {t("omnifs.free", "livres")})
                </span>
              </span>
            </div>
          )}

          {/* STATUS */}
          <section className="rounded-md border border-border/60 bg-surface2/20">
            <div className="px-2 py-1.5 text-[10px] uppercase tracking-wide text-textMuted border-b border-border/40">
              {t("omnifs.status", "Status")}
            </div>
            <div className={rowCls}>
              <span className="text-textMuted">{t("omnifs.bin", "Binário omnifs-mcp")}</span>
              <span className="flex items-center gap-1.5 text-text min-w-0">
                <span className={dotCls(status?.binFound === true)} />
                <span className="truncate" title={status?.binPath ?? ""}>{status?.binPath ?? t("omnifs.notFound", "não encontrado")}</span>
              </span>
            </div>
            <div className={rowCls}>
              <span className="text-textMuted">{t("omnifs.daemon", "Daemon (socket)")}</span>
              <span className="flex items-center gap-1.5 text-text min-w-0">
                <span className={dotCls(alive)} />
                <span className="truncate" title={status?.socketPath ?? ""}>
                  {alive
                    ? status?.managed
                      ? t("omnifs.aliveManaged", "vivo — gerenciado pelo OmniRift")
                      : t("omnifs.aliveExternal", "vivo — daemon externo (seu systemd/manual)")
                    : t("omnifs.dead", "fora do ar")}
                </span>
              </span>
            </div>
            <div className={rowCls}>
              <span className="text-textMuted">{t("omnifs.mount", "Pasta de Projetos (mount)")}</span>
              <span className="text-text truncate" title={status?.mount ?? ""}>{status?.mount ?? t("omnifs.notProvisioned", "não provisionada")}</span>
            </div>
            {status?.mount && !alive && (
              <div className="mx-2 mb-2 px-2 py-1.5 rounded border border-danger/40 bg-danger/10 text-[10px] text-danger flex items-start gap-1.5">
                <AlertTriangle size={12} className="shrink-0 mt-0.5" />
                {t("omnifs.enotconn", "Mount presente com daemon morto: agentes nessa pasta veriam erro de IO (ENOTCONN). Clique abaixo pra religar.")}
              </div>
            )}
            <div className="px-2 pb-2 pt-1">
              <button
                onClick={() => void provision()}
                disabled={!status?.binFound || busy !== null}
                className="w-full px-3 py-1.5 rounded-md text-xs bg-brand text-bg hover:bg-brand-hover disabled:opacity-40 flex items-center justify-center gap-2"
              >
                <FolderCheck size={13} />
                {status?.mount
                  ? t("omnifs.reprovision", "Religar daemon / recriar Pasta de Projetos")
                  : t("omnifs.provision", "Criar minha Pasta de Projetos OmniFS")}
                {busy === "provision" && <RefreshCw size={12} className="animate-spin" />}
              </button>
            </div>
          </section>

          {/* ESPAÇO */}
          <section className="rounded-md border border-border/60 bg-surface2/20">
            <div className="px-2 py-1.5 text-[10px] uppercase tracking-wide text-textMuted border-b border-border/40">
              {t("omnifs.space", "Espaço")}
            </div>
            <div className={rowCls}>
              <span className="text-textMuted">{t("omnifs.storeSize", "Store (store.redb)")}</span>
              <span className="text-text tabular-nums">{fmtBytes(status?.storeBytes ?? null)}</span>
            </div>
            <div className={rowCls}>
              <span className="text-textMuted">{t("omnifs.backingSize", "Backing (arquivos vivos)")}</span>
              <span className="text-text tabular-nums truncate" title={status?.backingPath ?? ""}>
                {status?.backingBytes !== null && status?.backingBytes !== undefined
                  ? fmtBytes(status.backingBytes)
                  : status?.backingPath ?? "—"}
              </span>
            </div>
          </section>

          {/* BUSCA semântica — o headline: acha por SIGNIFICADO, não por grep */}
          <section className="rounded-md border border-border/60 bg-surface2/20">
            <div className="px-2 py-1.5 text-[10px] uppercase tracking-wide text-textMuted border-b border-border/40 flex items-center gap-1.5">
              <Search size={11} /> {t("omnifs.search", "Busca semântica")}
            </div>
            <div className="px-2 py-2 flex items-center gap-2 border-b border-border/40">
              <input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void doSearch();
                }}
                placeholder={t("omnifs.searchPh", "onde no projeto… (ex.: a lógica de login)")}
                disabled={!alive}
                className="flex-1 bg-bg border border-border rounded px-2 py-1 text-[11px] text-text placeholder:text-textMuted focus:outline-none disabled:opacity-40"
              />
              <button
                onClick={() => void doSearch()}
                disabled={!alive || searching || !searchQuery.trim()}
                className="px-2.5 py-1 rounded-md text-[11px] bg-surface2 border border-border text-text hover:bg-bg disabled:opacity-40 flex items-center gap-1.5 shrink-0"
              >
                <Search size={12} /> {t("omnifs.searchGo", "Buscar")}
                {searching && <RefreshCw size={11} className="animate-spin" />}
              </button>
            </div>
            <div className="max-h-52 overflow-auto">
              {!alive ? (
                <p className="px-3 py-2 text-[11px] text-textMuted opacity-70">
                  {t("omnifs.searchNeedsDaemon", "Busca indisponível — daemon fora do ar. Provisione a Pasta de Projetos acima.")}
                </p>
              ) : searchErr ? (
                <p className="px-3 py-2 text-[11px] text-danger">{searchErr}</p>
              ) : searchHits === null ? (
                <p className="px-3 py-2 text-[11px] text-textMuted opacity-70">
                  {t("omnifs.searchHint", "Descreva o que procura em linguagem natural — os agentes buscam por conceito, não por *.ext. Rode o Índice abaixo se a busca vier vazia.")}
                </p>
              ) : searchHits.length === 0 ? (
                <p className="px-3 py-2 text-[11px] text-textMuted opacity-70">
                  {t("omnifs.searchEmpty", "Nenhum resultado — reindexe o drive abaixo ou tente outros termos.")}
                </p>
              ) : (
                searchHits.map((h, i) => (
                  <button
                    key={`${h.file}-${i}`}
                    onClick={() => void copyHit(h.file)}
                    title={t("omnifs.searchCopy", "Clique pra copiar o caminho")}
                    className="w-full text-left border-b border-border/30 last:border-b-0 px-2 py-1.5 hover:bg-surface2/40 group"
                  >
                    <div className="flex items-center gap-2 text-[11px]">
                      <span className="text-[10px] text-brand tabular-nums shrink-0" title={t("omnifs.searchScore", "relevância (score cosseno)")}>
                        {h.score.toFixed(3)}
                      </span>
                      <span className="flex-1 min-w-0 truncate font-mono text-text" title={h.file}>
                        {h.file}
                      </span>
                      {copiedFile === h.file ? (
                        <Check size={11} className="text-green-400 shrink-0" />
                      ) : (
                        <Copy size={11} className="text-textMuted opacity-0 group-hover:opacity-100 shrink-0" />
                      )}
                    </div>
                    {h.preview && (
                      <p className="mt-0.5 text-[10px] text-textMuted truncate" title={h.preview}>
                        {h.preview}
                      </p>
                    )}
                  </button>
                ))
              )}
            </div>
          </section>

          {/* SNAPSHOTS */}
          <section className="rounded-md border border-border/60 bg-surface2/20">
            <div className="px-2 py-1.5 text-[10px] uppercase tracking-wide text-textMuted border-b border-border/40 flex items-center gap-1.5">
              <History size={11} /> {t("omnifs.snapshots", "Snapshots")}
            </div>
            <div className="px-2 py-2 flex items-center gap-2 border-b border-border/40">
              <input
                value={snapMsg}
                onChange={(e) => setSnapMsg(e.target.value)}
                placeholder={t("omnifs.snapMsgPh", "mensagem do snapshot (opcional)")}
                className="flex-1 bg-bg border border-border rounded px-2 py-1 text-[11px] text-text placeholder:text-textMuted focus:outline-none"
              />
              <button
                onClick={() => void snapshot()}
                disabled={!alive || busy !== null}
                className="px-2.5 py-1 rounded-md text-[11px] bg-surface2 border border-border text-text hover:bg-bg disabled:opacity-40 flex items-center gap-1.5 shrink-0"
              >
                <Camera size={12} /> {t("omnifs.snapNow", "Snapshot agora")}
                {busy === "snapshot" && <RefreshCw size={11} className="animate-spin" />}
              </button>
            </div>
            <div className="max-h-52 overflow-auto">
              {!alive ? (
                <p className="px-3 py-2 text-[11px] text-textMuted opacity-70">{t("omnifs.logNeedsDaemon", "Timeline indisponível — daemon fora do ar.")}</p>
              ) : logErr ? (
                <p className="px-3 py-2 text-[11px] text-danger">{logErr}</p>
              ) : !log || log.length === 0 ? (
                <p className="px-3 py-2 text-[11px] text-textMuted opacity-70">{t("omnifs.noSnaps", "Nenhum snapshot ainda — tire o primeiro acima.")}</p>
              ) : (
                log.map((e) => (
                  <div key={e.short} className="border-b border-border/30 last:border-b-0">
                    <div className="flex items-center gap-2 px-2 py-1.5 text-[11px]">
                      <code className="text-[10px] text-brand shrink-0">{e.short}</code>
                      <span className="flex-1 min-w-0 truncate text-text" title={e.message}>
                        {e.message || <span className="text-textMuted opacity-60">{t("omnifs.noMsg", "(sem mensagem)")}</span>}
                      </span>
                      {e.at !== null && (
                        <span className="text-[10px] text-textMuted shrink-0">{new Date(e.at * 1000).toLocaleString()}</span>
                      )}
                      <button
                        onClick={() => setRestore(restore?.entry.short === e.short ? null : { entry: e, step: 0, typedHash: "" })}
                        disabled={busy !== null}
                        className="text-[10px] px-1.5 py-0.5 rounded border border-border text-textMuted hover:text-danger hover:border-danger/50 disabled:opacity-40 shrink-0 flex items-center gap-1"
                      >
                        <Undo2 size={11} /> {t("omnifs.restore", "Restaurar…")}
                      </button>
                    </div>
                    {/* Confirmação em 2 passos — ÚNICO caminho do rollback (humano) */}
                    {restore?.entry.short === e.short && (
                      <div className="mx-2 mb-2 px-2 py-2 rounded border border-danger/50 bg-danger/10 space-y-1.5">
                        <p className="text-[10px] text-danger font-medium flex items-start gap-1.5">
                          <AlertTriangle size={12} className="shrink-0 mt-0.5" />
                          {t("omnifs.restoreWarn", "Restaura o DRIVE INTEIRO pra este snapshot e APAGA o que não estiver em snapshot. Não afeta pastas fora do OmniFS.")}
                        </p>
                        {!e.fullHash && (
                          <>
                            <p className="text-[10px] text-textMuted">
                              {t("omnifs.needFullHash", "Snapshot tirado fora do OmniRift — cole o hash COMPLETO (64 hex, começa com ")}<code>{e.short}</code>):
                            </p>
                            <input
                              value={restore.typedHash}
                              onChange={(ev) => setRestore({ ...restore, typedHash: ev.target.value, step: 0 })}
                              placeholder={t("omnifs.fullHashPh", "hash completo do commit (omnifs log no terminal)")}
                              className="w-full bg-bg border border-border rounded px-2 py-1 text-[10px] font-mono text-text focus:outline-none"
                            />
                          </>
                        )}
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => confirmRestore(restore)}
                            disabled={!restoreHash(restore) || busy !== null}
                            className={cn(
                              "px-2.5 py-1 rounded text-[11px] disabled:opacity-40 flex items-center gap-1.5",
                              restore.step === 1
                                ? "bg-danger text-white hover:opacity-90"
                                : "border border-danger/60 text-danger hover:bg-danger/20",
                            )}
                          >
                            {busy === "restore" ? (
                              <RefreshCw size={11} className="animate-spin" />
                            ) : restore.step === 1 ? (
                              t("omnifs.restoreGo", "RESTAURAR AGORA (2/2)")
                            ) : (
                              t("omnifs.restoreConfirm1", "Confirmar restauração (1/2)")
                            )}
                          </button>
                          <button onClick={() => setRestore(null)} className="text-[10px] text-textMuted hover:text-text">
                            {t("common.cancel", "Cancelar")}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </section>

          {/* ÍNDICE */}
          <section className="rounded-md border border-border/60 bg-surface2/20">
            <div className="px-2 py-1.5 text-[10px] uppercase tracking-wide text-textMuted border-b border-border/40 flex items-center gap-1.5">
              <ScanSearch size={11} /> {t("omnifs.index", "Índice semântico")}
            </div>
            <div className="px-2 py-2 flex items-center gap-2">
              <span className="flex-1 text-[10px] text-textMuted">
                {t("omnifs.indexHint", "Reindexa TODOS os arquivos-texto do drive (full-scan — pode demorar em drives grandes). Rode após grandes mudanças pra busca semântica ficar atual.")}
              </span>
              <button
                onClick={() => void reindex()}
                disabled={!alive || busy !== null}
                className="px-2.5 py-1 rounded-md text-[11px] bg-surface2 border border-border text-text hover:bg-bg disabled:opacity-40 flex items-center gap-1.5 shrink-0"
              >
                <ScanSearch size={12} /> {t("omnifs.reindex", "Reindexar")}
                {busy === "reindex" && <RefreshCw size={11} className="animate-spin" />}
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>,
    document.body,
  );
}
