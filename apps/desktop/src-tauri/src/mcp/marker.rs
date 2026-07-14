//! Formatação de mensagem inter-agente (orquestração). O agente-alvo recebe a
//! mensagem como input normal e responde naturalmente — a resposta é capturada
//! pelo *settle* do PTY (Working→Done), NÃO por um marcador de resposta a casar.
//! (O marcador `[[OMNIRIFT-REPLY]]` foi abandonado: o LLM não ecoa formato exato.)

/// Formata a mensagem que chega de outro agente, com rótulo legível de quem envia.
pub fn incoming(from: &str, text: &str) -> String {
    format!("[mensagem de {from}] {text}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn incoming_labels_sender() {
        assert_eq!(
            incoming("@Orquestrador", "o que você está fazendo?"),
            "[mensagem de @Orquestrador] o que você está fazendo?"
        );
    }
}
