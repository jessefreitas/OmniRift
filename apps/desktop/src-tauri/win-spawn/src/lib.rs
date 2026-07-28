//! Helper compartilhado para spawnar no Windows programas que podem ser scripts,
//! shims ou executáveis sem extensão (por exemplo `.cmd`, `.ps1`, `npx`, `claude`).
//!
//! O problema: `CreateProcessW` só carrega imagens PE. Quando o npm instala o
//! `npx`/`claude` como um shim `.cmd`, executar `Command::new("npx")` diretamente
//! falha com "program not found" no Windows.
//!
//! O caminho de PTY resolve isso sozinho via `portable-pty`; este crate é o
//! equivalente para spawns assíncronos com `tokio::process::Command`.
//!
//! É um crate interno SEM dependências do Tauri: assim o binário de teste desta
//! lógica não linka o `tauri` e consegue rodar no Windows do CI, onde o test
//! runner do app principal morria com `STATUS_ENTRYPOINT_NOT_FOUND`.

use std::path::Path;

/// Como o programa foi resolvido no Windows — decide se dá pra spawnar direto ou se
/// o `cmd.exe` precisa entrar no meio.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolvedProgram {
    /// Imagem PE (`.exe`/`.com`) — o `CreateProcessW` executa direto, sem cmd.exe.
    Exe(String),
    /// Script (`.cmd`/`.bat`, o shim que o npm instala pro claude/codex/gemini) —
    /// só o cmd.exe sabe rodar.
    Script(String),
}

/// Resolve `command` pelo PATH + PATHEXT, do jeito que o próprio Windows resolveria.
///
/// Existe porque o `CreateProcessW` (usado pelo portable-pty) NÃO aplica PATHEXT: ele
/// só carrega imagens PE. Resolvendo aqui, o caso comum (`claude.exe`, `bash.exe`)
/// spawna DIRETO — sem cmd.exe no meio, e portanto sem nenhum problema de quoting de
/// cmd. Só o shim `.cmd` precisa do wrapper.
///
/// PURA (o `exists` é injetado) justamente pra rodar no Linux do CI — o `build_program`
/// do Windows nunca foi coberto por teste, e foi assim que a v0.1.141 shipou quebrada.
pub fn resolve_program_portable(
    command: &str,
    path_dirs: &[String],
    pathext: &[String],
    exists: &dyn Fn(&str) -> bool,
) -> Option<ResolvedProgram> {
    // `.exe`/`.com` são PE (spawn direto); o resto do PATHEXT (`.cmd`, `.bat`, …) é
    // script e obriga o cmd.exe. Case-insensitive porque o PATHEXT vem em MAIÚSCULAS
    // e o arquivo no disco costuma estar em minúsculas.
    let classify = |p: &str| {
        let lower = p.to_lowercase();
        if lower.ends_with(".exe") || lower.ends_with(".com") {
            ResolvedProgram::Exe(p.to_string())
        } else {
            ResolvedProgram::Script(p.to_string())
        }
    };

    let command_lower = command.to_lowercase();
    let ja_tem_ext = pathext
        .iter()
        .any(|ext| command_lower.ends_with(&ext.to_lowercase()));

    // Path explícito (o usuário apontou o binário): não varre o PATH, só resolve a
    // extensão. Um arquivo SEM extensão do PATHEXT devolve None de propósito — o
    // Windows não executa script extensionless nem direto nem via cmd, e fingir que
    // resolveu só empurraria a falha pro spawn.
    if command.contains('\\') || command.contains('/') {
        if ja_tem_ext && exists(command) {
            return Some(classify(command));
        }
        for ext in pathext {
            let candidato = format!("{command}{ext}");
            if exists(&candidato) {
                return Some(classify(&candidato));
            }
        }
        return None;
    }

    // Ordem que o Windows usa: diretório por fora, extensão por dentro — o 1º dir do
    // PATH vence mesmo que um dir posterior tenha uma extensão "melhor".
    for dir in path_dirs {
        if dir.is_empty() {
            continue;
        }
        let dir = dir.trim_end_matches(['\\', '/']);
        if ja_tem_ext {
            let candidato = format!("{dir}\\{command}");
            if exists(&candidato) {
                return Some(classify(&candidato));
            }
        }
        for ext in pathext {
            let candidato = format!("{dir}\\{command}{ext}");
            if exists(&candidato) {
                return Some(classify(&candidato));
            }
        }
    }
    None
}

