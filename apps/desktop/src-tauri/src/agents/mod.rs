use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentNode {
    pub id: String,
    pub label: String,
    pub role: Option<String>,
    pub pty_id: Option<String>,
    pub position: NodePosition,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodePosition {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentEdge {
    pub id: String,
    pub source: String,
    pub target: String,
}
