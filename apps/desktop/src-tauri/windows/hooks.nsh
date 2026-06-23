; Hooks do instalador NSIS (Tauri) — OmniRift.
;
; PRÉ-INSTALAÇÃO: mata os sidecars do OmniCompress que possam estar rodando antes de
; sobrescrever os arquivos. Sem isso, atualizar por cima de uma instância aberta — ou
; de um sidecar ÓRFÃO (ex.: o proxy que o v0.1.15 startava antes de crashar) — falha com
; "Error opening file for writing: omnicompress-proxy.exe" (arquivo travado/em uso).
; O app principal (omnirift.exe) já é tratado pelo template padrão do Tauri; aqui cuidamos
; dos externalBin, que o Tauri não conhece como processos.

!macro NSIS_HOOK_PREINSTALL
  nsExec::Exec 'taskkill /F /T /IM omnicompress-proxy.exe'
  nsExec::Exec 'taskkill /F /T /IM omnicompress-mcp.exe'
  nsExec::Exec 'taskkill /F /T /IM omnicompress.exe'
  Sleep 800
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::Exec 'taskkill /F /T /IM omnicompress-proxy.exe'
  nsExec::Exec 'taskkill /F /T /IM omnicompress-mcp.exe'
  nsExec::Exec 'taskkill /F /T /IM omnicompress.exe'
  Sleep 500
!macroend
