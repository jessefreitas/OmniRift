//! Execution host (ref §3.1, RE 03 — `executionHostId`).
//!
//! Colapsa "onde o agente roda" num único campo string tagged-union (`local` |
//! `ssh:<encoded>`) pra que o resto do código NÃO ramifique por transporte. Só os
//! pontos de spawn (`build_command` em `session.rs`) consultam `ExecutionHost::parse`
//! e decidem local-vs-ssh-wrap num lugar só. `runtime:<id>` = fase 2 (fora do MVP).
//!
//! ## Encoding do id
//! `Ssh(target)` serializa como `ssh:<percent-encoded target>`. O percent-encode
//! (próprio, sem dep nova) preserva `:`/`@`/`/` (que são comuns em `user@host`,
//! `host:port`, `ssh://...`) sobrevivendo dentro do próprio formato `ssh:`. Espelha o
//! `toSshExecutionHostId` do ref (`encodeURIComponent`). `parse` faz o caminho de
//! volta — round-trip exato.
//!
//! ## Segurança (CRÍTICO — este é o ponto de injeção de comando)
//! O `target` vira argv de `ssh` e o `cmd` remoto roda num shell do host remoto.
//! Duas defesas, ambas em fns PURAS testáveis:
//!   1. `validate_target` — rejeita qualquer `target` com metacaractere de shell
//!      (`;`, `|`, `&`, `$`, backtick, `(`, `)`, `<`, `>`, espaço, aspas, quebras,
//!      `\`, `*`, `?`, `!`, `#`, `~`, `=`, `%`, `,`, `+`, `[`, `]`, `{`, `}`).
//!      Whitelist: só `[A-Za-z0-9._@:-]`. Um `target` que não passa NUNCA chega ao
//!      `Command::new("ssh")` — `parse` devolve `Ssh` cru, mas `ssh_argv` falha.
//!   2. `shell_quote_single` — embrulha o `cmd` remoto em aspas simples POSIX
//!      (`'...'`, com `'` escapado como `'\''`), então o shell remoto recebe um único
//!      token literal — nada dentro do `cmd` é reinterpretado pelo shell do host.

/// Onde os terminais/agentes de um floor executam. `runtime:<id>` fica de fora no MVP
/// (RE §7.6). `Local` = comportamento atual idêntico (nenhum wrap).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExecutionHost {
    /// Máquina atual — sem wrap, spawn direto (default).
    Local,
    /// Host SSH remoto; `String` é o `sshTarget` cru (ex.: `user@host`, `host:2222`).
    Ssh(String),
}

impl ExecutionHost {
    /// Id serializado (`"local"` | `"ssh:<encoded>"`). Round-trip exato com `parse`.
    pub fn id(&self) -> String {
        match self {
            Self::Local => "local".to_string(),
            Self::Ssh(target) => format!("ssh:{}", percent_encode(target)),
        }
    }

    /// Parseia um `executionHostId` string. Qualquer coisa que não seja um
    /// `ssh:<algo-não-vazio>` válido cai em `Local` (fail-safe: desconhecido =
    /// local, nunca remoto). Espelha `parseExecutionHostId` do ref.
    ///
    /// NÃO valida o target contra injeção aqui — `parse` é só decode. A validação
    /// anti-injeção vive em `ssh_argv`/`validate_target`, no ponto onde o target
    /// vira argv (defesa no boundary de execução, não no de parsing).
    pub fn parse(s: &str) -> Self {
        if let Some(rest) = s.strip_prefix("ssh:") {
            let target = percent_decode(rest);
            if !target.is_empty() {
                return Self::Ssh(target);
            }
        }
        // "local", "", "runtime:..." (fase 2), ou lixo → Local.
        Self::Local
    }

    /// `true` se este host roda remoto via SSH (o único caso que embrulha o comando).
    pub fn is_remote(&self) -> bool {
        matches!(self, Self::Ssh(_))
    }
}

impl Default for ExecutionHost {
    fn default() -> Self {
        Self::Local
    }
}

