use ring::signature::{Ed25519KeyPair, KeyPair};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::File,
    io::Read,
    sync::{Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

const SCHEMA_VERSION: u32 = 1;
const SIGNATURE_ALGORITHM: &str = "Ed25519";
const MAX_SESSIONS: usize = 4;
const MAX_RUNS_PER_SESSION: usize = 256;
const BLIND_BATCH_KIND: &str = "blind-batch-receipt";
const PERFORMANCE_KIND: &str = "performance-raw-evidence";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct C137ProcessSignedEnvelope<T> {
    pub payload: T,
    pub signature_algorithm: &'static str,
    pub signature: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct C137ProcessOpeningPayload {
    pub schema_version: u32,
    pub kind: &'static str,
    pub session_id: String,
    pub challenge_digest: String,
    pub authority_nonce: String,
    pub process_id: u32,
    pub process_start_file_time_utc: String,
    pub native_executable_digest: String,
    pub ephemeral_public_key: String,
    pub ephemeral_key_id: String,
    pub opened_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct C137ProcessEvidenceBinding {
    pub evidence_kind: String,
    pub native_run_id: String,
    pub evidence_digest: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct C137ProcessFinalizationPayload {
    pub schema_version: u32,
    pub kind: &'static str,
    pub session_id: String,
    pub challenge_digest: String,
    pub opening_digest: String,
    pub process_id: u32,
    pub process_start_file_time_utc: String,
    pub native_executable_digest: String,
    pub sealed_evidence: Vec<C137ProcessEvidenceBinding>,
    pub sealed_evidence_digest: String,
    pub dynamic_evidence_binding_digest: String,
    pub finalized_at_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct C137ProcessAttestationReceipt {
    pub schema_version: u32,
    pub kind: &'static str,
    pub opening: C137ProcessSignedEnvelope<C137ProcessOpeningPayload>,
    pub finalization: C137ProcessSignedEnvelope<C137ProcessFinalizationPayload>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BeginC137ProcessAttestationRequest {
    pub challenge_digest: String,
    pub authority_nonce: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SealC137ProcessEvidenceRequest {
    pub session_id: String,
    pub native_run_id: String,
    pub evidence_digest: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FinalizeC137ProcessAttestationRequest {
    pub session_id: String,
    pub dynamic_evidence_binding_digest: String,
}

struct ProcessAttestationSession {
    private_key_pkcs8: Vec<u8>,
    opening: C137ProcessSignedEnvelope<C137ProcessOpeningPayload>,
    started_runs: HashMap<(String, String), ProcessRunState>,
    sealed_evidence: Vec<C137ProcessEvidenceBinding>,
    finalized: bool,
    #[cfg(test)]
    owner_thread: std::thread::ThreadId,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProcessRunState {
    Started,
    Terminal,
    Sealed,
}

static PROCESS_ATTESTATION_SESSIONS: OnceLock<Mutex<HashMap<String, ProcessAttestationSession>>> =
    OnceLock::new();

fn sessions() -> &'static Mutex<HashMap<String, ProcessAttestationSession>> {
    PROCESS_ATTESTATION_SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[tauri::command]
pub fn begin_c137_process_attestation(
    request: BeginC137ProcessAttestationRequest,
) -> Result<C137ProcessSignedEnvelope<C137ProcessOpeningPayload>, String> {
    validate_digest(&request.challenge_digest, "challengeDigest")?;
    validate_nonce(&request.authority_nonce)?;
    let mut state = sessions()
        .lock()
        .map_err(|_| "C137 进程证明状态锁已损坏。".to_string())?;
    if state.values().any(|session| {
        !session.finalized && {
            #[cfg(test)]
            {
                session.owner_thread == std::thread::current().id()
            }
            #[cfg(not(test))]
            {
                true
            }
        }
    }) {
        return Err("已有未完成的 C137 进程证明会话。".to_string());
    }
    prune_sessions(&mut state);
    if state.len() >= MAX_SESSIONS {
        return Err("C137 进程证明终态会话达到保留上限。".to_string());
    }

    let random = ring::rand::SystemRandom::new();
    let key = Ed25519KeyPair::generate_pkcs8(&random)
        .map_err(|_| "无法生成 C137 进程证明临时密钥。".to_string())?;
    let key_pair = Ed25519KeyPair::from_pkcs8(key.as_ref())
        .map_err(|_| "无法载入 C137 进程证明临时密钥。".to_string())?;
    let public_key = base64_url_encode(key_pair.public_key().as_ref());
    let ephemeral_key_id = canonical_digest(&serde_json::json!({
        "domain": "c137-live-process-ephemeral-key-v1",
        "publicKey": public_key
    }))?;
    let session_id = random_identifier("live-process")?;
    let opening_payload = C137ProcessOpeningPayload {
        schema_version: SCHEMA_VERSION,
        kind: "c137-live-process-opening",
        session_id: session_id.clone(),
        challenge_digest: request.challenge_digest,
        authority_nonce: request.authority_nonce,
        process_id: std::process::id(),
        process_start_file_time_utc: current_process_start_file_time_utc()?,
        native_executable_digest: current_executable_digest()?,
        ephemeral_public_key: public_key,
        ephemeral_key_id,
        opened_at_ms: current_time_ms(),
    };
    let opening = sign_envelope(opening_payload, &key_pair)?;
    state.insert(
        session_id,
        ProcessAttestationSession {
            private_key_pkcs8: key.as_ref().to_vec(),
            opening: opening.clone(),
            started_runs: HashMap::new(),
            sealed_evidence: Vec::new(),
            finalized: false,
            #[cfg(test)]
            owner_thread: std::thread::current().id(),
        },
    );
    Ok(opening)
}

#[tauri::command]
pub fn finalize_c137_process_attestation(
    request: FinalizeC137ProcessAttestationRequest,
) -> Result<C137ProcessAttestationReceipt, String> {
    validate_identifier(&request.session_id, "sessionId")?;
    validate_digest(
        &request.dynamic_evidence_binding_digest,
        "dynamicEvidenceBindingDigest",
    )?;
    let mut state = sessions()
        .lock()
        .map_err(|_| "C137 进程证明状态锁已损坏。".to_string())?;
    let session = state
        .get_mut(&request.session_id)
        .ok_or_else(|| "未找到 C137 进程证明会话。".to_string())?;
    if session.finalized {
        return Err("C137 进程证明会话已经终结，禁止重放。".to_string());
    }
    if session.sealed_evidence.is_empty() {
        return Err("C137 进程证明没有封存任何动态原生证据。".to_string());
    }
    if session
        .started_runs
        .values()
        .any(|state| *state != ProcessRunState::Sealed)
    {
        return Err("C137 进程证明仍有已启动但未封存的原生运行。".to_string());
    }
    let mut sealed_evidence = session.sealed_evidence.clone();
    sealed_evidence.sort_by(|left, right| {
        left.evidence_kind
            .cmp(&right.evidence_kind)
            .then(left.native_run_id.cmp(&right.native_run_id))
    });
    let opening_digest = canonical_digest(&session.opening.payload)?;
    let sealed_evidence_digest = canonical_digest(&sealed_evidence)?;
    let opening = &session.opening.payload;
    let finalization_payload = C137ProcessFinalizationPayload {
        schema_version: SCHEMA_VERSION,
        kind: "c137-live-process-finalization",
        session_id: request.session_id.clone(),
        challenge_digest: opening.challenge_digest.clone(),
        opening_digest,
        process_id: opening.process_id,
        process_start_file_time_utc: opening.process_start_file_time_utc.clone(),
        native_executable_digest: opening.native_executable_digest.clone(),
        sealed_evidence,
        sealed_evidence_digest,
        dynamic_evidence_binding_digest: request.dynamic_evidence_binding_digest,
        finalized_at_ms: current_time_ms(),
    };
    let key_pair = Ed25519KeyPair::from_pkcs8(&session.private_key_pkcs8)
        .map_err(|_| "C137 进程证明临时密钥已损坏。".to_string())?;
    let finalization = sign_envelope(finalization_payload, &key_pair)?;
    session.finalized = true;
    Ok(C137ProcessAttestationReceipt {
        schema_version: SCHEMA_VERSION,
        kind: "c137-live-process-attestation",
        opening: session.opening.clone(),
        finalization,
    })
}

pub fn record_blind_batch_started(native_run_id: &str) -> Result<(), String> {
    record_run_started(BLIND_BATCH_KIND, native_run_id)
}

pub fn record_performance_session_started(native_run_id: &str) -> Result<(), String> {
    record_run_started(PERFORMANCE_KIND, native_run_id)
}

pub fn record_blind_batch_terminal(native_run_id: &str) -> Result<(), String> {
    record_run_terminal(BLIND_BATCH_KIND, native_run_id)
}

pub fn record_performance_session_terminal(native_run_id: &str) -> Result<(), String> {
    record_run_terminal(PERFORMANCE_KIND, native_run_id)
}

pub fn seal_blind_batch_receipt(
    request: SealC137ProcessEvidenceRequest,
) -> Result<C137ProcessEvidenceBinding, String> {
    seal_evidence(BLIND_BATCH_KIND, request)
}

pub fn seal_performance_raw_evidence(
    request: SealC137ProcessEvidenceRequest,
) -> Result<C137ProcessEvidenceBinding, String> {
    seal_evidence(PERFORMANCE_KIND, request)
}

fn record_run_started(evidence_kind: &str, native_run_id: &str) -> Result<(), String> {
    validate_identifier(native_run_id, "nativeRunId")?;
    let mut state = sessions()
        .lock()
        .map_err(|_| "C137 进程证明状态锁已损坏。".to_string())?;
    let Some(session) = state.values_mut().find(|session| {
        !session.finalized && {
            #[cfg(test)]
            {
                session.owner_thread == std::thread::current().id()
            }
            #[cfg(not(test))]
            {
                true
            }
        }
    }) else {
        return Ok(());
    };
    if session.started_runs.len() >= MAX_RUNS_PER_SESSION {
        return Err("C137 进程证明原生运行数量超过上限。".to_string());
    }
    let key = (evidence_kind.to_string(), native_run_id.to_string());
    if session
        .started_runs
        .insert(key, ProcessRunState::Started)
        .is_some()
    {
        return Err("C137 进程证明检测到重复的原生运行标识。".to_string());
    }
    Ok(())
}

fn record_run_terminal(evidence_kind: &str, native_run_id: &str) -> Result<(), String> {
    validate_identifier(native_run_id, "nativeRunId")?;
    let mut state = sessions()
        .lock()
        .map_err(|_| "C137 进程证明状态锁已损坏。".to_string())?;
    let Some(session) = state.values_mut().find(|session| {
        !session.finalized && {
            #[cfg(test)]
            {
                session.owner_thread == std::thread::current().id()
            }
            #[cfg(not(test))]
            {
                true
            }
        }
    }) else {
        return Ok(());
    };
    let key = (evidence_kind.to_string(), native_run_id.to_string());
    let Some(run_state) = session.started_runs.get_mut(&key) else {
        return Err("C137 进程证明没有记录该原生运行的启动。".to_string());
    };
    if matches!(
        *run_state,
        ProcessRunState::Terminal | ProcessRunState::Sealed
    ) {
        return Ok(());
    }
    *run_state = ProcessRunState::Terminal;
    Ok(())
}

fn seal_evidence(
    evidence_kind: &str,
    request: SealC137ProcessEvidenceRequest,
) -> Result<C137ProcessEvidenceBinding, String> {
    validate_identifier(&request.session_id, "sessionId")?;
    validate_identifier(&request.native_run_id, "nativeRunId")?;
    validate_digest(&request.evidence_digest, "evidenceDigest")?;
    let mut state = sessions()
        .lock()
        .map_err(|_| "C137 进程证明状态锁已损坏。".to_string())?;
    let session = state
        .get_mut(&request.session_id)
        .ok_or_else(|| "未找到 C137 进程证明会话。".to_string())?;
    if session.finalized {
        return Err("C137 进程证明会话已经终结，禁止继续封存。".to_string());
    }
    let key = (evidence_kind.to_string(), request.native_run_id.clone());
    let run_state = session
        .started_runs
        .get_mut(&key)
        .ok_or_else(|| "原生运行不属于该 C137 进程证明会话。".to_string())?;
    if *run_state != ProcessRunState::Terminal {
        return Err("原生运行必须先进入可信终态，且同一运行只能封存一次。".to_string());
    }
    let binding = C137ProcessEvidenceBinding {
        evidence_kind: evidence_kind.to_string(),
        native_run_id: request.native_run_id,
        evidence_digest: request.evidence_digest,
    };
    session.sealed_evidence.push(binding.clone());
    *run_state = ProcessRunState::Sealed;
    Ok(binding)
}

fn sign_envelope<T: Serialize + Clone>(
    payload: T,
    key_pair: &Ed25519KeyPair,
) -> Result<C137ProcessSignedEnvelope<T>, String> {
    let digest = canonical_digest(&payload)?;
    Ok(C137ProcessSignedEnvelope {
        payload,
        signature_algorithm: SIGNATURE_ALGORITHM,
        signature: base64_url_encode(key_pair.sign(digest.as_bytes()).as_ref()),
    })
}

fn canonical_digest<T: Serialize>(value: &T) -> Result<String, String> {
    let value =
        serde_json::to_value(value).map_err(|_| "C137 进程证明内容无法序列化。".to_string())?;
    let canonical = canonical_json(&value)?;
    Ok(format!("sha256:{}", hex_sha256(canonical.as_bytes())))
}

fn canonical_json(value: &serde_json::Value) -> Result<String, String> {
    match value {
        serde_json::Value::Null | serde_json::Value::Bool(_) | serde_json::Value::Number(_) => {
            serde_json::to_string(value).map_err(|_| "canonical JSON 标量序列化失败。".to_string())
        }
        serde_json::Value::String(_) => serde_json::to_string(value)
            .map_err(|_| "canonical JSON 字符串序列化失败。".to_string()),
        serde_json::Value::Array(values) => Ok(format!(
            "[{}]",
            values
                .iter()
                .map(canonical_json)
                .collect::<Result<Vec<_>, _>>()?
                .join(",")
        )),
        serde_json::Value::Object(object) => {
            let mut keys = object.keys().collect::<Vec<_>>();
            keys.sort();
            let fields = keys
                .into_iter()
                .map(|key| {
                    let key_json = serde_json::to_string(key)
                        .map_err(|_| "canonical JSON key 序列化失败。".to_string())?;
                    Ok(format!("{key_json}:{}", canonical_json(&object[key])?))
                })
                .collect::<Result<Vec<_>, String>>()?;
            Ok(format!("{{{}}}", fields.join(",")))
        }
    }
}

fn current_executable_digest() -> Result<String, String> {
    let executable =
        std::env::current_exe().map_err(|_| "无法定位当前 C137 原生可执行文件。".to_string())?;
    let mut reader =
        File::open(executable).map_err(|_| "无法读取当前 C137 原生可执行文件。".to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|_| "当前 C137 原生可执行文件摘要读取失败。".to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!(
        "sha256:{}",
        hasher
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    ))
}

#[cfg(windows)]
fn current_process_start_file_time_utc() -> Result<String, String> {
    use windows_sys::Win32::{
        Foundation::FILETIME,
        System::Threading::{GetCurrentProcess, GetProcessTimes},
    };
    let mut creation = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let mut exit = creation;
    let mut kernel = creation;
    let mut user = creation;
    // SAFETY: all FILETIME pointers are valid and GetCurrentProcess returns a pseudo handle.
    let ok = unsafe {
        GetProcessTimes(
            GetCurrentProcess(),
            &mut creation,
            &mut exit,
            &mut kernel,
            &mut user,
        )
    };
    if ok == 0 {
        return Err("无法读取当前 C137 原生进程启动时间。".to_string());
    }
    Ok((((creation.dwHighDateTime as u64) << 32) | creation.dwLowDateTime as u64).to_string())
}

#[cfg(not(windows))]
fn current_process_start_file_time_utc() -> Result<String, String> {
    Err("C137 live-process attestation 仅支持 Windows。".to_string())
}

fn random_identifier(prefix: &str) -> Result<String, String> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| "无法生成 C137 进程证明随机标识。".to_string())?;
    Ok(format!("{prefix}-{}", hex_bytes(&bytes)))
}

fn current_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or(0)
}

fn prune_sessions(state: &mut HashMap<String, ProcessAttestationSession>) {
    if state.len() < MAX_SESSIONS {
        return;
    }
    if let Some(key) = state
        .iter()
        .find_map(|(key, session)| session.finalized.then(|| key.clone()))
    {
        state.remove(&key);
    }
}

fn validate_digest(value: &str, label: &str) -> Result<(), String> {
    let Some(hex) = value.strip_prefix("sha256:") else {
        return Err(format!("{label} 必须是 canonical SHA-256。"));
    };
    if hex.len() != 64
        || !hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(format!("{label} 必须是 canonical SHA-256。"));
    }
    Ok(())
}

fn validate_identifier(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 160
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
    {
        return Err(format!("{label} 不是 canonical 标识。"));
    }
    Ok(())
}

fn validate_nonce(value: &str) -> Result<(), String> {
    if value.len() != 43
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("authorityNonce 必须是 256-bit base64url。".to_string());
    }
    Ok(())
}

fn hex_sha256(value: &[u8]) -> String {
    hex_bytes(&Sha256::digest(value))
}

fn hex_bytes(value: &[u8]) -> String {
    value
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
}

fn base64_url_encode(value: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut output = String::with_capacity((value.len() * 4).div_ceil(3));
    let mut index = 0;
    while index + 3 <= value.len() {
        let block = ((value[index] as u32) << 16)
            | ((value[index + 1] as u32) << 8)
            | value[index + 2] as u32;
        output.push(TABLE[((block >> 18) & 63) as usize] as char);
        output.push(TABLE[((block >> 12) & 63) as usize] as char);
        output.push(TABLE[((block >> 6) & 63) as usize] as char);
        output.push(TABLE[(block & 63) as usize] as char);
        index += 3;
    }
    match value.len() - index {
        1 => {
            let block = (value[index] as u32) << 16;
            output.push(TABLE[((block >> 18) & 63) as usize] as char);
            output.push(TABLE[((block >> 12) & 63) as usize] as char);
        }
        2 => {
            let block = ((value[index] as u32) << 16) | ((value[index + 1] as u32) << 8);
            output.push(TABLE[((block >> 18) & 63) as usize] as char);
            output.push(TABLE[((block >> 12) & 63) as usize] as char);
            output.push(TABLE[((block >> 6) & 63) as usize] as char);
        }
        _ => {}
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    fn digest(fill: char) -> String {
        format!("sha256:{}", fill.to_string().repeat(64))
    }

    #[test]
    fn process_attestation_requires_started_terminal_bindings_and_is_single_use() {
        let opening = begin_c137_process_attestation(BeginC137ProcessAttestationRequest {
            challenge_digest: digest('a'),
            authority_nonce: "A".repeat(43),
        })
        .unwrap();
        let session_id = opening.payload.session_id.clone();
        record_blind_batch_started("batch-1").unwrap();
        assert!(
            finalize_c137_process_attestation(FinalizeC137ProcessAttestationRequest {
                session_id: session_id.clone(),
                dynamic_evidence_binding_digest: digest('b'),
            })
            .is_err()
        );
        record_blind_batch_terminal("batch-1").unwrap();
        let sealed = seal_blind_batch_receipt(SealC137ProcessEvidenceRequest {
            session_id: session_id.clone(),
            native_run_id: "batch-1".to_string(),
            evidence_digest: digest('c'),
        })
        .unwrap();
        assert_eq!(sealed.evidence_kind, BLIND_BATCH_KIND);
        let receipt = finalize_c137_process_attestation(FinalizeC137ProcessAttestationRequest {
            session_id: session_id.clone(),
            dynamic_evidence_binding_digest: digest('b'),
        })
        .unwrap();
        assert_eq!(receipt.finalization.payload.sealed_evidence, vec![sealed]);
        assert!(
            finalize_c137_process_attestation(FinalizeC137ProcessAttestationRequest {
                session_id,
                dynamic_evidence_binding_digest: digest('b'),
            })
            .is_err()
        );
    }

    #[test]
    fn process_attestation_rejects_cross_session_unstarted_and_duplicate_seals() {
        let opening = begin_c137_process_attestation(BeginC137ProcessAttestationRequest {
            challenge_digest: digest('d'),
            authority_nonce: "B".repeat(43),
        })
        .unwrap();
        let session_id = opening.payload.session_id;
        assert!(seal_blind_batch_receipt(SealC137ProcessEvidenceRequest {
            session_id: session_id.clone(),
            native_run_id: "batch-never-started".to_string(),
            evidence_digest: digest('e'),
        })
        .is_err());
        record_performance_session_started("benchmark-1").unwrap();
        record_performance_session_terminal("benchmark-1").unwrap();
        let request = SealC137ProcessEvidenceRequest {
            session_id,
            native_run_id: "benchmark-1".to_string(),
            evidence_digest: digest('f'),
        };
        seal_performance_raw_evidence(SealC137ProcessEvidenceRequest {
            session_id: request.session_id.clone(),
            native_run_id: request.native_run_id.clone(),
            evidence_digest: request.evidence_digest.clone(),
        })
        .unwrap();
        assert!(seal_performance_raw_evidence(request).is_err());
    }
}
