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
                    v.insert(AgentEntry {
                        session_id: session_id.clone(),
                        description: description.clone(),
                        floor: floor.clone(),
                        role: role.clone(),
                    });
                    break;
                }
                Entry::Occupied(mut o) if o.get().session_id == session_id => {
                    // Mesma sessão: re-registro (rename/reload/toggle do Sidebar) → atualiza
                    // metadados, MAS `None` significa "não sei", não "apague". Sobrescrever
                    // com None fazia o papel declarado no spawn evaporar: o Sidebar
                    // re-registra sem role em 4 caminhos, e o primeiro toggle depois de um
                    // spawn do orquestrador zerava o papel — derrubando em silêncio o guard
                    // anti-duplicata POR PAPEL, que é justamente o que pega o sinônimo.
                    let role = role.clone().or_else(|| o.get().role.clone());
                    let floor = floor.clone().or_else(|| o.get().floor.clone());
                    o.insert(AgentEntry {
                        session_id: session_id.clone(),
                        description: description.clone(),
                        floor,
                        role,
                    });
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
        log::info!(
            "MCP: agente '{}' registrado ({})",
            effective,
            &session_id[..8.min(session_id.len())]
        );
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
        self.0
            .iter()
            .map(|e| (e.key().clone(), e.value().clone()))
            .collect()
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

/// Resultado da resolução tolerante de um label de agente.
///
/// O MCP expõe labels amigáveis (ex: "DevOps - Codex"), mas o Orquestrador
/// costuma consultar por sinônimos curtos (ex: "Codex"). Em vez de falhar
/// com "não encontrado" e induzir o agente a spawnar outro, resolvemos
/// fuzzy — e quando a dúvida não é resolvível sozinha, devolvemos os
/// candidatos para que o chamador escolha.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LabelMatch {
    /// Um único agente casou; o String é o label CANONICO (como está registrado).
    Found(String),
    /// Vários candidatos casaram — quem chamou precisa escolher. Labels canônicos, ordenados.
    Ambiguous(Vec<String>),
    /// Nada casou. Traz os labels registrados (ordenados) para a mensagem de erro sugerir.
    NotFound(Vec<String>),
}

impl AgentRegistry {
    /// Resolve uma consulta de label em até 4 passos, da mais restrita à mais tolerante.
    ///
    /// A ordem importa: exato vence sempre; normalização vence substring; substring
    /// só decide se houver exatamente um candidato. Se houver mais de um, a resposta
    /// é `Ambiguous` com TODOS os candidatos, para que o chamador peça o label exato
    /// em vez de adivinhar e possivelmente spawnar um duplicado.
    pub fn resolve_label(&self, query: &str) -> LabelMatch {
        let query_trimmed = query.trim();
        let query_lower = query_trimmed.to_lowercase();

        // Coleta todos os labels canônicos e já ordena — DashMap itera em ordem
        // de hash, então fixamos ordem alfabética para determinismo nos testes
        // e nas mensagens de erro.
        let mut labels: Vec<String> = self.0.iter().map(|e| e.key().clone()).collect();
        labels.sort();

        // 1) Igualdade EXATA com o label registrado.
        for label in &labels {
            if label == query {
                return LabelMatch::Found(label.clone());
            }
        }

        // 2) Igualdade ignorando maiúsculas/minúsculas e espaços nas pontas.
        for label in &labels {
            if label.trim().to_lowercase() == query_lower {
                return LabelMatch::Found(label.clone());
            }
        }

        // 3) Substring case-insensitive: o query aparece dentro do label.
        let mut candidates: Vec<String> = labels
            .iter()
            .filter(|label| label.to_lowercase().contains(&query_lower))
            .cloned()
            .collect();

        match candidates.len() {
            0 => {
                // 4) Nada casou. Devolve a lista completa para enriquecer o erro.
                LabelMatch::NotFound(labels)
            }
            1 => LabelMatch::Found(candidates.pop().unwrap()),
            _ => {
                // Mais de um candidato: não arriscamos chutar. Ordena e pede ao
                // chamador que use o label exato.
                candidates.sort();
                LabelMatch::Ambiguous(candidates)
            }
        }
    }
}

