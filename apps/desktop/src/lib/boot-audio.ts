import { invoke } from "@tauri-apps/api/core";

// A reprodução de áudio foi movida para o backend Rust via comandos Tauri.
// A Web Audio API não é roteada pelo WebKitGTK no Linux, então o frontend
// apenas dispara os comandos e deixa o Rust cuidar do som e da fala.

export function playBootSound(): void {
  invoke("play_boot_sound").catch(() => {});
}

// A voz é PRÉ-GRAVADA (ElevenLabs) e embutida no backend; o `text` é ignorado (mantido só
// pra compatibilidade de assinatura — o texto na tela vem do greeting do BootIntro).
export async function speakGreeting(_text: string): Promise<boolean> {
  try {
    await invoke("play_greeting");
    return true;
  } catch {
    return false;
  }
}

export function stopAudio(): void {
  // No-op mantido apenas para compatibilidade de assinatura.
  // Os sons e a fala do backend são curtos e não exigem parada explícita.
}