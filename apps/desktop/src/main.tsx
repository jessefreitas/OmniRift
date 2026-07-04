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
import { ErrorBoundary } from './components/ErrorBoundary'
import { markBoot } from './lib/debug-log'

// Captura erros (console + globais) desde o boot — base do "Enviar diagnóstico".
initDiagnosticsCapture()

// P0 debug: marca o boot no ~/.omnirift/debug.log e loga o caminho no console.
void markBoot('boot').then((p) => p && console.info('[debug] log em', p))

// Aplica o tema salvo (cores/fontes) antes do render — evita flash do default.
applyTheme(loadTheme())

// Detecta os compressores no boot (popula o cache de reachability do proxy do
// OmniCompress) — pra a env já entrar nos primeiros spawns se o proxy estiver de pé.
void refreshCompressors().catch(() => {})

// Desabilita context menu padrão do WebKit globalmente
document.addEventListener('contextmenu', (e) => e.preventDefault());

// Fallback global: troca a TELA PRETA por uma tela legível (o stack já foi gravado em disco).
const crashScreen = (
  <div style={{ padding: 32, fontFamily: 'monospace', color: '#e8e8e8', background: '#161616', height: '100vh', boxSizing: 'border-box' }}>
    <h2 style={{ color: '#ff6b6b' }}>💥 OmniRift travou</h2>
    <p style={{ color: '#aaa', lineHeight: 1.6 }}>
      O erro completo foi gravado em <code style={{ color: '#a8b4ff' }}>~/.omnirift/debug.log</code>.<br />
      Feche e reabra o app; me manda esse arquivo pra eu corrigir.
    </p>
  </div>
)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary fallback={crashScreen} label="app">
      <App />
      <LicenseHost />
    </ErrorBoundary>
  </StrictMode>,
)
