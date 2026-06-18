// src/components/LlmConfigModal.tsx
//
// Config do LLM (BYOK) usado pelo Code Review (e reusável). Provider preset +
// baseUrl + apiKey + model + testar. Persiste em localStorage (key → keychain Fase 2).

import { useState } from "react";
import { createPortal } from "react-dom";
import { Cpu, X } from "lucide-react";

import { LLM_PRESETS, llmChat, llmListModels, loadLlmConfig, saveLlmConfig, type LlmConfig, type LlmProvider } from "@/lib/llm-client";
import { persistReviewConfig } from "@/lib/review-config-sync";
import { useT } from "@/lib/i18n";

interface Props {
  onClose: () => void;
  /** Embute sem backdrop/portal próprio (painel unificado Code Review IA). */
  embedded?: boolean;
}

export function LlmConfigModal({ onClose, embedded }: Props) {
  const t = useT();
  const init = loadLlmConfig();
  const [provider, setProvider] = useState<LlmProvider>(init?.provider ?? "openai");
  const [baseUrl, setBaseUrl] = useState(init?.baseUrl ?? LLM_PRESETS[0].baseUrl);
  const [apiKey, setApiKey] = useState(init?.apiKey ?? "");
  const [model, setModel] = useState(init?.model ?? "");
  const [test, setTest] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);

  async function listModels() {
    setLoadingModels(true);
    setTest(null);
    try {
      const ms = await llmListModels(current());
      setModels(ms);
      if (ms.length === 0) setTest(t("llmConfig.noModels", "nenhum modelo retornado (digite manualmente)"));
    } catch (e) {
      setTest(`✗ ${t("llmConfig.listModelsError", "listar modelos")}: ${String(e)}`);
    } finally {
      setLoadingModels(false);
    }
  }

  function applyPreset(id: string) {
    const p = LLM_PRESETS.find((x) => x.id === id);
    if (!p) return;
    setProvider(p.provider);
    setBaseUrl(p.baseUrl);
    if (!model) setModel(p.modelHint);
  }

  function current(): LlmConfig {
    return { provider, baseUrl: baseUrl.trim(), apiKey: apiKey.trim() || undefined, model: model.trim() };
  }

  async function doTest() {
    setTesting(true);
    setTest(null);
    try {
      const out = await llmChat(current(), "Você responde em 1 palavra.", "Responda apenas: ok");
      setTest(`✓ ${t("llmConfig.response", "resposta")}: ${out.slice(0, 60).trim()}`);
    } catch (e) {
      setTest(`✗ ${String(e)}`);
    } finally {
      setTesting(false);
    }
  }

  function save() {
    saveLlmConfig(current());
    void persistReviewConfig(); // espelha pro backend (Stop hook / MCP review)
    onClose();
  }

  const card = (
      <div className={embedded ? "flex flex-col" : "w-[540px] max-w-[92vw] rounded-lg border border-border bg-surface1 shadow-2xl flex flex-col"} onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center gap-2 px-4 py-2.5 border-b border-border">
          <Cpu size={15} className="text-brand" />
          <span className="text-sm font-medium text-text flex-1">{t("llmConfig.title", "LLM do Review (BYOK)")}</span>
          {!embedded && <button onClick={onClose} className="text-textMuted hover:text-text" title={t("llmConfig.close", "Fechar")}><X size={16} /></button>}
        </header>
        <div className="p-4 space-y-3">
          <div>
            <label className="text-[11px] uppercase tracking-wider text-textMuted">{t("llmConfig.provider", "Provider")}</label>
            <select
              onChange={(e) => applyPreset(e.target.value)}
              defaultValue={LLM_PRESETS.find((p) => p.provider === provider && p.baseUrl === baseUrl)?.id ?? ""}
              className="mt-1 w-full px-2 py-1.5 rounded-md text-sm bg-bg border border-border text-text focus:outline-none focus:border-brand"
            >
              <option value="">{t("llmConfig.choosePreset", "— escolher preset —")}</option>
              {LLM_PRESETS.map((p) => (<option key={p.id} value={p.id}>{p.label}</option>))}
            </select>
            <p className="mt-1 text-[10px] text-textMuted opacity-60">{t("llmConfig.apiType", "Tipo de API:")} <b>{provider}</b> (openai-compat · anthropic · ollama)</p>
          </div>
          <div>
            <label className="text-[11px] uppercase tracking-wider text-textMuted">{t("llmConfig.baseUrl", "Base URL")}</label>
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} className="mt-1 w-full px-2 py-1.5 rounded-md text-sm bg-bg border border-border text-text focus:outline-none focus:border-brand font-mono" />
          </div>
          <div>
            <label className="text-[11px] uppercase tracking-wider text-textMuted">{t("llmConfig.apiKey", "API Key")} {provider === "ollama" && <span className="opacity-50">{t("llmConfig.apiKeyOptional", "(opcional p/ Ollama local)")}</span>}</label>
            <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} type="password" placeholder={t("llmConfig.apiKeyPlaceholder", "sk-… / sua chave")} className="mt-1 w-full px-2 py-1.5 rounded-md text-sm bg-bg border border-border text-text focus:outline-none focus:border-brand font-mono" />
          </div>
          <div>
            <div className="flex items-center justify-between">
              <label className="text-[11px] uppercase tracking-wider text-textMuted">{t("llmConfig.model", "Modelo")}</label>
              <button
                onClick={() => void listModels()}
                disabled={loadingModels || !baseUrl.trim()}
                className="text-[10px] text-textMuted hover:text-brand disabled:opacity-40"
              >
                {loadingModels ? t("llmConfig.listing", "listando…") : t("llmConfig.listModels", "↻ listar modelos")}
              </button>
            </div>
            <input value={model} onChange={(e) => setModel(e.target.value)} list="llm-models" placeholder="gpt-4o / claude-sonnet-4-6 / qwen2.5-coder:7b" className="mt-1 w-full px-2 py-1.5 rounded-md text-sm bg-bg border border-border text-text focus:outline-none focus:border-brand font-mono" />
            <datalist id="llm-models">
              {models.map((m) => (<option key={m} value={m} />))}
            </datalist>
            {models.length > 0 && (
              <select
                value=""
                onChange={(e) => { if (e.target.value) setModel(e.target.value); }}
                className="mt-1 w-full px-2 py-1.5 rounded-md text-xs bg-bg border border-border text-text focus:outline-none focus:border-brand"
              >
                <option value="">{t("llmConfig.chooseFromPrefix", "— escolher dos")} {models.length} {t("llmConfig.chooseFromSuffix", "modelos —")}</option>
                {models.map((m) => (<option key={m} value={m}>{m}</option>))}
              </select>
            )}
          </div>
          {test && <p className={`text-[11px] font-mono ${test.startsWith("✓") ? "text-green-400" : "text-danger"} break-words`}>{test}</p>}
        </div>
        <footer className="flex justify-between gap-2 px-4 py-3 border-t border-border">
          <button onClick={() => void doTest()} disabled={testing || !baseUrl.trim() || !model.trim()} className="px-3 py-1.5 rounded-md text-xs bg-surface2 text-text hover:text-brand border border-border disabled:opacity-40">
            {testing ? t("llmConfig.testing", "testando…") : t("llmConfig.test", "Testar")}
          </button>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-3 py-1.5 rounded-md text-xs text-textMuted hover:bg-surface2">{t("llmConfig.cancel", "Cancelar")}</button>
            <button onClick={save} disabled={!baseUrl.trim() || !model.trim()} className="px-3 py-1.5 rounded-md text-xs bg-brand text-bg hover:bg-brand-hover disabled:opacity-40">{t("llmConfig.save", "Salvar")}</button>
          </div>
        </footer>
      </div>
  );
  return embedded ? card : createPortal(
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>{card}</div>,
    document.body,
  );
}
