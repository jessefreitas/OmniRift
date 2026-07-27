import { EXPERIENCE_MODE_STORAGE_KEY, type ExperienceStorage } from "./experience-mode-core";

export const WELCOME_SEEN_KEY = "omnirift-welcome-seen";

/**
 * As boas-vindas aparecem UMA vez, e só para quem está chegando agora.
 *
 * O critério não é "nunca viu": é "nunca viu E é instalação nova". Quem já usava o app
 * antes desta versão tem o modo gravado como "full" (regra `existingInstallation` do
 * experience-mode) — atualizar o app não pode jogar uma tela de tutorial na cara de
 * quem já sabe usar. Instalação nova nasce em "light"/"pocket" e recebe o tour.
 *
 * O modo é lido do storage, e não do store, porque esta decisão acontece no primeiro
 * render do App: o store já inicializou, mas ler a fonte evita depender dessa ordem.
 */
export function shouldShowWelcome(storage: ExperienceStorage): boolean {
  try {
    if (storage.getItem(WELCOME_SEEN_KEY)) return false;
    const mode = storage.getItem(EXPERIENCE_MODE_STORAGE_KEY);
    return mode === "light" || mode === "pocket";
  } catch {
    // Storage bloqueado (WebView sem permissão): não mostra. Um tour que reaparece
    // a cada boot irrita mais do que não existir.
    return false;
  }
}
