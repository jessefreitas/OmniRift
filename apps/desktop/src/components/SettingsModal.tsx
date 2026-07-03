// src/components/SettingsModal.tsx
//
// Central de Configurações (estilo Cursor "General"): consolida o sprawl de ~36 modais num
// lugar só, com abas. As abas NATIVAS (Conta/Geral/Privacidade) têm conteúdo próprio; as de
// ATALHO delegam aos modais que já existem — reusam o evento `omnirift:open-tool` que a Sidebar
// já escuta (zero reescrita). A aba CONTA é a peça nova: expõe o license-store (tier, licença,
// billing) — a cara profissional que a fase de lançamento pedia. NÃO reimplementa ativação:
// "Gerenciar licença" abre o LicenseModal existente (openLicense).

import { useState } from "react";
import { createPortal } from "react-dom";
import {
  Check, Copy, ExternalLink, Flag, KeyRound, Lock, Network, Palette,
  Server, Settings as SettingsIcon, Shield, SlidersHorizontal, Sparkles, User, X,
} from "lucide-react";
import { open as openExternal } from "@tauri-apps/plugin-shell";

import { useLicenseStore } from "@/store/license-store";
import { useI18n, useT, type Locale } from "@/lib/i18n";

const PRICING_URL = "https://omnirift.omniforge.com.br/";

type TabId = "account" | "general" | "privacy";

/** Atalhos p/ modais que já existem — delega via o evento que a Sidebar escuta. */
const SHORTCUTS: { tool: string; label: string; icon: typeof Palette; desc: string }[] = [
  { tool: "appearance", label: "Aparência", icon: Palette, desc: "Cores, fontes e temas (claro/escuro + personalizado)" },
  { tool: "llm-providers", label: "Providers de IA", icon: Server, desc: "Chaves e modelos dos provedores de LLM (BYOK)" },
  { tool: "feature-flags", label: "Feature flags", icon: Flag, desc: "Liga/desliga recursos por máquina (kill-switch, beta)" },
  { tool: "connections", label: "Memória & Conexões", icon: Network, desc: "Cérebro de memória plugável (OmniMemory/Obsidian)" },
];

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [tab, setTab] = useState<TabId>("account");

  const TABS: { id: TabId; label: string; icon: typeof User }[] = [
    { id: "account", label: t("settings.account", "Conta"), icon: User },
    { id: "general", label: t("settings.general", "Geral"), icon: SlidersHorizontal },
    { id: "privacy", label: t("settings.privacy", "Privacidade"), icon: Shield },
  ];

  // Abre um modal existente e fecha o Settings (a Sidebar escuta omnirift:open-tool).
  function openTool(tool: string) {
    window.dispatchEvent(new CustomEvent("omnirift:open-tool", { detail: tool }));
    onClose();
  }

  return createPortal(
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="w-[720px] max-w-[95vw] h-[520px] max-h-[92vh] rounded-lg border border-border bg-surface1 shadow-2xl flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center gap-2 px-4 py-2.5 border-b border-border shrink-0">
          <SettingsIcon size={15} className="text-brand" />
          <span className="text-sm font-medium text-text flex-1">{t("settings.title", "Configurações")}</span>
          <button onClick={onClose} className="text-textMuted hover:text-text p-1" title={t("common.close", "Fechar")}><X size={16} /></button>
        </header>

        <div className="flex-1 flex min-h-0">
          {/* Nav esquerda */}
          <nav className="w-[176px] shrink-0 border-r border-border p-2 overflow-auto flex flex-col gap-0.5">
            {TABS.map((tb) => (
              <button
                key={tb.id}
                onClick={() => setTab(tb.id)}
                className={
                  "flex items-center gap-2 px-2.5 py-1.5 rounded text-[12px] text-left transition-colors " +
                  (tab === tb.id ? "bg-brand/15 text-brand" : "text-textMuted hover:text-text hover:bg-white/5")
                }
              >
                <tb.icon size={14} className="shrink-0" />
                {tb.label}
              </button>
            ))}
            <div className="mt-2 mb-1 px-2.5 text-[9px] uppercase tracking-wider text-textMuted/70">{t("settings.more", "Mais")}</div>
            {SHORTCUTS.map((sc) => (
              <button
                key={sc.tool}
                onClick={() => openTool(sc.tool)}
                title={sc.desc}
                className="flex items-center gap-2 px-2.5 py-1.5 rounded text-[12px] text-left text-textMuted hover:text-text hover:bg-white/5 transition-colors"
              >
                <sc.icon size={14} className="shrink-0" />
                <span className="flex-1 truncate">{sc.label}</span>
                <ExternalLink size={11} className="shrink-0 opacity-50" />
              </button>
            ))}
          </nav>

          {/* Conteúdo direita */}
          <div className="flex-1 overflow-auto p-5 text-[12px]">
            {tab === "account" && <AccountTab onClose={onClose} />}
            {tab === "general" && <GeneralTab openTool={openTool} />}
            {tab === "privacy" && <PrivacyTab />}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function AccountTab({ onClose }: { onClose: () => void }) {
  const t = useT();
  const status = useLicenseStore((s) => s.status);
  const openLicense = useLicenseStore((s) => s.openLicense);
  const [copied, setCopied] = useState(false);
  const isFull = status?.tier === "full";
  const fp = status?.fingerprint ?? "";

  function copyFp() {
    navigator.clipboard?.writeText(fp);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }
  function manage() { openLicense(); onClose(); }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-text">{t("settings.account", "Conta")}</span>
        <span className={"text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded " + (isFull ? "bg-brand/20 text-brand" : "bg-surface2 text-textMuted")}>
          {isFull ? t("license.tierFull", "Full") : t("license.tierCommunity", "Community")}
        </span>
      </div>

      {isFull ? (
        <div className="flex items-center gap-2 text-[13px] text-text">
          <Sparkles size={15} className="text-brand" />
          {t("license.fullActive", "Tudo liberado")}
          {status?.holder ? <span className="text-textMuted">· {status.holder}</span> : null}
        </div>
      ) : (
        <p className="text-[12px] text-textMuted">
          {t("settings.communityNote", "Você está na edição community (grátis). Uma licença libera tudo (workspaces ilimitados, mais computadores).")}
        </p>
      )}

      {/* Fingerprint */}
      <div>
        <label className="text-[10px] uppercase tracking-wider text-textMuted">{t("license.machineIdLabel", "ID da máquina (fingerprint)")}</label>
        <div className="flex items-center gap-2 mt-1">
          <code className="flex-1 px-2 py-1.5 rounded bg-bg border border-border text-[12px] text-brand font-mono select-all truncate">{fp || "—"}</code>
          <button onClick={copyFp} className="text-textMuted hover:text-brand p-1.5" title={t("common.copy", "Copiar")}>
            {copied ? <Check size={14} className="text-brand" /> : <Copy size={14} />}
          </button>
        </div>
      </div>

      {/* Ações */}
      <div className="flex flex-wrap gap-2 pt-1">
        <button onClick={manage} className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs bg-brand text-bg hover:bg-brand-hover">
          <KeyRound size={13} /> {t("settings.manageLicense", "Gerenciar licença")}
        </button>
        <button onClick={() => void openExternal(PRICING_URL)} className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs border border-border text-text hover:border-brand hover:text-brand">
          <ExternalLink size={13} /> {isFull ? t("settings.manageBilling", "Assinatura / faturas") : t("settings.seePlans", "Ver planos")}
        </button>
      </div>
      {status?.exp ? (
        <p className="text-[11px] text-textMuted">
          {t("settings.expLabel", "Validade")}: {new Date(status.exp * 1000).toLocaleDateString()}
        </p>
      ) : null}
    </div>
  );
}

