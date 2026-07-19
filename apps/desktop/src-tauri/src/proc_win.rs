//! Helper compartilhado para spawnar no Windows programas que podem ser scripts,
//! shims ou executáveis sem extensão (por exemplo `.cmd`, `.ps1`, `npx`, `claude`).
//!
//! O problema: `CreateProcessW` só carrega imagens PE. Quando o npm instala o
//! `npx`/`claude` como um shim `.cmd`, executar `Command::new("npx")` diretamente
//! falha com "program not found" no Windows.
//!
//! O caminho de PTY resolve isso sozinho via `portable-pty`; este módulo é o
//! equivalente para spawns assíncronos com `tokio::process::Command`.

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

/// Aplica o quoting de argv do Windows (regras do `CommandLineToArgvW`/MSVCRT).
///
/// Se o argumento não for vazio e não contiver espaço, tab, nova linha,
/// `\x0b` nem aspas, é devolvido sem alteração. Caso contrário, é envolvido em
/// aspas e as barras invertidas que precedem uma aspas ou o fim da string são
/// dobradas; as próprias aspas são escapadas com `\`.
pub fn win_argv_quote(arg: &str) -> String {
    let precisa_quote = arg.is_empty()
        || arg
            .chars()
            .any(|c| c == ' ' || c == '\t' || c == '\n' || c == '\x0b' || c == '"');

    if !precisa_quote {
        return arg.to_string();
    }

    let chars: Vec<char> = arg.chars().collect();
    let mut out = String::with_capacity(arg.len() + 2);
    out.push('"');

    let mut i = 0;
    while i < chars.len() {
        let mut barras = 0usize;
        while i < chars.len() && chars[i] == '\\' {
            barras += 1;
            i += 1;
        }

        if i == chars.len() {
            // barras invertidas no final, dentro das aspas, devem ser dobradas
            for _ in 0..barras * 2 {
                out.push('\\');
            }
            break;
        }

        if chars[i] == '"' {
            // barras invertidas antes de uma aspas devem ser dobradas;
            // a aspas em si é escapada
            for _ in 0..barras * 2 {
                out.push('\\');
            }
            out.push('\\');
            out.push('"');
            i += 1;
        } else {
            for _ in 0..barras {
                out.push('\\');
            }
            out.push(chars[i]);
            i += 1;
        }
    }

    out.push('"');
    out
}

/// No Windows, encapsula o programa em `cmd.exe /s /c "<linha única>"` quando
/// ele não for um `.exe` nem o próprio `cmd`, permitindo rodar shims `.cmd` e
/// scripts. Fora do Windows é um no-op.
///
/// Usamos `/s` com a linha de comando já envolvida em aspas: o `cmd` remove a
/// primeira e a última aspas exatamente e reprocessa o miolo, mantendo o
/// escaping calculado por `win_argv_quote`.
pub fn wrap_for_windows(program: &str, args: &[String]) -> (String, Vec<String>) {
    #[cfg(windows)]
    {
        if needs_cmd_wrapper(program) {
            let linha = std::iter::once(win_argv_quote(program))
                .chain(args.iter().map(|a| win_argv_quote(a)))
                .collect::<Vec<_>>()
                .join(" ");

            let shell = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string());

            (shell, vec!["/s".into(), "/c".into(), linha])
        } else {
            (program.to_string(), args.to_vec())
        }
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

    /// Argumentos simples sem caracteres especiais devem permanecer intocados.
    #[test]
    fn quote_deixa_simples_intacto() {
        assert_eq!(win_argv_quote("-y"), "-y");
    }

    /// Argumentos com espaço precisam de aspas; aspas internas precisam ser
    /// escapadas com barra invertida.
    #[test]
    fn quote_protege_espaco_e_aspas() {
        let com_espaco = win_argv_quote("a b");
        assert!(com_espaco.starts_with('"') && com_espaco.ends_with('"'));

        let com_aspas = win_argv_quote("di\"z");
        assert!(com_aspas.contains("\\\"")); // barra + aspas escapada
    }
}
