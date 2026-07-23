import { fitToNodes, viewportCenterFlow } from "@/lib/canvas-focus";
import type { WorkflowTemplate } from "@/lib/workflow-templates";
import { useCanvasStore } from "@/store/canvas-store";

export interface InsertedWorkflow {
  nodeIds: string[];
  nodeCount: number;
  edgeCount: number;
}

/** Materializa uma descrição pura de workflow no canvas atual. */
export function insertWorkflowTemplate(template: WorkflowTemplate): InsertedWorkflow {
  const store = useCanvasStore.getState();
  const { nodes, edges } = template.build(viewportCenterFlow());
  const idByKey = new Map<string, string>();
  for (const spec of nodes) {
    const node = spec.kind === "filter"
      ? store.addFilterNode({ position: spec.position })
      : store.addAgent({ label: spec.label, persona: spec.persona, position: spec.position });
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
  fitToNodes(nodeIds);
  return { nodeIds, nodeCount: nodes.length, edgeCount };
}
