// PRIMEIRO import: migra chaves maestri-* → omnirift-* ANTES de qualquer store ler o localStorage.
import './lib/migrate-storage'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { LicenseHost } from './components/LicenseGate'
import { applyTheme, loadTheme } from './lib/theme-client'
import { refreshCompressors } from './lib/compress-client'
import { initDiagnosticsCapture } from './lib/diagnostics'

// Captura erros (console + globais) desde o boot — base do "Enviar diagnóstico".
initDiagnosticsCapture()

// Aplica o tema salvo (cores/fontes) antes do render — evita flash do default.
applyTheme(loadTheme())

// Detecta os compressores no boot (popula o cache de reachability do proxy do
// OmniCompress) — pra a env já entrar nos primeiros spawns se o proxy estiver de pé.
void refreshCompressors().catch(() => {})

// Desabilita context menu padrão do WebKit globalmente
document.addEventListener('contextmenu', (e) => e.preventDefault());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <LicenseHost />
  </StrictMode>,
)
