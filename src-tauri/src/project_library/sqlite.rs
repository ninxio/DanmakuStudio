use super::runtime_lease::{OwnerState, RuntimeLease};
#[cfg(test)]
#[path = "lease_tests.rs"]
mod lease_tests;
#[cfg(test)]
use super::ProjectLibraryTestFailpoint;
use super::{
    validate_contract_version, validate_safe_positive_integer, CommitProjectLibrarySessionChange,
    CommitProjectLibrarySessionRequest, CommitProjectLibrarySessionValue,
    OpenProjectLibrarySessionRequest, OpenProjectLibrarySessionSource,
    OpenProjectLibrarySessionValue, ProjectLibraryCommitDisposition, ProjectLibraryError,
    ProjectLibraryErrorCode, ProjectLibraryLimits, ProjectLibraryProjectSummary,
    ProjectLibraryQuery, ProjectLibraryQueryRequest, ProjectLibraryQueryValue,
    ProjectLibraryRevisionSummary, ProjectLibrarySaveKind, ProjectLibrarySessionSummary,
    StoredProjectSnapshot, PROJECT_LIBRARY_STORAGE_VERSION,
};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::de::IgnoredAny;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs,
    io::{self, Write},
    path::Path,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

pub(super) struct SqliteProjectLibrary {
    recent_name_cache: std::cell::RefCell<std::collections::HashMap<(String, u64), String>>,
    connection: Connection,
    runtime_id: String,
    runtime_lease: RuntimeLease,
    limits: ProjectLibraryLimits,
    #[cfg(test)]
    test_failpoint: Option<ProjectLibraryTestFailpoint>,
}

#[derive(Clone, Copy, Default)]
struct SessionAccess {
    legacy_exclusive: bool,
}

impl SessionAccess {
    // Call after reading the current owner inside the write transaction. A
    // receipt replay can change that owner without changing the head revision.
    fn require_inactive_owner(
        self,
        lease: &RuntimeLease,
        owner: &str,
    ) -> Result<(), ProjectLibraryError> {
        match lease
            .owner_state(owner)
            .map_err(|_| storage_unavailable())?
        {
            OwnerState::Alive => Err(live_owner_error()),
            OwnerState::Dead => Ok(()),
            OwnerState::Unknown if self.legacy_exclusive => Ok(()),
            OwnerState::Unknown => Err(ProjectLibraryError::new(
                ProjectLibraryErrorCode::RecoveryDecisionRequired,
                "会话持有者已经变化，请重新读取恢复列表后重试。",
                false,
            )),
        }
    }
}

impl SqliteProjectLibrary {
    pub(super) fn open(
        database_path: &Path,
        limits: ProjectLibraryLimits,
        fail_migration_before_commit: bool,
    ) -> Result<Self, ProjectLibraryError> {
        if let Some(parent) = database_path.parent() {
            fs::create_dir_all(parent).map_err(|_| storage_unavailable())?;
        }
        let mut connection = Connection::open(database_path).map_err(map_sqlite_error)?;
        connection
            .busy_timeout(Duration::from_millis(limits.busy_timeout_ms))
            .map_err(map_sqlite_error)?;
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .map_err(map_sqlite_error)?;
        connection
            .pragma_update(None, "synchronous", "FULL")
            .map_err(map_sqlite_error)?;
        let journal_mode: String = connection
            .query_row("PRAGMA journal_mode=WAL", [], |row| row.get(0))
            .map_err(map_sqlite_error)?;
        if !journal_mode.eq_ignore_ascii_case("wal") {
            return Err(ProjectLibraryError::new(
                ProjectLibraryErrorCode::StorageUnavailable,
                "项目库无法启用必需的 WAL 持久化模式。",
                false,
            ));
        }
        migrate(&mut connection, fail_migration_before_commit)?;
        let runtime_id = generate_identifier("runtime")?;
        let runtime_lease =
            RuntimeLease::acquire(database_path, &runtime_id).map_err(|_| storage_unavailable())?;

        Ok(Self {
            recent_name_cache: Default::default(),
            connection,
            runtime_id,
            runtime_lease,
            limits,
            #[cfg(test)]
            test_failpoint: None,
        })
    }

    #[cfg(test)]
    pub(super) fn set_failpoint_for_test(&mut self, failpoint: ProjectLibraryTestFailpoint) {
        self.test_failpoint = Some(failpoint);
    }

    #[cfg(test)]
    pub(super) fn set_query_only_for_test(&mut self) -> Result<(), ProjectLibraryError> {
        self.connection
            .pragma_update(None, "query_only", "ON")
            .map_err(map_sqlite_error)
    }

    #[cfg(test)]
    pub(super) fn limit_database_pages_for_test(&mut self) -> Result<(), ProjectLibraryError> {
        let page_count: i64 = self
            .connection
            .pragma_query_value(None, "page_count", |row| row.get(0))
            .map_err(map_sqlite_error)?;
        self.connection
            .pragma_update(None, "max_page_count", page_count)
            .map_err(map_sqlite_error)
    }

    #[cfg(test)]
    pub(super) fn storage_settings_for_test(
        &mut self,
    ) -> Result<(String, i64, bool), ProjectLibraryError> {
        let journal_mode = self
            .connection
            .pragma_query_value(None, "journal_mode", |row| row.get(0))
            .map_err(map_sqlite_error)?;
        let synchronous = self
            .connection
            .pragma_query_value(None, "synchronous", |row| row.get(0))
            .map_err(map_sqlite_error)?;
        let foreign_keys: i64 = self
            .connection
            .pragma_query_value(None, "foreign_keys", |row| row.get(0))
            .map_err(map_sqlite_error)?;
        Ok((journal_mode, synchronous, foreign_keys == 1))
    }

    pub(super) fn query(
        &mut self,
        request: ProjectLibraryQueryRequest,
    ) -> Result<ProjectLibraryQueryValue, ProjectLibraryError> {
        validate_contract_version(request.contract_version)?;
        match request.query {
            ProjectLibraryQuery::Recent { limit, cursor } => {
                self.list_recent(limit, cursor.as_deref())
            }
            ProjectLibraryQuery::Revision {
                library_project_id,
                revision,
            } => {
                validate_identifier(&library_project_id, "libraryProjectId")?;
                validate_safe_positive_integer(revision, "revision")?;
                let snapshot = load_snapshot(&self.connection, &library_project_id, revision)?;
                Ok(ProjectLibraryQueryValue::Revision { snapshot })
            }
            ProjectLibraryQuery::Revisions {
                library_project_id,
                before_revision,
                limit,
            } => self.list_revisions(library_project_id, before_revision, limit),
            ProjectLibraryQuery::Recoveries => self.list_recoveries(),
        }
    }

    pub(super) fn open_session(
        &mut self,
        request: OpenProjectLibrarySessionRequest,
    ) -> Result<OpenProjectLibrarySessionValue, ProjectLibraryError> {
        validate_contract_version(request.contract_version)?;
        validate_client_operation_id(&request.client_request_id)?;
        let access = self.prepare_session_access(&request)?;
        let result = self.open_session_checked(request, access);
        if access.legacy_exclusive {
            // This connection entered WAL in NORMAL mode, so the mode can be restored.
            // A subsequent read is required to actually release the exclusive file lock.
            let release = self
                .connection
                .pragma_update(None, "locking_mode", "NORMAL")
                .and_then(|_| {
                    self.connection
                        .query_row("SELECT count(*) FROM projects", [], |_| Ok(()))
                })
                .map_err(map_sqlite_error);
            if let Err(error) = release {
                return Err(error);
            }
        }
        result
    }

    fn open_session_checked(
        &mut self,
        request: OpenProjectLibrarySessionRequest,
        access: SessionAccess,
    ) -> Result<OpenProjectLibrarySessionValue, ProjectLibraryError> {
        validate_contract_version(request.contract_version)?;
        validate_client_operation_id(&request.client_request_id)?;
        let request_hash = request_digest(&request)?;
        match request.source {
            OpenProjectLibrarySessionSource::Create {
                display_name,
                project_schema_version,
                snapshot_json,
            } => self.create_project(
                access,
                &request.client_request_id,
                &request_hash,
                display_name,
                project_schema_version,
                snapshot_json,
            ),
            OpenProjectLibrarySessionSource::Head {
                library_project_id,
                expected_head_revision,
            } => self.open_head(
                access,
                &request.client_request_id,
                &request_hash,
                library_project_id,
                expected_head_revision,
            ),
            OpenProjectLibrarySessionSource::Recover {
                library_project_id,
                recovery_session_id,
                recovery_revision,
                expected_head_revision,
            } => self.recover_session(
                access,
                &request.client_request_id,
                &request_hash,
                library_project_id,
                recovery_session_id,
                recovery_revision,
                expected_head_revision,
            ),
            OpenProjectLibrarySessionSource::DiscardRecovery {
                library_project_id,
                recovery_session_id,
                expected_head_revision,
                source_revision,
                display_name,
                project_schema_version,
                snapshot_json,
            } => self.discard_recovery(
                access,
                &request.client_request_id,
                &request_hash,
                library_project_id,
                recovery_session_id,
                expected_head_revision,
                source_revision,
                display_name,
                project_schema_version,
                snapshot_json,
            ),
        }
    }

    pub(super) fn close_stable_runtime_sessions(&mut self) -> Result<(), ProjectLibraryError> {
        self.connection.execute(
            "UPDATE project_sessions SET state='closedRuntime', closed_at_ms=?1
             WHERE runtime_id=?2 AND state='open' AND latest_revision <= (
               SELECT stable_revision FROM projects WHERE projects.library_project_id=project_sessions.library_project_id
             )",
            params![sql_integer(now_unix_ms()?)?, self.runtime_id],
        ).map_err(map_sqlite_error)?;
        Ok(())
    }

