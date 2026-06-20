# Contexto de design pro code-review (OmniRift)

OmniRift é um **app desktop local single-user** (Tauri). O modelo de ameaça é
diferente de um serviço web multi-tenant — leve isso em conta.

## Decisões INTENCIONAIS — NÃO trate como vulnerabilidade nem CRITICAL

- **Chave pública Ed25519 embutida** (`commands/license.rs`, const `PUBKEY`): é uma
  chave **PÚBLICA**. Embuti-la é o design — verificação de licença **offline e
  secret-free**. A chave PRIVADA fica FORA do binário (`tools/.omnirift-license.key`,
  gitignored). Embutir a pública é correto e seguro; **não** é exposição de segredo.
- **Ofuscação XOR de tokens em repouso** (`memory/registry.rs`,
  `commands/mcp_servers.rs`, const `OBF_KEY`): é **ofuscação, não cifragem** — está
  documentado no próprio código. Só evita token em texto claro no SQLite **local**;
  keychain do OS é Fase 2 (TODO anotado). **Threat model**: app desktop local
  single-user — quem tem acesso de leitura a esse arquivo já tem o home inteiro do
  usuário (`~/.ssh`, cookies, etc.), então ofuscação vs cifragem aqui é
  **defense-in-depth de BAIXA severidade**, não exposição crítica. Se for mencionar,
  classifique como **INFO ou WARNING**, **NUNCA CRITICAL** — não derruba o gate.
- **Token redigido em erro de clone** (`commands/gitremote.rs`): o código **já
  remove** o token da mensagem de erro antes de retornar. Não relate como vazamento.
- **Subprocessos sempre via `std::process::Command::new(...).args([...])`** (Rust),
  NUNCA por shell (`sh -c`/`shell=true`). Os argumentos vão DIRETO ao binário, sem
  interpretação de shell → **não há shell/command injection** (ex.: `browser.rs`
  chama `playwright`, `gitremote.rs` chama `git clone` — ambos com `.args()`). NÃO
  relate "injeção de comando" onde o código usa `.args()`.
- **Limites fixos de tamanho** (`commands/fs.rs`, 5 MB): proteção simples e suficiente
  pra um app desktop; não precisa ser configurável.
- **Comentários em português** são o padrão do projeto — não é problema de estilo.

## Hardening cross-platform (Win/Linux) — decisões INTENCIONAIS (não CRITICAL)

Família de arquivos que faz integração de SO **controlada**. No máximo INFO/WARNING:

- **Env vars de SO em caminhos de busca** (`commands/editor.rs`, `compress/proxy.rs`,
  `commands/mcp.rs`, `commands/skill_wiring.rs`, `commands/scheduler.rs`): ler
  `HOME`/`USERPROFILE`/`LOCALAPPDATA`/`ProgramFiles`/`APPDATA`/`CODEX_HOME` pra montar
  caminhos + `Path::exists()` e então spawnar um binário CONHECIDO é o design. App
  desktop **single-user**: essas env vars são do próprio usuário (quem as controla já é
  dono do home). **NÃO** é "input não sanitizado" nem path traversal — não é CRITICAL.
- **Editores por lista fixa** (`commands/editor.rs`, const `KNOWN`): `cmd` vem de array
  hardcoded (code/cursor/subl/…), nunca de input do usuário. Registro do Windows é lido
  pela **API `winreg`** (sem subprocess `reg`). `where`/`which` via `.args()` (sem shell).
- **Floor hooks rodam o comando do usuário** (`commands/git.rs`, `floor_run_hook`): roda
  o hook de ciclo de vida do floor via `sh -lc`/`cmd /C` **por design** — é o comando que
  o PRÓPRIO usuário configurou pro floor dele (como um git hook / npm script). A fonte do
  comando é o dono do app → **não é injeção de comando**.
- **fg-pid no Windows** (`pty/detector.rs`): enumera processos via `sysinfo` (read-only).

## Foco do review

Relate achados **reais**: secrets de verdade (chave privada/credencial viva),
injeção (SQL/cmd), authz quebrada, bugs de correção, data loss. O resto (preferências
de error-handling, async vs spawn_blocking, "poderia ter mais testes") é **advisory**
(WARNING/INFO em categorias não-bloqueantes), não motivo de NO-GO.
