//! Sampler — thread de fundo que amostra recursos, guarda um ring buffer (~60) e
//! emite `resource://sample` a cada tick (sub-fase A).

use std::collections::VecDeque;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use tauri::{AppHandle, Emitter};

use super::system::SystemProbe;
use super::ResourceSample;

const RING_CAP: usize = 60;

/// Empurra mantendo a janela: descarta o mais antigo quando passa de `cap`.
fn push_capped<T>(ring: &mut VecDeque<T>, item: T, cap: usize) {
    if ring.len() >= cap {
        ring.pop_front();
    }
    ring.push_back(item);
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub struct Sampler {
    ring: Arc<Mutex<VecDeque<ResourceSample>>>,
}

impl Default for Sampler {
    fn default() -> Self {
        Self::new()
    }
}

impl Sampler {
    pub fn new() -> Self {
        Self {
            ring: Arc::new(Mutex::new(VecDeque::with_capacity(RING_CAP))),
        }
    }

    /// Último sample (pro comando `metrics_snapshot`).
    pub fn latest(&self) -> Option<ResourceSample> {
        self.ring.lock().back().cloned()
    }

    /// Sobe a thread: a cada `interval`, mede o global e emite `resource://sample`.
    /// Falha de leitura nunca derruba a thread (sysinfo não entra em pânico aqui).
    pub fn start(&self, app: AppHandle, interval: Duration, manager: Arc<crate::pty::PtyManager>) {
        let ring = Arc::clone(&self.ring);
        std::thread::spawn(move || {
            let mut probe = SystemProbe::new();
            // nvidia-smi disponível? decidido 1× pra não spawnar comando em vão.
            let gpu_on = super::gpu::nvidia_available();
            // CPU% exige 2 leituras separadas por ≥ MINIMUM_CPU_UPDATE_INTERVAL.
            std::thread::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL.max(Duration::from_millis(200)));
            loop {
                let vram = if gpu_on { super::gpu::vram_by_pid() } else { std::collections::HashMap::new() };
                let agents = probe.sample_agents(&manager.session_pids(), &vram);
                let gpus = if gpu_on { super::gpu::probe_gpus() } else { Vec::new() };
                let sample = ResourceSample {
                    ts: now_ms(),
                    global: probe.sample(),
                    gpus,
                    agents,
                };
                push_capped(&mut ring.lock(), sample.clone(), RING_CAP);
                let _ = app.emit("resource://sample", &sample);
                std::thread::sleep(interval);
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ring_keeps_only_last_cap() {
        let mut ring: VecDeque<u32> = VecDeque::new();
        for i in 0..100 {
            push_capped(&mut ring, i, RING_CAP);
        }
        assert_eq!(ring.len(), RING_CAP, "mantém a janela de {RING_CAP}");
        assert_eq!(*ring.front().unwrap(), 100 - RING_CAP as u32, "o mais antigo é o 40");
        assert_eq!(*ring.back().unwrap(), 99, "o mais novo é o 99");
    }

    #[test]
    fn ring_under_cap_keeps_all() {
        let mut ring: VecDeque<u32> = VecDeque::new();
        for i in 0..10 {
            push_capped(&mut ring, i, RING_CAP);
        }
        assert_eq!(ring.len(), 10);
        assert_eq!(*ring.front().unwrap(), 0);
    }
}
