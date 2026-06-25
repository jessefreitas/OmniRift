//! Importar um agente pronto (arquivo) como Role.
//!
//! Dois formatos suportados (confirmados em arquivos reais):
//!  - **Codex `.toml`**: `name`, `description`, `developer_instructions = """…"""`
//!    (o caso do `fonder-ceo.toml`). cli inferido = "codex".
//!  - **Claude `.md`**: frontmatter `--- name / description ---` + corpo (persona).
//!    Mesmo formato de `.claude/agents/*.md`. cli inferido = "claude".
//!
//! Os docs referenciados na persona (ex.: `Documentacoes/Fonder/…`) são lidos pelo
//! próprio CLI quando roda no projeto — o OmniRift NÃO parseia esses docs.
//!
//! `role_template(kind)` devolve um template em branco (com comentários) que é
//! reimportável pelo próprio `role_import_file` (round-trip).

use serde::Serialize;
use std::path::Path;

/// Resultado de um import — vira um Role no frontend (id slug + AgentRoleDef).
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportedRole {
    pub name: String,
    pub description: String,
    /// Persona inteira → vira `role.prompt`.
    pub prompt: String,
    /// CLI inferido pelo formato ("codex" | "claude"). Editável antes de salvar.
    pub cli: String,
    /// Caminho de origem (guardado no role p/ re-sync opcional).
    pub source_path: String,
    /// "codex" | "claude" — formato detectado.
    pub format: String,
}

/// Tira aspas e espaços de um valor de frontmatter YAML simples.
fn unquote(v: &str) -> String {
    v.trim().trim_matches(|c| c == '"' || c == '\'').to_string()
}

/// Parseia um `.md` Claude: frontmatter YAML (name/description) + corpo (prompt).
/// Erro claro se faltar o frontmatter ou o campo `name`.
fn parse_claude_md(content: &str, source_path: &str) -> Result<ImportedRole, String> {
    // trim_start p/ casar com a detecção (looks_claude usa trim_start) — um .md com
    // linha em branco no topo ainda parseia o frontmatter.
    let rest = content.trim_start().strip_prefix("---").ok_or_else(|| {
        "formato Claude (.md) exige frontmatter `---\\nname: …\\n---` no topo".to_string()
    })?;
    let end = rest.find("\n---").ok_or_else(|| {
        "frontmatter não fechado — falta a linha `---` de fechamento".to_string()
    })?;
    let fm = &rest[..end];
    let body = rest[end + 4..].trim_start_matches('\n');

    let mut name = String::new();
    let mut description = String::new();
    for line in fm.lines() {
        if let Some(v) = line.strip_prefix("name:") {
            name = unquote(v);
        } else if let Some(v) = line.strip_prefix("description:") {
            description = unquote(v);
        }
    }
    if name.is_empty() {
        return Err("campo obrigatório ausente: `name` no frontmatter".into());
    }
    Ok(ImportedRole {
        name,
        description,
        prompt: body.trim().to_string(),
        cli: "claude".into(),
        source_path: source_path.to_string(),
        format: "claude".into(),
    })
}

/// Parseia um `.toml` Codex: `name`, `description`, `developer_instructions`(→prompt).
/// Erro claro se o TOML for inválido ou faltar `name`/`developer_instructions`.
fn parse_codex_toml(content: &str, source_path: &str) -> Result<ImportedRole, String> {
    let v: toml::Value =
        toml::from_str(content).map_err(|e| format!("TOML inválido: {e}"))?;
    let get = |k: &str| v.get(k).and_then(|x| x.as_str()).map(|s| s.to_string());

    let name = get("name").filter(|s| !s.trim().is_empty()).ok_or_else(|| {
        "campo obrigatório ausente: `name` no .toml".to_string()
    })?;
    let prompt = get("developer_instructions")
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| {
            "campo obrigatório ausente: `developer_instructions` no .toml".to_string()
        })?;
    Ok(ImportedRole {
        name: name.trim().to_string(),
        description: get("description").unwrap_or_default().trim().to_string(),
        prompt: prompt.trim().to_string(),
        cli: "codex".into(),
        source_path: source_path.to_string(),
        format: "codex".into(),
    })
}

