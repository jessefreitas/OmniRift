//! Camada **specs** — descrição declarativa de cada comando (porta direta do
//! `CommandSpec` do ref, RE 05 §2.1/§3.1). Uma spec por comando: `path`, `usage`,
//! `summary`, flags permitidas e args posicionais. As specs são a **fonte única** de
//! help **e** validação (DRY): o help é renderizado delas e `validate` rejeita
//! comando/flag desconhecida ANTES de tocar no socket (senão um typo viraria o erro
//! enganoso "OmniRift não está rodando" — RE 05 §6.1).
//!
//! Sem dependências externas: parse de argv e validação são `std` puro, testável sem
//! socket nem app.

/// Flags globais aceitas por **qualquer** comando. `json` troca render humano por JSON
/// cru; `help`/`h` imprime o help do comando. Espelha `GLOBAL_FLAGS` do ref.
pub const GLOBAL_FLAGS: &[&str] = &["json", "help", "h"];

/// Flags que são **booleanas** (presença = true, sem valor): não consomem o próximo
/// token de argv. As demais flags consomem um valor (`--rows 80`).
pub const BOOLEAN_FLAGS: &[&str] = &["json", "help", "h"];

/// Descrição declarativa de um comando. `usage`/`summary`/`examples` alimentam o help;
/// `allowed_flags`/`positionals` alimentam a validação. Uma struct, dois usos (DRY).
#[derive(Debug, Clone)]
pub struct CommandSpec {
    /// Nome do comando como digitado (`status`, `agents`, `snapshot`).
    pub name: &'static str,
    /// Linha curta de ajuda.
    pub summary: &'static str,
    /// Linha de uso completa (`omnirift snapshot <sessionId> [--rows N]`).
    pub usage: &'static str,
    /// Flags aceitas além das globais (só os nomes longos, sem `--`).
    pub allowed_flags: &'static [&'static str],
    /// Args posicionais, em ordem (nomes p/ o help e p/ casar no handler).
    pub positionals: &'static [&'static str],
    /// Se `true`, o ÚLTIMO posicional declarado é **variádico**: aceita 1+ tokens, que o
    /// handler junta (ex.: `send <sessionId> <texto...>` → o texto pode ter vários tokens).
    /// `false` (default das specs antigas) = exatamente os declarados, nem a mais nem a menos.
    pub variadic_tail: bool,
    /// Exemplos pro help.
    pub examples: &'static [&'static str],
}

/// Tabela de todos os comandos MVP. `help`/`-h` e o registro de validação derivam
/// daqui — adicionar comando = adicionar uma entrada aqui + um braço no dispatch.
pub fn command_specs() -> &'static [CommandSpec] {
    const SPECS: &[CommandSpec] = &[
        CommandSpec {
            name: "status",
            summary: "Versão do app + contagem de agentes e floors.",
            usage: "omnirift status [--json]",
            allowed_flags: &[],
            positionals: &[],
            variadic_tail: false,
            examples: &["omnirift status", "omnirift status --json"],
        },
        CommandSpec {
            name: "agents",
            summary: "Lista os agentes (label, sessão, estado, floor).",
            usage: "omnirift agents [--json]",
            allowed_flags: &[],
            positionals: &[],
            variadic_tail: false,
            examples: &["omnirift agents", "omnirift agents --json"],
        },
        CommandSpec {
            name: "snapshot",
            summary: "Snapshot da tela de um PTY (emulador VT do #6).",
            usage: "omnirift snapshot <sessionId> [--rows N] [--json]",
            allowed_flags: &["rows"],
            positionals: &["sessionId"],
            variadic_tail: false,
            examples: &[
                "omnirift snapshot abc123",
                "omnirift snapshot abc123 --rows 40",
                "omnirift snapshot abc123 --json",
            ],
        },
        // --- Fase 2: mutações (só socket local) ---
        CommandSpec {
            name: "spawn",
            summary: "Cria um agente (PTY) e o attacha ao canvas.",
            usage: "omnirift spawn <command> [--args \"a b c\"] [--cwd P] [--label L] [--json]",
            allowed_flags: &["args", "cwd", "label"],
            positionals: &["command"],
            variadic_tail: false,
            examples: &[
                "omnirift spawn bash",
                "omnirift spawn claude --label alpha --cwd /tmp/work",
                "omnirift spawn claude --args \"--dangerously-skip-permissions\"",
            ],
        },
        CommandSpec {
            name: "send",
            summary: "Envia input (texto + Enter) p/ um agente.",
            usage: "omnirift send <sessionId> <texto...> [--json]",
            allowed_flags: &[],
            positionals: &["sessionId", "texto"],
            variadic_tail: true, // <texto...> aceita vários tokens (junta com espaço).
            examples: &[
                "omnirift send abc123 /help",
                "omnirift send abc123 implemente a feature X",
            ],
        },
        CommandSpec {
            name: "kill",
            summary: "Mata um agente (PTY). Idempotente.",
            usage: "omnirift kill <sessionId> [--json]",
            allowed_flags: &[],
            positionals: &["sessionId"],
            variadic_tail: false,
            examples: &["omnirift kill abc123"],
        },
    ];
    SPECS
}

