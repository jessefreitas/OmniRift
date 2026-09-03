// src/components/DiffLines.tsx
//
// Renderiza um patch unificado com linhas coloridas (+/- / @@). Componente puro
// isolado pra permitir code-splitting limpo entre ReviewNode e DiffViewerModal.

import { cn } from "@/lib/cn";

export function DiffLines({ patch }: { patch: string }) {
  const lines = patch.split("\n");
  return (
    <pre className="text-[11px] font-mono leading-[1.45]">
      {lines.map((ln, i) => {
        let cls = "text-text";
        let bg = "";
        if (ln.startsWith("@@")) cls = "text-brand";
        else if (
          ln.startsWith("+++") ||
          ln.startsWith("---") ||
          ln.startsWith("diff --git") ||
          ln.startsWith("index ") ||
          ln.startsWith("new file") ||
          ln.startsWith("deleted file") ||
          ln.startsWith("rename ")
        )
          cls = "text-textMuted opacity-50";
        else if (ln.startsWith("+")) {
          cls = "text-green-300";
          bg = "bg-green-500/10";
        } else if (ln.startsWith("-")) {
          cls = "text-red-300";
          bg = "bg-red-500/10";
        }
        return (
          <div key={i} className={cn("px-2 whitespace-pre-wrap break-all", cls, bg)}>
            {ln || " "}
          </div>
        );
      })}
    </pre>
  );
}