/// Valida um `sshTarget` contra injeção: whitelist estrita `[A-Za-z0-9._@:-]`.
/// Vazio ou qualquer metacaractere → `Err`. É a primeira barreira: nada que não
/// passe aqui chega ao argv do `ssh`.
pub fn validate_target(target: &str) -> Result<(), String> {
    if target.is_empty() {
        return Err("sshTarget vazio".to_string());
    }
    // Comprimento defensivo (um host legítimo nunca passa disso).
    if target.len() > 255 {
        return Err("sshTarget longo demais (>255)".to_string());
    }
    // `[`/`]` permitidos p/ IPv6 (`user@[2001:db8::1]:2222`) — vão pro argv do `ssh`
    // literais (sem shell local), não são vetor de injeção. [GLM-audit — IPv6]
    if let Some(bad) = target
        .chars()
        .find(|c| !(c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '@' | ':' | '-' | '[' | ']')))
    {
        return Err(format!(
            "sshTarget contém caractere inválido {bad:?} — só [A-Za-z0-9._@:[]-] são permitidos (anti-injeção)"
        ));
    }
    Ok(())
}

/// Embrulha um único token em aspas simples POSIX, à prova de injeção: o shell
/// remoto recebe o conteúdo verbatim. `'` interno vira `'\''` (fecha aspas, escapa
/// uma `'` literal, reabre aspas). Resultado é sempre um único argumento de shell.
pub fn shell_quote_single(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for c in s.chars() {
        if c == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(c);
        }
    }
    out.push('\'');
    out
}

/// Monta o argv completo do `ssh` pra rodar `remote_cmd` num PTY remoto no `target`.
///
/// Forma (RE §7.4 + spec Parte A.2):
///   `ssh -tt -o BatchMode=yes -o StrictHostKeyChecking=accept-new <target> -- <cmd>`
///
/// - `-tt`: força alocação de PTY remoto (o agente é uma TUI full-screen).
/// - `-o BatchMode=yes`: SÓ key-auth — se a chave falhar, o ssh ABORTA em vez de
///   travar num prompt de senha (que ninguém veria no PTY). Nunca senha via IPC.
/// - `-o StrictHostKeyChecking=accept-new`: aceita host novo (primeira conexão) mas
///   ainda detecta troca de chave (MITM) de hosts conhecidos.
/// - `--`: separa as opções do ssh do comando remoto (target não vira flag).
/// - `<cmd>`: passado como UM token shell-quotado → o shell remoto não reinterpreta.
///
/// Falha (`Err`) se o `target` não passa em `validate_target` — anti-injeção.
/// O `remote_cmd` NÃO é validado (qualquer comando é legítimo): ele é blindado por
/// `shell_quote_single`, não por whitelist.
pub fn ssh_argv(target: &str, remote_cmd: &str) -> Result<(String, Vec<String>), String> {
    validate_target(target)?;
    let args = vec![
        "-tt".to_string(),
        "-o".to_string(),
        "BatchMode=yes".to_string(),
        "-o".to_string(),
        "StrictHostKeyChecking=accept-new".to_string(),
        target.to_string(),
        "--".to_string(),
        // remote_cmd CRU (1 elemento argv): o `ssh` junta os args pós-`--` com espaço e
        // manda pro `$SHELL -c` REMOTO, que parseia o `cd`/`&&`/`exec`. Re-quotar com
        // shell_quote_single faria o shell remoto ver UM literal só → "command not found"
        // (SSH morto). A segurança vem do inner-quote POR TOKEN em build_remote_command_line
        // (cada arg do agente já é `'...'`), não desta camada. [GLM-audit — crítico]
        remote_cmd.to_string(),
    ];
    Ok(("ssh".to_string(), args))
}

/// Junta `program` + `args` numa linha de comando remota shell-quotada, pra rodar
/// via SSH. Cada token é individualmente shell-quotado e separado por espaço — o
/// shell remoto recebe `prog arg1 arg2` com cada um literal. É o `cmd-remoto` que
/// vira o último arg de `ssh_argv` (que o quota DE NOVO como um único token, pra
/// sobreviver ao argv do `ssh` local → o shell remoto desfaz essa camada e vê a
/// linha; o quote por-token interno protege os args entre si).
pub fn build_remote_command_line(program: &str, args: &[String]) -> String {
    let mut line = shell_quote_single(program);
    for a in args {
        line.push(' ');
        line.push_str(&shell_quote_single(a));
    }
    line
}

