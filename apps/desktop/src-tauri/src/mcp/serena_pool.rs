//! Pool de subprocessos **Serena** (MCP server de análise semântica via LSP),
//! keyed por raiz de projeto.
//!
//! Cada projeto aberto no OmniRift reusa UM subprocesso Serena (não 1 por arquivo).
//! Regras:
//!   - **Teto de 3 instâncias** simultâneas. Cheio → faz **evict LRU** (mata a menos
//!     recentemente usada) pra abrir espaço; se não houver candidato, recusa.
//!   - **Idle timeout de 5 min**: uma task de limpeza periódica mata instâncias sem
//!     uso há ≥ 5 min (libera o LSP, que é pesado).
//!   - Thread-safe via `Mutex<HashMap>`. Cada client é `Arc<Mutex<McpStdioClient>>`
//!     (compartilhado, serializado por chamada).
//!
//! O spawn usa `uvx --from serena-agent serena start-mcp-server --transport stdio
//! --context ide-assistant --project <root>`. `uvx` ausente (ou `serena` instalado)
//! → erro suave (nunca derruba o app). `.no_window()` em todo spawn (sem flash CMD
//! no Windows).

use crate::mcp::client::McpStdioClient;
use crate::proc_ext::NoWindow;
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::process::Command;
use tokio::sync::Mutex;

/// Teto de subprocessos Serena vivos ao mesmo tempo (memória: cada um sobe um LSP).
pub const MAX_INSTANCES: usize = 3;

/// Tempo sem uso até a task de limpeza matar uma instância.
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(5 * 60);

/// Intervalo da task de limpeza (varre instâncias ociosas).
const REAP_INTERVAL: Duration = Duration::from_secs(60);

/// Uma instância Serena no pool: o client + carimbo de último uso.
struct SerenaInstance {
    client: Arc<Mutex<McpStdioClient>>,
    last_used: Instant,
}

/// Pool keyed por raiz de projeto canonicalizada.
pub struct SerenaPool {
    /// project_root (canonical) → instância.
    instances: Arc<Mutex<HashMap<String, SerenaInstance>>>,
}

impl Default for SerenaPool {
    fn default() -> Self {
        Self::new()
    }
}

impl SerenaPool {
    /// Cria o pool e sobe a task de limpeza de ociosos (idle reaper).
    pub fn new() -> Self {
        let instances: Arc<Mutex<HashMap<String, SerenaInstance>>> =
            Arc::new(Mutex::new(HashMap::new()));
        Self::spawn_reaper(Arc::clone(&instances));
        Self { instances }
    }

