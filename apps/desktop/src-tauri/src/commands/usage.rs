//! Uso de tokens — agrega a usage REAL gravada pelos agentes nas sessões do
//! Claude Code (`~/.claude/projects/<slug>/<uuid>.jsonl`, uma usage por mensagem).
//! Read-only: o dado já existe no disco; nada é capturado no spawn. Total geral +
//! por projeto (cwd) + por modelo/LLM, com estimativa de custo (USD).

use std::collections::HashMap;
use std::path::PathBuf;

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
    /// Total geral (todos os modelos/projetos).
    total: Tally,
    by_model: Vec<ModelUsage>,
    by_project: Vec<ProjectUsage>,
    /// nº de sessões (.jsonl) varridas.
    sessions: i64,
}

/// Preço USD por 1M tokens (input, output). cache_read ≈ 0.1×input, cache_write ≈
/// 1.25×input (modelo Anthropic). Estimativa — preços mudam; é indicador, não fatura.
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

fn add_usage(t: &mut Tally, inp: i64, out: i64, cr: i64, cc: i64, model: &str) {
    t.calls += 1;
    t.input_tokens += inp;
    t.output_tokens += out;
    t.cache_read_tokens += cr;
    t.cache_creation_tokens += cc;
    t.total_tokens += inp + out + cr + cc;
    let (pin, pout) = price(model);
    t.cost_usd += (inp as f64 * pin
        + out as f64 * pout
        + cr as f64 * pin * 0.1
        + cc as f64 * pin * 1.25)
        / 1_000_000.0;
}

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

/// Varre as sessões do Claude Code e agrega o uso de tokens.
#[tauri::command]
pub fn usage_scan() -> Result<UsageReport, String> {
    let mut total = Tally::default();
    let mut models: HashMap<String, Tally> = HashMap::new();
    let mut projects: HashMap<String, Tally> = HashMap::new();
    let mut sessions = 0i64;

    let Some(home) = home() else {
        return Err("HOME não encontrado".into());
    };
    let projects_dir = home.join(".claude").join("projects");
    let Ok(slugs) = std::fs::read_dir(&projects_dir) else {
        // Sem sessões ainda — relatório vazio, não erro.
        return Ok(UsageReport { total, by_model: vec![], by_project: vec![], sessions: 0 });
    };

    for slug in slugs.flatten() {
        let Ok(files) = std::fs::read_dir(slug.path()) else { continue };
        for f in files.flatten() {
            let p = f.path();
            if p.extension().and_then(|x| x.to_str()) != Some("jsonl") {
                continue;
            }
            let Ok(content) = std::fs::read_to_string(&p) else { continue };
            sessions += 1;
            for line in content.lines() {
                // Filtro barato antes do parse JSON.
                if !line.contains("\"input_tokens\"") {
                    continue;
                }
                let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
                let Some(msg) = v.get("message") else { continue };
                let Some(u) = msg.get("usage") else { continue };
                let get = |k: &str| u.get(k).and_then(|x| x.as_i64()).unwrap_or(0);
                let inp = get("input_tokens");
                let out = get("output_tokens");
                let cr = get("cache_read_input_tokens");
                let cc = get("cache_creation_input_tokens");
                if inp + out + cr + cc == 0 {
                    continue;
                }
                let model = msg.get("model").and_then(|x| x.as_str()).unwrap_or("unknown");
                let cwd = v.get("cwd").and_then(|x| x.as_str()).unwrap_or("(sem projeto)");

                add_usage(&mut total, inp, out, cr, cc, model);
                add_usage(models.entry(model.to_string()).or_default(), inp, out, cr, cc, model);
                add_usage(projects.entry(cwd.to_string()).or_default(), inp, out, cr, cc, model);
            }
        }
    }

    let mut by_model: Vec<ModelUsage> = models
        .into_iter()
        .map(|(model, tally)| ModelUsage { model, tally })
        .collect();
    by_model.sort_by(|a, b| b.tally.total_tokens.cmp(&a.tally.total_tokens));

    let mut by_project: Vec<ProjectUsage> = projects
        .into_iter()
        .map(|(project, tally)| ProjectUsage { project, tally })
        .collect();
    by_project.sort_by(|a, b| b.tally.total_tokens.cmp(&a.tally.total_tokens));

    Ok(UsageReport { total, by_model, by_project, sessions })
}
