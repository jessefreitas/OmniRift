# Plano de Execução — Jornada de Onboarding de Produto

> Spec: `docs/superpowers/specs/2026-07-04-jornada-onboarding-produto-design.md`
> Criado: 2026-07-04. Status: **pronto p/ implementar** (5 decisões pendentes resolvidas abaixo).

## Decisões de arquitetura (resolução das 5 pendências da spec)

### D1 — Sandbox: comando Rust `tour_ensure_sandbox`
**Decisão:** criar comando Rust. `@tauri-apps/plugin-fs` cobre criar pastas e escrever
arquivos, mas **não faz `git init`** (precisa de shell). Já existe `run_git()` em
`src-tauri/src/git/mod.rs` — reusar. O comando faz: `mkdir -p appDataDir/tour-sandbox`,
`git init`, escreve `README.md` + `hello.sh`, retorna o path. Idempotente (se já existe
e é um repo git válido, só retorna o path). Teste `#[test]` no mesmo padrão dos 69
existentes.

### D2 — Zustand (já é o padrão do projeto)
**Decisão:** usar zustand. `canvas-store`, `resource-store`, `i18n`, `agent-checkpoints`,
`fleet-usage` já usam `create` do zustand. Sem dependência nova (`zustand@^5.0.2` já
instalado). `tour-store.ts` segue o mesmo padrão.

### D3 — `onMove` do React Flow
**Decisão:** usar `onMove` do `@xyflow/react@^12.3.5` (instalado). A API do React Flow
exposição `onMove`, `onMoveStart`, `onMoveEnd` como props do `<ReactFlow>` — confirmado
pela doc da v12. O `useTourWatcher` registra um callback `onMove` que seta um ref
booleano `viewportMoved = true` (sinal da missão 4). Não há `onMove` de React Flow em
uso no projeto hoje (os `onMove` encontrados em `Sidebar.tsx` e `guest-script.ts` são de
mouse, não do React Flow) — adicionar no componente que renderiza `<ReactFlow>`.

### D4 — Gancho de turn-done
**Decisão:** usar `listenAcpTurnDone(sessionId, handler)` de `acp-client.ts`. Já emite
em `acp://turn-done` com `data` do turno. O `useTourWatcher` assina esse evento para
cada node-agente ativo e incrementa um contador `turnsByAgentId: Record<string, number>`.
Missão 3 = "existe ≥1 agente com turns > 0 além da baseline". **Não instrumenta
`canvas-store`** — só escuta o barramento ACP que já existe (guardrail preservado).

### D5 — Persistência e i18n
**Decisão:** `localStorage` cru para `omnirift.tour.v1.seen` (bool) e
`omnirift.tour.v1.sandboxPath` (string) — segue o padrão dos ~15 componentes que já
usam `localStorage` direto. Para i18n, **usar o sistema existente** `src/lib/i18n.ts`
(zustand store `useI18n` + `translate(locale, key, fallback)` + dicionários
`locales/pt` e `locales/en`). Textos das 7 missões viram chaves no dicionário, não
strings soltas.

## Tabela de dispatch (orquestração)

| Agente | O que faz | Via | Dependências |
|--------|-----------|-----|--------------|
| A1 | `tour-missions.ts` (puro) + `tour-missions.test.ts` + generalizar `run-grab-tests.mjs` | `multi_agent_dispatch.py --type code` | Nenhuma (núcleo puro) |
| A2 | `tour-store.ts` (zustand) + chaves i18n PT/EN | `multi_agent_dispatch.py --type code` | A1 (tipos `MissionId`) |
| A3 | Comando Rust `tour_ensure_sandbox` + teste | `multi_agent_dispatch.py --type code` | Nenhuma (backend isolado) |
| A4 | `useTourWatcher.ts` (assina canvas-store + ACP turn-done + onMove + Kanban toggle) | `Agent` tool (precisa de filesystem + tipos do canvas-store) | A1, A2 |
| A5 | `TourOverlay.tsx` + `data-tour-id`s pontuais + entrada "Refazer tour" no menu Ajuda + flag `productTour` | `Agent` tool (precisa de filesystem + Sidebar/HelpModal) | A1, A2, A4 |

