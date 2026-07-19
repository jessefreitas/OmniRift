# Auditoria de performance, usabilidade e fluidez — OmniRift 0.1.141

**Data:** 19 de julho de 2026  
**Versão auditada:** `0.1.141`  
**Commit/tag auditado:** `1e1998a` / `v0.1.141`  
**Base de comparação:** `v0.1.140`  
**Escopo principal:** canvas, navegação entre agentes, React Flow, Zustand, terminais xterm, floors/projetos, animações, acessibilidade, build frontend, testes e gates de qualidade  
**Tipo:** revisão estática abrangente, análise de complexidade ciclomática, execução de gates e medição controlada em build de produção

> Este relatório complementa `docs/2026-07-19-auditoria-completa.md` e
> `docs/2026-07-19-revisao-release-v0.1.140.md`. Ele não substitui nem declara
> resolvidos os achados de segurança anteriores que não foram modificados nesta versão.

---

## 1. Veredito executivo

O OmniRift já possui várias proteções de desempenho corretas: terminais restaurados ficam
dormentes, o polling de processos é compartilhado, o xterm reduz trabalho quando está fora
do viewport, o histórico visual foi limitado, o foco automático foi removido do reattach,
o canvas ativo tem virtualização e as arestas não ficam animando em estado ocioso.

Essas melhorias diminuem CPU, memória e disputa de foco. Contudo, ainda há seis causas
estruturais capazes de explicar a sensação de canvas travado ou pesado ao “passear entre os
agentes”:

1. cada evento de movimento ou resize de nó grava imediatamente no Zustand, percorre floors
   e nós, recria arrays e volta a transformar todos os nós do floor em nós do React Flow;
2. todos os floors de todos os projetos permanecem montados, inclusive os invisíveis;
3. um único agente cujo primeiro spawn falhe pode manter a virtualização do floor inteiro
   desligada indefinidamente;
4. o conteúdo de agentes e terminais bloqueia os eventos do canvas, enquanto a ajuda ensina
   somente “arraste o fundo vazio”; num canvas denso, o usuário fica sem área segura para pan.
5. cada xterm montado tenta obter seu próprio contexto WebGL, sem o orçamento global sugerido
   pelo código; sob pressão, vários contextos caem e os terminais migram para o renderer DOM.
6. o “Montar” representa ondas no plano, mas faz eager-spawn de todos os terminais; o limite
   simultâneo do Orquestrador não protege esse caminho e 11 processos podem nascer juntos.

### Decisão

**NO-GO para anunciar ou aprovar a próxima versão como uma release de “canvas fluido”.**

A versão 0.1.141 pode ser tratada como uma release corretiva de backend/empacotamento, mas não
como solução para fluidez. Antes de uma release com essa promessa, os itens `PERF-141-001`,
`PERF-141-002`, `PERF-141-003`, `UX-141-004`, `PERF-141-015` e `PERF-141-017` devem ser
corrigidos e medidos em WebKitGTK e WebView2 reais.

### Scorecard

| Dimensão | Avaliação | Motivo principal |
|---|---:|---|
| Eficiência em repouso | Boa | polls compartilhados, terminais dormentes e animações ociosas reduzidas |
| Drag/resize com muitos nós | Fraca | mutação global e reconstrução O(n) a cada evento de ponteiro |
| Troca de floors/projetos | Fraca a regular | todos os floors e views continuam montados |
| Pan e zoom com mouse | Regular | funciona no fundo, mas é bloqueado sobre o conteúdo dos agentes |
| Trackpad | Fraca | scroll faz zoom; não há contrato natural de pan por dois dedos |
| Foco de terminal | Boa com ressalvas | reattach não foca; alguns caminhos ainda chamam `fit(true)` |
| Movimento e acessibilidade | Fraca | nenhuma política `prefers-reduced-motion`; intro bloqueante e controles sem nome |
| FailProof da interface | Regular | ErrorBoundary e watchdog existem, mas o watchdog não enxerga jank comum |
| Confiança de regressão | Fraca | não há suíte renderizada de UI nem benchmark de gesto nos dois WebViews |

---

## 2. O sistema compreendido

O canvas visível é implementado diretamente no desktop app com React Flow. O pacote
`packages/canvas-engine`, apesar de declarar React Flow e Pixi.js, ainda é um placeholder e
não é importado pelo frontend. Logo, a movimentação atual é DOM/SVG/React Flow; a presença de
Pixi.js no monorepo não significa que o canvas em produção tenha composição Pixi/GPU.

O fluxo relevante é:

```text
ponteiro / touchpad
  → React Flow controlado
  → FloorCanvas.onNodesChange
  → canvas-store.updateNodePosition/updateNodeSize
  → novo array de parallels + novo floor + novo array de nodes
  → seletores React/Zustand notificam Canvas e FloorCanvas
  → sort + map de todos os nós do floor
  → reconciliação React Flow + componentes de nó
  → paint/composite do WebView
```

No ciclo de vida dos floors:

```text
Canvas
  ├── FloorCanvas ativo             → visível + virtualização condicional
  ├── FloorCanvas inativo A         → display:none, mas montado e sem virtualização
  ├── FloorCanvas inativo B         → display:none, mas montado e sem virtualização
  └── FloorCanvas de outro projeto  → display:none, mas montado e sem virtualização
```

