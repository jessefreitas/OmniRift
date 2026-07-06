//! Verdade sobre mounts FUSE — direto da tabela do kernel (`/proc/mounts`).
//!
//! POR QUE EXISTE: o app checava só "socket vivo" pra decidir se o daemon dele
//! servia o mount configurado. Em máquina com daemon OmniFS EXTERNO no mesmo
//! socket (power-user), provision/recover viravam no-op declarando sucesso —
//! sem nada montado. A tabela de mounts do kernel não mente: se o mount está
//! lá como FUSE, ALGUÉM o serve; se não está, nenhum "✓" é legítimo.
//!
//! Também define o socket DEDICADO da Pasta de Projetos (derivado do store),
//! pra nunca disputar o socket global com o daemon do usuário.

use std::path::{Path, PathBuf};

/// Decodifica os escapes OCTAIS de /proc/mounts (\040 = espaço, \011 = tab,
/// \134 = backslash) — o kernel escapa esses chars no campo do target.
fn unescape_mount_path(s: &str) -> String {
    let mut out: Vec<u8> = Vec::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\\' {
            let mut digits = String::new();
            for _ in 0..3 {
                match chars.peek() {
                    Some(c) if c.is_digit(8) => {
                        digits.push(*c);
                        chars.next();
                    }
                    _ => break,
                }
            }
            if digits.len() == 3 {
                if let Ok(byte) = u8::from_str_radix(&digits, 8) {
                    out.push(byte);
                    continue;
                }
            }
            // Se não deu para decodificar, devolve a barra e os dígitos literalmente.
            out.push(b'\\');
            out.extend(digits.bytes());
        } else {
            out.extend(ch.encode_utf8(&mut [0; 4]).bytes());
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// O `mount` aparece na tabela de mounts como filesystem FUSE?
/// `mounts_content` = conteúdo de /proc/mounts (injetado — testável).
/// Linha: "<source> <target> <fstype> <opts> 0 0"; fstype conta se == "fuse"
/// ou começa com "fuse." (fuse.omnifs etc).
pub fn fuse_mount_present_in(mounts_content: &str, mount: &Path) -> bool {
    let wanted = mount.to_string_lossy();
    let wanted = wanted.trim_end_matches('/');
    if wanted.is_empty() {
        return false;
    }
    for line in mounts_content.lines() {
        let mut fields = line.split_whitespace();
        let (Some(_src), Some(target), Some(fstype)) =
            (fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        if fstype != "fuse" && !fstype.starts_with("fuse.") {
            continue;
        }
        let decoded = unescape_mount_path(target);
        if decoded.trim_end_matches('/') == wanted {
            return true;
        }
    }
    false
}

/// Lê /proc/mounts e delega. Fora do unix (ou erro de leitura) → false.
#[cfg(unix)]
pub fn fuse_mount_present(mount: &Path) -> bool {
    std::fs::read_to_string("/proc/mounts")
        .map(|content| fuse_mount_present_in(&content, mount))
        .unwrap_or(false)
}
#[cfg(not(unix))]
pub fn fuse_mount_present(_mount: &Path) -> bool {
    false
}

/// Socket DEDICADO da Pasta de Projetos, derivado do store: irmão do diretório
/// do store com sufixo ".sock" (ex.: ~/.omnirift/omnifs-drive → ~/.omnirift/omnifs-drive.sock).
/// Nunca disputa o socket global com um daemon externo do usuário.
pub fn store_socket_path(store: &Path) -> PathBuf {
    if let Some(name) = store.file_name().and_then(|n| n.to_str()) {
        let socket_name = format!("{name}.sock");
        store.with_file_name(socket_name)
    } else {
        store.join("omnifs.sock")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn fuse_mount_present_in_detects_fuse_line() {
        let content = "omnifs /home/user/OmniDrive fuse rw,nosuid 0 0\n";
        assert_eq!(fuse_mount_present_in(content, Path::new("/home/user/OmniDrive")), true);
    }

    #[test]
    fn fuse_mount_present_in_different_mount_false() {
        let content = "omnifs /home/user/OmniDrive fuse rw,nosuid 0 0\n";
        assert_eq!(fuse_mount_present_in(content, Path::new("/home/user/OutroDrive")), false);
    }

    #[test]
    fn fuse_mount_present_in_non_fuse_false() {
        let content = "/dev/sda1 /home/user/OmniDrive ext4 rw,relatime 0 0\n";
        assert_eq!(fuse_mount_present_in(content, Path::new("/home/user/OmniDrive")), false);
    }

    #[test]
    fn fuse_mount_present_in_decodes_octal_space() {
        let content = "omnifs /home/u/My\\040Drive fuse rw,nosuid 0 0\n";
        assert_eq!(fuse_mount_present_in(content, Path::new("/home/u/My Drive")), true);
    }

    #[test]
    fn fuse_mount_present_in_fuse_dot_subtype_counts() {
        let content = "omnifs /home/u/OmniDrive fuse.omnifs rw 0 0\n";
        assert_eq!(fuse_mount_present_in(content, Path::new("/home/u/OmniDrive")), true);
    }

    #[test]
    fn fuse_mount_present_in_ignores_trailing_slash() {
        let content = "omnifs /home/u/OmniDrive fuse rw,nosuid 0 0\n";
        assert_eq!(fuse_mount_present_in(content, Path::new("/home/u/OmniDrive/")), true);
    }

    #[test]
    fn fuse_mount_present_in_empty_content_false() {
        assert_eq!(fuse_mount_present_in("", Path::new("/home/user/OmniDrive")), false);
    }

    #[test]
    fn store_socket_path_appends_sock_sibling() {
        assert_eq!(
            store_socket_path(Path::new("/a/b/omnifs-drive")),
            PathBuf::from("/a/b/omnifs-drive.sock")
        );
    }

    #[test]
    fn store_socket_path_fallback_without_file_name() {
        assert_eq!(store_socket_path(Path::new("/")), PathBuf::from("/omnifs.sock"));
    }
}
