# Spec — Code Workspace & Debug IA (Fase 9)

- **Data:** 2026-06-17
- **Status:** Design — aguardando revisão
- **Depende de:** Canvas (`FloorCanvas`, `canvas-store`, `types/canvas.ts`), Fase 8 ✅ (`memory/` provider plugável, `MemoryRegistry`), Fase 2 ✅ (conexões PTY), `commands/serena.rs` (detecção de linguagem).
- **Origem:** decisão de produto (Jesse, 2026-06-17) — ter um **nó de código no canvas** (Monaco) com **métricas de complexidade nativas** (Ciclomática, Cognitiva, Halstead, Maintainability Index) e um **DebuggerAgent** que usa o **Serena MCP** (LSP semântico, 50+ linguagens) + o **MemoryProvider ativo** (bugs similares já resolvidos) pra propor e validar fixes. Debug vira cirurgia semântica, não caça ao rato por grep.
- **Nota de naming:** produto é **OmniRift** (codename "Maestri" aposentado em 2026-06-17). Nomes neutros do design (`CodeNode`, `DebuggerAgent`, `CodeMetrics`) seguem válidos.

---

## 1. Problema

Hoje o OmniRift orquestra agentes em PTYs no canvas, mas **não há como abrir/editar código** dentro do app — apenas via terminais. Não existe feedback visual sobre **complexidade do código que está sendo escrito**, e o **debug assistido por IA** exige que o usuário cole erros manualmente no agente. Ao mesmo tempo, o Serena (MCP server de análise semântica via LSP) já é injetado nos agentes pelo `agent_mcp_config` (Fase 1a ✅), mas **só dentro do terminal do agente** — o canvas não consome essas capacidades diretamente.

O usuário quer: abrir a tela de códigos, ver métricas de complexidade nativas (com nomes conhecidos — Ciclomática/Cognitiva/Halstead/MI), e ter um DebuggerAgent que consulta Serena + memória + boas práticas pra propor fixes.

## 2. Objetivo e sucesso

Adicionar ao OmniRift:

- **CodeNode** — novo tipo de nó de canvas: editor Monaco + painel de métricas de complexidade.
- **Métricas nativas** — Cyclomatic, Cognitive, Halstead, Maintainability Index calculadas em Rust sobre tree-sitter (incremental, multi-linguagem).
- **DebuggerAgent** — agente despachado com acesso a Serena (LSP), MemoryProvider ativo, e o diff/erro do CodeNode, via event bus Tauri (não PTY pipe).
- **Boas práticas** — thresholds configuráveis por linguagem, com feedback visual inline (verde/amarelo/vermelho) e sugestões acionáveis.

**Sucesso quando:**
- [ ] Usuário abre um arquivo `.rs`/`.ts`/`.py` no CodeNode e vê as 4 métricas atualizadas a cada digitação (debounced 500ms).
- [ ] Função com Cyclomatic > 10 é destacada em vermelho no painel; hovering mostra a razão.
- [ ] Usuário clica em "Debug" no CodeNode; um DebuggerAgent é criado/spawnado com Serena + MemoryProvider ativo injetados e recebe o contexto (arquivo, linha, erro, métricas).
- [ ] DebuggerAgent propõe um fix; aplicá-lo atualiza o CodeNode (via `replace_symbol_body` do Serena ou edição direta).
- [ ] O mesmo bug reaparece em outro arquivo → DebuggerAgent consulta o MemoryProvider, encontra o fix anterior, reusa.
- [ ] Sem regressão: **todos os testes atuais** (59 hoje — Fase 8 + review + keychain) continuam passando + novos testes da Fase 9.
- [ ] Pooling de subprocessos Serena: máximo 3 instâncias por projeto (não 1 por arquivo).

## 3. Arquitetura — três camadas independentes

