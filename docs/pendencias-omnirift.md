# OmniRift — Pendências e Roadmap

> 🔴 **ESTE DOC ESTÁ DEFASADO (snapshot de 2026-07-02, na v0.1.72).** Hoje (07-06) o
> publicado é a **v0.1.125**. Muita coisa listada abaixo como "falta" JÁ FOI ENTREGUE
> (Fase 9 completa, Bloco E, failproof no app, etc.). **Fonte de verdade = `docs/STATUS.md`**
> (auditado contra o código). Auditorias baseadas neste arquivo geram alarme falso —
> confira no STATUS.md ou no `git log`/`releases.ts` antes de "corrigir" qualquer item.

> Snapshot do que **falta** no OmniRift. Atualizado em 2026-07-02 (v0.1.77 em preparo; v0.1.72 é o último PUBLICADO pros clientes).
> Organizado por prioridade. O design de cada item está na memória do projeto (`~/.claude/projects/.../memory/`).

---

## ✅ Entregue (local, aguardando publicação — clientes estão na v0.1.72)

**OmniFS integrado (0.1.76/0.1.77) — filesystem de agentes de IA na instalação:**
- Detecção + injeção das tools `omnifs_*` em todo agente via `--connect` (busca semântica CROSS-projeto, snapshot, log, index); `rollback` bloqueado nos agentes.
- Daemon gerenciado (respeita o do usuário); "Criar minha Pasta de Projetos OmniFS" 1-clique.
- Painel de acompanhamento (status/espaço/timeline de snapshots com Restaurar humano/reindex) + chip 🗄️ no rodapé.
- F3: snapshot automático pré-onda no Montar + re-index no turn-done + evict pesquisável.

**Aprender (Fase 9 A0+A1):** modo tutor socrático no OmniPartner, **4 trilhas de linguagem** (Shell/Python/JS/HTML+CSS) × 2 exercícios verificáveis, dica graduada 1→3 via `llm_via_cli` (sem chave), Verificar via run_check. A1: contrato socrático no Rust + teste anti-vazamento de solução.

**Arquitetura backend-owned sessions (F1+F2+F3):** sessões ACP/PTY donas do backend — trocar de floor não mata agente; resume pós-restart; canvas virtualizado (onlyRenderVisibleElements).

**Produto:** Arquiteto = agente local sem chave (default) + templates ⚡ prontos; Routines fase 2 (triggers de floor + gate de Land); delete de agente com confirmação; card de permissão não estoura; ⟳ resiliente pós-morte.

## 🔴 Estruturais restantes

- **Mobile 4G** (relay Tasks 5–8: desktop dial + offer + fallback + E2E) — última fronteira, cross-repo, sessão própria.
- **OmniFS GC/prune** do store (roadmap do OmniFS — pré-requisito comercial; store só cresce).
- **Aprender A2–A4:** perfil do aluno na memória, grounding Serena/Context7, exercício→card no Kanban, modos Fazer/Par (sobre ACP).
- **Bundle do omnifs-mcp no CI** (externalBin por-triple; hoje cai pro ~/.cargo/bin/PATH).
- **Revisitar plano×andamento (diff rico):** o que divergiu, não só X/Y montados.

## 🟡 Parciais / polish

- Conexões cor-por-estado ✅ (direção nos pipes); refinar casos de review.
- OmniFS proveniência por agente (quem escreveu o quê) — depende de branches nomeadas no OmniFS.
- Overscan no pan (anti-churn da virtualização); trigger pós-land nas Routines; Codex/wrapper como engine do Arquiteto.
- Central de API — mapeamento `kind` best-effort pela baseUrl.

## 🔵 Fases do produto

- **Fase 6 — Routines:** COMPLETA (triggers de floor + gate).
- **Fase 8 — Memória plugável:** Fase 1 + keychain. Multi-DB Postgres = esquecer. (OmniFS NÃO é MemoryProvider — é FS de arquivos, complementar.)
- **Fase 9 — Aprender:** A0+A1 ✅; A2–A4 pendentes.
- **Mobile:** relay Fase 1 no ar; Tasks 5–8 pendentes.

## 🚫 Não fazer (decisões travadas)

- **Multi-DB Postgres** — esquecer.
- **CSP** por conta própria — equipe de beta.
- **`/admin/beta/mint`** — não fazer.
- **Nome de concorrente no repo** — NUNCA (repo público).
- **Bundlar OmniFS obrigatório** — é opt-in; sidecar dormente, ativação consciente com disclosure de espaço.
