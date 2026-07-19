# Auditoria completa de código, segurança, FailProof e complexidade — OmniRift

**Data do relatório:** 19 de julho de 2026  
**Base auditada:** commit 23ee5aa — versão 0.1.138  
**Projeto:** OmniRift  
**Escopo:** frontend React/TypeScript, aplicação Tauri/Rust, Workers Cloudflare, scripts, FailProof, dependências, CI e release  
**Tipo de auditoria:** revisão estática abrangente, execução local de gates e testes, análise de dependências e modelagem de ameaças

> Nota de rastreabilidade: a execução principal da auditoria terminou com o commit 23ee5aa e worktree limpo. Depois da auditoria foi detectada uma alteração local em apps/desktop/src-tauri/src/mcp/registry.rs. Essa alteração posterior não foi sobrescrita e não está coberta pelas conclusões deste documento.
>
> **Adendo pós-auditoria, 19 de julho de 2026:** após relato e evidência visual de travamento ao navegar entre agentes, foi analisado o caminho de virtualização/reattach dos terminais. O novo achado OR-PERF-002 documenta a causa e a correção local validada sobre a base 855c233.

---

## 1. Sumário executivo

O OmniRift compila, passa em todas as suítes Rust, nos testes puros do desktop, no Relay Worker e no subsistema FailProof. A arquitetura demonstra bons controles pontuais: E2EE móvel com nonces de OsRng, updater assinado, limites de frame no relay LAN, redator de logs, permissões 0600 para vários artefatos e uso predominante de queries parametrizadas.

Apesar disso, o sistema ainda não deve ser considerado endurecido para operar com repositórios, páginas, prompts ou modelos não confiáveis. Os riscos mais graves são:

1. Agentes Claude são iniciados com aprovação ignorada por padrão, enquanto o sandbox do host fica desligado e falha aberto.
2. A fronteira WebView → Tauri → sistema operacional oferece leitura global de arquivos e centenas de comandos IPC, com CSP desativada.
3. O serviço de licença permite abuso do beta, reativação de licenças past_due, autorreativação de dispositivos revogados e corrida no limite de seats.
4. Sidecars de produção são compilados do HEAD remoto, sem commit ou hash fixado, e depois entram nos instaladores assinados.
5. Há tokens persistidos em URLs Git, SSRF por redirects, autenticação local sem RNG criptográfico e ausência de controles de abuso no relay.

### Classificação geral

| Dimensão | Situação |
|---|---|
| Compilação e typecheck | Boa |
| Testes Rust | Boa |
| FailProof | Boa |
| Testes de UI renderizada | Ausentes |
| Segurança de agentes | Crítica |
| Fronteira WebView/Tauri | Alto risco |
| Serviço de licença | Alto risco |
| Supply chain | Alto risco |
| Dependências | Requer atualização imediata |
| Complexidade/manutenibilidade | Dívida alta em hotspots |
| Gates de CI | Incompletos |

### Recomendação de release

Não considerar a aplicação “segura por padrão” antes de corrigir, no mínimo:

- OR-SEC-001 — execução irrestrita dos agentes;
- OR-SEC-002 — fronteira WebView/Tauri;
- OR-SEC-003 a OR-SEC-006 — licenciamento;
- OR-SEC-010 — supply chain mutável;
- OR-SEC-008 — SSRF;
- OR-SEC-009 — geração de tokens.

---

## 2. Sistema compreendido

O OmniRift é um canvas desktop de orquestração de agentes e terminais:

~~~text
React 19 / WebView
  |
  | Tauri IPC — 252 comandos registrados
  v
Backend Rust
  ├── PTY manager e conexões entre agentes
  ├── ACP, Claude, Codex, Hermes e shell
  ├── SQLite e persistência do canvas
  ├── Git floors/worktrees
  ├── MCP, RPC local e OmniSwitch
  ├── memória Local / OmniMemory / Obsidian
  ├── OmniFS e snapshots
  └── relay móvel LAN/E2EE
        |
        ├── Cloudflare Relay Worker
        └── License Worker + D1 + Asaas
~~~

### Limites de confiança relevantes

1. **Conteúdo não confiável → agente:** código de repositórios, páginas capturadas, diffs e prompts podem conter prompt injection.
2. **Agente → host:** agentes têm shell, ferramentas MCP e acesso a arquivos.
3. **WebView → Rust:** o frontend consegue invocar comandos nativos e plugins Tauri.
4. **Rust → rede:** HTTP node, Playwright, providers LLM, Git e integrações externas.
5. **Cliente → Workers:** beta, licença, diagnóstico, checkout e relay são expostos publicamente.
6. **CI → artefato:** sidecars externos e dependências são incorporados à aplicação distribuída.

---

## 3. Escopo e metodologia

### 3.1 Código coberto

- 966 arquivos versionados no snapshot;
- aproximadamente 105 mil linhas de Rust, TypeScript, TSX, Python, JavaScript/MJS, Shell e SQL;
- 143 arquivos Rust;
- 179 arquivos TypeScript;
- 125 arquivos TSX;
- 33 arquivos Python;
- 13 arquivos JavaScript/MJS;
- 10 scripts Shell;
- schema do License Worker;
- workflows GitHub e Forgejo.

### 3.2 Técnicas aplicadas

- inventário de arquitetura e superfícies de ataque;
- leitura dirigida de comandos Tauri e limites de confiança;
- análise de fluxo de segredos;
- análise de execução de subprocessos;
- revisão do serviço de licença e do relay;
- análise FailProof e falha-aberto/falha-fechado;
- typecheck, build e testes;
- ESLint, Clippy, Rustfmt, Ruff e ShellCheck;
- Semgrep security-audit/secrets;
- npm audit e cargo-audit/RustSec;
- complexidade ciclomática com Lizard;
- inspeção de CI, release e supply chain.

### 3.3 Escala de severidade

| Severidade | Definição |
|---|---|
| Crítica | Pode levar a execução arbitrária, comprometimento amplo do host, fraude sistêmica ou supply-chain do release |
| Alta | Permite acesso indevido relevante, contorno de autorização, exfiltração de segredo ou indisponibilidade severa |
| Média | Requer pré-condição adicional, tem impacto limitado ou representa defesa em profundidade importante |
| Baixa | Problema de hardening, documentação, diagnóstico ou manutenção sem impacto imediato significativo |

### 3.4 Confiança dos achados

- **Confirmado:** consequência demonstrável diretamente pelo código ou por gate executado.
- **Alta confiança:** a configuração e o fluxo permitem o ataque; falta apenas uma PoC específica de plataforma.
- **Hipótese de hardening:** risco plausível que requer validação dinâmica antes de ser tratado como exploração confirmada.

---

## 4. Achados de segurança

## OR-SEC-001 — Agentes executam sem aprovação e sem sandbox por padrão

**Severidade:** Crítica  
**Confiança:** Confirmado

### Evidências

- apps/desktop/src/lib/agent-contract.ts:187-203
- apps/desktop/src/components/Sidebar.tsx:325-354
- apps/desktop/src-tauri/src/commands/constructor_chat.rs:28-50
- apps/desktop/src-tauri/src/sandbox.rs:13-18
- apps/desktop/src-tauri/src/sandbox.rs:30-48
- apps/desktop/src-tauri/src/sandbox.rs:54-95

Todo worker Claude recebe automaticamente:

