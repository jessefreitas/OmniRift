// src/components/nodes/SketchNodeLazy.tsx
//
// Carrega o SketchNode (e o tldraw, ~1.7MB) sob demanda — só quando um sketch é
// criado. Mantém o bundle inicial leve. React.lazy code-splita o import dinâmico;
// este wrapper NÃO importa tldraw direto, então fica no bundle principal.

import { lazy, Suspense } from "react";
import type { ComponentType } from "react";
import type { NodeProps } from "@xyflow/react";

import { ErrorBoundary } from "@/components/ErrorBoundary";

const Sketch = lazy(() =>
  import("./SketchNode").then((m) => ({ default: m.SketchNode })),
) as unknown as ComponentType<NodeProps>;

const FALLBACK_BOX =
  "flex items-center justify-center rounded-lg border border-border bg-surface1 text-textMuted text-xs h-full w-full px-3 text-center";

export function SketchNodeLazy(props: NodeProps) {
  return (
    // ErrorBoundary primeiro: se o tldraw falhar (load ou runtime), só ESTE node
    // mostra o aviso — o canvas inteiro continua de pé.
    <ErrorBoundary
      fallback={<div className={FALLBACK_BOX}>sketch indisponível (recrie o node)</div>}
    >
      <Suspense fallback={<div className={FALLBACK_BOX}>carregando sketch…</div>}>
        <Sketch {...props} />
      </Suspense>
    </ErrorBoundary>
  );
}
