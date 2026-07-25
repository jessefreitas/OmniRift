//! Mission Runner — executa layers com dispatch blocking + verify.

use crate::db::Db;
use crate::mcp::server::McpState;
use crate::mission::dag::{plan_dag, DagNode};
use crate::mission::events::{self, EventKind};
use crate::mission::handoff;
use crate::mission::verify::{self, AcceptanceRule};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MissionNode {
    pub id: String,
    pub role: String,
    #[serde(default)]
    pub capability: Option<String>,
    #[serde(default)]
    pub deps: Vec<String>,
    #[serde(default)]
    pub parallel_safe: bool,
    pub task: String,
    /// Hash opcional da persona (sha256 hex) para audit.
    #[serde(default)]
    pub persona_sha: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MissionPackage {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub brief: String,
    #[serde(default)]
    pub capabilities: Vec<String>,
    pub nodes: Vec<MissionNode>,
    #[serde(default)]
    pub acceptance: Vec<AcceptanceRule>,
    #[serde(default)]
    pub floor_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunReport {
    pub ok: bool,
    pub mission_id: String,
    pub layers: Vec<Vec<String>>,
    pub message: String,
}

pub fn parse_package(package_json: &str) -> Result<MissionPackage, String> {
    serde_json::from_str(package_json).map_err(|e| format!("package JSON inválido: {e}"))
}

/// Extrai node ids do package (para validate_chain).
pub fn package_node_ids(pkg: &MissionPackage) -> Vec<String> {
    pkg.nodes.iter().map(|n| n.id.clone()).collect()
}

pub async fn run_mission(state: &McpState, db: &Db, mission_id: &str) -> RunReport {
    let Some((_brief, package_json, cwd)) = events::get_mission_package(db, mission_id) else {
        return RunReport {
            ok: false,
            mission_id: mission_id.into(),
            layers: vec![],
            message: format!("missão '{mission_id}' não encontrada"),
        };
    };

    let pkg = match parse_package(&package_json) {
        Ok(p) => p,
        Err(e) => {
            return RunReport {
                ok: false,
                mission_id: mission_id.into(),
                layers: vec![],
                message: e,
            };
        }
    };

    let dag_nodes: Vec<DagNode> = pkg
        .nodes
        .iter()
        .map(|n| DagNode {
            id: n.id.clone(),
            deps: n.deps.clone(),
            parallel_safe: n.parallel_safe,
        })
        .collect();

    let plan = plan_dag(&dag_nodes);
    if plan.has_cycle {
        events::append_event(
            db,
            mission_id,
            EventKind::Failed,
            json!({ "reason": "cycle", "nodes": plan.cycle_nodes }),
        );
        events::set_mission_status(db, mission_id, "failed");
        return RunReport {
            ok: false,
            mission_id: mission_id.into(),
            layers: plan.layers,
            message: format!("DAG com ciclo: {:?}", plan.cycle_nodes),
        };
    }

    events::set_mission_status(db, mission_id, "running");

    for (i, layer) in plan.layers.iter().enumerate() {
        events::append_event(
            db,
            mission_id,
            EventKind::LayerStarted,
            json!({ "index": i, "nodes": layer }),
        );

        // parallel_safe nodes já estão agrupados; despacha todos da layer
        // (blocking sequencial dentro da layer por simplicidade segura —
        // parallel_safe ainda permite mesma layer no plan; wait é por nó).
        for node_id in layer {
            let node = match pkg.nodes.iter().find(|n| &n.id == node_id) {
                Some(n) => n,
                None => continue,
            };
            let target = format!("@{}", node.role);

            // M2: handoffs pending (fan-in: todos) → cita no task; consome após dispatch.
            let pending = handoff::load_pending(db, mission_id, Some(&node.role));
            let consume_keys: Vec<String> = pending.iter().map(|(k, _)| k.clone()).collect();
            let task_body = if pending.is_empty() {
                node.task.clone()
            } else {
                let blocks: Vec<String> = pending
                    .iter()
                    .map(|(key, h)| {
                        format!(
                            "[handoff pending {key}]\n\
                             from: {}\n\
                             last_command: {}\n\
                             next_action: {}\n\
                             decisions: {}\n\
                             blockers: {}",
                            h.from_agent,
                            h.last_command,
                            h.next_action,
                            h.decisions.join("; "),
                            h.blockers.join("; "),
                        )
                    })
                    .collect();
                format!("{}\n\n{}", blocks.join("\n\n"), node.task)
            };

            let result = crate::orchestrator::dispatch_task(
                state,
                db,
                &target,
                &task_body,
                None,
                "blocking",
            )
            .await;

            for key in &consume_keys {
                let _ = handoff::mark_consumed(db, key);
            }

            events::append_event(
                db,
                mission_id,
                EventKind::Dispatch,
                json!({
                    "node_id": node.id,
                    "role": node.role,
                    "capability": node.capability,
                    "result_excerpt": truncate(&result, 400),
                    "handoff_consumed": consume_keys,
                }),
            );

            if let Some(sha) = &node.persona_sha {
                events::append_event(
                    db,
                    mission_id,
                    EventKind::PersonaInjected,
                    json!({
                        "node_id": node.id,
                        "role": node.role,
                        "sha256": sha,
                        "bytes": sha.len(),
                    }),
                );
            }

            // M2: após settle do nó, handoff tipado para sucessores (deps → este id).
            let successors: Vec<(String, String, String)> = pkg
                .nodes
                .iter()
                .filter(|n| n.deps.iter().any(|d| d == &node.id || d == &node.role))
                .map(|n| (n.id.clone(), n.role.clone(), n.task.clone()))
                .collect();
            if !successors.is_empty() {
                let _ = handoff::write_after_settle(
                    db,
                    mission_id,
                    &node.id,
                    &node.role,
                    &format!("dispatch {}", node.id),
                    &truncate(&result, 400),
                    &successors,
                );
            }
        }

        events::append_event(
            db,
            mission_id,
            EventKind::LayerFinished,
            json!({ "index": i, "nodes": layer }),
        );
    }

    // Verify
    let work_cwd = cwd
        .as_deref()
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));

    let report = if pkg.acceptance.is_empty() {
        // Sem regras: gate passa por vacuidade explícita (missão só de coordenação).
        verify::VerifyReport {
            ok: true,
            results: vec![],
        }
    } else {
        verify::verify(&work_cwd, &pkg.acceptance)
    };

    if report.ok {
        events::append_event(
            db,
            mission_id,
            EventKind::GatePassed,
            json!({ "report": report }),
        );
        events::append_event(db, mission_id, EventKind::Delivered, json!({}));
        events::set_mission_status(db, mission_id, "delivered");
        RunReport {
            ok: true,
            mission_id: mission_id.into(),
            layers: plan.layers,
            message: "missão entregue (gate_passed)".into(),
        }
    } else {
        events::append_event(
            db,
            mission_id,
            EventKind::GateFailed,
            json!({ "report": report }),
        );
        events::append_event(db, mission_id, EventKind::Failed, json!({ "reason": "verify" }));
        events::set_mission_status(db, mission_id, "failed");
        RunReport {
            ok: false,
            mission_id: mission_id.into(),
            layers: plan.layers,
            message: "verify falhou (gate_failed)".into(),
        }
    }
}

