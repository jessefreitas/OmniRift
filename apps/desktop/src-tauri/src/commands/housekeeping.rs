//! Housekeeping do diretório de dados do OmniRift.
//!
//! Problema real (v1.6.x, máquina do usuário): o diretório de dados acumulava artefatos
//! regeráveis (`agent-settings-<slug>.json`, `agent-hook-<slug>.curl`,
//! `agent-mcp-<hash>.json`, `agent-prompt-<id>.txt`, `agent-cmd-<id>.cmd`) de agentes
//! que não existem mais — chegamos a contar 17 arquivos `agent-settings-*` de junho.
//! Todos esses arquivos são regravados a cada spawn, então apagar o antigo é seguro.
//!
//! Outro problema: `local-review.py` é extraído do binário e só reescrito no boot do app.
//! Usuário rodou dias com versão antiga porque o hook não reporta qual script está usando.
//! Por isso este módulo NUNCA deve tocar em `local-review.py` nem em `review-config.json`.

use serde_json::json;
use std::fs;
use std::path::Path;
use std::time::SystemTime;

/// Prefixos de artefatos que o próprio agente regrava a cada spawn.
/// Qualquer arquivo que case aqui é candidato à remoção se estiver velho o bastante.
const PREFIXOS_REGERAVEIS: &[&str] = &[
    "agent-settings-",
    "agent-hook-",
    "agent-mcp-",
    "agent-prompt-",
    "agent-cmd-",
];

/// Decide se um artefato do diretório de dados pode ser removido.
/// PURA (sem I/O) pra rodar no CI: recebe nome e idade em dias.
pub fn deve_remover(nome: &str, idade_dias: u64, teto_dias: u64) -> bool {
    let eh_regeravel = PREFIXOS_REGERAVEIS
        .iter()
        .any(|prefixo| nome.starts_with(prefixo));
    // Importante: `agent-mcp.json` (sem hash) não casa com `agent-mcp-`, então é
    // protegido automaticamente — é o arquivo vivo do MCP, não um artefato órfão.
    eh_regeravel && idade_dias >= teto_dias
}

/// Varre o diretório de dados e remove os artefatos regeráveis mais velhos que `teto_dias`.
/// Devolve (removidos, bytes_liberados). Erros de I/O são ignorados por arquivo — limpeza
/// nunca pode derrubar o boot.
pub fn limpar_artefatos(dir: &Path, teto_dias: u64) -> (usize, u64) {
    let mut removidos = 0usize;
    let mut bytes_liberados = 0u64;

    let Ok(entries) = fs::read_dir(dir) else {
        // Se o diretório não existir ou não for legível, não travamos o boot.
        return (0, 0);
    };

    for entry in entries.flatten() {
        let path = entry.path();

        let Ok(metadata) = fs::metadata(&path) else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }

        let Some(nome) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };

        let idade_dias = metadata
            .modified()
            .ok()
            .and_then(|mtime| SystemTime::now().duration_since(mtime).ok())
            .map(|dur| dur.as_secs() / 86400)
            .unwrap_or(0);

        if deve_remover(nome, idade_dias, teto_dias) {
            let tamanho = metadata.len();
            if fs::remove_file(&path).is_ok() {
                removidos += 1;
                bytes_liberados += tamanho;
            }
        }
    }

    (removidos, bytes_liberados)
}

