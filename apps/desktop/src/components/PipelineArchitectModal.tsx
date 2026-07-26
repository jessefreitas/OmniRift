// src/components/PipelineArchitectModal.tsx
//
// Arquiteto de Pipeline — descreve o projeto → um LLM da Central monta o TIME (agentes,
// subagentes, conexões, paralelos, ondas, caminho crítico). Renderiza tipo mini-canvas,
// GRAVA por projeto (revisitável) e pode MONTAR no canvas real.

import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { createPortal } from "react-dom";
import { Bot, Network, RefreshCw, Save, Sparkles, X } from "lucide-react";

import { useCanvasStore } from "@/store/canvas-store";
import { agentMcpConfig, agentSettingsConfig } from "@/lib/mcp-client";
import { agentsMdInstruction, workerClaudeArgs } from "@/lib/agent-contract";
import {
  llmProviderListModels,
  llmProvidersList,
  type LlmProvider,
} from "@/lib/llm-providers-client";
import { LLM_CATALOG } from "@/lib/llm-catalog";
import {
  generatePipelinePlan,
  generatePipelinePlanViaCli,
  omnigraphAvailable,
  omnigraphReport,
  pipelineSave,
  pipelineLoad,
  PIPELINE_CLIS,
  type PipelinePlan,
} from "@/lib/pipeline-client";
import { kanbanCardCreate } from "@/lib/kanban-client";
import { omnifsIsManagedCwd, omnifsSnapshotNow } from "@/lib/omnifs-client";
import { PIPELINE_TEMPLATES } from "@/lib/pipeline-templates";
// Aliasados: `addAgent` já existe neste componente como ação do canvas store (cria nó no
// canvas). Sem o alias, o import sequestrava as chamadas do Montar — o tsc pegou.
import {
  updateAgent as planUpdateAgent,
  removeAgent as planRemoveAgent,
  addAgent as planAddAgent,
  removeSubagent as planRemoveSubagent,
  applySetupPreset,
  effectiveAgentRuntime,
  materializeAgentSetup,
  pipelineSetupIssues,
  type PipelineSetupPreset,
} from "@/lib/pipeline-edit";
import { fitActiveFloor } from "@/lib/canvas-focus";
import { useT } from "@/lib/i18n";

const MODEL_COLORS: Record<string, string> = {
  haiku: "bg-emerald-500/20 text-emerald-300",
  sonnet: "bg-sky-500/20 text-sky-300",
  opus: "bg-purple-500/20 text-purple-300",
};

const RUNTIME_OPTIONS = [
  {
    id: "claude-terminal",
    label: "Claude Code · terminal executor",
    hint: "PTY nativo; edita arquivos e executa comandos.",
  },
  {
    id: "claude-acp",
    label: "Claude · OmniAgent coordenador",
    hint: "Sessão ACP; coordena o time sem tools de execução.",
  },
  {
    id: "codex-acp",
    label: "Codex · OmniAgent",
    hint: "Sessão ACP com login e modelos expostos pelo Codex.",
  },
  {
    id: "hermes-acp",
    label: "Hermes · LLM da Central de API",
    hint: "OpenRouter, Ollama, OpenAI, Gemini, local e outros.",
  },
] as const;

// Modo CLI local (sem chave): value do select = "__cli:<binário>". Default do modal —
// o usuário já paga a subscription do Claude Code; a Central/BYOK é opt-in, não gate.
const CLI_PREFIX = "__cli:";
const CLI_DEFAULT = `${CLI_PREFIX}claude`;

// Preferência do toggle "ancorar na arquitetura real (OmniGraph)" — persistida entre sessões.
const ANCHOR_KEY = "omnirift-pipe-anchor-arch";
/** Como montar o time. Default `terminal` (claude nativo): o modo ACP bloqueia as tools
 * de execução por design, então serve pra líder que coordena — não pro time inteiro.
 * Quem não sabe disso monta em ACP e vê agentes que não executam nada. Pedido de beta
 * tester (Eric, 18/07): "esqueço sempre que o modo ACP não é ideal pra todo o time". */
const MOUNT_AS_KEY = "omnirift-pipe-mount-as";
type MountAs = PipelineSetupPreset;
function loadMountAs(): MountAs {
  try {
    const v = localStorage.getItem(MOUNT_AS_KEY);
    if (v === "agent" || v === "terminal" || v === "hybrid") return v;
  } catch { /* localStorage off */ }
  return "terminal";
}

