//! Motor de AcceptanceRule — prova no disco (ortogonal a gate:land).

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AcceptanceRule {
    PathExists { path: String },
    PathNotStub { path: String, min_bytes: Option<u64> },
    Command { cmd: String, cwd: Option<String> },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuleResult {
    pub rule: String,
    pub ok: bool,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VerifyReport {
    pub ok: bool,
    pub results: Vec<RuleResult>,
}

pub fn verify(cwd: &Path, rules: &[AcceptanceRule]) -> VerifyReport {
    let mut results = Vec::new();
    for rule in rules {
        results.push(check_one(cwd, rule));
    }
    VerifyReport {
        ok: results.iter().all(|r| r.ok),
        results,
    }
}

fn check_one(cwd: &Path, rule: &AcceptanceRule) -> RuleResult {
    match rule {
        AcceptanceRule::PathExists { path } => {
            let p = resolve(cwd, path);
            let ok = p.exists();
            RuleResult {
                rule: format!("path_exists:{path}"),
                ok,
                detail: if ok {
                    format!("existe: {}", p.display())
                } else {
                    format!("ausente: {}", p.display())
                },
            }
        }
        AcceptanceRule::PathNotStub { path, min_bytes } => {
            let p = resolve(cwd, path);
            let min = min_bytes.unwrap_or(32);
            match std::fs::metadata(&p) {
                Ok(meta) if meta.len() >= min => RuleResult {
                    rule: format!("path_not_stub:{path}"),
                    ok: true,
                    detail: format!("{} bytes (≥ {min})", meta.len()),
                },
                Ok(meta) => RuleResult {
                    rule: format!("path_not_stub:{path}"),
                    ok: false,
                    detail: format!("stub: {} bytes < {min}", meta.len()),
                },
                Err(e) => RuleResult {
                    rule: format!("path_not_stub:{path}"),
                    ok: false,
                    detail: format!("erro: {e}"),
                },
            }
        }
        AcceptanceRule::Command { cmd, cwd: rule_cwd } => {
            let dir = rule_cwd
                .as_ref()
                .map(PathBuf::from)
                .unwrap_or_else(|| cwd.to_path_buf());
            // Shell leve: sh -c no Unix. Windows: cmd /C.
            #[cfg(windows)]
            let output = Command::new("cmd").args(["/C", cmd]).current_dir(&dir).output();
            #[cfg(not(windows))]
            let output = Command::new("sh").args(["-c", cmd]).current_dir(&dir).output();

            match output {
                Ok(o) => {
                    let ok = o.status.success();
                    let stderr = String::from_utf8_lossy(&o.stderr);
                    let stdout = String::from_utf8_lossy(&o.stdout);
                    let detail = if ok {
                        format!("exit 0: {}", stdout.chars().take(200).collect::<String>())
                    } else {
                        format!(
                            "exit {:?}: {}",
                            o.status.code(),
                            stderr.chars().take(200).collect::<String>()
                        )
                    };
                    RuleResult {
                        rule: format!("command:{cmd}"),
                        ok,
                        detail,
                    }
                }
                Err(e) => RuleResult {
                    rule: format!("command:{cmd}"),
                    ok: false,
                    detail: format!("spawn falhou: {e}"),
                },
            }
        }
    }
}

fn resolve(cwd: &Path, path: &str) -> PathBuf {
    let p = PathBuf::from(path);
    if p.is_absolute() {
        p
    } else {
        cwd.join(p)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn path_exists_passes_when_file_present() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("README.md");
        std::fs::write(&f, "hello world that is long enough").unwrap();
        let report = verify(
            dir.path(),
            &[AcceptanceRule::PathExists {
                path: "README.md".into(),
            }],
        );
        assert!(report.ok);
    }

    #[test]
    fn path_not_stub_fails_on_tiny_file() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("out.txt");
        let mut file = std::fs::File::create(&f).unwrap();
        write!(file, "x").unwrap();
        let report = verify(
            dir.path(),
            &[AcceptanceRule::PathNotStub {
                path: "out.txt".into(),
                min_bytes: Some(32),
            }],
        );
        assert!(!report.ok);
    }

    #[test]
    fn command_rule_respects_exit_code() {
        let dir = tempfile::tempdir().unwrap();
        let ok = verify(
            dir.path(),
            &[AcceptanceRule::Command {
                cmd: "true".into(),
                cwd: None,
            }],
        );
        assert!(ok.ok);
        let bad = verify(
            dir.path(),
            &[AcceptanceRule::Command {
                cmd: "false".into(),
                cwd: None,
            }],
        );
        assert!(!bad.ok);
    }
}
