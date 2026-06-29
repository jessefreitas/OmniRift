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
 * Salva a imagem do clipboard do SO num arquivo PNG temporário e devolve o caminho
 * (ou null se não há imagem / em erro). Contorna o paste de imagem quebrado no
 * WebKitGTK: lê os pixels via plugin (readImage → RGBA), encoda o PNG aqui no front
 * com <canvas> e delega ao Rust (save_paste_image) só a gravação do arquivo. O
 * caminho devolvido é inserido no stdin do agente (mesma ideia do file-drop).
 */
export async function pasteImageToFile(): Promise<string | null> {
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

    const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
    return await invoke<string>("save_paste_image", { bytes });
  } catch {
    return null;
  }
}
