//! `health_analyze_file` — análise de IA SOB DEMANDA de um arquivo: lê + roda
//! `code::metrics`, monta um prompt PT-BR pedindo a análise (smells, refactors,
//! risco) **em JSON** no formato `AiReport`, e roda o agente.
//!
//! Motor de IA (decisão da Fase A — spec §"Em aberto"): **agente headless via CLI**.
//! Spawna `claude -p "<prompt>"` (fallback `codex exec "<prompt>"`), captura stdout
//! e extrai o JSON. Razão: o painel não tem um provider/LLM próprio garantido no
//! backend (o `llm_chat` exige `LlmConfig` BYOK vindo do front, e o provider de
//! memória ≠ provider de LLM). O CLI já está no PATH dos usuários do OmniRift (é o
//! que eles usam pra spawnar agentes), roda offline-ish (subscription do usuário) e
//! não exige passar credencial pelo IPC. Degrada limpo: sem `claude`/`codex` no
//! PATH → `Err` amigável ("análise IA indisponível — configure um agente").
//!
//! Boundary: este módulo SÓ fala com o agente/LLM — não caminha o projeto.
//! Conteúdo do arquivo vai no prompt (o agente precisa), NUNCA em log.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::AppHandle;
use tokio::process::Command as TokioCommand;

use crate::code::{file_io, metrics, monaco_language, CodeMetrics, FunctionMetrics};
use crate::proc_ext::NoWindow;

/// Diretório (relativo ao root) onde os relatórios de IA persistidos vivem.
/// Mesmo princípio do backup-gate (`.omnirift/...`) — dentro do projeto, gitignored.
const REPORTS_DIR: &str = ".omnirift/health-reports";

/// Key fixa do relatório da dimensão Banco (`health_analyze_db`) — não há arquivo,
/// então usamos um nome estável em vez de derivar de um relpath.
const DB_REPORT_KEY: &str = "__db_repo__";

/// Um achado da análise de IA.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AiFinding {
    /// "critical" | "warning" | "info" (severidade).
    pub severity: String,
    /// "smell" | "refactor" | "risk" | "perf" | "security" | … (categoria).
    pub kind: String,
    pub title: String,
    pub detail: String,
    /// Sugestão de correção/refactor.
    pub suggestion: String,
    /// Linha aproximada (opcional).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<usize>,
}

/// Relatório de IA — o que o front recebe e renderiza no `AiReportView`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AiReport {
    /// Alvo da análise (o caminho do arquivo).
    pub target: String,
    pub findings: Vec<AiFinding>,
    /// Resumo executivo (1-3 frases) do estado do arquivo.
    pub summary: String,
}

/// Relatório de IA PERSISTIDO — o que `health_report_get`/`health_reports_list`
/// devolvem. Sobrevive ao fechamento do painel: depois que o usuário dá o comando,
/// o backend grava o `AiReport` quando ele fica pronto, então a UI pode recarregá-lo.
///
/// `file` é o relpath (relativo ao root) analisado — ou a key fixa pra dimensões sem
/// arquivo (ex.: banco). `ts` é o carimbo ISO-8601 da conclusão. `running` indica que
/// existe um marcador `.running` (análise em andamento) — quando `true` e o `report`
/// é placeholder vazio, é uma análise que ainda não concluiu.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SavedReport {
    /// Relpath (relativo ao root) do arquivo analisado, ou key fixa (ex.: banco).
    pub file: String,
    /// Carimbo ISO-8601 (RFC3339) de quando a análise concluiu.
    pub ts: String,
    /// O relatório de IA propriamente dito.
    pub report: AiReport,
    /// `true` se há um marcador `.running` pra esta key (análise em andamento).
    pub running: bool,
}

/// Função com a pior (maior) complexidade ciclomática.
fn worst_function(m: &CodeMetrics) -> Option<&FunctionMetrics> {
    m.functions.iter().max_by_key(|f| f.cyclomatic)
}

