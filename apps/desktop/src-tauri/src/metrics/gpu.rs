//! Probe de GPU via `nvidia-smi` (NVIDIA). Degrada pra vazio em máquinas sem GPU
//! NVIDIA — AMD/Intel ficam pra depois. Roda no processo nativo (spawn de comando).

use std::collections::HashMap;
use std::process::Command;

use crate::proc_ext::NoWindow;
use super::GpuStats;

/// `nvidia-smi` está disponível? (decidido 1× no boot do sampler pra não spawnar
/// comando à toa em máquina sem NVIDIA).
pub fn nvidia_available() -> bool {
    Command::new("nvidia-smi")
        .arg("-L")
        .no_window()
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn f32_of(s: &str) -> f32 {
    s.trim().parse().unwrap_or(0.0)
}

/// Uma `GpuStats` por GPU. MiB → bytes. `[Not Supported]` vira 0.
pub fn probe_gpus() -> Vec<GpuStats> {
    let out = Command::new("nvidia-smi")
        .args([
            "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw",
            "--format=csv,noheader,nounits",
        ])
        .no_window()
        .output();
    let Ok(out) = out else { return Vec::new() };
    if !out.status.success() {
        return Vec::new();
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|line| {
            let f: Vec<&str> = line.split(',').map(str::trim).collect();
            if f.len() < 4 {
                return None;
            }
            let mib = |s: &str| (f32_of(s) as u64) * 1024 * 1024;
            Some(GpuStats {
                vendor: "NVIDIA".into(),
                name: f[0].to_string(),
                util_pct: f32_of(f[1]),
                vram_used: mib(f[2]),
                vram_total: mib(f[3]),
                temp_c: f.get(4).map(|x| f32_of(x)),
                power_w: f.get(5).map(|x| f32_of(x)),
            })
        })
        .collect()
}

/// VRAM por PID (compute-apps): map pid → bytes. Vazio se não suportado.
pub fn vram_by_pid() -> HashMap<u32, u64> {
    let mut m = HashMap::new();
    let out = Command::new("nvidia-smi")
        .args(["--query-compute-apps=pid,used_memory", "--format=csv,noheader,nounits"])
        .no_window()
        .output();
    let Ok(out) = out else { return m };
    if !out.status.success() {
        return m;
    }
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let f: Vec<&str> = line.split(',').map(str::trim).collect();
        if f.len() < 2 {
            continue;
        }
        if let Ok(pid) = f[0].parse::<u32>() {
            let mib: u64 = f[1].parse().unwrap_or(0);
            m.insert(pid, mib * 1024 * 1024);
        }
    }
    m
}
