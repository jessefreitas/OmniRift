//! learn/tracks.rs — Catálogo canônico de trilhas embutidas no OmniRift (Fase 9 A2).
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LearnExercise {
    pub id: String,
    pub title: String,
    pub statement: String,
    pub goal: String,
    pub condition: String,
    pub hints: [String; 3],
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LearnTrack {
    pub id: String,
    pub label: String,
    pub emoji: String,
    pub exercises: Vec<LearnExercise>,
}

/// Devolve as trilhas embutidas compiladas no binário do OmniRift.
pub fn builtin_tracks() -> Vec<LearnTrack> {
    vec![
        LearnTrack {
            id: "sh".into(),
            label: "Shell / Bash".into(),
            emoji: "🐚".into(),
            exercises: vec![
                LearnExercise {
                    id: "hello-sum-sh".into(),
                    title: "Script de soma em shell".into(),
                    statement: "Crie um script `scripts/hello.sh` no projeto atual que receba DOIS números como argumentos e imprima a soma deles (só o número, numa linha). Ex.: `bash scripts/hello.sh 2 3` deve imprimir `5`.".into(),
                    goal: "Arquivo scripts/hello.sh que imprime a soma de dois argumentos numéricos.".into(),
                    condition: "bash scripts/hello.sh 2 3 | grep -q '^5$' && bash scripts/hello.sh 10 32 | grep -q '^42$'".into(),
                    hints: [
                        "Pense: como um script shell enxerga o que foi digitado depois do nome dele? E que operador do shell faz aritmética com inteiros?".into(),
                        "Os argumentos chegam como $1 e $2; aritmética se faz com $(( … )). Falta juntar isso num echo dentro de scripts/hello.sh.".into(),
                        "Solução: crie scripts/hello.sh com as linhas `#!/usr/bin/env bash` e `echo $(( $1 + $2 ))` (crie a pasta scripts/ antes, se não existir).".into(),
                    ],
                },
                LearnExercise {
                    id: "filter-ext-sh".into(),
                    title: "Filtrar arquivos por extensão".into(),
                    statement: "Crie um script `scripts/count_ext.sh` que receba uma extensão como argumento (ex: `txt`) e imprima a quantidade de arquivos com essa extensão no diretório atual.".into(),
                    goal: "Script scripts/count_ext.sh que conta arquivos pela extensão informada no primeiro argumento.".into(),
                    condition: "bash scripts/count_ext.sh md | grep -q '^[0-9]\\+$'".into(),
                    hints: [
                        "Como listar arquivos terminados com um sufixo no diretório atual? E que comando POSIX conta linhas?".into(),
                        "Use `find` ou `ls` combinado com `wc -l`.".into(),
                        "Solução: crie scripts/count_ext.sh com `find . -maxdepth 1 -name \"*.$1\" | wc -l`.".into(),
                    ],
                },
            ],
        },
        LearnTrack {
            id: "py".into(),
            label: "Python".into(),
            emoji: "🐍".into(),
            exercises: vec![
                LearnExercise {
                    id: "hello-json-py".into(),
                    title: "Leitor de JSON em Python".into(),
                    statement: "Crie um script `scripts/parse.py` que leia um arquivo JSON da entrada padrão (stdin) e imprima o valor da chave `name`.".into(),
                    goal: "Script scripts/parse.py que extrai a chave 'name' de um JSON vindo de stdin.".into(),
                    condition: "echo '{\"name\": \"OmniRift\"}' | python3 scripts/parse.py | grep -q '^OmniRift$'".into(),
                    hints: [
                        "Qual módulo da biblioteca padrão do Python lida com entrada padrão (sys) e JSON (json)?".into(),
                        "Use `json.load(sys.stdin)` para carregar os dados e acesse a chave `[\"name\"]`.".into(),
                        "Solução: crie scripts/parse.py com `import sys, json; data = json.load(sys.stdin); print(data['name'])`.".into(),
                    ],
                },
            ],
        },
        LearnTrack {
            id: "js".into(),
            label: "JavaScript / Node".into(),
            emoji: "🟨".into(),
            exercises: vec![
                LearnExercise {
                    id: "hello-env-js".into(),
                    title: "Variáveis de ambiente em Node".into(),
                    statement: "Crie um script `scripts/show_env.js` que imprima o valor da variável de ambiente `APP_ENV`.".into(),
                    goal: "Script scripts/show_env.js que imprime process.env.APP_ENV.".into(),
                    condition: "APP_ENV=production node scripts/show_env.js | grep -q '^production$'".into(),
                    hints: [
                        "Onde o Node expõe as variáveis de ambiente que o processo herdou do sistema operacional?".into(),
                        "Procure no objeto global `process.env`.".into(),
                        "Solução: crie scripts/show_env.js com `console.log(process.env.APP_ENV);`.".into(),
                    ],
                },
            ],
        },
        LearnTrack {
            id: "html".into(),
            label: "HTML / Web".into(),
            emoji: "🌐".into(),
            exercises: vec![
                LearnExercise {
                    id: "hello-semantic-html".into(),
                    title: "Página com tags semânticas".into(),
                    statement: "Crie um arquivo `index.html` com estrutura HTML5 contendo tags semânticas `<header>`, `<main>` e `<footer>`.".into(),
                    goal: "Arquivo index.html estruturado com header, main e footer.".into(),
                    condition: "grep -iq '<header>' index.html && grep -iq '<main>' index.html && grep -iq '<footer>' index.html".into(),
                    hints: [
                        "Pense nas tags semânticas do HTML5 para topo, conteúdo principal e rodapé.".into(),
                        "Basta criar as tags `<header></header>`, `<main></main>` e `<footer></footer>` dentro do seu `index.html`.".into(),
                        "Solução: crie `index.html` com `<!DOCTYPE html><html><body><header></header><main></main><footer></footer></body></html>`.".into(),
                    ],
                },
            ],
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tracks_sao_validas_e_tem_tres_dicas_cada() {
        let tracks = builtin_tracks();
        assert!(!tracks.is_empty());
        for tr in &tracks {
            assert!(!tr.id.is_empty());
            assert!(!tr.exercises.is_empty());
            for ex in &tr.exercises {
                assert!(!ex.id.is_empty());
                assert_eq!(ex.hints.len(), 3);
                assert!(!ex.hints[0].is_empty());
                assert!(!ex.hints[1].is_empty());
                assert!(!ex.hints[2].is_empty());
            }
        }
    }
}
