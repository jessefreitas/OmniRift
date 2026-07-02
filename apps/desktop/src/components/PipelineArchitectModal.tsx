// src/components/PipelineArchitectModal.tsx
//
// Arquiteto de Pipeline — descreve o projeto → um LLM da Central monta o TIME (agentes,
// subagentes, conexões, paralelos, ondas, caminho crítico). Renderiza tipo mini-canvas,
// GRAVA por projeto (revisitável) e pode MONTAR no canvas real.

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { createPortal } from "react-dom";
import { Network, Save, Sparkles, X } from "lucide-react";

import { useCanvasStore } from "@/store/canvas-store";
import { agentMcpConfig, agentSettingsConfig } from "@/lib/mcp-client";
import { workerClaudeArgs } from "@/lib/agent-contract";
import { llmProvidersList, type LlmProvider } from "@/lib/llm-providers-client";
import {
  generatePipelinePlan,
  pipelineSave,
  pipelineLoad,
  type PipelinePlan,
} from "@/lib/pipeline-client";
import { useT } from "@/lib/i18n";

const MODEL_COLORS: Record<string, string> = {
  haiku: "bg-emerald-500/20 text-emerald-300",
  sonnet: "bg-sky-500/20 text-sky-300",
  opus: "bg-purple-500/20 text-purple-300",
};

