//! Protocolo de marcador de orquestração: linhas especiais no PTY que os agentes trocam.
//! `ASK`/`MSG` são injetados pelo control plane; `REPLY` é o que o agente responde.
//! Parser PURO — sem PTY, sem estado — pra ser testável isolado.

/// Renderiza a linha ASK que o control plane injeta no PTY do alvo.
pub fn render_ask(from: &str, id: &str, question: &str) -> String {
    format!("[[OMNIRIFT-ASK from={from} id={id}]] {question}")
}

/// Renderiza a linha MSG (fire-and-forget) injetada no PTY do alvo.
pub fn render_msg(from: &str, message: &str) -> String {
    format!("[[OMNIRIFT-MSG from={from}]] {message}")
}

/// Extrai `(id, resposta)` de UMA linha REPLY. `None` se não for REPLY.
pub fn parse_reply(line: &str) -> Option<(String, String)> {
    let rest = line.trim().strip_prefix("[[OMNIRIFT-REPLY id=")?;
    let close = rest.find("]]")?;
    let id = rest[..close].trim().to_string();
    let answer = rest[close + 2..].trim().to_string();
    if id.is_empty() {
        return None;
    }
    Some((id, answer))
}

/// Varre uma tela (multi-linha) e devolve a resposta do REPLY cujo id casa `want_id`.
/// Varre de baixo pra cima: pega o REPLY mais recente daquele id.
pub fn find_reply(screen: &str, want_id: &str) -> Option<String> {
    screen.lines().rev().find_map(|l| {
        parse_reply(l).and_then(|(id, ans)| (id == want_id).then_some(ans))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_reply_with_matching_id() {
        let line = "[[OMNIRIFT-REPLY id=abc-123]] refatorando o auth";
        let got = parse_reply(line);
        assert_eq!(
            got,
            Some(("abc-123".to_string(), "refatorando o auth".to_string()))
        );
    }

    #[test]
    fn ignores_non_reply_lines() {
        assert_eq!(parse_reply("saída normal do agente"), None);
        assert_eq!(parse_reply("[[OMNIRIFT-ASK from=@A id=x]] oi"), None);
    }

    #[test]
    fn reply_matches_target_id_only() {
        let screen =
            "linha 1\n[[OMNIRIFT-REPLY id=zzz]] outra\n[[OMNIRIFT-REPLY id=abc]] certa\n";
        assert_eq!(find_reply(screen, "abc"), Some("certa".to_string()));
        assert_eq!(find_reply(screen, "nao-existe"), None);
    }

    #[test]
    fn empty_id_is_rejected() {
        assert_eq!(parse_reply("[[OMNIRIFT-REPLY id=]] vazio"), None);
    }

    #[test]
    fn ask_and_msg_render_expected_bytes() {
        assert_eq!(
            render_ask("@A", "abc", "o que faz?"),
            "[[OMNIRIFT-ASK from=@A id=abc]] o que faz?"
        );
        assert_eq!(render_msg("@B", "terminei"), "[[OMNIRIFT-MSG from=@B]] terminei");
    }
}
