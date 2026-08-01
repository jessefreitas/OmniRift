//! Gate de feature flags do OmniRift.
//!
//! Mantém um espelho em disco das flags da UI (`~/.omnirift/flags/<nome>`) para
//! que serviços de rede não subam antes do frontend existir — e nem ignorem
//! o estado desligado de flags ainda em construção.

use std::{env, fs, io, path::PathBuf};

/// Onde o espelho das flags mora: `~/.omnirift/flags/<nome>`. Arquivo presente = ligada.
pub fn flags_dir() -> Option<PathBuf> {
    env::var("HOME")
        .ok()
        .map(|home| PathBuf::from(home).join(".omnirift").join("flags"))
}

/// Nome de flag seguro pra virar nome de arquivo: só kebab-case ASCII.
///
/// O nome chega do frontend por comando Tauri; sem isto um `../` escreveria fora do
/// diretório de flags. Mesma defesa aplicada ao id de sessão no spill do PTY.
fn nome_valido(nome: &str) -> bool {
    !nome.is_empty()
        && nome.len() <= 64
        && nome
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// Converte `kebab-case` -> `SCREAMING_SNAKE_CASE`.
fn kebab_to_screaming_snake(nome: &str) -> String {
    nome.to_ascii_uppercase().replace('-', "_")
}

/// Nome da variável de ambiente que espelha a flag.
fn env_var_name(nome: &str) -> String {
    format!("OMNIRIFT_FLAG_{}", kebab_to_screaming_snake(nome))
}

/// `true` se a flag estiver ligada no espelho de disco ou via env.
///
/// A env `OMNIRIFT_FLAG_<NOME_EM_MAIUSCULAS_COM_UNDERSCORE>` vence com valores
/// `1` ou `true` (case-insensitive). Se `HOME` não estiver disponível, só a env
/// decide.
pub fn flag_ativa(nome: &str) -> bool {
    if !nome_valido(nome) {
        return false;
    }
    if let Ok(valor) = env::var(env_var_name(nome)) {
        if valor.eq_ignore_ascii_case("1") || valor.eq_ignore_ascii_case("true") {
            return true;
        }
    }

    if let Some(dir) = flags_dir() {
        return dir.join(nome).exists();
    }

    false
}

/// Persiste (ou remove) a flag no espelho de disco.
///
/// * `ativa = true`  → cria o diretório e um arquivo vazio.
/// * `ativa = false` → remove o arquivo; ausência do arquivo não é erro.
pub fn set_flag(nome: &str, ativa: bool) -> io::Result<()> {
    if !nome_valido(nome) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "nome de flag inválido (use kebab-case ascii)",
        ));
    }
    let Some(dir) = flags_dir() else {
        // Sem HOME não dá para criar arquivo, mas desligar não precisa de nada.
        return if ativa {
            Err(io::Error::new(
                io::ErrorKind::NotFound,
                "HOME indisponível para espelhar flag em disco",
            ))
        } else {
            Ok(())
        };
    };

    let path = dir.join(nome);

    if ativa {
        fs::create_dir_all(&dir)?;
        fs::File::create(&path)?;
        Ok(())
    } else {
        let _ = fs::remove_file(&path);
        Ok(())
    }
}

/// O servidor LAN só faz sentido se há a quem servir. Sem device pareado, não abre porta.
pub fn deve_subir_relay_lan(devices_pareados: usize, flag_forcada: bool) -> bool {
    devices_pareados > 0 || flag_forcada
}

/// Dialers 4G exigem a flag explicita — e alguém pareado pra discar por.
pub fn deve_discar_relay_4g(devices_pareados: usize, flag_4g: bool) -> bool {
    flag_4g && devices_pareados > 0
}

