# OmniSwitch — Plano 3: integração no spawn + feature flag + UI

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development ou superpowers:executing-plans. Steps usam checkbox (`- [ ]`).

**Goal:** Ligar o OmniSwitch (Planos 1+2) no fluxo real: os agentes apontam pro router (via feature flag, default OFF), com auth de gateway (o token do router vira a "API key" do agente), comandos Tauri pra config/health, e uma UI mínima pra editar a tabela + ver a saúde das chaves.

**Architecture:** (1) Backend: o `check_token` do router passa a aceitar o token também via `x-api-key` (Anthropic) / `Authorization: Bearer` (OpenAI) — assim o claude/codex CLI autentica com o token do router como sua key, e o router injeta a chave REAL do provider no forward. (2) Comandos Tauri: `omniswitch_url` (url+token pro env), `omniswitch_config_get/set`, `omniswitch_health`. (3) Feature flag `omniswitch` (default false). (4) Spawn: com a flag ON, injeta `ANTHROPIC_BASE_URL`/`OPENAI_BASE_URL` + a key-token no env do agente. (5) UI: painel OmniSwitch (editor JSON da tabela + lista de saúde).

**Tech Stack:** Rust (axum/tauri command), React/TS. Testes: unit no auth estendido (Rust) + `tsc`. **Validação ponta-a-ponta (agente roteando de verdade) é runtime** — só no app buildado; até lá é observado. Spec: `docs/superpowers/specs/2026-07-07-omniswitch-llm-key-router-design.md`. Depende dos Planos 1+2 (branch `feat/omniswitch`).

---

## Estrutura de arquivos (Plano 3)

- Modify: `apps/desktop/src-tauri/src/llm_router/server.rs` — `check_token` aceita `x-api-key`/`Bearer`; `config_path` público.
- Create: `apps/desktop/src-tauri/src/commands/omniswitch.rs` — comandos `omniswitch_url`, `omniswitch_config_get`, `omniswitch_config_set`, `omniswitch_health`.
- Modify: `apps/desktop/src-tauri/src/lib.rs` — registrar os comandos no `invoke_handler` + `pub mod`.
- Modify: `apps/desktop/src/lib/feature-flags.ts` — flag `omniswitch` (default false).
- Modify: `apps/desktop/src/components/Sidebar.tsx` — injetar env do router no spawn quando a flag ON.
- Create: `apps/desktop/src/lib/omniswitch-client.ts` — wrapper dos comandos.
- Create: `apps/desktop/src/components/OmniSwitchModal.tsx` — UI mínima (editor + saúde).

---

### Task 1: Auth de gateway — `check_token` aceita header de key do cliente

**Files:** Modify `apps/desktop/src-tauri/src/llm_router/server.rs`

- [ ] **Step 1: Estender `check_token` + teste**

Substituir `check_token` por (aceita, além de `x-omniswitch-token`/`?token=`, o token vindo como `x-api-key` OU `Authorization: Bearer` — é assim que o CLI manda a "key"):

```rust
/// Autoriza o request contra o token do router. Aceita o token em QUALQUER um destes,
/// nesta ordem: header `x-omniswitch-token`, query `?token=`, header `x-api-key`
/// (clientes Anthropic) ou `Authorization: Bearer <tok>` (clientes OpenAI). Isso permite
/// o agente usar o token do router como sua "API key" (padrão de gateway) — o router
/// valida e SÓ ENTÃO injeta a chave real do provider no forward.
pub fn check_token(headers: &HeaderMap, query: &HashMap<String, String>, expected: &str) -> bool {
    let bearer = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer ").map(str::to_string));
    let provided = headers
        .get("x-omniswitch-token")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
        .or_else(|| query.get("token").cloned())
        .or_else(|| headers.get("x-api-key").and_then(|v| v.to_str().ok()).map(str::to_string))
        .or(bearer);
    matches!(provided, Some(tok) if ct_eq(tok.as_bytes(), expected.as_bytes()))
}
```

Adicionar ao `mod tests`:

```rust
    #[test]
    fn token_check_accepts_x_api_key_and_bearer() {
        let q = HashMap::new();
        let mut h = HeaderMap::new();
        h.insert("x-api-key", "secret".parse().unwrap());
        assert!(check_token(&h, &q, "secret"));
        let mut h2 = HeaderMap::new();
        h2.insert("authorization", "Bearer secret".parse().unwrap());
        assert!(check_token(&h2, &q, "secret"));
        let mut h3 = HeaderMap::new();
        h3.insert("x-api-key", "wrong".parse().unwrap());
        assert!(!check_token(&h3, &q, "secret"));
    }
```

