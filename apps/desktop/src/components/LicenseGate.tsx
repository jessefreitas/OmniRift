// src/components/LicenseGate.tsx
//
// LicenseHost: carrega o status da licença no boot e renderiza, sob demanda, o
// modal de Licença/Upgrade + um toast quando um limite community é atingido.
// O app NÃO é mais bloqueado — sempre roda como community (limitado); a licença
// full desbloqueia o ilimitado. Em debug o backend devolve full.

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Copy, Gift, KeyRound, Lock, RefreshCw, ShieldCheck, Sparkles, X } from "lucide-react";
import { open as openExternal } from "@tauri-apps/plugin-shell";

import { useLicenseStore, type LimitKind } from "@/store/license-store";
import { useT } from "@/lib/i18n";
import { notify } from "@/lib/notify";
import { BetaInviteModal } from "@/components/BetaInviteModal";

/** Landing de planos (upgrade Pro). `?beta=1` sinaliza o desconto de beta tester. */
const PRICING_URL = "https://omnirift.omniforge.com.br/?beta=1";

export function LicenseHost() {
  const refresh = useLicenseStore((s) => s.refresh);
  const refreshRemote = useLicenseStore((s) => s.refreshRemote);
  const loadBetaMeta = useLicenseStore((s) => s.loadBetaMeta);
  const openBeta = useLicenseStore((s) => s.openBeta);
  const showLicense = useLicenseStore((s) => s.showLicense);
  const showBeta = useLicenseStore((s) => s.showBeta);
  const limitNotice = useLicenseStore((s) => s.limitNotice);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await refresh(); // status local (Rust, offline)
      await refreshRemote(); // renova no servidor (fecha o gap pós-trial/beta)
      await loadBetaMeta();
      if (cancelled) return;
      // 1º run: community + nunca viu o convite → abre o beta uma vez.
      const seen = localStorage.getItem("beta_invite_seen");
      if (!seen && useLicenseStore.getState().status?.tier !== "full") {
        localStorage.setItem("beta_invite_seen", "1");
        openBeta();
      }
    })();
    // Renova periodicamente (6h) enquanto o app roda — pega renovações do operador.
    const id = setInterval(() => void refreshRemote(), 6 * 60 * 60 * 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [refresh, refreshRemote, loadBetaMeta, openBeta]);

  return (
    <>
      {limitNotice && <LimitNotice kind={limitNotice} />}
      {showLicense && <LicenseModal />}
      {showBeta && <BetaInviteModal />}
    </>
  );
}

/** Toast quando um limite da edição community é atingido. */
function LimitNotice({ kind }: { kind: LimitKind }) {
  const t = useT();
  const openLicense = useLicenseStore((s) => s.openLicense);
  const clearLimit = useLicenseStore((s) => s.clearLimit);
  const msg: Record<LimitKind, string> = {
    canvas: t("license.limit.canvas", "Limite da edição community: 1 canvas. Faça upgrade para ilimitado."),
    agents: t("license.limit.agents", "Limite da edição community: 5 agentes. Faça upgrade para ilimitado."),
    floors: t("license.limit.floors", "Limite da edição community: 1 paralelo. Faça upgrade para ilimitado."),
  };
  return createPortal(
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[10000] flex items-center gap-3 px-4 py-2.5 rounded-lg border border-border bg-surface1 shadow-2xl">
      <Lock size={14} className="text-brand shrink-0" />
      <span className="text-[12px] text-text">{msg[kind]}</span>
      <button onClick={openLicense} className="text-[12px] font-medium text-brand hover:underline shrink-0">
        {t("license.seePlans", "Ver planos")}
      </button>
      <button onClick={clearLimit} className="text-textMuted hover:text-text shrink-0" title={t("common.close", "Fechar")}>
        <X size={14} />
      </button>
    </div>,
    document.body,
  );
}

