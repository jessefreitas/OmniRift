//! Driver do loop TURBO — a IO que ENVOLVE a decisão pura (`super::next_action`).
//!
//! Fluxo de uma iteração:
//!   1. cancelado? → para limpo (status "stopped").
//!   2. implementer headless (goal + no re-itera o erro da condição anterior) →
//!      `super::run_headless_agent` (helper compartilhado com o painel de Saúde).
//!   3. roda a condição via `sh -c` / `cmd /c` em `cwd`, captura exit + stdout/stderr
//!      (padrão de `commands/git.rs::parallel_run_hook`).
//!   4. persiste a iteração no estado + emite `turbo://update`.
//!   5. decide via `next_action(exit, iter, max)`:
//!      - RunVerifier → roda o verifier (CLI separado; maker ≠ checker) com o `git
//!        diff` + resultado da condição → grava `verdict`, status "passed".
//!      - Reiterate → próxima iteração (o erro da condição vira contexto pro implementer).
//!      - StopCap → status "failed_cap", para.
//!
//! **Nunca** commita/merge — o estado para no checkpoint humano (o Jesse revê o diff).
//! Credencial nunca pelo IPC: o headless usa a subscription do CLI.

use std::path::Path;
use std::sync::Arc;

use tauri::{AppHandle, Emitter};

use super::{
    next_action, now_ms, save_run, truncate_out, turbo_dir, Action, TurboCancels, TurboIter,
    TurboRun, OUT_CAP,
};
use crate::git;
use crate::health::ai::run_headless_agent;
use crate::proc_ext::NoWindow;

/// Evento Tauri emitido a cada passo do loop (a UI escuta `turbo://update`).
const UPDATE_EVENT: &str = "turbo://update";

/// Resultado de rodar a condição: exit code + saída combinada (stdout+stderr).
pub struct ConditionResult {
    pub exit: Option<i32>,
    pub output: String,
}

/// Roda a condição (comando shell) em `cwd` via `sh -c` (Unix) / `cmd /c` (Windows),
/// capturando o exit code + stdout/stderr combinados (padrão de `parallel_run_hook`).
/// Strip de LD_PRELOAD/GTK_MODULES (mesmo motivo dos PTYs; no-op no Windows). Falha
/// ao SPAWNAR (binário do shell ausente) vira exit `None` + a mensagem na saída — o
/// loop trata como "condição não passou" (não derruba o run).
pub fn run_condition(cwd: &str, condition: &str) -> ConditionResult {
    let mut cmd = if cfg!(windows) {
        let mut c = std::process::Command::new("cmd");
        c.arg("/C").arg(condition);
        c
    } else {
        let mut c = std::process::Command::new("sh");
        c.arg("-c").arg(condition);
        c
    };

    match cmd
        .current_dir(cwd)
        .env("LD_PRELOAD", "")
        .env("GTK_MODULES", "")
        .no_window()
        .output()
    {
        Ok(out) => {
            let mut s = String::from_utf8_lossy(&out.stdout).to_string();
            s.push_str(&String::from_utf8_lossy(&out.stderr));
            ConditionResult {
                exit: out.status.code(),
                output: s,
            }
        }
        Err(e) => ConditionResult {
            exit: None,
            output: format!("falha ao rodar a condição: {e}"),
        },
    }
}

/// Prompt do IMPLEMENTER. Inclui o goal + (a partir da 2ª iteração) o erro da
/// condição anterior pra ele corrigir. Pede explicitamente pra NÃO commitar.
pub fn build_implementer_prompt(
    goal: &str,
    condition: &str,
    prev_error: Option<&str>,
) -> String {
    let mut p = String::new();
    p.push_str(
        "Você é o IMPLEMENTER de um loop autônomo (TURBO mode) no OmniRift. Trabalhe no \
         diretório atual do projeto e implemente o objetivo abaixo.\n\n",
    );
    p.push_str(&format!("OBJETIVO:\n{goal}\n\n"));
    p.push_str(&format!(
        "CONDIÇÃO DE PRONTO (comando que DEVE sair com exit 0):\n{condition}\n\n"
    ));
    if let Some(err) = prev_error {
        p.push_str(
            "A tentativa anterior NÃO passou na condição. Saída do erro (corrija a causa raiz):\n",
        );
        p.push_str("```\n");
        p.push_str(err);
        p.push_str("\n```\n\n");
    }
    p.push_str(
        "Aplique as mudanças necessárias no código. NÃO faça commit nem merge (o humano \
         revisa o diff depois). Faça o mínimo necessário pra a condição passar.\n",
    );
    p
}