function GeneralTab({ openTool }: { openTool: (tool: string) => void }) {
  const t = useT();
  const locale = useI18n((s) => s.locale);
  const setLocale = useI18n((s) => s.setLocale);
  return (
    <div className="space-y-4">
      <span className="text-sm font-semibold text-text">{t("settings.general", "Geral")}</span>

      <div className="flex items-center gap-2">
        <span className="text-[11px] uppercase tracking-wider text-textMuted w-20">{t("appearance.language", "Idioma")}</span>
        {(["pt", "en"] as Locale[]).map((l) => (
          <button
            key={l}
            onClick={() => setLocale(l)}
            className={"px-3 py-1 rounded border text-[11px] " + (locale === l ? "border-brand text-brand" : "border-border text-textMuted hover:text-text")}
          >
            {l === "pt" ? "Português" : "English"}
          </button>
        ))}
      </div>

      <button onClick={() => openTool("appearance")} className="flex items-center gap-2 w-full px-3 py-2 rounded-md border border-border text-left hover:border-brand transition-colors">
        <Palette size={14} className="text-brand shrink-0" />
        <span className="flex-1">
          <span className="block text-text">{t("appearance.title", "Aparência")}</span>
          <span className="block text-[11px] text-textMuted">{t("settings.appearanceDesc", "Tema, cores e fontes")}</span>
        </span>
        <ExternalLink size={12} className="text-textMuted shrink-0" />
      </button>
    </div>
  );
}

function PrivacyTab() {
  const t = useT();
  return (
    <div className="space-y-3">
      <span className="text-sm font-semibold text-text">{t("settings.privacy", "Privacidade")}</span>
      <div className="flex items-start gap-2 rounded-md border border-brand/30 bg-brand/5 px-3 py-2.5">
        <Lock size={15} className="text-brand mt-0.5 shrink-0" />
        <p className="text-[12px] text-text leading-relaxed">
          {t("settings.privacyLocal", "O OmniRift roda 100% na sua máquina. Seus prompts, código e o trabalho dos agentes NUNCA saem daqui — exceto pro provedor de LLM que VOCÊ configura. Zero telemetria, zero coleta de dados.")}
        </p>
      </div>
      <div className="flex items-start gap-2 text-[12px] text-textMuted">
        <Shield size={14} className="text-brand mt-0.5 shrink-0" />
        <p>{t("settings.privacyLurkr", "O scan de risco (Lurkr) ainda avisa se uma credencial estiver indo pro LLM no contexto — redigida, nunca exposta. Ajuste em Feature flags.")}</p>
      </div>
    </div>
  );
}