/// Acha a spec de um comando pelo nome.
pub fn find_spec(name: &str) -> Option<&'static CommandSpec> {
    command_specs().iter().find(|s| s.name == name)
}

/// É flag booleana (não consome valor)?
pub fn is_boolean_flag(name: &str) -> bool {
    BOOLEAN_FLAGS.contains(&name)
}

/// Resultado do parse de argv: comando + flags + posicionais (na ordem). Cru — a
/// validação contra a spec é um passo separado ([`validate`]).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ParsedArgs {
    /// Nome do comando (1º token não-flag). `None` = nenhum comando (ex.: só `--help`).
    pub command: Option<String>,
    /// Flags: nome longo (sem `--`) → valor (string) ou `true` (booleana).
    pub flags: Vec<(String, FlagValue)>,
    /// Posicionais na ordem em que apareceram.
    pub positionals: Vec<String>,
    /// `help`/`-h` pedido (flag global, atalho).
    pub wants_help: bool,
    /// `--json` pedido.
    pub json: bool,
}

/// Valor de uma flag: string (`--rows 80`) ou booleana presente (`--json`).
#[derive(Debug, Clone, PartialEq)]
pub enum FlagValue {
    Str(String),
    Bool,
}

impl ParsedArgs {
    /// Valor string de uma flag, se presente como `--flag valor`.
    pub fn flag_str(&self, name: &str) -> Option<&str> {
        self.flags.iter().find_map(|(k, v)| match v {
            FlagValue::Str(s) if k == name => Some(s.as_str()),
            _ => None,
        })
    }

    /// True se a flag (booleana) está presente. Usado nos testes de parse e disponível
    /// pra handlers futuros que liguem comportamento por flag booleana específica.
    #[allow(dead_code)]
    pub fn has_flag(&self, name: &str) -> bool {
        self.flags.iter().any(|(k, _)| k == name)
    }
}

/// Erro de parse/validação de argv — sempre humano e acionável (o caller imprime e
/// sai com código != 0). Distinto dos erros de runtime (socket/app).
#[derive(Debug, Clone, PartialEq)]
pub struct ArgError(pub String);