/// Resolução real (com I/O), mas com os diretórios de busca injetados pelo chamador.
///
/// Antes este módulo chamava `crate::pty::session::effective_path_parts()` — isso é
/// acoplamento errado e impossível num crate separado. Quem conhece o PATH do filho
/// (por exemplo o `build_command` do app, que pode ter prependado o diretório dos
/// shims do `claude`) passa os diretórios aqui.
///
/// Lê o `PATHEXT` do ambiente, com fallback `.COM;.EXE;.BAT;.CMD`, e usa
/// `std::path::Path::is_file` como `exists`.
pub fn resolve_in_dirs(command: &str, path_dirs: &[String]) -> Option<ResolvedProgram> {
    let pathext_env =
        std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());
    let pathext: Vec<String> = pathext_env
        .split(';')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| {
            if s.starts_with('.') {
                s.to_string()
            } else {
                format!(".{s}")
            }
        })
        .collect();

    resolve_program_portable(command, path_dirs, &pathext, &|p: &str| {
        Path::new(p).is_file()
    })
}

/// Retorna `true` quando o comando precisa ser embrulhado pelo `cmd.exe` no
/// Windows. Regra: pega o basename, converte para minúsculas e, se não for
/// `cmd`/`cmd.exe`, retorna `true` quando o basename não terminar em `.exe`.
///
/// Disponível em ambos os sistemas operacionais para ser testada no CI.
pub fn needs_cmd_wrapper(command: &str) -> bool {
    let base = command
        .rsplit_once(&['\\', '/'])
        .map(|(_, b)| b)
        .unwrap_or(command)
        .to_lowercase();

    if base == "cmd" || base == "cmd.exe" {
        return false;
    }

    !base.ends_with(".exe")
}

/// Decide o argv final a partir de um programa JÁ resolvido (ou `None` se a resolução
/// falhou). Pura de propósito: roda no Linux do CI, que é onde os testes de verdade
/// acontecem — o caminho Windows nunca tinha cobertura e foi assim que a linha
/// pré-quotada sobreviveu tanto tempo.
///
/// - resolvido (`.exe` ou `.cmd`) → spawna direto, argumentos intactos. Quem cuida do
///   quoting é o `std` (que trata batch com as regras do cmd desde 1.77.2).
/// - não resolvido → `cmd.exe /d /c <programa> <args…>` com os tokens SEPARADOS.
///   Nunca uma linha única pré-quotada: essa é a forma que o cmd corrompe.
pub fn plan_windows_spawn(
    program: &str,
    args: &[String],
    resolved: Option<ResolvedProgram>,
    comspec: &str,
) -> (String, Vec<String>) {
    match resolved {
        Some(ResolvedProgram::Exe(p)) | Some(ResolvedProgram::Script(p)) => (p, args.to_vec()),
        None => {
            let mut argv: Vec<String> = vec!["/d".into(), "/c".into(), program.to_string()];
            argv.extend(args.iter().cloned());
            (comspec.to_string(), argv)
        }
    }
}

