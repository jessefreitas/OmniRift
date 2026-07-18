import { invoke } from "@tauri-apps/api/core";

// A reprodução de áudio foi movida para o backend Rust via comandos Tauri.
// A Web Audio API não é roteada pelo WebKitGTK no Linux, então o frontend
// apenas dispara os comandos e deixa o Rust cuidar do som e da fala.

export function playBootSound(): void {
  invoke("play_boot_sound").catch(() => {});
}

// Voz PRÉ-GRAVADA (ElevenLabs) embutida no backend; `voice` = "male" (Adam) | "female" (Ophelia).
// O backend escolhe o áudio por essa voz + a hora local. O texto na tela vem do currentGreeting.
export async function speakGreeting(voice: string): Promise<boolean> {
  try {
    await invoke("play_greeting", { voice });
    return true;
  } catch {
    return false;
  }
}

export function stopAudio(): void {
  // No-op mantido apenas para compatibilidade de assinatura.
  // Os sons e a fala do backend são curtos e não exigem parada explícita.
}