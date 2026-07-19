use std::env;
use std::path::Path;

/// Perfil de contenção para execução de subprocessos.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SandboxProfile {
    /// Sem sandbox.
    Off,
    /// Workspace isolado com acesso ao diretório de trabalho.
    Workspace,
}

/// Lê `OMNIRIFT_SANDBOX`; `"workspace"` ativa o modo Workspace, qualquer outro valor (ou ausência) mantém Off.
pub fn profile_from_env() -> SandboxProfile {
    match env::var("OMNIRIFT_SANDBOX").as_deref() {
        Ok("workspace") => SandboxProfile::Workspace,
        _ => SandboxProfile::Off,
    }
}

/// Verifica se existe um executável `bwrap` em algum diretório do `$PATH`.
pub fn bwrap_available() -> bool {
    env::var("PATH")
        .unwrap_or_default()
        .split(':')
        .map(|dir| Path::new(dir).join("bwrap"))
        .any(|p| p.is_file())
}

/// Envelopa o comando com `bwrap` quando o perfil Workspace está ativo e local;
/// caso contrário, retorna `(program, args)` intacto (fail-open).
pub fn maybe_wrap(
    program: String,
    args: Vec<String>,
    cwd: Option<&str>,
    is_remote: bool,
) -> (String, Vec<String>) {
    if is_remote
        || profile_from_env() != SandboxProfile::Workspace
        || !bwrap_available()
    {
        return (program, args);
    }

    let mut argv = build_bwrap_argv(&program, &args, cwd);
    if argv.is_empty() {
        return (program, args);
    }

    let wrapped_program = argv.remove(0);
    (wrapped_program, argv)
}

