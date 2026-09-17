use crate::project_library::{
    CommitProjectLibrarySessionRequest, CommitProjectLibrarySessionValue,
    OpenProjectLibrarySessionRequest, OpenProjectLibrarySessionValue, ProjectLibraryQueryRequest,
    ProjectLibraryQueryValue, ProjectLibraryReply, ProjectLibraryRuntime,
};
use tauri::State;

#[tauri::command]
pub async fn query_project_library(
    state: State<'_, ProjectLibraryRuntime>,
    request: ProjectLibraryQueryRequest,
) -> Result<ProjectLibraryReply<ProjectLibraryQueryValue>, String> {
    let runtime = state.inner().clone();
    Ok(ProjectLibraryReply::from_result(
        runtime.query(request).await,
    ))
}

#[tauri::command]
pub async fn open_project_library_session(
    state: State<'_, ProjectLibraryRuntime>,
    request: OpenProjectLibrarySessionRequest,
) -> Result<ProjectLibraryReply<OpenProjectLibrarySessionValue>, String> {
    let runtime = state.inner().clone();
    Ok(ProjectLibraryReply::from_result(
        runtime.open_session(request).await,
    ))
}

#[tauri::command]
pub async fn commit_project_library_session(
    state: State<'_, ProjectLibraryRuntime>,
    request: CommitProjectLibrarySessionRequest,
) -> Result<ProjectLibraryReply<CommitProjectLibrarySessionValue>, String> {
    let runtime = state.inner().clone();
    Ok(ProjectLibraryReply::from_result(
        runtime.commit_session(request).await,
    ))
}
