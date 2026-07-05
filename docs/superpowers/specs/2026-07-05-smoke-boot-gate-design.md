# Smoke-test de boot — gate de CI e de release

> Status: **aprovado em brainstorm** · 2026-07-05. Hardening #1 do plano "acessibilidade +
> confiabilidade" (3 releases sem feature nova). Motivação direta: a v0.1.120 shippou com o
> app **travando no boot** (React #185 — render loop) e nada automatizado pegou; o crash foi
> encontrado rodando o app na mão (boot → grep `REACT-ERROR` no `~/.omnirift/debug.log`).
> Este design transforma essa verificação manual em dois gates automáticos.

## Objetivo

**Nenhum build que não abre limpo chega a cliente — e nenhum commit que não abre limpo
entra despercebido na main.** O smoke-test lança o app de verdade (headless), espera o
frontend bootar e assere que não houve crash. Não testa features; testa a promessa mínima:
*o app abre*.

## Decisões tomadas (com o dono)

| Decisão | Escolha |
|---|---|
| Onde barrar | **Os dois**: CI em push/PR (feedback cedo) + gate no release (bloqueia cliente) |
| Plataformas | **Só Linux (xvfb)** — o crash-alvo é do frontend (mesmo bundle nos 3 SOs); GUI headless em Win/Mac é flaky demais pra gate |
| Sem boot marker | **Retry 1×, depois FALHA** — absorve flakiness transiente do WebKitGTK sem deixar passar build que não renderiza |
| Como testar o artefato do release | **Draft-then-publish** — smoke roda no `.deb` exato do release; verde → publica, vermelho → fica draft (cliente nunca vê) |

## Componente 1 — `scripts/smoke-boot.sh <binário>` (fonte única)

Mesmo script local e na CI (filosofia dos quality-gates: o CI invoca o mesmo binário que
roda na máquina do dev).

1. **HOME temporário isolado** (`mktemp -d`) → o app grava `$HOME/.omnirift/debug.log`
   num path limpo e conhecido; não polui nem lê estado da máquina/runner.
2. **Lança o binário** sob `xvfb-run`, com rendering por software
   (`LIBGL_ALWAYS_SOFTWARE=1`, `WEBKIT_DISABLE_COMPOSITING_MODE=1`), em background,
   com `timeout` de segurança.
3. **Espera até 25s** pelo marcador `===== boot =====` no debug.log (prova que o frontend
   executou o `markBoot` de `src/lib/debug-log.ts`).
   - Sem marcador → mata, **relança 1×**; ainda sem → **FAIL** ("frontend nunca rodou").
4. Com boot confirmado, **asserções** sobre o log deste boot:
   - `[💥 REACT-ERROR]` presente → **FAIL** (classe do crash do tour);
   - panic Rust presente → **FAIL**;
   - processo morreu sozinho antes do fim da janela → **FAIL** (crash nativo).
5. Mata o app, remove o HOME temp. Exit `0`/`1` com motivo claro no stdout.

**Modo `--self-test`** (Componente 4): valida a lógica de detecção contra logs sintéticos,
sem app — garante que o gate em si não é teatro.

## Componente 2 — `ci.yml` novo (push/PR na main)

Job único Linux (`ubuntu-22.04`, mesmas deps webkit do release.yml):

1. `npm run typecheck` (raiz — já cobre `apps/desktop` desde a v0.1.121) — gate que hoje
   só existe no build de release;
2. `cargo test` (os ~530 testes Rust) — idem, hoje ninguém roda em push;
3. `npx tauri build --debug --no-bundle` — compila 3-4× mais rápido que release/LTO e
   embute o **mesmo frontend**;
4. `scripts/smoke-boot.sh --self-test` e depois `scripts/smoke-boot.sh
   apps/desktop/src-tauri/target/debug/omnirift`;
5. Cache Rust (`swatinem/rust-cache`) pra manter o PR em tempo tolerável.

Teria pego o crash do tour **no push**, antes de existir tag.

## Componente 3 — gate no `release.yml` (draft-then-publish)

Hoje o `tauri-action` builda e auto-publica (`releaseDraft: false`). Passa a:

1. `tauri-action` cria o release como **draft** (updater só lê release publicado —
   cliente nunca vê draft);
2. Job novo `smoke-gate` (needs: build, `ubuntu-22.04`): baixa o `.deb` **do próprio
   draft** (`gh release download`), instala no runner (`dpkg -i`), roda
   `scripts/smoke-boot.sh /usr/bin/omnirift`;
3. Verde → `gh release edit vX.Y.Z --draft=false` (publica; idempotente — re-publicar
   release publicado é no-op). Vermelho → **release fica draft; job falha; cliente não
   recebe nada.**

**Interação com o guard existente** (mirror Forgejo re-dispara o workflow): o guard já
pula o run quando o release está **publicado** — segue cobrindo. Draft pendurado por
smoke vermelho: um re-run/re-tag re-builda e tenta de novo — comportamento desejado.
O `latest.json` é anexado pelo tauri-action no draft e só fica visível ao updater na
publicação — o feed nunca aponta pra artefato não-smoked.

**Fidelidade:** o smoke roda no artefato exato que o cliente instala (não um build irmão),
sem pagar build Linux duplicado.

## Componente 4 — testar o próprio gate

1. **`--self-test` permanente** (roda em todo ci.yml): casos sintéticos —
   log com boot limpo → PASS; log com `[💥 REACT-ERROR]` → FAIL; log vazio → FAIL
   pós-retry. Valida parsing/decisão sem app quebrado.
2. **Prova de fogo, uma vez:** branch descartável com `throw` no boot do frontend →
   confirmar smoke **vermelho** no runner real; reverter. Só depois disso o gate do
   release entra em vigor.

## Rollout (ordem de menor risco)

1. `scripts/smoke-boot.sh` + self-test, validado **local** contra o binário atual;
2. `ci.yml` (não bloqueia release de ninguém) + prova de fogo do caso-quebrado;
3. `release.yml` draft-then-publish — só após 1 e 2 verdes.

## Fora de escopo (YAGNI)

- Smoke em Windows/macOS (flaky como gate; reavaliar se surgir crash nativo específico);
- Testes de feature/E2E de UI (outro projeto — este gate só garante "abre limpo");
- Screenshot/visual diff;
- Gate de contexto MCP no spawn (hardening separado, já mitigado pelo strict-mcp).

## Riscos e mitigação

| Risco | Mitigação |
|---|---|
| Flakiness do WebKitGTK headless no runner | retry 1×; rendering por software; janela de 25s |
| Runner sem deps de GUI | ci/release já instalam webkit2gtk pro build; adicionar `xvfb` |
| Draft pendurado confunde | guard existente + re-run re-tenta; draft é invisível a cliente |
| Gate que não pega nada (teatro) | `--self-test` em todo run + prova de fogo antes de ativar |
