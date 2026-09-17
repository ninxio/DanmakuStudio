//! Startup-only SQLite backup with a durable activation journal. Never copy a live WAL file.
use super::*;
use rusqlite::{
    backup::{Backup, StepResult},
    Connection, OpenFlags,
};
use sha2::{Digest, Sha256};
use std::{
    io::Read,
    time::{Duration, Instant},
};

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Binding {
    version: u32,
    active_database: PathBuf,
    pending: Option<Pending>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Pending {
    target: PathBuf,
    staging: PathBuf,
    ready_hash: Option<String>,
    source_hash: Option<String>,
}

fn persist(path: &Path, value: &Binding) -> Result<(), String> {
    crate::project_files::atomic_write(path, &serde_json::to_vec(value).map_err(|e| e.to_string())?)
}

pub(super) fn activate(config: &Path, legacy: &Path, desired: &Path) -> Result<(), String> {
    let legacy_path = normalize_path(legacy)?;
    let desired_path = normalize_path(desired)?;
    let legacy = legacy_path.as_path();
    let desired = desired_path.as_path();
    let journal = config.join("storage-location-v1.json");
    let mut binding: Binding = match fs::read(&journal) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|e| format!("项目库位置记录损坏，已阻止打开空库：{e}"))?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let initial = if legacy.exists() { legacy } else { desired };
            if initial != legacy && initial.exists() {
                return Err("首次启用的新目录已有项目库，无法确认归属；请选择空目录。".into());
            }
            let _leases = lock_old_runtimes(initial)?;
            if initial.exists() {
                validate_database(initial)?;
            }
            crate::project_library::initialize_storage(initial)?;
            let initial = Binding {
                version: 1,
                active_database: initial.to_owned(),
                pending: None,
            };
            persist(&journal, &initial)?;
            initial
        }
        Err(e) => return Err(format!("无法读取项目库位置记录：{e}")),
    };
    if binding.version != 1 || !binding.active_database.is_absolute() {
        return Err("项目库位置记录版本或路径无效，已阻止打开空库。".into());
    }
    binding.active_database = normalize_path(&binding.active_database)?;
    if let Some(pending) = binding.pending.as_mut() {
        pending.target = normalize_path(&pending.target)?;
        pending.staging = normalize_path(&pending.staging)?;
    }
    // Even after a failed migration, disappearance of the old database is never first-run.
    validate_database(&binding.active_database)?;
    let leases = lock_old_runtimes(&binding.active_database)?;
    if desired == binding.active_database {
        if binding.pending.is_some() {
            // Explicitly choosing the current directory cancels activation, retaining all copies.
            binding.pending = None;
            persist(&journal, &binding)?;
        }
        return Ok(());
    }
    if let Some(pending) = &binding.pending {
        if pending.target != desired {
            return Err(format!(
                "上次迁移尚未完成。请先恢复原目录 {} 或重试目标目录 {}。",
                binding.active_database.display(),
                pending.target.display()
            ));
        }
    } else {
        if desired.exists() {
            return Err("目标已有项目库；迁移不会覆盖已有文件。".into());
        }
        let mut nonce = [0u8; 12];
        getrandom::fill(&mut nonce).map_err(|e| e.to_string())?;
        let nonce = nonce.iter().map(|b| format!("{b:02x}")).collect::<String>();
        let staging = desired.with_file_name(format!(".studio-migration-{nonce}.sqlite3"));
        binding.pending = Some(Pending {
            target: desired.to_owned(),
            staging,
            ready_hash: None,
            source_hash: None,
        });
        persist(&journal, &binding)?;
    }
    let pending = binding.pending.as_ref().ok_or("迁移状态丢失。")?;
    if pending.staging.parent() != desired.parent()
        || !pending
            .staging
            .file_name()
            .is_some_and(|n| n.to_string_lossy().starts_with(".studio-migration-"))
    {
        return Err("迁移暂存路径无效。".into());
    }
    if pending.ready_hash.is_none() {
        if desired.exists() {
            return Err("迁移目标出现未经核验的文件，已停止。".into());
        }
        let source_hash = backup(&binding.active_database, &pending.staging)?;
        let hash = digest(&pending.staging)?;
        binding.pending.as_mut().ok_or("迁移状态丢失。")?.ready_hash = Some(hash);
        binding
            .pending
            .as_mut()
            .ok_or("迁移状态丢失。")?
            .source_hash = Some(source_hash);
        persist(&journal, &binding)?;
    }
    let pending = binding.pending.as_ref().ok_or("迁移状态丢失。")?;
    if Some(source_digest(&binding.active_database)?) != pending.source_hash {
        return Err(format!("原库在备份后又有修改，已拒绝激活过期副本。请先恢复原目录 {}，重新启动后再选择新的空目录迁移。", binding.active_database.parent().and_then(Path::parent).and_then(Path::parent).unwrap_or(&binding.active_database).display()));
    }
    let ready = if desired.exists() {
        desired
    } else {
        &pending.staging
    };
    if Some(digest(ready)?) != pending.ready_hash {
        return Err("迁移副本校验失败，保留原库与副本；请恢复原目录后检查磁盘。".into());
    }
    validate_database(ready)?;
    if ready != desired {
        promote(&pending.staging, desired)?;
    }
    // Known-dead lease tombstones preserve recovery semantics of every retained session.
    let destination_leases = desired.with_extension("runtime-leases");
    fs::create_dir_all(&destination_leases).map_err(|e| e.to_string())?;
    for (name, _file) in &leases {
        let target = destination_leases.join(name);
        match OpenOptions::new().write(true).create_new(true).open(target) {
            Ok(file) => file.sync_all().map_err(|e| e.to_string())?,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    binding.active_database = desired.to_owned();
    binding.pending = None;
    persist(&journal, &binding)?;
    Ok(())
}

fn lock_old_runtimes(database: &Path) -> Result<Vec<(std::ffi::OsString, File)>, String> {
    let mut leases = Vec::new();
    let entries = match fs::read_dir(database.with_extension("runtime-leases")) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(leases),
        Err(e) => return Err(e.to_string()),
    };
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().map_err(|e| e.to_string())?.is_file() {
            return Err("项目库运行锁目录包含非普通文件。".into());
        }
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .open(entry.path())
            .map_err(|e| e.to_string())?;
        file.try_lock()
            .map_err(|_| "项目库仍被另一版本的 Studio 使用，请保存并退出另一实例后重试。")?;
        leases.push((entry.file_name(), file));
    }
    Ok(leases)
}

