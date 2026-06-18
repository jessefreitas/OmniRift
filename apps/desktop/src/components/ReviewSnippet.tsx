// src/components/ReviewSnippet.tsx
//
// Fase 5 (diff-aware inline): mostra o trecho exato de um finding (±context
// linhas em torno de file:line) com a linha alvo destacada. Lê via read_file.

import { useEffect, useState } from "react";

import { readFile } from "@/lib/preview-client";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/cn";

interface Props {
  worktree: string;
  file: string;
  line?: number;
  context?: number;
}

export function ReviewSnippet({ worktree, file, line, context = 3 }: Props) {
  const t = useT();
  const [lines, setLines] = useState<string[] | null>(null);
  const [start, setStart] = useState(1);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const path = file.startsWith("/") ? file : `${worktree}/${file}`;
    readFile(path)
      .then((content) => {
        if (!alive) return;
        const all = content.split("\n");
        if (line && line > 0) {
          const s = Math.max(1, line - context);
          const e = Math.min(all.length, line + context);
          setStart(s);
          setLines(all.slice(s - 1, e));
        } else {
          setStart(1);
          setLines(all.slice(0, context * 2 + 1));
        }
      })
      .catch((e) => alive && setErr(String(e)));
    return () => {
      alive = false;
    };
  }, [worktree, file, line, context]);

  if (err) return <p className="px-4 py-1.5 text-[10px] text-danger font-mono">{t("reviewSnippet.readError", "não consegui ler")} {file}: {err}</p>;
  if (!lines) return <p className="px-4 py-1.5 text-[10px] text-textMuted opacity-60">{t("reviewSnippet.loading", "carregando trecho…")}</p>;

  return (
    <pre className="mx-4 my-1 rounded bg-bg/60 border border-border/50 overflow-x-auto text-[11px] leading-[1.5] font-mono">
      {lines.map((ln, i) => {
        const n = start + i;
        const hit = line === n;
        return (
          <div key={n} className={cn("flex", hit && "bg-yellow-400/15")}>
            <span className={cn("select-none w-10 shrink-0 text-right pr-2", hit ? "text-yellow-300" : "text-textMuted opacity-50")}>{n}</span>
            <code className={cn("whitespace-pre pr-3", hit ? "text-yellow-100" : "text-text")}>{ln || " "}</code>
          </div>
        );
      })}
    </pre>
  );
}