function Row({ label, community, full }: { label: string; community: string; full: string }) {
  return (
    <div className="grid grid-cols-3 gap-2 px-3 py-1.5 text-[12px] border-t border-border/40">
      <span className="text-textMuted">{label}</span>
      <span className="text-text tabular-nums">{community}</span>
      <span className="text-brand tabular-nums">{full}</span>
    </div>
  );
}

function LicenseModal() {
  const t = useT();
  const status = useLicenseStore((s) => s.status);
  const activate = useLicenseStore((s) => s.activate);
  const close = useLicenseStore((s) => s.closeLicense);
  const wasBeta = useLicenseStore((s) => s.wasBeta);
  const [key, setKey] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [changing, setChanging] = useState(false);
  const [justActivated, setJustActivated] = useState(false);

  const isFull = status?.tier === "full";
  const fp = status?.fingerprint ?? "";

  // A confirmação precisa ser IMPOSSÍVEL de não ver: o badge minúsculo no cabeçalho
  // passava despercebido e o beta tester colava licença em cima de licença sem saber
  // que já estava ativado.
  async function doActivate() {
    setBusy(true);
    setErr(null);
    try {
      await activate(key.trim());
      setKey("");
      setChanging(false);
      setJustActivated(true);
      void notify(t("license.activatedToast", "Licença OmniRift Full ativada"));
      setTimeout(() => setJustActivated(false), 8000);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  function copyFp() {
    navigator.clipboard?.writeText(fp);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }

  return createPortal(
    <div className="fixed inset-0 z-[10001] flex items-center justify-center bg-black/50 p-4" onClick={close}>
      <div className="w-[480px] max-w-[94vw] rounded-xl border border-border bg-surface1 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center gap-2 px-5 py-3 border-b border-border">
          <KeyRound size={16} className="text-brand" />
          <span className="text-sm font-semibold text-text flex-1">{t("license.title", "Licença OmniRift")}</span>
          <span className={"text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded " + (isFull ? "bg-brand/20 text-brand" : "bg-surface2 text-textMuted")}>
            {isFull ? t("license.tierFull", "Full") : t("license.tierCommunity", "Community")}
          </span>
          <button onClick={close} className="text-textMuted hover:text-text" title={t("common.close", "Fechar")}><X size={16} /></button>
        </header>

        <div className="p-5 space-y-4">
          {!isFull && wasBeta && (
            <div className="flex items-start gap-2 rounded-md border border-brand/40 bg-brand/10 px-3 py-2.5">
              <Gift size={15} className="text-brand mt-0.5 shrink-0" />
              <div className="flex-1">
                <p className="text-[12px] text-text">
                  {t("beta.ended", "Seu acesso beta acabou. Continue no OmniRift Pro com desconto de beta tester.")}
                </p>
                <button onClick={() => void openExternal(PRICING_URL)} className="mt-1 text-[12px] font-medium text-brand hover:underline">
                  {t("beta.upgrade", "Ver planos com desconto ›")}
                </button>
              </div>
            </div>
          )}
          {isFull ? (
            <div className="flex items-center gap-2 text-[13px] text-text">
              <Sparkles size={15} className="text-brand" />
              {t("license.fullActive", "Tudo liberado")}
              {status?.holder ? <span className="text-textMuted">· {status.holder}</span> : null}
            </div>
          ) : (
            <>
              <p className="text-[12px] text-textMuted">
                {t("license.communityIntro", "Você está na edição community (grátis). Com uma licença, tudo fica ilimitado.")}
              </p>
              <div className="rounded-md border border-border overflow-hidden">
                <div className="grid grid-cols-3 gap-2 px-3 py-1.5 text-[10px] uppercase tracking-wide text-textMuted bg-surface2/40">
                  <span></span><span>{t("license.tierCommunity", "Community")}</span><span>{t("license.tierFull", "Full")}</span>
                </div>
                <Row label={t("license.workspaces", "Workspaces")} community="1" full={t("license.unlimited", "ilimitado")} />
                <Row label={t("license.devices", "Computadores")} community="1" full="3" />
              </div>
            </>
          )}

          <div>
            <label className="text-[10px] uppercase tracking-wider text-textMuted">{t("license.machineIdLabel", "ID da máquina (fingerprint)")}</label>
            <div className="flex items-center gap-2 mt-1">
              <code className="flex-1 px-2 py-1.5 rounded bg-bg border border-border text-[12px] text-brand font-mono select-all truncate">{fp || "—"}</code>
              <button onClick={copyFp} className="text-textMuted hover:text-brand p-1.5" title={t("common.copy", "Copiar")}>
                {copied ? <Check size={14} className="text-brand" /> : <Copy size={14} />}
              </button>
            </div>
          </div>

          <>
            {/* Banner de sucesso: feedback grande e impossivel de ignorar logo apos ativar. */}
            {justActivated ? (
              <div className="border border-brand bg-brand/10 rounded-md p-3 flex items-start gap-3">
                <ShieldCheck size={16} className="text-brand shrink-0 mt-0.5" />
                <div>
                  <p className="text-[13px] font-semibold text-text">
                    {t("license.activatedTitle", "Licença Full ativada")}
                  </p>
                  {status?.holder && (
                    <p className="text-[11px] text-textMuted mt-0.5">{status.holder}</p>
                  )}
                </div>
              </div>
            ) : isFull && !changing ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Check size={13} className="text-brand" />
                  <span className="text-[12px] text-text">
                    {t("license.keyActiveLabel", "Chave ativa nesta máquina")}
                  </span>
                </div>
                {status?.exp && (
                  <p className="text-[11px] text-textMuted">
                    {t("license.validUntil", "válida até")}{" "}
                    {new Date(status.exp * 1000).toLocaleDateString()}
                  </p>
                )}
                {/* Esconde o formulario quando ativado; so abre de novo sob demanda para evitar que o usuario cole licencas seguidas sem perceber. */}
                <button
                  type="button"
                  onClick={() => { setChanging(true); setErr(null); }}
                  className="flex items-center gap-1 text-[11px] text-textMuted hover:text-brand"
                >
                  <RefreshCw size={11} />
                  {t("license.changeKey", "Trocar chave de licença")}
                </button>
              </div>
            ) : (
              <div>
                <label className="text-[10px] uppercase tracking-wider text-textMuted">
                  {t("license.keyLabel", "Chave de licença")}
                </label>
                <div className="flex items-center gap-2 mt-1">
                  <input
                    type="text"
                    value={key}
                    onChange={(e) => setKey(e.target.value)}
                    placeholder={t("license.keyPlaceholder", "cole a chave aqui…")}
                    className="flex-1 px-2 py-1.5 rounded bg-bg border border-border text-[12px] text-text font-mono placeholder:text-textMuted focus:outline-none focus:border-brand"
                  />
                  {changing && (
                    <button
                      type="button"
                      onClick={() => { setChanging(false); setKey(""); setErr(null); }}
                      className="text-[11px] text-textMuted hover:text-text"
                    >
                      {t("common.cancel", "Cancelar")}
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={busy || !key.trim()}
                    onClick={doActivate}
                    className="px-3 py-1.5 rounded-md text-xs bg-brand text-bg hover:bg-brand-hover disabled:opacity-40"
                  >
                    {busy ? t("license.activating", "Ativando…") : t("license.activate", "Ativar")}
                  </button>
                </div>
              </div>
            )}

            {err && <p className="text-[11px] text-danger mt-1">{err}</p>}
            {status?.detail && !err && <p className="text-[11px] text-textMuted mt-1">{status.detail}</p>}
          </>
        </div>

        <footer className="px-5 py-2.5 border-t border-border text-[10px] text-textMuted opacity-70">
          {t("license.footer", "Verificação offline (Ed25519). Mande seu ID da máquina pra receber a chave vinculada a ela.")}
        </footer>
      </div>
    </div>,
    document.body,
  );
}
