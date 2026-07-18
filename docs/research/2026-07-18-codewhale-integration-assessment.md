# CodeWhale → runtime estruturado para modelos abertos no OmniRift

**Data:** 2026-07-18  
**Objeto auditado:** [`Hmbown/CodeWhale`](https://github.com/Hmbown/CodeWhale)  
**Snapshot de código:** `74afd81` (`main`, versão de workspace `0.9.1`)  
**Última release estável observada:** [`v0.9.0`](https://github.com/Hmbown/CodeWhale/releases/tag/v0.9.0)  
**Licença:** [MIT](https://github.com/Hmbown/CodeWhale/blob/74afd81/LICENSE)  
**Tipo de análise:** documentação, código Rust, testes, CI, pacote JavaScript e issues abertas  
**Fora do escopo:** benchmark de qualidade dos modelos e smoke test pago com provedores reais

---

## 0. Resumo executivo

O CodeWhale é um runtime local de agentes de programação escrito em Rust. Ele
oferece TUI, suporte a múltiplos provedores, ferramentas de shell e arquivos,
persistência de conversas, aprovações, automações, subagentes e uma API HTTP/SSE
com modelo estruturado de `Thread → Turn → Item`.

Para o OmniRift, o valor principal não está na TUI nem no sistema completo de
Fleet. Está em uma peça mais específica:

> usar o CodeWhale como motor estruturado para agentes baseados em modelos
> abertos, mantendo o OmniRift como dono da interface, memória, credenciais,
> Floors, permissões e orquestração.

### Decisão

**Adotar por integração de processo, de forma experimental e atrás de feature
flag. Não fazer fork e não incorporar os crates ao workspace neste momento.**

A integração recomendada usa o Runtime API HTTP/SSE, supervisionado pelo
backend Tauri. O frontend não conversa diretamente com o daemon. O backend
normaliza os eventos do CodeWhale para um contrato interno comum a ACP e aos
demais runtimes.

### Por que vale a pena

- entrega um runtime de agente pronto para DeepSeek, GLM, MiniMax, OpenRouter,
  Ollama e endpoints OpenAI-compatible;
- possui conversas duráveis, streaming retomável, interrupção, steering,
  aprovações e entrada adicional do usuário;
- possui ferramentas dinâmicas, que permitem ao OmniRift expor memória,
  terminais e Floors sem ensinar o CodeWhale sobre a arquitetura interna;
- reduz bastante o trabalho necessário para a Fase 7, “Ombro / LLM local”;
- a fronteira por processo permite atualização, rollback e remoção sem acoplar
  o monorepo ao ritmo de mudanças do projeto externo.

### O que impede adoção direta em produção

1. No snapshot auditado, o caminho Linux chamado de Landlock é apenas um
   marcador quando `prefer_bwrap` está desativado. O comando original é
   executado sem isolamento de filesystem, apesar do tipo reportado ser
   `LinuxLandlock`.
2. O backend padrão de segredos é um arquivo JSON local, não o keychain do SO.
3. Roteamento automático pode alterar o provedor efetivo e ampliar a fronteira
   de envio de contexto.
4. Plugins ainda não têm uma separação suficientemente forte entre descoberta,
   confiança e habilitação.
5. Há risco de concorrência quando processos diferentes usam o mesmo diretório
   de estado e workspace.
6. O SDK JavaScript publicado é estreito e está atrás da API Rust atual.

Esses pontos não anulam a integração. Eles definem como ela deve ser feita.

### Avaliação rápida

| Dimensão | Nota | Leitura |
|---|---:|---|
| Aderência à Fase 7 | 9/10 | Resolve exatamente o runtime para modelos abertos |
| Runtime API | 8/10 | Boa base, durável e retomável; ainda evolui rapidamente |
| Ferramentas dinâmicas | 9/10 | Melhor ponto de extensão para o OmniRift |
| Integração por processo | 8,5/10 | Isolável, reversível e compatível com Tauri |
| SDK JavaScript | 4/10 | Não deve ser a fundação da integração |
| Sandbox Linux padrão | 4/10 | Estado reportado não corresponde a isolamento efetivo |
| Segurança com hardening do OmniRift | 7,5/10 | Viável com bwrap obrigatório, isolamento e canários |
| Maturidade geral | 7/10 | Código e testes extensos, mas superfície grande e churn alto |

---

## 1. Pergunta respondida

Esta análise responde:

> O CodeWhale faz algo que o OmniRift ainda não faz, e é seguro e sustentável
> incorporá-lo ao produto?

Resposta curta:

- **sim**, ele preenche a lacuna de runtime de agente para modelos abertos;
- **não**, não deve assumir o papel de cérebro, canvas ou orquestrador central;
- **sim**, deve ser integrado como daemon local supervisionado;
- **não**, seus defaults de sandbox, segredos, routing e plugins não devem ser
  aceitos sem uma política explícita do OmniRift.

---

## 2. O que o CodeWhale realmente é

O projeto nasceu como um coding agent centrado em DeepSeek e cresceu para uma
plataforma multi-provider. Hoje sua superfície inclui:

- aplicação TUI;
- CLI de configuração e autenticação;
- runtime HTTP/SSE;
- modo ACP;
- servidor MCP;
- ferramentas locais de shell e arquivos;
- persistência SQLite de threads, turns, eventos e tarefas;
- memória e skills próprias;
- plugins e servidores MCP;
- automações e rotinas;
- Fleet, lanes e subagentes;
- execução local, SSH e caminhos de deploy remoto.

Isso o torna maior que uma biblioteca de chamada de LLM. O componente relevante
para nós é seu **agent runtime**: seleção de modelo, loop de ferramentas,
streaming, persistência e controle de execução.

### O que ele não deve virar dentro do OmniRift

O CodeWhale não deve ser:

- o owner do canvas;
- o banco canônico de configuração do OmniRift;
- o cofre primário de credenciais;
- o sistema de memória do produto;
- o gerenciador de worktrees/Floors;
- o scheduler global de Routines;
- a camada de permissões compartilhada por todos os runtimes;
- uma dependência Rust linkada diretamente ao processo Tauri.

Essas responsabilidades já pertencem ao domínio do OmniRift ou precisam ser
uniformes entre Claude, Codex, Hermes, shell e runtimes futuros.

---

## 3. Snapshot e sinais de maturidade

No commit auditado:

- workspace versionado como `0.9.1`, à frente da release estável `v0.9.0`;
- 18 crates Rust sob `crates/`;
- aproximadamente 551 mil linhas em arquivos `.rs`, incluindo testes e código
  gerado/manualmente repetitivo;
- mais de 8,5 mil anotações de teste Rust encontradas;
- CI com checks de build, testes, formato, lint e múltiplas plataformas;
- documentação extensa para Runtime API, sandbox, MCP, Fleet, memória e
  configuração;
- churn alto e alguns módulos muito grandes, reconhecido pelo próprio projeto
  em seu [RFC de decomposição](https://github.com/Hmbown/CodeWhale/blob/74afd81/docs/rfcs/FILE_DECOMPOSITION_0_9_0.md).

Essas métricas mostram investimento real, não estabilidade absoluta. Um projeto
pode ter muitos testes e ainda possuir um gap crítico entre documentação e
execução, como ocorre no caminho padrão de sandbox Linux.

### Leitura de manutenção

O repositório tem energia de desenvolvimento alta e uma superfície grande.
Isso favorece evolução rápida, mas aumenta três custos para integradores:

1. contratos podem mudar entre releases próximas;
2. funcionalidades propostas e implementadas convivem na documentação;
3. nomes legados `deepseek` ainda aparecem em variáveis, serviços e tipos.

Logo, o OmniRift deve fixar uma versão conhecida, validar capabilities no
startup e traduzir o protocolo externo para tipos próprios.

---

## 4. Arquitetura executável relevante

O entrypoint canônico documentado é:

```text
codewhale app-server --http
        │
        ├── dispatcher CLI `codewhale`
        │
        ├── delega ao binário irmão `codewhale-tui`
        │
        └── inicia o Runtime API HTTP/SSE em 127.0.0.1:7878
```

`codewhale serve --http` permanece como alias de compatibilidade. A delegação
ao binário irmão pode ser vista no
[`crates/cli/src/lib.rs`](https://github.com/Hmbown/CodeWhale/blob/74afd81/crates/cli/src/lib.rs),
e o contrato do servidor está em
[`docs/RUNTIME_API.md`](https://github.com/Hmbown/CodeWhale/blob/74afd81/docs/RUNTIME_API.md).

### Consequência de empacotamento

Não basta copiar somente o dispatcher `codewhale` sem validar a presença e a
resolução do executável irmão. O bundle precisa tratar os binários necessários
como uma unidade e executar um self-test após instalação.

### Bind e autenticação

O Runtime API:

- usa `127.0.0.1:7878` por padrão;
- aceita porta configurável;
- protege `/v1/*` com token;
- aceita `Authorization: Bearer <token>`;
- pode operar sem auth somente com flag insegura e bind loopback;
- não oferece TLS ou isolamento multiusuário.

Para o OmniRift, mesmo no loopback, o token é obrigatório. A porta deve ser
alocada dinamicamente, e o token deve ser aleatório, efêmero e conhecido apenas
pelo backend Tauri.

---

## 5. Contrato do Runtime API

O modelo é durável e adequado a uma UI rica:

```text
Thread
  └── Turn
       ├── user_message
       ├── agent_message
       ├── tool_call
       ├── command_execution
       ├── file_change
       ├── context_compaction
       ├── status
       └── error
```

Eventos são append-only e possuem `seq` monotônico, permitindo replay após
reload da UI ou reconexão do SSE.

### Operações centrais

| Necessidade do OmniRift | Contrato CodeWhale |
|---|---|
| Verificar processo | `GET /health` e `GET /v1/runtime/info` |
| Criar sessão estruturada | `POST /v1/threads` |
| Listar/restaurar sessões | `GET /v1/threads`, `GET /v1/threads/{id}` |
| Enviar prompt | `POST /v1/threads/{id}/turns` |
| Acompanhar execução | `GET /v1/threads/{id}/events?since_seq=<n>` |
| Corrigir direção durante o turno | `POST .../turns/{turn_id}/steer` |
| Interromper | `POST .../turns/{turn_id}/interrupt` |
| Compactar contexto | `POST /v1/threads/{id}/compact` |
| Resolver aprovação | `POST /v1/approvals/{approval_id}` |
| Responder pergunta | `POST /v1/user-input/{thread_id}/{input_id}` |
| Entregar resultado de tool externa | `POST .../tool-calls/{call_id}/result` |
| Consultar consumo | `GET /v1/usage` |

O catálogo completo está no
[`RUNTIME_API.md`](https://github.com/Hmbown/CodeWhale/blob/74afd81/docs/RUNTIME_API.md).

### Envelope SSE

Exemplo reduzido:

```json
{
  "schema_version": 1,
  "seq": 42,
  "event": "item.delta",
  "kind": "item.delta",
  "thread_id": "thr_1234abcd",
  "turn_id": "turn_5678efgh",
  "item_id": "item_90ab12cd",
  "timestamp": "2026-02-11T20:18:49.123Z",
  "payload": {
    "kind": "agent_message",
    "delta": "texto parcial"
  }
}
```

Eventos importantes para a UI:

- `thread.started`;
- `turn.started`, `turn.lifecycle`, `turn.completed`;
- `item.started`, `item.delta`, `item.completed`, `item.failed`;
- `approval.required`, `approval.decided`, `approval.timeout`;
- `user_input.required`, `user_input.answered`, `user_input.canceled`;
- `tool_call.requested`;
- `sandbox.denied`.

### Semântica de restart

Após restart, registros `queued` ou `in_progress` são marcados como
`interrupted`. Isso é honesto e suficiente para uma primeira integração. O
OmniRift deve exibir a interrupção; não deve fingir retomada automática de uma
execução que perdeu o processo.

### Regra para reconexão

O backend deve persistir o maior `seq` aceito por thread e reconectar com
`since_seq=<last_seq>`. Eventos duplicados devem ser ignorados pelo par
`(thread_id, seq)`. O frontend recebe eventos já normalizados e idempotentes.

---

## 6. Ferramentas dinâmicas: a ponte ideal

Este é o recurso mais estratégico para o OmniRift.

Ao criar uma thread ou iniciar um turn, o cliente pode fornecer ferramentas
dinâmicas com nome, descrição e JSON Schema. Quando o modelo chama uma delas, o
runtime publica `tool_call.requested`, aguarda o consumidor e recebe o resultado
por HTTP.

O contrato tipado está em
[`crates/protocol/src/runtime/mod.rs`](https://github.com/Hmbown/CodeWhale/blob/74afd81/crates/protocol/src/runtime/mod.rs),
a execução em
[`runtime_threads.rs`](https://github.com/Hmbown/CodeWhale/blob/74afd81/crates/tui/src/runtime_threads.rs),
e o endpoint de retorno em
[`runtime_api.rs`](https://github.com/Hmbown/CodeWhale/blob/74afd81/crates/tui/src/runtime_api.rs).

### Registro de tools

```json
{
  "model": "modelo-fixado-pelo-omnirift",
  "dynamic_tools": [
    {
      "namespace": "omnirift",
      "name": "memory_search",
      "description": "Busca memórias relevantes no provider ativo do OmniRift.",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": { "type": "string" },
          "limit": { "type": "integer", "minimum": 1, "maximum": 20 }
        },
        "required": ["query"],
        "additionalProperties": false
      }
    }
  ]
}
```

### Fluxo

```text
Modelo no CodeWhale
        │
        │ tool_call.requested
        ▼
CodeWhaleManager no Tauri
        │
        ├── valida nome + schema + tamanho
        ├── aplica política de permissão OmniRift
        ├── executa comando Rust interno
        └── registra receipt local
        │
        │ POST .../tool-calls/{call_id}/result
        ▼
CodeWhale continua o turn
```

Exemplo de resultado:

```json
{
  "success": true,
  "content": [
    {
      "type": "input_text",
      "text": "resultado serializado e limitado pelo OmniRift"
    }
  ]
}
```

### Tools iniciais recomendadas

| Tool | Backend OmniRift | Política |
|---|---|---|
| `memory_search` | provider ativo de memória | leitura, limite de resultados |
| `memory_write` | provider ativo de memória | aprovação explícita na primeira fase |
| `floor_status` | módulo `floors/` | somente leitura |
| `terminal_send` | PTY manager | aprovação e allowlist de sessão |
| `canvas_context` | snapshot reduzido do canvas | somente leitura, sem dump global |

### Tools que não devem existir inicialmente

- execução arbitrária de comando Tauri;
- acesso genérico ao banco SQLite;
- leitura indiscriminada de tokens ou configurações;
- “call any MCP tool” sem allowlist;
- mutação genérica do canvas;
- criação de novos agentes sem orçamento e autoridade explícitos.

Ferramentas dinâmicas não são uma fuga da política de segurança. Elas são um
novo ponto de entrada e precisam passar pelo mesmo sistema de aprovação do
OmniRift.

---

## 7. Divisão correta de responsabilidades

| Domínio | CodeWhale | OmniRift | Decisão |
|---|---|---|---|
| Loop de agente | Executa | Supervisiona | CodeWhale |
| Provider/model | Chama API | Escolhe e autoriza | Seleção fixada pelo OmniRift |
| Chave do provider | Consome em runtime | Guarda no keychain | OmniRift é owner |
| Threads/turns internos | Persiste | Mapeia para nodes | CodeWhale, com referência local |
| Canvas e conexões | Não conhece | Persiste/renderiza | OmniRift |
| Memória | Possui implementação própria | Provider plugável | Desabilitar memória CodeWhale |
| Worktrees | Possui lanes/workspaces | Possui Floors | Passar `cwd` do Floor |
| Aprovações | Suspende e publica evento | Decide e apresenta UI | OmniRift |
| Routines | Possui automations | Scheduler do produto | Não integrar inicialmente |
| Fleet/subagentes | Possui sistema próprio | Orquestra nodes | Não integrar inicialmente |
| Plugins/skills | Descobre e carrega | Precisa governança uniforme | Desabilitar inicialmente |
| Telemetria | Pode evoluir externamente | Política no-telemetry | Bloquear e auditar rede |

### Invariante arquitetural

O CodeWhale é um **executor**, não o control plane.

Se uma futura feature fizer o CodeWhale escolher sozinho credencial, memória,
workspace, provedor, plugin ou agente filho, ela atravessou essa fronteira e
precisa de uma decisão arquitetural explícita.

---

## 8. Arquitetura recomendada no OmniRift

```text
┌──────────────────────────────── Frontend ────────────────────────────────┐
│ AgentNode                                                               │
│   └── StructuredAgentTransport                                          │
│         ├── AcpTransport                                                │
│         └── CodeWhaleTransport ── Tauri commands/events                 │
└───────────────────────────────────┬──────────────────────────────────────┘
                                    │
┌──────────────────────────────── Backend Rust ────────────────────────────┐
│ CodeWhaleManager                                                        │
│   ├── process supervisor                                                │
│   ├── runtime HTTP client                                               │
│   ├── SSE replay/reconnect                                              │
│   ├── event normalizer                                                  │
│   ├── dynamic tool dispatcher                                           │
│   └── health/capability checks                                          │
│                                                                         │
│ Keychain ── chave selecionada       MemoryRegistry / PTY / Floors        │
└──────────────────┬─────────────────────────────┬─────────────────────────┘
                   │ loopback + token           │ tool results
                   ▼                            │
          CodeWhale daemon por projeto/Floor ◄──┘
                   │
                   ├── thread A → node A
                   ├── thread B → node B
                   └── state.db isolado
```

### Granularidade de processo

Recomendação inicial:

- um daemon por projeto aberto ou Floor ativo;
- várias threads no mesmo daemon;
- `CODEWHALE_HOME` exclusivo por instância lógica;
- nunca dois daemons apontando para o mesmo `CODEWHALE_HOME`;
- nunca compartilhar o mesmo banco de estado entre instâncias do OmniRift.

Um processo por node aumenta consumo e complexidade. Um processo global para
todos os projetos mistura estado, workspace e blast radius. O escopo por
projeto/Floor é o melhor compromisso inicial.

### Layout backend sugerido

```text
apps/desktop/src-tauri/src/codewhale/
├── mod.rs
├── manager.rs          # lifecycle e registry de instâncias
├── process.rs          # spawn, kill, logs e health
├── runtime_client.rs   # HTTP/SSE tipado
├── events.rs           # protocolo externo → evento interno
├── tools.rs            # dispatcher de dynamic tools
├── config.rs           # config hermética gerada
└── types.rs
```

Os comandos Tauri podem permanecer próximos do módulo ou em
`commands/codewhale.rs`, conforme a organização adotada pelo backend na fase de
implementação.

### Abstração frontend sugerida

Hoje o projeto possui unions rígidas de provider em:

- `apps/desktop/src/types/canvas.ts`;
- `apps/desktop/src/store/canvas-store.ts`;
- `apps/desktop/src/components/Sidebar.tsx`;
- fallback de provider em `apps/desktop/src-tauri/src/acp/mod.rs`.

Adicionar apenas mais um literal e mais branches ao
`apps/desktop/src/components/nodes/AgentNode.tsx` criaria acoplamento crescente.
O corte recomendado é por transporte/capability:

```ts
type StructuredAgentEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_started"; callId: string; name: string; input: unknown }
  | { type: "tool_completed"; callId: string; output: unknown }
  | { type: "approval_required"; approval: AgentApproval }
  | { type: "user_input_required"; request: AgentInputRequest }
  | { type: "usage"; usage: AgentUsage }
  | { type: "status"; status: AgentRunStatus }
  | { type: "error"; message: string; recoverable: boolean };

interface StructuredAgentTransport {
  start(input: StartAgentInput): Promise<AgentSessionRef>;
  prompt(sessionId: string, prompt: string): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  approve(approvalId: string, decision: "allow" | "deny"): Promise<void>;
  events(sessionId: string): AsyncIterable<StructuredAgentEvent>;
}
```

ACP e CodeWhale implementam essa interface sem forçar o componente visual a
entender detalhes de JSON-RPC, SSE ou endpoints.

---

## 9. Segurança: achados e requisitos

### 9.1 Sandbox Linux: bloqueador P0

A documentação descreve Landlock e seccomp como camadas de segurança. Porém, no
snapshot auditado, `SandboxManager::prepare_landlock` faz isto:

1. se `prefer_bwrap=true` e `/usr/bin/bwrap` existe, envolve o comando com
   bubblewrap;
2. caso contrário, devolve o comando original;
3. adiciona apenas `DEEPSEEK_SANDBOX=landlock`;
4. registra o tipo como `LinuxLandlock`.

O próprio comentário do código diz “marker only”. Evidência:
[`sandbox/mod.rs`](https://github.com/Hmbown/CodeWhale/blob/74afd81/crates/tui/src/sandbox/mod.rs#L482-L517).

Há uma implementação de seccomp no repositório, mas a auditoria não encontrou
um chamador de produção que instale o filtro no caminho normal de shell.

#### Impacto

A UI pode acreditar que uma execução está sandboxed quando ela não está. Isso é
pior que um modo explicitamente “sem sandbox”, porque altera a decisão do
usuário com informação incorreta.

#### Regra do OmniRift

- Linux: exigir `bubblewrap` e `prefer_bwrap=true` para o modo seguro;
- se bwrap não estiver disponível ou o canário falhar, exibir
  `unsandboxed`/`degraded`, nunca `Landlock ativo`;
- permissões do CodeWhale não substituem a política do OmniRift;
- não habilitar `auto_approve` por padrão.

#### Canários obrigatórios

Antes de liberar execução, um self-test deve provar que:

- escrita fora do workspace é negada;
- leitura de um arquivo sentinela fora do workspace é negada;
- escrita dentro do workspace permitido funciona;
- processo filho não escapa da política esperada;
- o estado reportado à UI corresponde ao resultado do teste.

O gate é comportamental. Detectar a existência de `/usr/bin/bwrap` não basta.

### 9.2 Segredos

O crate de segredos declara:

- backend padrão: arquivo;
- backend `system`/`keyring`: opt-in por `CODEWHALE_SECRET_BACKEND`;
- arquivo sob `~/.codewhale/secrets/`;
- verificação de modo `0600` em Unix.

Evidência:
[`crates/secrets/src/lib.rs`](https://github.com/Hmbown/CodeWhale/blob/74afd81/crates/secrets/src/lib.rs).

#### Regra do OmniRift

- nunca executar `codewhale auth set` como fluxo normal do produto;
- manter o token no keychain já implementado na Fase 8;
- selecionar uma única credencial por instância;
- injetá-la apenas no ambiente do daemon;
- não persistir a chave no `CODEWHALE_HOME`;
- mascarar env e argumentos em logs e diagnósticos;
- apagar o ambiente de spawn após a criação do processo quando aplicável;
- usar token Runtime distinto da chave do provider.

O shell filho do CodeWhale possui sanitização própria de ambiente, o que ajuda,
mas isso precisa ser coberto por teste de regressão com os nomes de chaves que o
OmniRift suporta.

### 9.3 Roteamento entre provedores

O roteamento automático amplia a fronteira de confiança: o usuário pode escolher
um provider e o runtime consultar ou executar por outro. A discussão está
registrada na [issue #4411](https://github.com/Hmbown/CodeWhale/issues/4411).

#### Regra do OmniRift

- desabilitar auto-routing;
- enviar provider e model exatos;
- validar `effective_provider` e `effective_model` retornados no turn;
- interromper e sinalizar mismatch;
- nunca disponibilizar ao daemon chaves de providers não selecionados.

Essa última regra transforma um erro de routing em falha fechada, não em envio
silencioso a outro serviço.

### 9.4 Plugins e skills

A descoberta automática de código/extensões precisa separar:

- encontrado;
- confiável;
- habilitado;
- autorizado neste workspace.

Esse gap aparece na [issue #4399](https://github.com/Hmbown/CodeWhale/issues/4399).

#### Regra do OmniRift

Plugins, skills pessoais, MCP automático e constitutions externas ficam
desabilitados no primeiro release. Uma fase futura poderá importar itens por
allowlist, com origem e hash visíveis.

### 9.5 Concorrência e ownership de estado

A [issue #4416](https://github.com/Hmbown/CodeWhale/issues/4416) descreve risco
de múltiplos processos disputando o mesmo workspace/estado.

#### Regra do OmniRift

- lock exclusivo por `CODEWHALE_HOME`;
- PID e metadados da instância persistidos pelo manager;
- um owner por banco;
- shutdown gracioso seguido de kill da árvore somente após timeout;
- recuperação que verifica processo órfão antes de iniciar outro.

### 9.6 Runtime API

- bind somente em loopback;
- token aleatório de pelo menos 256 bits;
- token nunca enviado ao frontend;
- porta aleatória ou reservada pelo manager;
- CORS não é a fronteira de segurança principal;
- sem `--insecure-no-auth` no produto;
- health público não deve conter segredos;
- logs do daemon passam por redaction antes de chegar à UI.

### 9.7 Política no-telemetry

Como o OmniRift declara “sem telemetria”, cada versão embutida do CodeWhale deve
passar por:

- auditoria de endpoints de rede;
- smoke test com proxy/monitor de egress;
- confirmação de que somente o provider escolhido é contatado;
- bloqueio de update check e serviços remotos não necessários;
- registro local de destinos efetivos sem conteúdo sensível.

Não basta confiar que a versão anterior não enviava telemetria.

---

## 10. Configuração hermética

Cada instância deve receber um home exclusivo, por exemplo:

```text
<app-data>/codewhale/
└── <project-id>/
    └── <floor-id-or-default>/
        ├── state.db
        ├── config.toml
        ├── logs/
        └── instance.json
```

Variáveis mínimas conceituais:

```text
CODEWHALE_HOME=<diretório isolado>
CODEWHALE_RUNTIME_TOKEN=<token efêmero>
CODEWHALE_SECRET_BACKEND=system  # somente se o runtime realmente usar o keychain
<PROVIDER_API_KEY>=<segredo selecionado>
```

Na estratégia preferida, o provider key é fornecido como variável de ambiente e
o fluxo de persistência de segredos do CodeWhale não é usado.

O arquivo de configuração deve ser gerado pelo OmniRift com:

- provider fixo;
- model fixo;
- auto-routing desligado;
- auto-approve desligado;
- memória própria desligada;
- plugins/skills/MCP automático desligados;
- bwrap preferido/obrigatório no Linux;
- workspace igual ao Floor selecionado;
- qualquer update check desligado.

Os nomes exatos das opções precisam ser validados contra a versão pinada no
momento da implementação; não se deve copiar um config de `main` para um binário
`v0.9.0` sem teste de parse.

---

## 11. SDK: construir um cliente Rust pequeno

O pacote `@codewhale/runtime-sdk` auditado está em versão `0.8.60` e cobre
principalmente helpers de Fleet. Algumas operações tipadas ainda apontam para
capabilities futuras e retornam erro explícito.

Portanto:

- não adicionar o SDK JavaScript ao frontend;
- não expor token e porta ao WebView;
- implementar no backend um cliente Rust pequeno com `reqwest` e SSE;
- tipar apenas os endpoints usados;
- preservar payload desconhecido para diagnósticos;
- validar `runtime_api_version` e `schema_version`;
- adicionar contract fixtures capturados da versão pinada.

Essa escolha também evita uma segunda cadeia de supply chain no frontend e
mantém a fronteira de rede no processo nativo.

---

## 12. Lifecycle e recuperação

### Startup

1. Resolver projeto e Floor.
2. Adquirir lock exclusivo do home isolado.
3. Resolver provider/model autorizados.
4. Ler chave do keychain.
5. Gerar token Runtime e porta.
6. Gerar configuração hermética.
7. Executar canários de sandbox quando necessário.
8. Spawn do daemon.
9. Aguardar `/health` com timeout.
10. Consultar `/v1/runtime/info`.
11. Validar versão e capabilities.
12. Só então criar/restaurar thread e conectar SSE.

### Operação

- armazenar `instance_id`, PID, versão, porta, project/floor e timestamps;
- mapear `node_id ↔ thread_id` no estado do OmniRift;
- manter cursor `last_seq` por thread;
- aplicar backoff com jitter em reconexões;
- limitar fila de eventos e tamanho de payload;
- cancelar tool calls pendentes quando o node for destruído;
- nunca resolver aprovação por ausência de resposta.

### Shutdown

1. Interromper turns ativos ou pedir confirmação conforme contexto.
2. Fechar subscriptions SSE.
3. Solicitar encerramento gracioso.
4. Aguardar timeout curto.
5. Encerrar a árvore do processo se necessário.
6. Liberar lock.
7. Preservar o home para retomada, salvo remoção explícita do usuário.

### Crash

- marcar node como `interrupted`, não `failed` genericamente;
- preservar transcript já persistido;
- oferecer “reiniciar runtime”;
- após restart, buscar snapshot da thread antes de reabrir SSE;
- não reenviar automaticamente o último prompt, evitando duplicar efeitos.

---

## 13. O que não fazer

- Não fazer fork no primeiro ciclo.
- Não copiar módulos internos do CodeWhale para o Tauri.
- Não linkar seus 18 crates ao workspace do OmniRift.
- Não permitir que o frontend acesse `127.0.0.1:7878` diretamente.
- Não guardar provider keys no SQLite do CodeWhale.
- Não aceitar `auto_approve=true` como conveniência de MVP.
- Não chamar sandbox de ativo com base apenas no nome reportado.
- Não habilitar auto-routing com mais de uma chave disponível.
- Não habilitar Fleet, lanes, automations, memória e plugins simultaneamente.
- Não duplicar Floors com o sistema de lanes do CodeWhale.
- Não duplicar OmniMemory com a memória interna do runtime.
- Não criar uma union fechada nova para cada provider/model suportado.
- Não depender de endpoints documentados como “proposed” ou “future”.
- Não atualizar automaticamente o binário sem rodar os contract tests.

---

## 14. Plano de integração

### Fase CW-0 — modo terminal

**Objetivo:** validar valor de produto com custo mínimo.

- detectar instalação do CodeWhale;
- permitir criar um terminal PTY com comando CodeWhale;
- usar cwd do Floor;
- documentar que esse modo é terminal e não possui integração estruturada;
- não injetar automaticamente todas as chaves.

**Estimativa:** cerca de 1 dia.

**Gate:** usuário consegue iniciar e remover o terminal sem deixar processo
órfão.

### Fase CW-1 — spike Runtime API

**Objetivo:** provar o contrato ponta a ponta sem redesenhar o AgentNode.

- pin de versão e checksum;
- supervisor de processo;
- token e porta efêmeros;
- health/runtime info;
- criar thread e turn;
- consumir SSE com replay;
- texto incremental, status, interrupt e erro;
- config hermética;
- provider/model fixos;
- canários de sandbox.

**Estimativa:** 3 a 5 dias.

**Gate:** uma app de teste/backend command executa uma conversa real, reconecta
sem duplicar eventos e falha fechada quando o sandbox requerido não funciona.

### Fase CW-2 — node estruturado

**Objetivo:** integrar o runtime ao canvas sem especializar excessivamente a UI.

- `StructuredAgentTransport`;
- tipos comuns de evento;
- provider registry extensível;
- render de tool calls, approvals, perguntas e usage;
- persistência `node_id ↔ thread_id`;
- restart e recovery;
- status de sandbox honesto.

**Estimativa:** 1 a 2 semanas.

**Gate:** testes de UI afirmam o DOM renderizado para streaming, aprovação,
interrupção e erro, conforme a convenção do projeto.

### Fase CW-3 — ferramentas OmniRift

**Objetivo:** conectar o runtime ao cérebro e ao canvas.

- dispatcher de dynamic tools;
- `memory_search` primeiro;
- schemas versionados;
- receipts;
- aprovação e limites;
- timeouts e cancelamento;
- testes contra replay e resultado tardio.

**Estimativa:** aproximadamente 1 semana para o primeiro conjunto seguro.

**Gate:** o modelo busca memória pelo provider ativo sem receber credenciais ou
acesso direto ao banco.

### Fase CW-4 — hardening e distribuição

**Objetivo:** tornar a integração suportável em release.

- bundle Linux e Windows;
- SBOM, licença e checksums;
- atualização manual/controlada;
- contract suite por versão;
- testes de egress;
- fault injection;
- limites de memória/CPU/eventos;
- matriz de suporte por SO;
- documentação de incidentes e rollback.

**Gate:** todos os critérios P0/P1 da próxima seção passam em CI ou em uma etapa
de release reproduzível.

---

## 15. Critérios de aceite

### P0 — obrigatórios antes de qualquer preview

- [ ] Versão do CodeWhale pinada por número e checksum.
- [ ] Daemon limitado a loopback.
- [ ] Runtime token obrigatório e invisível ao frontend.
- [ ] `CODEWHALE_HOME` isolado e com lock exclusivo.
- [ ] Provider/model exatos; auto-routing desligado.
- [ ] Somente uma chave de provider disponível ao daemon.
- [ ] `auto_approve=false`.
- [ ] Plugins, skills, MCP automático, Fleet e memória interna desligados.
- [ ] Canário prova isolamento efetivo ou UI declara modo sem sandbox.
- [ ] Processo e filhos são encerrados ao fechar/remover a instância.
- [ ] Logs não contêm provider key nem Runtime token.

### P1 — obrigatórios antes de release estável

- [ ] SSE reconecta por `since_seq` sem duplicação visual.
- [ ] Reload hidrata approvals e user inputs pendentes.
- [ ] Restart não reexecuta prompts automaticamente.
- [ ] Mismatch de provider/model falha fechado.
- [ ] Dynamic tools têm allowlist, schema, timeout e limite de resposta.
- [ ] Tool result tardio não é aplicado a outro turn.
- [ ] Testes de UI validam elementos renderizados.
- [ ] Contratos HTTP possuem fixtures da versão distribuída.
- [ ] Egress test confirma somente destinos autorizados.
- [ ] Licença MIT e notices acompanham o bundle.
- [ ] Windows exibe claramente ausência de isolamento de filesystem se esse
      continuar sendo o estado da versão pinada.

### P2 — evolução

- [ ] Cost/usage unificados com outros runtimes.
- [ ] Importação opt-in de skills com hash e provenance.
- [ ] Catálogo de capabilities por versão.
- [ ] Limites de orçamento por node/turn.
- [ ] Routines podem selecionar CodeWhale sem duplicar seu scheduler.
- [ ] Política uniforme de tool permissions entre ACP e CodeWhale.

---

## 16. Matriz de riscos

| Risco | Probabilidade | Impacto | Mitigação |
|---|---:|---:|---|
| Sandbox reporta proteção inexistente | Alta no snapshot | Crítico | bwrap obrigatório + canário + status honesto |
| Chave persistida em arquivo | Média | Alto | keychain OmniRift + env de processo + nunca usar auth set |
| Contexto enviado a provider inesperado | Média | Alto | pin provider/model + uma única chave + validar effective provider |
| Quebra de API entre releases | Alta | Médio/alto | pin, capabilities e contract tests |
| Dois daemons corrompem/disputam estado | Média | Alto | home isolado + lock + owner único |
| Plugin não confiável é carregado | Média | Alto | plugins/skills desabilitados |
| Processo órfão mantém shell ativo | Média | Alto | supervisor e kill de árvore |
| Evento SSE duplicado gera UI/efeito duplicado | Média | Médio | cursor monotônico e idempotência |
| Runtime acumula recursos | Média | Médio | limites, monitoramento local e reciclagem controlada |
| OmniRift duplica features do CodeWhale | Alta | Médio | manter fronteira executor/control plane |
| SDK diverge do servidor | Alta | Médio | cliente Rust próprio e pequeno |
| Bundle quebra resolução do binário irmão | Média | Médio | self-test pós-instalação |

---

## 17. ADR resumido

### Contexto

O OmniRift precisa executar agentes com modelos abertos e locais sem reconstruir
todo o loop de agente, persistência, streaming, tools e controle de turn.

### Decisão

Integrar uma versão pinada do CodeWhale como daemon local supervisionado pelo
Tauri, usando Runtime API HTTP/SSE e dynamic tools. Normalizar seus eventos para
um contrato interno compartilhável com ACP.

### Alternativas rejeitadas agora

**Fork do CodeWhale:** aumenta responsabilidade de manutenção e merge de uma
base muito grande antes de comprovar valor.

**Dependência Rust interna:** acopla releases, aumenta tempo de build e expõe
internals instáveis.

**Somente PTY para sempre:** simples, mas perde approvals estruturadas,
persistência, replay, usage e integração real com o canvas.

**Frontend chamando Runtime API:** vaza token/porta e mistura protocolo externo
com componentes React.

**Construir runtime próprio agora:** oferece controle máximo, porém repete muito
trabalho antes de validar a experiência de produto.

### Consequências

Positivas:

- acelera a Fase 7;
- preserva independência arquitetural;
- permite rollback removendo o daemon;
- cria uma abstração reutilizável para outros runtimes estruturados;
- dynamic tools conectam naturalmente a Fase 8.

Negativas:

- um processo adicional por projeto/Floor;
- contrato externo em evolução;
- necessidade de empacotar e atualizar binários Rust externos;
- hardening obrigatório acima dos defaults;
- testes de integração e egress entram no custo permanente do produto.

---

## 18. Recomendação final

O CodeWhale é bom para o OmniRift **se usado como motor substituível**.

Ele não deve ser adotado como plataforma inteira nem como nova fundação do
produto. O caminho de maior retorno é:

1. começar pelo spike do Runtime API;
2. criar uma abstração de transporte estruturado no AgentNode;
3. manter credenciais, memória, Floors e permissões no OmniRift;
4. usar dynamic tools para ligar o agente ao ecossistema interno;
5. bloquear release enquanto sandbox, routing, plugins e ownership de estado
   não estiverem controlados;
6. reavaliar após uma versão pinada completar a matriz P0/P1.

Em termos de produto, isso transforma o CodeWhale em um “ombro” para modelos
abertos sem transformar o OmniRift em uma skin de outro agente.

---

## 19. Referências

### CodeWhale

- [Repositório](https://github.com/Hmbown/CodeWhale)
- [Release v0.9.0](https://github.com/Hmbown/CodeWhale/releases/tag/v0.9.0)
- [Runtime API](https://github.com/Hmbown/CodeWhale/blob/74afd81/docs/RUNTIME_API.md)
- [Arquitetura](https://github.com/Hmbown/CodeWhale/blob/74afd81/docs/ARCHITECTURE.md)
- [Sandbox](https://github.com/Hmbown/CodeWhale/blob/74afd81/docs/SANDBOX.md)
- [Implementação do SandboxManager](https://github.com/Hmbown/CodeWhale/blob/74afd81/crates/tui/src/sandbox/mod.rs)
- [Crate de segredos](https://github.com/Hmbown/CodeWhale/blob/74afd81/crates/secrets/src/lib.rs)
- [Tipos de runtime e dynamic tools](https://github.com/Hmbown/CodeWhale/blob/74afd81/crates/protocol/src/runtime/mod.rs)
- [Runtime threads](https://github.com/Hmbown/CodeWhale/blob/74afd81/crates/tui/src/runtime_threads.rs)
- [Issue #4399 — confiança/habilitação de plugins](https://github.com/Hmbown/CodeWhale/issues/4399)
- [Issue #4411 — fronteira do auto-routing](https://github.com/Hmbown/CodeWhale/issues/4411)
- [Issue #4416 — ownership concorrente](https://github.com/Hmbown/CodeWhale/issues/4416)

### OmniRift

- `docs/superpowers/specs/2026-06-15-maestri-brain-interface-design.md`
- `docs/superpowers/plans/2026-06-15-fase1-memory-provider-backend.md`
- `apps/desktop/src/components/nodes/AgentNode.tsx`
- `apps/desktop/src-tauri/src/acp/mod.rs`
- `apps/desktop/src-tauri/src/memory/`
- `apps/desktop/src/lib/git-client.ts`
- `apps/desktop/src-tauri/src/commands/git.rs`

---

## Apêndice A — roteiro do spike técnico

Um spike é considerado conclusivo quando produz evidência para todos os itens:

1. checksum e `--version` do binário;
2. resolução correta do executável irmão;
3. config parseada sem fallback silencioso;
4. `runtime/info` com versão/capabilities esperadas;
5. criação de thread em cwd de um Floor descartável;
6. turn real com provider/model fixos;
7. replay SSE após desconexão forçada;
8. interrupt durante tool call;
9. approval allow e deny;
10. user input request e resposta;
11. dynamic tool `memory_search` falsa/in-memory;
12. resultado tardio e timeout;
13. crash e restart do daemon;
14. tentativa de leitura/escrita fora do sandbox;
15. inspeção de env recebido pelo shell filho;
16. inspeção de egress;
17. scan de logs por segredos;
18. remoção do node e ausência de processos órfãos.

O resultado deve ser guardado como fixture e relatório, não apenas demonstrado
manualmente.

## Apêndice B — política de compatibilidade proposta

| Estado | Comportamento do OmniRift |
|---|---|
| Binário ausente | Oferece instalação/documentação; não cria node estruturado |
| Versão não suportada | Bloqueia integração; terminal manual continua opcional |
| Capability ausente | Desabilita somente a feature correspondente |
| Schema SSE maior/desconhecido | Interrompe stream e preserva payload para diagnóstico |
| Sandbox degradado | Exige consentimento explícito ou bloqueia conforme política |
| Provider mismatch | Interrompe turn e mostra incidente |
| Runtime não saudável | Tenta restart limitado e oferece ação manual |
| State lock ocupado | Anexa ao owner conhecido ou falha; nunca abre segundo writer |
| Dynamic tool desconhecida | Retorna erro seguro; nunca faz dispatch genérico |

Essa política permite evolução gradual sem transformar qualquer incompatibilidade
em corrupção silenciosa ou ampliação de autoridade.
