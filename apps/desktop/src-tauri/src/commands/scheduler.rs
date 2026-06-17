//! Agendador OS-level: exporta uma routine pra rodar via systemd (Linux) ou Task
//! Scheduler (Windows) — sobrevive a app fechado e a reboot. Roda o comando shell
//! na `cwd`, headless (output no journal/log do SO), independente do canvas.
//!
//! Pra evitar inferno de quoting, o comando vai pra um **script** em disco e o
//! agendador só aponta pro script.

use std::process::Command;

/// Slug seguro/estável pro nome da unit/task (alfanumérico + hífen, cap 40).
/// DEVE casar com o slug do frontend (scheduler-client.ts) pra detectar instalado.
fn slug(name: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' })
        .collect();
    let s = s.trim_matches('-').to_string();
    if s.is_empty() {
        "routine".into()
    } else {
        s.chars().take(40).collect()
    }
}

#[tauri::command]
pub fn scheduler_install(
    name: String,
    command: String,
    cwd: String,
    at_time: Option<String>,
    interval_min: Option<u32>,
) -> Result<String, String> {
    if cwd.trim().is_empty() {
        return Err("Defina a pasta do projeto (cwd) antes de agendar no SO.".into());
    }
    if at_time.is_none() && interval_min.is_none() {
        return Err("A routine precisa de horário (às HH:MM) ou intervalo pra agendar.".into());
    }
    let s = slug(&name);
    install_impl(&s, &name, &command, &cwd, at_time.as_deref(), interval_min)
}

#[tauri::command]
pub fn scheduler_uninstall(name: String) -> Result<String, String> {
    uninstall_impl(&slug(&name))
}

#[tauri::command]
pub fn scheduler_list() -> Result<Vec<String>, String> {
    list_impl()
}

// ── Linux: systemd user timer ────────────────────────────────────────────────
#[cfg(target_os = "linux")]
fn unit_dir() -> Result<std::path::PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "sem HOME".to_string())?;
    let dir = std::path::PathBuf::from(home).join(".config/systemd/user");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

#[cfg(target_os = "linux")]
fn systemctl(args: &[&str]) -> Result<String, String> {
    let out = Command::new("systemctl")
        .arg("--user")
        .args(args)
        .output()
        .map_err(|e| format!("systemctl indisponível: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

#[cfg(target_os = "linux")]
fn install_impl(
    slug: &str,
    name: &str,
    command: &str,
    cwd: &str,
    at_time: Option<&str>,
    interval_min: Option<u32>,
) -> Result<String, String> {
    let dir = unit_dir()?;
    let base = format!("omnirift-{slug}");
    let script = dir.join(format!("{base}.sh"));
    let body = format!("#!/bin/bash\ncd {cwd:?} || exit 1\n{command}\n");
    std::fs::write(&script, body).map_err(|e| e.to_string())?;
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755));
    }

    let service = format!(
        "[Unit]\nDescription=OmniRift routine: {name}\n\n[Service]\nType=oneshot\nWorkingDirectory={cwd}\nExecStart=/bin/bash {script}\n",
        script = script.display(),
    );
    std::fs::write(dir.join(format!("{base}.service")), service).map_err(|e| e.to_string())?;

    let on = if let Some(t) = at_time {
        format!("OnCalendar=*-*-* {t}:00\nPersistent=true")
    } else {
        format!("OnBootSec=2min\nOnUnitActiveSec={}min", interval_min.unwrap_or(30))
    };
    let timer = format!(
        "[Unit]\nDescription=OmniRift timer: {name}\n\n[Timer]\n{on}\n\n[Install]\nWantedBy=timers.target\n",
    );
    std::fs::write(dir.join(format!("{base}.timer")), timer).map_err(|e| e.to_string())?;

    systemctl(&["daemon-reload"])?;
    systemctl(&["enable", "--now", &format!("{base}.timer")])?;
    Ok(format!("Agendado no systemd: {base}.timer"))
}

#[cfg(target_os = "linux")]
fn uninstall_impl(slug: &str) -> Result<String, String> {
    let dir = unit_dir()?;
    let base = format!("omnirift-{slug}");
    let _ = systemctl(&["disable", "--now", &format!("{base}.timer")]);
    let _ = std::fs::remove_file(dir.join(format!("{base}.timer")));
    let _ = std::fs::remove_file(dir.join(format!("{base}.service")));
    let _ = std::fs::remove_file(dir.join(format!("{base}.sh")));
    systemctl(&["daemon-reload"])?;
    Ok(format!("Removido do systemd: {base}"))
}