A justificativa registrada no próprio código é preservar o xterm que o OrchestratorDock
reloca no DOM e não perder estado visual de iframes e sketches. É uma dependência real, mas
faz o custo de memória e montagem crescer com o workspace inteiro, não apenas com o que está
na tela.

---

## 3. O que mudou desde a 0.1.140

O intervalo `v0.1.140..v0.1.141` contém correções importantes:

- o spill de system prompt longo no Windows passou a ser chamado pelo fluxo real;
- o quoting de `cmd.exe` e a delimitação do `omnirift.log` foram endurecidos;
- um diagnóstico real de cliente foi removido do repositório e a pasta foi ignorada;
- foi criada uma baseline de ESLint, Clippy e rustfmt;
- o release macOS ganhou assinatura/notarização condicionais e correções de empacotamento;
- a landing page passou a explicar melhor o diálogo real do Gatekeeper.

Não houve mudança material no caminho `Canvas` → `FloorCanvas` → `canvas-store`, em
`TerminalNode`, `AgentNode` ou nos gestos do React Flow. Portanto:

- o bloqueador Windows da revisão 0.1.140 foi corrigido e possui cobertura Rust;
- as melhorias anteriores de snapshot/foco do terminal permanecem válidas;
- o problema de fluidez do canvas não foi resolvido pela 0.1.141;
- a baseline de qualidade existe, mas não está ligada a nenhum workflow de CI.

---

## 4. Metodologia e limites da evidência

### 4.1 Cobertura

- 977 arquivos versionados no snapshot;
- 292 arquivos sob desktop/canvas-engine/terminal-node;
- leitura dirigida de renderização, store, terminal, agentes, gestos, foco, persistência,
  animações, feature flags, acessibilidade, CI e release;
- comparação de commits entre 0.1.140 e 0.1.141;
- complexidade ciclomática heurística em TypeScript/TSX;
- build de produção e inspeção de chunks;
- ESLint, testes Rust, Clippy e rustfmt;
- ensaio isolado de renderização em Chrome com APIs Tauri simuladas.

### 4.2 Medições válidas

- `npm run build --workspace=apps/desktop`: passou em 13,06 s;
- 3.950 módulos foram transformados;
- `cargo test`: 690 testes passaram, nenhum falhou e 1 foi ignorado;
- em uma página de produção isolada com 20 notas, o loop ocioso ficou próximo de 16,7 ms
  por frame e o heap JS reportado ficou em aproximadamente 10,38 MB;
- nessa mesma cena sintética, uma inspeção DOM encontrou 208 botões renderizados, dos quais
  62 não tinham texto, `title`, `aria-label` ou `aria-labelledby`; 36 desses estavam ocultos
  apenas por opacidade e continuavam no fluxo de foco.

Os números da cena de 20 notas comprovam apenas que o idle simples não está em loop e ajudam
a localizar problemas semânticos. Eles não representam Tauri, xterm, PTYs, agentes ativos,
WebKitGTK ou WebView2.

### 4.3 Resultados descartados

Um ensaio em Vite/dev com terminais artificiais produziu avisos do React Flow do tipo “node
not initialized”; o volume de console amplificou a latência. O número de frame desse ensaio
foi descartado.

A injeção de pan/drag por CDP headless não reproduziu de forma confiável o gesto nativo do
React Flow e também não foi usada como evidência de release. O teste obrigatório continua
sendo no aplicativo Tauri empacotado, com mouse e trackpad, em WebKitGTK e WebView2.

### 4.4 Diagnósticos reais recebidos após a análise inicial

Foram incorporados dois diagnósticos da versão 0.1.141, gerados às 16:50:48 e 16:54:21 no
Linux. Ambos estavam com o modo debug desligado, mas continham os eventos do watchdog e avisos
do renderer.

| Janela | Spawns Claude | MAIN-BLOCK | Soma registrada | Maior pausa | WebGL loss | Callbacks órfãos |
|---|---:|---:|---:|---:|---:|---:|
| 16:50 | 11 | 9 | 8.178 ms | 1.851 ms | 1 | 8 |
| 16:54 | 0 | 6 | 3.871 ms | 878 ms | 5 | 0 |
| Total | 11 | 15 | 12.049 ms | 1.851 ms | 6 | 8 |

Na primeira janela, 11 PTYs Claude foram iniciados em aproximadamente 22 segundos. O contador
subiu de 1 para 11 terminais vivos e os bloqueios chegaram a 1,85 s. Na segunda janela não
houve novo spawn, o contador permaneceu em 11 e ainda ocorreram seis bloqueios de 260–878 ms.
Isso mostra que o problema não se limita ao custo transitório de criação dos processos.

As cinco perdas de contexto WebGL da segunda janela ocorreram em grupos. Como o handler dispõe
o addon após a perda, o padrão é compatível com várias instâncias de terminal perdendo seus
contextos e migrando para o renderer DOM. O log sozinho não identifica a função que ocupou a
main thread, portanto a causalidade exata ainda requer trace. A combinação de quantidade de
terminais, context loss e fallback é, contudo, uma evidência muito mais forte que o ensaio
sintético descartado.

Os oito avisos de callback Tauri ausente dizem explicitamente que o WebView foi recarregado
enquanto operações assíncronas ainda estavam em voo. São mais provavelmente consequência da
tentativa de recuperar a interface do que causa original do travamento.

