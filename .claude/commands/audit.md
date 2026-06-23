---
description: Audita specs + planos contra o código real, reescreve docs/STATUS.md e (com aprovação) arquiva os concluídos pra evitar regressão
---

Audite o status REAL de implementação de TODAS as specs em `docs/superpowers/specs/*.md`
deste projeto (OmniRift — Tauri 2 = Rust + React + Cloudflare Worker).

## Regras de ouro
- **NÃO confie nos checkboxes** dos planos (`docs/superpowers/plans/*.md`) — eles ficam
  defasados (ex.: plano 0/53 mas a feature 100% feita). Verifique implementação **REAL**:
  o módulo de código existe, está **wired** (registrado em `lib.rs` / no MCP router /
  importado e usado no frontend) e idealmente tem teste.
- Uma **menção** num `.md` de design **≠ implementado**.

## Processo (paralelo, pra ser rápido)
1. Liste as specs em `docs/superpowers/specs/`.
2. Divida em ~4 grupos e dispare **1 agente por grupo** (Task tool, `subagent_type:
   general-purpose`), cada um cruzando suas specs contra o código em:
   - `apps/desktop/src` (frontend React/TS — components/, lib/, store/)
   - `apps/desktop/src-tauri/src` (Rust — comandos `#[tauri::command]`, módulos, MCP)
   - `services/license-worker/src` (worker — endpoints, db, testes)
   Cada agente retorna, **por spec**: `status` (DONE | PARTIAL | DESIGN-ONLY),
   `evidência` (arquivo/módulo/comando concreto que prova) e `gaps` (se PARTIAL).
3. Rode a validação por execução real e registre o resultado:
   - `cargo test --lib --manifest-path apps/desktop/src-tauri/Cargo.toml`
   - `npm test` em `services/license-worker`
4. Agregue tudo e **reescreva `docs/STATUS.md`** com:
   - data (hoje), aviso de que os checkboxes dos planos mentem (com 1-2 exemplos reais),
   - tabela `spec | status | evidência`,
   - seção **"Pendências reais"** com os gaps dos parciais,
   - resumo `X DONE · Y PARCIAL · Z DESIGN-ONLY`.
5. **Mapeie os PLANOS** (`docs/superpowers/plans/*.md`) pra suas specs: marque cada plano
   como `concluído` (todas as tarefas implementadas no código) / `parcial` / `não-iniciado`,
   IGNORANDO os checkboxes (verifique o código). Inclua isso no STATUS.md.
6. **Anti-regressão — proponha ARQUIVAR os concluídos:** liste as specs+planos **DONE**
   que deveriam ser marcados como "não usar mais" (pra nenhum agente re-dispatchar e
   re-implementar = regressão). Arquivar = mover pra `docs/superpowers/specs/archive/`
   (e `plans/archive/`) OU setar frontmatter `status: done` / `superseded_by`. O painel
   SPECS já desabilita dispatch em spec arquivada/concluída.
   - **Mostre a lista e PERGUNTE antes de mover** — só arquive os que eu aprovar.
7. Agregue tudo e **reescreva `docs/STATUS.md`** (data, aviso de que os checkboxes mentem,
   tabela `spec | status | plano | evidência`, "Pendências reais", e o resumo
   `X DONE · Y PARCIAL · Z DESIGN-ONLY · W arquivados`).
8. **NÃO commite automaticamente** — mostre o resumo + o diff e pergunte se commito
   (branch + PR, fluxo padrão do projeto).

Escopo: leitura do código + reescrita do `docs/STATUS.md` + (com aprovação) mover specs/planos
concluídos pra `archive/`. NUNCA altere código de feature.
