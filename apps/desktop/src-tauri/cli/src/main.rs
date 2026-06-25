//! `omnirift` — CLI fina do OmniRift (ref #8B). Pilota o app rodando via socket RPC
//! local (#8A). Trilogia DRY (RE 05): **specs** (help+validação declarativos) →
//! **handlers** (puros: monta params, formata) → **client** (descoberta via
//! runtime.json + socket Unix one-shot).
//!
//! Fluxo (espelha `cli/index.ts` do ref, §5.1):
//!   parse argv → help? imprime e sai → valida (comando/flag/posicionais) ANTES do
//!   socket → monta params → client::call → formata (`--json` cru ou humano).
//!
//! Códigos de saída: 0 sucesso · 1 erro de runtime (app off / socket / método) ·
//! 2 erro de uso (argv inválido). Erros vão pro stderr; resultado pro stdout.

mod client;
mod handlers;
mod specs;

use std::process::ExitCode;

fn main() -> ExitCode {
    // argv sem o nome do binário.
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(&args) {
        Ok(out) => {
            if !out.is_empty() {
                println!("{out}");
            }
            ExitCode::SUCCESS
        }
        Err(Exit::Usage(msg)) => {
            eprintln!("erro: {msg}");
            eprintln!("rode 'omnirift help' para ver os comandos.");
            ExitCode::from(2)
        }
        Err(Exit::Runtime(msg)) => {
            eprintln!("erro: {msg}");
            ExitCode::from(1)
        }
    }
}

/// Erro de saída do CLI: `Usage` (argv ruim, exit 2) vs `Runtime` (app/socket/método,
/// exit 1). Separar os dois deixa scripts discriminarem "eu chamei errado" de "o app
/// falhou". `Debug` p/ os testes (`unwrap_err`).
#[derive(Debug)]
enum Exit {
    Usage(String),
    Runtime(String),
}

/// Núcleo testável do CLI: argv → string a imprimir (ou erro). Não faz IO de stdout/
/// process::exit — o `main` cuida disso. Toca o socket só no caminho de comando real
/// (depois de validar tudo).
fn run(args: &[String]) -> Result<String, Exit> {
    // Sem args, ou `help`/`--help` na frente → help geral.
    if args.is_empty() {
        return Ok(specs::render_help());
    }
    if args[0] == "help" {
        // `help [comando]` → help específico se houver um comando válido a seguir.
        if let Some(name) = args.get(1) {
            return match specs::find_spec(name) {
                Some(spec) => Ok(specs::render_command_help(spec)),
                None => Err(Exit::Usage(format!("comando desconhecido: '{name}'"))),
            };
        }
        return Ok(specs::render_help());
    }

    let parsed = specs::parse_args(args).map_err(|e| Exit::Usage(e.to_string()))?;

    // `--help`/`-h` em qualquer posição → help (do comando, se houver um conhecido).
    if parsed.wants_help {
        if let Some(cmd) = parsed.command.as_deref() {
            if let Some(spec) = specs::find_spec(cmd) {
                return Ok(specs::render_command_help(spec));
            }
        }
        return Ok(specs::render_help());
    }

    // Valida comando/flags/posicionais ANTES de tocar no socket (RE 05 §6.1).
    let spec = specs::validate(&parsed).map_err(|e| Exit::Usage(e.to_string()))?;

    // Monta a chamada (params das flags) — erro aqui ainda é de uso.
    let plan = handlers::build_call(spec.name, &parsed).map_err(|e| Exit::Usage(e.to_string()))?;

    // Agora sim: descobre o app + chama o socket. Erros aqui são de runtime.
    let result = client::call(plan.method, plan.params).map_err(|e| Exit::Runtime(e.to_string()))?;

    Ok(handlers::format_result(spec.name, &result, parsed.json))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(tokens: &[&str]) -> Vec<String> {
        tokens.iter().map(|s| s.to_string()).collect()
    }

    // --- help: das specs, sem socket ---
    #[test]
    fn no_args_prints_general_help() {
        let out = run(&[]).unwrap();
        assert!(out.contains("COMANDOS"));
        assert!(out.contains("status"));
        assert!(out.contains("snapshot"));
    }

    #[test]
    fn help_command_prints_general_help() {
        let out = run(&argv(&["help"])).unwrap();
        assert!(out.contains("COMANDOS"));
    }

    #[test]
    fn help_with_command_prints_command_help() {
        let out = run(&argv(&["help", "snapshot"])).unwrap();
        assert!(out.contains("snapshot <sessionId>"));
        assert!(out.contains("--rows"));
    }

    #[test]
    fn help_flag_on_command_prints_command_help() {
        let out = run(&argv(&["snapshot", "--help"])).unwrap();
        assert!(out.contains("snapshot <sessionId>"));
    }

    #[test]
    fn short_help_flag_works() {
        let out = run(&argv(&["status", "-h"])).unwrap();
        // help de comando do status (usage), sem tocar socket.
        assert!(out.contains("omnirift status"));
    }

    // --- validação ANTES do socket: erro de uso, não de runtime ---
    #[test]
    fn unknown_command_is_usage_error_not_runtime() {
        let err = run(&argv(&["frobnicate"])).unwrap_err();
        match err {
            Exit::Usage(m) => assert!(m.contains("desconhecido")),
            Exit::Runtime(_) => panic!("typo de comando NÃO pode virar erro de runtime/socket"),
        }
    }

    #[test]
    fn unknown_flag_is_usage_error() {
        let err = run(&argv(&["status", "--bogus", "x"])).unwrap_err();
        assert!(matches!(err, Exit::Usage(_)));
    }

    #[test]
    fn missing_positional_is_usage_error() {
        let err = run(&argv(&["snapshot"])).unwrap_err();
        match err {
            Exit::Usage(m) => assert!(m.contains("sessionId")),
            _ => panic!("faltar posicional é erro de uso"),
        }
    }

    #[test]
    fn bad_rows_value_is_usage_error_before_socket() {
        let err = run(&argv(&["snapshot", "s", "--rows", "abc"])).unwrap_err();
        match err {
            Exit::Usage(m) => assert!(m.contains("inteiro")),
            Exit::Runtime(_) => panic!("--rows inválido deve falhar antes do socket"),
        }
    }

    // Comando válido SEM app rodando → erro de runtime (não de uso). Garante que a
    // descoberta corre só depois da validação. Usa HOME isolado p/ não achar um
    // runtime.json real da máquina.
    #[test]
    fn valid_command_without_app_is_runtime_error() {
        let tmp = std::env::temp_dir().join(format!("omnirift-cli-nohome-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        // Isola HOME/USERPROFILE → não há runtime.json → NotRunning.
        let prev_home = std::env::var("HOME").ok();
        let prev_profile = std::env::var("USERPROFILE").ok();
        std::env::set_var("HOME", &tmp);
        std::env::set_var("USERPROFILE", &tmp);

        let err = run(&argv(&["status"])).unwrap_err();

        // restaura
        match prev_home {
            Some(h) => std::env::set_var("HOME", h),
            None => std::env::remove_var("HOME"),
        }
        match prev_profile {
            Some(p) => std::env::set_var("USERPROFILE", p),
            None => std::env::remove_var("USERPROFILE"),
        }
        let _ = std::fs::remove_dir_all(&tmp);

        match err {
            Exit::Runtime(m) => assert!(
                m.contains("não está rodando") || m.contains("named-pipe"),
                "msg: {m}"
            ),
            Exit::Usage(m) => panic!("status válido sem app = runtime, não usage: {m}"),
        }
    }
}
