# Importar agente pronto como Role (+ template baixável) — Design

> Status: **active** · 2026-06-24. Pedido do Jesse: reaproveitar agentes já construídos (persona +
> docs + skills) sem reescrever no formulário de Role. Baseado no `fonder-ceo.toml` real (formato Codex).

**Goal:** No painel **Roles**, **importar um arquivo de agente** (`.toml` Codex / `.md` Claude) → vira um
Role já preenchido. E oferecer um **template baixável** que a pessoa preenche e reimporta (round-trip),
pra quem não tem agente pronto. Curva de uso menor pro avançado (Jesse) e pro iniciante.

## Formatos suportados (confirmados no arquivo real)
**A) Codex `.toml`** (caso do `fonder-ceo.toml`):
```
name = "fonder-ceo"
description = "..."
developer_instructions = """ <persona inteira; pode referenciar docs por caminho> """
```
→ mapeia: `name`→role.name(+id slug), `description`→role.description, `developer_instructions`→**role.prompt**,
cli inferido = **codex**. As refs de doc no texto (`Documentacoes/Fonder/...`) **o Codex lê sozinho** ao rodar
no projeto — OmniRift NÃO parseia os docs.

**B) Claude `.md`** (padrão `.claude/agents/*.md`): frontmatter `--- name / description ---` + corpo (persona).
→ `name`/`description` do frontmatter, corpo→role.prompt, cli inferido = **claude**. (O OmniRift já descobre
`.claude/agents/` — confirmar e reusar o parser; este import é a versão "qualquer caminho".)

## Componentes / pontos de edição
1. **`src-tauri/src/commands/role_import.rs`** (NOVO) — comando `role_import_file(path) -> ImportedRole`:
   - lê o arquivo; detecta formato por extensão/conteúdo (`.toml` com `developer_instructions` = Codex;
     `.md` com frontmatter = Claude). Parseia (crate `toml` p/ Codex; parser leve de frontmatter p/ md).
   - retorna `ImportedRole { name, description, prompt, cli, sourcePath, format }` (serde camelCase).
     Fail-soft: campos faltando → erro claro; formato desconhecido → erro com dica.
   - `role_template(kind) -> String` (kind: "codex"|"claude") → devolve o **template** (string) com campos
     + comentários explicando (pra salvar/baixar).
2. **Frontend** (`RolesSection.tsx` — já extraído no Step 1 + `agent-roles.ts`):
   - botão **"＋ de arquivo"** → file picker (Tauri dialog) → `role_import_file` → pré-visualiza
     (nome/cli/persona truncada) → "Criar role". Salva via `saveRoles` (role normal).
   - botão **"baixar modelo"** → escolhe formato → `role_template` → salva via dialog (`fonder-ceo.toml`/`.md`
     em branco com instruções) pra preencher e reimportar.
   - `cli` inferido editável antes de salvar (caso o usuário queira outro).
3. **Import vs Link:** MVP = **import (cópia)**, mas guarda `sourcePath` no role. Botão opcional
   **"re-sincronizar do arquivo"** relê o `.toml` e atualiza o prompt (o "link vivo" leve, sob demanda —
   sem reler a cada spawn, pra não surpreender).

## Decisões
1. Começa pelo **`.toml` Codex** (caso real do Jesse) + `.md` Claude junto. 2. cli inferido por formato,
editável. 3. Docs referenciados = lidos pelo próprio CLI no projeto (não parseamos). 4. Import-cópia +
`sourcePath` p/ re-sync opcional (não link-a-cada-spawn). 5. Template baixável p/ round-trip.

## Testing
- Rust: parse do `fonder-ceo.toml` real → ImportedRole correto (name/description/prompt/cli=codex);
  `.md` com frontmatter → role; arquivo inválido → erro; `role_template` devolve template parseável.
- TS: tsc; o fluxo importar→preview→criar adiciona um role válido (loadRoles).
- Boot-safe (comando sob demanda).