- --dangerously-skip-permissions;
- uma denylist textual curta;
- acesso ao shell e a ferramentas MCP.

O sandbox de processo:

- fica Off se OMNIRIFT_SANDBOX não for exatamente workspace;
- falha aberto se bwrap não existir;
- não isola rede;
- monta .config, .npm, .cargo e .omnirift;
- esconde apenas .ssh, .aws e .gnupg;
- não protege CLIs remotos.

A denylist de comandos destrutivos bloqueia padrões como Bash(rm:*), mas pode ser contornada por:

- bash -c;
- Python ou Node;
- find -delete;
- utilitários equivalentes;
- ferramentas MCP;
- novas variantes não previstas.

### Cadeia de ataque

~~~text
repositório/página/prompt malicioso
  → prompt injection
  → agente com permissões ignoradas
  → shell/MCP
  → leitura, alteração ou exfiltração no host
~~~

O Portal Grab aumenta esse risco ao inserir conteúdo de uma página diretamente no prompt de um Debugger Agent em apps/desktop/src/components/Sidebar.tsx:759-778.

### Impacto

- leitura de credenciais e arquivos pessoais;
- modificação de arquivos fora do projeto;
- exfiltração pela rede;
- persistência local;
- execução de payload de repositório não confiável;
- destruição de dados dentro do workspace.

### Recomendação

1. Tornar bypass de permissões opt-in, por sessão, com aviso explícito.
2. Ativar sandbox workspace por padrão.
3. Falhar fechado quando o perfil exigir sandbox e bwrap estiver ausente.
4. Isolar rede por padrão e permitir hosts explicitamente.
5. Não montar diretórios de configuração inteiros.
6. Aplicar políticas no backend por operação/caminho.
7. Tratar conteúdo externo como dados delimitados, nunca como instrução.

---

## OR-SEC-002 — Fronteira WebView/Tauri excessivamente ampla

**Severidade:** Alta  
**Confiança:** Alta confiança; PoC de plataforma pendente para todas as variantes

### Evidências

- apps/desktop/src-tauri/tauri.conf.json:25-30 — CSP nula e asset scope global;
- apps/desktop/src-tauri/capabilities/default.json:15-25 — shell, clipboard e leitura de qualquer arquivo;
- apps/desktop/src/components/nodes/HtmlNode.tsx:62-69 — HTML local com scripts e same-origin;
- apps/desktop/src/components/nodes/PreviewNode.tsx:132-136 — HTML/markdown renderizado;
- apps/desktop/src-tauri/src/commands/fs.rs:37-81 — caminhos arbitrários e denylist textual;
- apps/desktop/src-tauri/src/commands/code.rs:28-41 — leitura/escrita sem restrição de projeto;
- apps/desktop/src-tauri/src/lib.rs:401-654 — 252 comandos Tauri registrados.

### Exposição

Uma execução JavaScript no contexto privilegiado do WebView, ou uma fuga pelo asset protocol, encontra:

- leitura global de arquivos;
- leitura do clipboard;
- comandos de terminal/agente;
- tokens e chaves devolvidos ao frontend;
- operações Git;
- configuração de providers;
- operações destrutivas.

Exemplos de segredos ou poderes devolvidos/expostos ao frontend:

- provider_resolve devolve a API key;
- git_token_get devolve token Git;
- mcp_servers_list devolve specs desofuscados;
- omniswitch_url devolve o token local;
- omnifs_rollback restaura o drive inteiro sem confirmação no backend.

### Problema adicional

O bloqueio de caminhos sensíveis em commands/fs.rs verifica apenas a string original. Um symlink para ~/.ssh, ~/.aws ou outro alvo contorna a intenção do bloqueio. code_open nem aplica esse filtro.

### Recomendação

1. Definir CSP estrita.
2. Restringir assetProtocol aos arquivos selecionados/projetos abertos.
3. Remover fs:allow-read-file com path **.
4. Canonicalizar caminhos e validar que permanecem dentro de raízes autorizadas.
5. Não devolver segredos ao WebView; usar identificadores opacos.
6. Exigir confirmação/autorização também no backend para rollback, delete e operações destrutivas.
7. Separar capabilities por janela e função.

---

## OR-SEC-003 — Programa beta pode emitir licenças ilimitadas

**Severidade:** Crítica  
**Confiança:** Confirmado

### Evidências

- services/license-worker/src/beta.ts:28-64
- services/license-worker/src/index.ts:171-176
- services/license-worker/wrangler.toml:24-34

O endpoint aceita email e fingerprint fornecidos pelo cliente. O único antiabuso é “uma licença por fingerprint”, mas o atacante controla o fingerprint e pode gerar valores hexadecimais aleatórios.

Não existe rate-limit no código nem binding versionado no wrangler.toml. BETA_LAUNCH está habilitado.

### Impacto

- emissão automatizada de licenças full de 60 dias;
- crescimento de D1, eventos e CRM;
- abuso de email/integrações;
- invalidação do modelo comercial do beta.

### Recomendação

- fechar o endpoint público até existir controle forte;
- challenge assinado/convite servidor;
- rate-limit por IP, ASN, email e device;
- deduplicação por email;
- CAPTCHA/Turnstile;
- limite global de emissão;
- detecção de padrões e revogação.

---

## OR-SEC-004 — Licença past_due obtém entitlement full por /activate

**Severidade:** Alta  
**Confiança:** Confirmado

### Evidências

- services/license-worker/src/index.ts:241-258
- services/license-worker/src/index.ts:262-271
- services/license-worker/src/index.ts:388-395

/activate rejeita apenas canceled. Uma licença past_due passa, registra ou atualiza o dispositivo e recebe um entitlement full com nova janela. /refresh rejeita past_due, mas o cliente pode chamar /activate novamente.

### Recomendação

Centralizar a regra:

~~~text
can_issue_entitlement(status, trial_ends_at, payment_state)
~~~

A mesma função deve ser usada em activate e refresh, aceitando apenas:

- active;
- trial/beta ainda não expirado;
- estados explicitamente autorizados.

---

## OR-SEC-005 — Dispositivo revogado pode se autorreativar

**Severidade:** Alta  
**Confiança:** Confirmado

### Evidências

- services/license-worker/src/index.ts:249-255
- services/license-worker/src/db.ts:117-133

getDevice retorna também registros revogados. Como existing é verdadeiro, /activate não executa o seat cap. O UPSERT seguinte define revoked_at = NULL.

### Impacto

- revogação não é efetiva;
- dispositivo revogado volta sem autorização;
- seat cap pode ser contornado.

### Recomendação

- rejeitar existing.revoked_at em /activate;
- nunca limpar revogação implicitamente no UPSERT;
- criar endpoint administrativo/autenticado específico para reativação;
- registrar motivo, ator e timestamp.

---

## OR-SEC-006 — Seat cap sujeito a corrida

**Severidade:** Alta  
**Confiança:** Alta confiança

### Evidências

- services/license-worker/src/index.ts:249-255
- services/license-worker/src/db.ts:108-133
- services/license-worker/schema.sql:24-34

O fluxo executa COUNT e INSERT/UPSERT separadamente. Requisições concorrentes podem observar a mesma contagem e inserir múltiplos dispositivos.

### Problema relacionado

device_pubkey é armazenado e descrito como prova de posse, mas não participa da autenticação de activate, refresh ou revoke.

### Recomendação

