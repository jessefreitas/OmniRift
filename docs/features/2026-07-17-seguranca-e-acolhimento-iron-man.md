# OmniRift — Sessão 2026-07-17: Segurança + Sistema de Acolhimento Iron Man

Branch `fix/acp-montar-spawn`. Todas as entregas testadas (RED→GREEN / build verde) e atrás de
feature flags quando aplicável.

---

## ✨ Especial — Sistema de Acolhimento "Iron Man"

A abertura do OmniRift acolhe o operador com uma **intro cinematográfica estilo J.A.R.V.I.S.**, sorteada
a cada boot (`useArmor = Math.random() < 0.5`):

- **Armadura JARVIS procedural** (`boot-armor.ts` + `BootIntroArmor.tsx`) — a armadura holográfica
  **monta ao centro a partir de peças explodidas**, com HUD operando ao redor (rede neural viva, gauges,
  barras de SISTEMA, módulos inicializando um a um) e os olhos do visor acendendo ao ficar pronta. Cor
  (hue) e sentido de rotação são **aleatórios por boot** — nenhuma abertura é igual à anterior. Portada
  de `gen_armor.py` (potrace da arte-fonte → paths vetoriais).
- **HUD procedural** (`BootIntro.tsx`) — a variante alternativa: painel de diagnóstico sci-fi com a
  sequência de inicialização REAL do sistema (provedores, sessões, snapshots) acendendo linha a linha.
- **Voz FRIDAY neural (ElevenLabs, PT-BR)** — saudação por **período do dia** (manhã/tarde/noite/madrugada)
  com voz masculina (**Randel**) ou feminina (**Maria**), togglável no botão da intro. Áudio pré-gravado
  e embutido no binário (`include_bytes!`), tocado pelo backend Rust via rodio — porque o WebKitGTK do
  Linux não roteia Web Audio.
- **A saudação toca INTEIRA antes de fechar** — o clique pra entrar espera o áudio terminar (com teto de
  segurança), em vez de cortar a fala no meio. Ver a seção "fix de áudio" abaixo.

> É a primeira coisa que o usuário vê. Boot que dá orgulho de abrir.

### Fix de áudio órfão (causa raiz)

**Bug:** ao clicar pra entrar, a intro fechava na hora e a saudação seguia tocando órfã sobre o canvas.
**Causa:** `play_greeting` (comando Tauri síncrono) fazia `thread::spawn` destacada e **retornava
imediatamente** — o frontend não tinha sinal de quando o áudio terminava.
**Fix:** `play_greeting` virou `async` com `spawn_blocking().await` (resolve só no fim da fala) + helper
puro `gate-close.ts` (`Promise.race([áudio, teto 6s])`, nunca prende o usuário se não houver dispositivo
de som). As duas intros gateiam o fechamento no fim da saudação. Testado (`gate-close.test.ts`).

---

## 🔒 Segurança

### 1. Redação de segredos nos snapshots pro mobile (`redactor::redact_json`)
`pty.snapshot` e `acp.snapshot` (ambos na allowlist do controle remoto mobile) serializavam o terminal/
payloads **crus** pro relay — o e2ee cifra, mas o device pareado decifra e veria `sk-…`/`ghp_…` na tela.
Nova `redactor::redact_json(&mut Value)` redige recursivamente as strings-folha (só o que casa padrão de
segredo; ids/seq/labels intactos). TDD RED→GREEN. Regressão: redactor 21/21, rpc::methods 27/27.

### 2. Sandbox de execução via bwrap (núcleo, flag OFF por default)
Antes: agentes rodavam com **permissões plenas do usuário** nos spawn paths, sem contenção de syscall.
Agora: `sandbox.rs` (`SandboxProfile` Off/Workspace + `bwrap_available` + `build_bwrap_argv` + `maybe_wrap`
fail-open) envelopa o **executor real dos workers PTY** com bwrap no Linux — raiz read-only, workspace/
tmp/cache/npm/cargo RW, `~/.ssh`/`~/.aws`/`~/.gnupg` escondidos por tmpfs, `--die-with-parent`. Ativa com
`OMNIRIFT_SANDBOX=workspace`. Fail-open total → zero regressão quando off. 3 testes, pty 56/56.
Follow-up: flag no painel, ACP path, seccomp de rede, macOS Seatbelt, `~/.config` (v1 fica legível).

---

## 🧠 Agente

### Classificador de preguiça (juiz LLM anti-falsa-conclusão)
Ao fim de um turno **sem Goal ativo**, um juiz LLM cruza o que o agente DISSE com as tool calls que ele
REALMENTE fez e sinaliza "possível parada prematura" quando ele declara vitória sem verificar — o padrão
"prosa confiante NÃO é evidência". `laziness-check.ts` (gate barato pré-LLM + prompt + parse tolerante +
decisão híbrida, limiar 0.7). Flag `laziness-check` default OFF. 21 testes. Complementa o goal-check
existente (que já faz auto-nudge sob condição objetiva).

---

## Commits da sessão

| Commit | Entrega |
|--------|---------|
| `feat(agent)` | Classificador de preguiça |
| `feat(security)` | Redação buraco #2 (segredo pro mobile) |
| `feat(security)` | Sandbox núcleo bwrap |
| `feat(intro)` | Armadura JARVIS + voz Randel + saudação espera o áudio |

## Pendências conhecidas
- Armadura não perfeitamente centralizada no canvas (offset em investigação — dados e transform conferem,
  falta capturar a posição real em runtime; **aceito por ora**).
- Label do botão de voz ainda diz "Adam" (áudio já é Randel) — trocar.
- Sandbox: `~/.config` legível no v1; wiring do painel de flags; ACP spawn path.
