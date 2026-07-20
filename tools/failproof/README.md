# failproof

Sistema de busca de erros e correções que torna sessões de agente resistentes a falso sucesso. A V2 tem três camadas independentes: **Failbase** (SQLite local de erro→fix), **Hooks** (6 registros de disciplina e ciclo de vida) e **Watchdog** (vigia sessões unattended). É 100% standalone e stdlib only; OmniMemory continua opcional.

## Instalação

Requisitos: **Python 3.10+**

```bash
cd tools/failproof
./install.sh
```

O script cria um backup recuperável, registra os 6 hooks no `~/.claude/settings.json` (merge idempotente, preserva configurações existentes) e ativa o watchdog via systemd user timer (ou imprime instrução cron).

Base de dados: `~/.claude/failbase/failbase.db`

## Arquitetura — 3 Camadas

| Camada | Módulo | O quê | Onde |
|--------|--------|-------|------|
| **1. Failbase** | `failbase.py` | SQLite FTS5 + CLI (add, search, stats, doctor, sanitize, export) | `~/.claude/failbase/` |
| **2. Hooks** | `posttool_failure_capture.py` | PostToolUse: par falha→fix automático | `~/.claude/hooks/failproof_posttool_...` |
| | | `userprompt_correction_detector.py` | UserPromptSubmit: correção humana registra |  |
| | | `stop_evidence_gate.py` | Stop: bloqueia sucesso sem execução verde |  |
| | | `sessionstart_known_failures.py` | SessionStart: injeta top-10 erros do projeto |  |
| | | `watch_register.py` | UserPromptSubmit: registra sessão unattended |  |
| | | `watch_cleanup.py` | Stop: remove o registro ao terminar normalmente |  |
| **3. Watchdog** | `watchdog.py` | Vigia sessões unattended, escala strike 1→2→3 + sync OmniMemory | cron a cada 5 min ou systemd timer |

## Confiança — observado × validado

Nem todo fix aprendido tem o mesmo peso. failproof distingue dois níveis, e a
distinção guia **como** o fix é injetado no contexto:

| Nível | Origem | `fix_validated` | Como é injetado |
|-------|--------|-----------------|-----------------|
| **observado** | heurística temporal (falha→sucesso na mesma família de comando) | `0` | *"possível fix observado num caso semelhante (NÃO confirmado) — avalie antes de aplicar"* |
| **validado** | sinal forte: correção humana (`human-feedback`) ou CI verde (`ci`) | `1` | *"fix confirmado antes — confirme que se aplica ao seu caso"* |

Correlação temporal **não é prova**: dois `git ...` seguidos (um falha, outro passa)
não garantem que o segundo corrigiu o primeiro. Por isso a captura automática grava
como **observado**, nunca como verdade — evitando empurrar o agente pro caminho errado
com voz de autoridade. O ranking (`search`, `top_for_project`) dá peso ao validado:
com o mesmo "calor", um fix validado sobe acima de um observado.

## CLI

A CLI é o script `failbase.py` instalado em `~/.claude/failbase/` — invoque com `python3` (o instalador não cria wrapper no PATH).

### add — Registrar erro + fix

```bash
# sintaxe
python3 ~/.claude/failbase/failbase.py add \
  --symptom "descrição do erro" \
  --fix "como corrigir" \
  --source {session|human-feedback|ci|watchdog} \
  --project <nome-projeto> \
  --command "<comando que falhou>" \
  --validated

# exemplo
python3 ~/.claude/failbase/failbase.py add \
  --symptom "psycopg2 connection refused host pg" \
  --fix "usar service name core-net na rede overlay" \
  --source human-feedback --project omnirift --validated
```

### search — Busca por FTS5

```bash
python3 ~/.claude/failbase/failbase.py search "connection refused"
python3 ~/.claude/failbase/failbase.py search "docker network not found" --limit 10
```

Output: JSON array de matches ordenados por relevância.

### stats — Status da base

```bash
python3 ~/.claude/failbase/failbase.py stats
```

Output: `{"total": N, "validated": N, "by_source": {"session": N, "ci": N, ...}}`

## CI — Captura red→green

Dois subcomandos, chamados em pontos distintos do pipeline. `red` registra o job que falhou; `green` fecha o par quando o mesmo job (mesmo `--branch`) volta a passar, gravando o diff da correção como fix validado.

```bash
# quando o job falhou:
python3 ~/.claude/failbase/failbase_ci.py red \
  --job pytest --branch "$BRANCH" --log out.log --project omnirift

# quando o mesmo job passou depois:
python3 ~/.claude/failbase/failbase_ci.py green \
  --job pytest --branch "$BRANCH" --diff fix.diff --project omnirift
```

`green` sem um `red` pendente para o par `job+branch` é no-op. Detalhes: `failbase_ci.py`.

## Watchdog — Sessions Unattended

Para sessões que rodam sem intervenção humana (cron, FleetView, batch):

**Registro:** Sessão unattended cria arquivo JSON em `~/.claude/failbase/watch/<session_id>.json`:

