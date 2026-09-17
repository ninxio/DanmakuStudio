use super::*;
use std::path::PathBuf;

struct Database(PathBuf);
impl Database {
    fn new() -> Self {
        let directory = std::env::temp_dir().join(generate_identifier("dts-lease-test").unwrap());
        fs::create_dir(&directory).unwrap();
        Self(directory.join("library.sqlite3"))
    }
    fn open(&self) -> SqliteProjectLibrary {
        SqliteProjectLibrary::open(&self.0, ProjectLibraryLimits::test(), false).unwrap()
    }
}
impl Drop for Database {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(self.0.parent().unwrap());
    }
}
fn create_request() -> OpenProjectLibrarySessionRequest {
    OpenProjectLibrarySessionRequest {
        contract_version: 1,
        client_request_id: "create-owner".into(),
        source: OpenProjectLibrarySessionSource::Create {
            display_name: "lease test".into(),
            project_schema_version: 17,
            snapshot_json: "{\"schemaVersion\":17,\"value\":1}".into(),
        },
    }
}
fn head(
    opened: &OpenProjectLibrarySessionValue,
    revision: u64,
) -> OpenProjectLibrarySessionRequest {
    OpenProjectLibrarySessionRequest {
        contract_version: 1,
        client_request_id: generate_identifier("head").unwrap(),
        source: OpenProjectLibrarySessionSource::Head {
            library_project_id: opened.project.library_project_id.clone(),
            expected_head_revision: revision,
        },
    }
}
fn recover(
    opened: &OpenProjectLibrarySessionValue,
    revision: u64,
) -> OpenProjectLibrarySessionRequest {
    OpenProjectLibrarySessionRequest {
        contract_version: 1,
        client_request_id: generate_identifier("recover").unwrap(),
        source: OpenProjectLibrarySessionSource::Recover {
            library_project_id: opened.project.library_project_id.clone(),
            recovery_session_id: opened.session.session_id.clone(),
            recovery_revision: revision,
            expected_head_revision: revision,
        },
    }
}
fn save_autosave(owner: &mut SqliteProjectLibrary, opened: &OpenProjectLibrarySessionValue) {
    owner
        .commit_session(CommitProjectLibrarySessionRequest {
            contract_version: 1,
            library_project_id: opened.project.library_project_id.clone(),
            session_id: opened.session.session_id.clone(),
            client_mutation_id: "new-autosave".into(),
            expected_head_revision: 1,
            change: CommitProjectLibrarySessionChange::Save {
                save_kind: ProjectLibrarySaveKind::Autosave,
                source_revision: None,
                label: None,
                display_name: "lease test".into(),
                project_schema_version: 17,
                snapshot_json: "{\"schemaVersion\":17,\"value\":2}".into(),
            },
        })
        .unwrap();
}

#[test]
fn live_runtime_blocks_head_recovery_discard_and_receipt_reattachment() {
    let database = Database::new();
    let mut owner = database.open();
    let opened = owner.open_session(create_request()).unwrap();
    let mut contender = database.open();
    assert_eq!(
        contender.open_session(head(&opened, 1)).unwrap_err().code,
        ProjectLibraryErrorCode::ProjectAlreadyOpen
    );
    assert_eq!(
        contender.open_session(create_request()).unwrap_err().code,
        ProjectLibraryErrorCode::ProjectAlreadyOpen
    );
    save_autosave(&mut owner, &opened);
    assert_eq!(
        contender
            .open_session(recover(&opened, 2))
            .unwrap_err()
            .code,
        ProjectLibraryErrorCode::ProjectAlreadyOpen
    );
    let discard = OpenProjectLibrarySessionRequest {
        contract_version: 1,
        client_request_id: "discard-live".into(),
        source: OpenProjectLibrarySessionSource::DiscardRecovery {
            library_project_id: opened.project.library_project_id.clone(),
            recovery_session_id: opened.session.session_id.clone(),
            expected_head_revision: 2,
            source_revision: 1,
            display_name: "lease test".into(),
            project_schema_version: 17,
            snapshot_json: "{\"schemaVersion\":17,\"value\":1}".into(),
        },
    };
    assert_eq!(
        contender.open_session(discard).unwrap_err().code,
        ProjectLibraryErrorCode::ProjectAlreadyOpen
    );
    assert!(
        matches!(contender.list_recoveries().unwrap(), ProjectLibraryQueryValue::Recoveries { recoveries } if recoveries.is_empty())
    );
    assert_eq!(
        load_head_and_stable(&owner.connection, &opened.project.library_project_id).unwrap(),
        (2, 1)
    );
}

