//! Limpeza de output de terminal: remove sequências ANSI/OSC e quebra em linhas.
//! Compartilhado pelo detector de estado (e candidato a dedup do relay/MCP).

/// Remove ANSI/OSC e devolve as linhas com conteúdo, separadas por `\n`.
pub fn clean_terminal_output(bytes: &[u8]) -> String {
    let mut lines: Vec<String> = Vec::new();
    let mut line_buf: Vec<u8> = Vec::new();
    let mut i = 0;

    while i < bytes.len() {
        match bytes[i] {
            0x1b => {
                i += 1;
                if i >= bytes.len() {
                    break;
                }
                match bytes[i] {
                    b'[' => {
                        i += 1;
                        while i < bytes.len() && !(0x40..=0x7e).contains(&bytes[i]) {
                            i += 1;
                        }
                        i += 1; // consome o byte final do CSI
                    }
                    b']' => {
                        i += 1;
                        while i < bytes.len() {
                            if bytes[i] == 0x07 {
                                i += 1;
                                break;
                            }
                            if bytes[i] == 0x1b && i + 1 < bytes.len() && bytes[i + 1] == b'\\' {
                                i += 2;
                                break;
                            }
                            i += 1;
                        }
                    }
                    _ => i += 1,
                }
            }
            b'\r' => {
                i += 1;
                if i < bytes.len() && bytes[i] == b'\n' {
                    flush_line(&mut lines, &mut line_buf);
                    i += 1;
                } else {
                    line_buf.clear();
                }
            }
            b'\n' => {
                flush_line(&mut lines, &mut line_buf);
                i += 1;
            }
            0x08 => {
                line_buf.pop();
                i += 1;
            }
            b => {
                line_buf.push(b);
                i += 1;
            }
        }
    }
    flush_line(&mut lines, &mut line_buf);
    lines.join("\n")
}

/// As últimas `n` linhas com conteúdo de `clean_terminal_output`.
pub fn bottom_lines(bytes: &[u8], n: usize) -> String {
    let cleaned = clean_terminal_output(bytes);
    let lines: Vec<&str> = cleaned.lines().collect();
    let start = lines.len().saturating_sub(n);
    lines[start..].join("\n")
}

fn flush_line(lines: &mut Vec<String>, buf: &mut Vec<u8>) {
    let text = String::from_utf8_lossy(buf).trim().to_string();
    if !text.is_empty() {
        lines.push(text);
    }
    buf.clear();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_ansi_color() {
        assert_eq!(clean_terminal_output(b"\x1b[32mhello\x1b[0m\nworld"), "hello\nworld");
    }

    #[test]
    fn carriage_return_rewrites_line() {
        // \r sozinho (sem \n) = cursor volta à coluna 0 → descarta a linha parcial
        assert_eq!(clean_terminal_output(b"foo\rbar\n"), "bar");
    }

    #[test]
    fn skips_empty_lines() {
        assert_eq!(clean_terminal_output(b"a\n\n\nb"), "a\nb");
    }

    #[test]
    fn bottom_lines_takes_last_n() {
        assert_eq!(bottom_lines(b"a\nb\nc\nd", 2), "c\nd");
    }

    #[test]
    fn bottom_lines_handles_fewer_than_n() {
        assert_eq!(bottom_lines(b"only", 5), "only");
    }
}
