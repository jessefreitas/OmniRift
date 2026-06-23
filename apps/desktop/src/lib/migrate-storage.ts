// Migração das chaves de localStorage do codename antigo (`maestri-*`) para o nome
// real do produto (`omnirift-*`). "Maestri" era só codename — aposentado.
//
// Roda no BOOT, ANTES de qualquer store/módulo ler o localStorage — por isso é
// importada como PRIMEIRO import do main.tsx (efeito colateral no topo do módulo).
// Copia cada `maestri-X` para `omnirift-X` se o novo ainda não existe; mantém a
// chave antiga como fallback (não remove — zero risco de perder dados do usuário).

function migrateLegacyStorage(): void {
  try {
    if (typeof localStorage === "undefined") return;
    const PREFIX = "maestri-";
    const legacy: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PREFIX)) legacy.push(k);
    }
    for (const k of legacy) {
      const nk = "omnirift-" + k.slice(PREFIX.length);
      if (localStorage.getItem(nk) === null) {
        const v = localStorage.getItem(k);
        if (v !== null) localStorage.setItem(nk, v);
      }
    }
  } catch {
    /* localStorage indisponível/cheio — ignora, app segue com defaults */
  }
}

migrateLegacyStorage();
