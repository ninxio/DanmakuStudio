//! Persistent account owner. Secrets remain native; cancellation fences every disk mutation.
mod credential;
mod protocol;

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    sync::OnceLock,
};

#[derive(Debug)]
struct AuthError {
    needs_login: bool,
    message: String,
}
impl AuthError {
    fn other(message: &str) -> Self {
        Self {
            needs_login: false,
            message: message.into(),
        }
    }
    fn invalid() -> Self {
        Self::other("B 站登录响应不完整，请重新生成二维码或稍后重试。")
    }
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Account {
    mid: String,
    username: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    state: &'static str,
    account: Option<Account>,
    persisted: bool,
    last_verified_at: Option<u64>,
    message: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QrStart {
    attempt_id: String,
    qr_image: String,
    expires_at: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QrPoll {
    phase: &'static str,
    account: Option<Account>,
    persisted: bool,
    message: String,
}

struct Attempt {
    id: String,
    key: String,
    expires_at: u64,
    last_poll: u64,
    busy: bool,
    result: QrPoll,
}
#[derive(Default)]
struct Runtime {
    generation: u64,
    attempt: Option<Attempt>,
}
static RUNTIME: OnceLock<tokio::sync::Mutex<Runtime>> = OnceLock::new();
static MAINTENANCE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
fn runtime() -> &'static tokio::sync::Mutex<Runtime> {
    RUNTIME.get_or_init(|| tokio::sync::Mutex::new(Runtime::default()))
}
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn phase(phase: &'static str, message: &str) -> QrPoll {
    QrPoll {
        phase,
        message: message.into(),
        account: None,
        persisted: false,
    }
}
fn phase_for_code(code: i64) -> QrPoll {
    match code {
        86101 => phase("waiting_scan", "请用 B 站 App 扫码"),
        86090 => phase("waiting_confirm", "已扫码，请在手机上确认登录"),
        86038 => phase("expired", "二维码已过期，请重新生成"),
        0 => phase("verifying", "正在核对账号并保存登录"),
        _ => phase("failed", "B 站未完成登录，请重新生成二维码"),
    }
}
fn check_generation(state: &Runtime, generation: u64) -> Result<(), String> {
    if state.generation != generation {
        Err("本次登录操作已取消。".into())
    } else {
        Ok(())
    }
}

#[tauri::command]
pub async fn bilibili_auth_start_qr() -> Result<QrStart, String> {
    let generation = {
        let mut state = runtime().lock().await;
        state.generation += 1;
        state.attempt = None;
        state.generation
    };
    let (url, key) = protocol::generate().await.map_err(|e| e.message)?;
    let code = qrcode::QrCode::new(url.as_bytes()).map_err(|_| "无法绘制登录二维码。")?;
    let svg = code
        .render::<qrcode::render::svg::Color>()
        .min_dimensions(240, 240)
        .build();
    let qr_image = format!(
        "data:image/svg+xml;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(svg)
    );
    let mut random = [0u8; 16];
    getrandom::fill(&mut random).map_err(|_| "无法初始化扫码会话。")?;
    let attempt_id = format!("{:032x}", u128::from_le_bytes(random));
    let expires_at = now_ms() + 180_000;
    let mut state = runtime().lock().await;
    check_generation(&state, generation)?;
    state.attempt = Some(Attempt {
        id: attempt_id.clone(),
        key,
        expires_at,
        last_poll: 0,
        busy: false,
        result: phase("waiting_scan", "请用 B 站 App 扫码"),
    });
    Ok(QrStart {
        attempt_id,
        qr_image,
        expires_at,
    })
}

#[tauri::command]
pub async fn bilibili_auth_poll_qr(
    app: tauri::AppHandle,
    attempt_id: String,
) -> Result<QrPoll, String> {
    poll_at(&credential::path(&app)?, &attempt_id).await
}

async fn poll_at(path: &Path, attempt_id: &str) -> Result<QrPoll, String> {
    let (generation, key) = {
        let mut state = runtime().lock().await;
        let generation = state.generation;
        let attempt = state
            .attempt
            .as_mut()
            .filter(|a| a.id == attempt_id)
            .ok_or("扫码会话已取消或已更换。")?;
        if matches!(attempt.result.phase, "completed" | "expired" | "failed") {
            return Ok(attempt.result.clone());
        }
        if now_ms() >= attempt.expires_at {
            attempt.key.clear();
            attempt.result = phase("expired", "二维码已过期，请重新生成");
            return Ok(attempt.result.clone());
        }
        if attempt.busy || now_ms().saturating_sub(attempt.last_poll) < 2_000 {
            return Ok(attempt.result.clone());
        }
        attempt.busy = true;
        attempt.last_poll = now_ms();
        (generation, attempt.key.clone())
    };
    let result = async {
        let (value, headers) = protocol::poll(&key).await?;
        let code = value["data"]["code"]
            .as_i64()
            .ok_or_else(AuthError::invalid)?;
        if code != 0 {
            return Ok((phase_for_code(code), None));
        }
        let mut credential = credential::Credential::from_response(&headers, &value)?;
        protocol::verify(&mut credential).await?;
        Ok::<_, AuthError>((
            QrPoll {
                phase: "completed",
                account: Some(credential.account.clone()),
                persisted: true,
                message: "登录已加密保存在本机，重启后可继续使用。".into(),
            },
            Some(credential),
        ))
    }
    .await;
    let mut state = runtime().lock().await;
    check_generation(&state, generation)?;
    let attempt = state
        .attempt
        .as_mut()
        .filter(|a| a.id == attempt_id)
        .ok_or("扫码会话已取消。")?;
    attempt.busy = false;
    match result {
        Ok((result, credential)) => {
            if let Some(credential) = credential {
                // No completed result is visible unless durable protection succeeds.
                if let Err(error) = credential::save(path, &credential) {
                    attempt.key.clear();
                    attempt.result = phase(
                        "failed",
                        "手机确认成功，但本机保存失败；请检查磁盘后重新扫码。",
                    );
                    return Err(error);
                }
                attempt.key.clear();
            }
            attempt.result = result.clone();
            if result.persisted {
                // A maintenance request may have read the previous account after QR generation.
                // Saving the new identity invalidates that request before it can write back.
                state.generation += 1;
            }
            Ok(result)
        }
        Err(error) => {
            attempt.result.message = error.message;
            Ok(attempt.result.clone()) // Retry within this bounded QR attempt; never expose raw response.
        }
    }
}

#[tauri::command]
pub async fn bilibili_auth_cancel_qr(attempt_id: String) -> bool {
    let mut state = runtime().lock().await;
    if state.attempt.as_ref().is_some_and(|a| a.id == attempt_id) {
        state.generation += 1;
        state.attempt = None;
        true
    } else {
        false
    }
}

#[tauri::command]
pub async fn bilibili_auth_status(
    app: tauri::AppHandle,
    verify: bool,
) -> Result<AuthStatus, String> {
    status_at(&credential::path(&app)?, verify).await
}

async fn status_at(path: &Path, verify: bool) -> Result<AuthStatus, String> {
    let _maintenance = MAINTENANCE.lock().await;
    let (generation, mut credential) = {
        let state = runtime().lock().await;
        (state.generation, credential::load(path)?)
    };
    let Some(mut current) = credential.take() else {
        return Ok(AuthStatus {
            state: "anonymous",
            account: None,
            persisted: false,
            last_verified_at: None,
            message: "尚未登录，公开内容可直接获取。".into(),
        });
    };
    let mut error = None;
    if verify {
        match protocol::maintained(current.clone()).await {
            Ok(next) => {
                let state = runtime().lock().await;
                check_generation(&state, generation)?;
                credential::save(path, &next)?;
                current = next;
                drop(state);
                if current.pending_confirm.is_some() {
                    match protocol::confirm(&current).await {
                        Ok(()) => {
                            let state = runtime().lock().await;
                            check_generation(&state, generation)?;
                            current.pending_confirm = None;
                            credential::save(path, &current)?;
                        }
                        Err(e) => {
                            error = Some(format!("新登录已保存；刷新确认暂未完成。{}", e.message))
                        }
                    }
                }
            }
            Err(e) => {
                let state = runtime().lock().await;
                check_generation(&state, generation)?;
                if e.needs_login {
                    current.needs_login = true;
                    credential::save(path, &current)?;
                }
                error = Some(e.message);
            }
        }
    }
    let state = runtime().lock().await;
    check_generation(&state, generation)?;
    Ok(AuthStatus {
        state: if current.needs_login {
            "needs_login"
        } else if error.is_some() || !verify {
            "unverified"
        } else {
            "authenticated"
        },
        account: Some(current.account),
        persisted: true,
        last_verified_at: Some(current.last_verified_at),
        message: error.unwrap_or_else(|| {
            if current.needs_login {
                "登录已失效，请重新扫码。".into()
            } else if verify {
                "B 站账号可用，登录已加密保存。".into()
            } else {
                "已恢复本机保存的账号，可检查登录状态。".into()
            }
        }),
    })
}

#[tauri::command]
pub async fn bilibili_auth_logout(app: tauri::AppHandle) -> Result<(), String> {
    let mut state = runtime().lock().await;
    state.generation += 1;
    state.attempt = None;
    match std::fs::remove_file(credential::path(&app)?) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("本机登录文件未能清除，请检查目录权限后重试。".into()),
    }
}

pub(super) async fn acquisition_cookie(
    app: &tauri::AppHandle,
    explicit: Option<String>,
) -> Result<Option<String>, String> {
    if explicit
        .as_ref()
        .is_some_and(|value| !value.trim().is_empty())
    {
        return Ok(explicit);
    }
    let path = credential::path(app)?;
    let state = runtime().lock().await;
    let current = credential::load(&path)?;
    drop(state);
    if current
        .as_ref()
        .is_some_and(|c| now_ms().saturating_sub(c.last_verified_at) > 6 * 60 * 60 * 1000)
    {
        let status = status_at(&path, true).await?;
        if status.state == "needs_login" {
            return Err(status.message);
        }
    }
    let _state = runtime().lock().await;
    let current = credential::load(&path)?;
    if current.as_ref().is_some_and(|c| c.needs_login) {
        return Err("B 站登录已失效，请重新扫码。".into());
    }
    current
        .map(|c| c.header(protocol::NAV).map_err(|e| e.message))
        .transpose()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancellation_and_logout_fence_late_credential_writes() {
        let mut runtime = Runtime {
            generation: 4,
            attempt: None,
        };
        assert!(check_generation(&runtime, 4).is_ok());
        runtime.generation += 1;
        assert!(check_generation(&runtime, 4).is_err());
        assert_eq!(phase_for_code(86101).phase, "waiting_scan");
        assert_eq!(phase_for_code(86090).phase, "waiting_confirm");
        assert_eq!(phase_for_code(86038).phase, "expired");
        assert_eq!(phase_for_code(0).phase, "verifying");
        assert!(!phase_for_code(0).persisted);
    }
}
