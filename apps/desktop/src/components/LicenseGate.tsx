// src/components/LicenseGate.tsx
//
// Tela de ativação do beta: mostra o fingerprint da máquina (o usuário manda pro
// emissor) e recebe a chave. Bloqueia o app até ativar. Em debug o backend
// devolve activated:true → o gate nem aparece pra quem desenvolve.

import { useEffect, useState, type ReactNode } from "react";
import { KeyRound, Copy, Check } from "lucide-react";

import { licenseStatus, licenseActivate, type LicenseStatus } from "@/lib/license-client";
import { useT } from "@/lib/i18n";

export function LicenseGate({ children }: { children: ReactNode }) {
  const t = useT();
  const [status, setStatus] = useState<LicenseStatus | null>(null);
  const [key, setKey] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    // Se o comando falhar (ex.: backend antigo), NÃO trava — libera o app.
    licenseStatus()
      .then(setStatus)
      .catch(() => setStatus({ activated: true, fingerprint: "", holder: null, detail: null }));
  }, []);

  async function activate() {
    setBusy(true);
    setErr(null);
    try {
      setStatus(await licenseActivate(key.trim()));
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!status) return null; // carregando status
  if (status.activated) return <>{children}</>;

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-bg p-6">
      <div className="w-[460px] max-w-[94vw] rounded-xl border border-border bg-surface1 shadow-2xl p-6">
        <div className="flex items-center gap-2 mb-1">
          <KeyRound size={18} className="text-brand" />
          <h1 className="text-lg font-semibold text-text">OmniRift — Beta</h1>
        </div>
        <p className="text-[12px] text-textMuted mb-4">
          {t("license.intro1", "Acesso por chave durante o beta. Envie o seu")} <b>{t("license.machineId", "ID da máquina")}</b> {t("license.intro2", "abaixo pra receber uma chave e cole-a aqui.")}
        </p>

        <label className="text-[10px] uppercase tracking-wider text-textMuted">
          {t("license.machineIdLabel", "ID da máquina (fingerprint)")}
        </label>
        <div className="flex items-center gap-2 mt-1 mb-3">
          <code className="flex-1 px-2 py-1.5 rounded bg-bg border border-border text-[12px] text-brand font-mono select-all">
            {status.fingerprint || "—"}
          </code>
          <button
            onClick={() => {
              void navigator.clipboard.writeText(status.fingerprint);
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            }}
            className="p-1.5 rounded border border-border text-textMuted hover:text-brand"
            title={t("license.copy", "Copiar")}
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </button>
        </div>

        <label className="text-[10px] uppercase tracking-wider text-textMuted">{t("license.keyLabel", "Chave de licença")}</label>
        <textarea
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={t("license.keyPh", "cole a chave aqui…")}
          rows={3}
          className="w-full mt-1 px-2 py-1.5 rounded bg-bg border border-border text-[11px] text-text font-mono resize-none focus:outline-none focus:border-brand"
        />
        {(err || status.detail) && (
          <p className="mt-2 text-[11px] text-danger break-words">{err || status.detail}</p>
        )}
        <button
          onClick={() => void activate()}
          disabled={busy || !key.trim()}
          className="w-full mt-3 py-2 rounded-lg text-[13px] font-medium bg-brand text-bg hover:bg-brand-hover disabled:opacity-40 transition-colors"
        >
          {busy ? t("license.activating", "Ativando…") : t("license.activate", "Ativar")}
        </button>
        <p className="mt-3 text-[10px] text-textMuted opacity-60 text-center">
          {t("license.footer", "Free durante o beta · 1 chave por máquina · verificação offline.")}
        </p>
      </div>
    </div>
  );
}