/// No Windows, resolve o programa de verdade em vez de embrulhar tudo em `cmd.exe`.
///
/// A versão anterior montava `cmd.exe /s /c "<linha pré-quotada>"` e entregava a linha
/// como UM argumento. Isso não tem conserto: o `std`/`tokio` aplica o quoting argv do
/// Windows nesse argumento e escapa cada `"` como `\"`; o `cmd` não trata `\` como
/// escape, então o que estivesse quotado chegava literalmente com as barras. No caminho
/// PTY esse mesmo defeito matava todo agente com `'\"claude\"' não é reconhecido`.
///
/// Agora: `resolve_in_dirs` acha o alvo pelos diretórios passados + PATHEXT e devolve
/// o caminho ABSOLUTO. Um `.exe` spawna direto. Um shim `.cmd`/`.bat` também pode ir
/// direto porque o `std` trata batch como caso especial e monta a linha com as regras
/// do `cmd` — é o endurecimento do Rust 1.77.2 (CVE-2024-24576).
///
/// Se a resolução falhar (PATH diferente, binário ausente), cai no `cmd.exe /d /c` com
/// os tokens SEPARADOS — nunca mais numa linha única pré-quotada. `/d` pula o AutoRun
/// do registro, que injetaria saída de terceiro no stdio do adapter.
///
/// Recebe os diretórios de busca do chamador, mantendo este crate desacoplado do app.
/// Fora do Windows continua sendo no-op.
pub fn wrap_for_windows(
    program: &str,
    args: &[String],
    #[cfg_attr(not(windows), allow(unused_variables))] path_dirs: &[String],
) -> (String, Vec<String>) {
    #[cfg(windows)]
    {
        if !needs_cmd_wrapper(program) {
            return (program.to_string(), args.to_vec());
        }
        let comspec = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string());
        plan_windows_spawn(program, args, resolve_in_dirs(program, path_dirs), &comspec)
    }
    #[cfg(not(windows))]
    {
        (program.to_string(), args.to_vec())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `npx` e `claude` são shims `.cmd` instalados pelo npm; sem wrapper o Windows
    /// dá "program not found" ao tentar spawnar diretamente.
    #[test]
    fn npx_e_claude_precisam_de_wrapper() {
        assert!(needs_cmd_wrapper("npx"));
        assert!(needs_cmd_wrapper("claude"));
    }

    /// Programas `.exe` devem ser executados diretamente, sem passar pelo cmd.
    #[test]
    fn exe_spawna_direto() {
        assert!(!needs_cmd_wrapper("powershell.exe"));
        assert!(!needs_cmd_wrapper("C:\\Windows\\System32\\cmd.exe"));
    }

    /// O próprio `cmd` (ou `cmd.exe`) nunca deve ser embrulhado nele mesmo.
    #[test]
    fn cmd_nao_embrulha_a_si_mesmo() {
        assert!(!needs_cmd_wrapper("cmd"));
        assert!(!needs_cmd_wrapper("cmd.exe"));
    }

    /// A verificação ignora o caminho e olha apenas para o basename do comando.
    #[test]
    fn basename_ignora_o_caminho() {
        assert!(needs_cmd_wrapper("C:/Users/x/AppData/Roaming/npm/npx"));
    }

    // trava a regressão de executáveis resolvidos voltarem a passar pelo cmd.exe
    #[test]
    fn exe_resolvido_spawna_direto_sem_cmd() {
        let (programa, args) = plan_windows_spawn(
            "npx",
            &["-y".into()],
            Some(ResolvedProgram::Exe(r"C:\Bin\npx.exe".into())),
            "cmd.exe",
        );
        assert_eq!(programa, r"C:\Bin\npx.exe");
        assert_eq!(args, vec!["-y".to_string()]);
        assert!(
            !std::iter::once(&programa)
                .chain(args.iter())
                .any(|s| s.contains("/c") || s.contains("/s")),
            "programa resolvido não deve passar por /c nem /s do cmd.exe"
        );
    }

    // trava shims .cmd voltarem a serem empacotados em cmd /c
    #[test]
    fn shim_cmd_tambem_vai_direto() {
        let (programa, args) = plan_windows_spawn(
            "claude",
            &["-y".into()],
            Some(ResolvedProgram::Script(r"C:\npm\claude.cmd".into())),
            "cmd.exe",
        );
        assert_eq!(programa, r"C:\npm\claude.cmd");
        assert_eq!(args, vec!["-y".to_string()]);
        assert!(
            !std::iter::once(&programa)
                .chain(args.iter())
                .any(|s| { s == "cmd.exe" || s.contains("/c") || s.contains("/s") }),
            "shim .cmd deve ser executado direto, sem cmd.exe /c no meio"
        );
    }

    // trava o fallback cmd /d /c de fundir programa e args numa linha só
    #[test]
    fn sem_resolucao_cai_em_tokens_separados() {
        let (programa, args) = plan_windows_spawn("claude", &["-y".into()], None, "cmd.exe");
        assert_eq!(programa, "cmd.exe");
        assert_eq!(
            args,
            vec![
                "/d".to_string(),
                "/c".to_string(),
                "claude".to_string(),
                "-y".to_string(),
            ]
        );
    }

    // trava a montagem da linha pre-quotada com escapes \" que o cmd.exe não entende
    #[test]
    fn nunca_monta_linha_unica_pre_quotada() {
        let arg_problema = r#"diz "oi" agora"#;

        let casos: Vec<(String, Option<ResolvedProgram>, &str)> = vec![
            (
                "npx".into(),
                Some(ResolvedProgram::Exe(r"C:\Bin\npx.exe".into())),
                "npx",
            ),
            (
                "claude".into(),
                Some(ResolvedProgram::Script(r"C:\npm\claude.cmd".into())),
                "claude",
            ),
            ("claude".into(), None, "claude"),
        ];

        for (programa, resolvido, programa_original) in casos {
            let (cmd, argv) =
                plan_windows_spawn(&programa, &[arg_problema.into()], resolvido, "cmd.exe");

            for token in std::iter::once(&cmd).chain(argv.iter()) {
                assert!(
                    !token.contains(r#"\""#),
                    "argv não deve conter \\\" — essa era a forma como a linha pré-quotada corrompia o cmd.exe"
                );
                assert!(
                    !(token.contains(programa_original) && token.contains(arg_problema)),
                    "nenhum token pode juntar o programa e um argumento (linha pré-quotada)"
                );
            }
        }
    }

    // trava a não-resolução do shim npm/claude.cmd por caso de extensão
    #[test]
    fn resolucao_acha_shim_do_npm() {
        let exists = |candidato: &str| candidato.eq_ignore_ascii_case(r"C:\npm\claude.cmd");

        let resultado = resolve_program_portable(
            "claude",
            &[r"C:\npm".into()],
            &[".EXE".into(), ".CMD".into()],
            &exists,
        );

        match resultado {
            Some(ResolvedProgram::Script(p)) => {
                assert!(
                    p.eq_ignore_ascii_case(r"C:\npm\claude.cmd"),
                    "deveria resolver o shim claude.cmd"
                );
            }
            _ => panic!("deveria ter resolvido o claude.cmd como Script"),
        }
    }
}

#[cfg(windows)]
mod integracao_windows {
    use super::*;

    // Guarda e restaura o PATH do processo para não sujar o ambiente de testes paralelos
    struct PathGuard {
        original: Option<String>,
    }

    impl PathGuard {
        fn new(extra_path: &str) -> Self {
            let original = std::env::var("PATH").ok();
            let mut new_path = String::from(extra_path);
            if let Some(ref orig) = original {
                new_path.push(';');
                new_path.push_str(orig);
            }
            std::env::set_var("PATH", &new_path);
            PathGuard { original }
        }
    }

    impl Drop for PathGuard {
        fn drop(&mut self) {
            if let Some(orig) = self.original.take() {
                std::env::set_var("PATH", orig);
            } else {
                std::env::remove_var("PATH");
            }
        }
    }

    // Trava a falha real: o agente morre no spawn porque o cmd.exe recebe o nome quotado como um só argumento e não resolve o PATHEXT
    #[test]
    fn wrap_for_windows_resolve_e_executa_cmd_de_verdade() {
        let pid = std::process::id();
        let probe_name = format!("omnirift_probe_{}", pid);
        let dir = std::env::temp_dir().join(format!("omnirift_test_{}", pid));
        std::fs::create_dir_all(&dir).unwrap();

        let cmd_path = dir.join(format!("{}.cmd", probe_name));
        let content = "@echo off\r\necho PROBE_OK %1\r\n";
        std::fs::write(&cmd_path, content).unwrap();

        let _guard = PathGuard::new(dir.to_str().unwrap());

        let path_dirs: Vec<String> = std::env::var("PATH")
            .unwrap_or_default()
            .split(';')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();

        let args = vec!["arg com espaço".to_string()];
        let (program, argv) = wrap_for_windows(&probe_name, &args, &path_dirs);

        assert!(
            program.ends_with(".cmd"),
            "O programa deve ser resolvido para .cmd pelo PATHEXT. Se falhar, o bug do spawn voltou."
        );

        for arg in &argv {
            assert!(
                !arg.contains("\\\""),
                "Nenhum argumento deve conter aspas escapadas. Se falhar, o bug do spawn voltou."
            );
        }

        let output = std::process::Command::new(&program)
            .args(&argv)
            .output()
            .unwrap();

        assert!(
            output.status.success(),
            "A execução do .cmd falhou. Se falhar, o bug do spawn voltou."
        );

        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(
            stdout.contains("PROBE_OK"),
            "O stdout não contém PROBE_OK. Se falhar, o bug do spawn voltou."
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    // Trava a falha real: o argumento com aspas e espaço era corrompido para \"oi\" ou quebrado em pedaços no caminho de spawn do Windows
    #[test]
    fn argumento_com_aspas_chega_intato_ao_programa() {
        let pid = std::process::id();
        let probe_name = format!("omnirift_probe_{}", pid);
        let dir = std::env::temp_dir().join(format!("omnirift_test_arg_{}", pid));
        std::fs::create_dir_all(&dir).unwrap();

        let cmd_path = dir.join(format!("{}.cmd", probe_name));
        // O cmd usa %~1 que remove as aspas externas recebidas pelo programa, revelando o conteúdo puro
        let content = "@echo off\r\necho ARG=[%~1]\r\n";
        std::fs::write(&cmd_path, content).unwrap();

        let _guard = PathGuard::new(dir.to_str().unwrap());

        let path_dirs: Vec<String> = std::env::var("PATH")
            .unwrap_or_default()
            .split(';')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();

        // Argumento com aspas e espaço, exatamente o dado que se corrompia
        let args = vec![r#"diz "oi" agora"#.to_string()];
        let (program, argv) = wrap_for_windows(&probe_name, &args, &path_dirs);

        let output = std::process::Command::new(&program)
            .args(&argv)
            .output()
            .unwrap();

        assert!(
            output.status.success(),
            "A execução do .cmd falhou. Se falhar, o bug do spawn voltou."
        );

        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(
            stdout.contains("oi"),
            "O argumento com aspas não chegou intacto ao programa. Se falhar, o bug do spawn voltou."
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
