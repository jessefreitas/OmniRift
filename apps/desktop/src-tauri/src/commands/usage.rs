//! Uso de tokens — agrega a usage REAL gravada pelos agentes nos arquivos de
//! sessão dos CLIs (read-only; o dado já existe no disco). Cobre:
//!  - Claude Code: ~/.claude/projects/<slug>/<uuid>.jsonl (usage por mensagem).
//!  - Codex (OpenAI): ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl (total_token_usage
//!    cumulativo por sessão — pega o último).
//! Gemini/Antigravity não logam token nos transcripts → ficam de fora.
//! Total geral + por modelo/LLM + por projeto (cwd), com estimativa de custo (USD).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

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
    by_model: Vec<ModelUsage>,
    by_project: Vec<ProjectUsage>,
    sessions: i64,
}

/// Preço USD por 1M tokens (input, output). cache_read ≈ 0.1×input, cache_write ≈
/// 1.25×input. Estimativa — preços mudam; é indicador, não fatura.
fn price(model: &str) -> (f64, f64) {
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

fn bump(t: &mut Tally, calls: i64, inp: i64, out: i64, cr: i64, cc: i64, model: &str) {
    t.calls += calls;
    t.input_tokens += inp;
    t.output_tokens += out;
    t.cache_read_tokens += cr;
    t.cache_creation_tokens += cc;
    t.total_tokens += inp + out + cr + cc;
    let (pin, pout) = price(model);
    t.cost_usd += (inp as f64 * pin + out as f64 * pout + cr as f64 * pin * 0.1 + cc as f64 * pin * 1.25) / 1_000_000.0;
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

/// Claude Code: ~/.claude/projects/<slug>/<uuid>.jsonl — uma usage por mensagem.
fn scan_claude(home: &Path, agg: &mut Agg) {
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
            agg.sessions += 1;
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
                let model = msg.get("model").and_then(|x| x.as_str()).unwrap_or("unknown");
                let cwd = v.get("cwd").and_then(|x| x.as_str()).unwrap_or("(sem projeto)");
                agg.add(cwd, model, 1, inp, out, cr, cc);
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
fn scan_codex(home: &Path, agg: &mut Agg) {
    let dir = home.join(".codex").join("sessions");
    let mut files = Vec::new();
    collect_rollouts(&dir, &mut files);
    for p in files {
        let Ok(content) = std::fs::read_to_string(&p) else { continue };
        agg.sessions += 1;
        let mut cwd: Option<String> = None;
        let mut model = String::from("gpt");
        let mut last: Option<(i64, i64, i64, i64)> = None; // (input, cached, output+reasoning, total)
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
                        calls += 1;
                    }
                }
            }
        }
        if let Some((inp, cached, out, _total)) = last {
            let non_cached = (inp - cached).max(0);
            let cwd = cwd.as_deref().unwrap_or("(sem projeto)");
            agg.add(cwd, &model, calls.max(1), non_cached, out, cached, 0);
        }
    }
}

/// Varre as sessões dos CLIs (Claude Code + Codex) e agrega o uso de tokens.
#[tauri::command]
pub fn usage_scan() -> Result<UsageReport, String> {
    let mut agg = Agg::default();
    let Some(home) = home() else {
        return Err("HOME não encontrado".into());
    };
    scan_claude(&home, &mut agg);
    scan_codex(&home, &mut agg);

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

    Ok(UsageReport { total: agg.total, by_model, by_project, sessions: agg.sessions })
}
