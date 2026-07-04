# Jornada de Onboarding de Produto + Testes da Jornada — Design

> Status: **draft — aguarda aprovação do Jesse**. 2026-07-04.
> Pedido original: "quero que a gente possa fazer testes e ter uma jornada para ensinar
> nossos usuários a usar nosso sistema". Importante não confundir com a **Fase 9
> OmniPartner Aprender** (`2026-06-28-omnipartner-aprender-design.md`) — aquela ensina a
> **programar** (tutor Socrático sobre o código do usuário); esta ensina a **usar o
> OmniRift em si** (canvas, agentes, terminais, conexões, Kanban).

**Goal:** Dar ao usuário novo um caminho guiado, interativo e auto-verificado para
aprender o produto na prática — sem depender só do manual estático (`HelpModal` /
`help-content.ts`) — e garantir que essa jornada não quebra silenciosamente ao longo do
tempo, com uma suite de testes que valida a lógica de detecção de progresso.

## O que JÁ existe (reusar, não reinventar)

| Peça | OmniRift | Uso nesta feature |
| :--- | :--- | :--- |
| Manual estático | `help-content.ts` + `HelpModal` | Continua existindo à parte; a jornada é o complemento interativo, não substitui |
| Onboarding de repo (infra) | `repo-onboarding.ts` (indexOmnifs/buildGraph/seedKanban, opt-in + best-effort) | Reusa `seedKanban` para a missão 7; reusa a filosofia opt-in/best-effort/step-result |
| Canvas store | `canvas-store.ts` (`useCanvasStore`, nodes/edges por floor) | Fonte dos sinais estruturais (nós, edges, viewport) — **observado, não instrumentado** |
| Turn-done do agente | `AgentNode` (refs de Goal/Loop já enganchados no turno) | Reusa o mesmo gancho para detectar "mandou mensagem e o agente respondeu" |
| Feature flags | `feature-flags.ts` (`getFlag`/`useFlag`, default true/false) | A jornada nasce como flag `productTour` (default `true`, kill-switch instantâneo) |
| Persistência leve client-side | `localStorage` (padrão já usado em ~15 componentes) | Guarda só "já viu o tour" / "sandbox path" — nada de progresso passo-a-passo |
| Runner de teste puro | `scripts/run-grab-tests.mjs` + `test:grab` (esbuild bundla `.test.ts`, roda com node — **sem vitest/jest no frontend**) | Generalizado para aceitar qualquer entry point; ganha irmão `test:tour` |
| Testes Rust | 69 `#[test]`/`#[tokio::test]` em `src-tauri/src` | Qualquer comando novo (ex.: provisionar sandbox) ganha teste no mesmo padrão |

## Decisão de arquitetura (a peça-chave): missões estruturais, não eventos

A tentação óbvia é modelar cada missão como "capturar o evento X quando ele acontece".
Isso é frágil: se a UI perder o evento (re-render, timing, restart do app no meio), a
missão trava para sempre, e não há como testar sem simular o evento exato.

Em vez disso, cada missão é avaliada como **função pura de um retrato do estado atual**:
dado um conjunto de sinais (quantos nós/edges de cada tipo existem, se o workspace foi
salvo, se o viewport já se moveu, se o painel Kanban já abriu, se algum agente já
completou um turno), decide quais missões estão cumpridas — comparando sempre contra uma
**baseline** (o que já existia quando o sandbox foi semeado, pra não contar de graça os
nós pré-populados).

Vantagens:
- **Resumível de graça**: fechar o app no meio do tour não perde progresso — na próxima
  abertura, o mesmo retrato do estado já mostra as missões cumpridas.
- **Testável sem rodar o app**: a função `computeMissionStatus(signals, baseline)` é pura,
  determinística, zero dependência de Tauri/React — testa com o runner `esbuild+node` já
  existente no projeto.

## As 7 missões

| # | Missão | Sinal usado | Tipo |
| - | :--- | :--- | :--- |
| 1 | Abrir um projeto | — | Informativa (sandbox já abre sozinho; só narra o conceito) |
| 2 | Criar um agente | `canvas-store`: nº de nodes tipo agente além da baseline | Estrutural |
| 3 | Mandar mensagem pro agente | Gancho de turn-done já existente no `AgentNode` | Estrutural (contador por node id) |
| 4 | Mover/dar zoom no canvas | Callback `onMove` do React Flow (`@xyflow/react`, já na lib) | Observado 1x → vira sinal booleano |
| 5 | Salvar o workspace | Timestamp do último save bem-sucedido | Estrutural |
| 6 | Conectar Agente A → Agente B | `canvas-store`: edge entre 2 nodes-agente além da baseline | Estrutural |
| 7 | Ver o card criado no Kanban | `seedKanban` (reusado do `repo-onboarding.ts`) + flag "abriu o painel Kanban" | Estrutural + observado |

