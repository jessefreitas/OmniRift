use crate::pty::SessionId;
use dashmap::DashMap;
use std::sync::Arc;

#[derive(Clone)]
pub struct AgentEntry {
    pub session_id: SessionId,
    pub description: String,
    /// Nome do floor onde o agente vive — dá ao Orquestrador a topologia
    /// cross-floor (quem está em qual branch). `None` = floor desconhecido.
    pub floor: Option<String>,
    /// Role declarado no spawn; None = desconhecido.
    pub role: Option<String>,
}

/// Mapeia label de agente → (session_id PTY, description, floor).
/// Cada agente registrado vira uma tool dinâmica no MCP.
#[derive(Default, Clone)]
pub struct AgentRegistry(Arc<DashMap<String, AgentEntry>>);

impl AgentRegistry {
    pub fn new() -> Self {
        Self::default()
    }

/// Registra um agente. Devolve o label EFETIVO (pode diferir do pedido).
    ///
    /// Antes fazia `insert(label, ...)` direto: um segundo agente com o mesmo label
    /// SOBRESCREVIA o primeiro silenciosamente. Foi o que aconteceu quando o orquestrador
    /// spawnou um "Backend" duplicado — o clone roubou o label e o Backend original ficou
    /// órfão de todo `orchestrator_dispatch`/`terminal_send`, sem nenhum aviso.
    ///
    /// Agora: mesma sessão = re-registro idempotente; sessão DIFERENTE = sufixa (" 2", " 3"…),
    /// espelhando o que o canvas já faz no rótulo visível — os DOIS ficam endereçáveis.
    /// Usa `entry()` (trava o shard da chave) pra que a checagem+inserção de CADA tentativa
    /// seja atômica: dois registros simultâneos do mesmo label não se sobrescrevem, o
    /// segundo cai no sufixo.
    pub fn register(
        &self,
        label: String,
        session_id: SessionId,
        description: String,
        floor: Option<String>,
        role: Option<String>,
    ) -> String {
        use dashmap::mapref::entry::Entry;
        let mut effective = label.clone();
        let mut n = 2;
        loop {
            match self.0.entry(effective.clone()) {
                Entry::Vacant(v) => {
                    v.insert(AgentEntry { session_id: session_id.clone(), description: description.clone(), floor: floor.clone(), role: role.clone() });
                    break;
                }
                Entry::Occupied(mut o) if o.get().session_id == session_id => {
                    // Mesma sessão: re-registro (rename/reload) → atualiza metadados.
                    o.insert(AgentEntry { session_id: session_id.clone(), description: description.clone(), floor: floor.clone(), role: role.clone() });
                    break;
                }
                Entry::Occupied(_) => {
                    effective = format!("{label} {n}");
                    n += 1;
                }
            }
        }
        if effective != label {
            log::warn!("MCP: label '{label}' já pertence a outra sessão → registrado como '{effective}' (o original NÃO foi sobrescrito)");
        }
        log::info!("MCP: agente '{}' registrado ({})", effective, &session_id[..8.min(session_id.len())]);
        effective
    }

    pub fn unregister(&self, label: &str) -> Option<SessionId> {
        self.0.remove(label).map(|(_, e)| e.session_id)
    }

    /// Remove TODAS as entries apontando pra esta sessão (uso: sessão morreu/EOF).
    /// Sem isto o label fantasma continua no registry e o resolve fuzzy ainda o
    /// encontra ("dormindo (dead)"). Retorna os labels removidos (pra log).
    pub fn unregister_by_session(&self, session_id: &str) -> Vec<String> {
        let labels: Vec<String> = self
            .0
            .iter()
            .filter(|e| e.value().session_id == session_id)
            .map(|e| e.key().clone())
            .collect();
        for l in &labels {
            self.0.remove(l);
        }
        labels
    }

    pub fn list(&self) -> Vec<(String, AgentEntry)> {
        self.0.iter().map(|e| (e.key().clone(), e.value().clone())).collect()
    }

    pub fn get_session_id(&self, label: &str) -> Option<SessionId> {
        self.0.get(label).map(|e| e.session_id.clone())
    }

    /// Busca agente pelo nome de tool MCP (label normalizado em snake_case).
    pub fn get_by_tool_name(&self, tool_name: &str) -> Option<(String, AgentEntry)> {
        self.0
            .iter()
            .find(|e| to_tool_name(e.key()) == tool_name)
            .map(|e| (e.key().clone(), e.value().clone()))
    }
}

/// Converte label de agente em nome de tool MCP válido.
/// "Agente 01" → "agente_01" | "Frontend (React)" → "frontend_react"
pub fn to_tool_name(label: &str) -> String {
    label
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '_' })
        .collect::<String>()
        .split('_')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("_")
}
#[cfg(test)]
mod tests {
    use super::*;

    /// REGRESSÃO: o clone spawnado pelo orquestrador roubava o label do agente original
    /// (o `insert` por label sobrescrevia), deixando o Backend real órfão dos dispatches.
    /// Agora o segundo ganha sufixo e os DOIS continuam endereçáveis.
    #[test]
    fn label_duplicado_de_outra_sessao_sufixa_e_preserva_o_original() {
        let reg = AgentRegistry::default();

        let a = reg.register("Backend".into(), "sess-original".into(), "API".into(), None, None);
        assert_eq!(a, "Backend");

        let b = reg.register("Backend".into(), "sess-clone".into(), "API".into(), None, None);
        assert_eq!(b, "Backend 2", "o clone NAO pode roubar o label");

        assert_eq!(reg.0.get("Backend").unwrap().session_id, "sess-original");
        assert_eq!(reg.0.get("Backend 2").unwrap().session_id, "sess-clone");
    }

    /// Re-registro da MESMA sessão (rename/reload) é idempotente: mantém o label e
    /// atualiza os metadados, sem criar "Backend 2" fantasma.
    #[test]
    fn mesma_sessao_reregistra_no_mesmo_label() {
        let reg = AgentRegistry::default();
        reg.register("QA".into(), "sess-1".into(), "testes".into(), None, None);
        let again = reg.register("QA".into(), "sess-1".into(), "testes e2e".into(), Some("feat/x".into()), None);

        assert_eq!(again, "QA");
        assert_eq!(reg.0.len(), 1, "nao pode duplicar a propria sessao");
        let e = reg.0.get("QA").unwrap();
        assert_eq!(e.description, "testes e2e", "metadados atualizados");
        assert_eq!(e.floor.as_deref(), Some("feat/x"));
    }

    /// Três sessões distintas disputando o mesmo label → 2 e 3 são sufixados em ordem.
    #[test]
    fn terceira_sessao_vira_label_3() {
        let reg = AgentRegistry::default();
        reg.register("Frontend".into(), "s1".into(), "ui".into(), None, None);
        reg.register("Frontend".into(), "s2".into(), "ui".into(), None, None);
        let c = reg.register("Frontend".into(), "s3".into(), "ui".into(), None, None);
        assert_eq!(c, "Frontend 3");
        assert_eq!(reg.0.len(), 3);
    }
}