- transação serializada;
- Durable Object por licença ou operação D1 atômica;
- challenge-resposta com device_pubkey;
- constraint/modelo de seats que não dependa de read-then-write;
- testes concorrentes.

---

## OR-SEC-007 — Token Git exposto em argv e persistido no remote

**Severidade:** Alta  
**Confiança:** Confirmado

### Evidência

- apps/desktop/src-tauri/src/commands/gitremote.rs:96-125

O clone monta https://TOKEN@host/repo e passa essa URL ao processo Git.

### Impacto

- token visível durante a execução na listagem de processos;
- token persistido em .git/config como remote.origin.url;
- vazamento em backups, diagnósticos ou suporte.

### Recomendação

- GIT_ASKPASS temporário com permissão 0600;
- credential helper efêmero;
- header de autorização apropriado quando suportado;
- garantir remote set-url para URL limpa;
- teste que falhe se o token aparecer no argv ou .git/config.

---

## OR-SEC-008 — SSRF por redirect, rebinding e resposta ilimitada

**Severidade:** Alta  
**Confiança:** Confirmado para redirect/resposta ilimitada

### Evidências

- apps/desktop/src-tauri/src/commands/http.rs:45-93
- apps/desktop/src-tauri/src/commands/http.rs:95-134

O guard valida apenas a URL inicial. Reqwest segue redirects por padrão. Uma URL pública pode redirecionar para:

- 127.0.0.1;
- RFC1918;
- link-local;
- metadata cloud;
- serviços locais do OmniRift.

O código ainda admite TOCTOU de DNS e lê o corpo inteiro sem limite ou timeout global.

### Recomendação

- desabilitar redirect automático;
- validar cada hop;
- limitar número de redirects;
- pinar IP/conexão ou validar o endereço efetivamente conectado;
- timeouts de connect, request e body;
- stream com teto de bytes;
- bloquear credenciais e headers sensíveis em mudanças de origem.

---

## OR-SEC-009 — Tokens RPC/MCP/OmniSwitch sem RNG criptográfico

**Severidade:** Alta para atacante local; Média em máquina de usuário único  
**Confiança:** Confirmado

### Evidências

- apps/desktop/src-tauri/src/rpc/metadata.rs:1-8
- apps/desktop/src-tauri/src/rpc/metadata.rs:59-85
- apps/desktop/src-tauri/src/rpc/mod.rs:46-70
- apps/desktop/src-tauri/src/lib.rs:305 e 325

generate_token aplica SHA-256 sobre nanos do relógio, PID, contador e endereço de heap. Hash não cria entropia e o comentário afirma incorretamente que há entropia do SO.

O projeto já usa OsRng corretamente para device tokens e E2EE.

### Recomendação

- gerar 32 bytes com OsRng;
- codificar em base64url ou hex;
- manter runtime.json em 0600;
- aplicar ACL restritiva explícita no named pipe Windows;
- rotacionar tokens no restart.

---

## OR-SEC-010 — Sidecars de release compilados de HEAD remoto

**Severidade:** Crítica  
**Confiança:** Confirmado

### Evidências

- scripts/build-omnifs-sidecar.sh:28-42
- scripts/build-omnicompress.sh:29-44
- .github/workflows/release.yml

Os scripts clonam ou atualizam para HEAD/FETCH_HEAD e compilam o resultado. Esse binário entra no pacote oficial e passa a ser distribuído com a confiança do release OmniRift.

### Impacto

Comprometimento do repositório upstream, conta GitHub, branch ou dependência pode produzir código malicioso assinado/distribuído pelo OmniRift.

### Problema relacionado

apps/desktop/src-tauri/src/commands/clis.rs:277-295 executa curl | bash e iwr | iex sem assinatura ou checksum.

### Recomendação

- pin por commit imutável;
- arquivo de manifesto com URL, commit e SHA-256;
- verificar assinatura/hash antes do build;
- submodule/vendor ou release assinado;
- SBOM e provenance;
- eliminar pipe direto para shell.

---

## OR-SEC-011 — Relay usa segredo na URL e não limita abuso

**Severidade:** Alta para disponibilidade; Média para confidencialidade devido ao E2EE  
**Confiança:** Confirmado

### Evidências

- apps/relay-worker/src/index.ts:5-14
- apps/relay-worker/src/room.ts:8-30

O device token fica no path /r/TOKEN, sujeito a logs de URL. O Durable Object aceita até dois sockets, porém não limita:

- tamanho de mensagem;
- taxa;
- bytes por minuto;
- tempo de ociosidade;
- papel desktop/mobile;
- origem.

### Impacto

- ocupação permanente dos dois sockets;
- flooding e custo de egress;
- vazamento do room token em observabilidade;
- negação de conexão do dispositivo legítimo.

### Recomendação

- autenticação por header ou subprotocol;
- token de sala diferente do token de dispositivo;
- token de uso único/curta duração;
- limite de frame e throughput;
- idle timeout;
- autenticar roles;
- métricas e circuit breaker.

---

## OR-SEC-012 — Segredos protegidos apenas por XOR hardcoded

**Severidade:** Média  
**Confiança:** Confirmado

### Evidências

- apps/desktop/src-tauri/src/commands/mcp_servers.rs:9-32
- apps/desktop/src-tauri/src/commands/git_secret.rs:1-16
- apps/desktop/src-tauri/src/commands/git_secret.rs:70-80
- apps/desktop/src-tauri/src/memory/registry.rs:36-64

MCPs customizados e fallbacks de tokens usam ofuscação XOR com chave presente no código. Isso não fornece confidencialidade contra cópia do perfil ou processo do mesmo usuário.

### Recomendação

- keychain obrigatório para segredos persistentes;
- fallback cifrado com chave aleatória protegida pelo SO;
- se o keychain estiver indisponível, oferecer modo não persistente;
- nunca devolver specs completos com tokens ao frontend.

---

## OR-SEC-013 — API de licença sem controles adequados de borda

**Severidade:** Média/Alta  
**Confiança:** Confirmado no código versionado

### Evidências

- services/license-worker/src/index.ts:90-92 — CORS irrestrito;
- services/license-worker/src/index.ts:192-211 — diagnóstico público;
- services/license-worker/wrangler.toml — sem binding de rate-limit versionado.

Endpoints públicos sem controle no código:

- signup;
- signup/beta;
- checkout;
- activate;
- refresh;
- revoke;
- diag;
- donate.

log e state são truncados, mas note, appVersion, os e osVersion não são. O body total também não é limitado pela aplicação.

### Recomendação

- CORS por origem e método;
- rate-limit por rota;
- limite de body;
- validação de schema e comprimento;
- autenticação para diagnóstico ou token de suporte;
- retenção e quota no D1.

---

## OR-SEC-014 — Webhooks sem idempotência e ordenação

**Severidade:** Média/Alta para integridade de cobrança  
**Confiança:** Alta confiança

### Evidências

- services/license-worker/src/index.ts:285-315

O Worker autentica o webhook por token, mas não guarda:

- ID único do evento;
- horário efetivo;
- versão/ordem da assinatura;
- transição de estado válida.

Um evento PAYMENT_CONFIRMED antigo ou repetido pode chegar depois de PAYMENT_OVERDUE ou SUBSCRIPTION_DELETED e voltar a marcar a licença como active.

### Recomendação

- deduplicar por event ID;
- persistir event timestamp;
- máquina de estados explícita;
- recusar transições regressivas;
- reconciliar com a API Asaas para eventos sensíveis.