- [ ] **Step 2: Rodar — deve PASSAR**

Run: `cargo test --lib llm_router::server`
Expected: PASS (testes de antes + o novo).

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src-tauri/src/llm_router/server.rs
git commit -m "feat(omniswitch): auth de gateway — check_token aceita x-api-key/Bearer (token do router = key do agente)"
```

---

### Task 2: Comandos Tauri (url/config/health)

**Files:** Create `apps/desktop/src-tauri/src/commands/omniswitch.rs`; Modify `apps/desktop/src-tauri/src/lib.rs`, `server.rs`

- [ ] **Step 1: Tornar `config_path` público em server.rs**

Em `server.rs`, trocar `fn config_path()` por `pub fn config_path()`.

- [ ] **Step 2: Criar os comandos**

Create `apps/desktop/src-tauri/src/commands/omniswitch.rs`:

```rust
//! Comandos Tauri do OmniSwitch: URL+token pro env do agente, get/set da tabela de
//! roteamento (`~/.omnirift/llm_router.json`) e snapshot de saúde das chaves.

use tauri::State;
use crate::llm_router::server::RouterState;

/// URL base do router + token (pro front montar o env ANTHROPIC_BASE_URL/OPENAI_BASE_URL
/// e a key-token do agente). Loopback.
#[tauri::command]
pub fn omniswitch_url(state: State<'_, RouterState>) -> serde_json::Value {
    serde_json::json!({
        "baseUrl": format!("http://127.0.0.1:{}", crate::llm_router::ROUTER_PORT),
        "token": state.token.as_str(),
    })
}

/// Conteúdo cru do `~/.omnirift/llm_router.json` (ou "" se ausente) — pro editor da UI.
#[tauri::command]
pub fn omniswitch_config_get() -> String {
    std::fs::read_to_string(crate::llm_router::server::config_path()).unwrap_or_default()
}

/// Valida (via `table::parse`) e grava o JSON da tabela; recarrega o state ativo (0600).
#[tauri::command]
pub fn omniswitch_config_set(state: State<'_, RouterState>, json: String) -> Result<(), String> {
    let table = crate::llm_router::table::parse(&json)?; // valida antes de gravar
    let path = crate::llm_router::server::config_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, &json).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    *state.table.lock() = table; // aplica na sessão viva (novos requests já usam)
    Ok(())
}

/// Snapshot de saúde por chave (pro painel ao vivo): keyRef → disponível agora?
#[tauri::command]
pub fn omniswitch_health(state: State<'_, RouterState>) -> Vec<(String, bool)> {
    let now_ms = 0u64;
    let table = state.table.lock();
    let health = state.health.lock();
    let mut seen = std::collections::BTreeSet::new();
    let mut out = Vec::new();
    for chain in table.classes.values() {
        for t in chain {
            if seen.insert(t.key_ref.clone()) {
                out.push((t.key_ref.clone(), health.is_available(&t.key_ref, now_ms)));
            }
        }
    }
    out
}
```

- [ ] **Step 3: Registrar no lib.rs**

Em `lib.rs`: adicionar `pub mod omniswitch;` no bloco `mod` de `commands` (onde os outros `commands::` são declarados) e importar + registrar os 4 comandos no `tauri::generate_handler![...]`:
```rust
use commands::omniswitch::{omniswitch_url, omniswitch_config_get, omniswitch_config_set, omniswitch_health};
```
e no `generate_handler![ ... , omniswitch_url, omniswitch_config_get, omniswitch_config_set, omniswitch_health ]`.

- [ ] **Step 4: Rodar — compila**

Run: `cargo check --lib`
Expected: `Finished` sem erro.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/commands/omniswitch.rs apps/desktop/src-tauri/src/lib.rs apps/desktop/src-tauri/src/llm_router/server.rs
git commit -m "feat(omniswitch): comandos Tauri url/config_get/config_set/health"
```

---

### Task 3: Feature flag `omniswitch`

**Files:** Modify `apps/desktop/src/lib/feature-flags.ts`

- [ ] **Step 1: Adicionar a flag (default false)**

No array `FLAGS`, adicionar seguindo a shape das outras (checar `interface FlagDef` ~linha 20-30 e preencher os campos exatos que ele exige):

```ts
  {
    key: "omniswitch",
    label: "OmniSwitch (roteador de chave LLM)",
    description: "Aponta os agentes pro roteador interno de chave (fallback + rotação). Experimental — default desligado.",
    default: false,
  },
```

⚠️ Ajustar os campos ao `FlagDef` real (se tiver `title` em vez de `label`, ou campos obrigatórios extras, espelhar as flags vizinhas — ex.: a experimental de `default: false` na linha ~105).

