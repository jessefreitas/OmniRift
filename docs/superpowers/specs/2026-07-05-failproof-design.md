# failproof — Sistema de busca de erros e correções à prova de falhas

**Data:** 2026-07-05
**Status:** Aprovado (design validado em brainstorming com Jessé)
**Escopo:** Ciclo completo — comportamento de sessão Claude Code (Opus), output entregue e agentes autônomos, com aprendizado persistente entre sessões.

## Objetivo

Dar ao Opus (e a qualquer sessão Claude Code) um padrão sistemático de busca de erros e correções:

1. Toda falha vira registro estruturado (sintoma → causa raiz → fix validado).
2. Erro já visto = correção instantânea, sem re-diagnóstico.
3. Disciplina enforçada por hooks: nada é declarado "corrigido" sem evidência de execução real.
4. Agentes autônomos se auto-recuperam de travamentos/loops com escala progressiva.

## Requisito de portabilidade (não-negociável)

O núcleo funciona **100% standalone** em qualquer máquina/projeto, sem OmniMemory, sem cluster, sem rede. Integrações do ecossistema OmniForge são **plugins opcionais detectados em runtime** — princípio "detecção, não configuração". Ambiente sem nada = SQLite + hooks + watchdog em cron puro.

## Arquitetura — 3 camadas + plugins

```
┌─────────────────────────────────────────────────┐
│ Camada 1 — FAILBASE (cérebro)                    │
│ SQLite local: ~/.claude/failbase/failbase.db     │
│ CLI: failbase.py (add/search/stats/export)       │
│ Núcleo: ZERO dependência externa (stdlib only)   │
├─────────────────────────────────────────────────┤
│ Camada 2 — HOOKS (disciplina)                    │
│ PostToolUse  → captura par falha→fix             │
│ UserPromptSubmit → detecta correção humana       │
│ Stop         → gate "corrigido sem evidência"    │
│ SessionStart → injeta erros conhecidos do projeto│
│ Todos falham-aberto (erro no hook nunca trava)   │
├─────────────────────────────────────────────────┤
│ Camada 3 — WATCHDOG (rede de segurança)          │
│ watchdog.py via systemd user timer / cron        │
│ Vigia transcripts de sessões unattended          │
│ Escala: re-tenta → reinicia c/ postmortem →      │
│         para + notifica                          │
├─────────────────────────────────────────────────┤
│ PLUGINS opcionais (detectados em runtime)        │
│ • sync-omnimemory: failbase → pgvector           │
│ • notify: ntfy/Telegram para o watchdog          │
└─────────────────────────────────────────────────┘
```

Propriedade central: **cada camada falha independente**. Hook falha-aberto, sync atrasa mas não bloqueia, watchdog é externo à sessão que vigia.

## Camada 1 — Failbase (modelo de dados)

```sql
CREATE TABLE failures (
  id            INTEGER PRIMARY KEY,
  signature     TEXT NOT NULL,        -- hash normalizado do erro (comando + classe de erro, sem paths/timestamps)
  error_class   TEXT,                 -- ex: "pytest-assertion", "docker-network", "ssh-auth", "buffering-stdout"
  symptom       TEXT NOT NULL,        -- erro cru, truncado em 2KB
  root_cause    TEXT,                 -- diagnóstico
  fix           TEXT,                 -- o que resolveu (comando/diff/explicação)
  fix_validated INTEGER DEFAULT 0,    -- 1 = fix confirmado por execução verde
  source        TEXT,                 -- session | human-feedback | ci | watchdog
  project       TEXT,                 -- slug do projeto
  hits          INTEGER DEFAULT 1,    -- reincidência — erro que volta sobe no ranking
  created_at    TEXT,
  last_seen_at  TEXT
);
CREATE VIRTUAL TABLE failures_fts USING fts5(symptom, root_cause, fix);
```

- **Sem OmniMemory:** busca FTS5 nativa do SQLite ("erro parecido com esse").
- **Com OmniMemory:** plugin adiciona busca semântica por embedding (pgvector).
- **`signature` normalizada** permite lookup ~1ms no hook PostToolUse: "esse erro eu já vi" → devolve fix conhecido no tool result.
- CLI `failbase.py`: `add`, `search`, `stats`, `export` (stdlib only).

## Camada 2 — Hooks

Todos Python stdlib, falham-aberto (try/except global → exit 0), timeout interno de 2s.

### `posttool_failure_capture.py` (PostToolUse, matcher Bash)
- Buffer de sessão em `~/.claude/failbase/session_buffer/<session_id>.jsonl`.
- Comando com exit ≠ 0 → registra pendência com `signature`.
- Comando parecido depois passa → fecha o par: grava `(symptom, fix=comando que passou, fix_validated=1)`.
- Comando **falha** e signature já existe com fix validado → injeta no tool result:
  `💡 Failbase: erro conhecido (visto Nx). Fix que funcionou: <fix>`.