/// Detecção de formato + parse. `.toml` (ou conteúdo com `developer_instructions`)
/// = Codex; `.md` com frontmatter = Claude.
fn parse_role_file(path: &str, content: &str) -> Result<ImportedRole, String> {
    let ext = Path::new(path)
        .extension()
        .and_then(|x| x.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_default();

    let looks_codex = ext == "toml" || content.contains("developer_instructions");
    let looks_claude = ext == "md" || content.trim_start().starts_with("---");

    if looks_codex {
        parse_codex_toml(content, path)
    } else if looks_claude {
        parse_claude_md(content, path)
    } else {
        Err(format!(
            "formato desconhecido para `{path}` — use `.toml` (Codex) ou `.md` com frontmatter (Claude)"
        ))
    }
}

/// Lê e parseia um arquivo de agente como Role importável.
#[tauri::command]
pub fn role_import_file(path: String) -> Result<ImportedRole, String> {
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("não consegui ler `{path}`: {e}"))?;
    parse_role_file(&path, &content)
}

const CODEX_TEMPLATE: &str = r#"# Template de agente Codex (.toml) para OmniRift.
# Preencha os campos abaixo e reimporte via "＋ de arquivo" no painel Roles.
# `name` vira o nome do role; `description` aparece no tooltip;
# `developer_instructions` é a PERSONA inteira (vira o prompt do agente).

# Nome curto do agente (obrigatório).
name = ""

# Descrição de uma linha — quando usar este agente (opcional).
description = ""

# Persona completa. Pode referenciar docs por caminho relativo ao projeto;
# o Codex lê esses docs sozinho ao rodar (o OmniRift NÃO parseia).
developer_instructions = """
Você é …

Mandato:
- …

Limite:
- …
"""
"#;

const CLAUDE_TEMPLATE: &str = r#"---
name: meu-agente
description: Quando usar este agente (uma linha).
---

<!-- Corpo = persona completa (vira o prompt do agente).
     Pode referenciar docs por caminho; o Claude lê sozinho ao rodar. -->

Você é …

Mandato:
- …

Limite:
- …
"#;

/// Devolve o template (string) de um formato. Reimportável pelo próprio
/// `role_import_file` (round-trip) — depois de preencher os campos.
#[tauri::command]
pub fn role_template(kind: String) -> Result<String, String> {
    match kind.as_str() {
        "codex" => Ok(CODEX_TEMPLATE.to_string()),
        "claude" => Ok(CLAUDE_TEMPLATE.to_string()),
        other => Err(format!("kind desconhecido: `{other}` — use \"codex\" ou \"claude\"")),
    }
}

