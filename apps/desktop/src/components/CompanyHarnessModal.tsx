import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { BookOpen, Check, KeyRound, Plus, Save, ShieldCheck, Trash2, Users, X } from "lucide-react";

import {
  companyKnowledgeDelete,
  companyKnowledgeGet,
  companyKnowledgeList,
  companyKnowledgeSave,
  type CompanyKnowledgeInput,
  type CompanyKnowledgeSummary,
  type KnowledgeKind,
} from "@/lib/company-knowledge-client";

import {
  companyServiceCredentialDelete,
  companyServiceDelete,
  companyServiceRequestDecide,
  companyServiceRequests,
  companyServiceSave,
  companyServicesList,
  type CompanyService,
  type CompanyServiceOperation,
  type CompanyServiceRequest,
  type ServiceCategory,
} from "@/lib/company-services-client";
import { useAgentRuntimeStatus, type CouncilRosterEntry } from "@/lib/agent-runtime-status";
import {
  COUNCIL_START_MODES,
  councilConveneSummary,
  councilStartKeys,
  countCouncilMembers,
  type CouncilStartMode,
} from "@/lib/council-convene";
import { notify } from "@/lib/notify";
import { insertWorkflowTemplate } from "@/lib/workflow-insert";
import {
  COUNCIL_AREAS,
  WORKFLOW_TEMPLATES,
  buildCouncilWorkflow,
  type CouncilAreaId,
} from "@/lib/workflow-templates";

const CATEGORIES: Array<{ id: ServiceCategory; label: string }> = [
  { id: "payment", label: "Pagamentos" },
  { id: "consultation", label: "Consultas" },
  { id: "process", label: "Processos" },
  { id: "proposal", label: "Propostas" },
  { id: "quote", label: "Orçamentos" },
  { id: "internal", label: "Sistema interno" },
  { id: "other", label: "Outro" },
];

const emptyOperation = (): CompanyServiceOperation => ({
  id: "",
  name: "",
  description: "",
  method: "GET",
  path: "/",
  inputSchema: { type: "object", properties: {} },
  executionMode: "catalog",
});

const emptyService = (): CompanyService => ({
  id: "",
  name: "",
  category: "consultation",
  description: "",
  baseUrl: "https://",
  authKind: "none",
  authHeader: "",
  authPrefix: "",
  credentialProject: "",
  credentialKey: "",
  enabled: true,
  operations: [],
  hasCredential: false,
});

const emptyKnowledge = (): CompanyKnowledgeInput => ({
  id: "empresa/",
  name: "",
  title: "",
  kind: "company",
  description: "",
  content: "",
  enabled: true,
});

const KNOWLEDGE_KINDS: Array<{ id: KnowledgeKind; label: string }> = [
  { id: "persona", label: "Persona" },
  { id: "council", label: "Matriz do conselho" },
  { id: "company", label: "Conhecimento da empresa" },
  { id: "policy", label: "Política" },
  { id: "playbook", label: "Playbook" },
  { id: "other", label: "Outro" },
];

type HarnessTab = "services" | "knowledge" | "approvals";

