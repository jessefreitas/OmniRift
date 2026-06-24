//! Backup-gate (FUNDAÇÃO do painel de Saúde) — `src-tauri/src/health/backup.rs`.
//!
//! Princípio inviolável (do Jesse): **backup obrigatório antes de corrigir QUALQUER
//! código.** Nenhuma correção de código acontece sem passar por aqui primeiro. Este
//! módulo é esse gate: copia os arquivos-alvo pra `<root>/.omnirift/backups/<ts>/`
//! ANTES de qualquer agente tocar no código, e oferece restore 1-clique.
//!
//! Cópia instantânea via reflink/CoW (reusa o helper de `commands/fsinfo.rs`) onde o
//! FS suporta (btrfs/xfs/zfs/apfs); fallback `std::fs::copy` caso contrário. Arquivo
//! inexistente → ERRO (nunca backup vazio silencioso — isso quebraria o gate).
//!
//! State puro / sob demanda — NADA no setup que panique (lição v0.1.15). Os comandos
//! são acionados pela UI quando o usuário decide corrigir um finding.
//!
//! Boundaries: só faz IO de backup/restore (puro, testável). A orquestração de spawn
//! do agente de fix fica no listener da Sidebar (fora daqui).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::commands::fsinfo::reflink_clone;

/// Diretório raiz dos backups dentro do projeto.
const BACKUP_ROOT: &str = ".omnirift/backups";
/// Linha garantida no `.gitignore` do projeto (não versiona backups).
const GITIGNORE_LINE: &str = ".omnirift/";

/// Referência a um backup — o que o front recebe. `id` é único (nome do dir);
/// `ts` é o carimbo ISO-8601; `files` são os relpaths (relativos ao root)
/// salvos; `dir` é o caminho absoluto do diretório do backup.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BackupRef {
    /// Id único do backup = nome do diretório (`YYYYMMDD-HHMMSS`, com sufixo `-N`
    /// em caso de colisão no mesmo segundo).
    pub id: String,
    /// Carimbo de tempo ISO-8601 (RFC3339) de quando o backup foi criado.
    pub ts: String,
    /// Caminhos (relativos ao root) dos arquivos salvos neste backup.
    pub files: Vec<String>,
    /// Caminho absoluto do diretório do backup.
    pub dir: String,
}

/// Manifesto persistido em `<dir>/manifest.json`. Espelha o `BackupRef` menos o
/// `dir` (que é derivável do próprio local do manifesto).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    id: String,
    ts: String,
    files: Vec<String>,
}

/// Carimbo `YYYYMMDD-HHMMSS` (id/nome do dir) a partir de `SystemTime::now()`.
/// Local time, sem caracteres inválidos pra nome de diretório.
fn ts_compact() -> String {
    chrono::Local::now().format("%Y%m%d-%H%M%S").to_string()
}

/// Carimbo ISO-8601 (RFC3339) — vai no campo `ts` do manifesto/BackupRef.
fn ts_iso() -> String {
    chrono::Local::now().to_rfc3339()
}

/// Normaliza `p` pra um caminho ABSOLUTO dentro de `root`. Aceita path relativo
/// (resolve contra `root`) ou absoluto (usa como veio). Retorna o absoluto e o
/// relpath (relativo ao root) — o relpath é a chave no backup/manifesto.
///
/// Recusa qualquer alvo que escape do root (defesa contra `..`/symlink trickery):
/// um backup não deve gravar fora do diretório do projeto.
fn resolve_in_root(root: &Path, p: &str) -> Result<(PathBuf, String), String> {
    let raw = Path::new(p);
    let abs = if raw.is_absolute() {
        raw.to_path_buf()
    } else {
        root.join(raw)
    };

    // Canonicaliza o root (existe sempre) e tenta canonicalizar o alvo; se o alvo
    // não existir ainda (restore antes de recriar), cai pro abs lexical.
    let root_canon = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let abs_canon = abs.canonicalize().unwrap_or_else(|_| abs.clone());

    if !abs_canon.starts_with(&root_canon) {
        return Err(format!("caminho fora do root do projeto: {p}"));
    }

    let rel = abs_canon
        .strip_prefix(&root_canon)
        .map(|r| r.to_path_buf())
        .unwrap_or_else(|_| {
            // Fallback: usa o relpath lexical contra o root não-canônico.
            abs.strip_prefix(root).map(|r| r.to_path_buf()).unwrap_or(abs.clone())
        });

    let rel_str = rel.to_string_lossy().replace('\\', "/");
    Ok((abs_canon, rel_str))
}

