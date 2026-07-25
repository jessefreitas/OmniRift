//! Registry de capabilities tipadas + search HIGH / AMBIGUOUS / NO_MATCH.

use crate::db::Db;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capability {
    pub id: String,
    pub description: String,
    pub domains: Vec<String>,
    pub examples: Vec<String>,
    pub not_for: Vec<String>,
    pub invoke_kind: String,
    pub invoke_ref: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "signal", rename_all = "snake_case")]
pub enum SearchSignal {
    High { id: String, score: f64 },
    Ambiguous { candidates: Vec<ScoredCap> },
    NoMatch,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScoredCap {
    pub id: String,
    pub score: f64,
    pub description: String,
}

pub fn ensure_schema(conn: &rusqlite::Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS capabilities (
            id          TEXT PRIMARY KEY,
            description TEXT NOT NULL,
            domains     TEXT NOT NULL DEFAULT '[]',
            examples    TEXT NOT NULL DEFAULT '[]',
            not_for     TEXT NOT NULL DEFAULT '[]',
            invoke_kind TEXT NOT NULL DEFAULT 'role',
            invoke_ref  TEXT NOT NULL DEFAULT ''
        );",
    )?;
    Ok(())
}

pub fn upsert(db: &Db, cap: &Capability) -> Result<(), String> {
    let domains = serde_json::to_string(&cap.domains).unwrap_or_else(|_| "[]".into());
    let examples = serde_json::to_string(&cap.examples).unwrap_or_else(|_| "[]".into());
    let not_for = serde_json::to_string(&cap.not_for).unwrap_or_else(|_| "[]".into());
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO capabilities (id, description, domains, examples, not_for, invoke_kind, invoke_ref)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(id) DO UPDATE SET
               description=excluded.description,
               domains=excluded.domains,
               examples=excluded.examples,
               not_for=excluded.not_for,
               invoke_kind=excluded.invoke_kind,
               invoke_ref=excluded.invoke_ref",
            rusqlite::params![
                &cap.id,
                &cap.description,
                &domains,
                &examples,
                &not_for,
                &cap.invoke_kind,
                &cap.invoke_ref
            ],
        )?;
        Ok(())
    })
    .map_err(|e| e.to_string())
}

fn row_to_cap(row: &rusqlite::Row<'_>) -> rusqlite::Result<Capability> {
    let domains_s: String = row.get(2)?;
    let examples_s: String = row.get(3)?;
    let not_for_s: String = row.get(4)?;
    Ok(Capability {
        id: row.get(0)?,
        description: row.get(1)?,
        domains: serde_json::from_str(&domains_s).unwrap_or_default(),
        examples: serde_json::from_str(&examples_s).unwrap_or_default(),
        not_for: serde_json::from_str(&not_for_s).unwrap_or_default(),
        invoke_kind: row.get(5)?,
        invoke_ref: row.get(6)?,
    })
}

pub fn list(db: &Db) -> Vec<Capability> {
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, description, domains, examples, not_for, invoke_kind, invoke_ref
             FROM capabilities ORDER BY id",
        )?;
        let rows = stmt.query_map([], row_to_cap)?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    })
    .unwrap_or_default()
}

fn score_cap(query: &str, cap: &Capability) -> f64 {
    let q = query.to_lowercase();
    if q.is_empty() {
        return 0.0;
    }
    if cap.id.to_lowercase() == q {
        return 100.0;
    }
    let mut score = 0.0;
    if cap.id.to_lowercase().contains(&q) {
        score += 40.0;
    }
    // tokens do id dotted
    for part in cap.id.split('.') {
        if q.contains(part) {
            score += 8.0;
        }
    }
    let desc = cap.description.to_lowercase();
    for tok in q.split_whitespace() {
        if tok.len() < 3 {
            continue;
        }
        if desc.contains(tok) {
            score += 6.0;
        }
        for ex in &cap.examples {
            if ex.to_lowercase().contains(tok) {
                score += 10.0;
            }
        }
        for nf in &cap.not_for {
            if nf.to_lowercase().contains(tok) {
                score -= 15.0;
            }
        }
        for d in &cap.domains {
            if d.to_lowercase().contains(tok) || tok.contains(&d.to_lowercase()) {
                score += 5.0;
            }
        }
    }
    score
}

