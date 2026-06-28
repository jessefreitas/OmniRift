import * as React from "react";
import { forwardRef, useCallback, useRef } from "react";
import { pasteText } from "@/lib/clipboard";

type SafeInputElement = HTMLInputElement | HTMLTextAreaElement;

interface UseSafeInputHandlersOptions<E extends SafeInputElement> {
  onChange?: React.ChangeEventHandler<E>;
  onCompositionStart?: React.CompositionEventHandler<E>;
  onCompositionEnd?: React.CompositionEventHandler<E>;
  onPaste?: React.ClipboardEventHandler<E>;
  /** Prototype do elemento (HTMLInputElement/HTMLTextAreaElement) — dono do setter
   *  nativo de `value`, usado para notificar o input controlado do React no paste. */
  elementPrototype: SafeInputElement;
}

/**
 * Lógica compartilhada por SafeInput/SafeTextarea: conserta os 2 bugs de input do
 * WebKitGTK/Linux + IBus — composição de acentos/ç e Ctrl+V que não cola.
 */
function useSafeInputHandlers<E extends SafeInputElement>({
  onChange,
  onCompositionStart,
  onCompositionEnd,
  onPaste,
  elementPrototype,
}: UseSafeInputHandlersOptions<E>) {
  // true enquanto o IBus está compondo um dead-key (´+a, ç). Ref (não state) para
  // NÃO causar re-render durante o preedit.
  const composingRef = useRef(false);

  const handleCompositionStart = useCallback(
    (e: React.CompositionEvent<E>) => {
      composingRef.current = true;
      onCompositionStart?.(e);
    },
    [onCompositionStart],
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<E>) => {
      // Durante a composição NÃO propaga onChange ao pai: o re-render reescreveria
      // input.value no meio do preedit e corromperia a composição no WebKitGTK.
      if (composingRef.current) return;
      onChange?.(e);
    },
    [onChange],
  );

  const handleCompositionEnd = useCallback(
    (e: React.CompositionEvent<E>) => {
      // Fim da composição: libera e propaga o valor já commitado (e.currentTarget.value).
      // O CompositionEvent carrega currentTarget.value (lido pelo pai); o cast só alinha
      // o tipo do handler. Um onChange nativo pode vir logo após com o MESMO valor —
      // inócuo (setState do input controlado é idempotente).
      composingRef.current = false;
      onChange?.(e as unknown as React.ChangeEvent<E>);
      onCompositionEnd?.(e);
    },
    [onChange, onCompositionEnd],
  );

  const handlePaste = useCallback(
    async (e: React.ClipboardEvent<E>) => {
      // O paste nativo do Ctrl+V não chega no webview WebKitGTK → intercepta e lê o
      // clipboard do SO via plugin. preventDefault impede o (não-)paste nativo.
      e.preventDefault();
      // Captura elemento + caret ANTES do await: o React anula e.currentTarget quando
      // o handler async cede o controle (fim do ciclo do evento sintético). `el` é a
      // referência direta ao nó do DOM e permanece válida após o await.
      const el = e.currentTarget;
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? el.value.length;

      const text = await pasteText();
      if (!text) return;

      const newValue = el.value.slice(0, start) + text + el.value.slice(end);
      // Seta o value pelo setter NATIVO (contorna o controle do React) e dispara um
      // `input` event → o React reconcilia e chama o onChange real (atualiza o pai).
      const desc = Object.getOwnPropertyDescriptor(elementPrototype, "value");
      desc?.set?.call(el, newValue);
      el.dispatchEvent(new Event("input", { bubbles: true }));

      const pos = start + text.length;
      el.setSelectionRange(pos, pos);

      onPaste?.(e);
    },
    [onPaste, elementPrototype],
  );

  return {
    onCompositionStart: handleCompositionStart,
    onChange: handleChange,
    onCompositionEnd: handleCompositionEnd,
    onPaste: handlePaste,
  };
}

/** <input> drop-in que conserta composição (ç/acentos) e Ctrl+V no WebKitGTK. */
export const SafeInput = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ onChange, onCompositionStart, onCompositionEnd, onPaste, ...rest }, ref) => {
    const handlers = useSafeInputHandlers<HTMLInputElement>({
      onChange,
      onCompositionStart,
      onCompositionEnd,
      onPaste,
      elementPrototype: window.HTMLInputElement.prototype,
    });
    return <input ref={ref} {...rest} {...handlers} />;
  },
);
SafeInput.displayName = "SafeInput";

/** <textarea> drop-in que conserta composição (ç/acentos) e Ctrl+V no WebKitGTK. */
export const SafeTextarea = forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ onChange, onCompositionStart, onCompositionEnd, onPaste, ...rest }, ref) => {
    const handlers = useSafeInputHandlers<HTMLTextAreaElement>({
      onChange,
      onCompositionStart,
      onCompositionEnd,
      onPaste,
      elementPrototype: window.HTMLTextAreaElement.prototype,
    });
    return <textarea ref={ref} {...rest} {...handlers} />;
  },
);
SafeTextarea.displayName = "SafeTextarea";