**Ordem:** A1 + A2 + A3 em paralelo (independentes) → A4 (depende de A1+A2) → A5
(depende de A1+A2+A4).

## Passo a passo detalhado

### Passo 1 — Núcleo puro (A1) — `src/lib/tour/`

#### 1a. `src/lib/tour/tour-missions.ts`
```typescript
export type MissionId = "open-project" | "create-agent" | "send-message"
  | "move-canvas" | "save-workspace" | "connect-agents" | "see-kanban";

export interface TourSignals {
  agentNodeIds: string[];           // IDs dos nodes kind==="agent" no floor ativo
  agentEdgeCount: number;           // edges entre 2 nodes-agente no floor ativo
  turnsByAgentId: Record<string, number>;  // contagem de turn-done por agentId
  viewportMoved: boolean;           // onMove disparou pelo menos 1x
  workspaceSavedAt: number | null;  // timestamp do último save (null = nunca)
  kanbanPanelOpened: boolean;       // toggle do painel Kanban abriu pelo menos 1x
}

export interface TourBaseline {
  agentNodeIds: string[];   // IDs pré-populados pelo sandbox (excluir ao contar)
  agentEdgeCount: number;   // edges pré-populados
}

export const MISSION_ORDER: MissionId[] = [
  "open-project", "create-agent", "send-message", "move-canvas",
  "save-workspace", "connect-agents", "see-kanban",
];

/** Função pura — zero dependência de Tauri/React. Testável com esbuild+node. */
export function computeMissionStatus(
  signals: TourSignals,
  baseline: TourBaseline,
): MissionId[] {
  const done: MissionId[] = ["open-project"]; // missão 1 = informativa, sempre cumprida

  // Missão 2: agentNodeIds além da baseline
  const newAgents = signals.agentNodeIds.filter(
    (id) => !baseline.agentNodeIds.includes(id),
  );
  if (newAgents.length > 0) done.push("create-agent");

  // Missão 3: ≥1 turno em algum agente além da baseline
  const newAgentTurns = Object.entries(signals.turnsByAgentId)
    .filter(([id]) => !baseline.agentNodeIds.includes(id))
    .some(([, count]) => count > 0);
  if (newAgentTurns) done.push("send-message");

  // Missão 4: viewport se moveu
  if (signals.viewportMoved) done.push("move-canvas");

  // Missão 5: workspace salvo
  if (signals.workspaceSavedAt !== null) done.push("save-workspace");

  // Missão 6: edge entre 2 agents além da baseline
  if (signals.agentEdgeCount > baseline.agentEdgeCount) done.push("connect-agents");

  // Missão 7: painel Kanban abriu (see-kanban exige kanbanPanelOpened)
  if (signals.kanbanPanelOpened) done.push("see-kanban");

  return done;
}

/** Qual é a próxima missão a fazer (primeira não-cumprida na ordem canônica). */
export function nextMission(
  done: MissionId[],
): MissionId | null {
  return MISSION_ORDER.find((m) => !done.includes(m)) ?? null;
}
```

#### 1b. `src/lib/tour/tour-missions.test.ts`
Casos determinísticos:
- `[]` signals + baseline vazia → só `["open-project"]`
- 1 agent além da baseline → `["open-project", "create-agent"]`
- 1 agent + 1 turno nesse agent → `+ send-message`
- baseline com 1 agent pré-populado + 0 novos → `create-agent` NÃO cumprida
- viewportMoved true → `+ move-canvas`
- workspaceSavedAt = Date.now() → `+ save-workspace`
- agentEdgeCount 1 além da baseline → `+ connect-agents`
- kanbanPanelOpened true → `+ see-kanban`
- tudo cumprido → 7 missões, `nextMission` retorna `null`
- ordem: mesmo que sinais de missão 6 existam antes da 2, `computeMissionStatus`
  retorna na ordem canônica (validar com `.toEqual(MISSION_ORDER)`)

