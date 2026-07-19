# Revisão pré-release da versão 0.1.140 — OmniRift

**Data:** 19 de julho de 2026

**Base anterior:** `v0.1.138` (`23ee5aa`)

**Base revisada:** `v0.1.140` (`f65e97b`)

**Intervalo:** 11 commits, 44 arquivos, 4.201 adições e 160 remoções

**Escopo:** mudanças da 0.1.140, regressões, segurança, FailProof, complexidade ciclomática, testes, dependências e release

**Veredito:** **NO-GO**

> Esta revisão complementa `docs/2026-07-19-auditoria-completa.md`. Ela não declara
> resolvidos os achados anteriores que não foram modificados no intervalo. Dos achados
> de segurança da auditoria-base, a mudança desta versão corrige diretamente o
> OR-SEC-009, usando `OsRng` para o token RPC/MCP. Os demais riscos estruturais continuam
> exigindo remediação própria.

---

## 1. Resumo executivo

A versão 0.1.140 contém melhorias tecnicamente válidas: reduz a frequência da coleta de
métricas, limita o snapshot visual dos terminais, interrompe animações permanentes,
remove o foco automático na montagem do xterm, usa RNG do sistema para tokens e preserva
o papel do agente em re-registros.

Entretanto, a versão não deve ser publicada no estado da tag auditada. A correção que dá
nome à release — fazer os agentes Claude voltarem a abrir no Windows — existe como função
isolada, mas nunca é chamada pelo fluxo de produção. O próprio Clippy confirma que a
função e sua constante são código morto. O problema de navegador por papel também não
foi ligado ao caminho comum de Frontend/QA. Além disso, um diagnóstico real de cliente,
com caminhos locais e nomes de projetos, foi incluído no commit, na tag e no source
archive.

O gravador de diagnóstico melhorou, mas ainda não garante a fronteira de consentimento:
somente `debug.log` é cortado pela marca; `omnirift.log` continua trazendo histórico
anterior. Falhas ao gravar a marca são engolidas e um trecho marcado deixa de respeitar o
limite de tamanho.

No momento da revisão, a tag `v0.1.140` já existia e o workflow GitHub
`29698310677` estava construindo Windows, Linux e macOS. O workflow de release não roda
testes, typecheck ou lint e o smoke final abre apenas o pacote Linux. Assim, ele não é
capaz de detectar o bloqueador principal do Windows.

### Bloqueadores

| ID | Severidade | Achado | Bloqueia release |
|---|---:|---|:---:|
| R140-REL-001 | Crítica | Correção do prompt longo no Windows é código morto | Sim |
| R140-SEC-002 | Alta | Quoting de `cmd.exe` usa regras MSVCRT e admite metacaracteres | Sim |
| R140-REL-003 | Alta | Frontend/QA continuam sem MCP de navegador; arquivo MCP tem corrida | Sim |
| R140-PRIV-004 | Alta | Diagnóstico real de cliente foi versionado e incluído na tag | Sim |
| R140-PRIV-005 | Alta | Gravação diagnóstica ainda inclui histórico não delimitado | Sim |
| R140-REL-006 | Média | Correção do foco é plausível, mas não possui validação de UI e introduz foco não determinístico | Condicional |
| R140-CI-007 | Alta | Release não possui gate funcional de agente no Windows | Sim |
| R140-DEP-008 | Alta | 14 advisories npm e suíte do License Worker quebrada | Sim para hardening |
| R140-QLT-009 | Média/Alta | Lint, Clippy e rustfmt continuam vermelhos; hotspots altos | Sim para gate de qualidade |

---

## 2. O que mudou na 0.1.140

### 2.1 Desempenho

- o sampler nativo passa de varredura global de processos a cada segundo para dois
  ritmos: topologia completa a cada 10 segundos e atualização seletiva dos PIDs conhecidos;
- o painel fechado usa amostragem a cada 5 segundos e só ativa 1 Hz quando expandido e
  visível;
- lista de discos é reutilizada;
- `nvidia-smi` por processo deixa de rodar sem agentes;
- floors ocultos pausam polls e renderização visual, sem matar o PTY no backend;
- animações SVG ociosas de edges foram removidas;
- snapshots locais do xterm passam de até 10.000 para 1.000 linhas;
- snapshots remotos sem `rows` passam a usar 500 linhas.

