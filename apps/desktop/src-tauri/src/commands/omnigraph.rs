//! OmniGraph — knowledge graph de código (comunidades Leiden + god nodes + arestas com
//! confidence EXTRACTED/INFERRED/AMBIGUOUS). O Arquiteto de Pipeline ANCORA o time na
//! arquitetura REAL do repo.
//!
//! A JOGADA: NÃO injetamos o MCP da engine nos agentes (isso os deixaria consultando o
//! grafo turn-a-turn). Em vez disso rodamos a análise pesada UMA vez, DESTILAMOS o
//! GRAPH_REPORT.md (~6KB — god nodes + comunidades + surprising connections + perguntas) e
//! injetamos o RELATÓRIO no prompt do Arquiteto. O time nasce espelhando a arquitetura real.
//!
//! Detecção/subprocess reusam os padrões já provados no app:
//! - binário: `crate::compress::find_sidecar` (exe-dir → ~/.cargo/bin → PATH), mesmo
//!   resolvedor do `find_omnifs_bin` (omnifs/mod.rs);
//! - fallback rodando o pacote python de terceiro por `uvx` (só se `uvx` existe no PATH) — mesmo
//!   truque do adapter Hermes (acp/mod.rs), que roda pacote python por `uvx`;
//! - spawn assíncrono tokio com `kill_on_drop` + timeout + `NoWindow`, igual ao `llm_via_cli`.
//!
//! Degrada limpo: sem a engine nem uvx → `omnigraph_available()==false` e `omnigraph_report`
//! devolve `Ok(None)` (o modal esconde a opção; nada trava).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::proc_ext::NoWindow;

/// O build re-extrai o repo inteiro (AST) + clustering; em repo grande — e no 1º `uvx`,
/// que baixa numpy/networkx — leva minutos. Timeout generoso.
const BUILD_TIMEOUT: Duration = Duration::from_secs(300);

/// Teto do relatório destilado injetado no prompt do Arquiteto (~6KB — cabe folgado sem
/// estourar o contexto).
const DISTILL_MAX_BYTES: usize = 6 * 1024;

/// Nome do relatório que a engine gera.
const REPORT_NAME: &str = "GRAPH_REPORT.md";

/// Nome do grafo CRU (node-link JSON do networkx) que a engine gera.
const GRAPH_JSON_NAME: &str = "graph.json";

// Diretórios de saída do binário externo `graphify` (pacote `graphifyy`) — o CLI grava
// `GRAPH_REPORT.md`/`graph.json` nesses nomes por default, então renomeá-los quebraria a
// leitura. Contrato da engine externa (como o `fuse` no OmniFS) — a MARCA é OmniGraph.
const ENGINE_OUT_DIR: &str = "graphify-out"; // engine externa (binário 'graphify' de terceiro) — a MARCA é OmniGraph
const ENGINE_DOT_DIR: &str = ".graphify"; // engine externa (binário 'graphify' de terceiro) — a MARCA é OmniGraph

/// Teto do graph.json que topamos ler pro WebView (F2, importer do canvas). O grafo de
/// entidade inteiro pode passar de centenas de MB — e a memória do projeto registra que
/// jogar o grafo INTEIRO no WebKitGTK o mata. O importer só extrai o DIGEST de comunidades,
/// mas segurar um JSON gigante numa String + cruzar o IPC + `JSON.parse` no WebView já é OOM.
/// Acima do teto → `Err` (o botão avisa "grafo grande demais" e nada trava).
///
/// ⚠️ 2026-07-03: baixado de 128 → 40 MB. Um repo guarda-chuva (checkout_asaas: Next+Vite+
/// Laravel+Python + node_modules não-ignorados pelo graphify) gerou um graph.json de 95 MB
/// (75k nós) que PASSAVA no teto antigo e travava o WebKitGTK do Jessé. 40 MB cobre repos
/// grandes razoáveis (o próprio OmniRift = 6 MB) e barra os monstros — que devem ser
/// importados por SUBPROJETO, não pela pasta-mãe inteira.
const GRAPH_JSON_MAX_BYTES: u64 = 40 * 1024 * 1024;

/// Como invocar a engine: binário direto (PATH/sidecar) ou via `uvx` (pacote python de
/// terceiro). O 2º caminho só existe quando o `uvx` está instalado.
enum OmniGraphLauncher {
    Bin(PathBuf),
    Uvx(PathBuf),
}

impl OmniGraphLauncher {
    /// (programa, args-prefixo) pra montar o `Command`. No modo uvx o prefixo roda o
    /// pacote python de terceiro como subprocesso.
    fn cmd(&self) -> (String, Vec<String>) {
        match self {
            OmniGraphLauncher::Bin(p) => (p.to_string_lossy().into_owned(), Vec::new()),
            OmniGraphLauncher::Uvx(p) => (
                p.to_string_lossy().into_owned(),
                // engine externa (binário 'graphify' de terceiro, pacote 'graphifyy', como o fuse no OmniFS) — a MARCA é OmniGraph
                vec!["--from".into(), "graphifyy".into(), "graphify".into()],
            ),
        }
    }
}

/// Resolve como rodar a engine: binário no PATH/sidecar → senão via `uvx`
/// (se existir). `None` = nem binário nem uvx disponíveis (indisponível).
fn resolve_launcher() -> Option<OmniGraphLauncher> {
    // engine externa (binário 'graphify' de terceiro no PATH/sidecar) — a MARCA é OmniGraph
    if let Some(bin) = crate::compress::find_sidecar("graphify") {
        return Some(OmniGraphLauncher::Bin(bin));
    }
    crate::compress::find_sidecar("uvx").map(OmniGraphLauncher::Uvx)
}

/// Caminhos onde o GRAPH_REPORT.md pode ter sido gerado (ordem de preferência):
/// cwd e os diretórios de saída da engine (`ENGINE_OUT_DIR`/`ENGINE_DOT_DIR`).
fn candidate_report_paths(cwd: &Path) -> Vec<PathBuf> {
    vec![
        cwd.join(REPORT_NAME),
        cwd.join(ENGINE_OUT_DIR).join(REPORT_NAME),
        cwd.join(ENGINE_DOT_DIR).join(REPORT_NAME),
    ]
}

/// 1º report existente entre os candidatos (None = nenhum gerado ainda).
fn find_existing_report(cwd: &Path) -> Option<PathBuf> {
    candidate_report_paths(cwd).into_iter().find(|p| p.is_file())
}

/// Caminhos onde o graph.json cru pode estar (default da engine no diretório de saída),
/// nos mesmos diretórios do report.
fn candidate_graph_json_paths(cwd: &Path) -> Vec<PathBuf> {
    vec![
        cwd.join(ENGINE_OUT_DIR).join(GRAPH_JSON_NAME),
        cwd.join(GRAPH_JSON_NAME),
        cwd.join(ENGINE_DOT_DIR).join(GRAPH_JSON_NAME),
    ]
}

/// 1º graph.json existente entre os candidatos (None = nenhum gerado ainda).
fn find_existing_graph_json(cwd: &Path) -> Option<PathBuf> {
    candidate_graph_json_paths(cwd)
        .into_iter()
        .find(|p| p.is_file())
}

/// true = dá pra rodar a engine (binário no PATH/sidecar OU `uvx` disponível). O modal
/// usa isto pra decidir se mostra o toggle "Ancorar na arquitetura real".
#[tauri::command]
pub fn omnigraph_available() -> bool {
    resolve_launcher().is_some()
}

/// Devolve o GRAPH_REPORT.md DESTILADO (~6KB) do repo em `cwd`, pro Arquiteto ANCORAR o
/// time na arquitetura real. Semântica:
/// - `cwd` vazio ou engine indisponível → `Ok(None)` (degrada limpo, o modal cai no modo
///   normal).
/// - Report recente já no disco (cwd / diretórios de saída da engine) → lê e destila (NÃO
///   re-builda — o build é caro).
/// - Senão roda a engine em modo `update <cwd>` (extração AST + clustering, sem LLM) com timeout de
///   300s e lê o report gerado. Falha do build → `Err` (o modal avisa e segue sem âncora).
#[tauri::command]
pub async fn omnigraph_report(cwd: String) -> Result<Option<String>, String> {
    let cwd = cwd.trim().to_string();
    if cwd.is_empty() {
        return Ok(None);
    }
    let Some(launcher) = resolve_launcher() else {
        return Ok(None);
    };
    let cwd_path = PathBuf::from(&cwd);

    // 1) Report já no disco → destila e devolve (não paga o build de novo).
    if let Some(rep) = find_existing_report(&cwd_path) {
        let md = read_report(&rep)?;
        return Ok(Some(distill_graph_report(&md, DISTILL_MAX_BYTES)));
    }

    // 2) Sem report → builda e lê o gerado.
    run_build(&launcher, &cwd_path).await?;
    let rep = find_existing_report(&cwd_path).ok_or_else(|| {
        "a engine rodou mas não gerou GRAPH_REPORT.md — repo sem código extraível?".to_string()
    })?;
    let md = read_report(&rep)?;
    Ok(Some(distill_graph_report(&md, DISTILL_MAX_BYTES)))
}

fn read_report(path: &Path) -> Result<String, String> {
    std::fs::read_to_string(path).map_err(|e| format!("ler {}: {e}", path.display()))
}

