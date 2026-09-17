use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};
use tauri::{AppHandle, Manager};

const AUTHORITY_KEY_VERSION: u8 = 1;
const AUTHORITY_EVENT_VERSION: u8 = 2;
const AUTHORITY_HEAD_VERSION: u8 = 2;
const MAX_REQUEST_PAYLOAD_BYTES: usize = 32 * 1024;
const SIGNATURE_ALGORITHM: &str = "hmac-sha256-v1";
const ISSUE_DOMAIN: &str = "manual-time-map-verification-issue-v1";
const REVOCATION_DOMAIN: &str = "manual-time-map-verification-revocation-v1";
const EVENT_DIGEST_DOMAIN: &str = "manual-time-map-verification-event-digest-v2";
const EVENT_CHAIN_DOMAIN: &str = "manual-time-map-verification-event-chain-v2";
const HEAD_DOMAIN: &str = "manual-time-map-verification-durable-head-v2";
const MARKER_DOMAIN: &str = "manual-time-map-verification-ledger-marker-v2";
const GENESIS_EVENT_DIGEST: &str =
    "0000000000000000000000000000000000000000000000000000000000000000";
const EVENTS_V2_DIRECTORY: &str = "events-v2";
const LEGACY_EVENTS_V1_DIRECTORY: &str = "events";
const DURABLE_HEAD_FILE: &str = "authority-head-v2.json";
const LEDGER_MARKER_FILE: &str = "authority-ledger-v2.marker.json";
const PENDING_COMMIT_FILE: &str = "authority-commit-v2.pending.json";
const INSTALLATION_DOMAIN_HMAC_PREFIX: &str = "installation-domain-hmac-v1";