/// Monta o prompt PT-BR pedindo o relatório EM JSON estrito (formato `AiReport`).
/// Inclui as métricas (números) + o conteúdo do arquivo (o agente precisa pra
/// análise). Métricas opcionais degradam (linha some quando não há dado).
pub fn build_prompt(
    file_path: &str,
    language: &str,
    content: &str,
    metrics: Option<&CodeMetrics>,
) -> String {
    let mut p = String::new();
    p.push_str(
        "Você é o analista de saúde de código do OmniRift. Analise o arquivo abaixo e \
         produza um relatório de qualidade: code smells, refactors recomendados e riscos \
         (bug-proneness, acoplamento, manutenibilidade).\n\n",
    );
    p.push_str(&format!("Arquivo: {file_path}\n"));
    p.push_str(&format!("Linguagem: {language}\n"));

    if let Some(m) = metrics {
        p.push_str(&format!(
            "Métricas do arquivo: LOC {} · ciclomática máx {} · cognitiva máx {} · MI {}\n",
            m.loc,
            m.max_cyclomatic,
            m.max_cognitive,
            m.maintainability_index.round() as i64,
        ));
        if let Some(w) = worst_function(m) {
            p.push_str(&format!(
                "Pior função: {} (linhas {}–{}) · ciclomática {} · cognitiva {} · severidade {}\n",
                w.name, w.start_line, w.end_line, w.cyclomatic, w.cognitive, w.severity,
            ));
        }
    }

    p.push_str("\nConteúdo do arquivo:\n```");
    p.push_str(language);
    p.push('\n');
    p.push_str(content);
    p.push_str("\n```\n");

    p.push_str(
        "\nRESPONDA APENAS com um objeto JSON VÁLIDO (sem markdown, sem comentários, sem \
         texto antes ou depois), exatamente neste formato:\n\
         {\n\
         \x20 \"target\": \"<caminho do arquivo>\",\n\
         \x20 \"summary\": \"<1-3 frases sobre o estado do arquivo>\",\n\
         \x20 \"findings\": [\n\
         \x20\x20\x20 {\n\
         \x20\x20\x20\x20\x20 \"severity\": \"critical|warning|info\",\n\
         \x20\x20\x20\x20\x20 \"kind\": \"smell|refactor|risk|perf|security\",\n\
         \x20\x20\x20\x20\x20 \"title\": \"<título curto>\",\n\
         \x20\x20\x20\x20\x20 \"detail\": \"<o que é o problema>\",\n\
         \x20\x20\x20\x20\x20 \"suggestion\": \"<como corrigir/refatorar>\",\n\
         \x20\x20\x20\x20\x20 \"line\": <número da linha ou omita>\n\
         \x20\x20\x20 }\n\
         \x20 ]\n\
         }\n\
         Se o arquivo estiver saudável, devolva findings vazio e diga no summary. \
         Seja específico e acionável.\n",
    );
    p
}

/// Extrai o primeiro objeto JSON balanceado de um texto (o agente pode cercar com
/// markdown/preâmbulo). Procura o 1º `{` e casa as chaves respeitando strings.
pub fn extract_json(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let start = text.find('{')?;
    let mut depth = 0i32;
    let mut in_str = false;
    let mut escaped = false;
    for (i, &b) in bytes.iter().enumerate().skip(start) {
        let c = b as char;
        if in_str {
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_str = false;
            }
            continue;
        }
        match c {
            '"' => in_str = true,
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(text[start..=i].to_string());
                }
            }
            _ => {}
        }
    }
    None
}

/// Parseia a saída do agente num `AiReport`. Garante o `target` (sobrescreve com
/// o caminho real, caso o agente erre). Erro = JSON ausente/inválido.
pub fn parse_report(stdout: &str, target: &str) -> Result<AiReport, String> {
    let json = extract_json(stdout)
        .ok_or_else(|| "o agente não devolveu JSON parseável".to_string())?;
    let mut report: AiReport =
        serde_json::from_str(&json).map_err(|e| format!("JSON do agente inválido: {e}"))?;
    report.target = target.to_string();
    Ok(report)
}

/// CLI de agente headless + os args pra rodar um prompt único e capturar stdout.
/// `claude -p "<prompt>"` (modo print) ou `codex exec "<prompt>"`.
pub fn agent_invocation(prompt: &str) -> Option<(&'static str, Vec<String>)> {
    if is_on_path("claude") {
        return Some(("claude", vec!["-p".into(), prompt.to_string()]));
    }
    if is_on_path("codex") {
        return Some(("codex", vec!["exec".into(), prompt.to_string()]));
    }
    None
}