/// Lê o `graph.json` CRU do repo em `cwd` pro importer do canvas (F2) extrair as
/// comunidades Leiden. Ao contrário do `omnigraph_report`, **NÃO builda** — o canvas só
/// importa um grafo que já existe (o build vive no fluxo do Arquiteto). Semântica:
/// - `cwd` vazio / sem `graph.json` gerado → `Ok(None)` (o botão avisa "sem grafo").
/// - `graph.json` acima do teto (`GRAPH_JSON_MAX_BYTES`) → `Err` (grande demais pro WebView;
///   o botão mostra o aviso e nada trava).
/// - senão → `Ok(Some(conteúdo cru))`. O importer no WebView extrai só o digest de
///   comunidades (nomes + contagens + god nodes) — nunca joga o grafo inteiro no DOM.
#[tauri::command]
pub fn omnigraph_graph_json(cwd: String) -> Result<Option<String>, String> {
    let cwd = cwd.trim().to_string();
    if cwd.is_empty() {
        return Ok(None);
    }
    let cwd_path = PathBuf::from(&cwd);
    let Some(path) = find_existing_graph_json(&cwd_path) else {
        return Ok(None);
    };
    let size = std::fs::metadata(&path)
        .map_err(|e| format!("stat {}: {e}", path.display()))?
        .len();
    if size > GRAPH_JSON_MAX_BYTES {
        return Err(format!(
            "O grafo desse repo é grande demais ({} MB, teto {} MB) pra abrir no canvas sem \
             travar. Provável pasta guarda-chuva com muito código/vendor (node_modules?). \
             Abra um SUBPROJETO específico (uma subpasta com o código) em vez da pasta-mãe \
             inteira, ou use o relatório destilado do Arquiteto de Pipeline.",
            size / (1024 * 1024),
            GRAPH_JSON_MAX_BYTES / (1024 * 1024),
        ));
    }
    std::fs::read_to_string(&path)
        .map(Some)
        .map_err(|e| format!("ler {}: {e}", path.display()))
}

/// Roda a engine em modo `update <cwd>` (async tokio, `kill_on_drop` → sem leak de processo se o
/// timeout cancelar o wait; mesma lição do `cli_run`/`pty_kill`). `update` re-extrai o
/// código e regenera graph.json + GRAPH_REPORT.md sem precisar de LLM.
async fn run_build(launcher: &OmniGraphLauncher, cwd: &Path) -> Result<(), String> {
    let (prog, mut args) = launcher.cmd();
    args.push("update".into());
    args.push(cwd.to_string_lossy().into_owned());

    // Prioridade BAIXA (nice): o graphify usa cpu_count workers de AST (12 num host de
    // 12 cores) e, somado aos agentes Claude + UI, TRAVAVA a máquina no onboarding de um
    // repo grande (ex: 2.744 arquivos). `nice -n 15` faz o build CEDER CPU pro resto — a
    // UI e os agentes ficam responsivos; o grafo só demora um pouco mais. `update` não
    // expõe limite de workers, então controlamos pela prioridade do SO. Unix: `nice`
    // (coreutils) faz execvp → vira o próprio graphify (mesmo PID, kill_on_drop segue
    // valendo). Windows: roda direto (sem nice; o pico lá é aceitável).
    #[cfg(unix)]
    let (prog, args) = {
        let mut prefixed = vec!["-n".to_string(), "15".to_string(), prog];
        prefixed.extend(args);
        ("nice".to_string(), prefixed)
    };

    let mut cmd = tokio::process::Command::new(&prog);
    cmd.args(&args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .no_window();

    let child = cmd
        .spawn()
        .map_err(|e| format!("não consegui rodar `{prog}`: {e}"))?;
    let out = tokio::time::timeout(BUILD_TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| {
            format!(
                "a engine estourou o timeout de {}s (repo grande? processo finalizado)",
                BUILD_TIMEOUT.as_secs()
            )
        })?
        .map_err(|e| format!("falha lendo o output da engine: {e}"))?;

    if out.status.success() {
        return Ok(());
    }
    // Falhou: o stderr costuma explicar (sem código, pacote quebrado…). Resume pro toast.
    let stderr = String::from_utf8_lossy(&out.stderr);
    let stdout = String::from_utf8_lossy(&out.stdout);
    let src = if stderr.trim().is_empty() { stdout } else { stderr };
    let brief: String = src.trim().chars().take(500).collect();
    Err(format!("a engine (update) falhou ({}): {brief}", out.status))
}

/// Destila um GRAPH_REPORT.md pra caber em `max_bytes`, mantendo SÓ as seções centrais que
/// o Arquiteto precisa: God Nodes, Comunidades (nomes + tamanhos), Surprising Connections,
/// Suggested Questions e o Summary (nós/arestas + distribuição de confidence). O resto
/// (Corpus Check, Import Cycles, Knowledge Gaps…) é cortado.
///
/// Função PURA (sem IO/env) → testável. Invariante garantida: `saída.len() <= max_bytes`.
/// Estratégia: preâmbulo (o H1 e o que vier antes da 1ª seção) é a base; as seções centrais
/// entram por ORDEM DE IMPORTÂNCIA enquanto couberem no orçamento, e a saída é remontada na
/// ORDEM ORIGINAL do documento. Sem nenhuma seção reconhecida (formato estranho) → devolve o
/// md cru truncado (nunca volta vazio).
pub fn distill_graph_report(md: &str, max_bytes: usize) -> String {
    const NOTE: &str = "\n\n_[relatório OmniGraph destilado — só as seções centrais]_\n";

    // Preâmbulo = tudo antes da 1ª linha "## "; depois, cada "## " abre uma seção.
    let mut preamble = String::new();
    let mut sections: Vec<String> = Vec::new();
    for line in md.lines() {
        if line.starts_with("## ") {
            sections.push(String::new());
        }
        match sections.last_mut() {
            Some(s) => {
                s.push_str(line);
                s.push('\n');
            }
            None => {
                preamble.push_str(line);
                preamble.push('\n');
            }
        }
    }

    // Importância (menor = mais importante, cai por último no orçamento). Uma comunidade →
    // um floor/agente; god nodes → zona de review; por isso vêm primeiro. "communit" casa
    // tanto "Community Hubs" quanto "Communities".
    fn rank(section: &str) -> Option<u8> {
        let head = section.lines().next().unwrap_or("").to_lowercase();
        if head.contains("god node") {
            Some(0)
        } else if head.contains("communit") {
            Some(1)
        } else if head.contains("surprising") {
            Some(2)
        } else if head.contains("suggested") {
            Some(3)
        } else if head.contains("summary") {
            Some(4)
        } else {
            None
        }
    }

    // Seções centrais com seu índice de documento (pra remontar em ordem).
    let mut kept: Vec<(usize, u8)> = sections
        .iter()
        .enumerate()
        .filter_map(|(i, s)| rank(s).map(|r| (i, r)))
        .collect();

    // Formato não reconhecido → não perde o report: devolve o cru truncado.
    if kept.is_empty() {
        return truncate_on_boundary(md, max_bytes);
    }

    // Guloso por importância, respeitando o teto (a NOTE já entra no orçamento base).
    kept.sort_by_key(|&(_, r)| r);
    let base = preamble.len() + NOTE.len();
    let mut used = base;
    let mut include: Vec<usize> = Vec::new();
    for &(i, _) in &kept {
        let len = sections[i].len();
        if used + len <= max_bytes {
            used += len;
            include.push(i);
        }
    }

    // Remonta na ORDEM DO DOCUMENTO (leitura natural).
    include.sort_unstable();
    let mut out = preamble;
    for i in include {
        out.push_str(&sections[i]);
    }
    out.push_str(NOTE);

    // Safety: o preâmbulo sozinho pode estourar o teto → corta no boundary.
    truncate_on_boundary(&out, max_bytes)
}

/// Trunca `s` pra no máximo `max_bytes`, recuando até um char boundary (não corta UTF-8 no
/// meio — o report tem acento/emoji/box-drawing).
fn truncate_on_boundary(s: &str, max_bytes: usize) -> String {
    if s.len() <= max_bytes {
        return s.to_string();
    }
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    s[..end].to_string()
}

// ── F3.1 — Gate estrutural (blast-radius determinístico, sub-500ms, SEM LLM) ──────────
//
// A ideia: ANTES do review caro (LLM), casar os arquivos do diff com o grafo já no disco
// e medir o "raio de explosão" — quantos nós/comunidades a mudança toca, se cruza um god
// node (função-hub) e se mexe numa aresta AMBIGUOUS (acoplamento incerto). É barato: só lê
// o graph.json que o Arquiteto (F1) já gerou, faz path-match e conta grau. NÃO builda aqui —
// gate tem que ser rápido; sem grafo → impact vazio (`available:false`) e o Land segue.

/// Fração dos nós (por grau, o mais conectado) tratada como "god node" quando o graph.json
/// não traz a marcação explícita. ~2% = os hubs de verdade (as core abstractions do repo).
const GOD_NODE_TOP_FRACTION: f64 = 0.02;

/// Grau mínimo pra um nó ser candidato a god node no caminho por-grau. Evita que, em grafo
/// minúsculo/esparso, uma folha (grau 1) seja promovida a "hub" só por estar no top-2%.
const GOD_NODE_MIN_DEGREE: usize = 2;

/// Impacto estrutural de um conjunto de arquivos alterados, medido contra o graph.json.
/// Serializado camelCase pro cliente TS (routines.ts / omnigraph-client.ts). `available:false`
/// = sem grafo no disco (o gate degrada pra "passa", nunca bloqueia sem dado).
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphImpact {
    /// Havia um graph.json legível? false → o gate não tem base pra decidir (não bloqueia).
    pub available: bool,
    /// Nº de nós (entidades) do grafo cujos arquivos-fonte casam com o diff.
    pub nodes_affected: usize,
    /// Comunidades Leiden tocadas (ids únicos, ordenados).
    pub communities_touched: Vec<i64>,
    /// Labels dos god nodes (funções-hub) tocados pelo diff.
    pub god_nodes_touched: Vec<String>,
    /// Arestas AMBIGUOUS (acoplamento incerto) que o diff toca — pro gate e pra afiar o review.
    pub ambiguous_edges_touched: Vec<GraphAmbiguousEdge>,
}

/// Uma aresta de baixa confiança tocada pelo diff (labels legíveis das duas pontas).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphAmbiguousEdge {
    pub source: String,
    pub target: String,
    /// Sempre "AMBIGUOUS" hoje (o campo deixa o cliente distinguir se um dia entrar INFERRED).
    pub confidence: String,
}