/// Constrói o argv completo do `bwrap` para o perfil Workspace.
pub fn build_bwrap_argv(program: &str, args: &[String], workspace: Option<&str>) -> Vec<String> {
    let mut argv = vec![String::from("bwrap")];

    // Raiz read-only + dispositivos, proc e tmp read-write.
    argv.extend_from_slice(&[
        String::from("--ro-bind"), String::from("/"), String::from("/"),
        String::from("--dev-bind"), String::from("/dev"), String::from("/dev"),
        String::from("--proc"), String::from("/proc"),
        String::from("--bind"), String::from("/tmp"), String::from("/tmp"),
    ]);

    // Workspace do projeto com permissão de escrita.
    if let Some(ws) = workspace {
        argv.push(String::from("--bind"));
        argv.push(ws.to_string());
        argv.push(ws.to_string());
    }

    // Pastas essenciais do usuário para cache, npm, cargo, config e runtime do app.
    if let Ok(home) = env::var("HOME") {
        if !home.is_empty() {
            for dir in [".omnirift", ".cache", ".npm", ".cargo", ".config"] {
                let p = format!("{}/{}", home, dir);
                argv.push(String::from("--bind-try"));
                argv.push(p.clone());
                argv.push(p);
            }

            // Os tmpfs vêm DEPOIS dos binds acima porque ~/.config/gh mora
            // dentro do ~/.config recém-montado read-write.
            for secret in [".ssh", ".aws", ".gnupg", ".config/gh"] {
                argv.push(String::from("--tmpfs"));
                argv.push(format!("{}/{}", home, secret));
            }

            // ~/.claude é caso especial: guarda a credencial JUNTO com
            // settings.json e mcp.json que o agente precisa pra subir, então
            // tmpfs no diretório inteiro mataria a auth e o MCP de todo
            // agente Claude — por isso monta read-only e mascara só o arquivo.
            let claude_dir = format!("{}/.claude", home);
            argv.push(String::from("--ro-bind-try"));
            argv.push(claude_dir.clone());
            argv.push(claude_dir);

            // Arquivo solto não aceita tmpfs (bwrap só monta tmpfs em
            // diretório), então mascara com /dev/null; sem isso a raiz
            // --ro-bind entrega o arquivo.
            for file in [".claude/.credentials.json", ".git-credentials"] {
                argv.push(String::from("--ro-bind-try"));
                argv.push(String::from("/dev/null"));
                argv.push(format!("{}/{}", home, file));
            }
        }
    }

    argv.push(String::from("--die-with-parent"));
    argv.push(String::from("--"));
    argv.push(program.to_string());
    argv.extend(args.iter().cloned());

    argv
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_bwrap_argv_monta_estrutura_correta() {
        let program = "git";
        let args = vec![
            String::from("clone"),
            String::from("https://repo"),
        ];
        let workspace = Some("/repo/workspace");
        let argv = build_bwrap_argv(program, &args, workspace);

        assert_eq!(argv[0], "bwrap", "argv deve começar com bwrap");

        let ro_bind = vec![
            String::from("--ro-bind"),
            String::from("/"),
            String::from("/"),
        ];
        assert!(
            argv.windows(3).any(|w| w == ro_bind),
            "deve conter --ro-bind / /"
        );

        if let Ok(home) = std::env::var("HOME") {
            if !home.is_empty() {
                let ssh_tmpfs = vec![
                    String::from("--tmpfs"),
                    format!("{}/.ssh", home),
                ];
                assert!(
                    argv.windows(2).any(|w| w == ssh_tmpfs),
                    "deve esconder ~/.ssh com tmpfs vazio"
                );
            }
        }

        assert!(
            argv.contains(&workspace.unwrap().to_string()),
            "deve conter o workspace passado"
        );

        let separator_pos = argv
            .windows(2)
            .position(|w| w == [String::from("--"), String::from(program)])
            .expect("deve conter '-- <program>' separando flags do comando");

        assert_eq!(
            &argv[separator_pos..],
            &[
                String::from("--"),
                String::from(program),
                String::from("clone"),
                String::from("https://repo"),
            ][..],
            "final deve ser --, programa e args na ordem"
        );
    }

    #[test]
    fn build_bwrap_argv_oculta_todos_os_caminhos_de_credencial() {
        let home = match std::env::var("HOME") {
            Ok(v) if !v.is_empty() => v,
            _ => return,
        };

        let argv = build_bwrap_argv("claude", &[], Some("/repo"));

        for dir in [".ssh", ".aws", ".gnupg", ".config/gh"] {
            let esperado = vec![String::from("--tmpfs"), format!("{}/{}", home, dir)];
            assert!(
                argv.windows(2).any(|w| w == esperado),
                "o argv deveria conter '--tmpfs {0}/{1}' para ocultar credenciais: a raiz é --ro-bind, então sem tmpfs o agente lê o segredo em {0}/{1}",
                home, dir
            );
        }

        // ~/.claude não pode virar tmpfs (levaria junto settings.json/mcp.json e o
        // agente não sobe): monta read-only e mascara só o arquivo de credencial.
        for arquivo in [".claude/.credentials.json", ".git-credentials"] {
            let esperado_arquivo = vec![
                String::from("--ro-bind-try"),
                String::from("/dev/null"),
                format!("{}/{}", home, arquivo),
            ];
            assert!(
                argv.windows(3).any(|w| w == esperado_arquivo),
                "o argv deveria mascarar {}/{} com /dev/null via --ro-bind-try (arquivo solto não aceita tmpfs)",
                home, arquivo
            );
        }
    }

    #[test]
    fn build_bwrap_argv_oculta_gh_depois_de_montar_config() {
        let home = match std::env::var("HOME") {
            Ok(v) if !v.is_empty() => v,
            _ => return,
        };

        let argv = build_bwrap_argv("claude", &[], Some("/repo"));

        let config = format!("{}/.config", home);
        let config_gh = format!("{}/.config/gh", home);

        let pos_config = argv
            .iter()
            .position(|x| x == &config)
            .expect("esperava encontrar o bind/montagem de ~/.config no argv");

        let pos_gh = argv
            .iter()
            .position(|x| x == &config_gh)
            .expect("esperava encontrar --tmpfs de ~/.config/gh no argv");

        assert!(
            pos_gh > pos_config,
            "bwrap aplica operações em ordem; um bind de ~/.config depois do tmpfs de ~/.config/gh faria o token do gh reaparecer"
        );
    }

    #[test]
    fn build_bwrap_argv_sem_workspace_nao_insere_bind() {
        let argv = build_bwrap_argv("cmd", &[], None);
        let workspace_bind = vec![
            String::from("--bind"),
            String::from("/ws"),
            String::from("/ws"),
        ];
        assert!(
            !argv.windows(3).any(|w| w == workspace_bind),
            "sem workspace não deve inserir bind de workspace"
        );
    }

    #[test]
    fn maybe_wrap_remoto_retorna_intacto() {
        let program = String::from("git");
        let args = vec![String::from("pull")];
        let (p, a) = maybe_wrap(program.clone(), args.clone(), Some("/ws"), true);

        assert_eq!(p, program, "programa remoto não deve ser alterado");
        assert_eq!(a, args, "args remotos não devem ser alterados");
    }
}