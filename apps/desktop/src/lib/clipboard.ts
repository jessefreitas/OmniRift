// Helper de clipboard via tauri-plugin-clipboard-manager — contorna o
// `navigator.clipboard` quebrado no WebKitGTK/Linux (paste nativo do Ctrl+V não
// é entregue nos webviews Tauri/Linux). Base compartilhada: terminal (xterm) e
// os inputs React (SafeInput) leem/escrevem o clipboard do SO por aqui.
import { readText, writeText, readImage } from "@tauri-apps/plugin-clipboard-manager";
import { invoke } from "@tauri-apps/api/core";

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

/**
 * Teto prático do payload do IPC do Tauri (WebKitGTK/WebView2): acima disto o
 * `invoke` estoura ("texto/contexto > 32 MB"). O caller mede o conteúdo ANTES de
 * enviar e avisa o usuário em vez de deixar o IPC crashar. Margem propositada
 * abaixo do limite real (~32 MiB) porque o invoke ainda embrulha o payload.
 */
export const MAX_PASTE_BYTES = 30 * 1024 * 1024;

/** Bytes UTF-8 reais de uma string — é o que de fato trafega no payload do IPC
 *  (não `.length`, que conta unidades UTF-16 e subconta acentos/emoji). */
export function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * Lê a imagem do clipboard do SO e a encoda em PNG (bytes), ou null se não há
 * imagem / em erro. Contorna o paste de imagem quebrado no WebKitGTK: lê os pixels
 * via plugin (readImage → RGBA) e encoda o PNG aqui no front com <canvas>. A
 * GRAVAÇÃO fica no Rust (savePastePng). Separado em duas etapas pra o caller poder
 * medir o tamanho dos bytes ANTES de mandar pro IPC (guard de 32 MB).
 */
export async function readClipboardPng(): Promise<Uint8Array | null> {
  try {
    const img = await readImage();
    const { width, height } = await img.size();
    const rgba = await img.rgba();

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);

    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"));
    if (!blob) return null;
    return new Uint8Array(await blob.arrayBuffer());
  } catch {
    return null;
  }
}

/** Grava o PNG (bytes) num arquivo temp via Rust e devolve o caminho. O caller já
 *  validou `bytes.byteLength` contra o teto do IPC antes de chamar. */
export async function savePastePng(bytes: Uint8Array): Promise<string> {
  return invoke<string>("save_paste_image", { bytes: Array.from(bytes) });
}
