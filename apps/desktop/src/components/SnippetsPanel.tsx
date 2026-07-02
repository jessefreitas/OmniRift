// Central de copia-cola — snippet manager do USUÁRIO: texto/código/imagem
// persistentes (SQLite via snippets_*), globais e SEPARADOS do blackboard dos
// agentes. Colar 1-clique da área de transferência (texto ou imagem→PATH via
// save_paste_image), busca client-side, 📋 copiar e drag (text/plain) pros nós —
// o TerminalNode já aceita drop de texto (caminho de imagem cai como file-drop).
// Refresh ao vivo via snippets://changed.

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  ClipboardList, ClipboardPaste, X, Plus, Trash2, Copy, Check, Search,
} from "lucide-react";

import {
  snippetsList,
  snippetAdd,
  snippetDelete,
  onSnippetsChanged,
  type Snippet,
  type SnippetKind,
} from "@/lib/snippets-client";
import {
  pasteText, copyText, readClipboardPng, savePastePng,
  MAX_PASTE_BYTES, utf8ByteLength,
} from "@/lib/clipboard";
import { notify } from "@/lib/notify";
import { useT } from "@/lib/i18n";

/** Rótulo do chip de kind (i18n com fallback pt). */
const KIND_LABEL: Record<SnippetKind, { key: string; fallback: string }> = {
  text: { key: "snippets.kind.text", fallback: "texto" },
  code: { key: "snippets.kind.code", fallback: "código" },
  image: { key: "snippets.kind.image", fallback: "imagem" },
};