/// Args pra rodar um prompt único e capturar stdout num CLI de agente headless
/// ESPECÍFICO (`claude -p` / `codex exec` / fallback genérico). Reusado pelo TURBO
/// (`turbo/driver.rs`) — implementer/verifier são CLIs escolhidos pelo usuário, não
/// "o primeiro do PATH". `None` se o `cli` não for reconhecido. (Puro/testável.)
pub fn agent_args_for(cli: &str, prompt: &str) -> Option<Vec<String>> {
    match cli {
        "claude" => Some(vec!["-p".into(), prompt.to_string()]),
        "codex" => Some(vec!["exec".into(), prompt.to_string()]),
        // Outros CLIs de agente costumam aceitar o prompt como argumento posicional
        // (modo "run"); degrade pra isso em vez de falhar duro.
        other if !other.trim().is_empty() => Some(vec![prompt.to_string()]),
        _ => None,
    }
}

/// **Helper headless COMPARTILHADO** (DRY — spec §"Agente headless"). Roda um
/// `<cli>` específico com o `prompt` em `cwd`, captura stdout e devolve-o cru.
/// Reusado por TURBO (implementer/verifier) — o `run_agent_report` abaixo é o caso
/// especializado (escolhe o CLI do PATH + parseia o JSON). Degrada limpo: CLI
/// ausente no PATH ou exit≠0 → `Err` amigável. Conteúdo do prompt NUNCA é logado.
pub async fn run_headless_agent(cli: &str, prompt: &str, cwd: &str) -> Result<String, String> {
    if !is_on_path(cli) {
        return Err(format!(
            "agente '{cli}' indisponível — instale o CLI (ou escolha outro)"
        ));
    }
    let args = agent_args_for(cli, prompt)
        .ok_or_else(|| format!("não sei invocar o agente '{cli}'"))?;

    // Timeout defensivo: um agente headless travado (stall de rede) não pode pendurar
    // o chamador pra sempre — crítico pro loop TURBO, cujo cancelamento só checa entre
    // iterações. 15 min é folgado pra um turno; ao estourar vira erro (o loop trata como
    // iteração falha). NB: o filho não é morto no timeout (fica órfão até terminar) — fase 2.
    let fut = TokioCommand::new(cli)
        .args(&args)
        .current_dir(cwd)
        .no_window()
        .output();
    let output = tokio::time::timeout(std::time::Duration::from_secs(900), fut)
        .await
        .map_err(|_| format!("o agente '{cli}' excedeu o tempo limite (15 min)"))?
        .map_err(|e| format!("falha ao rodar o agente '{cli}': {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "o agente '{cli}' falhou (exit {}): {}",
            output.status.code().unwrap_or(-1),
            stderr.trim()
        ));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Roda um prompt pelo MESMO motor headless de `health_analyze_file`
/// (`claude -p` / `codex exec`), parseia o stdout num `AiReport` e força o
/// `target`. Degrada limpo: sem CLI no PATH → `Err` amigável. Reusado pela
/// dimensão Banco (`health_analyze_db`) — NÃO duplica spawn/parse.
/// Conteúdo do prompt nunca é logado.
pub async fn run_agent_report(prompt: &str, target: &str) -> Result<AiReport, String> {
    let (bin, args) = agent_invocation(prompt).ok_or_else(|| {
        "análise IA indisponível — configure um agente (instale o CLI `claude` ou `codex`)"
            .to_string()
    })?;

    let output = TokioCommand::new(bin)
        .args(&args)
        .no_window()
        .output()
        .await
        .map_err(|e| format!("falha ao rodar o agente '{bin}': {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "o agente '{bin}' falhou (exit {}): {}",
            output.status.code().unwrap_or(-1),
            stderr.trim()
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_report(&stdout, target)
}

/// `which`/`where <binary>` — true se no PATH (espelha clis.rs).
fn is_on_path(binary: &str) -> bool {
    let finder = if cfg!(target_os = "windows") { "where" } else { "which" };
    std::process::Command::new(finder)
        .arg(binary)
        .no_window()
        .output()
        .map(|o| o.status.success() && !o.stdout.is_empty())
        .unwrap_or(false)
}

// ───────────────────────── persistência dos relatórios ─────────────────────────
//
// Espelha o estilo do backup-gate (`backup.rs`): grava em `<root>/.omnirift/...`
// como JSON via serde, normaliza o path pra dentro do root, e separa a lógica de IO
// em fns puras testáveis (`save_report`/`load_report`/`list_reports`) das `#[tauri::command]`.
//
// Por que persistir: hoje `health_analyze_file` roda o agente e DEVOLVE o `AiReport`,
// mas se o usuário fecha o painel antes de terminar, perde tudo — mesmo já tendo dado o
// comando (que pode levar minutos). Gravamos um marcador `.running` ANTES de spawnar e o
// `<key>.json` AO CONCLUIR; assim a UI recarrega o resultado (ou vê "em andamento").

/// Carimbo ISO-8601 (RFC3339) — vai no campo `ts` do `SavedReport`. Espelha `backup.rs`.
fn ts_iso() -> String {
    chrono::Local::now().to_rfc3339()
}

/// Diretório absoluto dos relatórios sob o root (`<root>/.omnirift/health-reports`).
fn reports_dir(root: &str) -> PathBuf {
    Path::new(root).join(REPORTS_DIR)
}

/// Deriva a chave de arquivo (segura pra nome de arquivo) a partir do `path` do alvo,
/// normalizado pra RELPATH dentro do `root`. Path absoluto dentro do root → relpath;
/// path relativo → usado como veio; path fora do root → cai pro próprio path.
///
/// A key é o sha256 curto (16 hex) do relpath: estável, sem caracteres inválidos pra
/// nome de arquivo, e tolerante a `/`, `\\`, `:` (Windows drive), etc. Retorna
/// `(key, relpath)` — o relpath vai no campo `file` do `SavedReport` (legível).
fn report_key(root: &str, path: &str) -> (String, String) {
    let root_p = Path::new(root);
    let raw = Path::new(path);

    // Relpath legível: se o alvo está dentro do root, strip do prefixo; senão usa cru.
    let rel = if raw.is_absolute() {
        raw.strip_prefix(root_p)
            .map(|r| r.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| path.to_string())
    } else {
        path.replace('\\', "/")
    };

    (sha256_short(&rel), rel)
}

/// sha256 do input → primeiros 16 hex chars (64 bits) — colisão desprezível pra
/// o nº de arquivos de um projeto, e curto o bastante pra nome de arquivo.
fn sha256_short(s: &str) -> String {
    let digest = Sha256::digest(s.as_bytes());
    let mut hex = String::with_capacity(16);
    for b in digest.iter().take(8) {
        hex.push_str(&format!("{b:02x}"));
    }
    hex
}

/// **Helper puro testável.** Grava o `SavedReport` (`file`+`ts`+`report`) em
/// `<dir>/<key>.json` e REMOVE o marcador `<dir>/<key>.running` (se houver). Cria o
/// `dir` se preciso. NÃO spawna agente — só IO. `running` não é persistido no JSON
/// (é derivado da existência do marcador na leitura).
fn save_report(dir: &Path, key: &str, file: &str, report: &AiReport) -> Result<SavedReport, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("não criou {}: {e}", dir.display()))?;

    let saved = SavedReport {
        file: file.to_string(),
        ts: ts_iso(),
        report: report.clone(),
        running: false,
    };
    let json =
        serde_json::to_string_pretty(&saved).map_err(|e| format!("serializar relatório: {e}"))?;
    std::fs::write(dir.join(format!("{key}.json")), json)
        .map_err(|e| format!("escrever relatório {key}: {e}"))?;

    // Concluiu → remove o marcador (não deixa órfão). Falha de remoção é soft.
    let _ = std::fs::remove_file(dir.join(format!("{key}.running")));

    Ok(saved)
}

/// **Helper puro testável.** Lê `<dir>/<key>.json` se existir; marca `running` se há
/// `<dir>/<key>.running`. `None` quando não há JSON nem marcador. Se há SÓ o marcador
/// (análise em andamento, ainda sem resultado), devolve um `SavedReport` placeholder
/// (`report` vazio) com `running: true`.
fn load_report(dir: &Path, key: &str, file_hint: &str) -> Result<Option<SavedReport>, String> {
    let json_path = dir.join(format!("{key}.json"));
    let running = dir.join(format!("{key}.running")).exists();

    if json_path.is_file() {
        let raw = std::fs::read_to_string(&json_path)
            .map_err(|e| format!("ler relatório {key}: {e}"))?;
        let mut saved: SavedReport =
            serde_json::from_str(&raw).map_err(|e| format!("relatório inválido {key}: {e}"))?;
        saved.running = running;
        return Ok(Some(saved));
    }

    if running {
        // Em andamento, sem resultado ainda → placeholder vazio + running:true.
        return Ok(Some(SavedReport {
            file: file_hint.to_string(),
            ts: String::new(),
            report: AiReport {
                target: file_hint.to_string(),
                findings: Vec::new(),
                summary: String::new(),
            },
            running: true,
        }));
    }

    Ok(None)
}

/// **Helper puro testável.** Lista todos os relatórios de `dir`: cada `<key>.json` (+
/// marca `running` se há o `.running` da mesma key) e cada `.running` ÓRFÃO (sem json
/// → análise em andamento, placeholder vazio). Ordena por `ts` desc (mais recente
/// primeiro; placeholders com `ts` vazio caem pro fim). `dir` inexistente → vazio.
fn list_reports(dir: &Path) -> Result<Vec<SavedReport>, String> {
    if !dir.is_dir() {
        return Ok(Vec::new());
    }

    let mut out: Vec<SavedReport> = Vec::new();
    let mut running_keys: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut json_keys: std::collections::HashSet<String> = std::collections::HashSet::new();

    let entries = std::fs::read_dir(dir).map_err(|e| format!("ler {}: {e}", dir.display()))?;
    let entries: Vec<_> = entries.flatten().collect();

    // 1ª passada: cataloga as keys que têm marcador `.running`.
    for entry in &entries {
        let name = entry.file_name().to_string_lossy().to_string();
        if let Some(key) = name.strip_suffix(".running") {
            running_keys.insert(key.to_string());
        }
    }

    // 2ª passada: lê cada `<key>.json` (pula inválidos), marcando `running`.
    for entry in &entries {
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(key) = name.strip_suffix(".json") else {
            continue;
        };
        json_keys.insert(key.to_string());
        let raw = match std::fs::read_to_string(entry.path()) {
            Ok(r) => r,
            Err(_) => continue, // ilegível → pula (não derruba a listagem)
        };
        let mut saved: SavedReport = match serde_json::from_str(&raw) {
            Ok(s) => s,
            Err(_) => continue, // json inválido → pula
        };
        saved.running = running_keys.contains(key);
        out.push(saved);
    }

    // Marcadores `.running` ÓRFÃOS (sem json) → análise em andamento (placeholder).
    for key in &running_keys {
        if !json_keys.contains(key) {
            out.push(SavedReport {
                file: String::new(),
                ts: String::new(),
                report: AiReport {
                    target: String::new(),
                    findings: Vec::new(),
                    summary: String::new(),
                },
                running: true,
            });
        }
    }

    // Mais recente primeiro. `ts` RFC3339 → ordenável lexicograficamente; `ts` vazio
    // (placeholders em andamento) ordena por último com este desc.
    out.sort_by(|a, b| b.ts.cmp(&a.ts));
    Ok(out)
}

/// Grava o marcador `<dir>/<key>.running` (vazio) — chamado ANTES de spawnar o agente.
/// Cria o `dir` se preciso. Falha de IO é propagada (sem marcador → sem rastro de "em
/// andamento", mas não bloqueamos a análise por isso no caller).
fn write_running_marker(dir: &Path, key: &str) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("não criou {}: {e}", dir.display()))?;
    std::fs::write(dir.join(format!("{key}.running")), b"")
        .map_err(|e| format!("escrever marcador {key}: {e}"))
}

