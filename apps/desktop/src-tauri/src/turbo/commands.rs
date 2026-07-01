//! Comandos Tauri do TURBO mode — finos: validam, persistem o estado inicial,
//! spawnam o loop (`driver::drive`) via `tauri::async_runtime::spawn` (NUNCA
//! `tokio::spawn` — lição v0.1.15) e leem o estado de disco (a fonte da verdade).
//!
//! Contrato (camelCase no IPC):
//!   - turbo_start(cwd, goal, condition, implementerCli, verifierCli, maxIter) → id
//!   - turbo_status(cwd, id) → TurboRun | null
//!   - turbo_list(cwd)       → TurboRun[]
//!   - turbo_stop(id)        → () (sinaliza cancelamento; o driver para limpo)

use std::sync::Arc;

use tauri::{AppHandle, State};

use super::driver::{self, gen_run_id};
use super::{list_runs, load_run, now_ms, save_run, turbo_dir, TurboRun, TurboState};

/// Teto máximo de iterações permitido (guardrail do guardrail — evita um maxIter
/// absurdo vindo da UI). 1..=MAX.
const MAX_ITER_CEIL: u32 = 50;

/// Roda uma condição de parada (comando shell) em `cwd` e devolve `{exit, output}`.
/// Reusa o `run_condition` do driver do TURBO — é o que o **Goal** do AgentNode usa pra
/// checar "pronto?" (exit 0) a cada turno, sem precisar do loop headless do TURBO inteiro.
/// `spawn_blocking`: o `run_condition` é síncrono (std::process) → não trava o reactor.
#[tauri::command]
pub async fn run_check(cwd: String, condition: String) -> Result<serde_json::Value, String> {
    let r = tokio::task::spawn_blocking(move || driver::run_condition(&cwd, &condition))
        .await
        .map_err(|e| format!("run_check panicou: {e}"))?;
    Ok(serde_json::json!({ "exit": r.exit, "output": r.output }))
}

/// Inicia um run TURBO: valida as entradas, gera um id, persiste o estado inicial
/// (status "running") e spawna o loop em background. Retorna o `id` imediatamente
/// (o progresso chega via `turbo://update` + persistência). NÃO bloqueia.
///
/// Validações: `goal`/`condition`/`implementerCli`/`verifierCli` não-vazios; maker ≠
/// checker NÃO é forçado a CLIs diferentes (o usuário pode usar o mesmo binário com
/// papéis distintos), mas a UI sugere distintos. `maxIter` clampeado em 1..=50.
#[tauri::command]
pub async fn turbo_start(
    app: AppHandle,
    state: State<'_, TurboState>,
    cwd: String,
    goal: String,
    condition: String,
    implementer_cli: String,
    verifier_cli: String,
    max_iter: u32,
) -> Result<String, String> {
    if goal.trim().is_empty() {
        return Err("o objetivo (goal) não pode ser vazio".into());
    }
    if condition.trim().is_empty() {
        return Err("a condição de parada não pode ser vazia".into());
    }
    if implementer_cli.trim().is_empty() {
        return Err("escolha um CLI implementer".into());
    }
    if verifier_cli.trim().is_empty() {
        return Err("escolha um CLI verifier".into());
    }
    if cwd.trim().is_empty() {
        return Err("nenhum projeto aberto (cwd vazio)".into());
    }

    let max_iter = max_iter.clamp(1, MAX_ITER_CEIL);

    let id = gen_run_id();
    let run = TurboRun::new(
        id.clone(),
        goal,
        condition,
        implementer_cli,
        verifier_cli,
        max_iter,
        now_ms(),
    );

    // Persiste o estado inicial ANTES de spawnar (a UI já consegue listá-lo).
    let dir = turbo_dir(&cwd);
    save_run(&dir, &run).map_err(|e| format!("não persistiu o estado inicial: {e}"))?;

    // Loop em background. `tauri::async_runtime::spawn` (NUNCA tokio::spawn).
    let cancels: Arc<super::TurboCancels> = Arc::clone(&state);
    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        driver::drive(app_clone, cwd, run, cancels).await;
    });

    Ok(id)
}

/// Lê o estado de UM run (`<cwd>/.omnirift/turbo/<id>.json`). `None` se não existe.
/// O disco é a fonte da verdade — reabrir o app/painel recarrega por aqui.
#[tauri::command]
pub async fn turbo_status(cwd: String, id: String) -> Result<Option<TurboRun>, String> {
    let dir = turbo_dir(&cwd);
    load_run(&dir, &id)
}

/// Lista todos os runs TURBO do projeto em `cwd`, mais recente primeiro.
#[tauri::command]
pub async fn turbo_list(cwd: String) -> Result<Vec<TurboRun>, String> {
    let dir = turbo_dir(&cwd);
    list_runs(&dir)
}

/// Sinaliza o cancelamento de um run pelo `id`. O driver checa ANTES de cada
/// iteração e para limpo (status "stopped"). Idempotente; sempre Ok (mesmo se o id
/// já terminou — vira no-op no driver).
#[tauri::command]
pub async fn turbo_stop(state: State<'_, TurboState>, id: String) -> Result<(), String> {
    state.cancel(&id);
    Ok(())
}
