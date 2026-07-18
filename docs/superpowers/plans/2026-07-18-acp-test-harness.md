# Plano — Harness de teste do ACP (passo 3 da spec grok-patterns)

**Data:** 2026-07-18
**Origem:** passo 3 de `docs/superpowers/specs/2026-07-16-grok-patterns-acp-sandbox-secrets-design.md`
**Status:** plano com investigação empírica concluída — pronto pra executar
**Pré-requisito de:** passo 1 (contador de id + `id→oneshot`), passo 5 (reconexão), passo 6 (migração pro crate oficial)

---

## 0. Por que existe

O read-loop do `acp/mod.rs` (~180 linhas, 4 providers em produção) tem **ZERO teste**. Os 17 testes atuais cobrem só estruturas puras (`EventLog`, coalescência, `seq`, snapshot, gc). Foi exatamente aí que o **bug latente do hang** (adapter travava em request não implementado) viveu sem ninguém ver — corrigido em `345e7ab`, mas o fix só tem teste do helper puro, **não do loop**.

Sem harness, os passos 1/5/6 são cirurgia no escuro.

---

## 1. Investigação empírica (feita — não repetir)

Duas abordagens "óbvias" foram testadas e **descartadas com evidência**:

### ❌ Mock runtime do Tauri (`tauri::test::mock_app`)
Adicionei `tauri = { features = ["test"] }` em dev-dependencies: **compila** (RC=0). Mas o probe falhou:

```
error[E0308]: mismatched types
expected `AppHandle<tauri_runtime_wry::Wry<..>>`
   found `AppHandle<MockRuntime>`
```

`mock_app()` devolve `App<MockRuntime>`; o `spawn()` recebe `AppHandle` (= `AppHandle<Wry>`). Usar o mock exigiria tornar `AcpManager` **genérico sobre `R: Runtime`**, rippando por todos os comandos Tauri. Custo alto, ganho baixo. **Revertido.**

### ❌ Extração "mecânica" do loop (como a spec sugeria)
A spec estimou passo 3 como "M / Baixo risco". A leitura do código mostra acoplamento **triplo**, não simples:
1. **Emissor** — ~15 chamadas `app.emit("acp://…", TypedEvent{…})`.
2. **Escritor** — `sess.stdin` é `Arc<AsyncMutex<ChildStdin>>`, **dentro da struct `Session`** que `prompt`/`cancel`/`authenticate`/`set_model` também usam.
3. **Config capturada** — `cwd_loop`, `resume_loop`, `pc_loop`, `mcp_servers`.

Extrair sem desacoplar (1) e (2) não torna nada testável.

### ✅ Descoberta que destrava tudo
O loop **grava no `sess.observed` (EventLog) ANTES de emitir** (`record("ready")`, `record("permission")`, `record("auth-required")`, `record("exit")`). Ou seja: **dá pra assertar no EventLog sem depender de evento Tauri nenhum.** O emissor vira detalhe secundário; o essencial é conseguir construir uma `Session` sem processo real.

---

## 2. Design escolhido

Dois desacoplamentos pequenos e cirúrgicos destravam o loop inteiro:

### 2.1 `EventSink` — mata a dependência do Tauri
```rust
pub(crate) trait EventSink: Send + Sync + 'static {
    fn emit_event(&self, event: &str, payload: Value);
}
impl EventSink for AppHandle { /* let _ = self.emit(event, payload) */ }
```
- Produção: `AppHandle` implementa.
- Teste: `RecordingSink(Mutex<Vec<(String, Value)>>)`.
- **Equivalência de comportamento**: `app.emit(ev, TypedStruct)` e `app.emit(ev, to_value(TypedStruct))` produzem o MESMO JSON no front (mesma impl `Serialize`). Preserva contrato.
- **Não precisa de genéricos sobre `Runtime`.**

### 2.2 Escritor boxeado — mata a dependência de processo
```rust
// antes: stdin: Arc<AsyncMutex<ChildStdin>>
// depois: stdin: Arc<AsyncMutex<Box<dyn AsyncWrite + Send + Unpin>>>
```
Uma mudança de tipo na struct `Session` + assinatura do `write_line`. Testes injetam `tokio::io::duplex()` e **leem o que foi escrito** — é assim que se assere o `-32601`.

### 2.3 Loop extraído
```rust
async fn run_read_loop<R: AsyncRead + Unpin, S: EventSink>(
    reader: R, sink: Arc<S>, sess: Arc<Session>, sid: String, cfg: LoopCfg,
)
```
`LoopCfg { cwd, resume, provider_config, mcp_servers }` agrupa a config capturada.

---

## 3. Execução por etapas (cada uma com a suíte verde)

| # | Etapa | Risco | Gate |
|---|---|---|---|
| 1 | `EventSink` + impl p/ `AppHandle` + trocar as ~15 chamadas de emit | Baixo | 619 testes verdes |
| 2 | Boxear `stdin` na `Session` + ajustar `write_line` e os 4 call-sites | Médio | 619 testes verdes |
| 3 | Extrair `run_read_loop` (sem mudar lógica) | Médio | 619 testes verdes |
| 4 | Testes do loop com `duplex` + `RecordingSink` | — | novos testes |

**Regra:** uma etapa por commit, suíte inteira rodando entre elas. Se a etapa 2 se mostrar mais invasiva que o previsto, parar e reavaliar — ela é a única com ripple real.

---

## 4. Testes que o harness destrava

- **request desconhecido → `-32601` é ESCRITO no stdin** (hoje só o helper puro é testado; o wiring não).
- Notificação (sem `id`) **não** gera resposta.
- Handshake: `initialize` → `session/new` quando `authMethods` vazio; → `auth-required` quando não-vazio.
- BYOK: `provider_config` presente → auto-`authenticate` com o methodId certo.
- `session/load` (resume) OK e fallback pra `session/new` quando falha.
- Linha não-JSON não mata o loop; EOF → `record("exit")`.
- **Dois prompts concorrentes** — o teste que prova o defeito #1 e valida o passo 1 depois.

---

## 5. Critério de aceite

- [ ] 619 testes existentes continuam verdes em TODAS as etapas.
- [ ] Loop coberto por ≥7 testes novos, sem spawn de processo e sem Tauri.
- [ ] O fix do `-32601` passa a ter teste de wiring (não só do helper).
- [ ] Nenhum `#[cfg(test)]` vazando pra produção; `EventSink` é `pub(crate)`.
- [ ] Só então abrir o passo 1 (contador de id).

---

## 6. Fora de escopo

Contador de id/`oneshot` (passo 1), reconexão (5), migração pro crate `agent-client-protocol` (6). Este plano só torna esses passos **testáveis** — não os executa.