#[cfg(target_os = "linux")]
fn list_impl() -> Result<Vec<String>, String> {
    let dir = unit_dir()?;
    let mut out = vec![];
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            let n = e.file_name().to_string_lossy().to_string();
            if let Some(rest) = n.strip_prefix("omnirift-").and_then(|x| x.strip_suffix(".timer")) {
                out.push(rest.to_string());
            }
        }
    }
    Ok(out)
}

// ── Windows: schtasks ────────────────────────────────────────────────────────
#[cfg(target_os = "windows")]
fn script_dir() -> Result<std::path::PathBuf, String> {
    let appdata = std::env::var("APPDATA").map_err(|_| "sem APPDATA".to_string())?;
    let dir = std::path::PathBuf::from(appdata).join("OmniRift").join("scheduler");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

#[cfg(target_os = "windows")]
fn install_impl(
    slug: &str,
    _name: &str,
    command: &str,
    cwd: &str,
    at_time: Option<&str>,
    interval_min: Option<u32>,
) -> Result<String, String> {
    let dir = script_dir()?;
    let script = dir.join(format!("omnirift-{slug}.cmd"));
    let body = format!("@echo off\r\ncd /d \"{cwd}\"\r\n{command}\r\n");
    std::fs::write(&script, body).map_err(|e| e.to_string())?;

    let tn = format!("OmniRift\\{slug}");
    let tr = format!("\"{}\"", script.display());
    let mut args: Vec<String> = vec![
        "/Create".into(), "/F".into(),
        "/TN".into(), tn.clone(),
        "/TR".into(), tr,
    ];
    if let Some(t) = at_time {
        args.extend(["/SC".into(), "DAILY".into(), "/ST".into(), t.to_string()]);
    } else {
        args.extend([
            "/SC".into(), "MINUTE".into(),
            "/MO".into(), interval_min.unwrap_or(30).to_string(),
        ]);
    }
    let out = Command::new("schtasks").args(&args).output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(format!("Agendado no Task Scheduler: {tn}"))
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

#[cfg(target_os = "windows")]
fn uninstall_impl(slug: &str) -> Result<String, String> {
    let tn = format!("OmniRift\\{slug}");
    let _ = Command::new("schtasks").args(["/Delete", "/F", "/TN", &tn]).output();
    if let Ok(dir) = script_dir() {
        let _ = std::fs::remove_file(dir.join(format!("omnirift-{slug}.cmd")));
    }
    Ok(format!("Removido do Task Scheduler: {tn}"))
}

#[cfg(target_os = "windows")]
fn list_impl() -> Result<Vec<String>, String> {
    let dir = script_dir()?;
    let mut out = vec![];
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            let n = e.file_name().to_string_lossy().to_string();
            if let Some(rest) = n.strip_prefix("omnirift-").and_then(|x| x.strip_suffix(".cmd")) {
                out.push(rest.to_string());
            }
        }
    }
    Ok(out)
}

// ── Outros SOs ───────────────────────────────────────────────────────────────
#[cfg(not(any(target_os = "linux", target_os = "windows")))]
fn install_impl(_: &str, _: &str, _: &str, _: &str, _: Option<&str>, _: Option<u32>) -> Result<String, String> {
    Err("Agendador OS-level só suportado em Linux e Windows.".into())
}
#[cfg(not(any(target_os = "linux", target_os = "windows")))]
fn uninstall_impl(_: &str) -> Result<String, String> {
    Err("Agendador OS-level só suportado em Linux e Windows.".into())
}
#[cfg(not(any(target_os = "linux", target_os = "windows")))]
fn list_impl() -> Result<Vec<String>, String> {
    Ok(vec![])
}

#[cfg(test)]
mod tests {
    use super::slug;
    #[test]
    fn slug_is_stable_and_safe() {
        assert_eq!(slug("Commit no fim do dia"), "commit-no-fim-do-dia");
        assert_eq!(slug("  !!!  "), "routine");
    }
}
