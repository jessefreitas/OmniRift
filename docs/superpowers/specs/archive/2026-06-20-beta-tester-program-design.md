# Design — Programa Beta Tester (60 dias full)

**Data:** 2026-06-20 · **Status:** spec aprovada para plano · **Branch:** `feat/beta-tester-program`

## Objetivo

Permitir que qualquer pessoa que instalou o OmniRift se cadastre, **dentro do app, em 1 clique**, como beta tester e ganhe **60 dias com a edição full (Pro) liberada**, em troca de usar e reportar feedback. O operador (Jesse) pode **renovar/estender** o beta de um tester quando quiser.

O beta é uma **variante do trial existente** — reaproveita assinatura Ed25519, device-binding, verificação offline e integrações (OmniChat/email) do `license-worker`. Não cria sistema paralelo.

## Decisões (brainstorm 2026-06-20)

1. **Cadastro:** 1-clique no app (só email) → worker `/signup/beta`; entitlement emitido e auto-ativado pelo fingerprint (sem copiar/colar).
2. **Report:** botão no app abre **GitHub Issues** pré-preenchido (label `beta` + versão do app + SO).
3. **Fim dos 60 dias:** degrada para community **+** oferta de upgrade Pro com **desconto de beta tester** (% configurável no worker, não hardcoded).
4. **Convite na UI:** modal no 1º run (1×, só se community) **+** botão fixo na sidebar/`LicenseGate`.
5. **Anti-abuso:** **1 beta por fingerprint (device)** — idempotente (reinstalar mantém os dias restantes, não reseta).
6. **Renovação:** endpoint admin `/admin/beta/renew` + `/admin/beta/list` (auth por token), disparados por **script CLI** `scripts/beta-renew.mjs`. O app chama `/refresh` no boot + periodicamente → puxa a renovação automaticamente.

## Arquitetura

### Worker (`services/license-worker/`)

- **`POST /signup/beta`** `{ email, name?, fingerprint, devicePubkey? }`
  - Anti-abuso: busca `devices` pelo `fingerprint`. Se já há licença `plan:"beta"` para esse device → **idempotente**: re-emite entitlement com o **mesmo `exp` original** (não cria novo nem reseta os 60d).
  - Senão: cria `license` (`tier:"full"`, `status:"beta"`, `plan:"beta"`, `trial_ends_at = now + BETA_DAYS`). **Sem checkout Asaas.**
  - Registra device + emite entitlement `{ fp, holder:email, exp:trial_ends_at, tier:"full" }`.
  - OmniChat: cria card na etapa **"Beta (60d)"** (reaproveita `integrations.ts`). Email de boas-vindas com o link do GitHub Issues.
  - Retorna `{ licenseKey, entitlement, status:"beta", betaEndsAt }`.
- **`/refresh`** (existente) ganha tratamento de licença beta: renova entitlement com `exp = trial_ends_at` enquanto `status="beta"` e `trial_ends_at > now`; depois disso retorna expirado (app cai pra community).
- **`POST /admin/beta/renew`** `{ email | key, days }` — auth `Authorization: token <ADMIN_TOKEN>`. Estende `trial_ends_at += days` (ou define a partir de `now` se já expirou), volta `status="beta"`, loga evento. Idempotência não se aplica (ação deliberada do operador).
- **`GET /admin/beta/list`** — auth admin. Lista betas (`email`, `fingerprint`, `betaEndsAt`, dias restantes, `status`).
- **`/signup` (Pro)** ganha flag opcional `betaDiscount:true` → aplica `BETA_DISCOUNT_PCT` no preço do checkout Asaas (oferta pós-beta).

### Banco D1 (reuso, sem migração estrutural)

- `licenses`: usa `plan="beta"`, `status="beta"`, `trial_ends_at = +60d`. Colunas Asaas ficam nulas.
- `devices`, `events`: inalterados (device-binding + auditoria reaproveitados).
- OmniChat: nova **etapa "Beta (60d)"** no funil (config `FUNNEL_STAGE_BETA`).

### App — Rust (`apps/desktop/src-tauri/src/commands/license.rs`)

- Novo command `license_signup_beta(email) -> LicenseStatus`: lê o fingerprint (já existe), chama `/signup/beta`, **persiste a `licenseKey` + entitlement** no app data dir, devolve status. Verificação offline Ed25519 intocada.
- Persistir a `licenseKey` (hoje o fluxo Pro guarda a key) é o que habilita `/refresh`/renovação.

### App — TS (`apps/desktop/src/lib/license-client.ts`)