    fn prepare_session_access(
        &mut self,
        request: &OpenProjectLibrarySessionRequest,
    ) -> Result<SessionAccess, ProjectLibraryError> {
        let project_id = match &request.source {
            OpenProjectLibrarySessionSource::Head {
                library_project_id, ..
            }
            | OpenProjectLibrarySessionSource::Recover {
                library_project_id, ..
            }
            | OpenProjectLibrarySessionSource::DiscardRecovery {
                library_project_id, ..
            } => Some(library_project_id.clone()),
            OpenProjectLibrarySessionSource::Create { .. } => self
                .connection
                .query_row(
                    "SELECT library_project_id FROM project_sessions WHERE open_request_id=?1",
                    [&request.client_request_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(map_sqlite_error)?,
        };
        let Some(project_id) = project_id else {
            return Ok(SessionAccess::default());
        };
        let mut statement = self.connection.prepare(
            "SELECT DISTINCT runtime_id FROM project_sessions WHERE library_project_id=?1 AND runtime_id<>?2
             AND (state='open' OR (open_request_id=?3 AND state='closedRuntime'))"
        ).map_err(map_sqlite_error)?;
        let owners = statement
            .query_map(
                params![project_id, self.runtime_id, request.client_request_id],
                |row| row.get::<_, String>(0),
            )
            .map_err(map_sqlite_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(map_sqlite_error)?;
        drop(statement);
        let mut dead = Vec::new();
        let mut unknown = false;
        for owner in owners {
            match self
                .runtime_lease
                .owner_state(&owner)
                .map_err(|_| storage_unavailable())?
            {
                OwnerState::Alive => {
                    return Err(live_owner_error()
                        .with_actual_head(load_head_and_stable(&self.connection, &project_id)?.0))
                }
                OwnerState::Dead => dead.push(owner),
                OwnerState::Unknown => unknown = true,
            }
        }
        if unknown {
            if matches!(request.source, OpenProjectLibrarySessionSource::Head { .. }) {
                return Err(ProjectLibraryError::new(
                    ProjectLibraryErrorCode::RecoveryDecisionRequired,
                    "旧版本留下未关闭会话；请在恢复列表选择恢复。若另一实例仍在运行，请先关闭它。",
                    false,
                )
                .with_actual_head(load_head_and_stable(&self.connection, &project_id)?.0));
            }
            // Legacy runtimes have no lease. An exclusive SQLite connection lock is
            // the compatibility fence: even an idle older WAL connection blocks it.
            self.connection
                .pragma_update(None, "locking_mode", "EXCLUSIVE")
                .map_err(map_sqlite_error)?;
            if let Err(error) = self.connection.execute_batch("BEGIN EXCLUSIVE; COMMIT;") {
                let _ = self.connection.execute_batch("ROLLBACK;");
                let _ = self
                    .connection
                    .pragma_update(None, "locking_mode", "NORMAL");
                let _ = self
                    .connection
                    .query_row("SELECT count(*) FROM projects", [], |_| Ok(()));
                return Err(match error.sqlite_error_code() {
                    Some(
                        rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked,
                    ) => live_owner_error(),
                    _ => map_sqlite_error(error),
                });
            }
        }
        if matches!(request.source, OpenProjectLibrarySessionSource::Head { .. })
            && !dead.is_empty()
        {
            let now = sql_integer(now_unix_ms()?)?;
            let transaction = self
                .connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(map_sqlite_error)?;
            for owner in dead {
                transaction.execute(
                    "UPDATE project_sessions SET state='closedRuntime', closed_at_ms=?1
                     WHERE library_project_id=?2 AND runtime_id=?3 AND state='open' AND latest_revision <= (
                       SELECT stable_revision FROM projects WHERE library_project_id=?2
                     )", params![now, project_id, owner],
                ).map_err(map_sqlite_error)?;
            }
            transaction.commit().map_err(map_sqlite_error)?;
        }
        Ok(SessionAccess {
            legacy_exclusive: unknown,
        })
    }

    pub(super) fn commit_session(
        &mut self,
        request: CommitProjectLibrarySessionRequest,
    ) -> Result<CommitProjectLibrarySessionValue, ProjectLibraryError> {
        validate_contract_version(request.contract_version)?;
        validate_identifier(&request.library_project_id, "libraryProjectId")?;
        validate_identifier(&request.session_id, "sessionId")?;
        validate_client_operation_id(&request.client_mutation_id)?;
        validate_safe_positive_integer(request.expected_head_revision, "expectedHeadRevision")?;
        let request_hash = request_digest(&request)?;
        if let Some(receipt) =
            load_commit_receipt(&self.connection, &request.client_mutation_id, &request_hash)?
        {
            return Ok(receipt);
        }

        match request.change {
            CommitProjectLibrarySessionChange::Save {
                save_kind,
                source_revision,
                label,
                display_name,
                project_schema_version,
                snapshot_json,
            } => self.save_revision(
                request.library_project_id,
                request.session_id,
                request.client_mutation_id,
                request_hash,
                request.expected_head_revision,
                save_kind,
                source_revision,
                label,
                display_name,
                project_schema_version,
                snapshot_json,
            ),
            CommitProjectLibrarySessionChange::Close => self.close_session(
                request.library_project_id,
                request.session_id,
                request.client_mutation_id,
                request_hash,
                request.expected_head_revision,
            ),
        }
    }

    fn create_project(
        &mut self,
        access: SessionAccess,
        client_request_id: &str,
        request_hash: &str,
        display_name: String,
        project_schema_version: u32,
        snapshot_json: String,
    ) -> Result<OpenProjectLibrarySessionValue, ProjectLibraryError> {
        validate_display_name(&display_name)?;
        if project_schema_version == 0 {
            return Err(ProjectLibraryError::new(
                ProjectLibraryErrorCode::InvalidRequest,
                "projectSchemaVersion 必须大于 0。",
                false,
            ));
        }
        let snapshot_hash = validate_snapshot(&snapshot_json, self.limits.max_snapshot_bytes)?;
        let now = now_unix_ms()?;
        let now_sql = sql_integer(now)?;
        let schema_version_sql = i64::from(project_schema_version);
        let snapshot_len_sql = sql_integer(snapshot_json.len() as u64)?;
        let library_project_id = generate_identifier("project")?;
        let session_id = generate_identifier("session")?;
        let runtime_id = self.runtime_id.clone();
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(map_sqlite_error)?;
        if let Some(receipt) = load_open_receipt(
            &transaction,
            &runtime_id,
            client_request_id,
            request_hash,
            &self.runtime_lease,
            access,
        )? {
            transaction.commit().map_err(map_sqlite_error)?;
            return Ok(receipt);
        }
        transaction
            .execute(
                "INSERT INTO projects (
                    library_project_id, display_name, project_schema_version,
                    head_revision, stable_revision, created_at_ms, updated_at_ms, last_opened_at_ms
                 ) VALUES (?1, ?2, ?3, 1, 1, ?4, ?4, ?4)",
                params![
                    library_project_id,
                    display_name,
                    schema_version_sql,
                    now_sql
                ],
            )
            .map_err(map_sqlite_error)?;
        transaction
            .execute(
                "INSERT INTO project_revisions (
                    library_project_id, revision, parent_revision, source_revision,
                    project_schema_version, display_name, save_kind,
                    label, saved_at_ms, snapshot_bytes, snapshot_sha256, snapshot_len
                 ) VALUES (?1, 1, NULL, NULL, ?2, ?3, 'create', NULL, ?4, ?5, ?6, ?7)",
                params![
                    library_project_id,
                    schema_version_sql,
                    display_name,
                    now_sql,
                    snapshot_json.as_bytes(),
                    snapshot_hash,
                    snapshot_len_sql
                ],
            )
            .map_err(map_sqlite_error)?;
        transaction
            .execute(
                "INSERT INTO project_sessions (
                    session_id, runtime_id, library_project_id, open_request_id,
                    opened_revision, latest_revision, state, opened_at_ms, closed_at_ms
                 ) VALUES (?1, ?2, ?3, ?4, 1, 1, 'open', ?5, NULL)",
                params![
                    session_id,
                    runtime_id,
                    library_project_id,
                    client_request_id,
                    now_sql
                ],
            )
            .map_err(map_sqlite_error)?;
        let project = ProjectLibraryProjectSummary {
            library_project_id: library_project_id.clone(),
            display_name: display_name.clone(),
            project_schema_version,
            head_revision: 1,
            stable_revision: 1,
            created_at_unix_ms: now,
            updated_at_unix_ms: now,
            last_opened_at_unix_ms: now,
            has_recovery: false,
        };
        let value = OpenProjectLibrarySessionValue {
            project,
            session: ProjectLibrarySessionSummary {
                session_id,
                opened_revision: 1,
                current_revision: 1,
                stable_revision: 1,
                opened_at_unix_ms: now,
            },
            snapshot: StoredProjectSnapshot {
                library_project_id: library_project_id.clone(),
                revision: 1,
                display_name,
                project_schema_version,
                saved_at_unix_ms: now,
                snapshot_json,
            },
        };
        store_open_receipt(&transaction, client_request_id, request_hash, &value)?;
        apply_retention(&transaction, &library_project_id, self.limits)?;
        transaction.commit().map_err(map_sqlite_error)?;
        Ok(value)
    }