static AUTHORITY_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueManualVerificationRequest {
    request_payload: String,
    request_digest: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualVerificationSeal {
    verification_id: String,
    issuer_key_id: String,
    issuer_sequence: u64,
    signature_algorithm: &'static str,
    signature: String,
    request_digest: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyManualVerificationRequest {
    verification_id: String,
    issuer_key_id: String,
    signature: String,
    request_payload: String,
    request_digest: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualVerificationAuthorityResult {
    verification_id: String,
    issuer_key_id: String,
    signature: String,
    request_digest: String,
    status: &'static str,
    reason: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevokeManualVerificationRequest {
    verification_id: String,
    issuer_key_id: String,
    signature: String,
    request_digest: String,
    reason: String,
    revoked_by: String,
    revoked_at: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualVerificationRevocationSeal {
    verification_id: String,
    issuer_key_id: String,
    issuer_sequence: u64,
    signature_algorithm: &'static str,
    signature: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthorityKeyFile {
    version: u8,
    key_id: String,
    secret_hex: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(
    tag = "eventType",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum AuthorityEvent {
    Issue {
        version: u8,
        sequence: u64,
        previous_event_digest: String,
        verification_id: String,
        request_digest: String,
        signature: String,
        event_digest: String,
        chain_hmac: String,
    },
    Revoke {
        version: u8,
        sequence: u64,
        previous_event_digest: String,
        verification_id: String,
        request_digest: String,
        issue_signature: String,
        reason: String,
        revoked_by: String,
        revoked_at: String,
        signature: String,
        event_digest: String,
        chain_hmac: String,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthorityDurableHead {
    version: u8,
    sequence: u64,
    event_digest: String,
    legacy_v1_quarantined: bool,
    hmac: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthorityLedgerMarker {
    version: u8,
    key_id: String,
    legacy_v1_quarantined: bool,
    hmac: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct PendingAuthorityCommit {
    version: u8,
    previous_head: AuthorityDurableHead,
    event: AuthorityEvent,
    next_head: AuthorityDurableHead,
}

#[derive(Debug)]
struct LoadedAuthorityLedger {
    events: Vec<AuthorityEvent>,
    head: AuthorityDurableHead,
}

#[derive(Serialize)]
#[serde(
    tag = "eventType",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum AuthorityEventDigestBody<'a> {
    Issue {
        version: u8,
        sequence: u64,
        previous_event_digest: &'a str,
        verification_id: &'a str,
        request_digest: &'a str,
        signature: &'a str,
    },
    Revoke {
        version: u8,
        sequence: u64,
        previous_event_digest: &'a str,
        verification_id: &'a str,
        request_digest: &'a str,
        issue_signature: &'a str,
        reason: &'a str,
        revoked_by: &'a str,
        revoked_at: &'a str,
        signature: &'a str,
    },
}

#[tauri::command]
pub fn issue_manual_time_map_verification(
    app: AppHandle,
    request: IssueManualVerificationRequest,
) -> Result<ManualVerificationSeal, String> {
    let root = authority_root(&app)?;
    with_authority_lock(|| issue_at(&root, request))
}

#[tauri::command]
pub fn verify_manual_time_map_verification(
    app: AppHandle,
    request: VerifyManualVerificationRequest,
) -> Result<ManualVerificationAuthorityResult, String> {
    let root = authority_root(&app)?;
    with_authority_lock(|| verify_at(&root, request))
}

#[tauri::command]
pub fn revoke_manual_time_map_verification(
    app: AppHandle,
    request: RevokeManualVerificationRequest,
) -> Result<ManualVerificationRevocationSeal, String> {
    let root = authority_root(&app)?;
    with_authority_lock(|| revoke_at(&root, request))
}

/// Holds the installation authority lock across verification and the caller's final publish.
/// Concurrent revoke/issue commands cannot cross this guard's check-to-use boundary.
pub(crate) struct ManualVerificationAuthorityGuard {
    root: PathBuf,
    _guard: MutexGuard<'static, ()>,
}

pub(crate) struct InstallationDomainHmacSeal {
    pub(crate) issuer_key_id: String,
    pub(crate) signature: String,
}

pub(crate) fn lock_manual_time_map_verification_authority(
    app: &AppHandle,
) -> Result<ManualVerificationAuthorityGuard, String> {
    let root = authority_root(app)?;
    let guard = AUTHORITY_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "人工验证机构锁已损坏；verified 导出已阻断。".to_string())?;
    Ok(ManualVerificationAuthorityGuard {
        root,
        _guard: guard,
    })
}

impl ManualVerificationAuthorityGuard {
    pub(crate) fn require_active(
        &self,
        verification_id: &str,
        issuer_key_id: &str,
        signature: &str,
        request_payload: &str,
        request_digest: &str,
    ) -> Result<(), String> {
        let request = VerifyManualVerificationRequest {
            verification_id: verification_id.to_string(),
            issuer_key_id: issuer_key_id.to_string(),
            signature: signature.to_string(),
            request_payload: request_payload.to_string(),
            request_digest: request_digest.to_string(),
        };
        let result = verify_at(&self.root, request)?;
        if result.status == "active" {
            Ok(())
        } else {
            Err(format!(
                "人工验证凭据未通过本机签发/撤销注册表复核（{}）：{}",
                result.status, result.reason
            ))
        }
    }

    /// Signs a bounded, caller-owned payload with the installation key while this guard holds
    /// the authority lock. The explicit domain is included ahead of the payload so a signature
    /// issued for one native trust boundary cannot be replayed in another.
    pub(crate) fn sign_domain_payload(
        &self,
        domain: &str,
        payload: &[u8],
    ) -> Result<InstallationDomainHmacSeal, String> {
        validate_installation_hmac_input(domain, payload)?;
        let key = load_or_create_authority_key(&self.root)?;
        let secret = decode_fixed_hex::<32>(&key.secret_hex, "安装级签名密钥")?;
        Ok(InstallationDomainHmacSeal {
            issuer_key_id: key.key_id,
            signature: hmac_sha256_hex(&secret, &installation_domain_hmac_message(domain, payload)),
        })
    }

    /// Requires an installation-domain signature to match the current installation key.
    pub(crate) fn require_valid_domain_payload(
        &self,
        domain: &str,
        payload: &[u8],
        issuer_key_id: &str,
        signature: &str,
    ) -> Result<(), String> {
        validate_installation_hmac_input(domain, payload)?;
        validate_hex("signature", signature, 64)?;
        let key = load_or_create_authority_key(&self.root)?;
        if issuer_key_id != key.key_id {
            return Err("该内容收据由另一安装签发，或本机安装级密钥已丢失。".to_string());
        }
        let secret = decode_fixed_hex::<32>(&key.secret_hex, "安装级签名密钥")?;
        let expected = hmac_sha256_hex(&secret, &installation_domain_hmac_message(domain, payload));
        if !constant_time_hex_eq(&expected, signature) {
            return Err("安装级内容收据签名无效，已阻断信任。".to_string());
        }
        Ok(())
    }
}

fn validate_installation_hmac_input(domain: &str, payload: &[u8]) -> Result<(), String> {
    if domain.is_empty()
        || domain.len() > 128
        || !domain
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Err("安装级 HMAC 域格式无效。".to_string());
    }
    if payload.len() > 16 * 1024 * 1024 {
        return Err("安装级 HMAC 载荷超过 16 MiB 限制。".to_string());
    }
    Ok(())
}

fn installation_domain_hmac_message(domain: &str, payload: &[u8]) -> Vec<u8> {
    let mut message = Vec::with_capacity(
        INSTALLATION_DOMAIN_HMAC_PREFIX.len() + domain.len() + payload.len() + 2,
    );
    message.extend_from_slice(INSTALLATION_DOMAIN_HMAC_PREFIX.as_bytes());
    message.push(0);
    message.extend_from_slice(domain.as_bytes());
    message.push(0);
    message.extend_from_slice(payload);
    message
}

fn authority_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map(|path| path.join("manual-verification-authority-v1"))
        .map_err(|error| format!("无法定位人工验证机构目录：{error}"))
}

fn with_authority_lock<T>(operation: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    let guard = AUTHORITY_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "人工验证机构锁已损坏；为避免错误签发，本次操作已阻断。".to_string())?;
    let result = operation();
    drop(guard);
    result
}

fn issue_at(
    root: &Path,
    request: IssueManualVerificationRequest,
) -> Result<ManualVerificationSeal, String> {
    validate_issue_request(&request)?;
    let key = load_or_create_authority_key(root)?;
    let ledger = load_ledger(root, &key)?;
    let sequence = next_sequence(&ledger.events)?;
    let verification_id = random_hex(16)?;
    let secret = decode_fixed_hex::<32>(&key.secret_hex, "安装级签名密钥")?;
    let signature = hmac_sha256_hex(
        &secret,
        issue_signature_message(&verification_id, sequence, &request.request_digest).as_bytes(),
    );
    let event = seal_event_chain(
        AuthorityEvent::Issue {
            version: AUTHORITY_EVENT_VERSION,
            sequence,
            previous_event_digest: ledger.head.event_digest.clone(),
            verification_id: verification_id.clone(),
            request_digest: request.request_digest.clone(),
            signature: signature.clone(),
            event_digest: String::new(),
            chain_hmac: String::new(),
        },
        &secret,
    )?;
    append_immutable_event(root, &key, &ledger.head, &event)?;
    Ok(ManualVerificationSeal {
        verification_id,
        issuer_key_id: key.key_id,
        issuer_sequence: sequence,
        signature_algorithm: SIGNATURE_ALGORITHM,
        signature,
        request_digest: request.request_digest,
    })
}

fn verify_at(
    root: &Path,
    request: VerifyManualVerificationRequest,
) -> Result<ManualVerificationAuthorityResult, String> {
    validate_verification_request(&request)?;
    let key = load_or_create_authority_key(root)?;
    let base = |status: &'static str, reason: String| ManualVerificationAuthorityResult {
        verification_id: request.verification_id.clone(),
        issuer_key_id: request.issuer_key_id.clone(),
        signature: request.signature.clone(),
        request_digest: request.request_digest.clone(),
        status,
        reason,
    };
    if request.issuer_key_id != key.key_id {
        return Ok(base(
            "unknown",
            "该凭据由另一安装签发，或本机安装级密钥已丢失；必须重新完成人工复核。".to_string(),
        ));
    }
    if digest_payload(&request.request_payload) != request.request_digest {
        return Ok(base(
            "invalid",
            "项目中的签发请求摘要与当前规范化时间图内容不一致。".to_string(),
        ));
    }
    let events = load_ledger(root, &key)?.events;
    let issue = events.iter().find_map(|event| match event {
        AuthorityEvent::Issue {
            sequence,
            verification_id,
            request_digest,
            signature,
            ..
        } if verification_id == &request.verification_id => {
            Some((*sequence, request_digest.as_str(), signature.as_str()))
        }
        _ => None,
    });
    let Some((issue_sequence, registered_digest, registered_signature)) = issue else {
        return Ok(base(
            "unknown",
            "本机签发注册表中不存在该人工验证编号。".to_string(),
        ));
    };
    if registered_digest != request.request_digest || registered_signature != request.signature {
        return Ok(base(
            "invalid",
            "项目凭据与本机签发注册表不一致。".to_string(),
        ));
    }
    let secret = decode_fixed_hex::<32>(&key.secret_hex, "安装级签名密钥")?;
    let expected_signature = hmac_sha256_hex(
        &secret,
        issue_signature_message(
            &request.verification_id,
            issue_sequence,
            &request.request_digest,
        )
        .as_bytes(),
    );
    if !constant_time_hex_eq(&expected_signature, &request.signature) {
        return Ok(base("invalid", "人工验证 HMAC 签名无效。".to_string()));
    }
    if events.iter().any(|event| {
        matches!(
            event,
            AuthorityEvent::Revoke { verification_id, .. }
                if verification_id == &request.verification_id
        )
    }) {
        return Ok(base(
            "revoked",
            "本机撤销注册表已撤销该人工验证；项目 JSON 不能恢复它。".to_string(),
        ));
    }
    Ok(base(
        "active",
        "签名、规范化摘要和本机撤销注册表均已验证。".to_string(),
    ))
}

fn revoke_at(
    root: &Path,
    request: RevokeManualVerificationRequest,
) -> Result<ManualVerificationRevocationSeal, String> {
    validate_revocation_request(&request)?;
    let key = load_or_create_authority_key(root)?;
    if request.issuer_key_id != key.key_id {
        return Err("只能由原签发安装撤销该人工验证；当前安装密钥不匹配。".to_string());
    }
    let ledger = load_ledger(root, &key)?;
    let events = &ledger.events;
    let issue = events.iter().find_map(|event| match event {
        AuthorityEvent::Issue {
            sequence,
            verification_id,
            request_digest,
            signature,
            ..
        } if verification_id == &request.verification_id => {
            Some((*sequence, request_digest.as_str(), signature.as_str()))
        }
        _ => None,
    });
    let Some((issue_sequence, registered_digest, registered_signature)) = issue else {
        return Err("本机签发注册表中不存在该人工验证，不能生成撤销回执。".to_string());
    };
    if registered_digest != request.request_digest || registered_signature != request.signature {
        return Err("待撤销凭据与本机签发注册表不一致。".to_string());
    }
    let secret = decode_fixed_hex::<32>(&key.secret_hex, "安装级签名密钥")?;
    let expected_issue_signature = hmac_sha256_hex(
        &secret,
        issue_signature_message(
            &request.verification_id,
            issue_sequence,
            &request.request_digest,
        )
        .as_bytes(),
    );
    if !constant_time_hex_eq(&expected_issue_signature, &request.signature) {
        return Err("待撤销人工验证的签名无效。".to_string());
    }
    if let Some(existing) = events.iter().find_map(|event| match event {
        AuthorityEvent::Revoke {
            sequence,
            verification_id,
            reason,
            revoked_by,
            revoked_at,
            signature,
            ..
        } if verification_id == &request.verification_id => {
            Some((*sequence, reason, revoked_by, revoked_at, signature))
        }
        _ => None,
    }) {
        if existing.1 == &request.reason
            && existing.2 == &request.revoked_by
            && existing.3 == &request.revoked_at
        {
            return Ok(ManualVerificationRevocationSeal {
                verification_id: request.verification_id,
                issuer_key_id: key.key_id,
                issuer_sequence: existing.0,
                signature_algorithm: SIGNATURE_ALGORITHM,
                signature: existing.4.clone(),
            });
        }
        return Err("该人工验证已经撤销，撤销审计内容不能覆盖。".to_string());
    }
    let sequence = next_sequence(events)?;
    let signature = hmac_sha256_hex(
        &secret,
        revocation_signature_message(sequence, &request).as_bytes(),
    );
    let event = seal_event_chain(
        AuthorityEvent::Revoke {
            version: AUTHORITY_EVENT_VERSION,
            sequence,
            previous_event_digest: ledger.head.event_digest.clone(),
            verification_id: request.verification_id.clone(),
            request_digest: request.request_digest,
            issue_signature: request.signature,
            reason: request.reason,
            revoked_by: request.revoked_by,
            revoked_at: request.revoked_at,
            signature: signature.clone(),
            event_digest: String::new(),
            chain_hmac: String::new(),
        },
        &secret,
    )?;
    append_immutable_event(root, &key, &ledger.head, &event)?;
    Ok(ManualVerificationRevocationSeal {
        verification_id: request.verification_id,
        issuer_key_id: key.key_id,
        issuer_sequence: sequence,
        signature_algorithm: SIGNATURE_ALGORITHM,
        signature,
    })
}

fn validate_issue_request(request: &IssueManualVerificationRequest) -> Result<(), String> {
    if request.request_payload.len() > MAX_REQUEST_PAYLOAD_BYTES {
        return Err("人工验证规范化请求超过 32 KiB 限制。".to_string());
    }
    if digest_payload(&request.request_payload) != request.request_digest {
        return Err("人工验证请求的 SHA-256 摘要不正确。".to_string());
    }
    let value: Value = serde_json::from_str(&request.request_payload)
        .map_err(|error| format!("人工验证规范化请求不是有效 JSON：{error}"))?;
    let fields = value
        .as_array()
        .ok_or_else(|| "人工验证规范化请求必须是固定顺序数组。".to_string())?;
    if fields.len() != 12
        || fields[0].as_str() != Some("manual-time-map-verification-request-v1")
        || fields[1].as_str() != Some("manual-review")
        || !is_bounded_string(&fields[2], 1, 512)
        || fields[3].as_u64().is_none_or(|revision| revision == 0)
        || !is_sha256_digest_value(&fields[4])
        || !is_content_identity_array(&fields[5])
        || !is_content_identity_array(&fields[6])
        || !is_bounded_string(&fields[7], 1, 512)
        || !is_bounded_string(&fields[8], 1, 512)
        || !is_sha256_digest_value(&fields[9])
        || !is_bounded_string(&fields[10], 1, 512)
        || !is_bounded_string(&fields[11], 1, 512)
    {
        return Err(
            "人工验证请求缺少 manual-review、时间图摘要、媒体身份或复核证据摘要。".to_string(),
        );
    }
    Ok(())
}

fn validate_verification_request(request: &VerifyManualVerificationRequest) -> Result<(), String> {
    validate_bounded_text("verificationId", &request.verification_id)?;
    validate_bounded_text("issuerKeyId", &request.issuer_key_id)?;
    validate_hex("signature", &request.signature, 64)?;
    validate_sha256_digest("requestDigest", &request.request_digest)?;
    if request.request_payload.len() > MAX_REQUEST_PAYLOAD_BYTES {
        return Err("人工验证规范化请求超过 32 KiB 限制。".to_string());
    }
    Ok(())
}

fn validate_revocation_request(request: &RevokeManualVerificationRequest) -> Result<(), String> {
    validate_bounded_text("verificationId", &request.verification_id)?;
    validate_bounded_text("issuerKeyId", &request.issuer_key_id)?;
    validate_hex("signature", &request.signature, 64)?;
    validate_sha256_digest("requestDigest", &request.request_digest)?;
    validate_bounded_text("reason", &request.reason)?;
    validate_bounded_text("revokedBy", &request.revoked_by)?;
    validate_bounded_text("revokedAt", &request.revoked_at)
}

fn load_or_create_authority_key(root: &Path) -> Result<AuthorityKeyFile, String> {
    fs::create_dir_all(root).map_err(|error| format!("无法创建人工验证机构目录：{error}"))?;
    let key_path = root.join("authority-key-v1.json");
    if key_path.exists() {
        return read_authority_key(&key_path);
    }
    let mut secret = [0_u8; 32];
    getrandom::fill(&mut secret).map_err(|error| format!("无法生成安装级随机密钥：{error}"))?;
    let secret_hex = hex_encode(&secret);
    let key_id = format!("install-sha256:{}", &sha256_hex(&secret)[..32]);
    let key = AuthorityKeyFile {
        version: AUTHORITY_KEY_VERSION,
        key_id,
        secret_hex,
    };
    let bytes =
        serde_json::to_vec(&key).map_err(|error| format!("无法序列化安装级验证密钥：{error}"))?;
    write_atomic_new(&key_path, &bytes)?;
    read_authority_key(&key_path)
}

fn read_authority_key(path: &Path) -> Result<AuthorityKeyFile, String> {
    let mut bytes = Vec::new();
    File::open(path)
        .and_then(|mut file| file.read_to_end(&mut bytes))
        .map_err(|error| format!("无法读取安装级验证密钥：{error}"))?;
    let key: AuthorityKeyFile = serde_json::from_slice(&bytes)
        .map_err(|_| "安装级验证密钥文件已损坏；所有持久化人工验证均按不可信处理。".to_string())?;
    if key.version != AUTHORITY_KEY_VERSION
        || !key.key_id.starts_with("install-sha256:")
        || decode_fixed_hex::<32>(&key.secret_hex, "安装级签名密钥").is_err()
    {
        return Err("安装级验证密钥格式无效；所有持久化人工验证均按不可信处理。".to_string());
    }
    let secret = decode_fixed_hex::<32>(&key.secret_hex, "安装级签名密钥")?;
    let expected_id = format!("install-sha256:{}", &sha256_hex(&secret)[..32]);
    if key.key_id != expected_id {
        return Err("安装级验证密钥 ID 与密钥内容不一致；已阻断验证。".to_string());
    }
    Ok(key)
}

fn load_ledger(root: &Path, key: &AuthorityKeyFile) -> Result<LoadedAuthorityLedger, String> {
    fs::create_dir_all(root).map_err(|error| format!("无法创建人工验证签发机构目录：{error}"))?;
    let secret = decode_fixed_hex::<32>(&key.secret_hex, "安装级签名密钥")?;
    ensure_v2_ledger_initialized(root, key, &secret)?;
    recover_pending_commit(root, key, &secret)?;

    let marker = read_and_validate_marker(root, key, &secret)?;
    let head = read_and_validate_head(root, &secret)?;
    if head.legacy_v1_quarantined != marker.legacy_v1_quarantined {
        return Err(authority_corruption(
            "持久头与账本标记记录的 v1 隔离边界不一致",
        ));
    }

    let events_dir = root.join(EVENTS_V2_DIRECTORY);
    let mut paths = fs::read_dir(&events_dir)
        .map_err(|error| format!("无法读取人工验证 v2 事件目录：{error}"))?
        .map(|entry| entry.map(|value| value.path()))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("无法枚举人工验证 v2 事件：{error}"))?;
    if paths.iter().any(|path| {
        !path.is_file() || path.extension().and_then(|extension| extension.to_str()) != Some("json")
    }) {
        return Err(authority_corruption("v2 事件目录包含非预期条目"));
    }
    paths.sort();
    let expected_count = usize::try_from(head.sequence)
        .map_err(|_| authority_corruption("持久头序号超出当前平台可表示范围"))?;
    if paths.len() != expected_count {
        return Err(authority_corruption(
            "事件数量与持久头不一致，尾部事件可能已被删除或额外添加",
        ));
    }

    let mut events = Vec::with_capacity(paths.len());
    let mut previous_digest = GENESIS_EVENT_DIGEST.to_string();
    for (index, path) in paths.into_iter().enumerate() {
        let expected_sequence = u64::try_from(index)
            .ok()
            .and_then(|value| value.checked_add(1))
            .ok_or_else(|| authority_corruption("事件序号溢出"))?;
        let bytes = fs::read(&path)
            .map_err(|error| format!("无法读取人工验证事件 {}：{error}", path.display()))?;
        let event: AuthorityEvent = serde_json::from_slice(&bytes).map_err(|_| {
            authority_corruption(&format!("事件 {} 不是有效的 v2 JSON", path.display()))
        })?;
        let expected_name = event_file_name(&event);
        if path.file_name().and_then(|name| name.to_str()) != Some(expected_name.as_str()) {
            return Err(authority_corruption(
                "事件文件名与已签名的序号、编号和类型不一致",
            ));
        }
        validate_event(
            &event,
            expected_sequence,
            &previous_digest,
            &events,
            &secret,
        )?;
        previous_digest = event_digest_value(&event).to_string();
        events.push(event);
    }
    if head.event_digest != previous_digest {
        return Err(authority_corruption("持久头摘要与最终事件不一致"));
    }
    Ok(LoadedAuthorityLedger { events, head })
}

fn ensure_v2_ledger_initialized(
    root: &Path,
    key: &AuthorityKeyFile,
    secret: &[u8; 32],
) -> Result<(), String> {
    let head_path = root.join(DURABLE_HEAD_FILE);
    let marker_path = root.join(LEDGER_MARKER_FILE);
    let pending_path = root.join(PENDING_COMMIT_FILE);
    match (head_path.exists(), marker_path.exists()) {
        (true, true) => return Ok(()),
        (true, false) | (false, true) => {
            return Err(authority_corruption("持久头与账本标记只有一个存在"));
        }
        (false, false) => {}
    }
    if pending_path.exists() {
        return Err(authority_corruption("v2 持久头初始化前出现了待提交日志"));
    }
    let events_dir = root.join(EVENTS_V2_DIRECTORY);
    if events_dir.exists()
        && fs::read_dir(&events_dir)
            .map_err(|error| format!("无法检查 v2 事件目录：{error}"))?
            .next()
            .is_some()
    {
        return Err(authority_corruption(
            "v2 事件存在但持久头缺失，禁止自动回滚恢复",
        ));
    }
    fs::create_dir_all(&events_dir)
        .map_err(|error| format!("无法创建人工验证 v2 事件目录：{error}"))?;
    let legacy_v1_quarantined = legacy_v1_events_present(root)?;
    let marker = create_marker(key, legacy_v1_quarantined, secret);
    let head = create_head(0, GENESIS_EVENT_DIGEST, legacy_v1_quarantined, secret);
    let marker_bytes = serde_json::to_vec(&marker)
        .map_err(|error| format!("无法序列化人工验证账本标记：{error}"))?;
    let head_bytes =
        serde_json::to_vec(&head).map_err(|error| format!("无法序列化人工验证持久头：{error}"))?;
    // The marker is independent from the mutable head. An interrupted migration fails closed
    // instead of treating unchained v1 history as authoritative.
    write_atomic_new(&marker_path, &marker_bytes)?;
    write_atomic_new(&head_path, &head_bytes)
}

fn legacy_v1_events_present(root: &Path) -> Result<bool, String> {
    let path = root.join(LEGACY_EVENTS_V1_DIRECTORY);
    if !path.exists() {
        return Ok(false);
    }
    Ok(fs::read_dir(path)
        .map_err(|error| format!("无法检查旧版人工验证注册表：{error}"))?
        .next()
        .is_some())
}

fn create_marker(
    key: &AuthorityKeyFile,
    legacy_v1_quarantined: bool,
    secret: &[u8; 32],
) -> AuthorityLedgerMarker {
    AuthorityLedgerMarker {
        version: AUTHORITY_HEAD_VERSION,
        key_id: key.key_id.clone(),
        legacy_v1_quarantined,
        hmac: hmac_sha256_hex(
            secret,
            marker_hmac_message(&key.key_id, legacy_v1_quarantined).as_bytes(),
        ),
    }
}

fn create_head(
    sequence: u64,
    event_digest: &str,
    legacy_v1_quarantined: bool,
    secret: &[u8; 32],
) -> AuthorityDurableHead {
    AuthorityDurableHead {
        version: AUTHORITY_HEAD_VERSION,
        sequence,
        event_digest: event_digest.to_string(),
        legacy_v1_quarantined,
        hmac: hmac_sha256_hex(
            secret,
            head_hmac_message(sequence, event_digest, legacy_v1_quarantined).as_bytes(),
        ),
    }
}

fn read_and_validate_marker(
    root: &Path,
    key: &AuthorityKeyFile,
    secret: &[u8; 32],
) -> Result<AuthorityLedgerMarker, String> {
    let bytes = fs::read(root.join(LEDGER_MARKER_FILE))
        .map_err(|error| format!("无法读取人工验证账本标记：{error}"))?;
    let marker: AuthorityLedgerMarker =
        serde_json::from_slice(&bytes).map_err(|_| authority_corruption("账本标记已损坏"))?;
    if marker.version != AUTHORITY_HEAD_VERSION || marker.key_id != key.key_id {
        return Err(authority_corruption("账本标记版本或安装密钥编号无效"));
    }
    let expected = hmac_sha256_hex(
        secret,
        marker_hmac_message(&marker.key_id, marker.legacy_v1_quarantined).as_bytes(),
    );
    if !constant_time_hex_eq(&expected, &marker.hmac) {
        return Err(authority_corruption("账本标记 HMAC 无效"));
    }
    Ok(marker)
}

fn read_and_validate_head(root: &Path, secret: &[u8; 32]) -> Result<AuthorityDurableHead, String> {
    let bytes = fs::read(root.join(DURABLE_HEAD_FILE))
        .map_err(|error| format!("无法读取人工验证持久头：{error}"))?;
    let head: AuthorityDurableHead =
        serde_json::from_slice(&bytes).map_err(|_| authority_corruption("持久头已损坏"))?;
    validate_head(&head, secret)?;
    Ok(head)
}

fn validate_head(head: &AuthorityDurableHead, secret: &[u8; 32]) -> Result<(), String> {
    if head.version != AUTHORITY_HEAD_VERSION
        || validate_hex("eventDigest", &head.event_digest, 64).is_err()
        || validate_hex("headHmac", &head.hmac, 64).is_err()
    {
        return Err(authority_corruption("持久头格式无效"));
    }
    let expected = hmac_sha256_hex(
        secret,
        head_hmac_message(
            head.sequence,
            &head.event_digest,
            head.legacy_v1_quarantined,
        )
        .as_bytes(),
    );
    if !constant_time_hex_eq(&expected, &head.hmac) {
        return Err(authority_corruption("持久头 HMAC 无效"));
    }
    Ok(())
}

fn recover_pending_commit(
    root: &Path,
    key: &AuthorityKeyFile,
    secret: &[u8; 32],
) -> Result<(), String> {
    let pending_path = root.join(PENDING_COMMIT_FILE);
    if !pending_path.exists() {
        return Ok(());
    }
    let marker = read_and_validate_marker(root, key, secret)?;
    let bytes =
        fs::read(&pending_path).map_err(|error| format!("无法读取人工验证待提交日志：{error}"))?;
    let pending: PendingAuthorityCommit =
        serde_json::from_slice(&bytes).map_err(|_| authority_corruption("待提交日志已损坏"))?;
    if pending.version != AUTHORITY_EVENT_VERSION {
        return Err(authority_corruption("待提交日志版本无效"));
    }
    validate_head(&pending.previous_head, secret)?;
    validate_head(&pending.next_head, secret)?;
    let expected_next_sequence = pending
        .previous_head
        .sequence
        .checked_add(1)
        .ok_or_else(|| authority_corruption("待提交日志序号溢出"))?;
    if pending.previous_head.legacy_v1_quarantined != marker.legacy_v1_quarantined
        || pending.next_head.legacy_v1_quarantined != marker.legacy_v1_quarantined
        || pending.next_head.sequence != expected_next_sequence
        || pending.next_head.sequence != event_sequence(&pending.event)
        || pending.next_head.event_digest != event_digest_value(&pending.event)
        || event_previous_digest(&pending.event) != pending.previous_head.event_digest
    {
        return Err(authority_corruption("待提交日志没有连续扩展其已签名前驱头"));
    }
    validate_event_crypto(
        &pending.event,
        pending.next_head.sequence,
        &pending.previous_head.event_digest,
        secret,
    )?;

    let current_head = read_and_validate_head(root, secret)?;
    if current_head != pending.previous_head && current_head != pending.next_head {
        return Err(authority_corruption("待提交日志与当前持久头不一致"));
    }
    let event_path = root
        .join(EVENTS_V2_DIRECTORY)
        .join(event_file_name(&pending.event));
    if event_path.exists() {
        let existing: AuthorityEvent = serde_json::from_slice(
            &fs::read(&event_path).map_err(|error| format!("无法读取待提交事件目标：{error}"))?,
        )
        .map_err(|_| authority_corruption("待提交事件目标已损坏"))?;
        if existing != pending.event {
            return Err(authority_corruption("待提交事件目标与已签名日志不一致"));
        }
    } else if current_head == pending.next_head {
        return Err(authority_corruption("持久头已前进但对应事件文件缺失"));
    } else {
        let event_bytes = serde_json::to_vec(&pending.event)
            .map_err(|error| format!("无法序列化待恢复事件：{error}"))?;
        write_atomic_new(&event_path, &event_bytes)?;
    }
    if current_head == pending.previous_head {
        let head_bytes = serde_json::to_vec(&pending.next_head)
            .map_err(|error| format!("无法序列化待恢复持久头：{error}"))?;
        write_atomic_replace(&root.join(DURABLE_HEAD_FILE), &head_bytes)?;
    }
    fs::remove_file(&pending_path)
        .map_err(|error| format!("无法清除已完成的人工验证提交日志：{error}"))?;
    sync_parent_directory(&pending_path)
}

fn append_immutable_event(
    root: &Path,
    key: &AuthorityKeyFile,
    expected_head: &AuthorityDurableHead,
    event: &AuthorityEvent,
) -> Result<(), String> {
    let secret = decode_fixed_hex::<32>(&key.secret_hex, "安装级签名密钥")?;
    let current_head = read_and_validate_head(root, &secret)?;
    if &current_head != expected_head {
        return Err(authority_corruption("追加事务开始前持久头已发生变化"));
    }
    let next_sequence = current_head
        .sequence
        .checked_add(1)
        .ok_or_else(|| authority_corruption("签发机构事件序号溢出"))?;
    validate_event_crypto(event, next_sequence, &current_head.event_digest, &secret)?;
    let next_head = create_head(
        next_sequence,
        event_digest_value(event),
        current_head.legacy_v1_quarantined,
        &secret,
    );
    let pending = PendingAuthorityCommit {
        version: AUTHORITY_EVENT_VERSION,
        previous_head: current_head,
        event: event.clone(),
        next_head: next_head.clone(),
    };
    let pending_path = root.join(PENDING_COMMIT_FILE);
    let pending_bytes = serde_json::to_vec(&pending)
        .map_err(|error| format!("无法序列化人工验证提交日志：{error}"))?;
    write_atomic_new(&pending_path, &pending_bytes)?;

    let event_path = root.join(EVENTS_V2_DIRECTORY).join(event_file_name(event));
    let event_bytes =
        serde_json::to_vec(event).map_err(|error| format!("无法序列化人工验证事件：{error}"))?;
    write_atomic_new(&event_path, &event_bytes)?;
    let head_bytes = serde_json::to_vec(&next_head)
        .map_err(|error| format!("无法序列化人工验证持久头：{error}"))?;
    write_atomic_replace(&root.join(DURABLE_HEAD_FILE), &head_bytes)?;
    fs::remove_file(&pending_path)
        .map_err(|error| format!("无法清除已完成的人工验证提交日志：{error}"))?;
    sync_parent_directory(&pending_path)
}

fn seal_event_chain(
    mut event: AuthorityEvent,
    secret: &[u8; 32],
) -> Result<AuthorityEvent, String> {
    let digest = compute_event_digest(&event)?;
    let chain_hmac = hmac_sha256_hex(
        secret,
        event_chain_hmac_message(
            event_sequence(&event),
            event_previous_digest(&event),
            &digest,
        )
        .as_bytes(),
    );
    match &mut event {
        AuthorityEvent::Issue {
            event_digest,
            chain_hmac: stored_hmac,
            ..
        }
        | AuthorityEvent::Revoke {
            event_digest,
            chain_hmac: stored_hmac,
            ..
        } => {
            *event_digest = digest;
            *stored_hmac = chain_hmac;
        }
    }
    Ok(event)
}

fn validate_event(
    event: &AuthorityEvent,
    expected_sequence: u64,
    expected_previous_digest: &str,
    prior_events: &[AuthorityEvent],
    secret: &[u8; 32],
) -> Result<(), String> {
    validate_event_crypto(event, expected_sequence, expected_previous_digest, secret)?;
    match event {
        AuthorityEvent::Issue {
            sequence,
            verification_id,
            request_digest,
            signature,
            ..
        } => {
            validate_registry_text("verificationId", verification_id)?;
            validate_registry_digest("requestDigest", request_digest)?;
            validate_registry_hex("issue signature", signature)?;
            if prior_events.iter().any(|prior| {
                matches!(prior, AuthorityEvent::Issue { verification_id: prior_id, .. } if prior_id == verification_id)
            }) {
                return Err(authority_corruption("签发链中出现重复验证编号"));
            }
            let expected = hmac_sha256_hex(
                secret,
                issue_signature_message(verification_id, *sequence, request_digest).as_bytes(),
            );
            if !constant_time_hex_eq(&expected, signature) {
                return Err(authority_corruption("签发事件业务 HMAC 无效"));
            }
        }
        AuthorityEvent::Revoke {
            sequence,
            verification_id,
            request_digest,
            issue_signature,
            reason,
            revoked_by,
            revoked_at,
            signature,
            ..
        } => {
            validate_registry_text("verificationId", verification_id)?;
            validate_registry_digest("requestDigest", request_digest)?;
            validate_registry_hex("issue signature", issue_signature)?;
            validate_registry_text("reason", reason)?;
            validate_registry_text("revokedBy", revoked_by)?;
            validate_registry_text("revokedAt", revoked_at)?;
            validate_registry_hex("revocation signature", signature)?;
            let issue_matches = prior_events.iter().any(|prior| {
                matches!(
                    prior,
                    AuthorityEvent::Issue {
                        verification_id: prior_id,
                        request_digest: prior_digest,
                        signature: prior_signature,
                        ..
                    } if prior_id == verification_id
                        && prior_digest == request_digest
                        && prior_signature == issue_signature
                )
            });
            if !issue_matches {
                return Err(authority_corruption("撤销事件没有引用更早且匹配的签发事件"));
            }
            if prior_events.iter().any(|prior| {
                matches!(prior, AuthorityEvent::Revoke { verification_id: prior_id, .. } if prior_id == verification_id)
            }) {
                return Err(authority_corruption("事件链中出现重复撤销"));
            }
            let expected = hmac_sha256_hex(
                secret,
                revocation_signature_message_fields(
                    *sequence,
                    verification_id,
                    request_digest,
                    reason,
                    revoked_by,
                    revoked_at,
                )
                .as_bytes(),
            );
            if !constant_time_hex_eq(&expected, signature) {
                return Err(authority_corruption("撤销事件业务 HMAC 无效"));
            }
        }
    }
    Ok(())
}

fn validate_event_crypto(
    event: &AuthorityEvent,
    expected_sequence: u64,
    expected_previous_digest: &str,
    secret: &[u8; 32],
) -> Result<(), String> {
    if event_version(event) != AUTHORITY_EVENT_VERSION
        || event_sequence(event) != expected_sequence
        || event_previous_digest(event) != expected_previous_digest
        || validate_hex("eventDigest", event_digest_value(event), 64).is_err()
        || validate_hex("chainHmac", event_chain_hmac(event), 64).is_err()
    {
        return Err(authority_corruption(
            "事件版本、序号、前驱摘要或密码学字段无效",
        ));
    }
    let expected_digest = compute_event_digest(event)?;
    if !constant_time_hex_eq(&expected_digest, event_digest_value(event)) {
        return Err(authority_corruption("事件摘要无效"));
    }
    let expected_hmac = hmac_sha256_hex(
        secret,
        event_chain_hmac_message(
            expected_sequence,
            expected_previous_digest,
            &expected_digest,
        )
        .as_bytes(),
    );
    if !constant_time_hex_eq(&expected_hmac, event_chain_hmac(event)) {
        return Err(authority_corruption("事件链 HMAC 无效"));
    }
    Ok(())
}

fn compute_event_digest(event: &AuthorityEvent) -> Result<String, String> {
    let body = match event {
        AuthorityEvent::Issue {
            version,
            sequence,
            previous_event_digest,
            verification_id,
            request_digest,
            signature,
            ..
        } => AuthorityEventDigestBody::Issue {
            version: *version,
            sequence: *sequence,
            previous_event_digest,
            verification_id,
            request_digest,
            signature,
        },
        AuthorityEvent::Revoke {
            version,
            sequence,
            previous_event_digest,
            verification_id,
            request_digest,
            issue_signature,
            reason,
            revoked_by,
            revoked_at,
            signature,
            ..
        } => AuthorityEventDigestBody::Revoke {
            version: *version,
            sequence: *sequence,
            previous_event_digest,
            verification_id,
            request_digest,
            issue_signature,
            reason,
            revoked_by,
            revoked_at,
            signature,
        },
    };
    let body_bytes = serde_json::to_vec(&body)
        .map_err(|error| format!("无法序列化签发机构事件摘要正文：{error}"))?;
    let mut digest = Sha256::new();
    digest.update(EVENT_DIGEST_DOMAIN.as_bytes());
    digest.update([0]);
    digest.update(body_bytes);
    Ok(hex_encode(&digest.finalize()))
}

fn event_previous_digest(event: &AuthorityEvent) -> &str {
    match event {
        AuthorityEvent::Issue {
            previous_event_digest,
            ..
        }
        | AuthorityEvent::Revoke {
            previous_event_digest,
            ..
        } => previous_event_digest,
    }
}

fn event_digest_value(event: &AuthorityEvent) -> &str {
    match event {
        AuthorityEvent::Issue { event_digest, .. }
        | AuthorityEvent::Revoke { event_digest, .. } => event_digest,
    }
}

fn event_chain_hmac(event: &AuthorityEvent) -> &str {
    match event {
        AuthorityEvent::Issue { chain_hmac, .. } | AuthorityEvent::Revoke { chain_hmac, .. } => {
            chain_hmac
        }
    }
}

fn event_file_name(event: &AuthorityEvent) -> String {
    let (verification_id, kind) = match event {
        AuthorityEvent::Issue {
            verification_id, ..
        } => (verification_id, "issue"),
        AuthorityEvent::Revoke {
            verification_id, ..
        } => (verification_id, "revoke"),
    };
    let safe_id: String = verification_id
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .take(64)
        .collect();
    format!("{:020}-{safe_id}-{kind}.json", event_sequence(event))
}

fn validate_registry_text(label: &str, value: &str) -> Result<(), String> {
    validate_bounded_text(label, value)
        .map_err(|error| authority_corruption(&format!("事件字段无效：{error}")))
}

fn validate_registry_digest(label: &str, value: &str) -> Result<(), String> {
    validate_sha256_digest(label, value)
        .map_err(|error| authority_corruption(&format!("事件摘要字段无效：{error}")))
}

fn validate_registry_hex(label: &str, value: &str) -> Result<(), String> {
    validate_hex(label, value, 64)
        .map_err(|error| authority_corruption(&format!("事件签名字段无效：{error}")))
}

fn authority_corruption(detail: &str) -> String {
    format!("人工验证签发机构已损坏或发生回滚（{detail}）；为避免恢复失效凭据，所有验证均已阻断。")
}

fn marker_hmac_message(key_id: &str, legacy_v1_quarantined: bool) -> String {
    format!(
        "{MARKER_DOMAIN}\0{AUTHORITY_HEAD_VERSION}\0{key_id}\0{}",
        u8::from(legacy_v1_quarantined)
    )
}

fn head_hmac_message(sequence: u64, event_digest: &str, legacy_v1_quarantined: bool) -> String {
    format!(
        "{HEAD_DOMAIN}\0{AUTHORITY_HEAD_VERSION}\0{sequence}\0{event_digest}\0{}",
        u8::from(legacy_v1_quarantined)
    )
}

fn event_chain_hmac_message(sequence: u64, previous_digest: &str, digest: &str) -> String {
    format!(
        "{EVENT_CHAIN_DOMAIN}\0{AUTHORITY_EVENT_VERSION}\0{sequence}\0{previous_digest}\0{digest}"
    )
}

fn write_atomic_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "人工验证持久化路径缺少父目录。".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("无法创建人工验证持久化目录：{error}"))?;
    let temp_path = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("event"),
        random_hex(8)?
    ));
    let write_result = (|| -> Result<(), String> {
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temp_path)
            .map_err(|error| format!("无法创建人工验证临时文件：{error}"))?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| format!("无法同步人工验证临时文件：{error}"))?;
        atomic_move_new_file(&temp_path, path)?;
        sync_parent_directory(path)
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    write_result
}

fn write_atomic_replace(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "人工验证替换路径缺少父目录。".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("无法创建人工验证持久化目录：{error}"))?;
    let temp_path = parent.join(format!(
        ".{}.{}.replace.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("durable-head"),
        random_hex(8)?
    ));
    let result = (|| -> Result<(), String> {
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temp_path)
            .map_err(|error| format!("无法创建持久头替换文件：{error}"))?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| format!("无法同步持久头替换文件：{error}"))?;
        atomic_replace_file(&temp_path, path)?;
        sync_parent_directory(path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    result
}

#[cfg(windows)]
fn atomic_move_new_file(source: &Path, destination: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_WRITE_THROUGH};

    let source_wide: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination_wide: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    // SAFETY: Both paths are NUL-terminated UTF-16 buffers kept alive for the call.
    let result = unsafe {
        MoveFileExW(
            source_wide.as_ptr(),
            destination_wide.as_ptr(),
            MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        return Err(format!(
            "无法原子创建新的人工验证记录：{}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
fn atomic_move_new_file(source: &Path, destination: &Path) -> Result<(), String> {
    fs::hard_link(source, destination)
        .map_err(|error| format!("无法原子创建新的人工验证记录：{error}"))?;
    fs::remove_file(source).map_err(|error| format!("无法删除人工验证硬链接临时文件：{error}"))
}

#[cfg(windows)]
fn atomic_replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source_wide: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination_wide: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    // SAFETY: Both paths are NUL-terminated UTF-16 buffers kept alive for the call.
    let result = unsafe {
        MoveFileExW(
            source_wide.as_ptr(),
            destination_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        return Err(format!(
            "无法原子替换人工验证持久头：{}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
fn atomic_replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    fs::rename(source, destination).map_err(|error| format!("无法原子替换人工验证持久头：{error}"))
}

#[cfg(unix)]
fn sync_parent_directory(path: &Path) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "人工验证路径缺少父目录。".to_string())?;
    File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("无法同步人工验证目录：{error}"))
}

#[cfg(not(unix))]
fn sync_parent_directory(_path: &Path) -> Result<(), String> {
    // MOVEFILE_WRITE_THROUGH protects replacement ordering on Windows. If journal deletion is
    // interrupted, the signed journal remains and recovery deterministically completes forward.
    Ok(())
}

fn next_sequence(events: &[AuthorityEvent]) -> Result<u64, String> {
    events
        .last()
        .map(event_sequence)
        .unwrap_or(0)
        .checked_add(1)
        .ok_or_else(|| "人工验证注册表序号已经溢出。".to_string())
}

fn event_sequence(event: &AuthorityEvent) -> u64 {
    match event {
        AuthorityEvent::Issue { sequence, .. } | AuthorityEvent::Revoke { sequence, .. } => {
            *sequence
        }
    }
}

fn event_version(event: &AuthorityEvent) -> u8 {
    match event {
        AuthorityEvent::Issue { version, .. } | AuthorityEvent::Revoke { version, .. } => *version,
    }
}

fn issue_signature_message(verification_id: &str, sequence: u64, request_digest: &str) -> String {
    format!("{ISSUE_DOMAIN}\0{verification_id}\0{sequence}\0{request_digest}")
}

fn revocation_signature_message(
    sequence: u64,
    request: &RevokeManualVerificationRequest,
) -> String {
    revocation_signature_message_fields(
        sequence,
        &request.verification_id,
        &request.request_digest,
        &request.reason,
        &request.revoked_by,
        &request.revoked_at,
    )
}

fn revocation_signature_message_fields(
    sequence: u64,
    verification_id: &str,
    request_digest: &str,
    reason: &str,
    revoked_by: &str,
    revoked_at: &str,
) -> String {
    format!(
        "{REVOCATION_DOMAIN}\0{}\0{}\0{}\0{}\0{}\0{}",
        verification_id, sequence, request_digest, reason, revoked_by, revoked_at
    )
}

fn digest_payload(payload: &str) -> String {
    format!("sha256:{}", sha256_hex(payload.as_bytes()))
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex_encode(&Sha256::digest(bytes))
}

fn hmac_sha256_hex(key: &[u8; 32], message: &[u8]) -> String {
    let mut inner_pad = [0x36_u8; 64];
    let mut outer_pad = [0x5c_u8; 64];
    for (index, byte) in key.iter().enumerate() {
        inner_pad[index] ^= byte;
        outer_pad[index] ^= byte;
    }
    let mut inner = Sha256::new();
    inner.update(inner_pad);
    inner.update(message);
    let inner_digest = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(outer_pad);
    outer.update(inner_digest);
    hex_encode(&outer.finalize())
}

fn random_hex(byte_count: usize) -> Result<String, String> {
    let mut bytes = vec![0_u8; byte_count];
    getrandom::fill(&mut bytes).map_err(|error| format!("系统随机数生成失败：{error}"))?;
    Ok(hex_encode(&bytes))
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(char::from(HEX[(byte >> 4) as usize]));
        output.push(char::from(HEX[(byte & 0x0f) as usize]));
    }
    output
}

fn decode_fixed_hex<const N: usize>(value: &str, label: &str) -> Result<[u8; N], String> {
    if value.len() != N * 2 {
        return Err(format!("{label}长度无效。"));
    }
    let mut output = [0_u8; N];
    for (index, pair) in value.as_bytes().chunks_exact(2).enumerate() {
        output[index] =
            (hex_value(pair[0]).ok_or_else(|| format!("{label}包含非十六进制字符。"))? << 4)
                | hex_value(pair[1]).ok_or_else(|| format!("{label}包含非十六进制字符。"))?;
    }
    Ok(output)
}

fn hex_value(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        _ => None,
    }
}

fn constant_time_hex_eq(left: &str, right: &str) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.as_bytes()
        .iter()
        .zip(right.as_bytes())
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

fn validate_bounded_text(label: &str, value: &str) -> Result<(), String> {
    if value.trim().is_empty() || value.len() > 512 {
        return Err(format!("人工验证字段 {label} 必须是 1 到 512 个字符。"));
    }
    Ok(())
}

fn validate_sha256_digest(label: &str, value: &str) -> Result<(), String> {
    if !value.starts_with("sha256:") || validate_hex(label, &value[7..], 64).is_err() {
        return Err(format!("人工验证字段 {label} 不是规范 SHA-256 摘要。"));
    }
    Ok(())
}

fn validate_hex(label: &str, value: &str, length: usize) -> Result<(), String> {
    if value.len() != length
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(format!(
            "人工验证字段 {label} 不是 {length} 位小写十六进制。"
        ));
    }
    Ok(())
}

fn is_bounded_string(value: &Value, minimum: usize, maximum: usize) -> bool {
    value
        .as_str()
        .is_some_and(|text| text.trim().len() >= minimum && text.len() <= maximum)
}

fn is_sha256_digest_value(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|text| validate_sha256_digest("digest", text).is_ok())
}

fn is_content_identity_array(value: &Value) -> bool {
    value.as_array().is_some_and(|fields| {
        fields.len() == 6
            && is_bounded_string(&fields[0], 1, 128)
            && fields[1].as_u64().is_some()
            && fields[2].as_u64().is_some()
            && is_bounded_string(&fields[3], 1, 256)
            && is_bounded_string(&fields[4], 1, 256)
            && is_bounded_string(&fields[5], 1, 256)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn issued_record_survives_reload_and_payload_tampering_fails_closed() {
        let root = test_root("issue-verify");
        let request = issue_request("map-1");
        let seal = issue_at(&root, request).unwrap();
        let active = verify_at(&root, verify_request(&seal, "map-1")).unwrap();
        assert_eq!(active.status, "active");

        let tampered = verify_at(&root, verify_request(&seal, "map-2")).unwrap();
        assert_eq!(tampered.status, "invalid");
        assert!(tampered.reason.contains("摘要"));
        assert_no_temp_files(&root);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn revoke_is_durable_idempotent_and_cannot_be_reactivated_by_project_record() {
        let root = test_root("revoke");
        let seal = issue_at(&root, issue_request("map-1")).unwrap();
        let request = RevokeManualVerificationRequest {
            verification_id: seal.verification_id.clone(),
            issuer_key_id: seal.issuer_key_id.clone(),
            signature: seal.signature.clone(),
            request_digest: seal.request_digest.clone(),
            reason: "边界复核失败".to_string(),
            revoked_by: "reviewer-1".to_string(),
            revoked_at: "2026-07-12T00:00:00.000Z".to_string(),
        };
        let first = revoke_at(&root, clone_revocation_request(&request)).unwrap();
        let repeated = revoke_at(&root, request).unwrap();
        assert_eq!(first.signature, repeated.signature);

        let result = verify_at(&root, verify_request(&seal, "map-1")).unwrap();
        assert_eq!(result.status, "revoked");
        assert!(result.reason.contains("不能恢复"));
        assert_no_temp_files(&root);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn another_installation_or_lost_key_never_trusts_existing_project_signature() {
        let first_root = test_root("first-install");
        let second_root = test_root("second-install");
        let seal = issue_at(&first_root, issue_request("map-1")).unwrap();
        let result = verify_at(&second_root, verify_request(&seal, "map-1")).unwrap();
        assert_eq!(result.status, "unknown");
        assert!(result.reason.contains("另一安装"));
        fs::remove_file(first_root.join("authority-key-v1.json")).unwrap();
        let lost_key_result = verify_at(&first_root, verify_request(&seal, "map-1")).unwrap();
        assert_eq!(lost_key_result.status, "unknown");
        assert!(lost_key_result.reason.contains("密钥已丢失"));
        fs::remove_dir_all(first_root).unwrap();
        fs::remove_dir_all(second_root).unwrap();
    }

    #[test]
    fn corrupted_registry_blocks_all_verification_instead_of_ignoring_revocations() {
        let root = test_root("corrupt-registry");
        let seal = issue_at(&root, issue_request("map-1")).unwrap();
        let events = root.join(EVENTS_V2_DIRECTORY);
        fs::write(
            events.join("99999999999999999999-corrupt-revoke.json"),
            b"{",
        )
        .unwrap();
        let error = verify_at(&root, verify_request(&seal, "map-1")).unwrap_err();
        assert!(error.contains("所有验证均已阻断"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn deleting_tail_revocation_never_reactivates_the_issue() {
        let root = test_root("delete-tail-revoke");
        let seal = issue_at(&root, issue_request("map-1")).unwrap();
        revoke_at(&root, revocation_request(&seal)).unwrap();
        let paths = v2_event_paths(&root);
        assert_eq!(paths.len(), 2);
        fs::remove_file(paths.last().unwrap()).unwrap();

        let error = verify_at(&root, verify_request(&seal, "map-1")).unwrap_err();
        assert!(error.contains("事件数量与持久头不一致"));
        assert!(error.contains("所有验证均已阻断"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn deleting_a_middle_event_breaks_the_contiguous_chain() {
        let root = test_root("delete-middle");
        let first = issue_at(&root, issue_request("map-1")).unwrap();
        let _second = issue_at(&root, issue_request("map-2")).unwrap();
        revoke_at(&root, revocation_request(&first)).unwrap();
        let paths = v2_event_paths(&root);
        assert_eq!(paths.len(), 3);
        fs::remove_file(&paths[1]).unwrap();

        let error = verify_at(&root, verify_request(&first, "map-1")).unwrap_err();
        assert!(error.contains("事件数量与持久头不一致"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rolling_back_the_head_while_newer_events_exist_fails_closed() {
        let root = test_root("head-rollback");
        let seal = issue_at(&root, issue_request("map-1")).unwrap();
        let old_head = fs::read(root.join(DURABLE_HEAD_FILE)).unwrap();
        revoke_at(&root, revocation_request(&seal)).unwrap();
        fs::write(root.join(DURABLE_HEAD_FILE), old_head).unwrap();

        let error = verify_at(&root, verify_request(&seal, "map-1")).unwrap_err();
        assert!(error.contains("事件数量与持久头不一致"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn replacing_a_signed_event_or_damaging_the_head_fails_closed() {
        let replacement_root = test_root("event-replacement");
        let replacement_seal = issue_at(&replacement_root, issue_request("map-1")).unwrap();
        let event_path = v2_event_paths(&replacement_root).remove(0);
        let mut event_value: Value =
            serde_json::from_slice(&fs::read(&event_path).unwrap()).unwrap();
        event_value["requestDigest"] = Value::String(format!("sha256:{}", "9".repeat(64)));
        fs::write(&event_path, serde_json::to_vec(&event_value).unwrap()).unwrap();
        let replacement_error = verify_at(
            &replacement_root,
            verify_request(&replacement_seal, "map-1"),
        )
        .unwrap_err();
        assert!(replacement_error.contains("事件摘要无效"));
        fs::remove_dir_all(replacement_root).unwrap();

        let head_root = test_root("damaged-head");
        let head_seal = issue_at(&head_root, issue_request("map-1")).unwrap();
        fs::write(head_root.join(DURABLE_HEAD_FILE), b"{").unwrap();
        let head_error = verify_at(&head_root, verify_request(&head_seal, "map-1")).unwrap_err();
        assert!(head_error.contains("持久头已损坏"));
        fs::remove_dir_all(head_root).unwrap();
    }

    #[test]
    fn pending_revoke_recovers_forward_at_every_append_crash_boundary() {
        for phase in 0..3 {
            let root = test_root(&format!("pending-revoke-{phase}"));
            let seal = issue_at(&root, issue_request("map-1")).unwrap();
            let key = read_authority_key(&root.join("authority-key-v1.json")).unwrap();
            let secret = decode_fixed_hex::<32>(&key.secret_hex, "test secret").unwrap();
            let ledger = load_ledger(&root, &key).unwrap();
            let request = revocation_request(&seal);
            let sequence = next_sequence(&ledger.events).unwrap();
            let signature = hmac_sha256_hex(
                &secret,
                revocation_signature_message(sequence, &request).as_bytes(),
            );
            let event = seal_event_chain(
                AuthorityEvent::Revoke {
                    version: AUTHORITY_EVENT_VERSION,
                    sequence,
                    previous_event_digest: ledger.head.event_digest.clone(),
                    verification_id: request.verification_id,
                    request_digest: request.request_digest,
                    issue_signature: request.signature,
                    reason: request.reason,
                    revoked_by: request.revoked_by,
                    revoked_at: request.revoked_at,
                    signature,
                    event_digest: String::new(),
                    chain_hmac: String::new(),
                },
                &secret,
            )
            .unwrap();
            let next_head = create_head(
                sequence,
                event_digest_value(&event),
                ledger.head.legacy_v1_quarantined,
                &secret,
            );
            let pending = PendingAuthorityCommit {
                version: AUTHORITY_EVENT_VERSION,
                previous_head: ledger.head,
                event: event.clone(),
                next_head: next_head.clone(),
            };
            write_atomic_new(
                &root.join(PENDING_COMMIT_FILE),
                &serde_json::to_vec(&pending).unwrap(),
            )
            .unwrap();
            if phase >= 1 {
                write_atomic_new(
                    &root.join(EVENTS_V2_DIRECTORY).join(event_file_name(&event)),
                    &serde_json::to_vec(&event).unwrap(),
                )
                .unwrap();
            }
            if phase >= 2 {
                write_atomic_replace(
                    &root.join(DURABLE_HEAD_FILE),
                    &serde_json::to_vec(&next_head).unwrap(),
                )
                .unwrap();
            }

            let result = verify_at(&root, verify_request(&seal, "map-1")).unwrap();
            assert_eq!(result.status, "revoked");
            assert!(!root.join(PENDING_COMMIT_FILE).exists());
            assert_eq!(v2_event_paths(&root).len(), 2);
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn legacy_v1_history_without_a_head_is_quarantined_not_trusted() {
        let root = test_root("legacy-v1-quarantine");
        let key = load_or_create_authority_key(&root).unwrap();
        let secret = decode_fixed_hex::<32>(&key.secret_hex, "test secret").unwrap();
        let verification_id = "0123456789abcdef0123456789abcdef".to_string();
        let payload = payload("map-1");
        let request_digest = digest_payload(&payload);
        let signature = hmac_sha256_hex(
            &secret,
            issue_signature_message(&verification_id, 1, &request_digest).as_bytes(),
        );
        let legacy_dir = root.join(LEGACY_EVENTS_V1_DIRECTORY);
        fs::create_dir_all(&legacy_dir).unwrap();
        fs::write(
            legacy_dir.join("00000000000000000001-legacy-issue.json"),
            serde_json::to_vec(&serde_json::json!({
                "eventType": "issue",
                "version": 1,
                "sequence": 1,
                "verificationId": verification_id,
                "requestDigest": request_digest,
                "signature": signature
            }))
            .unwrap(),
        )
        .unwrap();
        let result = verify_at(
            &root,
            VerifyManualVerificationRequest {
                verification_id,
                issuer_key_id: key.key_id,
                signature,
                request_payload: payload,
                request_digest,
            },
        )
        .unwrap();
        assert_eq!(result.status, "unknown");
        let head: AuthorityDurableHead =
            serde_json::from_slice(&fs::read(root.join(DURABLE_HEAD_FILE)).unwrap()).unwrap();
        assert_eq!(head.sequence, 0);
        assert!(head.legacy_v1_quarantined);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn hmac_sha256_matches_known_vector() {
        assert_eq!(
            hmac_sha256_hex(&[0x0b; 32], b"Hi There"),
            "198a607eb44bfbc69903a0f1cf2bbdc5ba0aa3f3d9ae3c1c7a3b1696a0b68cf7"
        );
    }

    fn issue_request(map_id: &str) -> IssueManualVerificationRequest {
        let payload = payload(map_id);
        IssueManualVerificationRequest {
            request_digest: digest_payload(&payload),
            request_payload: payload,
        }
    }

    fn verify_request(
        seal: &ManualVerificationSeal,
        map_id: &str,
    ) -> VerifyManualVerificationRequest {
        VerifyManualVerificationRequest {
            verification_id: seal.verification_id.clone(),
            issuer_key_id: seal.issuer_key_id.clone(),
            signature: seal.signature.clone(),
            request_payload: payload(map_id),
            request_digest: seal.request_digest.clone(),
        }
    }

    fn payload(map_id: &str) -> String {
        serde_json::json!([
            "manual-time-map-verification-request-v1",
            "manual-review",
            map_id,
            1,
            format!("sha256:{}", "1".repeat(64)),
            ["sha256-full-file-v2", 1000, 100, "1", "2", "3"],
            ["sha256-full-file-v2", 2000, 200, "4", "5", "6"],
            "manual-a-b-review",
            "1",
            format!("sha256:{}", "2".repeat(64)),
            "reviewer-1",
            "2026-07-12T00:00:00.000Z"
        ])
        .to_string()
    }

    fn revocation_request(seal: &ManualVerificationSeal) -> RevokeManualVerificationRequest {
        RevokeManualVerificationRequest {
            verification_id: seal.verification_id.clone(),
            issuer_key_id: seal.issuer_key_id.clone(),
            signature: seal.signature.clone(),
            request_digest: seal.request_digest.clone(),
            reason: "boundary review failed".to_string(),
            revoked_by: "reviewer-1".to_string(),
            revoked_at: "2026-07-12T00:00:00.000Z".to_string(),
        }
    }

    fn v2_event_paths(root: &Path) -> Vec<PathBuf> {
        let mut paths = fs::read_dir(root.join(EVENTS_V2_DIRECTORY))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect::<Vec<_>>();
        paths.sort();
        paths
    }

    fn clone_revocation_request(
        request: &RevokeManualVerificationRequest,
    ) -> RevokeManualVerificationRequest {
        RevokeManualVerificationRequest {
            verification_id: request.verification_id.clone(),
            issuer_key_id: request.issuer_key_id.clone(),
            signature: request.signature.clone(),
            request_digest: request.request_digest.clone(),
            reason: request.reason.clone(),
            revoked_by: request.revoked_by.clone(),
            revoked_at: request.revoked_at.clone(),
        }
    }

    fn test_root(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "danmaku-manual-verification-{label}-{}-{nonce}",
            std::process::id()
        ))
    }

    fn assert_no_temp_files(root: &Path) {
        let mut pending = vec![root.to_path_buf()];
        while let Some(directory) = pending.pop() {
            for entry in fs::read_dir(directory).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    pending.push(path);
                } else {
                    assert_ne!(
                        path.extension().and_then(|extension| extension.to_str()),
                        Some("tmp")
                    );
                }
            }
        }
    }
}