Rastreabilidade dos arquivos analisados:

- SHA-256 `30e669f474696a8ea2bd3fa0989ca3d66caa68b8968757cbf0538dbec9c525b8`;
- SHA-256 `aad854d30e0bdce5e20ddffaba86cd3173f2bb041353a3d457448d91177f77f5`.

---

## 5. Achados priorizados

| ID | Severidade | Achado | Confiança |
|---|---:|---|---:|
| PERF-141-001 | Alta | drag/resize grava estado global e reconstrói o floor em cada evento | Confirmado |
| PERF-141-002 | Alta | floors invisíveis continuam totalmente montados | Confirmado |
| PERF-141-003 | Alta | falha de primeiro spawn pode desabilitar virtualização para sempre | Confirmado |
| UX-141-004 | Alta | canvas denso aprisiona pan/zoom sobre agentes e terminais | Confirmado |
| MOT-141-005 | Alta | intro experimental é default e bloqueia entrada, sem redução de movimento | Confirmado |
| UX-141-006 | Média/Alta | navegação por teclado e nomes acessíveis são incompletos | Confirmado |
| PERF-141-007 | Média/Alta | bundle inicial e chunks pesados pioram cold start e troca de recursos | Confirmado pelo build |
| QLT-141-008 | Média/Alta | passivo de lint/Clippy/formatação não é bloqueado pela CI | Confirmado |
| PERF-141-009 | Média/Alta | não existe gate de frame/gesto e o watchdog ignora jank abaixo de 250 ms | Confirmado |
| MOT-141-010 | Média | animações de câmera são fixas, não canceláveis e ignoram reduced motion | Confirmado |
| PERF-141-011 | Média | resize/drag de painéis causa setState por mousemove/pointermove | Confirmado |
| ARCH-141-012 | Média | canvas-engine/Pixi documentado não participa do produto atual | Confirmado |
| UX-141-013 | Média | confirmação destrutiva não implementa semântica e ciclo de foco de dialog | Confirmado |
| UX-141-014 | Baixa/Média | menu de contexto nativo é desligado globalmente | Confirmado |
| PERF-141-015 | Alta | contextos WebGL por terminal não têm limite e caem em cascata | Confirmado em diagnóstico real |
| PRIV-141-016 | Média | diagnóstico exportado fica `0664`, legível por outros usuários locais | Confirmado no filesystem |
| PERF-141-017 | Alta | “Montar” ignora ondas como admission control e inicia todos os PTYs | Confirmado em código e diagnóstico |

---

## 6. Detalhamento dos achados críticos e altos

### PERF-141-001 — hot path global em cada frame de drag/resize

**Evidência:**

- `apps/desktop/src/components/FloorCanvas.tsx:150-168` transforma novamente todos os nós
  com `sort` e `map` quando a referência do floor muda;
- `FloorCanvas.tsx:197-213` chama `updateNodePosition` ou `updateNodeSize` para cada mudança;
- `apps/desktop/src/store/canvas-store.ts:1130-1144` procura o floor e o nó e recria o array
  de nós e o array de parallels a cada evento;
- `apps/desktop/src/components/Canvas.tsx:28-56` assina `parallels` inteiro, de modo que uma
  mudança de posição também re-renderiza o contêiner global e seus overlays.

**Impacto:** o custo por amostra de ponteiro cresce com a quantidade de floors e nós. Em
60/120 Hz, a interface pode receber mais eventos do que consegue reconciliar. O atraso se
acumula, o ponteiro fica à frente do nó e o usuário percebe “peso”, saltos ou travamento.

**Correção recomendada:**

1. manter posição e tamanho transitórios no estado interno do React Flow durante o gesto;
2. persistir no Zustand apenas em `onNodeDragStop` e no fim do resize;
3. se outras views precisarem de posição ao vivo, coalescer no máximo uma escrita por
   `requestAnimationFrame` e usar uma ação batch para seleção múltipla;
4. fazer `Canvas` assinar somente IDs/estado necessário, com referências estáveis;
5. normalizar nós por ID ou manter cache incremental de `rfNodes`, evitando `sort/map` total;
6. medir commits React e frame time antes e depois.

**Critério de aceite:** com 200 nós e 300 edges no floor, drag contínuo por 60 s deve manter
pointer-to-paint p95 até 20 ms, p99 até 33 ms, zero long task acima de 50 ms, posição final
correta e nenhum erro no console.

### PERF-141-002 — todos os floors invisíveis permanecem montados

**Evidência:** `Canvas.tsx:3-14` documenta explicitamente a dependência e `Canvas.tsx:41-56`
renderiza um `FloorCanvas` para cada floor, usando apenas `display:none`. Já
`FloorCanvas.tsx:407-416` liga `onlyRenderVisibleElements` somente no floor ativo.

**Impacto:** terminais, AgentNodes, iframes, tldraws, listeners, stores e buffers de views
invisíveis permanecem vivos. O custo cresce com todos os projetos/floors abertos. Uma troca
de floor pode também revelar várias views que precisam recalcular layout ao mesmo tempo.

**Correção recomendada:**

