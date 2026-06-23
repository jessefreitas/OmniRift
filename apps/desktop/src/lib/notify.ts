/**
 * notify.ts
 *
 * Diálogos nativos do Tauri (WebKitGTK no Linux) — `window.alert/confirm` são
 * no-op no WebKitGTK, então toasts de erro e confirmações sumiam calados.
 * Aqui rotamos pelo tauri-plugin-dialog, que abre o diálogo nativo do SO.
 *
 * Requer no `capabilities/default.json`: dialog:allow-message + dialog:allow-ask.
 */
import { message, ask } from "@tauri-apps/plugin-dialog";

/** Toast/diálogo de informação ou erro. Silencioso se o plugin falhar (try/catch). */
export async function notify(msg: string, kind: "info" | "error" = "info"): Promise<void> {
  try {
    await message(msg, { title: kind === "error" ? "Erro" : "OmniRift", kind });
  } catch {
    /* plugin indisponível — falha silenciosa (nunca trava o fluxo) */
  }
}

/** Confirmação (OK/Cancelar). Retorna false se cancelar OU se o plugin falhar. */
export async function confirmDialog(msg: string, title = "Confirmar"): Promise<boolean> {
  try {
    return await ask(msg, { title, kind: "warning" });
  } catch {
    return false;
  }
}