    fn save_revision(
        &mut self,
        library_project_id: String,
        session_id: String,
        client_mutation_id: String,
        request_hash: String,
        expected_head_revision: u64,
        save_kind: ProjectLibrarySaveKind,
        source_revision: Option<u64>,
        label: Option<String>,
        display_name: String,
        project_schema_version: u32,
        snapshot_json: String,
    ) -> Result<CommitProjectLibrarySessionValue, ProjectLibraryError> {
        #[cfg(test)]
        let test_failpoint = self.test_failpoint.take();
        if !matches!(
            save_kind,
            ProjectLibrarySaveKind::Autosave
                | ProjectLibrarySaveKind::Checkpoint
                | ProjectLibrarySaveKind::Rollback
        ) {
            return Err(ProjectLibraryError::new(
                ProjectLibraryErrorCode::InvalidRequest,
                "commit saveKind 只允许 autosave、checkpoint 或 rollback。",
                false,
            ));
        }
        match (save_kind, source_revision) {
            (ProjectLibrarySaveKind::Rollback, Some(revision)) => {
                validate_safe_positive_integer(revision, "sourceRevision")?;
            }
            (ProjectLibrarySaveKind::Rollback, None) => {
                return Err(ProjectLibraryError::new(
                    ProjectLibraryErrorCode::InvalidRequest,
                    "rollback 必须指定 sourceRevision。",
                    false,
                ));
            }
            (_, Some(_)) => {
                return Err(ProjectLibraryError::new(
                    ProjectLibraryErrorCode::InvalidRequest,
                    "非 rollback 保存不得指定 sourceRevision。",
                    false,
                ));
            }
            _ => {}
        }
        validate_display_name(&display_name)?;
        validate_label(label.as_deref())?;
        if project_schema_version == 0 {
            return Err(ProjectLibraryError::new(
                ProjectLibraryErrorCode::InvalidRequest,
                "projectSchemaVersion 必须大于 0。",
                false,
            ));
        }
        let snapshot_hash = validate_snapshot(&snapshot_json, self.limits.max_snapshot_bytes)?;
        let now = now_unix_ms()?;
        let now_sql = sql_integer(now)?;
        let expected_head_sql = sql_integer(expected_head_revision)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(map_sqlite_error)?;

        if let Some(receipt) =
            load_commit_receipt(&transaction, &client_mutation_id, &request_hash)?
        {
            return Ok(receipt);
        }

        let project_state = transaction
            .query_row(
                "SELECT head_revision, stable_revision FROM projects WHERE library_project_id=?1",
                [&library_project_id],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
            )
            .optional()
            .map_err(map_sqlite_error)?;
        let Some((head_sql, stable_sql)) = project_state else {
            return Err(ProjectLibraryError::new(
                ProjectLibraryErrorCode::ProjectNotFound,
                "未找到指定的项目。",
                false,
            ));
        };
        let (head, stable) = checked_head_and_stable(head_sql, stable_sql)?;
        if head != expected_head_revision {
            return Err(ProjectLibraryError::new(
                ProjectLibraryErrorCode::RevisionConflict,
                "项目库已有更新修订，本次保存未覆盖它。",
                false,
            )
            .with_actual_head(head));
        }

        let session_state = transaction
            .query_row(
                "SELECT library_project_id, runtime_id, state, latest_revision
                 FROM project_sessions WHERE session_id=?1",
                [&session_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                    ))
                },
            )
            .optional()
            .map_err(map_sqlite_error)?;
        let Some((session_project_id, session_runtime_id, session_state, session_latest_sql)) =
            session_state
        else {
            return Err(ProjectLibraryError::new(
                ProjectLibraryErrorCode::SessionNotFound,
                "未找到指定的项目库会话。",
                false,
            ));
        };
        if session_project_id != library_project_id {
            return Err(ProjectLibraryError::new(
                ProjectLibraryErrorCode::SessionNotFound,
                "项目库会话不属于指定项目。",
                false,
            ));
        }
        let session_latest =
            checked_stored_positive_revision(session_latest_sql, "session revision")?;
        if session_runtime_id != self.runtime_id {
            if session_state == "open" && session_latest > stable {
                return Err(ProjectLibraryError::new(
                    ProjectLibraryErrorCode::RecoveryDecisionRequired,
                    "该会话属于上一次应用运行，需要先明确恢复或放弃。",
                    false,
                )
                .with_actual_head(head));
            }
            return Err(ProjectLibraryError::new(
                ProjectLibraryErrorCode::SessionClosed,
                "项目库会话不属于当前应用运行。",
                false,
            ));
        }
        if session_state != "open" {
            return Err(ProjectLibraryError::new(
                ProjectLibraryErrorCode::SessionClosed,
                "项目库会话已经关闭。",
                false,
            ));
        }
        if session_latest != expected_head_revision {
            return Err(ProjectLibraryError::new(
                ProjectLibraryErrorCode::RevisionConflict,
                "项目库会话基于过期修订，本次保存未覆盖新版本。",
                false,
            )
            .with_actual_head(head));
        }

        if let Some(source) = source_revision {
            let source_exists = transaction
                .query_row(
                    "SELECT 1 FROM project_revisions
                     WHERE library_project_id=?1 AND revision=?2",
                    params![library_project_id, sql_integer(source)?],
                    |_| Ok(()),
                )
                .optional()
                .map_err(map_sqlite_error)?
                .is_some();
            if !source_exists {
                return Err(ProjectLibraryError::new(
                    ProjectLibraryErrorCode::RevisionNotFound,
                    "rollback 来源修订不存在。",
                    false,
                ));
            }
        }

        let (current_hash, current_display_name, current_schema_version): (String, String, i64) =
            transaction
                .query_row(
                    "SELECT snapshot_sha256, display_name, project_schema_version
                 FROM project_revisions
                 WHERE library_project_id=?1 AND revision=?2",
                    params![library_project_id, head_sql],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .map_err(map_sqlite_error)?;
        if save_kind == ProjectLibrarySaveKind::Autosave
            && current_hash == snapshot_hash
            && current_display_name == display_name
            && current_schema_version == i64::from(project_schema_version)
        {
            let receipt = CommitProjectLibrarySessionValue {
                disposition: ProjectLibraryCommitDisposition::Unchanged,
                library_project_id,
                session_id,
                head_revision: head,
                stable_revision: stable,
                occurred_at_unix_ms: now,
                session_closed: false,
            };
            store_commit_receipt(&transaction, &client_mutation_id, &request_hash, &receipt)?;
            transaction.commit().map_err(map_sqlite_error)?;
            return Ok(receipt);
        }

        let revision = head
            .checked_add(1)
            .filter(|value| *value <= super::JAVASCRIPT_MAX_SAFE_INTEGER)
            .ok_or_else(|| {
                ProjectLibraryError::new(
                    ProjectLibraryErrorCode::LibraryQuotaExceeded,
                    "项目修订数量已超出支持范围。",
                    false,
                )
            })?;
        let revision_sql = sql_integer(revision)?;
        let schema_version_sql = i64::from(project_schema_version);
        let source_revision_sql = source_revision.map(sql_integer).transpose()?;
        let snapshot_len_sql = sql_integer(snapshot_json.len() as u64)?;
        transaction
            .execute(
                "INSERT INTO project_revisions (
                    library_project_id, revision, parent_revision, source_revision,
                    project_schema_version, display_name, save_kind, label, saved_at_ms,
                    snapshot_bytes, snapshot_sha256, snapshot_len
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                params![
                    library_project_id,
                    revision_sql,
                    head_sql,
                    source_revision_sql,
                    schema_version_sql,
                    display_name,
                    save_kind.as_str(),
                    label,
                    now_sql,
                    snapshot_json.as_bytes(),
                    snapshot_hash,
                    snapshot_len_sql
                ],
            )
            .map_err(map_sqlite_error)?;
        #[cfg(test)]
        trip_test_failpoint(
            test_failpoint,
            ProjectLibraryTestFailpoint::AfterRevisionInsert,
        )?;
        let new_stable = if matches!(
            save_kind,
            ProjectLibrarySaveKind::Checkpoint | ProjectLibrarySaveKind::Rollback
        ) {
            revision
        } else {
            stable
        };
        let changed = transaction
            .execute(
                "UPDATE projects
                 SET display_name=?1, project_schema_version=?2, head_revision=?3,
                     stable_revision=?4, updated_at_ms=?5
                 WHERE library_project_id=?6 AND head_revision=?7",
                params![
                    display_name,
                    schema_version_sql,
                    revision_sql,
                    sql_integer(new_stable)?,
                    now_sql,
                    library_project_id,
                    expected_head_sql
                ],
            )
            .map_err(map_sqlite_error)?;
        if changed != 1 {
            let actual = current_head(&transaction, &library_project_id)?.unwrap_or(head);
            return Err(ProjectLibraryError::new(
                ProjectLibraryErrorCode::RevisionConflict,
                "项目库已有更新修订，本次保存未覆盖它。",
                false,
            )
            .with_actual_head(actual));
        }
        #[cfg(test)]
        trip_test_failpoint(test_failpoint, ProjectLibraryTestFailpoint::AfterHeadUpdate)?;
        let session_changed = transaction
            .execute(
                "UPDATE project_sessions SET latest_revision=?1
                 WHERE session_id=?2 AND state='open' AND latest_revision=?3",
                params![revision_sql, session_id, expected_head_sql],
            )
            .map_err(map_sqlite_error)?;
        if session_changed != 1 {
            return Err(ProjectLibraryError::new(
                ProjectLibraryErrorCode::StorageCorrupt,
                "项目库会话在同一保存事务内发生了不可解释的变化。",
                false,
            ));
        }

        apply_retention(&transaction, &library_project_id, self.limits)?;

        let receipt = CommitProjectLibrarySessionValue {
            disposition: ProjectLibraryCommitDisposition::Committed,
            library_project_id,
            session_id,
            head_revision: revision,
            stable_revision: new_stable,
            occurred_at_unix_ms: now,
            session_closed: false,
        };
        store_commit_receipt(&transaction, &client_mutation_id, &request_hash, &receipt)?;
        #[cfg(test)]
        trip_test_failpoint(test_failpoint, ProjectLibraryTestFailpoint::BeforeCommit)?;
        transaction.commit().map_err(map_sqlite_error)?;
        #[cfg(test)]
        trip_test_failpoint(
            test_failpoint,
            ProjectLibraryTestFailpoint::AfterCommitBeforeReply,
        )?;
        Ok(receipt)
    }

    fn open_head(
        &mut self,
        access: SessionAccess,
        client_request_id: &str,
        request_hash: &str,
        library_project_id: String,
        expected_head_revision: u64,
    ) -> Result<OpenProjectLibrarySessionValue, ProjectLibraryError> {
        validate_identifier(&library_project_id, "libraryProjectId")?;
        validate_safe_positive_integer(expected_head_revision, "expectedHeadRevision")?;
        let now = now_unix_ms()?;
        let now_sql = sql_integer(now)?;
        let runtime_id = self.runtime_id.clone();
        let session_id = generate_identifier("session")?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(map_sqlite_error)?;
        if let Some(receipt) = load_open_receipt(
            &transaction,
            &runtime_id,
            client_request_id,
            request_hash,
            &self.runtime_lease,
            access,
        )? {
            transaction.commit().map_err(map_sqlite_error)?;
            return Ok(receipt);
        }
        let (head, stable) = load_head_and_stable(&transaction, &library_project_id)?;
        if head != expected_head_revision {
            return Err(revision_conflict(head));
        }
        let mut statement = transaction
            .prepare(
                "SELECT runtime_id, latest_revision FROM project_sessions
                 WHERE library_project_id=?1 AND state='open'",
            )
            .map_err(map_sqlite_error)?;
        let rows = statement
            .query_map([&library_project_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .map_err(map_sqlite_error)?;
        let mut has_current_session = false;
        let mut has_foreign_session = false;
        let mut recovery_required = false;
        for row in rows {
            let (owner_runtime, latest) = row.map_err(map_sqlite_error)?;
            let latest = checked_stored_u64(latest, "session revision")?;
            if owner_runtime == runtime_id {
                has_current_session = true;
            } else if latest > stable {
                recovery_required = true;
            } else {
                has_foreign_session = true;
            }
        }
        drop(statement);
        if has_current_session {
            return Err(ProjectLibraryError::new(
                ProjectLibraryErrorCode::ProjectAlreadyOpen,
                "该项目已经在当前应用会话中打开。",
                false,
            ));
        }
        if recovery_required {
            return Err(ProjectLibraryError::new(
                ProjectLibraryErrorCode::RecoveryDecisionRequired,
                "该项目存在未正常关闭的较新自动保存，需要先选择恢复或放弃。",
                false,
            )
            .with_actual_head(head));
        }
        if has_foreign_session {
            return Err(ProjectLibraryError::new(
                ProjectLibraryErrorCode::ProjectAlreadyOpen,
                "该项目仍由另一个应用运行保持打开。",
                false,
            ));
        }
        transaction
            .execute(
                "INSERT INTO project_sessions (
                    session_id, runtime_id, library_project_id, open_request_id,
                    opened_revision, latest_revision, state, opened_at_ms, closed_at_ms
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?5, 'open', ?6, NULL)",
                params![
                    session_id,
                    runtime_id,
                    library_project_id,
                    client_request_id,
                    sql_integer(head)?,
                    now_sql
                ],
            )
            .map_err(map_sqlite_error)?;
        transaction
            .execute(
                "UPDATE projects SET last_opened_at_ms=?1 WHERE library_project_id=?2",
                params![now_sql, library_project_id],
            )
            .map_err(map_sqlite_error)?;
        let value = build_open_value(
            &transaction,
            &runtime_id,
            library_project_id.clone(),
            session_id.clone(),
            head,
            stable,
            now,
        )?;
        store_open_receipt(&transaction, client_request_id, request_hash, &value)?;
        apply_retention(&transaction, &library_project_id, self.limits)?;
        transaction.commit().map_err(map_sqlite_error)?;
        Ok(value)
    }

    #[allow(clippy::too_many_arguments)]
    fn recover_session(
        &mut self,
        access: SessionAccess,
        client_request_id: &str,
        request_hash: &str,
        library_project_id: String,
        recovery_session_id: String,
        recovery_revision: u64,
        expected_head_revision: u64,
    ) -> Result<OpenProjectLibrarySessionValue, ProjectLibraryError> {
        validate_identifier(&library_project_id, "libraryProjectId")?;
        validate_identifier(&recovery_session_id, "recoverySessionId")?;
        validate_safe_positive_integer(recovery_revision, "recoveryRevision")?;
        validate_safe_positive_integer(expected_head_revision, "expectedHeadRevision")?;
        let now = now_unix_ms()?;
        let now_sql = sql_integer(now)?;
        let runtime_id = self.runtime_id.clone();
        let session_id = generate_identifier("session")?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(map_sqlite_error)?;
        if let Some(receipt) = load_open_receipt(
            &transaction,
            &runtime_id,
            client_request_id,
            request_hash,
            &self.runtime_lease,
            access,
        )? {
            transaction.commit().map_err(map_sqlite_error)?;
            return Ok(receipt);
        }
        let (head, stable) = load_head_and_stable(&transaction, &library_project_id)?;
        if head != expected_head_revision {
            return Err(revision_conflict(head));
        }
        let recovery = transaction
            .query_row(
                "SELECT library_project_id, runtime_id, latest_revision, state
                 FROM project_sessions WHERE session_id=?1",
                [&recovery_session_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                },
            )
            .optional()
            .map_err(map_sqlite_error)?;
        let Some((recovery_project, owner_runtime, latest_sql, state)) = recovery else {
            return Err(ProjectLibraryError::new(
                ProjectLibraryErrorCode::SessionNotFound,
                "未找到指定的恢复会话。",
                false,
            ));
        };
        let latest = checked_stored_u64(latest_sql, "recovery revision")?;
        if recovery_project != library_project_id
            || owner_runtime == runtime_id
            || state != "open"
            || latest != recovery_revision
            || recovery_revision != head
            || recovery_revision < stable
        {
            return Err(ProjectLibraryError::new(
                ProjectLibraryErrorCode::RecoveryDecisionRequired,
                "恢复候选已经变化，请重新读取项目库恢复列表。",
                false,
            )
            .with_actual_head(head));
        }
        access
            .require_inactive_owner(&self.runtime_lease, &owner_runtime)
            .map_err(|error| error.with_actual_head(head))?;
        let recovered_snapshot =
            load_snapshot(&transaction, &library_project_id, recovery_revision)?;
        let recovered_hash = sha256_hex(recovered_snapshot.snapshot_json.as_bytes());
        let revision = head
            .checked_add(1)
            .filter(|value| *value <= super::JAVASCRIPT_MAX_SAFE_INTEGER)
            .ok_or_else(|| {
                ProjectLibraryError::new(
                    ProjectLibraryErrorCode::LibraryQuotaExceeded,
                    "项目修订数量已超出支持范围。",
                    false,
                )
            })?;
        let revision_sql = sql_integer(revision)?;
        transaction
            .execute(
                "INSERT INTO project_revisions (
                    library_project_id, revision, parent_revision, source_revision,
                    project_schema_version, display_name, save_kind, label, saved_at_ms,
                    snapshot_bytes, snapshot_sha256, snapshot_len
                 ) VALUES (?1, ?2, ?3, ?3, ?4, ?5, 'recovered', NULL, ?6, ?7, ?8, ?9)",
                params![
                    library_project_id,
                    revision_sql,
                    sql_integer(recovery_revision)?,
                    i64::from(recovered_snapshot.project_schema_version),
                    recovered_snapshot.display_name,
                    now_sql,
                    recovered_snapshot.snapshot_json.as_bytes(),
                    recovered_hash,
                    sql_integer(recovered_snapshot.snapshot_json.len() as u64)?
                ],
            )
            .map_err(map_sqlite_error)?;
        let changed = transaction
            .execute(
                "UPDATE projects
                 SET display_name=?1, project_schema_version=?2, head_revision=?3,
                     updated_at_ms=?4, last_opened_at_ms=?4
                 WHERE library_project_id=?5 AND head_revision=?6",
                params![
                    recovered_snapshot.display_name,
                    i64::from(recovered_snapshot.project_schema_version),
                    revision_sql,
                    now_sql,
                    library_project_id,
                    sql_integer(expected_head_revision)?
                ],
            )
            .map_err(map_sqlite_error)?;
        if changed != 1 {
            let actual = current_head(&transaction, &library_project_id)?.unwrap_or(head);
            return Err(revision_conflict(actual));
        }
        transaction
            .execute(
                "UPDATE project_sessions SET state='abandoned', closed_at_ms=?1
                 WHERE library_project_id=?2 AND state='open'",
                params![now_sql, library_project_id],
            )
            .map_err(map_sqlite_error)?;
        transaction
            .execute(
                "INSERT INTO project_sessions (
                    session_id, runtime_id, library_project_id, open_request_id,
                    opened_revision, latest_revision, state, opened_at_ms, closed_at_ms
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?5, 'open', ?6, NULL)",
                params![
                    session_id,
                    runtime_id,
                    library_project_id,
                    client_request_id,
                    revision_sql,
                    now_sql
                ],
            )
            .map_err(map_sqlite_error)?;
        transaction
            .execute(
                "UPDATE projects SET last_opened_at_ms=?1 WHERE library_project_id=?2",
                params![now_sql, library_project_id],
            )
            .map_err(map_sqlite_error)?;
        let value = build_open_value(
            &transaction,
            &runtime_id,
            library_project_id,
            session_id,
            revision,
            stable,
            now,
        )?;
        store_open_receipt(&transaction, client_request_id, request_hash, &value)?;
        apply_retention(&transaction, &value.project.library_project_id, self.limits)?;
        transaction.commit().map_err(map_sqlite_error)?;
        Ok(value)
    }

    #[allow(clippy::too_many_arguments)]
    fn discard_recovery(
        &mut self,
        access: SessionAccess,
        client_request_id: &str,
        request_hash: &str,
        library_project_id: String,
        recovery_session_id: String,
        expected_head_revision: u64,
        source_revision: u64,
        display_name: String,
        project_schema_version: u32,
        snapshot_json: String,
    ) -> Result<OpenProjectLibrarySessionValue, ProjectLibraryError> {
        validate_identifier(&library_project_id, "libraryProjectId")?;
        validate_identifier(&recovery_session_id, "recoverySessionId")?;
        validate_safe_positive_integer(expected_head_revision, "expectedHeadRevision")?;
        validate_safe_positive_integer(source_revision, "sourceRevision")?;
        validate_display_name(&display_name)?;
        if project_schema_version == 0 {
            return Err(ProjectLibraryError::new(
                ProjectLibraryErrorCode::InvalidRequest,
                "projectSchemaVersion 必须大于 0。",
                false,
            ));
        }
        let snapshot_hash = validate_snapshot(&snapshot_json, self.limits.max_snapshot_bytes)?;
        let now = now_unix_ms()?;
        let now_sql = sql_integer(now)?;
        let runtime_id = self.runtime_id.clone();
        let session_id = generate_identifier("session")?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(map_sqlite_error)?;
        if let Some(receipt) = load_open_receipt(
            &transaction,
            &runtime_id,
            client_request_id,
            request_hash,
            &self.runtime_lease,
            access,
        )? {
            transaction.commit().map_err(map_sqlite_error)?;
            return Ok(receipt);
        }
        let (head, stable) = load_head_and_stable(&transaction, &library_project_id)?;
        if head != expected_head_revision {
            return Err(revision_conflict(head));
        }
        if source_revision != stable {
            return Err(ProjectLibraryError::new(
                ProjectLibraryErrorCode::RevisionConflict,
                "放弃恢复时提供的稳定修订已经过期。",
                false,
            )
            .with_actual_head(head));
        }
        let recovery = transaction
            .query_row(
                "SELECT library_project_id, runtime_id, latest_revision, state
                 FROM project_sessions WHERE session_id=?1",
                [&recovery_session_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                },
            )
            .optional()
            .map_err(map_sqlite_error)?;
        let Some((recovery_project, owner_runtime, recovery_latest_sql, state)) = recovery else {
            return Err(ProjectLibraryError::new(
                ProjectLibraryErrorCode::SessionNotFound,
                "未找到指定的恢复会话。",
                false,
            ));
        };
        let recovery_latest = checked_stored_u64(recovery_latest_sql, "recovery revision")?;
        if recovery_project != library_project_id
            || owner_runtime == runtime_id
            || state != "open"
            || recovery_latest != head
            || head <= stable
        {
            return Err(ProjectLibraryError::new(
                ProjectLibraryErrorCode::RecoveryDecisionRequired,
                "恢复候选已经变化，请重新读取项目库恢复列表。",
                false,
            )
            .with_actual_head(head));
        }
        access
            .require_inactive_owner(&self.runtime_lease, &owner_runtime)
            .map_err(|error| error.with_actual_head(head))?;
        let source_exists = transaction
            .query_row(
                "SELECT 1 FROM project_revisions
                 WHERE library_project_id=?1 AND revision=?2",
                params![library_project_id, sql_integer(source_revision)?],
                |_| Ok(()),
            )
            .optional()
            .map_err(map_sqlite_error)?
            .is_some();
        if !source_exists {
            return Err(ProjectLibraryError::new(
                ProjectLibraryErrorCode::RevisionNotFound,
                "放弃恢复的稳定来源修订不存在。",
                false,
            ));
        }
        let revision = head
            .checked_add(1)
            .filter(|value| *value <= super::JAVASCRIPT_MAX_SAFE_INTEGER)
            .ok_or_else(|| {
                ProjectLibraryError::new(
                    ProjectLibraryErrorCode::LibraryQuotaExceeded,
                    "项目修订数量已超出支持范围。",
                    false,
                )
            })?;
        let revision_sql = sql_integer(revision)?;
        transaction
            .execute(
                "INSERT INTO project_revisions (
                    library_project_id, revision, parent_revision, source_revision,
                    project_schema_version, display_name, save_kind, label, saved_at_ms,
                    snapshot_bytes, snapshot_sha256, snapshot_len
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'recoveryDiscarded', NULL, ?7, ?8, ?9, ?10)",
                params![
                    library_project_id,
                    revision_sql,
                    sql_integer(head)?,
                    sql_integer(source_revision)?,
                    i64::from(project_schema_version),
                    display_name,
                    now_sql,
                    snapshot_json.as_bytes(),
                    snapshot_hash,
                    sql_integer(snapshot_json.len() as u64)?
                ],
            )
            .map_err(map_sqlite_error)?;
        let changed = transaction
            .execute(
                "UPDATE projects
                 SET display_name=?1, project_schema_version=?2,
                     head_revision=?3, stable_revision=?3,
                     updated_at_ms=?4, last_opened_at_ms=?4
                 WHERE library_project_id=?5 AND head_revision=?6",
                params![
                    display_name,
                    i64::from(project_schema_version),
                    revision_sql,
                    now_sql,
                    library_project_id,
                    sql_integer(expected_head_revision)?
                ],
            )
            .map_err(map_sqlite_error)?;
        if changed != 1 {
            let actual = current_head(&transaction, &library_project_id)?.unwrap_or(head);
            return Err(revision_conflict(actual));
        }
        transaction
            .execute(
                "UPDATE project_sessions SET state='abandoned', closed_at_ms=?1
                 WHERE library_project_id=?2 AND state='open'",
                params![now_sql, library_project_id],
            )
            .map_err(map_sqlite_error)?;
        transaction
            .execute(
                "INSERT INTO project_sessions (
                    session_id, runtime_id, library_project_id, open_request_id,
                    opened_revision, latest_revision, state, opened_at_ms, closed_at_ms
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?5, 'open', ?6, NULL)",
                params![
                    session_id,
                    runtime_id,
                    library_project_id,
                    client_request_id,
                    revision_sql,
                    now_sql
                ],
            )
            .map_err(map_sqlite_error)?;
        let value = build_open_value(
            &transaction,
            &runtime_id,
            library_project_id.clone(),
            session_id.clone(),
            revision,
            revision,
            now,
        )?;
        store_open_receipt(&transaction, client_request_id, request_hash, &value)?;
        apply_retention(&transaction, &library_project_id, self.limits)?;
        transaction.commit().map_err(map_sqlite_error)?;
        Ok(value)
    }

    fn close_session(
        &mut self,
        library_project_id: String,
        session_id: String,
        client_mutation_id: String,
        request_hash: String,
        expected_head_revision: u64,
    ) -> Result<CommitProjectLibrarySessionValue, ProjectLibraryError> {
        let now = now_unix_ms()?;
        let now_sql = sql_integer(now)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(map_sqlite_error)?;
        if let Some(receipt) =
            load_commit_receipt(&transaction, &client_mutation_id, &request_hash)?
        {
            return Ok(receipt);
        }
        let (head, stable) = load_head_and_stable(&transaction, &library_project_id)?;
        if head != expected_head_revision {
            return Err(revision_conflict(head));
        }
        let session = transaction
            .query_row(
                "SELECT library_project_id, runtime_id, state, latest_revision
                 FROM project_sessions WHERE session_id=?1",
                [&session_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                    ))
                },
            )
            .optional()
            .map_err(map_sqlite_error)?;
        let Some((session_project, session_runtime_id, state, latest_sql)) = session else {
            return Err(ProjectLibraryError::new(
                ProjectLibraryErrorCode::SessionNotFound,
                "未找到指定的项目库会话。",
                false,
            ));
        };
        if session_project != library_project_id {
            return Err(ProjectLibraryError::new(
                ProjectLibraryErrorCode::SessionNotFound,
                "项目库会话不属于指定项目。",
                false,
            ));
        }
        let latest = checked_stored_positive_revision(latest_sql, "session revision")?;
        if session_runtime_id != self.runtime_id {
            if state == "open" && latest > stable {
                return Err(ProjectLibraryError::new(
                    ProjectLibraryErrorCode::RecoveryDecisionRequired,
                    "该会话属于上一次应用运行，需要先明确恢复或放弃。",
                    false,
                )
                .with_actual_head(head));
            }
            return Err(ProjectLibraryError::new(
                ProjectLibraryErrorCode::SessionClosed,
                "项目库会话不属于当前应用运行。",
                false,
            ));
        }
        if state != "open" {
            return Err(ProjectLibraryError::new(
                ProjectLibraryErrorCode::SessionClosed,
                "项目库会话已经关闭。",
                false,
            ));
        }
        if latest != head {
            return Err(revision_conflict(head));
        }
        let changed = transaction
            .execute(
                "UPDATE project_sessions SET state='closedClean', closed_at_ms=?1
                 WHERE session_id=?2 AND state='open' AND latest_revision=?3",
                params![now_sql, session_id, sql_integer(head)?],
            )
            .map_err(map_sqlite_error)?;
        if changed != 1 {
            return Err(ProjectLibraryError::new(
                ProjectLibraryErrorCode::SessionClosed,
                "项目库会话已经关闭。",
                false,
            ));
        }
        let project_changed = transaction
            .execute(
                "UPDATE projects SET stable_revision=?1 WHERE library_project_id=?2",
                params![sql_integer(head)?, library_project_id],
            )
            .map_err(map_sqlite_error)?;
        if project_changed != 1 {
            return Err(ProjectLibraryError::new(
                ProjectLibraryErrorCode::StorageCorrupt,
                "项目库会话存在，但所属项目在同一事务内缺失。",
                false,
            ));
        }
        apply_retention(&transaction, &library_project_id, self.limits)?;
        let receipt = CommitProjectLibrarySessionValue {
            disposition: ProjectLibraryCommitDisposition::Committed,
            library_project_id,
            session_id,
            head_revision: head,
            stable_revision: head,
            occurred_at_unix_ms: now,
            session_closed: true,
        };
        store_commit_receipt(&transaction, &client_mutation_id, &request_hash, &receipt)?;
        transaction.commit().map_err(map_sqlite_error)?;
        Ok(receipt)
    }

    fn list_revisions(
        &self,
        library_project_id: String,
        before_revision: Option<u64>,
        limit: u32,
    ) -> Result<ProjectLibraryQueryValue, ProjectLibraryError> {
        validate_identifier(&library_project_id, "libraryProjectId")?;
        if !(1..=100).contains(&limit) {
            return Err(ProjectLibraryError::new(
                ProjectLibraryErrorCode::InvalidRequest,
                "修订查询 limit 必须在 1 到 100 之间。",
                false,
            ));
        }
        if let Some(revision) = before_revision {
            validate_safe_positive_integer(revision, "beforeRevision")?;
        }
        let project =
            load_project_summary(&self.connection, &self.runtime_id, &library_project_id)?;
        let before_sql = before_revision
            .map(sql_integer)
            .transpose()?
            .unwrap_or(i64::MAX);
        let mut statement = self
            .connection
            .prepare(
                "SELECT revision, parent_revision, source_revision, save_kind,
                        label, saved_at_ms, snapshot_len
                 FROM project_revisions
                 WHERE library_project_id=?1 AND revision < ?2
                 ORDER BY revision DESC LIMIT ?3",
            )
            .map_err(map_sqlite_error)?;
        let rows = statement
            .query_map(
                params![library_project_id, before_sql, i64::from(limit)],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, Option<i64>>(1)?,
                        row.get::<_, Option<i64>>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, i64>(5)?,
                        row.get::<_, i64>(6)?,
                    ))
                },
            )
            .map_err(map_sqlite_error)?;
        let mut revisions = Vec::new();
        for row in rows {
            let (revision, parent, source, kind, label, saved_at, snapshot_bytes) =
                row.map_err(map_sqlite_error)?;
            let save_kind = ProjectLibrarySaveKind::parse(&kind).ok_or_else(|| {
                ProjectLibraryError::new(
                    ProjectLibraryErrorCode::StorageCorrupt,
                    "项目修订类型无效。",
                    false,
                )
            })?;
            revisions.push(ProjectLibraryRevisionSummary {
                revision: checked_stored_u64(revision, "revision")?,
                parent_revision: parent
                    .map(|value| checked_stored_u64(value, "parent revision"))
                    .transpose()?,
                source_revision: source
                    .map(|value| checked_stored_u64(value, "source revision"))
                    .transpose()?,
                save_kind,
                label,
                saved_at_unix_ms: checked_stored_u64(saved_at, "saved time")?,
                snapshot_bytes: checked_stored_u64(snapshot_bytes, "snapshot length")?,
            });
        }
        Ok(ProjectLibraryQueryValue::Revisions { project, revisions })
    }

    fn list_recent(
        &self,
        limit: u32,
        cursor: Option<&str>,
    ) -> Result<ProjectLibraryQueryValue, ProjectLibraryError> {
        if !(1..=50).contains(&limit) {
            return Err(ProjectLibraryError::new(
                ProjectLibraryErrorCode::InvalidRequest,
                "最近项目查询 limit 必须在 1 到 50 之间。",
                false,
            ));
        }
        let cursor = cursor.map(parse_recent_cursor).transpose()?;
        let row_limit = i64::from(limit) + 1;
        let mut ids = Vec::new();
        if let Some((cursor_time, cursor_project_id)) = cursor {
            let mut statement = self
                .connection
                .prepare(
                    "SELECT library_project_id, last_opened_at_ms FROM projects
                     WHERE last_opened_at_ms < ?1
                        OR (last_opened_at_ms = ?1 AND library_project_id > ?2)
                     ORDER BY last_opened_at_ms DESC, library_project_id ASC
                     LIMIT ?3",
                )
                .map_err(map_sqlite_error)?;
            let rows = statement
                .query_map(
                    params![sql_integer(cursor_time)?, cursor_project_id, row_limit],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
                )
                .map_err(map_sqlite_error)?;
            for row in rows {
                let (project_id, opened_at) = row.map_err(map_sqlite_error)?;
                ids.push((project_id, checked_stored_u64(opened_at, "opened time")?));
            }
        } else {
            let mut statement = self
                .connection
                .prepare(
                    "SELECT library_project_id, last_opened_at_ms FROM projects
                     ORDER BY last_opened_at_ms DESC, library_project_id ASC
                     LIMIT ?1",
                )
                .map_err(map_sqlite_error)?;
            let rows = statement
                .query_map([row_limit], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
                })
                .map_err(map_sqlite_error)?;
            for row in rows {
                let (project_id, opened_at) = row.map_err(map_sqlite_error)?;
                ids.push((project_id, checked_stored_u64(opened_at, "opened time")?));
            }
        }

        let has_more = ids.len() > limit as usize;
        if has_more {
            ids.truncate(limit as usize);
        }
        let next_cursor = if has_more {
            ids.last()
                .map(|(project_id, opened_at)| format!("v1:{opened_at}:{project_id}"))
        } else {
            None
        };
        let mut projects = Vec::with_capacity(ids.len());
        for (project_id, _) in ids {
            let mut summary =
                load_project_summary(&self.connection, &self.runtime_id, &project_id)?;
            // A display alias belongs only to the recent list. Open/recovery replies must
            // preserve the exact name paired with their immutable snapshot.
            if summary.display_name.trim().is_empty() || summary.display_name == "未命名项目" {
                let key = (project_id.clone(), summary.head_revision);
                let cached = self.recent_name_cache.borrow().get(&key).cloned();
                let alias = cached.unwrap_or_else(|| {
                    let title: Option<String> = self.connection.query_row(
                        "SELECT CASE WHEN json_valid(CAST(snapshot_bytes AS TEXT)) THEN COALESCE(
                            NULLIF(json_extract(CAST(snapshot_bytes AS TEXT), '$.familyArrangement.title'), ''),
                            NULLIF(json_extract(CAST(snapshot_bytes AS TEXT), '$.mediaLibrary[0].emby.seriesName'), ''),
                            NULLIF(json_extract(CAST(snapshot_bytes AS TEXT), '$.mediaLibrary[0].name'), ''),
                            NULLIF(json_extract(CAST(snapshot_bytes AS TEXT), '$.mediaBinding.displayName'), ''),
                            NULLIF(json_extract(CAST(snapshot_bytes AS TEXT), '$.assets[0].name'), '')
                        ) ELSE NULL END FROM project_revisions WHERE library_project_id=?1 AND revision=?2",
                        params![project_id, summary.head_revision as i64], |row| row.get(0)
                    ).ok().flatten();
                    let alias = title.filter(|name| !name.trim().is_empty()).unwrap_or_else(|| summary.display_name.clone()).chars().take(180).collect::<String>();
                    let mut cache = self.recent_name_cache.borrow_mut();
                    if cache.len() > 100 { cache.clear(); }
                    cache.insert(key, alias.clone());
                    alias
                });
                summary.display_name = alias;
            }
            projects.push(summary);
        }
        Ok(ProjectLibraryQueryValue::Recent {
            projects,
            next_cursor,
        })
    }

    fn list_recoveries(&self) -> Result<ProjectLibraryQueryValue, ProjectLibraryError> {
        let mut statement = self
            .connection
            .prepare(
                "SELECT p.library_project_id, p.display_name, s.session_id,
                        s.opened_revision, s.latest_revision, p.stable_revision,
                         r.saved_at_ms, s.runtime_id
                 FROM project_sessions s
                 JOIN projects p ON p.library_project_id=s.library_project_id
                 JOIN project_revisions r
                   ON r.library_project_id=s.library_project_id
                  AND r.revision=s.latest_revision
                 WHERE s.state='open' AND s.runtime_id<>?1
                 ORDER BY r.saved_at_ms DESC, p.library_project_id ASC, s.session_id ASC",
            )
            .map_err(map_sqlite_error)?;
        let rows = statement
            .query_map([&self.runtime_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, String>(7)?,
                ))
            })
            .map_err(map_sqlite_error)?;
        let mut recoveries = Vec::new();
        for row in rows {
            let (project_id, display_name, session_id, opened, latest, stable, saved_at, owner) =
                row.map_err(map_sqlite_error)?;
            match self
                .runtime_lease
                .owner_state(&owner)
                .map_err(|_| storage_unavailable())?
            {
                OwnerState::Alive => continue,
                OwnerState::Dead if latest <= stable => continue,
                _ => {}
            }
            recoveries.push(super::ProjectLibraryRecoveryCandidate {
                library_project_id: project_id,
                display_name,
                recovery_session_id: session_id,
                opened_revision: checked_stored_u64(opened, "opened revision")?,
                recovery_revision: checked_stored_u64(latest, "recovery revision")?,
                stable_revision: checked_stored_u64(stable, "stable revision")?,
                last_saved_at_unix_ms: checked_stored_u64(saved_at, "saved time")?,
                has_newer_autosave: latest > stable,
            });
        }
        Ok(ProjectLibraryQueryValue::Recoveries { recoveries })
    }
}