export function SnippetsPanel({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  // Feedback do 📋: id copiado há <1.5s mostra ✓ no lugar do ícone.
  const [copiedId, setCopiedId] = useState<number | null>(null);
  // Durante um drag, o overlay vira pointer-events-none pra o dragover ATRAVESSAR
  // o modal e alcançar os nós do canvas embaixo (senão o drop nunca chega neles).
  const [dragging, setDragging] = useState(false);

  const reload = useCallback(() => {
    snippetsList().then(setSnippets).catch((e) => console.warn("[snippets] list falhou:", e));
  }, []);

  useEffect(() => {
    reload();
    let unlisten: (() => void) | undefined;
    onSnippetsChanged(reload).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, [reload]);

  // Busca client-side: título + conteúdo + lang, case-insensitive.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return snippets;
    return snippets.filter((s) =>
      [s.title ?? "", s.content, s.lang ?? ""].some((f) => f.toLowerCase().includes(q)),
    );
  }, [snippets, query]);

  // 1-clique: área de transferência → snippet. Texto vira kind text; sem texto,
  // tenta imagem (PNG → arquivo via save_paste_image, registra o PATH — MVP).
  const addFromClipboard = useCallback(async () => {
    try {
      const text = await pasteText();
      if (text) {
        if (utf8ByteLength(text) > MAX_PASTE_BYTES) {
          void notify(t("snippets.tooBig", "Conteúdo da área de transferência grande demais (> 30 MB)."), "error");
          return;
        }
        await snippetAdd({ kind: "text", content: text });
        return;
      }
      const png = await readClipboardPng();
      if (!png) {
        void notify(t("snippets.emptyClipboard", "Área de transferência sem texto nem imagem."));
        return;
      }
      if (png.byteLength > MAX_PASTE_BYTES) {
        void notify(t("snippets.tooBig", "Conteúdo da área de transferência grande demais (> 30 MB)."), "error");
        return;
      }
      const path = await savePastePng(png);
      await snippetAdd({ kind: "image", content: path, title: t("snippets.pastedImage", "imagem colada") });
    } catch (e) {
      console.warn("[snippets] colar falhou:", e);
    }
  }, [t]);

  const copySnippet = useCallback((s: Snippet) => {
    void copyText(s.content).then(() => {
      setCopiedId(s.id);
      window.setTimeout(() => setCopiedId((cur) => (cur === s.id ? null : cur)), 1500);
    });
  }, []);

  return createPortal(
    <div
      className={`fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4 ${dragging ? "pointer-events-none" : ""}`}
      onClick={onClose}
    >
      <div
        className="flex max-h-[86vh] w-[720px] max-w-[94vw] flex-col overflow-hidden rounded-lg border border-border bg-surface1 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-border bg-surface2 px-4 py-3">
          <ClipboardList size={16} className="shrink-0 text-brand" />
          <h2 className="shrink-0 text-sm font-semibold text-text">
            {t("snippets.title", "Central de copia-cola")}
          </h2>
          <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded border border-border bg-bg px-2 py-1">
            <Search size={12} className="shrink-0 text-textMuted" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("snippets.search", "buscar…")}
              className="min-w-0 flex-1 bg-transparent text-[11px] text-text outline-none"
            />
          </div>
          <button
            onClick={() => void addFromClipboard()}
            className="flex shrink-0 items-center gap-1 rounded bg-brand/15 px-2 py-1 text-[11px] font-medium text-brand hover:bg-brand/25"
            title={t("snippets.fromClipboard", "Adicionar da área de transferência (texto ou imagem)")}
          >
            <ClipboardPaste size={13} />
            {t("snippets.paste", "Colar")}
          </button>
          <button
            onClick={() => setAdding((v) => !v)}
            className={`rounded p-1 hover:bg-white/10 ${adding ? "text-brand" : "text-textMuted hover:text-text"}`}
            title={t("snippets.addManual", "Adicionar manualmente")}
            aria-label={t("snippets.addManual", "Adicionar manualmente")}
          >
            <Plus size={15} />
          </button>
          <button
            onClick={onClose}
            className="rounded p-1 text-textMuted hover:bg-white/10 hover:text-text"
            aria-label={t("common.close", "Fechar")}
          >
            <X size={15} />
          </button>
        </div>

        {adding && <AddForm t={t} onDone={() => setAdding(false)} />}

        <div className="flex flex-1 flex-col gap-1.5 overflow-auto p-3">
          {filtered.length === 0 && (
            <p className="py-8 text-center text-xs text-textMuted">
              {snippets.length === 0
                ? t("snippets.empty", "Nada guardado ainda. Copie algo e clique em Colar — texto, código e imagens ficam aqui pra sempre, prontos pra copiar ou arrastar pra qualquer nó.")
                : t("snippets.noMatch", "Nenhum snippet bate com a busca.")}
            </p>
          )}
          {filtered.map((s) => (
            <div
              key={s.id}
              draggable
              onDragStart={(e) => {
                // text/plain: os nós do canvas já aceitam (TerminalNode insere no
                // stdin; PATH de imagem cai na convenção do file-drop).
                e.dataTransfer.setData("text/plain", s.content);
                e.dataTransfer.effectAllowed = "copy";
                setDragging(true);
              }}
              onDragEnd={() => setDragging(false)}
              className="cursor-grab rounded-md border border-border bg-surface2 p-2 active:cursor-grabbing"
            >
              <div className="mb-1 flex items-start justify-between gap-2">
                <h3 className="min-w-0 flex-1 truncate text-[12px] font-medium leading-tight text-text">
                  {s.title || s.content.split("\n")[0]}
                </h3>
                <span className="shrink-0 rounded bg-brand/10 px-1 text-[9px] font-semibold uppercase text-brand">
                  {t(KIND_LABEL[s.kind]?.key ?? "", KIND_LABEL[s.kind]?.fallback ?? s.kind)}
                  {s.kind === "code" && s.lang ? ` · ${s.lang}` : ""}
                </span>
              </div>
              <p className="mb-1.5 line-clamp-2 whitespace-pre-wrap font-mono text-[10px] text-textMuted">
                {s.content}
              </p>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[9px] text-textMuted">{s.createdAt}</span>
                <div className="flex items-center gap-0.5">
                  <button
                    onClick={() => copySnippet(s)}
                    className={`rounded p-0.5 hover:bg-white/10 ${copiedId === s.id ? "text-green-400" : "text-textMuted hover:text-text"}`}
                    title={t("snippets.copy", "Copiar pra área de transferência")}
                  >
                    {copiedId === s.id ? <Check size={14} /> : <Copy size={14} />}
                  </button>
                  <button
                    onClick={() => void snippetDelete(s.id).catch((e) => console.warn("[snippets] delete falhou:", e))}
                    className="rounded p-0.5 text-textMuted hover:bg-red-500/20 hover:text-red-400"
                    title={t("snippets.delete", "Excluir snippet")}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Form inline de adicionar manualmente: kind (texto/código) + título + conteúdo
 *  (+ linguagem quando código). Imagem entra só pelo botão Colar (PATH — MVP). */
function AddForm({ t, onDone }: {
  t: (key: string, fallback?: string) => string;
  onDone: () => void;
}) {
  const [kind, setKind] = useState<SnippetKind>("text");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [lang, setLang] = useState("");
  const canSave = content.length > 0;

  const save = () => {
    if (!canSave) return;
    if (utf8ByteLength(content) > MAX_PASTE_BYTES) {
      void notify(t("snippets.tooBig", "Conteúdo da área de transferência grande demais (> 30 MB)."), "error");
      return;
    }
    snippetAdd({
      kind,
      content,
      title: title.trim() || undefined,
      lang: kind === "code" ? lang.trim() || undefined : undefined,
    })
      .then(onDone)
      .catch((e) => console.warn("[snippets] create falhou:", e));
  };

  const input =
    "rounded border border-border bg-bg px-2 py-1 text-[11px] text-text outline-none focus:border-brand";
  return (
    <div className="flex flex-col gap-2 border-b border-border bg-surface2/50 p-3">
      <div className="flex items-center gap-2">
        <select value={kind} onChange={(e) => setKind(e.target.value as SnippetKind)} className={input}>
          <option value="text">{t("snippets.kind.text", "texto")}</option>
          <option value="code">{t("snippets.kind.code", "código")}</option>
        </select>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t("snippets.titlePh", "título (opcional)…")}
          className={`min-w-0 flex-1 ${input}`}
        />
        {kind === "code" && (
          <input
            value={lang}
            onChange={(e) => setLang(e.target.value)}
            placeholder={t("snippets.langPh", "linguagem…")}
            className={`w-28 ${input}`}
          />
        )}
      </div>
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder={t("snippets.contentPh", "conteúdo…")}
        rows={4}
        className={`resize-y font-mono ${input}`}
      />
      <div className="flex items-center justify-end gap-2">
        <button
          onClick={onDone}
          className="rounded border border-border px-3 py-1 text-[11px] text-textMuted hover:bg-white/10 hover:text-text"
        >
          {t("common.cancel", "Cancelar")}
        </button>
        <button
          onClick={save}
          disabled={!canSave}
          className="rounded bg-brand px-3 py-1 text-[11px] font-semibold text-white hover:opacity-90 disabled:pointer-events-none disabled:opacity-30"
        >
          {t("snippets.save", "Guardar")}
        </button>
      </div>
    </div>
  );
}
