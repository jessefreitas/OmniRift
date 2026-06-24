// src/components/health/LearnDimension.tsx
//
// Dimensão "Entenda" do painel Saúde do Projeto. Página didática (frontend-only,
// sem scan/backend) que explica POR QUE o painel existe, O QUE cada métrica
// mede (CX / COG / MI) e COMO LER os resultados. Reusa as MESMAS cores de nível
// das outras dimensões (emerald/yellow/red = ok/warn/high) para consistência
// visual, e puxa as bandas reais de `code-thresholds` quando fizer sentido.
//
// Tudo via i18n (`useT`); os números das bandas de CX/COG vêm dos defaults
// canônicos da spec (DEFAULT_THRESHOLDS); MI usa as bandas fixas (>85/65–85/<65).

import { Activity, FileCode2, Database, Lightbulb } from "lucide-react";

import { useT } from "@/lib/i18n";
import { DEFAULT_THRESHOLDS } from "@/lib/code-thresholds";

// Mesmas cores de nível das outras dimensões (ok/warn/high).
const LEVEL_DOT = {
  ok: "bg-emerald-400",
  warn: "bg-yellow-400",
  high: "bg-red-400",
} as const;
const LEVEL_TEXT = {
  ok: "text-emerald-400",
  warn: "text-yellow-400",
  high: "text-red-400",
} as const;

type Level = keyof typeof LEVEL_DOT;

/** Uma banda (🟢/🟡/🔴) de uma métrica: bolinha colorida + faixa de valores. */
function Band({ level, label }: { level: Level; label: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className={`inline-block h-2 w-2 rounded-full shrink-0 ${LEVEL_DOT[level]}`} />
      <span className={`text-[11px] font-mono ${LEVEL_TEXT[level]}`}>{label}</span>
    </div>
  );
}

interface MetricCardProps {
  icon: string;
  title: string;
  desc: string;
  measures: string;
  direction: string;
  /** Texto das 3 bandas (já com os números embutidos), na ordem ok/warn/high. */
  bands: { ok: string; warn: string; high: string };
}

function MetricCard({ icon, title, desc, measures, direction, bands }: MetricCardProps) {
  const t = useT();
  return (
    <div className="rounded-lg border border-border bg-surface1 px-3.5 py-3 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span aria-hidden className="text-base leading-none">{icon}</span>
        <h4 className="text-[13px] font-semibold text-text">{title}</h4>
      </div>
      <p className="text-[12px] text-textMuted leading-snug">{desc}</p>
      <div className="text-[11px] text-textMuted leading-snug">
        <span className="opacity-70">{t("health.learnMeasures", "Mede")}: </span>
        <span className="text-text">{measures}</span>
      </div>
      <div className="text-[11px] font-medium text-text">{direction}</div>
      <div className="pt-1.5 mt-0.5 border-t border-border/50">
        <div className="text-[9px] uppercase tracking-wide text-textMuted opacity-70 mb-1">
          {t("health.learnBands", "bandas")}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <Band level="ok" label={bands.ok} />
          <Band level="warn" label={bands.warn} />
          <Band level="high" label={bands.high} />
        </div>
      </div>
    </div>
  );
}

