# Biblioteca de Hooks acionáveis — design (aprovado em conversa 2026-07-10)

> Status: **design aprovado** (abordagem A + 3 decisões de produto abaixo). Falta: plano de
> implementação (`writing-plans`) + execução. Contexto: depois do config dir isolado
> (`agent-clean-hooks`, commit `1b379cb`), TUDO que o agente tem vem do nosso `--settings`
> — o que torna viável curar hooks por role.

## Decisões de produto (Jessé, 2026-07-10)

1. **Granularidade:** default por ROLE + override por AGENTE (nó).
2. **Catálogo v1:** review-gate (Stop, o caro), failproof (3 hooks), recitação (📿) e
   hooks CUSTOMIZADOS do usuário. Hook de STATUS (working/done) fica sempre ligado —
   a orquestração depende dele pro settle do `agent_ask`.
3. **UI:** seção "Hooks" no editor de role ✎ (defaults + cadastro de customizados) +
   submenu no card do agente (override; agente vivo → oferece reload, fluxo do switchCli).

## Arquitetura (abordagem A — catálogo no frontend)

- **`lib/hook-library.ts` (novo):** catálogo (3 built-ins + customizados
  `{id, label, event, matcher?, command, timeoutS}`), persistido em localStorage
  `omnirift-hook-library` = `{ custom: [], roleDefaults: Record<roleId, Record<hookId, bool>> }`.
  Defaults na ausência = comportamento atual: review ON, failproof ON, recitation OFF, custom OFF.
- **Resolução pura:** `effectiveHooks(roleId, nodeOverrides)` — precedência
  nó > role > catálogo. Flag global `failproof-agents` segue como kill-switch master (AND).
  Nó ganha `hookOverrides?: Record<hookId, boolean>` (persistido com o canvas).
- **Rust:** `agent_settings_config(label, hooks: {review, failproof, custom: Vec<CustomHook>})`
  (evolui a assinatura atual `failproof: bool`; ~7 callers via `agentSettingsConfig`).
  Status sempre embutido. Custom anexado no evento correspondente, timeout default 30s, teto 180s.
  Falha-aberto mantido.
- **Recitação:** NÃO vira settings JSON — é comportamento do app (`recitation.ts`); o toggle
  por role liga o 📿 no spawn.

## Segurança

Comando custom roda com o trust do usuário (igual terminal); timeout obrigatório;
aviso na UI pra não embutir secrets no comando.

## Testes

- Rust: units do builder no `review_cfg.rs` (padrão existente; cobrir merge de eventos
  com custom hooks).
- TS: `effectiveHooks` pura com teste de precedência.
- Manual: role com review OFF → turno fecha rápido; custom hook `touch /tmp/x` dispara.

## Fatos empíricos que ancoram o design (testados 2026-07-10)

- `disableAllHooks` em `--settings` mata TAMBÉM os hooks do próprio settings → nunca usar
  (quebraria o status tracking).
- `CLAUDE_CONFIG_DIR` isolado + `.claude.json` copiado + credenciais copiadas = agente
  autentica e os hooks do `--settings` disparam; globais ficam de fora.