/// Copia `src` → `dst` tentando reflink/CoW (instantâneo onde o FS suporta) e caindo
/// pra `std::fs::copy` em qualquer falha (FS sem reflink, Windows sem `cp`, etc.).
/// Cria os diretórios pais do destino. `src` DEVE existir (validado antes).
fn copy_with_reflink(src: &Path, dst: &Path) -> Result<(), String> {
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("não criou dir {}: {e}", parent.display()))?;
    }
    // Tenta reflink (reusa o helper de fsinfo: `cp --reflink=auto`). Qualquer erro
    // → fallback pra cópia normal (mais lenta, mas sempre funciona).
    if reflink_clone(src.to_string_lossy().into(), dst.to_string_lossy().into()).is_ok() {
        return Ok(());
    }
    std::fs::copy(src, dst)
        .map(|_| ())
        .map_err(|e| format!("cópia falhou {} → {}: {e}", src.display(), dst.display()))
}

/// Garante a linha `.omnirift/` no `<root>/.gitignore` (append idempotente). Cria o
/// arquivo se não existir; não duplica se a linha já estiver lá (qualquer grafia
/// equivalente após trim). Falha de IO é silenciosa-soft: o backup não deve abortar
/// só porque o `.gitignore` não pôde ser escrito.
pub fn ensure_gitignore(root: &Path) -> Result<(), String> {
    let path = root.join(".gitignore");
    let existing = std::fs::read_to_string(&path).unwrap_or_default();

    // Já presente (linha exata, ignorando espaços em volta)? → no-op.
    let already = existing.lines().any(|l| l.trim() == GITIGNORE_LINE);
    if already {
        return Ok(());
    }

    // Append preservando o conteúdo; garante newline antes da nova linha.
    let mut next = existing;
    if !next.is_empty() && !next.ends_with('\n') {
        next.push('\n');
    }
    next.push_str(GITIGNORE_LINE);
    next.push('\n');

    std::fs::write(&path, next).map_err(|e| format!("não escreveu .gitignore: {e}"))
}

/// Escolhe um diretório de backup único sob `<root>/.omnirift/backups/`. Base = o
/// carimbo compacto; se já existir (colisão no mesmo segundo), sufixa `-2`, `-3`, …
fn unique_backup_dir(backups_root: &Path, base: &str) -> (String, PathBuf) {
    let first = backups_root.join(base);
    if !first.exists() {
        return (base.to_string(), first);
    }
    let mut n = 2;
    loop {
        let id = format!("{base}-{n}");
        let dir = backups_root.join(&id);
        if !dir.exists() {
            return (id, dir);
        }
        n += 1;
    }
}

