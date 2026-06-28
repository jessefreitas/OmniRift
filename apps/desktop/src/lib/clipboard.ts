// Helper de clipboard via tauri-plugin-clipboard-manager — contorna o
// `navigator.clipboard` quebrado no WebKitGTK/Linux (paste nativo do Ctrl+V não
// é entregue nos webviews Tauri/Linux). Base compartilhada: terminal (xterm) e
// os inputs React (SafeInput) leem/escrevem o clipboard do SO por aqui.
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";

/**
 * Lê texto do clipboard do SO. Best-effort: devolve "" se indisponível ou em
 * erro (clipboard vazio, sem imagem-como-texto, permissão) — NUNCA lança, para
 * não derrubar o handler de paste da UI.
 */
export async function pasteText(): Promise<string> {
  try {
    return (await readText()) ?? "";
  } catch {
    return "";
  }
}

/**
 * Escreve texto no clipboard do SO. Best-effort (não lança) — copiar é uma ação
 * secundária; falha silenciosa é preferível a quebrar o fluxo do usuário.
 */
export async function copyText(text: string): Promise<void> {
  try {
    await writeText(text);
  } catch {
    // clipboard indisponível — silencioso de propósito.
  }
}
