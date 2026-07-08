import { useEffect, useState } from "react";
import { omniswitchConfigGet, omniswitchConfigSet, omniswitchHealth } from "@/lib/omniswitch-client";

/** UI mínima do OmniSwitch: edita a tabela de roteamento (JSON validado no backend) e
 *  mostra a saúde por chave. v1 é um editor JSON cru — editor visual = follow-up. */
export function OmniSwitchModal({ onClose }: { onClose: () => void }) {
  const [json, setJson] = useState("");
  const [health, setHealth] = useState<[string, boolean][]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    omniswitchConfigGet().then(setJson).catch(() => {});
    omniswitchHealth().then(setHealth).catch(() => {});
  }, []);

  async function save() {
    setErr(null);
    try {
      await omniswitchConfigSet(json);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
      setHealth(await omniswitchHealth());
    } catch (e) {
      setErr(String(e));
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="w-[720px] max-h-[80vh] overflow-auto rounded-lg border border-border bg-bg p-4" onClick={(e) => e.stopPropagation()}>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-text">OmniSwitch — roteamento de chave LLM</h2>
          <button onClick={onClose} className="text-textMuted hover:text-text">✕</button>
        </div>
        <p className="mb-2 text-[11px] text-textMuted">
          Tabela de roteamento (classes → alvos ordenados). Validada ao salvar. As chaves ficam no keychain (só o keyRef aqui).
        </p>
        <textarea
          value={json}
          onChange={(e) => setJson(e.target.value)}
          spellCheck={false}
          className="h-64 w-full rounded border border-border bg-surface p-2 font-mono text-[11px] text-text focus:outline-none focus:border-brand"
          placeholder='{"classes":{"code":[{"providerId":"groq","model":"llama-70b","keyRef":"credential.llm.groq"}]},"providers":{"groq":{"baseUrl":"https://api.groq.com","protocol":"openai"}}}'
        />
        {err && <div className="mt-1 text-[11px] text-danger">{err}</div>}
        <div className="mt-2 flex items-center gap-2">
          <button onClick={save} className="rounded bg-brand px-3 py-1 text-xs text-bg hover:bg-brand-hover">
            {saved ? "✓ salvo" : "Salvar"}
          </button>
        </div>
        <div className="mt-4">
          <h3 className="mb-1 text-[11px] font-semibold text-text">Saúde das chaves</h3>
          {health.length === 0 && <div className="text-[11px] text-textMuted opacity-60">Nenhuma chave na tabela ainda.</div>}
          {health.map(([k, ok]) => (
            <div key={k} className="flex items-center gap-2 text-[11px]">
              <span className={ok ? "text-green-400" : "text-amber-400"}>{ok ? "🟢" : "🟡"}</span>
              <span className="font-mono text-textMuted">{k}</span>
              <span className="text-textMuted opacity-60">{ok ? "disponível" : "esfriando"}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
