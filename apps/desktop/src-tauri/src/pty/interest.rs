//! Registro de interesse do frontend por sessão PTY.
//!
//! Motivação (auditoria de performance): o backend estava emitindo `pty://output` para
//! **todas** as sessões vivas, inclusive de floors invisíveis. Isso gerava serialização
//! desnecessária, tráfego IPC e trabalho de renderização no webview para nós fora da tela.
//! Aqui o frontend declara, por `session_id`, quando realmente há uma view montada
//! olhando para aquele terminal. O emulador VT continua sendo alimentado pelo read_loop
//! normalmente, então o snapshot fica correto e o conteúdo é recuperado ao voltar para o
//! floor.
//!
//! Regra de ouro: **fail-open**. Se ninguém declarou nada sobre uma sessão, ela é
//! considerada interessada. Um bug de fiação no frontend nunca deve silenciar um
//! terminal sem explicação — o pior caso é manter o comportamento anterior.

use dashmap::DashMap;

// `LazyLock` da std em vez de once_cell: o crate não tem essa dependência e o
// rust-version aqui é 1.77+, onde LazyLock já é estável.

// Escolha: DashMap + once_cell::Lazy.
// Justificativa: o pty manager do projeto já usa DashMap, então não adicionamos
// dependência nova. No hot path de `should_emit` evitamos o custo de um RwLock
// exclusivo para leitores e permitimos updates concorrentes sem bloqueios grossos.
//
// Otimização de memória: guardamos SÓ as sessões que foram explicitamente marcadas
// como SEM interesse. O caso comum (interessado) não paga inserção e o mapa fica
// pequeno.
// `OnceLock` (estável desde 1.70) e não `LazyLock` (1.80): o `rust-version` deste
// crate é 1.77.2, e o clippy reprova item acima do MSRV declarado.
static UNINTERESTED: std::sync::OnceLock<DashMap<String, bool>> = std::sync::OnceLock::new();

fn mapa() -> &'static DashMap<String, bool> {
    UNINTERESTED.get_or_init(DashMap::new)
}

/// Marca ou desmarca interesse do frontend numa sessão.
///
/// `interested == true` remove a sessão do mapa (fail-open e mapa mínimo).
/// `interested == false` registra que essa sessão deve ser silenciada no emit.
pub fn set_interest(session_id: &str, interested: bool) {
    if interested {
        // Remover faz com que `should_emit` volte ao padrão seguro: true.
        mapa().remove(session_id);
    } else {
        // Guardamos apenas a ausência de interesse.
        mapa().insert(session_id.to_string(), false);
    }
}

/// O backend deve emitir `pty://output` para esta sessão?
///
/// Desconhecida = SIM (fail-open). Só devolve `false` se o frontend explicitamente
/// declarou que não há ninguém olhando.
pub fn should_emit(session_id: &str) -> bool {
    match mapa().get(session_id) {
        Some(entry) => *entry.value(), // só existe se for `false`
        None => true,                  // fail-open: terminal nunca fica mudo por engano
    }
}

/// Esquece a sessão quando o PTY morre, evitando crescimento infinito do mapa.
pub fn forget(session_id: &str) {
    mapa().remove(session_id);
}

/// Quantas sessões estão explicitamente marcadas como SEM interesse (diagnóstico).
pub fn muted_count() -> usize {
    mapa().len()
}

#[cfg(test)]
mod tests {
    /// Serializa APENAS os testes que asseveram `muted_count`, que é global. Sem isto
    /// eles disputam o mesmo mapa e falham de forma intermitente — flaky por construção.
    static CONTADOR_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    use super::*;

    // Evita colisão entre testes que rodam em paralelo.
    fn unique(prefix: &str) -> String {
        format!(
            "{}-{}-{:?}",
            prefix,
            std::process::id(),
            std::thread::current().id()
        )
    }

    #[test]
    fn unknown_session_emits_true_fail_open() {
        // Falha real: se uma sessão nunca declarada fosse silenciada, um bug no
        // frontend deixaria o terminal mudo sem qualquer explicação.
        let sid = unique("unknown");
        assert!(
            should_emit(&sid),
            "sessão desconhecida deve emitir (fail-open)"
        );
    }

    #[test]
    fn set_false_mutes_and_set_true_re_enables() {
        let _guarda = CONTADOR_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // Falha real: alternar visibilidade de floor não pode perder saída nem
        // deixar de silenciar quando o terminal sai da tela.
        let sid = unique("toggle");

        let base = muted_count();
        assert!(should_emit(&sid));

        set_interest(&sid, false);
        assert!(!should_emit(&sid), "marcar false deve silenciar");
        assert_eq!(muted_count(), base + 1);

        set_interest(&sid, true);
        assert!(should_emit(&sid), "marcar true deve voltar a emitir");
        assert_eq!(muted_count(), base);
    }

    #[test]
    fn forget_restores_fail_open_and_cleans_map() {
        let _guarda = CONTADOR_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // Falha real: PTYs mortos acumulando no mapa cresceriam a memória para
        // sempre e sessões recriadas com o mesmo id herdariam estado errado.
        let sid = unique("forget");

        let base = muted_count();
        set_interest(&sid, false);
        assert!(!should_emit(&sid));
        assert_eq!(muted_count(), base + 1);

        forget(&sid);
        assert!(should_emit(&sid), "após forget deve voltar ao fail-open");
        assert_eq!(muted_count(), base);
    }

    #[test]
    fn muted_count_counts_only_muted_sessions() {
        let _guarda = CONTADOR_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // Falha real: métrica de performance mostrando sessões interessadas como
        // se fossem silenciadas daria diagnóstico errado na auditoria.
        let a = unique("muted-a");
        let b = unique("muted-b");
        let c = unique("muted-c");

        let base = muted_count();
        set_interest(&a, false);
        set_interest(&b, false);
        set_interest(&c, true); // interessado -> não entra no mapa

        assert_eq!(muted_count(), base + 2);

        forget(&a);
        forget(&b);
        forget(&c);
        assert_eq!(muted_count(), base);
    }

    #[test]
    fn concurrent_set_and_read_does_not_panic() {
        // Também segura o lock: este teste mexe no mapa global e, solto, fazia os
        // testes de contagem falharem de forma intermitente.
        let _guarda = CONTADOR_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // Falha real: declare/desdeclare interesse de vários floors ao mesmo tempo
        // enquanto o read_loop emite; uma primitiva não thread-safe causaria panic
        // ou corrupção de estado.
        const THREADS: usize = 8;
        const ITERATIONS: usize = 1_000;

        std::thread::scope(|s| {
            for i in 0..THREADS {
                s.spawn(move || {
                    let sid = unique(&format!("concurrent-{i}"));
                    for j in 0..ITERATIONS {
                        set_interest(&sid, j % 2 == 0);
                        let _ = should_emit(&sid);
                        if j % 10 == 0 {
                            forget(&sid);
                        }
                    }
                    // Limpa o que criou: `muted_count` é global e sobras daqui
                    // faziam os testes de contagem falharem de forma intermitente.
                    forget(&sid);
                });
            }
        });

        // Se chegamos aqui, não houve deadlock nem panic sob contenção.
    }
}
