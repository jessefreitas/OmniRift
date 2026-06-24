//! Bloco E — coordenação por claims (blackboard de arquivos).
//!
//! Registry em memória de "claims": antes de editar um arquivo, um agente
//! reivindica (`acquire`) o path; outro agente que tente reivindicar o MESMO path
//! recebe `Conflict`. É cooperativo (não trava o filesystem de verdade) mas dá
//! enforcement real às tools MCP `claim_*` — substitui o claim só-textual
//! (`memory_remember "claim: ..."`) por estado consultável.
//!
//! Também serve a detecção PRÓ-ATIVA de paths cruzados entre specs ativas
//! (frontmatter `paths:`) — ver `paths_overlap` / `spec_path_conflicts`.

use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// Uma reivindicação ativa sobre um path.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClaimEntry {
    /// Path normalizado (chave canônica).
    pub path: String,
    /// Path como o agente enviou (pra exibição/log).
    pub raw_path: String,
    /// Label do agente que detém o claim.
    pub agent_label: String,
    /// Floor/branch do agente (topologia), quando conhecido.
    pub floor: Option<String>,
    /// Epoch (segundos) de quando foi adquirido.
    pub ts: u64,
}

/// Conflito detectado: um path reivindicado por mais de um agente/floor, OU
/// sobreposição de `paths:` entre specs (detecção pró-ativa).
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Conflict {
    /// Path (normalizado) em disputa.
    pub path: String,
    /// Quem já detém / a primeira fonte.
    pub holder: String,
    /// Floor de quem detém.
    pub holder_floor: Option<String>,
    /// Quem tentou / a segunda fonte (agente ou outra spec).
    pub requester: String,
    /// Floor de quem tentou.
    pub requester_floor: Option<String>,
}

/// Normaliza um path pra chave canônica de claim:
/// - separadores `\` → `/`;
/// - colapsa `//` repetidos;
/// - remove `./` inicial e trailing `/`;
/// - lowercase NO WINDOWS (FS case-insensitive); preserva caso no Unix.
pub fn normalize_path(p: &str) -> String {
    let mut s = p.trim().replace('\\', "/");
    while s.contains("//") {
        s = s.replace("//", "/");
    }
    if let Some(rest) = s.strip_prefix("./") {
        s = rest.to_string();
    }
    let trimmed = s.trim_end_matches('/');
    if !trimmed.is_empty() {
        s = trimmed.to_string();
    }
    if cfg!(windows) {
        s = s.to_lowercase();
    }
    s
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Registry de claims — estado PURO em app (sem threads, sem IO). `app.manage`
/// disto no boot é seguro: nada roda nem panica.
#[derive(Default)]
pub struct ClaimsRegistry {
    inner: Mutex<HashMap<String, ClaimEntry>>,
}

impl ClaimsRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Reivindica `path` pra `agent` (no `floor`). Erro `Conflict` se já está
    /// reivindicado por OUTRO agente. Re-acquire do MESMO agente é idempotente
    /// (atualiza o ts/floor).
    pub fn acquire(
        &self,
        path: &str,
        agent: &str,
        floor: Option<String>,
    ) -> Result<ClaimEntry, Conflict> {
        let key = normalize_path(path);
        let mut map = self.inner.lock().unwrap();
        if let Some(existing) = map.get(&key) {
            if existing.agent_label != agent {
                return Err(Conflict {
                    path: key,
                    holder: existing.agent_label.clone(),
                    holder_floor: existing.floor.clone(),
                    requester: agent.to_string(),
                    requester_floor: floor,
                });
            }
        }
        let entry = ClaimEntry {
            path: key.clone(),
            raw_path: path.trim().to_string(),
            agent_label: agent.to_string(),
            floor,
            ts: now_secs(),
        };
        map.insert(key, entry.clone());
        Ok(entry)
    }

    /// Libera `path` se for detido por `agent`. Devolve true se removeu.
    /// Não remove claim de outro agente (silenciosamente false).
    pub fn release(&self, path: &str, agent: &str) -> bool {
        let key = normalize_path(path);
        let mut map = self.inner.lock().unwrap();
        match map.get(&key) {
            Some(e) if e.agent_label == agent => {
                map.remove(&key);
                true
            }
            _ => false,
        }
    }

    /// Libera TODOS os claims de um agente (ex.: quando o agente encerra/morre).
    /// Devolve quantos liberou.
    pub fn release_agent(&self, agent: &str) -> usize {
        let mut map = self.inner.lock().unwrap();
        let before = map.len();
        map.retain(|_, e| e.agent_label != agent);
        before - map.len()
    }

    /// Lista todos os claims ativos (ordenados por path).
    pub fn list(&self) -> Vec<ClaimEntry> {
        let map = self.inner.lock().unwrap();
        let mut v: Vec<ClaimEntry> = map.values().cloned().collect();
        v.sort_by(|a, b| a.path.cmp(&b.path));
        v
    }

    /// Para cada path consultado, devolve o Conflict se houver claim ativo de
    /// OUTRO agente. `requester`/`floor` identificam quem está perguntando.
    pub fn check(
        &self,
        paths: &[String],
        requester: &str,
        floor: Option<&str>,
    ) -> Vec<Conflict> {
        let map = self.inner.lock().unwrap();
        let mut out = Vec::new();
        for p in paths {
            let key = normalize_path(p);
            if let Some(e) = map.get(&key) {
                if e.agent_label != requester {
                    out.push(Conflict {
                        path: key,
                        holder: e.agent_label.clone(),
                        holder_floor: e.floor.clone(),
                        requester: requester.to_string(),
                        requester_floor: floor.map(String::from),
                    });
                }
            }
        }
        out
    }
}

