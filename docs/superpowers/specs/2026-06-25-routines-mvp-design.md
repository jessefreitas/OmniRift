# Routines MVP — fechar a Fase 6 (persistência + histórico + alvo de floor)

> Status: active · 2026-06-25. Routines JÁ é funcional (frontend + 2 schedulers: in-app + OS-level).
> Este MVP fecha os gaps de paridade. Branch nova de main. Conceito: automação agendada que dispara
> um comando/agente num floor.

## Estado atual (não refazer)
- Frontend completo: `RoutinesModal.tsx` (CRUD + 15 templates) wired (Sidebar + palette).
- `lib/routines.ts`: modelo `Routine` + run via `addTerminal` (floor ATIVO) + persistência **localStorage** (`omnirift-routines-v1`).
- `hooks/useRoutines.ts`: scheduler in-app (intervalMin + atTime diário).
- `commands/scheduler.rs`: scheduler OS-level (systemd/schtasks) — já registrado.

## Gaps a fechar (MVP enxuto)
1. **Persistência SQLite** (substitui localStorage — alinha com a Fase 3, permite histórico + cross-instância).
2. **Histórico de execução** (last-run / exit-code / status por disparo).
3. **Alvo de floor** (rodar num floor específico, não só o ativo).

(Fora do MVP, fase 2: triggers de ciclo-de-vida de floor created/deleted, gate pré-disparo.)

## Backend (Rust) — `commands/routines.rs` (NOVO) + registrar em lib.rs/mod.rs
- Reusa o SQLite do blackboard existente (a mesma conexão da Fase 3; ver como `commands/spec.rs`/blackboard abrem o DB).
- Tabelas: `routines (id TEXT PK, name, command, interval_min INT NULL, at_time TEXT NULL, enabled INT, target_floor TEXT NULL, created_at INT, updated_at INT)` + `routine_runs (id, routine_id FK, started_at INT, exit_code INT NULL, status TEXT)`.
- Comandos: `routines_list() -> Vec<Routine>`, `routines_upsert(routine)`, `routines_delete(id)`, `routines_record_run(routine_id, exit_code?, status)`, `routines_runs(routine_id) -> Vec<Run>`.
- Migração: na 1ª subida, se a tabela estiver vazia, NÃO faz nada (a migração do localStorage é no front, via upsert).

## Frontend (TS) — `lib/routines.ts` + `RoutinesModal.tsx` + `hooks/useRoutines.ts`
- `loadRoutines/saveRoutines` → comandos Tauri (não localStorage). **Migração one-shot**: se houver `omnirift-routines-v1` no localStorage e o backend vazio, importa + limpa a chave.
- Modelo `Routine` ganha `targetFloorId?: string`. `runRoutine` passa `floor: targetFloorId ?? activeFloor` no `addTerminal`. UI: dropdown "Rodar em" (floor ativo / floor específico) no modal.
- Após cada `runRoutine`, chama `routines_record_run`. UI: chip "última execução HH:MM · ✓/✗" por routine (lê `routines_runs`).

## Decomposição
- **A (backend):** commands/routines.rs (tabelas + 5 comandos + testes) + wire. cargo verde.
- **B (frontend):** migra persistência p/ Tauri (+ migração localStorage) + targetFloorId + chip de histórico. tsc 0. Depende do contrato dos comandos do A.

## Testing
- cargo: upsert/list/delete round-trip no SQLite (tempfile); record_run + runs por routine; migração idempotente. Não regride (374).
- tsc 0. Migração localStorage→Tauri testada (one-shot, não duplica). grab 48.
- GLM 5.2 audita cada diff. Boot-test final: criar routine, rodar, ver no histórico + no floor certo.