---

## OR-SEC-015 — macOS sem Developer ID e notarização

**Severidade:** Média  
**Confiança:** Confirmado

### Evidências

- apps/desktop/src-tauri/tauri.conf.json:63-65
- .github/workflows/release.yml:139-188

O bundle usa identidade ad-hoc e a verificação do seal é continue-on-error. O próprio workflow reconhece que isso não substitui notarização.

### Recomendação

- Apple Developer ID;
- hardened runtime;
- notarização;
- stapling;
- tornar verificação bloqueante quando macOS passar a ser oficialmente suportado.

---

## OR-SEC-016 — Dependências com advisories conhecidos

**Severidade:** Variável; Alta no conjunto  
**Confiança:** Confirmado pelos bancos npm/RustSec em 19/07/2026

### npm — workspace principal, incluindo tooling

| Severidade | Quantidade |
|---|---:|
| Crítica | 2 |
| Alta | 5 |
| Moderada | 5 |
| Baixa | 2 |
| Total | 14 |

Pacotes reportados:

- @cloudflare/vitest-pool-workers;
- vitest;
- vite;
- wrangler;
- ws;
- undici;
- devalue;
- miniflare;
- esbuild;
- @vitest/mocker;
- vite-node;
- dompurify;
- monaco-editor;
- @babel/core.

### npm — somente produção do desktop

- dompurify — moderada;
- monaco-editor — baixa por dependência de DOMPurify.

O DOMPurify é sensível porque protege a fronteira de markdown → HTML.

### License Worker

O audit completo encontrou:

- 4 altas;
- 2 moderadas;
- 0 em dependências de produção.

### RustSec

Vulnerabilidades:

- RUSTSEC-2026-0204 — crossbeam-epoch 0.9.18;
- RUSTSEC-2026-0195 — quick-xml 0.39.4, exaustão de memória;
- RUSTSEC-2026-0194 — quick-xml 0.39.4, CPU quadrática;
- RUSTSEC-2026-0185 — quinn-proto 0.11.14, exaustão remota de memória.

Observação: quinn-proto está no lockfile, mas não apareceu alcançável no grafo cargo tree atual.

Informativos de unsoundness:

- RUSTSEC-2026-0190 — anyhow 1.0.102;
- RUSTSEC-2024-0429 — glib 0.18.5.

### Recomendação

- atualizar DOMPurify imediatamente;
- alinhar Vitest/pool/Workerd/Wrangler;
- atualizar Vite;
- atualizar dependências Rust diretas/transitivas;
- remover pacotes mortos do lockfile;
- adicionar npm audit --omit=dev e cargo audit à CI.

---

## 5. Falhas funcionais e de comportamento FailProof

## OR-REL-001 — Ativação de licença retorna sucesso sem persistir

**Severidade:** Alta de confiabilidade  
**Confiança:** Confirmado

### Evidências

- apps/desktop/src-tauri/src/commands/license.rs:208-214
- apps/desktop/src-tauri/src/commands/license.rs:261-268

license_path retorna Option. Se o app data dir não existir ou não puder ser criado, license_activate simplesmente não grava e ainda retorna um LicenseStatus ativado.

### Sintoma

O usuário vê sucesso; após restart, a licença desaparece.

### Correção

Transformar license_path em Result e exigir persistência bem-sucedida antes de retornar status ativado.

---

## OR-REL-002 — Persistência de segredo falha silenciosamente

**Severidade:** Média  
**Confiança:** Confirmado

### Evidências

- apps/desktop/src-tauri/src/commands/providers.rs:99-130
- apps/desktop/src-tauri/src/commands/git_secret.rs:44-67
- apps/desktop/src-tauri/src/commands/git_secret.rs:92-116

provider_save ignora o booleano de secret_store::set. O fallback Git usa funções void que engolem falhas de create_dir, create, write e chmod, mas git_token_set retorna Ok.

### Correção

- propagar erro;
- confirmar read-after-write;
- não informar sucesso quando keychain e fallback falharem;
- escrita atômica com fsync/rename.

---

## OR-REL-003 — Boot parcial sem banco principal

**Severidade:** Alta de confiabilidade  
**Confiança:** Confirmado

### Evidência

- apps/desktop/src-tauri/src/lib.rs:226-264

Se Db::open falhar, o app apenas registra log e continua sem app.manage(db). Comandos que exigem State<Db> passam a falhar em runtime, enquanto a registry de memória abre outra conexão ou cai para in-memory.

### Risco

- estado dividido;
- canvas sem persistência;
- comandos IPC indisponíveis;
- usuário sem indicação clara do modo degradado.

### Correção

Ou falhar o boot com mensagem recuperável, ou registrar explicitamente um estado degradado único e mostrar banner bloqueante.

---

## OR-REL-004 — Saúde OmniSwitch usa relógio zero

**Severidade:** Média  
**Confiança:** Confirmado

### Evidências

- apps/desktop/src-tauri/src/commands/omniswitch.rs:41-55
- apps/desktop/src-tauri/src/llm_router/health.rs:23-38
- apps/desktop/src-tauri/src/llm_router/server.rs:108-112

omniswitch_health usa now_ms = 0. Chaves em cooldown continuam aparecendo indisponíveis mesmo depois do prazo real, até que algum sucesso altere explicitamente o estado.

### Correção

Usar o mesmo relógio epoch-ms do router e adicionar teste de consulta após expiração.

---

## OR-REL-005 — Toggle do Conductor usa closure obsoleta

**Severidade:** Média  
**Confiança:** Confirmado pelo lint e fluxo React

### Evidência

- apps/desktop/src/components/Sidebar.tsx:653-690

O listener de omnirift:open-tool captura constructorMode, mas o effect tem dependências vazias. setConstructorMode(!constructorMode) continua calculando a partir do valor inicial.

### Correção

~~~tsx
setConstructorMode((current) => !current)
~~~

---

## OR-REL-006 — Troca de CLI pode comparar command/role antigos

**Severidade:** Média  
**Confiança:** Alta confiança

### Evidência

- apps/desktop/src/components/nodes/TerminalNode.tsx:198-254

switchCli usa data.command e data.role, mas as dependências do useCallback não incluem esses campos.

### Impacto

- no-op incorreto;
- respawn desnecessário;
- comparação com configuração anterior.

---

## OR-REL-007 — Consultas e respostas materializadas sem teto

**Severidade:** Média/Alta para disponibilidade  
**Confiança:** Confirmado

### Evidências

- apps/desktop/src-tauri/src/commands/dbnode.rs:28-69
- apps/desktop/src-tauri/src/commands/http.rs:119-134

db_query acumula todas as linhas em Vec e não impõe:

- LIMIT;
- teto de bytes;
- timeout;
- cancelamento;
- paginação.

http_request lê todo o body como String.

### Correção

- limite default;
- paginação;
- stream;
- cancelamento;
- timeout;
- relatório de truncamento.

---

## OR-REL-008 — Escritas importantes não são atômicas

**Severidade:** Média  
**Confiança:** Confirmado

Foram encontrados 124 usos de std::fs::write/fs::write no backend. Nem todos são críticos, mas configurações e credenciais podem ser truncadas em crash ou disco cheio.

Exemplos:

- Preview write_file;
- license.key e license.id;
- configuração OmniSwitch;
- specs/configurações de providers;
- arquivos auxiliares MCP.

