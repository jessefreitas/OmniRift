use serde::{Deserialize, Serialize};

/// Runtime que originou o evento.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeKind {
    Acp,
    Claude,
    Codex,
    Shell,
}

/// De onde o evento veio (autoridade da fonte).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EventSource {
    Protocol,
    Hook,
    Transcript,
    Inferred,
}

impl EventSource {
    /// Precedência de autoridade: protocol > transcript > hook > inferred.
    pub fn authority(&self) -> u8 {
        match self {
            EventSource::Protocol => 3,
            EventSource::Transcript => 2,
            EventSource::Hook => 1,
            EventSource::Inferred => 0,
        }
    }

    /// Nome lowercase usado em chaves de deduplicação.
    fn as_dedup_str(&self) -> &'static str {
        match self {
            EventSource::Protocol => "protocol",
            EventSource::Hook => "hook",
            EventSource::Transcript => "transcript",
            EventSource::Inferred => "inferred",
        }
    }
}

/// Nível de confiança do evento derivado.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EventConfidence {
    Authoritative,
    Observed,
    Inferred,
}

/// Evento normalizado do ledger.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunEvent {
    /// UUID nosso (chave primária).
    pub id: String,
    /// Sessão do agente (FK).
    pub session_id: String,
    /// Nó do canvas.
    pub node_id: Option<String>,
    pub turn_id: Option<String>,
    /// Id nativo da fonte (dedup).
    pub native_event_id: Option<String>,
    /// tool_use_id / call_id.
    pub native_call_id: Option<String>,
    pub runtime: RuntimeKind,
    pub source: EventSource,
    pub confidence: EventConfidence,
    /// "tool.started", "turn.completed", etc.
    pub kind: String,
    pub occurred_at_ms: i64,
    pub monotonic_seq: i64,
    pub duration_ms: Option<i64>,
    /// Payload serializado (pode ser "{}").
    pub payload_json: String,
}

impl RunEvent {
    /// Chave de dedup determinística. Só existe quando native_event_id não é vazio.
    pub fn dedup_key(&self) -> Option<String> {
        match self.native_event_id.as_deref() {
            Some(id) if !id.is_empty() => Some(format!(
                "{}|{}|{}",
                self.session_id,
                self.source.as_dedup_str(),
                id
            )),
            _ => None,
        }
    }

    /// Válido = session_id e kind preenchidos, tempos/seq não negativos.
    pub fn is_valid(&self) -> bool {
        !self.session_id.is_empty()
            && !self.kind.is_empty()
            && self.occurred_at_ms >= 0
            && self.monotonic_seq >= 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_event() -> RunEvent {
        RunEvent {
            id: "ev-1".into(),
            session_id: "s1".into(),
            node_id: Some("n1".into()),
            turn_id: Some("t1".into()),
            native_event_id: Some("evt1".into()),
            native_call_id: Some("call1".into()),
            runtime: RuntimeKind::Claude,
            source: EventSource::Protocol,
            confidence: EventConfidence::Authoritative,
            kind: "tool.started".into(),
            occurred_at_ms: 1_700_000_000_000,
            monotonic_seq: 42,
            duration_ms: Some(120),
            payload_json: r#"{"x":1}"#.into(),
        }
    }

    #[test]
    fn authority_ordering() {
        assert_eq!(EventSource::Protocol.authority(), 3);
        assert_eq!(EventSource::Transcript.authority(), 2);
        assert_eq!(EventSource::Hook.authority(), 1);
        assert_eq!(EventSource::Inferred.authority(), 0);
    }

    #[test]
    fn dedup_key_com_native_id() {
        let ev = sample_event();
        assert_eq!(ev.dedup_key(), Some("s1|protocol|evt1".to_string()));
    }

    #[test]
    fn dedup_key_sem_native_id() {
        let mut ev = sample_event();
        ev.native_event_id = None;
        assert_eq!(ev.dedup_key(), None);
    }

    #[test]
    fn dedup_key_com_native_id_vazio() {
        let mut ev = sample_event();
        ev.native_event_id = Some("".into());
        assert_eq!(ev.dedup_key(), None);
    }

    #[test]
    fn is_valid_completo() {
        assert!(sample_event().is_valid());
    }

    #[test]
    fn is_valid_session_vazia() {
        let mut ev = sample_event();
        ev.session_id = "".into();
        assert!(!ev.is_valid());
    }

    #[test]
    fn is_valid_kind_vazio() {
        let mut ev = sample_event();
        ev.kind = "".into();
        assert!(!ev.is_valid());
    }

    #[test]
    fn is_valid_tempo_negativo() {
        let mut ev = sample_event();
        ev.occurred_at_ms = -1;
        assert!(!ev.is_valid());
    }

    #[test]
    fn serde_runtime_kind_acp() {
        assert_eq!(serde_json::to_string(&RuntimeKind::Acp).unwrap(), "\"acp\"");
    }

    #[test]
    fn serde_run_event_round_trip() {
        let ev = sample_event();
        let json = serde_json::to_string(&ev).unwrap();
        let de: RunEvent = serde_json::from_str(&json).unwrap();
        assert_eq!(ev.id, de.id);
        assert_eq!(ev.session_id, de.session_id);
        assert_eq!(ev.node_id, de.node_id);
        assert_eq!(ev.turn_id, de.turn_id);
        assert_eq!(ev.native_event_id, de.native_event_id);
        assert_eq!(ev.native_call_id, de.native_call_id);
        assert_eq!(ev.runtime, de.runtime);
        assert_eq!(ev.source, de.source);
        assert_eq!(ev.confidence, de.confidence);
        assert_eq!(ev.kind, de.kind);
        assert_eq!(ev.occurred_at_ms, de.occurred_at_ms);
        assert_eq!(ev.monotonic_seq, de.monotonic_seq);
        assert_eq!(ev.duration_ms, de.duration_ms);
        assert_eq!(ev.payload_json, de.payload_json);
    }
}