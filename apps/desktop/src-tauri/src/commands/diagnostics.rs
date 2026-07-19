//! Coleta de diagnóstico do app — empacota versão, SO e o tail do log de arquivo
//! num bundle único pra anexar em reports de bug/suporte.
//!
//! O log em arquivo é gravado pelo `tauri-plugin-log` (ver lib.rs) no app log dir
//! do SO, com base name "omnirift" → arquivo `omnirift.log`. Aqui apenas lemos o
//! tail (~200 KB finais) desse arquivo; sem o arquivo, devolvemos string vazia.

use serde::Serialize;
use tauri::Manager;

/// Quanto do final do log incluir no bundle (~200 KB).
const LOG_TAIL_BYTES: usize = 200 * 1024;

/// Rótulo que o gravador escreve no debug.log ao iniciar. O export corta a partir da
/// ÚLTIMA ocorrência dele — sem isso o pacote levaria log de sessões anteriores que o
/// cliente não autorizou. Sem ASCII-only de propósito? NÃO: mantenha sem acento porque o
/// valor é comparado como substring e precisa casar exatamente com o que o frontend manda.
pub const RECORDING_MARK: &str = "INICIO DA GRAVACAO";

/// Recorta o trecho do log que pertence a ESTA gravação.
///
/// Procura a ÚLTIMA ocorrência de `RECORDING_MARK` e devolve do início daquela linha em
/// diante. Sem marca — gravador não usado, ou log rotacionado — cai no tail de
/// `max_bytes` e o chamador AVISA que há histórico anterior, porque silenciosamente mandar
/// o passado é o problema que estamos corrigindo.
pub fn slice_recording(log: &str, max_bytes: usize) -> (String, bool) {
    if log.is_empty() {
        return (String::new(), false);
    }

    if let Some(idx) = log.rfind(RECORDING_MARK) {
        return (log[idx..].to_string(), true);
    }

    let bytes = log.as_bytes();
    let len = bytes.len();

    if max_bytes >= len {
        return (log.to_string(), false);
    }

    let mut start = len - max_bytes;
    while start < len && (bytes[start] & 0xC0) == 0x80 {
        start += 1;
    }

    (log[start..].to_string(), false)
}

/// Snapshot de diagnóstico do app, serializável pro front.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsBundle {
    /// Versão do crate (= versão do app no Cargo.toml).
    pub app_version: String,
    /// SO (`linux`, `windows`, `macos`, …).
    pub os: String,
    /// Versão/identificação do SO — best-effort, sem dep pesada nova.
    pub os_version: String,
    /// Últimos ~200 KB do arquivo de log (vazio se o arquivo não existe).
    pub log_tail: String,
}

/// Lê o tail (~200 KB finais) do `omnirift.log` no app log dir.
/// Qualquer falha (sem dir, sem arquivo, erro de IO) vira string vazia — coleta de
/// diagnóstico nunca deve falhar por causa do log.
fn read_log_tail(app: &tauri::AppHandle) -> String {
    let Ok(dir) = app.path().app_log_dir() else {
        return String::new();
    };
    // base name "omnirift" → arquivo "omnirift.log" (extensão do tauri-plugin-log).
    let path = dir.join("omnirift.log");
    let Ok(bytes) = std::fs::read(&path) else {
        return String::new();
    };
    let start = bytes.len().saturating_sub(LOG_TAIL_BYTES);
    // from_utf8_lossy lida com um corte no meio de um caractere multibyte.
    let tail = String::from_utf8_lossy(&bytes[start..]).into_owned();
    // FRONTEIRA sai-da-máquina: o bundle do /diag é anexado a reports de suporte
    // (sai do disco do usuário). Redige fingerprints de provedor / tokens / linhas
    // de env que possam ter caído no log antes de empacotar. Ver crate::redactor.
    crate::redactor::redact(&tail)
}

