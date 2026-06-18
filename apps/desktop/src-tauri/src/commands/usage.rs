//! Uso de tokens — agrega a usage REAL gravada pelos agentes nos arquivos de
//! sessão dos CLIs (read-only; o dado já existe no disco) + o ledger NATIVO das
//! chamadas LLM do próprio OmniRift (review/companion/test). Cobre:
//!  - Claude Code: ~/.claude/projects/<slug>/<uuid>.jsonl (usage por mensagem).
//!  - Codex (OpenAI): ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl (total_token_usage
//!    cumulativo por sessão — pega o último).
//!  - Ledger nativo (tabela llm_ledger): chamadas que o próprio OmniRift fez.
//! Gemini/Antigravity não logam token nos transcripts → ficam de fora.
//!
//! PERF: a varredura do disco (parse JSON por mensagem) é cara, então roda UMA vez
//! e vira buckets por (dia, projeto, modelo) num cache com TTL. Qualquer período
//! (hoje/7d/30d/tudo) e o status de orçamento agregam em memória (instantâneo). O
//! ↻ do painel força rebuild. O ledger é pequeno → relido a cada chamada (live).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Instant;

use chrono::{Datelike, Duration, Utc};
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::db::{Db, LedgerRow};

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
    } else if m.contains("fable") {
        (5.0, 25.0) // estimativa (Anthropic mid-tier); calibrar quando publicarem.
    } else if m.contains("gpt-5") || m.contains("gpt5") {
        (1.25, 10.0)
    } else if m.contains("gpt-4o-mini") {
        (0.15, 0.6)
    } else if m.contains("gpt-4o") || m.contains("gpt-4.1") {
        (2.5, 10.0)
    } else if m.contains("gemini") {
        (1.25, 5.0)
    } else {
        // Modelos locais (Ollama: qwen/llama/devstral/glm/kimi/…) custam $0.
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
}

impl Agg {
    /// `inp` = input NÃO-cacheado; `cr`/`cc` = cache read/creation (separados).
    fn add(&mut self, cwd: &str, model: &str, calls: i64, inp: i64, out: i64, cr: i64, cc: i64) {
        bump(&mut self.total, calls, inp, out, cr, cc, model);
        bump(self.models.entry(model.to_string()).or_default(), calls, inp, out, cr, cc, model);
        bump(self.projects.entry(cwd.to_string()).or_default(), calls, inp, out, cr, cc, model);
    }
}

/// Um bucket agregado por (dia, projeto, modelo) — granularidade do filtro.
struct Bucket {
    date: String, // "YYYY-MM-DD" (UTC)
    cwd: String,
    model: String,
    calls: i64,
    inp: i64,
    out: i64,
    cr: i64,
    cc: i64,
}

/// Cache da varredura: buckets + a data do último evento de cada sessão (pro
/// contador de sessões no período). Reconstruído quando passa do TTL ou no ↻.
struct CacheInner {
    built: Instant,
    buckets: Vec<Bucket>,
    session_last: Vec<String>,
}

/// Estado gerenciado (app.manage) — protege o cache entre chamadas concorrentes.
#[derive(Default)]
pub struct UsageCache(Mutex<Option<CacheInner>>);

const CACHE_TTL_SECS: u64 = 30;
const NO_DATE: &str = "0000-00-00";

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

/// Os 10 primeiros chars de um timestamp ISO ("YYYY-MM-DD"), ou sentinela.
fn date_of(ts: Option<&str>) -> String {
    ts.and_then(|s| s.get(..10)).unwrap_or(NO_DATE).to_string()
}

/// Cutoff de DATA (UTC) "YYYY-MM-DD" pro filtro. None = tudo; 0 = hoje; N = N dias atrás.
fn cutoff_date(since_days: Option<i64>) -> Option<String> {
    let n = since_days?;
    let today = Utc::now().date_naive();
    let d = if n <= 0 { today } else { today - Duration::days(n) };
    Some(d.format("%Y-%m-%d").to_string())
}

