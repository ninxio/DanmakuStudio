use super::*;
use rusqlite::Connection;

pub(super) struct Fixture {
    pub root: PathBuf,
}
impl Fixture {
    pub fn new() -> Self {
        let mut nonce = [0u8; 12];
        getrandom::fill(&mut nonce).unwrap();
        let nonce = nonce.iter().map(|v| format!("{v:02x}")).collect::<String>();
        let root = std::env::temp_dir().join(format!("studio-storage-{nonce}"));
        fs::create_dir(&root).unwrap();
        Self { root }
    }
    fn config(&self) -> PathBuf {
        self.root.join("config")
    }
    fn data(&self) -> PathBuf {
        self.root.join("data")
    }
    fn start(&self) -> StorageRuntime {
        StorageRuntime::start(self.config(), self.data()).unwrap()
    }
    fn settings(&self, root: &Path) {
        fs::write(
            self.config().join("app-settings.json"),
            serde_json::json!({"storage":{"rootDirectory":root,"cacheDirectory":""}}).to_string(),
        )
        .unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn default_roots_and_next_startup_activation_preserve_originals() {
    let f = Fixture::new();
    let runtime = f.start();
    let old = runtime.paths().unwrap().clone();
    assert_eq!(
        old.database,
        f.data().join("project-library/v1/library.sqlite3")
    );
    let source = Connection::open(&old.database).unwrap();
    source.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE retained_fixture (id INTEGER PRIMARY KEY, bytes BLOB); INSERT INTO retained_fixture VALUES(1,x'01020304');").unwrap();
    let audio = old.emby_audio.join("referenced.flac");
    fs::write(&audio, b"never move audio").unwrap();
    f.settings(&f.root.join("changed 目录"));
    assert!(runtime.status().restart_required);
    assert_eq!(runtime.paths().unwrap().database, old.database);
    drop(runtime);
    // Keep the connection open: latest committed values still reside in WAL.
    let next = f.start();
    let new = next.paths().unwrap();
    assert_ne!(new.database, old.database);
    let copy = Connection::open(&new.database).unwrap();
    assert_eq!(
        copy.query_row("SELECT bytes FROM retained_fixture", [], |r| r
            .get::<_, Vec<u8>>(0))
            .unwrap(),
        vec![1, 2, 3, 4]
    );
    for table in [
        "projects",
        "project_revisions",
        "project_sessions",
        "project_open_operations",
        "project_commit_operations",
    ] {
        assert_eq!(
            copy.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            source
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r
                    .get::<_, i64>(0))
                .unwrap()
        );
    }
    assert_eq!(fs::read(&audio).unwrap(), b"never move audio");
    assert!(old.database.exists());
    assert_eq!(new.bilibili, new.root.join("inputs/bilibili"));
    assert_eq!(new.originals, new.root.join("originals"));
    assert_eq!(new.exports, new.root.join("exports"));
}

#[test]
fn global_lock_is_independent_of_selected_data_directory() {
    let f = Fixture::new();
    let first = f.start();
    f.settings(&f.root.join("other"));
    assert!(StorageRuntime::start(f.config(), f.data()).is_err());
    drop(first);
    assert!(f.start().paths().is_ok());
}

#[test]
fn missing_or_corrupt_library_and_invalid_settings_never_open_empty_library() {
    let f = Fixture::new();
    let runtime = f.start();
    let database = runtime.paths().unwrap().database.clone();
    drop(runtime);
    fs::remove_file(&database).unwrap();
    let blocked = f.start();
    assert!(blocked.paths().is_err());
    assert!(!database.exists());
    drop(blocked);
    fs::write(&database, b"corrupt original").unwrap();
    let blocked = f.start();
    assert!(blocked.paths().is_err());
    assert_eq!(fs::read(&database).unwrap(), b"corrupt original");
    drop(blocked);
    fs::write(f.config().join("app-settings.json"), b"not json").unwrap();
    assert!(f.start().status().error.is_some());
}

#[test]
fn existing_target_and_unwritable_settings_keep_effective_library() {
    let f = Fixture::new();
    let runtime = f.start();
    let target = f.root.join("target");
    let database = target.join("project-library/v1/library.sqlite3");
    fs::create_dir_all(database.parent().unwrap()).unwrap();
    fs::write(&database, b"other library").unwrap();
    let content = serde_json::json!({"storage":{"rootDirectory":target}}).to_string();
    assert!(runtime.validate_settings(&content).is_err());
    assert_eq!(fs::read(&database).unwrap(), b"other library");
    let file = f.root.join("file");
    fs::write(&file, b"not a folder").unwrap();
    assert!(runtime
        .validate_settings(&serde_json::json!({"storage":{"rootDirectory":file}}).to_string())
        .is_err());
    assert!(runtime.paths().is_ok());
}

#[test]
fn settings_atomic_replacement_failure_preserves_previous_content() {
    let f = Fixture::new();
    let path = f.root.join("settings.json");
    crate::project_files::atomic_write(&path, b"old").unwrap();
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        let hold = OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(&path)
            .unwrap();
        assert!(crate::project_files::atomic_write(&path, b"new").is_err());
        assert_eq!(fs::read(&path).unwrap(), b"old");
        drop(hold);
    }
    crate::project_files::atomic_write(&path, b"new").unwrap();
    assert_eq!(fs::read(&path).unwrap(), b"new");
}

