# Failproof V2 — hardening e plugin global

Data: 2026-07-19

## Decisão

Adotar a V2 em duas superfícies, com o mesmo contrato de confiança:

1. O runtime Claude permanece canônico em `tools/failproof` e é instalado em `~/.claude`.
2. O Codex recebe um plugin local independente em `~/plugins/failproof-v2`, instalado pelo marketplace `personal`.

Os bancos não são compartilhados. Isso evita acoplamento de formato e permite que cada host use seus hooks nativos; os invariantes são compartilhados por testes e documentação.

## Invariantes V2

- Uma correção observada nunca sobrescreve uma correção validada.
- A identidade de uma falha inclui assinatura e projeto.
- Correção humana promove o registro original pela assinatura, em vez de criar uma linha solta.
- Erros intercalados por sucesso não formam um loop consecutivo.
- Sessões e turns não aparecem literalmente em nomes de arquivo.
- O watchdog não mata processos por padrão e revalida a identidade do PID antes de qualquer ação opt-in.
- `true`, `echo` e mera leitura não são evidência para concluir trabalho alterado.
- Segredos são redigidos antes da persistência; `sanitize` corrige legado de forma transacional.

## Plugin Codex

Componentes:

- `.codex-plugin/plugin.json`: manifesto 2.0.0.
- `skills/failproof-v2`: skill com invocação implícita habilitada.
- `hooks/hooks.json`: captura de sessão, ferramenta, prompt e parada.
- `scripts/failproof_v2.py`: runtime stdlib only, SQLite e CLI.

O marketplace pessoal usa política `INSTALLED_BY_DEFAULT`. Isso assegura instalação padrão em ambientes que consomem esse marketplace. A execução dos hooks ainda depende da confiança explícita do usuário em `/hooks`, por desenho de segurança do Codex.

## Migração executada

- A base Claude V1 foi copiada antes da migração.
- O schema foi elevado para V2 e duplicatas lógicas foram eliminadas.
- Dois registros legados com padrões de segredo foram redigidos; o backup preserva recuperação local.
- O systemd user timer do watchdog foi habilitado.
- O plugin `failproof-v2@personal` foi instalado e habilitado.

## Aceitação

- Suíte do runtime Claude: 152 testes verdes.
- Suíte do plugin Codex: 9 testes verdes.
- Skill e plugin aprovados pelos validadores oficiais locais.
- Hook simulado bloqueia mutação sem validação e libera após pytest verde.
- `doctor` retorna integridade SQLite, zero duplicatas e zero padrões de segredo na base ativa.

## Riscos residuais

- Hooks são guardrails e não cobrem toda ferramenta hospedada.
- O usuário precisa aprovar a definição atual dos hooks em `/hooks` e iniciar uma nova thread.
- Backups históricos já versionados no espelho de `~/.claude` exigem rotação e eventual limpeza de histórico separadas; a V2 apenas impede novos backups desse tipo de entrarem no versionamento.