/// Primeiro dia do mês corrente (UTC) — base do gasto vs orçamento.
fn month_start_date() -> String {
    Utc::now()
        .date_naive()
        .with_day(1)
        .map(|d| d.format("%Y-%m-%d").to_string())
        .unwrap_or_else(|| NO_DATE.to_string())
}

/// `date` ("YYYY-MM-DD") está dentro da janela? (compara strings — ISO é fixo).
fn within_date(date: &str, cutoff: &Option<String>) -> bool {
    match cutoff {
        None => true,
        Some(c) => date >= c.as_str(),
    }
}

type BucketMap = HashMap<(String, String, String), [i64; 5]>;

fn add_to(map: &mut BucketMap, date: &str, cwd: &str, model: &str, calls: i64, inp: i64, out: i64, cr: i64, cc: i64) {
    let e = map.entry((date.to_string(), cwd.to_string(), model.to_string())).or_insert([0; 5]);
    e[0] += calls;
    e[1] += inp;
    e[2] += out;
    e[3] += cr;
    e[4] += cc;
}

/// Claude Code: ~/.claude/projects/<slug>/<uuid>.jsonl — uma usage por mensagem.
fn scan_claude(home: &Path, map: &mut BucketMap, session_last: &mut Vec<String>) {
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
            let mut last_date = String::new();
            for line in content.lines() {
                if !line.contains("\"input_tokens\"") {
                    continue;
                }
                let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
                let Some(msg) = v.get("message") else { continue };
                let Some(u) = msg.get("usage") else { continue };
                let inp = get_i64(u, "input_tokens");
                let out = get_i64(u, "output_tokens");
                let cr = get_i64(u, "cache_read_input_tokens");
                let cc = get_i64(u, "cache_creation_input_tokens");
                if inp + out + cr + cc == 0 {
                    continue;
                }
                let date = date_of(v.get("timestamp").and_then(|x| x.as_str()));
                let model = msg.get("model").and_then(|x| x.as_str()).unwrap_or("unknown");
                let cwd = v.get("cwd").and_then(|x| x.as_str()).unwrap_or("(sem projeto)");
                add_to(map, &date, cwd, model, 1, inp, out, cr, cc);
                if date.as_str() > last_date.as_str() {
                    last_date = date;
                }
            }
            if !last_date.is_empty() {
                session_last.push(last_date);
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
fn scan_codex(home: &Path, map: &mut BucketMap, session_last: &mut Vec<String>) {
    let dir = home.join(".codex").join("sessions");
    let mut files = Vec::new();
    collect_rollouts(&dir, &mut files);
    for p in files {
        let Ok(content) = std::fs::read_to_string(&p) else { continue };
        let mut cwd: Option<String> = None;
        let mut model = String::from("gpt");
        let mut last: Option<(i64, i64, i64)> = None; // (input, cached, output+reasoning)
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
                        ));
                        if let Some(ts) = v.get("timestamp").and_then(|x| x.as_str()) {
                            last_ts = Some(ts.to_string());
                        }
                        calls += 1;
                    }
                }
            }
        }
        if let Some((inp, cached, out)) = last {
            let date = date_of(last_ts.as_deref());
            let non_cached = (inp - cached).max(0);
            let cwd = cwd.as_deref().unwrap_or("(sem projeto)");
            add_to(map, &date, cwd, &model, calls.max(1), non_cached, out, cached, 0);
            session_last.push(date);
        }
    }
}

/// Varre o disco e monta os buckets + datas das sessões (operação cara → cacheada).
fn build_buckets(home: &Path) -> (Vec<Bucket>, Vec<String>) {
    let mut map: BucketMap = HashMap::new();
    let mut session_last: Vec<String> = Vec::new();
    scan_claude(home, &mut map, &mut session_last);
    scan_codex(home, &mut map, &mut session_last);
    let buckets = map
        .into_iter()
        .map(|((date, cwd, model), v)| Bucket {
            date,
            cwd,
            model,
            calls: v[0],
            inp: v[1],
            out: v[2],
            cr: v[3],
            cc: v[4],
        })
        .collect();
    (buckets, session_last)
}

