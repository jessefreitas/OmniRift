// src/components/BetaInviteModal.tsx
//
// Convite de beta tester (60 dias full, 1-clique). Aparece no 1º run pra quem está
// em community + fica acessível por um botão fixo. Manda email + fingerprint pro
// worker /signup/beta (via store.betaSignup) e o app vira full na hora.

import { useState } from "react";
import { createPortal } from "react-dom";
import { Rocket, Sparkles, X } from "lucide-react";

import { useLicenseStore } from "@/store/license-store";
import { useT } from "@/lib/i18n";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function BetaInviteModal() {
  const t = useT();
  const betaSignup = useLicenseStore((s) => s.betaSignup);
  const close = useLicenseStore((s) => s.closeBeta);
  const openLicense = useLicenseStore((s) => s.openLicense);
  const [email, setEmail] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const valid = EMAIL_RE.test(email.trim());

  async function join() {
    if (!valid) {
      setErr(t("beta.invalidEmail", "Digite um email válido."));
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await betaSignup(email.trim());
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[10001] flex items-center justify-center bg-black/50 p-4" onClick={close}>
      <div className="w-[460px] max-w-[94vw] rounded-xl border border-border bg-surface1 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center gap-2 px-5 py-3 border-b border-border">
          <Rocket size={16} className="text-brand" />
          <span className="text-sm font-semibold text-text flex-1">{t("beta.title", "Seja um Beta Tester")}</span>
          <button onClick={close} className="text-textMuted hover:text-text" title={t("common.close", "Fechar")}>
            <X size={16} />
          </button>
        </header>

        <div className="p-5 space-y-4">
          <div className="flex items-start gap-2 text-[13px] text-text">
            <Sparkles size={15} className="text-brand mt-0.5 shrink-0" />
            <p>{t("beta.pitch", "60 dias com TUDO liberado, de graça. Em troca, é só usar e mandar seu feedback.")}</p>
          </div>

          <div>
            <label className="text-[10px] uppercase tracking-wider text-textMuted">{t("beta.emailLabel", "Seu email")}</label>
            <div className="flex items-center gap-2 mt-1">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && valid && !busy) join();
                }}
                placeholder={t("beta.emailPlaceholder", "voce@exemplo.com")}
                className="flex-1 px-2 py-1.5 rounded bg-bg border border-border text-[12px] text-text placeholder:text-textMuted focus:outline-none focus:border-brand"
              />
              <button
                onClick={join}
                disabled={busy || !valid}
                className="px-3 py-1.5 rounded-md text-xs whitespace-nowrap bg-brand text-bg hover:bg-brand-hover disabled:opacity-40"
              >
                {busy ? t("beta.joining", "Liberando…") : t("beta.join", "Quero testar (60 dias)")}
              </button>
            </div>
            {err && <p className="text-[11px] text-danger mt-1">{err}</p>}
          </div>

          <button onClick={openLicense} className="text-[12px] text-textMuted hover:text-brand">
            {t("beta.haveLicense", "Já tenho uma licença ›")}
          </button>
        </div>

        <footer className="px-5 py-2.5 border-t border-border text-[10px] text-textMuted opacity-70">
          {t("beta.footer", "Sem cartão. Ativa na hora nesta máquina. Você pode comprar depois com desconto de beta tester.")}
        </footer>
      </div>
    </div>,
    document.body,
  );
}
