//! Comando Tauri de configuração do harness de benchmark do canvas.
//!
//! Lê as variáveis de ambiente que controlam o bench no boot:
//! - `OMNIRIFT_BENCH_MODE`: liga o modo se "1", "true" ou "on" (case-insensitive).
//! - `OMNIRIFT_BENCH_FLAGS`: string com flags separadas por vírgula.
//! - `OMNIRIFT_BENCH_NODES`: contagem de nós sintéticos (inteiro positivo, default 300).
//! - `OMNIRIFT_BENCH_DRAG_STEPS`: passos da trajetória de arrasto (inteiro positivo, default 30).
//!
//! Valores inválidos caem silenciosamente nos defaults sem panic.

use serde::{Deserialize, Serialize};

pub const BENCH_MODE_ENV: &str = "OMNIRIFT_BENCH_MODE";
pub const BENCH_FLAGS_ENV: &str = "OMNIRIFT_BENCH_FLAGS";
pub const BENCH_NODES_ENV: &str = "OMNIRIFT_BENCH_NODES";
pub const BENCH_DRAG_STEPS_ENV: &str = "OMNIRIFT_BENCH_DRAG_STEPS";

pub const DEFAULT_BENCH_NODES: u32 = 300;
pub const DEFAULT_BENCH_DRAG_STEPS: u32 = 30;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BenchConfig {
    pub mode: bool,
    pub flags: String,
    pub nodes: u32,
    #[serde(alias = "dragSteps")]
    pub drag_steps: u32,
}

/// Parseia a env de modo do bench (1 | true | on liga).
pub fn parse_bench_mode(raw: Option<&str>) -> bool {
    let Some(val) = raw else {
        return false;
    };
    let trimmed = val.trim();
    trimmed.eq_ignore_ascii_case("1")
        || trimmed.eq_ignore_ascii_case("true")
        || trimmed.eq_ignore_ascii_case("on")
}

/// Parseia a env de flags do bench ("drag-commit-on-end=1,floors-unmount-inactive=0").
pub fn parse_bench_flags(raw: Option<&str>) -> String {
    raw.unwrap_or("").trim().to_string()
}

/// Parseia inteiro positivo para o bench com fallback defensivo para defaults.
pub fn parse_bench_u32(raw: Option<&str>, default: u32) -> u32 {
    match raw.and_then(|v| v.trim().parse::<u32>().ok()) {
        Some(val) if val > 0 => val,
        _ => default,
    }
}

/// Resolve a configuração a partir de valores de strings opcionais (função pura para testes).
pub fn resolve_bench_config(
    mode_raw: Option<&str>,
    flags_raw: Option<&str>,
    nodes_raw: Option<&str>,
    steps_raw: Option<&str>,
) -> BenchConfig {
    BenchConfig {
        mode: parse_bench_mode(mode_raw),
        flags: parse_bench_flags(flags_raw),
        nodes: parse_bench_u32(nodes_raw, DEFAULT_BENCH_NODES),
        drag_steps: parse_bench_u32(steps_raw, DEFAULT_BENCH_DRAG_STEPS),
    }
}

