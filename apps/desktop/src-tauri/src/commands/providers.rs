//! Central de Providers de LLM — registro ÚNICO de `{kind, baseUrl, modelo}` + a chave no
//! keychain do SO. O usuário cadastra a chave UMA vez e depois só seleciona provider+modelo
//! em qualquer lugar (Hermes, OmniPartner, review, agentes). Espelha o padrão do `hosts.rs`
//! (`~/.omnirift/*.json`, degrade limpo) + `secret_store` (chave fora do disco em claro).

use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};

/// Uma entrada da central (metadados). A CHAVE vive no keychain (conta `credential.llm.<id>`),
/// nunca no JSON — `hasKey` só diz se existe, sem trazer o valor.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LlmProvider {
    pub id: String,
    /// Nome amigável ("Meu Ollama Cloud").
    pub label: String,
    /// Tipo canônico: "ollama-cloud" | "openrouter" | "openai" | "anthropic" | "local".
    pub kind: String,
    /// Base URL (OpenAI-compat) — ex: https://ollama.com/v1.
    pub base_url: String,
    /// Modelo default escolhido (opcional; o picker pode sobrescrever).
    #[serde(default)]
    pub model: String,
    /// Só p/ a UI: há chave salva no keychain? (nunca traz o valor)
    #[serde(default)]
    pub has_key: bool,
}

#[cfg(windows)]
fn home_dir() -> Option<String> {
    std::env::var("USERPROFILE").ok()
}
#[cfg(not(windows))]
fn home_dir() -> Option<String> {
    std::env::var("HOME").ok()
}

/// `~/.omnirift/llm_providers.json` — mesmo diretório canônico do `hosts.json`.
fn providers_path() -> Result<PathBuf, String> {
    let home = home_dir().ok_or_else(|| "HOME indisponível".to_string())?;
    Ok(Path::new(&home).join(".omnirift").join("llm_providers.json"))
}

fn read_at(path: &Path) -> Result<Vec<LlmProvider>, String> {
    match std::fs::read_to_string(path) {
        Ok(s) if s.trim().is_empty() => Ok(vec![]),
        Ok(s) => serde_json::from_str(&s).map_err(|e| format!("llm_providers.json inválido: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(vec![]),
        Err(e) => Err(format!("falha lendo llm_providers.json: {e}")),
    }
}

fn write_at(path: &Path, items: &[LlmProvider]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("falha criando ~/.omnirift: {e}"))?;
    }
    let json = serde_json::to_string_pretty(items).map_err(|e| format!("falha serializando: {e}"))?;
    let mut f = std::fs::File::create(path).map_err(|e| format!("falha criando arquivo: {e}"))?;
    f.write_all(json.as_bytes()).map_err(|e| format!("falha gravando: {e}"))?;
    Ok(())
}

fn acct(id: &str) -> String {
    format!("credential.llm.{id}")
}

/// Lista os providers salvos (sem as chaves). `hasKey` reflete o keychain.
#[tauri::command]
pub fn providers_list() -> Result<Vec<LlmProvider>, String> {
    let path = providers_path()?;
    let mut list = read_at(&path)?;
    for p in &mut list {
        p.has_key = crate::memory::secret_store::get(&acct(&p.id)).is_some();
    }
    // Self-heal: colapsa duplicatas por kind+baseUrl (mantém a que TEM chave; senão a 1ª) e
    // reescreve o arquivo — limpa as duplicatas que os saves antigos (ids inconsistentes) deixaram.
    let before = list.len();
    let mut deduped: Vec<LlmProvider> = Vec::new();
    for p in list.into_iter() {
        match deduped
            .iter()
            .position(|x| x.kind == p.kind && x.base_url.trim() == p.base_url.trim())
        {
            Some(pos) => {
                if p.has_key && !deduped[pos].has_key {
                    deduped[pos] = p;
                }
            }
            None => deduped.push(p),
        }
    }
    if deduped.len() != before {
        let _ = write_at(&path, &deduped);
    }
    Ok(deduped)
}