/// Garante o cache fresco (rebuild se vazio/stale ou `force`) e roda `f` sobre ele.
/// O lock segura durante a varredura → chamadas concorrentes reusam o mesmo build.
fn with_cache<R>(cache: &UsageCache, force: bool, f: impl FnOnce(&CacheInner) -> R) -> Result<R, String> {
    let home = home().ok_or_else(|| "HOME não encontrado".to_string())?;
    let mut g = cache.0.lock();
    let stale = g.as_ref().map(|c| c.built.elapsed().as_secs() > CACHE_TTL_SECS).unwrap_or(true);
    if force || stale {
        let (buckets, session_last) = build_buckets(&home);
        *g = Some(CacheInner { built: Instant::now(), buckets, session_last });
    }
    Ok(f(g.as_ref().expect("cache recém-preenchido")))
}

/// Agrega buckets (no período) + o ledger nativo → (agregado, subtotal nativo).
/// `only` (cwd) filtra pra um único projeto quando setado.
fn aggregate(c: &CacheInner, cutoff: &Option<String>, ledger: &[LedgerRow], only: Option<&str>) -> (Agg, Tally) {
    let mut agg = Agg::default();
    for b in &c.buckets {
        if only.is_some_and(|p| p != b.cwd) {
            continue;
        }
        if within_date(&b.date, cutoff) {
            agg.add(&b.cwd, &b.model, b.calls, b.inp, b.out, b.cr, b.cc);
        }
    }
    let mut native = Tally::default();
    for r in ledger {
        let project = r.project.as_deref().unwrap_or("(OmniRift nativo)");
        if only.is_some_and(|p| p != project) {
            continue;
        }
        let date = r.at.get(..10).unwrap_or(NO_DATE);
        if within_date(date, cutoff) {
            agg.add(project, &r.model, 1, r.input_tokens, r.output_tokens, 0, 0);
            bump(&mut native, 1, r.input_tokens, r.output_tokens, 0, 0, &r.model);
        }
    }
    (agg, native)
}

fn build_report(c: &CacheInner, cutoff: &Option<String>, ledger: &[LedgerRow], only: Option<&str>) -> UsageReport {
    let (agg, native) = aggregate(c, cutoff, ledger, only);

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

    let sessions = c.session_last.iter().filter(|d| within_date(d, cutoff)).count() as i64;
    UsageReport { total: agg.total, native, by_model, by_project, sessions }
}

/// Varre as sessões dos CLIs + o ledger nativo e agrega o uso de tokens.
/// `since_days`: None = tudo; 0 = hoje; N = últimos N dias. `force` = re-varre o disco.
#[tauri::command]
pub fn usage_scan(
    since_days: Option<i64>,
    force: Option<bool>,
    project: Option<String>,
    db: State<'_, Db>,
    cache: State<'_, UsageCache>,
) -> Result<UsageReport, String> {
    let cutoff = cutoff_date(since_days);
    let ledger = db.ledger_rows(None).unwrap_or_default();
    with_cache(&cache, force.unwrap_or(false), |c| build_report(c, &cutoff, &ledger, project.as_deref()))
}

/// Gasto do mês corrente por projeto (CLI + nativo) vs orçamento → status.
#[tauri::command]
pub fn usage_budget_status(db: State<'_, Db>, cache: State<'_, UsageCache>) -> Result<Vec<BudgetStatus>, String> {
    let budgets = db.budgets_list().map_err(|e| e.to_string())?;
    if budgets.is_empty() {
        return Ok(vec![]);
    }
    let cutoff = Some(month_start_date());
    let ledger = db.ledger_rows(None).unwrap_or_default();
    let costs: HashMap<String, f64> = with_cache(&cache, false, |c| {
        let (agg, _) = aggregate(c, &cutoff, &ledger, None);
        agg.projects.into_iter().map(|(k, t)| (k, t.cost_usd)).collect()
    })?;

    let out = budgets
        .into_iter()
        .map(|b| {
            let spent = costs.get(&b.project).copied().unwrap_or(0.0);
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
