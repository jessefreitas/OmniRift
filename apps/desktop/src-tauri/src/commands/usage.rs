//! Uso de tokens — agrega a usage REAL gravada pelos agentes nos arquivos de
//! sessão dos CLIs (read-only; o dado já existe no disco) + o ledger NATIVO das
//! chamadas LLM do próprio OmniRift (review/companion/test). Cobre:
//!  - Claude Code: ~/.claude/projects/<slug>/<uuid>.jsonl (usage por mensagem).
//!  - Codex (OpenAI): ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl (total_token_usage
//!    cumulativo por sessão — pega o último).
//!  - Ledger nativo (tabela llm_ledger): chamadas que o próprio OmniRift fez.
//! Gemini/Antigravity não logam token nos transcripts → ficam de fora.
//! Total geral + nativo + por modelo/LLM + por projeto (cwd), com estimativa de
//! custo (USD) e filtro por período (hoje / N dias / tudo). Orçamento mensal por
//! projeto com status ok/warn/over.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use chrono::{Datelike, Duration, Utc};
use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::db::Db;

#[derive(Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Tally {
    calls: i64,
    input_tokens: i64,
    output_tokens: i64,
    cache_read_tokens: i64,
    cache_creation_tokens: i64,
    total_tokens: i64,
    cost_usd: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsage {
    model: String,
    #[serde(flatten)]
    tally: Tally,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectUsage {
    /// cwd do projeto (caminho); o frontend mostra o basename.
    project: String,
    #[serde(flatten)]
    tally: Tally,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageReport {
    total: Tally,
    /// Subconjunto do total: só as chamadas NATIVAS do OmniRift (ledger).
    native: Tally,
    by_model: Vec<ModelUsage>,
    by_project: Vec<ProjectUsage>,
    sessions: i64,
}

/// Status de orçamento de um projeto (gasto do mês corrente vs limite).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetStatus {
    /// chave do orçamento (cwd ou nome; casa com `project` do by_project).
    project: String,
    monthly_usd: f64,
    alert_pct: i64,
    /// Gasto do mês corrente (CLI + nativo) atribuído a esse projeto.
    spent_usd: f64,
    pct: f64,
    /// "ok" | "warn" | "over".
    status: String,
}

/// Preço USD por 1M tokens (input, output). cache_read ≈ 0.1×input, cache_write ≈
/// 1.25×input. Estimativa — preços mudam; é indicador, não fatura.
pub fn price(model: &str) -> (f64, f64) {
    let m = model.to_lowercase();
    if m.contains("opus") {
        (15.0, 75.0)
    } else if m.contains("sonnet") {
        (3.0, 15.0)
    } else if m.contains("haiku") {
        (0.8, 4.0)
    } else if m.contains("gpt-5") || m.contains("gpt5") {
        (1.25, 10.0)
    } else if m.contains("gpt-4o-mini") {
        (0.15, 0.6)
    } else if m.contains("gpt-4o") || m.contains("gpt-4.1") {
        (2.5, 10.0)
    } else if m.contains("gemini") {
        (1.25, 5.0)
    } else {
        (0.0, 0.0)
    }
}

/// Custo USD estimado de uma chamada. Compartilhado com o ledger nativo (llm.rs)
/// pra a estimativa ser idêntica em todo lugar.
pub fn cost_usd(model: &str, inp: i64, out: i64, cr: i64, cc: i64) -> f64 {
    let (pin, pout) = price(model);
    (inp as f64 * pin + out as f64 * pout + cr as f64 * pin * 0.1 + cc as f64 * pin * 1.25)
        / 1_000_000.0
}

fn bump(t: &mut Tally, calls: i64, inp: i64, out: i64, cr: i64, cc: i64, model: &str) {
    t.calls += calls;
    t.input_tokens += inp;
    t.output_tokens += out;
    t.cache_read_tokens += cr;
    t.cache_creation_tokens += cc;
    t.total_tokens += inp + out + cr + cc;
    t.cost_usd += cost_usd(model, inp, out, cr, cc);
}

#[derive(Default)]
struct Agg {
    total: Tally,
    models: HashMap<String, Tally>,
    projects: HashMap<String, Tally>,
    sessions: i64,
}

impl Agg {
    /// `inp` = input NÃO-cacheado; `cr`/`cc` = cache read/creation (separados).
    fn add(&mut self, cwd: &str, model: &str, calls: i64, inp: i64, out: i64, cr: i64, cc: i64) {
        bump(&mut self.total, calls, inp, out, cr, cc, model);
        bump(self.models.entry(model.to_string()).or_default(), calls, inp, out, cr, cc, model);
        bump(self.projects.entry(cwd.to_string()).or_default(), calls, inp, out, cr, cc, model);
    }
}

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

/// Extrai a string logo após `needle` (ex.: `"model":"` → o valor até a próxima `"`).
fn str_after<'a>(s: &'a str, needle: &str) -> Option<&'a str> {
    let i = s.find(needle)? + needle.len();
    let rest = &s[i..];
    let end = rest.find('"')?;
    Some(&rest[..end])
}