**Avaliação:** o desenho é coerente e reduz trabalho ocioso. A alegação de ganho de CPU
é apoiada por medição anterior/posterior descrita nos commits, mas não foi repetida nesta
revisão em uma build empacotada. O ganho de memória prometido pelos MCPs de navegador não
é válido para Frontend/QA no wiring atual.

### 2.2 Canvas e terminais

- `fit()` não foca mais por padrão;
- a montagem do xterm não chama mais `term.focus()`;
- clique explícito no terminal chama `fit(true)`;
- reparent para fullscreen/dock ainda chama `fit(true)`;
- cursor blink e escrita visual são pausados para views ocultas;
- o xterm passa a manter 1.000 linhas de scrollback, coerente com o snapshot pedido.

**Avaliação:** as duas causas apontadas para o travamento durante pan — disputa de foco e
reidratação excessiva — foram tratadas estaticamente. Falta teste renderizado e A/B na
mesma máquina/canvas de 12 agentes. A nota “não trava mais” é mais forte do que a evidência
atual permite afirmar.

### 2.3 Segurança e confiabilidade

- token RPC/MCP agora usa 32 bytes de `OsRng`: correção válida do OR-SEC-009;
- re-registro da mesma sessão preserva `role` e `floor` quando a nova chamada traz
  `None`: correção válida;
- `reveal_path` canonicaliza o alvo, exige existência, restringe aos diretórios
  permitidos e usa argv, sem shell: desenho adequado;
- action trail ganhou testes de privacidade e seu runner foi corrigido de 331 execuções
  enganosas para 35 casos reais;
- foram adicionados textos em português/inglês para o gravador.

### 2.4 Windows e MCP

- foi criada uma função para trocar `--append-system-prompt` por
  `--append-system-prompt-file` acima de 7.000 caracteres;
- foi criado um wrapper compartilhado para shims como `npx.cmd` no ACP;
- papéis Frontend e QA receberam `needsBrowser: true`.

**Avaliação:** são exatamente as áreas onde permanecem os dois bloqueadores funcionais
mais graves. A função de spill não está ligada à produção e `needsBrowser` não é passado
no caminho comum desses papéis.

---

## 3. Achados detalhados

## R140-REL-001 — Correção do prompt longo no Windows não é executada

**Severidade:** Crítica

**Confiança:** Confirmado por fluxo estático e Clippy

**Impacto:** agentes Claude continuam podendo encerrar em aproximadamente 1–2 segundos
no Windows quando o prompt ultrapassa o limite do `cmd.exe`.

### Evidência

- `spill_system_prompt_to_file` é definida em
  `apps/desktop/src-tauri/src/pty/session.rs:513`;
- suas únicas chamadas estão nos quatro testes em
  `apps/desktop/src-tauri/src/pty/session.rs:1109`, `:1121`, `:1136` e `:1155`;
- `build_command`, em `apps/desktop/src-tauri/src/pty/session.rs:560`, usa diretamente
  `cfg.args` e chama `build_program` sem aplicar o spill;
- `PtySession::spawn`, em `apps/desktop/src-tauri/src/pty/session.rs:184`, chama somente
  `build_command(&cfg)`;
- `cargo clippy --lib --all-features -- -D warnings` reporta
  `CMD_LINE_SAFE_LIMIT` e `spill_system_prompt_to_file` como nunca usados.

Os testes estão verdes porque testam a função isolada, não o caminho que inicia o
processo. É um caso clássico de teste unitário correto com integração inexistente.

### Falha FailProof adicional

Se a escrita do arquivo falhar, a função devolve os argumentos grandes originais. O
comentário chama isso de fail-open, mas o comportamento conhecido desses argumentos é
exceder o limite e impedir o agente de subir. O fallback precisa retornar erro explícito
ou escolher outro transporte seguro; repetir a entrada sabidamente inválida não é
degradação funcional.

### Correção exigida

1. aplicar o spill no caminho de produção antes do wrapper do `cmd.exe`;
2. limitar a transformação a Windows + execução local; um arquivo local não existe no
   host SSH remoto;
3. devolver `Result`, com erro visível se o arquivo necessário não puder ser criado;
4. criar arquivo com permissão de dono, nome não derivado diretamente de `session_id` e
   ciclo de limpeza definido;
