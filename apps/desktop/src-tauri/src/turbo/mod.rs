//! TURBO mode — loop engineering autônomo (MVP, spec 2026-06-24).
//!
//! Goal + condição de parada VERIFICÁVEL (comando shell, exit 0 = pronto) → loop:
//! implementer headless tenta → roda a condição → se exit≠0 devolve o erro pro
//! implementer corrigir → repete até exit 0 OU bater o teto de iterações → aí um
//! **verifier SEPARADO** (outro agente) dá GO/NO-GO no diff. Estado em disco
//! (`<root>/.omnirift/turbo/<id>.json`). **Sem auto-commit** (checkpoint humano).
//!
//! Boundaries (espelha `health/`):
//!   - `mod.rs` = tipos serde + a DECISÃO PURA (`next_action`) + persistência (IO
//!     puro, testável) + a registry de cancelamento. Sem spawn de agente aqui.
//!   - `driver.rs` = a IO do loop (spawn implementer/verifier, roda a condição,
//!     emite eventos) — ENVOLVE a função pura, não a reimplementa.
//!
//! Lição v0.1.15: a task de fundo do loop usa `tauri::async_runtime::spawn`
//! (NUNCA `tokio::spawn` — panica fora do runtime). Ver `commands.rs`.
//!
//! Guardrails (spec §"Guardrails"): maker ≠ checker (CLIs distintos), condição
//! por exit-code (não "o agente acha que terminou"), teto de iterações, checkpoint
//! humano (sem auto-merge). Credencial nunca pelo IPC — o headless usa a
//! subscription do CLI (igual ao painel de Saúde).

pub mod commands;
pub mod driver;

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

/// Diretório (relativo ao root) onde o estado dos runs TURBO persiste.
/// Mesmo princípio do `health/ai.rs` REPORTS_DIR — dentro do projeto, gitignored.
pub const TURBO_DIR: &str = ".omnirift/turbo";

/// Uma iteração do loop: o implementer rodou, a condição foi avaliada.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TurboIter {
    /// Número da iteração (1-based).
    pub n: u32,
    /// stdout (truncado) do implementer nesta iteração.
    pub implementer_out: String,
    /// Exit code da condição (`None` se o processo não retornou código — ex.: sinal).
    pub condition_exit: Option<i32>,
    /// stdout+stderr (truncado) da condição nesta iteração.
    pub condition_out: String,
}

/// Estado completo de UM run TURBO — a FONTE DA VERDADE (persistida + emitida ao vivo).
///
/// `status`:
///   - `"running"`    — loop em andamento.
///   - `"passed"`     — a condição passou (exit 0); o verifier rodou e gravou `verdict`.
///   - `"failed_cap"` — bateu o teto de iterações sem a condição passar.
///   - `"stopped"`    — cancelado pelo usuário (`turbo_stop`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TurboRun {
    /// Id do run (também o nome do arquivo `<id>.json`).
    pub id: String,
    /// Goal em linguagem natural (o que o implementer deve fazer).
    pub goal: String,
    /// Condição de parada: comando shell cujo exit 0 = pronto.
    pub condition: String,
    /// CLI do implementer (ex.: "claude", "codex") — quem ESCREVE.
    pub implementer_cli: String,
    /// CLI do verifier (ex.: "claude", "codex") — quem APROVA (maker ≠ checker).
    pub verifier_cli: String,
    /// Teto de iterações (guardrail — para e reporta ao estourar).
    pub max_iter: u32,
    /// Estado atual ("running"|"passed"|"failed_cap"|"stopped").
    pub status: String,
    /// Iterações já executadas (cada uma persistida ao concluir).
    pub iterations: Vec<TurboIter>,
    /// Parecer do verifier (GO/NO-GO + motivo) — `None` até o loop parar com sucesso.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verdict: Option<String>,
    /// Carimbo de criação em epoch millis.
    pub created_at_ms: u64,
}

