//! SystemProbe — leitura de CPU/RAM/swap/disco/rede via sysinfo (sub-fase A).

use std::collections::{HashMap, HashSet};
use std::time::Instant;

use sysinfo::{Disks, Networks, ProcessesToUpdate, System};

use super::{AgentStat, DiskStats, GlobalStats, NetStats};

/// De quanto em quanto tempo redescobrir os descendentes dos agentes. Entre uma descoberta e
/// outra, um filho NOVO (ex.: o agente acabou de abrir um MCP) só aparece no ciclo seguinte.
/// Troca consciente: até 10s de atraso pra notar filho novo custa muito menos que varrer o
/// /proc inteiro a cada segundo — que era 19% de um núcleo, 13,92% deles em syscall.
const TREE_TTL: std::time::Duration = std::time::Duration::from_secs(10);

pub struct SystemProbe {
    sys: System,
    disks: Disks,
    networks: Networks,
    last_net: Instant,
    /// Árvore de cada agente (raiz → raiz + descendentes), descoberta pela varredura completa.
    agent_tree: HashMap<u32, Vec<u32>>,
    /// Quando a árvore foi descoberta. `None` = nunca.
    tree_at: Option<Instant>,
    /// Raízes usadas pra montar o cache — se o conjunto muda, redescobre na hora.
    tree_roots: Vec<u32>,
}

impl SystemProbe {
    pub fn new() -> Self {
        let mut sys = System::new();
        // Primeira leitura de CPU/RAM (CPU% só fica válido no 2º refresh).
        sys.refresh_cpu_usage();
        sys.refresh_memory();
        Self {
            sys,
            disks: Disks::new_with_refreshed_list(),
            networks: Networks::new_with_refreshed_list(),
            last_net: Instant::now(),
            agent_tree: HashMap::new(),
            tree_at: None,
            tree_roots: Vec::new(),
        }
    }

    /// Uma amostra global. CPU% pressupõe que passou ≥ MINIMUM_CPU_UPDATE_INTERVAL
    /// desde a leitura anterior (o sampler garante isso).
    pub fn sample(&mut self) -> GlobalStats {
        self.sys.refresh_cpu_usage();
        self.sys.refresh_memory();

        let cpu_pct = self.sys.global_cpu_usage();
        let mem_used = self.sys.used_memory();
        let mem_total = self.sys.total_memory();
        let swap_used = self.sys.used_swap();
        let swap_total = self.sys.total_swap();

        // Disco: reaproveita a lista entre samples. Re-enumerar mounts/dispositivos a
        // cada segundo gerava syscalls e alocações mesmo sem qualquer mudança.
        self.disks.refresh(true);
        let (mut d_total, mut d_avail) = (0u64, 0u64);
        for d in self.disks.list() {
            d_total += d.total_space();
            d_avail += d.available_space();
        }
        let disk = DiskStats {
            used: d_total.saturating_sub(d_avail),
            total: d_total,
        };

        // Rede: bytes acumulados desde o último refresh ÷ tempo decorrido → bytes/s.
        self.networks.refresh(true);
        let elapsed = self.last_net.elapsed().as_secs_f64().max(0.001);
        self.last_net = Instant::now();
        let (mut rx, mut tx) = (0u64, 0u64);
        for (_iface, data) in self.networks.list() {
            rx += data.received();
            tx += data.transmitted();
        }
        let net = NetStats {
            rx_bytes_per_sec: (rx as f64 / elapsed) as u64,
            tx_bytes_per_sec: (tx as f64 / elapsed) as u64,
        };

        GlobalStats {
            cpu_pct,
            mem_used,
            mem_total,
            swap_used,
            swap_total,
            disk,
            net,
        }
    }

    /// Consumo por agente: soma CPU%/RSS do processo-raiz de cada sessão + descendentes.
    /// `label` fica vazio (o frontend resolve via id).
    pub fn sample_agents(&mut self, sessions: &[(String, u32)], vram_by_pid: &HashMap<u32, u64>) -> Vec<AgentStat> {
        if sessions.is_empty() { return Vec::new(); }

        let roots: Vec<u32> = sessions.iter().map(|(_, root)| *root).collect();

        // PT: Dois ritmos: topologia (cara, rara) descobre descendentes; métricas (barata, 1 Hz)
        // só refresca os PIDs já conhecidos. Filho novo aparece no próximo ciclo de topologia, com
        // atraso máximo de TREE_TTL — muito menor custo que varrer /proc inteiro a cada segundo.
        let needs_topology = self.tree_at.is_none()
            || self.tree_roots != roots
            || self.tree_at.map(|t| t.elapsed() >= TREE_TTL).unwrap_or(true);

        if needs_topology {
            self.sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);

            let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
            for (pid, p) in self.sys.processes() {
                if let Some(parent) = p.parent() {
                    children.entry(parent.as_u32()).or_default().push(pid.as_u32());
                }
            }

            self.agent_tree.clear();
            for root in &roots {
                let mut seen = HashSet::new();
                let mut stack = vec![*root];
                while let Some(pid) = stack.pop() {
                    if !seen.insert(pid) { continue; }
                    if let Some(kids) = children.get(&pid) {
                        stack.extend(kids);
                    }
                }
                let mut members: Vec<u32> = seen.into_iter().collect();
                if members.is_empty() {
                    members.push(*root);
                }
                self.agent_tree.insert(*root, members);
            }

            self.tree_at = Some(std::time::Instant::now());
            self.tree_roots = roots;
        } else {
            // PT: Métricas: refresca só os PIDs cacheados, evitando varrer /proc todo.
            let pids: Vec<sysinfo::Pid> = self.agent_tree
                .values()
                .flatten()
                .copied()
                .map(sysinfo::Pid::from_u32)
                .collect();
            if !pids.is_empty() {
                self.sys.refresh_processes(sysinfo::ProcessesToUpdate::Some(&pids), true);
            }
        }

        sessions.iter().map(|(sid, root)| {
            let mut cpu = 0.0f32;
            let mut rss = 0u64;
            let mut vram = 0u64;
            let members = self.agent_tree.get(root).cloned().unwrap_or_else(|| vec![*root]);
            for pid in &members {
                if let Some(p) = self.sys.process(sysinfo::Pid::from_u32(*pid)) {
                    cpu += p.cpu_usage();
                    rss += p.memory();
                }
                vram += vram_by_pid.get(pid).copied().unwrap_or(0);
            }
            AgentStat {
                session_id: sid.clone(),
                label: String::new(),
                pid: *root,
                cpu_pct: cpu,
                rss_bytes: rss,
                vram_bytes: if vram > 0 { Some(vram) } else { None },
            }
        }).collect()
    }
}
