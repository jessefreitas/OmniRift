use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::Manager;

/// Uma skill já resolvida no disco (id + metadados + dir raiz da skill).
pub struct ResolvedSkill {
    pub id: String,
    pub name: String,
    pub description: String,
    pub dir: PathBuf, // dir que contém o SKILL.md (e scripts/, references/, ...)
}

/// Como o spawn deve consumir o bundle materializado, por estratégia de CLI.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SkillWiring {
    /// claude: adicionar ["--plugin-dir", dir] aos args.
    PluginDir { dir: String },
    /// codex: setar env CODEX_HOME=home no spawn.
    CodexHome { home: String },
    /// fallback: anexar `text` (índice nome — desc — caminho) à 1ª mensagem.
    IndexPrompt { text: String },
}

fn cli_base(cli: &str) -> &str {
    Path::new(cli).file_name().and_then(|s| s.to_str()).unwrap_or(cli)
}

/// Materializa o bundle para `cli` dentro de `base_dir` (= app_data_dir).
/// `None` quando o bundle é vazio, o CLI é desconhecido, ou a materialização falha
/// (degradação graciosa: o agente sobe sem skills, como hoje).
pub fn materialize_wiring(cli: &str, skills: &[ResolvedSkill], base_dir: &Path) -> Option<SkillWiring> {
    if skills.is_empty() {
        return None;
    }
    match cli_base(cli) {
        "claude" => materialize_plugin_dir(skills, base_dir).map(|dir| SkillWiring::PluginDir { dir }),
        "codex" => materialize_codex_home(skills, base_dir).map(|home| SkillWiring::CodexHome { home }),
        "opencode" | "agy" | "antigravity" => Some(SkillWiring::IndexPrompt { text: index_prompt(skills) }),
        _ => None,
    }
}

/// Hash content-addressed dos IDs ordenados → dir estável entre restarts.
/// FNV-1a 64-bit: determinístico em qualquer versão/plataforma do Rust. NÃO usar
/// `DefaultHasher` — seu seed/algoritmo (SipHash) não são contratuais e podem mudar
/// entre toolchains, orfanando os dirs já materializados.
fn bundle_key(skills: &[ResolvedSkill]) -> String {
    let mut ids: Vec<&str> = skills.iter().map(|s| s.id.as_str()).collect();
    ids.sort_unstable();
    let joined = ids.join("\0");
    let mut h: u64 = 0xcbf2_9ce4_8422_2325; // FNV offset basis
    for b in joined.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3); // FNV prime
    }
    format!("{h:016x}")
}

fn materialize_plugin_dir(skills: &[ResolvedSkill], base: &Path) -> Option<String> {
    let root = base.join("agent-skills").join("claude").join(bundle_key(skills));
    // Já materializado e completo → reusa SEM apagar. Race-free: nunca destrói um dir
    // que o claude de outro agente (mesmo bundle) pode estar lendo via --plugin-dir.
    // Conteúdo é content-addressed por ID; mudar o set de IDs muda o dir. (Editar o
    // CORPO de uma skill in-place não é repropagado na Fase 1 — set de IDs é a chave.)
    if root.join(".claude-plugin/plugin.json").exists()
        && std::fs::read_dir(root.join("skills")).map(|mut r| r.next().is_some()).unwrap_or(false)
    {
        return Some(root.to_string_lossy().to_string());
    }
    // Build inicial (ou incompleto): (re)materializa do zero.
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join(".claude-plugin")).ok()?;
    std::fs::create_dir_all(root.join("skills")).ok()?;

    let manifest = serde_json::json!({
        "name": "omnirift-curated",
        "description": "Bundle de skills curado pelo OmniRift para este agente.",
        "version": "1.0.0"
    });
    std::fs::write(root.join(".claude-plugin/plugin.json"),
        serde_json::to_string_pretty(&manifest).ok()?).ok()?;

    let mut copied = 0usize;
    for s in skills {
        if !s.dir.join("SKILL.md").exists() { continue; } // ID ausente → ignora (graceful)
        let dst = root.join("skills").join(&s.id);
        if copy_dir_recursive(&s.dir, &dst).is_ok() { copied += 1; }
    }
    if copied == 0 { let _ = std::fs::remove_dir_all(&root); return None; }
    Some(root.to_string_lossy().to_string())
}