pub fn status_json(db: &Db, mission_id: &str) -> Value {
    let events = events::list_events(db, mission_id);
    let pkg = events::get_mission_package(db, mission_id);
    let node_ids = pkg
        .as_ref()
        .and_then(|(_, pj, _)| parse_package(pj).ok())
        .map(|p| package_node_ids(&p))
        .unwrap_or_default();
    let chain = events::validate_chain(&events, &node_ids, false);
    json!({
        "missionId": mission_id,
        "brief": pkg.as_ref().map(|(b, _, _)| b.clone()),
        "cwd": pkg.as_ref().and_then(|(_, _, c)| c.clone()),
        "events": events,
        "chain": chain,
    })
}

/// Verify sob demanda. Se `settle`, grava gate_*/delivered|failed (dock M3).
pub fn verify_mission(db: &Db, mission_id: &str, settle: bool) -> Result<verify::VerifyReport, String> {
    let Some((_, package_json, cwd)) = events::get_mission_package(db, mission_id) else {
        return Err(format!("missão '{mission_id}' não encontrada"));
    };
    let pkg = parse_package(&package_json)?;
    let work = cwd
        .as_deref()
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let report = if pkg.acceptance.is_empty() {
        verify::VerifyReport {
            ok: true,
            results: vec![],
        }
    } else {
        verify::verify(&work, &pkg.acceptance)
    };

    if settle {
        settle_gate(db, mission_id, &report);
    }
    Ok(report)
}

/// Persiste outcome do gate (idempotente se já `delivered`).
pub fn settle_gate(db: &Db, mission_id: &str, report: &verify::VerifyReport) {
    let existing = events::list_events(db, mission_id);
    if existing.iter().any(|e| e.kind == "delivered") {
        return;
    }
    // Retry após gate_failed: remove bloqueio permitindo novo settle.
    if report.ok {
        events::append_event(
            db,
            mission_id,
            EventKind::GatePassed,
            json!({ "report": report, "source": "verify_settle" }),
        );
        events::append_event(db, mission_id, EventKind::Delivered, json!({ "source": "verify_settle" }));
        events::set_mission_status(db, mission_id, "delivered");
    } else {
        events::append_event(
            db,
            mission_id,
            EventKind::GateFailed,
            json!({ "report": report, "source": "verify_settle" }),
        );
        events::append_event(
            db,
            mission_id,
            EventKind::Failed,
            json!({ "reason": "verify", "source": "verify_settle" }),
        );
        events::set_mission_status(db, mission_id, "failed");
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &s[..end])
}