#### 1c. Generalizar `scripts/run-grab-tests.mjs`
Mudar o entry point fixo para aceitar argumento:
```javascript
const entry = process.argv[2]
  ? resolve(root, process.argv[2])
  : resolve(root, "src/lib/grab/grab.test.ts");
// ...
entryPoints: [entry],
```
Adicionar em `apps/desktop/package.json`:
```json
"test:tour": "node scripts/run-grab-tests.mjs src/lib/tour/tour-missions.test.ts"
```
**Não quebrar `test:grab`** — sem arg, continua apontando para `grab.test.ts`.

### Passo 2 — Store + i18n (A2)

#### 2a. `src/store/tour-store.ts`
```typescript
import { create } from "zustand";
import type { MissionId } from "@/lib/tour/tour-missions";

const SEEN_KEY = "omnirift.tour.v1.seen";
const SANDBOX_KEY = "omnirift.tour.v1.sandboxPath";

interface TourState {
  isActive: boolean;
  sandboxPath: string | null;
  hasSeenTour: boolean;
  start: () => void;
  dismiss: () => void;
  markSeen: () => void;
  setSandboxPath: (p: string) => void;
}

export const useTourStore = create<TourState>((set) => ({
  isActive: false,
  sandboxPath: localStorage.getItem(SANDBOX_KEY),
  hasSeenTour: localStorage.getItem(SEEN_KEY) === "1",
  start: () => set({ isActive: true }),
  dismiss: () => {
    localStorage.setItem(SEEN_KEY, "1");
    set({ isActive: false, hasSeenTour: true });
  },
  markSeen: () => {
    localStorage.setItem(SEEN_KEY, "1");
    set({ hasSeenTour: true });
  },
  setSandboxPath: (p) => {
    localStorage.setItem(SANDBOX_KEY, p);
    set({ sandboxPath: p });
  },
}));
```