fn migrate(
    connection: &mut Connection,
    fail_before_commit: bool,
) -> Result<(), ProjectLibraryError> {
    let version: i64 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(map_sqlite_error)?;
    if version > PROJECT_LIBRARY_STORAGE_VERSION {
        return Err(ProjectLibraryError::new(
            ProjectLibraryErrorCode::UnsupportedStorageVersion,
            "项目库由更新版本的应用创建，当前版本只能保持失败关闭。",
            false,
        ));
    }
    if version == PROJECT_LIBRARY_STORAGE_VERSION {
        return Ok(());
    }
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| migration_failed())?;
    transaction
        .execute_batch(
            "CREATE TABLE projects (
                 library_project_id TEXT PRIMARY KEY,
                 display_name TEXT NOT NULL,
                 project_schema_version INTEGER NOT NULL,
                 head_revision INTEGER NOT NULL,
                 stable_revision INTEGER NOT NULL,
                 created_at_ms INTEGER NOT NULL,
                 updated_at_ms INTEGER NOT NULL,
                 last_opened_at_ms INTEGER NOT NULL
             );
             CREATE INDEX projects_recent_idx
                 ON projects(last_opened_at_ms DESC, library_project_id ASC);
             CREATE TABLE project_revisions (
                 library_project_id TEXT NOT NULL,
                 revision INTEGER NOT NULL,
                 parent_revision INTEGER,
                 source_revision INTEGER,
                 project_schema_version INTEGER NOT NULL,
                 display_name TEXT NOT NULL,
                 save_kind TEXT NOT NULL,
                 label TEXT,
                 saved_at_ms INTEGER NOT NULL,
                 snapshot_bytes BLOB NOT NULL,
                 snapshot_sha256 TEXT NOT NULL,
                 snapshot_len INTEGER NOT NULL,
                 PRIMARY KEY (library_project_id, revision),
                 FOREIGN KEY (library_project_id) REFERENCES projects(library_project_id) ON DELETE CASCADE
             );
             CREATE TABLE project_sessions (
                 session_id TEXT PRIMARY KEY,
                 runtime_id TEXT NOT NULL,
                 library_project_id TEXT NOT NULL,
                 open_request_id TEXT NOT NULL UNIQUE,
                 opened_revision INTEGER NOT NULL,
                 latest_revision INTEGER NOT NULL,
                 state TEXT NOT NULL,
                 opened_at_ms INTEGER NOT NULL,
                 closed_at_ms INTEGER,
                 FOREIGN KEY (library_project_id) REFERENCES projects(library_project_id) ON DELETE CASCADE
             );
             CREATE INDEX project_sessions_recovery_idx
                 ON project_sessions(library_project_id, state, latest_revision);
             CREATE TABLE project_open_operations (
                 client_request_id TEXT PRIMARY KEY,
                 request_sha256 TEXT NOT NULL,
                 response_metadata_json BLOB NOT NULL,
                 selected_revision INTEGER NOT NULL
             );
             CREATE TABLE project_commit_operations (
                 client_mutation_id TEXT PRIMARY KEY,
                 request_sha256 TEXT NOT NULL,
                 response_json BLOB NOT NULL
             );",
        )
        .map_err(|_| migration_failed())?;
    if fail_before_commit {
        return Err(migration_failed());
    }
    transaction
        .pragma_update(None, "user_version", PROJECT_LIBRARY_STORAGE_VERSION)
        .map_err(|_| migration_failed())?;
    transaction.commit().map_err(|_| migration_failed())?;
    Ok(())
}