    /// Task de fundo: a cada `REAP_INTERVAL`, mata instâncias ociosas há ≥ IDLE_TIMEOUT.
    fn spawn_reaper(instances: Arc<Mutex<HashMap<String, SerenaInstance>>>) {
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(REAP_INTERVAL).await;
                let mut map = instances.lock().await;
                let now = Instant::now();
                let stale: Vec<String> = map
                    .iter()
                    .filter(|(_, inst)| now.duration_since(inst.last_used) >= IDLE_TIMEOUT)
                    .map(|(k, _)| k.clone())
                    .collect();
                for key in stale {
                    if let Some(inst) = map.remove(&key) {
                        log::info!("[serena-pool] matando instância ociosa: {key}");
                        let client = inst.client;
                        // shutdown precisa de &mut → trava o client e mata.
                        tokio::spawn(async move {
                            client.lock().await.shutdown().await;
                        });
                    }
                }
            }
        });
    }

    /// Canonicaliza a raiz pra chave estável (resolve `.`/symlinks/relativos). Cai
    /// pro caminho cru se a canonicalização falhar (ex.: pasta não existe ainda).
    fn canonical_key(project_root: &str) -> String {
        std::fs::canonicalize(project_root)
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|_| project_root.to_string())
    }

    /// Reusa o client do projeto se já existe; senão spawna um novo (respeitando o
    /// teto + evict LRU). Atualiza `last_used`. Erro suave se uvx/serena ausente ou
    /// pool cheio sem candidato a evict.
    pub async fn get_or_spawn(
        &self,
        project_root: &str,
    ) -> Result<Arc<Mutex<McpStdioClient>>, String> {
        let key = Self::canonical_key(project_root);
        let mut map = self.instances.lock().await;

        // Reuso: já existe instância pra esse projeto.
        if let Some(inst) = map.get_mut(&key) {
            inst.last_used = Instant::now();
            return Ok(Arc::clone(&inst.client));
        }

        // Sem espaço → evict LRU (menos recentemente usada). Sem candidato → recusa.
        if map.len() >= MAX_INSTANCES {
            let lru = map
                .iter()
                .min_by_key(|(_, inst)| inst.last_used)
                .map(|(k, _)| k.clone());
            match lru {
                Some(victim) => {
                    if let Some(inst) = map.remove(&victim) {
                        log::info!("[serena-pool] evict LRU '{victim}' p/ abrir espaço a '{key}'");
                        let client = inst.client;
                        tokio::spawn(async move {
                            client.lock().await.shutdown().await;
                        });
                    }
                }
                None => {
                    return Err(format!(
                        "pool Serena cheio ({MAX_INSTANCES}) e sem candidato a evict"
                    ));
                }
            }
        }

        // Spawna novo subprocesso Serena pra esse projeto.
        let child = Self::spawn_serena(&key)?;
        let client = McpStdioClient::new(child)?;
        let client = Arc::new(Mutex::new(client));
        map.insert(
            key,
            SerenaInstance {
                client: Arc::clone(&client),
                last_used: Instant::now(),
            },
        );
        Ok(client)
    }

    /// Spawna `serena start-mcp-server ...` com stdin/stdout/stderr em pipe.
    /// Tenta o binário `serena` instalado; senão `uvx --from serena-agent serena`.
    /// Nenhum dos dois → erro suave.
    fn spawn_serena(project_root: &str) -> Result<tokio::process::Child, String> {
        let (command, prefix) = find_serena().ok_or_else(|| {
            "Serena indisponível: nem o binário `serena` nem `uvx` foram encontrados. \
             Instale o uv (https://docs.astral.sh/uv/) — o Serena baixa sozinho na 1ª execução."
                .to_string()
        })?;

        let mut cmd = Command::new(&command);
        for p in &prefix {
            cmd.arg(p);
        }
        cmd.args([
            "start-mcp-server",
            "--transport",
            "stdio",
            "--context",
            "ide-assistant",
            "--project",
            project_root,
            // Não abre a dashboard web do Serena a cada spawn.
            "--open-web-dashboard",
            "False",
        ]);
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .no_window();

        cmd.spawn()
            .map_err(|e| format!("falha ao spawnar Serena ({command}): {e}"))
    }

    /// Nº de instâncias vivas no pool (pra testes/observabilidade).
    pub async fn len(&self) -> usize {
        self.instances.lock().await.len()
    }

    /// Mata todas as instâncias (ex.: shutdown do app).
    pub async fn shutdown_all(&self) {
        let mut map = self.instances.lock().await;
        for (_, inst) in map.drain() {
            inst.client.lock().await.shutdown().await;
        }
    }
}

// ── Descoberta do runtime Serena (mirror do commands/mcp.rs, autocontido) ──────

#[cfg(unix)]
fn which(bin: &str) -> Option<String> {
    let out = std::process::Command::new("which").arg(bin).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let p = String::from_utf8_lossy(&out.stdout).lines().next()?.trim().to_string();
    if p.is_empty() { None } else { Some(p) }
}

#[cfg(windows)]
fn which(bin: &str) -> Option<String> {
    let out = std::process::Command::new("where").arg(bin).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let p = String::from_utf8_lossy(&out.stdout).lines().next()?.trim().to_string();
    if p.is_empty() { None } else { Some(p) }
}

/// Binário `serena` instalado (PATH ou uv tools).
fn serena_binary() -> Option<String> {
    if let Some(p) = which("serena") {
        return Some(p);
    }
    let home = home_dir()?;
    for c in [
        format!("{home}/.local/share/uv/tools/serena-agent/bin/serena"),
        format!("{home}/.local/bin/serena"),
    ] {
        if std::path::Path::new(&c).exists() {
            return Some(c);
        }
    }
    None
}

fn find_uvx() -> Option<String> {
    if let Some(p) = which("uvx") {
        return Some(p);
    }
    let home = home_dir()?;
    for c in [format!("{home}/.local/bin/uvx"), format!("{home}/.cargo/bin/uvx")] {
        if std::path::Path::new(&c).exists() {
            return Some(c);
        }
    }
    None
}

#[cfg(windows)]
fn home_dir() -> Option<String> {
    std::env::var("USERPROFILE").ok()
}

#[cfg(not(windows))]
fn home_dir() -> Option<String> {
    std::env::var("HOME").ok()
}

