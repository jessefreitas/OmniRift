import { fitToNodes, viewportCenterFlow } from "@/lib/canvas-focus";
import { useAgentRuntimeStatus } from "@/lib/agent-runtime-status";
import type { WorkflowTemplate } from "@/lib/workflow-templates";
import { useCanvasStore } from "@/store/canvas-store";

export interface InsertedWorkflow {
  nodeIds: string[];
  /** key do template → id estável do nó no canvas */
  idByKey: Record<string, string>;
  nodeCount: number;
  edgeCount: number;
}

export interface InsertWorkflowOptions {
  /** Keys do template cuja sessão ACP deve subir sob demanda após materializar. */
  startKeys?: string[];
}

/** Materializa uma descrição pura de workflow no canvas atual. */
export function insertWorkflowTemplate(
  template: WorkflowTemplate,
  options: InsertWorkflowOptions = {},
): InsertedWorkflow {
  const store = useCanvasStore.getState();
  const { nodes, edges } = template.build(viewportCenterFlow());
  const idByKey = new Map<string, string>();
  for (const spec of nodes) {
    const node = spec.kind === "filter"
      ? store.addFilterNode({ position: spec.position })
      // spawnedOnce: cards no canvas sem desligar virtualização nem spawnar N ACPs de uma vez
      // (Conselho / templates). Sessão sobe sob demanda — attach/resume ou "Iniciar sessão".
      : store.addAgent({ label: spec.label, persona: spec.persona, position: spec.position, spawnedOnce: true });
    idByKey.set(spec.key, node.id);
  }
  let edgeCount = 0;
  for (const edge of edges) {
    const from = idByKey.get(edge.from);
    const to = idByKey.get(edge.to);
    if (from && to) {
      store.addEdge(from, to, "generic");
      edgeCount++;
    }
  }
  const nodeIds = [...idByKey.values()];
  const startKeys = options.startKeys ?? [];
  const startIds = startKeys
    .map((key) => idByKey.get(key))
    .filter((id): id is string => !!id);
  // Foca primeiro quem vai subir (garante mount sob virtualização) e marca pendingStart.
  fitToNodes(startIds.length > 0 ? startIds : nodeIds);
  if (startIds.length > 0) {
    useAgentRuntimeStatus.getState().requestStart(startIds);
  }
  return {
    nodeIds,
    idByKey: Object.fromEntries(idByKey),
    nodeCount: nodes.length,
    edgeCount,
  };
}