impl TurboRun {
    /// Estado inicial de um run (status "running", sem iterações ainda).
    pub fn new(
        id: String,
        goal: String,
        condition: String,
        implementer_cli: String,
        verifier_cli: String,
        max_iter: u32,
        created_at_ms: u64,
    ) -> Self {
        Self {
            id,
            goal,
            condition,
            implementer_cli,
            verifier_cli,
            max_iter,
            status: "running".to_string(),
            iterations: Vec::new(),
            verdict: None,
            created_at_ms,
        }
    }
}

/// A próxima ação que o driver deve tomar — decidida PURAMENTE a partir do exit da
/// condição + a contagem de iterações vs o teto. Sem IO; testável em isolamento.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    /// A condição passou (exit 0) → rodar o verifier (parecer final GO/NO-GO).
    RunVerifier,
    /// A condição falhou e ainda há orçamento (`iter < max`) → nova iteração.
    Reiterate,
    /// Bateu o teto de iterações sem a condição passar → para e reporta.
    StopCap,
}

/// **Decisão PURA do loop** (spec §"Decisão PURA e testável").
///
/// - `exit_code == Some(0)` → `RunVerifier` (a condição é verdade; o checker decide).
/// - `exit_code != 0` (ou `None`) **e** `iter < max_iter` → `Reiterate`.
/// - caso contrário (`iter >= max_iter`, condição ainda falhando) → `StopCap`.
///
/// `iter` é o nº de iterações JÁ executadas (1-based no fim de cada passo). Sem IO:
/// o driver chama isto depois de rodar a condição e age conforme o `Action`.
pub fn next_action(exit_code: Option<i32>, iter: u32, max_iter: u32) -> Action {
    if exit_code == Some(0) {
        return Action::RunVerifier;
    }
    if iter < max_iter {
        Action::Reiterate
    } else {
        Action::StopCap
    }
}

/// Registry de cancelamento — ids dos runs que o usuário pediu pra parar
/// (`turbo_stop`). State PURO (Mutex<HashSet>) — sem thread/IO no construtor, então
/// `app.manage` disto no boot nunca panica (lição v0.1.15). O driver consulta
/// `is_cancelled` ANTES de cada iteração e para limpo (status "stopped").
#[derive(Default)]
pub struct TurboCancels(pub Mutex<HashSet<String>>);

impl TurboCancels {
    pub fn new() -> Self {
        Self::default()
    }

    /// Marca um run pra cancelamento (idempotente).
    pub fn cancel(&self, id: &str) {
        self.0.lock().insert(id.to_string());
    }

    /// `true` se o run foi marcado pra cancelamento.
    pub fn is_cancelled(&self, id: &str) -> bool {
        self.0.lock().contains(id)
    }

    /// Limpa a marca (chamado pelo driver ao terminar — não vaza ids mortos).
    pub fn clear(&self, id: &str) {
        self.0.lock().remove(id);
    }
}

/// State compartilhado da Tauri pro TURBO — só a registry de cancelamento (o estado
/// de cada run vive em disco, a fonte da verdade). `Arc` pra clonar pro driver.
pub type TurboState = Arc<TurboCancels>;

// ───────────────────────────── persistência ─────────────────────────────
//
// Espelha o estilo do `health/ai.rs`: grava em `<root>/.omnirift/turbo/<id>.json`
// via serde, e separa a IO em fns puras testáveis (`save_run`/`load_run`/`list_runs`)
// das `#[tauri::command]`. Cada passo do loop re-grava o estado COMPLETO → sobrevive
// a fechar o app (igual ao painel de Saúde).

/// Diretório absoluto dos runs sob o root (`<root>/.omnirift/turbo`).
pub fn turbo_dir(root: &str) -> PathBuf {
    Path::new(root).join(TURBO_DIR)
}

/// Epoch em millis (UTC) — vai no `created_at_ms`. Fail-soft: relógio antes da
/// epoch (impossível na prática) → 0.
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// **Helper puro testável.** Grava o `TurboRun` em `<dir>/<id>.json` (cria o `dir`
/// se preciso). Re-grava o estado COMPLETO a cada chamada (idempotente por id).
pub fn save_run(dir: &Path, run: &TurboRun) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("não criou {}: {e}", dir.display()))?;
    let json = serde_json::to_string_pretty(run).map_err(|e| format!("serializar run: {e}"))?;
    std::fs::write(dir.join(format!("{}.json", run.id)), json)
        .map_err(|e| format!("escrever run {}: {e}", run.id))
}

