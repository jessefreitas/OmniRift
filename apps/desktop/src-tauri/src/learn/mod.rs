//! learn/ — Contrato Socrático do OmniPartner Aprender (Fase 9, fatia A1).
//!
//! O que a A0 deixou no front (lib/learn.ts::buildSocraticSystem) vira aqui a FONTE
//! DA VERDADE, testável: o system-prompt canônico + a garantia anti-vazamento. O
//! ponto da A1 é que "a solução não vaza antes do nível máximo" deixa de ser só
//! confiança num prompt interpolado e passa a ser uma função PURA com testes que
//! provam o contrato (nível 1-2 → sem solução; nível máximo → liberado).
//!
//! Boundaries (espelha health/ e turbo/):
//!   - funções PURAS (`socratic_system`, `response_leaks_solution`) — sem IO, sem
//!     State do Tauri; é o que os testes cobrem em isolamento.
//!   - `#[tauri::command]` finas (`learn_socratic_prompt`, `learn_check_leak`) — só
//!     adaptam tipos (`Vec<String>` → `&[&str]`) e delegam pras funções puras.

/// Nível máximo de dica. SÓ nele o tutor pode revelar a solução completa.
/// Espelha o `MAX_HINT_LEVEL` do front (learn-exercises.ts) — mantenha os dois iguais.
pub const MAX_HINT_LEVEL: u8 = 3;

/// Nº máximo de linhas de código dentro de um bloco cercado (```) que os níveis
/// baixos (1–2) toleram. O nível 2 permite ~1 linha de fragmento; um bloco maior que
/// isso já é entregar solução. Acima disso → vazamento.
const MAX_FRAGMENT_LINES: usize = 2;

/// Marcador curto demais (ex.: "sys") daria falso-positivo — só marcadores com
/// substância entram no teste anti-vazamento.
const MIN_MARKER_CHARS: usize = 4;

/// Monta o system-prompt Socrático CANÔNICO (contrato duro por nível de dica).
///
/// `hint_level` é clampeado em `1..=MAX_HINT_LEVEL`. A regra por nível é EXPLÍCITA e
/// inegociável no prompt:
///   - nível 1: só conceito/pergunta, NUNCA código (nem fragmento);
///   - nível 2: no máximo 1 linha de fragmento, NUNCA a solução completa;
///   - nível máximo: solução completa PERMITIDA, sempre com explicação.
///
/// `exercise_statement` é o contexto do exercício já montado pelo front (enunciado +
/// objetivo + a dica interna do nível atual) — vai literal no fim do prompt.
pub fn socratic_system(language: &str, hint_level: u8, exercise_statement: &str) -> String {
    let level = hint_level.clamp(1, MAX_HINT_LEVEL);
    let lang = match language.trim() {
        "" => "programação",
        l => l,
    };
    let can_reveal = level >= MAX_HINT_LEVEL;

    let rule_now = if can_reveal {
        "- NESTE nível (o máximo) você PODE mostrar a solução completa — mas EXPLIQUE cada parte dela, linha por linha."
    } else {
        "- NESTE nível você está PROIBIDO de entregar a solução pronta ou código completo. Guie com perguntas curtas que façam o aprendiz raciocinar."
    };

    let mut out = String::new();
    out.push_str("Você é o OmniPartner Aprender, um tutor Socrático de programação dentro do OmniRift.\n");
    out.push_str(&format!(
        "Está ensinando {lang} a um INICIANTE — contextualize conceitos, exemplos e vocabulário nessa linguagem.\n"
    ));
    out.push_str("Você está no diretório do projeto do aprendiz e pode citar arquivos reais dele.\n\n");

    out.push_str("REGRAS INVIOLÁVEIS (o método Socrático vale mais que a resposta rápida):\n");
    out.push_str(&format!("- Nível de dica atual: {level} de {MAX_HINT_LEVEL}.\n"));
    out.push_str(rule_now);
    out.push('\n');
    out.push_str("- Nível 1: SOMENTE perguntas orientadoras e conceitos; ZERO código, nem fragmento.\n");
    out.push_str("- Nível 2: aponte o caminho (comandos/ideias concretas) com fragmentos de NO MÁXIMO 1 linha; NUNCA a solução inteira.\n");
    out.push_str(&format!("- Nível {MAX_HINT_LEVEL} (o máximo): solução completa permitida, SEMPRE explicada.\n"));
    out.push_str("- Nunca pule níveis: se o aprendiz ainda não esgotou as dicas, não adiante a solução.\n");
    out.push_str("- Responda em PT-BR, curto (no máximo ~8 linhas). Uma ideia por vez.\n");
    out.push_str("- Você só CONVERSA: nada de executar comandos nem editar arquivos.\n\n");

    out.push_str("EXERCÍCIO ATUAL:\n");
    out.push_str(exercise_statement.trim());
    out
}