/// **Backup-gate.** Copia cada `path` (relativo ou absoluto, normalizado pra dentro
/// do root) pra `<root>/.omnirift/backups/<id>/<relpath>` — reflink quando o FS
/// suporta, fallback `std::fs::copy`. Escreve `manifest.json` e retorna o `BackupRef`.
///
/// Garante `.omnirift/` no `.gitignore` na 1ª vez. Arquivo inexistente → ERRO (não
/// cria backup vazio silencioso). `paths` vazio → ERRO (não faz sentido um gate vazio).
#[tauri::command]
pub async fn health_backup(root: String, paths: Vec<String>) -> Result<BackupRef, String> {
    let root_path = Path::new(&root);
    if !root_path.is_dir() {
        return Err(format!("raiz não é um diretório: {root}"));
    }
    if paths.is_empty() {
        return Err("backup sem arquivos: passe ao menos um path".into());
    }

    // Gate confia no .gitignore: backups nunca devem ser versionados.
    let _ = ensure_gitignore(root_path);

    // Resolve + valida TODOS os paths ANTES de copiar qualquer um (atomicidade da
    // decisão: se um alvo é inválido/inexistente, aborta sem deixar backup parcial).
    let mut resolved: Vec<(PathBuf, String)> = Vec::with_capacity(paths.len());
    for p in &paths {
        let (abs, rel) = resolve_in_root(root_path, p)?;
        if !abs.is_file() {
            return Err(format!("arquivo inexistente (sem backup vazio): {p}"));
        }
        resolved.push((abs, rel));
    }

    let backups_root = root_path.join(BACKUP_ROOT);
    std::fs::create_dir_all(&backups_root)
        .map_err(|e| format!("não criou {}: {e}", backups_root.display()))?;

    let base = ts_compact();
    let (id, dir) = unique_backup_dir(&backups_root, &base);
    std::fs::create_dir_all(&dir).map_err(|e| format!("não criou {}: {e}", dir.display()))?;

    let mut files: Vec<String> = Vec::with_capacity(resolved.len());
    for (abs, rel) in &resolved {
        let dst = dir.join(rel);
        copy_with_reflink(abs, &dst)?;
        files.push(rel.clone());
    }

    let ts = ts_iso();
    let manifest = Manifest {
        id: id.clone(),
        ts: ts.clone(),
        files: files.clone(),
    };
    let manifest_json =
        serde_json::to_string_pretty(&manifest).map_err(|e| format!("serializar manifest: {e}"))?;
    std::fs::write(dir.join("manifest.json"), manifest_json)
        .map_err(|e| format!("escrever manifest: {e}"))?;

    Ok(BackupRef {
        id,
        ts,
        files,
        dir: dir.to_string_lossy().into_owned(),
    })
}

/// Restaura os arquivos do backup `id`: lê o manifesto e copia cada arquivo DE VOLTA
/// pro local original sob `root` (sobrescreve). Valida que o backup existe.
#[tauri::command]
pub async fn health_backup_restore(root: String, id: String) -> Result<(), String> {
    let root_path = Path::new(&root);
    if !root_path.is_dir() {
        return Err(format!("raiz não é um diretório: {root}"));
    }

    let dir = root_path.join(BACKUP_ROOT).join(&id);
    let manifest_path = dir.join("manifest.json");
    if !manifest_path.is_file() {
        return Err(format!("backup inexistente: {id}"));
    }

    let raw = std::fs::read_to_string(&manifest_path)
        .map_err(|e| format!("ler manifest {id}: {e}"))?;
    let manifest: Manifest =
        serde_json::from_str(&raw).map_err(|e| format!("manifest inválido {id}: {e}"))?;

    for rel in &manifest.files {
        let src = dir.join(rel);
        if !src.is_file() {
            return Err(format!("arquivo do backup sumiu: {rel} (backup {id})"));
        }
        // Destino = local original sob o root (relpath é relativo ao root por construção).
        let dst = root_path.join(rel);
        copy_with_reflink(&src, &dst)?;
    }

    Ok(())
}

