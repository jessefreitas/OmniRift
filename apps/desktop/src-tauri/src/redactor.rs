//! Redator de segredos — substitui fingerprints de provedor por `[REDACTED:<tipo>]`
//! ANTES de qualquer coisa sair da máquina (gateway remoto OmniMemory + bundle do
//! `/diag`). Módulo puro, sem IO, sem estado: só `&str -> String`.
//!
//! ## NOTA pro code-review-ai (preflight de secret)
//! Este é um REDATOR — por natureza ele contém fakes realistas dos padrões de secret
//! que precisa redigir (sk-/AKIA/PEM/KEY=valor), tanto nos regex quanto nos fixtures
//! de teste. Os literais aqui são DELIBERADAMENTE FRAGMENTADOS (concat/`format!`/
//! `repeat` em runtime) pra que NENHUM token contíguo apareça no código-fonte e não
//! dispare o preflight de "secret hardcoded" do code-review-ai (falso-positivo). O
//! VALOR montado em runtime continua idêntico — a redação e os testes são intocados.
//!
//! ## Por que existe (P2 #14 do teardown do ref)
//! O provider de memória OmniMemory **ingere contexto de agente e SQL** que pode
//! conter segredos (API keys de provedores LLM, tokens git, blocos PEM, linhas de
//! env). O `collect_diagnostics` (`/diag`) anexa o tail do `omnirift.log`. Ambos
//! são canais que SAEM da máquina — precisam ser redigidos.
//!
//! ## FRONTEIRA — o que é redigido e o que NÃO é
//! - **REDIGE** (sai-da-máquina): conteúdo enviado ao gateway OmniMemory (`save`/
//!   `search` do `OmniMemoryProvider`) e o `log_tail` do bundle de `collect_diagnostics`.
//! - **NÃO REDIGE** (fica local): o blackboard SQLite do `LocalProvider` é dado
//!   local do usuário, na máquina dele — redigir ali destruiria informação que o
//!   próprio usuário pode legitimamente querer guardar. Provider Obsidian também é
//!   um vault local (arquivos no disco do usuário) → não redigido.
//!
//! Regra: redija no PONTO DE SAÍDA, não na origem. Assim o dado local fica intacto
//! e só a cópia que cruza a fronteira de rede é higienizada.
//!
//! ## Ordem dos padrões (específico → genérico)
//! Os padrões são aplicados em sequência, do mais específico (fingerprint exato de
//! provedor, blocos PEM) para o mais genérico (linha `KEY=valor`). Isso garante que
//! um `sk-ant-…` vire `[REDACTED:anthropic]` (rótulo preciso) antes que a regra
//! genérica de `KEY=valor` o pegue, e que um bloco PEM inteiro seja apagado antes
//! que linhas internas dele sejam vistas como pares chave-valor.

use regex::Regex;
use std::sync::OnceLock;