/// **Coração da A1** — heurística testável de vazamento da solução. Nos níveis ABAIXO
/// do máximo, o tutor não pode entregar a solução. Considera vazamento se:
///   (a) a resposta contém um bloco de código cercado (```) com MAIS de
///       `MAX_FRAGMENT_LINES` linhas de código, OU
///   (b) a resposta contém qualquer um dos `forbidden_markers` (ex.: a expressão
///       exata da solução do exercício), comparação case-insensitive.
///
/// No nível máximo (`>= MAX_HINT_LEVEL`) a solução é liberada por contrato → NUNCA
/// vaza. Errar pra "vazou" (superestimar) é aceitável: o front só re-prompta; errar
/// pra "não vazou" quebraria o método Socrático, então a régua é conservadora.
pub fn response_leaks_solution(resp: &str, hint_level: u8, forbidden_markers: &[&str]) -> bool {
    // Nível máximo: solução permitida por contrato.
    if hint_level >= MAX_HINT_LEVEL {
        return false;
    }
    // (b) marcadores proibidos (a solução canônica / tokens-crux do exercício).
    let hay = resp.to_lowercase();
    for m in forbidden_markers {
        let needle = m.trim().to_lowercase();
        if needle.chars().count() >= MIN_MARKER_CHARS && hay.contains(&needle) {
            return true;
        }
    }
    // (a) bloco de código longo = solução despejada.
    max_fenced_code_lines(resp) > MAX_FRAGMENT_LINES
}

/// Maior nº de linhas de CÓDIGO (não-vazias, sem contar as cercas ```) entre todos os
/// blocos cercados da resposta. 0 se não houver bloco cercado. Blocos não fechados
/// (``` sem fim) contam o que veio até o fim — melhor superestimar que deixar vazar.
fn max_fenced_code_lines(resp: &str) -> usize {
    let mut in_block = false;
    let mut cur = 0usize;
    let mut max = 0usize;
    for line in resp.lines() {
        if line.trim_start().starts_with("```") {
            if in_block {
                max = max.max(cur);
                cur = 0;
            }
            in_block = !in_block;
            continue;
        }
        if in_block && !line.trim().is_empty() {
            cur += 1;
        }
    }
    if in_block {
        max = max.max(cur);
    }
    max
}

/// Comando Tauri: monta o system-prompt Socrático canônico. O front (lib/learn.ts)
/// invoca ISTO em vez de interpolar o prompt no TS — o mesmo texto que os testes
/// anti-vazamento do backend cobrem. Puro; nunca falha.
#[tauri::command]
pub fn learn_socratic_prompt(language: String, hint_level: u8, statement: String) -> String {
    socratic_system(&language, hint_level, &statement)
}