- separar sessão backend de view frontend de forma completa;
- dar ao OrchestratorDock uma segunda view xterm anexável, sem relocar o DOM de outro floor;
- serializar/restaurar estado visual necessário de portal e sketch;
- desmontar floors inativos ou manter um cache limitado, por exemplo ativo + anterior;
- congelar iframe/Canvas/WebGL de floors mantidos em cache;
- definir política explícita de descarte por pressão de memória.

**Critério de aceite:** após 20 alternâncias entre 10 floors, heap e RSS devem retornar a uma
faixa de até 10% do estado aquecido; troca de floor quente até 150 ms e fria até 500 ms; não
deve haver perda de sessão, scrollback, portal ou sketch.

### PERF-141-003 — agente que não nasce mantém virtualização desligada

**Evidência:**

- `FloorCanvas.tsx:130-134` define `hasUnbornAgents` se qualquer agente não possui
  `spawnedOnce`;
- `FloorCanvas.tsx:416` desliga a virtualização de todo o floor nessa condição;
- `apps/desktop/src/components/nodes/AgentNode.tsx:1008-1014` marca `spawnedOnce` somente
  depois de `acpSpawn` concluir com sucesso; o `catch` apenas registra erro e status morto.

**Cenário de falha:** um provider ausente, configuração inválida ou spawn que falha deixa
`spawnedOnce=false`. Como o nó morto continua no floor, todos os nós permanecem montados.
Quanto maior o workspace, maior o custo causado justamente por uma falha que deveria degradar
de forma localizada.

**Correção recomendada:** substituir `spawnedOnce` por um estado explícito de bootstrap,
separando `never-attempted`, `starting`, `ready` e `failed`. A virtualização deve depender de
“tentativa inicial despachada”, não de sucesso. O bootstrap de agentes fora da tela deve ser
orquestrado fora do mount visual, com timeout, cancelamento e retry visível.

**Critério de aceite:** criar 100 agentes, forçar 1 spawn a falhar e verificar que a
virtualização volta a ficar ativa; apenas o agente falho mostra erro/retry e os demais nós fora
do viewport são desmontados.

### UX-141-004 — pan fica preso em canvas denso

**Evidência:**

- `FloorCanvas.tsx:422-428` usa pan por drag no pane, zoom por scroll, desliga pan por scroll
  e reserva Shift para seleção;
- `TerminalNode.tsx:895-901` aplica `nowheel` e interrompe `pointerdown` no xterm;
- `AgentNode.tsx:1475-1480` aplica `nodrag nowheel` e interrompe `pointerdown` na conversa;
- `help-content.ts:39-43` e `help-content.ts:1048-1058` ensinam apenas “arraste o fundo” e
  “scroll para zoom”; não documentam Space+drag, botão do meio ou modo mão.

**Impacto:** quando cards cobrem a tela, iniciar o gesto sobre o conteúdo não move o canvas.
Com trackpad, o gesto de dois dedos tende a virar zoom em vez de pan. Isso corresponde ao
sintoma visual e ao relato de não conseguir passear entre os agentes, mesmo que o frame rate
esteja aceitável.

**Contrato de interação recomendado:**

| Gesto | Resultado |
|---|---|
| arrastar fundo com botão esquerdo | pan ou seleção, conforme ferramenta ativa |
| Space + arrastar em qualquer ponto | pan temporário, inclusive sobre terminal/agente |
| botão do meio + arrastar em qualquer ponto | pan |
| trackpad com dois dedos | pan |
| Ctrl/Cmd + scroll | zoom centrado no ponteiro |
| scroll dentro do xterm | scroll do terminal, exceto em modo mão/Space |
| Escape | cancela gesto, conexão, câmera ou modal atual |

Adicionar modo “mão”, cursor visual, dica na primeira ocorrência e ajuda atualizada. O handler
do xterm deve bloquear apenas a interação que realmente pertence ao terminal, preservando os
modificadores globais de navegação.

**Critério de aceite:** pan deve iniciar sobre pane, cabeçalho, corpo do agente e xterm usando
Space ou botão do meio; trackpad deve fazer pan sem zoom acidental; o terminal deve continuar
recebendo seleção de texto, scroll e teclado normalmente.

### MOT-141-005 — intro de boot bloqueante e sem reduced motion

**Evidência:**

- `apps/desktop/src/lib/feature-flags.ts:188-195` marca a intro como experimental, diz que
  deveria ficar `false` no release, mas mantém `default:true`;
- `BootIntro.tsx:8-37` contém rotações e pulsos infinitos;
- `BootIntro.tsx:52-80` espera 1,5 s, executa probes sequenciais com atraso artificial de
  380 ms e pode aguardar a voz por até 6 s antes de fechar;
- não existe uso de `prefers-reduced-motion` no código do desktop.

**Impacto:** o canvas real já está montado, mas fica coberto até múltiplas ações do usuário.
Em máquinas lentas, o boot aparenta travamento; para pessoas sensíveis a movimento, as
animações são contínuas e não há opt-out automático do sistema operacional.

**Correção recomendada:** default `false` em release; probes em paralelo e não bloqueantes;
entrada por uma única ação; botão “Pular”, Escape e timeout curto; nunca esperar TTS para
liberar o canvas; CSS e Canvas 2D respeitando `prefers-reduced-motion: reduce`.

### PERF-141-015 — contextos WebGL sem orçamento e fallback em cascata

**Evidência de código:**

