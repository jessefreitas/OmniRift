# Release & Auto-update — OmniRift

Fluxo: **Forgejo = fonte da verdade** → espelha pro GitHub → tag dispara o build
assinado → rascunho de Release → você revisa e **publica** → o updater dos clientes
acha o `latest.json` e oferece a nova versão.

## Chave de assinatura (minisign)

Os updates são **assinados** (minisign) e o app só instala o que a chave pública
em `tauri.conf.json` (`plugins.updater.pubkey`) valida.

- **Privada:** `tools/.omnirift-updater.key` — **gitignored, NUNCA comitar**.
  Gerada sem senha. **Faça backup** (se perder, não dá pra assinar updates futuros —
  teria que rotacionar a pubkey e todo cliente antigo para de atualizar).
- **Pública:** `tools/.omnirift-updater.key.pub` (= valor já embutido no config).
- Regenerar (só se rotacionar): `npx @tauri-apps/cli signer generate -p "" -w tools/.omnirift-updater.key -f`
  e copiar o `.pub` pra `plugins.updater.pubkey`.

## Secrets no GitHub (Settings → Secrets → Actions)

O workflow `.github/workflows/release.yml` assina no CI. Adicione:

| Secret | Valor |
|--------|-------|
| `TAURI_SIGNING_PRIVATE_KEY` | conteúdo de `tools/.omnirift-updater.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | vazio (chave sem senha) |

## Cortar um release

```bash
# 1. bump de versão nos 4 manifests (tauri.conf, Cargo, 2× package.json)
npm run version:set 0.1.0

# 2. commit + tag + push (no remoto GitHub espelhado)
git commit -am "release: v0.1.0"
git tag v0.1.0 && git push --tags

# 3. o workflow builda Linux (.deb/.AppImage) + Windows (.exe/.msi), ASSINA,
#    gera latest.json e cria um Release RASCUNHO.
# 4. revise o rascunho no GitHub e clique PUBLICAR.
#    → o updater (endpoint .../releases/latest/download/latest.json) passa a oferecer.
```

## Build local assinado (opcional)

`createUpdaterArtifacts: true` faz o `tauri build` exigir a chave. Localmente:

```bash
TAURI_SIGNING_PRIVATE_KEY="$(cat tools/.omnirift-updater.key)" \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" \
npm run tauri:build
```

## Como o cliente atualiza

Rodapé do Sidebar → **"Buscar atualização"** (`UpdaterButton`). Checa o feed via
plugin nativo (reqwest, fora do WebKitGTK), e se houver versão nova: baixa, valida
a assinatura, instala e relança. Em dev o check falha (build não assinado) — normal.