/// Prompt do VERIFIER (agente SEPARADO — maker ≠ checker). Recebe o `git diff` + o
/// resultado da condição e responde GO/NO-GO + motivo. Não escreve código.
pub fn build_verifier_prompt(goal: &str, condition: &str, diff: &str, condition_out: &str) -> String {
    let mut p = String::new();
    p.push_str(
        "Você é o VERIFIER de um loop autônomo (TURBO mode) no OmniRift. Você NÃO escreveu \
         este código — seu papel é dar um parecer independente (maker ≠ checker).\n\n",
    );
    p.push_str(&format!("OBJETIVO original:\n{goal}\n\n"));
    p.push_str(&format!("CONDIÇÃO de pronto:\n{condition}\n"));
    p.push_str("Resultado da condição (passou — exit 0):\n```\n");
    p.push_str(condition_out);
    p.push_str("\n```\n\n");
    p.push_str("DIFF das mudanças (git diff):\n```diff\n");
    p.push_str(diff);
    p.push_str("\n```\n\n");
    p.push_str(
        "Avalie: a condição realmente cobre o objetivo? A mudança faz sentido, é segura e não \
         tem gambiarra/atalho que burla a condição sem resolver de verdade? Responda começando \
         com 'GO' ou 'NO-GO' na primeira linha, seguido de um parágrafo curto justificando.\n",
    );
    p
}

/// Diff do worktree em `cwd` vs `base`, achatado em texto pro prompt do verifier.
/// `base` padrão = `HEAD` (mudanças não commitadas + working tree). Fail-soft: erro
/// vira uma nota no texto (o verifier ainda recebe o resultado da condição).
fn collect_diff(cwd: &str) -> String {
    match git::diff(Path::new(cwd), "HEAD") {
        Ok(d) => {
            let mut s = String::new();
            for f in &d.files {
                if !f.patch.is_empty() {
                    s.push_str(&f.patch);
                    s.push('\n');
                }
            }
            if !d.untracked.is_empty() {
                s.push_str("\n# Arquivos novos (untracked):\n");
                for u in &d.untracked {
                    s.push_str(&format!("# {u}\n"));
                }
            }
            if s.trim().is_empty() {
                "(sem mudanças no diff)".to_string()
            } else {
                s
            }
        }
        Err(e) => format!("(não consegui obter o diff: {e})"),
    }
}

/// Persiste o estado e emite `turbo://update` (a UI atualiza ao vivo). Falha de IO/
/// emit é soft — o loop continua (a UI recarrega via `turbo_list` se preciso).
fn persist_and_emit(app: &AppHandle, cwd: &str, run: &TurboRun) {
    let dir = turbo_dir(cwd);
    let _ = save_run(&dir, run);
    let _ = app.emit(UPDATE_EVENT, run);
}

/// **O loop.** Roda até a condição passar, bater o teto, ou ser cancelado. Persiste e
/// emite a cada passo. Ao parar com sucesso, roda o verifier e grava o `verdict`.
///
/// Recebe o estado inicial JÁ persistido (status "running") — re-grava o estado
/// completo a cada passo (sobrevive a fechar o app). `async` (chamado via
/// `tauri::async_runtime::spawn` no comando — NUNCA `tokio::spawn`).
pub async fn drive(app: AppHandle, cwd: String, mut run: TurboRun, cancels: Arc<TurboCancels>) {
    let mut prev_error: Option<String> = None;
    let mut iter: u32 = 0;

    loop {
        // Guardrail: cancelado pelo usuário → para limpo.
        if cancels.is_cancelled(&run.id) {
            run.status = "stopped".to_string();
            persist_and_emit(&app, &cwd, &run);
            cancels.clear(&run.id);
            return;
        }

        iter += 1;

        // 1. Implementer headless (helper compartilhado com Saúde). Erro de
        //    spawn/CLI ausente → grava na saída da iteração e segue pra condição
        //    (que vai falhar e disparar o fluxo normal de re-iteração/teto).
        let prompt = build_implementer_prompt(&run.goal, &run.condition, prev_error.as_deref());
        let implementer_out = match run_headless_agent(&run.implementer_cli, &prompt, &cwd).await {
            Ok(out) => out,
            Err(e) => {
                // CLI indisponível é fatal pro loop (degrade limpo, igual ao Saúde):
                // não há como progredir. Para e reporta na saída.
                run.iterations.push(TurboIter {
                    n: iter,
                    implementer_out: truncate_out(&e, OUT_CAP),
                    condition_exit: None,
                    condition_out: String::new(),
                });
                run.status = "failed_cap".to_string();
                run.verdict = Some(format!("NO-GO: agente indisponível — {e}"));
                persist_and_emit(&app, &cwd, &run);
                cancels.clear(&run.id);
                return;
            }
        };

        // 2. Roda a condição (exit code = a verdade).
        let cond = run_condition(&cwd, &run.condition);

        // 3. Persiste a iteração + emite.
        run.iterations.push(TurboIter {
            n: iter,
            implementer_out: truncate_out(&implementer_out, OUT_CAP),
            condition_exit: cond.exit,
            condition_out: truncate_out(&cond.output, OUT_CAP),
        });
        persist_and_emit(&app, &cwd, &run);

        // 4. Decide (PURO).
        match next_action(cond.exit, iter, run.max_iter) {
            Action::RunVerifier => {
                // Condição passou → verifier separado dá o parecer no diff.
                run.status = "passed".to_string();
                persist_and_emit(&app, &cwd, &run);

                let diff = collect_diff(&cwd);
                let vprompt =
                    build_verifier_prompt(&run.goal, &run.condition, &diff, &cond.output);
                let verdict = match run_headless_agent(&run.verifier_cli, &vprompt, &cwd).await {
                    Ok(out) => truncate_out(out.trim(), OUT_CAP),
                    Err(e) => format!("(verifier indisponível: {e})"),
                };
                run.verdict = Some(verdict);
                persist_and_emit(&app, &cwd, &run);
                cancels.clear(&run.id);
                return;
            }
            Action::Reiterate => {
                // O erro da condição vira contexto pro implementer corrigir.
                prev_error = Some(truncate_out(&cond.output, OUT_CAP));
                // segue o loop
            }
            Action::StopCap => {
                run.status = "failed_cap".to_string();
                run.verdict = Some(format!(
                    "NO-GO: bateu o teto de {} iterações sem a condição passar.",
                    run.max_iter
                ));
                persist_and_emit(&app, &cwd, &run);
                cancels.clear(&run.id);
                return;
            }
        }
    }
}