**Nota:** `currentMissionIndex` e `missions[]` **NÃO** são persistidos — vêm de graça
da checagem estrutural via `useTourWatcher` a cada render (princípio da spec: "resumível
de graça").

#### 2b. Chaves i18n
Adicionar em `src/lib/locales/pt.ts` e `en.ts`:
- `tour.mission.open-project.title` / `.desc`
- `tour.mission.create-agent.title` / `.desc`
- `tour.mission.send-message.title` / `.desc`
- `tour.mission.move-canvas.title` / `.desc`
- `tour.mission.save-workspace.title` / `.desc`
- `tour.mission.connect-agents.title` / `.desc`
- `tour.mission.see-kanban.title` / `.desc`
- `tour.cta.next` / `tour.cta.skip` / `tour.cta.waiting` / `tour.cta.redo`
- `tour.welcome.title` / `tour.welcome.desc`

### Passo 3 — Backend Rust (A3) — `src-tauri/src/commands/tour.rs`
```rust
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};
use crate::git::run_git; // reusar helper existente

/// Provisiona o sandbox do tour em appDataDir/tour-sandbox/.
/// Idempotente: se já é um repo git válido, só retorna o path.
#[tauri::command]
pub fn tour_ensure_sandbox(app: AppHandle) -> Result<String, String> {
    let dir = app.app_data_dir().map_err(|e| e.to_string())?;
    let sandbox = dir.join("tour-sandbox");
    if !sandbox.exists() {
        fs::create_dir_all(&sandbox).map_err(|e| e.to_string())?;
    }
    // git init (idempotente — git init em repo existente não erroa)
    run_git(&sandbox, &["init"]).map_err(|e| e.to_string())?;
    // seed README.md
    let readme = sandbox.join("README.md");
    if !readme.exists() {
        fs::write(&readme, "# Tour Sandbox\n\nProjeto de demonstração do tour guiado.\n")
            .map_err(|e| e.to_string())?;
    }
    // seed hello.sh
    let hello = sandbox.join("hello.sh");
    if !hello.exists() {
        fs::write(&hello, "#!/usr/bin/env bash\necho \"hello from tour sandbox\"\n")
            .map_err(|e| e.to_string())?;
    }
    Ok(sandbox.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn ensures_sandbox_idempotent() {
        let tmp = TempDir::new().unwrap();
        let sandbox = tmp.path().join("tour-sandbox");
        // simula app_data_dir via tmp — na prática o comando usa AppHandle
        fs::create_dir_all(&sandbox).unwrap();
        run_git(&sandbox, &["init"]).unwrap();
        assert!(sandbox.join(".git").exists());
        // segunda chamada não falha
        run_git(&sandbox, &["init"]).unwrap();
    }
}
```
Registrar em `src-tauri/src/commands/mod.rs` e no `invoke_handler!` do `lib.rs`.

### Passo 4 — Watcher (A4) — `src/hooks/useTourWatcher.ts`
Assina 4 fontes sem escrever de volta no canvas-store:
1. **canvas-store**: `useCanvasStore((s) => floorAtivo.nodes/edges)` → filtra
   `kind === "agent"` e edges entre agents → monta `agentNodeIds` e `agentEdgeCount`.
2. **ACP turn-done**: `listenAcpTurnDone(sessionId, ...)` para cada agent ativo →
   incrementa `turnsByAgentId[agentId]`. Registrar/desregistrar listeners no
   mount/unmount dos agents.
3. **React Flow onMove**: callback passado ao `<ReactFlow>` que seta
   `viewportMovedRef.current = true`.
4. **Kanban toggle**: assina `showKanban` do Sidebar (via um callback ou event bus
   leve — ver nota abaixo) ou, mais simples, observa o state do `tour-store` que o
   próprio Sidebar seta quando abre o Kanban (ver Passo 5).

A cada mudança de signals, chama `computeMissionStatus(signals, baseline)` e
`nextMission(done)`, atualizando o `tour-store` (que a UI lê para saber qual popover
mostrar). A `baseline` é capturada uma vez no `start()` do tour (snapshot dos
agentNodeIds/agentEdgeCount do sandbox no momento em que o tour inicia).

**Nota sobre a baseline:** quando o sandbox é semeado com 1 agente + 1 nota + 1
conexão, a baseline é `{ agentNodeIds: ["agent-seed-1"], agentEdgeCount: 0 }` (a
conexão é entre agente e nota, não entre 2 agents — não conta para a missão 6). Isso
garante que os nós pré-populados não satifazem missões de graça.

### Passo 5 — UI (A5)

#### 5a. `src/components/TourOverlay.tsx`
- Scrim semi-transparente + spotlight (recorte via `getBoundingClientRect` do
  elemento com `data-tour-id` da missão atual).
- Popover ancorado ao spotlight: título/desc (via `useI18n`/`translate`), e:
  - Missão 1 (informativa): botão "Próximo" (`tour.cta.next`).
  - Missões 2-7 (ação): "Aguardando você fazer isso..." (`tour.cta.waiting`) — sem
    botão de avanço; avança sozinho quando `useTourWatcher` reporta cumprida.
  - Sempre: botão "Pular tour" (`tour.cta.skip`).
- Recalcula posição em `resize` e `scroll`.
- Zero dependência nova.

#### 5b. `data-tour-id`s pontuais (não muda lógica dos componentes)
- `Sidebar.tsx` → `data-tour-id="sidebar"` (missão 1: abrir projeto / contexto geral)
- `Sidebar.tsx` botão "Novo agente" → `data-tour-id="new-agent"` (missão 2)
- `AgentNode.tsx` → `data-tour-id="agent-terminal"` (missão 3: mandar mensagem)
- Canvas/ReactFlow container → `data-tour-id="canvas"` (missão 4: mover/zoom)
- `Sidebar.tsx` botão "Salvar workspace" → `data-tour-id="save-workspace"` (missão 5)
- `Sidebar.tsx` toggle Kanban → `data-tour-id="kanban-toggle"` (missão 7)
- Para missão 6 (conectar agents): spotlight genérico no canvas ou no primeiro agent.

#### 5c. Entrada "Refazer tour guiado" no menu Ajuda
Em `Sidebar.tsx`, na seção de Ajuda, adicionar item que chama:
```typescript
tour_ensure_sandbox().then((path) => {
  useTourStore.getState().setSandboxPath(path);
  useTourStore.getState().start(); // reabre o tour
});
```
A checagem estrutural garante que, ao reabrir o mesmo sandbox intocado, tudo aparece
"a fazer" de novo (a baseline é recapturada no `start()`).

#### 5d. Auto-start na 1ª execução
Em `App.tsx` ou `main.tsx`, no mount:
```typescript
if (!useTourStore.getState().hasSeenTour && getFlag("productTour")) {
  invoke<string>("tour_ensure_sandbox").then((path) => {
    useTourStore.getState().setSandboxPath(path);
    // abrir o sandbox como cwd ativo + semear 1 agente/nota/conexão
    useTourStore.getState().start();
  }).catch(() => {}); // best-effort, nunca trava abertura
}
```

#### 5e. Feature flag
Em `feature-flags.ts`, adicionar à lista `FLAGS`:
```typescript
{ key: "productTour", label: "Tour guiado de onboarding", stage: "stable", default: true },
```

### Passo 6 — QA manual checklist (`docs/napkin.md`)
Seção nova (curta):
- [ ] Sandbox abre sozinho na 1ª execução (limpar `localStorage` pra simular)
- [ ] Spotlight alinha nos 7 alvos, em janela pequena e grande
- [ ] "Pular tour" fecha e não reaparece nas próximas aberturas
- [ ] "Refazer tour guiado" reabre o sandbox e reseta as missões
- [ ] Cada missão de ação avança sozinha ao ser realizada de verdade

## Validação automática (regression guard)

Antes de declarar concluído, rodar **TODOS** estes:
```bash
npm run test:grab        # suite existente — não pode quebrar
npm run test:tour        # suite nova — 100% da lógica de missão
npm run typecheck        # workspace completo
npm run lint             # eslint
```

## Guardrails (não-negociáveis — da spec)

- [ ] `useTourWatcher` **só lê** seletores do `canvas-store`; nunca adiciona
      side-effects de tour dentro das actions do store.
- [ ] Sandbox **nunca** é cwd de projeto real — vive em `appDataDir`, fora de mounts
      OmniFS.
- [ ] Best-effort em todo I/O (provisionar sandbox, seedKanban) — falha vira "skipped",
      nunca trava o app.
- [ ] Feature flag `productTour` desde o dia 1.
- [ ] Textos das 7 missões em PT/EN via `i18n.ts` (não strings soltas).

## Fora de escopo (v1) — YAGNI explícito

- Analytics/telemetria de conclusão
- Progresso passo-a-passo persistido entre sessões (a checagem estrutural já resolve)
- A/B testing
- Tour cobrindo Floors/Routines/OmniPartner/Portais

## Riscos e mitigações

| Risco | Mitigação |
|-------|-----------|
| Race: usuário faz missão 3 antes da 2 | `computeMissionStatus` avalia em ordem canônica; missão 3 só conta se houver agent além da baseline (ou seja, 2 também passou) |
| Spotlight quebrado em telas pequenas | Checklist QA manual; se recorrente, reconsiderar lib pronta (decisão adiada, não descartada) |
| Sandbox sujo após uso | "Refazer tour" recria a seed de forma idempotente |
| Dev mode Tauri tela branca no WebKitGTK | QA só em build `.deb` |
| Sandbox varrido por observer OmniFS | `appDataDir` é fora de qualquer mount OmniFS do usuário (confirmado por design) |