/// graph.json = node-link do networkx. `edges` no schema atual; `links` no legado (nx ≤ 3.1) —
/// o alias cobre os dois (mesmo remap que o `build.py` da engine faz).
#[derive(Debug, Deserialize)]
struct GraphJson {
    #[serde(default)]
    nodes: Vec<GraphNode>,
    #[serde(default, alias = "links")]
    edges: Vec<GraphEdge>,
}

#[derive(Debug, Deserialize)]
struct GraphNode {
    id: String,
    #[serde(default)]
    label: Option<String>,
    #[serde(default)]
    source_file: Option<String>,
    #[serde(default)]
    community: Option<i64>,
    /// Marcações explícitas de hub (se o grafo já as trouxer, vencem o cálculo por grau).
    #[serde(default)]
    god: Option<bool>,
    #[serde(default)]
    is_god: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct GraphEdge {
    source: String,
    target: String,
    /// "EXTRACTED" (default da engine) | "INFERRED" | "AMBIGUOUS".
    #[serde(default)]
    confidence: Option<String>,
}

/// True se `graph_src` e `changed` apontam pro MESMO arquivo, respeitando fronteira de path
/// (não casa `foobar.rs` com `foo.rs`). Porte 1:1 do `_path_match` do `prs.py` da engine —
/// cobre repo-relativo vs. absoluto/prefixado dos dois lados.
fn path_match(graph_src: &str, changed: &str) -> bool {
    graph_src == changed
        || graph_src.ends_with(&format!("/{changed}"))
        || changed.ends_with(&format!("/{graph_src}"))
}

/// Grau (nº de arestas incidentes) de cada nó, a partir da lista de arestas. É a "degree
/// centrality" que define os god nodes.
fn edge_degrees(edges: &[GraphEdge]) -> HashMap<&str, usize> {
    let mut deg: HashMap<&str, usize> = HashMap::new();
    for e in edges {
        *deg.entry(e.source.as_str()).or_insert(0) += 1;
        *deg.entry(e.target.as_str()).or_insert(0) += 1;
    }
    deg
}

/// Ids dos god nodes: marcados explicitamente (`god`/`is_god == true`) vencem; senão os
/// top-~2% por grau (mín. 1), exigindo grau ≥ `GOD_NODE_MIN_DEGREE` pra não promover folha.
fn god_node_ids<'a>(nodes: &'a [GraphNode], degrees: &HashMap<&str, usize>) -> HashSet<&'a str> {
    let explicit: HashSet<&str> = nodes
        .iter()
        .filter(|n| n.god == Some(true) || n.is_god == Some(true))
        .map(|n| n.id.as_str())
        .collect();
    if !explicit.is_empty() {
        return explicit;
    }
    if nodes.is_empty() {
        return HashSet::new();
    }
    let k = std::cmp::max(1, ((nodes.len() as f64) * GOD_NODE_TOP_FRACTION).ceil() as usize);
    let mut ranked: Vec<(&str, usize)> = nodes
        .iter()
        .map(|n| (n.id.as_str(), degrees.get(n.id.as_str()).copied().unwrap_or(0)))
        .filter(|&(_, d)| d >= GOD_NODE_MIN_DEGREE)
        .collect();
    // Grau desc; empate por id asc → determinístico (mesmo top-k sempre).
    ranked.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(b.0)));
    ranked.into_iter().take(k).map(|(id, _)| id).collect()
}

/// Núcleo PURO do gate (sem IO): casa `changed_files` com o grafo e devolve o blast-radius.
/// Testável isolado; `omnigraph_impact` é só o wrapper que lê o graph.json do disco.
fn compute_impact(graph: &GraphJson, changed_files: &[String]) -> GraphImpact {
    // Índice source_file → nós (mesma estratégia O(nós+arquivos) do compute_pr_impact do prs.py).
    let mut file_nodes: HashMap<&str, Vec<&str>> = HashMap::new();
    let mut node_community: HashMap<&str, i64> = HashMap::new();
    let mut node_label: HashMap<&str, &str> = HashMap::new();
    for n in &graph.nodes {
        let id = n.id.as_str();
        node_label.insert(id, n.label.as_deref().unwrap_or(id));
        if let Some(c) = n.community {
            node_community.insert(id, c);
        }
        if let Some(src) = n.source_file.as_deref() {
            if !src.is_empty() {
                file_nodes.entry(src).or_default().push(id);
            }
        }
    }

    // Casa o diff com os source_file dos nós (guarda `matched` evita recontar o mesmo arquivo).
    let mut affected: HashSet<&str> = HashSet::new();
    let mut matched: HashSet<&str> = HashSet::new();
    for cf in changed_files {
        let cf = cf.trim();
        if cf.is_empty() {
            continue;
        }
        for (src, ids) in &file_nodes {
            if !matched.contains(src) && path_match(src, cf) {
                matched.insert(src);
                for id in ids {
                    affected.insert(id);
                }
            }
        }
    }

    // Comunidades tocadas (únicas, ordenadas).
    let mut communities: Vec<i64> = affected
        .iter()
        .filter_map(|id| node_community.get(id).copied())
        .collect();
    communities.sort_unstable();
    communities.dedup();

    // God nodes tocados (labels, únicos, ordenados).
    let degrees = edge_degrees(&graph.edges);
    let gods = god_node_ids(&graph.nodes, &degrees);
    let mut god_nodes: Vec<String> = affected
        .iter()
        .filter(|id| gods.contains(*id))
        .map(|id| node_label.get(id).copied().unwrap_or(id).to_string())
        .collect();
    god_nodes.sort();
    god_nodes.dedup();

    // Arestas AMBIGUOUS que o diff toca: ≥1 ponta num nó afetado (editar um lado de um
    // acoplamento incerto JÁ é o sinal de risco — não exigimos as duas pontas no diff).
    let mut ambiguous: Vec<GraphAmbiguousEdge> = graph
        .edges
        .iter()
        .filter(|e| e.confidence.as_deref() == Some("AMBIGUOUS"))
        .filter(|e| affected.contains(e.source.as_str()) || affected.contains(e.target.as_str()))
        .map(|e| GraphAmbiguousEdge {
            source: node_label
                .get(e.source.as_str())
                .copied()
                .unwrap_or(e.source.as_str())
                .to_string(),
            target: node_label
                .get(e.target.as_str())
                .copied()
                .unwrap_or(e.target.as_str())
                .to_string(),
            confidence: "AMBIGUOUS".to_string(),
        })
        .collect();
    ambiguous.sort_by(|a, b| a.source.cmp(&b.source).then_with(|| a.target.cmp(&b.target)));
    ambiguous.dedup_by(|a, b| a.source == b.source && a.target == b.target);

    GraphImpact {
        available: true,
        nodes_affected: affected.len(),
        communities_touched: communities,
        god_nodes_touched: god_nodes,
        ambiguous_edges_touched: ambiguous,
    }
}

/// Gate estrutural do Land (F3.1): mede o blast-radius de `changed_files` contra o graph.json
/// já no disco de `cwd`. Rápido de propósito — **não builda** (sem grafo → `available:false`).
/// Semântica:
/// - `cwd` vazio / sem graph.json → `Ok(GraphImpact::default())` (`available:false` → o gate passa).
/// - graph.json acima do teto (`GRAPH_JSON_MAX_BYTES`) → também `available:false` (parsear um
///   JSON gigante estouraria o orçamento sub-500ms do gate; degrada pra "sem dado", não trava).
/// - senão → parseia e devolve o impacto. Erro de parse → `Err` (o cliente loga e deixa passar).
#[tauri::command]
pub fn omnigraph_impact(cwd: String, changed_files: Vec<String>) -> Result<GraphImpact, String> {
    let cwd = cwd.trim();
    if cwd.is_empty() {
        return Ok(GraphImpact::default());
    }
    let cwd_path = PathBuf::from(cwd);
    let Some(graph_path) = find_existing_graph_json(&cwd_path) else {
        return Ok(GraphImpact::default());
    };
    // Guarda de latência: acima do teto compartilhado, degrada pra "sem dado" (o gate NUNCA
    // bloqueia o Land por falta de base — só quando o grafo cabe e REPROVA de fato).
    if let Ok(meta) = std::fs::metadata(&graph_path) {
        if meta.len() > GRAPH_JSON_MAX_BYTES {
            return Ok(GraphImpact::default());
        }
    }
    let raw = std::fs::read_to_string(&graph_path)
        .map_err(|e| format!("ler {}: {e}", graph_path.display()))?;
    let graph: GraphJson =
        serde_json::from_str(&raw).map_err(|e| format!("parsear {}: {e}", graph_path.display()))?;
    Ok(compute_impact(&graph, &changed_files))
}

