# OmniRift Lab

O OmniRift Lab é o canal de desenvolvimento instalável lado a lado com o OmniRift
Stable. Ele existe para experimentar e validar melhorias sem escrever nos dados, nas
credenciais ou no canal de atualização usado pelos clientes.

## Fronteiras de isolamento

| Recurso | Stable | Lab |
|---|---|---|
| Branch | `main` | `lab` ou `lab/*` |
| Worktree recomendado | `OmniRift` | `OmniRift-Lab` |
| Nome do produto | OmniRift | OmniRift Lab |
| Bundle identifier | `com.omniforge.omnirift` | `com.omniforge.omnirift.lab` |
| Estado Tauri (SQLite, licença, logs) | diretório do identifier Stable | diretório do identifier Lab |
| Estado global | `~/.omnirift` | `~/.omnirift-lab` |
| Keychain | `OmniRift` | `OmniRift-Lab` |
| RPC local | `omnirift.sock`, portas 7844/7845 | `omnirift-lab.sock`, portas 17844/17845 |
| Rotinas OS | `omnirift-*` / `OmniRift` | `omnirift-lab-*` / `OmniRift-Lab` |
| Imagens temporárias | `omnirift-pastes` | `omnirift-lab-pastes` |
| Updater | release público Stable | desabilitado; instalação explícita |

O feature Cargo `lab` define o canal no binário. O arquivo
`src-tauri/tauri.lab.conf.json` define a identidade do instalador e força o frontend a
ser compilado no modo Vite `lab`. Os dois precisam ser usados juntos; os scripts abaixo
fazem isso e o guard de isolamento rejeita combinações incompletas.

Os terminais criados pelo Lab recebem `OMNIRIFT_CHANNEL=lab`; por isso a CLI
`omnirift` procura `.omnirift-lab/runtime.json` e nunca se conecta por engano à
instalação Stable. Para usar a CLI manualmente fora de um terminal do Lab:

```bash
OMNIRIFT_CHANNEL=lab omnirift status
```

## Uso diário

No worktree Lab:

```bash
npm run lab:guard
npm run tauri:lab
```

Gerar um instalador Lab local:

```bash
npm run tauri:build:lab
```

Atualizar o Lab com a `main` canônica do Forgejo:

```bash
npm run lab:sync
```

`lab:sync` recusa worktree sujo, faz fetch de `origin/main`, aplica rebase e roda o
guard novamente. Conflitos precisam ser resolvidos conscientemente no Lab; o script
nunca altera a `main`.

## Promoção de uma melhoria

1. Trabalhe em `lab/<tema>` ou faça commits pequenos na branch `lab`.
2. Rode `npm run lab:guard`, testes focados, typecheck e os gates proporcionais ao risco.
3. Revise o diff contra `main`: `git diff origin/main...HEAD`.
4. Abra PR para `main` ou cherry-pick apenas os commits validados.
5. A publicação para clientes continua exigindo tag `v*`, smoke gate do artefato e,
   agora, prova de que o commit da tag já pertence à `main`.

Não use dados reais de clientes no Lab. Quando um caso depender de dados, importe uma
cópia sanitizada e unidirecional para o armazenamento do Lab. Nunca aponte o Lab para o
banco ou diretório de dados Stable.