/// Remove o marcador `<dir>/<key>.running` (idempotente; falha = soft).
fn clear_running_marker(dir: &Path, key: &str) {
    let _ = std::fs::remove_file(dir.join(format!("{key}.running")));
}

/// Analisa um arquivo via IA: lê + métricas → prompt → agente headless → `AiReport`,
/// PERSISTINDO o resultado pra sobreviver ao fechamento do painel.
///
/// Fluxo: deriva a key (relpath→sha256 curto) → escreve `<key>.running` → roda o agente
/// → AO CONCLUIR grava `<key>.json` e remove o `.running`; em ERRO remove o `.running`
/// (sem órfão). Degrada limpo: sem CLI de agente no PATH → `Err` amigável. Conteúdo só
/// vai no prompt (pro agente), nunca em log. Retorna o `AiReport` como antes.
#[tauri::command]
pub async fn health_analyze_file(
    _app: AppHandle,
    root: String,
    path: String,
) -> Result<AiReport, String> {
    let p = Path::new(&path);
    let language = monaco_language(p).to_string();
    let content = file_io::read(p).map_err(|e| e.to_string())?;
    let metrics: Option<CodeMetrics> = metrics::compute(p, &content).ok();

    let prompt = build_prompt(&path, &language, &content, metrics.as_ref());

    let dir = reports_dir(&root);
    let (key, rel) = report_key(&root, &path);

    // Marcador ANTES de rodar (UI mostra "em andamento" mesmo se o painel reabrir).
    let _ = write_running_marker(&dir, &key);

    match run_agent_report(&prompt, &path).await {
        Ok(report) => {
            // Concluiu: grava o JSON e remove o marcador (save_report já faz os dois).
            let _ = save_report(&dir, &key, &rel, &report);
            Ok(report)
        }
        Err(e) => {
            // Erro: nunca deixa o `.running` órfão.
            clear_running_marker(&dir, &key);
            Err(e)
        }
    }
}