5. testar `build_command`/spawn completo, não apenas o helper;
6. adicionar smoke no Windows que inicia Claude com prompt acima de 8.191 caracteres e
   verifica que o processo permanece vivo/ready.

## R140-SEC-002 — Wrapper de `cmd.exe` não escapa a linguagem do shell

**Severidade:** Alta

**Confiança:** Alta; execução dinâmica em Windows ainda pendente

**Impacto:** corrupção de argumentos e possibilidade de injeção de comandos quando
prompts/args contêm sintaxe do `cmd.exe`.

### Evidência

`win_argv_quote`, em `apps/desktop/src-tauri/src/proc_win.rs:37` e na implementação
duplicada de `pty/session.rs:86`, aplica regras de `CommandLineToArgvW`/MSVCRT. Depois,
`wrap_for_windows` e `build_program` entregam a string a `cmd.exe /s /c`.

O `cmd.exe` possui outra gramática. Metacaracteres como `&`, `|`, `<`, `>`, `^`, `%`,
`!`, parênteses e quebras de linha não são neutralizados por quoting MSVCRT. Em especial,
`\"` não é o escape de aspas do `cmd`. Role prompts e argumentos podem conter aspas e
metacaracteres e são dados, não comandos de shell.

Os testes atuais verificam apenas a função de quote no Linux. Eles não executam o
resultado em `cmd.exe` e não cobrem metacaracteres, expansão `%VAR%`, delayed expansion
ou quebras de linha.

### Correção exigida

- centralizar uma única implementação de spawn Windows;
- evitar `cmd.exe` quando o alvo puder ser resolvido para executável nativo;
- para `.cmd`, usar uma rotina de quoting específica para a gramática do `cmd`, com
  delayed expansion desabilitada e matriz de testes em Windows real;
- nunca transportar prompt longo pela linha de comando;
- testar argumentos canário contendo todos os metacaracteres e confirmar argv idêntico
  no processo filho.

## R140-REL-003 — Browser por papel continua quebrado e o config MCP é compartilhado

**Severidade:** Alta

**Confiança:** Confirmado

**Impacto:** Frontend/QA perdem Playwright; spawns concorrentes podem receber perfil MCP
errado ou arquivo parcialmente escrito.

### Evidência de wiring

Frontend e QA têm `needsBrowser: true` em
`apps/desktop/src/lib/agent-roles.ts:244` e `:277`, mas não possuem `mcpServers`.

Em `apps/desktop/src/lib/agent-spawn.ts:113-116`, `role.needsBrowser` só é enviado dentro
do ramo `role.mcpServers !== undefined`. No ramo comum, usado pelos dois builtins, a
chamada permanece `agentMcpConfig()` e o backend remove Playwright.

Há três agravantes:

1. papéis built-in persistidos em versões anteriores não recebem o campo novo, pois
   `loadRoles` apenas adiciona IDs ausentes (`agent-roles.ts:318-326`);
2. o branch shell em `Sidebar.tsx:1480-1483` também não passa `needsBrowser`;
3. não há teste de integração que monte o spawn de Frontend, QA e Backend e leia o JSON
   final.

### Corrida do arquivo

Em `apps/desktop/src-tauri/src/commands/mcp.rs:329-337`, tanto o perfil sem navegador
quanto `allow_browser=true` usam `agent-mcp.json`. Cada chamada trunca e reescreve o
mesmo arquivo com `std::fs::write` (`:345`). Dois agentes iniciados juntos podem observar
o perfil da última gravação, receber capacidade indevida/perdê-la ou ler JSON durante
uma reescrita.

### Correção exigida

- passar `role.needsBrowser` nos dois ramos;
- migrar campos novos dos builtins salvos, preservando customizações do usuário;
- incluir o perfil completo no nome/hash do arquivo;
- gravar de forma atômica e manter permissão 0600;
- testar spawns simultâneos com e sem browser e verificar arquivos distintos;
- corrigir a documentação que ainda diz “undefined = TODOS”.

## R140-PRIV-004 — Diagnóstico real de cliente está dentro da tag

**Severidade:** Alta

**Confiança:** Confirmado

**Arquivo:** `logs_clientes/omnirift-diagnostico-20260719-143512.txt`

O arquivo possui 53.640 bytes, está com modo local 0664 e contém:

- um diretório de usuário Windows identificável;
- caminhos e nomes de projetos do cliente;
- 24 ocorrências de contexto `cwd`;
- identificadores de sessões e histórico de 16 spawns/14 saídas;
- logs de múltiplos boots, não apenas do incidente usado no commit.

Não foram detectados e-mails nem tokens pelos padrões atuais. Isso não torna o arquivo
publicável: nomes de projetos, estrutura de diretórios, username e histórico operacional
são dados do cliente. O Gitleaks não sinalizou o arquivo, demonstrando que secret scan
não substitui revisão de privacidade.

O arquivo está presente na árvore de `v0.1.140` e em `git archive v0.1.140`. Como foi
commitado, removê-lo apenas no próximo commit não apaga as cópias do histórico/remotes.

### Correção exigida

- retirar o arquivo do HEAD e adicionar `logs_clientes/` ao ignore;
- avaliar purge coordenado do histórico nos remotes; não reescrever história sem plano
  porque isso impacta clones e tags;
- manter diagnósticos fora do repositório, com acesso restrito e política de retenção;
- avisar o responsável pelos dados se o repositório já os tornou acessíveis;
- gerar fixtures sintéticas para testes/documentação.

## R140-PRIV-005 — Delimitação do gravador é parcial e falha aberta

**Severidade:** Alta

**Confiança:** Confirmado

**Impacto:** export pode conter atividade anterior ao clique “gravar” e crescer sem teto.

### Evidência

1. `slice_recording` é aplicado apenas ao `debug.log` em
   `commands/diagnostics.rs:119`. O `omnirift.log`, coletado por `read_log_tail` em
   `:67-83`, entra diretamente no arquivo em `:133-134` e pode conter até 200 KiB de
   sessões anteriores.
2. `markBoot` engole qualquer falha e retorna string vazia
   (`src/lib/debug-log.ts:16-22`). `DiagRecorder` ignora o retorno e mostra gravação ativa
   (`DiagRecorder.tsx:88-90`).
3. se a marca existir, `slice_recording` retorna tudo após ela (`diagnostics.rs:31-32`)
   e ignora `max_bytes`. Uma gravação longa pode produzir export arbitrariamente grande.
4. a marca é uma substring estática. Uma linha de log contendo o mesmo texto pode
   alterar a fronteira de integridade.
5. o arquivo final usa `File::create` sem endurecimento explícito de permissão
   (`diagnostics.rs:151`). O diagnóstico observado no repositório ficou 0664.
6. quando não há marca, o aviso fica dentro do arquivo gerado; não há confirmação
   explícita na UI antes de incluir histórico.

### Correção exigida

- iniciar a gravação no backend e devolver um ID opaco/aleatório;
- registrar offsets ou marcadores estruturados em **ambos** os logs;
- falhar fechado se a fronteira não puder ser persistida;
- manter teto de bytes também no caminho marcado;
- gerar o arquivo de forma atômica e owner-only;
- se houver fallback histórico, pedir consentimento visível antes da exportação.

## R140-REL-006 — Foco e pan melhoraram, mas o comportamento novo não está fechado

**Severidade:** Média

**Confiança:** correção principal com alta confiança estática; comportamento completo
não validado dinamicamente.

A remoção de `term.focus()` da montagem e o foco opt-in de `fit()` corrigem a disputa
durante remount/IntersectionObserver. Porém:

- `addTerminal` faz eager-spawn em `canvas-store.ts:616-621`;
- ao montar, o hook normalmente encontra a sessão viva e entra como `attached`, então o
  foco de “sessão nova” em `useTerminalSession.ts:316-320` não roda;
- dependendo da corrida entre eager-spawn e mount, um terminal novo pode focar ou não;
- reparent do host chama `fit(true)` em `TerminalNode.tsx:436-439`, inclusive quando uma
  mudança de floor/dock desloca o orquestrador;
- não existe teste com DOM/xterm que afirme que pan/remount não muda `document.activeElement`;
- a convenção do projeto exige teste de UI no DOM, mas não há runner
  Vitest + Testing Library do desktop.

### Critério de aceite

- teste renderizado com vários terminais, unmount/remount e pan simulado;
- foco só após gesto explícito ou criação determinada por um único owner;
- teste A/B com 12 agentes medindo p95/p99 de frame/pan e tempo de reattach;
- validação em WebKitGTK e WebView2.

## R140-CI-007 — O pipeline pode publicar a regressão principal

**Severidade:** Alta

