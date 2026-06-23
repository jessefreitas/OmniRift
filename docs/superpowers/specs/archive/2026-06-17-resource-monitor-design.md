# Spec — Monitor de Recursos (CPU/RAM/GPU por agente)

- **Data:** 2026-06-17
- **Status:** Design aprovado (Jesse) — aguardando plano
- **Depende de:** `PtyManager` (root PIDs dos agentes, via Arc compartilhado como o MCP usa), canvas mount no `App`, convenção visual de overlay/painel.
- **Origem:** decisão de produto — ver quanto cada agente (e o sistema) consome de CPU/RAM/GPU/VRAM, sempre à vista, com custo baixo quando fechado.

---

## 1. Visão geral

Novo módulo Rust `metrics/` que amostra recursos numa **thread de fundo** e emite eventos Tauri (`resource://sample`). O front mantém um espelho leve do último sample + ring buffer e renderiza um **chip sempre-visível** que expande num painel.

## 2. Backend Rust — `src-tauri/src/metrics/`

```
metrics/
  mod.rs        // tipos (Sample, GlobalStats, GpuStats, AgentStat) + re-exports
  system.rs     // SystemProbe — wrapper sysinfo (CPU, RAM, disco, rede)
  gpu/
    mod.rs      // trait GpuProbe + detect() → escolhe adapter
    nvml.rs     // NvidiaProbe (nvml-wrapper; util/VRAM/temp + VRAM por-PID)
    rocm.rs     // AmdProbe (rocm-smi/sysfs) — best-effort
    intel.rs    // IntelProbe (sysfs: freq + mem compartilhada) — limitado
    none.rs     // NoGpu (sempre presente, fallback)
  sampler.rs    // thread + ring buffer (~60) + emite evento + snapshot on-demand
```

- **`GpuProbe` (trait):** `fn probe(&self) -> Option<GpuStats>` + `fn per_pid_vram(&self) -> HashMap<u32,u64>`. `detect()` tenta NVML → ROCm → Intel → NoGpu. NVML carregado dinamicamente (lazy): sem driver, cai pro próximo sem quebrar o binário.
- **Atribuição por-agente:** o sampler lê os `root_pid()` do `PtyManager` (Arc compartilhado), usa `sysinfo` pra montar o mapa pai→filhos e soma CPU/RAM de cada subárvore; cruza com `per_pid_vram()` pra creditar VRAM ao agente certo (ex.: ollama).
- **Deps novas (Cargo):** `sysinfo = "0.33"` e `nvml-wrapper = "0.10"` (opcional, atrás de feature). ROCm/Intel são parsing/sysfs, sem dep.
- **Comandos:** `metrics_snapshot()` (sob demanda) e `metrics_set_config({ intervalMs, detailed })`. O evento `resource://sample` é o caminho principal (push).

## 3. Tipos compartilhados

`ResourceSample { ts, global: GlobalStats, gpus: GpuStats[], agents: AgentStat[] }`, com:
- `GlobalStats { cpuPct, memUsed/Total, swap?, disk{used,total}, net{rxBytesPerSec,txBytesPerSec} }`
- `GpuStats { vendor, name, utilPct, vramUsed/Total, tempC?, powerW? }`
- `AgentStat { sessionId, label, pid, cpuPct, rssBytes, vramBytes? }`

Mesma forma no Rust (serde camelCase) e TS. **Tipos LOCAIS** em `src/types/` (o app não consome `@omnirift/shared-types`).

## 4. Frontend

- **`store/resource-store.ts`** (Zustand): último sample + ring buffer (60) + `expanded`. Assina `resource://sample` uma vez no boot.
- **`<ResourceChip/>`** — top-level no `App`, canto inferior-direito, sempre visível: `⚡ 52% · 6/16GB · GPU 80%`. Cor vira âmbar/vermelho quando CPU/RAM/GPU/VRAM passam de ~85% (sinal barato, sem notificação no v1).
- **`<ResourcePanel/>`** — abre ao clicar no chip: barras + sparklines (~60s) de CPU/RAM/GPU/VRAM, disco, rede, e tabela por-agente ordenável (cpu/ram/vram). Overlay próprio (não `useNodeMaximize`), mas mesmo padrão visual.

## 5. Performance & cadência

- **Sempre (chip):** global + GPU agregada a cada 1s — barato.
- **Caro só com o painel aberto:** varredura de processos por-agente + VRAM por-PID, a cada 1–2s. Chip fechado ⇒ não paga esse custo.
- `sysinfo` exige dois ticks pra CPU% (~200ms mínimo) — o sampler respeita isso.

## 6. GPU — degradação graciosa

| Detecção | O que mostra |
|---|---|
| NVIDIA (NVML ok) | util %, VRAM, temp, VRAM por-agente |
| AMD (rocm/sysfs) | util %, VRAM, temp (best-effort) |
| Intel iGPU | freq + mem compartilhada (sem VRAM dedicada/por-PID) |
| Nenhuma | seção GPU some; chip mostra só CPU/RAM |

## 7. Erros & testes

- Traits mockáveis: testes do sampler com `FakeGpuProbe` e processos sintéticos; teste do ring buffer (wrap-around, janela 60); teste do caminho sem GPU (não pode quebrar). Falha de NVML/sysfs **nunca** derruba o sampler — loga e segue.

## 8. Não-objetivos (v1)

Sem notificações/alertas push, sem histórico em disco (só memória), sem gráficos de longo prazo, sem GPU remota.

## 9. Sub-fases (plano)

| Sub-fase | Escopo |
|---|---|
| **A** | `metrics/` backend: tipos + SystemProbe (sysinfo) + sampler (global, sem GPU/por-agente) + evento + comandos. Testes do ring buffer + sem-GPU. |
| **B** | Frontend: resource-store + ResourceChip (global) montado no App. |
| **C** | GPU: trait GpuProbe + NoGpu + NvidiaProbe (NVML lazy) + degradação. |
| **D** | Por-agente: subárvores de processo (pai→filhos) via PtyManager + VRAM por-PID; tabela no painel. |
| **E** | ResourcePanel completo (sparklines + tabela ordenável) + cadência cara só com painel aberto. |

Ordem: A → B (chip já útil) → C → D → E. AMD/Intel probes entram depois (best-effort).