export function LearnDimension() {
  const t = useT();

  // Bandas reais de CX/COG vindas dos thresholds canônicos (spec §5).
  const cx = DEFAULT_THRESHOLDS.cyclomatic; // warn 10, high 20
  const cog = DEFAULT_THRESHOLDS.cognitive; // warn 15, high 30

  return (
    <div className="space-y-5">
      {/* Por que este painel existe / como ajuda */}
      <section className="rounded-lg border border-brand/30 bg-brand/5 px-4 py-3">
        <div className="flex items-center gap-2 mb-1.5">
          <Activity size={15} className="text-brand shrink-0" />
          <h3 className="text-[13px] font-semibold text-text">
            {t("health.learnWhyTitle", "Por que este painel existe")}
          </h3>
        </div>
        <p className="text-[12px] text-textMuted leading-relaxed">
          {t(
            "health.learnWhyBody",
            "Mapeia a saúde do projeto inteiro num lugar só — acha os arquivos mais complexos/arriscados (onde bug nasce e refactor compensa) e a estrutura do banco — e deixa você pedir análise de IA pra agir antes que vire problema.",
          )}
        </p>
      </section>

      {/* As métricas (3 cards) */}
      <section>
        <h3 className="text-[11px] uppercase tracking-wide text-textMuted mb-2">
          {t("health.learnMetricsTitle", "As métricas")}
        </h3>
        <div className="grid grid-cols-1 gap-2.5">
          <MetricCard
            icon="🔀"
            title={t("health.learnCxTitle", "CX — Complexidade Ciclomática")}
            desc={t(
              "health.learnCxDesc",
              "Nº de caminhos independentes da função = pontos de decisão (if/for/while/case/&&/||/?) + 1.",
            )}
            measures={t(
              "health.learnCxMeasures",
              "ramificação → quantos testes ela exige e quão difícil é de seguir.",
            )}
            direction={t("health.learnCxDir", "Maior = pior.")}
            bands={{
              ok: `≤${cx.warn}`,
              warn: `${cx.warn + 1}–${cx.high}`,
              high: `>${cx.high}`,
            }}
          />
          <MetricCard
            icon="🧠"
            title={t("health.learnCogTitle", "COG — Complexidade Cognitiva")}
            desc={t(
              "health.learnCogDesc",
              "Quão difícil é pra um humano ENTENDER o código; pune aninhamento (if dentro de for dentro de if custa mais).",
            )}
            measures={t("health.learnCogMeasures", "carga mental / legibilidade.")}
            direction={t("health.learnCogDir", "Maior = pior.")}
            bands={{
              ok: `≤${cog.warn}`,
              warn: `${cog.warn + 1}–${cog.high}`,
              high: `>${cog.high}`,
            }}
          />
          <MetricCard
            icon="🛠️"
            title={t("health.learnMiTitle", "MI — Índice de Manutenibilidade (0–100)")}
            desc={t(
              "health.learnMiDesc",
              "Combina volume (Halstead) + ciclomática + linhas num único índice.",
            )}
            measures={t("health.learnMiMeasures", "quão fácil é manter o código.")}
            direction={t("health.learnMiDir", "Maior = MELHOR (inverso das outras).")}
            bands={{ ok: ">85", warn: "65–85", high: "<65" }}
          />
        </div>
      </section>

      {/* Como ler */}
      <section className="rounded-lg border border-border bg-surface1 px-4 py-3">
        <div className="flex items-center gap-2 mb-1.5">
          <Lightbulb size={15} className="text-yellow-400 shrink-0" />
          <h3 className="text-[13px] font-semibold text-text">
            {t("health.learnHowReadTitle", "Como ler")}
          </h3>
        </div>
        <p className="text-[12px] text-textMuted leading-relaxed">
          {t(
            "health.learnHowReadBody",
            "CX/COG altos + MI baixo = hotspot. O painel ordena os piores no topo. Clique no arquivo pra abrir, ou “analisar IA” pro relatório (smells, refactors). “Abrir agente” escala pro Debugger.",
          )}
        </p>
      </section>

      {/* Banco de Dados */}
      <section className="rounded-lg border border-border bg-surface1 px-4 py-3">
        <div className="flex items-center gap-2 mb-1.5">
          <Database size={15} className="text-sky-400 shrink-0" />
          <h3 className="text-[13px] font-semibold text-text">
            {t("health.learnDbTitle", "Banco de Dados")}
          </h3>
        </div>
        <p className="text-[12px] text-textMuted leading-relaxed">
          {t(
            "health.learnDbBody",
            "A dimensão Banco detecta o schema direto do repo (migrations, arquivos .sql, schema.prisma ou models de ORM), lista as tabelas com colunas e índices, e pede análise de IA pra apontar problemas de normalização, FK e índices faltando.",
          )}
        </p>
      </section>

      {/* Rodapé: legenda de cores */}
      <p className="flex items-center gap-1.5 text-[11px] text-textMuted opacity-70">
        <FileCode2 size={12} className="shrink-0" />
        {t(
          "health.learnFooter",
          "As cores aqui são as mesmas das listas: 🟢 saudável · 🟡 atenção · 🔴 risco.",
        )}
      </p>
    </div>
  );
}