Missões 1-5 são o "caminho de ouro" (equivalente interativo do "Comece em 4 passos" do
`HelpModal`, +1 de salvar). Missões 6-7 são o diferencial ("não é só mais um chat com
terminal") — mostram fan-out entre agentes e organização automática no Kanban.

## Sandbox

- Pasta real em `appDataDir/tour-sandbox/` (Tauri app-data-dir — **não** `/tmp`, **não**
  dentro de nenhum mount OmniFS do usuário, evitando os gotchas de FUSE/ENOTCONN já
  documentados no projeto).
- `git init` com um `README.md` explicando o sandbox + 1 script trivial (ex.: `hello.sh`)
  — só o suficiente para os agentes-exemplo terem algo real para apontar.
- Pré-populada com **1 agente-exemplo, 1 nota e 1 conexão**, todos anotados ("olha como
  fica"). A baseline de nodes/edges dessa seed é o que as missões estruturais excluem ao
  contar.
- Auto-provisionada e auto-aberta na 1ª execução do app (flag `omnirift.tour.v1.seen`
  ausente no `localStorage`). Se a pasta tiver sido apagada/movida quando o usuário clicar
  em "Refazer tour", é recriada de forma idempotente (mesma filosofia best-effort do
  `repo-onboarding.ts`).

## UI do tour

- **`TourOverlay.tsx`** (novo componente): scrim semi-transparente com recorte (spotlight)
  sobre o elemento-alvo + popover ancorado (título/descrição/ações). Zero dependência nova
  — posicionamento via `getBoundingClientRect()` do elemento com `data-tour-id`,
  recalculado em resize/scroll. Motivo de não usar lib pronta (`react-joyride`/`shepherd`):
  o projeto já levou sustos com bibliotecas de browser se comportando mal no WebKitGTK
  (diálogos nativos quebrados, WebGL context loss) — zero-dep elimina essa classe de risco
  e mantém controle total do visual.
- Alvos ganham o atributo `data-tour-id="..."` em edições pontuais (Sidebar, botão de novo
  agente, botão Salvar, toggle do painel Kanban) — não muda a lógica desses componentes.
- Progressão: missão 1 (informativa) avança com botão "Próximo". Missões de ação (2-7) não
  têm botão de avanço — o popover mostra "Aguardando você fazer isso..." e avança sozinho
  quando `useTourWatcher` reporta a missão cumprida. Isso faz o tour parecer reativo, não
  um slideshow.
- Sempre visível: **"Pular tour"** (seta a flag e fecha o overlay).
- Entrada permanente para revisitar: item no menu de Ajuda **"Refazer tour guiado"** — reabre
  o sandbox (recriando se preciso) e reseta as missões (a checagem estrutural garante que,
  ao reabrir o mesmo sandbox intocado, tudo aparece "a fazer" de novo).
- Registrado em `feature-flags.ts` como `productTour` (default `true`) — kill-switch
  instantâneo sem precisar de release, seguindo a diretriz já existente do projeto de que
  toda feature nova nasce como flag.

## Componentes / arquitetura

### Frontend — `src/`
- **`src/lib/tour/tour-missions.ts`** (puro): tipos `TourSignals`, `TourBaseline`,
  `MissionId`; função `computeMissionStatus(signals, baseline): MissionId[]`.
- **`src/lib/tour/tour-missions.test.ts`**: casos determinísticos (snapshot de sinais →
  missões esperadas), rodado via `npm run test:tour`.
- **`src/store/tour-store.ts`** (zustand): `missions`, `currentMissionIndex`, `isActive`,
  `start()`, `dismiss()`, `advance()`. Persiste em `localStorage` só: viu o tour (bool) e
  path do sandbox — nunca progresso passo-a-passo (vem de graça da checagem estrutural).
- **`src/hooks/useTourWatcher.ts`**: assina seletores do `canvas-store` (nodes/edges por
  floor), o callback `onMove` do React Flow, o toggle do painel Kanban e o gancho de
  turn-done do `AgentNode`; monta o `TourSignals` e chama `computeMissionStatus`, sem
  jamais escrever de volta no `canvas-store` (só observa).
- **`src/components/TourOverlay.tsx`**: renderiza spotlight + popover a partir do estado
  do `tour-store`.
- Pequenos `data-tour-id` adicionados em `Sidebar.tsx`, `AgentNode.tsx` (botão de criar),
  botão de salvar workspace, e no toggle do painel Kanban.

### Backend — `src-tauri/src/`
- Se a criação do sandbox precisar de um comando dedicado (provisionar pasta +
  `git init` + seed de arquivos fora do que o frontend já consegue via
  `@tauri-apps/plugin-fs`): novo comando `tour_ensure_sandbox`, com teste
  `#[test]`/`#[tokio::test]` seguindo o padrão já existente. Preferir resolver via
  plugin-fs no frontend primeiro; só criar comando Rust se o plugin-fs não cobrir (ex.:
  `git init`).

### Testes
- **`scripts/run-grab-tests.mjs` generalizado** para aceitar o entry point como argumento
  de linha de comando (hoje é fixo em `grab.test.ts`) — pequena melhoria pontual, já que
  vamos ter uma segunda suite quase idêntica. `package.json` ganha `"test:tour": "node
  scripts/run-grab-tests.mjs src/lib/tour/tour-missions.test.ts"` ao lado do `test:grab`
  existente (sem quebrar o script atual).
- Cobertura automatizada: 100% da lógica de missão (`computeMissionStatus`), incluindo
  casos de baseline (nodes/edges pré-existentes não contam), missões parcialmente
  cumpridas, e ordem de avaliação.
- **O que NÃO dá para automatizar nesse stack**: o alinhamento visual real do
  spotlight/popover só se observa num build `.deb` de verdade — o modo dev do Tauri dá
  tela branca no WebKitGTK (gotcha já documentado do projeto: `__TAURI_INTERNALS__` não é
  injetado no WebView HTTP). Isso vira um **checklist de QA manual** (novo, curto, em
  `docs/napkin.md`), rodado 1x por release antes de publicar:
  - [ ] Sandbox abre sozinho na 1ª execução (limpar `localStorage` pra simular)
  - [ ] Spotlight alinha nos 7 alvos, em janela pequena e grande
  - [ ] "Pular tour" fecha e não reaparece nas próximas aberturas
  - [ ] "Refazer tour guiado" reabre o sandbox e reseta as missões
  - [ ] Cada missão de ação avança sozinha ao ser realizada de verdade (sem clique manual)

## Guardrails (não-negociáveis)

- **Zero instrumentação intrusiva no `canvas-store`**: `useTourWatcher` só lê seletores
  existentes; nunca adiciona side-effects de tour dentro das actions do store.
- **Sandbox nunca é o cwd de um projeto real do usuário** — vive isolado em
  `appDataDir`, fora de qualquer mount OmniFS.
- **Best-effort em tudo que envolve I/O** (provisionar sandbox, seedKanban): falha vira
  "skipped" com motivo legível, nunca trava a abertura do app — mesma filosofia do
  `repo-onboarding.ts`.
- **Feature flag desde o dia 1** (`productTour`): permite desligar em produção sem release.
- Textos das 7 missões em **PT/EN**, seguindo o padrão bilíngue já usado no `HelpTopic`.

## Fora de escopo (v1) — YAGNI explícito

- Analytics/telemetria de conclusão do tour (quantos completam, onde travam) — fica para
  quando houver decisão de iterar com dados reais.
- Progresso passo-a-passo persistido entre sessões — desnecessário, a checagem estrutural
  já resolve isso de graça.
- A/B testing de variações do tour.
- Tour cobrindo Floors/Routines/OmniPartner/Portais — fica para uma 2ª leva se o tour v1
  validar bem (o objetivo aqui é o caminho de ouro + 1 diferencial, não o produto inteiro).

## Riscos conhecidos

- **Posicionamento do spotlight em telas pequenas ou com scroll**: mitigado pelo checklist
  manual de QA; se aparecer quebrado com frequência, é candidato a reconsiderar a
  Abordagem B (lib de tour pronta) — decisão adiada, não descartada de vez.
- **Sandbox "sujo" após uso** (usuário mexe demais nele e o "Refazer tour" fica confuso):
  mitigado por sempre recriar a seed seguindo o mesmo padrão idempotente do
  `repo-onboarding.ts` quando o usuário pedir explicitamente para refazer.
