export type ShellId = "auto" | "bash" | "powershell" | "cmd" | "wsl" | "gitbash" | "custom";
export type Platform = "windows" | "posix";

/** Binário + args pra spawnar. */
export interface ShellSpec {
  command: string;
  args: string[];
}

export interface ShellPref {
  shell: ShellId;
  custom: string;
}

export const SHELL_STORAGE_KEY = "omnirift-shell-pref";

const VALID_SHELLS: ShellId[] = ["auto", "bash", "powershell", "cmd", "wsl", "gitbash", "custom"];

function isShellId(value: unknown): value is ShellId {
  return typeof value === "string" && VALID_SHELLS.includes(value as ShellId);
}

// Fallback quando auto ou custom vazio.
function fallbackAuto(platform: Platform): string {
  return platform === "windows" ? "powershell.exe" : "bash";
}

// Resolve o binário baseado em shell + plataforma.
function resolveBin(shell: ShellId, platform: Platform, custom?: string): string {
  if (shell === "custom") {
    const trimmed = (custom ?? "").trim();
    return trimmed || fallbackAuto(platform);
  }

  if (platform === "windows") {
    switch (shell) {
      case "cmd": return "cmd.exe";
      case "wsl": return "wsl.exe";
      case "bash":
      case "gitbash": return "bash.exe";
      default: return "powershell.exe";
    }
  }

  // posix
  if (shell === "powershell") return "pwsh";
  return "bash";
}

// Plataforma atual pelo navigator (impuro, fino). Fora de browser → "posix".
export function currentPlatform(): Platform {
  if (typeof navigator !== "undefined" && /Win/i.test(navigator.userAgent)) {
    return "windows";
  }
  return "posix";
}

// Resolve o shell INTERATIVO puro (sem comando).
export function resolveShell(shell: ShellId, platform: Platform, custom?: string): ShellSpec {
  const command = resolveBin(shell, platform, custom);
  return { command, args: [] };
}

// Roda `line` e DEPOIS continua interativo (hooks de floor / routines).
export function shellRunThenStay(line: string, shell: ShellId, platform: Platform, custom?: string): ShellSpec {
  const bin = resolveBin(shell, platform, custom);

  // `custom` só assume POSIX quando REALMENTE preenchido. Vazio → cai no default da
  // plataforma; senão o Windows receberia powershell.exe com `-lc`, que é exatamente o
  // bug que este módulo existe pra matar.
  const customBin = (custom ?? "").trim();
  if (shell === "custom" && customBin) {
    return { command: customBin, args: ["-lc", `${line}; exec ${customBin}`] };
  }

  if (platform === "windows") {
    switch (shell) {
      case "cmd":
        return { command: "cmd.exe", args: ["/k", line] };
      case "wsl":
        return { command: "wsl.exe", args: ["bash", "-lc", `${line}; exec bash`] };
      case "bash":
      case "gitbash":
        return { command: "bash.exe", args: ["-lc", `${line}; exec bash.exe`] };
      case "powershell":
      case "auto":
      default:
        return { command: "powershell.exe", args: ["-NoExit", "-Command", line] };
    }
  }

  // posix: convenção POSIX -lc funciona.
  if (shell === "powershell") {
    return { command: "pwsh", args: ["-NoExit", "-Command", line] };
  }

  return { command: bin, args: ["-lc", `${line}; exec ${bin}`] };
}

// Persistência (localStorage, tolerante a erro/JSON inválido → default).
export function loadShellPref(): ShellPref {
  const fallback: ShellPref = { shell: "auto", custom: "" };
  try {
    const raw = localStorage.getItem(SHELL_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return fallback;
    return {
      shell: isShellId(parsed.shell) ? parsed.shell : "auto",
      custom: typeof parsed.custom === "string" ? parsed.custom : "",
    };
  } catch {
    return fallback;
  }
}

// Salva preferência, ignorando silenciosamente erros do storage.
export function saveShellPref(pref: ShellPref): void {
  try {
    localStorage.setItem(
      SHELL_STORAGE_KEY,
      JSON.stringify({ shell: pref.shell, custom: pref.custom ?? "" }),
    );
  } catch {
    // noop: ambiente sem storage ou privado.
  }
}

// Atalhos que leem a preferência salva + plataforma atual.
export function currentShell(): ShellSpec {
  const { shell, custom } = loadShellPref();
  return resolveShell(shell, currentPlatform(), custom);
}

export function currentShellRunThenStay(line: string): ShellSpec {
  const { shell, custom } = loadShellPref();
  return shellRunThenStay(line, shell, currentPlatform(), custom);
}