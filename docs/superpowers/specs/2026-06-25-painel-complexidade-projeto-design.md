# Painel de Complexidade do Projeto (9e) — Design

> Status: active · 2026-06-25. Completa a sub-fase 9e do Code Workspace. Branch nova de main.
> Hoje (9c ✅): métricas por-arquivo (`code/metrics.rs`: ciclomática, cognitiva, MI, severidade) expostas
> só como badge "cx N" no CodeNode. Este painel eleva isso a **nível-projeto** + ação de análise com IA.

## Goal
Um painel que lista TODOS os arquivos de código do projeto ativo com suas métricas (pior-primeiro),
permite abrir um arquivo, ver o drill-down por função, e **pedir análise com IA** de um arquivo (ou dos N
piores) reusando o `debug_request` (9d, já existe). Reusa o engine de métricas que já existe — NÃO reescreve.

## Estado atual (reusar, não refazer)
- `commands/code.rs`: `code_metrics(path) -> CodeMetrics` (por-arquivo; `functions[]` + avg/max ciclomática/
  cognitiva + MI + severidade). Registrado em lib.rs.
- `commands/code.rs`: `debug_request(payload) -> {prompt, language, metrics, similarBugs}` (monta o prompt do
  DebuggerAgent; NÃO spawna — o front spawna pelo caminho normal addTerminal + agent_mcp_config).
- `code/metrics.rs`: engine tree-sitter (`severity_for`, `level_for`, etc.). Thresholds hardcoded (mantidos).
- `commands/spec.rs`: `spec_list_files(dir, extraRoots?)` — PADRÃO de walk de arquivos do projeto (reusar).
- Front: `lib/code-client.ts` (cliente), `types/code.ts` (`CodeMetrics`/`FunctionMetrics`, camelCase),
  CodeNode (abre arquivo). Modais espelham `ConnectionsModal.tsx`. Toolbar + CommandPalette.

## Backend (Rust) — `commands/code.rs` (novo command) + lib.rs
Novo: `code_metrics_project(dir: String, extra_roots: Option<Vec<String>>) -> Vec<FileMetricsSummary>`
- Anda os arquivos de código sob `dir` (+ extra_roots), espelhando o walk do `spec_list_files`: **respeita
  `.gitignore`** (crate `ignore`, já no projeto) e pula `node_modules/target/dist/.git`. Só extensões que o
  `metrics.rs` sabe parsear (rust/ts/tsx/js/jsx/py/… — derivar da mesma lista de linguagens do engine).
- Pra cada arquivo, roda o engine EXISTENTE e projeta um DTO LEVE (não o `functions[]` inteiro — isso vem
  sob demanda via `code_metrics`):
  `FileMetricsSummary { path, language, loc, maxCyclomatic, maxCognitive, maintainabilityIndex, severity, fnCount }`
  (serde camelCase, bate o `types/code.ts`).
- **Teto** de 2000 arquivos (constante); se exceder, processa os 2000 primeiros e loga `tracing::warn!` o nº
  cortado (sem cap silencioso). Arquivo que falhar o parse → pula (não derruba o scan), best-effort.
- Custo: tree-sitter é rápido; pode ser sequential. Se a suíte ficar lenta, paralelizar com `rayon` é follow.

## Frontend (TS) — `components/CodeMetricsPanel.tsx` + `lib/code-client.ts` + wiring
- **`code-client.ts`**: `metricsProject(dir, extraRoots?) -> FileMetricsSummary[]` (invoke) + o tipo
  `FileMetricsSummary` em `types/code.ts`.
- **`CodeMetricsPanel.tsx`** (espelha `ConnectionsModal`): aberto pela toolbar + command-palette
  ("Complexidade do projeto"). Ao abrir → `metricsProject(cwd do projeto ativo)`.
  - **Tabela**: arquivo (path relativo) · LOC · cx máx · cognitiva máx · MI · severidade (badge verde/
    amarelo/vermelho). **Ordenável** por coluna; default **pior-primeiro** (maxCyclomatic desc, depois
    severity). **Filtro** por severidade (chips). Contagem-resumo no topo (N arquivos, X vermelhos).
  - **Clicar no arquivo** → abre num CodeNode (caminho existente de abrir arquivo no canvas).
  - **Drill-down**: expandir uma linha → `code_metrics(path)` → lista `functions[]` (nome, linhas, cx,
    cognitiva, MI, severidade), pior-primeiro. Lazy (só ao expandir).
  - **Analisar com IA** (a opção (b)): botão por-linha + um "Analisar os N piores" no topo → pra cada
    arquivo escolhido chama `debug_request({filePath})` → spawna o agente "debugger" pelo caminho normal
    (addTerminal + agent_mcp_config injeta Serena+memória). Confirmação antes de spawnar N agentes (aviso
    "vai abrir N terminais"). Reusa 100% o `debug_request` — sem backend novo pra isso.
  - i18n (pt/en), estilo dos modais existentes, estados de loading/empty/erro.

## Decisões
1. DTO leve no scan de projeto; `functions[]` sob demanda (não trafega tudo). 2. Respeita `.gitignore` +
   teto 2000 (log se cortar — sem cap silencioso). 3. "Analisar com IA" reusa `debug_request` (zero backend
   novo). 4. Thresholds configuráveis por linguagem = FORA (follow-up; os atuais funcionam). 5. Aditivo: o
   badge cx do CodeNode e o `code_metrics` por-arquivo seguem intactos. 6. Spawnar N agentes pede confirmação.

## Decomposição
- **A (backend):** `code_metrics_project` + `FileMetricsSummary` + walk (gitignore, extensões, teto) + testes.
- **B (frontend):** `CodeMetricsPanel` (tabela/sort/filtro/drill-down/abrir/Analisar-IA) + client + wiring +
  i18n. Depende do contrato do A.

## Testing (excelência — execução real, não visual)
- **cargo** (não regride os 381): `code_metrics_project` num dir tempfile com arquivos sintéticos →
  retorna 1 summary por arquivo de código; respeita `.gitignore` (arquivo ignorado NÃO aparece); pula
  node_modules; arquivo não-código ignorado; arquivo com parse-fail é pulado (não derruba); ordenação/dados
  batem o `code_metrics` por-arquivo (consistência do engine); teto respeitado (com input > teto sintético).
- **tsc 0** + `npm run test:grab` (48). Se houver runner de unit no front, testar o sort/filtro.
- **GLM 5.2** audita cada diff (foco: path traversal no walk, DoS por projeto gigante/symlink-loop no
  `ignore`, o "Analisar N piores" não spawnar agentes demais sem confirmação, vazamento de path absoluto).
- **Boot-test real**: abrir o painel num projeto, ver a tabela pior-primeiro, expandir um arquivo, abrir um
  arquivo no canvas, e disparar "Analisar com IA" num arquivo → agente debugger nasce.
