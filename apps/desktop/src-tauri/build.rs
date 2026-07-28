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
            let ext = if target.contains("windows") {
                ".exe"
            } else {
                ""
            };
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

    add_test_manifest();

    tauri_build::build()
}

/// Embute o manifesto do Windows NOS EXECUTÁVEIS DE TESTE.
///
/// `rustc-link-arg-tests` é a diretiva oficial do Cargo que atinge só os binários de
/// teste — o link do app de release não é tocado. Foi a peça que faltava: tentar pelo
/// `.cargo/config.toml` ou por `RUSTFLAGS` aplicaria a TUDO (e o cargo ainda quebra a
/// variável nos espaços do valor do manifesto).
///
/// Sem isso, `cargo test` no Windows morre com 0xc0000139 antes do primeiro teste
/// (tauri-apps/tauri#13419) e o alvo Windows fica sem cobertura nenhuma.
#[cfg(windows)]
fn add_test_manifest() {
    let manifest_path = PathBuf::from("windows-app-manifest.xml");

    let canonical = match manifest_path.canonicalize() {
        Ok(p) => p,
        // Falha-aberto: sem o manifesto os testes voltam a morrer no 0xc0000139, mas um
        // build-script que aborta deixaria o crate inteiro sem compilar.
        Err(e) => {
            println!("cargo:warning=manifest de teste do Windows não encontrado: {e}");
            return;
        }
    };

    // `\\?\` do canonicalize confunde o link.exe — o prefixo estendido não é aceito no
    // /MANIFESTINPUT. Some com ele.
    let path = canonical.display().to_string();
    let path = path.strip_prefix(r"\\?\").unwrap_or(&path);

    println!("cargo:rerun-if-changed={path}");
    println!("cargo:rustc-link-arg-tests=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg-tests=/MANIFESTINPUT:{path}");
}

#[cfg(not(windows))]
fn add_test_manifest() {}