- `apps/desktop/src/hooks/useTerminalSession.ts:206-239` cria um `WebglAddon` para toda view
  montada quando `terminal-webgl` está ligado;
- `useTerminalSession.ts:100-101` declara `webglSlotRef` como vaga do orçamento de WebGL, mas
  essa referência não é usada em nenhum outro lugar e não existe contador/limite global;
- `feature-flags.ts:53-58` deixa WebGL ligado por padrão;
- floors inativos continuam montados e podem conservar suas views/contextos;
- ao perder o contexto, o handler dispõe o WebGL e chama `term.refresh` de todas as linhas no
  renderer DOM (`useTerminalSession.ts:217-233`).

**Evidência de execução:** seis avisos `webgl context not restored; firing onContextLoss`, sendo
cinco na janela sem qualquer novo spawn. No mesmo período, 11 terminais estavam vivos e a main
thread sofreu bloqueios repetidos de até 878 ms. Na janela anterior, durante o burst de criação,
o maior bloqueio foi 1.851 ms.

**Interpretação:** o navegador/WebKit possui limites e pressão de memória para contextos GPU.
Cada xterm competir por um contexto pode expulsar outros. Quando vários caem, a aplicação faz
redraw completo e passa a sustentar mais terminais no renderer DOM, mais caro. A proteção atual
evita tela preta e crash, mas não evita a degradação de desempenho em cascata.

**Correção recomendada:**

1. criar um pool global pequeno de contextos WebGL, inicialmente 2–4, configurável por
   plataforma e validado por benchmark;
2. conceder vaga somente a xterms realmente visíveis; floor oculto ou nó fora do viewport
   deve liberar a vaga;
3. promover o terminal focado e aplicar LRU aos demais;
4. após context loss, colocar cooldown global e não criar outro contexto imediatamente;
5. escalonar `term.refresh` em rAF/idle em vez de redesenhar vários terminais no mesmo tick;
6. registrar localmente contadores `views-montadas`, `xterms-visíveis`, `webgl-ativos`,
   `webgl-loss` e `dom-fallback`, sem conteúdo de terminal;
7. oferecer modo seguro automático: após duas perdas em uma janela curta, desativar WebGL
   para a sessão e avisar o usuário uma única vez.

**Critério de aceite:** com 12 terminais em dois floors, contextos ativos nunca excedem o
budget; alternar floors por 10 minutos não produz context loss, long task acima de 50 ms nem
terminal preto; fallback de um terminal não provoca redraw simultâneo dos demais.

### PERF-141-017 — ondas visuais não limitam processos simultâneos

**Evidência:**

- `PipelineArchitectModal.tsx:237-353` percorre todos os agentes do plano e chama
  `addTerminal`, independentemente da onda;
- a onda muda posição, persona e conexões, mas não o ciclo de vida do processo;
- `canvas-store.ts:549-621` aplica limite de licença e um guard de burst, insere o nó e chama
  `ensurePtySessions([node])` em fire-and-forget;
- o guard aceita até 20 terminais em uma janela de 4 s, portanto não é controle de capacidade;
- `terminal-sessions.ts:77-98` consulta `ptyList` e faz spawn, mas cada `addTerminal` inicia uma
  chamada independente; não existe fila global ou single-flight de admissão;
- o teto `max_agents` padrão 5 do backend protege spawns feitos pelas tools MCP do
  Orquestrador, não o “Montar” do frontend;
- o diagnóstico real registrou 11 processos Claude iniciados em cerca de 22 s.

**Impacto:** ondas posteriores que deveriam aguardar dependências já consomem processo,
memória, xterm, polling e potencial contexto WebGL. O sistema paga o custo de todo o time no
início, e a própria abertura dos agentes compete com a interação do usuário.

**Correção recomendada:**

1. criar todos os cards/nós, mas deixar ondas futuras em estado `queued`/`dormant`;
2. iniciar apenas a primeira onda e respeitar um cap global único para MCP, Montar, routines e
   criação manual em lote;
3. usar uma fila backend-owned com no máximo 1–2 processos em estado `starting` ao mesmo tempo;
4. avançar a próxima onda por conclusão/entrega da dependência ou ação explícita do usuário;
5. tornar `ensurePtySessions` single-flight e capaz de receber o lote inteiro, evitando N
   chamadas concorrentes de `ptyList`;
6. exibir `na fila`, `iniciando`, `ativo`, `aguardando dependência` e `falhou`, com cancelamento;
7. adaptar o cap à memória disponível, mantendo um limite manual previsível.

**Critério de aceite:** ao montar 12 agentes em quatro ondas com cap 3, no máximo três ficam
vivos e no máximo dois iniciam simultaneamente; ondas seguintes não possuem PTY/xterm/WebGL até
serem liberadas; durante a montagem não ocorre `MAIN-BLOCK` acima de 50 ms.

### PRIV-141-016 — export diagnóstico com permissão `0664`

Os dois arquivos recebidos foram criados com modo `0664`. Isso permite leitura por qualquer
usuário local e escrita por membros do grupo. O conteúdo observado inclui diretório de projeto,
IDs de sessão, horários e topologia de carga. O recorte pela última marca funcionou — o segundo
`omnirift.log` veio vazio depois da marca, um sinal positivo da correção da 0.1.141 — mas a
proteção em repouso continua incompleta.