// ── F4a+c — REBUILD debounced no turn-done + alerta de dívida (god node emergente) ────
//
// O LOOP DE APRENDIZADO: quando um agente termina um turno, o front agenda (debounce ~90s,
// `scheduleGraphRebuild`) um `omnigraph_rebuild` — o grafo nunca fica velho sem custar um turno
// do agente. Ao FIM do rebuild comparamos os god nodes (funções-hub) com o rebuild anterior:
// um hub que NÃO existia antes = dívida arquitetural emergente → volta pro front notificar
// ("virou um hub, refatore?"). É o "c" do loop — o trabalho dos agentes revela a dívida sozinho.

/// Um god node (função-hub) que EMERGIU neste rebuild (não estava no baseline anterior).
/// Serializado camelCase pro front montar o toast de dívida ("N conexões — refatorar?").
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GodNodeAlert {
    /// Label legível do nó (nome da função/entidade que virou hub).
    pub label: String,
    /// Grau (nº de conexões incidentes) — o "N conexões" do aviso.
    pub degree: usize,
}

/// Caminho do baseline de god nodes de um projeto: `~/.omnirift/omnigraph-godnodes/<sha256(cwd)>.json`.
/// Mesmo padrão de slot-por-hash do `pipeline.rs` (não polui o repo do usuário; estável por cwd).
fn god_nodes_baseline_path(cwd: &str) -> Option<PathBuf> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()?;
    let mut h = Sha256::new();
    h.update(cwd.as_bytes());
    let hex = format!("{:x}", h.finalize());
    Some(
        Path::new(&home)
            .join(".omnirift")
            .join("omnigraph-godnodes")
            .join(format!("{hex}.json")),
    )
}

/// Núcleo PURO do alerta de dívida (sem IO): dados os god nodes ATUAIS (id, label, grau) e o
/// baseline anterior de ids, devolve os EMERGENTES ordenados por grau desc. `previous=None`
/// (1º rebuild, ainda sem baseline) → nunca alerta (evita spam no primeiro ciclo).
fn emergent_god_nodes(
    current: &[(String, String, usize)],
    previous: Option<&[String]>,
) -> Vec<GodNodeAlert> {
    let Some(prev) = previous else {
        return Vec::new();
    };
    let prev_set: HashSet<&str> = prev.iter().map(|s| s.as_str()).collect();
    let mut alerts: Vec<GodNodeAlert> = current
        .iter()
        .filter(|(id, _, _)| !prev_set.contains(id.as_str()))
        .map(|(_, label, degree)| GodNodeAlert {
            label: label.clone(),
            degree: *degree,
        })
        .collect();
    alerts.sort_by(|a, b| b.degree.cmp(&a.degree).then_with(|| a.label.cmp(&b.label)));
    alerts
}

/// Lê o grafo FRESCO (pós-rebuild), calcula os god nodes atuais, compara com o baseline
/// persistido (`emergent_god_nodes`), grava o baseline atualizado e devolve os emergentes.
/// Best-effort: qualquer falha de IO/parse → `vec![]` (o alerta nunca trava nem quebra o rebuild).
fn diff_god_nodes(cwd: &str, cwd_path: &Path) -> Vec<GodNodeAlert> {
    let Some(graph_path) = find_existing_graph_json(cwd_path) else {
        return Vec::new();
    };
    // Mesmo teto do gate — não parsear um JSON gigante só pra diff de hubs.
    if let Ok(meta) = std::fs::metadata(&graph_path) {
        if meta.len() > GRAPH_JSON_MAX_BYTES {
            return Vec::new();
        }
    }
    let Ok(raw) = std::fs::read_to_string(&graph_path) else {
        return Vec::new();
    };
    let Ok(graph) = serde_json::from_str::<GraphJson>(&raw) else {
        return Vec::new();
    };

    let degrees = edge_degrees(&graph.edges);
    let gods = god_node_ids(&graph.nodes, &degrees);
    let mut label: HashMap<&str, &str> = HashMap::new();
    for n in &graph.nodes {
        label.insert(n.id.as_str(), n.label.as_deref().unwrap_or(n.id.as_str()));
    }
    // (id, label, grau) atual — ids ordenados pra o baseline gravado ser determinístico.
    let mut current: Vec<(String, String, usize)> = gods
        .iter()
        .map(|id| {
            (
                (*id).to_string(),
                label.get(id).copied().unwrap_or(id).to_string(),
                degrees.get(id).copied().unwrap_or(0),
            )
        })
        .collect();
    current.sort_by(|a, b| a.0.cmp(&b.0));

    // Baseline anterior (lista de ids). Ausente = 1º rebuild.
    let baseline_path = god_nodes_baseline_path(cwd);
    let previous: Option<Vec<String>> = baseline_path
        .as_ref()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok());

    // Persiste o baseline atual (best-effort — a próxima comparação usa este).
    if let Some(p) = &baseline_path {
        if let Some(parent) = p.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let ids: Vec<&String> = current.iter().map(|(id, _, _)| id).collect();
        if let Ok(js) = serde_json::to_string(&ids) {
            let _ = std::fs::write(p, js);
        }
    }

    emergent_god_nodes(&current, previous.as_deref())
}

/// F4a — REBUILD do grafo no turn-done (debounced no front). Roda a engine (`update <cwd>`)
/// (mesmo launcher/timeout do F1) SÓ quando já existe um grafo no disco (opt-in por PRESENÇA —
/// o Arquiteto F1 gerou o 1º) E a engine está disponível. Sem grafo / sem launcher / cwd
/// vazio → `Ok(vec![])` no-op (degrade limpo — nunca paga o build num repo que o usuário nunca
/// ancorou, nunca trava o turno).
///
/// É `async` e aguarda o build (até 300s), mas o front chama FIRE-AND-FORGET (não bloqueia a
/// UI — mesmo padrão do `scheduleReindex`/`omnifs_index`). Ao terminar, devolve os god nodes
/// EMERGENTES (F4c) pro front notificar como dívida.
#[tauri::command]
pub async fn omnigraph_rebuild(cwd: String) -> Result<Vec<GodNodeAlert>, String> {
    let cwd = cwd.trim().to_string();
    if cwd.is_empty() {
        return Ok(Vec::new());
    }
    let Some(launcher) = resolve_launcher() else {
        return Ok(Vec::new());
    };
    let cwd_path = PathBuf::from(&cwd);
    // Opt-in por PRESENÇA: só re-buildamos um grafo que já existe (o F1 gera o 1º). Checagem
    // BARATA (só stat dos candidatos) — sem grafo = no-op imediato.
    if find_existing_graph_json(&cwd_path).is_none() {
        return Ok(Vec::new());
    }
    // Rebuild (await — mas o chamador não bloqueia; ver doc acima).
    run_build(&launcher, &cwd_path).await?;
    // F6 — auto-snapshot do graph.json fresco pro DIFF TEMPORAL (best-effort; naturalmente
    // "debounced" porque o rebuild já é debounced 90s no front). Falha (sem HOME, grafo grande)
    // → ignora: o snapshot é histórico de conveniência, nunca pode travar o rebuild.
    let _ = snapshot_graph_file(&cwd, &cwd_path);
    // Pós-rebuild: dívida emergente (god nodes novos vs baseline anterior).
    Ok(diff_god_nodes(&cwd, &cwd_path))
}

// ── F5 — MÚLTIPLAS VISÕES (front) + DIFF TEMPORAL (backend, a fusão OmniFS × OmniGraph) ────
//
// O DIFF é o "o que MUDOU na arquitetura" que o OmniFS dá pro código e o OmniGraph ainda não
// dava pra ESTRUTURA. Guardamos cópias do graph.json a cada rebuild (auto-snapshot acima) num
// slot-por-hash `~/.omnirift/omnigraph-history/<sha256(cwd)>/<ts>.json` (mesmo padrão de
// slot do pipeline.rs / god_nodes_baseline; NÃO polui o repo). Cap rotativo (20 — como o ledger
// do OmniFS), e o diff entre dois snapshots é PURO/testável: nós/arestas +/-, god nodes novos,
// e — o eixo que importa — ambiguidades RESOLVIDAS (AMBIGUOUS em A que sumiram/promoveram em B)
// e NOVAS. Degrada limpo: sem grafo → Err no snapshot (o chamador ignora), sem histórico → lista
// vazia. Nenhuma dessas features builda nada — só lê o que o loop F4 já mantém fresco.

/// Máx. de snapshots de graph.json guardados por projeto — rotaciona os mais velhos (mesma
/// ideia do ledger cap-500 do OmniFS, menor porque cada cópia é o grafo inteiro). 20 janelas
/// de rebuild dão histórico folgado pro diff temporal.
const GRAPH_SNAPSHOT_CAP: usize = 20;

/// Diretório de histórico de snapshots de um projeto: `~/.omnirift/omnigraph-history/<sha256(cwd)>/`.
/// Slot-por-hash estável (mesmo idioma do `god_nodes_baseline_path`) — não toca o repo do usuário.
fn omnigraph_history_dir(cwd: &str) -> Option<PathBuf> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()?;
    let mut h = Sha256::new();
    h.update(cwd.as_bytes());
    let hex = format!("{:x}", h.finalize());
    Some(
        Path::new(&home)
            .join(".omnirift")
            .join("omnigraph-history")
            .join(hex),
    )
}

/// Epoch em MILISSEGUNDOS (SystemTime, igual ao resto do OmniFS) — vira o nome do snapshot.
fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Um snapshot de graph.json no histórico (nome = epoch-ms; path completo). camelCase pro front.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphSnapshotInfo {
    /// Epoch em ms (o nome do arquivo, `<ts>.json`).
    pub ts: u64,
    pub path: String,
}

/// Uma aresta no diff (labels legíveis das duas pontas, em ordem canônica de id).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphDiffEdge {
    pub source: String,
    pub target: String,
}

