// src/lib/custom-compressors.ts
//
// Compressores PERSONALIZADOS do usuário (nome + comando de instalação). Persistem
// em localStorage e entram na lista do painel de Compressores, junto do catálogo.

export interface CustomCompressor {
  id: string;
  label: string;
  /** Comando de instalação (rodado num terminal do canvas). */
  installCmd: string;
}

const KEY = "omnirift-custom-compressors-v1";

export function loadCustomCompressors(): CustomCompressor[] {
  try {
    const s = localStorage.getItem(KEY);
    const arr = s ? (JSON.parse(s) as CustomCompressor[]) : [];
    return Array.isArray(arr) ? arr.filter((c) => c && c.label && c.installCmd) : [];
  } catch {
    return [];
  }
}

export function saveCustomCompressors(list: CustomCompressor[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* localStorage indisponível */
  }
}