```
┌──────────────────────────────────────────────────────────────────┐
│ Canvas OmniRift (React Flow)                                      │
│                                                                  │
│  ┌────────────────────┐         ┌─────────────────────┐          │
│  │  CodeNode           │─event──▶│  DebuggerAgent      │          │
│  │  (Monaco editor)    │  bus    │  (TerminalNode que  │          │
│  │  .rs / .ts / .py   │         │   já existe + role  │          │
│  │  ┌───────────────┐ │         │   "debugger" com    │          │
│  │  │ Painel        │ │         │   Serena+Memory MCP │          │
│  │  │ Complexidade  │ │◀─diff──│   injetados)         │          │
│  │  │ ◉ Cycl   12   │ │         └─────────────────────┘          │
│  │  │ ◉ Cogn    8   │ │                                           │
│  │  │ ◉ Halst  D=4  │ │                                           │
│  │  │ MI       72   │ │                                           │
│  │  └───────────────┘ │                                           │
│  └────────────────────┘                                           │
└──────────────────────────────────────────────────────────────────┘
         │                    │
         ▼                    ▼
┌──────────────────────────────────────────────────────────────────┐
│  src-tauri/src/                                                  │
│                                                                  │
│  code/  (NOVO — métricas + parser)                              │
│   ├─ mod.rs                                                      │
│   ├─ file_io.rs        abrir/salvar/watch (notify crate)        │
│   ├─ tree_sitter.rs    parser incremental multi-linguagem      │
│   ├─ cyclomatic.rs     McCabe 1976 sobre AST                     │
│   ├─ cognitive.rs       SonarSource 2016 sobre AST                │
│   ├─ halstead.rs       Halstead 1977 sobre tokens                 │
│   ├─ metrics.rs        agregador + thresholds + MI               │
│   └─ thresholds.rs    config por linguagem (serde)               │
│                                                                  │
│  mcp/  (existe — estende)                                       │
│   ├─ client.rs         (NOVO) JSON-RPC sobre stdio (spec MCP)     │
│   ├─ serena_pool.rs    (NOVO) pool de subprocessos Serena/proj    │
│   └─ tools.rs          (existe — adiciona code_* tools)         │
│                                                                  │
│  commands/                                                      │
│   ├─ code.rs           (NOVO) Tauri commands do CodeNode         │
│   └─ debug.rs          (NOVO) Tauri commands do DebuggerAgent   │
│                                                                  │
│  agents/  (existe)                                              │
│   └─ debug_routine.rs  (NOVO) rotina de debug no CodeNode        │
└──────────────────────────────────────────────────────────────────┘
```

## 4. Componentes — escolhas técnicas

| Peça | Escolha | Por quê |
|------|---------|---------|
| Editor no canvas | **Monaco** (`@monaco-editor/react`) | Mesmo engine do VS Code, syntax highlight 80+ linguagens, API rica de markers/decorations. Carrega sob demanda (dynamic import) e destrói quando ocioso. CodeMirror 6 é mais leve, mas Monaco tem melhor DX pro usuário final e markers nativos. |
| Parser Rust | **`tree-sitter`** crate + grammars por feature flag | Incremental (re-parse só o que mudou), 200+ gramáticas oficiais. Load-on-demand: só compila a grammar da linguagem do arquivo aberto. |
| MCP client (Serena) | **Implementação própria** (~300 LOC) | Spec MCP é JSON-RPC 2.0 sobre stdio; crates existentes estão imaturos. 300 LOC bem escritas > dependência duvidosa. |
| Serena runtime | **Pool de subprocessos** `uvx --from serena-agent serena` | Máximo 3 instâncias reusáveis por projeto (não 1 por arquivo). `tokio::process::Command` com stdin/stdout pipes. |
| File watch | `notify` crate | Padrão de facto em Rust para FS events (inotify/FSEvents/kqueue). |
| Métricas | **Implementação própria** sobre tree-sitter | Sem crate maduro que combine Cyclomatic + Cognitive + Halstead + MI. Cyclomatic e Halstead são triviais sobre AST/tokens; Cognitive exige traversal customizada (SonarSource spec). Vale o esforço — controle total e alinhamento com o app. |
| UI métricas | **Tailwind direto** + barras coloridas (verde/amarelo/vermelho) | É o padrão real do app — `@omnirift/ui`/shadcn NÃO é consumido hoje; painel no mesmo estilo de `ReviewModal` etc. |
| Comunicação CodeNode ↔ DebuggerAgent | **Event bus Tauri** (commands + `emit`/`listen`) | PTY pipes são pra I/O de terminal, não mensagens estruturadas. `debug_request` command com payload JSON é limpo, seguro e debugável. |
| Debug routine | **Direto no CodeNode** (watch interno) | Fase 6 (Routines) ainda parcial — acoplar agora gera débito. Migra quando Routines amadurecer. |