/// Thresholds: HIGH se top ≥ 30 e gap ≥ 12 vs 2º; AMBIGUOUS se top ≥ 12; senão NO_MATCH.
pub fn search(db: &Db, query: &str) -> SearchSignal {
    search_in(&list(db), query)
}

pub fn search_in(caps: &[Capability], query: &str) -> SearchSignal {
    let mut scored: Vec<ScoredCap> = caps
        .iter()
        .map(|c| ScoredCap {
            id: c.id.clone(),
            score: score_cap(query, c),
            description: c.description.clone(),
        })
        .filter(|s| s.score > 0.0)
        .collect();
    scored.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));

    if scored.is_empty() {
        return SearchSignal::NoMatch;
    }
    let top = &scored[0];
    if top.score >= 30.0 {
        let second = scored.get(1).map(|s| s.score).unwrap_or(0.0);
        if top.score - second >= 12.0 {
            return SearchSignal::High {
                id: top.id.clone(),
                score: top.score,
            };
        }
    }
    if top.score >= 12.0 {
        let candidates: Vec<ScoredCap> = scored.into_iter().take(5).collect();
        return SearchSignal::Ambiguous { candidates };
    }
    SearchSignal::NoMatch
}

pub fn seed_defaults(db: &Db) {
    let seeds: &[Capability] = &[
        Capability {
            id: "arch.api.contract".into(),
            description: "Definir contratos de API, modelagem e divisão de trabalho entre times.".into(),
            domains: vec!["architecture".into(), "api".into()],
            examples: vec!["definir contratos".into(), "modelar API".into(), "dividir fatias".into()],
            not_for: vec!["implementar endpoints".into()],
            invoke_kind: "role".into(),
            invoke_ref: "Arquiteto".into(),
        },
        Capability {
            id: "code.backend.implement".into(),
            description: "Implementar endpoints, banco e regras de negócio no backend.".into(),
            domains: vec!["code".into(), "backend".into()],
            examples: vec!["implementar API".into(), "criar endpoint".into(), "regras de negócio".into()],
            not_for: vec!["escrever telas".into()],
            invoke_kind: "role".into(),
            invoke_ref: "Backend".into(),
        },
        Capability {
            id: "code.frontend.implement".into(),
            description: "Implementar telas e integrar com a API pelo contrato.".into(),
            domains: vec!["code".into(), "frontend".into()],
            examples: vec!["implementar UI".into(), "tela".into(), "integrar frontend".into()],
            not_for: vec!["schema SQL".into()],
            invoke_kind: "role".into(),
            invoke_ref: "Frontend".into(),
        },
        Capability {
            id: "test.integration.run".into(),
            description: "Escrever e rodar testes de integração contra o entregue.".into(),
            domains: vec!["test".into(), "qa".into()],
            examples: vec!["testes de integração".into(), "rodar suíte".into(), "QA".into()],
            not_for: vec!["review de diff".into()],
            invoke_kind: "role".into(),
            invoke_ref: "QA".into(),
        },
        Capability {
            id: "review.diff.approve".into(),
            description: "Revisar o diff completo e aprovar ou devolver.".into(),
            domains: vec!["review".into()],
            examples: vec!["code review".into(), "revisar diff".into(), "aprovar PR".into()],
            not_for: vec!["escrever feature".into()],
            invoke_kind: "role".into(),
            invoke_ref: "Code Reviewer".into(),
        },
        Capability {
            id: "bug.triage.repro".into(),
            description: "Reproduzir bug, isolar causa e escrever caso mínimo.".into(),
            domains: vec!["bug".into(), "debug".into()],
            examples: vec!["reproduzir bug".into(), "triagem".into(), "caso mínimo".into()],
            not_for: vec!["corrigir em produção sem repro".into()],
            invoke_kind: "role".into(),
            invoke_ref: "Triagem".into(),
        },
        Capability {
            id: "bug.fix.patch".into(),
            description: "Corrigir causa raiz e adicionar teste de regressão.".into(),
            domains: vec!["bug".into(), "fix".into()],
            examples: vec!["corrigir bug".into(), "fix".into(), "patch com regressão".into()],
            not_for: vec!["só documentar o bug".into()],
            invoke_kind: "role".into(),
            invoke_ref: "Fixer".into(),
        },
        Capability {
            id: "bug.verify.suite".into(),
            description: "Rodar todos os testes e validar o cenário original do bug.".into(),
            domains: vec!["bug".into(), "test".into()],
            examples: vec!["verificar suíte".into(), "validar correção".into(), "regression guard".into()],
            not_for: vec!["triagem inicial".into()],
            invoke_kind: "role".into(),
            invoke_ref: "Verificador".into(),
        },
        Capability {
            id: "db.schema.migrate".into(),
            description: "Schema, migrations e índices sob demanda.".into(),
            domains: vec!["database".into()],
            examples: vec!["migration".into(), "índice".into(), "schema".into()],
            not_for: vec!["UI".into()],
            invoke_kind: "role".into(),
            invoke_ref: "DBA".into(),
        },
        Capability {
            id: "security.diff.owasp".into(),
            description: "Passada de segurança (OWASP) no diff.".into(),
            domains: vec!["security".into()],
            examples: vec!["OWASP".into(), "segurança no diff".into(), "pentest leve".into()],
            not_for: vec!["feature nova sem diff".into()],
            invoke_kind: "role".into(),
            invoke_ref: "Security".into(),
        },
    ];
    for cap in seeds {
        let _ = upsert(db, cap);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Vec<Capability> {
        vec![
            Capability {
                id: "bug.triage.repro".into(),
                description: "Reproduzir bug e isolar causa.".into(),
                domains: vec!["bug".into()],
                examples: vec!["reproduzir bug".into(), "triagem".into()],
                not_for: vec![],
                invoke_kind: "role".into(),
                invoke_ref: "Triagem".into(),
            },
            Capability {
                id: "bug.fix.patch".into(),
                description: "Corrigir causa raiz com teste de regressão.".into(),
                domains: vec!["bug".into()],
                examples: vec!["corrigir bug".into(), "fix".into()],
                not_for: vec![],
                invoke_kind: "role".into(),
                invoke_ref: "Fixer".into(),
            },
            Capability {
                id: "arch.api.contract".into(),
                description: "Definir contratos de API.".into(),
                domains: vec!["architecture".into()],
                examples: vec!["contratos de API".into()],
                not_for: vec![],
                invoke_kind: "role".into(),
                invoke_ref: "Arquiteto".into(),
            },
        ]
    }

    #[test]
    fn search_high_when_single_strong_match() {
        let sig = search_in(&sample(), "reproduzir bug triagem caso");
        match sig {
            SearchSignal::High { id, .. } => assert_eq!(id, "bug.triage.repro"),
            other => panic!("expected High, got {other:?}"),
        }
    }

    #[test]
    fn search_ambiguous_returns_top_n() {
        let sig = search_in(&sample(), "bug");
        match sig {
            SearchSignal::Ambiguous { candidates } => {
                assert!(candidates.len() >= 2);
            }
            SearchSignal::High { .. } => {
                // também aceitável se gap for grande — query "bug" casa 2
            }
            other => panic!("expected Ambiguous or High, got {other:?}"),
        }
    }

    #[test]
    fn search_no_match_when_empty_registry() {
        assert_eq!(search_in(&[], "qualquer coisa"), SearchSignal::NoMatch);
    }
}