export function PipelineArchitectModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const currentCwd = useCanvasStore((s) => s.currentCwd) ?? "";
  const addAgent = useCanvasStore((s) => s.addAgent);
  const addEdge = useCanvasStore((s) => s.addEdge);
  const addSubagent = useCanvasStore((s) => s.addSubagent);
  const addTerminal = useCanvasStore((s) => s.addTerminal);
  const setOrchestratorSid = useCanvasStore((s) => s.setOrchestratorSid);
  // Andamento: labels dos agentes/terminais já montados em QUALQUER floor do projeto.
  // ⚠️ O seletor devolve STRING (primitiva, estável no Object.is) — devolver array novo a
  // cada render fazia o useSyncExternalStore re-renderizar em loop e TRAVAVA o app ao abrir.
  const builtLabelsKey = useCanvasStore((s) =>
    s.parallels
      .filter((p) => p.projectId === s.activeProjectId)
      .flatMap((p) => p.nodes)
      .filter((n) => n.kind === "agent" || n.kind === "terminal")
      .map((n) => ("label" in n ? (n.label ?? "") : "").toLowerCase())
      .filter(Boolean)
      .sort()
      .join("\u0000"),
  );
  const builtLabels = useMemo(() => builtLabelsKey.split("\u0000").filter(Boolean), [builtLabelsKey]);

  const [providers, setProviders] = useState<LlmProvider[]>([]);
  // Híbrido (default): líder = OmniAgent ACP (orquestrador — nasce com tools de execução
  // bloqueadas por design, só delega); executores = terminais claude com role nativo.
  // Time 100% ACP era o default antigo e produzia N coordenadores sem NINGUÉM que executa.
  const [mountAs, setMountAs] = useState<MountAs>(loadMountAs);
  const [providerId, setProviderId] = useState("");
  const [model, setModel] = useState("");
  const [desc, setDesc] = useState("");
  const [plan, setPlan] = useState<PipelinePlan | null>(null);
  const [planView, setPlanView] = useState<"structure" | "setup">("structure");
  const [modelsByProvider, setModelsByProvider] = useState<Record<string, string[]>>({});
  const [loadingModelsFor, setLoadingModelsFor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [warn, setWarn] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  // OmniGraph: só mostra o toggle se o binário/uvx existe; a preferência do toggle persiste.
  const [omnigraphOk, setOmniGraphOk] = useState(false);
  const [anchorArch, setAnchorArch] = useState(() => {
    try { return localStorage.getItem(ANCHOR_KEY) === "1"; } catch { return false; }
  });

  useEffect(() => {
    llmProvidersList().then((ps) => {
      setProviders(ps);
      // Default é SEMPRE o agente local (mesmo login dos agentes do canvas — o Arquiteto
      // é só mais um agente que constrói). Provider da Central = escolha explícita.
      setProviderId((cur) => cur || CLI_DEFAULT);
    }).catch(() => {
      setProviders([]);
      setProviderId((cur) => cur || CLI_DEFAULT);
    });
    // revisita o plano salvo do projeto
    pipelineLoad(currentCwd).then((p) => { if (p) { setPlan(p); setSavedAt(p.createdAt ?? null); } }).catch(() => {});
  }, [currentCwd]);

  // OmniGraph disponível? + preferência salva do toggle (mount-only — não depende do cwd).
  useEffect(() => {
    omnigraphAvailable().then(setOmniGraphOk).catch(() => setOmniGraphOk(false));
  }, []);

  const isCli = providerId.startsWith(CLI_PREFIX);

  async function generate() {
    if (!desc.trim() || !providerId) { setErr(t("pipe.needDesc", "descreva o projeto e escolha um provider")); return; }
    setLoading(true); setErr(null); setWarn(null);
    try {
      // Âncora de arquitetura (OmniGraph): roda/lê o knowledge graph do repo ANTES do LLM e
      // injeta o relatório destilado como archContext. É best-effort — build pode demorar
      // (minutos) e, se falhar/vier vazio, cai no modo normal com um aviso (não trava).
      let archContext: string | undefined;
      if (anchorArch && omnigraphOk && currentCwd) {
        setLoadingMsg(t("pipe.analyzing", "analisando a arquitetura do repositório… (pode levar minutos)"));
        try {
          const rep = await omnigraphReport(currentCwd);
          if (rep && rep.trim()) archContext = rep;
          else setWarn(t("pipe.archEmpty", "OmniGraph não gerou grafo — montando o time sem âncora de arquitetura."));
        } catch (e) {
          setWarn(`${t("pipe.archFail", "OmniGraph falhou — montando sem âncora de arquitetura")}: ${String(e).slice(0, 200)}`);
        }
      }
      setLoadingMsg(t("pipe.thinking", "arquitetando…"));
      // Modo CLI local: roda `claude -p` headless (sem chave); o campo modelo é
      // ignorado — quem manda é o modelo configurado no CLI/wrapper do usuário.
      const p = isCli
        // No modo local o campo "modelo" vira o CLI/wrapper (ex: claude-glm52) — quem roda
        // claude via proxy escolhe o binário; vazio = o default da opção (claude).
        ? await generatePipelinePlanViaCli(desc.trim(), model.trim() || providerId.slice(CLI_PREFIX.length), archContext)
        : await generatePipelinePlan(desc.trim(), providerId, model.trim() || undefined, archContext);
      setPlan(p);
      await pipelineSave(currentCwd, p).catch(() => {});
      setSavedAt(p.createdAt ?? Date.now());
    } catch (e) {
      const msg = String(e);
      setErr(
        isCli && msg.includes("não consegui rodar")
          ? `${msg} — ${t("pipe.cliMissing", "instale/logue o Claude Code ou escolha um provider da Central de API")}`
          : msg,
      );
    } finally {
      setLoading(false);
      setLoadingMsg(null);
    }
  }

  async function save() {
    if (!plan) return;
    const configured = materializeAgentSetup(plan, mountAs);
    setPlan(configured);
    await pipelineSave(currentCwd, configured).catch(() => {});
    setSavedAt(Date.now());
  }

  async function loadProviderModels(providerIdToLoad: string) {
    if (!providerIdToLoad) return;
    setLoadingModelsFor(providerIdToLoad);
    try {
      const models = await llmProviderListModels(providerIdToLoad);
      setModelsByProvider((cur) => ({ ...cur, [providerIdToLoad]: models }));
    } catch (e) {
      setErr(`${t("pipe.modelsFail", "não consegui listar os modelos")}: ${String(e)}`);
    } finally {
      setLoadingModelsFor(null);
    }
  }

  async function openProvidersCentral() {
    if (plan) {
      const configured = materializeAgentSetup(plan, mountAs);
      await pipelineSave(currentCwd, configured).catch(() => {});
    }
    onClose();
    window.dispatchEvent(new CustomEvent("omnirift:open-tool", { detail: "llm-providers" }));
  }

  // Monta a topologia COMPLETA no canvas: um OmniAgent (ou terminal claude com role NATIVO,
  // via toggle) por agente, COM um BRIEF COMPARTILHADO (objetivo + time + fatia + conexões +
  // trava de não-re-orquestrar) + o pontapé nos agentes de entrada, os SUBAGENTES de cada um
  // (`.claude/agents/<role>.md` com o model:), as conexões, o MODELO sugerido do plano nos
  // principais (providerConfig / --model) e os FLOORS REAIS: cada paralelo do plano (além do
  // 1º, que fica no floor ativo) vira um Parallel próprio — nós nascem lá via targetFloorId.
  async function build() {
    if (!plan) return;
    const configuredPlan = materializeAgentSetup(plan, mountAs);
    const setupIssues = pipelineSetupIssues(configuredPlan, providers);
    if (setupIssues.length > 0) {
      setPlan(configuredPlan);
      setPlanView("setup");
      setErr(setupIssues.join(" · "));
      return;
    }
    setPlan(configuredPlan);
    await pipelineSave(currentCwd, configuredPlan).catch(() => {});
    // F3 item 1: ponto de restauração ANTES de montar o time. Se o cwd do projeto
    // está num mount OmniFS vivo, tira um snapshot pré-onda — toda montagem de time
    // fica revertível (o time inteiro pode mexer no drive). Falha silenciosa se não
    // for mount OmniFS: NÃO bloqueia o Montar.
    if (currentCwd) {
      try {
        if (await omnifsIsManagedCwd(currentCwd)) {
          await omnifsSnapshotNow(`pré-montagem: ${plan.summary.slice(0, 160)}`);
        }
      } catch {
        /* snapshot é best-effort — nunca trava a montagem do time */
      }
    }
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
    const mcpPath = configuredPlan.agents.some((agent) => agent.runtime === "claude-terminal")
      ? await agentMcpConfig().catch(() => null)
      : null;

    const idByRole = new Map<string, string>();
    const floorByRole = new Map<string, string | undefined>();
    // Colunas por (floor, onda): cada floor é um canvas próprio → layout recomeça nele.
    const colByFloorWave = new Map<string, number>();
    let skippedByLimit = 0;
    // Líder = agente da MENOR onda (o Arquiteto, que "define contratos e divide o trabalho").
    // Ele vira o ORQUESTRADOR do time (persona de comando abaixo + coroa/dock via setOrchestratorSid).
    const leaderRole = [...configuredPlan.agents].sort((x, y) => (x.wave ?? 1) - (y.wave ?? 1))[0]?.role.toLowerCase();
    // ADMISSÃO POR ONDA: só a primeira onda ganha processo. As seguintes nascem
    // SUSPENSAS (card 💤, zero PTY) e o usuário religa quando a dependência entrega.
    // Antes disso a onda era só desenho — o Montar subia o time INTEIRO de uma vez
    // (11 claude em ~22s no diagnóstico do Jessé, main thread parada 1,85s).
    const firstWave = Math.min(...configuredPlan.agents.map((a) => a.wave ?? 1));
    for (const a of configuredPlan.agents) {
      const wave = a.wave ?? 1;
      const bornDormant = wave !== firstWave;
      const targetFloorId = floorIdFor(a.floor);
      const colKey = `${targetFloorId ?? "active"}:${wave}`;
      const col = colByFloorWave.get(colKey) ?? 0;
      colByFloorWave.set(colKey, col + 1);
      const x = 80 + wave * 360;
      const y = 80 + col * 240;
      const ups = upstream(a.role);
      const downs = downstream(a.role);
      const isSource = ups.length === 0; // ponto de entrada → recebe o pontapé imediato
      const isLeader = a.role.toLowerCase() === leaderRole;
      const persona = isLeader
        ? // 👑 ORQUESTRADOR: além da própria fatia, COMANDA o time (coroa/dock via setOrchestratorSid).
          `Você é o ${a.role} e o ORQUESTRADOR deste time no OmniRift. OBJETIVO DO PROJETO: ${plan.summary}\n` +
          `TIME (${plan.agents.length}): ${teamLine}.\n` +
          `Papel duplo: (1) sua fatia — ${a.why}; (2) COMANDAR o time — divida o trabalho, acione cada agente ` +
          `na vez dele, cobre as entregas e INTEGRE o resultado. As conexões do canvas disparam as ondas, mas ` +
          `VOCÊ acompanha e destrava quem travar. NÃO rode dispatch/squad/multi_agent_dispatch — coordene pelo ` +
          `canvas (Kanban + blackboard + agent_wake), que é o jeito do OmniRift.\n` +
          `KANBAN (project="${currentCwd}"): distribua e acompanhe as fatias com kanban_list/kanban_card_move/` +
          `kanban_card_note. BLACKBOARD: rode memory_recall/memory_remember pra alinhar o time. Agente dormindo ` +
          `na vez dele → agent_wake.\n` +
          `${agentsMdInstruction(a.role, anchorArch && omnigraphOk)}\n` +
          `COMECE AGORA: leia ${repoHint}, defina os contratos/arquitetura e distribua as fatias pro time.`
        : `Você faz parte de um TIME montado no OmniRift. OBJETIVO DO PROJETO: ${plan.summary}\n` +
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
        `KANBAN: existe um card seu no Kanban do projeto (tools kanban_list/kanban_card_move/kanban_card_note, ` +
        `project="${currentCwd}"). Mova seu card pra "doing" ao começar, "review" ao terminar, e registre ` +
        `progresso com kanban_card_note — é o acompanhamento visual do usuário. ` +
        `COMMIT: se você editou arquivos, faça commit da sua fatia (git add -A && git commit -m "...") ` +
        `no worktree ao concluir — sem commit não há baseline e o review_current/gate reporta "sem diff".\n` +
        // Steal #1 do deepagents — papel que APRENDE: cada role mantém seu AGENTS.md
        // (./.omnirift/agents-md/<slug>.md); lê no início, edita ao aprender algo durável.
        // F4d: time ancorado no grafo → o brief manda o papel gravar insight ESTRUTURAL da fatia.
        `${agentsMdInstruction(a.role, anchorArch && omnigraphOk)}\n` +
        (isSource
          ? `COMECE AGORA pela sua parte do objetivo acima; se faltar contexto, leia ${repoHint} antes de perguntar.`
          : `Prepare sua fatia agora lendo ${repoHint}; execute quando ${ups.join(", ")} te entregar o trabalho.`);

      let nodeId: string;
      if (a.runtime === "claude-terminal") {
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
          dormant: bornDormant,
        });
        if (!node) { skippedByLimit++; continue; } // gate de licença (máx agentes) → pula o role
        nodeId = node.id;
      } else {
        const acpProvider =
          a.runtime === "codex-acp"
            ? "codex"
            : a.runtime === "hermes-acp"
              ? "hermes"
              : "claude";
        const llmProvider = a.providerId
          ? providers.find((provider) => provider.id === a.providerId)
          : undefined;
        const effectiveModel = a.model?.trim() || llmProvider?.model?.trim() || "";
        const node = addAgent({
          label: a.role,
          persona,
          position: { x, y },
          provider: acpProvider,
          // O setup persiste só metadados. Hermes resolve credentialId no keychain do backend;
          // Claude/Codex aplicam o modelo pelo canal ACP após o ready.
          providerConfig: effectiveModel
            ? {
                provider: llmProvider?.kind ?? acpProvider,
                model: effectiveModel,
                credentialId: llmProvider?.id,
                baseUrl: llmProvider?.baseUrl,
              }
            : undefined,
          targetFloorId,
        });
        nodeId = node.id;
      }
      idByRole.set(a.role.toLowerCase(), nodeId);
      floorByRole.set(a.role.toLowerCase(), targetFloorId);
      // Semeia o Kanban do projeto: 1 card por agente/fatia no backlog (o brief manda o
      // agente movê-lo pra doing/review) — é o "diff plano×andamento" visível pro usuário.
      void kanbanCardCreate({
        project: currentCwd || "",
        title: a.role,
        body: a.why,
        agent: a.role,
        nodeId,
      }).catch(() => {});
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
    // 👑 Promove o líder (menor onda = Arquiteto) a ORQUESTRADOR: ganha a coroa + o dock e comanda
    // o time (todos já entram no canal MCP abaixo). session_id do terminal = node.id (idByRole).
    const leaderId = leaderRole ? idByRole.get(leaderRole) : undefined;
    if (leaderId) setOrchestratorSid(leaderId);
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
    // O TIME montado já entra no canal MCP (checkboxes MCP AGENTS marcadas) — o time
    // colabora, então o Orquestrador precisa poder comandá-los sem o usuário marcar 5
    // caixas na mão. Adiciona os ids ao Set (id do nó = a chave do canal p/ agent E
    // terminal, pois addTerminal usa session_id = node.id) e avisa o Sidebar re-registrar
    // (mesmo evento do fix de restore). Só os PRINCIPAIS (subagentes são privados).
    try {
      const key = "omnirift-mcp-agents";
      const cur = new Set<string>(JSON.parse(localStorage.getItem(key) ?? "[]"));
      for (const id of idByRole.values()) cur.add(id);
      localStorage.setItem(key, JSON.stringify([...cur]));
      window.dispatchEvent(new CustomEvent("omnirift:mcp-remapped"));
    } catch { /* localStorage indisponível */ }
    console.info(
      `[pipeline] Montar: ${idByRole.size} agentes (setup por agente), ${createdFloors} paralelo(s) criado(s), ` +
      `${skippedCross} conexão(ões) cross-floor pulada(s), ${skippedByLimit} agente(s) barrado(s) por licença`,
    );
    // Enquadra o time recém-montado: sem isto, agente fora do viewport ficava invisível
    // (e, antes do gate spawnedOnce no FloorCanvas, nem chegava a spawnar).
    fitActiveFloor();
    onClose();
  }

  const sel = "rounded-md border border-border bg-bg px-2 py-1.5 text-sm text-text outline-none focus:border-brand";
  const waves = plan ? [...new Set(plan.agents.map((a) => a.wave ?? 1))].sort((a, b) => a - b) : [];

  return createPortal(
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="flex max-h-[92vh] w-[1080px] max-w-[96vw] flex-col rounded-lg border border-border bg-surface1 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
          <Network size={15} className="text-brand" />
          <span className="flex-1 text-sm font-medium text-text">{t("pipe.title", "Arquiteto de Pipeline")}</span>
          {savedAt && <span className="text-[10px] text-textMuted">{t("pipe.saved", "plano salvo")} ✓</span>}
          <button onClick={onClose} className="text-textMuted hover:text-text"><X size={16} /></button>
        </header>

        <div className="flex-1 space-y-3 overflow-auto p-4">
          {/* Entrada */}
          <div className="space-y-2">
            {/* Modelos de uso PRONTOS: ⚡ = plano completo (só clicar em Montar, sem LLM);
                os demais preenchem a descrição pro LLM customizar. Onboarding de 1 clique. */}
            <div className="flex flex-wrap gap-1.5">
              {PIPELINE_TEMPLATES.map((tp) => (
                <button
                  key={tp.id}
                  onClick={() => {
                    if (tp.plan) {
                      setPlan(tp.plan);
                      setPlanView("structure");
                      setSavedAt(null);
                      setErr(null);
                    }
                    else setDesc(tp.desc);
                  }}
                  className="rounded-full border border-border bg-surface2 px-2 py-0.5 text-[11px] text-text/80 hover:border-brand hover:text-text"
                  title={tp.plan ? t("pipe.tplReady", "Plano completo pronto — revise e clique em Montar (não precisa gerar)") : tp.desc}
                >
                  {tp.emoji} {tp.label}
                </button>
              ))}
            </div>
            <textarea
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              placeholder={t("pipe.descPh", "Descreva o projeto: ex 'sistema que recebe payloads por API, uma IA lê os dados, gera um PDF e envia por email'")}
              rows={2}
              className="w-full resize-none rounded-md border border-border bg-bg px-2 py-1.5 text-sm text-text outline-none focus:border-brand"
            />
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={providerId}
                onChange={(e) => {
                  const v = e.target.value;
                  // Entrada do CATÁLOGO (sem chave salva) → não vira seleção: abre a Central
                  // de API pra cadastrar (mesma mecânica do botão ➕ abaixo).
                  if (v.startsWith("__register:")) {
                    void openProvidersCentral();
                    return;
                  }
                  setProviderId(v);
                }}
                className={sel}
              >
                {/* 1ª opção (e default sem provider salvo): CLI local headless — roda com a
                    subscription que o usuário já paga, sem chave/Central. */}
                {PIPELINE_CLIS.map((c) => (
                  <option key={c.id} value={`${CLI_PREFIX}${c.id}`}>
                    🤖 {t("pipe.cliClaude", c.label)}
                  </option>
                ))}
                {/* label pode repetir (2 chaves do mesmo provider) → sufixa modelo/kind pra distinguir */}
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}{p.model ? ` · ${p.model}` : p.kind ? ` · ${p.kind}` : ""}
                  </option>
                ))}
                {/* Catálogo completo: kinds SEM provider salvo viram atalho de cadastro. */}
                {(() => {
                  const unregistered = LLM_CATALOG.filter((c) => !providers.some((p) => p.kind === c.kind));
                  if (unregistered.length === 0) return null;
                  return (
                    <optgroup label={t("pipe.catalogGroup", "— sem chave (clique pra cadastrar) —")}>
                      {unregistered.map((c) => (
                        <option key={c.kind} value={`__register:${c.kind}`}>
                          {c.label}
                        </option>
                      ))}
                    </optgroup>
                  );
                })()}
              </select>
              <input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder={isCli ? t("pipe.cliPh", "CLI (opcional, ex: claude-glm52)") : t("pipe.model", "modelo (opcional)")}
                title={isCli ? t("pipe.modelCliT", "Qual binário roda o Arquiteto: vazio = claude; aceita wrappers (claude-glm52, …)") : undefined}
                className={`${sel} w-44 font-mono text-[11px]`}
              />
              <button onClick={() => void generate()} disabled={loading || !desc.trim() || !providerId}
                className="ml-auto flex items-center gap-1.5 rounded-md bg-brand px-3 py-1.5 text-xs text-bg hover:bg-brand-hover disabled:opacity-40">
                <Sparkles size={13} /> {loading ? (loadingMsg ?? t("pipe.thinking", "arquitetando…")) : t("pipe.generate", "Gerar plano")}
              </button>
            </div>
            {/* Âncora de arquitetura real: só aparece se o OmniGraph (binário/uvx) existe.
                Ligado → o Gerar roda o knowledge graph do repo e ancora o time nele. */}
            {omnigraphOk && (
              <label
                className="flex cursor-pointer items-center gap-1.5 text-[11px] text-text/80"
                title={t("pipe.anchorT", "Roda o OmniGraph (knowledge graph do código) e ANCORA o time na arquitetura real do repo: comunidades viram floors/agentes, god nodes viram zonas de review obrigatório, acoplamento vira conexão. O build pode levar minutos na 1ª vez.")}
              >
                <input
                  type="checkbox"
                  checked={anchorArch}
                  onChange={(e) => {
                    setAnchorArch(e.target.checked);
                    try { localStorage.setItem(ANCHOR_KEY, e.target.checked ? "1" : "0"); } catch { /* localStorage off */ }
                  }}
                />
                🧠 {t("pipe.anchorArch", "Ancorar na arquitetura real (OmniGraph)")}
              </label>
            )}
            {/* BYOK: o dropdown lista o que tem CHAVE na Central. Atalho pra cadastrar mais
                (OpenRouter, Anthropic, Gemini, …) sem caçar no menu Ferramentas. */}
            <button
              onClick={() => void openProvidersCentral()}
              className="text-[11px] text-brand hover:underline"
            >
              ➕ {t("pipe.addProvider", "cadastrar outro provider (OpenRouter, Anthropic, Gemini…) na Central de API")}
            </button>
            {/* Sem chave NÃO é bloqueio: o modo CLI local (default) já gera o plano. */}
            {providers.length === 0 && !isCli && <p className="text-[11px] text-amber-300/80">{t("pipe.noProviders", "cadastre uma chave em Ferramentas → Central de API")}</p>}
            {warn && <p className="break-words text-[11px] text-amber-300/80">⚠ {warn}</p>}
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

              <div className="flex items-center gap-1 rounded-md bg-bg/50 p-1">
                <button
                  type="button"
                  onClick={() => setPlanView("structure")}
                  className={`rounded px-3 py-1 text-[11px] ${
                    planView === "structure"
                      ? "bg-surface2 text-text shadow-sm"
                      : "text-textMuted hover:text-text"
                  }`}
                >
                  1 · {t("pipe.structureTab", "Estrutura e fluxo")}
                </button>
                <button
                  type="button"
                  onClick={() => setPlanView("setup")}
                  className={`flex items-center gap-1 rounded px-3 py-1 text-[11px] ${
                    planView === "setup"
                      ? "bg-brand/15 text-brand shadow-sm"
                      : "text-textMuted hover:text-text"
                  }`}
                >
                  <Bot size={12} /> 2 · {t("pipe.setupTab", "Setup dos agentes")}
                </button>
                <span className="ml-auto pr-2 text-[10px] text-textMuted">
                  {t("pipe.setupSavedHint", "motor e modelo são salvos com o plano")}
                </span>
              </div>

              {planView === "structure" && plan.floors.length > 1 && (
                <div className="text-[11px] text-textMuted">
                  <span className="font-semibold text-text/80">{t("pipe.floors", "Paralelos")}:</span>{" "}
                  {plan.floors.map((f) => f.name).join(" · ")}
                </div>
              )}

              {/* O plano passou a ser editável: role pode mudar, então o índice real do agente (não o role) é a chave dos cards. */}
              {planView === "structure" && <div className="flex gap-3 overflow-x-auto pb-1">
                {waves.map((w) => (
                  <div key={w} className="min-w-[210px] flex-1 space-y-1.5">
                    <div className="text-[10px] uppercase tracking-wider text-textMuted">
                      {t("pipe.wave", "onda")} {w}
                    </div>

                    {plan.agents
                      .map((a, i) => ({ a, i }))
                      .filter(({ a }) => (a.wave ?? 1) === w)
                      .map(({ a, i }) => (
                        <div key={i} className="rounded-md border border-brand/30 bg-brand/5 p-2 space-y-1.5">
                          <div className="flex items-start gap-1">
                            <input
                              type="text"
                              value={a.role}
                              onChange={(e) => setPlan(planUpdateAgent(plan, i, { role: e.target.value }))}
                              className="flex-1 rounded border border-border/60 bg-bg/40 px-1 py-0.5 text-[11px] outline-none focus:border-brand"
                            />
                            <span
                              className="max-w-[105px] truncate rounded bg-white/5 px-1.5 py-0.5 text-[9px] text-textMuted"
                              title={RUNTIME_OPTIONS.find((r) => r.id === effectiveAgentRuntime(plan, i, mountAs))?.label}
                            >
                              {RUNTIME_OPTIONS.find((r) => r.id === effectiveAgentRuntime(plan, i, mountAs))?.label}
                            </span>
                            <button
                              type="button"
                              title={t("pipe.rmAgent", "remover este agente do plano (tira também os subagentes e conexões dele)")}
                              onClick={() => setPlan(planRemoveAgent(plan, i))}
                              className="mt-0.5 text-textMuted hover:text-danger"
                            >
                              <X size={11} />
                            </button>
                          </div>

                          {plan.floors.length > 1 && (
                            <select
                              value={a.floor ?? ""}
                              onChange={(e) => setPlan(planUpdateAgent(plan, i, { floor: e.target.value || undefined }))}
                              className="w-full rounded border border-border/60 bg-bg/40 px-1 py-0.5 text-[10px] outline-none focus:border-brand"
                            >
                              <option value="">— sem paralelo —</option>
                              {plan.floors.map((f) => (
                                <option key={f.name} value={f.name}>
                                  {f.name}
                                </option>
                              ))}
                            </select>
                          )}

                          <textarea
                            rows={2}
                            value={a.why}
                            placeholder={t("pipe.whyPh", "o que este agente faz")}
                            onChange={(e) => setPlan(planUpdateAgent(plan, i, { why: e.target.value }))}
                            className="w-full resize-none rounded border border-border/60 bg-bg/40 px-1 py-0.5 text-[11px] outline-none focus:border-brand"
                          />

                          {plan.subagents
                            .filter((s) => s.parent?.toLowerCase() === a.role.toLowerCase())
                            .map((s) => (
                              <div key={s.role} className="flex items-center justify-between rounded border border-amber-500/25 bg-amber-500/5 px-1.5 py-0.5 text-[10px] text-amber-200/90">
                                <span>↳ {s.role}{s.model ? ` (${s.model})` : ""} (sub)</span>
                                <button
                                  type="button"
                                  onClick={() => setPlan(planRemoveSubagent(plan, a.role, s.role))}
                                  className="text-textMuted hover:text-danger"
                                >
                                  <X size={11} />
                                </button>
                              </div>
                            ))}
                        </div>
                      ))}

                    <button
                      type="button"
                      onClick={() => setPlan(planAddAgent(plan, w))}
                      className="w-full rounded border border-dashed border-border/50 px-1 py-1 text-[10px] text-textMuted hover:text-brand"
                    >
                      + agente
                    </button>
                  </div>
                ))}
              </div>}

              {/* Conexões */}
              {planView === "structure" && plan.connections.length > 0 && (
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
              {planView === "structure" && plan.criticalPath.length > 0 && (
                <div className="text-[11px]">
                  <span className="font-semibold text-text/80">{t("pipe.critical", "Caminho crítico")}:</span>{" "}
                  <span className="font-mono text-orange-300">{plan.criticalPath.join(" → ")}</span>
                </div>
              )}

              {planView === "structure" && plan.collaboration && (
                <p className="text-[11px] leading-snug text-text/60"><span className="font-semibold text-text/80">{t("pipe.collab", "Colaboração")}:</span> {plan.collaboration}</p>
              )}

              {planView === "setup" && (
                <div className="space-y-2.5">
                  <div className="flex flex-wrap items-center gap-2 rounded-md border border-brand/20 bg-brand/5 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="text-[12px] font-medium text-text">
                        {t("pipe.setupLead", "Escolha como cada agente vai operar")}
                      </div>
                      <div className="text-[10px] text-textMuted">
                        {t("pipe.setupExplain", "O runtime define o processo; o modelo define a inteligência. Use o preset no rodapé e ajuste as exceções aqui.")}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        void openProvidersCentral();
                      }}
                      className="shrink-0 text-[10px] text-brand hover:underline"
                    >
                      {t("pipe.manageProviders", "Gerenciar Central de API")}
                    </button>
                  </div>

                  {pipelineSetupIssues(materializeAgentSetup(plan, mountAs), providers).length > 0 && (
                    <div className="rounded-md border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-[10px] text-amber-200">
                      {pipelineSetupIssues(materializeAgentSetup(plan, mountAs), providers).join(" · ")}
                    </div>
                  )}

                  <div className="grid gap-2 md:grid-cols-2">
                    {plan.agents.map((agent, index) => {
                      const runtime = effectiveAgentRuntime(plan, index, mountAs);
                      const runtimeInfo = RUNTIME_OPTIONS.find((item) => item.id === runtime);
                      const selectedProvider = providers.find((provider) => provider.id === agent.providerId);
                      const providerModels = agent.providerId ? modelsByProvider[agent.providerId] ?? [] : [];
                      return (
                        <section
                          key={`${agent.role}-${index}`}
                          className="rounded-md border border-border bg-bg/35 p-3"
                        >
                          <div className="mb-2 flex items-start gap-2">
                            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-brand/10 text-brand">
                              <Bot size={14} />
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-[12px] font-medium text-text">{agent.role}</div>
                              <div className="line-clamp-1 text-[10px] text-textMuted" title={agent.why}>
                                {agent.why || t("pipe.noMission", "sem responsabilidade descrita")}
                              </div>
                            </div>
                            <span className="rounded bg-white/5 px-1.5 py-0.5 text-[9px] text-textMuted">
                              {t("pipe.wave", "onda")} {agent.wave ?? 1}
                            </span>
                          </div>

                          <label className="block text-[9px] uppercase tracking-wider text-textMuted">
                            {t("pipe.runtime", "Runtime / motor")}
                          </label>
                          <select
                            value={runtime}
                            onChange={(e) => {
                              const next = e.target.value as (typeof RUNTIME_OPTIONS)[number]["id"];
                              setPlan(planUpdateAgent(plan, index, {
                                runtime: next,
                                providerId: next === "hermes-acp" ? agent.providerId : undefined,
                                model: undefined,
                              }));
                            }}
                            className={`${sel} mt-1 w-full text-[11px]`}
                          >
                            {RUNTIME_OPTIONS.map((option) => (
                              <option key={option.id} value={option.id}>{option.label}</option>
                            ))}
                          </select>
                          <p className="mt-1 text-[9px] text-textMuted">{runtimeInfo?.hint}</p>

                          {runtime === "hermes-acp" && (
                            <div className="mt-2 grid grid-cols-[minmax(0,1fr)_auto] gap-1.5">
                              <select
                                value={agent.providerId ?? ""}
                                onChange={(e) => {
                                  const nextId = e.target.value || undefined;
                                  const nextProvider = providers.find((provider) => provider.id === nextId);
                                  setPlan(planUpdateAgent(plan, index, {
                                    providerId: nextId,
                                    model: nextProvider?.model || undefined,
                                  }));
                                }}
                                className={`${sel} min-w-0 text-[11px]`}
                              >
                                <option value="">{t("pipe.pickInferenceProvider", "— provider de inferência —")}</option>
                                {providers.map((provider) => (
                                  <option key={provider.id} value={provider.id}>
                                    {provider.label} · {provider.kind}{provider.hasKey ? " · chave salva" : ""}
                                  </option>
                                ))}
                              </select>
                              <button
                                type="button"
                                disabled={!agent.providerId || loadingModelsFor === agent.providerId}
                                onClick={() => void loadProviderModels(agent.providerId ?? "")}
                                title={t("pipe.listModels", "Listar modelos deste provider")}
                                className="rounded-md border border-border px-2 text-textMuted hover:border-brand hover:text-brand disabled:opacity-30"
                              >
                                <RefreshCw size={12} className={loadingModelsFor === agent.providerId ? "animate-spin" : ""} />
                              </button>
                            </div>
                          )}

                          <label className="mt-2 block text-[9px] uppercase tracking-wider text-textMuted">
                            {t("pipe.agentModel", "Modelo")}
                          </label>
                          {runtime === "claude-terminal" || runtime === "claude-acp" ? (
                            <select
                              value={agent.model ?? ""}
                              onChange={(e) => setPlan(planUpdateAgent(plan, index, { model: e.target.value || undefined }))}
                              className={`${sel} mt-1 w-full text-[11px] ${MODEL_COLORS[agent.model ?? ""] ?? ""}`}
                            >
                              <option value="">{t("pipe.defaultModel", "padrão do runtime")}</option>
                              <option value="haiku">haiku · rápido/econômico</option>
                              <option value="sonnet">sonnet · equilibrado</option>
                              <option value="opus">opus · decisão crítica</option>
                            </select>
                          ) : (
                            <>
                              <input
                                value={agent.model ?? selectedProvider?.model ?? ""}
                                list={`pipeline-models-${index}`}
                                onChange={(e) => setPlan(planUpdateAgent(plan, index, { model: e.target.value || undefined }))}
                                placeholder={
                                  runtime === "hermes-acp"
                                    ? t("pipe.hermesModelPh", "escolha ou informe o ID do modelo")
                                    : t("pipe.codexModelPh", "ID do modelo; vazio usa o padrão do login")
                                }
                                className={`${sel} mt-1 w-full font-mono text-[11px]`}
                              />
                              <datalist id={`pipeline-models-${index}`}>
                                {providerModels.map((providerModel) => (
                                  <option key={providerModel} value={providerModel} />
                                ))}
                              </datalist>
                            </>
                          )}
                        </section>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {plan && (
          <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-4 py-3">
            <span className="mr-auto text-[10px] text-textMuted">
              {plan.agents.length} {t("pipe.agentsConfigured", "agentes no setup")}
            </span>
            <select
              value={mountAs}
              onChange={(e) => {
                const v = e.target.value as MountAs;
                setMountAs(v);
                setPlan(applySetupPreset(plan, v));
                setPlanView("setup");
                // Lembra a escolha: quem troca de propósito não deve reconfigurar toda vez.
                try { localStorage.setItem(MOUNT_AS_KEY, v); } catch { /* localStorage off */ }
              }}
              title={t("pipe.mountAsT", "Aplica um preset ao time inteiro; depois você pode ajustar runtime, provider e modelo agente por agente na aba Setup.")}
              className={`${sel} text-[11px]`}
            >
              <option value="terminal">{t("pipe.asTerminal", "Preset: todos Claude terminal (executores)")}</option>
              <option value="hybrid">{t("pipe.asHybrid", "Preset: líder ACP + executores terminal")}</option>
              <option value="agent">{t("pipe.asAgent", "Preset: todos Claude ACP (coordenadores)")}</option>
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