O CodeNode já possui implementação atômica com arquivo temporário, fsync e rename em apps/desktop/src-tauri/src/code/file_io.rs:18-48 e pode servir de utilitário comum.

---

## OR-REL-009 — Documentação FailProof divergente da implementação

**Severidade:** Baixa  
**Confiança:** Confirmado

### Evidências

- tools/failproof/README.md:101-119 — informa 20 minutos;
- tools/failproof/watchdog.py:24-41 — usa 40 minutos;
- tools/failproof/README.md:170-177 — informa 72 testes;
- execução atual — 145 testes.

### Correção

Atualizar a documentação e gerar parte desses números automaticamente.

---

## OR-PERF-001 — Bundles frontend excessivos e code splitting ineficaz

**Severidade:** Média  
**Confiança:** Confirmado pelo build

O build passou, mas gerou warnings para chunks acima de 500 KB.

Principais chunks observados:

- 3,668 MB — aproximadamente 954 KB gzip;
- 1,779 MB — aproximadamente 555 KB gzip;
- 1,723 MB — aproximadamente 521 KB gzip.

DiffViewerModal é lazy em apps/desktop/src/components/Sidebar.tsx:111, mas ReviewNode importa DiffLines estaticamente em apps/desktop/src/components/nodes/ReviewNode.tsx:17. Isso força o módulo para o bundle principal.

### Correção

- mover DiffLines para módulo pequeno separado;
- dividir Monaco, tldraw/Pixi e modais pesados;
- medir startup real no WebKitGTK/WebView2;
- estabelecer budget de bundle.

---

## OR-PERF-002 — Reattach de terminal longo bloqueia a navegação do canvas

**Severidade:** Alta para usabilidade; Média para disponibilidade

**Confiança:** Confirmado por inspeção do fluxo e incompatibilidade objetiva de limites

**Status:** Correção local implementada e validada; teste visual no WebKitGTK ainda recomendado

### Sintoma observado

Ao passear pelo canvas entre agentes, especialmente em sessões antigas ou com muito output,
o WebView engasga quando um TerminalNode entra novamente no viewport. O problema é amplificado
quando vários agentes cruzam o limite de renderização durante o mesmo movimento.

### Causa raiz

O floor ativo usa `onlyRenderVisibleElements`. Portanto, um terminal fora do viewport é
desmontado e, quando volta, reanexa ao PTY vivo e executa `pty_snapshot`.

Antes da correção:

- o backend podia devolver 10.000 linhas, limitado a 4 MB de ANSI;
- o payload atravessava o IPC Tauri;
- o xterm reinterpretava todo o ANSI no thread da interface;
- o xterm não configurava `scrollback`, portanto usava sua janela padrão de 1.000 linhas;
- até 90% do histórico processado podia ser descartado imediatamente pela própria view;
- o `fit()` também focava o xterm em eventos automáticos de layout/viewport, fazendo agentes
  disputarem o foco durante o pan.

Fluxo do travamento:

~~~text
pan do canvas
  → TerminalNode entra no viewport
  → React Flow remonta a view
  → pty_snapshot serializa até 10k linhas / 4 MB
  → IPC transfere o payload
  → xterm interpreta ANSI no WebView
  → view retém só 1k linhas
  → frame longo + foco roubado
~~~

### Correção aplicada

- o backend continua retendo 10.000 linhas como fonte de verdade;
- `pty_snapshot` passou a aceitar `scrollbackRows` opcional;
- pedidos acima do limite são limitados no backend, inclusive `usize::MAX`;
- a view declara explicitamente `scrollback: 1_000`;
- o reattach pede exatamente 1.000 linhas, evitando trabalho que seria descartado;
- `fit()` não muda mais o foco em eventos automáticos; foco passou a ser opt-in e ocorre
  apenas em ações intencionais, como clicar no terminal ou abri-lo em tela cheia.

### FailProof

- callers antigos que omitem `scrollbackRows` preservam o comportamento de 10.000 linhas;
- `None` usa o limite histórico do backend;
- valores excessivos são clampados para 10.000;
- valor zero ainda preserva a tela visível, pois limita apenas o histórico anterior;
- falha no snapshot continua fail-soft: a view mantém o conteúdo atual e segue com output live;
- o PTY e o histórico completo permanecem no backend, sem perda da sessão do agente.

### Validação executada

- typecheck TypeScript completo do desktop: passou;
- build de produção do frontend: passou;
- testes Rust direcionados do limite: 3 passaram;
- suíte Rust completa: 666 passaram, 1 ignorado e 0 falhas;
- ESLint do cliente PTY alterado: passou;
- `git diff --check`: passou;
- Rustfmt global continua falhando por dívida preexistente em muitos arquivos; as linhas novas
  não adicionaram divergência apontada pelo formatter.

### Validação dinâmica ainda recomendada

Na build Tauri Linux, abrir ao menos oito agentes, produzir mais de 1.000 linhas em dois deles
e alternar o viewport repetidamente. Medir frame time do WebKit antes/depois e confirmar:

- ausência de foco saltando entre terminais;
- pan responsivo enquanto os nós entram no viewport;
- scrollback recente de até 1.000 linhas disponível;
- sessão e histórico autoritativo preservados no backend.

---

## 6. Complexidade ciclomática

### 6.1 Resultado geral

Foram analisadas 6.832 funções em 493 arquivos suportados pelo analisador.

| Linguagem | Arquivos | Funções | Média CCN | Máxima | CCN > 10 | CCN > 15 | CCN > 20 | CCN > 30 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Rust | 143 | 2.031 | 2,61 | 53 | 63 | 15 | 7 | 3 |
| TypeScript | 179 | 1.547 | 2,50 | 43 | 38 | 19 | 6 | 4 |
| TSX | 125 | 2.993 | 2,23 | 121 | 70 | 39 | 22 | 10 |
| Python | 33 | 249 | 4,04 | 25 | 26 | 12 | 3 | 0 |
| JS/MJS | 13 | 12 | 1,67 | 6 | 0 | 0 | 0 | 0 |
| **Total** | **493** | **6.832** | — | **121** | **197** | **85** | **38** | **17** |

Outros sinais:

- 64 funções com NLOC > 80;
- 61 funções com mais de cinco argumentos.

### 6.2 Threshold recomendado

| CCN | Tratamento |
|---:|---|
| 1–10 | Aceitável |
| 11–15 | Revisar/testar branches |
| 16–20 | Refatoração planejada |
| 21–30 | Alto risco de regressão |
| > 30 | Bloqueador para crescimento; decompor |

### 6.3 Hotspots