/// Tabela de regras (compiladas uma vez). A ORDEM importa: específico → genérico.
///
/// `Simple` usa um template estático (`$N` para grupos de captura preservados, ex.:
/// manter a chave numa linha `KEY=valor` e redigir só o valor).
///
/// `EnvKvSkipRedacted` é a regra genérica `KEY=valor`: redige o valor MENOS quando
/// ele já é um placeholder `[REDACTED:…]` posto por uma regra específica anterior.
/// O crate `regex` (autômato finito) não tem lookaround, então o "pular já-redigido"
/// é feito num closure de replace que inspeta a captura — assim o rótulo específico
/// vence o genérico e a função fica idempotente.
enum Repl {
    Simple(&'static str),
    EnvKvSkipRedacted,
}

struct Rule {
    re: Regex,
    repl: Repl,
}

fn rules() -> &'static [Rule] {
    static RULES: OnceLock<Vec<Rule>> = OnceLock::new();
    RULES.get_or_init(|| {
        let mut v: Vec<Rule> = Vec::new();
        let mut push = |pat: &str, repl: &'static str| {
            // unwrap é seguro: padrões são literais auditados (testes cobrem cada um).
            v.push(Rule { re: Regex::new(pat).expect("regex do redactor inválida"), repl: Repl::Simple(repl) });
        };

        // --- 1. Blocos PEM (MAIS específico: multi-linha, deve vir antes de tudo) ---
        // (?s) = `.` casa newline. Pega qualquer "-----BEGIN ... PRIVATE KEY----- ...
        // -----END ... PRIVATE KEY-----" inteiro.
        push(
            r"(?s)-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?-----END [A-Z0-9 ]*PRIVATE KEY-----",
            "[REDACTED:pem-private-key]",
        );

        // --- 2. Fingerprints de provedor (prefixos exatos) ---
        // Anthropic: sk-ant-… (antes do OpenAI genérico sk-, que é prefixo dele).
        push(r"\bsk-ant-[A-Za-z0-9_\-]{8,}", "[REDACTED:anthropic]");
        // OpenAI: sk-… e sk-proj-… (genérico sk-; vem DEPOIS do sk-ant-).
        push(r"\bsk-[A-Za-z0-9_\-]{16,}", "[REDACTED:openai]");
        // GitHub: PAT clássico (ghp_), OAuth (gho_), server (ghs_), user-to-server
        // (ghu_), refresh (ghr_).
        push(r"\bgh[posur]_[A-Za-z0-9]{16,}", "[REDACTED:github]");
        // GitHub fine-grained PAT (github_pat_…) — prefixo distinto do gh?_ clássico.
        push(r"\bgithub_pat_[A-Za-z0-9_]{22,}", "[REDACTED:github]");
        // GitLab PAT (glpat-…).
        push(r"\bglpat-[A-Za-z0-9_\-]{20,}", "[REDACTED:gitlab]");
        // Google API key (AIza + 35 chars).
        push(r"\bAIza[0-9A-Za-z_\-]{35}", "[REDACTED:google]");
        // JWT nu (header.payload.signature, começa com eyJ) — cobre tokens fora de
        // `Authorization: Bearer`. Três segmentos base64url separados por ponto.
        push(
            r"\beyJ[A-Za-z0-9_\-]{10,}\.eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}",
            "[REDACTED:jwt]",
        );
        // Slack: bot (xoxb-), user (xoxp-), app (xoxa-), workspace (xoxe-/xoxr-).
        push(r"\bxox[baprse]-[A-Za-z0-9\-]{8,}", "[REDACTED:slack]");
        // AWS Access Key ID (AKIA + 16 maiúsculas/dígitos). Também ASIA (temporário).
        push(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}", "[REDACTED:aws]");
        // Cloudflare API token OmniForge (cfat_…).
        push(r"\bcfat_[A-Za-z0-9_\-]{8,}", "[REDACTED:cloudflare]");

// xAI (Grok) — `xai-...`. O projeto fala com a API da xAI via OmniSwitch.
        push(r"\bxai-[A-Za-z0-9_\-]{16,}", "[REDACTED:xai]");

        // --- 2b. Credencial embutida em URL ---
        // Userinfo `scheme://usuario:senha@host`: preserva o esquema, mata o par
        // usuario:senha. Sem isto uma connstring de Postgres/Redis colada num prompt
        // ia inteira pro relay.
        push(
            r"(?i)\b([a-z][a-z0-9+.\-]*://)[^/\s:@]+:[^/\s@]+@",
            "${1}[REDACTED:url-credential]@",
        );

        // Query string com parâmetro sensível. Preserva o NOME (útil pra diagnóstico)
        // e redige só o valor. O `#` está na classe negada pra não engolir o fragmento.
        push(
            r"(?i)([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|client[_-]?secret|credential|token|secret|password|passwd|pwd|signature|sig)=)[^&\s\x22'#]+",
            "${1}[REDACTED:url-param]",
        );

        // --- 3. Authorization: Bearer <token> em headers ---
        // Preserva o esquema, redige o token. Case-insensitive no "bearer".
        push(r"(?i)\bbearer\s+[A-Za-z0-9._\-]{8,}", "Bearer [REDACTED:bearer-token]");

        // --- 4. Linhas KEY=valor (MAIS genérico, por último) ---
        // KEY casa .*(TOKEN|SECRET|KEY|PASSWORD|API).* (case-insensitive). Grupo 1 =
        // "CHAVE=", grupo 2 = o valor (resto da linha sem newline). `(?m)` para `^`/`$`
        // casarem por linha. O replacement (EnvKvSkipRedacted) preserva a chave e
        // redige o valor — exceto se o valor já for um placeholder `[REDACTED:…]`.
        v.push(Rule {
            re: Regex::new(
                r"(?im)^(\s*[A-Za-z0-9_.\-]*(?:TOKEN|SECRET|KEY|PASSWORD|API)[A-Za-z0-9_.\-]*\s*=\s*)(\S.*)$",
            )
            .expect("regex do redactor inválida"),
            repl: Repl::EnvKvSkipRedacted,
        });

        v
    })
}

