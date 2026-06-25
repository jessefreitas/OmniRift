// src/components/TerminalContextMenu.tsx
//
// Context menu customizado para terminais — substitui o menu padrão do WebKit.
// Renderizado via createPortal em document.body para escapar de qualquer
// stacking context dos nós do canvas.

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Copy, Clipboard, BookmarkPlus, Maximize2, X, Zap } from "lucide-react";
import { cn } from "@/lib/cn";
import { useT } from "@/lib/i18n";

export interface TerminalContextMenuProps {
  x: number;
  y: number;
  onClose: () => void;
  onCopy: () => void;
  onPaste: () => void;
  onCopyAndSave: () => void;
  onFullscreen: () => void;
  onSendToTurbo: () => void;
  onCloseTerminal: () => void;
}

interface MenuItemProps {
  icon: React.ReactNode;
  label: string;
  shortcut?: string;
  onClick: () => void;
  danger?: boolean;
}

function MenuItem({ icon, label, shortcut, onClick, danger }: MenuItemProps) {
  return (
    <button
      className={cn(
        "flex items-center gap-2 w-full px-3 py-1.5 text-xs rounded",
        "hover:bg-surface3 transition-colors text-left",
        danger ? "text-danger" : "text-text",
      )}
      onMouseDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
      }}
    >
      <span className="w-3.5 shrink-0 text-textMuted">{icon}</span>
      <span className="flex-1">{label}</span>
      {shortcut && (
        <span className="text-[10px] text-textMuted ml-2 shrink-0">{shortcut}</span>
      )}
    </button>
  );
}

function Separator() {
  return <div className="my-1 border-t border-border" />;
}

export function TerminalContextMenu({
  x,
  y,
  onClose,
  onCopy,
  onPaste,
  onCopyAndSave,
  onFullscreen,
  onSendToTurbo,
  onCloseTerminal,
}: TerminalContextMenuProps) {
  const t = useT();
  const menuRef = useRef<HTMLDivElement>(null);

  // Fechar ao clicar fora
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    // Usar capture para pegar antes que outros handlers consumam o evento
    document.addEventListener("mousedown", handleClick, { capture: true });
    document.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => {
      document.removeEventListener("mousedown", handleClick, { capture: true });
      document.removeEventListener("keydown", handleKeyDown, { capture: true });
    };
  }, [onClose]);

  // Ajustar posição para não sair da viewport
  const style: React.CSSProperties = {
    position: "fixed",
    left: Math.min(x, window.innerWidth - 180),
    top: Math.min(y, window.innerHeight - 220),
    zIndex: 99999,
  };

  return createPortal(
    <div
      ref={menuRef}
      style={style}
      className={cn(
        "w-44 rounded-md shadow-lg border border-border bg-surface2 py-1 px-1",
        "text-xs select-none",
      )}
      // Impede que o clique no menu feche o menu (handled via mousedown fora)
      onMouseDown={(e) => e.stopPropagation()}
    >
      <MenuItem
        icon={<Copy size={12} />}
        label={t("terminalMenu.copy", "Copiar")}
        shortcut="Ctrl+C"
        onClick={() => { onCopy(); onClose(); }}
      />
      <MenuItem
        icon={<Clipboard size={12} />}
        label={t("terminalMenu.paste", "Colar")}
        shortcut="Ctrl+V"
        onClick={() => { onPaste(); onClose(); }}
      />
      <MenuItem
        icon={<BookmarkPlus size={12} />}
        label={t("terminalMenu.copyAndSave", "Copiar e Guardar")}
        onClick={() => { onCopyAndSave(); onClose(); }}
      />
      <MenuItem
        icon={<Zap size={12} />}
        label={t("terminalMenu.sendToTurbo", "Enviar pro TURBO")}
        onClick={() => { onSendToTurbo(); onClose(); }}
      />
      <Separator />
      <MenuItem
        icon={<Maximize2 size={12} />}
        label={t("terminalMenu.fullscreen", "Tela cheia")}
        onClick={() => { onFullscreen(); onClose(); }}
      />
      <Separator />
      <MenuItem
        icon={<X size={12} />}
        label={t("terminalMenu.closeTerminal", "Fechar Terminal")}
        onClick={() => { onCloseTerminal(); onClose(); }}
        danger
      />
    </div>,
    document.body,
  );
}