| CCN | NLOC | Função/bloco | Local |
|---:|---:|---|---|
| 121 | 622 | landFloor | apps/desktop/src/components/Sidebar.tsx:1241 |
| 57 | 173 | bloco principal AgentNode | apps/desktop/src/components/nodes/AgentNode.tsx:276 |
| 53 | 236 | terminal_dispatch | apps/desktop/src-tauri/src/mcp/tools.rs:889 |
| 51 | 261 | AcpManager::spawn | apps/desktop/src-tauri/src/acp/mod.rs:396 |
| 48 | 46 | handleReady | apps/desktop/src/components/nodes/AgentNode.tsx:578 |
| 44 | 281 | authenticate | apps/desktop/src/components/nodes/AgentNode.tsx:1235 |
| 43 | 80 | importCommunities | apps/desktop/src/lib/omnigraph-graph.ts:156 |
| 42 | 91 | bloco ConstructorBar | apps/desktop/src/components/ConstructorBar.tsx:112 |
| 41 | 175 | FloorCanvasImpl | apps/desktop/src/components/FloorCanvas.tsx:122 |
| 38 | 117 | build do PipelineArchitect | apps/desktop/src/components/PipelineArchitectModal.tsx:185 |
| 36 | 194 | orchestration_dispatch | apps/desktop/src-tauri/src/mcp/tools.rs:1229 |
| 35 | 50 | bloco canvas-store | apps/desktop/src/store/canvas-store.ts:549 |
| 34 | 122 | ReviewModal | apps/desktop/src/components/ReviewModal.tsx:45 |
| 34 | 65 | buildRoleSpawn | apps/desktop/src/lib/agent-spawn.ts:72 |
| 33 | 47 | checkAgainst | apps/desktop/src/lib/response-schema.ts:140 |
| 32 | 121 | PortalNodeBase | apps/desktop/src/components/nodes/PortalNode.tsx:24 |
| 32 | 35 | handler da Sidebar | apps/desktop/src/components/Sidebar.tsx:653 |

> Limitação do analisador: em TSX, algumas funções aninhadas são atribuídas ao bloco externo. Os valores são indicadores de risco e devem ser confirmados com testes de branches, mas os hotspots continuam válidos.

### 6.4 Estratégia de refatoração

#### Sidebar.landFloor

Separar em:

1. validateLandRequest;
2. collectParallelState;
3. runPreLandChecks;
4. resolveConflicts;
5. executeLand;
6. updateCanvasState;
7. reportResult.

Cada etapa deve retornar um resultado tipado e testável.

#### AgentNode

Extrair:

- máquina de estados de conexão;
- autenticação;
- replay/snapshot;
- eventos ACP;
- seleção de modelo;
- lifecycle/cleanup.

#### MCP dispatchers

Trocar blocos monolíticos por tabela de handlers tipados, preservando autorização e validação comuns no entrypoint.

#### AcpManager::spawn

Separar:

- resolução de adapter;
- provider/env;
- criação de processo;
- handshake;
- criação de sessão;
- tasks de IO;
- rollback de spawn parcial.

---

## 7. Gates executados

| Gate | Resultado | Observação |
|---|---|---|
| npm run typecheck | Passou | Não cobre o desktop sozinho |
| build desktop — tsc -b + Vite | Passou | Com warnings de bundle |
| testes Rust all-targets | 657 passaram | 1 ignorado |
| testes desktop puros | 176 passaram | Sem React DOM |
| FailProof | 145 passaram | Verde no snapshot final |
| Relay Worker | 4 passaram | Verde |
| License Worker | Falhou antes de coletar testes | Toolchain incompatível |
| npm run lint global | Falhou | 7.014 ocorrências incluindo target |
| ESLint somente src | Falhou | 89 erros e 17 warnings |
| cargo clippy -D warnings | Falhou | 86 diagnósticos únicos |
| cargo fmt --check | Falhou | 120 arquivos |
| Ruff | Falhou | 47 ocorrências |
| Shell syntax | Passou | ShellCheck trouxe apenas infos |
| Node syntax | Passou | JS/MJS |
| Semgrep | Sem finding grave automático | Houve warnings de parsing |
| Busca de segredos | Passou | Nenhuma credencial real encontrada |

---

## 8. ESLint detalhado

### 8.1 Totais por regra

| Regra | Ocorrências |
|---|---:|
| react-hooks/set-state-in-effect | 44 |
| react-hooks/exhaustive-deps | 13 |
| react-hooks/refs | 12 |
| @typescript-eslint/no-unused-expressions | 7 |
| @typescript-eslint/no-unused-vars | 5 |
| no-empty | 4 |
| parser | 4 |
| react-hooks/immutability | 4 |
| @typescript-eslint/no-explicit-any | 3 |
| react-hooks/preserve-manual-memoization | 2 |
| react-hooks/purity | 2 |
| react-hooks/static-components | 2 |
| no-useless-assignment | 1 |
| prefer-const | 1 |
| react-hooks/rules-of-hooks | 1 |
| react-refresh/only-export-components | 1 |

### 8.2 Arquivos afetados

| Arquivo | Erros | Warnings | Linhas/regras principais |
|---|---:|---:|---|
| BootIntro.tsx | 1 | 0 | 46 refs |
| ClisModal.tsx | 1 | 0 | 56 set-state-in-effect |
| CommandPalette.tsx | 1 | 1 | 100 deps; 109 set-state |
| CompanionModal.tsx | 1 | 0 | 96 set-state |
| CompressorsModal.tsx | 1 | 0 | 38 set-state |
| ConnectionDropMenu.tsx | 2 | 0 | 131-132 static-components |
| ConnectionsModal.tsx | 1 | 0 | 49 set-state |
| DiffViewerModal.tsx | 1 | 0 | 79 set-state |
| ExecutionInspector.tsx | 1 | 0 | 49 set-state |
| GitReposModal.tsx | 0 | 1 | 92 parser |
| GraphImportButton.tsx | 4 | 0 | 357-363 refs |
| HelpModal.tsx | 0 | 2 | 42 e 46 deps |
| LlmConfigModal.tsx | 1 | 0 | 139 rules-of-hooks |
| McpServersModal.tsx | 1 | 0 | 44 set-state |
| MemoryModal.tsx | 1 | 0 | 61 set-state |
| MobileDevicesModal.tsx | 1 | 0 | 55 set-state |
| OmniFsModal.tsx | 1 | 0 | 107 set-state |
| OmniGraphDiffModal.tsx | 1 | 0 | 71 set-state |
| OmniGraphReportModal.tsx | 1 | 0 | 175 set-state |
| OrchestratorDock.tsx | 1 | 0 | 64 memoization |
| PipelineArchitectModal.tsx | 1 | 0 | 126 set-state |
| RemindersModal.tsx | 1 | 0 | 41 set-state |
| ReviewFixConfirm.tsx | 1 | 0 | 29 refresh export |
| ReviewModal.tsx | 3 | 2 | 80, 120, 124, 128, 135 |
| RoleEditModal.tsx | 1 | 0 | 82 set-state |
| RoutinesModal.tsx | 1 | 0 | 146 set-state |
| SessionHistoryModal.tsx | 2 | 0 | 74 e 77 set-state |
| Sidebar.tsx | 5 | 3 | 690, 751, 782 deps; 822; 889; 969; 975; 1128 |
| SkillsCenterModal.tsx | 1 | 0 | 68 set-state |
| SnapshotsModal.tsx | 1 | 0 | 88 set-state |
| SymbolBodyModal.tsx | 1 | 0 | 27 set-state |
| TrajectoryEvalModal.tsx | 1 | 0 | 81 immutability |
| UsageModal.tsx | 1 | 0 | 234 set-state |
| FlowEdge.tsx | 2 | 0 | 78 refs; 89 set-state |
| CodeDimension.tsx | 5 | 0 | 211, 219, 229, 252, 282 |
| DbDimension.tsx | 1 | 1 | 286 set-state; 323 deps |
| DebtTab.tsx | 1 | 0 | 55 set-state |
| ProjectHealthPanel.tsx | 1 | 2 | 86 set-state; 89 deps; 91 parser |
| CodeNode.tsx | 7 | 0 | 71-72 immutability; 104; 136-155 refs |
| DbNode.tsx | 1 | 0 | 50 set-state |
| FileTreeNode.tsx | 1 | 0 | 105 set-state |
| FilterNode.tsx | 1 | 0 | 65 set-state |
| HermesWizard.tsx | 1 | 0 | 168 set-state |
| PdfNode.tsx | 1 | 0 | 61 set-state |
| PreviewNode.tsx | 1 | 0 | 66 set-state |
| ReviewNode.tsx | 1 | 0 | 98 set-state |
| TerminalNode.tsx | 3 | 4 | 253, 391, 447, 449 deps; 400; 553 e 716 purity |
| TurboPanel.tsx | 2 | 1 | 111, 115, 120 |
| useReorderable.ts | 1 | 0 | 52 set-state |
| useTerminalSession.ts | 3 | 0 | 91 refs; 547 immutability; 683 memoization |
| boot-probes.ts | 3 | 0 | 21, 30, 39 explicit-any |
| gate-close.test.ts | 1 | 0 | 5 unused expression |
| omnigraph-graph.ts | 2 | 0 | 158 unused; 272 prefer-const |
| watchdog.test.ts | 1 | 0 | 1 unused |
| pipeline-edit.test.ts | 1 | 0 | 20 unused |
| review.ts | 1 | 0 | 156 useless assignment |
| shell.test.ts | 1 | 0 | 10 unused |
| use-draggable.ts | 4 | 0 | 21, 43, 57, 62 empty blocks |

