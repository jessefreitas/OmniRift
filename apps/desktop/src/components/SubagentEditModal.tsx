// src/components/SubagentEditModal.tsx
//
// EDITOR COMPLETO de subagente (o card raso do SubagentNode só trocava o modelo; aqui edita o
// PAPEL de verdade). Abre no evento `omnirift:edit-subagent` (botão ✎ no card). Deixa:
//   1. partir de um TEMPLATE de role (BUILTIN_ROLES) — preenche nome+persona num clique;
//   2. editar nome, papel curto (description) e a PERSONA/instruções (o role de verdade);
//   3. escolher o LLM de uma GALERIA — Claude (haiku/sonnet/opus) OU os teus providers da Central
//      (não digitar cego), com o aviso honesto de que subagente NATIVO só usa Claude/wrapper;
//   4. ver o PREVIEW do `.claude/agents/<slug>.md` que será gravado.
// Salvar → subagent_write (re-escreve o arquivo) + patchNode (atualiza o nó no canvas).
//
// UI in-DOM (WebKitGTK sem diálogo nativo): overlay próprio, fecha no X / ESC / clique fora.

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X, Save, Sparkles, Bot, Cpu, ChevronDown, ChevronRight } from "lucide-react";

import { SafeInput, SafeTextarea } from "@/components/SafeInput";
import { useCanvasStore } from "@/store/canvas-store";
import { llmProvidersList, type LlmProvider } from "@/lib/llm-providers-client";
import { BUILTIN_ROLES } from "@/lib/agent-roles";
import { notify } from "@/lib/notify";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/cn";

interface EditDetail {
  nodeId: string;
  label: string;
  description?: string;
  prompt?: string;
  model?: string;
  cwd?: string;
}

/** Modelos Claude nativos (o subagente é família-do-pai). `value` vai no frontmatter `model:`. */
const CLAUDE_MODELS: { value: string; label: string }[] = [
  { value: "", label: "Herda do pai" },
  { value: "haiku", label: "Claude Haiku · rápido e barato" },
  { value: "sonnet", label: "Claude Sonnet · equilíbrio" },
  { value: "opus", label: "Claude Opus · mais capaz" },
];

/** slug do nome (igual ao backend: [a-z0-9-]) — só pro preview do caminho. */
function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "subagente";
}