```json
{
  "session_id": "s1",
  "transcript_path": "/tmp/transcript.jsonl",
  "pid": 12345,
  "relaunch_cmd": "claude-code --project omnirift --relaunch {postmortem}"
}
```

**Strike progressiva:**
- **Strike 1:** detecta inatividade ou loop atual e gera diagnóstico.
- **Strike 2:** amplia o postmortem e recomenda mudança de estratégia.
- **Strike 3:** grava postmortem na failbase, notifica e remove o watch.

O watchdog é **observer-only por padrão**: ele não envia sinal nem relança processo. Ação destrutiva exige `FAILPROOF_ALLOW_KILL=1`, identidade de PID revalidada (start time + hash de cmdline) e comando de relaunch explícito.

## Plugin Codex global

A distribuição Codex vive em `~/plugins/failproof-v2` e no marketplace pessoal. Ela inclui skill implícita, hooks `SessionStart`, `PostToolUse`, `UserPromptSubmit` e `Stop`, além de banco próprio em `PLUGIN_DATA`.

```bash
codex plugin add failproof-v2@personal
codex plugin list
```

O marketplace marca o plugin como `INSTALLED_BY_DEFAULT`. Depois da instalação, abra uma nova thread e aprove os hooks em `/hooks`; sem essa confiança explícita o Codex mantém o plugin habilitado, mas não executa seus hooks.

**Postmortem:** `~/.claude/failbase/postmortems/<session_id>.txt` — relatório com:
- Últimos erros (signatures FTS)
- Transcrição do tail do transcript
- Fixes conhecidos que poderiam ter evitado o loop
- Recomendação de mudança de estratégia

## Plugins — Notificação e Sync

Detectados em runtime pelo prefixo `FAILPROOF_*`. Ausência nunca quebra a base.

| Plugin | Ativa com | Comportamento |
|--------|-----------|---------------|
| **notify** | `FAILPROOF_NTFY_URL` (e.g., `https://ntfy.sh/mychannel`) | Envia notificações POST JSON de watchdog strikes |
| | `FAILPROOF_TELEGRAM_TOKEN` + `FAILPROOF_TELEGRAM_CHAT` | Envia mensagens Telegram de watchdog |
| | Nenhuma | Fallback: grava alertas em `~/.claude/failbase/alerts/` (arquivo puro) |
| **sync-omnimemory** | `FAILPROOF_SYNC_CMD` | Empurra falhas novas (`synced=0`) → OmniMemory. Disparado pelo **watchdog** (a cada 5 min). Sem a env: **no-op = base 100% local e privada** |

Exemplos de env:

```bash
# notificação ntfy.sh
export FAILPROOF_NTFY_URL="https://ntfy.sh/meu-failproof-channel"

# notificação Telegram
export FAILPROOF_TELEGRAM_TOKEN="123:ABC"
export FAILPROOF_TELEGRAM_CHAT="-9876543210"
```

### Privacidade — cliente vs. equipe

O `FAILPROOF_SYNC_CMD` recebe no **stdin** um JSONL das falhas com `synced=0`; se o
comando sair `0`, elas são marcadas `synced=1`. O default (env ausente) é **não
sincronizar nada** — a base fica local. Isso separa os dois públicos sem código extra:

- **Cliente / máquina externa:** não configure a env. A base de erros é privada,
  fica só no `~/.claude/failbase` da máquina. Nada sai.
- **Dev da empresa:** configure a env para alimentar o cérebro compartilhado
  (OmniMemory) — o erro que um dev resolveu vira contexto pra todos. A distinção
  observado/validado viaja junto (o JSONL carrega `fix_validated`), então o cérebro
  não trata palpite como verdade.

```bash
# Dev da empresa — sync p/ OmniMemory (padrão file-based do CLAUDE.md).
# O ingest do outro lado insere as rows na tabela de memórias, preservando fix_validated.
export FAILPROOF_SYNC_CMD='ssh omnimemory-01 "sudo docker run -i --rm --network core-net \
  -v /tmp/failproof_ingest.py:/tmp/ingest.py python:3.11-alpine \
  sh -c \"pip install psycopg2-binary -q 2>/dev/null && python3 /tmp/ingest.py\""'
```

## Testes

```bash
cd tools/failproof
python3 -m pytest tests/ -v
```

Cobertura atual: 152 testes cobrem failbase, migração, sanitização, CLI, hooks, watchdog, CI, plugins, falha-aberto, instalação, paridade da cópia ativa, confiança observado/validado, sync OmniMemory e fumaça. O plugin Codex possui uma suíte adicional própria.

## Desinstalar

```bash
./uninstall.sh
```

Remove:
- Hooks em `~/.claude/hooks/failproof_*`
- Entradas em `~/.claude/settings.json`
- Systemd timer/service

**Preserva:** `~/.claude/failbase/failbase.db` (todos os dados, para recuperação posterior).

---

**Licença:** OmniRift license  
**Spec:** `docs/superpowers/specs/2026-07-05-failproof-design.md`