fn live_owner_error() -> ProjectLibraryError {
    ProjectLibraryError::new(
        ProjectLibraryErrorCode::ProjectAlreadyOpen,
        "该项目仍由另一个应用实例保持打开；请先在另一实例中关闭项目后重试。",
        false,
    )
}

fn migration_failed() -> ProjectLibraryError {
    ProjectLibraryError::new(
        ProjectLibraryErrorCode::MigrationFailed,
        "项目库结构升级失败，原有数据未被替换。",
        false,
    )
}

fn load_snapshot(
    connection: &Connection,
    library_project_id: &str,
    revision: u64,
) -> Result<StoredProjectSnapshot, ProjectLibraryError> {
    let row = connection
        .query_row(
            "SELECT r.display_name, r.project_schema_version, r.saved_at_ms,
                    r.snapshot_bytes, r.snapshot_sha256, r.snapshot_len
             FROM project_revisions r
             WHERE r.library_project_id = ?1 AND r.revision = ?2",
            params![library_project_id, sql_integer(revision)?],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, Vec<u8>>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, i64>(5)?,
                ))
            },
        )
        .optional()
        .map_err(map_sqlite_error)?;
    let Some((
        display_name,
        project_schema_version_sql,
        saved_at_unix_ms_sql,
        bytes,
        expected_hash,
        snapshot_len_sql,
    )) = row
    else {
        let project_exists = connection
            .query_row(
                "SELECT 1 FROM projects WHERE library_project_id = ?1",
                [library_project_id],
                |_| Ok(()),
            )
            .optional()
            .map_err(map_sqlite_error)?
            .is_some();
        return Err(ProjectLibraryError::new(
            if project_exists {
                ProjectLibraryErrorCode::RevisionNotFound
            } else {
                ProjectLibraryErrorCode::ProjectNotFound
            },
            if project_exists {
                "未找到指定的项目修订。"
            } else {
                "未找到指定的项目。"
            },
            false,
        ));
    };
    let project_schema_version = u32::try_from(project_schema_version_sql)
        .ok()
        .filter(|value| *value > 0)
        .ok_or_else(|| {
            ProjectLibraryError::new(
                ProjectLibraryErrorCode::StorageCorrupt,
                "项目修订中的 schema version 无效。",
                false,
            )
        })?;
    if display_name.trim().is_empty() || display_name.len() > 1024 {
        return Err(ProjectLibraryError::new(
            ProjectLibraryErrorCode::StorageCorrupt,
            "项目修订中的显示名无效。",
            false,
        ));
    }
    let saved_at_unix_ms = u64::try_from(saved_at_unix_ms_sql).map_err(|_| {
        ProjectLibraryError::new(
            ProjectLibraryErrorCode::StorageCorrupt,
            "项目修订中的保存时间无效。",
            false,
        )
    })?;
    let snapshot_len = checked_stored_u64(snapshot_len_sql, "snapshot length")?;
    if snapshot_len != bytes.len() as u64 {
        return Err(ProjectLibraryError::new(
            ProjectLibraryErrorCode::StorageCorrupt,
            "项目修订长度校验失败。",
            false,
        ));
    }
    let actual_hash = sha256_hex(&bytes);
    if actual_hash != expected_hash {
        return Err(ProjectLibraryError::new(
            ProjectLibraryErrorCode::StorageCorrupt,
            "项目修订完整性校验失败，未自动回退到其他版本。",
            false,
        ));
    }
    let snapshot_json = String::from_utf8(bytes).map_err(|_| {
        ProjectLibraryError::new(
            ProjectLibraryErrorCode::StorageCorrupt,
            "项目修订不是有效的 UTF-8 数据。",
            false,
        )
    })?;
    if snapshot_json.trim_start().as_bytes().first() != Some(&b'{') {
        return Err(ProjectLibraryError::new(
            ProjectLibraryErrorCode::StorageCorrupt,
            "项目修订不是有效的 JSON object。",
            false,
        ));
    }
    let mut deserializer = serde_json::Deserializer::from_str(&snapshot_json);
    IgnoredAny::deserialize(&mut deserializer)
        .and_then(|_| deserializer.end())
        .map_err(|_| {
            ProjectLibraryError::new(
                ProjectLibraryErrorCode::StorageCorrupt,
                "项目修订不是完整有效的 JSON object。",
                false,
            )
        })?;
    Ok(StoredProjectSnapshot {
        library_project_id: library_project_id.to_string(),
        revision,
        display_name,
        project_schema_version,
        saved_at_unix_ms,
        snapshot_json,
    })
}