export function SubagentEditModal() {
  const t = useT();
  const patchNode = useCanvasStore((s) => s.patchNode);
  const [detail, setDetail] = useState<EditDetail | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState("");
  const [providers, setProviders] = useState<LlmProvider[]>([]);
  const [saving, setSaving] = useState(false);
  const [showPreview, setShowPreview] = useState(false);

  useEffect(() => {
    const onEdit = (e: Event) => {
      const d = (e as CustomEvent).detail as EditDetail;
      if (!d?.nodeId) return;
      setDetail(d);
      setName(d.label ?? "");
      setDescription(d.description ?? "");
      setPrompt(d.prompt ?? "");
      setModel(d.model ?? "");
      setShowPreview(false);
      // Carrega os providers da Central (galeria de LLMs) — best-effort.
      void llmProvidersList().then(setProviders).catch(() => setProviders([]));
    };
    window.addEventListener("omnirift:edit-subagent", onEdit as EventListener);
    return () => window.removeEventListener("omnirift:edit-subagent", onEdit as EventListener);
  }, []);

  useEffect(() => {
    if (!detail) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setDetail(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detail]);

  if (!detail) return null;

  /** Aplica um template de role (preenche nome + persona; não mexe no modelo). */
  function applyTemplate(roleName: string, rolePrompt: string) {
    if (!name.trim()) setName(roleName);
    setPrompt(rolePrompt);
    if (!description.trim()) setDescription(rolePrompt.split(".")[0]?.slice(0, 80) ?? "");
  }

  const isNativeModel = model === "" || ["haiku", "sonnet", "opus"].includes(model);
  const slug = slugify(name);
  const previewMd =
    `---\nname: ${slug}\ndescription: ${description || "(sem descrição)"}` +
    (model ? `\nmodel: ${model}` : "") +
    `\n---\n\n${prompt || "(sem instruções)"}\n`;

  async function save() {
    if (!detail) return;
    if (!name.trim()) {
      void notify(t("subedit.needName", "Dê um nome ao subagente."), "error");
      return;
    }
    setSaving(true);
    try {
      await invoke("subagent_write", {
        dir: detail.cwd ?? "",
        name: name.trim(),
        description: description.trim() || null,
        prompt: prompt.trim(),
        tools: null,
        model: model || null,
      });
      patchNode(detail.nodeId, {
        label: name.trim(),
        description: description.trim(),
        prompt: prompt.trim(),
        model,
      });
      void notify(t("subedit.saved", "Subagente “{n}” atualizado.").replace("{n}", name.trim()), "info");
      setDetail(null);
    } catch (e) {
      void notify(t("subedit.saveFail", "Não consegui gravar o subagente: {e}").replace("{e}", String(e)), "error");
    } finally {
      setSaving(false);
    }
  }

  const field = "w-full rounded-md border border-border bg-black/20 px-2.5 py-1.5 text-[12px] text-text outline-none focus:border-brand/60";
  const lbl = "text-[10px] font-semibold uppercase tracking-wide text-textMuted";

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setDetail(null)}>
      <div
        className="flex max-h-[88vh] w-[min(720px,94vw)] flex-col overflow-hidden rounded-lg border border-amber-500/40 bg-surface1 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <Bot size={16} className="text-amber-400" />
            <h2 className="text-sm font-semibold text-text">{t("subedit.title", "Editar subagente")}</h2>
          </div>
          <button onClick={() => setDetail(null)} className="rounded p-1 text-textMuted hover:bg-white/5 hover:text-text">
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
          {/* Templates */}
          <div>
            <div className="mb-1.5 flex items-center gap-1.5">
              <Sparkles size={12} className="text-amber-400" />
              <span className={lbl}>{t("subedit.templates", "Partir de um papel pronto")}</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {BUILTIN_ROLES.map((r) => (
                <button
                  key={r.id}
                  onClick={() => applyTemplate(r.name, r.prompt)}
                  title={r.prompt}
                  className="rounded-full border border-border px-2.5 py-1 text-[11px] text-textMuted transition-colors hover:border-amber-400/60 hover:text-text"
                >
                  {r.name}
                </button>
              ))}
            </div>
          </div>

          {/* Nome + papel curto */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={lbl}>{t("subedit.name", "Nome")}</label>
              <SafeInput value={name} onChange={(e) => setName(e.target.value)} placeholder="ex: DBA" className={cn(field, "mt-1")} />
            </div>
            <div>
              <label className={lbl}>{t("subedit.desc", "Papel curto")}</label>
              <SafeInput value={description} onChange={(e) => setDescription(e.target.value)} placeholder="ex: schema, migrations e índices" className={cn(field, "mt-1")} />
            </div>
          </div>

          {/* Persona / instruções (o role de verdade) */}
          <div>
            <label className={lbl}>{t("subedit.persona", "Instruções (a persona / o que ele faz)")}</label>
            <SafeTextarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={6}
              placeholder={t("subedit.personaPh", "Você é um DBA. Foque em schema, queries, índices, migrations… NUNCA rode operações destrutivas sem confirmação.")}
              className={cn(field, "mt-1 resize-y font-mono text-[11px] leading-relaxed")}
            />
          </div>

          {/* LLM / modelo — galeria */}
          <div>
            <div className="mb-1.5 flex items-center gap-1.5">
              <Cpu size={12} className="text-amber-400" />
              <span className={lbl}>{t("subedit.llm", "Modelo / LLM")}</span>
            </div>
            {/* Claude nativo */}
            <div className="flex flex-wrap gap-1.5">
              {CLAUDE_MODELS.map((m) => (
                <button
                  key={m.value || "inherit"}
                  onClick={() => setModel(m.value)}
                  className={cn(
                    "rounded-md border px-2.5 py-1 text-[11px] transition-colors",
                    model === m.value ? "border-amber-400 bg-amber-500/15 text-amber-200" : "border-border text-textMuted hover:text-text",
                  )}
                >
                  {m.label}
                </button>
              ))}
            </div>
            {/* Providers da Central */}
            {providers.length > 0 && (
              <>
                <div className="mt-2.5 text-[10px] text-textMuted">
                  {t("subedit.yourProviders", "Ou um dos teus providers (via wrapper compatível):")}
                </div>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {providers.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => setModel(p.model)}
                      title={`${p.kind} · ${p.model}`}
                      className={cn(
                        "rounded-md border px-2.5 py-1 text-[11px] transition-colors",
                        model === p.model ? "border-brand bg-brand/15 text-brand" : "border-border text-textMuted hover:text-text",
                      )}
                    >
                      {p.label} <span className="opacity-60">· {p.model}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
            {/* Custom livre */}
            <div className="mt-2 flex items-center gap-2">
              <span className="text-[10px] text-textMuted">{t("subedit.custom", "ou digite:")}</span>
              <SafeInput
                value={isNativeModel ? "" : model}
                onChange={(e) => setModel(e.target.value.trim())}
                placeholder="ex: glm-5.2, kimi-k2.7…"
                className={cn(field, "flex-1 py-1")}
              />
            </div>
            {!isNativeModel && model && (
              <p className="mt-1.5 rounded border border-amber-500/30 bg-amber-500/5 px-2 py-1 text-[10px] text-amber-300/90">
                {t("subedit.nativeWarn", "⚠️ Subagente nativo do Claude Code: “{m}” só funciona se o agente-pai roda via um wrapper/proxy que mapeia esse modelo (ex: claude-glm52). Pra um LLM de outro provider de verdade, use um Agente full em vez de subagente.").replace("{m}", model)}
              </p>
            )}
          </div>

          {/* Preview do arquivo */}
          <div>
            <button onClick={() => setShowPreview((v) => !v)} className="flex items-center gap-1 text-[11px] text-textMuted hover:text-text">
              {showPreview ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              {t("subedit.preview", "Ver o arquivo que será gravado")} <span className="font-mono opacity-60">.claude/agents/{slug}.md</span>
            </button>
            {showPreview && (
              <pre className="mt-1.5 max-h-40 overflow-auto rounded-md border border-border bg-black/30 p-2.5 text-[10px] leading-relaxed text-text/80">
                {previewMd}
              </pre>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          <button onClick={() => setDetail(null)} className="rounded-md px-3 py-1.5 text-[12px] text-textMuted hover:text-text">
            {t("common.cancel", "Cancelar")}
          </button>
          <button
            onClick={() => void save()}
            disabled={saving}
            className="flex items-center gap-1.5 rounded-md bg-amber-500 px-3 py-1.5 text-[12px] font-medium text-black hover:bg-amber-400 disabled:opacity-50"
          >
            <Save size={13} /> {saving ? t("subedit.saving", "Gravando…") : t("subedit.save", "Salvar subagente")}
          </button>
        </div>
      </div>
    </div>
  );
}