/// Grava o template num caminho (usado pelo "baixar modelo" quando o
/// `@tauri-apps/plugin-fs` não está disponível — escreve via Rust).
#[tauri::command]
pub fn role_template_save(path: String, kind: String) -> Result<(), String> {
    let content = role_template(kind)?;
    std::fs::write(&path, content).map_err(|e| format!("não consegui escrever `{path}`: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Conteúdo do `fonder-ceo.toml` real (formato Codex).
    const FONDER_CEO_TOML: &str = r#"name = "fonder-ceo"
description = "Ponto de entrada padrao e router executivo da Fonder. Use para interpretar qualquer demanda."
developer_instructions = """
Voce e o CEO Fonder, agente executivo consultivo da Fonder.

Mandato:
- ser o ponto de entrada padrao para toda demanda;
- proteger coerencia estrategica.

Limite:
- voce e read-only/advisory nesta v1;
- nao edite arquivos.
"""
"#;

    #[test]
    fn parse_codex_toml_real() {
        let r = parse_role_file("fonder-ceo.toml", FONDER_CEO_TOML).expect("parse");
        assert_eq!(r.name, "fonder-ceo");
        assert_eq!(r.cli, "codex");
        assert_eq!(r.format, "codex");
        assert!(r.prompt.contains("CEO Fonder"), "prompt deve conter a persona");
        assert!(r.description.contains("router executivo"));
        assert_eq!(r.source_path, "fonder-ceo.toml");
    }

    #[test]
    fn parse_codex_by_content_without_ext() {
        // Sem extensão, mas tem `developer_instructions` → detecta Codex.
        let r = parse_role_file("/tmp/agente", FONDER_CEO_TOML).expect("parse");
        assert_eq!(r.cli, "codex");
    }

    #[test]
    fn parse_claude_md_frontmatter() {
        let md = "---\nname: revisor\ndescription: Revisa código.\n---\n\nVocê é um revisor rigoroso.\nAponte bugs.\n";
        let r = parse_role_file("revisor.md", md).expect("parse");
        assert_eq!(r.name, "revisor");
        assert_eq!(r.cli, "claude");
        assert_eq!(r.format, "claude");
        assert_eq!(r.description, "Revisa código.");
        assert!(r.prompt.starts_with("Você é um revisor"));
        assert!(r.prompt.contains("Aponte bugs"));
    }

    #[test]
    fn err_unknown_format() {
        let e = parse_role_file("notas.txt", "só um texto qualquer").unwrap_err();
        assert!(e.contains("formato desconhecido"), "msg: {e}");
    }

    #[test]
    fn err_codex_invalid_toml() {
        let e = parse_role_file("x.toml", "name = = quebrado").unwrap_err();
        assert!(e.contains("TOML inválido"), "msg: {e}");
    }

    #[test]
    fn err_codex_missing_required_field() {
        // .toml válido mas sem developer_instructions.
        let e = parse_role_file("x.toml", "name = \"x\"\n").unwrap_err();
        assert!(e.contains("developer_instructions"), "msg: {e}");
    }

    #[test]
    fn err_claude_no_frontmatter() {
        let e = parse_role_file("x.md", "sem frontmatter aqui").unwrap_err();
        assert!(e.contains("frontmatter"), "msg: {e}");
    }

    #[test]
    fn err_claude_missing_name() {
        let e = parse_role_file("x.md", "---\ndescription: só desc\n---\ncorpo").unwrap_err();
        assert!(e.contains("name"), "msg: {e}");
    }

    #[test]
    fn parse_claude_md_leading_blank_lines() {
        // .md com linhas em branco no topo: detecção e parse devem concordar.
        let md = "\n\n---\nname: revisor\ndescription: d\n---\ncorpo da persona";
        let r = parse_role_file("r.md", md).expect("parse apesar do topo em branco");
        assert_eq!(r.name, "revisor");
        assert_eq!(r.cli, "claude");
        assert!(r.prompt.contains("corpo da persona"));
    }

    #[test]
    fn template_codex_is_reimportable() {
        let t = role_template("codex".into()).expect("template");
        // Preenche os campos vazios do template e confirma que reimporta.
        let filled = t
            .replacen("name = \"\"", "name = \"teste\"", 1)
            .replacen(
                "developer_instructions = \"\"\"",
                "developer_instructions = \"\"\"\nVocê é o agente de teste.",
                1,
            );
        let r = parse_role_file("modelo.toml", &filled).expect("reimport");
        assert_eq!(r.name, "teste");
        assert_eq!(r.cli, "codex");
        assert!(r.prompt.contains("agente de teste"));
    }

    #[test]
    fn template_codex_blank_is_valid_toml() {
        // O template em branco deve ser TOML válido (só falha por campo obrigatório
        // vazio, não por sintaxe).
        let t = role_template("codex".into()).expect("template");
        let e = parse_role_file("modelo.toml", &t).unwrap_err();
        assert!(e.contains("name") || e.contains("developer_instructions"), "msg: {e}");
        assert!(!e.contains("TOML inválido"), "template não pode ter sintaxe quebrada: {e}");
    }

    #[test]
    fn template_claude_is_reimportable() {
        let t = role_template("claude".into()).expect("template");
        let r = parse_role_file("modelo.md", &t).expect("reimport");
        assert_eq!(r.name, "meu-agente");
        assert_eq!(r.cli, "claude");
    }

    #[test]
    fn template_unknown_kind_errs() {
        assert!(role_template("xpto".into()).is_err());
    }

    #[test]
    #[ignore] // só roda sob demanda: depende do arquivo real na máquina do Jesse.
    fn parse_real_fonder_ceo_file() {
        let path = "/home/skycracker/Documentos/fonder-ceo.toml";
        let r = role_import_file(path.to_string()).expect("real file");
        assert_eq!(r.name, "fonder-ceo");
        assert_eq!(r.cli, "codex");
        assert!(r.prompt.contains("CEO Fonder"));
        assert!(r.prompt.contains("rtk git status")); // backticks dentro do triple-quote
    }
}
