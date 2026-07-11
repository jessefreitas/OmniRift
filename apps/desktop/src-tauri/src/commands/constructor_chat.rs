//! Sessão Claude PERSISTENTE pro modo Conversar do Constructor.
//!
//! Um processo `claude` headless (stream-json) fica VIVO em background — invisível ao
//! canvas (não é um nó/PTY). A 1ª msg paga o boot; as seguintes reusam a sessão (sem
//! cold-start). Streaming: a task de leitura do stdout emite cada pedaço de texto via
//! `constructor://chat-delta` e finaliza em `constructor://chat-done` (texto completo).
//! `--strict-mcp-config` = zero MCP (conversa não usa tools; corta latência por turno).

use std::process::Stdio;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::Mutex;

/// State gerenciado pelo Tauri: o processo copiloto atual (ou nenhum).
#[derive(Default)]
pub struct ConstructorChat(pub Mutex<Option<ChatProc>>);

pub struct ChatProc {
    child: Child,
    stdin: ChildStdin,
    cwd: String,
    cli: String,
}

/// Spawna o processo claude persistente e liga a task que lê o stdout e emite os deltas.
/// `persona` (system prompt do copiloto) entra UMA vez aqui — não se repete por mensagem.
async fn spawn_proc(app: &AppHandle, cli: &str, cwd: &str, persona: &str) -> Result<ChatProc, String> {
    let mut cmd = Command::new(cli);
    cmd.args([
        "--print",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--strict-mcp-config",
        "--dangerously-skip-permissions",
    ]);
    if !persona.is_empty() {
        cmd.args(["--append-system-prompt", persona]);
    }
    let mut child = cmd
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("não consegui iniciar `{cli}`: {e}"))?;

    let stdin = child.stdin.take().ok_or("sem stdin")?;
    let stdout = child.stdout.take().ok_or("sem stdout")?;

    let app2 = app.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(ev) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            match ev.get("type").and_then(|v| v.as_str()) {
                Some("stream_event") => {
                    let delta = ev.get("event").and_then(|e| e.get("delta"));
                    let is_text =
                        delta.and_then(|d| d.get("type")).and_then(|t| t.as_str()) == Some("text_delta");
                    if is_text {
                        if let Some(t) = delta.and_then(|d| d.get("text")).and_then(|t| t.as_str()) {
                            let _ = app2.emit("constructor://chat-delta", t);
                        }
                    }
                }
                Some("result") => {
                    let full = ev.get("result").and_then(|r| r.as_str()).unwrap_or("");
                    let _ = app2.emit("constructor://chat-done", full);
                }
                _ => {}
            }
        }
        // stdout fechou → o processo morreu; o front recria no próximo send.
        let _ = app2.emit("constructor://chat-dead", ());
    });

    Ok(ChatProc {
        child,
        stdin,
        cwd: cwd.to_string(),
        cli: cli.to_string(),
    })
}

/// Envia uma mensagem pro copiloto. Garante o processo (spawna se não há / cwd|cli mudou
/// / morreu) e escreve a msg no stdin. A resposta chega via os eventos `constructor://chat-*`.
#[tauri::command]
pub async fn constructor_chat_send(
    app: AppHandle,
    state: State<'_, ConstructorChat>,
    input: String,
    cli: Option<String>,
    cwd: Option<String>,
    persona: Option<String>,
) -> Result<(), String> {
    let cli = cli.unwrap_or_else(|| "claude".into());
    let cwd = cwd.filter(|c| !c.is_empty()).unwrap_or_else(|| ".".into());
    let persona = persona.unwrap_or_default();
    let mut guard = state.0.lock().await;

    let needs_spawn = match guard.as_mut() {
        None => true,
        Some(p) => {
            p.cwd != cwd || p.cli != cli || matches!(p.child.try_wait(), Ok(Some(_)) | Err(_))
        }
    };
    if needs_spawn {
        *guard = Some(spawn_proc(&app, &cli, &cwd, &persona).await?);
    }

    let proc = guard.as_mut().unwrap();
    let msg =
        serde_json::json!({ "type": "user", "message": { "role": "user", "content": input } });
    let line = format!("{msg}\n");
    let res = async {
        proc.stdin.write_all(line.as_bytes()).await?;
        proc.stdin.flush().await
    }
    .await;
    if let Err(e) = res {
        *guard = None; // pipe quebrado → recria no próximo send
        return Err(format!("sessão do copiloto caiu ({e}) — mande de novo"));
    }
    Ok(())
}

/// Encerra a sessão do copiloto (ao fechar o Constructor / trocar de projeto).
#[tauri::command]
pub async fn constructor_chat_close(state: State<'_, ConstructorChat>) -> Result<(), String> {
    if let Some(mut p) = state.0.lock().await.take() {
        let _ = p.child.start_kill();
    }
    Ok(())
}