## 5. Métricas de complexidade — referência canônica

| # | Nome | Autor/ano | O que mede | Limite típico |
|---|------|-----------|------------|---------------|
| 1 | **Cyclomatic Complexity** | McCabe, 1976 | # caminhos independentes (cada `if`/`while`/`for`/`case`/`&&`/`\|\|`/catch soma +1) | ≤ 10 por função |
| 2 | **Cognitive Complexity** | SonarSource, 2016 | Esforço humano — penaliza aninhamento (×n), recursão, quebras de fluxo | ≤ 15 por função |
| 3 | **Halstead Metrics** | Halstead, 1977 | Dificuldade, Volume, Esforço, Bugs estimados (operadores/operandos distintos vs. totais) | D ≤ 5, V ≤ 200 |
| 4 | **NPath Complexity** | Nejmeh, 1988 | # caminhos possíveis (exponencial com aninhamento) | ≤ 200 |
| 5 | **Maintainability Index** | Microsoft, 1991 | Combina Halstead + Cyclomatic + LOC numa escala 0–100 | ≥ 65 |

**Implementação:** Cyclomatic + Cognitive + Halstead no backend Rust. MI derivado (fórmula Microsoft: `MI = max(0, (171 - 5.2*ln(V) - 0.23*CC - 16.2*ln(LOC)) * 100/171)`). NPath fica fora da v1 (exponencial, ganho marginal sobre Cyclomatic).

## 6. Serena — ferramentas consumidas pelo DebuggerAgent