/// Copia recursivamente (sem seguir/duplicar symlinks como symlink — resolve o alvo).
fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if from.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else {
            std::fs::copy(&from, &to)?; // copy segue symlink → grava arquivo real
        }
    }
    Ok(())
}

fn real_codex_home() -> Option<PathBuf> {
    if let Ok(h) = std::env::var("CODEX_HOME") {
        if !h.is_empty() { return Some(PathBuf::from(h)); }
    }
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()
        .map(|h| PathBuf::from(h).join(".codex"))
}

fn materialize_codex_home(skills: &[ResolvedSkill], base: &Path) -> Option<String> {
    let home = base.join("agent-codex-home").join(bundle_key(skills));
    // Reusa se já tem ≥1 skill curada (race-free: não apaga home que outro codex lê).
    if std::fs::read_dir(home.join("skills"))
        .map(|r| r.flatten().any(|e| e.path().join("SKILL.md").exists()))
        .unwrap_or(false)
    {
        return Some(home.to_string_lossy().to_string());
    }
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(home.join("skills")).ok()?;

    // Preserva login + config + system-skills do home real (symlink — codex segue).
    if let Some(real) = real_codex_home() {
        for f in ["config.toml", "auth.json"] {
            let src = real.join(f);
            if src.exists() { let _ = symlink(&src, &home.join(f)); }
        }
        let sys = real.join("skills/.system");
        if sys.exists() { let _ = symlink(&sys, &home.join("skills/.system")); }
    }

    let mut copied = 0usize;
    for s in skills {
        if !s.dir.join("SKILL.md").exists() { continue; }
        let dst = home.join("skills").join(&s.id);
        if copy_dir_recursive(&s.dir, &dst).is_ok() { copied += 1; }
    }
    if copied == 0 { let _ = std::fs::remove_dir_all(&home); return None; }
    Some(home.to_string_lossy().to_string())
}

#[cfg(unix)]
fn symlink(src: &Path, dst: &Path) -> std::io::Result<()> { std::os::unix::fs::symlink(src, dst) }
#[cfg(windows)]
fn symlink(src: &Path, dst: &Path) -> std::io::Result<()> {
    if src.is_dir() { std::os::windows::fs::symlink_dir(src, dst) }
    else { std::os::windows::fs::symlink_file(src, dst) }
}

fn index_prompt(skills: &[ResolvedSkill]) -> String {
    // NOTE: expõe o caminho absoluto (home do usuário) de cada skill na 1ª mensagem —
    // intencional (o agente faz `cat` sob demanda). Se um dia houver export/gravação de
    // conversa, considerar caminho relativo/redação.
    let lines: Vec<String> = skills.iter()
        .map(|s| format!("- {} — {} — {}", s.name, s.description, s.dir.join("SKILL.md").display()))
        .collect();
    format!(
        "Skills disponíveis pra esta sessão (leia o corpo sob demanda com `cat <caminho>`):\n{}",
        lines.join("\n")
    )
}

#[derive(Debug, Clone, Serialize)]
pub struct InstalledSkill {
    pub id: String,
    pub name: String,
    pub description: String,
    pub source: String, // "claude-global" | "codex-global" | "claude-plugin"
    pub path: String,    // dir da skill
}

/// Lê só o frontmatter YAML simples (name:/description:) — nunca o corpo.
fn parse_frontmatter(skill_md: &Path) -> Option<(String, String)> {
    let txt = std::fs::read_to_string(skill_md).ok()?;
    let mut name = String::new();
    let mut desc = String::new();
    let mut in_fm = false;
    for (i, line) in txt.lines().enumerate() {
        if i == 0 && line.trim() == "---" { in_fm = true; continue; }
        if in_fm && line.trim() == "---" { break; }
        if let Some(v) = line.strip_prefix("name:") { name = v.trim().to_string(); }
        if let Some(v) = line.strip_prefix("description:") { desc = v.trim().to_string(); }
    }
    if name.is_empty() && desc.is_empty() { None } else { Some((name, desc)) }
}

