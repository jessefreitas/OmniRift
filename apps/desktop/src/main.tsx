import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { LicenseGate } from './components/LicenseGate'
import { applyTheme, loadTheme } from './lib/theme-client'

// Aplica o tema salvo (cores/fontes) antes do render — evita flash do default.
applyTheme(loadTheme())

// Desabilita context menu padrão do WebKit globalmente
document.addEventListener('contextmenu', (e) => e.preventDefault());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LicenseGate>
      <App />
    </LicenseGate>
  </StrictMode>,
)
