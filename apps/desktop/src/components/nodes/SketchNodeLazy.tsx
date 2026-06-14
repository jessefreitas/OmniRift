// src/components/nodes/SketchNodeLazy.tsx
//
// Carrega o SketchNode (e o tldraw, ~1.7MB) sob demanda — só quando um sketch é
// criado. Mantém o bundle inicial leve. React.lazy code-splita o import dinâmico;
// este wrapper NÃO importa tldraw direto, então fica no bundle principal.

import { lazy, Suspense } from "react";
import type { ComponentType } from "react";
import type { NodeProps } from "@xyflow/react";

const Sketch = lazy(() =>
  import("./SketchNode").then((m) => ({ default: m.SketchNode })),
) as unknown as ComponentType<NodeProps>;

export function SketchNodeLazy(props: NodeProps) {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center rounded-lg border border-border bg-surface1 text-textMuted text-xs">
          carregando sketch…
        </div>
      }
    >
      <Sketch {...props} />
    </Suspense>
  );
}
