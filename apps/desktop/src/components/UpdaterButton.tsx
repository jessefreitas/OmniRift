// src/components/UpdaterButton.tsx
//
// Botão de auto-update no rodapé do Sidebar. Estados: buscar → checando →
// (na última versão | atualizar) → instalando(%). Em dev o check falha (build
// não assinado / sem release) → mostra "falha ao checar" no hover, sem ruído.

import { useState } from "react";
import { Check, Download, RefreshCw } from "lucide-react";
import type { Update } from "@tauri-apps/plugin-updater";

import { checkForUpdate, installUpdate, type UpdateInfo } from "@/lib/updater-client";
import { useT } from "@/lib/i18n";

type State = "idle" | "checking" | "uptodate" | "available" | "installing" | "error";

export function UpdaterButton() {
  const t = useT();
  const [state, setState] = useState<State>("idle");
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [update, setUpdate] = useState<Update | null>(null);
  const [pct, setPct] = useState(0);
  const [err, setErr] = useState("");

  async function onCheck() {
    setState("checking");
    setErr("");
    try {
      const r = await checkForUpdate();
      setInfo(r.info);
      setUpdate(r.update);
      setState(r.info.available ? "available" : "uptodate");
    } catch (e) {
      setErr(String(e));
      setState("error");
    }
  }

  async function onInstall() {
    if (!update) return;
    setState("installing");
    setPct(0);
    try {
      await installUpdate(update, setPct); // relança o app ao terminar
    } catch (e) {
      setErr(String(e));
      setState("error");
    }
  }

  if (state === "available" && info) {
    return (
      <button onClick={onInstall} className="flex items-center gap-1 text-brand hover:underline" title={info.notes ?? ""}>
        <Download size={11} /> {t("updater.available", "Atualizar para")} v{info.version}
      </button>
    );
  }
  if (state === "installing") {
    return (
      <span className="flex items-center gap-1 text-textMuted">
        <RefreshCw size={11} className="animate-spin" /> {t("updater.installing", "Instalando")} {pct}%
      </span>
    );
  }
  if (state === "uptodate") {
    return (
      <span className="flex items-center gap-1 text-textMuted">
        <Check size={11} /> {t("updater.upToDate", "Está na última versão")}
      </span>
    );
  }
  return (
    <button
      onClick={onCheck}
      className="flex items-center gap-1 text-textMuted hover:text-brand"
      title={state === "error" ? err : t("updater.checkTip", "Procurar nova versão nos releases do GitHub")}
    >
      <RefreshCw size={11} className={state === "checking" ? "animate-spin" : ""} />
      {state === "error" ? t("updater.failed", "Falha ao checar") : t("updater.check", "Buscar atualização")}
    </button>
  );
}