/// Diferença estrutural entre dois graph.json (A = antes, B = depois). Tudo em LABELS legíveis,
/// ordenado e deduplicado (determinístico). camelCase pro cliente TS.
#[derive(Debug, Default, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphDiff {
    /// Nós presentes em B e não em A (arquitetura nova).
    pub added_nodes: Vec<String>,
    /// Nós presentes em A e não em B (arquitetura removida).
    pub removed_nodes: Vec<String>,
    /// Arestas presentes em B e não em A.
    pub added_edges: Vec<GraphDiffEdge>,
    /// Arestas presentes em A e não em B.
    pub removed_edges: Vec<GraphDiffEdge>,
    /// God nodes (funções-hub) que são hub em B mas não eram em A (dívida que surgiu).
    pub new_god_nodes: Vec<String>,
    /// Arestas que eram AMBIGUOUS em A e sumiram OU promoveram (EXTRACTED/INFERRED) em B — o loop
    /// F4b "limpou". É o sinal de PROGRESSO da arquitetura.
    pub resolved_ambiguous: Vec<GraphDiffEdge>,
    /// Arestas AMBIGUOUS em B que não eram AMBIGUOUS em A (acoplamento incerto que apareceu).
    pub new_ambiguous: Vec<GraphDiffEdge>,
}

/// Confiança normalizada de uma aresta (default engine = EXTRACTED). Espelha o `normConfidence`
/// do importer TS.
fn norm_conf(c: &Option<String>) -> &'static str {
    match c.as_deref() {
        Some("AMBIGUOUS") => "AMBIGUOUS",
        Some("INFERRED") => "INFERRED",
        _ => "EXTRACTED",
    }
}

/// id → label legível (label > id) de um grafo.
fn label_map(g: &GraphJson) -> HashMap<&str, &str> {
    g.nodes
        .iter()
        .map(|n| (n.id.as_str(), n.label.as_deref().unwrap_or(n.id.as_str())))
        .collect()
}

/// Chave de aresta NÃO-DIRECIONADA (ids ordenados) — A→B e B→A colapsam num par só.
fn edge_key(a: &str, b: &str) -> (String, String) {
    if a <= b {
        (a.to_string(), b.to_string())
    } else {
        (b.to_string(), a.to_string())
    }
}

/// Confiança + labels de uma aresta, já alinhados à ordem canônica da chave (pro diff legível).
struct EdgeInfo {
    conf: &'static str,
    src_label: String,
    tgt_label: String,
}

/// Mapa par-de-ids canônico → EdgeInfo de um grafo (última aresta do par vence — grafo de código
/// não costuma ter multiarestas com confidences distintas no mesmo par).
fn edge_info_map(g: &GraphJson, labels: &HashMap<&str, &str>) -> HashMap<(String, String), EdgeInfo> {
    let mut m = HashMap::new();
    for e in &g.edges {
        let key = edge_key(&e.source, &e.target);
        let src_lbl = labels
            .get(e.source.as_str())
            .copied()
            .unwrap_or(e.source.as_str())
            .to_string();
        let tgt_lbl = labels
            .get(e.target.as_str())
            .copied()
            .unwrap_or(e.target.as_str())
            .to_string();
        // Alinha os labels à ORDEM da chave (key.0 = menor id) pra o diff ser determinístico.
        let (src_label, tgt_label) = if key.0 == e.source {
            (src_lbl, tgt_lbl)
        } else {
            (tgt_lbl, src_lbl)
        };
        m.insert(
            key,
            EdgeInfo {
                conf: norm_conf(&e.confidence),
                src_label,
                tgt_label,
            },
        );
    }
    m
}

fn to_diff_edge(info: &EdgeInfo) -> GraphDiffEdge {
    GraphDiffEdge {
        source: info.src_label.clone(),
        target: info.tgt_label.clone(),
    }
}

fn sort_dedup_edges(mut v: Vec<GraphDiffEdge>) -> Vec<GraphDiffEdge> {
    v.sort_by(|a, b| a.source.cmp(&b.source).then_with(|| a.target.cmp(&b.target)));
    v.dedup();
    v
}

/// Núcleo PURO do diff (sem IO): compara dois grafos já parseados. Reusa `edge_degrees` +
/// `god_node_ids` (a MESMA lógica de hub do gate F3.1) e `norm_conf` (a MESMA do importer F2).
fn compute_diff(a: &GraphJson, b: &GraphJson) -> GraphDiff {
    let la = label_map(a);
    let lb = label_map(b);
    let ids_a: HashSet<&str> = a.nodes.iter().map(|n| n.id.as_str()).collect();
    let ids_b: HashSet<&str> = b.nodes.iter().map(|n| n.id.as_str()).collect();

    // Nós +/- (por id; apresentados por label).
    let mut added_nodes: Vec<String> = ids_b
        .iter()
        .filter(|id| !ids_a.contains(*id))
        .map(|id| lb.get(id).copied().unwrap_or(id).to_string())
        .collect();
    added_nodes.sort();
    added_nodes.dedup();
    let mut removed_nodes: Vec<String> = ids_a
        .iter()
        .filter(|id| !ids_b.contains(*id))
        .map(|id| la.get(id).copied().unwrap_or(id).to_string())
        .collect();
    removed_nodes.sort();
    removed_nodes.dedup();

    // Arestas +/- e transições de confiança (por par de ids não-direcionado).
    let ea = edge_info_map(a, &la);
    let eb = edge_info_map(b, &lb);

    let mut added_edges = Vec::new();
    let mut new_ambiguous = Vec::new();
    for (key, info) in &eb {
        let prev = ea.get(key);
        if prev.is_none() {
            added_edges.push(to_diff_edge(info));
        }
        // AMBIGUOUS em B, e não era AMBIGUOUS em A (nova aresta OU confiança piorou pra incerta).
        if info.conf == "AMBIGUOUS" && prev.map(|p| p.conf) != Some("AMBIGUOUS") {
            new_ambiguous.push(to_diff_edge(info));
        }
    }
    let mut removed_edges = Vec::new();
    let mut resolved_ambiguous = Vec::new();
    for (key, info) in &ea {
        let next = eb.get(key);
        if next.is_none() {
            removed_edges.push(to_diff_edge(info));
        }
        // Era AMBIGUOUS em A e sumiu OU promoveu (não-AMBIGUOUS) em B → RESOLVIDA (o loop limpou).
        if info.conf == "AMBIGUOUS" && next.map(|n| n.conf) != Some("AMBIGUOUS") {
            resolved_ambiguous.push(to_diff_edge(info));
        }
    }

    // God nodes emergentes (hub em B, não em A) — reusa a MESMA heurística do gate.
    let da = edge_degrees(&a.edges);
    let db = edge_degrees(&b.edges);
    let ga = god_node_ids(&a.nodes, &da);
    let gb = god_node_ids(&b.nodes, &db);
    let mut new_god_nodes: Vec<String> = gb
        .iter()
        .filter(|id| !ga.contains(*id))
        .map(|id| lb.get(id).copied().unwrap_or(id).to_string())
        .collect();
    new_god_nodes.sort();
    new_god_nodes.dedup();

    GraphDiff {
        added_nodes,
        removed_nodes,
        added_edges: sort_dedup_edges(added_edges),
        removed_edges: sort_dedup_edges(removed_edges),
        new_god_nodes,
        resolved_ambiguous: sort_dedup_edges(resolved_ambiguous),
        new_ambiguous: sort_dedup_edges(new_ambiguous),
    }
}

/// Lista os arquivos de snapshot (`<epoch-ms>.json`) de um diretório, ordenados ASC por ts.
/// Ignora arquivos com nome não-numérico. Dir ausente/ilegível → vazio.
fn list_snapshot_files(dir: &Path) -> Vec<(u64, PathBuf)> {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out: Vec<(u64, PathBuf)> = rd
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.is_file() && p.extension().and_then(|e| e.to_str()) == Some("json"))
        .filter_map(|p| {
            let ts = p
                .file_stem()
                .and_then(|s| s.to_str())
                .and_then(|s| s.parse::<u64>().ok())?;
            Some((ts, p))
        })
        .collect();
    out.sort_by_key(|(ts, _)| *ts);
    out
}

/// Rotaciona o histórico: mantém os `cap` mais recentes, apaga os mais velhos (best-effort).
fn prune_snapshots(dir: &Path, cap: usize) {
    let files = list_snapshot_files(dir);
    if files.len() <= cap {
        return;
    }
    for (_, p) in files.iter().take(files.len() - cap) {
        let _ = std::fs::remove_file(p);
    }
}

/// Copia o graph.json atual pro histórico (`<ts>.json`) e rotaciona. Falha limpa: sem grafo →
/// Err (o auto-snapshot ignora; o comando manual reporta). NÃO builda — só copia o que já existe.
fn snapshot_graph_file(cwd: &str, cwd_path: &Path) -> Result<PathBuf, String> {
    let Some(src) = find_existing_graph_json(cwd_path) else {
        return Err("nenhum graph.json pra snapshotar — rode o OmniGraph (Arquiteto ancorado) primeiro".into());
    };
    // Não copiar (nem manter ×20) um grafo gigante — mesmo teto do gate/importer.
    if let Ok(meta) = std::fs::metadata(&src) {
        if meta.len() > GRAPH_JSON_MAX_BYTES {
            return Err(format!(
                "graph.json tem {} MB (teto {} MB) — grande demais pra snapshotar",
                meta.len() / (1024 * 1024),
                GRAPH_JSON_MAX_BYTES / (1024 * 1024),
            ));
        }
    }
    let dir = omnigraph_history_dir(cwd).ok_or_else(|| "HOME indisponível".to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("criar histórico: {e}"))?;
    // Nome = epoch-ms; colisão no mesmo ms (rebuilds rápidos) → incrementa até vagar.
    let mut ts = now_millis();
    let mut dest = dir.join(format!("{ts}.json"));
    while dest.exists() {
        ts += 1;
        dest = dir.join(format!("{ts}.json"));
    }
    std::fs::copy(&src, &dest).map_err(|e| format!("copiar snapshot: {e}"))?;
    prune_snapshots(&dir, GRAPH_SNAPSHOT_CAP);
    Ok(dest)
}