fn validate_snapshot(snapshot_json: &str, max_bytes: usize) -> Result<String, ProjectLibraryError> {
    if snapshot_json.len() > max_bytes {
        return Err(ProjectLibraryError::new(
            ProjectLibraryErrorCode::SnapshotTooLarge,
            "项目快照超过本地项目库允许的大小。",
            false,
        ));
    }
    if snapshot_json.trim_start().as_bytes().first() != Some(&b'{') {
        return Err(ProjectLibraryError::new(
            ProjectLibraryErrorCode::InvalidSnapshotJson,
            "项目快照必须是完整的 JSON object。",
            false,
        ));
    }
    let mut deserializer = serde_json::Deserializer::from_str(snapshot_json);
    IgnoredAny::deserialize(&mut deserializer).map_err(|_| {
        ProjectLibraryError::new(
            ProjectLibraryErrorCode::InvalidSnapshotJson,
            "项目快照必须是完整有效的 JSON object。",
            false,
        )
    })?;
    deserializer.end().map_err(|_| {
        ProjectLibraryError::new(
            ProjectLibraryErrorCode::InvalidSnapshotJson,
            "项目快照末尾包含额外数据。",
            false,
        )
    })?;
    Ok(sha256_hex(snapshot_json.as_bytes()))
}

fn validate_identifier(value: &str, field: &str) -> Result<(), ProjectLibraryError> {
    if !value.trim().is_empty() && value.len() <= 128 {
        Ok(())
    } else {
        Err(ProjectLibraryError::new(
            ProjectLibraryErrorCode::InvalidRequest,
            format!("项目库 {field} 必须非空且不超过 128 bytes。"),
            false,
        ))
    }
}

fn parse_recent_cursor(cursor: &str) -> Result<(u64, String), ProjectLibraryError> {
    if cursor.len() > 256 {
        return Err(invalid_cursor());
    }
    let mut parts = cursor.splitn(3, ':');
    if parts.next() != Some("v1") {
        return Err(invalid_cursor());
    }
    let opened_at = parts
        .next()
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or_else(invalid_cursor)?;
    let project_id = parts.next().ok_or_else(invalid_cursor)?.to_string();
    validate_safe_positive_integer(opened_at, "recent cursor time")?;
    validate_identifier(&project_id, "recent cursor project")?;
    Ok((opened_at, project_id))
}

fn invalid_cursor() -> ProjectLibraryError {
    ProjectLibraryError::new(
        ProjectLibraryErrorCode::InvalidRequest,
        "最近项目 cursor 无效。",
        false,
    )
}

fn validate_client_operation_id(value: &str) -> Result<(), ProjectLibraryError> {
    validate_identifier(value, "client operation id")
}

fn validate_display_name(value: &str) -> Result<(), ProjectLibraryError> {
    if !value.trim().is_empty() && value.len() <= 1024 {
        Ok(())
    } else {
        Err(ProjectLibraryError::new(
            ProjectLibraryErrorCode::InvalidRequest,
            "项目显示名必须非空且不超过 1024 bytes。",
            false,
        ))
    }
}