**Confiança:** Confirmado pelo workflow

`.github/workflows/release.yml` faz `npm ci`, compila os sidecars e executa
`tauri-action`. Não roda `cargo test`, os 211 testes puros, typecheck ou lint. O smoke
gate instala e abre apenas o `.deb` Linux (`release.yml:190-227`).

O bug crítico é específico do caminho `cmd.exe`/WebView2 e não é exercitado pelo smoke
Linux. O build Windows prova compilação/empacotamento, não que um agente Claude abre com
prompt real.

### Correção exigida

- release deve depender de um SHA aprovado pelos gates ou repetir os gates na tag;
- adicionar teste Windows real do spawn Claude/fixture `.cmd` com prompt longo;
- adicionar smoke de abertura do app e de uma sessão PTY no Windows;
- não publicar automaticamente a tag atual após um smoke exclusivamente Linux;
- por causa do guard de versão estritamente crescente, entregar as correções em nova
  versão, sem mover silenciosamente a tag já propagada.

## R140-DEP-008 — Dependências vulneráveis e testes do Worker quebrados

**Severidade:** Alta no conjunto

**Confiança:** Resultado do `npm audit` e execução local

O `npm audit --workspaces --include-workspace-root` retornou 14 pacotes afetados:

| Severidade | Quantidade |
|---|---:|
| Crítica | 2 |
| Alta | 5 |
| Moderada | 5 |
| Baixa | 2 |

Diretos de maior relevância: `vitest` (crítica, tooling),
`@cloudflare/vitest-pool-workers` (crítica, tooling), `vite` (alta, dev server),
`wrangler` (alta, deploy/tooling) e `dompurify` (moderada, runtime/sanitização).

A suíte `services/license-worker` falha antes de coletar qualquer teste:

- Vitest instalado: 3.2.6;
- pool Cloudflare declara suporte apenas a Vitest 2.0.x–2.1.x;
- runtime falha ao resolver `devalue`;
- resultado: **0 arquivos e 0 testes executados, 1 erro**.

O serviço de licença possui achados críticos/altos na auditoria-base; ficar sem a suíte
executável elimina uma das poucas barreiras contra regressões nessa área.

## R140-QLT-009 — Complexidade e gates continuam acima do limite

**Severidade:** Média/Alta de confiabilidade

### Complexidade ciclomática dos caminhos relevantes

Medição com Lizard 1.23.0. Threshold recomendado: CCN até 10 normal; 11–15 exige revisão
e testes de ramos; acima de 15 deve ser dividido antes de nova lógica crítica.

| Função | Arquivo | CCN | Observação |
|---|---|---:|---|
| `landFloor` | `Sidebar.tsx` | 121 | hotspot estrutural; atribuição TSX pode englobar closures |
| `buildRoleSpawn` | `agent-spawn.ts` | 34 | wiring de CLI/MCP/skills; originou o bug de branch |
| `spawnRole` | `Sidebar.tsx` | 25 | fluxo alternativo shell ainda diverge |
| `PtySession::spawn` | `pty/session.rs` | 21 | ciclo de vida concorrente/PTY |
| callback de reconnect | `useTerminalSession.ts` | 17 | várias corridas e fallbacks |
| `win_argv_quote` | `proc_win.rs` | 15 | fronteira de segurança sem teste Windows |
| `agent_mcp_config` | `commands/mcp.rs` | 14 | montagem, filtro e persistência no mesmo bloco |
| `build_command` | `pty/session.rs` | 11 | host, sandbox e spawn por plataforma |
| `diagnostics_export` | `commands/diagnostics.rs` | 9 | duas fontes de log e IO |
| `slice_recording` | `commands/diagnostics.rs` | 6 | baixa complexidade, mas invariante incompleta |
| `spill_system_prompt_to_file` | `pty/session.rs` | 5 | simples, porém desconectada da integração |

Os principais defeitos desta revisão não são explicados apenas por CCN: são falhas de
wiring e de invariantes entre módulos. Isso reforça que métrica ciclomática precisa ser
combinada com testes ponta a ponta.

### Gates

