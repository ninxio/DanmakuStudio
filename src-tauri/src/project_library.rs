mod runtime_lease;
mod sqlite;

use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{sync_channel, SyncSender, TrySendError},
        Arc, Mutex,
    },
    thread,
};
use tokio::sync::oneshot;

const PROJECT_LIBRARY_CONTRACT_VERSION: u32 = 1;
const PROJECT_LIBRARY_STORAGE_VERSION: i64 = 1;
const PROJECT_LIBRARY_MAX_SNAPSHOT_BYTES: usize = 256 * 1024 * 1024;
const PROJECT_LIBRARY_MAX_NON_PROTECTED_REVISIONS: usize = 20;
const PROJECT_LIBRARY_MAX_NON_PROTECTED_BYTES: u64 = 1024 * 1024 * 1024;
const PROJECT_LIBRARY_BUSY_TIMEOUT_MS: u64 = 2_000;
const PROJECT_LIBRARY_ACTOR_CAPACITY: usize = 16;
const JAVASCRIPT_MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, Copy)]
struct ProjectLibraryLimits {
    max_snapshot_bytes: usize,
    max_non_protected_revisions: usize,
    max_non_protected_bytes: u64,
    busy_timeout_ms: u64,
}

impl ProjectLibraryLimits {
    fn production() -> Self {
        Self {
            max_snapshot_bytes: PROJECT_LIBRARY_MAX_SNAPSHOT_BYTES,
            max_non_protected_revisions: PROJECT_LIBRARY_MAX_NON_PROTECTED_REVISIONS,
            max_non_protected_bytes: PROJECT_LIBRARY_MAX_NON_PROTECTED_BYTES,
            busy_timeout_ms: PROJECT_LIBRARY_BUSY_TIMEOUT_MS,
        }
    }