`apps/desktop/src-tauri/src/commands/diagnostics.rs:157-169` usa `File::create` e herda a umask,
sem `OpenOptionsExt::mode(0o600)` nem `set_permissions` posterior.

**Correção:** criar arquivo temporário owner-only, escrever e sincronizar, renomear de forma
atômica e verificar em teste Unix que o modo final é `0600`. No Windows, manter ACL restrita ao
usuário. A UI deve continuar permitindo inspeção antes do envio.

---

## 7. Usabilidade, acessibilidade e movimento

### UX-141-006 — controles sem nome e tabs não semânticas

O componente `Tooltip` exibe o rótulo visual por hover, mas não conecta o tooltip ao botão
com `aria-describedby` nem fornece nome acessível. Na cena controlada, 62 botões não tinham
nome detectável. A contagem é específica da cena, porém confirma um padrão de implementação.

`ProjectTabs.tsx:39-75` usa `div onClick` para as abas, sem `role=tab`, `tabIndex`,
`aria-selected` ou navegação por setas. O botão de fechar aparece apenas por `group-hover`,
sem equivalente `focus-within`. Isso impede operação previsível por teclado.

**Correção:** botão/Tab semântico, `tablist`, roving tabindex, setas Home/End, foco visível,
`aria-selected`, nomes acessíveis nos ícones e vínculo real entre trigger e tooltip.

### MOT-141-010 — câmera sem cancelamento e sem preferência de movimento

`apps/desktop/src/lib/canvas-focus.ts:27-31`, `35-67` e `95-102` usam delays e animações fixas
de 400 ms. Não há coordenador que cancele uma animação quando chega novo pedido. Cliques
rápidos em agentes/floors podem disputar a câmera ou terminar em um destino obsoleto.

**Correção:** controlador `last-request-wins`, cancelamento de timers anteriores, duração
proporcional à distância com teto, movimento instantâneo em reduced motion e indicação clara
do destino focado.

### UX-141-013 — confirmação destrutiva incompleta

`FloorCanvas.tsx:445-477` cria um overlay visual, mas não fornece `role="dialog"`,
`aria-modal`, título associado, trap de foco, Escape ou restauração do foco anterior. O botão
“Não” recebe autofocus, o que é um bom default destrutivo, mas Tab ainda pode escapar para a
interface atrás do modal.

### UX-141-014 — menu de contexto globalmente removido

`apps/desktop/src/main.tsx:27-28` cancela o menu nativo em todo o documento. O terminal possui
menu próprio, mas inputs, notas, links e áreas sem menu alternativo perdem uma convenção do
sistema operacional. Limitar a supressão às superfícies que oferecem substituto melhora
descoberta e acessibilidade.

---

## 8. Performance complementar

### PERF-141-007 — bundles pesados

O build passou, mas o Vite alertou sobre chunks acima de 500 kB:

| Chunk observado | Minificado | Gzip aproximado |
|---|---:|---:|
| bundle inicial `index` | 1.786,94 kB | 557,78 kB |
| `toggleHighContrast` | 3.668,13 kB | 953,93 kB |
| `SketchNode` | 1.722,88 kB | 521,07 kB |
| worker PDF | 1.375,83 kB | não informado no resumo |
| `PdfNode` | 338,53 kB | 101,20 kB |

Também existe import dinâmico ineficaz de `DiffViewerModal`: um caminho lazy convive com
import estático por `ReviewNode`. O resultado afeta cold start, parse/compile de JavaScript e
picos ao abrir recursos pesados.

**Correção:** separar primitivas pequenas dos modais, manter Monaco/tldraw/PDF fora do caminho
inicial, revisar dependências duplicadas e estabelecer budget inicial de até 350–400 kB gzip.

### PERF-141-011 — painéis atualizam React em cada evento

`Sidebar.tsx:798-812`, `ConstructorPanel.tsx:22-55` e `lib/use-draggable.ts:24-70` chamam
`setState` diretamente em `mousemove`/`pointermove`. O problema é menor que o drag do React
Flow, mas pode competir pelo main thread quando painel, terminal e canvas estão ativos.

**Correção:** pointer capture consistente, posição transitória via `transform`, coalescimento
em `requestAnimationFrame`, commit final no `pointerup` e cleanup em `pointercancel`/blur.

### ARCH-141-012 — Pixi não compõe o canvas atual

`packages/canvas-engine/src/CanvasEngine.tsx` ainda contém “Phase 1 placeholder” e não há import
dele no desktop. Pixi.js está declarado, mas não participa da renderização. Isso não é um bug
isolado; é uma divergência entre arquitetura declarada e produto real que pode gerar decisões
de performance baseadas numa aceleração inexistente.

Não se recomenda migrar tudo para Pixi antes de corrigir o hot path de estado. Primeiro deve
ser eliminado o trabalho React desnecessário; depois, um benchmark decide se edges/background
ou LOD extremo merecem uma camada Pixi.

---

## 9. Controles positivos já presentes

Os seguintes mecanismos devem ser preservados durante qualquer refatoração:

- terminais restaurados começam `dormant` e acordam por intenção do usuário
  (`canvas-store.ts:1265-1268`);