/// Comando Tauri: roda o detector de vazamento após cada resposta do tutor. `true`
/// → o front substitui a resposta por um aviso e NÃO mostra o vazamento. Adapta o
/// `Vec<String>` do IPC pro `&[&str]` da função pura.
#[tauri::command]
pub fn learn_check_leak(resp: String, hint_level: u8, markers: Vec<String>) -> bool {
    let refs: Vec<&str> = markers.iter().map(String::as_str).collect();
    response_leaks_solution(&resp, hint_level, &refs)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Solução canônica do exercício "script de soma em shell" (o marcador-crux que
    // o front extrai da dica de nível máximo). Reusado nos cenários abaixo.
    const SUM_SOLUTION: &str = "echo $(( $1 + $2 ))";

    // ─────────────────────── anti-vazamento (o coração da A1) ───────────────────────

    #[test]
    fn conceptual_answer_level1_does_not_leak() {
        // Resposta 100% Socrática: só perguntas e conceito, zero código.
        let resp = "Boa pergunta! Como um script shell enxerga o que você digita depois do nome dele? \
                    E qual operador do shell faz contas com inteiros? Pense nisso e me diga o que achou.";
        assert!(!response_leaks_solution(resp, 1, &[SUM_SOLUTION]), "conceito puro não vaza");
    }

    #[test]
    fn full_solution_level1_leaks_via_marker() {
        // O tutor "adiantou" a solução exata no nível 1 → marcador crava o vazamento.
        let resp = format!("Fácil, é só fazer: {SUM_SOLUTION} dentro do arquivo.");
        assert!(response_leaks_solution(&resp, 1, &[SUM_SOLUTION]), "solução no nível 1 vaza");
    }

    #[test]
    fn same_solution_level3_does_not_leak() {
        // MESMA resposta, mas no nível máximo: liberado por contrato → NÃO vaza.
        let resp = format!("A solução é `{SUM_SOLUTION}`, e cada parte significa…");
        assert!(
            !response_leaks_solution(&resp, MAX_HINT_LEVEL, &[SUM_SOLUTION]),
            "no nível máximo a solução é permitida"
        );
    }

    #[test]
    fn big_code_block_level2_leaks_via_line_count() {
        // Bloco cercado com 4 linhas de código no nível 2, SEM marcador conhecido →
        // ainda assim é solução demais; o line-count pega.
        let resp = "Segue pronto:\n```bash\n#!/usr/bin/env bash\nmkdir -p scripts\ncd scripts\ncat > x.sh\n```\n";
        assert!(response_leaks_solution(resp, 2, &[]), "bloco de código grande vaza");
    }

    #[test]
    fn one_line_fragment_level2_is_allowed() {
        // Nível 2 permite fragmento de 1 linha; sem marcador de solução → não vaza.
        let resp = "Você está perto. Lembre que os argumentos chegam em `$1` e `$2`:\n```bash\n$(( ... ))\n```\nMonte o resto.";
        assert!(!response_leaks_solution(resp, 2, &[SUM_SOLUTION]), "1 linha é permitido no nível 2");
    }

    #[test]
    fn marker_match_is_case_insensitive() {
        let resp = "Basta escrever CONSOLE.LOG(NUMBER(PROCESS.ARGV[2]) + NUMBER(PROCESS.ARGV[3]))";
        let marker = "console.log(Number(process.argv[2]) + Number(process.argv[3]))";
        assert!(response_leaks_solution(resp, 1, &[marker]), "case não deve escapar do detector");
    }

    #[test]
    fn short_markers_are_ignored_no_false_positive() {
        // "sys" (3 chars) aparece na resposta, mas é curto demais pra ser marcador —
        // senão qualquer menção conceitual a "sys" bloquearia o tutor.
        let resp = "Procure pelo módulo sys; ele guarda os argumentos da linha de comando.";
        assert!(!response_leaks_solution(resp, 1, &["sys"]), "marcador curto não gera falso-positivo");
    }

    #[test]
    fn empty_markers_and_prose_never_leaks() {
        let resp = "Que comando clássico do Unix conta as linhas de um arquivo?";
        assert!(!response_leaks_solution(resp, 1, &[]), "prosa sem código e sem marcador nunca vaza");
    }

    #[test]
    fn level_above_max_is_treated_as_reveal() {
        // hint_level fora da faixa (>= máximo) → tratado como nível máximo (liberado).
        let resp = format!("Solução: {SUM_SOLUTION}");
        assert!(!response_leaks_solution(&resp, 99, &[SUM_SOLUTION]), "acima do máximo libera");
    }

    #[test]
    fn fenced_block_line_count_ignores_fences_and_blanks() {
        // 2 linhas de código (a régua tolera até MAX_FRAGMENT_LINES) → não vaza por
        // line-count; prova que cercas e linhas em branco não são contadas como código.
        let resp = "```\n\n#!/usr/bin/env bash\necho oi\n\n```";
        assert_eq!(max_fenced_code_lines(resp), 2);
        assert!(!response_leaks_solution(resp, 2, &[]), "2 linhas está no limite tolerado");
    }

    // ─────────────────────── system-prompt Socrático ───────────────────────

    #[test]
    fn socratic_system_low_level_forbids_code() {
        let p = socratic_system("Shell", 1, "Crie um script de soma.");
        assert!(p.contains("PROIBIDO"), "nível baixo tem a regra dura: {p}");
        assert!(p.contains("ZERO código"));
        assert!(p.contains("Nível de dica atual: 1 de 3"));
    }

    #[test]
    fn socratic_system_max_level_allows_solution() {
        let p = socratic_system("Python", MAX_HINT_LEVEL, "Some dois números.");
        assert!(p.contains("PODE mostrar a solução completa"), "nível máximo libera: {p}");
        assert!(p.contains("Nível de dica atual: 3 de 3"));
    }

    #[test]
    fn socratic_system_carries_language_and_statement() {
        let p = socratic_system("JavaScript", 2, "Leia um campo de um JSON.");
        assert!(p.contains("JavaScript"), "linguagem interpolada");
        assert!(p.contains("Leia um campo de um JSON."), "enunciado interpolado");
    }

    #[test]
    fn socratic_system_clamps_out_of_range_level() {
        // 0 → clampeado pra 1 (proíbe); 99 → clampeado pro máximo (libera).
        assert!(socratic_system("Shell", 0, "x").contains("1 de 3"));
        let hi = socratic_system("Shell", 99, "x");
        assert!(hi.contains("3 de 3"));
        assert!(hi.contains("PODE mostrar a solução completa"));
    }

    #[test]
    fn socratic_system_defaults_empty_language() {
        let p = socratic_system("   ", 1, "x");
        assert!(p.contains("ensinando programação"), "linguagem vazia vira genérica: {p}");
    }

    // ─────────────────────── wrappers de comando (adaptação de tipos) ───────────────────────

    #[test]
    fn learn_check_leak_command_delegates() {
        let markers = vec![SUM_SOLUTION.to_string()];
        assert!(learn_check_leak(format!("faça {SUM_SOLUTION}"), 1, markers.clone()));
        assert!(!learn_check_leak(format!("faça {SUM_SOLUTION}"), MAX_HINT_LEVEL, markers));
    }

    #[test]
    fn learn_socratic_prompt_command_delegates() {
        let a = learn_socratic_prompt("Shell".into(), 1, "Some dois números.".into());
        let b = socratic_system("Shell", 1, "Some dois números.");
        assert_eq!(a, b, "o comando é só um adaptador da função pura");
    }
}