- [ ] **Step 2: Typecheck** — Run: `npx tsc -b` (de `apps/desktop`) → EXIT 0.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/lib/feature-flags.ts
git commit -m "feat(omniswitch): feature flag omniswitch (default off)"
```

---

### Task 4: `omniswitch-client.ts` + injeção de env no spawn

**Files:** Create `apps/desktop/src/lib/omniswitch-client.ts`; Modify `apps/desktop/src/components/Sidebar.tsx`

- [ ] **Step 1: Client wrapper**

Create `apps/desktop/src/lib/omniswitch-client.ts`:

```ts
import { invoke } from "@tauri-apps/api/core";

export interface OmniSwitchUrl { baseUrl: string; token: string }

export const omniswitchUrl = () => invoke<OmniSwitchUrl>("omniswitch_url");
export const omniswitchConfigGet = () => invoke<string>("omniswitch_config_get");
export const omniswitchConfigSet = (json: string) => invoke<void>("omniswitch_config_set", { json });
export const omniswitchHealth = () => invoke<[string, boolean][]>("omniswitch_health");

/** Env de roteamento pro agente: aponta as BASE_URL pro router e usa o token do router
 *  como "API key" do agente (o router valida e injeta a chave real do provider). Só
 *  claude-code/codex — CLIs que respeitam ANTHROPIC_BASE_URL/OPENAI_BASE_URL. */
export async function omniswitchEnv(): Promise<Array<[string, string]>> {
  const { baseUrl, token } = await omniswitchUrl();
  return [
    ["ANTHROPIC_BASE_URL", baseUrl],
    ["ANTHROPIC_API_KEY", token],
    ["OPENAI_BASE_URL", `${baseUrl}/v1`],
    ["OPENAI_API_KEY", token],
  ];
}
```

- [ ] **Step 2: Injetar no spawn quando a flag ON (Sidebar `spawnRole`)**

Em `Sidebar.tsx`, importar `getFlag` (de `@/lib/feature-flags`) + `omniswitchEnv` (de `@/lib/omniswitch-client`). Em `spawnRole`, ANTES dos `addTerminal`, montar o env do router e concatenar ao env existente quando a flag ON. Os `addTerminal` de `spawnRole` hoje passam `env: skillEnv.length > 0 ? skillEnv : undefined`. Trocar por um env combinado:

```ts
    const swEnv = getFlag("omniswitch") ? await omniswitchEnv().catch(() => []) : [];
    const combinedEnv = [...skillEnv, ...swEnv];
    // nos addTerminal: env: combinedEnv.length > 0 ? combinedEnv : undefined
```

Aplicar nos pontos de spawn claude-code de `spawnRole` (o `cli.systemPromptFlag` e o fallback). NÃO aplicar em `role === "shell"`. Com a flag OFF, `swEnv` é `[]` → `combinedEnv === skillEnv` → comportamento IDÊNTICO ao atual (invariante de não-regressão).

⚠️ Ajustar ao nome real da variável de env local (`skillEnv`) e à assinatura dos `addTerminal` no arquivo.

- [ ] **Step 3: Typecheck** — Run: `npx tsc -b` → EXIT 0.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/lib/omniswitch-client.ts apps/desktop/src/components/Sidebar.tsx
git commit -m "feat(omniswitch): injeta env do router no spawn quando a flag ON (gateway BASE_URL+token)"
```

---

### Task 5: UI mínima — `OmniSwitchModal`

**Files:** Create `apps/desktop/src/components/OmniSwitchModal.tsx`; Modify o pai que gerencia os modais de IA/Providers (onde `McpServersModal` é aberto).

- [ ] **Step 1: Modal com editor JSON + lista de saúde**

Create `apps/desktop/src/components/OmniSwitchModal.tsx`:

```tsx
import { useEffect, useState } from "react";
import { omniswitchConfigGet, omniswitchConfigSet, omniswitchHealth } from "@/lib/omniswitch-client";

/** UI mínima do OmniSwitch: edita a tabela de roteamento (JSON validado no backend) e
 *  mostra a saúde por chave. v1 é um editor JSON cru — editor visual = follow-up. */
export function OmniSwitchModal({ onClose }: { onClose: () => void }) {
  const [json, setJson] = useState("");
  const [health, setHealth] = useState<[string, boolean][]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    omniswitchConfigGet().then(setJson).catch(() => {});
    omniswitchHealth().then(setHealth).catch(() => {});
  }, []);

  async function save() {
    setErr(null);
    try {
      await omniswitchConfigSet(json);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
      setHealth(await omniswitchHealth());
    } catch (e) {
      setErr(String(e));
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="w-[720px] max-h-[80vh] overflow-auto rounded-lg border border-border bg-bg p-4" onClick={(e) => e.stopPropagation()}>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-text">OmniSwitch — roteamento de chave LLM</h2>
          <button onClick={onClose} className="text-textMuted hover:text-text">✕</button>
        </div>
        <p className="mb-2 text-[11px] text-textMuted">
          Tabela de roteamento (classes → alvos ordenados). Validada ao salvar. As chaves ficam no keychain (só o keyRef aqui).
        </p>
        <textarea
          value={json}
          onChange={(e) => setJson(e.target.value)}
          spellCheck={false}
          className="h-64 w-full rounded border border-border bg-surface p-2 font-mono text-[11px] text-text focus:outline-none focus:border-brand"
          placeholder='{"classes":{"code":[{"providerId":"groq","model":"llama-70b","keyRef":"credential.llm.groq"}]},"providers":{"groq":{"baseUrl":"https://api.groq.com","protocol":"openai"}}}'
        />
        {err && <div className="mt-1 text-[11px] text-danger">{err}</div>}
        <div className="mt-2 flex items-center gap-2">
          <button onClick={save} className="rounded bg-brand px-3 py-1 text-xs text-bg hover:bg-brand-hover">
            {saved ? "✓ salvo" : "Salvar"}
          </button>
        </div>
        <div className="mt-4">
          <h3 className="mb-1 text-[11px] font-semibold text-text">Saúde das chaves</h3>
          {health.length === 0 && <div className="text-[11px] text-textMuted opacity-60">Nenhuma chave na tabela ainda.</div>}
          {health.map(([k, ok]) => (
            <div key={k} className="flex items-center gap-2 text-[11px]">
              <span className={ok ? "text-green-400" : "text-amber-400"}>{ok ? "🟢" : "🟡"}</span>
              <span className="font-mono text-textMuted">{k}</span>
              <span className="text-textMuted opacity-60">{ok ? "disponível" : "esfriando"}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Abrir o modal a partir de um botão**

No componente pai que gerencia os modais (onde há `showMcpServers`/`<McpServersModal ...>`), adicionar `const [showOmniSwitch, setShowOmniSwitch] = useState(false)`, um item no menu Ferramentas → "🧠 IA & Provedores" que faz `setShowOmniSwitch(true)`, e renderizar `{showOmniSwitch && <OmniSwitchModal onClose={() => setShowOmniSwitch(false)} />}`. Seguir o padrão exato do `McpServersModal`.

- [ ] **Step 3: Typecheck** — Run: `npx tsc -b` → EXIT 0.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/components/OmniSwitchModal.tsx apps/desktop/src/components/<pai>.tsx
git commit -m "feat(omniswitch): UI mínima — editor da tabela + saúde das chaves (OmniSwitchModal)"
```

---

### Task 6: Regression guard do Plano 3

**Files:** nenhum

- [ ] **Step 1: Rust** — Run: `cargo test --lib` → PASS, 0 falhas. E `cargo check --release --lib` → `Finished`.
- [ ] **Step 2: Front** — Run: `npx tsc -b` (de `apps/desktop`) → EXIT 0.
- [ ] **Step 3: Nada a commitar se limpo.**

---

## Self-review (cobertura vs spec)

- Spec §4 (agente aponta pro router via env no spawn) → Task 4. ✅
- Spec §5 (UI: editor da tabela + painel de saúde) → Task 5. ✅ (editor JSON cru; visual drag-drop = follow-up, YAGNI no v1)
- Spec §6 (auth loopback; key só no forward) → Task 1 (auth de gateway) + Task 2 (`config_set` grava só keyRef, 0600). ✅
- Spec §7 (feature flag, default off, kill-switch) → Task 3 + Task 4 (flag OFF = comportamento atual idêntico). ✅

⚠️ **Honestidade (observado×validado):** o auth estendido tem unit test (validado). O resto — env no spawn, comandos, UI — é validável só por `cargo check`/`tsc` (compila) aqui; a prova PONTA-A-PONTA (um agente claude real subindo com a flag ON e roteando pelo OmniSwitch com fallback) é **runtime**, no app buildado. Até o build+teste manual, essa integração é **observada**, não validada.
- **Follow-up (Fase 2 do produto):** editor visual da tabela, relógio monotônico no cooldown (hoje `now_ms=0`), `/v1/models`+`count_tokens`, tradução cross-protocol, compressão encadeada, sync da tabela com o cofre OmniMemory.