### `userprompt_correction_detector.py` (UserPromptSubmit)
- Regex leve: "tá errado", "não é assim", "regressão", "de novo isso", variações.
- Detectou → injeta instrução: "O usuário corrigiu você. Antes de responder, registre na failbase o que você fez de errado e qual o entendimento correto (`failbase.py add --source human-feedback`)."
- Gatilho determinístico; o conteúdo do registro é do modelo (só ele sabe a causa raiz).

### `stop_evidence_gate.py` (Stop)
- Varre final do transcript: resposta declara sucesso ("corrigido", "funcionando", "pronto", "resolvido") **e** não há execução verde (exit 0 de teste/build/comando) após a última edição de arquivo → bloqueia: "Declarou corrigido sem evidência de execução. Rode a validação antes de concluir."
- **Máximo 1 bloqueio por turno** (flag em arquivo) — nunca cria loop infinito; segunda passada libera mas marca scorecard.

### `sessionstart_known_failures.py` (SessionStart)
- Injeta top-10 erros do projeto atual, ranking `hits × recência`, formato compacto (~500 tokens max):
  "Erros já conhecidos neste projeto — não repita: …".

## Camada 3 — Watchdog progressivo

`watchdog.py` a cada 5 min (systemd user timer; fallback cron). Vigia sessões unattended (FleetView, cron, `OMNI_UNATTENDED`).

**Detecção:**
- Transcript sem evento novo há N min (default 20); ou
- Loop: mesma signature de erro ≥3x seguidas; ou
- Processo morto com task incompleta.

**Escala progressiva** (estado por sessão em `~/.claude/failbase/watchdog_state.json`):

| Strike | Ação |
|--------|------|
| 1 | Injeta na sessão (ou mata e relança com prompt aumentado): erro detectado + fixes conhecidos da failbase + "tente estratégia diferente" |
| 2 | Mata a sessão, gera postmortem automático (últimas N ações, erro repetido, o que já foi tentado), relança sessão nova com postmortem no contexto |
| 3 | Para de vez, grava postmortem na failbase (`source=watchdog`), notifica (plugin ntfy/Telegram; fallback: `~/.claude/failbase/alerts/` + log) |

Todo postmortem alimenta a base — a próxima sessão em tarefa parecida nasce sabendo o que não funciona.

## Fontes de captura (todas automáticas)

1. **Falhas de execução na sessão** — par falha→fix capturado pelo hook PostToolUse.
2. **Correções humanas** — feedback do usuário detectado no UserPromptSubmit.
3. **CI/gates vermelhos** — `failbase-ci.py` chamável de qualquer pipeline (Forgejo Action ou pre-push local): job falhou → registra symptom; branch verde depois → fecha o par com o diff que corrigiu. Standalone, sem acesso ao cluster.
4. **Agentes autônomos** — postmortems do watchdog.

## Instalação e portabilidade

Repo próprio `failproof` com `install.sh`:
- Copia hooks para `~/.claude/hooks` (ou `.claude/` do projeto).
- Registra no `settings.json` via **merge** (não sobrescreve).
- Cria o DB e diretórios.
- Detecta plugins viáveis (OmniMemory? ntfy? systemd?) e ativa só o que existe.
- Desinstalação limpa (`uninstall.sh`).

## Plugins opcionais

- **sync-omnimemory:** daemon leve (systemd user timer) espelha failbase → pgvector do cluster para busca semântica cross-máquina e consolidação. Ausente = nada quebra.
- **notify:** ntfy/Telegram para alertas do watchdog. Sem config = log + arquivo em `alerts/`.

## Testes (pytest)

- **Unit:** normalização de signature, ranking (`hits × recência`), busca FTS.
- **Integração:** hooks contra transcripts sintéticos — par falha→fix capturado; gate bloqueia falso sucesso; gate não bloqueia sucesso com evidência; watchdog escala 1→2→3 corretamente.
- **Fumaça:** `install.sh` em diretório temporário; merge de settings.json idempotente.
- **Invariante crítico:** exceção interna em qualquer hook vira exit 0 (hook nunca quebra sessão) — teste explícito.

## Fora de escopo (YAGNI)

- UI/dashboard (a CLI `stats` cobre).
- Busca semântica local sem cluster (FTS5 basta no standalone).
- Auto-fix aplicado sem sessão (watchdog relança sessões; não edita código sozinho).
- Multi-usuário/multi-tenant no DB local.