/// Comando Tauri: roda a limpeza no diretório de dados do app. Devolve um resumo pra UI.
#[tauri::command]
pub fn housekeeping_run(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("diretório de dados do app indisponível: {e}"))?;

    // Padrão de 7 dias: dá uma semana de "tolerância" caso o agente só esteja
    // temporariamente offline, mas já evita o acúmulo de meses visto no incidente.
    let (removidos, bytes_liberados) = limpar_artefatos(&dir, 7);

    Ok(json!({
        "removidos": removidos,
        "bytesLiberados": bytes_liberados,
        "dir": dir.to_string_lossy()
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::io::Write;
    use std::time::{SystemTime, UNIX_EPOCH};

    /// Cada prefixo regerável deve ser removido quando velho o bastante.
    /// Falha real: acúmulo de 17 agent-settings-<slug>.json de agentes que já não existiam.
    #[test]
    fn prefixos_regeraveis_sao_removidos_quando_velhos() {
        let casos = [
            ("agent-settings-foo.json", 8, 7, true),
            ("agent-hook-bar.curl", 8, 7, true),
            ("agent-mcp-deadbeef.json", 8, 7, true),
            ("agent-prompt-42.txt", 8, 7, true),
            ("agent-cmd-42.cmd", 8, 7, true),
        ];
        for (nome, idade, teto, esperado) in casos {
            assert_eq!(
                deve_remover(nome, idade, teto),
                esperado,
                "falhou em {}",
                nome
            );
        }
    }

    /// Nenhum artefato regerável pode ser removido enquanto estiver abaixo do teto.
    /// Falha real: não podemos apagar arquivos do agente que ainda pode respawnar a qualquer momento.
    #[test]
    fn artefatos_novos_nao_sao_removidos() {
        let casos = [
            ("agent-settings-foo.json", 3, 7, false),
            ("agent-hook-bar.curl", 0, 7, false),
            ("agent-mcp-deadbeef.json", 6, 7, false),
            ("agent-prompt-99.txt", 1, 7, false),
            ("agent-cmd-99.cmd", 2, 7, false),
        ];
        for (nome, idade, teto, esperado) in casos {
            assert_eq!(
                deve_remover(nome, idade, teto),
                esperado,
                "falhou em {}",
                nome
            );
        }
    }

    /// `agent-mcp.json` exato (sem hash) nunca é removido.
    /// Falha real: este é o arquivo vivo de configuração do MCP do usuário; não é artefato órfão.
    #[test]
    fn agent_mcp_vivo_nunca_eh_removido() {
        assert!(!deve_remover("agent-mcp.json", 999, 7));
    }

    /// `local-review.py`, `review-config.json`, banco SQLite e nomes desconhecidos são sagrados.
    /// Falha real: sem essa barreira, a limpeza vira perda de dado e o usuário roda
    /// versão antiga do script de review sem saber (ou perde o banco).
    #[test]
    fn arquivos_protegidos_nunca_sao_removidos() {
        let protegidos = [
            "local-review.py",
            "review-config.json",
            "app.sqlite",
            "webview-state.json",
            "qualquer-coisa.dat",
        ];
        for nome in protegidos {
            assert!(!deve_remover(nome, 999, 7), "falhou em {}", nome);
        }
    }

    /// Varredura real em diretório temporário: força "velho" via teto = 0
    /// (arquivos recém-criados têm idade 0 dias, e 0 >= 0).
    /// Falha real: a função pura pode estar certa, mas a varredura de disco precisa
    /// respeitar as mesmas regras e não apagar arquivos vivos/desconhecidos.
    #[test]
    fn limpar_artefatos_real_remove_somente_os_velhos() {
        let pid = std::process::id();
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis();
        let base = std::env::temp_dir().join(format!("omnirift_hk_{}_{}", pid, ts));

        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();

        let velhos_regeraveis = [
            "agent-settings-morto.json",
            "agent-hook-morto.curl",
            "agent-mcp-deadbeef.json",
            "agent-prompt-velho.txt",
            "agent-cmd-velho.cmd",
        ];

        let protegidos = [
            "agent-mcp.json",
            "local-review.py",
            "review-config.json",
            "app.sqlite",
            "desconhecido.dat",
        ];

        for nome in &velhos_regeraveis {
            let mut f = File::create(base.join(nome)).unwrap();
            f.write_all(b"x").unwrap();
        }

        for nome in &protegidos {
            let mut f = File::create(base.join(nome)).unwrap();
            f.write_all(b"y").unwrap();
        }

        let (removidos, bytes) = limpar_artefatos(&base, 0);

        assert_eq!(removidos, velhos_regeraveis.len());
        assert!(bytes >= velhos_regeraveis.len() as u64);

        for nome in &velhos_regeraveis {
            assert!(
                !base.join(nome).exists(),
                "{} deveria ter sido removido",
                nome
            );
        }

        for nome in &protegidos {
            assert!(
                base.join(nome).exists(),
                "{} deveria ter sido preservado",
                nome
            );
        }

        let _ = fs::remove_dir_all(&base);
    }
}
