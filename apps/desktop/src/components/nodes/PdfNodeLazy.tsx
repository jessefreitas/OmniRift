// src/components/nodes/PdfNodeLazy.tsx
//
// Carrega o PdfNode (e o pdf.js, ~pesado) sob demanda — só quando um PDF é aberto.
// Mantém o bundle inicial leve. React.lazy code-splita o import dinâmico; este
// wrapper NÃO importa pdfjs-dist direto, então fica no bundle principal.

import { lazy, Suspense } from "react";
import type { ComponentType } from "react";
import type { NodeProps } from "@xyflow/react";

import { ErrorBoundary } from "@/components/ErrorBoundary";

const Pdf = lazy(() =>
  import("./PdfNode").then((m) => ({ default: m.PdfNode })),
) as unknown as ComponentType<NodeProps>;

const FALLBACK_BOX =
  "flex items-center justify-center rounded-lg border border-border bg-surface1 text-textMuted text-xs h-full w-full px-3 text-center";

export function PdfNodeLazy(props: NodeProps) {
  return (
    // ErrorBoundary primeiro: se o pdf.js falhar (load ou runtime), só ESTE node
    // mostra o aviso — o canvas inteiro continua de pé.
    <ErrorBoundary
      fallback={<div className={FALLBACK_BOX}>pdf indisponível (recrie o node)</div>}
    >
      <Suspense fallback={<div className={FALLBACK_BOX}>carregando pdf…</div>}>
        <Pdf {...props} />
      </Suspense>
    </ErrorBoundary>
  );
}
