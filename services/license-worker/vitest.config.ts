import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

// Chave Ed25519 pkcs8 DESCARTÁVEL, só pros testes. A real é o secret
// ED25519_PRIVATE_KEY em produção (tools/.omnirift-license.key). Os testes apenas
// inspecionam os campos do payload do entitlement — não verificam a assinatura —
// então qualquer chave Ed25519 válida serve. NÃO é segredo de produção.
const TEST_SIGNING_KEY = "MC4CAQAwBQYDK2VwBCIEIIu3QlpOGpBNES8iR1g7FJWFRLSPBZ45XVa1XOYkzMWH";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          // D1 "DB" + vars vêm do wrangler.toml; aqui só injetamos o "secret" de teste.
          bindings: { ED25519_PRIVATE_KEY: TEST_SIGNING_KEY },
        },
      },
    },
  },
});