/// Lê o relatório persistido de um arquivo (`<key>.json`), marcando `running` se há o
/// marcador. `None` se nunca foi analisado. Só-marcador (em andamento) → placeholder
/// vazio com `running: true`.
#[tauri::command]
pub async fn health_report_get(root: String, path: String) -> Result<Option<SavedReport>, String> {
    let dir = reports_dir(&root);
    let (key, rel) = report_key(&root, &path);
    load_report(&dir, &key, &rel)
}

/// Lista todos os relatórios persistidos do projeto (incluindo análises em andamento),
/// ordenados por `ts` desc (mais recente primeiro).
#[tauri::command]
pub async fn health_reports_list(root: String) -> Result<Vec<SavedReport>, String> {
    let dir = reports_dir(&root);
    list_reports(&dir)
}

/// Key fixa do relatório da dimensão Banco — reusada por `health_analyze_db` pra
/// persistir sob o MESMO padrão (sem arquivo, então key estável).
pub fn db_report_key() -> &'static str {
    DB_REPORT_KEY
}

/// Persiste um `AiReport` da dimensão Banco sob a key fixa `__db_repo__`, MESMO padrão
/// de `health_analyze_file`. Reusado por `db.rs::health_analyze_db`. Falha de IO é soft
/// (não derruba a análise já concluída).
pub fn persist_db_report(root: &str, report: &AiReport) {
    let dir = reports_dir(root);
    let _ = save_report(&dir, DB_REPORT_KEY, DB_REPORT_KEY, report);
}

