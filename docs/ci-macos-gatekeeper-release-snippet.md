# CI snippet — colar em `.github/workflows/release.yml` (job `build`, matrix macOS)

> O PR não altera `release.yml` diretamente quando o token do contribuidor não tem scope `workflow`.
> Maintainer: copiar os dois steps **antes/depois** do step `Build + Release (tauri-action)`.

## 1) Antes do `tauri-action` (após externalBin macOS)

```yaml
      # macOS sem Developer ID: força identidade ad-hoc ("-") no bundler Tauri.
      # Sem isso o .app sai linker-signed incompleto → Gatekeeper "is damaged".
      # tauri.conf.json já tem bundle.macOS.signingIdentity = "-"; o env reforça no job.
      # NÃO substitui notarization — só evita o falso "damaged" até haver cert pago.
      # Ver scripts/macos-adhoc-codesign.sh e scripts/install-macos.sh.
      - name: macOS ad-hoc signing identity (até Developer ID + notarize)
        if: matrix.os == 'macos-14'
        run: |
          echo "APPLE_SIGNING_IDENTITY=-" >> "$GITHUB_ENV"
          echo "→ signingIdentity ad-hoc (-) — seal do bundle no tauri build"
```

## 2) Depois do `tauri-action`

```yaml
      - name: macOS — garantir seal ad-hoc no .app e reempacotar .dmg
        if: matrix.os == 'macos-14'
        shell: bash
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          GITHUB_REPOSITORY: ${{ github.repository }}
          TAG: ${{ github.ref_name }}
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
        run: bash scripts/macos-repack-dmg.sh
```

O script `scripts/macos-repack-dmg.sh` já está neste PR.