[Serena](https://github.com/oraios/serena) é MCP server open-source que expõe análise semântica sobre LSP. Ferramentas-chave usadas pelo DebuggerAgent:

- `find_symbol` — achar símbolo por nome (ex: função com erro)
- `get_symbol_details` — assinatura, docs, tipo de retorno
- `get_references` / `find_referencing_symbols` — quem chama isso (cross-file)
- `search_for_pattern` — busca semântica (não grep)
- `replace_symbol_body` — editar via AST (não string-match)
- + ~15 outras (criar arquivo, ler, etc.)

Suporta Python, JS/TS, Rust, Go, Java, C#, C++, PHP — todas as linguagens com LSP. **O OmniRift já injeta Serena em todo agente** (`agent_mcp_config`); a novidade é consumir Serena **direto do backend Rust** (via MCP client stdio) pra alimentar o CodeNode com info semântica (ex: "mostrar todas as refs da função com complexidade alta") e dar ao DebuggerAgent contexto rico sem precisar do terminal.

## 7. Fluxo de debug

```
1. Usuário abre arquivo X.rs no CodeNode → tree-sitter parseia → métricas calculadas
2. Usuário edita → debounce 500ms → re-parse incremental → métricas atualizadas
3. Função `foo` aparece com Cyclomatic 18 (vermelho) → painel mostra razão
4. Usuário clica em "Debug" no CodeNode
5. Backend: serena_pool.get_or_spawn(projeto) → MCP client stdio
6. Backend: chama serena.find_symbol("foo") + serena.get_references("foo")
7. Backend: chama memory_registry.active_provider().search("cyclomatic high foo")
8. Backend: monta prompt com {arquivo, diff, métricas, refs serena, memória similar}
9. Backend: spawn DebuggerAgent (TerminalNode com role "debugger")
10. DebuggerAgent recebe o prompt + Serena + MemoryProvider injetados
11. DebuggerAgent propõe fix → usuário aprova → serena.replace_symbol_body aplica
12. CodeNode recarrega arquivo → métricas recalculadas → Cyclomatic caiu pra 8 (verde)
13. MemoryProvider.save({content: "foo: cyclomatic 18→8 por refatorar branch X", category: "debug_fix"})
```

## 8. Sub-fases

| Sub-fase | Escopo | Depende de | Esforço |
|----------|--------|------------|---------|
| **9a** | CodeNode no canvas — Monaco em React Flow, abrir/fechar arquivo, watch FS | Fase 1 ✅ | médio |
| **9b** | MCP Client stdio (JSON-RPC) + Serena pool (subprocesso por projeto, teto 3) | 9a | médio |
| **9c** | Métricas nativas — tree-sitter + ciclomática + cognitiva + halstead + MI | 9a | médio-alto |
| **9d** | DebuggerAgent — event bus + spawn com Serena+Memory + rotina de debug | 9a, 9b, 9c | médio |
| **9e** | Painel de boas práticas — thresholds configuráveis, linting visual inline | 9c | pequeno |

**Ordem ótima:** 9a primeiro (fundação). Depois 9b + 9c em paralelo (independentes — MCP client e tree-sitter não se tocam). 9d só depois das três. 9e ao final.

## 9. Testes (pirâmide)

- **Rust unit:** tree-sitter parseia snippet de cada linguagem; Cyclomatic/Cognitive/Halstead em casos conhecidos (ex: `fn x() { if a && b { for c { } } }` → CC=3); MCP client serializa/deserializa JSON-RPC; Serena pool reusa instância do mesmo projeto.
- **Integração:** CodeNode abre arquivo real, métricas calculadas, Serena pool responde `find_symbol` contra um projeto fixture.
- **Front:** `tsc` direcionado + smoke do CodeNode (Monaco monta, métricas renderizam, painel mostra thresholds); DebuggerAgent recebe payload via event bus.

## 10. Fora de escopo (YAGNI)

- NÃO reescrever o Serena — só consumir.
- NÃO reimplementar LSP — Serena já encapsula.
- NÃO editor multi-cursor avançado (Monaco tem, mas não expomos tudo na v1).
- NÃO auto-aplicar fixes sem aprovação do usuário (Fase 9d exige clique em "Apply").
- NÃO NPath Complexity na v1 (exponencial, ganho marginal).
- NÃO integrar com Routines da Fase 6 ainda (parcial — migra depois).
- NÃO diff visual inline entre versão original e fix (DiffViewerModal já existe, reusar se fizer sentido).

## 11. Riscos

- **Monaco pesado (~5MB)** → dynamic import + lazy mount + destruir quando ocioso; CodeNode é um nó de canvas, pode ter múltiplas instâncias. Mitigação: só montar Monaco quando o nó for visível (não em `display:none`).
- **Tree-sitter grammars** → carregar todas é overkill; load-on-demand por feature flag do Cargo. Mitigação: só compilar a grammar da linguagem do arquivo aberto.
- **Subprocessos Serena** → 5 projetos = 5 subprocessos + 5 LSPs. Mitigação: pool com teto 3, reusar por projeto, timeout ocioso (5min sem uso → kill).
- **Cognitive Complexity** → spec SonarSource tem arestas (break/goto, recursão, ternário aninhado). Mitigação: implementar a spec literalmente, testar contra exemplos da SonarSource.
- **Event bus Tauri** → `emit`/`listen` é global; múltiplos CodeNodes podem ouvir eventos uns dos outros. Mitigação: payload sempre carrega `codeNodeId` emissor e `debuggerAgentId` alvo; listener filtra.
- **Race condition diff vs Serena** → usuário edita enquanto Serena está replace_symbol_body. Mitigação: lock por arquivo (RwLock no backend), rejeitar edição manual enquanto Serena aplicando.

## Compliance notes

- **Classe de dados:** código-fonte do usuário pode conter segredos hardcoded (tokens, senhas) — nunca logar conteúdo do arquivo; métricas sim (são números), conteúdo não.
- **ISO 27001:** A.8.10 (sem código em log), A.8.15 (Serena subprocesso isolado por projeto), A.5.15 (token do MemoryProvider só no wiring, nunca no payload de debug).
- **Risco mitigado:** vazamento de código via logs; corrupção de arquivo por race condition (lock por arquivo).

## Próximo passo

Revisão deste spec → `writing-plans` da Fase 9 (este doc). Implementação segue o dev-flow do projeto (TDD, Ollama pro corpo do código + auditoria Claude via `cargo test`). Branch: `feat/code-workspace-debug-ia` partindo da `main` (ou da `feat/memory-provider-fase1` se quiser já memory-aware).
