# QA Manual — Release Checklist

> Checklist de verificação manual que **só pode ser rodado em build `.deb` de verdade**
> (o modo dev do Tauri dá tela branca no WebKitGTK — `__TAURI_INTERNALS__` não é injetado).

---

## Tour guiado de onboarding (`productTour`)

- [ ] **Sandbox abre sozinho na 1ª execução** — limpar `localStorage` (chave `omnirift.tour.v1.seen`) para simular primeiro acesso; ao abrir o app, o tour deve iniciar automaticamente com o sandbox provisionado em `appDataDir/tour-sandbox/`.
- [ ] **Spotlight alinha nos 7 alvos** — verificar em janela pequena (800×600) e grande (1920×1080). Cada alvo (`sidebar`, `new-agent`, `agent-terminal`, `canvas`, `save-workspace`, `kanban-toggle`) deve ter o recorte visível.
- [ ] **"Pular tour" fecha e não reaparece** — clicar em "Pular tour"; fechar e reabrir o app. O tour não deve reaparecer (flag `hasSeenTour=true` persistida).
- [ ] **"Refazer tour guiado" reabre o sandbox** — no menu Ferramentas → "Refazer tour guiado". Deve recriar o sandbox (idempotente) e resetar as missões. A checagem estrutural garante que tudo aparece "a fazer" de novo.
- [ ] **Missões de ação avançam sozinhas** — criar agente, mandar mensagem, mover canvas, salvar workspace, conectar agentes, abrir Kanban. Cada uma deve fazer o popover avançar automaticamente (sem botão de próximo).

## Como simular 1ª execução (para QA)

```bash
# Remover a flag de "já viu" — equivalente a primeira abertura do app
# No DevTools do app ou via console do sistema operacional:
rm -rf ~/.local/share/com.omniforge.omnirift/tour-sandbox
# E apagar a chave no localStorage do WebView (via DevTools ou reinstalando o app)
```

## Como verificar o sandbox

```bash
# Linux — verificar se o sandbox foi provisionado
ls -la ~/.local/share/com.omniforge.omnirift/tour-sandbox/
cat ~/.local/share/com.omniforge.omnirift/tour-sandbox/README.md
```
