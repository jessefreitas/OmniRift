// src/lib/companion.ts
//
// Companheiro do OmniRift — equivalente ao "Ombro" do Maestri, mas SUPERA:
//  - plugável (qualquer LLM BYOK, não preso a Apple Foundation Models)
//  - ciente da MEMÓRIA (blackboard) → contexto além do canvas atual
//  - ciente do ESTADO VIVO dos agentes (terminalStatuses)
// Lê o estado do canvas + memórias e devolve resumo + próximos passos.

import { useCanvasStore } from "@/store/canvas-store";
import { llmChat, loadLlmConfig } from "@/lib/llm-client";
import { memoryQuery } from "@/lib/memory-client";

export async function analyzeCanvas(): Promise<string> {
  const cfg = loadLlmConfig();
  if (!cfg) {
    return "Configure um LLM em Ferramentas → 'LLM do review (BYOK)'. O OmniPartner usa o mesmo (qualquer provider).";
  }

  const s = useCanvasStore.getState();
  const floors = s.floors.filter((f) => f.projectId === s.activeProjectId);
  const lines: string[] = [];
  for (const f of floors) {
    const agents = f.nodes.filter((n): n is Extract<typeof n, { kind: "terminal" }> => n.kind === "terminal");
    lines.push(`Paralelo "${f.name}"${f.branch ? ` (branch ${f.branch})` : ""}: ${agents.length} agente(s)`);
    for (const a of agents) {
      const st = s.terminalStatuses[a.id] ?? "?";
      lines.push(`  - ${a.label ?? a.role} [${a.role}] · estado: ${st} · cmd: ${a.command}`);
    }
  }
  const state = lines.length ? lines.join("\n") : "(nenhum paralelo/agente no projeto ativo)";

  let mem = "";
  try {
    const ms = await memoryQuery({ limit: 8 });
    if (ms.length) mem = "\n\nMemórias recentes do projeto:\n" + ms.map((m) => `- ${m.value}`).join("\n");
  } catch {
    /* memória é opcional */
  }

  const system =
    "Você é o OmniPartner do OmniRift: observa o canvas de agentes de IA e ajuda o humano a orquestrá-los. Seja conciso e acionável, em PT-BR.";
  const prompt =
    `Estado do canvas (projeto ativo):\n${state}${mem}\n\n` +
    "Responda curto, em PT-BR:\n" +
    "1) RESUMO — o que está acontecendo agora (1-2 frases).\n" +
    "2) PRÓXIMOS PASSOS — 3 ações concretas que o humano (ou os agentes) deveriam tomar a seguir.";

  return llmChat(cfg, system, prompt);
}