- `signupBeta(email)`: `POST /signup/beta {email, fingerprint}` → aplica via command Rust → atualiza license store. Grava também um flag local **`wasBeta=true`** (app data) — é o que o app usa pra, no fim do beta, mostrar o CTA de **desconto beta** (o entitlement só carrega `tier:full`, não o plano).
- **`/refresh` no boot + intervalo** (ex.: a cada N horas) usando a `licenseKey` guardada → puxa renovação e fecha o gap pós-trial. Reaproveita a chamada `/refresh` existente.

### App — UI (`apps/desktop/src/components/`)

- **`BetaInviteModal.tsx`**: modal do 1º run (headline "Seja um Beta Tester — 60 dias com tudo liberado", input de email, botão "Quero testar (60 dias)", link "Já tenho licença ›" → `LicenseGate`). Exibe 1× (flag localStorage) só se `tier=community`. Sucesso → toast "Beta ativado! 60 dias" + app vira full.
- **Botão fixo** "Seja beta tester" na sidebar/`LicenseGate` (pra quem fechou o modal).
- **Botão "Reportar / Feedback"** → abre GitHub Issues novo, pré-preenchido (`?labels=beta&title=...&body=...` com versão do app + SO). Repo: `GITHUB_REPO` (jessefreitas/OmniRift).
- **Dia 60:** `LicenseGate`/toast mostra "Seu beta acabou — vire Pro com desconto de beta tester" (CTA → `/signup` com `betaDiscount:true`).

### CLI (`scripts/beta-renew.mjs`)

- `node scripts/beta-renew.mjs <email|key> +<dias>` → chama `/admin/beta/renew` com `ADMIN_TOKEN`.
- `node scripts/beta-renew.mjs --list` → chama `/admin/beta/list`.
- Lê `ADMIN_TOKEN` e a URL do worker de env/registry (não hardcode de segredo).

## Fluxos de dados

1. **1º run (community)** → `BetaInviteModal` → email → `signupBeta` → `/signup/beta` (checa fingerprint) → entitlement 60d → grava key+entitlement → app full.
2. **Reinstalar mesma máquina** → `/signup/beta` vê fingerprint já beta → devolve entitlement existente (dias restantes), sem reset.
3. **Boot/intervalo** → `/refresh {key, fingerprint}` → mantém entitlement até o dia 60 (e aplica renovações).
4. **Operador renova** → `beta-renew.mjs email +60` → `/admin/beta/renew` estende `trial_ends_at` → próximo `/refresh` do tester restaura full (mesmo se tinha expirado).
5. **Dia 60 sem renovar** → `/refresh` retorna expirado → community + CTA de upgrade com desconto beta.
6. **Reportar** → botão → GitHub Issues pré-preenchido.

## Config / env (worker)

`ADMIN_TOKEN` (novo, auth dos endpoints admin) · `BETA_DAYS=60` · `BETA_DISCOUNT_PCT` (ex.: 30) · `FUNNEL_STAGE_BETA` · `GITHUB_REPO` (já existe, p/ o link de issues). Sem hardcode de valores de negócio.

## Tratamento de erros

- Worker offline → modal "tente de novo"; app segue community (não bloqueia).
- Email inválido → validação no client antes de chamar.
- Beta já usado nessa máquina → "você já testou aqui" + dias restantes (ou community + oferta Pro).
- Entitlement inválido/expirado → community (comportamento atual, gracioso).
- `/admin/*` sem token válido → 401.

## Testes

- **Worker:** unit do `/signup/beta` (cria licença 60d `plan:beta`, **zero** chamada Asaas, idempotência por fingerprint); do `/admin/beta/renew` (estende e reativa expirado; 401 sem token); `/refresh` de beta.
- **Rust:** verificação de entitlement beta (exp 60d, tier full) — reaproveita testes de `license.rs`.
- **App:** e2e manual do modal (cadastro → full → reportar).

## Net-new vs reuso

**Net-new:** `/signup/beta`, `/admin/beta/renew`, `/admin/beta/list`, flag `betaDiscount` no `/signup`, command Rust `license_signup_beta` + persistência da key + `/refresh` periódico, `BetaInviteModal` + botões (beta/feedback) + CTA dia-60, etapa OmniChat "Beta", email beta, `scripts/beta-renew.mjs`, envs (`ADMIN_TOKEN`, `BETA_DAYS`, `BETA_DISCOUNT_PCT`, `FUNNEL_STAGE_BETA`).

**Reuso:** emissão/assinatura de entitlement (Ed25519), device-binding, verificação offline (PUBKEY no app), gate community/full (`license.rs` + `canvas-store`), integração OmniChat/email, dedup por email, `/refresh`.

## Fora de escopo (v1)

Painel admin web (renovação é CLI), build/assinatura macOS, multi-cohort analytics, coleta de feedback estruturada in-app (é link pro GitHub Issues).
