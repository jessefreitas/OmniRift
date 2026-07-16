// src/components/ProvidersCentralModal.tsx
//
// Central de API — gerencia as chaves dos providers de LLM num lugar só. Cadastra a chave
// UMA vez (fica no keychain do SO) e depois é só selecionar provider+modelo no Hermes, no
// OmniPartner e no review. Irmã da Área de Conexões (ConnectionsModal), mas p/ LLMs.

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { KeyRound, RefreshCw, Trash2, X } from "lucide-react";

import {
  llmProvidersList,
  llmProviderSave,
  llmProviderDelete,
  llmProviderListModels,
  type LlmProvider,
} from "@/lib/llm-providers-client";
import { useT } from "@/lib/i18n";

/** Presets de kind → baseUrl default (autopreenche o form ao escolher o tipo). */
const KIND_PRESETS: { kind: string; label: string; baseUrl: string; needsKey: boolean }[] = [
  { kind: "ollama-cloud", label: "Ollama Cloud", baseUrl: "https://ollama.com/v1", needsKey: true },
  { kind: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", needsKey: true },
  { kind: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", needsKey: true },
  { kind: "anthropic", label: "Anthropic", baseUrl: "https://api.anthropic.com", needsKey: true },
  { kind: "groq", label: "Groq", baseUrl: "https://api.groq.com/openai/v1", needsKey: true },
  { kind: "gemini", label: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", needsKey: true },
  { kind: "local", label: "Local (LM Studio / Ollama)", baseUrl: "http://127.0.0.1:1234/v1", needsKey: false },
];

export function ProvidersCentralModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [list, setList] = useState<LlmProvider[]>([]);
  const [editId, setEditId] = useState<string | null>(null);
  const [kind, setKind] = useState("ollama-cloud");
  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState(KIND_PRESETS[0].baseUrl);
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function reload() {
    llmProvidersList().then(setList).catch(() => setList([]));
  }
  useEffect(() => {
    let mounted = true;
    async function run() {
      try {
        const list = await llmProvidersList();
        if (!mounted) return;
        setList(list);
      } catch {
        if (!mounted) return;
        setList([]);
      }
    }
    void run();
    return () => { mounted = false; };
  }, []);

  function applyKind(k: string) {
    setKind(k);
    const p = KIND_PRESETS.find((x) => x.kind === k);
    if (p) {
      setBaseUrl(p.baseUrl);
      if (!label.trim()) setLabel(p.label);
    }
  }

  function resetForm() {
    setEditId(null);
    setKind("ollama-cloud");
    setLabel("");
    setBaseUrl(KIND_PRESETS[0].baseUrl);
    setApiKey("");
    setModel("");
    setMsg(null);
  }

  function editProvider(p: LlmProvider) {
    setEditId(p.id);
    setKind(p.kind);
    setLabel(p.label);
    setBaseUrl(p.baseUrl);
    setApiKey(""); // não trazemos a chave; vazio = mantém a existente
    setModel(p.model);
    setMsg(null);
  }

  async function save() {
    if (!kind.trim() || !baseUrl.trim()) {
      setMsg("✗ kind e baseUrl obrigatórios");
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const id = editId ?? (crypto.randomUUID?.() ?? `${kind}-${list.length}`);
      await llmProviderSave(
        { id, label: label.trim() || kind, kind, baseUrl: baseUrl.trim(), model: model.trim() },
        apiKey.trim() || undefined,
      );
      resetForm();
      reload();
    } catch (e) {
      setMsg(`✗ ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    await llmProviderDelete(id).catch(() => {});
    if (editId === id) resetForm();
    reload();
  }

  async function test(p: LlmProvider) {
    setMsg(`⏳ ${t("apiCentral.testing", "testando")} ${p.label}…`);
    try {
      const models = await llmProviderListModels(p.id);
      setMsg(`✓ ${p.label}: ${models.length} ${t("apiCentral.modelsFound", "modelos")}`);
    } catch (e) {
      setMsg(`✗ ${p.label}: ${String(e)}`);
    }
  }

  const input = "mt-1 w-full px-2 py-1.5 rounded-md text-sm bg-bg border border-border text-text focus:outline-none focus:border-brand";

  return createPortal(
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="flex max-h-[88vh] w-[560px] max-w-[92vw] flex-col rounded-lg border border-border bg-surface1 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
          <KeyRound size={15} className="text-brand" />
          <span className="flex-1 text-sm font-medium text-text">{t("apiCentral.title", "Central de API")}</span>
          <button onClick={onClose} className="text-textMuted hover:text-text"><X size={16} /></button>
        </header>

        <div className="flex-1 space-y-3 overflow-auto p-4">
          {/* Chaves cadastradas */}
          <div>
            <div className="mb-1 text-[11px] uppercase tracking-wider text-textMuted">{t("apiCentral.saved", "Chaves cadastradas")}</div>
            {list.length === 0 && (
              <p className="text-[12px] text-textMuted opacity-60">{t("apiCentral.empty", "nenhuma ainda — cadastre abaixo. A chave fica no keychain do SO.")}</p>
            )}
            <div className="space-y-1.5">
              {list.map((p) => (
                <div key={p.id} className="flex items-center gap-2 rounded-md border border-border bg-bg px-2.5 py-1.5">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-text">
                      {p.label} <span className="text-[11px] text-textMuted">· {p.kind}</span> {p.hasKey ? "· 🔑" : ""}
                    </div>
                    <div className="truncate font-mono text-[10px] text-textMuted opacity-60">{p.baseUrl}{p.model ? ` · ${p.model}` : ""}</div>
                  </div>
                  <button onClick={() => void test(p)} title={t("apiCentral.test", "Testar (listar modelos)")} className="shrink-0 rounded p-1 text-textMuted hover:bg-surface2 hover:text-brand"><RefreshCw size={13} /></button>
                  <button onClick={() => editProvider(p)} className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-textMuted hover:bg-surface2 hover:text-text">{t("apiCentral.edit", "editar")}</button>
                  <button onClick={() => void remove(p.id)} title={t("apiCentral.remove", "Remover")} className="shrink-0 rounded p-1 text-textMuted hover:bg-surface2 hover:text-danger"><Trash2 size={13} /></button>
                </div>
              ))}
            </div>
          </div>

          {/* Form add/editar */}
          <div className="rounded-md border border-border p-3">
            <div className="mb-2 text-[11px] uppercase tracking-wider text-textMuted">
              {editId ? t("apiCentral.editing", "Editando chave") : t("apiCentral.add", "Cadastrar provider")}
            </div>
            <div className="space-y-2">
              <div>
                <label className="text-[11px] text-textMuted">{t("apiCentral.kind", "Tipo")}</label>
                <select value={kind} onChange={(e) => applyKind(e.target.value)} className={input}>
                  {KIND_PRESETS.map((p) => (<option key={p.kind} value={p.kind}>{p.label}</option>))}
                </select>
              </div>
              <div>
                <label className="text-[11px] text-textMuted">{t("apiCentral.label", "Nome (apelido)")}</label>
                <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t("apiCentral.labelPh", "ex: Meu Ollama Cloud")} className={input} />
              </div>
              <div>
                <label className="text-[11px] text-textMuted">{t("apiCentral.baseUrl", "Base URL")}</label>
                <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} className={`${input} font-mono`} />
              </div>
              <div>
                <label className="text-[11px] text-textMuted">
                  {t("apiCentral.apiKey", "API Key")}{" "}
                  {editId && <span className="opacity-50">{t("apiCentral.keyKeep", "(vazio = manter atual)")}</span>}
                </label>
                <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} type="password" placeholder="sk-… / sua chave" className={`${input} font-mono`} />
              </div>
              <div>
                <label className="text-[11px] text-textMuted">{t("apiCentral.model", "Modelo default (opcional)")}</label>
                <input value={model} onChange={(e) => setModel(e.target.value)} placeholder={t("apiCentral.modelPh", "ex: kimi-k2.7-code")} className={`${input} font-mono`} />
              </div>
            </div>
            {msg && <p className={`mt-2 break-words font-mono text-[11px] ${msg.startsWith("✓") ? "text-green-400" : msg.startsWith("⏳") ? "text-textMuted" : "text-danger"}`}>{msg}</p>}
            <div className="mt-3 flex justify-end gap-2">
              {editId && <button onClick={resetForm} className="rounded-md px-3 py-1.5 text-xs text-textMuted hover:bg-surface2">{t("apiCentral.cancelEdit", "Cancelar edição")}</button>}
              <button onClick={() => void save()} disabled={busy || !baseUrl.trim()} className="rounded-md bg-brand px-3 py-1.5 text-xs text-bg hover:bg-brand-hover disabled:opacity-40">
                {busy ? t("apiCentral.saving", "salvando…") : editId ? t("apiCentral.update", "Atualizar") : t("apiCentral.saveNew", "Cadastrar")}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