// ── Detecção pró-ativa de paths cruzados entre specs (frontmatter `paths:`) ──────

/// Normaliza um glob/path declarado em `paths:` pra comparar sobreposição:
/// tira o sufixo de glob (`/**`, `/*`, trailing `*`) e normaliza separadores.
fn normalize_glob_base(p: &str) -> String {
    let s = normalize_path(p);
    let s = s
        .trim_end_matches("/**")
        .trim_end_matches("/*")
        .trim_end_matches("**")
        .trim_end_matches('*')
        .trim_end_matches('/');
    s.to_string()
}

/// Dois paths/globs declarados se cruzam se, depois de tirar o glob, um é prefixo
/// (de segmento) do outro — ou são iguais. Ex.: `src/lib/db/**` × `src/lib/db/x.ts`
/// → cruzam; `src/a` × `src/ab` → NÃO (segmento diferente).
pub fn paths_overlap(a: &str, b: &str) -> bool {
    let na = normalize_glob_base(a);
    let nb = normalize_glob_base(b);
    if na.is_empty() || nb.is_empty() {
        // Glob "tudo" (ex.: `**`) — considera que cruza com qualquer coisa.
        return true;
    }
    if na == nb {
        return true;
    }
    // Prefixo por SEGMENTO: na="src/lib" cobre nb="src/lib/db" mas não "src/library".
    let is_seg_prefix = |short: &str, long: &str| {
        long.len() > short.len()
            && long.starts_with(short)
            && long.as_bytes().get(short.len()) == Some(&b'/')
    };
    is_seg_prefix(&na, &nb) || is_seg_prefix(&nb, &na)
}

/// Uma spec ativa com seus paths declarados (entrada da detecção cross-spec).
pub struct SpecPaths {
    pub label: String,
    pub floor: Option<String>,
    pub paths: Vec<String>,
}