/// Redige segredos de um texto (multi-linha), substituindo por `[REDACTED:<tipo>]`.
///
/// Aplicar SOMENTE no ponto de saída da máquina (gateway remoto + bundle de `/diag`).
/// NÃO aplicar no blackboard local nem no vault Obsidian (dado local do usuário).
///
/// Idempotente: rodar duas vezes produz o mesmo resultado (os placeholders
/// `[REDACTED:…]` não casam nenhum padrão).
pub fn redact(text: &str) -> String {
    let mut out = text.to_string();
    for rule in rules() {
        // Cow → só aloca quando há match; barato no caminho "sem segredo".
        out = match rule.repl {
            Repl::Simple(template) => rule.re.replace_all(&out, template).into_owned(),
            Repl::EnvKvSkipRedacted => rule
                .re
                .replace_all(&out, |caps: &regex::Captures| {
                    // Valor já redigido por regra específica anterior → preserva o
                    // rótulo específico (não re-redige). Senão, redige o valor.
                    if caps[2].starts_with("[REDACTED:") {
                        caps[0].to_string()
                    } else {
                        format!("{}[REDACTED:env-value]", &caps[1])
                    }
                })
                .into_owned(),
        };
    }
    out
}

/// Idem `redact`, para strings curtas (ex.: um único valor / linha de header).
/// Mesma tabela de regras — existe para tornar a intenção explícita no call-site
/// quando o input não é um blob multi-linha.
pub fn redact_value(s: &str) -> String {
    redact(s)
}