fn scan_skills_root(root: &Path) -> Vec<InstalledSkill> {
    let mut out = vec![];
    let Ok(rd) = std::fs::read_dir(root) else { return out };
    for e in rd.flatten() {
        let dir = e.path();
        if !dir.is_dir() { continue; }
        let md = dir.join("SKILL.md");
        if !md.exists() { continue; }
        let id = dir.file_name().and_then(|s| s.to_str()).unwrap_or_default().to_string();
        if id.starts_with('.') { continue; } // pula .system etc.
        let (name, desc) = parse_frontmatter(&md).unwrap_or((id.clone(), String::new()));
        out.push(InstalledSkill {
            id: id.clone(),
            name: if name.is_empty() { id } else { name },
            description: desc, source: String::new(),
            path: dir.to_string_lossy().to_string(),
        });
    }
    out
}

#[tauri::command]
pub fn list_installed_skills() -> Vec<InstalledSkill> {
    let mut all = vec![];
    if let Ok(home) = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")) {
        let home = PathBuf::from(home);
        for (sub, source) in [(".claude/skills", "claude-global"), (".codex/skills", "codex-global")] {
            let mut v = scan_skills_root(&home.join(sub));
            for s in &mut v { s.source = source.to_string(); }
            all.append(&mut v);
        }
        // plugins claude: <plugins>/marketplaces/*/plugins/*/skills/*
        let mk = home.join(".claude/plugins/marketplaces");
        if let Ok(mks) = std::fs::read_dir(&mk) {
            for m in mks.flatten() {
                let plugs = m.path().join("plugins");
                if let Ok(ps) = std::fs::read_dir(&plugs) {
                    for p in ps.flatten() {
                        let mut v = scan_skills_root(&p.path().join("skills"));
                        for s in &mut v { s.source = "claude-plugin".to_string(); }
                        all.append(&mut v);
                    }
                }
            }
        }
    }
    all
}

/// Resolve as chaves de skill (do role/override) → ResolvedSkill. Casa por `id`
/// (basename do dir, único) e, como fallback, por `name` (frontmatter) — porque o
/// RoleEditModal guarda a skill pelo `name`, que diverge do dir em skills importadas
/// com nome não-slug (ex.: "My Cool Skill" vs dir `my-cool-skill`). id tem prioridade
/// pra evitar ambiguidade quando um name casa com o id de outra skill.
fn resolve_skills(installed: &[InstalledSkill], keys: &[String]) -> Vec<ResolvedSkill> {
    keys.iter()
        .filter_map(|key| {
            installed
                .iter()
                .find(|s| &s.id == key)
                .or_else(|| installed.iter().find(|s| &s.name == key))
                .map(|s| ResolvedSkill {
                    id: s.id.clone(),
                    name: s.name.clone(),
                    description: s.description.clone(),
                    dir: PathBuf::from(&s.path),
                })
        })
        .collect()
}