| Gate | Resultado |
|---|---|
| versões package/desktop/Cargo/Tauri | 0.1.140, sincronizadas |
| `npm run typecheck` | passou |
| `npm run build` | passou; warnings de chunks > 500 kB |
| `cargo test --lib` | 684 passaram, 1 ignorado |
| runners puros do desktop | 211 passaram, 0 falharam |
| License Worker | falhou antes de coletar testes |
| ESLint | falhou: 89 erros e 17 warnings |
| Clippy com `-D warnings` | falhou: 87 erros |
| rustfmt check | falhou no baseline amplo do workspace |
| Lizard | 7 warnings no conjunto dirigido; hotspots até CCN 121 |
| Semgrep | 20 achados INFO; nenhum novo high/critical automático |
| Gitleaks histórico | 4 hits, triados como canários/testes e chave de localStorage |
| npm audit | 14 vulnerabilidades: 2 críticas e 5 altas |
| Windows cross-check local | inconclusivo: ambiente sem `lib.exe`; CI xwin/Windows necessário |

O lint foi executado com uma alteração local de ignore que apareceu durante a revisão e
não pertence à tag. Ela apenas remove artefatos gerados do scan; os 106 problemas
restantes são de código-fonte. A CI atual não executa lint.

---

## 4. Matriz de regressão mínima para a próxima versão

| Cenário | Plataforma | Asserção obrigatória |
|---|---|---|
| Claude com prompt de 12 kB | Windows | processo abre e chega a ready |
| Prompt com `&|<>^%!"` e newline | Windows | argv chega literal; nenhum comando lateral roda |
| Frontend builtin, storage vazio | Linux/Windows | config contém Playwright |
| QA builtin salvo na 0.1.138 | Linux/Windows | migração adiciona browser sem perder customizações |
| Backend builtin | Linux/Windows | config não contém browser |
| Frontend + Backend simultâneos | Linux/Windows | paths distintos e JSON íntegro |
| Pan por 12 agentes | WebKitGTK/WebView2 | foco não muda; p95/p99 dentro do orçamento |
| Remount de terminal | WebKitGTK/WebView2 | no máximo 1.000 linhas reidratadas |
| Início de diagnóstico sem permissão | todos | UI não entra em “gravando” |
| Export após gravação | todos | nenhum byte anterior em ambos os logs |
| Gravação longa | todos | pacote respeita teto de tamanho |
| Release Windows | Windows runner | smoke cria PTY e inicia fixture `.cmd` |

---

## 5. Ordem recomendada de correção

1. impedir publicação da tag atual enquanto o run estiver em draft/em execução;
2. retirar o diagnóstico do código e tratar a exposição já ocorrida;
3. ligar o spill ao spawn real, tornar a falha explícita e adicionar smoke Windows;
4. corrigir o quoting do `cmd.exe` com teste em Windows real;
5. corrigir o wiring/migração/isolamento dos configs MCP;
6. redesenhar a fronteira do gravador para ambos os logs, com ID e limites;
7. criar testes DOM para foco/remount e repetir o A/B com 12 agentes;
8. alinhar Vitest/Cloudflare pool, atualizar dependências e reativar os testes do Worker;
9. tornar typecheck, testes, lint controlado e smoke Windows gates obrigatórios de release;
10. lançar uma versão nova estritamente maior, preservando a regra anti-downgrade.

---

## 6. Critério de GO

A próxima candidata só recebe GO quando:

- não houver função de correção crítica morta;
- o teste Windows de prompt longo e metacaracteres passar;
- Frontend/QA e Backend receberem configs MCP corretos em spawn concorrente;
- nenhum log real de cliente estiver no repositório/tag/archive;
- o export comprovar delimitação de ambos os logs e limite de tamanho;
- o teste de UI provar que pan/remount não rouba foco;
- License Worker executar sua suíte sem erro de runtime;
- os gates de release forem executados no SHA da tag;
- os bloqueadores de segurança da auditoria-base tiverem plano de risco explícito — uma
  correção de performance não equivale a hardening geral do sistema.

## 7. Conclusão

**NO-GO para `v0.1.140` no commit `f65e97b`.**

A versão melhora a arquitetura de performance e corrige de forma adequada o RNG do
token e a preservação do papel do agente. Porém, as promessas centrais das release notes
não correspondem ao caminho efetivo em três pontos: Windows não usa o spill,
Frontend/QA não recebem o browser pelo ramo comum e o diagnóstico não contém somente o
período gravado. Somados ao arquivo real de cliente dentro da tag e à ausência de smoke
Windows, esses problemas impedem uma publicação responsável.
