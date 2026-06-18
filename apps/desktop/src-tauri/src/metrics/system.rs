//! SystemProbe — leitura de CPU/RAM/swap/disco/rede via sysinfo (sub-fase A).

use std::collections::{HashMap, HashSet};
use std::time::Instant;

use sysinfo::{Disks, Networks, ProcessesToUpdate, System};

use super::{AgentStat, DiskStats, GlobalStats, NetStats};

pub struct SystemProbe {
    sys: System,
    networks: Networks,
    last_net: Instant,
}

impl SystemProbe {
    pub fn new() -> Self {
        let mut sys = System::new();
        // Primeira leitura de CPU/RAM (CPU% só fica válido no 2º refresh).
        sys.refresh_cpu_usage();
        sys.refresh_memory();
        Self {
            sys,
            networks: Networks::new_with_refreshed_list(),
            last_net: Instant::now(),
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

        // Disco: soma de todos os discos; usado = total − disponível.
        let disks = Disks::new_with_refreshed_list();
        let (mut d_total, mut d_avail) = (0u64, 0u64);
        for d in disks.list() {
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

    /// Consumo por agente: refresh dos processos e soma CPU%/RSS do processo-raiz
    /// de cada sessão + descendentes. `label` fica vazio (o frontend resolve via id).
    pub fn sample_agents(
        &mut self,
        sessions: &[(String, u32)],
        vram_by_pid: &HashMap<u32, u64>,
    ) -> Vec<AgentStat> {
        if sessions.is_empty() {
            return Vec::new();
        }
        self.sys.refresh_processes(ProcessesToUpdate::All, true);
        let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
        let mut stats: HashMap<u32, (f32, u64)> = HashMap::new();
        for (pid, p) in self.sys.processes() {
            let id = pid.as_u32();
            stats.insert(id, (p.cpu_usage(), p.memory()));
            if let Some(parent) = p.parent() {
                children.entry(parent.as_u32()).or_default().push(id);
            }
        }
        sessions
            .iter()
            .map(|(sid, root)| {
                let (mut cpu, mut rss, mut vram) = (0.0f32, 0u64, 0u64);
                let mut seen = HashSet::new();
                let mut stack = vec![*root];
                while let Some(pid) = stack.pop() {
                    if !seen.insert(pid) {
                        continue;
                    }
                    if let Some((c, m)) = stats.get(&pid) {
                        cpu += *c;
                        rss += *m;
                    }
                    vram += vram_by_pid.get(&pid).copied().unwrap_or(0);
                    if let Some(kids) = children.get(&pid) {
                        stack.extend(kids);
                    }
                }
                AgentStat {
                    session_id: sid.clone(),
                    label: String::new(),
                    pid: *root,
                    cpu_pct: cpu,
                    rss_bytes: rss,
                    vram_bytes: if vram > 0 { Some(vram) } else { None },
                }
            })
            .collect()
    }
}