/// Gera um id de run estável-no-tempo: epoch millis + um sufixo aleatório curto, pra
/// não colidir entre runs iniciados no mesmo millis. Sem deps extras (usa o relógio +
/// o endereço do estado como entropia barata — basta pra unicidade local).
pub fn gen_run_id() -> String {
    let ms = now_ms();
    // Entropia barata: contador atômico de processo (monotônico).
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    format!("turbo-{ms:x}-{seq:x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn condition_true_exits_zero() {
        let dir = tempfile::tempdir().unwrap();
        let r = run_condition(&dir.path().to_string_lossy(), "true");
        assert_eq!(r.exit, Some(0), "`true` sai com 0");
    }

    #[test]
    fn condition_false_exits_nonzero() {
        let dir = tempfile::tempdir().unwrap();
        let r = run_condition(&dir.path().to_string_lossy(), "false");
        assert_ne!(r.exit, Some(0), "`false` não sai com 0");
    }

    #[test]
    fn condition_captures_output() {
        let dir = tempfile::tempdir().unwrap();
        // echo pra stdout — funciona tanto no sh quanto no cmd.
        let r = run_condition(&dir.path().to_string_lossy(), "echo turbo_marker");
        assert_eq!(r.exit, Some(0));
        assert!(r.output.contains("turbo_marker"), "captura o stdout");
    }

    #[test]
    fn condition_runs_in_cwd() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("sentinel.txt"), "x").unwrap();
        // Condição que só passa se o cwd for o tempdir (o arquivo existe lá).
        let probe = if cfg!(windows) {
            "if exist sentinel.txt (exit 0) else (exit 1)"
        } else {
            "test -f sentinel.txt"
        };
        let r = run_condition(&dir.path().to_string_lossy(), probe);
        assert_eq!(r.exit, Some(0), "a condição roda no cwd dado");
    }

    #[test]
    fn implementer_prompt_includes_goal_and_condition() {
        let p = build_implementer_prompt("fix the bug", "cargo test", None);
        assert!(p.contains("fix the bug"));
        assert!(p.contains("cargo test"));
        assert!(p.contains("NÃO faça commit"), "instrui a não commitar");
        assert!(!p.contains("tentativa anterior"), "1ª iter sem erro anterior");
    }

    #[test]
    fn implementer_prompt_includes_prev_error_on_reiterate() {
        let p = build_implementer_prompt("g", "c", Some("error: expected ;"));
        assert!(p.contains("tentativa anterior"), "re-iter inclui o erro");
        assert!(p.contains("error: expected ;"));
    }

    #[test]
    fn verifier_prompt_includes_diff_and_go_nogo() {
        let p = build_verifier_prompt("g", "c", "diff --git a/x b/x", "test ok");
        assert!(p.contains("diff --git a/x b/x"), "inclui o diff");
        assert!(p.contains("test ok"), "inclui o resultado da condição");
        assert!(p.contains("GO") && p.contains("NO-GO"), "pede GO/NO-GO");
        assert!(p.contains("maker ≠ checker") || p.contains("NÃO escreveu"), "reforça independência");
    }

    #[test]
    fn gen_run_id_unique_and_prefixed() {
        let a = gen_run_id();
        let b = gen_run_id();
        assert!(a.starts_with("turbo-"));
        assert_ne!(a, b, "ids consecutivos não colidem");
    }
}