/// Cruza os `paths:` de specs ATIVAS e devolve as sobreposições — pra o
/// Orquestrador avisar ANTES do fan-out. Compara par a par (specs distintas);
/// cada par com algum path que se cruza vira UM Conflict (primeiro path cruzado).
pub fn cross_spec_conflicts(specs: &[SpecPaths]) -> Vec<Conflict> {
    let mut out = Vec::new();
    for i in 0..specs.len() {
        for j in (i + 1)..specs.len() {
            let a = &specs[i];
            let b = &specs[j];
            let mut hit: Option<String> = None;
            'pair: for pa in &a.paths {
                for pb in &b.paths {
                    if paths_overlap(pa, pb) {
                        hit = Some(normalize_glob_base(pa));
                        break 'pair;
                    }
                }
            }
            if let Some(path) = hit {
                out.push(Conflict {
                    path,
                    holder: a.label.clone(),
                    holder_floor: a.floor.clone(),
                    requester: b.label.clone(),
                    requester_floor: b.floor.clone(),
                });
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_collapses_and_strips() {
        assert_eq!(normalize_path("./src//lib/db/"), "src/lib/db");
        assert_eq!(normalize_path("src\\lib\\a.ts"), "src/lib/a.ts");
        assert_eq!(normalize_path("  a/b  "), "a/b");
    }

    #[cfg(windows)]
    #[test]
    fn normalize_lowercases_on_windows() {
        assert_eq!(normalize_path("Src/Lib/A.TS"), "src/lib/a.ts");
    }

    #[cfg(not(windows))]
    #[test]
    fn normalize_preserves_case_on_unix() {
        assert_eq!(normalize_path("Src/Lib/A.TS"), "Src/Lib/A.TS");
    }

    #[test]
    fn acquire_then_conflict_for_other_agent() {
        let r = ClaimsRegistry::new();
        assert!(r.acquire("src/a.ts", "Backend", Some("feat/api".into())).is_ok());
        // Mesmo path, outro agente → conflito.
        let err = r.acquire("./src/a.ts", "Frontend", Some("feat/ui".into())).unwrap_err();
        assert_eq!(err.path, "src/a.ts");
        assert_eq!(err.holder, "Backend");
        assert_eq!(err.requester, "Frontend");
    }

    #[test]
    fn acquire_same_agent_is_idempotent() {
        let r = ClaimsRegistry::new();
        assert!(r.acquire("src/a.ts", "Backend", None).is_ok());
        // Re-acquire do mesmo agente NÃO conflita.
        assert!(r.acquire("src/a.ts", "Backend", Some("feat/api".into())).is_ok());
        assert_eq!(r.list().len(), 1);
        // E o floor foi atualizado no re-acquire.
        assert_eq!(r.list()[0].floor.as_deref(), Some("feat/api"));
    }

    #[test]
    fn release_only_by_holder() {
        let r = ClaimsRegistry::new();
        r.acquire("src/a.ts", "Backend", None).unwrap();
        // Outro agente NÃO libera.
        assert!(!r.release("src/a.ts", "Frontend"));
        assert_eq!(r.list().len(), 1);
        // O dono libera.
        assert!(r.release("src/a.ts", "Backend"));
        assert!(r.list().is_empty());
    }

    #[test]
    fn release_agent_frees_all_its_claims() {
        let r = ClaimsRegistry::new();
        r.acquire("src/a.ts", "Backend", None).unwrap();
        r.acquire("src/b.ts", "Backend", None).unwrap();
        r.acquire("src/c.ts", "Frontend", None).unwrap();
        assert_eq!(r.release_agent("Backend"), 2);
        assert_eq!(r.list().len(), 1);
        assert_eq!(r.list()[0].agent_label, "Frontend");
    }

    #[test]
    fn check_reports_conflicts_for_others_only() {
        let r = ClaimsRegistry::new();
        r.acquire("src/a.ts", "Backend", Some("feat/api".into())).unwrap();
        r.acquire("src/b.ts", "Frontend", None).unwrap();
        // Frontend checa a, b, c → só `a` (de Backend) conflita; `b` é dele; `c` livre.
        let conflicts = r.check(
            &["src/a.ts".into(), "./src/b.ts".into(), "src/c.ts".into()],
            "Frontend",
            Some("feat/ui"),
        );
        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0].path, "src/a.ts");
        assert_eq!(conflicts[0].holder, "Backend");
    }

    #[test]
    fn paths_overlap_matches_glob_and_prefix() {
        assert!(paths_overlap("src/lib/db/**", "src/lib/db/conn.ts"));
        assert!(paths_overlap("src/lib/db/conn.ts", "src/lib/db/**"));
        assert!(paths_overlap("src/lib", "src/lib/x.ts"));
        assert!(paths_overlap("src/a.ts", "./src/a.ts"));
        // Segmento diferente: NÃO cruza.
        assert!(!paths_overlap("src/lib", "src/library/x.ts"));
        assert!(!paths_overlap("src/a", "src/b"));
        // Glob "tudo" cruza com qualquer coisa.
        assert!(paths_overlap("**", "qualquer/coisa.rs"));
    }

    #[test]
    fn cross_spec_conflicts_finds_overlapping_specs() {
        let specs = vec![
            SpecPaths {
                label: "Spec A".into(),
                floor: Some("feat/a".into()),
                paths: vec!["src/lib/db/**".into(), "src/api/users.ts".into()],
            },
            SpecPaths {
                label: "Spec B".into(),
                floor: Some("feat/b".into()),
                paths: vec!["src/lib/db/conn.ts".into()],
            },
            SpecPaths {
                label: "Spec C".into(),
                floor: Some("feat/c".into()),
                paths: vec!["docs/readme.md".into()],
            },
        ];
        let conflicts = cross_spec_conflicts(&specs);
        // A×B cruzam (db); A×C e B×C não.
        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0].holder, "Spec A");
        assert_eq!(conflicts[0].requester, "Spec B");
        assert_eq!(conflicts[0].path, "src/lib/db");
    }

    #[test]
    fn cross_spec_no_conflict_when_disjoint() {
        let specs = vec![
            SpecPaths { label: "A".into(), floor: None, paths: vec!["src/a/**".into()] },
            SpecPaths { label: "B".into(), floor: None, paths: vec!["src/b/**".into()] },
        ];
        assert!(cross_spec_conflicts(&specs).is_empty());
    }
}