fn validate_label(value: Option<&str>) -> Result<(), ProjectLibraryError> {
    if value.is_none_or(|label| label.len() <= 256) {
        Ok(())
    } else {
        Err(ProjectLibraryError::new(
            ProjectLibraryErrorCode::InvalidRequest,
            "项目修订标签不得超过 256 bytes。",
            false,
        ))
    }
}

fn request_digest<T: serde::Serialize>(request: &T) -> Result<String, ProjectLibraryError> {
    let mut hasher = Sha256::new();
    serde_json::to_writer(DigestWriter(&mut hasher), request).map_err(|_| {
        ProjectLibraryError::new(
            ProjectLibraryErrorCode::InvalidRequest,
            "项目库请求无法序列化。",
            false,
        )
    })?;
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

struct DigestWriter<'a>(&'a mut Sha256);

impl Write for DigestWriter<'_> {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.0.update(buffer);
        Ok(buffer.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn load_commit_receipt(
    connection: &Connection,
    client_mutation_id: &str,
    request_hash: &str,
) -> Result<Option<CommitProjectLibrarySessionValue>, ProjectLibraryError> {
    let stored = connection
        .query_row(
            "SELECT request_sha256, response_json FROM project_commit_operations
             WHERE client_mutation_id=?1",
            [client_mutation_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?)),
        )
        .optional()
        .map_err(map_sqlite_error)?;
    let Some((stored_hash, response)) = stored else {
        return Ok(None);
    };
    if stored_hash != request_hash {
        return Err(ProjectLibraryError::new(
            ProjectLibraryErrorCode::IdempotencyMismatch,
            "clientMutationId 已用于不同的项目库请求。",
            false,
        ));
    }
    let mut receipt: CommitProjectLibrarySessionValue =
        serde_json::from_slice(&response).map_err(|_| {
            ProjectLibraryError::new(
                ProjectLibraryErrorCode::StorageCorrupt,
                "项目库幂等回执损坏。",
                false,
            )
        })?;
    if receipt.library_project_id.trim().is_empty()
        || receipt.library_project_id.len() > 128
        || receipt.session_id.trim().is_empty()
        || receipt.session_id.len() > 128
        || receipt.head_revision == 0
        || receipt.head_revision > super::JAVASCRIPT_MAX_SAFE_INTEGER
        || receipt.stable_revision == 0
        || receipt.stable_revision > receipt.head_revision
        || receipt.occurred_at_unix_ms > super::JAVASCRIPT_MAX_SAFE_INTEGER
        || (receipt.session_closed && receipt.stable_revision != receipt.head_revision)
        || (receipt.disposition == ProjectLibraryCommitDisposition::Unchanged
            && receipt.session_closed)
    {
        return Err(ProjectLibraryError::new(
            ProjectLibraryErrorCode::StorageCorrupt,
            "项目库提交回执字段不一致。",
            false,
        ));
    }
    receipt.disposition = ProjectLibraryCommitDisposition::AlreadyCommitted;
    Ok(Some(receipt))
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OpenReceiptMetadata {
    project: ProjectLibraryProjectSummary,
    session: ProjectLibrarySessionSummary,
}

fn load_open_receipt(
    connection: &rusqlite::Transaction<'_>,
    runtime_id: &str,
    client_request_id: &str,
    request_hash: &str,
    runtime_lease: &RuntimeLease,
    access: SessionAccess,
) -> Result<Option<OpenProjectLibrarySessionValue>, ProjectLibraryError> {
    let stored = connection
        .query_row(
            "SELECT request_sha256, response_metadata_json, selected_revision
             FROM project_open_operations WHERE client_request_id=?1",
            [client_request_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Vec<u8>>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            },
        )
        .optional()
        .map_err(map_sqlite_error)?;
    let Some((stored_hash, metadata_bytes, selected_revision_sql)) = stored else {
        return Ok(None);
    };
    if stored_hash != request_hash {
        return Err(ProjectLibraryError::new(
            ProjectLibraryErrorCode::IdempotencyMismatch,
            "clientRequestId 已用于不同的项目库请求。",
            false,
        ));
    }
    let metadata: OpenReceiptMetadata = serde_json::from_slice(&metadata_bytes).map_err(|_| {
        ProjectLibraryError::new(
            ProjectLibraryErrorCode::StorageCorrupt,
            "项目库打开回执损坏。",
            false,
        )
    })?;
    let selected_revision = checked_stored_u64(selected_revision_sql, "selected revision")?;
    let snapshot = load_snapshot(
        connection,
        &metadata.project.library_project_id,
        selected_revision,
    )?;
    if !project_summary_fields_are_valid(&metadata.project)
        || !session_summary_fields_are_valid(&metadata.session)
        || metadata.project.library_project_id != snapshot.library_project_id
        || metadata.project.head_revision != selected_revision
        || metadata.project.stable_revision != metadata.session.stable_revision
        || metadata.project.display_name != snapshot.display_name
        || metadata.project.project_schema_version != snapshot.project_schema_version
        || metadata.project.has_recovery
        || metadata.session.opened_revision != selected_revision
        || metadata.session.current_revision != selected_revision
        || metadata.session.session_id.trim().is_empty()
        || metadata.session.session_id.len() > 128
    {
        return Err(ProjectLibraryError::new(
            ProjectLibraryErrorCode::StorageCorrupt,
            "项目库打开回执的项目、会话和修订不一致。",
            false,
        ));
    }

    let stored_session = connection
        .query_row(
            "SELECT runtime_id, library_project_id, open_request_id,
                    opened_revision, latest_revision, state
             FROM project_sessions WHERE session_id=?1",
            [&metadata.session.session_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, String>(5)?,
                ))
            },
        )
        .optional()
        .map_err(map_sqlite_error)?;
    let Some((owner_runtime, session_project, open_request_id, opened_sql, latest_sql, state)) =
        stored_session
    else {
        return Err(ProjectLibraryError::new(
            ProjectLibraryErrorCode::SessionClosed,
            "项目库打开回执对应的会话已经不存在。",
            false,
        ));
    };
    let opened_revision = checked_stored_positive_revision(opened_sql, "opened revision")?;
    let latest_revision = checked_stored_positive_revision(latest_sql, "session revision")?;
    if session_project != metadata.project.library_project_id
        || open_request_id != client_request_id
        || opened_revision != selected_revision
    {
        return Err(ProjectLibraryError::new(
            ProjectLibraryErrorCode::StorageCorrupt,
            "项目库打开回执与会话记录不一致。",
            false,
        ));
    }
    if owner_runtime == runtime_id {
        return Ok(Some(OpenProjectLibrarySessionValue {
            project: metadata.project,
            session: metadata.session,
            snapshot,
        }));
    }
    let (actual_head, stable_revision) =
        load_head_and_stable(connection, &metadata.project.library_project_id)?;
    access
        .require_inactive_owner(runtime_lease, &owner_runtime)
        .map_err(|error| error.with_actual_head(actual_head))?;
    if state != "open" && state != "closedRuntime" {
        return Err(ProjectLibraryError::new(
            ProjectLibraryErrorCode::SessionClosed,
            "项目库打开回执对应的会话已经关闭。",
            false,
        ));
    }
    if latest_revision != selected_revision {
        if latest_revision > stable_revision {
            return Err(ProjectLibraryError::new(
                ProjectLibraryErrorCode::RecoveryDecisionRequired,
                "项目库打开回执对应的会话已有较新自动保存，需要先明确恢复或放弃。",
                false,
            )
            .with_actual_head(actual_head));
        }
        return Err(ProjectLibraryError::new(
            ProjectLibraryErrorCode::SessionClosed,
            "项目库打开回执对应的会话已经变化。",
            false,
        ));
    }
    if actual_head != selected_revision {
        return Err(revision_conflict(actual_head));
    }
    let changed = connection
        .execute(
            "UPDATE project_sessions
             SET runtime_id=?1, state='open', closed_at_ms=NULL
             WHERE session_id=?2 AND runtime_id=?3 AND library_project_id=?4
               AND open_request_id=?5 AND state IN ('open', 'closedRuntime')
               AND opened_revision=?6 AND latest_revision=?6
               AND EXISTS (
                 SELECT 1 FROM projects p
                 WHERE p.library_project_id=?4 AND p.head_revision=?6
               ) AND NOT EXISTS (
                 SELECT 1 FROM project_sessions other
                 WHERE other.library_project_id=?4 AND other.state='open' AND other.session_id<>?2
               )",
            params![
                runtime_id,
                metadata.session.session_id,
                owner_runtime,
                metadata.project.library_project_id,
                client_request_id,
                sql_integer(selected_revision)?
            ],
        )
        .map_err(map_sqlite_error)?;
    if changed != 1 {
        return Err(ProjectLibraryError::new(
            ProjectLibraryErrorCode::SessionClosed,
            "项目库打开回执对应的会话已由其他运行接管。",
            false,
        ));
    }
    Ok(Some(OpenProjectLibrarySessionValue {
        project: metadata.project,
        session: metadata.session,
        snapshot,
    }))
}

fn store_open_receipt(
    connection: &Connection,
    client_request_id: &str,
    request_hash: &str,
    value: &OpenProjectLibrarySessionValue,
) -> Result<(), ProjectLibraryError> {
    let metadata = OpenReceiptMetadata {
        project: value.project.clone(),
        session: value.session.clone(),
    };
    let metadata_bytes = serde_json::to_vec(&metadata).map_err(|_| {
        ProjectLibraryError::new(
            ProjectLibraryErrorCode::Internal,
            "项目库无法生成打开回执。",
            false,
        )
    })?;
    connection
        .execute(
            "INSERT INTO project_open_operations (
                client_request_id, request_sha256, response_metadata_json, selected_revision
             ) VALUES (?1, ?2, ?3, ?4)",
            params![
                client_request_id,
                request_hash,
                metadata_bytes,
                sql_integer(value.snapshot.revision)?
            ],
        )
        .map_err(map_sqlite_error)?;
    Ok(())
}

fn build_open_value(
    connection: &Connection,
    runtime_id: &str,
    library_project_id: String,
    session_id: String,
    selected_revision: u64,
    stable_revision: u64,
    opened_at_unix_ms: u64,
) -> Result<OpenProjectLibrarySessionValue, ProjectLibraryError> {
    let project = load_project_summary(connection, runtime_id, &library_project_id)?;
    let snapshot = load_snapshot(connection, &library_project_id, selected_revision)?;
    Ok(OpenProjectLibrarySessionValue {
        project,
        session: ProjectLibrarySessionSummary {
            session_id,
            opened_revision: selected_revision,
            current_revision: selected_revision,
            stable_revision,
            opened_at_unix_ms,
        },
        snapshot,
    })
}

fn store_commit_receipt(
    connection: &Connection,
    client_mutation_id: &str,
    request_hash: &str,
    receipt: &CommitProjectLibrarySessionValue,
) -> Result<(), ProjectLibraryError> {
    let response = serde_json::to_vec(receipt).map_err(|_| {
        ProjectLibraryError::new(
            ProjectLibraryErrorCode::Internal,
            "项目库无法生成提交回执。",
            false,
        )
    })?;
    connection
        .execute(
            "INSERT INTO project_commit_operations (
                client_mutation_id, request_sha256, response_json
             ) VALUES (?1, ?2, ?3)",
            params![client_mutation_id, request_hash, response],
        )
        .map_err(map_sqlite_error)?;
    Ok(())
}