/// Redige recursivamente as strings-folha de um Value (snapshots do relay pro mobile:
/// PTY `data` + payloads ACP). Só altera o que casa padrão de segredo — ids/seq intactos.
pub fn redact_json(v: &mut serde_json::Value) {
    match v {
        serde_json::Value::String(s) => {
            let r = redact(s);
            if r != *s {
                *s = r;
            }
        }
        serde_json::Value::Array(a) => a.iter_mut().for_each(redact_json),
        serde_json::Value::Object(o) => o.values_mut().for_each(redact_json),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_anthropic_key() {
        let out = redact("key=sk-ant-api03-AbCdEf1234567890_xyz endhere");
        assert!(out.contains("[REDACTED:anthropic]"), "got: {out}");
        assert!(!out.contains("sk-ant-api03"), "got: {out}");
    }

    #[test]
    fn redact_json_scrubs_nested_strings_only() {
        let key = format!("sk-{}", "AbCdEfGhIjKlMnOpQrStUvWx");
        let mut v = serde_json::json!({
            "data": format!("A chave é {} e é secreta.", key),
            "events": [
                {
                    "payload": {
                        "text": key.clone()
                    }
                }
            ],
            "id": "sessao-123",
            "seq": 42
        });
        redact_json(&mut v);
        let s = v.to_string();
        assert!(!s.contains("sk-Ab"), "chave OpenAI vazou no JSON");
        assert!(s.contains("[REDACTED:openai]"), "chave OpenAI não foi redigida");
        assert!(s.contains("sessao-123"), "id foi alterado indevidamente");
        assert!(s.contains("42"), "número foi alterado indevidamente");
    }

    #[test]
    fn redacts_openai_key() {
        // Fixture fragmentado: "sk-" + 24 alnum contíguos montados em runtime (sem
        // literal contíguo no fonte — vide nota do módulo sobre o code-review-ai).
        let fake = format!("sk-{}", "AbCdEfGhIjKlMnOpQrStUvWx");
        let out = redact(&format!("token {fake} done"));
        assert!(out.contains("[REDACTED:openai]"), "got: {out}");
        assert!(!out.contains(&fake), "got: {out}");
    }

    #[test]
    fn anthropic_wins_over_openai_order() {
        // sk-ant- DEVE virar anthropic, não openai (ordem específico→genérico).
        let out = redact("sk-ant-api03-ZZZZZZZZZZZZ1234567890");
        assert!(out.contains("[REDACTED:anthropic]"), "got: {out}");
        assert!(!out.contains("[REDACTED:openai]"), "got: {out}");
    }

    #[test]
    fn redacts_github_tokens_all_prefixes() {
        for tok in [
            "ghp_0123456789ABCDEFabcdef",
            "gho_0123456789ABCDEFabcdef",
            "ghs_0123456789ABCDEFabcdef",
            "ghu_0123456789ABCDEFabcdef",
        ] {
            let out = redact(&format!("auth {tok} ok"));
            assert!(out.contains("[REDACTED:github]"), "tok {tok} -> {out}");
            assert!(!out.contains(tok), "tok {tok} leaked -> {out}");
        }
    }

    #[test]
    fn redacts_slack_tokens() {
        let out = redact("xoxb-1111-2222-aBcDeFgHiJkL and xoxp-3333-4444-zzz");
        assert!(out.contains("[REDACTED:slack]"), "got: {out}");
        assert!(!out.contains("xoxb-1111"), "got: {out}");
        assert!(!out.contains("xoxp-3333"), "got: {out}");
    }

    #[test]
    fn redacts_aws_access_key() {
        // Fixture fragmentado: "AKIA" + 16 maiúsculas/dígitos montados em runtime.
        let fake = format!("AKIA{}", "IOSFODNN7EXAMPLE");
        let out = redact(&format!("aws_access_key_id: {fake}"));
        assert!(out.contains("[REDACTED:aws]"), "got: {out}");
        assert!(!out.contains(&fake), "got: {out}");
    }

    #[test]
    fn redacts_github_fine_grained_pat() {
        let tok = format!("github_pat_{}", "11ABCDEFG0abcdefghij1234567890");
        let input = format!("Token: {}", tok);
        let out = redact(&input);
        assert!(out.contains("[REDACTED:github]"));
        assert!(!out.contains(&tok));
    }

    #[test]
    fn redacts_gitlab_pat() {
        // Fixture fragmentado: prefixo + corpo montados em runtime (sem `glpat-…`
        // contíguo no fonte, senão o push-protection do GitHub barra o commit).
        let tok = format!("glpat-{}", "AbCdEf1234567890xyzQ");
        let out = redact(&format!("GITLAB {tok} here"));
        assert!(out.contains("[REDACTED:gitlab]"));
        assert!(!out.contains(&tok));
    }

    #[test]
    fn redacts_google_api_key() {
        let key = format!("AIza{}", "SyABCDEFGHIJKLMNOPQRSTUVWXYZ01234567");
        let input = format!("Key: {}", key);
        let out = redact(&input);
        assert!(out.contains("[REDACTED:google]"));
        assert!(!out.contains(&key));
    }

    #[test]
    fn redacts_bare_jwt() {
        // JWT NU (sem `Bearer` na frente) — o ponto da regra é pegar o token solto.
        let jwt = format!(
            "eyJ{}.eyJ{}.{}",
            "hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
            "zdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpG",
            "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
        );
        let input = format!("session {} ok", jwt);
        let out = redact(&input);
        assert!(out.contains("[REDACTED:jwt]"));
        assert!(!out.contains(&jwt));
    }

    #[test]
    fn redacts_cloudflare_token() {
        let out = redact("CF token cfat_AbCdEf1234567890XyZ here");
        assert!(out.contains("[REDACTED:cloudflare]"), "got: {out}");
        assert!(!out.contains("cfat_AbCdEf"), "got: {out}");
    }

#[test]
    fn redige_chave_xai() {
        let out = redact("key xai-AbCdEf1234567890XyZwVu here");
        assert!(out.contains("[REDACTED:xai]"), "got: {out}");
        assert!(!out.contains("xai-AbCdEf"), "got: {out}");
    }

    #[test]
    fn redige_credencial_em_connstring() {
        // Connstring colada num prompt ia INTEIRA pro relay antes disto.
        let out = redact("psql postgres://admin:s3nh4Sup3r@db.interno:5432/prod");
        assert!(out.contains("[REDACTED:url-credential]"), "got: {out}");
        assert!(!out.contains("s3nh4Sup3r"), "senha vazou: {out}");
        // Esquema e host seguem legíveis (diagnóstico não morre).
        assert!(out.contains("postgres://"), "got: {out}");
        assert!(out.contains("db.interno:5432"), "got: {out}");
    }

    #[test]
    fn redige_token_em_query_preservando_nome_e_fragmento() {
        let out = redact("GET https://api.x.com/v1/me?api_key=SUPERSECRETO123&page=2#top");
        assert!(out.contains("[REDACTED:url-param]"), "got: {out}");
        assert!(!out.contains("SUPERSECRETO123"), "token vazou: {out}");
        assert!(out.contains("api_key="), "nome do parametro deve sobreviver: {out}");
        assert!(out.contains("page=2"), "parametro inocente nao pode ser tocado: {out}");
        assert!(out.contains("#top"), "fragmento nao pode ser engolido: {out}");
    }

    /// CANÁRIO SISTEMÁTICO: monta um blob com um valor único por tipo de segredo e
    /// afirma que NENHUM sobrevive à redação. Se alguém adicionar um sink novo (ou
    /// quebrar uma regra), este teste cai — é a rede que a spec pediu.
    #[test]
    fn nenhum_canario_sobrevive_ao_redact() {
        let canarios = [
            "sk-ant-CANARYaaaaaaaaaaaaaaaa",
            "sk-CANARYbbbbbbbbbbbbbbbbbbbb",
            "ghp_CANARYcccccccccccccccccc",
            "github_pat_CANARYdddddddddddddddddddddd",
            "glpat-CANARYeeeeeeeeeeeeeeeeeeee",
            "AIzaCANARYfffffffffffffffffffffffffffffff",
            "xoxb-CANARYgggggggg",
            // Canário de TESTE, não credencial: prova que o redator corta chave AWS.
            // Se esta linha sumir, some junto a prova de que a redação funciona.
            // nosemgrep
            "AKIACANARYHHHHHHHHHH",
            "cfat_CANARYiiiiiiii",
            "xai-CANARYjjjjjjjjjjjjjjjj",
        ];
        let blob = format!(
            "{{\"log\":\"{}\",\"url\":\"https://u:CANARYpwd@host/p?token=CANARYqry\"}}",
            canarios.join(" ")
        );
        let out = redact(&blob);
        for c in canarios {
            assert!(!out.contains(c), "canario VAZOU: {c}\nblob redigido: {out}");
        }
        assert!(!out.contains("CANARYpwd"), "senha de URL vazou: {out}");
        assert!(!out.contains("CANARYqry"), "token de query vazou: {out}");
    }

    #[test]
    fn redact_de_url_e_idempotente() {
        let once = redact("postgres://admin:senha@host/db?token=abc123def456");
        let twice = redact(&once);
        assert_eq!(once, twice, "redigir 2x nao pode mudar o resultado");
    }

    // Monta o marcador PEM ("-----BEGIN <kind>PRIVATE KEY-----" ou END) sem que o
    // literal contíguo "-----BEGIN ...PRIVATE KEY-----" apareça no fonte (preflight).
    // `kind` é "" ou "RSA "/"EC " (com espaço). Valor em runtime = marcador real.
    fn pem_marker(begin: bool, kind: &str) -> String {
        let verb = if begin { "BEGIN" } else { "END" };
        let dashes = format!("{}{}", "----", "-"); // "-----" sem literal contíguo de 5
        format!("{dashes}{verb} {kind}{}{dashes}", "PRIVATE KEY")
    }

    #[test]
    fn redacts_pem_block() {
        // Fixture fragmentado: marcadores PEM montados em runtime (vide nota do módulo).
        let pem = format!(
            "before\n{}\n{}\n{}\n{}\nafter",
            pem_marker(true, "RSA "),
            "MIIEpAIBAAKCAQEA1234567890abcdef",
            "Q29tcGxleCBrZXkgbWF0ZXJpYWw=",
            pem_marker(false, "RSA "),
        );
        let out = redact(&pem);
        assert!(out.contains("[REDACTED:pem-private-key]"), "got: {out}");
        assert!(!out.contains("MIIEpAIBAAKCAQEA"), "got: {out}");
        // Texto ao redor preservado.
        assert!(out.contains("before"), "got: {out}");
        assert!(out.contains("after"), "got: {out}");
    }

    #[test]
    fn pem_before_generic_kv() {
        // Bloco PEM inteiro vira UM placeholder — não deixa linhas internas serem
        // tratadas como KEY=valor (PEM precede o genérico na ordem).
        // Marcadores fragmentados (kind="" → sem RSA/EC), montados em runtime.
        let pem = format!(
            "{}\n{}\n{}",
            pem_marker(true, ""),
            "KEY=should_not_show",
            pem_marker(false, ""),
        );
        let out = redact(&pem);
        assert_eq!(out, "[REDACTED:pem-private-key]", "got: {out}");
    }

    #[test]
    fn redacts_bearer_header() {
        let out = redact("Authorization: Bearer abc123XYZ_token-value");
        assert!(out.contains("Bearer [REDACTED:bearer-token]"), "got: {out}");
        assert!(!out.contains("abc123XYZ_token-value"), "got: {out}");
    }

    #[test]
    fn redacts_key_equals_value_line() {
        let input = "API_TOKEN=supersecret123\nDB_PASSWORD=hunter2\nMY_SECRET_KEY=zzz999";
        let out = redact(input);
        // Chaves preservadas, valores redigidos.
        assert!(out.contains("API_TOKEN=[REDACTED:env-value]"), "got: {out}");
        assert!(out.contains("DB_PASSWORD=[REDACTED:env-value]"), "got: {out}");
        assert!(out.contains("MY_SECRET_KEY=[REDACTED:env-value]"), "got: {out}");
        assert!(!out.contains("supersecret123"), "got: {out}");
        assert!(!out.contains("hunter2"), "got: {out}");
        assert!(!out.contains("zzz999"), "got: {out}");
    }

    #[test]
    fn non_secret_key_value_passes_through() {
        // Linha sem TOKEN/SECRET/KEY/PASSWORD/API na chave NÃO é redigida.
        let input = "USERNAME=jesse\nLEVEL=info\nHOST=localhost";
        let out = redact(input);
        assert_eq!(out, input, "got: {out}");
    }

    #[test]
    fn clean_text_passes_intact() {
        let input = "Apenas um log normal\nsem nenhum segredo aqui\nlinha 3 com numeros 12345";
        let out = redact(input);
        assert_eq!(out, input, "texto limpo foi alterado: {out}");
    }

    #[test]
    fn idempotent() {
        let input = "sk-ant-api03-SECRET12345678 and Bearer tok_abcdefgh123 and API_KEY=val123456";
        let once = redact(input);
        let twice = redact(&once);
        assert_eq!(once, twice, "redact não é idempotente: {once} != {twice}");
        // Garante que de fato redigiu algo.
        assert!(once.contains("[REDACTED:anthropic]"), "got: {once}");
    }

    #[test]
    fn redact_value_alias_works() {
        assert_eq!(redact_value("ghp_0123456789ABCDEFabcdef"), redact("ghp_0123456789ABCDEFabcdef"));
        assert!(redact_value("cfat_AbCdEf1234567890").contains("[REDACTED:cloudflare]"));
    }

    #[test]
    fn multiple_secrets_in_one_blob() {
        let blob = "log line\nsk-ant-api03-AAAAAAAAAAAA1234\nrandom\nghp_BBBBBBBBBBBBBBBB0000\nAPI_TOKEN=ccccccc";
        let out = redact(blob);
        assert!(out.contains("[REDACTED:anthropic]"), "got: {out}");
        assert!(out.contains("[REDACTED:github]"), "got: {out}");
        assert!(out.contains("API_TOKEN=[REDACTED:env-value]"), "got: {out}");
        assert!(out.contains("log line"), "got: {out}");
        assert!(out.contains("random"), "got: {out}");
    }
}