/// Comando Tauri: lê as 4 variáveis de ambiente do SO e devolve a configuração resolvida.
#[tauri::command]
pub fn bench_config() -> BenchConfig {
    let mode_raw = std::env::var(BENCH_MODE_ENV).ok();
    let flags_raw = std::env::var(BENCH_FLAGS_ENV).ok();
    let nodes_raw = std::env::var(BENCH_NODES_ENV).ok();
    let steps_raw = std::env::var(BENCH_DRAG_STEPS_ENV).ok();

    resolve_bench_config(
        mode_raw.as_deref(),
        flags_raw.as_deref(),
        nodes_raw.as_deref(),
        steps_raw.as_deref(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_defaults_when_env_absent() {
        let config = resolve_bench_config(None, None, None, None);
        assert_eq!(
            config,
            BenchConfig {
                mode: false,
                flags: String::new(),
                nodes: 300,
                drag_steps: 30,
            }
        );
    }

    #[test]
    fn test_defaults_when_env_empty() {
        let config = resolve_bench_config(Some(""), Some(""), Some(""), Some(""));
        assert_eq!(
            config,
            BenchConfig {
                mode: false,
                flags: String::new(),
                nodes: 300,
                drag_steps: 30,
            }
        );
    }

    #[test]
    fn test_bench_mode_truthy_values() {
        for truthy in ["1", "true", "on", "TRUE", "On", "ON", " 1 ", " true\t"] {
            assert!(
                parse_bench_mode(Some(truthy)),
                "esperava mode=true para '{truthy}'"
            );
        }
    }

    #[test]
    fn test_bench_mode_falsy_and_invalid_values() {
        for falsy in [
            "0", "false", "off", "FALSE", "Off", "2", "-1", "sim", "yes", "bench",
        ] {
            assert!(
                !parse_bench_mode(Some(falsy)),
                "esperava mode=false para '{falsy}'"
            );
        }
    }

    #[test]
    fn test_bench_flags_parsing() {
        assert_eq!(parse_bench_flags(None), "");
        assert_eq!(parse_bench_flags(Some("")), "");
        assert_eq!(
            parse_bench_flags(Some("drag-commit-on-end=1,floors-unmount-inactive=0")),
            "drag-commit-on-end=1,floors-unmount-inactive=0"
        );
        assert_eq!(
            parse_bench_flags(Some("   drag-commit-on-end=1   ")),
            "drag-commit-on-end=1"
        );
    }

    #[test]
    fn test_bench_nodes_valid_and_invalid() {
        // Válidos
        assert_eq!(parse_bench_u32(Some("300"), DEFAULT_BENCH_NODES), 300);
        assert_eq!(parse_bench_u32(Some("500"), DEFAULT_BENCH_NODES), 500);
        assert_eq!(parse_bench_u32(Some(" 100 "), DEFAULT_BENCH_NODES), 100);

        // Inválidos (devem cair no default 300 sem panic)
        assert_eq!(parse_bench_u32(None, DEFAULT_BENCH_NODES), 300);
        assert_eq!(parse_bench_u32(Some(""), DEFAULT_BENCH_NODES), 300);
        assert_eq!(parse_bench_u32(Some("0"), DEFAULT_BENCH_NODES), 300);
        assert_eq!(parse_bench_u32(Some("-10"), DEFAULT_BENCH_NODES), 300);
        assert_eq!(parse_bench_u32(Some("abc"), DEFAULT_BENCH_NODES), 300);
        assert_eq!(parse_bench_u32(Some("12.5"), DEFAULT_BENCH_NODES), 300);
        assert_eq!(parse_bench_u32(Some("NaN"), DEFAULT_BENCH_NODES), 300);
    }

    #[test]
    fn test_bench_drag_steps_valid_and_invalid() {
        // Válidos
        assert_eq!(parse_bench_u32(Some("30"), DEFAULT_BENCH_DRAG_STEPS), 30);
        assert_eq!(parse_bench_u32(Some("50"), DEFAULT_BENCH_DRAG_STEPS), 50);
        assert_eq!(parse_bench_u32(Some(" 15 "), DEFAULT_BENCH_DRAG_STEPS), 15);

        // Inválidos (devem cair no default 30 sem panic)
        assert_eq!(parse_bench_u32(None, DEFAULT_BENCH_DRAG_STEPS), 30);
        assert_eq!(parse_bench_u32(Some(""), DEFAULT_BENCH_DRAG_STEPS), 30);
        assert_eq!(parse_bench_u32(Some("0"), DEFAULT_BENCH_DRAG_STEPS), 30);
        assert_eq!(parse_bench_u32(Some("-1"), DEFAULT_BENCH_DRAG_STEPS), 30);
        assert_eq!(parse_bench_u32(Some("xyz"), DEFAULT_BENCH_DRAG_STEPS), 30);
        assert_eq!(parse_bench_u32(Some("9.99"), DEFAULT_BENCH_DRAG_STEPS), 30);
    }

    #[test]
    fn test_resolve_bench_config_full() {
        let config = resolve_bench_config(
            Some("true"),
            Some("drag-commit-on-end=1,floors-unmount-inactive=0"),
            Some("450"),
            Some("60"),
        );
        assert_eq!(
            config,
            BenchConfig {
                mode: true,
                flags: "drag-commit-on-end=1,floors-unmount-inactive=0".to_string(),
                nodes: 450,
                drag_steps: 60,
            }
        );
    }

    #[test]
    fn test_bench_config_json_serialization() {
        let config = BenchConfig {
            mode: true,
            flags: "drag-commit-on-end=1".to_string(),
            nodes: 300,
            drag_steps: 30,
        };
        let json = serde_json::to_string(&config).expect("serialização para json");
        assert!(json.contains("\"mode\":true"));
        assert!(json.contains("\"flags\":\"drag-commit-on-end=1\""));
        assert!(json.contains("\"nodes\":300"));
        assert!(json.contains("\"drag_steps\":30"));

        let deserialized: BenchConfig =
            serde_json::from_str(&json).expect("deserialização de json");
        assert_eq!(deserialized, config);

        // Teste de compatibilidade com camelCase no deserializador
        let camel_json = r#"{"mode":true,"flags":"","nodes":200,"dragSteps":40}"#;
        let from_camel: BenchConfig =
            serde_json::from_str(camel_json).expect("deserialização camelCase");
        assert_eq!(from_camel.drag_steps, 40);
        assert_eq!(from_camel.nodes, 200);
    }
}
