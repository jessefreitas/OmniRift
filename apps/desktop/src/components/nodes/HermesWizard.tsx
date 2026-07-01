import { useState, useEffect, useCallback, type MouseEvent } from "react";
import { X } from "lucide-react";
import { useT } from "@/lib/i18n";
import { hermesListModels } from "@/lib/acp-client";
import {
  llmProvidersList,
  llmProviderSave,
  llmProviderDelete,
  llmProviderResolve,
  type LlmProvider,
} from "@/lib/llm-providers-client";

type Provider = {
  id: string;
  label: string;
  baseUrl: string;
  needsKey: boolean;
  hint: string;
};

const PROVIDERS: Provider[] = [
  { id: "ollama-cloud", label: "Ollama Cloud", baseUrl: "https://ollama.com/v1", needsKey: true, hint: "API Ollama Cloud (ollama.com)" },
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", needsKey: true, hint: "aggregator — centenas de modelos" },
  { id: "local", label: "Local (LM Studio / Ollama)", baseUrl: "http://127.0.0.1:1234/v1", needsKey: false, hint: "roda offline, sem key" },
];

export interface HermesProviderConfig {
  provider: string;
  model: string;
  key: string;
  baseUrl?: string;
}

export function HermesWizard({
  onDone,
  onCancel,
}: {
  onDone: (cfg: HermesProviderConfig) => void;
  onCancel?: () => void;
}) {
  const t = useT();

  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [provider, setProvider] = useState<Provider | null>(null);
  const [key, setKey] = useState<string>("");
  const [models, setModels] = useState<string[]>([]);
  const [search, setSearch] = useState<string>("");
  const [manualModel, setManualModel] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<boolean>(false);
  // Central de Providers: as chaves já cadastradas (uma vez) — selecionar em vez de re-colar.
  const [saved, setSaved] = useState<LlmProvider[]>([]);
  const reloadSaved = useCallback(() => {
    llmProvidersList().then(setSaved).catch(() => setSaved([]));
  }, []);
  useEffect(() => {
    reloadSaved();
  }, [reloadSaved]);

  const fetchModels = useCallback(async (p: Provider, k: string) => {
    setLoading(true);
    setError(false);
    try {
      const list = await hermesListModels(p.id, p.needsKey ? k : "", p.baseUrl);
      setModels(list ?? []);
    } catch {
      setError(true);
      setModels([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleSelectProvider = useCallback((p: Provider) => {
    setProvider(p);
    setKey("");
    setModels([]);
    setSearch("");
    setManualModel("");
    setError(false);

    if (p.needsKey) {
      setStep(2);
    } else {
      setStep(3);
      void fetchModels(p, "");
    }
  }, [fetchModels]);

  const handleContinueFromKey = useCallback(() => {
    if (!provider || !provider.needsKey || key.trim() === "") return;
    // Central de Providers: salva a chave UMA vez (upsert por kind) → reusável em qualquer lugar.
    void llmProviderSave(
      { id: provider.id, label: provider.label, kind: provider.id, baseUrl: provider.baseUrl, model: "" },
      key.trim(),
    ).then(reloadSaved).catch(() => {});
    setStep(3);
    void fetchModels(provider, key.trim());
  }, [fetchModels, provider, key, reloadSaved]);

  // Selecionar um provider JÁ salvo: resolve a chave (keychain) → pula direto pro modelo.
  const handleSelectSaved = useCallback(
    async (sp: LlmProvider) => {
      try {
        const r = await llmProviderResolve(sp.id);
        const syn: Provider = { id: sp.kind, label: sp.label, baseUrl: r.baseUrl, needsKey: true, hint: sp.kind };
        setProvider(syn);
        setKey(r.key);
        setModels([]);
        setSearch("");
        setManualModel("");
        setError(false);
        setStep(3);
        void fetchModels(syn, r.key);
      } catch {
        setError(true);
      }
    },
    [fetchModels],
  );

  const handleDeleteSaved = useCallback(
    async (id: string, e: MouseEvent) => {
      e.stopPropagation();
      await llmProviderDelete(id).catch(() => {});
      reloadSaved();
    },
    [reloadSaved],
  );

  const handlePickModel = useCallback(
    (modelId: string) => {
      if (!provider) return;
      onDone({
        provider: provider.id,
        model: modelId.trim(),
        key: provider.needsKey ? key.trim() : "",
        baseUrl: provider.baseUrl,
      });
    },
    [onDone, provider, key]
  );

  const handleManualDone = useCallback(() => {
    if (!provider || manualModel.trim() === "") return;
    onDone({
      provider: provider.id,
      model: manualModel.trim(),
      key: provider.needsKey ? key.trim() : "",
      baseUrl: provider.baseUrl,
    });
  }, [onDone, provider, manualModel, key]);

  const handleBack = useCallback(() => {
    if (step === 3) {
      if (provider?.needsKey) {
        setStep(2);
      } else {
        setStep(1);
      }
    } else if (step === 2) {
      setStep(1);
    }
  }, [step, provider]);

  useEffect(() => {
    if (step === 3) {
      setSearch("");
      setManualModel("");
    }
  }, [step]);

  const filteredModels = models.filter((m) =>
    m.toLowerCase().includes(search.toLowerCase())
  );

  const actionBtn =
    "rounded bg-orange-500/15 px-2.5 py-1 text-orange-200 hover:bg-orange-500/25";

  return (
    <div className="rounded border border-orange-500/30 bg-orange-500/5 p-2.5">
      {step === 1 && (
        <div>
          {/* Central de Providers: chaves já cadastradas → seleciona em vez de re-colar */}
          {saved.length > 0 && (
            <div className="mb-2">
              <h3 className="mb-1 font-semibold text-orange-300">
                {t("hermes.saved", "Providers salvos")}
              </h3>
              <div className="space-y-1.5">
                {saved.map((sp) => (
                  <div
                    key={sp.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => void handleSelectSaved(sp)}
                    className="flex cursor-pointer items-center gap-2 rounded border border-emerald-500/20 bg-emerald-500/10 p-2 hover:bg-emerald-500/20"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm text-text">{sp.label}</div>
                      <div className="text-[11px] text-text/60">
                        {sp.kind}
                        {sp.hasKey ? " · 🔑 chave salva" : ""}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={(e) => void handleDeleteSaved(sp.id, e)}
                      title={t("hermes.removeSaved", "Remover provider salvo")}
                      className="shrink-0 rounded p-0.5 text-text/40 hover:bg-white/10 hover:text-red-300"
                    >
                      <X size={13} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
          <h3 className="mb-1 font-semibold text-orange-300">
            {saved.length > 0 ? t("hermes.step1New", "Novo provider") : t("hermes.step1", "Provider")}
          </h3>
          <div className="space-y-1.5">
            {PROVIDERS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => handleSelectProvider(p)}
                className="w-full rounded border border-orange-500/20 bg-orange-500/10 p-2 text-left hover:bg-orange-500/20"
              >
                <div className="text-sm text-text">{p.label}</div>
                <div className="text-[11px] text-text/60">{p.hint}</div>
              </button>
            ))}
          </div>
          {onCancel && (
            <div className="mt-2.5 flex justify-end">
              <button type="button" onClick={onCancel} className={actionBtn}>
                {t("cancel", "Cancelar")}
              </button>
            </div>
          )}
        </div>
      )}

      {step === 2 && provider && (
        <div>
          <h3 className="mb-1 font-semibold text-orange-300">
            {t("hermes.step2", "Sua chave (BYOK)")}
          </h3>
          <input
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={t("hermes.keyPlaceholder", "cole sua API key aqui")}
            className="w-full rounded bg-white/5 px-2 py-1 text-text outline-none"
          />
          <p className="mt-1 text-[11px] text-text/60">
            {t("hermes.keyHint", "A chave fica no app, host-gated — não vaza entre providers.")}
          </p>
          <div className="mt-2.5 flex items-center justify-between">
            <button type="button" onClick={handleBack} className={actionBtn}>
              {t("back", "Voltar")}
            </button>
            <button
              type="button"
              disabled={key.trim() === ""}
              onClick={handleContinueFromKey}
              className={`${actionBtn} disabled:opacity-50`}
            >
              {t("continue", "Continuar")}
            </button>
          </div>
          {onCancel && (
            <div className="mt-2.5 flex justify-end">
              <button type="button" onClick={onCancel} className={actionBtn}>
                {t("cancel", "Cancelar")}
              </button>
            </div>
          )}
        </div>
      )}

      {step === 3 && provider && (
        <div>
          <h3 className="mb-1 font-semibold text-orange-300">
            {t("hermes.step3", "Modelo")}
          </h3>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("hermes.searchPlaceholder", "buscar modelo…")}
            className="w-full rounded bg-white/5 px-2 py-1 text-text outline-none"
          />

          {loading && (
            <p className="mt-1 text-[11px] text-text/60">
              {t("hermes.loading", "buscando modelos…")}
            </p>
          )}

          {!loading && error && filteredModels.length === 0 && (
            <div className="mt-1.5">
              <p className="text-[11px] text-text/60">
                {t("hermes.listError", "Não foi possível listar os modelos. Digite o ID manualmente.")}
              </p>
            </div>
          )}

          {!loading && !error && filteredModels.length === 0 && models.length > 0 && (
            <p className="mt-1 text-[11px] text-text/60">
              {t("hermes.noMatches", "nenhum modelo coincide com a busca")}
            </p>
          )}

          {!loading && models.length === 0 && !error && (
            <div className="mt-1.5">
              <p className="text-[11px] text-text/60">
                {t("hermes.emptyList", "Nenhum modelo encontrado. Digite o ID manualmente.")}
              </p>
            </div>
          )}

          {filteredModels.length > 0 && (
            <div className="mt-1.5 max-h-[180px] overflow-auto rounded border border-orange-500/20">
              {filteredModels.map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => handlePickModel(m)}
                  className="block w-full truncate px-2 py-1 text-left text-sm text-text hover:bg-orange-500/15"
                >
                  {m}
                </button>
              ))}
            </div>
          )}

          {(error || models.length === 0 || (filteredModels.length === 0 && models.length > 0)) && !loading && (
            <div className="mt-1.5 flex items-center gap-1.5">
              <input
                type="text"
                value={manualModel}
                onChange={(e) => setManualModel(e.target.value)}
                placeholder={t("hermes.manualModel", "id do modelo")}
                className="w-full rounded bg-white/5 px-2 py-1 text-text outline-none"
              />
              <button
                type="button"
                disabled={manualModel.trim() === ""}
                onClick={handleManualDone}
                className={`${actionBtn} disabled:opacity-50`}
              >
                {t("use", "Usar")}
              </button>
            </div>
          )}

          <div className="mt-2.5 flex items-center justify-between">
            <button type="button" onClick={handleBack} className={actionBtn}>
              {t("back", "Voltar")}
            </button>
            {onCancel && (
              <button type="button" onClick={onCancel} className={actionBtn}>
                {t("cancel", "Cancelar")}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}