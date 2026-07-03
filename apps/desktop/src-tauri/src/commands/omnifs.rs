//! Comandos Tauri do OmniFS (F1+F2) — status/provisão/snapshot/timeline/restauração.
//!
//! Todos async + `spawn_blocking`: o cliente do socket e o `ensure_daemon` (retry
//! de até 5s) são bloqueantes e não podem segurar o runtime do Tauri.
//!
//! ⚠️ `omnifs_rollback` NÃO existe pros agentes (bloqueado via DENY_DESTRUCTIVE);
//! o comando daqui é o ÚNICO caminho — humano, atrás da confirmação em 2 passos
//! do OmniFsModal.

use serde::Serialize;

use crate::omnifs::{DaemonStatus, LogEntry};

/// Estado do OmniFS (binário/daemon/socket/mount/tamanhos) — alimenta o modal
/// "OmniFS — Pasta de agentes" e o chip de status do rodapé (poll de 30s).
#[tauri::command]
pub async fn omnifs_status() -> DaemonStatus {
    tauri::async_runtime::spawn_blocking(crate::omnifs::daemon_status)
        .await
        .unwrap_or_default()
}

/// Cria a "Pasta de Projetos OmniFS" (store `~/.omnirift/omnifs-drive` + mount
/// default `~/OmniRift/Projetos`), grava a config e sobe/reusa o daemon.
#[tauri::command]
pub async fn omnifs_provision(mount_dir: Option<String>) -> Result<DaemonStatus, String> {
    tauri::async_runtime::spawn_blocking(move || crate::omnifs::provision(mount_dir))
        .await
        .map_err(|e| e.to_string())?
}

/// Snapshot AGORA (mensagem opcional) — devolve "snapshot: <hash>" e registra o
/// hash completo no ledger local (habilita o Restaurar da timeline).
#[tauri::command]
pub async fn omnifs_snapshot_now(message: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::omnifs::snapshot_now(message.as_deref().unwrap_or(""))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Timeline de snapshots (mais recente primeiro): `omnifs_log` do daemon + hash
/// completo do ledger local quando o snapshot foi tirado pelo OmniRift.
#[tauri::command]
pub async fn omnifs_log() -> Result<Vec<LogEntry>, String> {
    tauri::async_runtime::spawn_blocking(crate::omnifs::snapshot_log)
        .await
        .map_err(|e| e.to_string())?
}

/// Restaura o drive INTEIRO pra um commit (hash COMPLETO, 64 hex). Destrutivo e
/// global — chamado só pelo OmniFsModal após confirmação em 2 passos.
#[tauri::command]
pub async fn omnifs_rollback(commit: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || crate::omnifs::rollback_full(&commit))
        .await
        .map_err(|e| e.to_string())?
}

/// O `cwd` está dentro de um mount OmniFS VIVO? Usado pela automação F3 do front
/// (snapshot pré-onda no Montar + re-index debounced no turn-done) pra só disparar
/// quando o projeto de fato vive no OmniFS. Barato (1 read de JSON + 1 connect local).
#[tauri::command]
pub async fn omnifs_is_managed_cwd(cwd: String) -> bool {
    tauri::async_runtime::spawn_blocking(move || crate::omnifs::is_managed_cwd(&cwd))
        .await
        .unwrap_or(false)
}

/// (Re)indexa semanticamente o drive — full-scan (pode demorar em drives grandes).
#[tauri::command]
pub async fn omnifs_reindex() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        crate::omnifs::call("omnifs_index", serde_json::json!({}))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Um hit da busca semântica do OmniFS: `score` cosseno (mais alto = mais
/// relevante) + `file` (caminho no drive) + `preview` (trecho do arquivo).
/// camelCase pro front (`SearchHit` no omnifs-client.ts).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub score: f64,
    pub file: String,
    pub preview: String,
}

/// Parseia o texto do `omnifs_search` do daemon. Cada linha vem formatada como
/// `"{score:.3}  {path}  — {snippet}"` (ver handle_tool_call em omnifs-mcp:
/// score, DOIS espaços, path, `  — `, snippet com `\n`→espaço). Linhas sem score
/// numérico — ex.: "nenhum resultado (índice vazio? …)" — são ignoradas, então
/// índice vazio devolve `[]` limpo em vez de um hit falso.
fn parse_search_text(text: &str) -> Vec<SearchHit> {
    text.lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|line| {
            let (score_s, rest) = line.split_once("  ")?;
            let score: f64 = score_s.trim().parse().ok()?;
            let (file, preview) = match rest.split_once("  — ") {
                Some((f, p)) => (f.trim().to_string(), p.trim().to_string()),
                None => (rest.trim().to_string(), String::new()),
            };
            Some(SearchHit { score, file, preview })
        })
        .collect()
}

/// Busca semântica no drive OmniFS por SIGNIFICADO ("onde está a lógica de auth",
/// não `*.py`) — roteia pela tool `omnifs_search` do daemon (mesmo socket do
/// log/snapshot). Requer daemon vivo: sem ele, erro amigável pedindo pra
/// provisionar a Pasta de Projetos (em vez do "daemon não está no ar" cru do
/// cliente). Query vazia → `[]` sem tocar o socket.
#[tauri::command]
pub async fn omnifs_search(query: String) -> Result<Vec<SearchHit>, String> {
    let query = query.trim().to_string();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    tauri::async_runtime::spawn_blocking(move || {
        if !crate::omnifs::socket_alive(&crate::omnifs::socket_path()) {
            return Err("OmniFS: provisione a Pasta de Projetos OmniFS (Ferramentas → \
                        \"OmniFS — Pasta de agentes\") — o daemon precisa estar no ar \
                        pra busca semântica."
                .to_string());
        }
        let text = crate::omnifs::call("omnifs_search", serde_json::json!({ "query": query }))?;
        Ok(parse_search_text(&text))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_search_text_linhas_do_daemon() {
        // Formato real: "{score:.3}  {path}  — {snippet}".
        let text = "0.842  src/auth/login.rs  — valida o token JWT e cria a sessão\n\
                    0.611  src/db/users.rs  — busca o usuário por email";
        let hits = parse_search_text(text);
        assert_eq!(hits.len(), 2);
        assert!((hits[0].score - 0.842).abs() < 1e-9);
        assert_eq!(hits[0].file, "src/auth/login.rs");
        assert_eq!(hits[0].preview, "valida o token JWT e cria a sessão");
        assert_eq!(hits[1].file, "src/db/users.rs");
    }

    #[test]
    fn parse_search_text_ignora_indice_vazio_e_lixo() {
        // "nenhum resultado …" não tem score numérico → nada de hit falso.
        assert!(parse_search_text("nenhum resultado (índice vazio? rode omnifs_index antes)").is_empty());
        assert!(parse_search_text("").is_empty());
        assert!(parse_search_text("   \n  \n").is_empty());
    }

    #[test]
    fn parse_search_text_linha_sem_snippet() {
        // Defensivo: sem o separador "  — " o resto todo vira file, preview vazio.
        let hits = parse_search_text("0.500  docs/README.md");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].file, "docs/README.md");
        assert_eq!(hits[0].preview, "");
    }
}