fn get_i64(v: &Value, key: &str) -> i64 {
    v.get(key).and_then(|x| x.as_i64()).unwrap_or(0)
}

/// Cutoff ISO19 ("YYYY-MM-DDTHH:MM:SS") em UTC pro filtro de período.
/// `None` = tudo; `Some(0)` = início de hoje; `Some(n)` = agora − n dias.
fn cutoff_for(since_days: Option<i64>) -> Option<String> {
    let n = since_days?;
    let now = Utc::now();
    let dt = if n <= 0 {
        now.date_naive().and_hms_opt(0, 0, 0)?.and_utc()
    } else {
        now - Duration::days(n)
    };
    Some(dt.format("%Y-%m-%dT%H:%M:%S").to_string())
}

/// Início do mês corrente (UTC) em ISO19 — base do gasto vs orçamento.
fn month_start() -> Option<String> {
    let now = Utc::now();
    let dt = now.date_naive().with_day(1)?.and_hms_opt(0, 0, 0)?.and_utc();
    Some(dt.format("%Y-%m-%dT%H:%M:%S").to_string())
}

/// `ts` (ISO) está dentro da janela? Compara os primeiros 19 chars (Z vs +00:00
/// não importam — o prefixo YYYY-MM-DDTHH:MM:SS domina e é largura fixa).
fn within(ts: &str, cutoff: &Option<String>) -> bool {
    match cutoff {
        None => true,
        Some(c) => {
            let t = if ts.len() >= 19 { &ts[..19] } else { ts };
            t >= c.as_str()
        }
    }
}

/// Claude Code: ~/.claude/projects/<slug>/<uuid>.jsonl — uma usage por mensagem.
fn scan_claude(home: &Path, agg: &mut Agg, cutoff: &Option<String>) {
    let dir = home.join(".claude").join("projects");
    let Ok(slugs) = std::fs::read_dir(&dir) else { return };
    for slug in slugs.flatten() {
        let Ok(files) = std::fs::read_dir(slug.path()) else { continue };
        for f in files.flatten() {
            let p = f.path();
            if p.extension().and_then(|x| x.to_str()) != Some("jsonl") {
                continue;
            }
            let Ok(content) = std::fs::read_to_string(&p) else { continue };
            let mut counted = false;
            for line in content.lines() {
                if !line.contains("\"input_tokens\"") {
                    continue;
                }
                let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
                // Filtro de período pelo timestamp da mensagem.
                if let Some(ts) = v.get("timestamp").and_then(|x| x.as_str()) {
                    if !within(ts, cutoff) {
                        continue;
                    }
                } else if cutoff.is_some() {
                    continue; // sem timestamp e há filtro → fora
                }
                let Some(msg) = v.get("message") else { continue };
                let Some(u) = msg.get("usage") else { continue };
                let inp = get_i64(u, "input_tokens");
                let out = get_i64(u, "output_tokens");
                let cr = get_i64(u, "cache_read_input_tokens");
                let cc = get_i64(u, "cache_creation_input_tokens");
                if inp + out + cr + cc == 0 {
                    continue;
                }
                let model = msg.get("model").and_then(|x| x.as_str()).unwrap_or("unknown");
                let cwd = v.get("cwd").and_then(|x| x.as_str()).unwrap_or("(sem projeto)");
                agg.add(cwd, model, 1, inp, out, cr, cc);
                if !counted {
                    agg.sessions += 1;
                    counted = true;
                }
            }
        }
    }
}

fn collect_rollouts(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            collect_rollouts(&p, out);
        } else if p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("rollout-") && n.ends_with(".jsonl")) {
            out.push(p);
        }
    }
}

/// Codex: ~/.codex/sessions/**/rollout-*.jsonl. total_token_usage é CUMULATIVO
/// (pega o último); `input_tokens` JÁ inclui o cacheado → separa pra não duplicar.
fn scan_codex(home: &Path, agg: &mut Agg, cutoff: &Option<String>) {
    let dir = home.join(".codex").join("sessions");
    let mut files = Vec::new();
    collect_rollouts(&dir, &mut files);
    for p in files {
        let Ok(content) = std::fs::read_to_string(&p) else { continue };
        let mut cwd: Option<String> = None;
        let mut model = String::from("gpt");
        let mut last: Option<(i64, i64, i64, i64)> = None; // (input, cached, output+reasoning, total)
        let mut last_ts: Option<String> = None;
        let mut calls = 0i64;
        for line in content.lines() {
            if cwd.is_none() {
                if let Some(c) = str_after(line, "\"cwd\":\"") {
                    cwd = Some(c.to_string());
                }
            }
            if line.contains("\"model\":\"") {
                if let Some(m) = str_after(line, "\"model\":\"") {
                    if !m.is_empty() {
                        model = m.to_string();
                    }
                }
            }
            if line.contains("\"total_token_usage\"") {
                if let Ok(v) = serde_json::from_str::<Value>(line) {
                    if let Some(u) = v.pointer("/payload/info/total_token_usage") {
                        last = Some((
                            get_i64(u, "input_tokens"),
                            get_i64(u, "cached_input_tokens"),
                            get_i64(u, "output_tokens") + get_i64(u, "reasoning_output_tokens"),
                            get_i64(u, "total_tokens"),
                        ));
                        if let Some(ts) = v.get("timestamp").and_then(|x| x.as_str()) {
                            last_ts = Some(ts.to_string());
                        }
                        calls += 1;
                    }
                }
            }
        }
        // Filtro de período pela hora do último evento de uso da sessão.
        let ts = last_ts.as_deref().unwrap_or("");
        if cutoff.is_some() && !within(ts, cutoff) {
            continue;
        }
        if let Some((inp, cached, out, _total)) = last {
            let non_cached = (inp - cached).max(0);
            let cwd = cwd.as_deref().unwrap_or("(sem projeto)");
            agg.add(cwd, &model, calls.max(1), non_cached, out, cached, 0);
            agg.sessions += 1;
        }
    }
}