/// Roteador local só sobe com a flag ligada.
pub fn deve_subir_omniswitch(flag_omniswitch: bool) -> bool {
    flag_omniswitch
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    // -----------------------------------------------------------------------
    // Parse do nome da env
    // -----------------------------------------------------------------------

    #[test]
    fn kebab_remote_4g_relay_vira_screaming_snake() {
        // Trava o bug: dialer 4G ignorava a flag porque a env era montada errada.
        assert_eq!(
            env_var_name("remote-4g-relay"),
            "OMNIRIFT_FLAG_REMOTE_4G_RELAY"
        );
    }

    #[test]
    fn kebab_omniswitch_vira_screaming_snake() {
        // Trava o bug: OmniSwitch subia porque nunca achava a variável correta.
        assert_eq!(env_var_name("omniswitch"), "OMNIRIFT_FLAG_OMNISWITCH");
    }

    // -----------------------------------------------------------------------
    // Leitura de flag via env
    // -----------------------------------------------------------------------

    #[test]
    fn env_ligada_com_valor_1_ativa_mesmo_sem_arquivo() {
        // Trava o bug: backend não considerava override de ambiente da UI/CI.
        env::set_var("OMNIRIFT_FLAG_TESTE_ENV_1_ATIVA", "1");
        assert!(flag_ativa("teste-env-1-ativa"));
    }

    #[test]
    fn env_ligada_case_insensitive_ativa() {
        // Trava o bug: comparação da env era case-sensitive e rejeitava "True".
        env::set_var("OMNIRIFT_FLAG_TESTE_ENV_TRUE_ATIVA", "TrUe");
        assert!(flag_ativa("teste-env-true-ativa"));
    }

    #[test]
    fn env_desligada_com_valor_0_nao_ativa() {
        // Trava o bug: qualquer valor não-vazio na env era tratado como ligado.
        env::set_var("OMNIRIFT_FLAG_TESTE_ENV_0_DESLIGADA", "0");
        assert!(!flag_ativa("teste-env-0-desligada"));
    }

    // -----------------------------------------------------------------------
    // Persistência em disco
    // -----------------------------------------------------------------------

    #[test]
    fn set_flag_true_cria_arquivo_vazio_e_ativa() {
        // Trava o bug: UI ligava a flag mas o backend não espelhava em disco.
        let nome = "teste-gate-set-true-xyz";
        set_flag(nome, true).expect("deve criar arquivo vazio");
        assert!(flag_ativa(nome));
        if let Some(dir) = flags_dir() {
            let _ = fs::remove_file(dir.join(nome));
        }
    }

    #[test]
    fn set_flag_false_em_arquivo_inexistente_nao_falha() {
        // Trava o bug: remover flag inexistente propagava erro e quebrava o boot.
        let res = set_flag("teste-gate-nao-existe-abc", false);
        assert!(res.is_ok());
    }

    // -----------------------------------------------------------------------
    // Decisões de boot (funções puras)
    // -----------------------------------------------------------------------

    #[test]
    fn relay_lan_somente_com_device_ou_flag_forcada() {
        // Trava o bug: WebSocket bindava [IP_1]:6768 sem nenhum celular pareado.
        let casos = [
            (0_usize, false, false), // desligado: sem device, sem flag
            (0, true, true),         // flag de debug/forçado liga
            (1, false, true),        // um device já basta
            (3, true, true),         // ambos ligados
        ];
        for (devices, flag, esperado) in casos {
            assert_eq!(
                deve_subir_relay_lan(devices, flag),
                esperado,
                "LAN: devices={devices}, flag={flag}"
            );
        }
    }

    #[test]
    fn relay_4g_so_sobe_com_flag_e_device_pareado() {
        // Trava o bug: dialers discavam o Worker mesmo com "remote-4g-relay" desligada.
        let casos = [
            (0_usize, false, false), // tudo desligado
            (0, true, false),        // flag sem device não disca
            (1, false, false),       // device sem flag não disca
            (2, true, true),         // ambos ligados
        ];
        for (devices, flag, esperado) in casos {
            assert_eq!(
                deve_discar_relay_4g(devices, flag),
                esperado,
                "4G: devices={devices}, flag={flag}"
            );
        }
    }

    #[test]
    fn omniswitch_so_sobe_com_flag() {
        // Trava o bug: roteador OmniSwitch subia mesmo com a flag omniswitch desligada.
        assert!(!deve_subir_omniswitch(false));
        assert!(deve_subir_omniswitch(true));
    }

    /// Trava o defeito exato da auditoria: os gates existirem e ninguém os consultar.
    /// Serviço de rede que sobe com a flag desligada é quebra de contrato de configuração
    /// — e foi o estado do relay 4G e do OmniSwitch até aqui.
    #[test]
    fn os_gates_estao_fiados_no_boot() {
        let relay = include_str!("mod.rs");
        let lib = include_str!("../lib.rs");
        assert!(
            relay.contains("deve_subir_relay_lan"),
            "rpc/mod.rs parou de gatear o servidor LAN — volta a bindar 0.0.0.0 sem device pareado"
        );
        assert!(
            relay.contains("deve_discar_relay_4g"),
            "rpc/mod.rs parou de gatear os dialers 4G — volta a discar o Worker com a flag off"
        );
        assert!(
            lib.contains("gate::flag_ativa(\"omniswitch\")"),
            "lib.rs parou de gatear o OmniSwitch — volta a subir servidor com a flag off"
        );
    }

    /// Trava a REGRESSÃO que o gate acima causou: sem device pareado o servidor LAN
    /// não sobe no boot (certo), mas o PRIMEIRO pareamento depende dele. Se o fluxo
    /// de pareamento deixar de subir o servidor sob demanda, parear numa instalação
    /// limpa volta a ser impossível — e a mensagem de erro ("tente em instantes")
    /// nunca deixa de valer, o que esconde o defeito.
    #[test]
    fn pareamento_sobe_o_servidor_sob_demanda() {
        let mod_rs = include_str!("mod.rs");
        assert!(
            mod_rs.contains("pub fn ensure_lan_server"),
            "rpc/mod.rs perdeu ensure_lan_server — o primeiro pareamento fica sem servidor"
        );
        let offer = mod_rs
            .split("pub fn mobile_pairing_offer")
            .nth(1)
            .unwrap_or("");
        assert!(
            offer.contains("ensure_lan_server"),
            "mobile_pairing_offer parou de garantir o servidor — instalação limpa não pareia mais"
        );
    }
}
