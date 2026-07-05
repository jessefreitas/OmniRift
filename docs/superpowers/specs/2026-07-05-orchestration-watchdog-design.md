# Watchdog de entrega da orquestração + reviewer no contrato

> Status: **aprovado em brainstorm** · 2026-07-05. Item R2-#7 do plano de hardening.
> Caso real (deep-live-cam): Pipeline montou time de 5; o líder (Arquiteto) prometeu
> contrato e não entregou; os 4 workers — corretamente — ficaram "aguardando specs";
> o Code Reviewer nunca foi chamado. Deadlock silencioso: o usuário paga um time
> inteiro parado e ninguém o avisa.

## Diagnóstico (por que trava)

1. A persona do líder MANDA ("COMECE AGORA… distribua as fatias") — mas é **prompt,
   não mecanismo**; sob deriva (contexto, distração) o modelo não cumpre e nada cobra.
2. Os workers obedecem certo ("faça SÓ a sua fatia") → ociosos por design.
3. Nenhum componente observa "time ocioso + zero fatia" — e a **Recitação não dispara
   em idle** (pega carona em mensagens; time parado = sem turnos = sem recitação).
4. O reviewer só entra quando existe diff → num deadlock, nunca.

Decisão (com o dono): **A + C agora; B (gate estrutural: workers dormentes até as
fatias existirem) fica como evolução do Pipeline, spec própria.**

## A) Watchdog de entrega (Rust, determinístico, zero token quando flui)

**Onde:** task periódica no backend (padrão do idle-reaper do serena_pool), por floor
que tenha **orquestrador definido** (`setOrchestratorSid` — o Pipeline já marca).

**Condição de deadlock** (todas, por `WATCHDOG_MIN` = 5 min contínuos):
- ≥ 2 agentes do floor em estado `ready` (AcpManager) **sem turno ACP** no período;
- **zero entrega no Kanban do projeto**: nenhum card fora de `backlog` E nenhum
  card de tarefa (card de papel = tem `node_id`; tarefa = `node_id NULL` ou criado
  após o Montar).

**Ação (escada):**
1. **Cobrança 1** — `acp_prompt` no líder: "sua equipe está há N min bloqueada
   esperando o contrato. AGORA: registre o contrato (memory_remember) e crie as
   fatias como cards (kanban_card_create) movendo a primeira pra 'doing' e acionando
   o agente responsável (terminal_send_text). Não descreva — execute."
2. **Cobrança 2** (após +5 min sem entrega) — mesma injeção + linha de urgência.
3. **Alerta ao usuário** (após +5 min) — evento pro front → toast: "O time do floor X
   está parado há 15 min esperando o Arquiteto entregar as fatias. Cutuque-o ou
   verifique o Kanban." O watchdog então silencia (não vira spam) até a condição
   resetar (alguma entrega acontecer).

**Nunca dispara quando:** floor sem orquestrador; qualquer agente `running`; já
existe fatia/entrega; tour/bench; flag `orchestration-watchdog` desligada
(feature flag, default ON — kill-switch padrão do projeto).

## C) Reviewer entra no contrato (não só no diff)

**Gatilho:** o watchdog (ou fluxo normal) observa o **1º card de tarefa** criado no
Kanban do projeto → se o floor tem um agente com role de review (`Code Reviewer`):
1. Cria card "Review do contrato/fatias" atribuído a ele (uma vez por floor);
2. `acp_prompt` nele: "o Arquiteto registrou o contrato e as fatias (kanban_list +
   memory_recall). Revise ANTES da implementação: interfaces fazem sentido? fatias
   independentes? riscos? Grave o parecer com kanban_card_note no card de review."

Sem agente de review no floor → passo ignorado (fail-soft).

## Telemetria mínima

`log::info!` em cada disparo (floor, estágio da escada, motivo) — auditável no log;
contador no card do líder via `kanban_card_note` ("watchdog cobrou entrega às HH:MM")
pra ficar VISÍVEL no canvas (moat: o Citadel só teria isso em texto).

## Testes

- Unit (Rust): função pura `deadlock_state(agents, cards, elapsed) -> Option<Stage>`
  — casos: flui (card em doing) → None; time ocioso sem fatia → Stage::Nudge1 → 2 →
  UserAlert; reset após entrega; floor sem orquestrador → None.
- Integração manual: replay do cenário deep-live-cam (time montado, líder mudo) →
  observar cobrança no terminal do líder e toast.

## Fora de escopo (YAGNI)

- B (workers dormentes até fatias existirem) — spec própria na R2;
- Julgar a QUALIDADE do contrato (é papel do reviewer, não do watchdog);
- Watchdog para agentes avulsos fora de floor com orquestrador.