### Observação

Nem toda ocorrência set-state-in-effect é bug funcional. Entretanto, os erros de closure/dependência, purity, refs durante render e uso antes da declaração indicam incompatibilidades reais com o React Compiler e risco de comportamento obsoleto.

### Problema do gate global

apps/desktop/eslint.config.js ignora apenas dist. Como o script executa eslint ., ele também varre src-tauri/target e gera milhares de falsos positivos em código gerado.

Correção:

~~~js
globalIgnores([
  "dist/**",
  "src-tauri/target/**",
  "node_modules/**",
  "coverage/**"
])
~~~

---

## 9. Clippy, Rustfmt, Python e Shell

### 9.1 Clippy

86 diagnósticos únicos em 31 arquivos.

| Regra | Únicos |
|---|---:|
| doc_overindented_list_items | 20 |
| needless_borrow | 12 |
| too_many_arguments | 9 |
| doc_lazy_continuation | 8 |
| bool_assert_comparison | 7 |
| unnecessary_sort_by | 4 |
| type_complexity | 3 |
| manual_find | 3 |
| unnecessary_map_or | 2 |
| redundant_closure | 2 |
| needless_borrows_for_generic_args | 2 |
| manual_pattern_char_comparison | 2 |
| empty_line_after_doc_comments | 2 |
| demais regras | 10 |

Os itens de maior valor arquitetural são:

- too_many_arguments;
- type_complexity;
- double_ended_iterator_last;
- manual_find;
- APIs sem Default/is_empty.

### 9.2 Rustfmt

120 arquivos Rust não passam em cargo fmt --check. Isso torna diffs ruidosos e impede usar formatação como gate até fazer um commit mecânico isolado.

### 9.3 Ruff

47 ocorrências:

- lambdas atribuídas em local-review.py;
- múltiplas instruções por linha em omnirift-anti-patterns.py;
- imports tardios deliberados no FailProof;
- nomes ambíguos;
- imports agrupados em teste.

Majoritariamente estilo, sem vulnerabilidade confirmada.

### 9.4 ShellCheck

Somente avisos SC2317 no cleanup/trap de scripts/smoke-boot.sh. O código é chamado indiretamente pelo trap, portanto pode ser falso positivo documentável.

---

## 10. Testes e cobertura

### 10.1 Resultados

| Suíte | Resultado |
|---|---:|
| Rust | 657 passaram, 1 ignorado |
| Desktop lógica pura | 176 passaram |
| FailProof | 145 passaram |
| Relay Worker | 4 passaram |
| License Worker | 0 executados; runner quebrou |

Total de testes verdes executados: 982.

### 10.2 FailProof

O subsistema passou integralmente e cobre:

- failbase;
- captura falha → possível fix;
- distinção observado/validado;
- hooks;
- evidence gate;
- watchdog;
- strikes;
- plugins;
- instalação;
- paridade repo/home;
- falha-aberto.

Isso comprova o FailProof como subsistema, mas não torna o restante do aplicativo fail-proof automaticamente.

### 10.3 License Worker

O runner falha por incompatibilidade entre:

- Vitest 3.2.6;
- @cloudflare/vitest-pool-workers 0.8.71;
- múltiplas versões de Wrangler/Workerd;
- compatibility date mais nova que o runtime instalado.

Os testes existentes focam beta e diagnóstico. Não há testes cobrindo:

- activate past_due;
- dispositivo revogado;
- seat cap;
- concorrência;
- refresh com prova de dispositivo;
- revoke;
- ordenação de webhooks.

### 10.4 Frontend

Os 176 testes desktop são testes de lógica empacotados com esbuild. Não existe runner React DOM com Vitest + Testing Library.

Consequências:

- modal pode deixar de renderizar e teste de store continuar verde;
- foco/teclado/acessibilidade não são validados;
- lifecycle de hooks não é executado;
- regressões em portais, nós e overlays não são observadas.

### Recomendação mínima

- Vitest;
- @testing-library/react;
- user-event;
- ambiente jsdom/happy-dom;
- testes por role/visibilidade;
- asserts no DOM;
- poucos testes E2E Tauri para IPC crítico.

---

## 11. CI e release

### 11.1 O que a CI cobre

GitHub:

- npm ci;
- typecheck;
- sidecars;
- cargo test;
- build debug;
- smoke boot.

Forgejo:

- cargo test Linux;
- cargo xwin check;
- typecheck dos workspaces;
- tsc -b do desktop;
- regra contra .d.ts próprio.

### 11.2 Gates ausentes

- ESLint;
- cargo fmt --check;
- Clippy;
- Ruff;
- ShellCheck;
- FailProof;
- License Worker;
- Relay Worker no workflow principal;
- npm audit de produção;
- cargo audit;
- secret scan bloqueante;
- testes React DOM;
- budget de bundle;
- pin/verificação de sidecars.

### 11.3 Ponto positivo

O release usa draft-then-publish e smoke no .deb real. O updater também possui chave pública para verificar assinaturas.

### 11.4 Risco

O smoke prova que o aplicativo abre; não prova:

- segurança;
- funcionalidade de licença;
- integridade dos sidecars de origem;
- UI;
- Windows/macOS completos;
- ausência de advisory.

---

## 12. Controles positivos encontrados

Os seguintes controles devem ser preservados:

1. E2EE móvel com X25519/XSalsa e OsRng.
2. Nonce novo por frame e anti-replay.
3. Limite de 1 MiB no WebSocket LAN.
4. Limite de conexões e timeout de handshake LAN.
5. Device tokens gerados por OsRng.
6. Keychain como caminho primário para memória/Git/providers.
7. Arquivos sensíveis frequentemente em 0600.
8. Updater assinado.
9. Release draft com smoke antes de publicar.
10. Redação de segredos no log.
11. DB usando bindings parametrizados.
12. CodeNode com escrita atômica.
13. Preview HTML em iframe sandbox sem scripts.
14. FailProof separando fix observado de fix validado.
15. Testes Rust numerosos e verdes.