fn validate_database(path: &Path) -> Result<(), String> {
    let connection =
        Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|e| {
            format!(
                "原项目库不存在或不可读，已阻止创建空库（{}）：{e}",
                path.display()
            )
        })?;
    let result: String = connection
        .query_row("PRAGMA quick_check", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if result != "ok" {
        return Err(format!("项目库完整性检查失败：{result}"));
    }
    // v1/v2 libraries are still upgraded by the existing production migrations.
    let count: i64 = connection
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='projects'",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if count != 1 {
        return Err("文件不含 Studio 项目库表，已阻止打开空库。".into());
    }
    Ok(())
}

fn backup(source: &Path, destination: &Path) -> Result<String, String> {
    // This private staging file belongs to the durable journal; restarting an incomplete backup
    // reuses it through SQLite (including its WAL), never copies just the main database file.
    let source = Connection::open_with_flags(source, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| e.to_string())?;
    source.execute_batch("BEGIN").map_err(|e| e.to_string())?;
    let source_hash = logical_digest(&source)?;
    let mut target = Connection::open(destination).map_err(|e| e.to_string())?;
    {
        let backup = Backup::new(&source, &mut target).map_err(|e| e.to_string())?;
        let deadline = Instant::now() + Duration::from_secs(120);
        loop {
            match backup
                .step(256)
                .map_err(|e| format!("项目库备份失败，原库保留：{e}"))?
            {
                StepResult::Done => break,
                StepResult::Busy | StepResult::Locked => {
                    std::thread::sleep(Duration::from_millis(25))
                }
                _ => {}
            }
            if Instant::now() >= deadline {
                return Err("项目库备份超时，原库保留，下次启动可重试。".into());
            }
        }
    }
    target
        .pragma_update(None, "journal_mode", "DELETE")
        .map_err(|e| e.to_string())?;
    target.close().map_err(|(_, e)| e.to_string())?;
    OpenOptions::new()
        .write(true)
        .open(destination)
        .and_then(|f| f.sync_all())
        .map_err(|e| e.to_string())?;
    validate_database(destination)?;
    crate::project_library::initialize_storage(destination)?;
    // Finish schema validation before recording the hash. Activation itself is read-only.
    let target = Connection::open(destination).map_err(|e| e.to_string())?;
    target
        .pragma_update(None, "journal_mode", "DELETE")
        .map_err(|e| e.to_string())?;
    target.close().map_err(|(_, e)| e.to_string())?;
    OpenOptions::new()
        .write(true)
        .open(destination)
        .and_then(|f| f.sync_all())
        .map_err(|e| e.to_string())?;
    Ok(source_hash)
}

