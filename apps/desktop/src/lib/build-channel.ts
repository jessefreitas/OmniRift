export const BUILD_CHANNEL = import.meta.env.MODE === "lab" ? "lab" : "stable";

export const IS_LAB_BUILD = BUILD_CHANNEL === "lab";

// O Lab nunca consulta nem instala o feed Stable. Um canal Lab de atualização
// pode ser criado depois com chave e feed próprios; por enquanto, artefatos são
// instalados explicitamente pelo desenvolvedor.
export const UPDATER_ENABLED = !IS_LAB_BUILD;
