// Modal "Enviar diagnóstico": o usuário descreve o problema (+ contato opcional) e
// envia junto dos logs técnicos (collect_diagnostics + console) pro worker /diag.
// Devolve um código pra ele citar no grupo do WhatsApp. Gerado via Ollama + auditado.

import { useState } from "react";
import { createPortal } from "react-dom";
import { Bug, X, Send, Copy, Check } from "lucide-react";
import { sendDiagnostics } from "@/lib/diagnostics";

export function DiagnosticsModal({ onClose }: { onClose: () => void }) {
  const [msg, setMsg] = useState("");
  const [contact, setContact] = useState("");
  const [sending, setSending] = useState(false);
  const [resultId, setResultId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function enviar() {
    if (sending) return;
    setSending(true);
    setError(null);
    const note = msg.trim() + (contact.trim() ? `\n\n[contato] ${contact.trim()}` : "");
    try {
      const id = await sendDiagnostics(note || undefined);
      setResultId(id);
    } catch (e) {
      setError(String(e));
    } finally {
      setSending(false);
    }
  }

  async function copiar() {
    try {
      await navigator.clipboard.writeText(resultId ?? "");
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="w-[520px] max-w-[94vw] max-h-[85vh] rounded-lg border border-border bg-surface1 shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-2 px-4 py-2.5 border-b border-border shrink-0">
          <Bug size={15} className="text-brand" />
          <span className="text-sm font-medium text-text">Enviar diagnóstico</span>
          <div className="flex-1" />
          <button type="button" onClick={onClose} className="text-textMuted hover:text-text p-1">
            <X size={16} />
          </button>
        </header>

        <div className="px-4 py-3 space-y-3 overflow-y-auto">
          {resultId ? (
            <div className="p-3 rounded bg-green-500/10 border border-green-500/20 space-y-2">
              <p className="text-sm font-medium text-brand">Diagnóstico enviado ✓</p>
              <p className="text-[12px] text-textMuted">Cole este código no grupo do WhatsApp pra equipe achar seu log:</p>
              <div className="flex items-center gap-2">
                <code className="px-2 py-1 rounded bg-bg border border-border text-text text-sm font-mono">{resultId}</code>
                <button type="button" onClick={copiar} className="flex items-center gap-1.5 text-xs text-text hover:text-brand">
                  {copied ? <Check size={13} /> : <Copy size={13} />}
                  {copied ? "Copiado" : "Copiar"}
                </button>
              </div>
            </div>
          ) : (
            <>
              <p className="text-[12px] text-textMuted">
                Conta o que aconteceu (o que você fazia, o que esperava). Vai junto com versão, sistema e logs técnicos recentes — nunca enviamos senhas/tokens.
              </p>
              <textarea
                value={msg}
                onChange={(e) => setMsg(e.target.value)}
                rows={5}
                placeholder="Descreva o problema ou o que você quer falar…"
                className="w-full px-2 py-1.5 text-sm rounded bg-bg border border-border text-text placeholder:text-textMuted focus:outline-none focus:border-brand resize-none"
              />
              <input
                type="text"
                value={contact}
                onChange={(e) => setContact(e.target.value)}
                placeholder="Contato (opcional) — WhatsApp ou e-mail pra te responder"
                className="w-full px-2 py-1.5 text-sm rounded bg-bg border border-border text-text placeholder:text-textMuted focus:outline-none focus:border-brand"
              />
              {error && <p className="text-[12px] text-red-400">{error}</p>}
            </>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 px-4 py-2.5 border-t border-border shrink-0">
          {resultId ? (
            <button type="button" onClick={onClose} className="px-3 py-1.5 text-xs rounded bg-brand text-bg hover:bg-brand-hover">
              Fechar
            </button>
          ) : (
            <>
              <button type="button" onClick={onClose} className="px-3 py-1.5 text-xs rounded text-textMuted hover:text-text">
                Cancelar
              </button>
              <button
                type="button"
                onClick={enviar}
                disabled={sending}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-brand text-bg hover:bg-brand-hover disabled:opacity-50"
              >
                <Send size={13} />
                {sending ? "Enviando…" : "Enviar diagnóstico"}
              </button>
            </>
          )}
        </footer>
      </div>
    </div>,
    document.body,
  );
}