---

## 13. Plano de remediação

## Fase 0 — contenção imediata, 24–48 horas

1. Remover bypass automático dos agentes.
2. Desabilitar ou proteger /signup/beta.
3. Bloquear activate para past_due e revoked.
4. Atualizar DOMPurify.
5. Trocar generate_token por OsRng.
6. Limpar token da URL Git e dos remotes já clonados.
7. Desativar redirects automáticos no HTTP node.

### Critério de saída

- nenhum agente novo nasce com bypass sem consentimento;
- past_due/revoked não recebem entitlement;
- beta não pode ser multiplicado com fingerprints aleatórios;
- tokens não aparecem em argv/config Git;
- SSRF redirect testado.

## Fase 1 — fronteiras de confiança, primeira semana

1. CSP estrita.
2. Asset scope limitado.
3. Capabilities Tauri por janela.
4. File access por projeto/canonical path.
5. Segredos opacos ao frontend.
6. Confirmação backend para rollback/delete.
7. Sandbox fail-closed com rede controlada.
8. Limites no relay e APIs públicas.

## Fase 2 — licença e cobrança, primeira semana

1. Máquina de estados de licença.
2. Seat allocation atômica.
3. Prova de posse com device_pubkey.
4. Idempotência de webhook.
5. Rate-limit e body schemas.
6. Suíte de testes do Worker restaurada.

## Fase 3 — supply chain e dependências

1. Pin dos sidecars.
2. Hash/provenance/SBOM.
3. Remover curl | shell.
4. npm audit/cargo audit em CI.
5. Atualizar toolchain Cloudflare.
6. Developer ID/notarização macOS.

## Fase 4 — qualidade e complexidade

1. Corrigir configuração ESLint.
2. Commit mecânico de Rustfmt.
3. Zeragem gradual de Clippy/Ruff.
4. Testes React DOM.
5. Refatorar CCN > 30.
6. Budget de bundle.

---

## 14. Matriz de priorização

| ID | Severidade | Esforço estimado | Prioridade |
|---|---|---|---|
| OR-SEC-001 | Crítica | Alto | P0 |
| OR-SEC-002 | Alta | Alto | P0 |
| OR-SEC-003 | Crítica | Médio | P0 |
| OR-SEC-004 | Alta | Baixo | P0 |
| OR-SEC-005 | Alta | Baixo | P0 |
| OR-SEC-006 | Alta | Médio | P0 |
| OR-SEC-007 | Alta | Médio | P0 |
| OR-SEC-008 | Alta | Médio | P0 |
| OR-SEC-009 | Alta/Média | Baixo | P0 |
| OR-SEC-010 | Crítica | Médio | P0 |
| OR-SEC-011 | Alta/Média | Médio | P1 |
| OR-SEC-012 | Média | Médio | P1 |
| OR-SEC-013 | Média/Alta | Médio | P1 |
| OR-SEC-014 | Média/Alta | Médio | P1 |
| OR-SEC-015 | Média | Médio/Alto | P2 |
| OR-SEC-016 | Variável | Médio | P1 |
| OR-REL-001 | Alta | Baixo | P0 |
| OR-REL-002 | Média | Baixo | P1 |
| OR-REL-003 | Alta | Médio | P1 |
| OR-REL-004 | Média | Baixo | P1 |
| OR-REL-005 | Média | Baixo | P1 |
| OR-REL-006 | Média | Baixo | P1 |
| OR-REL-007 | Média/Alta | Médio | P1 |
| OR-REL-008 | Média | Médio | P2 |
| OR-REL-009 | Baixa | Baixo | P3 |
| OR-PERF-001 | Média | Médio | P2 |
| OR-PERF-002 | Alta/Média | Baixo | P0 |

---

## 15. Critérios de aceite para uma nova auditoria

Uma reauditoria deve exigir:

### Segurança

- nenhum bypass de permissões default;
- sandbox fail-closed;
- CSP ativa;
- capabilities mínimas;
- segredos não retornam ao WebView;
- SSRF por redirect/rebinding coberto;
- tokens CSPRNG;
- beta e licença com testes adversariais;
- sidecars fixados por hash.

### Qualidade

- ESLint em zero;
- cargo fmt verde;
- Clippy verde ou baseline explícito sem novos débitos;
- Ruff verde;
- complexidade máxima nova <= 15;
- redução dos hotspots > 30.

### Testes

- License Worker verde;
- testes activate/refresh/revoke;
- teste concorrente de seat;
- testes DOM dos fluxos principais;
- teste de falha de persistência;
- teste de boot sem DB;
- testes de segurança Tauri/WebView.

### Dependências

- zero critical/high em dependências de produção;
- advisories Rust analisados e resolvidos/justificados;
- audits bloqueantes na CI.

---

## 16. Comandos de reprodução

~~~bash
# TypeScript e build
npm run typecheck
npm run build --workspace=apps/desktop

# Testes desktop
npm run test:grab --workspace=apps/desktop
npm run test:laziness --workspace=apps/desktop
npm run test:goal-budget --workspace=apps/desktop
npm run test:speculative-compact --workspace=apps/desktop
npm run test:shell --workspace=apps/desktop
npm run test:license --workspace=apps/desktop
npm run test:pipeline-edit --workspace=apps/desktop

# Rust
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets
cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --all -- --check
cargo audit --manifest-path apps/desktop/src-tauri/Cargo.toml

# FailProof
pytest -q tools/failproof

# Frontend lint isolado
cd apps/desktop
npx eslint src

# Workers
cd apps/relay-worker
npm test

cd services/license-worker
npm test

# Dependências
npm audit
npm audit --omit=dev

# Python e Shell
ruff check scripts tools
shellcheck scripts/*.sh tools/failproof/*.sh
~~~

---

## 17. Limitações

Esta auditoria não incluiu:

- pentest dinâmico completo do WebKitGTK;
- pentest dinâmico do WebView2;
- Windows real;
- macOS real/Gatekeeper;
- infraestrutura Cloudflare em produção;
- regras WAF/rate-limit configuradas fora do repositório;
- conta Asaas e comportamento real de entrega/reordenação;
- Forgejo/GitHub settings e secrets;
- análise de binários sidecar compilados;
- fuzzing de protocolos;
- exploração ofensiva em máquina separada.

Portanto, “nenhum outro problema foi encontrado” não significa ausência absoluta de vulnerabilidades. O relatório lista todos os problemas observados no código e nos gates executados dentro do escopo acima.

---

## 18. Conclusão

O OmniRift possui uma base funcional forte e um backend Rust bem testado, mas combina três características de alto risco:

1. processa conteúdo inerentemente não confiável;
2. concede autonomia elevada a agentes;
3. expõe uma ponte ampla entre WebView e sistema operacional.

Nesse contexto, segurança não pode depender de prompt, denylist textual ou confirmação somente na UI. Os controles precisam existir no backend, ser fail-closed e aplicar menor privilégio por padrão.

A ordem correta é:

1. conter agentes e licença;
2. fechar a fronteira Tauri;
3. proteger supply chain e rede;
4. restaurar gates;
5. reduzir complexidade.

Após os itens P0, recomenda-se uma reauditoria focada com PoCs WebView/Tauri, testes concorrentes do License Worker e teste de prompt injection dentro do sandbox revisado.