    #[cfg(test)]
    fn test() -> Self {
        Self {
            max_snapshot_bytes: 4 * 1024 * 1024,
            max_non_protected_revisions: PROJECT_LIBRARY_MAX_NON_PROTECTED_REVISIONS,
            max_non_protected_bytes: 32 * 1024 * 1024,
            busy_timeout_ms: 100,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectLibraryQueryRequest {
    pub contract_version: u32,
    pub query: ProjectLibraryQuery,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ProjectLibraryQuery {
    Recent {
        limit: u32,
        cursor: Option<String>,
    },
    Recoveries,
    Revisions {
        library_project_id: String,
        before_revision: Option<u64>,
        limit: u32,
    },
    Revision {
        library_project_id: String,
        revision: u64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ProjectLibraryQueryValue {
    Recent {
        projects: Vec<ProjectLibraryProjectSummary>,
        next_cursor: Option<String>,
    },
    Recoveries {
        recoveries: Vec<ProjectLibraryRecoveryCandidate>,
    },
    Revisions {
        project: ProjectLibraryProjectSummary,
        revisions: Vec<ProjectLibraryRevisionSummary>,
    },
    Revision {
        snapshot: StoredProjectSnapshot,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectLibraryProjectSummary {
    pub library_project_id: String,
    pub display_name: String,
    pub project_schema_version: u32,
    pub head_revision: u64,
    pub stable_revision: u64,
    pub created_at_unix_ms: u64,
    pub updated_at_unix_ms: u64,
    pub last_opened_at_unix_ms: u64,
    pub has_recovery: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProjectLibrarySaveKind {
    Create,
    Autosave,
    Checkpoint,
    Recovered,
    Rollback,
    RecoveryDiscarded,
}

impl ProjectLibrarySaveKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Create => "create",
            Self::Autosave => "autosave",
            Self::Checkpoint => "checkpoint",
            Self::Recovered => "recovered",
            Self::Rollback => "rollback",
            Self::RecoveryDiscarded => "recoveryDiscarded",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "create" => Some(Self::Create),
            "autosave" => Some(Self::Autosave),
            "checkpoint" => Some(Self::Checkpoint),
            "recovered" => Some(Self::Recovered),
            "rollback" => Some(Self::Rollback),
            "recoveryDiscarded" => Some(Self::RecoveryDiscarded),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectLibraryRevisionSummary {
    pub revision: u64,
    pub parent_revision: Option<u64>,
    pub source_revision: Option<u64>,
    pub save_kind: ProjectLibrarySaveKind,
    pub label: Option<String>,
    pub saved_at_unix_ms: u64,
    pub snapshot_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredProjectSnapshot {
    pub library_project_id: String,
    pub revision: u64,
    pub display_name: String,
    pub project_schema_version: u32,
    pub saved_at_unix_ms: u64,
    pub snapshot_json: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectLibraryRecoveryCandidate {
    pub library_project_id: String,
    pub display_name: String,
    pub recovery_session_id: String,
    pub opened_revision: u64,
    pub recovery_revision: u64,
    pub stable_revision: u64,
    pub last_saved_at_unix_ms: u64,
    pub has_newer_autosave: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenProjectLibrarySessionRequest {
    pub contract_version: u32,
    pub client_request_id: String,
    pub source: OpenProjectLibrarySessionSource,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum OpenProjectLibrarySessionSource {
    Create {
        display_name: String,
        project_schema_version: u32,
        snapshot_json: String,
    },
    Head {
        library_project_id: String,
        expected_head_revision: u64,
    },
    Recover {
        library_project_id: String,
        recovery_session_id: String,
        recovery_revision: u64,
        expected_head_revision: u64,
    },
    DiscardRecovery {
        library_project_id: String,
        recovery_session_id: String,
        expected_head_revision: u64,
        source_revision: u64,
        display_name: String,
        project_schema_version: u32,
        snapshot_json: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectLibrarySessionSummary {
    pub session_id: String,
    pub opened_revision: u64,
    pub current_revision: u64,
    pub stable_revision: u64,
    pub opened_at_unix_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenProjectLibrarySessionValue {
    pub project: ProjectLibraryProjectSummary,
    pub session: ProjectLibrarySessionSummary,
    pub snapshot: StoredProjectSnapshot,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommitProjectLibrarySessionRequest {
    pub contract_version: u32,
    pub library_project_id: String,
    pub session_id: String,
    pub client_mutation_id: String,
    pub expected_head_revision: u64,
    pub change: CommitProjectLibrarySessionChange,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum CommitProjectLibrarySessionChange {
    Save {
        save_kind: ProjectLibrarySaveKind,
        source_revision: Option<u64>,
        label: Option<String>,
        display_name: String,
        project_schema_version: u32,
        snapshot_json: String,
    },
    Close,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProjectLibraryCommitDisposition {
    Committed,
    AlreadyCommitted,
    Unchanged,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommitProjectLibrarySessionValue {
    pub disposition: ProjectLibraryCommitDisposition,
    pub library_project_id: String,
    pub session_id: String,
    pub head_revision: u64,
    pub stable_revision: u64,
    pub occurred_at_unix_ms: u64,
    pub session_closed: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProjectLibraryErrorCode {
    InvalidRequest,
    InvalidSnapshotJson,
    SnapshotTooLarge,
    ProjectNotFound,
    RevisionNotFound,
    SessionNotFound,
    SessionClosed,
    ProjectAlreadyOpen,
    RecoveryDecisionRequired,
    RevisionConflict,
    IdempotencyMismatch,
    LibraryBusy,
    LibraryQuotaExceeded,
    UnsupportedStorageVersion,
    MigrationFailed,
    StorageCorrupt,
    StorageUnavailable,
    StorageFull,
    PermissionDenied,
    Internal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectLibraryError {
    pub code: ProjectLibraryErrorCode,
    pub message: String,
    pub retryable: bool,
    pub actual_head_revision: Option<u64>,
}

impl ProjectLibraryError {
    fn new(code: ProjectLibraryErrorCode, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            code,
            message: message.into(),
            retryable,
            actual_head_revision: None,
        }
    }

    fn with_actual_head(mut self, revision: u64) -> Self {
        // Only these errors carry revision context in the public bridge contract.
        if matches!(
            self.code,
            ProjectLibraryErrorCode::RevisionConflict
                | ProjectLibraryErrorCode::RecoveryDecisionRequired
        ) {
            self.actual_head_revision = Some(revision);
        }
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProjectLibraryReply<T> {
    Success(T),
    Failure(ProjectLibraryError),
}

impl<T> ProjectLibraryReply<T> {
    pub fn from_result(result: Result<T, ProjectLibraryError>) -> Self {
        match result {
            Ok(value) => Self::Success(value),
            Err(error) => Self::Failure(error),
        }
    }
}

impl<T: Serialize> Serialize for ProjectLibraryReply<T> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct SuccessReply<'a, T> {
            contract_version: u32,
            ok: bool,
            value: &'a T,
        }

        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct FailureReply<'a> {
            contract_version: u32,
            ok: bool,
            error: &'a ProjectLibraryError,
        }

        match self {
            Self::Success(value) => SuccessReply {
                contract_version: PROJECT_LIBRARY_CONTRACT_VERSION,
                ok: true,
                value,
            }
            .serialize(serializer),
            Self::Failure(error) => FailureReply {
                contract_version: PROJECT_LIBRARY_CONTRACT_VERSION,
                ok: false,
                error,
            }
            .serialize(serializer),
        }
    }
}

enum ProjectLibraryActorMessage {
    Query(
        ProjectLibraryQueryRequest,
        oneshot::Sender<Result<ProjectLibraryQueryValue, ProjectLibraryError>>,
    ),
    Open(
        OpenProjectLibrarySessionRequest,
        oneshot::Sender<Result<OpenProjectLibrarySessionValue, ProjectLibraryError>>,
        Option<SnapshotRequestPermit>,
    ),
    Commit(
        CommitProjectLibrarySessionRequest,
        oneshot::Sender<Result<CommitProjectLibrarySessionValue, ProjectLibraryError>>,
        Option<SnapshotRequestPermit>,
    ),
    #[cfg(test)]
    SetFailpoint(ProjectLibraryTestFailpoint, oneshot::Sender<()>),
    #[cfg(test)]
    SetQueryOnly(oneshot::Sender<Result<(), ProjectLibraryError>>),
    #[cfg(test)]
    LimitDatabasePages(oneshot::Sender<Result<(), ProjectLibraryError>>),
    #[cfg(test)]
    InspectStorageSettings(oneshot::Sender<Result<(String, i64, bool), ProjectLibraryError>>),
    #[cfg(test)]
    PauseForTest(oneshot::Sender<()>, std::sync::mpsc::Receiver<()>),
    Shutdown,
}

#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProjectLibraryTestFailpoint {
    AfterRevisionInsert,
    AfterHeadUpdate,
    BeforeCommit,
    AfterCommitBeforeReply,
}

enum ProjectLibraryTransport {
    Available(SyncSender<ProjectLibraryActorMessage>),
    Unavailable(ProjectLibraryError),
}

struct SnapshotRequestPermit {
    in_flight: Arc<AtomicBool>,
}

impl Drop for SnapshotRequestPermit {
    fn drop(&mut self) {
        self.in_flight.store(false, Ordering::Release);
    }
}

struct ProjectLibraryRuntimeInner {
    transport: ProjectLibraryTransport,
    worker: Mutex<Option<thread::JoinHandle<()>>>,
    snapshot_request_in_flight: Arc<AtomicBool>,
    #[cfg(test)]
    temporary_database_path: Option<PathBuf>,
}

impl Drop for ProjectLibraryRuntimeInner {
    fn drop(&mut self) {
        if let ProjectLibraryTransport::Available(sender) = &self.transport {
            let _ = sender.send(ProjectLibraryActorMessage::Shutdown);
        }
        if let Ok(worker) = self.worker.get_mut() {
            if let Some(worker) = worker.take() {
                let _ = worker.join();
            }
        }
        #[cfg(test)]
        if let Some(path) = &self.temporary_database_path {
            let _ = std::fs::remove_file(path);
            let _ = std::fs::remove_file(path.with_extension("sqlite3-wal"));
            let _ = std::fs::remove_file(path.with_extension("sqlite3-shm"));
        }
    }
}

#[derive(Clone)]
pub struct ProjectLibraryRuntime {
    inner: Arc<ProjectLibraryRuntimeInner>,
}

impl ProjectLibraryRuntime {
    pub fn open(database_path: PathBuf) -> Self {
        Self::start(
            database_path,
            ProjectLibraryLimits::production(),
            false,
            false,
        )
    }

    fn start(
        database_path: PathBuf,
        limits: ProjectLibraryLimits,
        _temporary: bool,
        fail_migration_before_commit: bool,
    ) -> Self {
        let (sender, receiver) = sync_channel(PROJECT_LIBRARY_ACTOR_CAPACITY);
        let worker = thread::Builder::new()
            .name("project-library-sqlite".to_string())
            .spawn({
                let database_path = database_path.clone();
                move || {
                    let mut repository = sqlite::SqliteProjectLibrary::open(
                        &database_path,
                        limits,
                        fail_migration_before_commit,
                    );
                    while let Ok(message) = receiver.recv() {
                        match message {
                            ProjectLibraryActorMessage::Query(request, response) => {
                                let result = repository
                                    .as_mut()
                                    .map_err(|error| (*error).clone())
                                    .and_then(|repository| repository.query(request));
                                let _ = response.send(result);
                            }
                            ProjectLibraryActorMessage::Open(
                                request,
                                response,
                                _snapshot_permit,
                            ) => {
                                let result = repository
                                    .as_mut()
                                    .map_err(|error| (*error).clone())
                                    .and_then(|repository| repository.open_session(request));
                                let _ = response.send(result);
                            }
                            ProjectLibraryActorMessage::Commit(
                                request,
                                response,
                                _snapshot_permit,
                            ) => {
                                let result = repository
                                    .as_mut()
                                    .map_err(|error| (*error).clone())
                                    .and_then(|repository| repository.commit_session(request));
                                let _ = response.send(result);
                            }
                            #[cfg(test)]
                            ProjectLibraryActorMessage::SetFailpoint(failpoint, response) => {
                                if let Ok(repository) = repository.as_mut() {
                                    repository.set_failpoint_for_test(failpoint);
                                }
                                let _ = response.send(());
                            }
                            #[cfg(test)]
                            ProjectLibraryActorMessage::SetQueryOnly(response) => {
                                let result = repository
                                    .as_mut()
                                    .map_err(|error| (*error).clone())
                                    .and_then(|repository| repository.set_query_only_for_test());
                                let _ = response.send(result);
                            }
                            #[cfg(test)]
                            ProjectLibraryActorMessage::LimitDatabasePages(response) => {
                                let result = repository
                                    .as_mut()
                                    .map_err(|error| (*error).clone())
                                    .and_then(|repository| {
                                        repository.limit_database_pages_for_test()
                                    });
                                let _ = response.send(result);
                            }
                            #[cfg(test)]
                            ProjectLibraryActorMessage::InspectStorageSettings(response) => {
                                let result = repository
                                    .as_mut()
                                    .map_err(|error| (*error).clone())
                                    .and_then(|repository| repository.storage_settings_for_test());
                                let _ = response.send(result);
                            }
                            #[cfg(test)]
                            ProjectLibraryActorMessage::PauseForTest(entered, release) => {
                                let _ = entered.send(());
                                let _ = release.recv();
                            }
                            ProjectLibraryActorMessage::Shutdown => {
                                if let Ok(repository) = repository.as_mut() {
                                    let _ = repository.close_stable_runtime_sessions();
                                }
                                break;
                            }
                        }
                    }
                }
            });

        match worker {
            Ok(worker) => Self {
                inner: Arc::new(ProjectLibraryRuntimeInner {
                    transport: ProjectLibraryTransport::Available(sender),
                    worker: Mutex::new(Some(worker)),
                    snapshot_request_in_flight: Arc::new(AtomicBool::new(false)),
                    #[cfg(test)]
                    temporary_database_path: _temporary.then_some(database_path),
                }),
            },
            Err(_) => Self::unavailable(ProjectLibraryError::new(
                ProjectLibraryErrorCode::StorageUnavailable,
                "项目库后台线程无法启动。",
                true,
            )),
        }
    }

    pub fn unavailable(error: ProjectLibraryError) -> Self {
        Self {
            inner: Arc::new(ProjectLibraryRuntimeInner {
                transport: ProjectLibraryTransport::Unavailable(error),
                worker: Mutex::new(None),
                snapshot_request_in_flight: Arc::new(AtomicBool::new(false)),
                #[cfg(test)]
                temporary_database_path: None,
            }),
        }
    }

    pub(crate) fn storage_unavailable() -> Self {
        Self::unavailable(ProjectLibraryError::new(
            ProjectLibraryErrorCode::StorageUnavailable,
            "应用无法解析本地项目库目录。",
            false,
        ))
    }

    #[cfg(test)]
    fn temporary_for_test() -> Self {
        let mut random = [0_u8; 16];
        getrandom::fill(&mut random).expect("test database id");
        let suffix = random
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let path = std::env::temp_dir().join(format!("project-library-test-{suffix}.sqlite3"));
        Self::start(path, ProjectLibraryLimits::test(), true, false)
    }

    #[cfg(test)]
    fn start_with_migration_failure_for_test(path: PathBuf) -> Self {
        Self::start(path, ProjectLibraryLimits::test(), false, true)
    }

    pub async fn query(
        &self,
        request: ProjectLibraryQueryRequest,
    ) -> Result<ProjectLibraryQueryValue, ProjectLibraryError> {
        let (response, receiver) = oneshot::channel();
        self.send(ProjectLibraryActorMessage::Query(request, response))?;
        receiver.await.map_err(|_| actor_stopped_error())?
    }

    pub async fn open_session(
        &self,
        request: OpenProjectLibrarySessionRequest,
    ) -> Result<OpenProjectLibrarySessionValue, ProjectLibraryError> {
        let snapshot_permit = self.acquire_snapshot_request_permit(matches!(
            &request.source,
            OpenProjectLibrarySessionSource::Create { .. }
                | OpenProjectLibrarySessionSource::DiscardRecovery { .. }
        ))?;
        let (response, receiver) = oneshot::channel();
        self.send(ProjectLibraryActorMessage::Open(
            request,
            response,
            snapshot_permit,
        ))?;
        receiver.await.map_err(|_| actor_stopped_error())?
    }

    pub async fn commit_session(
        &self,
        request: CommitProjectLibrarySessionRequest,
    ) -> Result<CommitProjectLibrarySessionValue, ProjectLibraryError> {
        let snapshot_permit = self.acquire_snapshot_request_permit(matches!(
            &request.change,
            CommitProjectLibrarySessionChange::Save { .. }
        ))?;
        let (response, receiver) = oneshot::channel();
        self.send(ProjectLibraryActorMessage::Commit(
            request,
            response,
            snapshot_permit,
        ))?;
        receiver.await.map_err(|_| actor_stopped_error())?
    }

    fn acquire_snapshot_request_permit(
        &self,
        required: bool,
    ) -> Result<Option<SnapshotRequestPermit>, ProjectLibraryError> {
        if !required {
            return Ok(None);
        }
        let in_flight = Arc::clone(&self.inner.snapshot_request_in_flight);
        in_flight
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| {
                ProjectLibraryError::new(
                    ProjectLibraryErrorCode::LibraryBusy,
                    "已有项目快照正在保存，请稍后重试。",
                    true,
                )
            })?;
        Ok(Some(SnapshotRequestPermit { in_flight }))
    }

    #[cfg(test)]
    async fn set_failpoint_for_test(&self, failpoint: ProjectLibraryTestFailpoint) {
        let (response, receiver) = oneshot::channel();
        self.send(ProjectLibraryActorMessage::SetFailpoint(
            failpoint, response,
        ))
        .expect("test failpoint should reach actor");
        receiver.await.expect("test failpoint actor response");
    }

    #[cfg(test)]
    async fn set_query_only_for_test(&self) -> Result<(), ProjectLibraryError> {
        let (response, receiver) = oneshot::channel();
        self.send(ProjectLibraryActorMessage::SetQueryOnly(response))?;
        receiver.await.map_err(|_| actor_stopped_error())?
    }

    #[cfg(test)]
    async fn limit_database_pages_for_test(&self) -> Result<(), ProjectLibraryError> {
        let (response, receiver) = oneshot::channel();
        self.send(ProjectLibraryActorMessage::LimitDatabasePages(response))?;
        receiver.await.map_err(|_| actor_stopped_error())?
    }

    #[cfg(test)]
    async fn storage_settings_for_test(&self) -> Result<(String, i64, bool), ProjectLibraryError> {
        let (response, receiver) = oneshot::channel();
        self.send(ProjectLibraryActorMessage::InspectStorageSettings(response))?;
        receiver.await.map_err(|_| actor_stopped_error())?
    }

    #[cfg(test)]
    async fn pause_actor_for_test(&self) -> SyncSender<()> {
        let (entered, entered_receiver) = oneshot::channel();
        let (release, release_receiver) = sync_channel(0);
        self.send(ProjectLibraryActorMessage::PauseForTest(
            entered,
            release_receiver,
        ))
        .expect("test pause should reach actor");
        entered_receiver
            .await
            .expect("actor should enter test pause");
        release
    }

    fn send(&self, message: ProjectLibraryActorMessage) -> Result<(), ProjectLibraryError> {
        match &self.inner.transport {
            ProjectLibraryTransport::Unavailable(error) => Err(error.clone()),
            ProjectLibraryTransport::Available(sender) => {
                sender.try_send(message).map_err(|error| match error {
                    TrySendError::Full(_) => ProjectLibraryError::new(
                        ProjectLibraryErrorCode::LibraryBusy,
                        "项目库请求队列暂时繁忙，请稍后重试。",
                        true,
                    ),
                    TrySendError::Disconnected(_) => actor_stopped_error(),
                })
            }
        }
    }
}

/// Startup migration validates the same schema/WAL requirements before selecting a new root.
pub(crate) fn initialize_storage(path: &std::path::Path) -> Result<(), String> {
    sqlite::SqliteProjectLibrary::open(path, ProjectLibraryLimits::production(), false)
        .map(|_| ())
        .map_err(|error| format!("项目库初始化失败：{error:?}"))
}

fn actor_stopped_error() -> ProjectLibraryError {
    ProjectLibraryError::new(
        ProjectLibraryErrorCode::StorageUnavailable,
        "项目库后台线程已停止。",
        true,
    )
}

fn validate_contract_version(version: u32) -> Result<(), ProjectLibraryError> {
    if version == PROJECT_LIBRARY_CONTRACT_VERSION {
        Ok(())
    } else {
        Err(ProjectLibraryError::new(
            ProjectLibraryErrorCode::InvalidRequest,
            "项目库 contractVersion 必须为 1。",
            false,
        ))
    }
}

fn validate_safe_positive_integer(value: u64, field: &str) -> Result<(), ProjectLibraryError> {
    if value > 0 && value <= JAVASCRIPT_MAX_SAFE_INTEGER {
        Ok(())
    } else {
        Err(ProjectLibraryError::new(
            ProjectLibraryErrorCode::InvalidRequest,
            format!("项目库 {field} 必须是正的 JavaScript 安全整数。"),
            false,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::{
        CommitProjectLibrarySessionChange, CommitProjectLibrarySessionRequest,
        OpenProjectLibrarySessionRequest, OpenProjectLibrarySessionSource,
        ProjectLibraryCommitDisposition, ProjectLibraryError, ProjectLibraryErrorCode,
        ProjectLibraryLimits, ProjectLibraryQuery, ProjectLibraryQueryRequest,
        ProjectLibraryQueryValue, ProjectLibraryReply, ProjectLibraryRuntime,
        ProjectLibrarySaveKind, ProjectLibraryTestFailpoint,
    };
    use std::path::{Path, PathBuf};

    struct TestDatabase {
        path: PathBuf,
    }

    impl TestDatabase {
        fn new() -> Self {
            let mut random = [0_u8; 16];
            getrandom::fill(&mut random).expect("test database id");
            let suffix = random
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>();
            Self {
                path: std::env::temp_dir().join(format!("project-library-reopen-{suffix}.sqlite3")),
            }
        }

        fn runtime(&self) -> ProjectLibraryRuntime {
            ProjectLibraryRuntime::start(
                self.path.clone(),
                ProjectLibraryLimits::test(),
                false,
                false,
            )
        }
    }

    impl Drop for TestDatabase {
        fn drop(&mut self) {
            remove_sqlite_files(&self.path);
        }
    }

    fn remove_sqlite_files(path: &Path) {
        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_file(path.with_extension("sqlite3-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite3-shm"));
    }

    #[tokio::test]
    async fn opaque_project_json_round_trips_without_reordering() {
        let fixture = "{\n  \"schemaVersion\": 17,\n  \"futureField\": { \"z\": 1, \"a\": 2 }\n}\n";
        let runtime = ProjectLibraryRuntime::temporary_for_test();

        let opened = runtime
            .open_session(OpenProjectLibrarySessionRequest {
                contract_version: 1,
                client_request_id: "open-round-trip".to_string(),
                source: OpenProjectLibrarySessionSource::Create {
                    display_name: "逐字往返".to_string(),
                    project_schema_version: 17,
                    snapshot_json: fixture.to_string(),
                },
            })
            .await
            .expect("create should succeed");

        let queried = runtime
            .query(ProjectLibraryQueryRequest {
                contract_version: 1,
                query: ProjectLibraryQuery::Revision {
                    library_project_id: opened.project.library_project_id.clone(),
                    revision: 1,
                },
            })
            .await
            .expect("revision should be readable");

        let ProjectLibraryQueryValue::Revision { snapshot } = queried else {
            panic!("expected revision response");
        };
        assert_eq!(snapshot.snapshot_json, fixture);
    }

    #[tokio::test]
    async fn recent_unnamed_alias_does_not_change_the_open_snapshot_contract() {
        let runtime = ProjectLibraryRuntime::temporary_for_test();
        let fixture =
            r#"{"schemaVersion":18,"name":"未命名项目","assets":[{"name":"示例剧 第三季"}]}"#;
        let opened = runtime
            .open_session(OpenProjectLibrarySessionRequest {
                contract_version: 1,
                client_request_id: "alias-create".into(),
                source: OpenProjectLibrarySessionSource::Create {
                    display_name: "未命名项目".into(),
                    project_schema_version: 18,
                    snapshot_json: fixture.into(),
                },
            })
            .await
            .unwrap();
        let recent = runtime
            .query(ProjectLibraryQueryRequest {
                contract_version: 1,
                query: ProjectLibraryQuery::Recent {
                    limit: 10,
                    cursor: None,
                },
            })
            .await
            .unwrap();
        let ProjectLibraryQueryValue::Recent { projects, .. } = recent else {
            panic!("expected recent");
        };
        assert_eq!(projects[0].display_name, "示例剧 第三季");
        runtime
            .commit_session(CommitProjectLibrarySessionRequest {
                contract_version: 1,
                library_project_id: opened.project.library_project_id.clone(),
                session_id: opened.session.session_id.clone(),
                client_mutation_id: "alias-close".into(),
                expected_head_revision: 1,
                change: CommitProjectLibrarySessionChange::Close,
            })
            .await
            .unwrap();
        let reopened = runtime
            .open_session(OpenProjectLibrarySessionRequest {
                contract_version: 1,
                client_request_id: "alias-open".into(),
                source: OpenProjectLibrarySessionSource::Head {
                    library_project_id: opened.project.library_project_id,
                    expected_head_revision: 1,
                },
            })
            .await
            .unwrap();
        assert_eq!(reopened.project.display_name, "未命名项目");
        assert_eq!(reopened.snapshot.display_name, "未命名项目");
        assert_eq!(reopened.snapshot.snapshot_json, fixture);
    }

    #[tokio::test]
    async fn autosave_appends_an_immutable_revision_and_advances_only_head() {
        let runtime = ProjectLibraryRuntime::temporary_for_test();
        let opened = runtime
            .open_session(OpenProjectLibrarySessionRequest {
                contract_version: 1,
                client_request_id: "open-autosave".to_string(),
                source: OpenProjectLibrarySessionSource::Create {
                    display_name: "自动保存".to_string(),
                    project_schema_version: 17,
                    snapshot_json: "{\"schemaVersion\":17,\"value\":1}".to_string(),
                },
            })
            .await
            .expect("create should succeed");

        let committed = runtime
            .commit_session(CommitProjectLibrarySessionRequest {
                contract_version: 1,
                library_project_id: opened.project.library_project_id.clone(),
                session_id: opened.session.session_id.clone(),
                client_mutation_id: "autosave-1".to_string(),
                expected_head_revision: 1,
                change: CommitProjectLibrarySessionChange::Save {
                    save_kind: ProjectLibrarySaveKind::Autosave,
                    source_revision: None,
                    label: None,
                    display_name: "自动保存".to_string(),
                    project_schema_version: 17,
                    snapshot_json: "{\"schemaVersion\":17,\"value\":2}".to_string(),
                },
            })
            .await
            .expect("autosave should succeed");
        assert_eq!(
            committed.disposition,
            ProjectLibraryCommitDisposition::Committed
        );
        assert_eq!(committed.head_revision, 2);
        assert_eq!(committed.stable_revision, 1);

        let queried = runtime
            .query(ProjectLibraryQueryRequest {
                contract_version: 1,
                query: ProjectLibraryQuery::Revisions {
                    library_project_id: opened.project.library_project_id,
                    before_revision: None,
                    limit: 20,
                },
            })
            .await
            .expect("history should be readable");
        let ProjectLibraryQueryValue::Revisions { project, revisions } = queried else {
            panic!("expected revisions response");
        };
        assert_eq!((project.head_revision, project.stable_revision), (2, 1));
        assert_eq!(
            revisions
                .iter()
                .map(|revision| (revision.revision, revision.save_kind))
                .collect::<Vec<_>>(),
            vec![
                (2, ProjectLibrarySaveKind::Autosave),
                (1, ProjectLibrarySaveKind::Create)
            ]
        );
    }

    #[tokio::test]
    async fn revision_metadata_remains_immutable_when_the_project_is_renamed() {
        let runtime = ProjectLibraryRuntime::temporary_for_test();
        let opened = create_test_project(&runtime, "rename-history", "原始名称").await;
        runtime
            .commit_session(CommitProjectLibrarySessionRequest {
                change: CommitProjectLibrarySessionChange::Save {
                    save_kind: ProjectLibrarySaveKind::Checkpoint,
                    source_revision: None,
                    label: Some("重命名".to_string()),
                    display_name: "新名称".to_string(),
                    project_schema_version: 18,
                    snapshot_json: "{\"schemaVersion\":18,\"value\":2}".to_string(),
                },
                ..test_autosave_request(&opened, "rename-checkpoint", 1, 2, 32)
            })
            .await
            .expect("rename checkpoint");

        for (revision, expected_name, expected_schema) in [(1, "原始名称", 17), (2, "新名称", 18)]
        {
            let stored = runtime
                .query(ProjectLibraryQueryRequest {
                    contract_version: 1,
                    query: ProjectLibraryQuery::Revision {
                        library_project_id: opened.project.library_project_id.clone(),
                        revision,
                    },
                })
                .await
                .expect("read historical snapshot");
            let ProjectLibraryQueryValue::Revision { snapshot } = stored else {
                panic!("expected revision snapshot");
            };
            assert_eq!(snapshot.display_name, expected_name);
            assert_eq!(snapshot.project_schema_version, expected_schema);
        }
    }

    #[tokio::test]
    async fn abandoned_autosave_is_recoverable_until_the_new_session_closes_cleanly() {
        let database = TestDatabase::new();
        let runtime = database.runtime();
        let opened = runtime
            .open_session(OpenProjectLibrarySessionRequest {
                contract_version: 1,
                client_request_id: "open-recovery".to_string(),
                source: OpenProjectLibrarySessionSource::Create {
                    display_name: "恢复测试".to_string(),
                    project_schema_version: 17,
                    snapshot_json: "{\"schemaVersion\":17,\"value\":1}".to_string(),
                },
            })
            .await
            .expect("create should succeed");
        runtime
            .commit_session(CommitProjectLibrarySessionRequest {
                contract_version: 1,
                library_project_id: opened.project.library_project_id.clone(),
                session_id: opened.session.session_id,
                client_mutation_id: "recovery-autosave".to_string(),
                expected_head_revision: 1,
                change: CommitProjectLibrarySessionChange::Save {
                    save_kind: ProjectLibrarySaveKind::Autosave,
                    source_revision: None,
                    label: None,
                    display_name: "恢复测试".to_string(),
                    project_schema_version: 17,
                    snapshot_json: "{\"schemaVersion\":17,\"value\":2}".to_string(),
                },
            })
            .await
            .expect("autosave should succeed");
        let project_id = opened.project.library_project_id;
        drop(runtime);

        let reopened_runtime = database.runtime();
        let recoveries = reopened_runtime
            .query(ProjectLibraryQueryRequest {
                contract_version: 1,
                query: ProjectLibraryQuery::Recoveries,
            })
            .await
            .expect("recoveries should be readable");
        let ProjectLibraryQueryValue::Recoveries { recoveries } = recoveries else {
            panic!("expected recoveries response");
        };
        assert_eq!(recoveries.len(), 1);
        let recovery = recoveries[0].clone();
        assert_eq!(recovery.library_project_id, project_id);
        assert_eq!(
            (recovery.stable_revision, recovery.recovery_revision),
            (1, 2)
        );

        let stale_session_commit = reopened_runtime
            .commit_session(CommitProjectLibrarySessionRequest {
                contract_version: 1,
                library_project_id: project_id.clone(),
                session_id: recovery.recovery_session_id.clone(),
                client_mutation_id: "stale-session-must-not-save".to_string(),
                expected_head_revision: 2,
                change: CommitProjectLibrarySessionChange::Save {
                    save_kind: ProjectLibrarySaveKind::Autosave,
                    source_revision: None,
                    label: None,
                    display_name: "恢复测试".to_string(),
                    project_schema_version: 17,
                    snapshot_json: "{\"schemaVersion\":17,\"value\":3}".to_string(),
                },
            })
            .await
            .expect_err("a previous runtime session cannot bypass explicit recovery");
        assert_eq!(
            stale_session_commit.code,
            ProjectLibraryErrorCode::RecoveryDecisionRequired
        );
        assert_eq!(stale_session_commit.actual_head_revision, Some(2));
        let stale_session_close = reopened_runtime
            .commit_session(CommitProjectLibrarySessionRequest {
                contract_version: 1,
                library_project_id: project_id.clone(),
                session_id: recovery.recovery_session_id.clone(),
                client_mutation_id: "stale-session-must-not-close".to_string(),
                expected_head_revision: 2,
                change: CommitProjectLibrarySessionChange::Close,
            })
            .await
            .expect_err("a previous runtime session cannot silently accept recovery by closing");
        assert_eq!(
            stale_session_close.code,
            ProjectLibraryErrorCode::RecoveryDecisionRequired
        );
        assert_eq!(stale_session_close.actual_head_revision, Some(2));

        let head_error = reopened_runtime
            .open_session(OpenProjectLibrarySessionRequest {
                contract_version: 1,
                client_request_id: "open-without-decision".to_string(),
                source: OpenProjectLibrarySessionSource::Head {
                    library_project_id: project_id.clone(),
                    expected_head_revision: 2,
                },
            })
            .await
            .expect_err("head open must require a recovery decision");
        assert_eq!(
            head_error.code,
            ProjectLibraryErrorCode::RecoveryDecisionRequired
        );

        let recover_request = OpenProjectLibrarySessionRequest {
            contract_version: 1,
            client_request_id: "resume-recovery".to_string(),
            source: OpenProjectLibrarySessionSource::Recover {
                library_project_id: project_id.clone(),
                recovery_session_id: recovery.recovery_session_id,
                recovery_revision: 2,
                expected_head_revision: 2,
            },
        };
        let resumed = reopened_runtime
            .open_session(recover_request.clone())
            .await
            .expect("recovery should open the autosave");
        assert_eq!(
            resumed.snapshot.snapshot_json,
            "{\"schemaVersion\":17,\"value\":2}"
        );
        assert_eq!(
            (resumed.project.head_revision, resumed.snapshot.revision),
            (3, 3),
            "accepting recovery must append an immutable decision revision"
        );
        let history = reopened_runtime
            .query(ProjectLibraryQueryRequest {
                contract_version: 1,
                query: ProjectLibraryQuery::Revisions {
                    library_project_id: project_id.clone(),
                    before_revision: None,
                    limit: 10,
                },
            })
            .await
            .expect("recovery history");
        assert!(matches!(
            history,
            ProjectLibraryQueryValue::Revisions { revisions, .. }
                if revisions.first().map(|revision| (
                    revision.revision,
                    revision.parent_revision,
                    revision.source_revision,
                    revision.save_kind,
                )) == Some((3, Some(2), Some(2), ProjectLibrarySaveKind::Recovered))
        ));
        drop(reopened_runtime);
        let recovery_ack_runtime = database.runtime();
        let recover_replay = recovery_ack_runtime
            .open_session(recover_request)
            .await
            .expect("recovery request retry after restart must reclaim its appended revision");
        assert_eq!(recover_replay, resumed);

        let closed = recovery_ack_runtime
            .commit_session(CommitProjectLibrarySessionRequest {
                contract_version: 1,
                library_project_id: project_id,
                session_id: resumed.session.session_id,
                client_mutation_id: "close-recovered".to_string(),
                expected_head_revision: 3,
                change: CommitProjectLibrarySessionChange::Close,
            })
            .await
            .expect("clean close should succeed");
        assert!(closed.session_closed);
        assert_eq!((closed.head_revision, closed.stable_revision), (3, 3));

        let recoveries = recovery_ack_runtime
            .query(ProjectLibraryQueryRequest {
                contract_version: 1,
                query: ProjectLibraryQuery::Recoveries,
            })
            .await
            .expect("recoveries should remain readable");
        assert!(matches!(
            recoveries,
            ProjectLibraryQueryValue::Recoveries { recoveries } if recoveries.is_empty()
        ));
    }

    #[tokio::test]
    async fn discard_and_rollback_append_new_revisions_without_rewriting_history() {
        let database = TestDatabase::new();
        let runtime = database.runtime();
        let opened = runtime
            .open_session(OpenProjectLibrarySessionRequest {
                contract_version: 1,
                client_request_id: "open-discard".to_string(),
                source: OpenProjectLibrarySessionSource::Create {
                    display_name: "历史测试".to_string(),
                    project_schema_version: 17,
                    snapshot_json: "{\"schemaVersion\":17,\"value\":1}".to_string(),
                },
            })
            .await
            .expect("create should succeed");
        runtime
            .commit_session(CommitProjectLibrarySessionRequest {
                contract_version: 1,
                library_project_id: opened.project.library_project_id.clone(),
                session_id: opened.session.session_id,
                client_mutation_id: "discard-autosave".to_string(),
                expected_head_revision: 1,
                change: CommitProjectLibrarySessionChange::Save {
                    save_kind: ProjectLibrarySaveKind::Autosave,
                    source_revision: None,
                    label: None,
                    display_name: "历史测试".to_string(),
                    project_schema_version: 17,
                    snapshot_json: "{\"schemaVersion\":17,\"value\":2}".to_string(),
                },
            })
            .await
            .expect("autosave should succeed");
        let project_id = opened.project.library_project_id;
        drop(runtime);

        let runtime = database.runtime();
        let recovery = match runtime
            .query(ProjectLibraryQueryRequest {
                contract_version: 1,
                query: ProjectLibraryQuery::Recoveries,
            })
            .await
            .expect("recovery query")
        {
            ProjectLibraryQueryValue::Recoveries { recoveries } => recoveries[0].clone(),
            _ => panic!("expected recovery list"),
        };
        let discarded = runtime
            .open_session(OpenProjectLibrarySessionRequest {
                contract_version: 1,
                client_request_id: "discard-recovery".to_string(),
                source: OpenProjectLibrarySessionSource::DiscardRecovery {
                    library_project_id: project_id.clone(),
                    recovery_session_id: recovery.recovery_session_id,
                    expected_head_revision: 2,
                    source_revision: 1,
                    display_name: "历史测试".to_string(),
                    project_schema_version: 17,
                    snapshot_json: "{\"schemaVersion\":17,\"value\":1,\"migrated\":true}"
                        .to_string(),
                },
            })
            .await
            .expect("discard should append stable snapshot");
        assert_eq!(
            (
                discarded.project.head_revision,
                discarded.project.stable_revision
            ),
            (3, 3)
        );
        assert_eq!(discarded.session.current_revision, 3);

        let rollback = runtime
            .commit_session(CommitProjectLibrarySessionRequest {
                contract_version: 1,
                library_project_id: project_id.clone(),
                session_id: discarded.session.session_id,
                client_mutation_id: "rollback-to-two".to_string(),
                expected_head_revision: 3,
                change: CommitProjectLibrarySessionChange::Save {
                    save_kind: ProjectLibrarySaveKind::Rollback,
                    source_revision: Some(2),
                    label: Some("回到自动保存".to_string()),
                    display_name: "历史测试".to_string(),
                    project_schema_version: 17,
                    snapshot_json: "{\"schemaVersion\":17,\"value\":2,\"migrated\":true}"
                        .to_string(),
                },
            })
            .await
            .expect("rollback should append a child revision");
        assert_eq!((rollback.head_revision, rollback.stable_revision), (4, 4));

        let history = runtime
            .query(ProjectLibraryQueryRequest {
                contract_version: 1,
                query: ProjectLibraryQuery::Revisions {
                    library_project_id: project_id.clone(),
                    before_revision: None,
                    limit: 10,
                },
            })
            .await
            .expect("history should remain readable");
        let ProjectLibraryQueryValue::Revisions { revisions, .. } = history else {
            panic!("expected revisions");
        };
        assert_eq!(
            revisions
                .iter()
                .map(|revision| (
                    revision.revision,
                    revision.save_kind,
                    revision.source_revision
                ))
                .collect::<Vec<_>>(),
            vec![
                (4, ProjectLibrarySaveKind::Rollback, Some(2)),
                (3, ProjectLibrarySaveKind::RecoveryDiscarded, Some(1)),
                (2, ProjectLibrarySaveKind::Autosave, None),
                (1, ProjectLibrarySaveKind::Create, None)
            ]
        );

        for (revision, expected_value) in [(1, 1), (2, 2)] {
            let snapshot = runtime
                .query(ProjectLibraryQueryRequest {
                    contract_version: 1,
                    query: ProjectLibraryQuery::Revision {
                        library_project_id: project_id.clone(),
                        revision,
                    },
                })
                .await
                .expect("old revision must remain readable");
            let ProjectLibraryQueryValue::Revision { snapshot } = snapshot else {
                panic!("expected revision");
            };
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&snapshot.snapshot_json).unwrap()
                    ["value"],
                expected_value
            );
        }
    }

    #[tokio::test]
    async fn recent_projects_are_metadata_only_and_cursor_paginated() {
        let runtime = ProjectLibraryRuntime::temporary_for_test();
        for (request_id, name) in [("recent-a", "较早项目"), ("recent-b", "较新项目")] {
            runtime
                .open_session(OpenProjectLibrarySessionRequest {
                    contract_version: 1,
                    client_request_id: request_id.to_string(),
                    source: OpenProjectLibrarySessionSource::Create {
                        display_name: name.to_string(),
                        project_schema_version: 17,
                        snapshot_json: format!("{{\"schemaVersion\":17,\"name\":\"{name}\"}}"),
                    },
                })
                .await
                .expect("project should be created");
            std::thread::sleep(std::time::Duration::from_millis(2));
        }

        let first_page = runtime
            .query(ProjectLibraryQueryRequest {
                contract_version: 1,
                query: ProjectLibraryQuery::Recent {
                    limit: 1,
                    cursor: None,
                },
            })
            .await
            .expect("recent projects should be readable");
        let ProjectLibraryQueryValue::Recent {
            projects,
            next_cursor,
        } = first_page
        else {
            panic!("expected recent response");
        };
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].display_name, "较新项目");
        let cursor = next_cursor.expect("first page should have a cursor");

        let second_page = runtime
            .query(ProjectLibraryQueryRequest {
                contract_version: 1,
                query: ProjectLibraryQuery::Recent {
                    limit: 1,
                    cursor: Some(cursor),
                },
            })
            .await
            .expect("next page should be readable");
        assert!(matches!(
            second_page,
            ProjectLibraryQueryValue::Recent { projects, next_cursor: None }
                if projects.len() == 1 && projects[0].display_name == "较早项目"
        ));
    }

    #[tokio::test]
    async fn commit_retry_is_idempotent_mismatch_fails_and_identical_autosave_is_unchanged() {
        let runtime = ProjectLibraryRuntime::temporary_for_test();
        let opened = runtime
            .open_session(OpenProjectLibrarySessionRequest {
                contract_version: 1,
                client_request_id: "open-idempotency".to_string(),
                source: OpenProjectLibrarySessionSource::Create {
                    display_name: "幂等测试".to_string(),
                    project_schema_version: 17,
                    snapshot_json: "{\"schemaVersion\":17,\"value\":1}".to_string(),
                },
            })
            .await
            .expect("create should succeed");
        let request = CommitProjectLibrarySessionRequest {
            contract_version: 1,
            library_project_id: opened.project.library_project_id.clone(),
            session_id: opened.session.session_id.clone(),
            client_mutation_id: "idempotent-save".to_string(),
            expected_head_revision: 1,
            change: CommitProjectLibrarySessionChange::Save {
                save_kind: ProjectLibrarySaveKind::Autosave,
                source_revision: None,
                label: None,
                display_name: "幂等测试".to_string(),
                project_schema_version: 17,
                snapshot_json: "{\"schemaVersion\":17,\"value\":2}".to_string(),
            },
        };
        let first = runtime
            .commit_session(request.clone())
            .await
            .expect("first commit");
        let replay = runtime
            .commit_session(request.clone())
            .await
            .expect("same request should replay");
        assert_eq!(
            first.disposition,
            ProjectLibraryCommitDisposition::Committed
        );
        assert_eq!(
            replay.disposition,
            ProjectLibraryCommitDisposition::AlreadyCommitted
        );
        assert_eq!((first.head_revision, replay.head_revision), (2, 2));

        let mut mismatch = request;
        if let CommitProjectLibrarySessionChange::Save { snapshot_json, .. } = &mut mismatch.change
        {
            *snapshot_json = "{\"schemaVersion\":17,\"value\":999}".to_string();
        }
        let mismatch = runtime
            .commit_session(mismatch)
            .await
            .expect_err("same mutation id with different payload must fail");
        assert_eq!(mismatch.code, ProjectLibraryErrorCode::IdempotencyMismatch);

        let unchanged = runtime
            .commit_session(CommitProjectLibrarySessionRequest {
                contract_version: 1,
                library_project_id: opened.project.library_project_id.clone(),
                session_id: opened.session.session_id,
                client_mutation_id: "same-content-new-operation".to_string(),
                expected_head_revision: 2,
                change: CommitProjectLibrarySessionChange::Save {
                    save_kind: ProjectLibrarySaveKind::Autosave,
                    source_revision: None,
                    label: None,
                    display_name: "幂等测试".to_string(),
                    project_schema_version: 17,
                    snapshot_json: "{\"schemaVersion\":17,\"value\":2}".to_string(),
                },
            })
            .await
            .expect("same content autosave should no-op");
        assert_eq!(
            unchanged.disposition,
            ProjectLibraryCommitDisposition::Unchanged
        );
        assert_eq!(unchanged.head_revision, 2);

        let history = runtime
            .query(ProjectLibraryQueryRequest {
                contract_version: 1,
                query: ProjectLibraryQuery::Revisions {
                    library_project_id: opened.project.library_project_id,
                    before_revision: None,
                    limit: 10,
                },
            })
            .await
            .expect("history");
        assert!(matches!(
            history,
            ProjectLibraryQueryValue::Revisions { revisions, .. } if revisions.len() == 2
        ));
    }

    #[tokio::test]
    async fn hash_identical_autosave_is_unchanged_only_when_revision_metadata_also_matches() {
        let runtime = ProjectLibraryRuntime::temporary_for_test();
        let opened = create_test_project(&runtime, "same-bytes-rename", "旧名称").await;
        let snapshot_json = opened.snapshot.snapshot_json.clone();
        let renamed = runtime
            .commit_session(CommitProjectLibrarySessionRequest {
                contract_version: 1,
                library_project_id: opened.project.library_project_id.clone(),
                session_id: opened.session.session_id.clone(),
                client_mutation_id: "same-bytes-rename".to_string(),
                expected_head_revision: 1,
                change: CommitProjectLibrarySessionChange::Save {
                    save_kind: ProjectLibrarySaveKind::Autosave,
                    source_revision: None,
                    label: None,
                    display_name: "新名称".to_string(),
                    project_schema_version: 17,
                    snapshot_json: snapshot_json.clone(),
                },
            })
            .await
            .expect("metadata change must append");
        assert_eq!(
            renamed.disposition,
            ProjectLibraryCommitDisposition::Committed
        );
        assert_eq!(renamed.head_revision, 2);

        let identical = runtime
            .commit_session(CommitProjectLibrarySessionRequest {
                contract_version: 1,
                library_project_id: opened.project.library_project_id,
                session_id: opened.session.session_id,
                client_mutation_id: "same-bytes-same-metadata".to_string(),
                expected_head_revision: 2,
                change: CommitProjectLibrarySessionChange::Save {
                    save_kind: ProjectLibrarySaveKind::Autosave,
                    source_revision: None,
                    label: None,
                    display_name: "新名称".to_string(),
                    project_schema_version: 17,
                    snapshot_json,
                },
            })
            .await
            .expect("identical autosave");
        assert_eq!(
            identical.disposition,
            ProjectLibraryCommitDisposition::Unchanged
        );
        assert_eq!(identical.head_revision, 2);
    }

    #[tokio::test]
    async fn clean_close_ack_is_durable_and_idempotent() {
        let database = TestDatabase::new();
        let runtime = database.runtime();
        let opened = create_test_project(&runtime, "close-idempotency", "关闭幂等").await;
        runtime
            .commit_session(test_autosave_request(
                &opened,
                "close-idempotency-save",
                1,
                2,
                32,
            ))
            .await
            .expect("autosave");
        let close_request = CommitProjectLibrarySessionRequest {
            contract_version: 1,
            library_project_id: opened.project.library_project_id.clone(),
            session_id: opened.session.session_id,
            client_mutation_id: "close-idempotency".to_string(),
            expected_head_revision: 2,
            change: CommitProjectLibrarySessionChange::Close,
        };
        let closed = runtime
            .commit_session(close_request.clone())
            .await
            .expect("clean close");
        assert_eq!(
            closed.disposition,
            ProjectLibraryCommitDisposition::Committed
        );
        assert!(closed.session_closed);
        drop(runtime);

        let reopened = database.runtime();
        let replay = reopened
            .commit_session(close_request.clone())
            .await
            .expect("close retry after reopen");
        assert_eq!(
            replay.disposition,
            ProjectLibraryCommitDisposition::AlreadyCommitted
        );
        assert!(replay.session_closed);
        assert_eq!((replay.head_revision, replay.stable_revision), (2, 2));

        let mut mismatch = close_request;
        mismatch.expected_head_revision = 1;
        let mismatch = reopened
            .commit_session(mismatch)
            .await
            .expect_err("same mutation id cannot be reused");
        assert_eq!(mismatch.code, ProjectLibraryErrorCode::IdempotencyMismatch);
    }

    #[tokio::test]
    async fn two_sqlite_connections_with_the_same_head_allow_exactly_one_writer() {
        let database = TestDatabase::new();
        let first_runtime = database.runtime();
        let opened = first_runtime
            .open_session(OpenProjectLibrarySessionRequest {
                contract_version: 1,
                client_request_id: "open-two-writers".to_string(),
                source: OpenProjectLibrarySessionSource::Create {
                    display_name: "并发测试".to_string(),
                    project_schema_version: 17,
                    snapshot_json: "{\"schemaVersion\":17,\"winner\":null}".to_string(),
                },
            })
            .await
            .expect("create");
        let second_runtime = database.runtime();
        let request = |mutation: &str, winner: &str| CommitProjectLibrarySessionRequest {
            contract_version: 1,
            library_project_id: opened.project.library_project_id.clone(),
            session_id: opened.session.session_id.clone(),
            client_mutation_id: mutation.to_string(),
            expected_head_revision: 1,
            change: CommitProjectLibrarySessionChange::Save {
                save_kind: ProjectLibrarySaveKind::Autosave,
                source_revision: None,
                label: None,
                display_name: "并发测试".to_string(),
                project_schema_version: 17,
                snapshot_json: format!("{{\"schemaVersion\":17,\"winner\":\"{winner}\"}}"),
            },
        };

        let (left, right) = tokio::join!(
            first_runtime.commit_session(request("writer-left", "left")),
            second_runtime.commit_session(request("writer-right", "right"))
        );
        let results = [left, right];
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        let rejected = results
            .iter()
            .find_map(|result| result.as_ref().err())
            .expect("one writer must be rejected");
        assert!(matches!(
            rejected.code,
            ProjectLibraryErrorCode::RevisionConflict | ProjectLibraryErrorCode::SessionClosed
        ));
        if rejected.code == ProjectLibraryErrorCode::RevisionConflict {
            assert_eq!(rejected.actual_head_revision, Some(2));
        }

        let stored = first_runtime
            .query(ProjectLibraryQueryRequest {
                contract_version: 1,
                query: ProjectLibraryQuery::Revision {
                    library_project_id: opened.project.library_project_id,
                    revision: 2,
                },
            })
            .await
            .expect("winning revision");
        let ProjectLibraryQueryValue::Revision { snapshot } = stored else {
            panic!("expected revision");
        };
        let winner = serde_json::from_str::<serde_json::Value>(&snapshot.snapshot_json).unwrap()
            ["winner"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(winner == "left" || winner == "right");
    }

    #[tokio::test]
    async fn foreign_open_session_never_silently_abandons_the_live_owner() {
        let database = TestDatabase::new();
        let owner = database.runtime();
        let opened = owner
            .open_session(OpenProjectLibrarySessionRequest {
                contract_version: 1,
                client_request_id: "foreign-owner-create".to_string(),
                source: OpenProjectLibrarySessionSource::Create {
                    display_name: "活跃会话".to_string(),
                    project_schema_version: 17,
                    snapshot_json: "{\"schemaVersion\":17,\"value\":1}".to_string(),
                },
            })
            .await
            .expect("owner opens project");
        let contender = database.runtime();

        let active_error = contender
            .open_session(OpenProjectLibrarySessionRequest {
                contract_version: 1,
                client_request_id: "foreign-contender-head".to_string(),
                source: OpenProjectLibrarySessionSource::Head {
                    library_project_id: opened.project.library_project_id.clone(),
                    expected_head_revision: 1,
                },
            })
            .await
            .expect_err("a foreign open session must remain owned even without autosave");
        assert_eq!(
            active_error.code,
            ProjectLibraryErrorCode::ProjectAlreadyOpen
        );

        let saved = owner
            .commit_session(test_autosave_request(
                &opened,
                "foreign-owner-save",
                1,
                2,
                32,
            ))
            .await
            .expect("rejected contender must not close the owner session");
        assert_eq!(saved.head_revision, 2);

        let recovery_error = contender
            .open_session(OpenProjectLibrarySessionRequest {
                contract_version: 1,
                client_request_id: "foreign-contender-recovery".to_string(),
                source: OpenProjectLibrarySessionSource::Head {
                    library_project_id: opened.project.library_project_id,
                    expected_head_revision: 2,
                },
            })
            .await
            .expect_err("a live foreign autosave must not be offered for takeover");
        assert_eq!(
            recovery_error.code,
            ProjectLibraryErrorCode::ProjectAlreadyOpen
        );
        assert_eq!(recovery_error.actual_head_revision, None);
    }

    #[tokio::test]
    async fn transaction_failpoints_reopen_without_half_state_and_post_commit_retry_recovers_ack() {
        for (index, failpoint) in [
            ProjectLibraryTestFailpoint::AfterRevisionInsert,
            ProjectLibraryTestFailpoint::AfterHeadUpdate,
            ProjectLibraryTestFailpoint::BeforeCommit,
        ]
        .into_iter()
        .enumerate()
        {
            let database = TestDatabase::new();
            let runtime = database.runtime();
            let opened = runtime
                .open_session(OpenProjectLibrarySessionRequest {
                    contract_version: 1,
                    client_request_id: format!("open-failpoint-{index}"),
                    source: OpenProjectLibrarySessionSource::Create {
                        display_name: "事务故障".to_string(),
                        project_schema_version: 17,
                        snapshot_json: "{\"schemaVersion\":17,\"value\":1}".to_string(),
                    },
                })
                .await
                .expect("create");
            runtime.set_failpoint_for_test(failpoint).await;
            let failed = runtime
                .commit_session(CommitProjectLibrarySessionRequest {
                    contract_version: 1,
                    library_project_id: opened.project.library_project_id.clone(),
                    session_id: opened.session.session_id,
                    client_mutation_id: format!("failed-save-{index}"),
                    expected_head_revision: 1,
                    change: CommitProjectLibrarySessionChange::Save {
                        save_kind: ProjectLibrarySaveKind::Autosave,
                        source_revision: None,
                        label: None,
                        display_name: "事务故障".to_string(),
                        project_schema_version: 17,
                        snapshot_json: "{\"schemaVersion\":17,\"value\":2}".to_string(),
                    },
                })
                .await
                .expect_err("injected transaction failure");
            assert_eq!(failed.code, ProjectLibraryErrorCode::StorageUnavailable);
            let project_id = opened.project.library_project_id;
            drop(runtime);

            let reopened = database.runtime();
            let history = reopened
                .query(ProjectLibraryQueryRequest {
                    contract_version: 1,
                    query: ProjectLibraryQuery::Revisions {
                        library_project_id: project_id.clone(),
                        before_revision: None,
                        limit: 10,
                    },
                })
                .await
                .expect("reopen history");
            assert!(matches!(
                history,
                ProjectLibraryQueryValue::Revisions { project, revisions }
                    if project.head_revision == 1 && revisions.len() == 1
            ));
            let missing = reopened
                .query(ProjectLibraryQueryRequest {
                    contract_version: 1,
                    query: ProjectLibraryQuery::Revision {
                        library_project_id: project_id,
                        revision: 2,
                    },
                })
                .await
                .expect_err("rolled-back revision must not exist");
            assert_eq!(missing.code, ProjectLibraryErrorCode::RevisionNotFound);
        }

        let database = TestDatabase::new();
        let runtime = database.runtime();
        let opened = runtime
            .open_session(OpenProjectLibrarySessionRequest {
                contract_version: 1,
                client_request_id: "open-after-commit".to_string(),
                source: OpenProjectLibrarySessionSource::Create {
                    display_name: "回执恢复".to_string(),
                    project_schema_version: 17,
                    snapshot_json: "{\"schemaVersion\":17,\"value\":1}".to_string(),
                },
            })
            .await
            .expect("create");
        let request = CommitProjectLibrarySessionRequest {
            contract_version: 1,
            library_project_id: opened.project.library_project_id,
            session_id: opened.session.session_id,
            client_mutation_id: "commit-without-ack".to_string(),
            expected_head_revision: 1,
            change: CommitProjectLibrarySessionChange::Save {
                save_kind: ProjectLibrarySaveKind::Autosave,
                source_revision: None,
                label: None,
                display_name: "回执恢复".to_string(),
                project_schema_version: 17,
                snapshot_json: "{\"schemaVersion\":17,\"value\":2}".to_string(),
            },
        };
        runtime
            .set_failpoint_for_test(ProjectLibraryTestFailpoint::AfterCommitBeforeReply)
            .await;
        let failure = runtime
            .commit_session(request.clone())
            .await
            .expect_err("ack should be lost after durable commit");
        assert_eq!(failure.code, ProjectLibraryErrorCode::StorageUnavailable);
        drop(runtime);

        let reopened = database.runtime();
        let replay = reopened
            .commit_session(request)
            .await
            .expect("same mutation should recover committed receipt");
        assert_eq!(
            replay.disposition,
            ProjectLibraryCommitDisposition::AlreadyCommitted
        );
        assert_eq!(replay.head_revision, 2);
    }

    #[tokio::test]
    async fn storage_migration_is_atomic_and_future_user_version_fails_closed() {
        let interrupted_database = TestDatabase::new();
        rusqlite::Connection::open(&interrupted_database.path)
            .expect("create v0 database")
            .pragma_update(None, "user_version", 0)
            .expect("set v0");
        let interrupted = ProjectLibraryRuntime::start_with_migration_failure_for_test(
            interrupted_database.path.clone(),
        );
        let migration_error = interrupted
            .query(ProjectLibraryQueryRequest {
                contract_version: 1,
                query: ProjectLibraryQuery::Recent {
                    limit: 10,
                    cursor: None,
                },
            })
            .await
            .expect_err("injected migration must fail");
        assert_eq!(
            migration_error.code,
            ProjectLibraryErrorCode::MigrationFailed
        );
        drop(interrupted);
        let raw = rusqlite::Connection::open(&interrupted_database.path).expect("reopen raw v0");
        let version: i64 = raw
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("read user_version");
        assert_eq!(version, 0);
        drop(raw);
        let migrated = interrupted_database.runtime();
        let result = migrated
            .query(ProjectLibraryQueryRequest {
                contract_version: 1,
                query: ProjectLibraryQuery::Recent {
                    limit: 10,
                    cursor: None,
                },
            })
            .await
            .expect("v0 should migrate after retry");
        assert!(matches!(
            result,
            ProjectLibraryQueryValue::Recent { projects, .. } if projects.is_empty()
        ));

        let future_database = TestDatabase::new();
        rusqlite::Connection::open(&future_database.path)
            .expect("create future database")
            .pragma_update(None, "user_version", 2)
            .expect("set future version");
        let future = future_database.runtime();
        let future_error = future
            .query(ProjectLibraryQueryRequest {
                contract_version: 1,
                query: ProjectLibraryQuery::Recoveries,
            })
            .await
            .expect_err("future storage version must fail closed");
        assert_eq!(
            future_error.code,
            ProjectLibraryErrorCode::UnsupportedStorageVersion
        );
    }

    #[tokio::test]
    async fn retention_prunes_only_unprotected_history_and_keeps_open_recovery_references() {
        let runtime = ProjectLibraryRuntime::temporary_for_test();
        let opened = runtime
            .open_session(OpenProjectLibrarySessionRequest {
                contract_version: 1,
                client_request_id: "open-retention".to_string(),
                source: OpenProjectLibrarySessionSource::Create {
                    display_name: "保留测试".to_string(),
                    project_schema_version: 17,
                    snapshot_json: "{\"schemaVersion\":17,\"revision\":1}".to_string(),
                },
            })
            .await
            .expect("create");
        let project_id = opened.project.library_project_id;
        let session_id = opened.session.session_id;
        runtime
            .commit_session(CommitProjectLibrarySessionRequest {
                contract_version: 1,
                library_project_id: project_id.clone(),
                session_id: session_id.clone(),
                client_mutation_id: "retention-stable-2".to_string(),
                expected_head_revision: 1,
                change: CommitProjectLibrarySessionChange::Save {
                    save_kind: ProjectLibrarySaveKind::Checkpoint,
                    source_revision: None,
                    label: Some("稳定修订".to_string()),
                    display_name: "保留测试".to_string(),
                    project_schema_version: 17,
                    snapshot_json: "{\"schemaVersion\":17,\"revision\":2}".to_string(),
                },
            })
            .await
            .expect("checkpoint");
        for revision in 3_u64..=27 {
            runtime
                .commit_session(CommitProjectLibrarySessionRequest {
                    contract_version: 1,
                    library_project_id: project_id.clone(),
                    session_id: session_id.clone(),
                    client_mutation_id: format!("retention-{revision}"),
                    expected_head_revision: revision - 1,
                    change: CommitProjectLibrarySessionChange::Save {
                        save_kind: ProjectLibrarySaveKind::Autosave,
                        source_revision: None,
                        label: None,
                        display_name: "保留测试".to_string(),
                        project_schema_version: 17,
                        snapshot_json: format!("{{\"schemaVersion\":17,\"revision\":{revision}}}"),
                    },
                })
                .await
                .expect("autosave");
        }

        let history = runtime
            .query(ProjectLibraryQueryRequest {
                contract_version: 1,
                query: ProjectLibraryQuery::Revisions {
                    library_project_id: project_id.clone(),
                    before_revision: None,
                    limit: 100,
                },
            })
            .await
            .expect("history");
        let ProjectLibraryQueryValue::Revisions { project, revisions } = history else {
            panic!("expected history");
        };
        assert_eq!((project.head_revision, project.stable_revision), (27, 2));
        let retained = revisions
            .iter()
            .map(|revision| revision.revision)
            .collect::<Vec<_>>();
        assert_eq!(retained.len(), 23);
        assert!(retained.contains(&1), "open session base must be protected");
        assert!(retained.contains(&2), "stable revision must be protected");
        assert!(
            retained.contains(&27),
            "head/latest revision must be protected"
        );
        assert!(
            !retained.contains(&3),
            "old unprotected revision should be pruned"
        );

        let stable = runtime
            .query(ProjectLibraryQueryRequest {
                contract_version: 1,
                query: ProjectLibraryQuery::Revision {
                    library_project_id: project_id.clone(),
                    revision: 2,
                },
            })
            .await
            .expect("stable revision remains readable");
        assert!(matches!(stable, ProjectLibraryQueryValue::Revision { .. }));
        let pruned = runtime
            .query(ProjectLibraryQueryRequest {
                contract_version: 1,
                query: ProjectLibraryQuery::Revision {
                    library_project_id: project_id,
                    revision: 3,
                },
            })
            .await
            .expect_err("old unprotected revision should be gone");
        assert_eq!(pruned.code, ProjectLibraryErrorCode::RevisionNotFound);
    }

    #[tokio::test]
    async fn retention_enforces_the_byte_budget_independently_of_revision_count() {
        let database = TestDatabase::new();
        let runtime = ProjectLibraryRuntime::start(
            database.path.clone(),
            ProjectLibraryLimits {
                max_snapshot_bytes: 4 * 1024 * 1024,
                max_non_protected_revisions: 100,
                max_non_protected_bytes: 600,
                busy_timeout_ms: 100,
            },
            false,
            false,
        );
        let opened = create_test_project(&runtime, "retention-bytes", "容量保留").await;
        for revision in 2_u64..=7 {
            runtime
                .commit_session(test_autosave_request(
                    &opened,
                    &format!("retention-bytes-{revision}"),
                    revision - 1,
                    revision,
                    220,
                ))
                .await
                .expect("autosave under retention byte test");
        }
        let history = runtime
            .query(ProjectLibraryQueryRequest {
                contract_version: 1,
                query: ProjectLibraryQuery::Revisions {
                    library_project_id: opened.project.library_project_id,
                    before_revision: None,
                    limit: 100,
                },
            })
            .await
            .expect("retained history");
        let ProjectLibraryQueryValue::Revisions { revisions, .. } = history else {
            panic!("expected revision list");
        };
        let non_protected_bytes = revisions
            .iter()
            .filter(|revision| !matches!(revision.revision, 1 | 7))
            .map(|revision| revision.snapshot_bytes)
            .sum::<u64>();
        assert!(non_protected_bytes <= 600);
        assert!(revisions.iter().any(|revision| revision.revision == 1));
        assert!(revisions.iter().any(|revision| revision.revision == 7));
        assert!(
            revisions.len() < 7,
            "byte budget must prune even though the count budget allows every revision"
        );
    }

    #[tokio::test]
    async fn clean_close_reapplies_retention_after_releasing_open_revision_protection() {
        let runtime = ProjectLibraryRuntime::temporary_for_test();
        let opened = runtime
            .open_session(OpenProjectLibrarySessionRequest {
                contract_version: 1,
                client_request_id: "open-close-retention".to_string(),
                source: OpenProjectLibrarySessionSource::Create {
                    display_name: "关闭后保留".to_string(),
                    project_schema_version: 17,
                    snapshot_json: "{\"schemaVersion\":17,\"revision\":1}".to_string(),
                },
            })
            .await
            .expect("create project");

        for revision in 2..=26 {
            let mutation_id = format!("close-retention-{revision}");
            runtime
                .commit_session(test_autosave_request(
                    &opened,
                    &mutation_id,
                    revision - 1,
                    revision,
                    32,
                ))
                .await
                .expect("append long-session autosave");
        }
        runtime
            .commit_session(CommitProjectLibrarySessionRequest {
                contract_version: 1,
                library_project_id: opened.project.library_project_id.clone(),
                session_id: opened.session.session_id,
                client_mutation_id: "close-after-long-session".to_string(),
                expected_head_revision: 26,
                change: CommitProjectLibrarySessionChange::Close,
            })
            .await
            .expect("clean close");

        let history = runtime
            .query(ProjectLibraryQueryRequest {
                contract_version: 1,
                query: ProjectLibraryQuery::Revisions {
                    library_project_id: opened.project.library_project_id,
                    before_revision: None,
                    limit: 100,
                },
            })
            .await
            .expect("history after close");
        let ProjectLibraryQueryValue::Revisions { project, revisions } = history else {
            panic!("expected revisions");
        };
        assert_eq!((project.head_revision, project.stable_revision), (26, 26));
        assert_eq!(revisions.len(), 21, "head plus 20 non-protected revisions");
        assert_eq!(
            revisions.first().map(|revision| revision.revision),
            Some(26)
        );
        assert!(revisions.iter().all(|revision| revision.revision != 1));
    }

    #[tokio::test]
    async fn open_request_id_is_idempotent_and_cannot_be_reused_for_different_content() {
        let runtime = ProjectLibraryRuntime::temporary_for_test();
        let request = OpenProjectLibrarySessionRequest {
            contract_version: 1,
            client_request_id: "same-open-operation".to_string(),
            source: OpenProjectLibrarySessionSource::Create {
                display_name: "打开幂等".to_string(),
                project_schema_version: 17,
                snapshot_json: "{\"schemaVersion\":17,\"value\":1}".to_string(),
            },
        };
        let first = runtime
            .open_session(request.clone())
            .await
            .expect("first open");
        let replay = runtime
            .open_session(request.clone())
            .await
            .expect("same open request should replay");
        assert_eq!(first, replay);

        let mut mismatch = request;
        if let OpenProjectLibrarySessionSource::Create { snapshot_json, .. } = &mut mismatch.source
        {
            *snapshot_json = "{\"schemaVersion\":17,\"value\":2}".to_string();
        }
        let mismatch = runtime
            .open_session(mismatch)
            .await
            .expect_err("same open id with different payload must fail");
        assert_eq!(mismatch.code, ProjectLibraryErrorCode::IdempotencyMismatch);

        let recent = runtime
            .query(ProjectLibraryQueryRequest {
                contract_version: 1,
                query: ProjectLibraryQuery::Recent {
                    limit: 10,
                    cursor: None,
                },
            })
            .await
            .expect("recent");
        assert!(matches!(
            recent,
            ProjectLibraryQueryValue::Recent { projects, .. } if projects.len() == 1
        ));
    }

    #[tokio::test]
    async fn open_ack_retry_after_restart_reattaches_only_the_exact_unchanged_session() {
        let database = TestDatabase::new();
        let request = OpenProjectLibrarySessionRequest {
            contract_version: 1,
            client_request_id: "open-ack-restart".to_string(),
            source: OpenProjectLibrarySessionSource::Create {
                display_name: "打开回执恢复".to_string(),
                project_schema_version: 17,
                snapshot_json: "{\"schemaVersion\":17,\"value\":1}".to_string(),
            },
        };
        let first_runtime = database.runtime();
        let first = first_runtime
            .open_session(request.clone())
            .await
            .expect("durable open before lost ack");
        drop(first_runtime);

        let restarted = database.runtime();
        let replay = restarted
            .open_session(request)
            .await
            .expect("same open operation should recover its exact session");
        assert_eq!(replay, first);
        let saved = restarted
            .commit_session(test_autosave_request(
                &replay,
                "save-after-open-ack-retry",
                1,
                2,
                32,
            ))
            .await
            .expect("reattached session must be usable by the new runtime");
        assert_eq!(saved.head_revision, 2);

        let later_runtime = database.runtime();
        let unsafe_replay = later_runtime
            .open_session(OpenProjectLibrarySessionRequest {
                contract_version: 1,
                client_request_id: "open-ack-restart".to_string(),
                source: OpenProjectLibrarySessionSource::Create {
                    display_name: "打开回执恢复".to_string(),
                    project_schema_version: 17,
                    snapshot_json: "{\"schemaVersion\":17,\"value\":1}".to_string(),
                },
            })
            .await
            .expect_err("a changed session must not be stolen by an old open receipt");
        assert_eq!(
            unsafe_replay.code,
            ProjectLibraryErrorCode::ProjectAlreadyOpen
        );
        assert_eq!(unsafe_replay.actual_head_revision, None);
    }

    #[tokio::test]
    async fn open_receipt_replay_in_same_runtime_remains_stable_after_session_progress() {
        let database = TestDatabase::new();
        let runtime = database.runtime();
        let request = OpenProjectLibrarySessionRequest {
            contract_version: 1,
            client_request_id: "open-replay-after-save".to_string(),
            source: OpenProjectLibrarySessionSource::Create {
                display_name: "打开回执稳定".to_string(),
                project_schema_version: 17,
                snapshot_json: "{\"schemaVersion\":17,\"value\":1}".to_string(),
            },
        };
        let first = runtime
            .open_session(request.clone())
            .await
            .expect("initial open");
        runtime
            .commit_session(test_autosave_request(
                &first,
                "save-before-open-replay",
                1,
                2,
                32,
            ))
            .await
            .expect("session progress");

        let replay = runtime
            .open_session(request)
            .await
            .expect("the original runtime should receive its durable receipt");
        assert_eq!(replay, first);
    }

    #[tokio::test]
    async fn snapshot_requests_are_single_in_flight_without_charging_query_or_close() {
        let runtime = ProjectLibraryRuntime::temporary_for_test();
        let opened = runtime
            .open_session(OpenProjectLibrarySessionRequest {
                contract_version: 1,
                client_request_id: "open-snapshot-budget".to_string(),
                source: OpenProjectLibrarySessionSource::Create {
                    display_name: "快照预算".to_string(),
                    project_schema_version: 17,
                    snapshot_json: "{\"schemaVersion\":17,\"value\":1}".to_string(),
                },
            })
            .await
            .expect("create project");
        let release = runtime.pause_actor_for_test().await;

        let first_runtime = runtime.clone();
        let first_opened = opened.clone();
        let first_snapshot = tokio::spawn(async move {
            first_runtime
                .commit_session(test_autosave_request(
                    &first_opened,
                    "snapshot-budget-first",
                    1,
                    2,
                    2 * 1024 * 1024,
                ))
                .await
        });
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        assert!(!first_snapshot.is_finished(), "actor must still be paused");

        let second_snapshot = tokio::time::timeout(
            std::time::Duration::from_millis(100),
            runtime.open_session(OpenProjectLibrarySessionRequest {
                contract_version: 1,
                client_request_id: "snapshot-budget-second".to_string(),
                source: OpenProjectLibrarySessionSource::Create {
                    display_name: "第二个大快照".to_string(),
                    project_schema_version: 17,
                    snapshot_json: format!(
                        "{{\"schemaVersion\":17,\"padding\":\"{}\"}}",
                        "x".repeat(2 * 1024 * 1024)
                    ),
                },
            }),
        )
        .await;

        let query_runtime = runtime.clone();
        let query = tokio::spawn(async move {
            query_runtime
                .query(ProjectLibraryQueryRequest {
                    contract_version: 1,
                    query: ProjectLibraryQuery::Recent {
                        limit: 10,
                        cursor: None,
                    },
                })
                .await
        });
        let close_runtime = runtime.clone();
        let close_project_id = opened.project.library_project_id.clone();
        let close_session_id = opened.session.session_id.clone();
        let close = tokio::spawn(async move {
            close_runtime
                .commit_session(CommitProjectLibrarySessionRequest {
                    contract_version: 1,
                    library_project_id: close_project_id,
                    session_id: close_session_id,
                    client_mutation_id: "snapshot-budget-close".to_string(),
                    expected_head_revision: 2,
                    change: CommitProjectLibrarySessionChange::Close,
                })
                .await
        });
        release.send(()).expect("release paused actor");

        first_snapshot
            .await
            .expect("first task")
            .expect("first snapshot should complete");
        query
            .await
            .expect("query task")
            .expect("metadata query must not consume snapshot budget");
        close
            .await
            .expect("close task")
            .expect("close must not consume snapshot budget");
        let busy = second_snapshot
            .expect("second snapshot must be rejected without entering the actor")
            .expect_err("only one snapshot-bearing request may be in flight");
        assert_eq!(busy.code, ProjectLibraryErrorCode::LibraryBusy);

        runtime
            .open_session(OpenProjectLibrarySessionRequest {
                contract_version: 1,
                client_request_id: "snapshot-budget-after-release".to_string(),
                source: OpenProjectLibrarySessionSource::Create {
                    display_name: "预算已释放".to_string(),
                    project_schema_version: 17,
                    snapshot_json: "{\"schemaVersion\":17}".to_string(),
                },
            })
            .await
            .expect("snapshot permit must release after the first request completes");
    }

    #[tokio::test]
    async fn invalid_unknown_and_over_limit_snapshots_fail_before_storage() {
        let runtime = ProjectLibraryRuntime::temporary_for_test();
        for (request_id, snapshot) in [
            ("invalid-array", "[]".to_string()),
            ("invalid-json", "{not-json}".to_string()),
            ("invalid-trailing", "{} trailing".to_string()),
        ] {
            let error = runtime
                .open_session(OpenProjectLibrarySessionRequest {
                    contract_version: 1,
                    client_request_id: request_id.to_string(),
                    source: OpenProjectLibrarySessionSource::Create {
                        display_name: "无效快照".to_string(),
                        project_schema_version: 17,
                        snapshot_json: snapshot,
                    },
                })
                .await
                .expect_err("invalid snapshot must fail closed");
            assert_eq!(error.code, ProjectLibraryErrorCode::InvalidSnapshotJson);
        }

        let oversized = format!("{{\"padding\":\"{}\"}}", "x".repeat(4 * 1024 * 1024));
        let error = runtime
            .open_session(OpenProjectLibrarySessionRequest {
                contract_version: 1,
                client_request_id: "snapshot-too-large".to_string(),
                source: OpenProjectLibrarySessionSource::Create {
                    display_name: "过大快照".to_string(),
                    project_schema_version: 17,
                    snapshot_json: oversized,
                },
            })
            .await
            .expect_err("oversized snapshot must fail before storage");
        assert_eq!(error.code, ProjectLibraryErrorCode::SnapshotTooLarge);

        let unknown_field = serde_json::json!({
            "contractVersion": 1,
            "clientRequestId": "unknown-field",
            "source": {
                "kind": "create",
                "displayName": "未知字段",
                "projectSchemaVersion": 17,
                "snapshotJson": "{}",
                "databasePath": "C:/private/library.sqlite3"
            }
        });
        assert!(
            serde_json::from_value::<OpenProjectLibrarySessionRequest>(unknown_field).is_err(),
            "wire DTO must reject unknown fields before the repository sees them"
        );

        let recent = runtime
            .query(ProjectLibraryQueryRequest {
                contract_version: 1,
                query: ProjectLibraryQuery::Recent {
                    limit: 10,
                    cursor: None,
                },
            })
            .await
            .expect("invalid writes must leave the library readable");
        assert!(matches!(
            recent,
            ProjectLibraryQueryValue::Recent { projects, .. } if projects.is_empty()
        ));
    }

    #[tokio::test]
    async fn busy_read_only_and_storage_full_fail_closed_without_advancing_head() {
        let busy_database = TestDatabase::new();
        let busy_runtime = busy_database.runtime();
        let opened = create_test_project(&busy_runtime, "busy", "并发占用").await;
        let lock = rusqlite::Connection::open(&busy_database.path).expect("open lock connection");
        lock.execute_batch("BEGIN IMMEDIATE")
            .expect("hold writer lock");
        let busy = busy_runtime
            .commit_session(test_autosave_request(&opened, "busy-save", 1, 2, 32))
            .await
            .expect_err("external writer lock must fail closed");
        assert_eq!(busy.code, ProjectLibraryErrorCode::LibraryBusy);
        assert!(busy.retryable);
        assert_error_is_sanitized(&busy, &busy_database.path, "value");
        lock.execute_batch("ROLLBACK").expect("release writer lock");
        assert_project_head(&busy_runtime, &opened.project.library_project_id, 1).await;

        let read_only_runtime = ProjectLibraryRuntime::temporary_for_test();
        let opened = create_test_project(&read_only_runtime, "readonly", "只读失败").await;
        read_only_runtime
            .set_query_only_for_test()
            .await
            .expect("enable query_only");
        let denied = read_only_runtime
            .commit_session(test_autosave_request(&opened, "readonly-save", 1, 2, 32))
            .await
            .expect_err("read-only storage must fail closed");
        assert_eq!(denied.code, ProjectLibraryErrorCode::PermissionDenied);
        assert!(!denied.retryable);
        assert_project_head(&read_only_runtime, &opened.project.library_project_id, 1).await;

        let full_runtime = ProjectLibraryRuntime::temporary_for_test();
        let opened = create_test_project(&full_runtime, "full", "磁盘已满").await;
        full_runtime
            .limit_database_pages_for_test()
            .await
            .expect("freeze max_page_count");
        let full = full_runtime
            .commit_session(test_autosave_request(
                &opened,
                "full-save",
                1,
                2,
                1024 * 1024,
            ))
            .await
            .expect_err("page limit must simulate SQLITE_FULL");
        assert_eq!(full.code, ProjectLibraryErrorCode::StorageFull);
        assert!(full.retryable);
        assert_project_head(&full_runtime, &opened.project.library_project_id, 1).await;
    }

    #[tokio::test]
    async fn corrupted_head_snapshot_never_falls_back_to_an_older_revision() {
        let database = TestDatabase::new();
        let runtime = database.runtime();
        let opened = create_test_project(&runtime, "corrupt", "损坏检测").await;
        let checkpoint = runtime
            .commit_session(CommitProjectLibrarySessionRequest {
                change: CommitProjectLibrarySessionChange::Save {
                    save_kind: ProjectLibrarySaveKind::Checkpoint,
                    source_revision: None,
                    label: Some("稳定版本".to_string()),
                    display_name: "损坏检测".to_string(),
                    project_schema_version: 17,
                    snapshot_json: "{\"schemaVersion\":17,\"value\":2}".to_string(),
                },
                ..test_autosave_request(&opened, "corrupt-checkpoint", 1, 2, 32)
            })
            .await
            .expect("checkpoint");
        runtime
            .commit_session(CommitProjectLibrarySessionRequest {
                contract_version: 1,
                library_project_id: opened.project.library_project_id.clone(),
                session_id: opened.session.session_id,
                client_mutation_id: "close-before-corruption".to_string(),
                expected_head_revision: checkpoint.head_revision,
                change: CommitProjectLibrarySessionChange::Close,
            })
            .await
            .expect("clean close");
        let project_id = opened.project.library_project_id;
        drop(runtime);

        let raw = rusqlite::Connection::open(&database.path).expect("open database for tamper");
        raw.execute(
            "UPDATE project_revisions SET snapshot_bytes=?1
             WHERE library_project_id=?2 AND revision=2",
            rusqlite::params![b"{\"schemaVersion\":17,\"tampered\":true}", project_id],
        )
        .expect("tamper head without updating digest");
        drop(raw);

        let reopened = database.runtime();
        let error = reopened
            .open_session(OpenProjectLibrarySessionRequest {
                contract_version: 1,
                client_request_id: "open-corrupt-head".to_string(),
                source: OpenProjectLibrarySessionSource::Head {
                    library_project_id: project_id,
                    expected_head_revision: 2,
                },
            })
            .await
            .expect_err("corrupt head must not fall back to revision 1");
        assert_eq!(error.code, ProjectLibraryErrorCode::StorageCorrupt);
        assert!(!error.message.contains("tampered"));
        assert!(!error.message.contains("sqlite"));
    }

    #[tokio::test]
    async fn inconsistent_snapshot_length_is_storage_corruption_not_a_partial_read() {
        let database = TestDatabase::new();
        let runtime = database.runtime();
        let opened = create_test_project(&runtime, "corrupt-length", "长度损坏").await;
        let project_id = opened.project.library_project_id;
        drop(runtime);

        let raw = rusqlite::Connection::open(&database.path).expect("open database for tamper");
        raw.execute(
            "UPDATE project_revisions SET snapshot_len=snapshot_len+1
             WHERE library_project_id=?1 AND revision=1",
            [&project_id],
        )
        .expect("tamper stored length");
        drop(raw);

        let reopened = database.runtime();
        let error = reopened
            .query(ProjectLibraryQueryRequest {
                contract_version: 1,
                query: ProjectLibraryQuery::Revision {
                    library_project_id: project_id,
                    revision: 1,
                },
            })
            .await
            .expect_err("length mismatch must fail closed");
        assert_eq!(error.code, ProjectLibraryErrorCode::StorageCorrupt);
    }

    #[tokio::test]
    async fn sqlite_actor_enforces_wal_full_and_foreign_keys() {
        let runtime = ProjectLibraryRuntime::temporary_for_test();
        let (journal_mode, synchronous, foreign_keys) = runtime
            .storage_settings_for_test()
            .await
            .expect("inspect actor connection pragmas");
        assert_eq!(journal_mode.to_ascii_lowercase(), "wal");
        assert_eq!(synchronous, 2, "SQLite FULL is numeric level 2");
        assert!(foreign_keys);
    }

    #[test]
    fn wire_reply_is_exact_camel_case_and_never_exposes_repository_details() {
        let success = ProjectLibraryReply::from_result(Ok(ProjectLibraryQueryValue::Recent {
            projects: Vec::new(),
            next_cursor: None,
        }));
        let success = serde_json::to_value(success).expect("serialize success reply");
        assert_eq!(
            success,
            serde_json::json!({
                "contractVersion": 1,
                "ok": true,
                "value": { "kind": "recent", "projects": [], "nextCursor": null }
            })
        );

        let failure: ProjectLibraryReply<ProjectLibraryQueryValue> =
            ProjectLibraryReply::from_result(Err(ProjectLibraryError::new(
                ProjectLibraryErrorCode::StorageUnavailable,
                "本地项目库暂时不可用。",
                true,
            )));
        let failure = serde_json::to_value(failure).expect("serialize failure reply");
        assert_eq!(
            failure,
            serde_json::json!({
                "contractVersion": 1,
                "ok": false,
                "error": {
                    "code": "storageUnavailable",
                    "message": "本地项目库暂时不可用。",
                    "retryable": true,
                    "actualHeadRevision": null
                }
            })
        );
        let serialized = failure.to_string().to_ascii_lowercase();
        for forbidden in ["databasepath", "sqlite", "select ", "connection"] {
            assert!(!serialized.contains(forbidden));
        }
    }

    #[test]
    fn rust_wire_requests_accept_only_the_exact_camel_case_contract() {
        let query: ProjectLibraryQueryRequest = serde_json::from_value(serde_json::json!({
            "contractVersion": 1,
            "query": {
                "kind": "revisions",
                "libraryProjectId": "project-001",
                "beforeRevision": 9,
                "limit": 20
            }
        }))
        .expect("camelCase query request");
        assert!(matches!(
            query.query,
            ProjectLibraryQuery::Revisions {
                library_project_id,
                before_revision: Some(9),
                limit: 20
            } if library_project_id == "project-001"
        ));

        let open: OpenProjectLibrarySessionRequest = serde_json::from_value(serde_json::json!({
            "contractVersion": 1,
            "clientRequestId": "discard-001",
            "source": {
                "kind": "discardRecovery",
                "libraryProjectId": "project-001",
                "recoverySessionId": "session-old",
                "expectedHeadRevision": 4,
                "sourceRevision": 2,
                "displayName": "示例项目",
                "projectSchemaVersion": 17,
                "snapshotJson": "{\"schemaVersion\":17}"
            }
        }))
        .expect("camelCase open request");
        assert!(matches!(
            open.source,
            OpenProjectLibrarySessionSource::DiscardRecovery {
                expected_head_revision: 4,
                source_revision: 2,
                ..
            }
        ));

        let commit: CommitProjectLibrarySessionRequest =
            serde_json::from_value(serde_json::json!({
                "contractVersion": 1,
                "libraryProjectId": "project-001",
                "sessionId": "session-001",
                "clientMutationId": "save-001",
                "expectedHeadRevision": 4,
                "change": {
                    "kind": "save",
                    "saveKind": "rollback",
                    "sourceRevision": 2,
                    "label": "恢复旧版本",
                    "displayName": "示例项目",
                    "projectSchemaVersion": 17,
                    "snapshotJson": "{\"schemaVersion\":17}"
                }
            }))
            .expect("camelCase commit request");
        assert!(matches!(
            commit.change,
            CommitProjectLibrarySessionChange::Save {
                save_kind: ProjectLibrarySaveKind::Rollback,
                source_revision: Some(2),
                ..
            }
        ));

        assert!(
            serde_json::from_value::<ProjectLibraryQueryRequest>(serde_json::json!({
                "contract_version": 1,
                "query": { "kind": "recoveries" }
            }))
            .is_err(),
            "snake_case aliases are not part of the public contract"
        );
    }

    #[tokio::test]
    #[ignore = "manual release-mode Project Library performance baseline"]
    async fn project_library_release_performance_baseline() {
        let database = TestDatabase::new();
        let cold_started_at = std::time::Instant::now();
        let runtime = ProjectLibraryRuntime::start(
            database.path.clone(),
            ProjectLibraryLimits::production(),
            false,
            false,
        );
        runtime
            .query(ProjectLibraryQueryRequest {
                contract_version: 1,
                query: ProjectLibraryQuery::Recent {
                    limit: 50,
                    cursor: None,
                },
            })
            .await
            .expect("cold initialize and query");
        let cold_start = cold_started_at.elapsed();

        let opened = create_test_project(&runtime, "performance", "性能基线").await;
        let save_started_at = std::time::Instant::now();
        runtime
            .commit_session(test_autosave_request(
                &opened,
                "performance-16m-save",
                1,
                2,
                16 * 1024 * 1024,
            ))
            .await
            .expect("16 MiB autosave");
        let save_16_mib = save_started_at.elapsed();

        let unchanged_request =
            test_autosave_request(&opened, "performance-16m-unchanged", 2, 2, 16 * 1024 * 1024);
        let unchanged_started_at = std::time::Instant::now();
        let unchanged = runtime
            .commit_session(unchanged_request)
            .await
            .expect("16 MiB unchanged autosave");
        let unchanged_16_mib = unchanged_started_at.elapsed();
        assert_eq!(
            unchanged.disposition,
            ProjectLibraryCommitDisposition::Unchanged
        );

        let read_started_at = std::time::Instant::now();
        let read = runtime
            .query(ProjectLibraryQueryRequest {
                contract_version: 1,
                query: ProjectLibraryQuery::Revision {
                    library_project_id: opened.project.library_project_id,
                    revision: 2,
                },
            })
            .await
            .expect("16 MiB hot read");
        let read_16_mib = read_started_at.elapsed();
        assert!(matches!(
            read,
            ProjectLibraryQueryValue::Revision { snapshot }
                if snapshot.snapshot_json.len() > 16 * 1024 * 1024
        ));

        for index in 0..100 {
            create_test_project(&runtime, &format!("perf-recent-{index}"), "最近项目").await;
        }
        let recent_started_at = std::time::Instant::now();
        let recent = runtime
            .query(ProjectLibraryQueryRequest {
                contract_version: 1,
                query: ProjectLibraryQuery::Recent {
                    limit: 50,
                    cursor: None,
                },
            })
            .await
            .expect("recent 50 query");
        let recent_50 = recent_started_at.elapsed();
        assert!(matches!(
            recent,
            ProjectLibraryQueryValue::Recent { projects, .. } if projects.len() == 50
        ));

        println!(
            "project-library-performance coldStartMs={} save16MiBMs={} unchanged16MiBMs={} read16MiBMs={} recent50Ms={}",
            cold_start.as_millis(),
            save_16_mib.as_millis(),
            unchanged_16_mib.as_millis(),
            read_16_mib.as_millis(),
            recent_50.as_millis()
        );
        assert!(cold_start < std::time::Duration::from_secs(1));
        assert!(save_16_mib < std::time::Duration::from_secs(3));
        assert!(unchanged_16_mib < std::time::Duration::from_secs(1));
        assert!(read_16_mib < std::time::Duration::from_secs(1));
        assert!(recent_50 < std::time::Duration::from_millis(250));
    }

    async fn create_test_project(
        runtime: &ProjectLibraryRuntime,
        request_suffix: &str,
        display_name: &str,
    ) -> super::OpenProjectLibrarySessionValue {
        runtime
            .open_session(OpenProjectLibrarySessionRequest {
                contract_version: 1,
                client_request_id: format!("open-{request_suffix}"),
                source: OpenProjectLibrarySessionSource::Create {
                    display_name: display_name.to_string(),
                    project_schema_version: 17,
                    snapshot_json: "{\"schemaVersion\":17,\"value\":1}".to_string(),
                },
            })
            .await
            .expect("create test project")
    }

    fn test_autosave_request(
        opened: &super::OpenProjectLibrarySessionValue,
        mutation_id: &str,
        expected_head_revision: u64,
        value: u64,
        padding_bytes: usize,
    ) -> CommitProjectLibrarySessionRequest {
        CommitProjectLibrarySessionRequest {
            contract_version: 1,
            library_project_id: opened.project.library_project_id.clone(),
            session_id: opened.session.session_id.clone(),
            client_mutation_id: mutation_id.to_string(),
            expected_head_revision,
            change: CommitProjectLibrarySessionChange::Save {
                save_kind: ProjectLibrarySaveKind::Autosave,
                source_revision: None,
                label: None,
                display_name: opened.project.display_name.clone(),
                project_schema_version: 17,
                snapshot_json: format!(
                    "{{\"schemaVersion\":17,\"value\":{value},\"padding\":\"{}\"}}",
                    "x".repeat(padding_bytes)
                ),
            },
        }
    }

    async fn assert_project_head(
        runtime: &ProjectLibraryRuntime,
        project_id: &str,
        expected_head: u64,
    ) {
        let history = runtime
            .query(ProjectLibraryQueryRequest {
                contract_version: 1,
                query: ProjectLibraryQuery::Revisions {
                    library_project_id: project_id.to_string(),
                    before_revision: None,
                    limit: 10,
                },
            })
            .await
            .expect("history remains readable");
        assert!(matches!(
            history,
            ProjectLibraryQueryValue::Revisions { project, revisions }
                if project.head_revision == expected_head
                    && revisions.first().map(|revision| revision.revision) == Some(expected_head)
        ));
    }

    fn assert_error_is_sanitized(error: &super::ProjectLibraryError, path: &Path, secret: &str) {
        let path = path.to_string_lossy();
        assert!(!error.message.contains(path.as_ref()));
        assert!(!error.message.contains(secret));
        assert!(!error.message.to_ascii_lowercase().contains("sql"));
    }
}