#[test]
fn crashed_clean_runtime_reopens_but_dirty_snapshot_still_requires_a_decision() {
    let database = Database::new();
    let mut owner = database.open();
    let opened = owner.open_session(create_request()).unwrap();
    drop(owner); // no graceful cleanup: simulates the OS releasing a crashed actor's lock
    let mut reopened = database.open();
    let resumed = reopened.open_session(head(&opened, 1)).unwrap();
    assert_eq!(
        resumed.snapshot.snapshot_json,
        opened.snapshot.snapshot_json
    );
    save_autosave(&mut reopened, &resumed);
    drop(reopened);
    let mut recovery = database.open();
    assert_eq!(
        recovery.open_session(head(&resumed, 2)).unwrap_err().code,
        ProjectLibraryErrorCode::RecoveryDecisionRequired
    );
    assert!(
        matches!(recovery.list_recoveries().unwrap(), ProjectLibraryQueryValue::Recoveries { recoveries } if recoveries.len() == 1 && recoveries[0].has_newer_autosave)
    );
    let restored = recovery.open_session(recover(&resumed, 2)).unwrap();
    assert!(restored.snapshot.snapshot_json.contains("\"value\":2"));
    assert_eq!(restored.project.stable_revision, 1);
}

#[test]
fn graceful_shutdown_closes_only_stable_sessions_and_preserves_exact_open_receipts() {
    let database = Database::new();
    let mut owner = database.open();
    let opened = owner.open_session(create_request()).unwrap();
    owner.close_stable_runtime_sessions().unwrap();
    drop(owner);
    let mut reopened = database.open();
    let reattached = reopened.open_session(create_request()).unwrap();
    assert_eq!(reattached, opened);
    save_autosave(&mut reopened, &reattached);
    reopened.close_stable_runtime_sessions().unwrap();
    let state: String = reopened
        .connection
        .query_row(
            "SELECT state FROM project_sessions WHERE session_id=?1",
            [&reattached.session.session_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(state, "open");
}

#[test]
fn legacy_stable_session_requires_explicit_recovery_and_excludes_live_old_connections() {
    let database = Database::new();
    let mut owner = database.open();
    let opened = owner.open_session(create_request()).unwrap();
    owner
        .connection
        .execute(
            "UPDATE project_sessions SET runtime_id='legacy_runtime'",
            [],
        )
        .unwrap();
    let mut contender = database.open();
    let legacy_error = contender.open_session(head(&opened, 1)).unwrap_err();
    assert_eq!(legacy_error.actual_head_revision, Some(1));
    assert_eq!(
        contender.open_session(head(&opened, 1)).unwrap_err().code,
        ProjectLibraryErrorCode::RecoveryDecisionRequired
    );
    assert!(
        matches!(contender.list_recoveries().unwrap(), ProjectLibraryQueryValue::Recoveries { recoveries } if recoveries.len() == 1 && !recoveries[0].has_newer_autosave)
    );
    assert_eq!(
        contender
            .open_session(recover(&opened, 1))
            .unwrap_err()
            .code,
        ProjectLibraryErrorCode::ProjectAlreadyOpen
    );
    assert_eq!(
        load_head_and_stable(&owner.connection, &opened.project.library_project_id).unwrap(),
        (1, 1)
    );
    drop(owner);
    let restored = contender.open_session(recover(&opened, 1)).unwrap();
    assert_eq!(
        restored.snapshot.snapshot_json,
        opened.snapshot.snapshot_json
    );
    assert_eq!(restored.project.head_revision, 2);
    let peer = database.open();
    assert_eq!(
        load_head_and_stable(&peer.connection, &opened.project.library_project_id).unwrap(),
        (2, 1)
    );
}

#[test]
fn ownership_errors_keep_the_public_error_context_contract() {
    for (code, expected) in [
        (ProjectLibraryErrorCode::ProjectAlreadyOpen, None),
        (ProjectLibraryErrorCode::StorageUnavailable, None),
        (ProjectLibraryErrorCode::RecoveryDecisionRequired, Some(3)),
        (ProjectLibraryErrorCode::RevisionConflict, Some(3)),
    ] {
        let error = ProjectLibraryError::new(code, "test", false).with_actual_head(3);
        assert_eq!(error.actual_head_revision, expected);
    }
}

#[test]
fn receipt_replay_rechecks_an_owner_reattached_after_preflight() {
    let database = Database::new();
    let mut original = database.open();
    let opened = original.open_session(create_request()).unwrap();
    drop(original);

    let mut delayed = database.open();
    let request = create_request();
    let access = delayed.prepare_session_access(&request).unwrap();
    let mut winner = database.open();
    let reattached = winner.open_session(create_request()).unwrap();
    assert_eq!(reattached.session.session_id, opened.session.session_id);

    // Exact interleaving, without threads or sleeps: preflight saw the dead
    // original owner, but the receipt transaction must see the live winner.
    assert_eq!(
        delayed
            .open_session_checked(request, access)
            .unwrap_err()
            .code,
        ProjectLibraryErrorCode::ProjectAlreadyOpen
    );
    let owner: String = winner
        .connection
        .query_row(
            "SELECT runtime_id FROM project_sessions WHERE session_id=?1",
            [&reattached.session.session_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(owner, winner.runtime_id);
    save_autosave(&mut winner, &reattached);
    assert_eq!(
        load_head_and_stable(&winner.connection, &opened.project.library_project_id).unwrap(),
        (2, 1)
    );
}

#[test]
fn recovery_and_discard_recheck_an_owner_reattached_after_preflight() {
    let database = Database::new();
    let mut original = database.open();
    let opened = original.open_session(create_request()).unwrap();
    save_autosave(&mut original, &opened);
    drop(original);

    // An interrupted recovery leaves an open receipt at an unconfirmed head.
    let mut interrupted = database.open();
    let replay_request = recover(&opened, 2);
    let recovered = interrupted.open_session(replay_request.clone()).unwrap();
    assert_eq!(
        (
            recovered.project.head_revision,
            recovered.project.stable_revision
        ),
        (3, 1)
    );
    drop(interrupted);

    let mut delayed = database.open();
    let recover_request = recover(&recovered, 3);
    let recover_access = delayed.prepare_session_access(&recover_request).unwrap();
    let discard_request = OpenProjectLibrarySessionRequest {
        contract_version: 1,
        client_request_id: "discard-delayed".into(),
        source: OpenProjectLibrarySessionSource::DiscardRecovery {
            library_project_id: recovered.project.library_project_id.clone(),
            recovery_session_id: recovered.session.session_id.clone(),
            expected_head_revision: 3,
            source_revision: 1,
            display_name: opened.snapshot.display_name.clone(),
            project_schema_version: opened.snapshot.project_schema_version,
            snapshot_json: opened.snapshot.snapshot_json.clone(),
        },
    };
    let discard_access = delayed.prepare_session_access(&discard_request).unwrap();
    let mut winner = database.open();
    let reattached = winner.open_session(replay_request).unwrap();
    assert_eq!(reattached.session.session_id, recovered.session.session_id);

    for (request, access) in [
        (recover_request, recover_access),
        (discard_request, discard_access),
    ] {
        assert_eq!(
            delayed
                .open_session_checked(request, access)
                .unwrap_err()
                .code,
            ProjectLibraryErrorCode::ProjectAlreadyOpen
        );
        assert_eq!(
            load_head_and_stable(&winner.connection, &recovered.project.library_project_id)
                .unwrap(),
            (3, 1)
        );
        let snapshot =
            load_snapshot(&winner.connection, &recovered.project.library_project_id, 3).unwrap();
        assert_eq!(snapshot.snapshot_json, recovered.snapshot.snapshot_json);
    }
    let saved = winner
        .commit_session(CommitProjectLibrarySessionRequest {
            contract_version: 1,
            library_project_id: recovered.project.library_project_id.clone(),
            session_id: recovered.session.session_id.clone(),
            client_mutation_id: "winner-can-still-save".into(),
            expected_head_revision: 3,
            change: CommitProjectLibrarySessionChange::Save {
                save_kind: ProjectLibrarySaveKind::Autosave,
                source_revision: None,
                label: None,
                display_name: "lease test".into(),
                project_schema_version: 17,
                snapshot_json: "{\"schemaVersion\":17,\"value\":3}".into(),
            },
        })
        .unwrap();
    assert_eq!((saved.head_revision, saved.stable_revision), (4, 1));
}

#[test]
fn fresh_legacy_owner_requires_a_fence_acquired_for_this_request() {
    let database = Database::new();
    let mut original = database.open();
    let opened = original.open_session(create_request()).unwrap();
    drop(original);
    let mut delayed = database.open();
    let request = create_request();
    let access = delayed.prepare_session_access(&request).unwrap();
    assert!(!access.legacy_exclusive);
    delayed
        .connection
        .execute(
            "UPDATE project_sessions SET runtime_id='legacy_runtime' WHERE session_id=?1",
            [&opened.session.session_id],
        )
        .unwrap();
    assert_eq!(
        delayed
            .open_session_checked(request, access)
            .unwrap_err()
            .code,
        ProjectLibraryErrorCode::RecoveryDecisionRequired
    );
    assert_eq!(
        load_head_and_stable(&delayed.connection, &opened.project.library_project_id).unwrap(),
        (1, 1)
    );
}