fn load_graph(p: &Path) -> Result<GraphJson, String> {
    let raw = std::fs::read_to_string(p).map_err(|e| format!("ler {}: {e}", p.display()))?;
    serde_json::from_str(&raw).map_err(|e| format!("parsear {}: {e}", p.display()))
}

/// Garante que `p` está DENTRO de `dir` (canonicalizado) — trava leitura arbitrária via `..`
/// (mesmo espírito do fs-gate do OmniFS). Devolve o path canônico ou Err.
fn ensure_under(dir: &Path, p: &Path) -> Result<PathBuf, String> {
    let cp = std::fs::canonicalize(p)
        .map_err(|e| format!("snapshot inacessível {}: {e}", p.display()))?;
    let cd =
        std::fs::canonicalize(dir).map_err(|e| format!("histórico inacessível: {e}"))?;
    if !cp.starts_with(&cd) {
        return Err("snapshot fora do histórico deste projeto".into());
    }
    Ok(cp)
}

/// F5 — Tira um snapshot do graph.json atual pro histórico e devolve o path gravado. Manual
/// (a UI "comparar arquitetura" também deixa forçar); o auto-snapshot vive no `omnigraph_rebuild`.
#[tauri::command]
pub fn omnigraph_snapshot_graph(cwd: String) -> Result<String, String> {
    let cwd = cwd.trim().to_string();
    if cwd.is_empty() {
        return Err("cwd vazio".into());
    }
    let p = snapshot_graph_file(&cwd, &PathBuf::from(&cwd))?;
    Ok(p.to_string_lossy().into_owned())
}

/// F5 — Lista os snapshots de graph.json do projeto (mais RECENTE primeiro). Sem histórico →
/// `Ok(vec![])`. A UI usa isto pra deixar o usuário escolher A e B pro diff.
#[tauri::command]
pub fn omnigraph_list_snapshots(cwd: String) -> Result<Vec<GraphSnapshotInfo>, String> {
    let cwd = cwd.trim().to_string();
    if cwd.is_empty() {
        return Ok(Vec::new());
    }
    let Some(dir) = omnigraph_history_dir(&cwd) else {
        return Ok(Vec::new());
    };
    let mut files = list_snapshot_files(&dir);
    files.reverse(); // mais recente primeiro
    Ok(files
        .into_iter()
        .map(|(ts, p)| GraphSnapshotInfo {
            ts,
            path: p.to_string_lossy().into_owned(),
        })
        .collect())
}

