# OmniRift — Pendências e Roadmap

> Snapshot do que **falta** no OmniRift. Atualizado em 2026-07-01 (v0.1.69).
> Organizado por prioridade. O design de cada item está na memória do projeto (`~/.claude/projects/.../memory/`).

---

## ✅ Entregue na v0.1.69 (o lote estrutural fechou)

- **Montar completo (Arquiteto de Pipeline):** brief compartilhado + subagentes (v0.1.68) e agora
  **floors (paralelos) REAIS** quando o plano pede (targetFloorId em addAgent/addSubagent/addEdge;
  1º floor do plano = floor ativo; reuso idempotente por nome; gate de licença → fallback pro ativo;
  conexões cross-floor puladas — floors são canvases isolados), **toggle terminal-com-role**
  (claude nativo com persona via `--append-system-prompt` + `--model` do plano) e **modelo sugerido
  nos agentes PRINCIPAIS** (providerConfig → aplicado no ready via configOption "model").
- **Persona ≠ engine parte 2 (cross-provider):** seletor de provider no header do OmniAgent
  (claude/codex/hermes) — re-spawna com o adapter novo e RE-INJETA a persona (nova conversa;
  histórico não cruza adapters por design do ACP).
- **Task #6 (Hermes/ministral):** causa raiz = adapter nasce em `ministral-3:3b` e a resposta do
  `session/set_model` (id=6/7) era IGNORADA no read-loop → falha silenciosa + badge otimista mentindo.
  Agora: recusa vira evento `acp://model-rejected` → badge reverte pro modelo confirmado + aviso.
- **Duplo-clique no header do TERMINAL → tela cheia** (no nome continua renomeando).
- **Badge X/Y montados** agora conta agentes em TODOS os floors do projeto (não só o ativo).

## 🔴 Estruturais restantes

### Revisitar o plano contra o andamento (diff rico)
O badge X/Y montados existe. Falta o diff qualitativo plano ↔ canvas: **o que divergiu**
(agente renomeado, conexão removida, modelo trocado) — acompanhamento de projeto de verdade.

## 🟡 Parciais (funcionam, dá pra melhorar)

- **Conexões animadas:** terminais pulsam verde na atividade. Falta direção/estado completo
  (branco idle / azul saindo / verde entrando / vermelho parado) por edge.
- **Central de API — consumidores:** Hermes, OmniPartner e review usam. Mapeamento `kind` pela
  baseUrl é best-effort; pode refinar.
- **Filtro por IA:** funciona; o `result` como tipo de payload ainda é pouco usado.

## 🟢 Backlog antigo (memória do projeto)

- **Central de copia-cola** (snippet manager): texto + código + imagem, SQLite persistente,
  cola/arrasta pra qualquer nó. Separado do blackboard dos agentes.

## 🔵 Fases do produto (CLAUDE.md do projeto)

- **Fase 6 — Routines:** MVP entregue. Falta **triggers de floor + gate**.
- **Fase 8 — Memória plugável:** Fase 1 completa + keychain. Multi-DB Postgres = esquecer.
- **Fase 9 — OmniPartner Aprender** (tutor socrático): spec draft, não iniciado. 9a/9c/9e ✅, 9b/9d ⏳.

## ⚪ Polish e pequenos

- **Modelo/contexto no header do node (terminal):** leitura da statusline é frágil (follow-up).
- **CSP:** delegado à equipe de beta teste (decisão do Jessé — não fazer por conta própria).

## ✅ Validações pendentes (testar, não construir) — agora na 0.1.69

- Reinstalar o `.deb` **0.1.69** e testar de verdade:
  - Arquiteto de Pipeline com plano de 2+ paralelos → floors criados de verdade + toggle terminal.
  - Modelo sugerido aparecendo nos OmniAgents principais (badge após ready).
  - Trocar provider no header do OmniAgent → persona re-injetada.
  - Hermes: escolher modelo ≠ ministral e ver se o badge fica honesto (recusa aparece como aviso).
  - Duplo-clique no header do terminal → fullscreen; no nome → renomear.
  - Copy/paste do terminal, deletar linha, conexão fácil, canvas por pasta (regressão 0.1.68).
- **Mobile:** M1 push / M2 pareamento (APK Expo já roda), OU relay 4G Tasks 5–8.

## 🚫 Não fazer (decisões travadas)

- **Multi-DB Postgres** (Fase 2 memória) — esquecer.
- **CSP** por conta própria — é da equipe de beta.
- **`/admin/beta/mint`** — o Jessé pediu pra não fazer.
- **Nome de concorrente no repo** — NUNCA (repo público).
