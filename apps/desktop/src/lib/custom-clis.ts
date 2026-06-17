// src/lib/custom-clis.ts
//
// CLIs de agente PERSONALIZADOS (definidos pelo usuário): nome + comando + comando
// de instalação opcional. Persistem em localStorage e entram na lista "Novo agente"
// junto dos presets e dos CLIs instalados do catálogo.

export interface CustomCli {
  id: string;
  label: string;
  /** Binário/comando que abre o agente (ex: "mycli"). */
  command: string;
  /** Comando de instalação opcional (rodado num terminal pelo botão instalar). */
  installCmd?: string;
}

const KEY = "omnirift-custom-clis-v1";

export function loadCustomClis(): CustomCli[] {
  try {
    const s = localStorage.getItem(KEY);
    const arr = s ? (JSON.parse(s) as CustomCli[]) : [];
    return Array.isArray(arr) ? arr.filter((c) => c && c.command && c.label) : [];
  } catch {
    return [];
  }
}

export function saveCustomClis(list: CustomCli[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* localStorage indisponível — ignora */
  }
}