/// F5 — DIFF TEMPORAL: compara dois snapshots (A = antes, B = depois) do histórico do projeto.
/// Os dois paths TÊM que estar dentro do histórico deste `cwd` (`ensure_under` — sem leitura
/// arbitrária). Erro de IO/parse → Err (a UI mostra o toast).
#[tauri::command]
pub fn omnigraph_diff(
    cwd: String,
    snapshot_path_a: String,
    snapshot_path_b: String,
) -> Result<GraphDiff, String> {
    let cwd = cwd.trim().to_string();
    let dir = omnigraph_history_dir(&cwd).ok_or_else(|| "HOME indisponível".to_string())?;
    let pa = ensure_under(&dir, Path::new(&snapshot_path_a))?;
    let pb = ensure_under(&dir, Path::new(&snapshot_path_b))?;
    let ga = load_graph(&pa)?;
    let gb = load_graph(&pb)?;
    Ok(compute_diff(&ga, &gb))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Report realista (mesmas seções do relatório real da engine): distila mantendo as centrais e
    /// cortando as periféricas.
    const SAMPLE: &str = "\
# Graph Report - projeto  (2026-07-02)

## Corpus Check
- 2 files · ~29 words
- Verdict: corpus is large enough.

## Summary
- 7 nodes · 10 edges · 2 communities
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS

## Community Hubs (Navigation)
- [[_COMMUNITY_a.py|a.py]]
- [[_COMMUNITY_Widget|Widget]]

## God Nodes (most connected - your core abstractions)
1. `Widget` - 4 edges
2. `foo()` - 3 edges

## Surprising Connections (you probably didn't know these)
- `main()` --calls--> `Widget`  [EXTRACTED]

## Import Cycles
- None detected.

## Communities (2 total)
- Community 1: auth (5 nodes)
- Community 2: rendering (3 nodes)

## Knowledge Gaps
- 2 thin communities omitted.

## Suggested Questions
- **Why does `Widget` bridge to `a.py`?**
";

    #[test]
    fn distill_keeps_core_sections_and_drops_periphery() {
        let out = distill_graph_report(SAMPLE, 6 * 1024);
        // Preâmbulo (H1) preservado.
        assert!(out.contains("# Graph Report - projeto"));
        // Seções centrais mantidas.
        assert!(out.contains("## God Nodes"), "god nodes: {out}");
        assert!(out.contains("## Community Hubs"), "hubs: {out}");
        assert!(out.contains("## Communities"), "communities: {out}");
        assert!(out.contains("## Surprising Connections"), "surprising: {out}");
        assert!(out.contains("## Suggested Questions"), "suggested: {out}");
        assert!(out.contains("## Summary"), "summary: {out}");
        // Confidence das arestas (EXTRACTED/…) sobrevive (vem no Summary + Surprising).
        assert!(out.contains("EXTRACTED"));
        // Tamanhos das comunidades sobrevivem.
        assert!(out.contains("5 nodes") && out.contains("3 nodes"));
        // Periféricas cortadas.
        assert!(!out.contains("## Corpus Check"), "corpus não devia entrar");
        assert!(!out.contains("## Import Cycles"), "cycles não devia entrar");
        assert!(!out.contains("## Knowledge Gaps"), "gaps não devia entrar");
        // Marca de destilado.
        assert!(out.contains("destilado"));
    }

    #[test]
    fn distill_respects_byte_budget_on_large_report() {
        // Report gigante: 400 seções de God Nodes fajutas de ~1KB cada (~400KB).
        let mut big = String::from("# Graph Report - huge  (2026-07-02)\n\n");
        for i in 0..400 {
            big.push_str(&format!("## God Nodes batch {i}\n"));
            big.push_str(&"x".repeat(1000));
            big.push('\n');
        }
        let max = 6 * 1024;
        let out = distill_graph_report(&big, max);
        assert!(out.len() <= max, "estourou o teto: {} > {max}", out.len());
        // Ainda assim entregou conteúdo útil (H1 + ao menos 1 seção).
        assert!(out.contains("# Graph Report - huge"));
        assert!(out.contains("## God Nodes batch"));
    }

    #[test]
    fn distill_multibyte_never_splits_char() {
        // Preâmbulo cheio de multibyte maior que o teto → corta no boundary, sem panic e
        // continua UTF-8 válido (String garante isso; o assert é a prova de que não truncou
        // no meio de um code point).
        let md = format!("# {}\n", "áç🧠".repeat(2000)); // sem seções "## " → caminho do fallback
        let out = distill_graph_report(&md, 64);
        assert!(out.len() <= 64);
        assert!(std::str::from_utf8(out.as_bytes()).is_ok());
    }

    #[test]
    fn distill_unrecognized_format_returns_truncated_raw() {
        let md = "só um texto sem cabeçalhos de seção nenhum";
        let out = distill_graph_report(md, 10);
        assert!(out.len() <= 10);
        assert!(md.starts_with(&out)); // é um prefixo do original (truncado)
    }

    #[test]
    fn launcher_uvx_cmd_prefixes_package() {
        let l = OmniGraphLauncher::Uvx(PathBuf::from("/home/x/.local/bin/uvx"));
        let (prog, args) = l.cmd();
        assert_eq!(prog, "/home/x/.local/bin/uvx");
        // engine externa (binário 'graphify' de terceiro) — a MARCA é OmniGraph
        assert_eq!(args, vec!["--from", "graphifyy", "graphify"]);
        // Binário direto: sem prefixo.
        // engine externa (binário 'graphify' de terceiro) — a MARCA é OmniGraph
        let b = OmniGraphLauncher::Bin(PathBuf::from("/usr/bin/graphify"));
        assert_eq!(b.cmd().1, Vec::<String>::new());
    }

    #[test]
    fn find_existing_graph_json_prefers_out_dir() {
        let dir = tempfile::tempdir().unwrap();
        // Nenhum grafo ainda.
        assert!(find_existing_graph_json(dir.path()).is_none());
        // graph.json no diretório de saída da engine é encontrado.
        let out = dir.path().join(ENGINE_OUT_DIR);
        std::fs::create_dir_all(&out).unwrap();
        std::fs::write(out.join(GRAPH_JSON_NAME), b"{}").unwrap();
        assert_eq!(
            find_existing_graph_json(dir.path()),
            Some(out.join(GRAPH_JSON_NAME))
        );
    }

    #[test]
    fn omnigraph_graph_json_none_when_empty_or_missing() {
        // cwd vazio → None (degrada limpo, sem tocar disco).
        assert_eq!(omnigraph_graph_json("   ".into()).unwrap(), None);
        // cwd sem graph.json → None.
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            omnigraph_graph_json(dir.path().to_string_lossy().into_owned()).unwrap(),
            None
        );
    }

    #[test]
    fn omnigraph_graph_json_reads_raw_when_present() {
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join(ENGINE_OUT_DIR);
        std::fs::create_dir_all(&out).unwrap();
        let raw = r#"{"nodes":[{"id":"a","community":0}],"links":[]}"#;
        std::fs::write(out.join(GRAPH_JSON_NAME), raw).unwrap();
        let got = omnigraph_graph_json(dir.path().to_string_lossy().into_owned()).unwrap();
        assert_eq!(got.as_deref(), Some(raw));
    }

    #[test]
    fn find_existing_report_prefers_out_dir() {
        let dir = tempfile::tempdir().unwrap();
        // Nenhum report ainda.
        assert!(find_existing_report(dir.path()).is_none());
        // Report no diretório de saída da engine é encontrado.
        let out = dir.path().join(ENGINE_OUT_DIR);
        std::fs::create_dir_all(&out).unwrap();
        std::fs::write(out.join(REPORT_NAME), b"# rep").unwrap();
        assert_eq!(find_existing_report(dir.path()), Some(out.join(REPORT_NAME)));
        // Report na raiz do cwd tem precedência (1º candidato).
        std::fs::write(dir.path().join(REPORT_NAME), b"# raiz").unwrap();
        assert_eq!(
            find_existing_report(dir.path()),
            Some(dir.path().join(REPORT_NAME))
        );
    }

    // ── F3.1 — gate estrutural ────────────────────────────────────────────────────────

    fn gnode(id: &str, label: &str, source_file: Option<&str>, community: Option<i64>) -> GraphNode {
        GraphNode {
            id: id.into(),
            label: Some(label.into()),
            source_file: source_file.map(Into::into),
            community,
            god: None,
            is_god: None,
        }
    }
    fn gedge(source: &str, target: &str, confidence: Option<&str>) -> GraphEdge {
        GraphEdge {
            source: source.into(),
            target: target.into(),
            confidence: confidence.map(Into::into),
        }
    }

    #[test]
    fn path_match_is_boundary_safe() {
        assert!(path_match("src/foo.rs", "src/foo.rs")); // idêntico
        assert!(path_match("a/b/src/foo.rs", "src/foo.rs")); // graph_src termina com /changed
        assert!(path_match("src/foo.rs", "repo/src/foo.rs")); // changed termina com /graph_src
        assert!(!path_match("src/foobar.rs", "foo.rs")); // NÃO casa: fronteira quebra
        assert!(!path_match("src/foo.rs", "bar.rs"));
    }

    #[test]
    fn degrees_count_both_endpoints() {
        let edges = vec![gedge("a", "b", None), gedge("a", "c", None)];
        let d = edge_degrees(&edges);
        assert_eq!(d.get("a"), Some(&2));
        assert_eq!(d.get("b"), Some(&1));
        assert_eq!(d.get("c"), Some(&1));
    }

    #[test]
    fn god_nodes_explicit_marks_win() {
        let nodes = vec![
            GraphNode { god: Some(true), ..gnode("a", "a", None, None) },
            gnode("b", "b", None, None),
        ];
        let g = god_node_ids(&nodes, &HashMap::new());
        assert!(g.contains("a") && !g.contains("b"));
    }

    #[test]
    fn god_nodes_top_fraction_needs_min_degree() {
        // Grafo esparso: 3 nós, só 1 hub (grau 2). Folhas (grau 1) NÃO viram god node.
        let nodes = vec![
            gnode("hub", "hub", None, None),
            gnode("leaf1", "leaf1", None, None),
            gnode("leaf2", "leaf2", None, None),
        ];
        let edges = vec![gedge("hub", "leaf1", None), gedge("hub", "leaf2", None)];
        let g = god_node_ids(&nodes, &edge_degrees(&edges));
        assert!(g.contains("hub"));
        assert!(!g.contains("leaf1") && !g.contains("leaf2"));
    }

    #[test]
    fn impact_end_to_end_god_community_ambiguous() {
        let graph = GraphJson {
            nodes: vec![
                gnode("auth.py::login", "login", Some("src/auth.py"), Some(1)),
                gnode("auth.py::logout", "logout", Some("src/auth.py"), Some(1)),
                gnode("ui.py::render", "render", Some("src/ui.py"), Some(2)),
                gnode("db.py::query", "query", Some("src/db.py"), Some(3)),
            ],
            edges: vec![
                gedge("auth.py::login", "db.py::query", Some("AMBIGUOUS")),
                gedge("auth.py::login", "auth.py::logout", Some("EXTRACTED")),
                gedge("auth.py::login", "ui.py::render", Some("EXTRACTED")),
            ],
        };
        // Muda src/auth.py → afeta login+logout (comunidade 1); login é o hub (grau 3);
        // a aresta login↔query é AMBIGUOUS e tem uma ponta afetada.
        let impact = compute_impact(&graph, &["src/auth.py".to_string()]);
        assert!(impact.available);
        assert_eq!(impact.nodes_affected, 2);
        assert_eq!(impact.communities_touched, vec![1]);
        assert_eq!(impact.god_nodes_touched, vec!["login".to_string()]);
        assert_eq!(impact.ambiguous_edges_touched.len(), 1);
        assert_eq!(impact.ambiguous_edges_touched[0].source, "login");
        assert_eq!(impact.ambiguous_edges_touched[0].target, "query");
    }

    #[test]
    fn impact_no_match_is_available_but_empty() {
        let graph = GraphJson {
            nodes: vec![gnode("a", "a", Some("src/a.py"), Some(0))],
            edges: vec![],
        };
        let impact = compute_impact(&graph, &["src/other.py".to_string()]);
        assert!(impact.available); // teve grafo → available, só não casou nada
        assert_eq!(impact.nodes_affected, 0);
        assert!(impact.communities_touched.is_empty());
        assert!(impact.god_nodes_touched.is_empty());
        assert!(impact.ambiguous_edges_touched.is_empty());
    }

    #[test]
    fn impact_ambiguous_edge_needs_only_one_endpoint_affected() {
        let graph = GraphJson {
            nodes: vec![
                gnode("x", "x", Some("src/x.py"), Some(0)),
                gnode("y", "y", Some("src/y.py"), Some(1)),
                gnode("z", "z", Some("src/z.py"), Some(2)),
            ],
            edges: vec![
                gedge("x", "y", Some("AMBIGUOUS")), // x afetado → conta
                gedge("y", "z", Some("AMBIGUOUS")), // nenhuma ponta afetada → não conta
            ],
        };
        let impact = compute_impact(&graph, &["src/x.py".to_string()]);
        assert_eq!(impact.ambiguous_edges_touched.len(), 1);
        assert_eq!(impact.ambiguous_edges_touched[0].source, "x");
    }

    #[test]
    fn graph_json_parses_links_alias() {
        // networkx ≤ 3.1 serializa as arestas como "links" — o alias tem que cobrir.
        let raw = r#"{"nodes":[{"id":"a","source_file":"a.py","community":0}],
                      "links":[{"source":"a","target":"a","confidence":"AMBIGUOUS"}]}"#;
        let g: GraphJson = serde_json::from_str(raw).unwrap();
        assert_eq!(g.nodes.len(), 1);
        assert_eq!(g.edges.len(), 1);
    }

    #[test]
    fn omnigraph_impact_empty_cwd_and_missing_graph_are_unavailable() {
        // cwd vazio → default (available:false), sem tocar disco.
        let imp = omnigraph_impact("  ".into(), vec![]).unwrap();
        assert!(!imp.available);
        // cwd sem graph.json → também available:false (gate passa).
        let dir = tempfile::tempdir().unwrap();
        let imp = omnigraph_impact(dir.path().to_string_lossy().into_owned(), vec!["a.py".into()])
            .unwrap();
        assert!(!imp.available);
    }

    #[test]
    fn omnigraph_impact_reads_graph_from_disk() {
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join(ENGINE_OUT_DIR);
        std::fs::create_dir_all(&out).unwrap();
        let raw = r#"{"nodes":[{"id":"m::f","label":"f","source_file":"src/m.py","community":7}],
                      "edges":[]}"#;
        std::fs::write(out.join(GRAPH_JSON_NAME), raw).unwrap();
        let imp = omnigraph_impact(
            dir.path().to_string_lossy().into_owned(),
            vec!["src/m.py".into()],
        )
        .unwrap();
        assert!(imp.available);
        assert_eq!(imp.nodes_affected, 1);
        assert_eq!(imp.communities_touched, vec![7]);
    }

    // ── F4a+c — rebuild debounced + alerta de dívida (god node emergente) ────────────────

    #[test]
    fn emergent_god_nodes_first_run_is_silent() {
        // 1º rebuild: sem baseline anterior → nunca alerta (evita spam de "N hubs novos").
        let current = vec![("a".into(), "A".into(), 5usize), ("b".into(), "B".into(), 3)];
        assert!(emergent_god_nodes(&current, None).is_empty());
    }

    #[test]
    fn emergent_god_nodes_returns_only_new_sorted_by_degree() {
        // Baseline tinha só "a"; agora "b"(grau 4) e "c"(grau 7) são novos → só eles alertam,
        // ordenados por grau desc (o hub mais pesado primeiro).
        let current = vec![
            ("a".into(), "A".into(), 9usize),
            ("b".into(), "B".into(), 4),
            ("c".into(), "C".into(), 7),
        ];
        let prev = vec!["a".to_string()];
        let out = emergent_god_nodes(&current, Some(&prev));
        assert_eq!(out.len(), 2);
        assert_eq!(out[0], GodNodeAlert { label: "C".into(), degree: 7 });
        assert_eq!(out[1], GodNodeAlert { label: "B".into(), degree: 4 });
    }

    #[test]
    fn emergent_god_nodes_empty_when_nothing_new() {
        let current = vec![("a".into(), "A".into(), 5usize)];
        let prev = vec!["a".to_string(), "z".to_string()];
        assert!(emergent_god_nodes(&current, Some(&prev)).is_empty());
    }

    #[test]
    fn god_nodes_baseline_path_is_stable_and_scoped() {
        // Sem HOME/USERPROFILE não dá pra formar o caminho — pula (ambiente de CI mínimo).
        let Some(p1) = god_nodes_baseline_path("/repo/alpha") else {
            return;
        };
        // Determinístico: mesmo cwd → mesmo slot.
        assert_eq!(Some(&p1), god_nodes_baseline_path("/repo/alpha").as_ref());
        // Escopo por projeto: cwd diferente → slot diferente.
        assert_ne!(Some(p1.clone()), god_nodes_baseline_path("/repo/beta"));
        // Fica sob ~/.omnirift/omnigraph-godnodes/ (não polui o repo).
        assert!(p1.to_string_lossy().contains("omnigraph-godnodes"));
        assert_eq!(p1.extension().and_then(|e| e.to_str()), Some("json"));
    }

    #[tokio::test]
    async fn omnigraph_rebuild_empty_cwd_is_noop() {
        // cwd vazio → Ok(vec![]) sem tocar disco/subprocess (degrade limpo).
        let out = omnigraph_rebuild("   ".into()).await.unwrap();
        assert!(out.is_empty());
    }

    // ── F5 — diff temporal + snapshots ───────────────────────────────────────────────────

    fn diff_edge(s: &str, t: &str) -> GraphDiffEdge {
        GraphDiffEdge { source: s.into(), target: t.into() }
    }

    #[test]
    fn edge_key_is_undirected() {
        // A→B e B→A colapsam na MESMA chave canônica (menor id primeiro).
        assert_eq!(edge_key("a", "b"), edge_key("b", "a"));
        assert_eq!(edge_key("b", "a"), ("a".into(), "b".into()));
    }

    #[test]
    fn norm_conf_defaults_to_extracted() {
        assert_eq!(norm_conf(&None), "EXTRACTED");
        assert_eq!(norm_conf(&Some("weird".into())), "EXTRACTED");
        assert_eq!(norm_conf(&Some("AMBIGUOUS".into())), "AMBIGUOUS");
        assert_eq!(norm_conf(&Some("INFERRED".into())), "INFERRED");
    }

    #[test]
    fn diff_added_and_removed_nodes() {
        let a = GraphJson {
            nodes: vec![gnode("x", "X", None, None), gnode("y", "Y", None, None)],
            edges: vec![],
        };
        let b = GraphJson {
            nodes: vec![gnode("y", "Y", None, None), gnode("z", "Z", None, None)],
            edges: vec![],
        };
        let d = compute_diff(&a, &b);
        assert_eq!(d.added_nodes, vec!["Z".to_string()]); // z só em B
        assert_eq!(d.removed_nodes, vec!["X".to_string()]); // x só em A
    }

    #[test]
    fn diff_resolved_and_new_ambiguous() {
        // A: login↔query AMBIGUOUS, a↔b EXTRACTED.
        // B: login↔query virou EXTRACTED (resolvida) e a↔c nova AMBIGUOUS.
        let a = GraphJson {
            nodes: vec![
                gnode("login", "login", None, None),
                gnode("query", "query", None, None),
                gnode("a", "a", None, None),
                gnode("b", "b", None, None),
                gnode("c", "c", None, None),
            ],
            edges: vec![
                gedge("login", "query", Some("AMBIGUOUS")),
                gedge("a", "b", Some("EXTRACTED")),
            ],
        };
        let b = GraphJson {
            nodes: vec![
                gnode("login", "login", None, None),
                gnode("query", "query", None, None),
                gnode("a", "a", None, None),
                gnode("b", "b", None, None),
                gnode("c", "c", None, None),
            ],
            edges: vec![
                gedge("login", "query", Some("EXTRACTED")), // promoveu → RESOLVIDA
                gedge("a", "b", Some("EXTRACTED")),
                gedge("a", "c", Some("AMBIGUOUS")), // nova incerta
            ],
        };
        let d = compute_diff(&a, &b);
        assert_eq!(d.resolved_ambiguous, vec![diff_edge("login", "query")]);
        assert_eq!(d.new_ambiguous, vec![diff_edge("a", "c")]);
        // a↔c é nova aresta também.
        assert_eq!(d.added_edges, vec![diff_edge("a", "c")]);
        assert!(d.removed_edges.is_empty());
    }

    #[test]
    fn diff_resolved_when_ambiguous_edge_vanishes() {
        // Aresta AMBIGUOUS some completamente em B → conta como resolvida E removida.
        let a = GraphJson {
            nodes: vec![gnode("m", "m", None, None), gnode("n", "n", None, None)],
            edges: vec![gedge("m", "n", Some("AMBIGUOUS"))],
        };
        let b = GraphJson {
            nodes: vec![gnode("m", "m", None, None), gnode("n", "n", None, None)],
            edges: vec![],
        };
        let d = compute_diff(&a, &b);
        assert_eq!(d.resolved_ambiguous, vec![diff_edge("m", "n")]);
        assert_eq!(d.removed_edges, vec![diff_edge("m", "n")]);
        assert!(d.new_ambiguous.is_empty());
    }

    #[test]
    fn diff_new_god_nodes_uses_hub_heuristic() {
        // A: hub tem grau 2. B: hub ganhou mais arestas e um 2º hub emerge.
        let a = GraphJson {
            nodes: vec![
                gnode("hub", "hub", None, None),
                gnode("l1", "l1", None, None),
                gnode("l2", "l2", None, None),
            ],
            edges: vec![gedge("hub", "l1", None), gedge("hub", "l2", None)],
        };
        let b = GraphJson {
            nodes: vec![
                gnode("hub", "hub", None, None),
                gnode("h2", "h2", None, None),
                gnode("l1", "l1", None, None),
                gnode("l2", "l2", None, None),
            ],
            // h2 agora também é hub (grau ≥2) — emerge em B.
            edges: vec![
                gedge("hub", "l1", None),
                gedge("hub", "l2", None),
                gedge("h2", "l1", None),
                gedge("h2", "l2", None),
            ],
        };
        let d = compute_diff(&a, &b);
        assert!(d.new_god_nodes.contains(&"h2".to_string()), "h2 devia emergir: {d:?}");
        assert!(!d.new_god_nodes.contains(&"hub".to_string()), "hub já era hub em A");
    }

    #[test]
    fn diff_identical_graphs_is_empty() {
        let g = GraphJson {
            nodes: vec![gnode("a", "a", None, None), gnode("b", "b", None, None)],
            edges: vec![gedge("a", "b", Some("EXTRACTED"))],
        };
        let g2 = GraphJson {
            nodes: vec![gnode("a", "a", None, None), gnode("b", "b", None, None)],
            edges: vec![gedge("a", "b", Some("EXTRACTED"))],
        };
        assert_eq!(compute_diff(&g, &g2), GraphDiff::default());
    }

    #[test]
    fn snapshot_history_dir_is_stable_and_scoped() {
        let Some(p1) = omnigraph_history_dir("/repo/alpha") else { return };
        assert_eq!(Some(&p1), omnigraph_history_dir("/repo/alpha").as_ref());
        assert_ne!(Some(p1.clone()), omnigraph_history_dir("/repo/beta"));
        assert!(p1.to_string_lossy().contains("omnigraph-history"));
    }

    #[test]
    fn list_snapshot_files_sorts_and_ignores_nonnumeric() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("30.json"), b"{}").unwrap();
        std::fs::write(dir.path().join("10.json"), b"{}").unwrap();
        std::fs::write(dir.path().join("20.json"), b"{}").unwrap();
        std::fs::write(dir.path().join("notes.json"), b"{}").unwrap(); // não-numérico: ignorado
        std::fs::write(dir.path().join("15.txt"), b"{}").unwrap(); // não-json: ignorado
        let files = list_snapshot_files(dir.path());
        let ts: Vec<u64> = files.iter().map(|(t, _)| *t).collect();
        assert_eq!(ts, vec![10, 20, 30]); // ASC, só numéricos .json
    }

    #[test]
    fn prune_snapshots_keeps_most_recent() {
        let dir = tempfile::tempdir().unwrap();
        for i in 1..=5u64 {
            std::fs::write(dir.path().join(format!("{i}.json")), b"{}").unwrap();
        }
        prune_snapshots(dir.path(), 3); // mantém 3, 4, 5
        let ts: Vec<u64> = list_snapshot_files(dir.path()).iter().map(|(t, _)| *t).collect();
        assert_eq!(ts, vec![3, 4, 5]);
    }

    #[test]
    fn omnigraph_list_snapshots_empty_cwd_is_empty() {
        assert!(omnigraph_list_snapshots("  ".into()).unwrap().is_empty());
    }

    #[test]
    fn omnigraph_diff_rejects_paths_outside_history() {
        // cwd real, mas paths apontando pra FORA do histórico → Err (ensure_under barra).
        let outside = tempfile::tempdir().unwrap();
        let f = outside.path().join("evil.json");
        std::fs::write(&f, r#"{"nodes":[],"edges":[]}"#).unwrap();
        let res = omnigraph_diff(
            "/repo/whatever".into(),
            f.to_string_lossy().into_owned(),
            f.to_string_lossy().into_owned(),
        );
        assert!(res.is_err(), "path fora do histórico devia ser rejeitado");
    }
}