/// Coleta um bundle de diagnóstico (versão, SO, tail do log) pra reports de suporte.
#[tauri::command]
pub fn collect_diagnostics(app: tauri::AppHandle) -> DiagnosticsBundle {
    DiagnosticsBundle {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        os: std::env::consts::OS.to_string(),
        // Best-effort sem crate nova pesada: SO/ARCH dos consts da std.
        os_version: format!("{}/{}", std::env::consts::OS, std::env::consts::ARCH),
        log_tail: read_log_tail(&app),
    }
}
/// Gera um arquivo ÚNICO de diagnóstico pro beta tester anexar no suporte.
///
/// Texto puro de propósito (sem zip): o tester CONSEGUE ABRIR e ver o que está
/// mandando antes de enviar — isso é o que faz ele confiar em mandar. Também evita
/// dependência nova e não precisa do worker no ar (funciona atrás de firewall).
///
/// SEGURANÇA: tudo passa por `redactor::redact` na saída, mesmo os dois logs já
/// serem redigidos na escrita. Redundância barata; este arquivo SAI da máquina.
#[tauri::command]
pub fn diagnostics_export(app: tauri::AppHandle) -> Result<String, String> {
    use std::io::Write;

    let b = collect_diagnostics(app.clone());
    // from_utf8_lossy: um único byte inválido faria read_to_string devolver VAZIO,
    // e o suporte perderia o debug.log inteiro sem ninguém perceber.
    let dbg_path = crate::commands::debug_log::debug_log_path();
    let (debug_log, debug_err) = match std::fs::read(&dbg_path) {
        Ok(bytes) => (String::from_utf8_lossy(&bytes).into_owned(), String::new()),
        Err(e) => (String::new(), format!("(nao consegui ler {dbg_path}: {e})")),
    };
    // PRIVACIDADE: corta a partir da marca que o gravador escreve ao iniciar. Sem isso o
    // pacote levava os últimos 200 KB CRUS — que podem ser de outra sessão, de outro
    // projeto. O cliente aperta "gravar" e tem que sair daí pra frente, não do passado.
    let (debug_tail, veio_da_marca) = slice_recording(&debug_log, 200_000);

    let mut out = String::new();
    out.push_str("=== OmniRift — diagnóstico ===\n");
    out.push_str(&format!("gerado : {}\n", chrono::Local::now().format("%Y-%m-%d %H:%M:%S")));
    out.push_str(&format!("versão : {}\n", b.app_version));
    out.push_str(&format!("SO     : {} {}\n", b.os, b.os_version));
    out.push_str(&format!("debug  : {}\n", if crate::commands::debug_mode::is_enabled() { "LIGADO" } else { "desligado" }));
    out.push_str("\nSe o modo debug estava DESLIGADO, o log tem menos detalhe: ligue em\n");
    out.push_str("Configurações > Geral, reproduza o problema e gere o arquivo de novo.\n");
    if !veio_da_marca {
        out.push_str("\nAVISO: este pacote NÃO foi delimitado por uma gravação — inclui o\n");
        out.push_str("final do log, que pode conter atividade anterior a este problema.\n");
    }
    out.push_str("\n\n=== omnirift.log (fim) ===\n");
    out.push_str(&b.log_tail);
    out.push_str("\n\n=== debug.log (fim) ===\n");
    if !debug_err.is_empty() {
        out.push_str(&debug_err);
        out.push('\n');
    }
    out.push_str(&debug_tail);

    let safe = crate::redactor::redact(&out);

    let dir = app
        .path()
        .app_log_dir()
        .map_err(|e| format!("sem diretório de log: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("não criei o diretório: {e}"))?;
    let name = format!("omnirift-diagnostico-{}.txt", chrono::Local::now().format("%Y%m%d-%H%M%S"));
    let path = dir.join(name);
    let mut f = std::fs::File::create(&path).map_err(|e| format!("não criei o arquivo: {e}"))?;
    f.write_all(safe.as_bytes()).map_err(|e| format!("não escrevi: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    /// doc: o cliente apertou "gravar" — nada de antes disso pode sair da máquina dele
    fn corta_a_partir_da_marca() {
        let log = "passado que nao pode vazar\n===== ".to_string()
            + RECORDING_MARK
            + " =====\nagora sim";
        let (trecho, veio_da_marca) = slice_recording(&log, 200);
        assert!(!trecho.contains("passado que nao pode vazar"));
        assert!(trecho.contains("agora sim"));
        assert!(veio_da_marca);
    }

    #[test]
    /// doc: gravar duas vezes na mesma sessão — vale a última
    fn usa_a_ultima_marca_quando_ha_varias() {
        let log = format!(
            "===== {} =====\nprimeira\n===== {} =====\nsegunda",
            RECORDING_MARK, RECORDING_MARK
        );
        let (trecho, veio_da_marca) = slice_recording(&log, 200);
        assert!(trecho.contains("segunda"));
        assert!(!trecho.contains("primeira"));
        assert!(veio_da_marca);
    }

    #[test]
    /// doc: sem marca não dá pra saber o que é da gravação; o chamador precisa AVISAR
    fn sem_marca_cai_no_tail_e_avisa() {
        let log = "a".repeat(300);
        let (trecho, veio_da_marca) = slice_recording(&log, 100);
        assert!(trecho.len() <= 100);
        assert!(!veio_da_marca);
    }

    #[test]
    /// doc: cortar no meio de um multibyte produziria lixo no arquivo que o suporte lê
    fn nao_corta_caractere_multibyte() {
        let log = "á".repeat(100);
        let (trecho, veio_da_marca) = slice_recording(&log, 51);
        assert!(trecho.is_char_boundary(0));
        assert_ne!(trecho.as_bytes()[0] & 0xC0, 0x80);
        assert!(!veio_da_marca);
    }

    #[test]
    /// doc: log vazio não deve quebrar o export
    fn log_vazio_nao_quebra() {
        let (trecho, veio_da_marca) = slice_recording("", 100);
        assert_eq!(trecho, "");
        assert!(!veio_da_marca);
    }
}