export function CompanyHarnessModal({
  onClose,
  initialTab = "services",
}: {
  onClose: () => void;
  initialTab?: HarnessTab;
}) {
  const [tab, setTab] = useState<HarnessTab>(initialTab);
  const [services, setServices] = useState<CompanyService[]>([]);
  const [knowledge, setKnowledge] = useState<CompanyKnowledgeSummary[]>([]);
  const [requests, setRequests] = useState<CompanyServiceRequest[]>([]);
  const [draft, setDraft] = useState<CompanyService>(emptyService);
  const [knowledgeDraft, setKnowledgeDraft] = useState<CompanyKnowledgeInput>(emptyKnowledge);
  const [knowledgeBuiltIn, setKnowledgeBuiltIn] = useState(false);
  const [credential, setCredential] = useState("");
  const [councilArea, setCouncilArea] = useState<CouncilAreaId>("technology");
  const [councilTopic, setCouncilTopic] = useState("");
  const [councilStartMode, setCouncilStartMode] = useState<CouncilStartMode>("brain");
  const [schemaEditor, setSchemaEditor] = useState<{ index: number; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const pendingCount = useMemo(() => requests.filter((item) => item.status === "pending").length, [requests]);

  const councilPreview = useMemo(() => {
    const built = buildCouncilWorkflow({ x: 0, y: 0 }, councilArea);
    const keys = built.nodes.map((node) => node.key);
    const memberCount = countCouncilMembers(keys);
    return {
      memberCount,
      totalAgents: built.nodes.length,
      memberKeys: keys.filter((key) => key !== "moderator" && key !== "rapporteur"),
      summary: councilConveneSummary({
        areaLabel: COUNCIL_AREAS.find((item) => item.id === councilArea)?.label ?? councilArea,
        mode: councilStartMode,
        memberCount,
        totalAgents: built.nodes.length,
      }),
    };
  }, [councilArea, councilStartMode]);

  function conveneCouncil() {
    const template = WORKFLOW_TEMPLATES.find((item) => item.id === "conselho-de-guerra");
    if (!template) return;
    const area = COUNCIL_AREAS.find((item) => item.id === councilArea);
    const startKeys = councilStartKeys(councilStartMode, councilPreview.memberKeys);
    const labelByKey = new Map(
      buildCouncilWorkflow({ x: 0, y: 0 }, councilArea).nodes.map((node) => [node.key, node.label]),
    );
    const inserted = insertWorkflowTemplate(
      {
        ...template,
        name: area?.label ?? template.name,
        build: (origin) => {
          const result = buildCouncilWorkflow(origin, councilArea);
          const topic = councilTopic.trim();
          if (!topic) return result;
          return {
            ...result,
            nodes: result.nodes.map((node) => node.key === "moderator"
              ? { ...node, persona: `${node.persona}\n\nTema inicial desta convocação: ${topic}` }
              : node),
          };
        },
      },
      { startKeys },
    );
    const entries: CouncilRosterEntry[] = Object.entries(inserted.idByKey).map(([key, nodeId]) => {
      const role = key === "moderator" ? "brain" : key === "rapporteur" ? "rapporteur" : "member";
      if (!startKeys.includes(key)) {
        useAgentRuntimeStatus.getState().reportStatus(nodeId, "idle");
      }
      return {
        nodeId,
        key,
        label: labelByKey.get(key) ?? key,
        role,
      };
    });
    useAgentRuntimeStatus.getState().setCouncilRoster({
      areaId: councilArea,
      areaLabel: area?.label ?? "Conselho",
      topic: councilTopic.trim(),
      entries,
      convenedAt: Date.now(),
    });
    void notify(`🏛️ ${councilPreview.summary}`);
    onClose();
  }

  function reload() {
    void Promise.all([companyServicesList(), companyKnowledgeList(), companyServiceRequests()])
      .then(([nextServices, nextKnowledge, nextRequests]) => {
        setServices(nextServices);
        setKnowledge(nextKnowledge);
        setRequests(nextRequests);
      })
      .catch((error) => setMessage(`✗ ${String(error)}`));
  }

  useEffect(reload, []);

  function edit(service: CompanyService) {
    setDraft(structuredClone(service));
    setCredential("");
    setMessage("");
    setTab("services");
  }

  async function editKnowledge(source: CompanyKnowledgeSummary) {
    setBusy(true);
    setMessage("");
    setTab("knowledge");
    try {
      const full = await companyKnowledgeGet(source.id);
      setKnowledgeDraft({
        id: full.id,
        name: full.name,
        title: full.title,
        kind: full.kind,
        description: full.description,
        content: full.content,
        enabled: full.enabled,
      });
      setKnowledgeBuiltIn(full.builtIn);
    } catch (error) {
      setMessage(`✗ ${String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function saveKnowledge() {
    setBusy(true);
    setMessage("");
    try {
      const saved = await companyKnowledgeSave(knowledgeDraft);
      setKnowledgeDraft({
        id: saved.id,
        name: saved.name,
        title: saved.title,
        kind: saved.kind,
        description: saved.description,
        content: saved.content,
        enabled: saved.enabled,
      });
      setKnowledgeBuiltIn(saved.builtIn);
      setMessage("✓ Base salva. Os agentes já podem consultá-la.");
      reload();
    } catch (error) {
      setMessage(`✗ ${String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function removeKnowledge() {
    if (!knowledgeDraft.id || knowledgeBuiltIn || !window.confirm(`Excluir ${knowledgeDraft.name || knowledgeDraft.id}?`)) return;
    try {
      await companyKnowledgeDelete(knowledgeDraft.id);
      setKnowledgeDraft(emptyKnowledge());
      setKnowledgeBuiltIn(false);
      reload();
    } catch (error) {
      setMessage(`✗ ${String(error)}`);
    }
  }

  function patchOperation(index: number, patch: Partial<CompanyServiceOperation>) {
    setDraft((current) => ({
      ...current,
      operations: current.operations.map((operation, i) => (i === index ? { ...operation, ...patch } : operation)),
    }));
  }

  function applySchema() {
    if (!schemaEditor) return;
    try {
      const parsed = JSON.parse(schemaEditor.text) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("o schema precisa ser um objeto JSON");
      patchOperation(schemaEditor.index, { inputSchema: parsed as Record<string, unknown> });
      setSchemaEditor(null);
      setMessage("");
    } catch (error) {
      setMessage(`✗ JSON Schema inválido: ${String(error)}`);
    }
  }

  async function save() {
    setBusy(true);
    setMessage("");
    try {
      const saved = await companyServiceSave(draft, credential.trim() || undefined);
      setDraft(structuredClone(saved));
      setCredential("");
      setMessage("✓ Serviço salvo. O contrato já está disponível para os agentes.");
      reload();
    } catch (error) {
      setMessage(`✗ ${String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!draft.id || !window.confirm(`Excluir ${draft.name || draft.id}?`)) return;
    await companyServiceDelete(draft.id);
    setDraft(emptyService());
    setCredential("");
    reload();
  }

  async function removeCredential() {
    if (!draft.id) return;
    await companyServiceCredentialDelete(draft.id);
    setDraft((current) => ({ ...current, hasCredential: false }));
    setMessage("Credencial removida do keychain.");
    reload();
  }

  async function decide(requestId: string, approve: boolean) {
    setBusy(true);
    setMessage(approve ? "Executando operação aprovada…" : "Negando solicitação…");
    try {
      const result = await companyServiceRequestDecide(requestId, approve);
      setMessage(approve ? `✓ Executada: HTTP ${result.httpStatus ?? "ok"}` : "Solicitação negada.");
      reload();
    } catch (error) {
      setMessage(`✗ ${String(error)}`);
      reload();
    } finally {
      setBusy(false);
    }
  }

  const input = "w-full rounded border border-border bg-bg px-2 py-1.5 text-[12px] text-text outline-none focus:border-brand";
  const label = "mb-1 block text-[10px] uppercase tracking-wide text-textMuted";

  return createPortal(
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/55 p-4" onClick={onClose}>
      <div className="flex h-[760px] max-h-[94vh] w-[1040px] max-w-[96vw] flex-col overflow-hidden rounded-xl border border-border bg-surface1 shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <header className="flex items-center gap-2 border-b border-border px-4 py-3">
          <BookOpen size={16} className="text-brand" />
          <div className="flex-1">
            <div className="text-sm font-semibold text-text">Harness Empresarial</div>
            <div className="text-[10px] text-textMuted">Conselho e APIs compartilhados pelos agentes — segredos ficam no OmniMemory/keychain</div>
          </div>
          <button onClick={onClose} className="p-1 text-textMuted hover:text-text"><X size={17} /></button>
        </header>

        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-bg/40 px-4 py-2">
          <Users size={13} className="text-brand" />
          <select value={councilArea} onChange={(event) => setCouncilArea(event.target.value as CouncilAreaId)} aria-label="Área do Conselho" className="rounded border border-border bg-bg px-2 py-1.5 text-[11px] text-text">
            {COUNCIL_AREAS.map((area) => <option key={area.id} value={area.id}>{area.label}</option>)}
          </select>
          <input value={councilTopic} onChange={(event) => setCouncilTopic(event.target.value)} maxLength={240} placeholder="Tema da reunião (opcional)" aria-label="Tema do Conselho" className="w-52 rounded border border-border bg-bg px-2 py-1.5 text-[11px] text-text placeholder:text-textMuted" />
          <div className="flex items-center gap-1 rounded border border-border bg-surface1 p-0.5" role="radiogroup" aria-label="Modo de convocação">
            {COUNCIL_START_MODES.map((mode) => (
              <button
                key={mode.id}
                type="button"
                role="radio"
                aria-checked={councilStartMode === mode.id}
                title={mode.hint}
                onClick={() => setCouncilStartMode(mode.id)}
                className={`rounded px-2 py-1 text-[10px] ${councilStartMode === mode.id ? "bg-brand/20 text-brand" : "text-textMuted hover:text-text"}`}
              >
                {mode.label}
              </button>
            ))}
          </div>
          <button onClick={conveneCouncil} className="flex items-center gap-1 rounded border border-brand/40 bg-brand/10 px-2.5 py-1.5 text-[11px] text-brand hover:bg-brand/20">
            <Users size={13} /> Reunir
          </button>
          <div className="basis-full text-[10px] leading-relaxed text-textMuted">{councilPreview.summary}</div>
        </div>

        <div className="flex border-b border-border px-4">
          <button onClick={() => setTab("services")} className={`px-3 py-2 text-xs ${tab === "services" ? "border-b-2 border-brand text-brand" : "text-textMuted"}`}>Serviços</button>
          <button onClick={() => setTab("knowledge")} className={`px-3 py-2 text-xs ${tab === "knowledge" ? "border-b-2 border-brand text-brand" : "text-textMuted"}`}>Bases ({knowledge.length})</button>
          <button onClick={() => setTab("approvals")} className={`px-3 py-2 text-xs ${tab === "approvals" ? "border-b-2 border-brand text-brand" : "text-textMuted"}`}>
            Aprovações {pendingCount > 0 && <span className="ml-1 rounded-full bg-amber-500/20 px-1.5 text-amber-300">{pendingCount}</span>}
          </button>
        </div>

        {tab === "services" ? (
          <div className="flex min-h-0 flex-1">
            <aside className="w-64 shrink-0 overflow-auto border-r border-border p-3">
              <button onClick={() => { setDraft(emptyService()); setCredential(""); }} className="mb-3 flex w-full items-center justify-center gap-1 rounded bg-brand px-2 py-1.5 text-xs text-bg">
                <Plus size={13} /> Novo serviço
              </button>
              <div className="space-y-1">
                {services.map((service) => (
                  <button key={service.id} onClick={() => edit(service)} className={`w-full rounded border px-2 py-2 text-left ${draft.id === service.id ? "border-brand bg-brand/10" : "border-border hover:bg-white/5"}`}>
                    <div className="flex items-center gap-1 text-xs font-medium text-text">
                      <span className={`h-2 w-2 rounded-full ${service.enabled ? "bg-green-400" : "bg-textMuted"}`} />
                      <span className="truncate">{service.name}</span>
                    </div>
                    <div className="mt-0.5 truncate text-[10px] text-textMuted">{CATEGORIES.find((item) => item.id === service.category)?.label} · {service.operations.length} operações</div>
                  </button>
                ))}
              </div>
            </aside>

            <main className="min-w-0 flex-1 overflow-auto p-4">
              <div className="grid grid-cols-2 gap-3">
                <label><span className={label}>ID estável</span><input className={input} value={draft.id} disabled={services.some((item) => item.id === draft.id)} placeholder="consulta-cnpj" onChange={(event) => setDraft({ ...draft, id: event.target.value })} /></label>
                <label><span className={label}>Nome</span><input className={input} value={draft.name} placeholder="Consulta de CNPJ" onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
                <label><span className={label}>Categoria</span><select className={input} value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value as ServiceCategory })}>{CATEGORIES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
                <label className="flex items-end gap-2 pb-1"><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} /><span className="text-xs text-text">Disponível para os agentes</span></label>
                <label className="col-span-2"><span className={label}>Descrição para os agentes</span><textarea className={`${input} min-h-16`} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label>
                <label className="col-span-2"><span className={label}>Base URL</span><input className={input} value={draft.baseUrl} placeholder="https://api.empresa.com/v1" onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} /></label>
                <label><span className={label}>Autenticação</span><select className={input} value={draft.authKind} onChange={(event) => setDraft({ ...draft, authKind: event.target.value as CompanyService["authKind"] })}><option value="none">Sem autenticação</option><option value="bearer">Bearer token</option><option value="header">Header custom</option></select></label>
                <label><span className={label}>Header</span><input className={input} disabled={draft.authKind !== "header"} value={draft.authHeader} placeholder="X-Api-Key" onChange={(event) => setDraft({ ...draft, authHeader: event.target.value })} /></label>
                {draft.authKind === "header" && <label className="col-span-2"><span className={label}>Prefixo do valor do header</span><input className={input} value={draft.authPrefix} placeholder="Ex.: token ou PVEAPIToken=" onChange={(event) => setDraft({ ...draft, authPrefix: event.target.value })} /></label>}
                {draft.authKind !== "none" && <>
                  <label><span className={label}>Projeto no cofre OmniMemory</span><input className={input} value={draft.credentialProject} placeholder="OmniForge" onChange={(event) => setDraft({ ...draft, credentialProject: event.target.value })} /></label>
                  <label><span className={label}>Chave no cofre OmniMemory</span><input className={input} value={draft.credentialKey} placeholder="credential.servico.api_token" onChange={(event) => setDraft({ ...draft, credentialKey: event.target.value })} /></label>
                </>}
                {draft.authKind !== "none" && <label className="col-span-2"><span className={label}>Credencial {draft.hasCredential && "(já configurada; vazio mantém)"}</span><div className="flex gap-2"><input type="password" autoComplete="new-password" className={input} value={credential} onChange={(event) => setCredential(event.target.value)} /><button onClick={() => void removeCredential()} disabled={!draft.hasCredential} title="Remover do keychain" className="rounded border border-border px-2 text-textMuted hover:text-red-300 disabled:opacity-30"><KeyRound size={14} /></button></div></label>}
              </div>

              <div className="mt-5 flex items-center gap-2">
                <ShieldCheck size={14} className="text-brand" />
                <h3 className="text-xs font-semibold text-text">Operações declaradas</h3>
                <span className="flex-1 text-[10px] text-textMuted">GET pode ser automático; mutações sempre exigem aprovação</span>
                <button onClick={() => setDraft({ ...draft, operations: [...draft.operations, emptyOperation()] })} className="flex items-center gap-1 rounded border border-border px-2 py-1 text-[11px] text-text hover:border-brand"><Plus size={11} /> Operação</button>
              </div>
              <div className="mt-2 space-y-2">
                {draft.operations.map((operation, index) => (
                  <div key={`${operation.id}-${index}`} className="rounded-lg border border-border bg-bg/40 p-3">
                    <div className="grid grid-cols-[120px_1fr_90px] gap-2">
                      <input className={input} value={operation.id} placeholder="buscar" onChange={(event) => patchOperation(index, { id: event.target.value })} />
                      <input className={input} value={operation.name} placeholder="Buscar cadastro" onChange={(event) => patchOperation(index, { name: event.target.value })} />
                      <button onClick={() => setDraft({ ...draft, operations: draft.operations.filter((_, i) => i !== index) })} className="flex items-center justify-center gap-1 rounded border border-border text-[11px] text-textMuted hover:text-red-300"><Trash2 size={11} /> remover</button>
                    </div>
                    <div className="mt-2 grid grid-cols-[90px_1fr_160px] gap-2">
                      <select className={input} value={operation.method} onChange={(event) => patchOperation(index, { method: event.target.value as CompanyServiceOperation["method"], executionMode: event.target.value === "GET" ? operation.executionMode : operation.executionMode === "auto" ? "approval" : operation.executionMode })}>{["GET", "POST", "PUT", "PATCH", "DELETE"].map((method) => <option key={method}>{method}</option>)}</select>
                      <input className={input} value={operation.path} placeholder="/companies/{cnpj}" onChange={(event) => patchOperation(index, { path: event.target.value })} />
                      <select className={input} value={operation.executionMode} onChange={(event) => patchOperation(index, { executionMode: event.target.value as CompanyServiceOperation["executionMode"] })}><option value="catalog">Só contrato</option>{operation.method === "GET" && <option value="auto">Automático</option>}<option value="approval">Pedir aprovação</option></select>
                    </div>
                    <textarea className={`${input} mt-2 min-h-12`} value={operation.description} placeholder="O que esta operação faz e quais campos espera" onChange={(event) => patchOperation(index, { description: event.target.value })} />
                    <div className="mt-2 flex items-center gap-2">
                      <button onClick={() => setSchemaEditor({ index, text: JSON.stringify(operation.inputSchema, null, 2) })} className="rounded border border-border px-2 py-1 text-[10px] text-textMuted hover:border-brand hover:text-text">Editar contrato JSON Schema</button>
                      <span className="truncate text-[10px] text-textMuted">{JSON.stringify(operation.inputSchema)}</span>
                    </div>
                    {schemaEditor?.index === index && <div className="mt-2 rounded border border-brand/30 bg-surface2 p-2">
                      <textarea className={`${input} min-h-44 font-mono`} value={schemaEditor.text} onChange={(event) => setSchemaEditor({ index, text: event.target.value })} />
                      <div className="mt-2 flex justify-end gap-2"><button onClick={() => setSchemaEditor(null)} className="rounded border border-border px-2 py-1 text-[10px] text-textMuted">Cancelar</button><button onClick={applySchema} className="rounded bg-brand px-2 py-1 text-[10px] text-bg">Aplicar schema</button></div>
                    </div>}
                  </div>
                ))}
                {draft.operations.length === 0 && <div className="rounded border border-dashed border-border p-5 text-center text-xs text-textMuted">Adicione as operações que os agentes poderão descobrir.</div>}
              </div>

              {message && <div className="mt-3 rounded border border-border bg-bg px-3 py-2 text-xs text-text">{message}</div>}
              <div className="mt-4 flex justify-end gap-2">
                {services.some((item) => item.id === draft.id) && <button onClick={() => void remove()} className="flex items-center gap-1 rounded border border-red-400/30 px-3 py-1.5 text-xs text-red-300"><Trash2 size={12} /> Excluir</button>}
                <button disabled={busy} onClick={() => void save()} className="flex items-center gap-1 rounded bg-brand px-3 py-1.5 text-xs text-bg disabled:opacity-40"><Save size={12} /> Salvar serviço</button>
              </div>
            </main>
          </div>
        ) : tab === "knowledge" ? (
          <div className="flex min-h-0 flex-1">
            <aside className="w-72 shrink-0 overflow-auto border-r border-border p-3">
              <button onClick={() => { setKnowledgeDraft(emptyKnowledge()); setKnowledgeBuiltIn(false); setMessage(""); }} className="mb-3 flex w-full items-center justify-center gap-1 rounded bg-brand px-2 py-1.5 text-xs text-bg">
                <Plus size={13} /> Nova base
              </button>
              <div className="space-y-1">
                {knowledge.map((source) => (
                  <button key={source.id} onClick={() => void editKnowledge(source)} className={`w-full rounded border px-2 py-2 text-left ${knowledgeDraft.id === source.id ? "border-brand bg-brand/10" : "border-border hover:bg-white/5"}`}>
                    <div className="flex items-center gap-1 text-xs font-medium text-text">
                      <span className={`h-2 w-2 rounded-full ${source.enabled ? "bg-green-400" : "bg-textMuted"}`} />
                      <span className="truncate">{source.name}</span>
                    </div>
                    <div className="mt-0.5 truncate text-[10px] text-textMuted">{KNOWLEDGE_KINDS.find((item) => item.id === source.kind)?.label} · {Math.ceil(source.contentBytes / 1024)} KiB{source.builtIn ? " · importada" : ""}</div>
                  </button>
                ))}
              </div>
            </aside>

            <main className="min-w-0 flex-1 overflow-auto p-4">
              <div className="mb-3 rounded border border-brand/20 bg-brand/5 p-3 text-xs text-textMuted">
                As 23 personas e 4 matrizes do Conselho de Guerra foram copiadas para o SQLite do OmniRift. O uso normal não acessa n8n nem Google Drive.
              </div>
              <div className="grid grid-cols-2 gap-3">
                <label><span className={label}>ID estável</span><input className={input} value={knowledgeDraft.id} disabled={knowledge.some((item) => item.id === knowledgeDraft.id)} placeholder="empresa/manual-comercial" onChange={(event) => setKnowledgeDraft({ ...knowledgeDraft, id: event.target.value })} /></label>
                <label><span className={label}>Tipo</span><select className={input} value={knowledgeDraft.kind} onChange={(event) => setKnowledgeDraft({ ...knowledgeDraft, kind: event.target.value as KnowledgeKind })}>{KNOWLEDGE_KINDS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
                <label><span className={label}>Nome curto</span><input className={input} value={knowledgeDraft.name} onChange={(event) => setKnowledgeDraft({ ...knowledgeDraft, name: event.target.value })} /></label>
                <label><span className={label}>Título</span><input className={input} value={knowledgeDraft.title} onChange={(event) => setKnowledgeDraft({ ...knowledgeDraft, title: event.target.value })} /></label>
                <label className="col-span-2"><span className={label}>Descrição para os agentes</span><textarea className={`${input} min-h-14`} value={knowledgeDraft.description} onChange={(event) => setKnowledgeDraft({ ...knowledgeDraft, description: event.target.value })} /></label>
                <label className="col-span-2"><span className={label}>Conteúdo da base</span><textarea className={`${input} min-h-[390px] font-mono leading-relaxed`} value={knowledgeDraft.content} onChange={(event) => setKnowledgeDraft({ ...knowledgeDraft, content: event.target.value })} /></label>
                <label className="col-span-2 flex items-center gap-2"><input type="checkbox" checked={knowledgeDraft.enabled} onChange={(event) => setKnowledgeDraft({ ...knowledgeDraft, enabled: event.target.checked })} /><span className="text-xs text-text">Disponível para os agentes</span></label>
              </div>
              {knowledgeBuiltIn && <div className="mt-3 text-[10px] text-textMuted">Base importada: pode ser editada ou desativada; não é excluída acidentalmente.</div>}
              {message && <div className="mt-3 rounded border border-border bg-bg px-3 py-2 text-xs text-text">{message}</div>}
              <div className="mt-4 flex justify-end gap-2">
                {!knowledgeBuiltIn && knowledge.some((item) => item.id === knowledgeDraft.id) && <button onClick={() => void removeKnowledge()} className="flex items-center gap-1 rounded border border-red-400/30 px-3 py-1.5 text-xs text-red-300"><Trash2 size={12} /> Excluir</button>}
                <button disabled={busy} onClick={() => void saveKnowledge()} className="flex items-center gap-1 rounded bg-brand px-3 py-1.5 text-xs text-bg disabled:opacity-40"><Save size={12} /> Salvar base</button>
              </div>
            </main>
          </div>
        ) : (
          <div className="flex-1 overflow-auto p-4">
            <div className="mb-3 rounded border border-amber-400/20 bg-amber-400/5 p-3 text-xs text-textMuted">Pagamentos, propostas enviadas, alterações de processo e qualquer operação de escrita aparecem aqui antes de sair do OmniRift.</div>
            <div className="space-y-2">
              {requests.map((request) => (
                <div key={request.id} className="rounded-lg border border-border bg-bg/40 p-3">
                  <div className="flex items-center gap-2"><span className="text-xs font-medium text-text">{request.serviceName} · {request.operationName}</span><span className={`rounded px-1.5 py-0.5 text-[10px] ${request.status === "pending" ? "bg-amber-500/15 text-amber-300" : "bg-white/5 text-textMuted"}`}>{request.status}</span><span className="ml-auto text-[10px] text-textMuted">{request.createdAt}</span></div>
                  <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-surface2 p-2 text-[10px] text-textMuted">{JSON.stringify(request.input, null, 2)}</pre>
                  {request.resultPreview && <div className="mt-2 line-clamp-3 text-[10px] text-textMuted">{request.resultPreview}</div>}
                  {request.status === "pending" && <div className="mt-2 flex justify-end gap-2"><button disabled={busy} onClick={() => void decide(request.id, false)} className="rounded border border-border px-2 py-1 text-[11px] text-textMuted">Negar</button><button disabled={busy} onClick={() => void decide(request.id, true)} className="flex items-center gap-1 rounded bg-brand px-2 py-1 text-[11px] text-bg"><Check size={11} /> Aprovar e executar</button></div>}
                </div>
              ))}
              {requests.length === 0 && <div className="p-10 text-center text-xs text-textMuted">Nenhuma solicitação de serviço.</div>}
            </div>
            {message && <div className="mt-3 text-xs text-text">{message}</div>}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