/// **Helper puro testável.** Lê `<dir>/<id>.json` se existir (`None` se não há).
pub fn load_run(dir: &Path, id: &str) -> Result<Option<TurboRun>, String> {
    let path = dir.join(format!("{id}.json"));
    if !path.is_file() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("ler run {id}: {e}"))?;
    let run: TurboRun = serde_json::from_str(&raw).map_err(|e| format!("run inválido {id}: {e}"))?;
    Ok(Some(run))
}

/// **Helper puro testável.** Lista todos os runs de `dir` (cada `<id>.json` válido),
/// ordenados por `created_at_ms` desc (mais recente primeiro). `dir` inexistente →
/// vazio. Arquivos ilegíveis/inválidos são pulados (não derrubam a listagem).
pub fn list_runs(dir: &Path) -> Result<Vec<TurboRun>, String> {
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut out: Vec<TurboRun> = Vec::new();
    let entries = std::fs::read_dir(dir).map_err(|e| format!("ler {}: {e}", dir.display()))?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.strip_suffix(".json").is_none() {
            continue;
        }
        let raw = match std::fs::read_to_string(entry.path()) {
            Ok(r) => r,
            Err(_) => continue,
        };
        match serde_json::from_str::<TurboRun>(&raw) {
            Ok(run) => out.push(run),
            Err(_) => continue,
        }
    }
    // Mais recente primeiro (desc por created_at_ms).
    out.sort_by_key(|r| std::cmp::Reverse(r.created_at_ms));
    Ok(out)
}

/// Trunca uma string de saída de agente/condição pra um teto de bytes (respeitando
/// boundaries UTF-8), anexando um marcador. Mantém o estado em disco enxuto e o
/// payload do evento leve — a UI mostra o stdout truncado, não o log inteiro.
pub fn truncate_out(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    // Acha o maior boundary de char <= max (não corta no meio de um codepoint).
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n…[truncado, {} bytes no total]", &s[..end], s.len())
}

/// Teto de bytes pra cada saída persistida/emitida (implementer + condição).
pub const OUT_CAP: usize = 16 * 1024;

#[cfg(test)]
mod tests {
    use super::*;

    // ───────────────────── decisão pura (next_action) ─────────────────────

    #[test]
    fn next_action_exit_zero_runs_verifier() {
        // Condição passou → verifier, INDEPENDENTE da contagem de iterações.
        assert_eq!(next_action(Some(0), 1, 6), Action::RunVerifier);
        assert_eq!(next_action(Some(0), 6, 6), Action::RunVerifier, "exit 0 vence o teto");
        assert_eq!(next_action(Some(0), 0, 0), Action::RunVerifier);
    }

    #[test]
    fn next_action_failure_under_cap_reiterates() {
        assert_eq!(next_action(Some(1), 1, 6), Action::Reiterate);
        assert_eq!(next_action(Some(2), 5, 6), Action::Reiterate, "iter<max → re-itera");
        assert_eq!(next_action(None, 3, 6), Action::Reiterate, "sem exit code = falha");
    }

    #[test]
    fn next_action_failure_at_cap_stops() {
        assert_eq!(next_action(Some(1), 6, 6), Action::StopCap, "iter==max → para");
        assert_eq!(next_action(Some(1), 7, 6), Action::StopCap, "iter>max → para");
        assert_eq!(next_action(None, 6, 6), Action::StopCap);
    }

    #[test]
    fn next_action_max_iter_one_boundary() {
        // max=1: 1ª iteração falhou → já bateu o teto.
        assert_eq!(next_action(Some(1), 1, 1), Action::StopCap);
        // mas se passou, roda verifier mesmo no teto.
        assert_eq!(next_action(Some(0), 1, 1), Action::RunVerifier);
    }

    // ───────────────────── cancelamento ─────────────────────

