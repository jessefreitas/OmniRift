//! Planejador de DAG → layers (topo-sort / Kahn).
//!
//! Puro e testável: sem PTY, sem DB, sem async.

use std::collections::{HashMap, HashSet, VecDeque};

#[derive(Debug, Clone)]
pub struct DagNode {
    pub id: String,
    pub deps: Vec<String>,
    /// Se false (default), o nó fica sozinho na layer (serializado).
    pub parallel_safe: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanResult {
    pub layers: Vec<Vec<String>>,
    pub has_cycle: bool,
    pub cycle_nodes: Vec<String>,
    pub unknown_deps: Vec<(String, String)>,
}

pub fn plan_dag(nodes: &[DagNode]) -> PlanResult {
    let mut by_id: HashMap<&str, &DagNode> = HashMap::new();
    for n in nodes {
        by_id.insert(n.id.as_str(), n);
    }

    let mut unknown_deps = Vec::new();
    let mut indegree: HashMap<&str, usize> = HashMap::new();
    let mut dependents: HashMap<&str, Vec<&str>> = HashMap::new();

    for n in nodes {
        indegree.entry(n.id.as_str()).or_insert(0);
        for d in &n.deps {
            if !by_id.contains_key(d.as_str()) {
                unknown_deps.push((n.id.clone(), d.clone()));
                continue;
            }
            *indegree.entry(n.id.as_str()).or_insert(0) += 1;
            dependents.entry(d.as_str()).or_default().push(n.id.as_str());
        }
    }

    let mut ready: VecDeque<&str> = indegree
        .iter()
        .filter(|(_, &deg)| deg == 0)
        .map(|(&id, _)| id)
        .collect();
    // ordem estável
    let mut ready_vec: Vec<&str> = ready.drain(..).collect();
    ready_vec.sort_unstable();
    ready.extend(ready_vec);

    let mut layers: Vec<Vec<String>> = Vec::new();
    let mut placed = 0usize;
    let total = nodes.len();

    while !ready.is_empty() {
        // Separar parallel_safe vs forced-serial neste frontier.
        let mut batch: Vec<&str> = ready.drain(..).collect();
        batch.sort_unstable();

        let mut parallel: Vec<&str> = Vec::new();
        let mut serial: Vec<&str> = Vec::new();
        for id in batch {
            if by_id.get(id).map(|n| n.parallel_safe).unwrap_or(false) {
                parallel.push(id);
            } else {
                serial.push(id);
            }
        }

        if !parallel.is_empty() {
            layers.push(parallel.iter().map(|s| (*s).to_string()).collect());
            for id in &parallel {
                placed += 1;
                unlock_dependents(id, &dependents, &mut indegree, &mut ready);
            }
        }
        for id in serial {
            layers.push(vec![id.to_string()]);
            placed += 1;
            unlock_dependents(id, &dependents, &mut indegree, &mut ready);
            // re-sort ready after each serial unlock for stability
            let mut v: Vec<&str> = ready.drain(..).collect();
            v.sort_unstable();
            ready.extend(v);
        }
    }

    let has_cycle = placed < total;
    let cycle_nodes = if has_cycle {
        indegree
            .iter()
            .filter(|(_, &deg)| deg > 0)
            .map(|(&id, _)| id.to_string())
            .collect()
    } else {
        Vec::new()
    };

    // Dedup unknown_deps
    let mut seen = HashSet::new();
    unknown_deps.retain(|p| seen.insert(p.clone()));

    PlanResult {
        layers,
        has_cycle,
        cycle_nodes,
        unknown_deps,
    }
}

fn unlock_dependents<'a>(
    id: &'a str,
    dependents: &HashMap<&'a str, Vec<&'a str>>,
    indegree: &mut HashMap<&'a str, usize>,
    ready: &mut VecDeque<&'a str>,
) {
    if let Some(deps) = dependents.get(id) {
        for &child in deps {
            if let Some(deg) = indegree.get_mut(child) {
                *deg = deg.saturating_sub(1);
                if *deg == 0 {
                    ready.push_back(child);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn n(id: &str, deps: &[&str], parallel_safe: bool) -> DagNode {
        DagNode {
            id: id.into(),
            deps: deps.iter().map(|s| (*s).to_string()).collect(),
            parallel_safe,
        }
    }

    #[test]
    fn linear_deps_make_three_layers() {
        let nodes = vec![n("a", &[], false), n("b", &["a"], false), n("c", &["b"], false)];
        let r = plan_dag(&nodes);
        assert!(!r.has_cycle);
        assert_eq!(r.layers, vec![vec!["a"], vec!["b"], vec!["c"]]);
    }

    #[test]
    fn parallel_safe_siblings_share_layer() {
        let nodes = vec![
            n("a", &[], false),
            n("b", &["a"], true),
            n("c", &["a"], true),
            n("d", &["b", "c"], false),
        ];
        let r = plan_dag(&nodes);
        assert!(!r.has_cycle);
        assert_eq!(r.layers[0], vec!["a".to_string()]);
        assert_eq!(r.layers[1], vec!["b".to_string(), "c".to_string()]);
        assert_eq!(r.layers[2], vec!["d".to_string()]);
    }

    #[test]
    fn cycle_is_reported() {
        let nodes = vec![n("a", &["b"], false), n("b", &["a"], false)];
        let r = plan_dag(&nodes);
        assert!(r.has_cycle);
        assert!(!r.cycle_nodes.is_empty());
    }

    #[test]
    fn unknown_deps_reported() {
        let nodes = vec![n("a", &["missing"], false)];
        let r = plan_dag(&nodes);
        assert_eq!(r.unknown_deps, vec![("a".into(), "missing".into())]);
        // "missing" ignored → a has indegree 0 → runs
        assert!(!r.has_cycle);
        assert_eq!(r.layers, vec![vec!["a"]]);
    }
}
