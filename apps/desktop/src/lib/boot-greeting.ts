export type BootVoice = "male" | "female";

export function greetingForHour(h: number): string {
  if (h >= 5 && h < 12) {
    return "Bom dia. Sistemas OmniRift online. Todos os agentes ao seu comando.";
  }
  if (h >= 12 && h < 18) {
    return "Boa tarde. Sistemas OmniRift online. Todos os agentes ao seu comando.";
  }
  if (h >= 18) {
    return "Boa noite. Sistemas OmniRift online. Todos os agentes ao seu comando.";
  }
  return "Ainda em operação a esta hora? Impressionante. Sistemas OmniRift online, ao seu comando.";
}

export function currentGreeting(): string {
  return greetingForHour(new Date().getHours());
}

export function getBootVoice(): BootVoice {
  try {
    const saved = localStorage.getItem("omnirift-boot-voice");
    return saved === "female" ? "female" : "male";
  } catch {
    return "male";
  }
}

export function setBootVoice(v: BootVoice): void {
  try {
    localStorage.setItem("omnirift-boot-voice", v);
  } catch {
    // falha silenciosa em ambientes sem localStorage
  }
}