fn source_digest(path: &Path) -> Result<String, String> {
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| e.to_string())?;
    connection
        .execute_batch("BEGIN")
        .map_err(|e| e.to_string())?;
    logical_digest(&connection)
}

// Hash logical rows, not database/WAL bytes: checkpointing alone is not a project edit.
// Every table is included, preserving future schema additions and mutation/recovery receipts.
fn logical_digest(connection: &Connection) -> Result<String, String> {
    use rusqlite::types::ValueRef;
    let mut hash = Sha256::new();
    let version: i64 = connection
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .map_err(|e| e.to_string())?;
    hash.update(version.to_le_bytes());
    let mut schema = connection
        .prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name")
        .map_err(|e| e.to_string())?;
    let definitions = schema
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    for definition in definitions {
        let (kind, name, sql) = definition.map_err(|e| e.to_string())?;
        for value in [&kind, &name, sql.as_deref().unwrap_or("")] {
            hash.update((value.len() as u64).to_le_bytes());
            hash.update(value.as_bytes());
        }
        if kind != "table" {
            continue;
        }
        let mut query = connection
            .prepare(&format!(
                "SELECT * FROM \"{}\" ORDER BY rowid",
                name.replace('"', "\"\"")
            ))
            .map_err(|e| e.to_string())?;
        let columns = query.column_count();
        let mut rows = query.query([]).map_err(|e| e.to_string())?;
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            hash.update(b"row");
            hash.update((columns as u64).to_le_bytes());
            for column in 0..columns {
                match row.get_ref(column).map_err(|e| e.to_string())? {
                    ValueRef::Null => hash.update([0]),
                    ValueRef::Integer(v) => {
                        hash.update([1]);
                        hash.update(v.to_le_bytes());
                    }
                    ValueRef::Real(v) => {
                        hash.update([2]);
                        hash.update(v.to_bits().to_le_bytes());
                    }
                    ValueRef::Text(v) | ValueRef::Blob(v) => {
                        hash.update([
                            if matches!(
                                row.get_ref(column).map_err(|e| e.to_string())?,
                                ValueRef::Text(_)
                            ) {
                                3
                            } else {
                                4
                            },
                        ]);
                        hash.update((v.len() as u64).to_le_bytes());
                        hash.update(v);
                    }
                }
            }
        }
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn digest(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut block = [0u8; 64 * 1024];
    loop {
        let count = file.read(&mut block).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        hash.update(&block[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

#[cfg(windows)]
fn promote(source: &Path, target: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_WRITE_THROUGH};
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    // SAFETY: NUL-terminated buffers remain alive; deliberately no REPLACE_EXISTING.
    if unsafe { MoveFileExW(source.as_ptr(), target.as_ptr(), MOVEFILE_WRITE_THROUGH) } == 0 {
        return Err(format!(
            "无法完成迁移文件落盘，原库保留：{}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::tests::Fixture;
    use super::*;

    fn interrupted(f: &Fixture, promoted: bool) -> (PathBuf, PathBuf, PathBuf) {
        let config = f.root.join("config");
        fs::create_dir(&config).unwrap();
        let source = f.root.join("old/library.sqlite3");
        crate::project_library::initialize_storage(&source).unwrap();
        let writer = Connection::open(&source).unwrap();
        writer
            .execute_batch(
                "CREATE TABLE migration_test(value TEXT); INSERT INTO migration_test VALUES('A');",
            )
            .unwrap();
        drop(writer);
        let target = f.root.join("new/library.sqlite3");
        fs::create_dir(target.parent().unwrap()).unwrap();
        let staging = target.with_file_name(".studio-migration-test.sqlite3");
        let source_hash = backup(&source, &staging).unwrap();
        let ready_hash = digest(&staging).unwrap();
        persist(
            &config.join("storage-location-v1.json"),
            &Binding {
                version: 1,
                active_database: source.clone(),
                pending: Some(Pending {
                    target: target.clone(),
                    staging: staging.clone(),
                    ready_hash: Some(ready_hash),
                    source_hash: Some(source_hash),
                }),
            },
        )
        .unwrap();
        if promoted {
            promote(&staging, &target).unwrap();
        }
        (config, source, target)
    }

    #[test]
    fn interrupted_backup_or_promotion_resumes_with_unchanged_source() {
        for promoted in [false, true] {
            let f = Fixture::new();
            let (config, source, target) = interrupted(&f, promoted);
            activate(&config, &source, &target).unwrap();
            let binding: Binding =
                serde_json::from_slice(&fs::read(config.join("storage-location-v1.json")).unwrap())
                    .unwrap();
            assert_eq!(binding.active_database, target);
            assert!(binding.pending.is_none());
            assert!(source.exists());
        }
    }

    #[test]
    fn old_app_edit_after_ready_or_promotion_refuses_stale_activation() {
        for promoted in [false, true] {
            let f = Fixture::new();
            let (config, source, target) = interrupted(&f, promoted);
            let old_app = Connection::open(&source).unwrap();
            old_app
                .execute_batch(
                    "PRAGMA journal_mode=WAL; INSERT INTO migration_test VALUES('new edit');",
                )
                .unwrap();
            let error = activate(&config, &source, &target).unwrap_err();
            assert!(error.contains("过期副本"), "{error}");
            let binding: Binding =
                serde_json::from_slice(&fs::read(config.join("storage-location-v1.json")).unwrap())
                    .unwrap();
            assert_eq!(binding.active_database, source);
            assert_eq!(
                old_app
                    .query_row("SELECT COUNT(*) FROM migration_test", [], |r| r
                        .get::<_, i64>(0))
                    .unwrap(),
                2
            );
            // Explicit recovery to A remains possible and never deletes B.
            activate(&config, &source, &source).unwrap();
        }
    }

    #[test]
    fn damaged_activation_journal_is_not_first_run() {
        let f = Fixture::new();
        let (config, source, target) = interrupted(&f, false);
        fs::write(config.join("storage-location-v1.json"), b"invalid").unwrap();
        assert!(activate(&config, &source, &target).is_err());
        assert!(!target.exists());
    }
}

#[cfg(not(windows))]
fn promote(source: &Path, target: &Path) -> Result<(), String> {
    fs::hard_link(source, target).map_err(|e| e.to_string())?;
    fs::remove_file(source).map_err(|e| e.to_string())
}