#[tauri::command]
pub fn agent_skills_config(app: tauri::AppHandle, cli: String, skill_ids: Vec<String>) -> Option<SkillWiring> {
    if skill_ids.is_empty() { return None; }
    let resolved = resolve_skills(&list_installed_skills(), &skill_ids);
    if resolved.is_empty() { return None; } // nenhum id/name casou → graceful (fail-open)
    let base = app.path().app_data_dir().ok()?;
    std::fs::create_dir_all(&base).ok()?;
    materialize_wiring(&cli, &resolved, &base)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Tests that mutate process env run serially via a shared guard.
    use std::sync::Mutex;
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    // helper: dir único sem Date/rand (usa pid + contador atômico)
    fn tempdir_unique(tag: &str) -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU32, Ordering};
        static N: AtomicU32 = AtomicU32::new(0);
        let p = std::env::temp_dir().join(format!("omnirift-test-{tag}-{}-{}",
            std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn sd(id: &str) -> ResolvedSkill {
        ResolvedSkill { id: id.into(), name: id.into(), description: "d".into(),
            dir: std::path::PathBuf::from(format!("/nonexistent/{id}")) }
    }

    fn inst(id: &str, name: &str) -> InstalledSkill {
        InstalledSkill { id: id.into(), name: name.into(), description: "d".into(),
            source: "test".into(), path: format!("/x/{id}") }
    }

    #[test]
    fn resolve_matches_by_id_then_name() {
        let installed = vec![inst("my-cool-skill", "My Cool Skill"), inst("alpha", "alpha")];
        // casa por id (dir basename)
        assert_eq!(resolve_skills(&installed, &["my-cool-skill".into()])[0].id, "my-cool-skill");
        // casa por name (RoleEditModal guarda o name não-slug) — era o bug do Phase-2
        let by_name = resolve_skills(&installed, &["My Cool Skill".into()]);
        assert_eq!(by_name.len(), 1, "name != dir deve resolver por name");
        assert_eq!(by_name[0].id, "my-cool-skill");
        // chave inexistente é ignorada (fail-open), sem panic
        let mixed = resolve_skills(&installed, &["sumiu".into(), "alpha".into()]);
        assert_eq!(mixed.len(), 1);
        assert_eq!(mixed[0].id, "alpha");
    }

    #[test]
    fn resolve_prefers_id_over_name_on_collision() {
        // "x" é id de uma skill E name de outra → id ganha (sem ambiguidade)
        let installed = vec![inst("x", "X skill"), inst("other", "x")];
        let r = resolve_skills(&installed, &["x".into()]);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].id, "x", "match por id tem prioridade");
    }

    #[test]
    fn empty_bundle_is_noop() {
        // Sem skills => None => spawn idêntico ao de hoje (zero regressão).
        assert!(materialize_wiring("claude", &[], std::path::Path::new("/tmp/x")).is_none());
        assert!(materialize_wiring("codex", &[], std::path::Path::new("/tmp/x")).is_none());
        assert!(materialize_wiring("opencode", &[], std::path::Path::new("/tmp/x")).is_none());
    }

    #[test]
    fn unknown_cli_is_none() {
        let skills = vec![sd("a")];
        assert!(materialize_wiring("totally-unknown", &skills, std::path::Path::new("/tmp/x")).is_none());
    }

    #[test]
    fn claude_builds_plugin_dir_with_manifest_and_skills() {
        let tmp = tempdir_unique("claude-plug");
        // skill de origem no disco
        let src = tmp.join("src-skill/my-skill");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("SKILL.md"), "---\nname: my-skill\ndescription: d\n---\nbody").unwrap();
        let skills = vec![ResolvedSkill { id: "my-skill".into(), name: "my-skill".into(),
            description: "d".into(), dir: src.clone() }];

        let base = tmp.join("appdata");
        let w = materialize_wiring("claude", &skills, &base).unwrap();
        let dir = match w { SkillWiring::PluginDir { dir } => dir, _ => panic!("esperava PluginDir") };
        let p = std::path::Path::new(&dir);
        assert!(p.join(".claude-plugin/plugin.json").exists(), "manifest");
        assert!(p.join("skills/my-skill/SKILL.md").exists(), "skill copiada (não symlink)");
        // copiada de verdade (não symlink externo, que o claude ignoraria)
        assert!(!std::fs::symlink_metadata(p.join("skills/my-skill/SKILL.md")).unwrap().file_type().is_symlink());
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn codex_builds_home_with_skills_and_links() {
        let _g = ENV_LOCK.lock().unwrap();
        let tmp = tempdir_unique("codex-home");
        // home real fake
        let real = tmp.join("real-codex");
        std::fs::create_dir_all(real.join("skills/.system")).unwrap();
        std::fs::write(real.join("config.toml"), "model=\"gpt-5.5\"").unwrap();
        std::fs::write(real.join("auth.json"), "{}").unwrap();
        std::env::set_var("CODEX_HOME", &real); // materialize_codex_home lê isso

        let src = tmp.join("src-skill/sk");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("SKILL.md"), "---\nname: sk\ndescription: d\n---\nx").unwrap();
        let skills = vec![ResolvedSkill { id: "sk".into(), name: "sk".into(), description: "d".into(), dir: src }];

        let base = tmp.join("appdata");
        let w = materialize_wiring("codex", &skills, &base).unwrap();
        let home = match w { SkillWiring::CodexHome { home } => home, _ => panic!("esperava CodexHome") };
        let p = std::path::Path::new(&home);
        assert!(p.join("skills/sk/SKILL.md").exists(), "skill curada");
        assert!(p.join("config.toml").exists(), "config linkado");
        assert!(p.join("auth.json").exists(), "auth linkado");
        std::env::remove_var("CODEX_HOME");
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn opencode_gets_index_prompt() {
        let skills = vec![ResolvedSkill { id: "x".into(), name: "Xeon".into(),
            description: "faz X".into(), dir: std::path::PathBuf::from("/skills/x") }];
        let w = materialize_wiring("opencode", &skills, std::path::Path::new("/tmp")).unwrap();
        match w {
            SkillWiring::IndexPrompt { text } => {
                assert!(text.contains("Xeon — faz X — /skills/x/SKILL.md"));
            }
            _ => panic!("esperava IndexPrompt"),
        }
    }

    #[test]
    fn claude_skips_missing_skill_dir_without_panic() {
        let tmp = tempdir_unique("missing");
        // só metadados, dir não existe → deve ser ignorada; bundle vira None (nenhuma válida)
        let skills = vec![ResolvedSkill { id: "ghost".into(), name: "ghost".into(),
            description: "d".into(), dir: tmp.join("nope") }];
        assert!(materialize_wiring("claude", &skills, &tmp.join("appdata")).is_none());
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn claude_plugin_dir_reused_without_destructive_wipe() {
        // Fix do race TOCTOU: a 2ª materialização do mesmo bundle reusa o dir e NÃO
        // o destrói (um claude concorrente poderia estar lendo via --plugin-dir).
        let tmp = tempdir_unique("reuse");
        let src = tmp.join("src/keep");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("SKILL.md"), "---\nname: keep\ndescription: d\n---\nx").unwrap();
        let skills = vec![ResolvedSkill { id: "keep".into(), name: "keep".into(),
            description: "d".into(), dir: src }];
        let base = tmp.join("appdata");

        let d1 = match materialize_wiring("claude", &skills, &base).unwrap() {
            SkillWiring::PluginDir { dir } => dir, _ => panic!() };
        // marca-d'água: arquivo que NÃO seria recriado se houvesse wipe+rebuild
        std::fs::write(std::path::Path::new(&d1).join("skills/keep/.witness"), "1").unwrap();

        let d2 = match materialize_wiring("claude", &skills, &base).unwrap() {
            SkillWiring::PluginDir { dir } => dir, _ => panic!() };
        assert_eq!(d1, d2, "mesmo bundle → mesmo dir");
        assert!(std::path::Path::new(&d2).join("skills/keep/.witness").exists(),
            "dir reusado, não apagado na 2ª chamada");
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn bundle_key_deterministic_and_order_independent() {
        // Mesmo set de IDs (ordem diferente) → mesma chave; set diferente → chave diferente.
        let a = vec![sd("alpha"), sd("beta")];
        let b = vec![sd("beta"), sd("alpha")];
        let c = vec![sd("alpha"), sd("gamma")];
        assert_eq!(bundle_key(&a), bundle_key(&b), "ordem dos IDs não pode mudar a chave");
        assert_ne!(bundle_key(&a), bundle_key(&c), "set diferente → chave diferente");
    }

    #[test]
    fn scans_skill_dir_metadata_only() {
        let tmp = tempdir_unique("scan");
        let s = tmp.join("alpha"); std::fs::create_dir_all(&s).unwrap();
        std::fs::write(s.join("SKILL.md"),
            "---\nname: alpha\ndescription: faz alpha\n---\ncorpo enorme aqui").unwrap();
        let found = scan_skills_root(&tmp);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].name, "alpha");
        assert_eq!(found[0].description, "faz alpha");
        assert!(found[0].path.ends_with("alpha")); // dir, não o corpo
        std::fs::remove_dir_all(&tmp).ok();
    }
}