/// Salva/atualiza um provider (upsert por id). `apiKey` (opcional) vai pro keychain; None =
/// mantém a chave existente. Retorna a entrada persistida (com `hasKey`).
#[tauri::command]
pub fn provider_save(mut entry: LlmProvider, api_key: Option<String>) -> Result<LlmProvider, String> {
    if entry.kind.trim().is_empty() || entry.base_url.trim().is_empty() {
        return Err("kind e baseUrl são obrigatórios".into());
    }
    let path = providers_path()?;
    let mut list = read_at(&path)?;
    // Dedup: os 3 pontos de save (wizard Hermes, config do review, modal Central) usavam ids
    // diferentes p/ o mesmo provider → duplicatas. Se já existe uma entrada com o MESMO id OU
    // o mesmo kind+baseUrl, reusa o id dela (ATUALIZA em vez de duplicar). 1 chave por (kind,url).
    let existing_id = list
        .iter()
        .find(|p| p.id == entry.id || (p.kind == entry.kind && p.base_url.trim() == entry.base_url.trim()))
        .map(|p| p.id.clone());
    if let Some(id) = existing_id {
        entry.id = id;
    }
    if entry.id.trim().is_empty() {
        return Err("id vazio".into());
    }
    if let Some(key) = api_key.filter(|k| !k.trim().is_empty()) {
        crate::memory::secret_store::set(&acct(&entry.id), key.trim());
    }
    entry.has_key = crate::memory::secret_store::get(&acct(&entry.id)).is_some();
    if let Some(existing) = list.iter_mut().find(|p| p.id == entry.id) {
        *existing = entry.clone();
    } else {
        list.push(entry.clone());
    }
    write_at(&path, &list)?;
    Ok(entry)
}

/// Remove um provider + a chave do keychain.
#[tauri::command]
pub fn provider_delete(id: String) -> Result<(), String> {
    let path = providers_path()?;
    let mut list = read_at(&path)?;
    list.retain(|p| p.id != id);
    write_at(&path, &list)?;
    crate::memory::secret_store::delete(&acct(&id));
    Ok(())
}

/// Provider resolvido p/ uso: `{kind, baseUrl, model, key}`. A chave vem do keychain.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedProvider {
    pub kind: String,
    pub base_url: String,
    pub model: String,
    pub key: String,
}

/// Resolve um provider salvo (traz a chave do keychain) p/ o consumidor injetar no spawn/chat.
#[tauri::command]
pub fn provider_resolve(id: String) -> Result<ResolvedProvider, String> {
    let list = read_at(&providers_path()?)?;
    let p = list
        .into_iter()
        .find(|p| p.id == id)
        .ok_or_else(|| "provider não encontrado".to_string())?;
    let key = crate::memory::secret_store::get(&acct(&id)).unwrap_or_default();
    Ok(ResolvedProvider { kind: p.kind, base_url: p.base_url, model: p.model, key })
}

/// Lista os modelos de um provider salvo — reusa o motor OpenAI-compat de `hermes_list_models`
/// (GET {baseUrl}/models). Anthropic não expõe /models → o picker cai no input manual.
#[tauri::command]
pub async fn provider_list_models(id: String) -> Result<Vec<String>, String> {
    let r = provider_resolve(id)?;
    crate::commands::acp::hermes_list_models(r.kind, r.key, Some(r.base_url)).await
}

/// Catálogo CURADO do claude-ollama (`~/.config/claude-ollama/models.env`): os valores dos
/// `ALIAS_*` (glm-5.2, kimi-k2.7-code, deepseek-v4-pro, qwen3.5:397b…) — o que o proxy `:11439`
/// serve DE FATO e o usuário usa. É a lista certa pro picker de modelo do subagente, porque o
/// `/v1/models` do ollama.com vem vazio/genérico. Ordenado, únicos. Vazio se o arquivo não existe
/// (setup sem claude-ollama). Best-effort — nunca falha.
#[tauri::command]
pub fn claude_ollama_models() -> Vec<String> {
    #[cfg(windows)]
    let home = std::env::var("USERPROFILE").ok();
    #[cfg(not(windows))]
    let home = std::env::var("HOME").ok();
    let Some(home) = home else { return Vec::new() };
    let path = PathBuf::from(home).join(".config/claude-ollama/models.env");
    let Ok(content) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    let mut seen = std::collections::BTreeSet::new();
    for line in content.lines() {
        let line = line.trim();
        if line.starts_with('#') {
            continue;
        }
        // ALIAS_<nome>=<model-id> → coletamos o model-id (o que vai no `model:`).
        if let Some(rest) = line.strip_prefix("ALIAS_") {
            if let Some((_, val)) = rest.split_once('=') {
                let v = val.trim().trim_matches('"');
                if !v.is_empty() {
                    seen.insert(v.to_string());
                }
            }
        }
    }
    seen.into_iter().collect()
}