export function PipelineArchitectModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const currentCwd = useCanvasStore((s) => s.currentCwd) ?? "";
  const addAgent = useCanvasStore((s) => s.addAgent);
  const addEdge = useCanvasStore((s) => s.addEdge);
  const addSubagent = useCanvasStore((s) => s.addSubagent);
  const addTerminal = useCanvasStore((s) => s.addTerminal);
  // Andamento: labels dos agentes/terminais já montados em QUALQUER floor do projeto
  // (o Montar agora espalha por paralelos — contar só o ativo mentiria o X/Y).
  const builtLabels = useCanvasStore((s) => {
    return s.parallels
      .filter((p) => p.projectId === s.activeProjectId)
      .flatMap((p) => p.nodes)
      .filter((n) => n.kind === "agent" || n.kind === "terminal")
      .map((n) => ("label" in n ? (n.label ?? "") : "").toLowerCase())
      .filter(Boolean);
  });

  const [providers, setProviders] = useState<LlmProvider[]>([]);
  const [mountAs, setMountAs] = useState<"agent" | "terminal">("agent");
  const [providerId, setProviderId] = useState("");
  const [model, setModel] = useState("");
  const [desc, setDesc] = useState("");
  const [plan, setPlan] = useState<PipelinePlan | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    llmProvidersList().then((ps) => {
      setProviders(ps);
      if (ps[0]) setProviderId((cur) => cur || ps[0].id);
    }).catch(() => setProviders([]));
    // revisita o plano salvo do projeto
    pipelineLoad(currentCwd).then((p) => { if (p) { setPlan(p); setSavedAt(p.createdAt ?? null); } }).catch(() => {});
  }, [currentCwd]);

  async function generate() {
    if (!desc.trim() || !providerId) { setErr(t("pipe.needDesc", "descreva o projeto e escolha um provider")); return; }
    setLoading(true); setErr(null);
    try {
      const p = await generatePipelinePlan(desc.trim(), providerId, model.trim() || undefined);
      setPlan(p);
      await pipelineSave(currentCwd, p).catch(() => {});
      setSavedAt(p.createdAt ?? Date.now());
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function save() {
    if (!plan) return;
    await pipelineSave(currentCwd, plan).catch(() => {});
    setSavedAt(Date.now());
  }

  // Monta a topologia COMPLETA no canvas: um OmniAgent (ou terminal claude com role NATIVO,
  // via toggle) por agente, COM um BRIEF COMPARTILHADO (objetivo + time + fatia + conexões +
  // trava de não-re-orquestrar) + o pontapé nos agentes de entrada, os SUBAGENTES de cada um
  // (`.claude/agents/<role>.md` com o model:), as conexões, o MODELO sugerido do plano nos
  // principais (providerConfig / --model) e os FLOORS REAIS: cada paralelo do plano (além do
  // 1º, que fica no floor ativo) vira um Parallel próprio — nós nascem lá via targetFloorId.
  async function build() {
    if (!plan) return;
    const store = useCanvasStore.getState();
    // FLOORS REAIS: reusa por nome se já existir (re-Montar idempotente); createParallel
    // devolve null no gate de licença (community = 1 floor) → esse paralelo cai no ativo.
    const floorIdByName = new Map<string, string>();
    let createdFloors = 0;
    if (plan.floors.length > 1) {
      for (const f of plan.floors.slice(1)) {
        const existing = store.parallels.find(
          (p) => p.projectId === store.activeProjectId && p.name.toLowerCase() === f.name.toLowerCase(),
        );
        const target = existing ?? store.createParallel(f.name) ?? undefined;
        if (target) {
          floorIdByName.set(f.name.toLowerCase(), target.id);
          if (!existing) createdFloors++;
        }
      }
    }
    const floorIdFor = (floor?: string) => (floor ? floorIdByName.get(floor.toLowerCase()) : undefined);

    const teamLine = plan.agents.map((a) => a.role).join(", ");
    const repoHint = currentCwd ? `o repositório em ${currentCwd}` : "o repositório do projeto";
    const upstream = (role: string) =>
      plan.connections.filter((c) => c.to.toLowerCase() === role.toLowerCase()).map((c) => c.from);
    const downstream = (role: string) =>
      plan.connections.filter((c) => c.from.toLowerCase() === role.toLowerCase()).map((c) => c.to);

    // Terminal-com-role: o perfil MCP de dev é um só (resolve 1x); settings é por-agente.
    const mcpPath = mountAs === "terminal" ? await agentMcpConfig().catch(() => null) : null;

    const idByRole = new Map<string, string>();
    const floorByRole = new Map<string, string | undefined>();
    // Colunas por (floor, onda): cada floor é um canvas próprio → layout recomeça nele.
    const colByFloorWave = new Map<string, number>();
    let skippedByLimit = 0;
    for (const a of plan.agents) {
      const wave = a.wave ?? 1;
      const targetFloorId = floorIdFor(a.floor);
      const colKey = `${targetFloorId ?? "active"}:${wave}`;
      const col = colByFloorWave.get(colKey) ?? 0;
      colByFloorWave.set(colKey, col + 1);
      const x = 80 + wave * 360;
      const y = 80 + col * 240;
      const ups = upstream(a.role);
      const downs = downstream(a.role);
      const isSource = ups.length === 0; // ponto de entrada → recebe o pontapé imediato
      const persona =
        `Você faz parte de um TIME montado no OmniRift. OBJETIVO DO PROJETO: ${plan.summary}\n` +
        `TIME (${plan.agents.length}): ${teamLine}.\n` +
        `VOCÊ é o ${a.role}. Sua fatia: ${a.why}` +
        (a.model ? ` (modelo sugerido: ${a.model})` : "") +
        (a.floor && plan.floors.length > 1 ? ` — paralelo ${a.floor}` : "") + ".\n" +
        (ups.length ? `Você RECEBE trabalho de: ${ups.join(", ")}. ` : "Você é um ponto de ENTRADA do fluxo. ") +
        (downs.length ? `Você ENTREGA para: ${downs.join(", ")}.\n` : "\n") +
        `REGRA DO TIME: você é UM membro focado. Faça SÓ a sua fatia. NÃO crie sub-times, NÃO rode ` +
        `dispatch/squad/multi_agent_dispatch, NÃO re-orquestre — quem coordena é o canvas do OmniRift ` +
        `(sua saída já alimenta o próximo pela conexão). ` +
        `MEMÓRIA COMPARTILHADA: no começo rode memory_recall pra ver o que o time já registrou; ao ` +
        `terminar sua fatia, rode memory_remember gravando suas decisões e saídas pro próximo agente ` +
        `puxar (é assim que o time colabora — o blackboard começa vazio e enche com o trabalho de vocês). ` +
        `COMMIT: se você editou arquivos, faça commit da sua fatia (git add -A && git commit -m "...") ` +
        `no worktree ao concluir — sem commit não há baseline e o review_current/gate reporta "sem diff". ` +
        (isSource
          ? `COMECE AGORA pela sua parte do objetivo acima; se faltar contexto, leia ${repoHint} antes de perguntar.`
          : `Prepare sua fatia agora lendo ${repoHint}; execute quando ${ups.join(", ")} te entregar o trabalho.`);

      let nodeId: string;
      if (mountAs === "terminal") {
        // Terminal claude NATIVO: persona vira system prompt real (--append-system-prompt,
        // dentro do contrato dev) + modelo do plano via --model (o CLI aceita haiku/sonnet/opus).
        const settingsPath = await agentSettingsConfig(a.role).catch(() => null);
        const node = addTerminal({
          command: "claude",
          args: [...workerClaudeArgs(mcpPath, persona, settingsPath), ...(a.model ? ["--model", a.model] : [])],
          role: "claude-code",
          label: a.role,
          position: { x, y },
          targetFloorId,
        });
        if (!node) { skippedByLimit++; continue; } // gate de licença (máx agentes) → pula o role
        nodeId = node.id;
      } else {
        const node = addAgent({
          label: a.role,
          persona,
          position: { x, y },
          // Modelo sugerido pelo plano nos PRINCIPAIS: o AgentNode aplica no ready
          // (configOption "model" do Claude — mesmo cano do dropdown).
          providerConfig: a.model ? { provider: "claude", model: a.model } : undefined,
          targetFloorId,
        });
        nodeId = node.id;
      }
      idByRole.set(a.role.toLowerCase(), nodeId);
      floorByRole.set(a.role.toLowerCase(), targetFloorId);
      // Subagentes deste agente: cria o nó + escreve o `.claude/agents/<role>.md` com o model:
      // (o addSubagent+SubagentNode materializam; aqui passamos prompt/model do plano).
      const subs = plan.subagents.filter((s) => s.parent.toLowerCase() === a.role.toLowerCase());
      subs.forEach((s, i) => {
        const sub = addSubagent({
          role: s.role.toLowerCase().replace(/\s+/g, "-"),
          label: s.role,
          description: s.why.slice(0, 120),
          prompt: `Você é o ${s.role} (subagente do ${a.role}). ${s.why}`,
          parentAgentId: nodeId,
          parentLabel: a.role,
          cwd: currentCwd || undefined,
          model: s.model,
          position: { x: x + i * 250, y: y + 260 },
          targetFloorId,
        });
        // Materializa o arquivo do subagente (.claude/agents/<role>.md) com o model: no frontmatter.
        void invoke("subagent_write", {
          dir: currentCwd || "",
          name: s.role,
          description: s.why.slice(0, 120),
          prompt: `Você é o ${s.role} (subagente do ${a.role}). ${s.why}`,
          tools: null,
          model: s.model || null,
        }).catch(() => {});
        addEdge(nodeId, sub.id, "subagent-link", { sourceHandle: "subagent", targetFloorId });
      });
    }
    // Conexões: floors são canvases ISOLADOS → só liga quando os dois lados estão no mesmo
    // floor; cross-floor fica documentado no plano (chips de conexões) e é pulado aqui.
    let skippedCross = 0;
    for (const c of plan.connections) {
      const from = idByRole.get(c.from.toLowerCase());
      const to = idByRole.get(c.to.toLowerCase());
      if (!from || !to || from === to) continue;
      const ff = floorByRole.get(c.from.toLowerCase());
      const tf = floorByRole.get(c.to.toLowerCase());
      if (ff !== tf) { skippedCross++; continue; }
      addEdge(from, to, "generic", { targetFloorId: ff });
    }
    console.info(
      `[pipeline] Montar: ${idByRole.size} agentes (${mountAs}), ${createdFloors} paralelo(s) criado(s), ` +
      `${skippedCross} conexão(ões) cross-floor pulada(s), ${skippedByLimit} agente(s) barrado(s) por licença`,
    );
    onClose();
  }

  const sel = "rounded-md border border-border bg-bg px-2 py-1.5 text-sm text-text outline-none focus:border-brand";
  const waves = plan ? [...new Set(plan.agents.map((a) => a.wave ?? 1))].sort((a, b) => a - b) : [];

  return createPortal(
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="flex max-h-[90vh] w-[720px] max-w-[95vw] flex-col rounded-lg border border-border bg-surface1 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
          <Network size={15} className="text-brand" />
          <span className="flex-1 text-sm font-medium text-text">{t("pipe.title", "Arquiteto de Pipeline")}</span>
          {savedAt && <span className="text-[10px] text-textMuted">{t("pipe.saved", "plano salvo")} ✓</span>}
          <button onClick={onClose} className="text-textMuted hover:text-text"><X size={16} /></button>
        </header>

        <div className="flex-1 space-y-3 overflow-auto p-4">
          {/* Entrada */}
          <div className="space-y-2">
            <textarea
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              placeholder={t("pipe.descPh", "Descreva o projeto: ex 'sistema que recebe payloads por API, uma IA lê os dados, gera um PDF e envia por email'")}
              rows={2}
              className="w-full resize-none rounded-md border border-border bg-bg px-2 py-1.5 text-sm text-text outline-none focus:border-brand"
            />
            <div className="flex flex-wrap items-center gap-2">
              <select value={providerId} onChange={(e) => setProviderId(e.target.value)} className={sel}>
                <option value="">{t("pipe.pickProvider", "— provider (Central de API) —")}</option>
                {providers.map((p) => (<option key={p.id} value={p.id}>{p.label}</option>))}
              </select>
              <input value={model} onChange={(e) => setModel(e.target.value)} placeholder={t("pipe.model", "modelo (opcional)")} className={`${sel} w-40 font-mono text-[11px]`} />
              <button onClick={() => void generate()} disabled={loading || !desc.trim() || !providerId}
                className="ml-auto flex items-center gap-1.5 rounded-md bg-brand px-3 py-1.5 text-xs text-bg hover:bg-brand-hover disabled:opacity-40">
                <Sparkles size={13} /> {loading ? t("pipe.thinking", "arquitetando…") : t("pipe.generate", "Gerar plano")}
              </button>
            </div>
            {providers.length === 0 && <p className="text-[11px] text-amber-300/80">{t("pipe.noProviders", "cadastre uma chave em Ferramentas → Central de API")}</p>}
            {err && <p className="break-words font-mono text-[11px] text-danger">✗ {err}</p>}
          </div>

          {/* Plano renderizado */}
          {plan && (
            <div className="space-y-3 rounded-md border border-border p-3">
              <div className="flex items-start gap-2">
                <p className="flex-1 text-[13px] text-text">{plan.summary}</p>
                {(() => {
                  const built = plan.agents.filter((a) => builtLabels.includes(a.role.toLowerCase())).length;
                  return (
                    <span
                      className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${built === 0 ? "bg-white/5 text-textMuted" : built === plan.agents.length ? "bg-emerald-500/20 text-emerald-300" : "bg-amber-500/20 text-amber-200"}`}
                      title={t("pipe.progressT", "agentes deste plano já montados no canvas")}
                    >
                      {built}/{plan.agents.length} {t("pipe.built", "montados")}
                    </span>
                  );
                })()}
              </div>

              {plan.floors.length > 1 && (
                <div className="text-[11px] text-textMuted">
                  <span className="font-semibold text-text/80">{t("pipe.floors", "Paralelos")}:</span>{" "}
                  {plan.floors.map((f) => f.name).join(" · ")}
                </div>
              )}

              {/* Agentes por onda (colunas = mini-canvas) */}
              <div className="flex gap-3 overflow-x-auto pb-1">
                {waves.map((w) => (
                  <div key={w} className="min-w-[180px] flex-1 space-y-1.5">
                    <div className="text-[10px] uppercase tracking-wider text-textMuted">{t("pipe.wave", "onda")} {w}</div>
                    {plan.agents.filter((a) => (a.wave ?? 1) === w).map((a) => (
                      <div key={a.role} className="rounded-md border border-brand/30 bg-brand/5 p-2">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[12px] font-semibold text-text">{a.role}</span>
                          {a.model && <span className={`rounded px-1 py-0.5 text-[8px] uppercase ${MODEL_COLORS[a.model] ?? "bg-white/10 text-text/60"}`}>{a.model}</span>}
                          {a.floor && plan.floors.length > 1 && <span className="text-[8px] text-textMuted">▦ {a.floor}</span>}
                        </div>
                        <div className="text-[10px] leading-snug text-text/60">{a.why}</div>
                        {plan.subagents.filter((s) => s.parent.toLowerCase() === a.role.toLowerCase()).map((s) => (
                          <div key={s.role} className="mt-1 rounded border border-amber-500/25 bg-amber-500/5 px-1.5 py-0.5 text-[10px] text-amber-200/90">
                            ↳ {s.role}{s.model ? ` · ${s.model}` : ""} <span className="text-text/40">(sub)</span>
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                ))}
              </div>

              {/* Conexões */}
              {plan.connections.length > 0 && (
                <div>
                  <div className="mb-1 text-[10px] uppercase tracking-wider text-textMuted">{t("pipe.connections", "Conexões")}</div>
                  <div className="flex flex-wrap gap-1">
                    {plan.connections.map((c, i) => (
                      <span key={i} className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-text/80" title={c.why}>
                        {c.from} <span className="text-brand">→</span> {c.to}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Caminho crítico */}
              {plan.criticalPath.length > 0 && (
                <div className="text-[11px]">
                  <span className="font-semibold text-text/80">{t("pipe.critical", "Caminho crítico")}:</span>{" "}
                  <span className="font-mono text-orange-300">{plan.criticalPath.join(" → ")}</span>
                </div>
              )}

              {plan.collaboration && (
                <p className="text-[11px] leading-snug text-text/60"><span className="font-semibold text-text/80">{t("pipe.collab", "Colaboração")}:</span> {plan.collaboration}</p>
              )}
            </div>
          )}
        </div>

        {plan && (
          <footer className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
            <select
              value={mountAs}
              onChange={(e) => setMountAs(e.target.value as "agent" | "terminal")}
              title={t("pipe.mountAsT", "OmniAgent = nó ACP (persona por priming). Terminal = claude nativo com role via --append-system-prompt + --model do plano.")}
              className={`${sel} text-[11px]`}
            >
              <option value="agent">{t("pipe.asAgent", "montar como OmniAgent (ACP)")}</option>
              <option value="terminal">{t("pipe.asTerminal", "montar como terminal claude (role nativo)")}</option>
            </select>
            <button onClick={() => void save()} className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs text-text hover:bg-surface2">
              <Save size={13} /> {t("pipe.saveBtn", "Salvar plano")}
            </button>
            <button onClick={() => void build()} className="flex items-center gap-1.5 rounded-md bg-brand px-3 py-1.5 text-xs text-bg hover:bg-brand-hover">
              <Network size={13} /> {t("pipe.build", "Montar no canvas")}
            </button>
          </footer>
        )}
      </div>
    </div>,
    document.body,
  );
}
