// src/components/health/DbDimension.tsx
//
// Dimensão "Banco de Dados" do painel Saúde do Projeto.
//
// Dois modos (toggle "Do repo" | "Ao vivo"):
//   - Do repo (Fase B): `dbScanRepo(currentCwd)` → detecta o schema do repo
//     (migrations / *.sql / schema.prisma / models ORM).
//   - Ao vivo (Fase C): connection string → `dbIntrospect(connStr)` → introspecta
//     o schema REAL do banco conectado. "analisar IA" → `healthAnalyzeDbLive`.
//
// Os DOIS modos exibem o mesmo `DbScan` (`DbScanView`, abaixo) e o mesmo
// `AiReportView` — a renderização de tabelas e o relatório NÃO são duplicados.
//
// SEGURANÇA (Fase C): a connection string carrega credencial → vive SÓ no estado
// efêmero deste componente. NUNCA é persistida em localStorage (nem o backend a
// loga). Aviso discreto "a senha não é salva". (Sem `db_conn_save/list` no
// backend ainda → sem checkbox "lembrar (keychain)".)
//
// Fail-open: erro de qualquer modo vira aviso inline; o modo "Do repo" segue
// funcionando mesmo que o "Ao vivo" falhe, e vice-versa.

import { useEffect, useRef, useState } from "react";
import {
  Sparkles,
  Loader2,
  Database,
  ChevronRight,
  ChevronDown,
  KeyRound,
  Link2,
  Table2,
  Eye,
  EyeOff,
  Plug,
} from "lucide-react";

import { useT } from "@/lib/i18n";
import {
  dbScanRepo,
  dbIntrospect,
  healthAnalyzeDb,
  healthAnalyzeDbLive,
  healthDbReportGet,
  type DbScan,
  type DbTable,
  type DbColumn,
  type AiReport,
} from "@/lib/health-client";
import { AiReportView } from "./AiReportView";

interface Props {
  currentCwd: string;
}

const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;

function ColumnRow({ col }: { col: DbColumn }) {
  const t = useT();
  return (
    <div className="px-2 py-0.5 grid grid-cols-[1fr_auto_auto] gap-2 items-center text-[12px]">
      <span className="flex items-center gap-1.5 min-w-0">
        {col.pk ? (
          <KeyRound size={11} className="text-yellow-400 shrink-0" />
        ) : col.fk ? (
          <Link2 size={11} className="text-sky-400 shrink-0" />
        ) : (
          <span className="w-[11px] shrink-0" />
        )}
        <span className="truncate font-mono text-text">{col.name}</span>
      </span>
      <span className="font-mono text-textMuted text-[11px] text-right truncate max-w-[160px]">
        {col.type}
      </span>
      <span className="flex items-center gap-1 justify-end">
        {col.pk && (
          <span className="text-[9px] uppercase tracking-wide text-yellow-400">
            {t("health.dbPk", "PK")}
          </span>
        )}
        {col.fk && (
          <span className="text-[9px] uppercase tracking-wide text-sky-400">
            {t("health.dbFk", "FK")}
          </span>
        )}
        <span className="text-[9px] uppercase tracking-wide text-textMuted opacity-60">
          {col.nullable ? t("health.dbNull", "null") : t("health.dbNotNull", "not null")}
        </span>
      </span>
    </div>
  );
}