/// Escreve o marcador `.running` da dimensão Banco (antes de spawnar). Falha = soft.
pub fn mark_db_running(root: &str) {
    let dir = reports_dir(root);
    let _ = write_running_marker(&dir, DB_REPORT_KEY);
}

/// Remove o marcador `.running` da dimensão Banco (em erro, sem órfão). Falha = soft.
pub fn clear_db_running(root: &str) {
    let dir = reports_dir(root);
    clear_running_marker(&dir, DB_REPORT_KEY);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn sample_metrics() -> CodeMetrics {
        let src = "fn big(a: bool) {\n    if a {\n        for _ in 0..3 {}\n    }\n}\n";
        metrics::compute(&PathBuf::from("x.rs"), src).unwrap()
    }

    #[test]
    fn build_prompt_includes_path_lang_content_and_json_schema() {
        let m = sample_metrics();
        let p = build_prompt("/tmp/x.rs", "rust", "fn big() {}", Some(&m));
        assert!(p.contains("/tmp/x.rs"));
        assert!(p.contains("rust"));
        assert!(p.contains("fn big()"), "conteúdo do arquivo no prompt");
        assert!(p.contains("JSON"), "pede JSON");
        assert!(p.contains("\"findings\""), "esquema com findings");
        assert!(p.contains("\"severity\""), "esquema com severity");
        assert!(p.contains("Pior função: big"), "pior função das métricas");
    }

    #[test]
    fn build_prompt_degrades_without_metrics() {
        let p = build_prompt("/tmp/y.ts", "typescript", "const a = 1;", None);
        assert!(p.contains("/tmp/y.ts"));
        assert!(!p.contains("Pior função"), "sem métricas → sem linha de função");
        assert!(p.contains("\"summary\""), "ainda pede o esquema");
    }

    #[test]
    fn extract_json_from_fenced_markdown() {
        let raw = "Claro, aqui está:\n```json\n{\"target\":\"x\",\"summary\":\"ok\",\"findings\":[]}\n```\nFim.";
        let j = extract_json(raw).unwrap();
        assert_eq!(j, "{\"target\":\"x\",\"summary\":\"ok\",\"findings\":[]}");
    }

    #[test]
    fn extract_json_handles_nested_braces_and_strings() {
        let raw = "{\"a\": {\"b\": 1}, \"s\": \"tem } chave na string\"}";
        let j = extract_json(raw).unwrap();
        assert_eq!(j, raw);
    }

    #[test]
    fn extract_json_none_when_absent() {
        assert!(extract_json("nenhum json aqui").is_none());
    }

    #[test]
    fn parse_report_overrides_target() {
        let stdout = "{\"target\":\"errado\",\"summary\":\"tem smells\",\"findings\":[{\"severity\":\"warning\",\"kind\":\"smell\",\"title\":\"função longa\",\"detail\":\"40 linhas\",\"suggestion\":\"extraia\",\"line\":12}]}";
        let r = parse_report(stdout, "/real/path.rs").unwrap();
        assert_eq!(r.target, "/real/path.rs", "target sobrescrito com o real");
        assert_eq!(r.summary, "tem smells");
        assert_eq!(r.findings.len(), 1);
        assert_eq!(r.findings[0].severity, "warning");
        assert_eq!(r.findings[0].line, Some(12));
    }

    #[test]
    fn parse_report_optional_line_omitted() {
        let stdout = "{\"target\":\"x\",\"summary\":\"ok\",\"findings\":[{\"severity\":\"info\",\"kind\":\"refactor\",\"title\":\"t\",\"detail\":\"d\",\"suggestion\":\"s\"}]}";
        let r = parse_report(stdout, "x").unwrap();
        assert_eq!(r.findings[0].line, None);
    }

    #[test]
    fn parse_report_errs_on_garbage() {
        assert!(parse_report("isso não é json", "x").is_err());
    }

    // ───────────────────── persistência dos relatórios ─────────────────────

    fn sample_report(target: &str, summary: &str) -> AiReport {
        AiReport {
            target: target.to_string(),
            summary: summary.to_string(),
            findings: vec![AiFinding {
                severity: "warning".into(),
                kind: "smell".into(),
                title: "função longa".into(),
                detail: "40 linhas".into(),
                suggestion: "extraia".into(),
                line: Some(12),
            }],
        }
    }

    /// Round-trip: save_report grava → load_report lê de volta idêntico.
    #[test]
    fn save_load_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        let report = sample_report("src/app.rs", "tem smells");

        let saved = save_report(d, "k1", "src/app.rs", &report).unwrap();
        assert_eq!(saved.file, "src/app.rs");
        assert_eq!(saved.report, report);
        assert!(!saved.running, "sem marcador → running:false");
        assert!(d.join("k1.json").is_file(), "JSON gravado");

        let loaded = load_report(d, "k1", "src/app.rs").unwrap().unwrap();
        assert_eq!(loaded.file, "src/app.rs");
        assert_eq!(loaded.report, report, "report idêntico no round-trip");
        assert_eq!(loaded.ts, saved.ts);
        assert!(!loaded.running);
    }

    /// load_report → None quando nunca foi analisado (sem json, sem marcador).
    #[test]
    fn load_none_when_absent() {
        let dir = tempfile::tempdir().unwrap();
        assert!(load_report(dir.path(), "nope", "x.rs").unwrap().is_none());
    }

    /// save_report REMOVE o marcador `.running` ao concluir (não deixa órfão).
    #[test]
    fn save_clears_running_marker() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        write_running_marker(d, "k2").unwrap();
        assert!(d.join("k2.running").exists());

        save_report(d, "k2", "f.rs", &sample_report("f.rs", "ok")).unwrap();
        assert!(!d.join("k2.running").exists(), "marcador removido ao concluir");

        let loaded = load_report(d, "k2", "f.rs").unwrap().unwrap();
        assert!(!loaded.running);
    }

    /// JSON presente + marcador presente → running:true marcado na leitura.
    #[test]
    fn load_marks_running_when_marker_present() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        save_report(d, "k3", "f.rs", &sample_report("f.rs", "ok")).unwrap();
        // Re-cria o marcador (ex.: nova análise por cima de um resultado antigo).
        write_running_marker(d, "k3").unwrap();

        let loaded = load_report(d, "k3", "f.rs").unwrap().unwrap();
        assert!(loaded.running, "marcador presente → running:true");
        assert_eq!(loaded.report.summary, "ok", "ainda traz o resultado anterior");
    }

    /// Só-marcador (sem json) → placeholder vazio com running:true (em andamento).
    #[test]
    fn load_running_only_returns_placeholder() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        write_running_marker(d, "k4").unwrap();

        let loaded = load_report(d, "k4", "novo.rs").unwrap().unwrap();
        assert!(loaded.running);
        assert_eq!(loaded.file, "novo.rs", "file_hint vira o file do placeholder");
        assert!(loaded.report.findings.is_empty(), "placeholder vazio");
        assert!(loaded.report.summary.is_empty());
        assert_eq!(loaded.ts, "", "sem ts pois não concluiu");
    }

    /// list_reports ordena por ts desc (mais recente primeiro).
    #[test]
    fn list_orders_by_ts_desc() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        // Fabrica 3 JSONs com ts conhecidos (não dependemos do relógio).
        for (key, ts) in [
            ("a", "2026-01-01T00:00:00+00:00"),
            ("b", "2026-03-01T12:00:00+00:00"),
            ("c", "2026-02-01T06:00:00+00:00"),
        ] {
            let saved = SavedReport {
                file: format!("{key}.rs"),
                ts: ts.to_string(),
                report: sample_report(&format!("{key}.rs"), "s"),
                running: false,
            };
            let json = serde_json::to_string_pretty(&saved).unwrap();
            std::fs::write(d.join(format!("{key}.json")), json).unwrap();
        }

        let list = list_reports(d).unwrap();
        assert_eq!(list.len(), 3);
        assert_eq!(list[0].file, "b.rs", "março primeiro");
        assert_eq!(list[1].file, "c.rs", "fevereiro");
        assert_eq!(list[2].file, "a.rs", "janeiro por último");
    }

    /// list_reports inclui marcadores ÓRFÃOS (em andamento) como placeholder running.
    #[test]
    fn list_includes_orphan_running() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        save_report(d, "done", "done.rs", &sample_report("done.rs", "ok")).unwrap();
        write_running_marker(d, "inprogress").unwrap();

        let list = list_reports(d).unwrap();
        assert_eq!(list.len(), 2, "1 concluído + 1 em andamento");
        let running: Vec<_> = list.iter().filter(|r| r.running).collect();
        assert_eq!(running.len(), 1, "exatamente 1 em andamento");
        assert!(running[0].report.findings.is_empty(), "órfão é placeholder vazio");
    }

    /// list_reports em dir inexistente → vazio (não erro).
    #[test]
    fn list_empty_when_dir_absent() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("does-not-exist");
        assert!(list_reports(&missing).unwrap().is_empty());
    }

    /// report_key produz key SEGURA pra path com `/` (sem barra no nome de arquivo)
    /// e estável (mesma entrada → mesma key). Relpath é derivado dentro do root.
    #[test]
    fn report_key_safe_for_slashes_and_stable() {
        let root = "/proj";
        let (k1, rel1) = report_key(root, "/proj/src/deep/nested/app.rs");
        assert_eq!(rel1, "src/deep/nested/app.rs", "relpath dentro do root");
        assert!(!k1.contains('/'), "key sem barra → nome de arquivo seguro");
        assert!(!k1.contains('\\'));
        assert_eq!(k1.len(), 16, "sha256 curto = 16 hex");

        // Estável: mesma entrada → mesma key.
        let (k2, _) = report_key(root, "/proj/src/deep/nested/app.rs");
        assert_eq!(k1, k2);

        // Paths diferentes → keys diferentes.
        let (k3, _) = report_key(root, "/proj/src/deep/nested/other.rs");
        assert_ne!(k1, k3);

        // E a key serve de fato como nome de arquivo gravável.
        let dir = tempfile::tempdir().unwrap();
        let saved = save_report(dir.path(), &k1, &rel1, &sample_report(&rel1, "ok"));
        assert!(saved.is_ok(), "key gravável como nome de arquivo");
    }

    /// report_key com path relativo usa o próprio path (normalizado) como relpath.
    #[test]
    fn report_key_relative_path() {
        let (key, rel) = report_key("/proj", "src/app.rs");
        assert_eq!(rel, "src/app.rs");
        assert_eq!(key, sha256_short("src/app.rs"));
    }

    /// db_report_key é a key fixa esperada (`__db_repo__`).
    #[test]
    fn db_key_is_fixed() {
        assert_eq!(db_report_key(), "__db_repo__");
    }

    /// agent_args_for monta os args certos por CLI (reusado pelo TURBO).
    #[test]
    fn agent_args_for_known_clis() {
        assert_eq!(agent_args_for("claude", "oi"), Some(vec!["-p".into(), "oi".into()]));
        assert_eq!(agent_args_for("codex", "oi"), Some(vec!["exec".into(), "oi".into()]));
        // CLI desconhecido (não vazio) → prompt posicional (degrade).
        assert_eq!(agent_args_for("gemini", "oi"), Some(vec!["oi".into()]));
        // Vazio → None.
        assert_eq!(agent_args_for("", "oi"), None);
        assert_eq!(agent_args_for("   ", "oi"), None);
    }
}
