// src/components/MobileDevicesModal.tsx
//
// Painel de Dispositivos móveis (Mobile steering #9). Pareia um celular (mostra o QR),
// lista os pareados, revoga e concede controle (steering). Espelha o ConnectionsModal.
// O `deviceToken`/`code` do offer é SEGREDO — nunca vai pro console nem pro innerHTML.
// O QR é renderizado via `qrcode` → dataURL num <img> (sem innerHTML, render seguro).

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import QRCode from "qrcode";
import { Copy, RefreshCw, ShieldCheck, Smartphone, Trash2, X } from "lucide-react";

import {
  humanizeLastSeen,
  mobileDevicesList,
  mobilePairingOffer,
  mobileRevoke,
  mobileSetSteering,
  type MobileDevice,
} from "@/lib/mobile-client";
import { cn } from "@/lib/cn";
import { useT } from "@/lib/i18n";
import { confirmDialog, notify } from "@/lib/notify";

interface Props {
  onClose: () => void;
}

interface PairState {
  deepLink: string;
  endpoint: string;
  qrDataUrl: string;
}

export function MobileDevicesModal({ onClose }: Props) {
  const t = useT();
  const [devices, setDevices] = useState<MobileDevice[]>([]);
  const [pair, setPair] = useState<PairState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setDevices(await mobileDevicesList());
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function startPairing() {
    setBusy("pair");
    setError(null);
    try {
      const res = await mobilePairingOffer();
      // dataURL local (offline) — sem rede, sem innerHTML. NÃO logar res.deepLink (contém o token).
      const qrDataUrl = await QRCode.toDataURL(res.deepLink, { margin: 1, width: 220 });
      setPair({ deepLink: res.deepLink, endpoint: res.offer.endpoint, qrDataUrl });
      await load(); // o offer cria/reusa um device pendente → reflete na lista
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function copyLink() {
    if (!pair) return;
    try {
      await navigator.clipboard.writeText(pair.deepLink);
      await notify(t("mobile.copied", "Link copiado"));
    } catch {
      /* clipboard off — falha silenciosa */
    }
  }

  async function copyEndpoint() {
    if (!pair) return;
    try {
      await navigator.clipboard.writeText(pair.endpoint);
    } catch {
      /* clipboard off */
    }
  }

  async function toggleSteer(d: MobileDevice) {
    const enable = !d.steer;
    if (enable) {
      const ok = await confirmDialog(
        t("mobile.steerWarn", "Permitir que este celular CONTROLE o desktop? Ele poderá criar e matar agentes remotamente."),
        t("mobile.steerWarnTitle", "Conceder controle"),
      );
      if (!ok) return;
    }
    setBusy(`steer:${d.deviceId}`);
    setError(null);
    try {
      const res = await mobileSetSteering(d.deviceId, enable);
      if (!res.applied) setError(t("mobile.deviceGone", "Device não encontrado (talvez revogado)."));
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function revoke(d: MobileDevice) {
    const ok = await confirmDialog(
      t("mobile.revokeConfirm", "Revogar este dispositivo? Ele perderá o acesso imediatamente.").replace("{name}", d.name),
      t("mobile.revokeTitle", "Revogar dispositivo"),
    );
    if (!ok) return;
    setBusy(`revoke:${d.deviceId}`);
    setError(null);
    try {
      await mobileRevoke(d.deviceId);
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="w-[640px] max-w-[94vw] max-h-[88vh] rounded-lg border border-border bg-surface1 shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-2 px-4 py-2.5 border-b border-border shrink-0">
          <Smartphone size={15} className="text-brand" />
          <span className="text-sm font-medium text-text flex-1">{t("mobile.title", "Dispositivos móveis")}</span>
          <button onClick={() => void load()} title={t("common.reload", "Recarregar")} className="text-textMuted hover:text-brand p-1">
            <RefreshCw size={14} />
          </button>
          <button onClick={onClose} className="text-textMuted hover:text-text p-1" title={t("common.close", "Fechar")}>
            <X size={16} />
          </button>
        </header>

        {error && (
          <p className="px-4 py-2 text-[11px] text-danger border-b border-border break-words">{error}</p>
        )}

        <div className="flex-1 overflow-auto p-3 space-y-3">
          {/* Parear */}
          <div className="rounded-md border border-border bg-bg/40 p-3">
            <div className="flex items-center gap-2 mb-1">
              <Smartphone size={14} className="text-brand" />
              <span className="text-sm text-text font-medium flex-1">{t("mobile.pairTitle", "Parear celular")}</span>
            </div>
            <p className="text-[11px] text-textMuted mb-2">
              {t("mobile.pairDesc", "Gere um QR e escaneie no app OmniRift do celular. O celular e o desktop precisam estar na MESMA rede local.")}
            </p>

            {!pair ? (
              <button
                onClick={() => void startPairing()}
                disabled={busy === "pair"}
                className="px-2.5 py-1 rounded text-[11px] bg-brand text-bg hover:bg-brand-hover disabled:opacity-40 transition-colors"
              >
                {busy === "pair" ? t("mobile.generating", "gerando…") : t("mobile.pairBtn", "Parear celular")}
              </button>
            ) : (
              <div className="flex flex-col sm:flex-row gap-3 items-start">
                <img
                  src={pair.qrDataUrl}
                  alt={t("mobile.qrAlt", "QR de pareamento")}
                  width={180}
                  height={180}
                  className="rounded bg-white p-1 shrink-0"
                />
                <div className="flex-1 min-w-0 space-y-2">
                  <div>
                    <div className="text-[10px] text-textMuted mb-0.5">{t("mobile.endpointLabel", "Endpoint LAN")}</div>
                    <div className="flex items-center gap-1.5">
                      <code className="text-[11px] text-text bg-bg border border-border rounded px-1.5 py-0.5 font-mono truncate flex-1">{pair.endpoint}</code>
                      <button onClick={() => void copyEndpoint()} title={t("mobile.copyEndpoint", "Copiar endpoint")} className="text-textMuted hover:text-brand p-1 shrink-0">
                        <Copy size={12} />
                      </button>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button onClick={() => void copyLink()} className="flex items-center gap-1 px-2.5 py-1 rounded text-[11px] bg-surface2 text-text hover:text-brand border border-border">
                      <Copy size={11} /> {t("mobile.copyLink", "Copiar link")}
                    </button>
                    <button onClick={() => void startPairing()} disabled={busy === "pair"} className="px-2.5 py-1 rounded text-[11px] bg-surface2 text-text hover:text-brand border border-border disabled:opacity-40">
                      {t("mobile.regen", "Gerar novo")}
                    </button>
                  </div>
                  <p className="text-[10px] text-textMuted opacity-70">{t("mobile.secretWarn", "Este código contém um segredo de pareamento — não compartilhe fora do seu celular.")}</p>
                </div>
              </div>
            )}
          </div>

          {/* Lista de devices */}
          <div className="rounded-md border border-border bg-bg/40 p-3">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-sm text-text font-medium flex-1">{t("mobile.listTitle", "Dispositivos pareados")}</span>
            </div>

            {devices.length === 0 ? (
              <p className="text-[11px] text-textMuted">{t("mobile.empty", "Nenhum dispositivo. Pareie um celular acima.")}</p>
            ) : (
              <div className="space-y-2">
                {devices.map((d) => (
                  <div key={d.deviceId} className="flex items-center gap-2 rounded border border-border bg-bg/50 px-2.5 py-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[12px] text-text font-medium truncate">{d.name}</span>
                        {d.pending ? (
                          <span className="text-[9px] text-amber-400 bg-amber-400/15 px-1.5 py-0.5 rounded shrink-0">{t("mobile.badgePending", "pendente")}</span>
                        ) : (
                          <span className="text-[9px] text-green-400 bg-green-400/15 px-1.5 py-0.5 rounded shrink-0">{t("mobile.badgeConnected", "conectado")}</span>
                        )}
                        {d.steer && (
                          <span className="flex items-center gap-0.5 text-[9px] text-brand bg-brand/15 px-1.5 py-0.5 rounded shrink-0">
                            <ShieldCheck size={9} /> {t("mobile.badgeSteer", "controle")}
                          </span>
                        )}
                      </div>
                      <div className="text-[10px] text-textMuted">{humanizeLastSeen(d.lastSeenAt, t)}</div>
                    </div>

                    <label className="flex items-center gap-1.5 cursor-pointer shrink-0" title={t("mobile.steerHint", "o celular poderá criar/matar agentes")}>
                      <input
                        type="checkbox"
                        checked={d.steer}
                        disabled={busy === `steer:${d.deviceId}`}
                        onChange={() => void toggleSteer(d)}
                        className="accent-brand"
                      />
                      <span className={cn("text-[10px]", d.steer ? "text-brand" : "text-textMuted")}>{t("mobile.allowControl", "Permitir controle")}</span>
                    </label>

                    <button
                      onClick={() => void revoke(d)}
                      disabled={busy === `revoke:${d.deviceId}`}
                      title={t("mobile.revoke", "Revogar")}
                      className="text-textMuted hover:text-danger p-1 shrink-0 disabled:opacity-40"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <footer className="px-4 py-2 border-t border-border text-[10px] text-textMuted opacity-60 shrink-0">
          {t("mobile.footer", "Conceder controle destrava criar/matar agentes pelo celular. Mantenha desligado se só quer monitorar.")}
        </footer>
      </div>
    </div>,
    document.body,
  );
}
