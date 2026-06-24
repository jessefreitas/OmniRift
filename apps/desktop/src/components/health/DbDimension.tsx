// src/components/health/DbDimension.tsx
//
// Dimensão "Banco de Dados" do painel Saúde do Projeto (Fase B — do repo).
// Ao montar, chama `dbScanRepo(currentCwd)` → detecta o schema do repo
// (migrations / *.sql / schema.prisma / models ORM) e mostra:
//   - resumo: nº de tabelas, fontes detectadas e dialeto inferido.
//   - lista de tabelas expansíveis: `nome · nº colunas · source`, abrindo para
//     mostrar colunas (name · type · flags PK/FK/null) + índices.
//   - botão "analisar IA" → `healthAnalyzeDb` → renderiza o AiReportView (REUSE).
//
// Estado vazio didático (nenhum schema detectado + por que isso importa).
// Fail-open: erro vira aviso inline, nunca quebra o painel (nem a dim. Código).

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
} from "lucide-react";

import { useT } from "@/lib/i18n";
import {
  dbScanRepo,
  healthAnalyzeDb,
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

export function DbDimension({ currentCwd }: Props) {
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

    return () => {
      scanToken.current++;
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
  const sources = scan?.sources ?? [];

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
          <div className="text-sm font-mono text-text truncate" title={scan?.dialect ?? undefined}>
            {scan?.dialect || "—"}
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
          onClick={() => void analyze()}
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
      {report && <AiReportView report={report} />}

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