    #[test]
    fn cancels_set_get_clear() {
        let c = TurboCancels::new();
        assert!(!c.is_cancelled("r1"));
        c.cancel("r1");
        assert!(c.is_cancelled("r1"));
        c.cancel("r1"); // idempotente
        assert!(c.is_cancelled("r1"));
        c.clear("r1");
        assert!(!c.is_cancelled("r1"));
    }

    // ───────────────────── persistência ─────────────────────

    fn sample_run(id: &str, created: u64) -> TurboRun {
        let mut r = TurboRun::new(
            id.to_string(),
            "fix the bug".into(),
            "cargo test".into(),
            "claude".into(),
            "codex".into(),
            6,
            created,
        );
        r.iterations.push(TurboIter {
            n: 1,
            implementer_out: "did the thing".into(),
            condition_exit: Some(1),
            condition_out: "test failed".into(),
        });
        r
    }

    #[test]
    fn save_load_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        let run = sample_run("abc", 1000);

        save_run(d, &run).unwrap();
        assert!(d.join("abc.json").is_file(), "JSON gravado");

        let loaded = load_run(d, "abc").unwrap().unwrap();
        assert_eq!(loaded, run, "round-trip idêntico");
        assert_eq!(loaded.status, "running");
        assert_eq!(loaded.iterations.len(), 1);
    }

    #[test]
    fn save_overwrites_same_id() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        let mut run = sample_run("x", 5);
        save_run(d, &run).unwrap();

        run.status = "passed".into();
        run.verdict = Some("GO: faz sentido".into());
        save_run(d, &run).unwrap();

        let loaded = load_run(d, "x").unwrap().unwrap();
        assert_eq!(loaded.status, "passed", "estado mais recente sobrescreve");
        assert_eq!(loaded.verdict.as_deref(), Some("GO: faz sentido"));
    }

    #[test]
    fn load_none_when_absent() {
        let dir = tempfile::tempdir().unwrap();
        assert!(load_run(dir.path(), "nope").unwrap().is_none());
    }

    #[test]
    fn list_orders_by_created_desc() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        save_run(d, &sample_run("a", 100)).unwrap();
        save_run(d, &sample_run("b", 300)).unwrap();
        save_run(d, &sample_run("c", 200)).unwrap();

        let list = list_runs(d).unwrap();
        assert_eq!(list.len(), 3);
        assert_eq!(list[0].id, "b", "mais recente primeiro");
        assert_eq!(list[1].id, "c");
        assert_eq!(list[2].id, "a");
    }

    #[test]
    fn list_empty_when_dir_absent() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("nope");
        assert!(list_runs(&missing).unwrap().is_empty());
    }

    #[test]
    fn list_skips_invalid_json() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        save_run(d, &sample_run("good", 1)).unwrap();
        std::fs::write(d.join("bad.json"), "{ not valid").unwrap();
        std::fs::write(d.join("ignore.txt"), "x").unwrap();

        let list = list_runs(d).unwrap();
        assert_eq!(list.len(), 1, "só o válido entra");
        assert_eq!(list[0].id, "good");
    }

    // ───────────────────── truncate ─────────────────────

    #[test]
    fn truncate_keeps_short_output() {
        assert_eq!(truncate_out("ok", 100), "ok");
    }

    #[test]
    fn truncate_caps_long_output_at_char_boundary() {
        let s = "a".repeat(50);
        let out = truncate_out(&s, 10);
        assert!(out.starts_with("aaaaaaaaaa"));
        assert!(out.contains("truncado"));
        assert!(out.contains("50 bytes"));
    }

    #[test]
    fn truncate_respects_utf8_boundary() {
        // "é" são 2 bytes — cortar em 1 byte cairia no meio; deve recuar.
        let s = "ééééé"; // 10 bytes
        let out = truncate_out(s, 3); // boundary mais próximo <= 3 é 2
        assert!(out.starts_with('é'), "não corta no meio do codepoint");
        assert!(out.contains("truncado"));
    }

    #[test]
    fn run_new_starts_running_no_verdict() {
        let r = TurboRun::new("z".into(), "g".into(), "true".into(), "claude".into(), "codex".into(), 6, 0);
        assert_eq!(r.status, "running");
        assert!(r.verdict.is_none());
        assert!(r.iterations.is_empty());
    }
}