#[test]
fn same_existing_directory_spelling_is_not_a_migration() {
    let f = Fixture::new();
    let runtime = f.start();
    let mut spelling = f.data().to_string_lossy().into_owned();
    #[cfg(windows)]
    {
        spelling = spelling.to_ascii_uppercase();
    }
    spelling.push(std::path::MAIN_SEPARATOR);
    spelling.push('.');
    f.settings(Path::new(&spelling));
    assert!(!runtime.status().restart_required);
}

#[tokio::test]
async fn migration_preserves_revision_bytes_recovery_sessions_and_idempotency_receipts() {
    use crate::project_library::*;
    let f = Fixture::new();
    let storage = f.start();
    let source = storage.paths().unwrap().database.clone();
    let runtime = ProjectLibraryRuntime::open(source.clone());
    let snapshot1=serde_json::json!({"schemaVersion":18,"mediaLibrary":[{"localPath":"C:/existing/audio.flac"}],"revisionMarker":1}).to_string();
    let snapshot2 = snapshot1.replace("\"revisionMarker\":1", "\"revisionMarker\":2");
    let request = OpenProjectLibrarySessionRequest {
        contract_version: 1,
        client_request_id: "migration-create".into(),
        source: OpenProjectLibrarySessionSource::Create {
            display_name: "保留修订".into(),
            project_schema_version: 18,
            snapshot_json: snapshot1.clone(),
        },
    };
    let opened = runtime.open_session(request).await.unwrap();
    runtime
        .commit_session(CommitProjectLibrarySessionRequest {
            contract_version: 1,
            library_project_id: opened.project.library_project_id.clone(),
            session_id: opened.session.session_id.clone(),
            client_mutation_id: "migration-autosave".into(),
            expected_head_revision: 1,
            change: CommitProjectLibrarySessionChange::Save {
                save_kind: ProjectLibrarySaveKind::Autosave,
                source_revision: None,
                label: None,
                display_name: "保留修订".into(),
                project_schema_version: 18,
                snapshot_json: snapshot2.clone(),
            },
        })
        .await
        .unwrap();
    f.settings(&f.root.join("moved"));
    drop(runtime);
    drop(storage);
    let moved = f.start();
    let database = moved.paths().unwrap().database.clone();
    let before = Connection::open(&source).unwrap();
    let after = Connection::open(&database).unwrap();
    for table in [
        "projects",
        "project_revisions",
        "project_sessions",
        "project_open_operations",
        "project_commit_operations",
    ] {
        let count = before
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| {
                r.get::<_, i64>(0)
            })
            .unwrap();
        assert!(count > 0, "{table}");
        assert_eq!(
            count,
            after
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r
                    .get::<_, i64>(0))
                .unwrap()
        );
    }
    for (revision, expected) in [(1, snapshot1), (2, snapshot2)] {
        let bytes = after
            .query_row(
                "SELECT snapshot_bytes FROM project_revisions WHERE revision=?1",
                [revision],
                |r| r.get::<_, Vec<u8>>(0),
            )
            .unwrap();
        assert_eq!(bytes, expected.as_bytes());
    }
    let relocated = ProjectLibraryRuntime::open(database);
    let recovered = relocated
        .open_session(OpenProjectLibrarySessionRequest {
            contract_version: 1,
            client_request_id: "migration-recover".into(),
            source: OpenProjectLibrarySessionSource::Recover {
                library_project_id: opened.project.library_project_id,
                recovery_session_id: opened.session.session_id,
                recovery_revision: 2,
                expected_head_revision: 2,
            },
        })
        .await
        .unwrap();
    assert!(recovered
        .snapshot
        .snapshot_json
        .contains("C:/existing/audio.flac"));
}

#[test]
fn migration_refuses_an_active_old_version_runtime() {
    let f = Fixture::new();
    let storage = f.start();
    let source = storage.paths().unwrap().database.clone();
    drop(storage);
    let dir = source.with_extension("runtime-leases");
    fs::create_dir_all(&dir).unwrap();
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(dir.join("old-active.lease"))
        .unwrap();
    file.try_lock().unwrap();
    f.settings(&f.root.join("moved"));
    let refused = f.start();
    assert!(refused.paths().unwrap_err().contains("另一版本"));
}

#[test]
fn only_existing_legacy_directories_are_reported() {
    let f = Fixture::new();
    let runtime = f.start();
    assert!(runtime.status().retained_legacy_directories.is_empty());
    let legacy = f.data().join("alignment-v2-coarse-cache-v2");
    fs::create_dir(&legacy).unwrap();
    assert_eq!(runtime.status().retained_legacy_directories, vec![legacy]);
}

#[tokio::test]
async fn audio_cleanup_and_new_download_admission_are_mutually_exclusive() {
    let reading = audio_cache_use().await;
    assert!(audio_cache_cleanup().is_err());
    drop(reading);
    let cleanup = audio_cache_cleanup().unwrap();
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(20), audio_cache_use())
            .await
            .is_err()
    );
    drop(cleanup);
    let _reading = audio_cache_use().await;
}
