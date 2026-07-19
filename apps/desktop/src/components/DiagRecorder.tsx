import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Circle, Square } from "lucide-react";
import { debugModeGet, debugModeSet, diagnosticsExport, revealPath } from "@/lib/debug-client";
import { getTrailScope, setTrailScope, clearTrail, type TrailScope } from "@/lib/action-trail";
import { notify } from "@/lib/notify";
// `markBoot` grava a marca no debug.log (o nome é do 1º uso — boot); é a mesma primitiva.
import { markBoot } from "@/lib/debug-log";
import { useT } from "@/lib/i18n";

export function DiagRecorder() {
  const t = useT();

  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [scope, setScope] = useState<TrailScope>("actions");
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // sincroniza o estado inicial sem depender de renderizações posteriores
  useEffect(() => {
    let alive = true;

    async function init() {
      try {
        const on = await debugModeGet();
        const s = getTrailScope();
        if (!alive) return;
        setRecording(on);
        if (s !== "off") setScope(s);
      } catch {
        // falha silenciosa na montagem para não spamar o rodapé
      }
    }

    init();

    return () => {
      alive = false;
    };
  }, []);

  // fecha o painel por interação natural do usuário (esc ou clique fora)
  useEffect(() => {
    if (!popoverOpen) return;

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPopoverOpen(false);
    };

    const handleMouse = (e: MouseEvent) => {
      const target = e.target as Node;
      // o próprio botão já alterna o estado, então não fecha por ele
      if (buttonRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      setPopoverOpen(false);
    };

    document.addEventListener("keydown", handleKey);
    document.addEventListener("mousedown", handleMouse);

    return () => {
      document.removeEventListener("keydown", handleKey);
      document.removeEventListener("mousedown", handleMouse);
    };
  }, [popoverOpen]);

  const startRecording = useCallback(async () => {
    if (busy) return;

    setBusy(true);

    try {
      const efetivo = await debugModeSet(true);

      if (!efetivo) {
        notify(t("diag.failed", "Não consegui ligar a gravação (permissão de disco?)"), "error");
        return;
      }

      setTrailScope(scope);
      clearTrail();
      // Marca o ponto de partida NO ARQUIVO. Sem isto o export levava os últimos 200 KB
      // crus — que podem ser de outra sessão, de outro projeto. O cliente aperta "gravar"
      // e o pacote tem que começar aqui, não no passado dele.
      await markBoot("INICIO DA GRAVACAO");
      setRecording(true);
      setPopoverOpen(false);
    } catch {
      notify(t("diag.failed", "Não consegui ligar a gravação (permissão de disco?)"), "error");
    } finally {
      setBusy(false);
    }
  }, [busy, scope, t]);

  const stopRecording = useCallback(async () => {
    if (busy) return;

    setBusy(true);

    try {
      // O backend devolve o estado EFETIVO. Se a remoção do marcador falhar (permissão),
      // ele SEGUE em modo Debug — e mostrar "parado" aqui deixaria o cliente com o disco
      // enchendo achando que desligou. Refletimos o estado real, não o pretendido.
      let aindaGravando = false;
      try {
        aindaGravando = await debugModeSet(false);
      } catch {
        aindaGravando = true;
      }
      if (aindaGravando) {
        notify(t("diag.stopFailed", "Não consegui desligar a gravação (permissão de disco?) — ela continua ativa"), "error");
      }

      setTrailScope("off");
      setRecording(aindaGravando);

      let caminho = "";

      try {
        caminho = await diagnosticsExport();
      } catch {
        notify(t("diag.exportFailed", "Falha ao exportar o pacote de diagnóstico"), "error");
      }

      if (caminho) {
        const basename = caminho.replace(/\\/g, "/").split("/").pop() ?? "";

        try {
          await revealPath(caminho);
          notify(t("diag.ready", "Diagnóstico pronto: ") + basename, "info");
        } catch {
          // arquivo existe, mas não conseguimos abrir a pasta nativamente
          notify(t("diag.readyNoOpen", "Diagnóstico salvo em: ") + caminho, "info");
        }
      }
    } finally {
      setBusy(false);
    }
  }, [busy, t]);

  const handleButtonClick = useCallback(() => {
    if (busy) return;

    if (recording) {
      stopRecording();
      return;
    }

    // mede o botão só na abertura, pois ele fica no rodapé e o painel sobe
    if (buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      setPos({ top: rect.top, left: rect.left });
    }

    setPopoverOpen(true);
  }, [busy, recording, stopRecording]);

  const options: { value: TrailScope; label: string; desc: string }[] = [
    {
      value: "technical",
      label: t("diag.scopeTech", "Só log técnico"),
      desc: t("diag.scopeTechDesc", "erros e comandos do sistema"),
    },
    {
      value: "actions",
      label: t("diag.scopeActions", "Log + minhas ações"),
      // Honestidade: hoje a trilha registra ERROS (com arquivo/linha), não cliques. O
      // texto antigo prometia "o que você clicou" e não entregava — no canal de suporte
      // isso corrói justamente a confiança que o gravador existe pra construir.
      desc: t("diag.scopeActionsDesc", "inclui os erros que apareceram (sem textos nem código)"),
    },
  ];

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={handleButtonClick}
        disabled={busy}
        className={`flex items-center gap-1.5 text-xs transition-colors ${
          recording ? "text-red-400 hover:text-red-300" : "text-textMuted hover:text-brand"
        }`}
      >
        {recording ? <Square size={11} /> : <Circle size={11} />}
        <span>
          {recording
            ? t("diag.stop", "Gravando… parar")
            : t("diag.record", "Gravar")}
        </span>
      </button>

      {popoverOpen &&
        pos &&
        createPortal(
          <div
            ref={popoverRef}
            className="fixed z-[9999] w-[280px] rounded-md border border-border bg-surface1 p-3 shadow-2xl"
            style={{
              top: pos.top - 8,
              left: pos.left,
              transform: "translateY(-100%)",
            }}
          >
            <div className="mb-2 text-xs font-semibold text-text">
              {t("diag.recordWhat", "O que gravar?")}
            </div>

            <div className="space-y-2">
              {options.map((opt) => (
                <label
                  key={opt.value}
                  className="flex cursor-pointer items-start gap-2 rounded-sm text-textMuted hover:text-text"
                >
                  <input
                    type="radio"
                    name="diag-scope"
                    value={opt.value}
                    checked={scope === opt.value}
                    onChange={() => setScope(opt.value)}
                    disabled={busy}
                    className="mt-0.5"
                  />
                  <div className="text-xs">
                    <div className="font-medium text-text">{opt.label}</div>
                    <div className="text-textMuted">{opt.desc}</div>
                  </div>
                </label>
              ))}
            </div>

            <button
              type="button"
              onClick={startRecording}
              disabled={busy}
              className="mt-3 w-full rounded-md bg-brand px-3 py-1.5 text-xs text-white disabled:opacity-50"
            >
              {t("diag.start", "Começar a gravar")}
            </button>
          </div>,
          document.body
        )}
    </>
  );
}