impl std::fmt::Display for ArgError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// Tokeniza `args` (sem o nome do binário) em [`ParsedArgs`]. Suporta:
/// - `--flag valor` e `--flag=valor` (string), `--flag` (booleana se for booleana).
/// - `-h` como atalho de `--help`.
/// - posicionais (qualquer token que não começa com `-`).
///
/// **Não** valida contra a spec ainda — só estrutura. Flag desconhecida que pareça
/// string consome o próximo token; a rejeição vem em [`validate`] (mensagem clara).
pub fn parse_args(args: &[String]) -> Result<ParsedArgs, ArgError> {
    let mut parsed = ParsedArgs::default();
    let mut i = 0;
    while i < args.len() {
        let tok = &args[i];
        if let Some(rest) = tok.strip_prefix("--") {
            if rest.is_empty() {
                return Err(ArgError("flag vazia '--'".into()));
            }
            // `--flag=valor`
            if let Some(eq) = rest.find('=') {
                let (name, val) = rest.split_at(eq);
                let val = &val[1..];
                record_flag(&mut parsed, name, Some(val.to_string()));
                i += 1;
                continue;
            }
            // `--flag` (booleana) ou `--flag valor` (string)
            if is_boolean_flag(rest) {
                record_flag(&mut parsed, rest, None);
                i += 1;
            } else {
                // Precisa de valor; pega o próximo token (se houver e não for outra flag).
                let val = args.get(i + 1).filter(|n| !n.starts_with('-')).cloned();
                match val {
                    Some(v) => {
                        record_flag(&mut parsed, rest, Some(v));
                        i += 2;
                    }
                    None => {
                        // Sem valor → registra como booleana p/ a validação rejeitar com
                        // "flag desconhecida" se for o caso, ou "exige valor" se conhecida.
                        return Err(ArgError(format!("flag '--{rest}' exige um valor")));
                    }
                }
            }
        } else if tok == "-h" {
            parsed.wants_help = true;
            i += 1;
        } else if let Some(short) = tok.strip_prefix('-') {
            // Flags curtas além de -h não são suportadas no MVP.
            return Err(ArgError(format!("flag curta desconhecida '-{short}'")));
        } else {
            // Posicional. O 1º vira o comando; os demais são args do comando.
            if parsed.command.is_none() {
                parsed.command = Some(tok.clone());
            } else {
                parsed.positionals.push(tok.clone());
            }
            i += 1;
        }
    }
    Ok(parsed)
}

/// Registra uma flag em `parsed`, marcando os atalhos globais (`help`/`h`/`json`).
fn record_flag(parsed: &mut ParsedArgs, name: &str, value: Option<String>) {
    match name {
        "help" | "h" => parsed.wants_help = true,
        "json" => parsed.json = true,
        _ => {}
    }
    let v = match value {
        Some(s) => FlagValue::Str(s),
        None => FlagValue::Bool,
    };
    parsed.flags.push((name.to_string(), v));
}

/// Valida `parsed` contra a spec do comando: comando conhecido? flags todas permitidas
/// (globais ∪ específicas)? nº de posicionais bate? Roda ANTES de qualquer socket — um
/// typo vira erro claro, não timeout confuso (RE 05 §6.1). Retorna a spec resolvida.
pub fn validate(parsed: &ParsedArgs) -> Result<&'static CommandSpec, ArgError> {
    let Some(name) = parsed.command.as_deref() else {
        return Err(ArgError("nenhum comando informado".into()));
    };
    let spec = find_spec(name)
        .ok_or_else(|| ArgError(format!("comando desconhecido: '{name}'. Rode 'omnirift help'.")))?;

    // Flags: cada uma tem que ser global OU declarada na spec.
    for (flag, _) in &parsed.flags {
        let known = GLOBAL_FLAGS.contains(&flag.as_str())
            || spec.allowed_flags.contains(&flag.as_str());
        if !known {
            return Err(ArgError(format!(
                "flag desconhecida para '{name}': '--{flag}'. Uso: {}",
                spec.usage
            )));
        }
    }

    // Posicionais: exige ao menos os declarados. Sem `variadic_tail`, exige EXATAMENTE os
    // declarados (nem a mais); com `variadic_tail`, o último aceita 1+ tokens (ex.: texto
    // do `send` com espaços). Faltar qualquer um → erro nominal (qual falta).
    let need = spec.positionals.len();
    let got = parsed.positionals.len();
    if got < need {
        let missing = spec.positionals[got];
        return Err(ArgError(format!("falta o argumento <{missing}>. Uso: {}", spec.usage)));
    }
    if got > need && !spec.variadic_tail {
        return Err(ArgError(format!(
            "argumentos demais para '{name}' (esperado {need}). Uso: {}",
            spec.usage
        )));
    }

    Ok(spec)
}

