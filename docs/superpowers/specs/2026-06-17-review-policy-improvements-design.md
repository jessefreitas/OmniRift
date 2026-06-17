---
status: active
title: Melhorias da Política de Review — code-review mais assertivo
date: 2026-06-17
---

# Melhorias da Política de Review — Design

**Goal:** Deixar o code-review-ai cada vez mais **assertivo** (menos ruído, mais sinal) e o desenvolvimento mais seguro — evoluindo a tela "Política de Review" (`ReviewPolicyModal.tsx`) + os scripts `ci-code-review.py` / `local-review.py`.

**Contexto:** Hoje a política tem categorias (peso + bloqueia), thresholds (máx CRITICAL/WARNING), limites de PR e "contratos/regras extras". Nesta sessão o gate passou a **respeitar as categorias bloqueantes** (só Segurança bloqueia), ganhou **contexto de design** (`.forgejo/review-context.md`) e **supressão determinística** de falso-positivos reconhecidos. Este design constrói em cima disso.

---

## Princípios

- **Sinal > ruído.** WARNINGs de IA são advisory; o gate bloqueia só no que importa (CRITICAL de categoria bloqueante). Falso-positivo reincidente vira supressão explícita, não fadiga.
- **Curadoria barata.** Presets e edição in-app, não YAML na mão.
- **Aprende com o histórico.** O review fica melhor sabendo o que já apontou e o que foi aceito.

---

## Fase 1 — Curadoria na tela (UI, alto valor / baixo esforço)

### 1a. Presets de rigor
Um seletor **Frouxo / Padrão / Rígido** que seta de uma vez: thresholds, quais categorias bloqueiam e o coverage alvo.
- *Frouxo*: só Segurança CRITICAL bloqueia; resto advisory.
- *Padrão*: Segurança bloqueia (CRITICAL + 2 WARNING); demais advisory.
- *Rígido*: Segurança + Qualidade bloqueiam; coverage 90%.
- Modelo: `policy.preset` + um botão que aplica o template (ainda editável depois).

### 1b. Contexto de design editável (Brain Connect do reviewer)
A tela ganha um campo grande **"Contexto de design (o reviewer respeita)"** que edita o `.forgejo/review-context.md` direto do app (hoje só arquivo). É onde se declara intenção (chave pública embutida, ofuscação at-rest, threat model). Comando Rust novo `review_context_read/write`.

### 1c. Supressões geríveis
A lista `SUPPRESS` (achados aceitos por arquivo+palavra) hoje vive no script. Trazer pra tela: **"Achados aceitos"** — uma lista editável de `{arquivo, palavra-chave, motivo}`. Persistida no config; lida pelos dois scripts. Cada supressão exige um **motivo** (auditável).

---

## Fase 2 — Histórico de findings (aprendizado)

Persistir cada review (no SQLite / blackboard): `{pr, sha, file, category, severity, title, verdict, ts}`.
- **Reincidência**: marca um achado que já apareceu N× ("esse bug voltou 3×") — prioriza.
- **Tendência**: gráfico simples "achados por review ao longo do tempo" → o código está melhorando?
- **Fechar o loop**: quando um achado some entre reviews, conta como resolvido.
- UI: aba "Histórico" no `ReviewModal`. Comandos `review_history_add/list`.

---

## Fase 3 — Regras ligadas a paths

Frontmatter/políticas por caminho (glob):
- `src/api/** → exige teste correspondente`
- `**/migrations/** → exige categoria DBA no review (peso alto)`
- `*.rs com unsafe → Segurança obrigatória`

Modelo: `policy.pathRules: [{glob, require: ["test"|"dba"|...], categoryBoost}]`. O preflight injeta um finding quando uma regra de path é violada (determinístico → confiável). Casa com o aviso de sobreposição de specs (`paths`) que já existe.

---

## Fase 4 — Auto-fix sugerido

Para findings com `suggestion`, oferecer **aplicar**:
- Botão "Corrigir" → despacha um **agente** (1 task) com o finding + o trecho → ele aplica o patch na branch e re-roda o review (fecha o loop de [[spec-lifecycle-orquestracao]]).
- Ou, pra fixes triviais determinísticos (remover console.log, etc.), patch direto.
- Respeita o teto de agentes + aprovação do Orquestrador.

---

## Fase 5 — Diff-aware inline

O review já manda `file`+`line`. Mostrar o **trecho exato inline** num node de review (em vez de só listar), com o highlight da linha. Reaproveita o Preview/editor: abre o arquivo no ponto, com o finding ancorado. Permite "aceitar"/"corrigir"/"ignorar" por achado ali mesmo.

---

## Plano de implementação (fases independentes, por valor)

1. **Fase 1** (presets + contexto editável + supressões geríveis) — UI + 2 comandos Rust. Entrega o maior ganho de assertividade com menos código.
2. **Fase 3** (regras por path) — determinístico, alto valor de segurança.
3. **Fase 2** (histórico) — persistência + UI.
4. **Fase 5** (inline) — UX do review.
5. **Fase 4** (auto-fix) — o mais complexo (orquestração); por último.

Ordem por valor/esforço: 1 → 3 → 2 → 5 → 4.

---

## Riscos / decisões abertas

- **Presets** não devem sobrescrever ajustes manuais sem aviso (aplicar = template inicial, editável).
- **Supressões geríveis** podem virar tapete pra esconder bug real → exigir motivo + mostrar contagem de quantos achados cada supressão engole.
- **Auto-fix** num PR grande é arriscado (patch errado) → sempre via agente + re-review, nunca cego.
- **Histórico** cresce — rotacionar/limitar como os snapshots.