/// Como rodar o Serena MCP: (comando, args_prefixo). Binário direto, ou
/// `uvx --from serena-agent serena` (uvx baixa automaticamente na 1ª execução).
fn find_serena() -> Option<(String, Vec<String>)> {
    if let Some(bin) = serena_binary() {
        return Some((bin, vec![]));
    }
    if let Some(uvx) = find_uvx() {
        return Some((uvx, vec!["--from".into(), "serena-agent".into(), "serena".into()]));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Stdio;
    use tokio::process::Command as TokioCommand;

    /// Helper: cria uma instância de client falsa (subprocesso `cat`) pra popular o
    /// pool SEM depender de Serena/uvx. `cat` mantém stdin/stdout abertos.
    fn fake_client() -> Arc<Mutex<McpStdioClient>> {
        let child = TokioCommand::new("cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .expect("spawn cat");
        Arc::new(Mutex::new(McpStdioClient::new(child).expect("client")))
    }

    /// Insere manualmente uma instância no pool (bypass do spawn real do Serena).
    async fn insert_fake(pool: &SerenaPool, key: &str) -> Arc<Mutex<McpStdioClient>> {
        let client = fake_client();
        pool.instances.lock().await.insert(
            key.to_string(),
            SerenaInstance {
                client: Arc::clone(&client),
                last_used: Instant::now(),
            },
        );
        client
    }

    /// Keying: pedir o MESMO projeto duas vezes devolve o MESMO Arc (reuso, não respawn).
    #[tokio::test]
    async fn same_project_returns_same_arc() {
        let pool = SerenaPool::new();
        let key = "/tmp/omnirift-pool-test-proj-A";
        let first = insert_fake(&pool, key).await;

        let got = pool.get_or_spawn(key).await.expect("reuso");
        assert!(
            Arc::ptr_eq(&first, &got),
            "mesmo projeto deve reusar o mesmo Arc<Mutex<Client>>"
        );
        assert_eq!(pool.len().await, 1);
        pool.shutdown_all().await;
    }

    /// `get_or_spawn` atualiza `last_used` ao reusar (mantém a instância "quente").
    #[tokio::test]
    async fn reuse_updates_last_used() {
        let pool = SerenaPool::new();
        let key = "/tmp/omnirift-pool-test-proj-B";
        insert_fake(&pool, key).await;

        // força last_used pro passado
        {
            let mut map = pool.instances.lock().await;
            map.get_mut(key).unwrap().last_used = Instant::now() - Duration::from_secs(120);
        }
        let _ = pool.get_or_spawn(key).await.expect("reuso");
        let map = pool.instances.lock().await;
        let age = Instant::now().duration_since(map.get(key).unwrap().last_used);
        assert!(age < Duration::from_secs(5), "last_used deve ter sido renovado");
        drop(map);
        pool.shutdown_all().await;
    }

    /// Teto de 3: com 3 instâncias e um 4º projeto, o evict LRU mantém o total em 3
    /// e remove a menos recentemente usada (não estoura o teto).
    #[tokio::test]
    async fn cap_three_evicts_lru() {
        let pool = SerenaPool::new();

        // 3 instâncias com last_used escalonado: A é a mais antiga (vítima do LRU).
        for (i, key) in ["/tmp/pool-A", "/tmp/pool-B", "/tmp/pool-C"].iter().enumerate() {
            insert_fake(&pool, key).await;
            // A mais velho que B, B mais velho que C
            let mut map = pool.instances.lock().await;
            map.get_mut(*key).unwrap().last_used =
                Instant::now() - Duration::from_secs((3 - i) as u64 * 10);
        }
        assert_eq!(pool.len().await, MAX_INSTANCES);

        // Simula a lógica de evict que get_or_spawn faria pro 4º projeto, sem
        // depender do spawn real (uvx pode não estar no CI). Replicamos a regra:
        {
            let mut map = pool.instances.lock().await;
            assert!(map.len() >= MAX_INSTANCES);
            let victim = map
                .iter()
                .min_by_key(|(_, inst)| inst.last_used)
                .map(|(k, _)| k.clone())
                .unwrap();
            assert_eq!(victim, "/tmp/pool-A", "A (mais antigo) deve ser a vítima LRU");
            map.remove(&victim);
        }
        // Insere o 4º no lugar.
        insert_fake(&pool, "/tmp/pool-D").await;

        assert_eq!(pool.len().await, MAX_INSTANCES, "total nunca passa do teto");
        let map = pool.instances.lock().await;
        assert!(!map.contains_key("/tmp/pool-A"), "A foi evictado");
        assert!(map.contains_key("/tmp/pool-D"), "D entrou");
        drop(map);
        pool.shutdown_all().await;
    }

    /// Projetos diferentes ocupam slots diferentes (keying por raiz).
    #[tokio::test]
    async fn different_projects_different_slots() {
        let pool = SerenaPool::new();
        let a = insert_fake(&pool, "/tmp/proj-X").await;
        let b = insert_fake(&pool, "/tmp/proj-Y").await;
        assert!(!Arc::ptr_eq(&a, &b));
        assert_eq!(pool.len().await, 2);
        pool.shutdown_all().await;
    }
}