/// Lista os backups do projeto lendo `<root>/.omnirift/backups/*/manifest.json`.
/// Ordena por `ts` desc (mais recente primeiro). Manifestos ilegíveis/inválidos
/// são pulados (não derrubam a listagem).
#[tauri::command]
pub async fn health_backup_list(root: String) -> Result<Vec<BackupRef>, String> {
    let root_path = Path::new(&root);
    let backups_root = root_path.join(BACKUP_ROOT);
    if !backups_root.is_dir() {
        return Ok(Vec::new()); // sem backups ainda → lista vazia (não é erro)
    }

    let mut out: Vec<BackupRef> = Vec::new();
    let entries = match std::fs::read_dir(&backups_root) {
        Ok(e) => e,
        Err(e) => return Err(format!("ler {}: {e}", backups_root.display())),
    };

    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let manifest_path = dir.join("manifest.json");
        let raw = match std::fs::read_to_string(&manifest_path) {
            Ok(r) => r,
            Err(_) => continue, // dir sem manifest legível → pula
        };
        let manifest: Manifest = match serde_json::from_str(&raw) {
            Ok(m) => m,
            Err(_) => continue, // manifest inválido → pula
        };
        out.push(BackupRef {
            id: manifest.id,
            ts: manifest.ts,
            files: manifest.files,
            dir: dir.to_string_lossy().into_owned(),
        });
    }

    // Mais recente primeiro. `ts` é RFC3339 → ordenável lexicograficamente; desempate
    // por id desc pra ser determinístico quando dois backups têm o mesmo segundo.
    out.sort_by(|a, b| b.ts.cmp(&a.ts).then_with(|| b.id.cmp(&a.id)));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// Round-trip: backup → modifica original → restore → conteúdo original de volta.
    #[tokio::test]
    async fn backup_restore_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let root_s = root.to_string_lossy().to_string();

        // Arquivo em subdir (testa criação de subdirs no destino).
        fs::create_dir_all(root.join("src")).unwrap();
        let file = root.join("src").join("app.rs");
        fs::write(&file, "ORIGINAL").unwrap();

        // Backup (path relativo).
        let bref = health_backup(root_s.clone(), vec!["src/app.rs".into()])
            .await
            .unwrap();
        assert_eq!(bref.files, vec!["src/app.rs".to_string()]);
        assert!(Path::new(&bref.dir).join("manifest.json").is_file());
        assert!(Path::new(&bref.dir).join("src").join("app.rs").is_file());

        // Modifica o original.
        fs::write(&file, "MODIFICADO").unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "MODIFICADO");

        // Restore → volta ao original.
        health_backup_restore(root_s.clone(), bref.id.clone())
            .await
            .unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "ORIGINAL");
    }

    /// Backup aceita path ABSOLUTO e normaliza pra relpath dentro do root.
    #[tokio::test]
    async fn backup_accepts_absolute_path() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let file = root.join("main.rs");
        fs::write(&file, "abs").unwrap();

        let bref = health_backup(
            root.to_string_lossy().to_string(),
            vec![file.to_string_lossy().to_string()],
        )
        .await
        .unwrap();
        assert_eq!(bref.files, vec!["main.rs".to_string()]);
    }

    /// Arquivo inexistente → erro (NUNCA backup vazio silencioso).
    #[tokio::test]
    async fn backup_missing_file_errors() {
        let dir = tempfile::tempdir().unwrap();
        let root_s = dir.path().to_string_lossy().to_string();
        let err = health_backup(root_s, vec!["nao-existe.rs".into()])
            .await
            .unwrap_err();
        assert!(err.contains("inexistente"), "erro foi: {err}");
    }

    /// Lista vazia de paths → erro (gate vazio não faz sentido).
    #[tokio::test]
    async fn backup_empty_paths_errors() {
        let dir = tempfile::tempdir().unwrap();
        let root_s = dir.path().to_string_lossy().to_string();
        assert!(health_backup(root_s, vec![]).await.is_err());
    }

    /// Restore de id inexistente → erro claro.
    #[tokio::test]
    async fn restore_unknown_id_errors() {
        let dir = tempfile::tempdir().unwrap();
        let root_s = dir.path().to_string_lossy().to_string();
        let err = health_backup_restore(root_s, "20990101-000000".into())
            .await
            .unwrap_err();
        assert!(err.contains("inexistente"), "erro foi: {err}");
    }

    /// `health_backup_list` ordena por ts desc (mais recente primeiro).
    #[tokio::test]
    async fn list_orders_desc() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let root_s = root.to_string_lossy().to_string();
        let backups_root = root.join(BACKUP_ROOT);
        fs::create_dir_all(&backups_root).unwrap();

        // Fabrica 3 backups com ts conhecidos (não dependemos do relógio).
        for (id, ts) in [
            ("20260101-000000", "2026-01-01T00:00:00+00:00"),
            ("20260301-120000", "2026-03-01T12:00:00+00:00"),
            ("20260201-060000", "2026-02-01T06:00:00+00:00"),
        ] {
            let d = backups_root.join(id);
            fs::create_dir_all(&d).unwrap();
            let m = format!(
                r#"{{"id":"{id}","ts":"{ts}","files":["a.rs"]}}"#
            );
            fs::write(d.join("manifest.json"), m).unwrap();
        }

        let list = health_backup_list(root_s).await.unwrap();
        assert_eq!(list.len(), 3);
        // Desc por ts: março > fevereiro > janeiro.
        assert_eq!(list[0].id, "20260301-120000");
        assert_eq!(list[1].id, "20260201-060000");
        assert_eq!(list[2].id, "20260101-000000");
    }

    /// `list` em projeto sem backups → vazio (não erro).
    #[tokio::test]
    async fn list_empty_when_no_backups() {
        let dir = tempfile::tempdir().unwrap();
        let root_s = dir.path().to_string_lossy().to_string();
        assert!(health_backup_list(root_s).await.unwrap().is_empty());
    }

    /// `.gitignore` recebe `.omnirift/` idempotente: chamar 2x não duplica.
    #[test]
    fn gitignore_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        ensure_gitignore(root).unwrap();
        ensure_gitignore(root).unwrap(); // 2ª vez = no-op

        let content = fs::read_to_string(root.join(".gitignore")).unwrap();
        let count = content.lines().filter(|l| l.trim() == GITIGNORE_LINE).count();
        assert_eq!(count, 1, ".omnirift/ não deve duplicar");
    }

    /// `.gitignore` preexistente é preservado (append, não overwrite).
    #[test]
    fn gitignore_preserves_existing() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join(".gitignore"), "target/\nnode_modules/").unwrap();

        ensure_gitignore(root).unwrap();

        let content = fs::read_to_string(root.join(".gitignore")).unwrap();
        assert!(content.contains("target/"), "linha antiga preservada");
        assert!(content.contains("node_modules/"), "linha antiga preservada");
        assert!(content.lines().any(|l| l.trim() == GITIGNORE_LINE));
    }

    /// `health_backup` cria `.gitignore` com a linha na 1ª chamada.
    #[tokio::test]
    async fn backup_seeds_gitignore() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let file = root.join("x.rs");
        fs::write(&file, "x").unwrap();

        let _ = health_backup(root.to_string_lossy().to_string(), vec!["x.rs".into()])
            .await
            .unwrap();

        let gi = fs::read_to_string(root.join(".gitignore")).unwrap();
        assert!(gi.lines().any(|l| l.trim() == GITIGNORE_LINE));
    }

    /// Colisão de id no mesmo segundo → sufixo `-2` (dirs distintos).
    #[tokio::test]
    async fn id_collision_gets_suffix() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let root_s = root.to_string_lossy().to_string();
        let file = root.join("y.rs");
        fs::write(&file, "y").unwrap();

        let b1 = health_backup(root_s.clone(), vec!["y.rs".into()])
            .await
            .unwrap();
        // Pré-cria o dir do próximo segundo improvável; em vez disso, criamos
        // manualmente o dir base que o b1 usaria de novo pra forçar colisão.
        let backups_root = root.join(BACKUP_ROOT);
        let same = backups_root.join(&b1.id);
        assert!(same.exists());
        // Segundo backup no mesmo segundo (relógio) OU base já ocupada → id diferente.
        let b2 = health_backup(root_s, vec!["y.rs".into()]).await.unwrap();
        assert_ne!(b1.dir, b2.dir, "dirs de backup devem ser distintos");
    }
}