- `TerminalNode` possui ErrorBoundary próprio, contendo falha no nó em vez de derrubar o canvas;
- `useProcInfo` usa um único poll batch de 5 s e reaproveita referências imutáveis;
- xterm limita a view a 1.000 linhas e tenta WebGL com degradação para renderer normal;
- output oculto passa para background com backlog limitado e reidratação por snapshot;
- `IntersectionObserver` e LOD abaixo de zoom 0,35 reduzem paint do terminal/conversa;
- foco do xterm é opt-in em `fit(true)`, não efeito automático de toda medição;
- autosave marca dirty de forma barata e serializa somente no tick de 5 minutos;
- edge em idle fica estática; `dashdraw` só é ligado no estado `sending`;
- React Flow oferece minimap pannable/zoomable, limite de zoom, threshold de drag e raio de
  conexão ampliado;
- existe fallback global para crash e watchdog local de main thread, coerente com a política
  de não usar telemetria.

---

## 10. Complexidade ciclomática

A análise de TSX é heurística: JSX e hooks podem confundir o parser. Os números abaixo servem
para priorizar decomposição e testes, não como prova isolada de defeito.

| Hotspot | CCN aproximada | Risco |
|---|---:|---|
| `FloorCanvasImpl` | 41 | mistura render, conexão, delete, gestos, virtualização e modal |
| `FloorCanvas.onConnect` | 21 | muitos tipos de edge e efeitos backend |
| `FloorCanvas.onConnectEnd` | 17 | menu, alças e múltiplos caminhos de cancelamento |
| `FloorCanvas.onNodeDragStop` | 12 | busca/reparent e geometria |
| `AgentNode.handleReady` | 48 | handshake, estado e capacidades concentrados |
| `AgentNode.rehydrate` | 17 | replay e deduplicação de sessão |
| callback interno de restore do workspace | 15 | migração de muitos tipos de nó |
| effect de attach/spawn do terminal | 17 | corrida attach/spawn/snapshot/foco |

Faixa proposta para código novo:

- até 10: aceitável;
- 11–20: exige testes por ramo e justificativa;
- acima de 20: refatorar antes de ampliar comportamento.

`FloorCanvasImpl` deve ser dividido em, no mínimo, adaptador de nós, controlador de gestos,
controlador de conexões, controlador de delete e camada visual. Para agentes/terminais, usar
máquina de estados explícita reduz combinações inválidas e melhora FailProof.

---

## 11. Gates executados e dívida de qualidade

| Gate | Resultado | Observação |
|---|---|---|
| build desktop (`tsc -b` + Vite) | PASS | 13,06 s; chunks grandes |
| testes Rust | PASS | 690 pass, 0 fail, 1 ignored |
| ESLint desktop | FAIL | 106 problemas: 89 erros e 17 warnings |
| Clippy | WARN | 86 diagnósticos |
| rustfmt check | FAIL | 869 blocos `Diff in` |
| baseline registrada | 106 / 86 / 891 | fmt atual melhor que a baseline |
| baseline na CI | AUSENTE | nenhum workflow chama `quality-baseline.sh` |
| testes de UI renderizada | AUSENTES | sem Vitest + Testing Library/axe |
| testes e2e de gestos Tauri | AUSENTES | sem matriz WebKitGTK/WebView2 |
| gate de frame time | AUSENTE | nenhum budget p95/p99 no release |

O ESLint sinaliza padrões diretamente relacionados a fluidez: setState dentro de effects,
refs acessadas durante render e componentes cujo memoization foi rejeitado pelo React
Compiler. A baseline é útil para impedir piora, mas hoje é apenas manual; sem workflow, não é
um gate.

**Correção:** chamar `scripts/quality-baseline.sh` em Forgejo e GitHub, falhar se ferramentas
estiverem ausentes no ambiente de CI, travar toda melhoria atualizando a baseline e criar uma
meta gradual até zero. PRs que alterem `FloorCanvas`, store, AgentNode ou terminal devem rodar
testes de UI e um benchmark de interação.

---

## 12. Observabilidade FailProof da fluidez

O watchdog atual usa timer de 500 ms e só registra atraso a partir de 250 ms
(`debug-log.ts:54-102`). Ele detecta congelamentos graves, mas não percebe frames de 20–100 ms,
que já tornam drag e pan desagradáveis.

Adicionar observabilidade local, sem telemetria:

- amostrador rAF opt-in no modo diagnóstico, com p50/p95/p99;
- `PerformanceObserver` quando disponível e fallback por rAF/timer no WebKitGTK;
- contexto de interação: pan, drag, resize, zoom, troca de floor, reattach;
- número de floors, nós, edges, xterms visíveis e views mantidas em cache;
- contagem de commits React e duração do commit em build de profiling;
- exportação somente após consentimento, mantendo a política “no telemetry”.

O diagnóstico deve ser limitado, redigido, owner-only e não conter conteúdo de terminal,
prompt, caminho sensível ou segredo.

---

## 13. Plano de correção recomendado

### P0 — antes de chamar a experiência de fluida

1. Criar estado transitório local para drag/resize e persistir somente no fim do gesto.
2. Desacoplar virtualização de `spawnedOnce` bem-sucedido.
3. Implementar Space-pan e middle-pan sobre qualquer conteúdo e contrato correto de trackpad.
4. Implementar orçamento global de WebGL por visibilidade e failover escalonado.
5. Fazer as ondas controlarem o ciclo de vida e unificar o limite global de agentes.
6. Desligar `boot-intro` por padrão na release e respeitar reduced motion.
7. Criar diagnóstico com permissão `0600`/ACL do usuário.
8. Criar benchmark reprodutível no Tauri empacotado para WebKitGTK e WebView2.