function TableRow({ table }: { table: DbTable }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const Chevron = open ? ChevronDown : ChevronRight;

  return (
    <div className="rounded-md border border-border bg-surface1 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full px-2 py-1.5 flex items-center gap-2 text-left hover:bg-surface2"
        title={table.source}
      >
        <Chevron size={13} className="text-textMuted shrink-0" />
        <Table2 size={12} className="text-textMuted shrink-0" />
        <span className="font-mono text-[12px] text-text truncate">{table.name}</span>
        <span className="text-[10px] text-textMuted opacity-70 shrink-0">
          · {table.columns.length} {t("health.dbColumns", "colunas")}
        </span>
        <div className="flex-1" />
        <span
          className="text-[10px] font-mono text-textMuted opacity-50 truncate max-w-[180px] shrink-0"
          title={table.source}
        >
          {baseName(table.source)}
        </span>
      </button>

      {open && (
        <div className="border-t border-border px-1 py-1 space-y-0.5 bg-bg/30">
          {table.columns.length === 0 ? (
            <p className="px-2 py-1 text-[11px] text-textMuted opacity-60">
              {t("health.dbNoColumns", "Nenhuma coluna detectada.")}
            </p>
          ) : (
            table.columns.map((c) => <ColumnRow key={c.name} col={c} />)
          )}

          {table.indexes.length > 0 && (
            <div className="px-2 pt-1.5 mt-1 border-t border-border/50">
              <div className="text-[9px] uppercase tracking-wide text-textMuted opacity-70 mb-0.5">
                {t("health.dbIndexes", "índices")}
              </div>
              <div className="flex flex-wrap gap-1">
                {table.indexes.map((ix, i) => (
                  <span
                    key={`${ix}-${i}`}
                    className="px-1.5 py-0.5 rounded bg-surface2 text-[10px] font-mono text-textMuted"
                  >
                    {ix}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Renderização compartilhada de um `DbScan` (resumo + fontes + ação "analisar IA"
 * + relatório + lista de tabelas). REUSADA pelos dois modos (repo e ao vivo) —
 * é o único lugar que desenha tabelas, então nada é duplicado.
 *
 * Os pais controlam o ciclo de análise (estado/handler) pra cada modo poder
 * chamar `healthAnalyzeDb` (repo) ou `healthAnalyzeDbLive` (ao vivo).
 */
function DbScanView({
  scan,
  root,
  onAnalyze,
  analyzing,
  analyzeError,
  report,
}: {
  scan: DbScan;
  /** Raiz do projeto (p/ o backup-gate do AiReportView). */
  root: string;
  onAnalyze: () => void;
  analyzing: boolean;
  analyzeError: string | null;
  report: AiReport | null;
}) {
  const t = useT();
  const tables = scan.tables ?? [];
  const sources = scan.sources ?? [];

  return (
    <div className="space-y-4">
      {/* Resumo */}
      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-lg border border-border bg-surface1 px-3 py-2">
          <div className="text-[10px] uppercase tracking-wide text-textMuted">
            {t("health.dbTables", "tabelas")}
          </div>
          <div className="text-lg font-mono text-text">{tables.length}</div>
        </div>
        <div className="rounded-lg border border-border bg-surface1 px-3 py-2">
          <div className="text-[10px] uppercase tracking-wide text-textMuted">
            {t("health.dbSources", "fontes")}
          </div>
          <div className="text-lg font-mono text-text">{sources.length}</div>
        </div>
        <div className="rounded-lg border border-border bg-surface1 px-3 py-2">
          <div className="text-[10px] uppercase tracking-wide text-textMuted">
            {t("health.dbDialect", "dialeto")}
          </div>
          <div className="text-sm font-mono text-text truncate" title={scan.dialect ?? undefined}>
            {scan.dialect || "—"}
          </div>
        </div>
      </div>

      {/* Fontes detectadas */}
      {sources.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-wide text-textMuted mb-1">
            {t("health.dbDetectedSources", "Fontes de schema detectadas")}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {sources.map((s) => (
              <span
                key={s}
                title={s}
                className="px-2 py-0.5 rounded-md border border-border bg-surface1 text-[10px] font-mono text-textMuted truncate max-w-[220px]"
              >
                {s}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Ação: analisar IA */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onAnalyze}
          disabled={analyzing}
          className="flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] rounded bg-brand text-bg hover:bg-brand-hover disabled:opacity-50"
        >
          {analyzing ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
          {analyzing ? t("health.analyzing", "analisando…") : t("health.dbAnalyze", "analisar IA")}
        </button>
        <span className="text-[11px] text-textMuted opacity-70">
          {t("health.dbAnalyzeHint", "Analisa o schema inteiro: relações, índices e riscos.")}
        </span>
      </div>

      {analyzeError && (
        <p className="text-[11px] text-red-400">
          {t("health.analysisError", "Análise indisponível")}: {analyzeError}
        </p>
      )}
      {/* fixable={false}: o alvo do relatório de DB é o repo/schema (diretório),
          não um arquivo backupável — sem ação de "corrigir" com backup aqui. */}
      {report && <AiReportView report={report} root={root} fixable={false} />}

      {/* Lista de tabelas */}
      <div>
        <div className="text-[10px] uppercase tracking-wide text-textMuted mb-1">
          {t("health.dbDetectedTables", "Tabelas detectadas")}
        </div>
        <div className="space-y-1">
          {tables.map((tbl) => (
            <TableRow key={`${tbl.source}:${tbl.name}`} table={tbl} />
          ))}
        </div>
      </div>
    </div>
  );
}

/** Modo "Do repo" (Fase B) — scan automático do schema ao montar / trocar projeto. */
function DbRepoMode({ currentCwd }: { currentCwd: string }) {
  const t = useT();

  const [scan, setScan] = useState<DbScan | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [report, setReport] = useState<AiReport | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);

  // Descarta resultados de scans antigos (re-montar / trocar de projeto).
  const scanToken = useRef(0);

  useEffect(() => {
    if (!currentCwd) return;
    const token = ++scanToken.current;
    setLoading(true);
    setError(null);
    setScan(null);
    setReport(null);
    setAnalyzeError(null);

    dbScanRepo(currentCwd)
      .then((result) => {
        if (scanToken.current === token) setScan(result);
      })
      .catch((e) => {
        if (scanToken.current === token) setError(String(e));
      })
      .finally(() => {
        if (scanToken.current === token) setLoading(false);
      });

    // Recarrega a análise de IA salva (sobrevive a trocar de aba / fechar o painel —
    // o backend persiste sob a key fixa __db_repo__). Se ainda roda, faz poll até concluir.
    let pollId: ReturnType<typeof setTimeout> | undefined;
    const reloadReport = () => {
      healthDbReportGet(currentCwd)
        .then((saved) => {
          if (scanToken.current !== token || !saved) return;
          if (saved.running) {
            setAnalyzing(true);
            pollId = setTimeout(reloadReport, 3000);
          } else {
            setAnalyzing(false);
            setReport(saved.report);
          }
        })
        .catch(() => {});
    };
    reloadReport();

    return () => {
      scanToken.current++;
      if (pollId) clearTimeout(pollId);
    };
  }, [currentCwd]);

  async function analyze() {
    setAnalyzing(true);
    setAnalyzeError(null);
    try {
      const r = await healthAnalyzeDb(currentCwd);
      setReport(r);
    } catch (e) {
      setAnalyzeError(String(e));
    } finally {
      setAnalyzing(false);
    }
  }

  if (loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-9 rounded-md bg-surface1 animate-pulse" />
        ))}
      </div>
    );
  }

  // Fail-open: erro de scan vira aviso inline, não quebra o painel.
  if (error) {
    return (
      <div className="rounded-lg border border-red-400/30 bg-red-400/5 p-4">
        <p className="text-[13px] text-red-400 font-medium">
          {t("health.dbScanError", "Falha ao detectar o schema")}
        </p>
        <p className="text-[12px] text-textMuted mt-1 whitespace-pre-wrap">{error}</p>
      </div>
    );
  }

  const tables = scan?.tables ?? [];

  // Estado vazio didático.
  if (tables.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-center px-4">
        <div className="max-w-[420px] space-y-2">
          <Database size={28} className="text-textMuted opacity-40 mx-auto" />
          <p className="text-[13px] text-text font-medium">
            {t("health.dbEmpty", "Nenhum schema detectado no repo")}
          </p>
          <p className="text-[12px] text-textMuted leading-snug">
            {t(
              "health.dbEmptyHint",
              "Procuramos migrations, arquivos .sql, schema.prisma e models de ORM. Mapear o schema aqui ajuda a ver relações, índices faltando e riscos de modelagem — antes que virem bug ou gargalo.",
            )}
          </p>
        </div>
      </div>
    );
  }

  return (
    <DbScanView
      scan={scan!}
      root={currentCwd}
      onAnalyze={() => void analyze()}
      analyzing={analyzing}
      analyzeError={analyzeError}
      report={report}
    />
  );
}

/**
 * Modo "Ao vivo" (Fase C) — connection string → introspecção do schema real.
 *
 * A `connStr` (com credencial) vive SÓ aqui no estado; nunca em localStorage.
 * Trocar de modo desmonta este componente → o segredo some da memória.
 */
function DbLiveMode({ currentCwd }: { currentCwd: string }) {
  const t = useT();

  const [connStr, setConnStr] = useState("");
  const [reveal, setReveal] = useState(false);

  const [scan, setScan] = useState<DbScan | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connError, setConnError] = useState<string | null>(null);

  const [report, setReport] = useState<AiReport | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);

  // Descarta introspecções antigas (conexões em sequência).
  const connToken = useRef(0);

  async function connect() {
    const conn = connStr.trim();
    if (!conn || connecting) return;
    const token = ++connToken.current;
    setConnecting(true);
    setConnError(null);
    setScan(null);
    setReport(null);
    setAnalyzeError(null);
    try {
      const result = await dbIntrospect(conn);
      if (connToken.current === token) setScan(result);
    } catch (e) {
      if (connToken.current === token) setConnError(String(e));
    } finally {
      if (connToken.current === token) setConnecting(false);
    }
  }

  async function analyze() {
    const conn = connStr.trim();
    if (!conn) return;
    setAnalyzing(true);
    setAnalyzeError(null);
    try {
      const r = await healthAnalyzeDbLive(conn);
      setReport(r);
    } catch (e) {
      setAnalyzeError(String(e));
    } finally {
      setAnalyzing(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* Formulário de conexão */}
      <div className="rounded-lg border border-border bg-surface1 p-3 space-y-2">
        <label className="block text-[10px] uppercase tracking-wide text-textMuted">
          {t("health.dbLiveConnStrLabel", "String de conexão")}
        </label>
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <input
              type={reveal ? "text" : "password"}
              value={connStr}
              onChange={(e) => setConnStr(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void connect();
              }}
              autoComplete="off"
              spellCheck={false}
              placeholder={t(
                "health.dbLiveConnStrPlaceholder",
                "postgres://user:senha@host:5432/db ou sqlite:/caminho/arquivo.db",
              )}
              className="w-full pl-2.5 pr-9 py-1.5 text-[12px] font-mono rounded bg-bg border border-border text-text placeholder:text-textMuted/50 focus:outline-none focus:border-brand"
            />
            <button
              type="button"
              onClick={() => setReveal((r) => !r)}
              title={reveal ? t("health.dbLiveHide", "ocultar") : t("health.dbLiveShow", "mostrar")}
              aria-label={reveal ? t("health.dbLiveHide", "ocultar") : t("health.dbLiveShow", "mostrar")}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 text-textMuted hover:text-text"
            >
              {reveal ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
          <button
            type="button"
            onClick={() => void connect()}
            disabled={connecting || connStr.trim().length === 0}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] rounded bg-brand text-bg hover:bg-brand-hover disabled:opacity-50 shrink-0"
          >
            {connecting ? <Loader2 size={13} className="animate-spin" /> : <Plug size={13} />}
            {connecting
              ? t("health.dbLiveConnecting", "conectando…")
              : t("health.dbLiveConnect", "Conectar")}
          </button>
        </div>
        {/* Aviso discreto de segurança — a senha não é persistida. */}
        <p className="text-[10px] text-textMuted opacity-70">
          {t("health.dbLiveNoSecret", "A senha não é salva — vive só enquanto este painel estiver aberto.")}
        </p>
      </div>

      {/* Fail-open: erro de conexão vira aviso inline; não quebra a aba "Do repo". */}
      {connError && (
        <div className="rounded-lg border border-red-400/30 bg-red-400/5 p-4">
          <p className="text-[13px] text-red-400 font-medium">
            {t("health.dbLiveConnError", "Conexão falhou — confira a string de conexão.")}
          </p>
          <p className="text-[12px] text-textMuted mt-1 whitespace-pre-wrap">{connError}</p>
        </div>
      )}

      {/* Estado vazio didático (ainda não conectou). */}
      {!scan && !connError && !connecting && (
        <div className="text-center px-4 py-6">
          <div className="max-w-[420px] mx-auto space-y-2">
            <Database size={28} className="text-textMuted opacity-40 mx-auto" />
            <p className="text-[13px] text-text font-medium">
              {t("health.dbLiveEmpty", "Conecte a um banco ao vivo")}
            </p>
            <p className="text-[12px] text-textMuted leading-snug">
              {t(
                "health.dbLiveEmptyHint",
                "Cole a string de conexão acima e clique em Conectar pra introspectar o schema real do banco — tabelas, colunas, PK/FK e índices — e pedir análise de IA. A senha vive só nesta sessão.",
              )}
            </p>
          </div>
        </div>
      )}

      {/* Schema introspectado → mesma renderização da Fase B. */}
      {scan && (
        <DbScanView
          scan={scan}
          root={currentCwd}
          onAnalyze={() => void analyze()}
          analyzing={analyzing}
          analyzeError={analyzeError}
          report={report}
        />
      )}
    </div>
  );
}

type DbMode = "repo" | "live";

export function DbDimension({ currentCwd }: Props) {
  const t = useT();
  const [mode, setMode] = useState<DbMode>("repo");

  return (
    <div className="space-y-4">
      {/* Toggle: Do repo | Ao vivo */}
      <div className="inline-flex rounded-md border border-border bg-surface1 p-0.5 text-[12px]">
        <button
          type="button"
          onClick={() => setMode("repo")}
          className={`px-3 py-1 rounded ${
            mode === "repo" ? "bg-brand text-bg" : "text-textMuted hover:text-text"
          }`}
        >
          {t("health.dbModeRepo", "Do repo")}
        </button>
        <button
          type="button"
          onClick={() => setMode("live")}
          className={`px-3 py-1 rounded ${
            mode === "live" ? "bg-brand text-bg" : "text-textMuted hover:text-text"
          }`}
        >
          {t("health.dbModeLive", "Ao vivo")}
        </button>
      </div>

      {/* Modos isolados: cada um tem o próprio estado. Trocar de "Ao vivo" pra
          "Do repo" DESMONTA o DbLiveMode → a connection string some da memória. */}
      {mode === "repo" ? (
        <DbRepoMode currentCwd={currentCwd} />
      ) : (
        <DbLiveMode currentCwd={currentCwd} />
      )}
    </div>
  );
}
