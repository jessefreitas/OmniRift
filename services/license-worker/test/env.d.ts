import type { Env } from "../src/index";

// Tipa o binding `env` de `cloudflare:test` com o Env do worker.
declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

// Imports `*?raw` (schema.sql) usados nos testes.
declare module "*?raw" {
  const content: string;
  export default content;
}
