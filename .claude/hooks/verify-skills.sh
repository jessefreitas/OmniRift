#!/usr/bin/env bash
# SessionStart hook — verifica que o marketplace OmniForge está instalado.
#
# Instalado automaticamente pelo template project-base em .claude/settings.json:
#   {
#     "hooks": {
#       "SessionStart": [
#         {"type": "command", "command": "bash .claude/hooks/verify-skills.sh"}
#       ]
#     }
#   }
#
# Saída esperada (stdout vira contexto adicional na sessão Claude).

set -eu

PLUGINS_JSON=".claude/plugins.json"
CLAUDE_PLUGINS_DIR="${HOME}/.claude/plugins/installed_plugins.json"
STATUS_LOG=".claude/skills-status.log"

mkdir -p "$(dirname "$STATUS_LOG")"
: > "$STATUS_LOG"

log() { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a "$STATUS_LOG" >&2; }

if [ ! -f "$PLUGINS_JSON" ]; then
  log "FATAL: $PLUGINS_JSON não encontrado — template OmniForge ausente."
  exit 0
fi

MARKETPLACE="$(grep -oE '"marketplace"[[:space:]]*:[[:space:]]*"[^"]+"' "$PLUGINS_JSON" | head -1 | sed -E 's/.*"([^"]+)"$/\1/')"
MARKETPLACE="${MARKETPLACE:-omniforge/skills_transformers}"

# extrai itens do bloco "required": [...]
REQUIRED_PLUGINS_RAW="$(awk '/"required"[[:space:]]*:[[:space:]]*\[/{flag=1; next} flag && /\]/{exit} flag{print}' "$PLUGINS_JSON" \
  | grep -oE '"[^"]+"' | tr -d '"')"

if [ -z "$REQUIRED_PLUGINS_RAW" ]; then
  log "FATAL: nenhum plugin obrigatório declarado em $PLUGINS_JSON."
  exit 0
fi

missing=()
while IFS= read -r p; do
  [ -z "$p" ] && continue
  if ! grep -qE "\"${p}(@[^\"]+)?\"" "$CLAUDE_PLUGINS_DIR" 2>/dev/null; then
    missing+=("$p")
  fi
done <<< "$REQUIRED_PLUGINS_RAW"

if [ ${#missing[@]} -eq 0 ]; then
  log "OK — todos os plugins OmniForge obrigatórios instalados."

  # Audit obrigatório: se não houver lock OU lock >30 dias, avisa na sessão
  AUDIT_LOCK=".claude/omniforge-audit.lock"
  if [ ! -f "$AUDIT_LOCK" ]; then
    log "AUDIT PENDENTE: projeto nunca foi auditado."
    cat <<'EOF'
## Audit OmniForge — OBRIGATÓRIO antes de trabalho novo

Este projeto ainda **não foi auditado** contra o padrão OmniForge (ISO 27001 +
OWASP + dev flow + code excellence + docs + observability).

**Regra cardinal:** sem audit verde, nenhuma feature nova é autorizada.

### Rodar agora

Peça ao Claude: `audita o projeto`

A skill `omniforge-legacy-audit` vai:
1. Varrer o repo inteiro (≤90s em repos de 100k LOC)
2. Emitir score 0-100 + relatório em `docs/omniforge-audit/<ts>.md`
3. Categorizar desvios (crítico/alto/médio/baixo)
4. Gerar plano de remediação acionável
5. Criar issues GitHub + cards Kanban para críticos

Se score ≥ mínimo do profile (default standard = 90), autoriza o trabalho.
Se score < mínimo, `omniforge-remediation` aplica fixes automáticos.
EOF
  else
    # parse score do lock (formato JSON simples)
    LAST_TS="$(grep -oE '"timestamp"[[:space:]]*:[[:space:]]*"[^"]+"' "$AUDIT_LOCK" | head -1 | sed -E 's/.*"([^"]+)"$/\1/')"
    LAST_SCORE="$(grep -oE '"score"[[:space:]]*:[[:space:]]*[0-9]+' "$AUDIT_LOCK" | head -1 | sed -E 's/.*:[[:space:]]*([0-9]+).*/\1/')"
    log "Audit mais recente: score=${LAST_SCORE:-?} ts=${LAST_TS:-?}"

    # check expiração (30 dias)
    if [ -n "${LAST_TS:-}" ]; then
      LAST_EPOCH="$(date -d "$LAST_TS" +%s 2>/dev/null || echo 0)"
      NOW_EPOCH="$(date +%s)"
      AGE_DAYS=$(( (NOW_EPOCH - LAST_EPOCH) / 86400 ))
      if [ "$AGE_DAYS" -gt 30 ]; then
        log "AUDIT EXPIRADO: último audit foi há ${AGE_DAYS}d (limite: 30d)."
        cat <<EOF
## Audit OmniForge — EXPIRADO

Último audit foi há **${AGE_DAYS} dias** (limite: 30 dias). Peça ao Claude: \`re-audita\`.
EOF
      fi
    fi
  fi

  exit 0
fi

log "FALTANDO plugins obrigatórios: ${missing[*]}"
log "Marketplace esperado: $MARKETPLACE"

cat <<EOF
## Skills OmniForge — aviso de configuração

Este projeto OmniForge requer os plugins abaixo instalados no Claude Code, mas estão **faltando**:

${missing[*]/#/- }

### Como resolver agora

1. Instale o marketplace:
   \`\`\`
   /plugin marketplace add $MARKETPLACE
   \`\`\`

2. Instale os plugins obrigatórios:
$(for p in "${missing[@]}"; do echo "   \`/plugin install $p@$MARKETPLACE\`"; done)

3. Abra nova sessão. Este hook validará novamente.

Sem essas skills, comportamentos padrão do agente OmniForge (worktrees, dev flow, arquitetura, kanban, memória) **não se aplicam**.

Log em \`$STATUS_LOG\`.
EOF

exit 0