### P1 — sprint seguinte

1. Desacoplar OrchestratorDock da view xterm do floor e desmontar floors inativos.
2. Introduzir cache limitado de floors e política de pressão de memória.
3. Dividir `FloorCanvasImpl` e formalizar máquina de estados de interação.
4. Corrigir tabs, tooltips, modais e controles icon-only para teclado/leitor de tela.
5. Implementar coordenador cancelável de câmera.
6. Ligar baseline e testes renderizados à CI.
7. Fazer code splitting real de Monaco, tldraw, PDF e diff.

### P2 — evolução e escala

1. Normalizar o store e aplicar seletores finos por nó/floor.
2. Avaliar Pixi apenas com benchmark A/B para edges/background/LOD extremo.
3. Coalescer resize/drag dos painéis flutuantes.
4. Adicionar teste de vazamento após ciclos longos de floor, fullscreen e dock.
5. Medir 1, 20, 100, 200 e 1.000 nós, com e sem terminais ativos.

---

## 14. Matriz obrigatória de validação

| Plataforma | Entrada | Cenas mínimas |
|---|---|---|
| Linux WebKitGTK | mouse | pan/drag/zoom, 20 e 200 nós, 12 terminais |
| Linux WebKitGTK | trackpad | dois dedos, pinch/Ctrl-scroll, xterm sob ponteiro |
| Windows WebView2 | mouse | mesmos cenários + sessão Claude real |
| Windows WebView2 | trackpad | mesmos gestos e escalas de DPI 100/150/200% |
| ambas | teclado | Space-pan, Escape, tabs, dialog, foco do terminal |
| ambas | reduced motion | boot, câmera, pulse, edge e transições |
| ambas | multi-floor | 10 floors, 20 ciclos, 1 spawn falhando |

### Budgets propostos de release

- pointer-to-paint: p95 ≤ 20 ms e p99 ≤ 33 ms;
- zero long task > 50 ms durante pan, zoom e drag;
- zero erro/warning de React Flow durante a interação;
- troca de floor: ≤ 150 ms aquecido, ≤ 500 ms frio;
- crescimento de heap/RSS após 20 ciclos: ≤ 10% sobre o estado aquecido;
- nenhum foco roubado durante pan/remount;
- posição, seleção e conexão finais corretas após cancelamento ou soltura;
- bundle inicial: alvo ≤ 350–400 kB gzip;
- todos os gestos principais operáveis com teclado e com nomes acessíveis;
- reduced motion elimina animações contínuas e deslocamentos não essenciais.

Esses budgets são metas propostas; a auditoria atual não os declara atingidos.

---

## 15. Checklist de release

Uma release de fluidez só deve ser aprovada quando:

- [ ] `PERF-141-001` possui comparação antes/depois em build empacotada;
- [ ] falha de spawn não desliga virtualização;
- [ ] pan funciona sobre terminal/agente com Space e botão do meio;
- [ ] trackpad faz pan natural e zoom deliberado;
- [ ] floors inativos têm custo limitado e mensurado;
- [ ] contextos WebGL ativos respeitam um budget e floors ocultos não retêm vaga;
- [ ] context loss isolado não causa cascata de DOM refresh nem terminal preto;
- [ ] “Montar” respeita ondas/cap e não inicia o time inteiro de uma vez;
- [ ] existe fila global de spawn com estado e cancelamento visíveis;
- [ ] boot intro não bloqueia release e reduced motion é respeitado;
- [ ] nenhum componente rouba foco durante navegação;
- [ ] testes DOM afirmam o que renderiza, não apenas o Zustand;
- [ ] CI executa baseline, testes renderizados e benchmark mínimo;
- [ ] WebKitGTK e WebView2 passam na mesma matriz;
- [ ] bundle e memória ficam dentro do budget;
- [ ] diagnóstico exportado é owner-only (`0600`/ACL equivalente);
- [ ] não há novos erros de lint/Clippy/rustfmt;
- [ ] os achados de segurança anteriores continuam rastreados separadamente.

---

## 16. Conclusão

O travamento relatado não aponta para uma única falha. A correção anterior do reattach de
scrollback e do foco automático removeu um gargalo real, mas o canvas ainda combina custo
global por movimento, retenção de floors invisíveis, virtualização dependente do sucesso de
spawn, contextos WebGL sem limite, eager-spawn de ondas futuras e gestos que deixam de
funcionar sobre a maior parte de uma tela densa. Os diagnósticos reais confirmaram 15
bloqueios, 12,049 s de atraso registrado e seis perdas de contexto durante duas janelas curtas.

A sequência mais segura é corrigir primeiro o hot path e o contrato de navegação, depois
desmontar floors inativos e só então decidir, por benchmark, se Pixi é necessário. Sem essa
ordem e sem medição no Tauri real, otimizações visuais isoladas podem melhorar a aparência sem
eliminar a causa do atraso.

**Resultado final:** a 0.1.141 melhora confiabilidade de Windows, privacidade e distribuição,
mas mantém pendências altas de performance e usabilidade no canvas. Não há evidência suficiente
para declarar “movimentos fluidos” no estado atual.
