use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[path = "libmpv_load.rs"]
mod loading;
#[path = "libmpv_runtime.rs"]
mod runtime;
#[path = "libmpv_subtitles.rs"]
mod subtitles;
use subtitles::{DanmakuRequest, DanmakuResult};

const MAX_LIBMPV_SESSIONS: usize = 2;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibMpvRuntimeRequest {
    mpv_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibMpvRuntimeStatus {
    available: bool,
    library_path: Option<String>,
    client_api_version: Option<String>,
    message: String,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeVideoBounds {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    visible: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibMpvCreateSessionRequest {
    session_id: String,
    mpv_path: String,
    media_path: String,
    start_position_ms: Option<u64>,
    start_paused: Option<bool>,
    bounds: NativeVideoBounds,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibMpvControlRequest {
    session_id: String,
    action: String,
    media_path: Option<String>,
    position_ms: Option<u64>,
    playback_rate: Option<f64>,
    muted: Option<bool>,
    start_paused: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibMpvSessionIdRequest {
    session_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibMpvBoundsRequest {
    session_id: String,
    bounds: NativeVideoBounds,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibMpvTrackSummary {
    id: i64,
    track_type: String,
    title: Option<String>,
    language: Option<String>,
    codec: Option<String>,
    selected: bool,
    external: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibMpvSessionStatus {
    session_id: String,
    running: bool,
    load_revision: u64,
    load_state: loading::LoadState,
    playback_status: String,
    media_name: Option<String>,
    position_ms: u64,
    duration_ms: u64,
    tracks: Vec<LibMpvTrackSummary>,
    message: String,
    error: Option<String>,
}

#[tauri::command]
pub fn detect_libmpv_runtime(request: LibMpvRuntimeRequest) -> Result<LibMpvRuntimeStatus, String> {
    platform::detect_runtime(&request)
}

#[tauri::command]
pub fn set_libmpv_danmaku_track(request: DanmakuRequest) -> Result<DanmakuResult, String> {
    validate_session_id(&request.session_id)?;
    subtitles::validate(&request)?;
    platform::set_danmaku_track(request)
}

#[tauri::command]
pub fn create_libmpv_session(
    window: tauri::WebviewWindow,
    request: LibMpvCreateSessionRequest,
) -> Result<LibMpvSessionStatus, String> {
    validate_session_id(&request.session_id)?;
    validate_media_source(&request.media_path)?;
    validate_bounds(request.bounds)?;
    platform::create_session(window, request)
}

#[tauri::command]
pub fn control_libmpv_session(
    request: LibMpvControlRequest,
) -> Result<LibMpvSessionStatus, String> {
    validate_session_id(&request.session_id)?;
    platform::control_session(request)
}

#[tauri::command]
pub fn get_libmpv_session_status(
    request: LibMpvSessionIdRequest,
) -> Result<LibMpvSessionStatus, String> {
    validate_session_id(&request.session_id)?;
    platform::session_status(&request.session_id)
}

#[tauri::command]
pub fn set_libmpv_session_bounds(
    window: tauri::WebviewWindow,
    request: LibMpvBoundsRequest,
) -> Result<LibMpvSessionStatus, String> {
    validate_session_id(&request.session_id)?;
    validate_bounds(request.bounds)?;
    platform::set_session_bounds(window, request)
}

#[tauri::command]
pub fn destroy_libmpv_session(
    window: tauri::WebviewWindow,
    request: LibMpvSessionIdRequest,
) -> Result<LibMpvSessionStatus, String> {
    validate_session_id(&request.session_id)?;
    platform::destroy_session(window, &request.session_id)
}

fn validate_session_id(session_id: &str) -> Result<(), String> {
    let valid = !session_id.is_empty()
        && session_id.len() <= 64
        && session_id
            .bytes()
            .all(|value| value.is_ascii_alphanumeric() || matches!(value, b'-' | b'_'));
    if valid {
        Ok(())
    } else {
        Err("播放器会话 ID 无效。".to_string())
    }
}

fn validate_media_source(media_path: &str) -> Result<(), String> {
    if media_path.trim().is_empty() || media_path.contains('\0') {
        return Err("libmpv 播放需要有效的媒体地址。".to_string());
    }
    let source = media_path.trim();
    if source.to_ascii_lowercase().starts_with("https://")
        || source.to_ascii_lowercase().starts_with("http://")
    {
        return Ok(());
    }
    crate::local_media_path::ensure_local_media_path(source)?;
    let path = Path::new(source);
    if !path.is_absolute() || !path.is_file() {
        return Err("libmpv 播放地址必须是存在的绝对文件路径，或 HTTP(S) 地址。".to_string());
    }
    Ok(())
}

fn validate_bounds(bounds: NativeVideoBounds) -> Result<(), String> {
    if bounds.width <= 0 || bounds.height <= 0 || bounds.width > 16_384 || bounds.height > 16_384 {
        return Err("原生视频区域尺寸无效。".to_string());
    }
    Ok(())
}

fn resolve_libmpv_library_path(mpv_path: &str) -> Result<PathBuf, String> {
    runtime::resolve_library_path(mpv_path)
}

fn media_display_name(media_path: &str) -> Option<String> {
    if media_path.starts_with("http://") || media_path.starts_with("https://") {
        return media_path
            .split('?')
            .next()
            .and_then(|value| value.rsplit('/').next())
            .filter(|value| !value.is_empty())
            .map(str::to_string);
    }
    Path::new(media_path)
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
}

#[cfg(windows)]
mod platform {
    use super::*;
    use libloading::Library;
    use std::collections::HashMap;
    use std::ffi::{c_char, c_void, CStr, CString};
    use std::ptr::{null, null_mut};
    use std::sync::{mpsc, Arc, Mutex, OnceLock};
    use std::time::Duration;
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::SetFocus;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, GetParent, RegisterClassW, SetWindowPos,
        ShowWindow, HTTRANSPARENT, MA_NOACTIVATE, SWP_NOACTIVATE, SWP_NOOWNERZORDER, SW_HIDE,
        SW_SHOWNOACTIVATE, WM_MOUSEACTIVATE, WM_NCHITTEST, WM_SETFOCUS, WNDCLASSW, WS_CHILD,
        WS_CLIPCHILDREN, WS_CLIPSIBLINGS, WS_DISABLED, WS_EX_NOACTIVATE, WS_EX_TRANSPARENT,
    };

    const MPV_FORMAT_FLAG: i32 = 3;
    const MPV_FORMAT_INT64: i32 = 4;
    const MPV_FORMAT_DOUBLE: i32 = 5;
    const VIDEO_HOST_CLASS_NAME: &str = "DanmakuStudioVideoHost";

    type MpvCreate = unsafe extern "C" fn() -> *mut c_void;
    type MpvInitialize = unsafe extern "C" fn(*mut c_void) -> i32;
    type MpvTerminateDestroy = unsafe extern "C" fn(*mut c_void);
    type MpvSetOptionString =
        unsafe extern "C" fn(*mut c_void, *const c_char, *const c_char) -> i32;
    type MpvCommand = unsafe extern "C" fn(*mut c_void, *const *const c_char) -> i32;
    type MpvGetProperty = unsafe extern "C" fn(*mut c_void, *const c_char, i32, *mut c_void) -> i32;
    type MpvGetPropertyString = unsafe extern "C" fn(*mut c_void, *const c_char) -> *mut c_char;
    type MpvFree = unsafe extern "C" fn(*mut c_void);
    type MpvErrorString = unsafe extern "C" fn(i32) -> *const c_char;
    type MpvClientApiVersion = unsafe extern "C" fn() -> u64;
    type MpvWaitEvent = unsafe extern "C" fn(*mut c_void, f64) -> *const MpvEvent;

    // ABI layouts from mpv/client.h. Copy event data before the next wait_event call.
    #[repr(C)]
    struct MpvEvent {
        event_id: i32,
        error: i32,
        reply_userdata: u64,
        data: *mut c_void,
    }
    #[repr(C)]
    struct MpvEndFile {
        reason: i32,
        error: i32,
        playlist_entry_id: i64,
        playlist_insert_id: i64,
        playlist_insert_num_entries: i32,
    }

    struct LibMpvApi {
        _library: Library,
        create: MpvCreate,
        initialize: MpvInitialize,
        terminate_destroy: MpvTerminateDestroy,
        set_option_string: MpvSetOptionString,
        command: MpvCommand,
        get_property: MpvGetProperty,
        get_property_string: MpvGetPropertyString,
        free: MpvFree,
        error_string: MpvErrorString,
        client_api_version: MpvClientApiVersion,
        wait_event: MpvWaitEvent,
    }

    struct LibMpvSession {
        session_id: String,
        api: Arc<LibMpvApi>,
        handle: usize,
        host_hwnd: isize,
        media_name: Option<String>,
        last_error: Option<String>,
        subtitles: subtitles::SubtitleTrack,
        load: loading::MediaLoad,
    }

    impl Drop for LibMpvSession {
        fn drop(&mut self) {
            if self.handle != 0 {
                unsafe { (self.api.terminate_destroy)(self.handle as *mut c_void) };
                self.handle = 0;
            }
        }
    }

    #[derive(Default)]
    struct LibMpvManager {
        sessions: HashMap<String, LibMpvSession>,
    }

    static MANAGER: OnceLock<Mutex<LibMpvManager>> = OnceLock::new();
    static VIDEO_HOST_CLASS: OnceLock<Result<(), String>> = OnceLock::new();

    pub(super) fn detect_runtime(
        request: &LibMpvRuntimeRequest,
    ) -> Result<LibMpvRuntimeStatus, String> {
        let library_path = resolve_libmpv_library_path(&request.mpv_path)?;
        let api = LibMpvApi::load(&library_path)?;
        let version = api.version_label();
        let handle = unsafe { (api.create)() } as usize;
        if handle == 0 {
            return Err("libmpv 无法创建初始化检测会话。".into());
        }
        let api = Arc::new(api);
        let _guard = HandleGuard {
            api: Arc::clone(&api),
            handle,
        };
        for (name, value) in [
            ("config", "no"),
            ("terminal", "no"),
            ("vo", "null"),
            ("ao", "null"),
            ("idle", "yes"),
        ] {
            api.set_option(handle, name, value)?;
        }
        for (name, value) in embedded_input_options() {
            api.set_option(handle, name, value)?;
        }
        api.check(
            unsafe { (api.initialize)(handle as *mut c_void) },
            "初始化 libmpv 运行库",
        )?;
        Ok(LibMpvRuntimeStatus {
            available: true,
            library_path: Some(library_path.to_string_lossy().into_owned()),
            client_api_version: Some(version.clone()),
            message: format!("libmpv {version} 已通过初始化；画面能力将在加载媒体后检查。"),
        })
    }

    pub(super) fn create_session(
        window: tauri::WebviewWindow,
        request: LibMpvCreateSessionRequest,
    ) -> Result<LibMpvSessionStatus, String> {
        let mut manager = manager().lock().map_err(|_| manager_lock_error())?;
        if manager.sessions.contains_key(&request.session_id) {
            return Err("同名 libmpv 会话已经存在，请先销毁旧会话。".to_string());
        }
        if manager.sessions.len() >= MAX_LIBMPV_SESSIONS {
            return Err(format!(
                "libmpv 同时最多允许 {MAX_LIBMPV_SESSIONS} 个会话。"
            ));
        }

        let library_path = resolve_libmpv_library_path(&request.mpv_path)?;
        let api = Arc::new(LibMpvApi::load(&library_path)?);
        let host_hwnd = create_video_host(&window, request.bounds)?;
        let result = LibMpvSession::create(api, host_hwnd, &request);
        let session = match result {
            Ok(session) => session,
            Err(error) => {
                destroy_video_host(&window, host_hwnd)?;
                return Err(error);
            }
        };
        let session_id = request.session_id.clone();
        manager.sessions.insert(session_id.clone(), session);
        status_for_session(
            manager
                .sessions
                .get(&session_id)
                .ok_or_else(|| "libmpv 会话创建后未能登记。".to_string())?,
        )
    }

    pub(super) fn control_session(
        request: LibMpvControlRequest,
    ) -> Result<LibMpvSessionStatus, String> {
        let mut manager = manager().lock().map_err(|_| manager_lock_error())?;
        let session = manager
            .sessions
            .get_mut(&request.session_id)
            .ok_or_else(|| "libmpv 会话不存在。".to_string())?;
        session.process_events();
        let command_result = match request.action.as_str() {
            "load" => {
                let media_path = request
                    .media_path
                    .as_deref()
                    .ok_or_else(|| "libmpv load 缺少媒体地址。".to_string())?;
                validate_media_source(media_path)?;
                let backend = SubtitleSessionBackend {
                    api: &session.api,
                    handle: session.handle,
                    ready: session.load.ready(),
                };
                session.subtitles.clear_for_media_change(&backend)?;
                session.load.begin();
                session.last_error = None;
                let result = load_media(
                    &session.api,
                    session.handle,
                    media_path,
                    request.position_ms,
                    request.start_paused.unwrap_or(true),
                )
                .and_then(|()| {
                    session
                        .load
                        .bind_entry(session.api.get_i64(session.handle, "playlist/0/id"))
                });
                if result.is_ok() {
                    session.media_name = media_display_name(media_path);
                } else {
                    session.load.fail();
                }
                result
            }
            "play" => session.api.command(session.handle, &["set", "pause", "no"]),
            "pause" => session
                .api
                .command(session.handle, &["set", "pause", "yes"]),
            "seek" => {
                let position_ms = request
                    .position_ms
                    .ok_or_else(|| "libmpv seek 缺少目标时间。".to_string())?;
                if session.load.state == loading::LoadState::Loading {
                    session.load.pending_seek = Some(position_ms);
                    Ok(())
                } else {
                    session.seek(position_ms)
                }
            }
            "setPlaybackRate" => {
                let rate = request
                    .playback_rate
                    .filter(|value| value.is_finite() && *value > 0.0 && *value <= 4.0)
                    .ok_or_else(|| "libmpv 播放倍率必须在 0 到 4 之间。".to_string())?;
                let rate_text = format!("{rate:.4}");
                session
                    .api
                    .command(session.handle, &["set", "speed", &rate_text])
            }
            "setMuted" => {
                let muted = request
                    .muted
                    .ok_or_else(|| "libmpv 静音命令缺少目标状态。".to_string())?;
                session
                    .api
                    .command(session.handle, &["set", "mute", mpv_boolean(muted)])
            }
            _ => Err(format!("未知 libmpv 控制动作：{}", request.action)),
        };
        if let Err(error) = command_result {
            session.last_error = Some(error.clone());
            return Err(error);
        }
        session.last_error = None;
        session.process_events();
        status_for_session(session)
    }

    pub(super) fn session_status(session_id: &str) -> Result<LibMpvSessionStatus, String> {
        let mut manager = manager().lock().map_err(|_| manager_lock_error())?;
        let session = manager
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| "libmpv 会话不存在。".to_string())?;
        session.process_events();
        status_for_session(session)
    }

    pub(super) fn set_danmaku_track(request: DanmakuRequest) -> Result<DanmakuResult, String> {
        let mut manager = manager().lock().map_err(|_| manager_lock_error())?;
        let session = manager
            .sessions
            .get_mut(&request.session_id)
            .ok_or_else(|| "libmpv 会话不存在。".to_string())?;
        session.process_events();
        let backend = SubtitleSessionBackend {
            api: &session.api,
            handle: session.handle,
            ready: session.load.ready(),
        };
        session.subtitles.set(request, &backend)
    }

    struct SubtitleSessionBackend<'a> {
        api: &'a LibMpvApi,
        handle: usize,
        ready: bool,
    }
    impl subtitles::SubtitleBackend for SubtitleSessionBackend<'_> {
        fn command(&self, args: &[&str]) -> Result<(), String> {
            self.api.command(self.handle, args)
        }
        fn selected_subtitle(&self) -> String {
            self.api
                .get_string(self.handle, "sid")
                .unwrap_or_else(|| "no".into())
        }
        fn media_ready(&self) -> bool {
            self.ready
        }
        fn track_for_file(&self, path: &str) -> Option<i64> {
            let count = self
                .api
                .get_i64(self.handle, "track-list/count")
                .unwrap_or(0)
                .clamp(0, 256);
            (0..count).find_map(|index| {
                let prefix = format!("track-list/{index}");
                let filename = self
                    .api
                    .get_string(self.handle, &format!("{prefix}/external-filename"))?;
                (Path::new(&filename) == Path::new(path))
                    .then(|| self.api.get_i64(self.handle, &format!("{prefix}/id")))
                    .flatten()
            })
        }
    }

    pub(super) fn set_session_bounds(
        window: tauri::WebviewWindow,
        request: LibMpvBoundsRequest,
    ) -> Result<LibMpvSessionStatus, String> {
        let manager = manager().lock().map_err(|_| manager_lock_error())?;
        let session = manager
            .sessions
            .get(&request.session_id)
            .ok_or_else(|| "libmpv 会话不存在。".to_string())?;
        update_video_host(&window, session.host_hwnd, request.bounds)?;
        status_for_session(session)
    }

    pub(super) fn destroy_session(
        window: tauri::WebviewWindow,
        session_id: &str,
    ) -> Result<LibMpvSessionStatus, String> {
        let session = {
            let mut manager = manager().lock().map_err(|_| manager_lock_error())?;
            manager
                .sessions
                .remove(session_id)
                .ok_or_else(|| "libmpv 会话不存在。".to_string())?
        };
        let host_hwnd = session.host_hwnd;
        let media_name = session.media_name.clone();
        drop(session);
        destroy_video_host(&window, host_hwnd)?;
        Ok(LibMpvSessionStatus {
            session_id: session_id.to_string(),
            running: false,
            load_revision: 0,
            load_state: loading::LoadState::Idle,
            playback_status: "stopped".to_string(),
            media_name,
            position_ms: 0,
            duration_ms: 0,
            tracks: Vec::new(),
            message: "libmpv 会话已销毁。".to_string(),
            error: None,
        })
    }

    impl LibMpvApi {
        fn load(path: &Path) -> Result<Self, String> {
            runtime::verify_architecture(path)?;
            use windows_sys::Win32::System::LibraryLoader::{
                LOAD_LIBRARY_SEARCH_DEFAULT_DIRS, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR,
            };
            let library: Library = unsafe {
                libloading::os::windows::Library::load_with_flags(
                    path,
                    LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS,
                )
            }
            .map(Library::from)
            .map_err(|error| format!("加载 libmpv 失败：{error}"))?;
            unsafe {
                let create = load_symbol(&library, b"mpv_create\0")?;
                let initialize = load_symbol(&library, b"mpv_initialize\0")?;
                let terminate_destroy = load_symbol(&library, b"mpv_terminate_destroy\0")?;
                let set_option_string = load_symbol(&library, b"mpv_set_option_string\0")?;
                let command = load_symbol(&library, b"mpv_command\0")?;
                let get_property = load_symbol(&library, b"mpv_get_property\0")?;
                let get_property_string = load_symbol(&library, b"mpv_get_property_string\0")?;
                let free = load_symbol(&library, b"mpv_free\0")?;
                let error_string = load_symbol(&library, b"mpv_error_string\0")?;
                let client_api_version = load_symbol(&library, b"mpv_client_api_version\0")?;
                let wait_event = load_symbol(&library, b"mpv_wait_event\0")?;
                let client_api_version: MpvClientApiVersion = client_api_version;
                if client_api_version() < ((1 << 16) | 108) {
                    return Err(
                        "libmpv 客户端 API 太旧，无法安全识别媒体加载，请更新运行库。".into(),
                    );
                }
                Ok(Self {
                    _library: library,
                    create,
                    initialize,
                    terminate_destroy,
                    set_option_string,
                    command,
                    get_property,
                    get_property_string,
                    free,
                    error_string,
                    client_api_version,
                    wait_event,
                })
            }
        }

        fn version_label(&self) -> String {
            let version = unsafe { (self.client_api_version)() };
            format!("{}.{}", version >> 16, version & 0xffff)
        }

        fn set_option(&self, handle: usize, name: &str, value: &str) -> Result<(), String> {
            let name = c_string(name)?;
            let value = c_string(value)?;
            let result = unsafe {
                (self.set_option_string)(handle as *mut c_void, name.as_ptr(), value.as_ptr())
            };
            self.check(result, "设置 libmpv 选项")
        }

        fn command(&self, handle: usize, values: &[&str]) -> Result<(), String> {
            let values = values
                .iter()
                .map(|value| c_string(value))
                .collect::<Result<Vec<_>, _>>()?;
            let mut pointers = values
                .iter()
                .map(|value| value.as_ptr())
                .collect::<Vec<_>>();
            pointers.push(null());
            let result = unsafe { (self.command)(handle as *mut c_void, pointers.as_ptr()) };
            self.check(result, "执行 libmpv 命令")
        }

        fn get_double(&self, handle: usize, name: &str) -> Option<f64> {
            let name = c_string(name).ok()?;
            let mut value = 0.0_f64;
            let result = unsafe {
                (self.get_property)(
                    handle as *mut c_void,
                    name.as_ptr(),
                    MPV_FORMAT_DOUBLE,
                    (&mut value as *mut f64).cast(),
                )
            };
            (result >= 0 && value.is_finite()).then_some(value)
        }

        fn get_i64(&self, handle: usize, name: &str) -> Option<i64> {
            let name = c_string(name).ok()?;
            let mut value = 0_i64;
            let result = unsafe {
                (self.get_property)(
                    handle as *mut c_void,
                    name.as_ptr(),
                    MPV_FORMAT_INT64,
                    (&mut value as *mut i64).cast(),
                )
            };
            (result >= 0).then_some(value)
        }

        fn get_flag(&self, handle: usize, name: &str) -> Option<bool> {
            let name = c_string(name).ok()?;
            let mut value = 0_i32;
            let result = unsafe {
                (self.get_property)(
                    handle as *mut c_void,
                    name.as_ptr(),
                    MPV_FORMAT_FLAG,
                    (&mut value as *mut i32).cast(),
                )
            };
            (result >= 0).then_some(value != 0)
        }

        fn get_string(&self, handle: usize, name: &str) -> Option<String> {
            let name = c_string(name).ok()?;
            let pointer =
                unsafe { (self.get_property_string)(handle as *mut c_void, name.as_ptr()) };
            if pointer.is_null() {
                return None;
            }
            let value = unsafe { CStr::from_ptr(pointer) }
                .to_string_lossy()
                .into_owned();
            unsafe { (self.free)(pointer.cast()) };
            Some(value)
        }

        fn check(&self, result: i32, action: &str) -> Result<(), String> {
            if result >= 0 {
                return Ok(());
            }
            let pointer = unsafe { (self.error_string)(result) };
            let detail = if pointer.is_null() {
                format!("错误码 {result}")
            } else {
                unsafe { CStr::from_ptr(pointer) }
                    .to_string_lossy()
                    .into_owned()
            };
            Err(format!("{action}失败：{detail}"))
        }
    }

    impl LibMpvSession {
        fn create(
            api: Arc<LibMpvApi>,
            host_hwnd: isize,
            request: &LibMpvCreateSessionRequest,
        ) -> Result<Self, String> {
            let handle = unsafe { (api.create)() } as usize;
            if handle == 0 {
                return Err("libmpv 无法创建播放 handle。".to_string());
            }
            let mut guard = HandleGuard {
                api: Arc::clone(&api),
                handle,
            };
            let wid = (host_hwnd as usize).to_string();
            for (name, value) in embedded_mpv_options(&wid) {
                api.set_option(handle, name, value)?;
            }
            let initialize_result = unsafe { (api.initialize)(handle as *mut c_void) };
            api.check(initialize_result, "初始化 libmpv")?;
            load_media(
                &api,
                handle,
                &request.media_path,
                request.start_position_ms,
                request.start_paused.unwrap_or(true),
            )?;
            let mut load = loading::MediaLoad::default();
            load.begin();
            load.bind_entry(api.get_i64(handle, "playlist/0/id"))?;
            guard.handle = 0;
            Ok(Self {
                session_id: request.session_id.clone(),
                api,
                handle,
                host_hwnd,
                media_name: media_display_name(&request.media_path),
                last_error: None,
                subtitles: subtitles::SubtitleTrack::default(),
                load,
            })
        }

        fn seek(&self, position_ms: u64) -> Result<(), String> {
            let seconds = format!("{:.3}", position_ms as f64 / 1_000.0);
            self.api
                .command(self.handle, &["seek", &seconds, "absolute+exact"])
        }

        fn process_events(&mut self) {
            // Reuse the existing status polling. Never wait while holding the manager lock.
            for _ in 0..256 {
                let event = unsafe { (self.api.wait_event)(self.handle as *mut c_void, 0.0) };
                if event.is_null() {
                    break;
                }
                let event = unsafe { &*event };
                match event.event_id {
                    0 => break,
                    6 if !event.data.is_null() => {
                        self.load.started(unsafe { *event.data.cast::<i64>() })
                    }
                    8 => self.load.loaded(),
                    7 if !event.data.is_null() => {
                        let end = unsafe { &*event.data.cast::<MpvEndFile>() };
                        if self.load.ended(
                            end.playlist_entry_id,
                            end.reason,
                            end.playlist_insert_id,
                        ) {
                            self.last_error = Some(if end.error < 0 {
                                self.api.check(end.error, "载入媒体").unwrap_err()
                            } else {
                                "媒体在加载完成前已停止。".into()
                            });
                        }
                    }
                    1 | 24 => {
                        self.load.fail();
                        self.last_error =
                            Some("播放器已退出或事件队列溢出，请重新加载媒体。".into());
                    }
                    _ => {}
                }
            }
            if self.load.ready() {
                if let Some(position) = self.load.pending_seek.take() {
                    if let Err(error) = self.seek(position) {
                        self.load.fail();
                        self.last_error = Some(error);
                        return;
                    }
                }
                let backend = SubtitleSessionBackend {
                    api: &self.api,
                    handle: self.handle,
                    ready: true,
                };
                if let Err(error) = self.subtitles.flush(&backend) {
                    self.last_error = Some(error);
                }
            }
        }
    }

    pub(super) fn embedded_mpv_options<'a>(wid: &'a str) -> Vec<(&'static str, &'a str)> {
        let mut options = vec![
            ("config", "no"),
            ("terminal", "no"),
            ("input-default-bindings", "no"),
            ("osc", "no"),
            ("idle", "yes"),
            ("keep-open", "yes"),
            ("vo", "gpu-next"),
            ("hwdec", "auto-safe"),
            ("wid", wid),
        ];
        options.extend(embedded_input_options());
        options
    }

    fn embedded_input_options() -> [(&'static str, &'static str); 4] {
        [
            ("input-cursor", "no"),
            ("input-cursor-passthrough", "yes"),
            ("input-vo-keyboard", "no"),
            ("input-builtin-drag-and-drop", "no"),
        ]
    }

    fn load_media(
        api: &LibMpvApi,
        handle: usize,
        media_path: &str,
        start_position_ms: Option<u64>,
        start_paused: bool,
    ) -> Result<(), String> {
        // `loadfile` starts asynchronous demuxing. Issuing an exact `seek`
        // immediately afterwards races large/remote files and libmpv returns
        // the unhelpful "error running command". Supplying the file-local
        // `start` option makes the initial position part of the load itself.
        api.command(handle, &["set", "pause", "yes"])
            .map_err(|error| format!("准备载入媒体失败：{error}"))?;
        let command = build_loadfile_command(media_path, start_position_ms);
        let arguments = command.iter().map(String::as_str).collect::<Vec<_>>();
        if start_position_ms.is_some_and(|value| value > 0) {
            api.command(handle, &arguments)
                .map_err(|error| format!("载入媒体并定位到初始位置失败：{error}"))?;
        } else {
            api.command(handle, &arguments)
                .map_err(|error| format!("载入媒体失败：{error}"))?;
        }
        if !start_paused {
            api.command(handle, &["set", "pause", "no"])
                .map_err(|error| format!("载入后开始播放失败：{error}"))?;
        }
        Ok(())
    }

    pub(super) fn build_loadfile_command(
        media_path: &str,
        start_position_ms: Option<u64>,
    ) -> Vec<String> {
        let mut command = vec![
            "loadfile".to_string(),
            media_path.trim().to_string(),
            "replace".to_string(),
        ];
        if let Some(position_ms) = start_position_ms.filter(|value| *value > 0) {
            // mpv 0.38+ inserts the playlist index before per-file options.
            // `-1` means "use the normal insertion position"; without it the
            // `start=...` option is parsed as an invalid index and loadfile
            // fails with the opaque "error running command".
            command.push("-1".to_string());
            command.push(format!("start={:.3}", position_ms as f64 / 1_000.0));
        }
        command
    }

    #[cfg(test)]
    pub(super) fn run_headless_playback_smoke(
        mpv_path: &str,
        media_path: &str,
    ) -> Result<(u64, u64), String> {
        let library_path = resolve_libmpv_library_path(mpv_path)?;
        let api = Arc::new(LibMpvApi::load(&library_path)?);
        let handle = unsafe { (api.create)() } as usize;
        if handle == 0 {
            return Err("libmpv 无法创建测试 handle。".to_string());
        }
        let guard = HandleGuard {
            api: Arc::clone(&api),
            handle,
        };
        for (name, value) in [
            ("config", "no"),
            ("terminal", "no"),
            ("idle", "yes"),
            ("keep-open", "yes"),
            ("vo", "null"),
            ("ao", "null"),
        ] {
            api.set_option(handle, name, value)?;
        }
        for (name, value) in embedded_input_options() {
            api.set_option(handle, name, value)?;
        }
        let initialize_result = unsafe { (api.initialize)(handle as *mut c_void) };
        api.check(initialize_result, "初始化无界面 libmpv 测试")?;
        load_media(&api, handle, media_path, Some(1_000), false)?;
        let mut first_position_ms = None;
        let mut last_position_ms = 0;
        for _ in 0..100 {
            std::thread::sleep(Duration::from_millis(40));
            let position_ms =
                seconds_to_milliseconds(api.get_double(handle, "time-pos").unwrap_or(0.0));
            if position_ms > 0 {
                first_position_ms.get_or_insert(position_ms);
                last_position_ms = position_ms;
            }
            if first_position_ms.is_some_and(|first| last_position_ms >= first + 250) {
                break;
            }
        }
        drop(guard);
        let first_position_ms =
            first_position_ms.ok_or_else(|| "真实媒体载入后没有产生播放位置。".to_string())?;
        if last_position_ms < first_position_ms + 250 {
            return Err(format!(
                "真实媒体已载入但播放位置没有前进：{first_position_ms} -> {last_position_ms} ms。"
            ));
        }
        Ok((first_position_ms, last_position_ms))
    }

    struct HandleGuard {
        api: Arc<LibMpvApi>,
        handle: usize,
    }

    impl Drop for HandleGuard {
        fn drop(&mut self) {
            if self.handle != 0 {
                unsafe { (self.api.terminate_destroy)(self.handle as *mut c_void) };
            }
        }
    }

    fn status_for_session(session: &LibMpvSession) -> Result<LibMpvSessionStatus, String> {
        let position_ms = seconds_to_milliseconds(
            session
                .api
                .get_double(session.handle, "time-pos")
                .unwrap_or(0.0),
        );
        let duration_ms = if session.load.ready() {
            seconds_to_milliseconds(
                session
                    .api
                    .get_double(session.handle, "duration")
                    .unwrap_or(0.0),
            )
        } else {
            0
        };
        let idle = session
            .api
            .get_flag(session.handle, "idle-active")
            .unwrap_or(false);
        let paused = session
            .api
            .get_flag(session.handle, "pause")
            .unwrap_or(true);
        let playback_status = if idle {
            "stopped"
        } else if paused {
            "paused"
        } else {
            "playing"
        };
        Ok(LibMpvSessionStatus {
            session_id: session.session_id.clone(),
            running: true,
            load_revision: session.load.revision,
            load_state: session.load.state,
            playback_status: playback_status.to_string(),
            media_name: session.media_name.clone(),
            position_ms,
            duration_ms,
            tracks: if session.load.ready() {
                read_tracks(session)
            } else {
                Vec::new()
            },
            message: "libmpv 会话可用。".to_string(),
            error: session.last_error.clone(),
        })
    }

    fn read_tracks(session: &LibMpvSession) -> Vec<LibMpvTrackSummary> {
        let count = session
            .api
            .get_i64(session.handle, "track-list/count")
            .unwrap_or(0)
            .clamp(0, 128);
        (0..count)
            .map(|index| {
                let prefix = format!("track-list/{index}");
                LibMpvTrackSummary {
                    id: session
                        .api
                        .get_i64(session.handle, &format!("{prefix}/id"))
                        .unwrap_or(index),
                    track_type: session
                        .api
                        .get_string(session.handle, &format!("{prefix}/type"))
                        .unwrap_or_else(|| "unknown".to_string()),
                    title: session
                        .api
                        .get_string(session.handle, &format!("{prefix}/title")),
                    language: session
                        .api
                        .get_string(session.handle, &format!("{prefix}/lang")),
                    codec: session
                        .api
                        .get_string(session.handle, &format!("{prefix}/codec")),
                    selected: session
                        .api
                        .get_flag(session.handle, &format!("{prefix}/selected"))
                        .unwrap_or(false),
                    external: session
                        .api
                        .get_flag(session.handle, &format!("{prefix}/external"))
                        .unwrap_or(false),
                }
            })
            .collect()
    }

    fn seconds_to_milliseconds(seconds: f64) -> u64 {
        if !seconds.is_finite() || seconds <= 0.0 {
            return 0;
        }
        (seconds * 1_000.0).round().clamp(0.0, u64::MAX as f64) as u64
    }

    unsafe fn load_symbol<T: Copy>(library: &Library, name: &[u8]) -> Result<T, String> {
        unsafe { library.get::<T>(name) }
            .map(|symbol| *symbol)
            .map_err(|error| {
                let name = String::from_utf8_lossy(name)
                    .trim_end_matches('\0')
                    .to_string();
                format!("libmpv 缺少 {name}：{error}")
            })
    }

    fn c_string(value: &str) -> Result<CString, String> {
        CString::new(value).map_err(|_| "libmpv 参数包含非法空字符。".to_string())
    }

    fn manager() -> &'static Mutex<LibMpvManager> {
        MANAGER.get_or_init(|| Mutex::new(LibMpvManager::default()))
    }

    fn manager_lock_error() -> String {
        "libmpv 会话状态锁已损坏。".to_string()
    }

    fn create_video_host(
        window: &tauri::WebviewWindow,
        bounds: NativeVideoBounds,
    ) -> Result<isize, String> {
        let parent = window
            .hwnd()
            .map_err(|error| format!("无法取得应用窗口句柄：{error}"))?
            .0 as isize;
        run_on_main_thread(window, move || unsafe {
            create_video_host_inner(parent, bounds)
        })
    }

    fn update_video_host(
        window: &tauri::WebviewWindow,
        host_hwnd: isize,
        bounds: NativeVideoBounds,
    ) -> Result<(), String> {
        run_on_main_thread(window, move || unsafe {
            apply_video_host_bounds(host_hwnd, bounds)
        })
    }

    unsafe fn apply_video_host_bounds(
        host_hwnd: isize,
        bounds: NativeVideoBounds,
    ) -> Result<(), String> {
        unsafe {
            let positioned = SetWindowPos(
                host_hwnd as *mut c_void,
                null_mut(),
                bounds.x,
                bounds.y,
                bounds.width,
                bounds.height,
                // The WebView is an opaque sibling child window. Keep the video host at the
                // top of the sibling Z-order or the DOM placeholder will cover decoded frames.
                SWP_NOACTIVATE | SWP_NOOWNERZORDER,
            );
            if positioned == 0 {
                return Err("调整原生视频区域失败。".to_string());
            }
            ShowWindow(
                host_hwnd as *mut c_void,
                if bounds.visible {
                    SW_SHOWNOACTIVATE
                } else {
                    SW_HIDE
                },
            );
            Ok(())
        }
    }

    fn destroy_video_host(window: &tauri::WebviewWindow, host_hwnd: isize) -> Result<(), String> {
        run_on_main_thread(window, move || unsafe {
            if DestroyWindow(host_hwnd as *mut c_void) == 0 {
                return Err("销毁原生视频区域失败。".to_string());
            }
            Ok(())
        })
    }

    fn run_on_main_thread<T, F>(window: &tauri::WebviewWindow, task: F) -> Result<T, String>
    where
        T: Send + 'static,
        F: FnOnce() -> Result<T, String> + Send + 'static,
    {
        let (sender, receiver) = mpsc::sync_channel(1);
        window
            .run_on_main_thread(move || {
                let _ = sender.send(task());
            })
            .map_err(|error| format!("调度原生视频窗口操作失败：{error}"))?;
        receiver
            .recv_timeout(Duration::from_secs(5))
            .map_err(|_| "原生视频窗口操作超时。".to_string())?
    }

    unsafe fn create_video_host_inner(
        parent: isize,
        bounds: NativeVideoBounds,
    ) -> Result<isize, String> {
        let module = unsafe { GetModuleHandleW(null()) };
        if module.is_null() {
            return Err("无法取得应用模块句柄。".to_string());
        }
        ensure_video_host_class(module)?;
        let class_name = wide_string(VIDEO_HOST_CLASS_NAME);
        // mpv creates a child HWND on its own thread. Host-only hit testing and
        // WM_SETFOCUS handling cannot intercept that descendant's input. Disabling
        // the render-only ancestor prevents the entire subtree from taking focus.
        let styles = WS_CHILD | WS_CLIPCHILDREN | WS_CLIPSIBLINGS | WS_DISABLED;
        let extended_styles = WS_EX_NOACTIVATE | WS_EX_TRANSPARENT;
        let hwnd = unsafe {
            CreateWindowExW(
                extended_styles,
                class_name.as_ptr(),
                null(),
                styles,
                bounds.x,
                bounds.y,
                bounds.width,
                bounds.height,
                parent as *mut c_void,
                null_mut(),
                module,
                null(),
            )
        };
        if hwnd.is_null() {
            return Err("创建原生视频区域失败。".to_string());
        }
        // Initial geometry is already cached by the frontend. Establish sibling
        // Z-order here too; otherwise no resize may arrive to raise this host.
        if let Err(error) = unsafe { apply_video_host_bounds(hwnd as isize, bounds) } {
            unsafe {
                DestroyWindow(hwnd);
            }
            return Err(error);
        }
        Ok(hwnd as isize)
    }

    fn ensure_video_host_class(module: *mut c_void) -> Result<(), String> {
        VIDEO_HOST_CLASS
            .get_or_init(|| unsafe { register_video_host_class(module) })
            .clone()
    }

    unsafe fn register_video_host_class(module: *mut c_void) -> Result<(), String> {
        let class_name = wide_string(VIDEO_HOST_CLASS_NAME);
        let window_class = WNDCLASSW {
            style: 0,
            lpfnWndProc: Some(video_host_window_proc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: module,
            hIcon: null_mut(),
            hCursor: null_mut(),
            hbrBackground: null_mut(),
            lpszMenuName: null(),
            lpszClassName: class_name.as_ptr(),
        };
        if unsafe { RegisterClassW(&window_class) } == 0 {
            return Err(format!(
                "注册原生视频窗口失败：{}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(())
    }

    unsafe extern "system" fn video_host_window_proc(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if let Some(result) = video_host_input_result(message) {
            return result;
        }
        if message == WM_SETFOCUS {
            let previous_focus = wparam as HWND;
            let destination = if !previous_focus.is_null() && previous_focus != hwnd {
                previous_focus
            } else {
                unsafe { GetParent(hwnd) }
            };
            if !destination.is_null() {
                unsafe { SetFocus(destination) };
            }
            return 0;
        }
        unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
    }

    pub(super) fn video_host_input_result(message: u32) -> Option<LRESULT> {
        match message {
            WM_NCHITTEST => Some(HTTRANSPARENT as LRESULT),
            WM_MOUSEACTIVATE => Some(MA_NOACTIVATE as LRESULT),
            _ => None,
        }
    }

    #[cfg(test)]
    mod focus_tests {
        use super::*;
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetFocus, IsWindowEnabled};
        use windows_sys::Win32::UI::WindowsAndMessaging::WS_OVERLAPPED;

        #[test]
        #[ignore = "Requires DANMAKU_LIBMPV_PATH and DANMAKU_LIBMPV_MEDIA; exercises real GPU child windows"]
        fn real_embedded_renderer_plays_without_taking_focus() {
            use windows_sys::Win32::UI::WindowsAndMessaging::{
                DispatchMessageW, FindWindowExW, PeekMessageW, TranslateMessage, MSG, PM_REMOVE,
            };
            unsafe {
                let class = wide_string("STATIC");
                let module = GetModuleHandleW(null());
                let parent = CreateWindowExW(
                    0,
                    class.as_ptr(),
                    null(),
                    WS_OVERLAPPED,
                    0,
                    0,
                    640,
                    360,
                    null_mut(),
                    null_mut(),
                    module,
                    null(),
                );
                let editor = CreateWindowExW(
                    0,
                    class.as_ptr(),
                    null(),
                    WS_CHILD,
                    0,
                    0,
                    32,
                    32,
                    parent,
                    null_mut(),
                    module,
                    null(),
                );
                assert!(!parent.is_null() && !editor.is_null());
                let bounds = NativeVideoBounds {
                    x: 0,
                    y: 0,
                    width: 320,
                    height: 180,
                    visible: true,
                };
                let host = create_video_host_inner(parent as isize, bounds).unwrap();
                SetFocus(editor);
                let (sender, receiver) = mpsc::channel();
                let worker = std::thread::spawn(move || {
                    let result = (|| -> Result<(u64, u64), String> {
                        let path = resolve_libmpv_library_path(
                            &std::env::var("DANMAKU_LIBMPV_PATH").unwrap(),
                        )?;
                        let api = Arc::new(LibMpvApi::load(&path)?);
                        let handle = (api.create)() as usize;
                        if handle == 0 {
                            return Err("mpv_create failed".into());
                        }
                        let guard = HandleGuard {
                            api: api.clone(),
                            handle,
                        };
                        let wid = host.to_string();
                        for (name, value) in embedded_mpv_options(&wid) {
                            api.set_option(handle, name, value)?;
                        }
                        api.set_option(handle, "ao", "null")?;
                        api.check((api.initialize)(handle as *mut c_void), "initialize")?;
                        load_media(
                            &api,
                            handle,
                            &std::env::var("DANMAKU_LIBMPV_MEDIA").unwrap(),
                            Some(1000),
                            false,
                        )?;
                        let mut first = None;
                        let mut last = 0;
                        let deadline = std::time::Instant::now() + Duration::from_secs(15);
                        while std::time::Instant::now() < deadline {
                            (api.wait_event)(handle as *mut c_void, 0.02);
                            last = seconds_to_milliseconds(
                                api.get_double(handle, "time-pos").unwrap_or(0.0),
                            );
                            if api.get_flag(handle, "vo-configured") == Some(true) && last > 0 {
                                first.get_or_insert(last);
                            }
                            if first.is_some_and(|start| last >= start + 300) {
                                break;
                            }
                        }
                        // Let the parent inspect the live mpv child before destroying the handle.
                        sender.send(()).unwrap();
                        std::thread::sleep(Duration::from_millis(300));
                        drop(guard);
                        Ok((first.unwrap_or(0), last))
                    })();
                    result
                });
                let deadline = std::time::Instant::now() + Duration::from_secs(20);
                let mut renderer_seen = false;
                let mut focus_preserved = true;
                let mut focus_changes = Vec::new();
                while !worker.is_finished() && std::time::Instant::now() < deadline {
                    let mut message: MSG = std::mem::zeroed();
                    while PeekMessageW(&mut message, null_mut(), 0, 0, PM_REMOVE) != 0 {
                        TranslateMessage(&message);
                        DispatchMessageW(&message);
                    }
                    if GetFocus() != editor && focus_changes.last() != Some(&(GetFocus() as isize))
                    {
                        focus_changes.push(GetFocus() as isize);
                    }
                    focus_preserved &= GetFocus() == editor;
                    if receiver.try_recv().is_ok() {
                        let child = FindWindowExW(
                            host as HWND,
                            null_mut(),
                            wide_string("mpv").as_ptr(),
                            null(),
                        );
                        renderer_seen = !child.is_null();
                        SetFocus(child);
                        focus_preserved &= GetFocus() == editor;
                        apply_video_host_bounds(
                            host,
                            NativeVideoBounds {
                                width: 400,
                                ..bounds
                            },
                        )
                        .unwrap();
                    }
                    std::thread::sleep(Duration::from_millis(5));
                }
                assert!(
                    worker.is_finished(),
                    "renderer did not finish within its deadline"
                );
                let result = worker.join().unwrap();
                DestroyWindow(parent);
                let (first, last) = result.unwrap();
                assert!(
                    first > 0 && last >= first + 300,
                    "real GPU playback must advance: {first} -> {last}"
                );
                assert!(renderer_seen, "real mpv child HWND must exist");
                assert!(focus_preserved, "create/load/resize/child focus must leave the editor focused; changes={focus_changes:?}, editor={editor:?}");
            }
        }

        #[test]
        fn embedded_descendant_cannot_take_editor_focus() {
            // mpv owns a second child HWND below our host. Test that child, not just
            // the host WndProc: its separate input handling must not bypass the host.
            unsafe {
                let class = wide_string("STATIC");
                let module = GetModuleHandleW(null());
                let parent = CreateWindowExW(
                    0,
                    class.as_ptr(),
                    null(),
                    WS_OVERLAPPED,
                    0,
                    0,
                    64,
                    64,
                    null_mut(),
                    null_mut(),
                    module,
                    null(),
                );
                assert!(!parent.is_null());
                let editor = CreateWindowExW(
                    0,
                    class.as_ptr(),
                    null(),
                    WS_CHILD,
                    0,
                    0,
                    32,
                    32,
                    parent,
                    null_mut(),
                    module,
                    null(),
                );
                let host = create_video_host_inner(
                    parent as isize,
                    NativeVideoBounds {
                        x: 0,
                        y: 0,
                        width: 32,
                        height: 32,
                        visible: false,
                    },
                )
                .unwrap() as HWND;
                let renderer = CreateWindowExW(
                    0,
                    class.as_ptr(),
                    null(),
                    WS_CHILD,
                    0,
                    0,
                    32,
                    32,
                    host,
                    null_mut(),
                    module,
                    null(),
                );
                SetFocus(editor);
                let before = GetFocus();
                SetFocus(renderer);
                let after = GetFocus();
                let enabled = IsWindowEnabled(host);
                DestroyWindow(parent);
                assert_eq!(before, editor, "the editor must own focus before rendering");
                assert_eq!(
                    after, editor,
                    "the renderer stole keyboard focus from the editor"
                );
                assert_eq!(
                    enabled, 0,
                    "render-only hosts must disable descendant input"
                );
            }
        }
    }

    fn wide_string(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(Some(0)).collect()
    }

    pub(super) fn mpv_boolean(value: bool) -> &'static str {
        if value {
            "yes"
        } else {
            "no"
        }
    }
}

#[cfg(not(windows))]
mod platform {
    use super::*;

    fn unsupported<T>() -> Result<T, String> {
        Err("libmpv 原生嵌入当前只支持 Windows 桌面版。".to_string())
    }

    pub(super) fn set_danmaku_track(_request: DanmakuRequest) -> Result<DanmakuResult, String> {
        unsupported()
    }

    pub(super) fn detect_runtime(
        _request: &LibMpvRuntimeRequest,
    ) -> Result<LibMpvRuntimeStatus, String> {
        unsupported()
    }

    pub(super) fn create_session(
        _window: tauri::WebviewWindow,
        _request: LibMpvCreateSessionRequest,
    ) -> Result<LibMpvSessionStatus, String> {
        unsupported()
    }

    pub(super) fn control_session(
        _request: LibMpvControlRequest,
    ) -> Result<LibMpvSessionStatus, String> {
        unsupported()
    }

    pub(super) fn session_status(_session_id: &str) -> Result<LibMpvSessionStatus, String> {
        unsupported()
    }

    pub(super) fn set_session_bounds(
        _window: tauri::WebviewWindow,
        _request: LibMpvBoundsRequest,
    ) -> Result<LibMpvSessionStatus, String> {
        unsupported()
    }

    pub(super) fn destroy_session(
        _window: tauri::WebviewWindow,
        _session_id: &str,
    ) -> Result<LibMpvSessionStatus, String> {
        unsupported()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn validates_session_ids_and_bounds() {
        assert!(validate_session_id("reference_preview-1").is_ok());
        assert!(validate_session_id("").is_err());
        assert!(validate_session_id("bad/session").is_err());
        assert!(validate_bounds(NativeVideoBounds {
            x: 0,
            y: 0,
            width: 640,
            height: 360,
            visible: true,
        })
        .is_ok());
        assert!(validate_bounds(NativeVideoBounds {
            x: 0,
            y: 0,
            width: 0,
            height: 360,
            visible: true,
        })
        .is_err());
    }

    #[test]
    fn accepts_https_session_media_but_rejects_arbitrary_non_file_sources() {
        assert!(
            validate_media_source("https://media.example.test/Videos/1/stream?api_key=secret")
                .is_ok()
        );
        assert!(validate_media_source("relative/video.mkv").is_err());
        assert!(validate_media_source("ftp://media.example.test/video.mkv").is_err());
    }

    #[test]
    fn resolves_only_known_libmpv_file_names_next_to_configured_mpv() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("danmaku-libmpv-{suffix}"));
        fs::create_dir_all(&root).unwrap();
        let mpv = root.join("mpv.exe");
        let library = root.join("mpv-2.dll");
        fs::write(&mpv, b"test").unwrap();
        fs::write(&library, b"test").unwrap();

        let resolved = resolve_libmpv_library_path(mpv.to_string_lossy().as_ref()).unwrap();
        assert_eq!(resolved, library.canonicalize().unwrap());

        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn builds_loadfile_options_in_the_mpv_0_38_argument_order() {
        assert_eq!(
            platform::build_loadfile_command(r"F:\media\episode.mkv", Some(12_800)),
            vec![
                "loadfile",
                r"F:\media\episode.mkv",
                "replace",
                "-1",
                "start=12.800"
            ]
        );
        assert_eq!(
            platform::build_loadfile_command(r"F:\media\episode.mkv", Some(0)),
            vec!["loadfile", r"F:\media\episode.mkv", "replace"]
        );
    }

    #[cfg(windows)]
    #[test]
    fn embedded_video_host_never_accepts_pointer_or_keyboard_input() {
        let options = platform::embedded_mpv_options("12345")
            .into_iter()
            .collect::<std::collections::HashMap<_, _>>();
        assert_eq!(options.get("input-cursor"), Some(&"no"));
        assert_eq!(options.get("input-cursor-passthrough"), Some(&"yes"));
        assert_eq!(options.get("input-vo-keyboard"), Some(&"no"));
        assert_eq!(options.get("input-builtin-drag-and-drop"), Some(&"no"));
        assert_eq!(options.get("wid"), Some(&"12345"));

        assert_eq!(
            platform::video_host_input_result(
                windows_sys::Win32::UI::WindowsAndMessaging::WM_NCHITTEST
            ),
            Some(
                windows_sys::Win32::UI::WindowsAndMessaging::HTTRANSPARENT
                    as windows_sys::Win32::Foundation::LRESULT
            )
        );
        assert_eq!(
            platform::video_host_input_result(
                windows_sys::Win32::UI::WindowsAndMessaging::WM_MOUSEACTIVATE
            ),
            Some(
                windows_sys::Win32::UI::WindowsAndMessaging::MA_NOACTIVATE
                    as windows_sys::Win32::Foundation::LRESULT
            )
        );
    }

    #[cfg(windows)]
    #[test]
    fn serializes_independent_session_audio_solo_as_mpv_boolean() {
        assert_eq!(platform::mpv_boolean(true), "yes");
        assert_eq!(platform::mpv_boolean(false), "no");
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "需要通过 DANMAKU_LIBMPV_PATH 和 DANMAKU_LIBMPV_MEDIA 指定本机真实运行库与媒体"]
    fn real_libmpv_load_and_play_position_advances() {
        let mpv_path = std::env::var("DANMAKU_LIBMPV_PATH").expect("DANMAKU_LIBMPV_PATH");
        let media_path = std::env::var("DANMAKU_LIBMPV_MEDIA").expect("DANMAKU_LIBMPV_MEDIA");
        let (first, last) =
            platform::run_headless_playback_smoke(&mpv_path, &media_path).expect("real playback");
        assert!(
            last >= first + 250,
            "playback must advance: {first} -> {last}"
        );
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "需要通过 DANMAKU_LIBMPV_PATH 和 DANMAKU_LIBMPV_MEDIA 指定本机真实运行库与媒体"]
    fn real_two_libmpv_handles_advance_concurrently() {
        let mpv_path = std::env::var("DANMAKU_LIBMPV_PATH").expect("DANMAKU_LIBMPV_PATH");
        let media_path = std::env::var("DANMAKU_LIBMPV_MEDIA").expect("DANMAKU_LIBMPV_MEDIA");
        let left_mpv_path = mpv_path.clone();
        let left_media_path = media_path.clone();
        let left = std::thread::spawn(move || {
            platform::run_headless_playback_smoke(&left_mpv_path, &left_media_path)
        });
        let right = std::thread::spawn(move || {
            platform::run_headless_playback_smoke(&mpv_path, &media_path)
        });
        for result in [
            left.join().expect("left smoke"),
            right.join().expect("right smoke"),
        ] {
            let (first, last) = result.expect("concurrent real playback");
            assert!(
                last >= first + 250,
                "concurrent playback must advance: {first} -> {last}"
            );
        }
    }
}