/// Mensagem pronta pro erro do MCP, em pt-BR, listando os candidatos.
///
/// `Found` não é erro, então devolve string vazia. `Ambiguous` e `NotFound`
/// dão ao Orquestrador a informação que faltava para decidir, evitando que ele
/// conclua erroneamente que precisa spawnar outro agente.
pub fn erro_de_label(query: &str, m: &LabelMatch) -> String {
    match m {
        LabelMatch::Found(_) => String::new(),
        LabelMatch::Ambiguous(candidates) => format!(
            "O nome '{}' é ambíguo. Candidatos: {}. Por favor, informe o label exato.",
            query,
            candidates.join(", ")
        ),
        LabelMatch::NotFound(labels) => {
            if labels.is_empty() {
                // Pegadinha que confundiu o orquestrador: a seção da sidebar é opt-in.
                // Sem nenhum nó marcado, o registry fica vazio e nenhuma tool MCP existe.
                "Nenhum agente está registrado. Para disponibilizar um agente, marque o nó na seção 'MCP AGENTS' da barra lateral (é opt-in).".into()
            } else {
                format!(
                    "Agente '{}' não encontrado. Labels registrados: {}. Use list_agents ou informe o label exato.",
                    query,
                    labels.join(", ")
                )
            }
        }
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

        let a = reg.register(
            "Backend".into(),
            "sess-original".into(),
            "API".into(),
            None,
            None,
        );
        assert_eq!(a, "Backend");

        let b = reg.register(
            "Backend".into(),
            "sess-clone".into(),
            "API".into(),
            None,
            None,
        );
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
        let again = reg.register(
            "QA".into(),
            "sess-1".into(),
            "testes e2e".into(),
            Some("feat/x".into()),
            None,
        );

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

    /// REGRESSAO: o Sidebar re-registra o agente sem informar role em 4 caminhos (toggle do
    /// checkbox MCP, restore, reload). Sobrescrever com None fazia o papel declarado no spawn
    /// evaporar no primeiro toggle, e o guard anti-duplicata POR PAPEL — o que pega o
    /// orquestrador abrindo "UI Dev" em cima de um "Frontend" livre — parava de funcionar em
    /// silencio, sem erro nenhum na tela.
    #[test]
    fn reregistro_sem_role_preserva_o_papel_declarado() {
        let reg = AgentRegistry::default();
        reg.register(
            "Frontend".into(),
            "s1".into(),
            "ui".into(),
            Some("feat/ui".into()),
            Some("frontend".into()),
        );
        let again = reg.register(
            "Frontend".into(),
            "s1".into(),
            "ui atualizada".into(),
            None,
            None,
        );
        assert_eq!(
            again, "Frontend",
            "re-registro da mesma sessao mantem o label"
        );
        // ESCOPO OBRIGATÓRIO: `get()` devolve um Ref que segura o shard do DashMap em
        // leitura. Segurá-lo enquanto se chama `register()` (que pede escrita no MESMO
        // shard) TRAVA o teste — deadlock, não falha. Custou uma suíte pendurada por
        // minutos até eu perceber que "rodando há 60s" não era compilação lenta.
        {
            let e = reg.0.get("Frontend").unwrap();
            assert_eq!(
                e.role.as_deref(),
                Some("frontend"),
                "o papel do spawn nao pode evaporar"
            );
            assert_eq!(
                e.floor.as_deref(),
                Some("feat/ui"),
                "o floor tambem e preservado"
            );
            assert_eq!(
                e.description, "ui atualizada",
                "o que FOI informado atualiza normalmente"
            );
        }
        reg.register(
            "Frontend".into(),
            "s1".into(),
            "x".into(),
            None,
            Some("backend".into()),
        );
        assert_eq!(
            reg.0.get("Frontend").unwrap().role.as_deref(),
            Some("backend"),
            "Some tem que sobrescrever; so None e que preserva"
        );
    }

    mod tests {
        use super::*;

        #[test]
        fn resolve_exato_vence_substring_e_nao_eh_ambiguo() {
            // Falha real: se houvesse "Codex" e "Codex Helper", uma busca por
            // "Codex" poderia cair em substring e virar ambígua. Exato deve vencer.
            let r = AgentRegistry::new();
            r.register("Codex".into(), "s1".into(), "".into(), None, None);
            r.register("Codex Helper".into(), "s2".into(), "".into(), None, None);

            match r.resolve_label("Codex") {
                LabelMatch::Found(label) => assert_eq!(label, "Codex"),
                other => panic!("esperado Found('Codex'), obtido {:?}", other),
            }
        }

        #[test]
        fn resolve_caso_real_devops_codex_por_codex_eh_found() {
            // Reproduz exatamente o relato: agente registrado como "DevOps - Codex",
            // orquestrador consultou "Codex". Deve achar por substring única e evitar
            // que o orquestrador spawnasse outro agente.
            let r = AgentRegistry::new();
            r.register("DevOps - Codex".into(), "s1".into(), "".into(), None, None);

            match r.resolve_label("Codex") {
                LabelMatch::Found(label) => assert_eq!(label, "DevOps - Codex"),
                other => panic!("esperado Found('DevOps - Codex'), obtido {:?}", other),
            }
        }

        #[test]
        fn resolve_dois_labels_contendo_codex_eh_ambiguous() {
            // Falha real: múltiplos candidatos forçam o chamador a escolher, em vez
            // de o MCP decidir errado e endereçar o agente errado.
            let r = AgentRegistry::new();
            r.register("DevOps - Codex".into(), "s1".into(), "".into(), None, None);
            r.register("Codex Helper".into(), "s2".into(), "".into(), None, None);

            match r.resolve_label("Codex") {
                LabelMatch::Ambiguous(cands) => {
                    assert_eq!(cands, vec!["Codex Helper", "DevOps - Codex"]);
                }
                other => panic!("esperado Ambiguous, obtido {:?}", other),
            }
        }

        #[test]
        fn resolve_case_insensitive_e_trim() {
            // Sidebar pode registrar com espaços; o orquestrador pode mandar caixa
            // diferente. A normalização deve encontrar sem exigir match perfeito.
            let r = AgentRegistry::new();
            r.register("DevOps - Codex".into(), "s1".into(), "".into(), None, None);

            match r.resolve_label("  devops - codex  ") {
                LabelMatch::Found(label) => assert_eq!(label, "DevOps - Codex"),
                other => panic!("esperado Found via trim+lower, obtido {:?}", other),
            }
        }

        #[test]
        fn resolve_notfound_lista_todos_ordenados() {
            // Quando não acha nada, a mensagem de erro deve listar todos os labels
            // ordenados, dando ao orquestrador a chance de usar o nome certo.
            let r = AgentRegistry::new();
            r.register("Zeta".into(), "s1".into(), "".into(), None, None);
            r.register("Alpha".into(), "s2".into(), "".into(), None, None);

            match r.resolve_label("Inexistente") {
                LabelMatch::NotFound(labels) => assert_eq!(labels, vec!["Alpha", "Zeta"]),
                other => panic!("esperado NotFound, obtido {:?}", other),
            }
        }

        #[test]
        fn resolve_vazio_notfound_sem_labels_e_msg_cita_mcp_agents() {
            // Falha real do orquestrador: registry vazio porque a seção MCP AGENTS
            // da sidebar é opt-in. A mensagem deve explicitar isso.
            let r = AgentRegistry::new();
            let m = r.resolve_label("Codex");

            match &m {
                LabelMatch::NotFound(labels) => assert!(labels.is_empty()),
                other => panic!("esperado NotFound vazio, obtido {:?}", other),
            }

            let msg = erro_de_label("Codex", &m);
            assert!(msg.contains("MCP AGENTS"));
            assert!(msg.contains("opt-in"));
        }

        #[test]
        fn erro_ambiguous_pergunta_pelo_exato() {
            let r = AgentRegistry::new();
            r.register("DevOps - Codex".into(), "s1".into(), "".into(), None, None);
            r.register("Codex Helper".into(), "s2".into(), "".into(), None, None);

            let m = r.resolve_label("Codex");
            let msg = erro_de_label("Codex", &m);
            assert!(msg.contains("ambíguo"));
            assert!(msg.contains("DevOps - Codex"));
            assert!(msg.contains("Codex Helper"));
        }

        #[test]
        fn erro_found_e_vazio() {
            let r = AgentRegistry::new();
            r.register("Codex".into(), "s1".into(), "".into(), None, None);

            let m = r.resolve_label("Codex");
            assert_eq!(erro_de_label("Codex", &m), "");
        }
    }

    /// Trava o defeito que já aconteceu duas vezes neste repo: o fix existe, tem teste
    /// verde, e NINGUÉM o chama. Se `resolve_label` sumir dos consumidores, o label
    /// aproximado volta a dar "não encontrado" e o orquestrador volta a spawnar duplicado.
    #[test]
    fn resolve_label_esta_fiado_nos_consumidores() {
        let tools = include_str!("tools.rs");
        let server = include_str!("server.rs");
        // `agent_registry.` no meio importa: existe um `mgr.resolve_label` homônimo no
        // AcpManager, e procurar só por "resolve_label" casava com ELE — o teste passava
        // com a fiação desfeita. Descoberto quebrando a fiação de propósito.
        assert!(
            tools.contains("agent_registry.resolve_label"),
            "mcp/tools.rs parou de usar resolve_label — send_text/run voltaram a exigir label exato"
        );
        assert!(
            server.contains("agent_registry.resolve_label"),
            "mcp/server.rs parou de usar resolve_label — do_send_task voltou a exigir label exato"
        );
    }
}
