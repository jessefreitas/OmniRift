use std::{env, fs, path::PathBuf};

fn main() {
    // B1 — `cargo test`/`--debug` out-of-the-box em clone fresco.
    // Os sidecars (omnicompress-*, omnifs-mcp) NÃO são executados em teste/dev, mas o
    // tauri-build valida que os `externalBin` EXISTAM já na compilação. Como `binaries/`
    // é gitignored (só populado pela esteira de release), num clone limpo eles faltam e
    // `cargo test` quebrava no build-script. Aqui criamos STUBS VAZIOS quando ausentes —
    // SÓ em profile debug. No release, PROFILE=release → NÃO stubamos: a esteira roda
    // scripts/build-*.sh antes e exige os binários reais (stub aqui nunca mascara isso).
    if env::var("PROFILE").as_deref() == Ok("debug") {
        if let Ok(target) = env::var("TARGET") {
            let ext = if target.contains("windows") { ".exe" } else { "" };
            let dir = PathBuf::from("binaries");
            let _ = fs::create_dir_all(&dir);
            for name in [
                "omnicompress-proxy",
                "omnicompress-mcp",
                "omnicompress",
                "omnifs-mcp",
            ] {
                let stub = dir.join(format!("{name}-{target}{ext}"));
                if !stub.exists() {
                    let _ = fs::write(&stub, b""); // falha-aberto: erro de fs não quebra o build
                }
            }
        }
    }

    tauri_build::build()
}
