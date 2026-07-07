//! Parse + validação da RoutingTable a partir de JSON (`~/.omnirift/llm_router.json`).

use crate::llm_router::RoutingTable;

/// Parseia e valida a tabela. Erros: JSON inválido, classe sem alvos, keyRef vazio,
/// modelo duplicado dentro de uma classe (ambiguidade no `explicit`).
pub fn parse(json: &str) -> Result<RoutingTable, String> {
    let table: RoutingTable = serde_json::from_str(json).map_err(|e| format!("JSON inválido: {e}"))?;
    if table.classes.is_empty() {
        return Err("tabela sem nenhuma classe".into());
    }
    for (class, chain) in &table.classes {
        if chain.is_empty() {
            return Err(format!("classe '{class}' sem alvos"));
        }
        let mut seen = std::collections::HashSet::new();
        for t in chain {
            if t.key_ref.trim().is_empty() {
                return Err(format!("classe '{class}': alvo '{}' com keyRef vazio", t.model));
            }
            if !seen.insert(t.model.as_str()) {
                return Err(format!("classe '{class}': modelo '{}' duplicado", t.model));
            }
        }
    }
    Ok(table)
}

#[cfg(test)]
mod tests {
    use super::*;

    const OK: &str = r#"{
      "classes": {
        "code": [
          {"providerId":"ollama","model":"kimi","keyRef":"credential.llm.ollama","cost":"low","capability":"high"},
          {"providerId":"groq","model":"llama","keyRef":"credential.llm.groq"}
        ]
      },
      "defaultStrategy": "cost-first"
    }"#;

    #[test]
    fn parses_valid_table() {
        let t = parse(OK).expect("deve parsear");
        assert_eq!(t.classes["code"].len(), 2);
        assert_eq!(t.default_strategy, crate::llm_router::Strategy::CostFirst);
        assert_eq!(t.classes["code"][0].cost, crate::llm_router::Cost::Low);
    }

    #[test]
    fn rejects_empty_classes() {
        let err = parse(r#"{"classes":{}}"#).unwrap_err();
        assert!(err.contains("nenhuma classe"));
    }

    #[test]
    fn rejects_empty_chain() {
        let err = parse(r#"{"classes":{"code":[]}}"#).unwrap_err();
        assert!(err.contains("sem alvos"));
    }

    #[test]
    fn rejects_empty_keyref() {
        let err = parse(r#"{"classes":{"code":[{"providerId":"x","model":"m","keyRef":""}]}}"#).unwrap_err();
        assert!(err.contains("keyRef vazio"));
    }

    #[test]
    fn rejects_duplicate_model() {
        let j = r#"{"classes":{"code":[
          {"providerId":"a","model":"m","keyRef":"k1"},
          {"providerId":"b","model":"m","keyRef":"k2"}]}}"#;
        assert!(parse(j).unwrap_err().contains("duplicado"));
    }
}
