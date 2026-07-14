# macOS Gatekeeper — “App is damaged”

## Sintoma

Ao abrir o `.dmg` / `OmniRift.app` baixado, o macOS mostra algo como:

> OmniRift is damaged and can’t be opened. You should move it to the Trash.

Isso **não** significa download corrompido.

## Causas (duas camadas)

1. **Assinatura ad-hoc incompleta**  
   O bundler Tauri, sem `signingIdentity`, deixa o binário só *linker-signed* (`Sealed Resources=none`). O `spctl` reclama e o Finder traduz como “damaged”.

2. **Quarentena** (`com.apple.quarantine`)  
   Qualquer download da internet ganha esse xattr. Sem notarization, o Gatekeeper exige um passo de confiança.

## O que o repositório faz

| Camada | Onde | Efeito |
|--------|------|--------|
| Seal ad-hoc no **build** | `tauri.conf.json` → `bundle.macOS.signingIdentity: "-"` + job macOS no `release.yml` | O `.app` dentro do `.dmg` sai com sealed resources |
| Fallback CI | `scripts/macos-adhoc-codesign.sh` + `scripts/macos-repack-dmg.sh` | Re-sela e reempacota se o bundler regredir |
| Install do usuário | `scripts/install-macos.sh` | `xattr -cr` + re-seal local + copia pra `/Applications` |

## Workaround local (uma linha)

```bash
curl -fsSL https://raw.githubusercontent.com/jessefreitas/OmniRift/main/scripts/install-macos.sh | bash
```

Ou, se o app já está em `/Applications`:

```bash
xattr -cr /Applications/OmniRift.app
codesign --force --deep --sign - /Applications/OmniRift.app
open /Applications/OmniRift.app
```

## Solução definitiva (produção)

1. Conta **Apple Developer Program**
2. Certificado **Developer ID Application**
3. No CI: sign com a identity real (não `"-"`)
4. **Notarize** (`notarytool`) + **staple** no `.app` / `.dmg`
5. Remover o fallback ad-hoc quando o pipeline notarizado estiver verde

Até lá, ad-hoc seal + `install-macos.sh` são o caminho de **beta**, não gambiarra escondida: estão documentados e automatizados no release.

## Verificação

```bash
codesign -dv --verbose=2 /Applications/OmniRift.app
# Esperado: Signature=adhoc, Sealed Resources version=2 (ou superior)

xattr -l /Applications/OmniRift.app
# Não deve listar com.apple.quarantine após install-macos.sh
```
