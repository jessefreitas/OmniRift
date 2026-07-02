# OmniRift — Pendências e Roadmap

> Snapshot do que **falta** no OmniRift. Atualizado em 2026-07-01 (v0.1.71 publicada).
> Organizado por prioridade. O design de cada item está na memória do projeto (`~/.claude/projects/.../memory/`).

---

## ✅ Entregue na v0.1.71 (PUBLICADA — tag + CI disparado)

- **Fleet bar:** progresso agregado dos agentes paralelos no canvas (N/M prontos · tempo · tokens).
- **Kanban com colunas customizáveis por projeto** (em cima das 6 colunas estilo Jira da 0.1.70).
- **`agent_sleep` / `agent_wake`** via MCP — o Orquestrador pausa/acorda agentes do time.
- **Custo "Hoje" honesto:** estava inflado ~61% por dupla contagem — deflacionado.
- **Dedupe de labels** + **fix da scrollbar fantasma**.
- **Pipeline:** providers com mesmo nome no dropdown distinguidos (sufixo modelo/kind) +
  **modelo PERSONALIZADO no subagente** + atalho pra Central de API.

## ✅ Embutido (v0.1.70, sem release próprio)

- **Kanban do projeto:** backend SQLite (`kanban_cards`) + painel — agentes movem cards via MCP,
  usuário acompanha; 6 colunas estilo Jira (Backlog / Em andamento / Teste / Review / Bloqueado / Concluído).
- **Fix travamento do Arquiteto de Pipeline:** abrir o modal TRAVAVA o app (seletor instável em loop).
- **Reload sem perder a persona:** OmniAgent re-injeta; terminal ganha ⟳ sempre visível.
- **Restore:** canal MCP sobrevive ao reabrir projeto/snapshot; card do subagente não estoura;
  `parentAgentId` remapeado (subagente não vira órfão); resume morto (código 129) sobe sessão nova.
- **Canvas leve:** xterm em WebGL + LOD por zoom + cap de mensagens.
- **Persona ≠ engine parte 2:** troca de PROVIDER mantém o papel + `set_model` honesto.

## 🔴 Estruturais restantes (tasks de verdade, não polish)

- **Conexões cor-por-estado** (🔶 em andamento): edge por estado — branco idle / azul saindo /
  verde entrando / vermelho parado. Terminais já pulsam verde na atividade; falta direção/estado por edge.
- **Central de copia-cola** (snippet manager): texto + código + imagem, SQLite persistente,
  cola/arrasta pra qualquer nó. Separado do blackboard dos agentes.
- **AGENTS.md por agente:** instruções persistentes por agente do canvas (contrato de papel versionado).
- **Evict/compactação do OmniAgent:** sessão ACP longa cresce sem limite — falta política de
  evict + compactação de contexto.
- **Backend-owned sessions:** sessão do agente pertencer ao backend Rust (sobrevive a reload do
  webview / restart do front), não ao node React.
- **Revisitar o plano contra o andamento (diff rico):** o badge X/Y montados existe; falta o diff
  qualitativo plano ↔ canvas (agente renomeado, conexão removida, modelo trocado).

## 🔵 Fases do produto (CLAUDE.md do projeto)

- **Fase 6 — Routines fase 2:** MVP entregue. Falta **triggers de floor + gate**.
- **Fase 8 — Memória plugável:** Fase 1 completa + keychain. Multi-DB Postgres = esquecer.
- **Fase 9 — OmniPartner Aprender** (tutor socrático): spec draft, não iniciado. 9a/9c/9e ✅, 9b/9d ⏳.
- **Mobile:** M1 push / M2 pareamento (APK Expo já roda), OU relay 4G Tasks 5–8 (relay próprio CF
  Worker + DO já no ar — Fase 1 Tasks 1–4 done).

## ⚪ Polish e pequenos

- **Modelo/contexto no header do node (terminal):** leitura da statusline é frágil (follow-up).
- **Central de API — consumidores:** mapeamento `kind` pela baseUrl é best-effort; pode refinar.
- **Filtro por IA:** funciona; o `result` como tipo de payload ainda é pouco usado.

## ✅ Validações pendentes (testar, não construir) — na 0.1.71

- Reinstalar o `.deb` **0.1.71** e testar de verdade:
  - Fleet bar com 2+ agentes paralelos (progresso agregado + tempo + tokens).
  - Kanban: criar coluna customizada por projeto + agente movendo card via MCP.
  - `agent_sleep`/`agent_wake` pelo Orquestrador.
  - Custo "Hoje" batendo com o esperado (sem a dupla contagem).
  - Regressões 0.1.70: Arquiteto de Pipeline abre sem travar, reload mantém persona,
    reabrir projeto mantém canal MCP + subagentes.

## 🚫 Não fazer (decisões travadas)

- **Multi-DB Postgres** (Fase 2 memória) — esquecer.
- **CSP** por conta própria — é da equipe de beta.
- **`/admin/beta/mint`** — o Jessé pediu pra não fazer.
- **Nome de concorrente no repo** — NUNCA (repo público).