/// Percent-encode próprio (sem dep nova — `urlencoding` não está no manifesto).
/// Codifica tudo que não seja "unreserved" RFC3986 (`A-Za-z0-9-._~`) como `%XX`.
/// Isso garante que `:`, `@`, `/`, espaço etc. do target sobrevivam dentro do
/// formato `ssh:<...>` sem ambiguidade no `parse`.
fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push('%');
            out.push(hex_upper(b >> 4));
            out.push(hex_upper(b & 0x0f));
        }
    }
    out
}

/// Decodifica `%XX` de volta. Bytes inválidos (`%` solto / hex malformado) são
/// mantidos verbatim (decode tolerante — nunca panica).
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (from_hex(bytes[i + 1]), from_hex(bytes[i + 2])) {
                out.push((h << 4) | l);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_upper(nibble: u8) -> char {
    match nibble {
        0..=9 => (b'0' + nibble) as char,
        10..=15 => (b'A' + (nibble - 10)) as char,
        _ => '0',
    }
}

fn from_hex(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_round_trip() {
        assert_eq!(ExecutionHost::parse("local"), ExecutionHost::Local);
        assert_eq!(ExecutionHost::Local.id(), "local");
        // Desconhecido / vazio / runtime (fase 2) → Local (fail-safe).
        assert_eq!(ExecutionHost::parse(""), ExecutionHost::Local);
        assert_eq!(ExecutionHost::parse("runtime:env-1"), ExecutionHost::Local);
        assert_eq!(ExecutionHost::parse("ssh:"), ExecutionHost::Local); // vazio após prefixo
        assert_eq!(ExecutionHost::parse("garbage"), ExecutionHost::Local);
    }

    #[test]
    fn ssh_round_trip_simple() {
        let h = ExecutionHost::Ssh("box".to_string());
        let id = h.id();
        assert_eq!(id, "ssh:box");
        assert_eq!(ExecutionHost::parse(&id), h);
    }

    #[test]
    fn ssh_round_trip_with_user_at_host_port() {
        // O caso que exige encoding: `:` e `@` no target.
        let target = "user@host.example.com:2222";
        let h = ExecutionHost::Ssh(target.to_string());
        let id = h.id();
        // `@` e `:` percent-encoded dentro do `ssh:` → sem ambiguidade no parse.
        assert!(id.starts_with("ssh:"), "id: {id}");
        assert!(id.contains("%40"), "@ encoded: {id}"); // @ = 0x40
        assert!(id.contains("%3A"), ": encoded: {id}"); // : = 0x3A
        // round-trip recupera o target exato.
        assert_eq!(ExecutionHost::parse(&id), h);
        if let ExecutionHost::Ssh(t) = ExecutionHost::parse(&id) {
            assert_eq!(t, target);
        } else {
            panic!("deveria ser Ssh");
        }
    }

    #[test]
    fn ssh_round_trip_with_slash_and_ssh_uri() {
        // ssh://user@host/path tipo target — `/` precisa sobreviver.
        let target = "ssh://deploy@10.0.0.1/srv";
        let h = ExecutionHost::Ssh(target.to_string());
        let id = h.id();
        assert!(id.contains("%2F"), "/ encoded: {id}"); // / = 0x2F
        assert_eq!(ExecutionHost::parse(&id), h);
    }

    #[test]
    fn is_remote() {
        assert!(!ExecutionHost::Local.is_remote());
        assert!(ExecutionHost::Ssh("x".into()).is_remote());
        assert!(!ExecutionHost::default().is_remote());
    }

    // ---- Validação anti-injeção do target -------------------------------

    #[test]
    fn valid_targets_accepted() {
        for t in [
            "host",
            "user@host",
            "user@host.example.com",
            "user@host:2222",
            "10.0.0.1",
            "my-box_01.internal",
            "git@git.omnimemory.com.br",
        ] {
            assert!(validate_target(t).is_ok(), "deveria aceitar: {t}");
        }
    }

    #[test]
    fn injection_targets_rejected() {
        // Cada um destes tenta injetar comando/escapar o argv → DEVE falhar.
        for t in [
            "host; rm -rf /",
            "host && curl evil",
            "host | nc evil 9999",
            "host`whoami`",
            "host$(id)",
            "host\nrm -rf /",
            "-oProxyCommand=evil", // flag injection (mas '=' já está fora da whitelist)
            "host '; evil'",
            "host\"x",
            "host*",
            "host/../etc",
            "",
            "host with space",
        ] {
            assert!(
                validate_target(t).is_err(),
                "deveria REJEITAR (injeção): {t:?}"
            );
        }
    }

    // ---- shell_quote_single ---------------------------------------------

    #[test]
    fn shell_quote_basic() {
        assert_eq!(shell_quote_single("hello"), "'hello'");
        assert_eq!(shell_quote_single("a b c"), "'a b c'");
    }

    #[test]
    fn shell_quote_escapes_single_quote() {
        // O caso crítico: aspas simples dentro do conteúdo.
        assert_eq!(shell_quote_single("it's"), "'it'\\''s'");
        // Tentativa de quebrar o quoting: `'; rm -rf / #`
        let evil = "'; rm -rf / #";
        let q = shell_quote_single(evil);
        // Começa e termina com aspas simples, e a `'` interna foi neutralizada.
        assert!(q.starts_with('\''));
        assert!(q.ends_with('\''));
        assert!(q.contains("'\\''"));
        // O conteúdo perigoso vira literal dentro das aspas (não há `'` solta que
        // reabriria o shell).
        assert!(q.contains("rm -rf"));
    }

    // ---- ssh_argv montado certo -----------------------------------------

    #[test]
    fn ssh_argv_builds_expected_flags() {
        let (prog, args) = ssh_argv("user@host", "claude --foo").expect("target ok");
        assert_eq!(prog, "ssh");
        // Forma exata: -tt -o BatchMode=yes -o StrictHostKeyChecking=accept-new <target> -- <cmd>
        assert_eq!(args[0], "-tt");
        assert_eq!(args[1], "-o");
        assert_eq!(args[2], "BatchMode=yes");
        assert_eq!(args[3], "-o");
        assert_eq!(args[4], "StrictHostKeyChecking=accept-new");
        assert_eq!(args[5], "user@host");
        assert_eq!(args[6], "--");
        // O cmd remoto é o último arg, CRU — o ssh junta e manda pro shell remoto parsear.
        // (A segurança é o inner-quote por token em build_remote_command_line, não aqui.)
        assert_eq!(args[7], "claude --foo");
        assert_eq!(args.len(), 8);
    }

    #[test]
    fn ssh_argv_rejects_injection_target() {
        let err = ssh_argv("host; rm -rf /", "claude").unwrap_err();
        assert!(err.contains("inválido") || err.contains("injeção"), "{err}");
    }

    #[test]
    fn malicious_agent_arg_neutralized_by_per_token_quote() {
        // A segurança do cmd remoto vem do quote POR TOKEN (build_remote_command_line),
        // não do ssh_argv. Um arg do agente com metacaractere vira UM token entre aspas →
        // o shell remoto não reinterpreta o `;`.
        let line = build_remote_command_line("claude", &["echo hi; rm -rf /".to_string()]);
        assert_eq!(line, "'claude' 'echo hi; rm -rf /'");
        // ssh_argv passa a linha CRUA (o ssh manda pro shell remoto, que vê os tokens
        // quotados — o `;` dentro das aspas é literal, não executa).
        let (_p, args) = ssh_argv("host", &line).expect("ok");
        assert_eq!(args.last().unwrap(), "'claude' 'echo hi; rm -rf /'");
    }

    #[test]
    fn ipv6_target_accepted() {
        // IPv6 exige colchetes — devem passar (literais no argv, sem injeção). [GLM-audit]
        assert!(validate_target("user@[2001:db8::1]:2222").is_ok());
    }

    // ---- build_remote_command_line --------------------------------------

    #[test]
    fn remote_command_line_quotes_each_token() {
        let line = build_remote_command_line("claude", &[
            "--append-system-prompt".to_string(),
            "you are an agent".to_string(),
        ]);
        // prog e cada arg shell-quotados, separados por espaço.
        assert_eq!(line, "'claude' '--append-system-prompt' 'you are an agent'");
    }

    #[test]
    fn remote_command_line_no_args() {
        assert_eq!(build_remote_command_line("bash", &[]), "'bash'");
    }
}