/// Renderiza o help geral (lista de comandos) a partir das specs — mesma fonte da
/// validação (DRY). `help <cmd>` cai em [`render_command_help`].
pub fn render_help() -> String {
    let mut out = String::new();
    out.push_str("omnirift — CLI do OmniRift (pilota o app via socket RPC local)\n\n");
    out.push_str("USO:\n  omnirift <comando> [args] [--json]\n\nCOMANDOS:\n");
    let width = command_specs().iter().map(|s| s.name.len()).max().unwrap_or(0);
    for spec in command_specs() {
        out.push_str(&format!("  {:width$}  {}\n", spec.name, spec.summary, width = width));
    }
    out.push_str("\nFLAGS GLOBAIS:\n");
    out.push_str("  --json      Imprime a resposta JSON crua (em vez de texto humano).\n");
    out.push_str("  --help, -h  Mostra ajuda (deste comando, se houver um).\n");
    out.push_str("\nDescoberta: lê ~/.omnirift/runtime.json (escrito pelo app rodando).\n");
    out
}

/// Help de um comando específico (usage + exemplos), das specs.
pub fn render_command_help(spec: &CommandSpec) -> String {
    let mut out = String::new();
    out.push_str(&format!("{}\n\n", spec.summary));
    out.push_str(&format!("USO:\n  {}\n", spec.usage));
    if !spec.examples.is_empty() {
        out.push_str("\nEXEMPLOS:\n");
        for ex in spec.examples {
            out.push_str(&format!("  {ex}\n"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- parse de argv ---
    #[test]
    fn parse_command_and_positional() {
        let p = parse_args(&["snapshot".into(), "sess1".into()]).unwrap();
        assert_eq!(p.command.as_deref(), Some("snapshot"));
        assert_eq!(p.positionals, vec!["sess1".to_string()]);
    }

    #[test]
    fn parse_string_flag_space_form() {
        let p = parse_args(&["snapshot".into(), "s".into(), "--rows".into(), "40".into()]).unwrap();
        assert_eq!(p.flag_str("rows"), Some("40"));
    }

    #[test]
    fn parse_string_flag_eq_form() {
        let p = parse_args(&["snapshot".into(), "s".into(), "--rows=40".into()]).unwrap();
        assert_eq!(p.flag_str("rows"), Some("40"));
    }

    #[test]
    fn parse_bool_flag_json_sets_json() {
        let p = parse_args(&["status".into(), "--json".into()]).unwrap();
        assert!(p.json);
        assert!(p.has_flag("json"));
    }

    #[test]
    fn parse_short_help_sets_wants_help() {
        let p = parse_args(&["status".into(), "-h".into()]).unwrap();
        assert!(p.wants_help);
    }

    #[test]
    fn parse_long_help_sets_wants_help() {
        let p = parse_args(&["--help".into()]).unwrap();
        assert!(p.wants_help);
    }

    #[test]
    fn parse_value_flag_without_value_errors() {
        let err = parse_args(&["snapshot".into(), "s".into(), "--rows".into()]).unwrap_err();
        assert!(err.0.contains("rows"));
    }

    // --- validação contra a spec ---
    #[test]
    fn validate_unknown_command_rejected() {
        let p = parse_args(&["bogus".into()]).unwrap();
        let err = validate(&p).unwrap_err();
        assert!(err.0.contains("desconhecido"), "msg: {}", err.0);
    }

    #[test]
    fn validate_unknown_flag_rejected() {
        let p = parse_args(&["status".into(), "--nope".into(), "x".into()]).unwrap();
        let err = validate(&p).unwrap_err();
        assert!(err.0.contains("flag desconhecida"), "msg: {}", err.0);
    }

    #[test]
    fn validate_global_json_flag_allowed_everywhere() {
        let p = parse_args(&["status".into(), "--json".into()]).unwrap();
        assert!(validate(&p).is_ok());
    }

    #[test]
    fn validate_snapshot_rows_flag_allowed() {
        let p = parse_args(&["snapshot".into(), "s".into(), "--rows".into(), "40".into()]).unwrap();
        let spec = validate(&p).unwrap();
        assert_eq!(spec.name, "snapshot");
    }

    #[test]
    fn validate_missing_positional_rejected() {
        let p = parse_args(&["snapshot".into()]).unwrap();
        let err = validate(&p).unwrap_err();
        assert!(err.0.contains("sessionId"), "msg: {}", err.0);
    }

    #[test]
    fn validate_too_many_positionals_rejected() {
        let p = parse_args(&["status".into(), "extra".into()]).unwrap();
        let err = validate(&p).unwrap_err();
        assert!(err.0.contains("demais"), "msg: {}", err.0);
    }

    // --- render do help (das specs — DRY) ---
    #[test]
    fn help_lists_all_commands() {
        let h = render_help();
        for spec in command_specs() {
            assert!(h.contains(spec.name), "help deve listar '{}'", spec.name);
        }
        assert!(h.contains("--json"));
    }

    #[test]
    fn command_help_shows_usage_and_examples() {
        let spec = find_spec("snapshot").unwrap();
        let h = render_command_help(spec);
        assert!(h.contains(spec.usage));
        assert!(h.contains("--rows"));
    }

    // --- Fase 2: as 3 mutações existem e validam ---
    #[test]
    fn phase2_commands_have_specs() {
        for name in ["spawn", "send", "kill"] {
            assert!(find_spec(name).is_some(), "spec de '{name}' deve existir");
        }
    }

    #[test]
    fn help_lists_phase2_commands() {
        let h = render_help();
        for name in ["spawn", "send", "kill"] {
            assert!(h.contains(name), "help deve listar '{name}'");
        }
    }

    #[test]
    fn spawn_validates_with_command_and_flags() {
        let p = parse_args(&[
            "spawn".into(),
            "claude".into(),
            "--label".into(),
            "alpha".into(),
            "--cwd".into(),
            "/tmp".into(),
        ])
        .unwrap();
        let spec = validate(&p).unwrap();
        assert_eq!(spec.name, "spawn");
    }

    #[test]
    fn spawn_missing_command_rejected() {
        let p = parse_args(&["spawn".into()]).unwrap();
        let err = validate(&p).unwrap_err();
        assert!(err.0.contains("command"), "msg: {}", err.0);
    }

    #[test]
    fn spawn_rejects_unknown_flag() {
        let p = parse_args(&["spawn".into(), "bash".into(), "--nope".into(), "x".into()]).unwrap();
        let err = validate(&p).unwrap_err();
        assert!(err.0.contains("flag desconhecida"), "msg: {}", err.0);
    }

    // send: variádico — sessionId + 1+ tokens de texto.
    #[test]
    fn send_accepts_variadic_text() {
        let p = parse_args(&["send".into(), "s1".into(), "oi".into(), "tudo".into(), "bem".into()])
            .unwrap();
        let spec = validate(&p).unwrap();
        assert_eq!(spec.name, "send");
        assert!(spec.variadic_tail, "send é variádico");
        assert_eq!(p.positionals.len(), 4);
    }

    #[test]
    fn send_single_text_token_ok() {
        let p = parse_args(&["send".into(), "s1".into(), "/help".into()]).unwrap();
        assert!(validate(&p).is_ok());
    }

    #[test]
    fn send_missing_text_rejected() {
        // só sessionId, sem texto → falta <texto>.
        let p = parse_args(&["send".into(), "s1".into()]).unwrap();
        let err = validate(&p).unwrap_err();
        assert!(err.0.contains("texto"), "msg: {}", err.0);
    }

    #[test]
    fn send_missing_session_id_rejected() {
        let p = parse_args(&["send".into()]).unwrap();
        let err = validate(&p).unwrap_err();
        assert!(err.0.contains("sessionId"), "msg: {}", err.0);
    }

    // kill: exatamente <sessionId> (não-variádico).
    #[test]
    fn kill_validates_with_session_id() {
        let p = parse_args(&["kill".into(), "s1".into()]).unwrap();
        assert_eq!(validate(&p).unwrap().name, "kill");
    }

    #[test]
    fn kill_too_many_positionals_rejected() {
        let p = parse_args(&["kill".into(), "s1".into(), "extra".into()]).unwrap();
        let err = validate(&p).unwrap_err();
        assert!(err.0.contains("demais"), "msg: {}", err.0);
    }

    #[test]
    fn kill_missing_session_id_rejected() {
        let p = parse_args(&["kill".into()]).unwrap();
        let err = validate(&p).unwrap_err();
        assert!(err.0.contains("sessionId"), "msg: {}", err.0);
    }
}