fn current_head(
    connection: &Connection,
    library_project_id: &str,
) -> Result<Option<u64>, ProjectLibraryError> {
    connection
        .query_row(
            "SELECT head_revision FROM projects WHERE library_project_id=?1",
            [library_project_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(map_sqlite_error)?
        .map(|value| checked_stored_positive_revision(value, "head revision"))
        .transpose()
}

fn load_head_and_stable(
    connection: &Connection,
    library_project_id: &str,
) -> Result<(u64, u64), ProjectLibraryError> {
    let row = connection
        .query_row(
            "SELECT head_revision, stable_revision FROM projects WHERE library_project_id=?1",
            [library_project_id],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()
        .map_err(map_sqlite_error)?;
    let Some((head, stable)) = row else {
        return Err(ProjectLibraryError::new(
            ProjectLibraryErrorCode::ProjectNotFound,
            "未找到指定的项目。",
            false,
        ));
    };
    checked_head_and_stable(head, stable)
}

fn checked_head_and_stable(
    head_sql: i64,
    stable_sql: i64,
) -> Result<(u64, u64), ProjectLibraryError> {
    let head = checked_stored_positive_revision(head_sql, "head revision")?;
    let stable = checked_stored_positive_revision(stable_sql, "stable revision")?;
    if stable > head {
        return Err(ProjectLibraryError::new(
            ProjectLibraryErrorCode::StorageCorrupt,
            "项目库稳定修订不能晚于 head。",
            false,
        ));
    }
    Ok((head, stable))
}

fn checked_stored_positive_revision(value: i64, field: &str) -> Result<u64, ProjectLibraryError> {
    let value = checked_stored_u64(value, field)?;
    if value == 0 {
        return Err(corrupt_integer());
    }
    Ok(value)
}

fn revision_conflict(actual_head: u64) -> ProjectLibraryError {
    ProjectLibraryError::new(
        ProjectLibraryErrorCode::RevisionConflict,
        "项目库已有更新修订，本次操作未覆盖它。",
        false,
    )
    .with_actual_head(actual_head)
}

fn load_project_summary(
    connection: &Connection,
    runtime_id: &str,
    library_project_id: &str,
) -> Result<ProjectLibraryProjectSummary, ProjectLibraryError> {
    let row = connection
        .query_row(
            "SELECT display_name, project_schema_version, head_revision, stable_revision,
                    created_at_ms, updated_at_ms, last_opened_at_ms,
                    EXISTS(
                      SELECT 1 FROM project_sessions s
                      WHERE s.library_project_id=projects.library_project_id
                        AND s.state='open' AND s.runtime_id<>?2
                        AND s.latest_revision>projects.stable_revision
                    )
             FROM projects WHERE library_project_id=?1",
            params![library_project_id, runtime_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, bool>(7)?,
                ))
            },
        )
        .optional()
        .map_err(map_sqlite_error)?;
    let Some((display_name, schema, head, stable, created, updated, opened, has_recovery)) = row
    else {
        return Err(ProjectLibraryError::new(
            ProjectLibraryErrorCode::ProjectNotFound,
            "未找到指定的项目。",
            false,
        ));
    };
    let summary = ProjectLibraryProjectSummary {
        library_project_id: library_project_id.to_string(),
        display_name,
        project_schema_version: u32::try_from(schema).map_err(|_| corrupt_integer())?,
        head_revision: checked_stored_u64(head, "head revision")?,
        stable_revision: checked_stored_u64(stable, "stable revision")?,
        created_at_unix_ms: checked_stored_u64(created, "created time")?,
        updated_at_unix_ms: checked_stored_u64(updated, "updated time")?,
        last_opened_at_unix_ms: checked_stored_u64(opened, "opened time")?,
        has_recovery,
    };
    if !project_summary_fields_are_valid(&summary) {
        return Err(ProjectLibraryError::new(
            ProjectLibraryErrorCode::StorageCorrupt,
            "项目库项目摘要字段不一致。",
            false,
        ));
    }
    Ok(summary)
}

fn project_summary_fields_are_valid(summary: &ProjectLibraryProjectSummary) -> bool {
    !summary.library_project_id.trim().is_empty()
        && summary.library_project_id.len() <= 128
        && !summary.display_name.trim().is_empty()
        && summary.display_name.len() <= 1024
        && summary.project_schema_version > 0
        && summary.head_revision > 0
        && summary.head_revision <= super::JAVASCRIPT_MAX_SAFE_INTEGER
        && summary.stable_revision > 0
        && summary.stable_revision <= summary.head_revision
        && summary.created_at_unix_ms <= super::JAVASCRIPT_MAX_SAFE_INTEGER
        && summary.updated_at_unix_ms <= super::JAVASCRIPT_MAX_SAFE_INTEGER
        && summary.last_opened_at_unix_ms <= super::JAVASCRIPT_MAX_SAFE_INTEGER
}

fn session_summary_fields_are_valid(summary: &ProjectLibrarySessionSummary) -> bool {
    !summary.session_id.trim().is_empty()
        && summary.session_id.len() <= 128
        && summary.opened_revision > 0
        && summary.opened_revision <= super::JAVASCRIPT_MAX_SAFE_INTEGER
        && summary.current_revision > 0
        && summary.current_revision <= super::JAVASCRIPT_MAX_SAFE_INTEGER
        && summary.stable_revision > 0
        && summary.stable_revision <= summary.current_revision
        && summary.opened_at_unix_ms <= super::JAVASCRIPT_MAX_SAFE_INTEGER
}

fn apply_retention(
    connection: &Connection,
    library_project_id: &str,
    limits: ProjectLibraryLimits,
) -> Result<(), ProjectLibraryError> {
    let (head, stable) = load_head_and_stable(connection, library_project_id)?;
    let mut protected = HashSet::from([sql_integer(head)?, sql_integer(stable)?]);
    let mut session_statement = connection
        .prepare(
            "SELECT opened_revision, latest_revision FROM project_sessions
             WHERE library_project_id=?1 AND state='open'",
        )
        .map_err(map_sqlite_error)?;
    let session_rows = session_statement
        .query_map([library_project_id], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
        })
        .map_err(map_sqlite_error)?;
    for row in session_rows {
        let (opened, latest) = row.map_err(map_sqlite_error)?;
        protected.insert(opened);
        protected.insert(latest);
    }
    drop(session_statement);

    let mut revision_statement = connection
        .prepare(
            "SELECT revision, source_revision, snapshot_len FROM project_revisions
             WHERE library_project_id=?1 ORDER BY revision DESC",
        )
        .map_err(map_sqlite_error)?;
    let revision_rows = revision_statement
        .query_map([library_project_id], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, Option<i64>>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })
        .map_err(map_sqlite_error)?;
    let mut revisions = Vec::new();
    for row in revision_rows {
        revisions.push(row.map_err(map_sqlite_error)?);
    }
    drop(revision_statement);

    let directly_protected = protected.clone();
    for (revision, source, _) in &revisions {
        if directly_protected.contains(revision) {
            if let Some(source) = source {
                protected.insert(*source);
            }
        }
    }

    let mut kept_non_protected = 0_usize;
    let mut kept_non_protected_bytes = 0_u64;
    let mut delete = Vec::new();
    for (revision, _, snapshot_len) in revisions {
        if protected.contains(&revision) {
            continue;
        }
        let snapshot_len = checked_stored_u64(snapshot_len, "snapshot length")?;
        let next_bytes = kept_non_protected_bytes.saturating_add(snapshot_len);
        if kept_non_protected < limits.max_non_protected_revisions
            && next_bytes <= limits.max_non_protected_bytes
        {
            kept_non_protected += 1;
            kept_non_protected_bytes = next_bytes;
        } else {
            delete.push(revision);
        }
    }
    for revision in delete {
        connection
            .execute(
                "DELETE FROM project_revisions
                 WHERE library_project_id=?1 AND revision=?2",
                params![library_project_id, revision],
            )
            .map_err(map_sqlite_error)?;
    }
    Ok(())
}

fn checked_stored_u64(value: i64, _field: &str) -> Result<u64, ProjectLibraryError> {
    u64::try_from(value)
        .ok()
        .filter(|value| *value <= super::JAVASCRIPT_MAX_SAFE_INTEGER)
        .ok_or_else(corrupt_integer)
}

fn corrupt_integer() -> ProjectLibraryError {
    ProjectLibraryError::new(
        ProjectLibraryErrorCode::StorageCorrupt,
        "项目库包含超出支持范围的整数。",
        false,
    )
}

fn generate_identifier(prefix: &str) -> Result<String, ProjectLibraryError> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| {
        ProjectLibraryError::new(
            ProjectLibraryErrorCode::StorageUnavailable,
            "项目库无法生成安全标识。",
            true,
        )
    })?;
    Ok(format!(
        "{prefix}-{}",
        bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    ))
}

fn now_unix_ms() -> Result<u64, ProjectLibraryError> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| {
            ProjectLibraryError::new(
                ProjectLibraryErrorCode::StorageUnavailable,
                "系统时钟早于 Unix epoch，项目库无法记录修订时间。",
                false,
            )
        })?
        .as_millis();
    u64::try_from(millis)
        .ok()
        .filter(|value| *value <= super::JAVASCRIPT_MAX_SAFE_INTEGER)
        .ok_or_else(|| {
            ProjectLibraryError::new(
                ProjectLibraryErrorCode::StorageUnavailable,
                "系统时间超出项目库支持范围。",
                false,
            )
        })
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn sql_integer(value: u64) -> Result<i64, ProjectLibraryError> {
    i64::try_from(value).map_err(|_| {
        ProjectLibraryError::new(
            ProjectLibraryErrorCode::InvalidRequest,
            "项目库整数超出 SQLite 支持范围。",
            false,
        )
    })
}

fn map_sqlite_error(error: rusqlite::Error) -> ProjectLibraryError {
    use rusqlite::ErrorCode;
    match &error {
        rusqlite::Error::SqliteFailure(details, _) => match details.code {
            ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked => ProjectLibraryError::new(
                ProjectLibraryErrorCode::LibraryBusy,
                "项目库正被其他写入占用，请稍后重试。",
                true,
            ),
            ErrorCode::DiskFull => ProjectLibraryError::new(
                ProjectLibraryErrorCode::StorageFull,
                "本地磁盘空间不足，项目未保存。",
                true,
            ),
            ErrorCode::ReadOnly | ErrorCode::PermissionDenied => ProjectLibraryError::new(
                ProjectLibraryErrorCode::PermissionDenied,
                "项目库没有写入权限，项目未保存。",
                false,
            ),
            ErrorCode::DatabaseCorrupt | ErrorCode::NotADatabase => ProjectLibraryError::new(
                ProjectLibraryErrorCode::StorageCorrupt,
                "项目库文件损坏或格式无效。",
                false,
            ),
            _ => storage_unavailable(),
        },
        _ => storage_unavailable(),
    }
}

fn storage_unavailable() -> ProjectLibraryError {
    ProjectLibraryError::new(
        ProjectLibraryErrorCode::StorageUnavailable,
        "本地项目库暂时不可用。",
        true,
    )
}

#[cfg(test)]
fn trip_test_failpoint(
    active: Option<ProjectLibraryTestFailpoint>,
    current: ProjectLibraryTestFailpoint,
) -> Result<(), ProjectLibraryError> {
    if active == Some(current) {
        Err(ProjectLibraryError::new(
            ProjectLibraryErrorCode::StorageUnavailable,
            "测试注入的项目库事务中断。",
            true,
        ))
    } else {
        Ok(())
    }
}