/// Funde o ledger NATIVO do OmniRift no agregado + soma o subtotal `native`.
fn scan_ledger(db: &Db, agg: &mut Agg, cutoff: &Option<String>, native: &mut Tally) {
    let rows = match db.ledger_rows(cutoff.as_deref()) {
        Ok(r) => r,
        Err(_) => return,
    };
    for r in rows {
        let project = r.project.as_deref().unwrap_or("(OmniRift nativo)");
        agg.add(project, &r.model, 1, r.input_tokens, r.output_tokens, 0, 0);
        bump(native, 1, r.input_tokens, r.output_tokens, 0, 0, &r.model);
    }
}

/// Varre as sessões dos CLIs + o ledger nativo e agrega o uso de tokens.
/// `since_days`: None = tudo; 0 = hoje; N = últimos N dias.
#[tauri::command]
pub fn usage_scan(since_days: Option<i64>, db: State<'_, Db>) -> Result<UsageReport, String> {
    let mut agg = Agg::default();
    let mut native = Tally::default();
    let Some(home) = home() else {
        return Err("HOME não encontrado".into());
    };
    let cutoff = cutoff_for(since_days);
    scan_claude(&home, &mut agg, &cutoff);
    scan_codex(&home, &mut agg, &cutoff);
    scan_ledger(&db, &mut agg, &cutoff, &mut native);

    let mut by_model: Vec<ModelUsage> = agg
        .models
        .into_iter()
        .map(|(model, tally)| ModelUsage { model, tally })
        .collect();
    by_model.sort_by(|a, b| b.tally.total_tokens.cmp(&a.tally.total_tokens));

    let mut by_project: Vec<ProjectUsage> = agg
        .projects
        .into_iter()
        .map(|(project, tally)| ProjectUsage { project, tally })
        .collect();
    by_project.sort_by(|a, b| b.tally.total_tokens.cmp(&a.tally.total_tokens));

    Ok(UsageReport { total: agg.total, native, by_model, by_project, sessions: agg.sessions })
}

/// Gasto do mês corrente por projeto (CLI + nativo) vs orçamento → status.
#[tauri::command]
pub fn usage_budget_status(db: State<'_, Db>) -> Result<Vec<BudgetStatus>, String> {
    let budgets = db.budgets_list().map_err(|e| e.to_string())?;
    if budgets.is_empty() {
        return Ok(vec![]);
    }
    let Some(home) = home() else {
        return Err("HOME não encontrado".into());
    };
    let cutoff = month_start();
    let mut agg = Agg::default();
    let mut native = Tally::default();
    scan_claude(&home, &mut agg, &cutoff);
    scan_codex(&home, &mut agg, &cutoff);
    scan_ledger(&db, &mut agg, &cutoff, &mut native);

    let out = budgets
        .into_iter()
        .map(|b| {
            let spent = agg.projects.get(&b.project).map(|t| t.cost_usd).unwrap_or(0.0);
            let pct = if b.monthly_usd > 0.0 { spent / b.monthly_usd * 100.0 } else { 0.0 };
            let status = if pct >= 100.0 {
                "over"
            } else if pct >= b.alert_pct as f64 {
                "warn"
            } else {
                "ok"
            };
            BudgetStatus {
                project: b.project,
                monthly_usd: b.monthly_usd,
                alert_pct: b.alert_pct,
                spent_usd: spent,
                pct,
                status: status.into(),
            }
        })
        .collect();
    Ok(out)
}

/// Cria/atualiza o orçamento mensal (USD) de um projeto.
#[tauri::command]
pub fn budget_set(project: String, monthly_usd: f64, alert_pct: Option<i64>, db: State<'_, Db>) -> Result<(), String> {
    let pct = alert_pct.unwrap_or(80).clamp(1, 100);
    db.budget_set(&project, monthly_usd, pct).map_err(|e| e.to_string())
}

/// Remove o orçamento de um projeto (ação do próprio usuário).
#[tauri::command]
pub fn budget_remove(project: String, db: State<'_, Db>) -> Result<(), String> {
    db.budget_remove(&project).map_err(|e| e.to_string())
}
