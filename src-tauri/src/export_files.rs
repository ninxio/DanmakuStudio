use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, OpenOptions},
    io::{ErrorKind, Write},
    path::{Component, Path, PathBuf},
    process::Command,
    sync::Arc,
};
use tauri::AppHandle;
pub(crate) mod edited;

use crate::manual_verification::{
    lock_manual_time_map_verification_authority, ManualVerificationAuthorityGuard,
};
use crate::media_probe::{probe_media_content_identity, MediaContentIdentity};
use crate::physical_file::{PhysicalFileObjectKey, PinnedPhysicalFile};
#[cfg(test)]
use crate::xml_import_receipt::{compute_xml_inventory_digest, XML_CONTENT_RECEIPT_DOMAIN};
use crate::xml_import_receipt::{
    verify_xml_content_receipt, XmlContentReceiptV1, XmlImmutableDanmakuItemV1,
};

const VERIFIED_EXPORT_SCHEMA_VERSION: u8 = 3;
const VERIFIED_EXPORT_MANIFEST_DOMAIN: &str = "verified-export-manifest-v3";
const MANUAL_VERIFICATION_REQUEST_DOMAIN: &str = "manual-time-map-verification-request-v1";
const TRUSTED_AUTOMATIC_CALIBRATION_ARTIFACT_ID: &str = "alignment-v2.5-independent-holdout-policy";
const TRUSTED_AUTOMATIC_CALIBRATION_ARTIFACT_VERSION: &str = "1";
const TRUSTED_AUTOMATIC_ENGINE_VERSION: &str = "alignment-v2.5-rust";
const TRUSTED_AUTOMATIC_FEATURE_VERSION: &str =
    "pcm-s16le-16k-pts-tiled-fine-content-window-sequence-reuse-frontier-v25";
const PROJECTION_DERIVATION_DOMAIN: &str = "projection-derivation-v2";
const PROJECTION_POLICY_VERSION: &str = "source-projection-v1";
const PROJECTION_SERIALIZER_VERSION: &str = "bilibili-xml-export-v1";
const MEDIA_TIME_MAP_CORE_DOMAIN: &str = "media-time-map-core-v2";
const MANUAL_TAKEOVER_NOTE_PREFIX: &str = "manual-takeover:v1:";
const MANUAL_SPAN_REVIEW_NOTE_PREFIX: &str = "manual-span-review:v1:";
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_PROJECTION_ASSETS: usize = 4_096;
const MAX_PROJECTION_MEDIA: usize = 8_192;
const MAX_PROJECTION_ROUTES: usize = 65_536;
const MAX_PROJECTION_ITEMS: usize = 500_000;
const MAX_PROJECTION_RAW_P_FIELDS: usize = 64;
const MAX_PROJECTION_RAW_P_BYTES: usize = 16 * 1024;
const MAX_PROJECTION_DANMAKU_TEXT_BYTES: usize = 1024 * 1024;
const MAX_CORE_CANONICAL_JSON_BYTES: usize = 1_048_576;
const MAX_VERIFIED_MANIFEST_JSON_BYTES: usize = 16 * 1024 * 1024;
const MAX_TEXT_REPORT_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveTextReportFileRequest {
    directory_path: String,
    file_name: String,
    content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveVerifiedExportFileRequest {
    directory_path: String,
    file_name: String,
    content_bytes: Vec<u8>,
    verification: VerifiedExportVerification,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VerifiedExportVerification {
    schema_version: u8,
    project_id: String,
    project_updated_at: String,
    manifest_json: String,
    manifest_digest: String,
    project_snapshot_digest: String,
    archive_file_name: String,
    archive_content_digest: String,
    outputs: Vec<VerifiedExportOutput>,
    map_proofs: Vec<VerifiedExportMapProof>,
    dependencies: Vec<VerifiedMediaDependency>,
    projection_derivation: ProjectionDerivationV1,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct VerifiedExportOutput {
    file_name: String,
    content_digest: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct VerifiedExportMapProof {
    map_id: String,
    revision: u64,
    state: String,
    declared_quality: String,
    span_kinds: Vec<String>,
    core_digest: String,
    core_canonical_json: String,
    source_media_id: String,
    target_media_id: String,
    source_identity: ExpectedMediaContentIdentity,
    target_identity: ExpectedMediaContentIdentity,
    #[serde(default)]
    manual_verification: VerifiedExportManualVerification,
    #[serde(default)]
    automatic_verification: Option<VerifiedExportAutomaticVerification>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectionDerivationV1 {
    domain: String,
    projection_policy_version: String,
    serializer_version: String,
    project_id: String,
    project_updated_at: String,
    media: Vec<ProjectionMediaV1>,
    xml_assets: Vec<ProjectionXmlAssetV1>,
    source_bindings: Vec<ProjectionSourceBindingV1>,
    routes: Vec<ProjectionRouteV1>,
    disabled_item_ids: Vec<String>,
    item_time_adjustments: Vec<ProjectionItemTimeAdjustmentV1>,
    target_output_files: Vec<ProjectionTargetOutputV1>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectionMediaV1 {
    media_id: String,
    role: String,
    name: String,
    media_file_name: String,
    duration_ms: Option<u64>,
    episode_label: Option<String>,
    content_identity: Option<ExpectedMediaContentIdentity>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectionXmlAssetV1 {
    asset_id: String,
    source_file_name: String,
    source_receipt: Option<XmlContentReceiptV1>,
    items: Vec<ProjectionDanmakuItemV1>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectionDanmakuItemV1 {
    item_id: String,
    asset_id: String,
    original_index: u64,
    source_time_ms: u64,
    mode: Option<i64>,
    font_size: Option<i64>,
    color: Option<i64>,
    timestamp: Option<i64>,
    pool: Option<i64>,
    user_hash: Option<String>,
    row_id: Option<String>,
    text: String,
    raw_p_fields: Vec<String>,
    enabled: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectionSourceBindingV1 {
    binding_id: String,
    asset_id: String,
    source_media_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectionRouteV1 {
    route_id: String,
    kind: String,
    asset_id: Option<String>,
    source_media_id: Option<String>,
    source_start_ms: u64,
    source_end_ms: u64,
    target_media_id: Option<String>,
    target_start_ms: Option<u64>,
    time_map_id: Option<String>,
    timing_rules: Vec<ProjectionTimingRuleV1>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectionTimingRuleV1 {
    rule_id: String,
    source_at_ms: u64,
    gap_ms: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectionItemTimeAdjustmentV1 {
    item_id: String,
    adjustment_ms: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectionTargetOutputV1 {
    #[serde(default)]
    metadata_xml: Option<String>,
    target_media_id: String,
    file_name: String,
}

#[derive(Clone, Debug)]
struct SignedTimeMapCore {
    map_id: String,
    revision: u64,
    source_media_id: String,
    target_media_id: String,
    source_start_ms: u64,
    source_end_ms: u64,
    target_start_ms: u64,
    spans: Vec<SignedTimeMapSpan>,
    manual_takeover_approved: bool,
}

#[derive(Clone, Debug)]
struct SignedTimeMapSpan {
    kind: String,
    source_start_ms: u64,
    source_end_ms: u64,
    target_start_ms: u64,
    target_end_ms: u64,
}

#[derive(Clone, Copy, Debug)]
struct SignedVerifiedGraphQuality {
    unique_content_coverage: Option<f64>,
    held_out_anchor_count: u64,
}

#[derive(Debug)]
struct NativeProjectedEntry<'a> {
    item: &'a ProjectionDanmakuItemV1,
    final_time_ms: u64,
    projection_ordinal: u64,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct VerifiedExportManualVerification {
    verification_id: String,
    issuer_key_id: String,
    signature_algorithm: String,
    signature: String,
    request_payload: String,
    request_digest: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct VerifiedExportAutomaticVerification {
    calibration_artifact_id: String,
    calibration_artifact_version: String,
    verifier: String,
    verified_at: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum VerifiedExportProofMethod {
    Manual,
    Automatic,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VerifiedMediaDependency {
    media_id: String,
    path: String,
    expected_identity: ExpectedMediaContentIdentity,
    #[serde(default)]
    map_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ExpectedMediaContentIdentity {
    algorithm: String,
    size_bytes: u64,
    modified_unix_ms: u64,
    first_sample_digest: String,
    middle_sample_digest: String,
    last_sample_digest: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SaveExportFileResult {
    file_name: String,
    file_path: String,
    directory_path: String,
    was_renamed: bool,
}

#[tauri::command]
pub fn save_text_report_file(
    request: SaveTextReportFileRequest,
) -> Result<SaveExportFileResult, String> {
    let directory = validate_export_directory(&request.directory_path)?;
    let file_name = validate_text_report_file_name(&request.file_name)?;
    if request.content.len() > MAX_TEXT_REPORT_BYTES {
        return Err(format!(
            "文本报告超过 {} MiB 上限，已拒绝写入。",
            MAX_TEXT_REPORT_BYTES / (1024 * 1024)
        ));
    }
    write_export_file(&directory, &file_name, request.content.as_bytes())
}

/// Saves a time-map-derived export only after re-reading every dependent media identity.
///
/// Keeping verification and the write in one backend command closes the UI/preflight gap: a
/// browser fallback or an unavailable verification bridge can never silently become approval.
#[tauri::command]
pub fn save_verified_projected_xml_export(
    app: AppHandle,
    request: SaveVerifiedExportFileRequest,
) -> Result<SaveExportFileResult, String> {
    let authority = lock_manual_time_map_verification_authority(&app)?;
    verify_projection_xml_receipts(
        &app,
        &authority,
        &request.verification.projection_derivation,
    )?;
    save_verified_projected_xml_export_with_authority(request, |proof| {
        if proof.automatic_verification.is_some() {
            return Ok(());
        }
        let manual = &proof.manual_verification;
        authority.require_active(
            &manual.verification_id,
            &manual.issuer_key_id,
            &manual.signature,
            &manual.request_payload,
            &manual.request_digest,
        )
    })
}

fn verify_projection_xml_receipts(
    app: &AppHandle,
    authority: &ManualVerificationAuthorityGuard,
    derivation: &ProjectionDerivationV1,
) -> Result<(), String> {
    verify_projection_xml_receipts_with(derivation, |receipt, items| {
        verify_xml_content_receipt(app, authority, receipt, items)
    })
}

fn verify_projection_xml_receipts_with(
    derivation: &ProjectionDerivationV1,
    mut verify_receipt: impl FnMut(
        &XmlContentReceiptV1,
        &[XmlImmutableDanmakuItemV1],
    ) -> Result<(), String>,
) -> Result<(), String> {
    let total_items = derivation
        .xml_assets
        .iter()
        .try_fold(0_usize, |total, asset| {
            total
                .checked_add(asset.items.len())
                .ok_or_else(|| "投影重建 inventory 的弹幕总数溢出。".to_string())
        })?;
    if total_items > MAX_PROJECTION_ITEMS {
        return Err(format!(
            "高精度导出最多处理 {MAX_PROJECTION_ITEMS} 条项目弹幕。"
        ));
    }
    let mut assets_by_id = HashMap::with_capacity(derivation.xml_assets.len());
    for asset in &derivation.xml_assets {
        if assets_by_id
            .insert(asset.asset_id.as_str(), asset)
            .is_some()
        {
            return Err(format!(
                "投影重建 inventory 含重复 XML assetId：{}。",
                asset.asset_id
            ));
        }
    }

    let mut verified_asset_ids = HashSet::new();
    for route in derivation
        .routes
        .iter()
        .filter(|route| route.kind == "content")
    {
        let asset_id = route
            .asset_id
            .as_deref()
            .ok_or_else(|| format!("内容 route {} 缺少 XML assetId。", route.route_id))?;
        if !verified_asset_ids.insert(asset_id) {
            continue;
        }
        let asset = assets_by_id
            .get(asset_id)
            .ok_or_else(|| format!("内容 route {} 引用的 XML 资产不存在。", route.route_id))?;
        let receipt = asset.source_receipt.as_ref().ok_or_else(|| {
            format!(
                "XML 资产 {} 没有桌面原生内容收据；请在素材页重新选择原始 XML。",
                asset.source_file_name
            )
        })?;
        let mut immutable_items = Vec::with_capacity(asset.items.len());
        for (index, item) in asset.items.iter().enumerate() {
            let raw_p_bytes = item.raw_p_fields.iter().try_fold(0_usize, |total, field| {
                total
                    .checked_add(field.len())
                    .ok_or_else(|| "XML 弹幕 p 字段总长度溢出。".to_string())
            })?;
            if item.raw_p_fields.len() > MAX_PROJECTION_RAW_P_FIELDS
                || raw_p_bytes > MAX_PROJECTION_RAW_P_BYTES
                || item.text.len() > MAX_PROJECTION_DANMAKU_TEXT_BYTES
            {
                return Err(format!(
                    "XML 资产 {} 的第 {} 条弹幕超过安全大小上限。",
                    asset.source_file_name, index
                ));
            }
            let original_index =
                u64::try_from(index).map_err(|_| "XML 弹幕序号超过原生导出范围。".to_string())?;
            let expected_item_id = format!("{}_item_{original_index}", asset.asset_id);
            if item.original_index != original_index
                || item.asset_id != asset.asset_id
                || item.item_id != expected_item_id
                || !item.enabled
            {
                return Err(format!(
                    "XML 资产 {} 的第 {} 条弹幕身份或原始启用状态已被修改，已阻断导出。",
                    asset.source_file_name, index
                ));
            }
            immutable_items.push(XmlImmutableDanmakuItemV1 {
                original_index: item.original_index,
                source_time_ms: item.source_time_ms,
                mode: item.mode,
                font_size: item.font_size,
                color: item.color,
                timestamp: item.timestamp,
                pool: item.pool,
                user_hash: item.user_hash.clone(),
                row_id: item.row_id.clone(),
                text: item.text.clone(),
                raw_p_fields: item.raw_p_fields.clone(),
            });
        }
        verify_receipt(receipt, &immutable_items)?;
    }
    Ok(())
}

fn save_verified_projected_xml_export_with_authority<F>(
    request: SaveVerifiedExportFileRequest,
    mut verify_authority: F,
) -> Result<SaveExportFileResult, String>
where
    F: FnMut(&VerifiedExportMapProof) -> Result<(), String>,
{
    let directory = validate_export_directory(&request.directory_path)?;
    let file_name = validate_export_file_name(&request.file_name)?;
    verify_verified_export_envelope(&request, &mut verify_authority)?;
    let dependency_pins = pin_and_verify_export_dependencies(&request.verification)?;
    let result = write_export_file(&directory, &file_name, &request.content_bytes)?;
    for pin in dependency_pins {
        if let Err(error) = pin.verify_handle_and_path() {
            let _ = fs::remove_file(&result.file_path);
            return Err(format!(
                "verified 导出写盘后的媒体 lease 复核失败，已删除本次输出：{error}"
            ));
        }
    }
    Ok(result)
}

fn write_export_file(
    directory: &Path,
    requested_file_name: &str,
    content_bytes: &[u8],
) -> Result<SaveExportFileResult, String> {
    let (base, extension) = split_file_name(requested_file_name);
    for duplicate_number in 1..=9999 {
        let candidate_name = if duplicate_number == 1 {
            requested_file_name.to_string()
        } else {
            format!("{base} ({duplicate_number}){extension}")
        };
        let target = directory.join(&candidate_name);
        let mut file = match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
        {
            Ok(file) => file,
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format_export_write_error(directory, &target, error)),
        };
        if let Err(error) = file.write_all(content_bytes).and_then(|_| file.sync_all()) {
            drop(file);
            let _ = fs::remove_file(&target);
            return Err(format_export_write_error(directory, &target, error));
        }
        return Ok(SaveExportFileResult {
            file_name: candidate_name,
            file_path: target.to_string_lossy().to_string(),
            directory_path: directory.to_string_lossy().to_string(),
            was_renamed: duplicate_number != 1,
        });
    }
    Err("导出文件夹里已有太多同名文件，请更换文件名或清理目录。".to_string())
}

fn pin_and_verify_export_dependencies(
    verification: &VerifiedExportVerification,
) -> Result<Vec<Arc<PinnedPhysicalFile>>, String> {
    let mut pins_by_object = HashMap::<PhysicalFileObjectKey, Arc<PinnedPhysicalFile>>::new();
    for dependency in &verification.dependencies {
        let media_id = dependency.media_id.trim();
        let path = dependency.path.trim();
        if media_id.is_empty() || path.is_empty() || path.contains("://") {
            return Err("导出媒体身份依赖包含无效的本地文件信息，已拒绝写入。".to_string());
        }
        let media_path = Path::new(path);
        if !media_path.is_absolute() || !media_path.is_file() {
            return Err(format!(
                "导出依赖媒体 {media_id} 不存在或不是本地绝对路径，已拒绝写入。"
            ));
        }
        let pin = PinnedPhysicalFile::open(media_path)
            .map_err(|error| format!("导出依赖媒体 {media_id} 无法取得稳定只读 lease：{error}"))?;
        pin.verify_handle_and_path()?;
        let actual = probe_media_content_identity(pin.handle_final_path())
            .map_err(|error| format!("导出依赖媒体 {media_id} 的身份复核失败：{error}"))?;
        if !identity_matches(&dependency.expected_identity, &actual) {
            let map_diagnostic = if dependency.map_ids.is_empty() {
                String::new()
            } else {
                format!("（时间图：{}）", dependency.map_ids.join("、"))
            };
            return Err(format!(
                "导出依赖媒体 {media_id}{map_diagnostic} 已在预检后被替换或修改，已拒绝写入；请重新分析并确认匹配。"
            ));
        }
        pins_by_object.entry(pin.object_key()).or_insert(pin);
    }
    Ok(pins_by_object.into_values().collect())
}

fn verify_verified_export_envelope<F>(
    request: &SaveVerifiedExportFileRequest,
    verify_authority: &mut F,
) -> Result<(), String>
where
    F: FnMut(&VerifiedExportMapProof) -> Result<(), String>,
{
    let verification = &request.verification;
    if verification.schema_version != VERIFIED_EXPORT_SCHEMA_VERSION {
        return Err(format!(
            "高精度导出 schemaVersion 必须为 {VERIFIED_EXPORT_SCHEMA_VERSION}。"
        ));
    }
    for (label, value) in [
        ("projectId", verification.project_id.as_str()),
        ("projectUpdatedAt", verification.project_updated_at.as_str()),
        ("manifestDigest", verification.manifest_digest.as_str()),
        (
            "projectSnapshotDigest",
            verification.project_snapshot_digest.as_str(),
        ),
        ("archiveFileName", verification.archive_file_name.as_str()),
        (
            "archiveContentDigest",
            verification.archive_content_digest.as_str(),
        ),
    ] {
        validate_nonempty_bounded(label, value, 1_048_576)?;
    }
    validate_nonempty_bounded(
        "manifestJson",
        &verification.manifest_json,
        MAX_VERIFIED_MANIFEST_JSON_BYTES,
    )?;
    validate_sha256_digest("manifestDigest", &verification.manifest_digest)?;
    validate_sha256_digest(
        "projectSnapshotDigest",
        &verification.project_snapshot_digest,
    )?;
    validate_sha256_digest("archiveContentDigest", &verification.archive_content_digest)?;
    if request.file_name != verification.archive_file_name {
        return Err("写盘文件名与高精度导出 manifest 不一致。".to_string());
    }
    let actual_archive_digest = sha256_digest(&request.content_bytes);
    if actual_archive_digest != verification.archive_content_digest {
        return Err("待写盘内容 SHA-256 与高精度导出 manifest 不一致。".to_string());
    }
    if verification.outputs.is_empty() {
        return Err("高精度导出 manifest 没有逻辑 XML 输出。".to_string());
    }
    if verification.map_proofs.is_empty() {
        return Err("高精度导出没有携带被引用时间图 proof。".to_string());
    }
    if verification.dependencies.is_empty() {
        return Err("高精度分集导出没有携带媒体身份依赖，已拒绝写入。".to_string());
    }

    validate_projected_export_file_shape(request)?;
    validate_output_content_binding(request)?;
    validate_map_proofs_and_dependencies(verification, verify_authority)?;
    validate_projection_derivation_binding(request)?;

    let canonical_projection = canonical_projection_derivation(&verification.projection_derivation);
    let canonical_projection_json = serde_json::to_string(&canonical_projection)
        .map_err(|error| format!("无法重算项目投影快照：{error}"))?;
    if sha256_digest(canonical_projection_json.as_bytes()) != verification.project_snapshot_digest {
        return Err("项目投影快照 SHA-256 不匹配。".to_string());
    }

    let canonical = canonical_verified_export_manifest(verification)?;
    let canonical_json = serde_json::to_string(&canonical)
        .map_err(|error| format!("无法重算高精度导出 manifest：{error}"))?;
    if canonical_json != verification.manifest_json {
        return Err("高精度导出 manifest 不是固定顺序规范 JSON。".to_string());
    }
    if sha256_digest(canonical_json.as_bytes()) != verification.manifest_digest {
        return Err("高精度导出 manifest SHA-256 不匹配。".to_string());
    }
    Ok(())
}

fn validate_projected_export_file_shape(
    request: &SaveVerifiedExportFileRequest,
) -> Result<(), String> {
    for output in &request.verification.outputs {
        if !has_case_insensitive_extension(&output.file_name, "xml") {
            return Err(format!(
                "高精度投影的逻辑输出必须使用 .xml 扩展名：{}。",
                output.file_name
            ));
        }
    }
    if request.verification.outputs.len() == 1 {
        if !has_case_insensitive_extension(&request.file_name, "xml") {
            return Err("高精度投影的单文件写盘目标必须使用 .xml 扩展名。".to_string());
        }
    } else if !has_case_insensitive_extension(&request.file_name, "zip") {
        return Err("高精度投影的多文件写盘目标必须使用 .zip 扩展名。".to_string());
    }
    Ok(())
}

fn validate_output_content_binding(request: &SaveVerifiedExportFileRequest) -> Result<(), String> {
    let outputs = &request.verification.outputs;
    let mut names = HashSet::new();
    for output in outputs {
        validate_export_file_name(&output.file_name)?;
        validate_sha256_digest("output contentDigest", &output.content_digest)?;
        if !names.insert(output.file_name.to_lowercase()) {
            return Err("高精度导出 manifest 含重复逻辑输出文件名。".to_string());
        }
    }
    if outputs.len() == 1 {
        let output = &outputs[0];
        if request.file_name != output.file_name
            || sha256_digest(&request.content_bytes) != output.content_digest
        {
            return Err("单文件写盘内容与 manifest 逻辑 XML 不一致。".to_string());
        }
        return Ok(());
    }
    let archive_outputs = parse_and_verify_stored_zip(&request.content_bytes)?;
    if archive_outputs.len() != outputs.len() {
        return Err("ZIP 内逻辑 XML 数量与高精度导出 manifest 不一致。".to_string());
    }
    let expected = outputs
        .iter()
        .map(|output| (output.file_name.as_str(), output.content_digest.as_str()))
        .collect::<HashMap<_, _>>();
    for (name, bytes) in archive_outputs {
        let Some(expected_digest) = expected.get(name.as_str()) else {
            return Err(format!("ZIP 含 manifest 未声明的逻辑文件：{name}"));
        };
        if sha256_digest(bytes) != *expected_digest {
            return Err(format!(
                "ZIP 内逻辑文件 {name} 的 SHA-256 与 manifest 不一致。"
            ));
        }
    }
    Ok(())
}

fn validate_map_proofs_and_dependencies<F>(
    verification: &VerifiedExportVerification,
    verify_authority: &mut F,
) -> Result<(), String>
where
    F: FnMut(&VerifiedExportMapProof) -> Result<(), String>,
{
    let mut proofs = HashMap::new();
    for proof in &verification.map_proofs {
        let proof_method = validate_export_proof_method(proof)?;
        validate_nonempty_bounded("mapId", &proof.map_id, 512)?;
        if proof.revision == 0 || proof.state != "confirmed" || proof.declared_quality != "verified"
        {
            return Err(format!(
                "时间图 {} 必须为 confirmed 且 declaredQuality=verified。",
                proof.map_id
            ));
        }
        validate_sha256_digest("map coreDigest", &proof.core_digest)?;
        let signed_core = parse_and_validate_signed_time_map_core_with_method(proof, proof_method)?;
        validate_media_identity_shape(&proof.source_identity)?;
        validate_media_identity_shape(&proof.target_identity)?;
        if proof.span_kinds.is_empty()
            || proof.span_kinds.iter().any(|kind| {
                !matches!(
                    kind.as_str(),
                    "matched" | "sourceOnly" | "targetOnly" | "ambiguous"
                ) || (kind == "ambiguous" && !signed_core.manual_takeover_approved)
            })
        {
            return Err(format!(
                "时间图 {} 没有可导出的 span，或仍含未经人工接管确认的 ambiguous/未知 span。",
                proof.map_id
            ));
        }
        let signed_span_kinds = signed_core
            .spans
            .iter()
            .map(|span| span.kind.as_str())
            .collect::<Vec<_>>();
        let declared_span_kinds = proof
            .span_kinds
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>();
        if signed_span_kinds != declared_span_kinds {
            return Err(format!(
                "时间图 {} 的 spanKinds 与已签核心不一致。",
                proof.map_id
            ));
        }
        match proof_method {
            VerifiedExportProofMethod::Manual => validate_manual_request_binding(proof)?,
            VerifiedExportProofMethod::Automatic => validate_automatic_verification_binding(proof)?,
        }
        if proofs.insert(proof.map_id.as_str(), proof).is_some() {
            return Err("高精度导出含重复时间图 proof。".to_string());
        }
    }

    let mut dependency_by_media = HashMap::new();
    let mut dependency_map_ids = HashSet::new();
    for dependency in &verification.dependencies {
        validate_nonempty_bounded("dependency mediaId", &dependency.media_id, 512)?;
        validate_media_identity_shape(&dependency.expected_identity)?;
        if dependency.map_ids.is_empty() {
            return Err(format!(
                "媒体依赖 {} 没有绑定任何时间图。",
                dependency.media_id
            ));
        }
        let mut local_ids = HashSet::new();
        for map_id in &dependency.map_ids {
            if !local_ids.insert(map_id.as_str()) {
                return Err(format!("媒体依赖 {} 含重复 mapId。", dependency.media_id));
            }
            if !proofs.contains_key(map_id.as_str()) {
                return Err(format!("媒体依赖引用了缺失 proof：{map_id}"));
            }
            dependency_map_ids.insert(map_id.as_str());
        }
        if dependency_by_media
            .insert(dependency.media_id.as_str(), dependency)
            .is_some()
        {
            return Err("高精度导出含重复媒体依赖。".to_string());
        }
    }
    if dependency_map_ids.len() != proofs.len() {
        return Err("时间图 proof 与媒体依赖 mapIds 未形成双向完整绑定。".to_string());
    }

    for proof in verification.map_proofs.iter() {
        let source = dependency_by_media
            .get(proof.source_media_id.as_str())
            .ok_or_else(|| format!("时间图 {} 缺少来源媒体依赖。", proof.map_id))?;
        let target = dependency_by_media
            .get(proof.target_media_id.as_str())
            .ok_or_else(|| format!("时间图 {} 缺少目标媒体依赖。", proof.map_id))?;
        if !source.map_ids.iter().any(|id| id == &proof.map_id)
            || !target.map_ids.iter().any(|id| id == &proof.map_id)
        {
            return Err(format!("时间图 {} 未同时绑定两端媒体依赖。", proof.map_id));
        }
        if !expected_identities_match(&source.expected_identity, &proof.source_identity)
            || !expected_identities_match(&target.expected_identity, &proof.target_identity)
        {
            return Err(format!(
                "时间图 {} 的 proof 身份与媒体依赖不一致。",
                proof.map_id
            ));
        }
        if proof.automatic_verification.is_none() {
            verify_authority(proof)
                .map_err(|error| format!("时间图 {} 的人工验证未获放行：{error}", proof.map_id))?;
        }
    }
    Ok(())
}

fn validate_export_proof_method(
    proof: &VerifiedExportMapProof,
) -> Result<VerifiedExportProofMethod, String> {
    let manual = &proof.manual_verification;
    let has_manual = !manual.verification_id.is_empty()
        || !manual.issuer_key_id.is_empty()
        || !manual.signature_algorithm.is_empty()
        || !manual.signature.is_empty()
        || !manual.request_payload.is_empty()
        || !manual.request_digest.is_empty();
    match (has_manual, proof.automatic_verification.is_some()) {
        (true, false) => Ok(VerifiedExportProofMethod::Manual),
        (false, true) => Ok(VerifiedExportProofMethod::Automatic),
        _ => Err(format!(
            "时间图 {} 必须且只能携带人工或内置自动验证 proof 中的一种。",
            proof.map_id
        )),
    }
}

fn validate_automatic_verification_binding(proof: &VerifiedExportMapProof) -> Result<(), String> {
    let automatic = proof
        .automatic_verification
        .as_ref()
        .ok_or_else(|| "自动验证 proof 缺失。".to_string())?;
    if automatic.calibration_artifact_id != TRUSTED_AUTOMATIC_CALIBRATION_ARTIFACT_ID
        || automatic.calibration_artifact_version != TRUSTED_AUTOMATIC_CALIBRATION_ARTIFACT_VERSION
    {
        return Err(
            "自动验证 calibration artifact/version 不在 native 内置受信策略中。".to_string(),
        );
    }
    validate_nonempty_bounded("automatic verifier", &automatic.verifier, 512)?;
    validate_nonempty_bounded("automatic verifiedAt", &automatic.verified_at, 512)?;
    Ok(())
}

fn validate_manual_request_binding(proof: &VerifiedExportMapProof) -> Result<(), String> {
    let manual = &proof.manual_verification;
    for (label, value) in [
        ("verificationId", manual.verification_id.as_str()),
        ("issuerKeyId", manual.issuer_key_id.as_str()),
        ("requestPayload", manual.request_payload.as_str()),
    ] {
        validate_nonempty_bounded(label, value, 32 * 1024)?;
    }
    if manual.signature_algorithm != "hmac-sha256-v1" {
        return Err("人工验证 proof 使用了不受支持的签名算法。".to_string());
    }
    validate_hex("manual signature", &manual.signature, 64)?;
    validate_sha256_digest("manual requestDigest", &manual.request_digest)?;
    if sha256_digest(manual.request_payload.as_bytes()) != manual.request_digest {
        return Err("人工验证 requestPayload 与 requestDigest 不一致。".to_string());
    }
    let value: Value = serde_json::from_str(&manual.request_payload)
        .map_err(|error| format!("人工验证 requestPayload 不是有效 JSON：{error}"))?;
    let fields = value
        .as_array()
        .ok_or_else(|| "人工验证 requestPayload 必须是固定顺序数组。".to_string())?;
    if fields.len() != 12
        || fields[0].as_str() != Some(MANUAL_VERIFICATION_REQUEST_DOMAIN)
        || fields[1].as_str() != Some("manual-review")
        || fields[2].as_str() != Some(proof.map_id.as_str())
        || fields[3].as_u64() != Some(proof.revision)
        || fields[4].as_str() != Some(proof.core_digest.as_str())
        || fields[5] != identity_manifest_value(&proof.source_identity)
        || fields[6] != identity_manifest_value(&proof.target_identity)
        || fields[7].as_str().is_none_or(str::is_empty)
        || fields[8].as_str().is_none_or(str::is_empty)
        || fields[9]
            .as_str()
            .is_none_or(|digest| validate_sha256_digest("reviewEvidenceDigest", digest).is_err())
        || fields[10].as_str().is_none_or(str::is_empty)
        || fields[11].as_str().is_none_or(str::is_empty)
    {
        return Err(format!(
            "时间图 {} 的人工验证请求未绑定当前 map/revision/core/两端身份。",
            proof.map_id
        ));
    }
    Ok(())
}

fn parse_and_validate_signed_time_map_core(
    proof: &VerifiedExportMapProof,
) -> Result<SignedTimeMapCore, String> {
    let method = validate_export_proof_method(proof)?;
    parse_and_validate_signed_time_map_core_with_method(proof, method)
}

fn parse_and_validate_signed_time_map_core_with_method(
    proof: &VerifiedExportMapProof,
    proof_method: VerifiedExportProofMethod,
) -> Result<SignedTimeMapCore, String> {
    validate_nonempty_bounded(
        "map coreCanonicalJson",
        &proof.core_canonical_json,
        MAX_CORE_CANONICAL_JSON_BYTES,
    )?;
    if sha256_digest(proof.core_canonical_json.as_bytes()) != proof.core_digest {
        return Err(format!(
            "时间图 {} 的 coreCanonicalJson 与已签 coreDigest 不一致。",
            proof.map_id
        ));
    }
    let value: Value = serde_json::from_str(&proof.core_canonical_json)
        .map_err(|error| format!("时间图 {} 的已签核心不是有效 JSON：{error}", proof.map_id))?;
    let fields = value
        .as_array()
        .ok_or_else(|| format!("时间图 {} 的已签核心必须是固定顺序数组。", proof.map_id))?;
    if fields.len() != 19 || fields[0].as_str() != Some(MEDIA_TIME_MAP_CORE_DOMAIN) {
        return Err(format!(
            "时间图 {} 的已签核心 domain 或字段数量无效。",
            proof.map_id
        ));
    }
    let map_id = required_json_string(&fields[1], "signed core mapId")?;
    let revision = safe_json_u64(&fields[2], "signed core revision")?;
    let source_media_id = required_json_string(&fields[3], "signed core sourceMediaId")?;
    let target_media_id = required_json_string(&fields[4], "signed core targetMediaId")?;
    if map_id != proof.map_id
        || revision != proof.revision
        || source_media_id != proof.source_media_id
        || target_media_id != proof.target_media_id
        || fields[7] != identity_manifest_value(&proof.source_identity)
        || fields[8] != identity_manifest_value(&proof.target_identity)
    {
        return Err(format!(
            "时间图 {} 的已签核心未绑定 proof 的 map/revision/两端媒体身份。",
            proof.map_id
        ));
    }
    let source_start_ms = safe_json_u64(&fields[9], "signed core sourceStartMs")?;
    let source_end_ms = safe_json_u64(&fields[10], "signed core sourceEndMs")?;
    let target_start_ms = safe_json_u64(&fields[11], "signed core targetStartMs")?;
    let target_end_ms = safe_json_u64(&fields[12], "signed core targetEndMs")?;
    let span_values = fields[13]
        .as_array()
        .ok_or_else(|| format!("时间图 {} 的已签核心缺少 spans。", proof.map_id))?;
    if span_values.is_empty() || span_values.len() > 1_000_000 {
        return Err(format!(
            "时间图 {} 的已签核心 spans 为空或超过上限。",
            proof.map_id
        ));
    }
    let manual_takeover_approved =
        validate_signed_manual_takeover_evidence(&proof.map_id, &fields[13], &fields[15])?;
    if proof_method == VerifiedExportProofMethod::Automatic && manual_takeover_approved {
        return Err(format!(
            "时间图 {} 的自动验证 proof 不能包含人工接管声明。",
            proof.map_id
        ));
    }
    let graph_quality = validate_signed_graph_quality(
        &proof.map_id,
        &fields[14],
        manual_takeover_approved,
        proof_method,
    )?;
    validate_signed_compact_evidence(
        &proof.map_id,
        &fields[15],
        graph_quality,
        manual_takeover_approved,
        proof_method,
    )?;
    if proof_method == VerifiedExportProofMethod::Automatic
        && (fields[16].as_str() != Some(TRUSTED_AUTOMATIC_ENGINE_VERSION)
            || fields[17].as_str() != Some(TRUSTED_AUTOMATIC_FEATURE_VERSION))
    {
        return Err(format!(
            "时间图 {} 的自动验证 proof 不是受信 V2.5 引擎/特征版本。",
            proof.map_id
        ));
    }
    let mut spans: Vec<SignedTimeMapSpan> = Vec::with_capacity(span_values.len());
    let mut span_ids = HashSet::with_capacity(span_values.len());
    for (span_index, value) in span_values.iter().enumerate() {
        let span_fields = value.as_array().ok_or_else(|| {
            format!(
                "时间图 {} 的第 {} 个 span 不是固定数组。",
                proof.map_id,
                span_index + 1
            )
        })?;
        if span_fields.len() != 10 {
            return Err(format!(
                "时间图 {} 的第 {} 个 span 字段数量无效。",
                proof.map_id,
                span_index + 1
            ));
        }
        let id = required_json_string(&span_fields[0], "signed span id")?;
        if !span_ids.insert(id.clone()) {
            return Err(format!(
                "时间图 {} 的第 {} 个 span id 重复。",
                proof.map_id,
                span_index + 1
            ));
        }
        let kind = required_json_string(&span_fields[1], "signed span kind")?;
        let reason = required_json_string(&span_fields[6], "signed span reason")?;
        validate_signed_span_quality(
            &proof.map_id,
            span_index,
            kind.as_str(),
            &span_fields[7],
            proof_method,
        )?;
        validate_signed_span_boundaries(
            &proof.map_id,
            span_index,
            kind.as_str(),
            &span_fields[8],
            proof_method,
        )?;
        validate_signed_span_alternatives(&proof.map_id, span_index, &span_fields[9])?;
        let span = SignedTimeMapSpan {
            kind,
            source_start_ms: safe_json_u64(&span_fields[2], "signed span sourceStartMs")?,
            source_end_ms: safe_json_u64(&span_fields[3], "signed span sourceEndMs")?,
            target_start_ms: safe_json_u64(&span_fields[4], "signed span targetStartMs")?,
            target_end_ms: safe_json_u64(&span_fields[5], "signed span targetEndMs")?,
        };
        debug_assert!(!reason.is_empty());
        validate_signed_span_shape(&proof.map_id, span_index, &span, manual_takeover_approved)?;
        if let Some(previous) = spans.last() {
            if previous.source_end_ms != span.source_start_ms
                || previous.target_end_ms != span.target_start_ms
            {
                return Err(format!(
                    "时间图 {} 的已签 spans 在双轴上不连续。",
                    proof.map_id
                ));
            }
        }
        spans.push(span);
    }
    let first = &spans[0];
    let last = &spans[spans.len() - 1];
    if source_start_ms >= source_end_ms
        || target_start_ms >= target_end_ms
        || first.source_start_ms != source_start_ms
        || first.target_start_ms != target_start_ms
        || last.source_end_ms != source_end_ms
        || last.target_end_ms != target_end_ms
    {
        return Err(format!(
            "时间图 {} 的已签范围与 spans 边界不一致。",
            proof.map_id
        ));
    }
    Ok(SignedTimeMapCore {
        map_id,
        revision,
        source_media_id,
        target_media_id,
        source_start_ms,
        source_end_ms,
        target_start_ms,
        spans,
        manual_takeover_approved,
    })
}

fn validate_signed_span_shape(
    map_id: &str,
    span_index: usize,
    span: &SignedTimeMapSpan,
    manual_takeover_approved: bool,
) -> Result<(), String> {
    if span.source_end_ms < span.source_start_ms || span.target_end_ms < span.target_start_ms {
        return Err(format!(
            "时间图 {map_id} 的第 {} 个已签 span 范围倒置。",
            span_index + 1
        ));
    }
    let source_duration = span.source_end_ms - span.source_start_ms;
    let target_duration = span.target_end_ms - span.target_start_ms;
    let valid = match span.kind.as_str() {
        "matched" => source_duration > 0 && target_duration > 0,
        "sourceOnly" => source_duration > 0 && target_duration == 0,
        "targetOnly" => source_duration == 0 && target_duration > 0,
        "ambiguous" => manual_takeover_approved && (source_duration > 0 || target_duration > 0),
        _ => false,
    };
    if !valid {
        return Err(format!(
            "时间图 {map_id} 的第 {} 个已签 span 类型、形状无效或仍含 ambiguous。",
            span_index + 1
        ));
    }
    Ok(())
}

fn validate_signed_manual_takeover_evidence(
    map_id: &str,
    span_values: &Value,
    evidence_value: &Value,
) -> Result<bool, String> {
    let evidence_fields = evidence_value
        .as_array()
        .filter(|fields| fields.len() == 10)
        .ok_or_else(|| format!("时间图 {map_id} 的已签 evidence 字段数量无效。"))?;
    let evidence_types = evidence_fields[0]
        .as_array()
        .ok_or_else(|| format!("时间图 {map_id} 的已签 evidence types 无效。"))?;
    let notes = evidence_fields[9]
        .as_array()
        .ok_or_else(|| format!("时间图 {map_id} 的已签 evidence notes 不是数组。"))?
        .iter()
        .map(|note| required_json_string(note, "signed evidence note"))
        .collect::<Result<Vec<_>, _>>()?;
    let takeover_notes = notes
        .iter()
        .filter(|note| note.starts_with(MANUAL_TAKEOVER_NOTE_PREFIX))
        .collect::<Vec<_>>();
    if takeover_notes.is_empty() {
        return Ok(false);
    }
    if takeover_notes.len() != 1
        || takeover_notes[0].len() <= MANUAL_TAKEOVER_NOTE_PREFIX.len()
        || !evidence_types
            .iter()
            .any(|item| item.as_str() == Some("manual"))
    {
        return Err(format!(
            "时间图 {map_id} 的人工接管声明重复、缺少时间或没有 manual 证据。"
        ));
    }

    let spans = span_values
        .as_array()
        .ok_or_else(|| format!("时间图 {map_id} 的已签核心缺少 spans。"))?;
    for (span_index, span) in spans.iter().enumerate() {
        let fields = span.as_array().ok_or_else(|| {
            format!(
                "时间图 {map_id} 的第 {} 个人工接管 span 不是固定数组。",
                span_index + 1
            )
        })?;
        let Some(kind) = fields.get(1).and_then(Value::as_str) else {
            return Err(format!(
                "时间图 {map_id} 的第 {} 个人工接管 span 缺少类型。",
                span_index + 1
            ));
        };
        let decision = match kind {
            "matched" => continue,
            "sourceOnly" => "source-extra",
            "targetOnly" => "target-extra",
            "ambiguous" => "replacement",
            _ => {
                return Err(format!(
                    "时间图 {map_id} 的第 {} 个人工接管 span 类型未知。",
                    span_index + 1
                ))
            }
        };
        let prefix = format!("{MANUAL_SPAN_REVIEW_NOTE_PREFIX}{span_index}:{decision}:");
        if !notes
            .iter()
            .any(|note| note.starts_with(&prefix) && note.len() > prefix.len())
        {
            return Err(format!(
                "时间图 {map_id} 的第 {} 个差异 span 缺少与类型一致的人工接管结论。",
                span_index + 1
            ));
        }
    }
    Ok(true)
}

fn validate_signed_graph_quality(
    map_id: &str,
    value: &Value,
    manual_takeover_approved: bool,
    proof_method: VerifiedExportProofMethod,
) -> Result<SignedVerifiedGraphQuality, String> {
    let fields = value
        .as_array()
        .ok_or_else(|| format!("时间图 {map_id} 的图级 quality 不是固定数组。"))?;
    if fields.len() != 14 {
        return Err(format!("时间图 {map_id} 的图级 quality 字段数量无效。"));
    }
    let probability = safe_json_optional_unit_f64(&fields[0], "signed quality probability")?;
    let metric_source = validate_json_enum(
        &fields[1],
        "signed quality metricSource",
        &["measured", "estimated", "missing"],
    )?;
    let coverage = safe_json_optional_unit_f64(&fields[2], "signed quality coverage")?;
    let unique_content_coverage =
        safe_json_optional_unit_f64(&fields[3], "signed quality uniqueContentCoverage")?;
    validate_residual_sequence(&fields[4..=7], "signed graph quality residuals")?;
    let p50_residual_ms = safe_json_optional_u64(&fields[4], "signed quality p50ResidualMs")?;
    let p95_residual_ms = safe_json_optional_u64(&fields[5], "signed quality p95ResidualMs")?;
    let p99_residual_ms = safe_json_optional_u64(&fields[6], "signed quality p99ResidualMs")?;
    let max_residual_ms = safe_json_optional_u64(&fields[7], "signed quality maxResidualMs")?;
    let boundary_uncertainty_ms =
        safe_json_optional_u64(&fields[8], "signed quality boundaryUncertaintyMs")?;
    let alternative_margin =
        safe_json_optional_unit_f64(&fields[9], "signed quality alternativeMargin")?;
    let anchor_count = safe_json_u64(&fields[10], "signed quality anchorCount")?;
    let anchor_region_count = safe_json_u64(&fields[11], "signed quality anchorRegionCount")?;
    let held_out_anchor_count = safe_json_u64(&fields[12], "signed quality heldOutAnchorCount")?;
    if anchor_region_count > 3 || held_out_anchor_count > anchor_count {
        return Err(format!(
            "时间图 {map_id} 的图级 anchorRegionCount 或 heldOutAnchorCount 无效。"
        ));
    }
    validate_json_reasons(&fields[13], "signed graph quality reasons")?;

    let meets_verified_contract = match proof_method {
        VerifiedExportProofMethod::Manual => {
            metric_source == "measured"
                && probability.is_some_and(|number| number >= 0.995)
                && coverage.is_some_and(|number| number >= 0.90)
                && unique_content_coverage.is_some_and(|number| number >= 0.80)
                && p50_residual_ms.is_some()
                && p95_residual_ms.is_some_and(|milliseconds| milliseconds <= 100)
                && p99_residual_ms.is_some_and(|milliseconds| milliseconds <= 500)
                && max_residual_ms.is_some()
                && boundary_uncertainty_ms.is_some_and(|milliseconds| milliseconds <= 250)
                && alternative_margin.is_some_and(|margin| margin >= 0.25)
                && anchor_count >= 30
                && anchor_region_count >= 3
                && held_out_anchor_count > 0
        }
        VerifiedExportProofMethod::Automatic => {
            metric_source == "measured"
                && probability.is_none_or(|number| number >= 0.995)
                && coverage.is_some_and(|number| number >= 0.90)
                && unique_content_coverage.is_some_and(|number| number >= 0.80)
                && p50_residual_ms.is_some()
                && p95_residual_ms.is_some_and(|milliseconds| milliseconds <= 100)
                && p99_residual_ms.is_some_and(|milliseconds| milliseconds <= 250)
                && max_residual_ms.is_some_and(|milliseconds| milliseconds <= 500)
                && boundary_uncertainty_ms.is_some_and(|milliseconds| milliseconds <= 250)
                && alternative_margin.is_some_and(|margin| margin >= 0.35)
                && anchor_count >= 12
                && anchor_region_count >= 3
                && held_out_anchor_count >= 6
        }
    };
    if !meets_verified_contract && !manual_takeover_approved {
        return Err(format!(
            "时间图 {map_id} 的已签图级质量低于 verified 最低契约。"
        ));
    }

    Ok(SignedVerifiedGraphQuality {
        unique_content_coverage,
        held_out_anchor_count,
    })
}

fn validate_signed_span_quality(
    map_id: &str,
    span_index: usize,
    span_kind: &str,
    value: &Value,
    proof_method: VerifiedExportProofMethod,
) -> Result<(), String> {
    let fields = value.as_array().ok_or_else(|| {
        format!(
            "时间图 {map_id} 的第 {} 个 span quality 不是固定数组。",
            span_index + 1
        )
    })?;
    if fields.len() != 17 {
        return Err(format!(
            "时间图 {map_id} 的第 {} 个 span quality 字段数量无效。",
            span_index + 1
        ));
    }
    let level = validate_json_enum(
        &fields[0],
        "signed span quality level",
        &["verified", "review", "blocked", "legacy-unverified"],
    )?;
    if matches!(level, "blocked" | "legacy-unverified") {
        return Err(format!(
            "时间图 {map_id} 的第 {} 个已签 span 仍为 {level}，不能冒充 verified 导出。",
            span_index + 1
        ));
    }
    let metric_source = validate_json_enum(
        &fields[1],
        "signed span quality metricSource",
        &["measured", "estimated", "missing"],
    )?;
    safe_json_optional_unit_f64(&fields[2], "signed span probability")?;
    let coverage = safe_json_optional_unit_f64(&fields[3], "signed span coverage")?;
    safe_json_optional_unit_f64(&fields[4], "signed span uniqueContentCoverage")?;
    safe_json_optional_unit_f64(&fields[5], "signed span alternativeMargin")?;
    let anchor_count = safe_json_u64(&fields[6], "signed span anchorCount")?;
    let held_out_anchor_count = safe_json_u64(&fields[7], "signed span heldOutAnchorCount")?;
    if held_out_anchor_count > anchor_count {
        return Err(format!(
            "时间图 {map_id} 的第 {} 个 span heldOutAnchorCount 超过 anchorCount。",
            span_index + 1
        ));
    }
    validate_residual_sequence(&fields[8..=11], "signed span residuals")?;
    let p95_residual_ms = safe_json_optional_u64(&fields[9], "signed span p95ResidualMs")?;
    safe_json_optional_u64(&fields[12], "signed span boundaryUncertaintyMs")?;
    for (field, label) in [
        (&fields[13], "signed span leftSupport"),
        (&fields[14], "signed span rightSupport"),
    ] {
        validate_json_enum(
            field,
            label,
            &[
                "supported",
                "unsupported",
                "notApplicable",
                "legacyUnverified",
            ],
        )?;
    }
    let signals = fields[15]
        .as_array()
        .filter(|signals| signals.len() == 3)
        .ok_or_else(|| format!("时间图 {map_id} 的逐段 signals 形状无效。"))?;
    for signal in signals {
        validate_json_enum(
            signal,
            "signed span signal",
            &["used", "blocked", "conflict"],
        )?;
    }
    if proof_method == VerifiedExportProofMethod::Automatic {
        if signals[0].as_str() != Some("used") {
            return Err(format!(
                "时间图 {map_id} 的第 {} 个自动验证 span 没有可用音频证据。",
                span_index + 1
            ));
        }
        if span_kind == "matched"
            && (metric_source != "measured"
                || !coverage.is_some_and(|number| number >= 0.70)
                || !p95_residual_ms.is_some_and(|milliseconds| milliseconds <= 250))
        {
            return Err(format!(
                "时间图 {map_id} 的第 {} 个自动验证 matched span 覆盖或残差不足。",
                span_index + 1
            ));
        }
    }
    validate_json_reasons(&fields[16], "signed span quality reasons")
}

fn validate_signed_compact_evidence(
    map_id: &str,
    value: &Value,
    graph_quality: SignedVerifiedGraphQuality,
    manual_takeover_approved: bool,
    proof_method: VerifiedExportProofMethod,
) -> Result<(), String> {
    let fields = value
        .as_array()
        .filter(|fields| fields.len() == 10)
        .ok_or_else(|| format!("时间图 {map_id} 的已签 evidence 字段数量无效。"))?;
    let evidence_types = fields[0]
        .as_array()
        .filter(|types| !types.is_empty())
        .ok_or_else(|| format!("时间图 {map_id} 的已签 evidence types 为空或无效。"))?;
    let mut unique_types = HashSet::with_capacity(evidence_types.len());
    for evidence_type in evidence_types {
        let evidence_type = validate_json_enum(
            evidence_type,
            "signed evidence type",
            &["audio", "visual", "manual", "danmaku", "legacy"],
        )?;
        if !unique_types.insert(evidence_type) {
            return Err(format!("时间图 {map_id} 的已签 evidence types 重复。"));
        }
    }
    match proof_method {
        VerifiedExportProofMethod::Manual if !unique_types.contains("manual") => {
            return Err(format!(
                "时间图 {map_id} 的 verified proof 使用人工验证凭据，但已签核心缺少 manual 复核证据。"
            ));
        }
        VerifiedExportProofMethod::Automatic
            if unique_types.contains("manual") || !unique_types.contains("audio") =>
        {
            return Err(format!(
                "时间图 {map_id} 的自动验证 proof 必须使用音频留出证据且不能混入人工证据。"
            ));
        }
        _ => {}
    }
    if unique_types.contains("legacy") {
        return Err(format!(
            "时间图 {map_id} 的已签核心仍含 legacy 证据，不能冒充 verified 导出。"
        ));
    }

    let audio_anchor_count = safe_json_u64(&fields[1], "signed evidence audioAnchorCount")?;
    let visual_anchor_count = safe_json_u64(&fields[2], "signed evidence visualAnchorCount")?;
    let held_out_anchor_count = safe_json_u64(&fields[3], "signed evidence heldOutAnchorCount")?;
    safe_json_optional_unit_f64(&fields[4], "signed evidence top1Top2Margin")?;
    let unique_content_coverage =
        safe_json_optional_unit_f64(&fields[5], "signed evidence uniqueContentCoverage")?;
    let repeated_content_only = fields[6]
        .as_bool()
        .ok_or_else(|| format!("时间图 {map_id} 的已签 repeatedContentOnly 不是布尔值。"))?;
    fields[7]
        .as_str()
        .ok_or_else(|| format!("时间图 {map_id} 的已签 selectedTrackReason 不是字符串。"))?;
    fields[8]
        .as_array()
        .ok_or_else(|| format!("时间图 {map_id} 的已签 alternativeTrackScores 不是数组。"))?;
    fields[9]
        .as_array()
        .ok_or_else(|| format!("时间图 {map_id} 的已签 evidence notes 不是数组。"))?;

    if unique_types.contains("audio") && audio_anchor_count == 0 {
        return Err(format!("时间图 {map_id} 声明 audio 证据但没有音频锚点。"));
    }
    if proof_method == VerifiedExportProofMethod::Automatic && audio_anchor_count < 12 {
        return Err(format!("时间图 {map_id} 的自动验证音频锚点少于 12 个。"));
    }
    if unique_types.contains("visual") && visual_anchor_count == 0 {
        return Err(format!("时间图 {map_id} 声明 visual 证据但没有视觉锚点。"));
    }
    if repeated_content_only && !manual_takeover_approved {
        return Err(format!(
            "时间图 {map_id} 的已签证据只有重复内容，不能满足 verified 独特内容契约。"
        ));
    }
    if held_out_anchor_count != graph_quality.held_out_anchor_count
        || unique_content_coverage != graph_quality.unique_content_coverage
    {
        return Err(format!(
            "时间图 {map_id} 的已签图级质量与 evidence 留出锚点或独特内容覆盖率不一致。"
        ));
    }
    Ok(())
}

fn validate_signed_span_boundaries(
    map_id: &str,
    span_index: usize,
    span_kind: &str,
    value: &Value,
    proof_method: VerifiedExportProofMethod,
) -> Result<(), String> {
    let boundaries = value
        .as_array()
        .filter(|boundaries| boundaries.len() == 2)
        .ok_or_else(|| {
            format!(
                "时间图 {map_id} 的第 {} 个 span boundaries 形状无效。",
                span_index + 1
            )
        })?;
    let mut statuses = Vec::with_capacity(2);
    for (side, boundary) in ["start", "end"].into_iter().zip(boundaries) {
        statuses.push(validate_signed_boundary(
            map_id,
            span_index,
            side,
            boundary,
            proof_method,
        )?);
    }
    if proof_method == VerifiedExportProofMethod::Automatic
        && span_kind != "matched"
        && statuses.iter().any(|status| *status != "refined")
    {
        return Err(format!(
            "时间图 {map_id} 的第 {} 个自动验证单侧差异缺少双边精修证据。",
            span_index + 1
        ));
    }
    Ok(())
}

fn validate_signed_boundary(
    map_id: &str,
    span_index: usize,
    side: &str,
    value: &Value,
    proof_method: VerifiedExportProofMethod,
) -> Result<String, String> {
    let fields = value
        .as_array()
        .filter(|fields| fields.len() == 11)
        .ok_or_else(|| {
            format!(
                "时间图 {map_id} 的第 {} 个 span {side} boundary 字段数量无效。",
                span_index + 1
            )
        })?;
    let status = validate_json_enum(
        &fields[0],
        "signed boundary status",
        &[
            "refined",
            "ambiguous",
            "unsupported",
            "notApplicable",
            "legacyUnverified",
        ],
    )?;
    if proof_method == VerifiedExportProofMethod::Automatic
        && matches!(status, "ambiguous" | "unsupported" | "legacyUnverified")
    {
        return Err(format!(
            "时间图 {map_id} 的第 {} 个自动验证 span {side} 边界仍未唯一定位。",
            span_index + 1
        ));
    }
    if !fields[1].is_null() {
        validate_json_enum(
            &fields[1],
            "signed boundary axis",
            &["source", "target", "both"],
        )?;
    }
    if !fields[2].is_null() {
        validate_json_enum(
            &fields[2],
            "signed boundary contextSide",
            &["before", "after"],
        )?;
    }
    let coarse_ms = safe_json_optional_u64(&fields[3], "signed boundary coarseMs")?;
    let refined_ms = safe_json_optional_u64(&fields[4], "signed boundary refinedMs")?;
    let uncertainty_start_ms =
        safe_json_optional_u64(&fields[5], "signed boundary uncertaintyStartMs")?;
    let uncertainty_end_ms =
        safe_json_optional_u64(&fields[6], "signed boundary uncertaintyEndMs")?;
    let support_duration_ms =
        safe_json_optional_u64(&fields[7], "signed boundary supportDurationMs")?;
    safe_json_optional_correlation(&fields[8], "signed boundary correlation")?;
    safe_json_optional_unit_f64(&fields[9], "signed boundary alternativeMargin")?;
    required_json_string(&fields[10], "signed boundary reason")?;
    if uncertainty_start_ms.is_some() != uncertainty_end_ms.is_some()
        || uncertainty_start_ms
            .zip(uncertainty_end_ms)
            .is_some_and(|(start, end)| end < start)
    {
        return Err(format!(
            "时间图 {map_id} 的第 {} 个 span {side} boundary 不确定区间无效。",
            span_index + 1
        ));
    }
    if status == "refined"
        && (fields[1].is_null()
            || coarse_ms.is_none()
            || refined_ms.is_none()
            || uncertainty_start_ms.is_none()
            || uncertainty_end_ms.is_none()
            || support_duration_ms.is_none())
    {
        return Err(format!(
            "时间图 {map_id} 的第 {} 个 span {side} refined boundary 缺少实测字段。",
            span_index + 1
        ));
    }
    Ok(status.to_string())
}

fn validate_signed_span_alternatives(
    map_id: &str,
    span_index: usize,
    value: &Value,
) -> Result<(), String> {
    let alternatives = value.as_array().ok_or_else(|| {
        format!(
            "时间图 {map_id} 的第 {} 个 span alternatives 不是数组。",
            span_index + 1
        )
    })?;
    if alternatives.len() > 1_000_000 {
        return Err(format!("时间图 {map_id} 的逐段 alternatives 超过上限。"));
    }
    for alternative in alternatives {
        let fields = alternative
            .as_array()
            .filter(|fields| fields.len() == 7)
            .ok_or_else(|| format!("时间图 {map_id} 的逐段 alternative 形状无效。"))?;
        let kind = validate_json_enum(
            &fields[0],
            "signed span alternative kind",
            &["matched", "sourceOnly", "targetOnly", "ambiguous"],
        )?;
        safe_json_optional_unit_f64(&fields[1], "signed span alternative score")?;
        let source_start_ms = safe_json_u64(&fields[2], "alternative sourceStartMs")?;
        let source_end_ms = safe_json_u64(&fields[3], "alternative sourceEndMs")?;
        let target_start_ms = safe_json_u64(&fields[4], "alternative targetStartMs")?;
        let target_end_ms = safe_json_u64(&fields[5], "alternative targetEndMs")?;
        required_json_string(&fields[6], "signed span alternative reason")?;
        if !has_valid_span_shape(
            kind,
            source_start_ms,
            source_end_ms,
            target_start_ms,
            target_end_ms,
            true,
        ) {
            return Err(format!(
                "时间图 {map_id} 的逐段 alternative 范围或类型无效。"
            ));
        }
    }
    Ok(())
}

fn has_valid_span_shape(
    kind: &str,
    source_start_ms: u64,
    source_end_ms: u64,
    target_start_ms: u64,
    target_end_ms: u64,
    allow_ambiguous: bool,
) -> bool {
    let Some(source_duration) = source_end_ms.checked_sub(source_start_ms) else {
        return false;
    };
    let Some(target_duration) = target_end_ms.checked_sub(target_start_ms) else {
        return false;
    };
    match kind {
        "matched" => source_duration > 0 && target_duration > 0,
        "sourceOnly" => source_duration > 0 && target_duration == 0,
        "targetOnly" => source_duration == 0 && target_duration > 0,
        "ambiguous" => allow_ambiguous && (source_duration > 0 || target_duration > 0),
        _ => false,
    }
}

fn validate_residual_sequence(values: &[Value], label: &str) -> Result<(), String> {
    if values.len() != 4 {
        return Err(format!("高精度导出字段 {label} 数量无效。"));
    }
    let residuals = values
        .iter()
        .enumerate()
        .map(|(index, value)| safe_json_optional_u64(value, &format!("{label}[{index}]")))
        .collect::<Result<Vec<_>, _>>()?;
    for pair in residuals.windows(2) {
        if pair[0]
            .zip(pair[1])
            .is_some_and(|(left, right)| left > right)
        {
            return Err(format!("高精度导出字段 {label} 不是单调残差分位数。"));
        }
    }
    Ok(())
}

fn validate_json_reasons(value: &Value, label: &str) -> Result<(), String> {
    let reasons = value
        .as_array()
        .filter(|reasons| !reasons.is_empty())
        .ok_or_else(|| format!("高精度导出字段 {label} 为空或不是数组。"))?;
    let mut unique = HashSet::with_capacity(reasons.len());
    for reason in reasons {
        let reason = required_json_string(reason, label)?;
        if !unique.insert(reason) {
            return Err(format!("高精度导出字段 {label} 包含重复原因。"));
        }
    }
    Ok(())
}

fn validate_json_enum<'a>(
    value: &'a Value,
    label: &str,
    allowed: &[&str],
) -> Result<&'a str, String> {
    let text = value
        .as_str()
        .filter(|text| allowed.contains(text))
        .ok_or_else(|| format!("高精度导出字段 {label} 枚举值无效。"))?;
    Ok(text)
}

fn safe_json_optional_u64(value: &Value, label: &str) -> Result<Option<u64>, String> {
    if value.is_null() {
        Ok(None)
    } else {
        safe_json_u64(value, label).map(Some)
    }
}

fn safe_json_optional_unit_f64(value: &Value, label: &str) -> Result<Option<f64>, String> {
    if value.is_null() {
        return Ok(None);
    }
    let number = value
        .as_f64()
        .filter(|number| number.is_finite() && (0.0..=1.0).contains(number))
        .ok_or_else(|| format!("高精度导出字段 {label} 不是 0..1 有限数或 null。"))?;
    Ok(Some(number))
}

fn safe_json_optional_correlation(value: &Value, label: &str) -> Result<Option<f64>, String> {
    if value.is_null() {
        return Ok(None);
    }
    let number = value
        .as_f64()
        .filter(|number| number.is_finite() && (-1.0..=1.0).contains(number))
        .ok_or_else(|| format!("高精度导出字段 {label} 不是 -1..1 有限数或 null。"))?;
    Ok(Some(number))
}

fn required_json_string(value: &Value, label: &str) -> Result<String, String> {
    let text = value
        .as_str()
        .ok_or_else(|| format!("高精度导出字段 {label} 不是字符串。"))?;
    validate_nonempty_bounded(label, text, 1_048_576)?;
    Ok(text.to_string())
}

fn safe_json_u64(value: &Value, label: &str) -> Result<u64, String> {
    let number = value
        .as_u64()
        .filter(|number| *number <= MAX_SAFE_INTEGER)
        .ok_or_else(|| format!("高精度导出字段 {label} 不是非负安全整数毫秒。"))?;
    Ok(number)
}

fn validate_projection_derivation_binding(
    request: &SaveVerifiedExportFileRequest,
) -> Result<(), String> {
    let verification = &request.verification;
    let derivation = &verification.projection_derivation;
    if derivation.domain != PROJECTION_DERIVATION_DOMAIN
        || derivation.projection_policy_version != PROJECTION_POLICY_VERSION
        || derivation.serializer_version != PROJECTION_SERIALIZER_VERSION
    {
        return Err(
            "投影 derivation 的 domain、投影策略或 XML serializer 版本不受支持。".to_string(),
        );
    }
    if derivation.project_id != verification.project_id
        || derivation.project_updated_at != verification.project_updated_at
    {
        return Err("投影 derivation 未绑定当前项目快照。".to_string());
    }
    if derivation.media.len() > MAX_PROJECTION_MEDIA
        || derivation.xml_assets.len() > MAX_PROJECTION_ASSETS
        || derivation.routes.len() > MAX_PROJECTION_ROUTES
        || derivation.source_bindings.len() > MAX_PROJECTION_ASSETS
        || derivation.target_output_files.len() > MAX_PROJECTION_MEDIA
    {
        return Err("投影 derivation 超过媒体、资产、绑定、路由或目标数量上限。".to_string());
    }

    let mut media_by_id = HashMap::<String, &ProjectionMediaV1>::new();
    for media in &derivation.media {
        validate_projection_id("mediaId", &media.media_id)?;
        validate_bounded("media name", &media.name, 1_048_576)?;
        validate_bounded("media fileName", &media.media_file_name, 1_048_576)?;
        if !matches!(media.role.as_str(), "targetOriginal" | "bilibiliReference") {
            return Err(format!("投影媒体 {} 的角色无效。", media.media_id));
        }
        validate_optional_safe_milliseconds("media durationMs", media.duration_ms)?;
        if let Some(identity) = &media.content_identity {
            validate_media_identity_shape(identity)?;
        }
        if media_by_id.insert(media.media_id.clone(), media).is_some() {
            return Err("投影 derivation 含重复 mediaId。".to_string());
        }
    }

    let mut assets_by_id = HashMap::<String, &ProjectionXmlAssetV1>::new();
    let mut item_ids = HashSet::<String>::new();
    let mut item_count = 0_usize;
    for asset in &derivation.xml_assets {
        validate_projection_id("assetId", &asset.asset_id)?;
        validate_bounded("source fileName", &asset.source_file_name, 1_048_576)?;
        item_count = item_count
            .checked_add(asset.items.len())
            .ok_or_else(|| "投影弹幕总数溢出。".to_string())?;
        if item_count > MAX_PROJECTION_ITEMS {
            return Err("投影弹幕总数超过安全上限。".to_string());
        }
        let mut original_indices = HashSet::new();
        for item in &asset.items {
            validate_projection_item(asset, item)?;
            if !item_ids.insert(item.item_id.clone()) {
                return Err(format!("投影 derivation 含重复 itemId：{}。", item.item_id));
            }
            if !original_indices.insert(item.original_index) {
                return Err(format!(
                    "弹幕资产 {} 含重复 originalIndex。",
                    asset.asset_id
                ));
            }
        }
        if assets_by_id.insert(asset.asset_id.clone(), asset).is_some() {
            return Err("投影 derivation 含重复 assetId。".to_string());
        }
    }

    let mut source_binding_by_asset = HashMap::<String, String>::new();
    let mut binding_ids = HashSet::new();
    for binding in &derivation.source_bindings {
        validate_projection_id("bindingId", &binding.binding_id)?;
        validate_projection_id("binding assetId", &binding.asset_id)?;
        validate_projection_id("binding sourceMediaId", &binding.source_media_id)?;
        if !binding_ids.insert(binding.binding_id.as_str()) {
            return Err("投影 derivation 含重复 bindingId。".to_string());
        }
        if !assets_by_id.contains_key(&binding.asset_id) {
            return Err(format!("来源绑定引用缺失资产：{}。", binding.asset_id));
        }
        let source_media = media_by_id
            .get(&binding.source_media_id)
            .ok_or_else(|| format!("来源绑定引用缺失媒体：{}。", binding.source_media_id))?;
        if source_media.role != "bilibiliReference" {
            return Err(format!(
                "来源绑定 {} 未指向 B 站参考素材。",
                binding.binding_id
            ));
        }
        if source_binding_by_asset
            .insert(binding.asset_id.clone(), binding.source_media_id.clone())
            .is_some()
        {
            return Err(format!("资产 {} 含重复来源绑定。", binding.asset_id));
        }
    }

    let mut proof_cores = HashMap::<String, SignedTimeMapCore>::new();
    for proof in &verification.map_proofs {
        let core = parse_and_validate_signed_time_map_core(proof)?;
        let source_media = media_by_id
            .get(&core.source_media_id)
            .ok_or_else(|| format!("时间图 {} 的来源媒体不在投影 inventory。", core.map_id))?;
        let target_media = media_by_id
            .get(&core.target_media_id)
            .ok_or_else(|| format!("时间图 {} 的目标媒体不在投影 inventory。", core.map_id))?;
        if source_media.role != "bilibiliReference" || target_media.role != "targetOriginal" {
            return Err(format!("时间图 {} 的两端媒体角色无效。", core.map_id));
        }
        if source_media.content_identity.as_ref() != Some(&proof.source_identity)
            || target_media.content_identity.as_ref() != Some(&proof.target_identity)
        {
            return Err(format!(
                "时间图 {} 的 proof 身份与项目媒体 inventory 不一致。",
                core.map_id
            ));
        }
        if proof_cores.insert(core.map_id.clone(), core).is_some() {
            return Err("投影 derivation 含重复已签时间图。".to_string());
        }
    }

    validate_projection_routes_and_overlaps(
        derivation,
        &assets_by_id,
        &media_by_id,
        &source_binding_by_asset,
        &proof_cores,
    )?;

    let disabled = normalized_string_set("disabledItemIds", &derivation.disabled_item_ids)?;
    let adjustments = normalized_adjustment_map(&derivation.item_time_adjustments)?;
    let target_outputs = validate_target_output_inventory(derivation, &media_by_id)?;

    let mut groups = HashMap::<String, Vec<NativeProjectedEntry<'_>>>::new();
    let mut projection_ordinal = 0_u64;
    let mut content_target_ids = HashSet::<String>::new();

    for route in derivation
        .routes
        .iter()
        .filter(|route| route.kind == "content")
    {
        let asset_id = route
            .asset_id
            .as_deref()
            .expect("validated content assetId");
        let target_media_id = route
            .target_media_id
            .as_deref()
            .expect("validated content targetMediaId");
        let map_id = route
            .time_map_id
            .as_deref()
            .expect("validated content timeMapId");
        let asset = assets_by_id[asset_id];
        let core = &proof_cores[map_id];
        content_target_ids.insert(target_media_id.to_string());
        let group = groups.entry(target_media_id.to_string()).or_default();
        for item in &asset.items {
            if item.source_time_ms < route.source_start_ms
                || item.source_time_ms >= route.source_end_ms
            {
                continue;
            }
            let Some(mapped_time_ms) = map_signed_source_time(core, item.source_time_ms)? else {
                continue;
            };
            if !item.enabled || disabled.contains(item.item_id.as_str()) {
                continue;
            }
            let adjustment_ms = i128::from(*adjustments.get(item.item_id.as_str()).unwrap_or(&0));
            let final_time_ms = i128::from(mapped_time_ms) + adjustment_ms;
            if !(0..=i128::from(MAX_SAFE_INTEGER)).contains(&final_time_ms) {
                return Err(format!(
                    "弹幕 {} 投影后的时间为负或超过安全整数范围，已拒绝导出。",
                    item.item_id
                ));
            }
            let final_time_ms = u64::try_from(final_time_ms)
                .map_err(|_| "投影时间无法转换为非负整数。".to_string())?;
            let target_media = media_by_id[target_media_id];
            if target_media
                .duration_ms
                .is_some_and(|duration| final_time_ms >= duration)
            {
                return Err(format!(
                    "弹幕 {} 投影后超出目标原片时长，已拒绝导出。",
                    item.item_id
                ));
            }
            group.push(NativeProjectedEntry {
                item,
                final_time_ms,
                projection_ordinal,
            });
            projection_ordinal = projection_ordinal
                .checked_add(1)
                .ok_or_else(|| "投影顺序计数溢出。".to_string())?;
        }
    }

    if content_target_ids.len() != target_outputs.len()
        || content_target_ids
            .iter()
            .any(|target_id| !target_outputs.contains_key(target_id))
    {
        return Err("targetOutputFiles 未与全部正片投影目标形成一一对应。".to_string());
    }
    let referenced_map_ids = derivation
        .routes
        .iter()
        .filter(|route| route.kind == "content")
        .filter_map(|route| route.time_map_id.as_ref())
        .collect::<HashSet<_>>();
    if referenced_map_ids.len() != proof_cores.len()
        || proof_cores
            .keys()
            .any(|map_id| !referenced_map_ids.contains(map_id))
    {
        return Err("正片路由与 verified map proofs 未形成双向完整绑定。".to_string());
    }

    let mut expected_xml_by_file = HashMap::<String, Vec<u8>>::new();
    for target_id in content_target_ids {
        let mut entries = groups.remove(&target_id).unwrap_or_default();
        entries.sort_by(|left, right| {
            left.final_time_ms
                .cmp(&right.final_time_ms)
                .then(left.item.original_index.cmp(&right.item.original_index))
                .then(left.projection_ordinal.cmp(&right.projection_ordinal))
        });
        if entries.is_empty() {
            continue;
        }
        let file_name = target_outputs[&target_id].file_name.clone();
        let xml = serialize_native_bilibili_xml(
            &entries,
            target_outputs[&target_id].metadata_xml.as_deref(),
        )?;
        if expected_xml_by_file.insert(file_name, xml).is_some() {
            return Err("多个投影目标解析为同一逻辑 XML 文件名。".to_string());
        }
    }

    if expected_xml_by_file.len() != verification.outputs.len() {
        return Err("原生投影重建得到的逻辑 XML 数量与 manifest 不一致。".to_string());
    }
    let actual_outputs = logical_output_bytes(request)?;
    for output in &verification.outputs {
        let expected = expected_xml_by_file
            .get(&output.file_name)
            .ok_or_else(|| format!("manifest 声明了原生投影未生成的 XML：{}", output.file_name))?;
        if sha256_digest(expected) != output.content_digest {
            return Err(format!(
                "逻辑 XML {} 的摘要不是由已签时间图和完整投影 inventory 推导所得。",
                output.file_name
            ));
        }
        let actual = actual_outputs
            .get(output.file_name.as_str())
            .ok_or_else(|| format!("待写内容缺少逻辑 XML：{}", output.file_name))?;
        if *actual != expected.as_slice() {
            return Err(format!(
                "逻辑 XML {} 与原生端独立重建结果不一致，已拒绝写盘。",
                output.file_name
            ));
        }
    }
    Ok(())
}

fn validate_projection_item(
    asset: &ProjectionXmlAssetV1,
    item: &ProjectionDanmakuItemV1,
) -> Result<(), String> {
    validate_projection_id("itemId", &item.item_id)?;
    if item.asset_id != asset.asset_id {
        return Err(format!(
            "弹幕 {} 的 assetId 与所属资产不一致。",
            item.item_id
        ));
    }
    if item.original_index > MAX_SAFE_INTEGER || item.source_time_ms > MAX_SAFE_INTEGER {
        return Err(format!(
            "弹幕 {} 含超过 JS 安全整数的索引或时间。",
            item.item_id
        ));
    }
    validate_bounded("danmaku text", &item.text, 16 * 1_048_576)?;
    validate_xml_10_characters("danmaku text", &item.text)?;
    if item.raw_p_fields.len() > 256 {
        return Err(format!("弹幕 {} 的 p 字段数量超过上限。", item.item_id));
    }
    for field in &item.raw_p_fields {
        validate_bounded("danmaku p field", field, 1_048_576)?;
        validate_xml_10_characters("danmaku p field", field)?;
    }
    for value in [
        item.mode,
        item.font_size,
        item.color,
        item.timestamp,
        item.pool,
    ]
    .into_iter()
    .flatten()
    {
        validate_safe_i64("danmaku metadata", value)?;
    }
    if let Some(user_hash) = &item.user_hash {
        validate_bounded("danmaku userHash", user_hash, 1_048_576)?;
        validate_xml_10_characters("danmaku userHash", user_hash)?;
    }
    if let Some(row_id) = &item.row_id {
        validate_bounded("danmaku rowId", row_id, 1_048_576)?;
        validate_xml_10_characters("danmaku rowId", row_id)?;
    }
    Ok(())
}

fn validate_projection_routes_and_overlaps(
    derivation: &ProjectionDerivationV1,
    assets_by_id: &HashMap<String, &ProjectionXmlAssetV1>,
    media_by_id: &HashMap<String, &ProjectionMediaV1>,
    source_binding_by_asset: &HashMap<String, String>,
    proof_cores: &HashMap<String, SignedTimeMapCore>,
) -> Result<(), String> {
    let mut route_ids = HashSet::new();
    let mut grouped = HashMap::<(String, String), Vec<&ProjectionRouteV1>>::new();
    for route in &derivation.routes {
        validate_projection_id("routeId", &route.route_id)?;
        if !route_ids.insert(route.route_id.as_str()) {
            return Err("投影 derivation 含重复 routeId。".to_string());
        }
        if !matches!(route.kind.as_str(), "content" | "ignored")
            || route.source_start_ms > MAX_SAFE_INTEGER
            || route.source_end_ms > MAX_SAFE_INTEGER
            || route.source_start_ms >= route.source_end_ms
            || route
                .target_start_ms
                .is_some_and(|value| value > MAX_SAFE_INTEGER)
        {
            return Err(format!(
                "投影路由 {} 的类型或时间范围无效。",
                route.route_id
            ));
        }
        for rule in &route.timing_rules {
            validate_projection_id("timing ruleId", &rule.rule_id)?;
            if rule.source_at_ms > MAX_SAFE_INTEGER {
                return Err(format!(
                    "投影路由 {} 的 timing rule 时间无效。",
                    route.route_id
                ));
            }
            validate_safe_i64("timing gapMs", rule.gap_ms)?;
        }
        let asset_id = route
            .asset_id
            .as_ref()
            .ok_or_else(|| format!("投影路由 {} 缺少 assetId。", route.route_id))?;
        let source_media_id = route
            .source_media_id
            .as_ref()
            .ok_or_else(|| format!("投影路由 {} 缺少 sourceMediaId。", route.route_id))?;
        if !assets_by_id.contains_key(asset_id)
            || media_by_id
                .get(source_media_id)
                .is_none_or(|media| media.role != "bilibiliReference")
            || source_binding_by_asset.get(asset_id) != Some(source_media_id)
        {
            return Err(format!(
                "投影路由 {} 的资产、参考媒体或来源绑定无效。",
                route.route_id
            ));
        }
        grouped
            .entry((asset_id.clone(), source_media_id.clone()))
            .or_default()
            .push(route);
        if route.kind == "ignored" {
            continue;
        }
        let target_media_id = route
            .target_media_id
            .as_ref()
            .ok_or_else(|| format!("正片路由 {} 缺少 targetMediaId。", route.route_id))?;
        if media_by_id
            .get(target_media_id)
            .is_none_or(|media| media.role != "targetOriginal")
        {
            return Err(format!("正片路由 {} 的目标不是原片。", route.route_id));
        }
        let map_id = route
            .time_map_id
            .as_ref()
            .ok_or_else(|| format!("正片路由 {} 缺少 timeMapId。", route.route_id))?;
        let core = proof_cores
            .get(map_id)
            .ok_or_else(|| format!("正片路由 {} 缺少已签时间图。", route.route_id))?;
        if core.map_id != *map_id
            || core.revision == 0
            || core.source_media_id != *source_media_id
            || core.target_media_id != *target_media_id
            || core.source_start_ms != route.source_start_ms
            || core.source_end_ms != route.source_end_ms
            || core.target_start_ms != route.target_start_ms.unwrap_or(0)
        {
            return Err(format!(
                "正片路由 {} 与已签时间图范围或两端媒体不一致。",
                route.route_id
            ));
        }
    }

    for routes in grouped.values_mut() {
        routes.sort_by(|left, right| {
            left.source_start_ms
                .cmp(&right.source_start_ms)
                .then(left.source_end_ms.cmp(&right.source_end_ms))
        });
        for left_index in 0..routes.len() {
            let left = routes[left_index];
            for right in routes.iter().skip(left_index + 1) {
                if right.source_start_ms >= left.source_end_ms {
                    break;
                }
                let conflict = left.kind == "ignored"
                    || right.kind == "ignored"
                    || left.target_media_id == right.target_media_id;
                if conflict {
                    return Err(format!(
                        "投影路由 {} 与 {} 的来源范围冲突。",
                        left.route_id, right.route_id
                    ));
                }
            }
        }
    }
    Ok(())
}

fn validate_target_output_inventory<'a>(
    derivation: &'a ProjectionDerivationV1,
    media_by_id: &HashMap<String, &ProjectionMediaV1>,
) -> Result<HashMap<String, &'a ProjectionTargetOutputV1>, String> {
    let mut targets = HashMap::new();
    let mut file_names = HashSet::new();
    for target in &derivation.target_output_files {
        validate_projection_id("target output mediaId", &target.target_media_id)?;
        validate_export_file_name(&target.file_name)?;
        if media_by_id
            .get(&target.target_media_id)
            .is_none_or(|media| media.role != "targetOriginal")
        {
            return Err(format!(
                "目标输出 {} 未指向原片媒体。",
                target.target_media_id
            ));
        }
        if !file_names.insert(target.file_name.to_lowercase()) {
            return Err("targetOutputFiles 含重复逻辑文件名。".to_string());
        }
        if targets
            .insert(target.target_media_id.clone(), target)
            .is_some()
        {
            return Err("targetOutputFiles 含重复 targetMediaId。".to_string());
        }
    }
    Ok(targets)
}

fn normalized_string_set<'a>(
    label: &str,
    values: &'a [String],
) -> Result<HashSet<&'a str>, String> {
    let mut result = HashSet::new();
    for value in values {
        validate_projection_id(label, value)?;
        if !result.insert(value.as_str()) {
            return Err(format!("投影 derivation 字段 {label} 含重复值。"));
        }
    }
    Ok(result)
}

fn normalized_adjustment_map(
    adjustments: &[ProjectionItemTimeAdjustmentV1],
) -> Result<HashMap<&str, i64>, String> {
    let mut result = HashMap::new();
    for adjustment in adjustments {
        validate_projection_id("adjustment itemId", &adjustment.item_id)?;
        validate_safe_i64("adjustmentMs", adjustment.adjustment_ms)?;
        if result
            .insert(adjustment.item_id.as_str(), adjustment.adjustment_ms)
            .is_some()
        {
            return Err("投影 derivation 含重复 itemTimeAdjustment。".to_string());
        }
    }
    Ok(result)
}

fn map_signed_source_time(
    core: &SignedTimeMapCore,
    source_time_ms: u64,
) -> Result<Option<u64>, String> {
    for span in &core.spans {
        if span.source_start_ms <= source_time_ms && source_time_ms < span.source_end_ms {
            if span.kind == "sourceOnly"
                || (span.kind == "ambiguous" && core.manual_takeover_approved)
            {
                return Ok(None);
            }
            if span.kind != "matched" {
                return Err(format!(
                    "时间图 {} 在来源时间上命中不可投影 span。",
                    core.map_id
                ));
            }
            let source_duration = span.source_end_ms - span.source_start_ms;
            let target_duration = span.target_end_ms - span.target_start_ms;
            let source_delta = source_time_ms - span.source_start_ms;
            let numerator = u128::from(source_delta) * u128::from(target_duration);
            let denominator = u128::from(source_duration);
            let rounded_delta = (numerator * 2 + denominator) / (denominator * 2);
            let rounded_delta =
                u64::try_from(rounded_delta).map_err(|_| "分段仿射插值结果溢出。".to_string())?;
            let candidate = span
                .target_start_ms
                .checked_add(rounded_delta)
                .ok_or_else(|| "分段仿射插值加法溢出。".to_string())?;
            return Ok(Some(candidate.min(span.target_end_ms - 1)));
        }
    }
    Err(format!(
        "时间图 {} 未覆盖正片路由范围内的来源时间 {}。",
        core.map_id, source_time_ms
    ))
}

#[path = "xml_export_metadata.rs"]
mod xml_export_metadata;

fn serialize_native_bilibili_xml(
    entries: &[NativeProjectedEntry<'_>],
    metadata: Option<&str>,
) -> Result<Vec<u8>, String> {
    let mut output = String::new();
    output.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
    output.push_str("<i>\n");
    output.push_str("  <generator>Danmaku Timeline Studio</generator>\n");
    if let Some(fragment) = metadata {
        xml_export_metadata::validate(fragment)?;
        output.push_str(fragment);
        output.push('\n');
    }
    for entry in entries {
        let mut fields = if entry.item.raw_p_fields.is_empty() {
            projection_fallback_p_fields(entry.item, entry.final_time_ms)
        } else {
            entry.item.raw_p_fields.clone()
        };
        let fallback = projection_fallback_p_fields(entry.item, entry.final_time_ms);
        fields[0] = format_xml_seconds(entry.final_time_ms);
        while fields.len() < fallback.len() {
            fields.push(fallback[fields.len()].clone());
        }
        output.push_str("  <d p=\"");
        output.push_str(&escape_xml_attribute(&fields.join(",")));
        output.push_str("\">");
        output.push_str(&escape_xml_text(&entry.item.text));
        output.push_str("</d>\n");
    }
    output.push_str("</i>\n");
    Ok(output.into_bytes())
}

fn projection_fallback_p_fields(item: &ProjectionDanmakuItemV1, time_ms: u64) -> Vec<String> {
    vec![
        format_xml_seconds(time_ms),
        item.mode.unwrap_or(1).to_string(),
        item.font_size.unwrap_or(25).to_string(),
        item.color.unwrap_or(16_777_215).to_string(),
        item.timestamp.unwrap_or(0).to_string(),
        item.pool.unwrap_or(0).to_string(),
        item.user_hash.clone().unwrap_or_default(),
        item.row_id.clone().unwrap_or_default(),
    ]
}

fn format_xml_seconds(milliseconds: u64) -> String {
    format!("{}.{:03}", milliseconds / 1000, milliseconds % 1000)
}

fn escape_xml_text(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn escape_xml_attribute(text: &str) -> String {
    escape_xml_text(text)
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn logical_output_bytes(
    request: &SaveVerifiedExportFileRequest,
) -> Result<HashMap<String, &[u8]>, String> {
    if request.verification.outputs.len() == 1 {
        return Ok(HashMap::from([(
            request.verification.outputs[0].file_name.clone(),
            request.content_bytes.as_slice(),
        )]));
    }
    Ok(parse_and_verify_stored_zip(&request.content_bytes)?
        .into_iter()
        .collect())
}

fn validate_projection_id(label: &str, value: &str) -> Result<(), String> {
    validate_nonempty_bounded(label, value, 512)
}

fn validate_bounded(label: &str, value: &str, max_bytes: usize) -> Result<(), String> {
    if value.len() > max_bytes {
        return Err(format!("高精度导出字段 {label} 超过大小限制。"));
    }
    Ok(())
}

fn validate_optional_safe_milliseconds(label: &str, value: Option<u64>) -> Result<(), String> {
    if value.is_some_and(|number| number > MAX_SAFE_INTEGER) {
        return Err(format!("高精度导出字段 {label} 超过安全整数范围。"));
    }
    Ok(())
}

fn validate_safe_i64(label: &str, value: i64) -> Result<(), String> {
    let max = i64::try_from(MAX_SAFE_INTEGER).expect("MAX_SAFE_INTEGER fits i64");
    if !(-max..=max).contains(&value) {
        return Err(format!("高精度导出字段 {label} 超过安全整数范围。"));
    }
    Ok(())
}

fn validate_xml_10_characters(label: &str, value: &str) -> Result<(), String> {
    if value.chars().any(|character| {
        !matches!(character, '\u{0009}' | '\u{000a}' | '\u{000d}')
            && !matches!(character as u32, 0x20..=0xd7ff | 0xe000..=0xfffd | 0x10000..=0x10ffff)
    }) {
        return Err(format!(
            "高精度导出字段 {label} 包含 XML 1.0 不允许的字符。"
        ));
    }
    Ok(())
}

fn canonical_verified_export_manifest(
    verification: &VerifiedExportVerification,
) -> Result<Value, String> {
    let mut outputs = verification.outputs.iter().collect::<Vec<_>>();
    outputs.sort_by(|left, right| left.file_name.cmp(&right.file_name));
    let mut map_proofs = verification.map_proofs.iter().collect::<Vec<_>>();
    map_proofs.sort_by(|left, right| left.map_id.cmp(&right.map_id));
    let mut dependencies = verification.dependencies.iter().collect::<Vec<_>>();
    dependencies.sort_by(|left, right| left.media_id.cmp(&right.media_id));

    let output_values = outputs
        .into_iter()
        .map(|output| json!([output.file_name, output.content_digest]))
        .collect::<Vec<_>>();
    let proof_values = map_proofs
        .into_iter()
        .map(|proof| {
            let verification_value = match &proof.automatic_verification {
                Some(automatic) => json!([
                    "automatic-calibration",
                    automatic.calibration_artifact_id,
                    automatic.calibration_artifact_version,
                    automatic.verifier,
                    automatic.verified_at,
                ]),
                None => json!([
                    proof.manual_verification.verification_id,
                    proof.manual_verification.issuer_key_id,
                    proof.manual_verification.signature_algorithm,
                    proof.manual_verification.signature,
                    proof.manual_verification.request_payload,
                    proof.manual_verification.request_digest,
                ]),
            };
            json!([
                proof.map_id,
                proof.revision,
                proof.state,
                proof.declared_quality,
                proof.span_kinds,
                proof.core_digest,
                proof.core_canonical_json,
                proof.source_media_id,
                proof.target_media_id,
                identity_manifest_value(&proof.source_identity),
                identity_manifest_value(&proof.target_identity),
                verification_value
            ])
        })
        .collect::<Vec<_>>();
    let dependency_values = dependencies
        .into_iter()
        .map(|dependency| {
            let mut map_ids = dependency.map_ids.clone();
            map_ids.sort();
            json!([
                dependency.media_id,
                identity_manifest_value(&dependency.expected_identity),
                map_ids
            ])
        })
        .collect::<Vec<_>>();

    Ok(json!([
        VERIFIED_EXPORT_MANIFEST_DOMAIN,
        verification.schema_version,
        verification.project_id,
        verification.project_updated_at,
        verification.project_snapshot_digest,
        verification.archive_file_name,
        verification.archive_content_digest,
        output_values,
        proof_values,
        dependency_values,
    ]))
}

fn canonical_projection_derivation(derivation: &ProjectionDerivationV1) -> Value {
    let media = derivation
        .media
        .iter()
        .map(|media| {
            json!([
                media.media_id,
                media.role,
                media.name,
                media.media_file_name,
                media.duration_ms,
                media.episode_label,
                media.content_identity.as_ref().map(identity_manifest_value)
            ])
        })
        .collect::<Vec<_>>();
    let assets = derivation
        .xml_assets
        .iter()
        .map(|asset| {
            let items = asset
                .items
                .iter()
                .map(|item| {
                    json!([
                        item.item_id,
                        item.asset_id,
                        item.original_index,
                        item.source_time_ms,
                        item.mode,
                        item.font_size,
                        item.color,
                        item.timestamp,
                        item.pool,
                        item.user_hash,
                        item.row_id,
                        item.text,
                        item.raw_p_fields,
                        item.enabled,
                    ])
                })
                .collect::<Vec<_>>();
            let receipt = asset.source_receipt.as_ref().map(|receipt| {
                json!([
                    receipt.domain,
                    receipt.version,
                    receipt.receipt_id,
                    receipt.content_digest,
                    receipt.size_bytes,
                    receipt.parser_version,
                    receipt.inventory_digest,
                    receipt.issuer_key_id,
                    receipt.signature_algorithm,
                    receipt.signature,
                ])
            });
            json!([asset.asset_id, asset.source_file_name, receipt, items])
        })
        .collect::<Vec<_>>();
    let bindings = derivation
        .source_bindings
        .iter()
        .map(|binding| {
            json!([
                binding.binding_id,
                binding.asset_id,
                binding.source_media_id
            ])
        })
        .collect::<Vec<_>>();
    let routes = derivation
        .routes
        .iter()
        .map(|route| {
            let timing_rules = route
                .timing_rules
                .iter()
                .map(|rule| json!([rule.rule_id, rule.source_at_ms, rule.gap_ms]))
                .collect::<Vec<_>>();
            json!([
                route.route_id,
                route.kind,
                route.asset_id,
                route.source_media_id,
                route.source_start_ms,
                route.source_end_ms,
                route.target_media_id,
                route.target_start_ms,
                route.time_map_id,
                timing_rules,
            ])
        })
        .collect::<Vec<_>>();
    let adjustments = derivation
        .item_time_adjustments
        .iter()
        .map(|adjustment| json!([adjustment.item_id, adjustment.adjustment_ms]))
        .collect::<Vec<_>>();
    let target_outputs = derivation
        .target_output_files
        .iter()
        .map(|target| match &target.metadata_xml {
            Some(metadata) => json!([target.target_media_id, target.file_name, metadata]),
            None => json!([target.target_media_id, target.file_name]),
        })
        .collect::<Vec<_>>();
    json!([
        derivation.domain,
        derivation.projection_policy_version,
        derivation.serializer_version,
        derivation.project_id,
        derivation.project_updated_at,
        media,
        assets,
        bindings,
        routes,
        derivation.disabled_item_ids,
        adjustments,
        target_outputs,
    ])
}

fn identity_manifest_value(identity: &ExpectedMediaContentIdentity) -> Value {
    json!([
        identity.algorithm,
        identity.size_bytes,
        identity.modified_unix_ms,
        identity.first_sample_digest,
        identity.middle_sample_digest,
        identity.last_sample_digest,
    ])
}

fn validate_media_identity_shape(identity: &ExpectedMediaContentIdentity) -> Result<(), String> {
    if identity.algorithm != "sha256-full-file-v2" {
        return Err("高精度导出只接受 sha256-full-file-v2 全文件媒体身份。".to_string());
    }
    for digest in [
        identity.first_sample_digest.as_str(),
        identity.middle_sample_digest.as_str(),
        identity.last_sample_digest.as_str(),
    ] {
        validate_hex("media identity digest", digest, 64)?;
    }
    Ok(())
}

fn validate_nonempty_bounded(label: &str, value: &str, max_bytes: usize) -> Result<(), String> {
    if value.trim().is_empty() || value.len() > max_bytes {
        return Err(format!("高精度导出字段 {label} 为空或超过大小限制。"));
    }
    Ok(())
}

fn validate_sha256_digest(label: &str, value: &str) -> Result<(), String> {
    if !value.starts_with("sha256:") || validate_hex(label, &value[7..], 64).is_err() {
        return Err(format!("高精度导出字段 {label} 不是规范 SHA-256 摘要。"));
    }
    Ok(())
}

fn validate_hex(label: &str, value: &str, expected_len: usize) -> Result<(), String> {
    if value.len() != expected_len
        || !value
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
    {
        return Err(format!(
            "高精度导出字段 {label} 必须是 {expected_len} 位小写十六进制。"
        ));
    }
    Ok(())
}

fn sha256_digest(bytes: &[u8]) -> String {
    format!("sha256:{}", hex_encode(&Sha256::digest(bytes)))
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

fn parse_and_verify_stored_zip(bytes: &[u8]) -> Result<Vec<(String, &[u8])>, String> {
    if bytes.len() < 22 {
        return Err("多文件高精度导出不是完整 ZIP。".to_string());
    }
    let end_offset = bytes.len() - 22;
    if read_u32(bytes, end_offset)? != 0x0605_4b50
        || read_u16(bytes, end_offset + 4)? != 0
        || read_u16(bytes, end_offset + 6)? != 0
        || read_u16(bytes, end_offset + 20)? != 0
    {
        return Err("多文件高精度导出 ZIP 终止记录无效。".to_string());
    }
    let disk_entries = usize::from(read_u16(bytes, end_offset + 8)?);
    let total_entries = usize::from(read_u16(bytes, end_offset + 10)?);
    let central_size = usize::try_from(read_u32(bytes, end_offset + 12)?)
        .map_err(|_| "ZIP 中央目录大小越界。".to_string())?;
    let central_offset = usize::try_from(read_u32(bytes, end_offset + 16)?)
        .map_err(|_| "ZIP 中央目录偏移越界。".to_string())?;
    if disk_entries != total_entries
        || total_entries == 0
        || central_offset
            .checked_add(central_size)
            .is_none_or(|value| value != end_offset)
    {
        return Err("多文件高精度导出 ZIP 中央目录边界无效。".to_string());
    }

    let mut central_cursor = central_offset;
    let mut names = HashSet::new();
    let mut entries = Vec::with_capacity(total_entries);
    for _ in 0..total_entries {
        require_range(bytes, central_cursor, 46)?;
        if read_u32(bytes, central_cursor)? != 0x0201_4b50
            || read_u16(bytes, central_cursor + 8)? != 0x0800
            || read_u16(bytes, central_cursor + 10)? != 0
        {
            return Err("ZIP 中央目录不是 UTF-8 stored entry。".to_string());
        }
        let crc = read_u32(bytes, central_cursor + 16)?;
        let compressed_size = usize::try_from(read_u32(bytes, central_cursor + 20)?)
            .map_err(|_| "ZIP entry 大小越界。".to_string())?;
        let uncompressed_size = usize::try_from(read_u32(bytes, central_cursor + 24)?)
            .map_err(|_| "ZIP entry 大小越界。".to_string())?;
        let name_len = usize::from(read_u16(bytes, central_cursor + 28)?);
        let extra_len = usize::from(read_u16(bytes, central_cursor + 30)?);
        let comment_len = usize::from(read_u16(bytes, central_cursor + 32)?);
        let local_offset = usize::try_from(read_u32(bytes, central_cursor + 42)?)
            .map_err(|_| "ZIP local header 偏移越界。".to_string())?;
        if compressed_size != uncompressed_size || extra_len != 0 || comment_len != 0 {
            return Err("高精度导出只接受无压缩、无附加字段的确定性 ZIP。".to_string());
        }
        require_range(bytes, central_cursor + 46, name_len)?;
        let central_name =
            std::str::from_utf8(&bytes[central_cursor + 46..central_cursor + 46 + name_len])
                .map_err(|_| "ZIP 文件名不是 UTF-8。".to_string())?;
        validate_export_file_name(central_name)?;
        if !names.insert(central_name.to_lowercase()) {
            return Err("ZIP 含重复逻辑文件名。".to_string());
        }

        require_range(bytes, local_offset, 30)?;
        if read_u32(bytes, local_offset)? != 0x0403_4b50
            || read_u16(bytes, local_offset + 6)? != 0x0800
            || read_u16(bytes, local_offset + 8)? != 0
            || read_u32(bytes, local_offset + 14)? != crc
            || usize::try_from(read_u32(bytes, local_offset + 18)?).ok() != Some(compressed_size)
            || usize::try_from(read_u32(bytes, local_offset + 22)?).ok() != Some(uncompressed_size)
        {
            return Err("ZIP local header 与中央目录不一致。".to_string());
        }
        let local_name_len = usize::from(read_u16(bytes, local_offset + 26)?);
        let local_extra_len = usize::from(read_u16(bytes, local_offset + 28)?);
        require_range(bytes, local_offset + 30, local_name_len + local_extra_len)?;
        let local_name =
            std::str::from_utf8(&bytes[local_offset + 30..local_offset + 30 + local_name_len])
                .map_err(|_| "ZIP local 文件名不是 UTF-8。".to_string())?;
        if local_name != central_name || local_extra_len != 0 {
            return Err("ZIP local 文件名与中央目录不一致。".to_string());
        }
        let data_start = local_offset + 30 + local_name_len;
        require_range(bytes, data_start, compressed_size)?;
        let data = &bytes[data_start..data_start + compressed_size];
        if crc32(data) != crc {
            return Err(format!("ZIP 文件 {central_name} 的 CRC32 无效。"));
        }
        entries.push((central_name.to_string(), data));
        central_cursor = central_cursor
            .checked_add(46 + name_len + extra_len + comment_len)
            .ok_or_else(|| "ZIP 中央目录偏移溢出。".to_string())?;
    }
    if central_cursor != end_offset {
        return Err("ZIP 中央目录含未声明尾部数据。".to_string());
    }
    Ok(entries)
}

fn read_u16(bytes: &[u8], offset: usize) -> Result<u16, String> {
    require_range(bytes, offset, 2)?;
    Ok(u16::from_le_bytes([bytes[offset], bytes[offset + 1]]))
}

fn read_u32(bytes: &[u8], offset: usize) -> Result<u32, String> {
    require_range(bytes, offset, 4)?;
    Ok(u32::from_le_bytes([
        bytes[offset],
        bytes[offset + 1],
        bytes[offset + 2],
        bytes[offset + 3],
    ]))
}

fn require_range(bytes: &[u8], offset: usize, length: usize) -> Result<(), String> {
    if offset
        .checked_add(length)
        .is_none_or(|end| end > bytes.len())
    {
        return Err("ZIP 结构越过输入边界。".to_string());
    }
    Ok(())
}

fn crc32(bytes: &[u8]) -> u32 {
    let mut value = 0xffff_ffff_u32;
    for byte in bytes {
        value ^= u32::from(*byte);
        for _ in 0..8 {
            value = if value & 1 == 1 {
                0xedb8_8320 ^ (value >> 1)
            } else {
                value >> 1
            };
        }
    }
    value ^ 0xffff_ffff
}

fn identity_matches(
    expected: &ExpectedMediaContentIdentity,
    actual: &MediaContentIdentity,
) -> bool {
    let content_fields_match = expected.algorithm == actual.algorithm
        && expected.size_bytes == actual.size_bytes
        && expected.first_sample_digest == actual.first_sample_digest
        && expected.middle_sample_digest == actual.middle_sample_digest
        && expected.last_sample_digest == actual.last_sample_digest;
    if expected.algorithm == "sha256-full-file-v2" {
        // v2 is a whole-file content identity. mtime remains useful diagnostics but touching an
        // otherwise identical file must not invalidate a confirmed map.
        content_fields_match
    } else {
        // Legacy sampled identities require every persisted field for conservative compatibility.
        content_fields_match && expected.modified_unix_ms == actual.modified_unix_ms
    }
}

fn expected_identities_match(
    left: &ExpectedMediaContentIdentity,
    right: &ExpectedMediaContentIdentity,
) -> bool {
    let content_fields_match = left.algorithm == right.algorithm
        && left.size_bytes == right.size_bytes
        && left.first_sample_digest == right.first_sample_digest
        && left.middle_sample_digest == right.middle_sample_digest
        && left.last_sample_digest == right.last_sample_digest;
    if left.algorithm == "sha256-full-file-v2" {
        content_fields_match
    } else {
        content_fields_match && left.modified_unix_ms == right.modified_unix_ms
    }
}

#[tauri::command]
pub fn open_export_directory(directory_path: String) -> Result<(), String> {
    let directory = validate_export_directory(&directory_path)?;
    open_directory(&directory)
}

fn validate_export_directory(raw: &str) -> Result<PathBuf, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("请选择导出文件夹。".to_string());
    }
    let path = PathBuf::from(trimmed);
    if !path.is_absolute() {
        return Err("导出文件夹需要是完整路径。".to_string());
    }
    let metadata = fs::metadata(&path).map_err(|error| match error.kind() {
        ErrorKind::NotFound => "导出文件夹不存在，请重新选择。".to_string(),
        ErrorKind::PermissionDenied => "没有权限访问导出文件夹，请换一个目录。".to_string(),
        _ => format!("无法读取导出文件夹：{error}"),
    })?;
    if !metadata.is_dir() {
        return Err("导出位置不是文件夹，请重新选择。".to_string());
    }
    Ok(path)
}

fn validate_export_file_name(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.encode_utf16().count() > 240 {
        return Err("导出文件名无效。".to_string());
    }
    let mut components = Path::new(trimmed).components();
    if !matches!(components.next(), Some(Component::Normal(_))) || components.next().is_some() {
        return Err("导出文件名必须是单个普通文件名，不能包含盘符、路径或前缀。".to_string());
    }
    if trimmed
        .chars()
        .any(|character| character <= '\u{001f}' || r#"<>:"/\|?*"#.contains(character))
        || trimmed.ends_with(['.', ' '])
    {
        return Err("导出文件名包含 Windows 不允许的字符或结尾。".to_string());
    }
    let device_base = trimmed
        .split('.')
        .next()
        .unwrap_or(trimmed)
        .to_ascii_uppercase();
    let reserved_device = matches!(device_base.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || device_base.strip_prefix("COM").is_some_and(|suffix| {
            matches!(suffix, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
        })
        || device_base.strip_prefix("LPT").is_some_and(|suffix| {
            matches!(suffix, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
        });
    if reserved_device {
        return Err("导出文件名不能使用 Windows 保留设备名。".to_string());
    }
    Ok(trimmed.to_string())
}

fn validate_text_report_file_name(raw: &str) -> Result<String, String> {
    let file_name = validate_export_file_name(raw)?;
    if !has_case_insensitive_extension(&file_name, "txt") {
        return Err("普通文本报告只能写入 .txt 文件。".to_string());
    }
    Ok(file_name)
}

fn has_case_insensitive_extension(file_name: &str, expected: &str) -> bool {
    Path::new(file_name)
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case(expected))
}

fn split_file_name(file_name: &str) -> (String, String) {
    match file_name.rsplit_once('.') {
        Some((base, extension)) if !base.is_empty() => (base.to_string(), format!(".{extension}")),
        _ => (file_name.to_string(), String::new()),
    }
}

fn format_export_write_error(directory: &Path, target: &Path, error: std::io::Error) -> String {
    match error.kind() {
        ErrorKind::PermissionDenied => format!(
            "没有权限写入导出文件夹：{}。请换一个目录或检查文件权限。",
            directory.to_string_lossy()
        ),
        ErrorKind::AlreadyExists => format!(
            "导出文件已存在且无法自动改名：{}。",
            target.to_string_lossy()
        ),
        _ => format!("写入导出文件失败：{error}"),
    }
}

#[cfg(target_os = "windows")]
fn open_directory(directory: &Path) -> Result<(), String> {
    Command::new("explorer")
        .arg(directory)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("打开导出文件夹失败：{error}"))
}

#[cfg(target_os = "macos")]
fn open_directory(directory: &Path) -> Result<(), String> {
    Command::new("open")
        .arg(directory)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("打开导出文件夹失败：{error}"))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_directory(directory: &Path) -> Result<(), String> {
    Command::new("xdg-open")
        .arg(directory)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("打开导出文件夹失败：{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_file_names_with_path_segments() {
        assert!(validate_export_file_name("episode.xml").is_ok());
        assert!(validate_export_file_name(".hidden.xml").is_ok());
        assert!(validate_export_file_name("分集😀.xml").is_ok());
        assert!(validate_export_file_name("nested/episode.xml").is_err());
        assert!(validate_export_file_name("nested\\episode.xml").is_err());
        for invalid in [
            "C:outside.xml",
            "name.xml:stream",
            "CON",
            "con.txt",
            "NUL ",
            "episode.xml.",
            "bad\u{001f}.xml",
        ] {
            assert!(
                validate_export_file_name(invalid).is_err(),
                "Windows 危险文件名必须拒绝：{invalid:?}"
            );
        }
        assert!(validate_export_file_name(" ").is_err());
    }

    #[test]
    fn text_report_command_only_writes_bounded_utf8_txt_files() {
        let unique = tempfile_like_path("danmaku-export-text-report");
        let _ = fs::remove_dir_all(&unique);
        fs::create_dir_all(&unique).unwrap();

        let result = save_text_report_file(SaveTextReportFileRequest {
            directory_path: unique.to_string_lossy().to_string(),
            file_name: "检查报告.TXT".to_string(),
            content: "中文 UTF-8 报告".to_string(),
        })
        .unwrap();
        assert_eq!(result.file_name, "检查报告.TXT");
        assert_eq!(
            fs::read_to_string(unique.join("检查报告.TXT")).unwrap(),
            "中文 UTF-8 报告"
        );

        for file_name in ["projected.xml", "projected.zip", "report.json", "report"] {
            let error = save_text_report_file(SaveTextReportFileRequest {
                directory_path: unique.to_string_lossy().to_string(),
                file_name: file_name.to_string(),
                content: "not allowed".to_string(),
            })
            .unwrap_err();
            assert!(error.contains("只能写入 .txt"));
            assert!(!unique.join(file_name).exists());
        }

        let oversized_name = "oversized.txt";
        let error = save_text_report_file(SaveTextReportFileRequest {
            directory_path: unique.to_string_lossy().to_string(),
            file_name: oversized_name.to_string(),
            content: "x".repeat(MAX_TEXT_REPORT_BYTES + 1),
        })
        .unwrap_err();
        assert!(error.contains("MiB 上限"));
        assert!(!unique.join(oversized_name).exists());
        fs::remove_dir_all(unique).unwrap();
    }

    #[test]
    fn splits_names_without_losing_extension() {
        assert_eq!(
            split_file_name("episode.xml"),
            ("episode".to_string(), ".xml".to_string())
        );
        assert_eq!(
            split_file_name("archive"),
            ("archive".to_string(), "".to_string())
        );
    }

    #[test]
    fn existing_file_is_never_overwritten_when_choosing_a_duplicate_name() {
        let unique = tempfile_like_path("danmaku-export-unique");
        let _ = fs::remove_dir_all(&unique);
        fs::create_dir_all(&unique).unwrap();
        fs::write(unique.join("episode.xml"), "old").unwrap();

        let result = write_export_file(&unique, "episode.xml", b"new").unwrap();

        assert_eq!(result.file_name, "episode (2).xml");
        assert!(result.was_renamed);
        assert_eq!(fs::read(unique.join("episode.xml")).unwrap(), b"old");
        assert_eq!(fs::read(unique.join("episode (2).xml")).unwrap(), b"new");
        fs::remove_dir_all(unique).unwrap();
    }

    #[test]
    fn concurrent_writers_atomically_claim_distinct_file_names() {
        use std::collections::HashSet;
        use std::sync::{Arc, Barrier};
        use std::thread;

        let unique = tempfile_like_path("danmaku-export-concurrent");
        let _ = fs::remove_dir_all(&unique);
        fs::create_dir_all(&unique).unwrap();
        let directory = Arc::new(unique.clone());
        let barrier = Arc::new(Barrier::new(8));
        let handles = (0..8)
            .map(|index| {
                let directory = Arc::clone(&directory);
                let barrier = Arc::clone(&barrier);
                thread::spawn(move || {
                    let content = format!("writer-{index}");
                    barrier.wait();
                    let result =
                        write_export_file(directory.as_path(), "episode.xml", content.as_bytes())
                            .unwrap();
                    (result.file_name, content)
                })
            })
            .collect::<Vec<_>>();

        let results = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect::<Vec<_>>();
        let file_names = results
            .iter()
            .map(|(file_name, _)| file_name.as_str())
            .collect::<HashSet<_>>();
        assert_eq!(file_names.len(), 8);
        for (file_name, expected_content) in results {
            assert_eq!(
                fs::read_to_string(unique.join(file_name)).unwrap(),
                expected_content
            );
        }
        fs::remove_dir_all(unique).unwrap();
    }

    #[test]
    fn verified_save_rechecks_media_identity_before_writing() {
        let unique = tempfile_like_path("danmaku-export-verified");
        let _ = fs::remove_dir_all(&unique);
        fs::create_dir_all(&unique).unwrap();
        let (source_path, target_path, source_identity, target_identity) =
            create_media_pair(&unique);
        let request = verified_request(
            &unique,
            &source_path,
            &target_path,
            source_identity,
            target_identity,
        );

        let mut authority_checks = 0;
        let result = save_verified_projected_xml_export_with_authority(request, |_| {
            authority_checks += 1;
            Ok(())
        })
        .unwrap();

        assert_eq!(result.file_name, "episode.xml");
        assert_eq!(authority_checks, 1);
        assert_eq!(
            fs::read(unique.join("episode.xml")).unwrap(),
            request_fixture_xml()
        );
        fs::remove_dir_all(unique).unwrap();
    }

    #[test]
    fn verified_save_accepts_only_native_revalidated_automatic_policy_proof() {
        let unique = tempfile_like_path("danmaku-export-automatic-proof");
        let _ = fs::remove_dir_all(&unique);
        fs::create_dir_all(&unique).unwrap();
        let (source_path, target_path, source_identity, target_identity) =
            create_media_pair(&unique);
        let mut request = verified_request(
            &unique,
            &source_path,
            &target_path,
            source_identity,
            target_identity,
        );
        convert_request_to_automatic_proof(&mut request);

        let mut authority_checks = 0;
        let result =
            save_verified_projected_xml_export_with_authority(clone_request(&request), |_| {
                authority_checks += 1;
                Ok(())
            })
            .unwrap();
        assert_eq!(authority_checks, 0);
        assert_eq!(result.file_name, "episode.xml");

        let mut forged_artifact = request;
        forged_artifact.verification.map_proofs[0]
            .automatic_verification
            .as_mut()
            .unwrap()
            .calibration_artifact_version = "999".to_string();
        resign_manifest(&mut forged_artifact.verification);
        let error = save_verified_projected_xml_export_with_authority(forged_artifact, |_| Ok(()))
            .unwrap_err();
        assert!(error.contains("calibration artifact/version"));
        fs::remove_dir_all(unique).unwrap();
    }

    #[test]
    fn projected_export_shape_requires_xml_outputs_and_zip_only_for_multiple_outputs() {
        let unique = tempfile_like_path("danmaku-export-purpose-shape");
        let _ = fs::remove_dir_all(&unique);
        fs::create_dir_all(&unique).unwrap();
        let (source_path, target_path, source_identity, target_identity) =
            create_media_pair(&unique);
        let base = verified_request(
            &unique,
            &source_path,
            &target_path,
            source_identity,
            target_identity,
        );
        assert!(validate_projected_export_file_shape(&base).is_ok());

        let mut non_xml_output = clone_request(&base);
        non_xml_output.verification.outputs[0].file_name = "episode.txt".to_string();
        assert!(validate_projected_export_file_shape(&non_xml_output)
            .unwrap_err()
            .contains("逻辑输出必须使用 .xml"));

        let mut non_xml_outer = clone_request(&base);
        non_xml_outer.file_name = "episode.txt".to_string();
        assert!(validate_projected_export_file_shape(&non_xml_outer)
            .unwrap_err()
            .contains("单文件写盘目标必须使用 .xml"));

        let mut multiple_with_xml_outer = clone_request(&base);
        multiple_with_xml_outer
            .verification
            .outputs
            .push(VerifiedExportOutput {
                file_name: "episode-2.xml".to_string(),
                content_digest: sha256_digest(b"second"),
            });
        assert!(
            validate_projected_export_file_shape(&multiple_with_xml_outer)
                .unwrap_err()
                .contains("多文件写盘目标必须使用 .zip")
        );
        multiple_with_xml_outer.file_name = "season.ZIP".to_string();
        assert!(validate_projected_export_file_shape(&multiple_with_xml_outer).is_ok());
        fs::remove_dir_all(unique).unwrap();
    }

    #[test]
    fn verified_save_refuses_a_media_replaced_after_preflight() {
        let unique = tempfile_like_path("danmaku-export-replaced");
        let _ = fs::remove_dir_all(&unique);
        fs::create_dir_all(&unique).unwrap();
        let (source_path, target_path, source_identity, target_identity) =
            create_media_pair(&unique);
        fs::write(&source_path, vec![9_u8; 256 * 1024]).unwrap();
        let error = save_verified_projected_xml_export_with_authority(
            verified_request(
                &unique,
                &source_path,
                &target_path,
                source_identity,
                target_identity,
            ),
            |_| Ok(()),
        )
        .unwrap_err();

        assert!(error.contains("已在预检后被替换或修改"));
        assert!(!unique.join("episode.xml").exists());
        fs::remove_dir_all(unique).unwrap();
    }

    #[test]
    fn native_projection_rebuild_applies_item_adjustments_and_serializer_rules() {
        let unique = tempfile_like_path("danmaku-export-native-rebuild-adjustment");
        let _ = fs::remove_dir_all(&unique);
        fs::create_dir_all(&unique).unwrap();
        let (source_path, target_path, source_identity, target_identity) =
            create_media_pair(&unique);
        let mut request = verified_request(
            &unique,
            &source_path,
            &target_path,
            source_identity,
            target_identity,
        );
        request
            .verification
            .projection_derivation
            .item_time_adjustments = vec![ProjectionItemTimeAdjustmentV1 {
            item_id: "asset-1_item_0".to_string(),
            adjustment_ms: 50,
        }];
        request.content_bytes = String::from_utf8(request_fixture_xml())
            .unwrap()
            .replace("0.100", "0.150")
            .into_bytes();
        let digest = sha256_digest(&request.content_bytes);
        request.verification.archive_content_digest = digest.clone();
        request.verification.outputs[0].content_digest = digest;
        resign_manifest(&mut request.verification);

        let result =
            save_verified_projected_xml_export_with_authority(request, |_| Ok(())).unwrap();
        assert_eq!(result.file_name, "episode.xml");
        assert!(String::from_utf8(fs::read(result.file_path).unwrap())
            .unwrap()
            .contains("p=\"0.150,1,25,16777215,0,0,,\""));
        fs::remove_dir_all(unique).unwrap();
    }

    #[test]
    fn verified_writer_accepts_explicit_manual_takeover_with_replacement_span() {
        let unique = tempfile_like_path("danmaku-export-manual-takeover");
        let _ = fs::remove_dir_all(&unique);
        fs::create_dir_all(&unique).unwrap();
        let (source_path, target_path, source_identity, target_identity) =
            create_media_pair(&unique);
        let mut request = verified_request(
            &unique,
            &source_path,
            &target_path,
            source_identity,
            target_identity,
        );
        let mut core: Value =
            serde_json::from_str(&request.verification.map_proofs[0].core_canonical_json).unwrap();
        let fields = core.as_array_mut().unwrap();
        fields[14].as_array_mut().unwrap()[0] = json!(0.60);
        fields[14].as_array_mut().unwrap()[3] = json!(0.20);
        fields[14].as_array_mut().unwrap()[9] = json!(0.20);
        fields[15].as_array_mut().unwrap()[5] = json!(0.20);
        fields[15].as_array_mut().unwrap()[9] = json!([
            "fixture",
            "manual-takeover:v1:2026-07-12T00:00:00.000Z",
            "manual-span-review:v1:1:replacement:用户明确接受版本替换段不导出"
        ]);
        let spans = fields[13].as_array_mut().unwrap();
        spans[0].as_array_mut().unwrap()[0] = json!("span-1-matched-0-500-0-500");
        spans[0].as_array_mut().unwrap()[3] = json!(500);
        spans[0].as_array_mut().unwrap()[5] = json!(500);
        let mut replacement = spans[0].clone();
        let replacement_fields = replacement.as_array_mut().unwrap();
        replacement_fields[0] = json!("span-2-ambiguous-500-1000-500-1000");
        replacement_fields[1] = json!("ambiguous");
        replacement_fields[2] = json!(500);
        replacement_fields[3] = json!(1000);
        replacement_fields[4] = json!(500);
        replacement_fields[5] = json!(1000);
        replacement_fields[6] = json!("人工接管版本替换段");
        spans.push(replacement);
        request.verification.map_proofs[0].span_kinds =
            vec!["matched".to_string(), "ambiguous".to_string()];
        rebind_signed_core_and_request(&mut request, core);

        let result =
            save_verified_projected_xml_export_with_authority(request, |_| Ok(())).unwrap();
        assert_eq!(result.file_name, "episode.xml");
        assert!(unique.join("episode.xml").exists());
        fs::remove_dir_all(unique).unwrap();
    }

    #[test]
    fn verified_writer_keeps_comments_in_explicit_provisional_playback_mapping() {
        let unique = tempfile_like_path("danmaku-export-provisional-playback");
        fs::create_dir_all(&unique).unwrap();
        let (source_path, target_path, source_identity, target_identity) =
            create_media_pair(&unique);
        let mut request = verified_request(
            &unique,
            &source_path,
            &target_path,
            source_identity,
            target_identity,
        );
        let mut core: Value =
            serde_json::from_str(&request.verification.map_proofs[0].core_canonical_json).unwrap();
        let fields = core.as_array_mut().unwrap();
        fields[14].as_array_mut().unwrap()[0] = json!(0.30);
        fields[15].as_array_mut().unwrap()[9] = json!([
            "fixture",
            "manual-takeover:v1:2026-09-14T00:00:00.000Z",
            "playback-adoption:v1:2026-09-14T00:00:00.000Z",
            "playback-provisional-span:v1:span-1"
        ]);
        fields[13].as_array_mut().unwrap()[0]
            .as_array_mut()
            .unwrap()[0] = json!("span-1");
        rebind_signed_core_and_request(&mut request, core);
        let result =
            save_verified_projected_xml_export_with_authority(request, |_| Ok(())).unwrap();
        let xml = fs::read_to_string(&result.file_path).unwrap();
        assert!(xml.contains("p=\"0.100,1,25,16777215,0,0,,\""));
        assert!(xml.contains("fixture &amp; text"));
        fs::remove_dir_all(unique).unwrap();
    }

    #[test]
    fn verified_writer_does_not_block_long_source_xml_outside_confirmed_routes() {
        let unique = tempfile_like_path("danmaku-export-long-source-xml");
        let _ = fs::remove_dir_all(&unique);
        fs::create_dir_all(&unique).unwrap();
        let (source_path, target_path, source_identity, target_identity) =
            create_media_pair(&unique);
        let mut request = verified_request(
            &unique,
            &source_path,
            &target_path,
            source_identity,
            target_identity,
        );
        for index in 1_u64..=10 {
            request.verification.projection_derivation.xml_assets[0]
                .items
                .push(ProjectionDanmakuItemV1 {
                    item_id: format!("asset-1_item_{index}"),
                    asset_id: "asset-1".to_string(),
                    original_index: index,
                    source_time_ms: 1_000 + index,
                    mode: None,
                    font_size: None,
                    color: None,
                    timestamp: None,
                    pool: None,
                    user_hash: None,
                    row_id: None,
                    text: format!("outside confirmed route {index}"),
                    raw_p_fields: Vec::new(),
                    enabled: true,
                });
        }
        resign_manifest(&mut request.verification);

        let result =
            save_verified_projected_xml_export_with_authority(request, |_| Ok(())).unwrap();
        assert_eq!(result.file_name, "episode.xml");
        assert!(unique.join("episode.xml").exists());
        fs::remove_dir_all(unique).unwrap();
    }

    #[test]
    fn verified_envelope_rejects_quality_span_proof_and_request_tampering() {
        let unique = tempfile_like_path("danmaku-export-proof-tamper");
        let _ = fs::remove_dir_all(&unique);
        fs::create_dir_all(&unique).unwrap();
        let (source_path, target_path, source_identity, target_identity) =
            create_media_pair(&unique);
        let base = verified_request(
            &unique,
            &source_path,
            &target_path,
            source_identity,
            target_identity,
        );

        let mut low_quality = clone_request(&base);
        low_quality.verification.map_proofs[0].declared_quality = "review".to_string();
        resign_manifest(&mut low_quality.verification);
        assert_rejected_without_write(&low_quality, &unique, "declaredQuality=verified");

        let mut ambiguous = clone_request(&base);
        ambiguous.verification.map_proofs[0]
            .span_kinds
            .push("ambiguous".to_string());
        resign_manifest(&mut ambiguous.verification);
        assert_rejected_without_write(&ambiguous, &unique, "ambiguous/未知 span");

        let mut self_consistent_low_metrics = clone_request(&base);
        let mut low_metrics_core: Value = serde_json::from_str(
            &self_consistent_low_metrics.verification.map_proofs[0].core_canonical_json,
        )
        .unwrap();
        low_metrics_core.as_array_mut().unwrap()[14]
            .as_array_mut()
            .unwrap()[0] = json!(0.99);
        rebind_signed_core_and_request(&mut self_consistent_low_metrics, low_metrics_core);
        assert_rejected_without_write(
            &self_consistent_low_metrics,
            &unique,
            "低于 verified 最低契约",
        );

        let mut self_consistent_blocked_span = clone_request(&base);
        let mut blocked_span_core: Value = serde_json::from_str(
            &self_consistent_blocked_span.verification.map_proofs[0].core_canonical_json,
        )
        .unwrap();
        blocked_span_core.as_array_mut().unwrap()[13]
            .as_array_mut()
            .unwrap()[0]
            .as_array_mut()
            .unwrap()[7]
            .as_array_mut()
            .unwrap()[0] = json!("blocked");
        rebind_signed_core_and_request(&mut self_consistent_blocked_span, blocked_span_core);
        assert_rejected_without_write(&self_consistent_blocked_span, &unique, "仍为 blocked");

        let mut unsigned_core_change = clone_request(&base);
        unsigned_core_change.verification.map_proofs[0]
            .core_canonical_json
            .push(' ');
        resign_manifest(&mut unsigned_core_change.verification);
        assert_rejected_without_write(
            &unsigned_core_change,
            &unique,
            "coreCanonicalJson 与已签 coreDigest 不一致",
        );

        let mut missing_proof = clone_request(&base);
        missing_proof.verification.map_proofs.clear();
        resign_manifest(&mut missing_proof.verification);
        assert_rejected_without_write(&missing_proof, &unique, "没有携带被引用时间图 proof");

        let mut forged_request = clone_request(&base);
        forged_request.verification.map_proofs[0]
            .manual_verification
            .request_payload = "[]".to_string();
        forged_request.verification.map_proofs[0]
            .manual_verification
            .request_digest = sha256_digest(b"[]");
        resign_manifest(&mut forged_request.verification);
        assert_rejected_without_write(&forged_request, &unique, "未绑定当前 map/revision/core");

        fs::remove_dir_all(unique).unwrap();
    }

    #[test]
    fn signed_v2_core_rejects_incomplete_span_evidence_and_optimistic_p99() {
        let unique = tempfile_like_path("danmaku-export-v2-span-evidence");
        let _ = fs::remove_dir_all(&unique);
        fs::create_dir_all(&unique).unwrap();
        let (source_path, target_path, source_identity, target_identity) =
            create_media_pair(&unique);
        let request = verified_request(
            &unique,
            &source_path,
            &target_path,
            source_identity,
            target_identity,
        );
        let mut proof = request.verification.map_proofs[0].clone();
        let original: Value = serde_json::from_str(&proof.core_canonical_json).unwrap();

        let mut incomplete = original.clone();
        incomplete.as_array_mut().unwrap()[13]
            .as_array_mut()
            .unwrap()[0]
            .as_array_mut()
            .unwrap()
            .pop();
        proof.core_canonical_json = serde_json::to_string(&incomplete).unwrap();
        proof.core_digest = sha256_digest(proof.core_canonical_json.as_bytes());
        assert!(parse_and_validate_signed_time_map_core(&proof)
            .unwrap_err()
            .contains("span 字段数量无效"));

        let mut optimistic_p99 = original;
        optimistic_p99.as_array_mut().unwrap()[13]
            .as_array_mut()
            .unwrap()[0]
            .as_array_mut()
            .unwrap()[7]
            .as_array_mut()
            .unwrap()[10] = json!(5);
        proof.core_canonical_json = serde_json::to_string(&optimistic_p99).unwrap();
        proof.core_digest = sha256_digest(proof.core_canonical_json.as_bytes());
        assert!(parse_and_validate_signed_time_map_core(&proof)
            .unwrap_err()
            .contains("不是单调残差分位数"));

        fs::remove_dir_all(unique).unwrap();
    }

    #[test]
    fn verified_envelope_rejects_content_manifest_and_dependency_tampering() {
        let unique = tempfile_like_path("danmaku-export-envelope-tamper");
        let _ = fs::remove_dir_all(&unique);
        fs::create_dir_all(&unique).unwrap();
        let (source_path, target_path, source_identity, target_identity) =
            create_media_pair(&unique);
        let base = verified_request(
            &unique,
            &source_path,
            &target_path,
            source_identity,
            target_identity,
        );

        let mut content = clone_request(&base);
        content.content_bytes = b"<i>tampered</i>".to_vec();
        assert_rejected_without_write(&content, &unique, "待写盘内容 SHA-256");

        let mut self_consistent_forgery = clone_request(&base);
        self_consistent_forgery.content_bytes = b"<i>forged but fully resigned</i>".to_vec();
        let forged_digest = sha256_digest(&self_consistent_forgery.content_bytes);
        self_consistent_forgery.verification.outputs[0].content_digest = forged_digest.clone();
        self_consistent_forgery.verification.archive_content_digest = forged_digest;
        resign_manifest(&mut self_consistent_forgery.verification);
        assert_rejected_without_write(
            &self_consistent_forgery,
            &unique,
            "不是由已签时间图和完整投影 inventory 推导所得",
        );

        let mut manifest = clone_request(&base);
        manifest.verification.manifest_digest = sha256_digest(b"not-the-manifest");
        assert_rejected_without_write(&manifest, &unique, "manifest SHA-256");

        let mut dependency = clone_request(&base);
        dependency.verification.dependencies[0].map_ids.clear();
        resign_manifest(&mut dependency.verification);
        assert_rejected_without_write(&dependency, &unique, "没有绑定任何时间图");

        fs::remove_dir_all(unique).unwrap();
    }

    #[test]
    fn receipt_bound_projection_rejects_missing_receipt_and_resigned_item_tampering() {
        let unique = tempfile_like_path("danmaku-export-xml-receipt-binding");
        let _ = fs::remove_dir_all(&unique);
        fs::create_dir_all(&unique).unwrap();
        let (source_path, target_path, source_identity, target_identity) =
            create_media_pair(&unique);
        let mut request = verified_request(
            &unique,
            &source_path,
            &target_path,
            source_identity,
            target_identity,
        );

        let missing = verify_projection_xml_receipts_with(
            &request.verification.projection_derivation,
            |_, _| Ok(()),
        )
        .unwrap_err();
        assert!(missing.contains("没有桌面原生内容收据"));

        let immutable = XmlImmutableDanmakuItemV1 {
            original_index: 0,
            source_time_ms: 100,
            mode: None,
            font_size: None,
            color: None,
            timestamp: None,
            pool: None,
            user_hash: None,
            row_id: None,
            text: "fixture & text".to_string(),
            raw_p_fields: Vec::new(),
        };
        let inventory_digest = compute_xml_inventory_digest(&[immutable]).unwrap();
        request.verification.projection_derivation.xml_assets[0].source_receipt =
            Some(XmlContentReceiptV1 {
                domain: XML_CONTENT_RECEIPT_DOMAIN.to_string(),
                version: 1,
                receipt_id: format!("xmlr-sha256:{}", "a".repeat(64)),
                content_digest: format!("sha256:{}", "b".repeat(64)),
                size_bytes: 123,
                parser_version: crate::xml_import_receipt::XML_PARSER_VERSION.to_string(),
                inventory_digest,
                issuer_key_id: "install-sha256:fixture".to_string(),
                signature_algorithm: "hmac-sha256-v1".to_string(),
                signature: "c".repeat(64),
            });
        verify_projection_xml_receipts_with(
            &request.verification.projection_derivation,
            |receipt, items| {
                if compute_xml_inventory_digest(items)? == receipt.inventory_digest {
                    Ok(())
                } else {
                    Err("receipt inventory mismatch".to_string())
                }
            },
        )
        .unwrap();

        request.verification.projection_derivation.xml_assets[0].items[0].text =
            "forged text".to_string();
        resign_manifest(&mut request.verification);
        let error = verify_projection_xml_receipts_with(
            &request.verification.projection_derivation,
            |receipt, items| {
                if compute_xml_inventory_digest(items)? == receipt.inventory_digest {
                    Ok(())
                } else {
                    Err("receipt inventory mismatch".to_string())
                }
            },
        )
        .unwrap_err();
        assert_eq!(error, "receipt inventory mismatch");
        fs::remove_dir_all(unique).unwrap();
    }

    #[test]
    fn verified_envelope_requires_active_local_authority_before_writing() {
        let unique = tempfile_like_path("danmaku-export-authority");
        let _ = fs::remove_dir_all(&unique);
        fs::create_dir_all(&unique).unwrap();
        let (source_path, target_path, source_identity, target_identity) =
            create_media_pair(&unique);
        let request = verified_request(
            &unique,
            &source_path,
            &target_path,
            source_identity,
            target_identity,
        );
        for reason in ["revoked", "unknown"] {
            let error =
                save_verified_projected_xml_export_with_authority(clone_request(&request), |_| {
                    Err(reason.to_string())
                })
                .unwrap_err();
            assert!(error.contains(reason));
            assert!(!unique.join("episode.xml").exists());
        }
        fs::remove_dir_all(unique).unwrap();
    }

    #[test]
    fn verified_zip_binds_every_logical_xml_and_archive_bytes() {
        let first = ("1.xml", b"<i>1</i>".as_slice());
        let second = ("2.xml", b"<i>2</i>".as_slice());
        let zip = create_test_stored_zip(&[first, second]);
        let parsed = parse_and_verify_stored_zip(&zip).unwrap();
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0], ("1.xml".to_string(), first.1));
        assert_eq!(parsed[1], ("2.xml".to_string(), second.1));

        let mut tampered = zip;
        let byte = tampered.iter_mut().find(|byte| **byte == b'2').unwrap();
        *byte = b'9';
        assert!(parse_and_verify_stored_zip(&tampered).is_err());

        let windows_case_collision = create_test_stored_zip(&[
            ("Episode.xml", b"<i>1</i>".as_slice()),
            ("episode.xml", b"<i>2</i>".as_slice()),
        ]);
        assert!(parse_and_verify_stored_zip(&windows_case_collision).is_err());
    }

    #[test]
    fn verified_projection_preserves_inert_metadata_and_rejects_comment_injection() {
        for injected in [false, true] {
            let unique = tempfile_like_path("xml-metadata-projection");
            fs::create_dir_all(&unique).unwrap();
            let (source, target, source_id, target_id) = create_media_pair(&unique);
            let mut request = verified_request(&unique, &source, &target, source_id, target_id);
            let mut metadata = "  <dts:metadata xmlns:dts=\"urn:danmaku-studio:xml:metadata:1\" schema-version=\"1\" duration-ms=\"1000\">\n  </dts:metadata>".to_string();
            if injected {
                metadata =
                    metadata.replace("</dts:metadata>", "<d p=\"0.1\">forged</d></dts:metadata>");
            }
            request
                .verification
                .projection_derivation
                .target_output_files[0]
                .metadata_xml = Some(metadata.clone());
            request.content_bytes = String::from_utf8(request_fixture_xml())
                .unwrap()
                .replace("  <d p=", &format!("{metadata}\n  <d p="))
                .into_bytes();
            let digest = sha256_digest(&request.content_bytes);
            request.verification.archive_content_digest = digest.clone();
            request.verification.outputs[0].content_digest = digest;
            resign_manifest(&mut request.verification);
            let result = save_verified_projected_xml_export_with_authority(request, |_| Ok(()));
            if injected {
                assert!(result.unwrap_err().contains("不允许的元素"));
                assert!(!unique.join("episode.xml").exists());
            } else {
                result.unwrap();
                assert!(fs::read_to_string(unique.join("episode.xml"))
                    .unwrap()
                    .contains(&metadata));
            }
            fs::remove_dir_all(unique).unwrap();
        }
    }

    fn assert_rejected_without_write(
        request: &SaveVerifiedExportFileRequest,
        directory: &Path,
        expected: &str,
    ) {
        let error =
            save_verified_projected_xml_export_with_authority(clone_request(request), |_| Ok(()))
                .unwrap_err();
        assert!(error.contains(expected), "unexpected error: {error}");
        assert!(!directory.join("episode.xml").exists());
    }

    fn create_media_pair(
        directory: &Path,
    ) -> (
        PathBuf,
        PathBuf,
        ExpectedMediaContentIdentity,
        ExpectedMediaContentIdentity,
    ) {
        let source_path = directory.join("source.bin");
        let target_path = directory.join("target.bin");
        fs::write(&source_path, vec![7_u8; 256 * 1024]).unwrap();
        fs::write(&target_path, vec![8_u8; 256 * 1024]).unwrap();
        let source_identity =
            expected_identity(&probe_media_content_identity(&source_path).unwrap());
        let target_identity =
            expected_identity(&probe_media_content_identity(&target_path).unwrap());
        (source_path, target_path, source_identity, target_identity)
    }

    fn verified_request(
        directory: &Path,
        source_path: &Path,
        target_path: &Path,
        source_identity: ExpectedMediaContentIdentity,
        target_identity: ExpectedMediaContentIdentity,
    ) -> SaveVerifiedExportFileRequest {
        let content_bytes = request_fixture_xml();
        let core_canonical_json = serde_json::to_string(&json!([
            MEDIA_TIME_MAP_CORE_DOMAIN,
            "map-1",
            1,
            "source-1",
            "target-1",
            null,
            null,
            identity_manifest_value(&source_identity),
            identity_manifest_value(&target_identity),
            0,
            1000,
            0,
            1000,
            [[
                "span-1-matched-0-1000-0-1000",
                "matched",
                0,
                1000,
                0,
                1000,
                "fixture matched span",
                [
                    "verified",
                    "measured",
                    0.995,
                    1.0,
                    1.0,
                    1.0,
                    30,
                    6,
                    10,
                    20,
                    30,
                    40,
                    0,
                    "supported",
                    "supported",
                    ["used", "blocked", "blocked"],
                    ["fixture span evidence"]
                ],
                [
                    [
                        "notApplicable",
                        "both",
                        null,
                        null,
                        null,
                        null,
                        null,
                        0,
                        null,
                        null,
                        "fixture start boundary"
                    ],
                    [
                        "notApplicable",
                        "both",
                        null,
                        null,
                        null,
                        null,
                        null,
                        0,
                        null,
                        null,
                        "fixture end boundary"
                    ]
                ],
                []
            ]],
            [
                0.995,
                "measured",
                1.0,
                1.0,
                10,
                20,
                30,
                40,
                0,
                1.0,
                30,
                3,
                6,
                ["fixture graph evidence"]
            ],
            [
                ["audio", "manual"],
                30,
                0,
                6,
                1.0,
                1.0,
                false,
                "fixture track",
                [],
                ["fixture"]
            ],
            "fixture-engine-v1",
            "fixture-feature-v1",
            "sha256:fixture-parameters"
        ]))
        .unwrap();
        let core_digest = sha256_digest(core_canonical_json.as_bytes());
        let review_digest = sha256_digest(b"review-evidence");
        let request_payload = serde_json::to_string(&json!([
            MANUAL_VERIFICATION_REQUEST_DOMAIN,
            "manual-review",
            "map-1",
            1,
            core_digest,
            identity_manifest_value(&source_identity),
            identity_manifest_value(&target_identity),
            "manual-a-b-review",
            "1",
            review_digest,
            "本机用户",
            "2026-07-12T00:00:00.000Z",
        ]))
        .unwrap();
        let request_digest = sha256_digest(request_payload.as_bytes());
        let proof = VerifiedExportMapProof {
            map_id: "map-1".to_string(),
            revision: 1,
            state: "confirmed".to_string(),
            declared_quality: "verified".to_string(),
            span_kinds: vec!["matched".to_string()],
            core_digest,
            core_canonical_json,
            source_media_id: "source-1".to_string(),
            target_media_id: "target-1".to_string(),
            source_identity: source_identity.clone(),
            target_identity: target_identity.clone(),
            manual_verification: VerifiedExportManualVerification {
                verification_id: "verification-1".to_string(),
                issuer_key_id: "install-sha256:fixture".to_string(),
                signature_algorithm: "hmac-sha256-v1".to_string(),
                signature: "a".repeat(64),
                request_payload,
                request_digest,
            },
            automatic_verification: None,
        };
        let mut verification = VerifiedExportVerification {
            schema_version: VERIFIED_EXPORT_SCHEMA_VERSION,
            project_id: "project-1".to_string(),
            project_updated_at: "2026-07-12T00:00:00.000Z".to_string(),
            manifest_json: String::new(),
            manifest_digest: sha256_digest(b"pending-manifest"),
            project_snapshot_digest: sha256_digest(b"pending-project"),
            archive_file_name: "episode.xml".to_string(),
            archive_content_digest: sha256_digest(&content_bytes),
            outputs: vec![VerifiedExportOutput {
                file_name: "episode.xml".to_string(),
                content_digest: sha256_digest(&content_bytes),
            }],
            map_proofs: vec![proof],
            dependencies: vec![
                VerifiedMediaDependency {
                    media_id: "source-1".to_string(),
                    path: source_path.to_string_lossy().to_string(),
                    expected_identity: source_identity.clone(),
                    map_ids: vec!["map-1".to_string()],
                },
                VerifiedMediaDependency {
                    media_id: "target-1".to_string(),
                    path: target_path.to_string_lossy().to_string(),
                    expected_identity: target_identity.clone(),
                    map_ids: vec!["map-1".to_string()],
                },
            ],
            projection_derivation: ProjectionDerivationV1 {
                domain: PROJECTION_DERIVATION_DOMAIN.to_string(),
                projection_policy_version: PROJECTION_POLICY_VERSION.to_string(),
                serializer_version: PROJECTION_SERIALIZER_VERSION.to_string(),
                project_id: "project-1".to_string(),
                project_updated_at: "2026-07-12T00:00:00.000Z".to_string(),
                media: vec![
                    ProjectionMediaV1 {
                        media_id: "source-1".to_string(),
                        role: "bilibiliReference".to_string(),
                        name: "source".to_string(),
                        media_file_name: "source.bin".to_string(),
                        duration_ms: Some(1000),
                        episode_label: None,
                        content_identity: Some(source_identity.clone()),
                    },
                    ProjectionMediaV1 {
                        media_id: "target-1".to_string(),
                        role: "targetOriginal".to_string(),
                        name: "target".to_string(),
                        media_file_name: "target.bin".to_string(),
                        duration_ms: Some(1000),
                        episode_label: Some("1".to_string()),
                        content_identity: Some(target_identity.clone()),
                    },
                ],
                xml_assets: vec![ProjectionXmlAssetV1 {
                    asset_id: "asset-1".to_string(),
                    source_file_name: "source.xml".to_string(),
                    source_receipt: None,
                    items: vec![ProjectionDanmakuItemV1 {
                        item_id: "asset-1_item_0".to_string(),
                        asset_id: "asset-1".to_string(),
                        original_index: 0,
                        source_time_ms: 100,
                        mode: None,
                        font_size: None,
                        color: None,
                        timestamp: None,
                        pool: None,
                        user_hash: None,
                        row_id: None,
                        text: "fixture & text".to_string(),
                        raw_p_fields: Vec::new(),
                        enabled: true,
                    }],
                }],
                source_bindings: vec![ProjectionSourceBindingV1 {
                    binding_id: "binding-1".to_string(),
                    asset_id: "asset-1".to_string(),
                    source_media_id: "source-1".to_string(),
                }],
                routes: vec![ProjectionRouteV1 {
                    route_id: "route-1".to_string(),
                    kind: "content".to_string(),
                    asset_id: Some("asset-1".to_string()),
                    source_media_id: Some("source-1".to_string()),
                    source_start_ms: 0,
                    source_end_ms: 1000,
                    target_media_id: Some("target-1".to_string()),
                    target_start_ms: Some(0),
                    time_map_id: Some("map-1".to_string()),
                    timing_rules: Vec::new(),
                }],
                disabled_item_ids: Vec::new(),
                item_time_adjustments: Vec::new(),
                target_output_files: vec![ProjectionTargetOutputV1 {
                    metadata_xml: None,
                    target_media_id: "target-1".to_string(),
                    file_name: "episode.xml".to_string(),
                }],
            },
        };
        resign_manifest(&mut verification);
        SaveVerifiedExportFileRequest {
            directory_path: directory.to_string_lossy().to_string(),
            file_name: "episode.xml".to_string(),
            content_bytes,
            verification,
        }
    }

    fn request_fixture_xml() -> Vec<u8> {
        concat!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n",
            "<i>\n",
            "  <generator>Danmaku Timeline Studio</generator>\n",
            "  <d p=\"0.100,1,25,16777215,0,0,,\">fixture &amp; text</d>\n",
            "</i>\n"
        )
        .as_bytes()
        .to_vec()
    }

    fn resign_manifest(verification: &mut VerifiedExportVerification) {
        verification.project_snapshot_digest = sha256_digest(
            serde_json::to_string(&canonical_projection_derivation(
                &verification.projection_derivation,
            ))
            .unwrap()
            .as_bytes(),
        );
        verification.manifest_json =
            serde_json::to_string(&canonical_verified_export_manifest(verification).unwrap())
                .unwrap();
        verification.manifest_digest = sha256_digest(verification.manifest_json.as_bytes());
    }

    fn rebind_signed_core_and_request(request: &mut SaveVerifiedExportFileRequest, core: Value) {
        let proof = &mut request.verification.map_proofs[0];
        proof.core_canonical_json = serde_json::to_string(&core).unwrap();
        proof.core_digest = sha256_digest(proof.core_canonical_json.as_bytes());
        let mut manual_request: Value =
            serde_json::from_str(&proof.manual_verification.request_payload).unwrap();
        manual_request.as_array_mut().unwrap()[4] = json!(proof.core_digest);
        proof.manual_verification.request_payload = serde_json::to_string(&manual_request).unwrap();
        proof.manual_verification.request_digest =
            sha256_digest(proof.manual_verification.request_payload.as_bytes());
        resign_manifest(&mut request.verification);
    }

    fn convert_request_to_automatic_proof(request: &mut SaveVerifiedExportFileRequest) {
        let proof = &mut request.verification.map_proofs[0];
        let mut core: Value = serde_json::from_str(&proof.core_canonical_json).unwrap();
        let fields = core.as_array_mut().unwrap();
        fields[15].as_array_mut().unwrap()[0] = json!(["audio"]);
        fields[16] = json!(TRUSTED_AUTOMATIC_ENGINE_VERSION);
        fields[17] = json!(TRUSTED_AUTOMATIC_FEATURE_VERSION);
        proof.core_canonical_json = serde_json::to_string(&core).unwrap();
        proof.core_digest = sha256_digest(proof.core_canonical_json.as_bytes());
        proof.manual_verification = VerifiedExportManualVerification::default();
        proof.automatic_verification = Some(VerifiedExportAutomaticVerification {
            calibration_artifact_id: TRUSTED_AUTOMATIC_CALIBRATION_ARTIFACT_ID.to_string(),
            calibration_artifact_version: TRUSTED_AUTOMATIC_CALIBRATION_ARTIFACT_VERSION
                .to_string(),
            verifier: "Danmaku Timeline Studio native+domain policy".to_string(),
            verified_at: "2026-08-19T00:00:00.000Z".to_string(),
        });
        resign_manifest(&mut request.verification);
    }

    fn clone_request(request: &SaveVerifiedExportFileRequest) -> SaveVerifiedExportFileRequest {
        SaveVerifiedExportFileRequest {
            directory_path: request.directory_path.clone(),
            file_name: request.file_name.clone(),
            content_bytes: request.content_bytes.clone(),
            verification: VerifiedExportVerification {
                schema_version: request.verification.schema_version,
                project_id: request.verification.project_id.clone(),
                project_updated_at: request.verification.project_updated_at.clone(),
                manifest_json: request.verification.manifest_json.clone(),
                manifest_digest: request.verification.manifest_digest.clone(),
                project_snapshot_digest: request.verification.project_snapshot_digest.clone(),
                archive_file_name: request.verification.archive_file_name.clone(),
                archive_content_digest: request.verification.archive_content_digest.clone(),
                outputs: request.verification.outputs.clone(),
                map_proofs: request.verification.map_proofs.clone(),
                dependencies: request.verification.dependencies.clone(),
                projection_derivation: request.verification.projection_derivation.clone(),
            },
        }
    }

    pub(super) fn create_test_stored_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut local = Vec::new();
        let mut central = Vec::new();
        for (name, data) in entries {
            let name = name.as_bytes();
            let offset = u32::try_from(local.len()).unwrap();
            let crc = crc32(data);
            let size = u32::try_from(data.len()).unwrap();
            push_u32(&mut local, 0x0403_4b50);
            push_u16(&mut local, 20);
            push_u16(&mut local, 0x0800);
            push_u16(&mut local, 0);
            push_u16(&mut local, 0);
            push_u16(&mut local, 0x0021);
            push_u32(&mut local, crc);
            push_u32(&mut local, size);
            push_u32(&mut local, size);
            push_u16(&mut local, u16::try_from(name.len()).unwrap());
            push_u16(&mut local, 0);
            local.extend_from_slice(name);
            local.extend_from_slice(data);

            push_u32(&mut central, 0x0201_4b50);
            push_u16(&mut central, 20);
            push_u16(&mut central, 20);
            push_u16(&mut central, 0x0800);
            push_u16(&mut central, 0);
            push_u16(&mut central, 0);
            push_u16(&mut central, 0x0021);
            push_u32(&mut central, crc);
            push_u32(&mut central, size);
            push_u32(&mut central, size);
            push_u16(&mut central, u16::try_from(name.len()).unwrap());
            push_u16(&mut central, 0);
            push_u16(&mut central, 0);
            push_u16(&mut central, 0);
            push_u16(&mut central, 0);
            push_u32(&mut central, 0);
            push_u32(&mut central, offset);
            central.extend_from_slice(name);
        }
        let central_offset = u32::try_from(local.len()).unwrap();
        let central_size = u32::try_from(central.len()).unwrap();
        local.extend_from_slice(&central);
        push_u32(&mut local, 0x0605_4b50);
        push_u16(&mut local, 0);
        push_u16(&mut local, 0);
        push_u16(&mut local, u16::try_from(entries.len()).unwrap());
        push_u16(&mut local, u16::try_from(entries.len()).unwrap());
        push_u32(&mut local, central_size);
        push_u32(&mut local, central_offset);
        push_u16(&mut local, 0);
        local
    }

    fn push_u16(output: &mut Vec<u8>, value: u16) {
        output.extend_from_slice(&value.to_le_bytes());
    }

    fn push_u32(output: &mut Vec<u8>, value: u32) {
        output.extend_from_slice(&value.to_le_bytes());
    }

    fn expected_identity(identity: &MediaContentIdentity) -> ExpectedMediaContentIdentity {
        ExpectedMediaContentIdentity {
            algorithm: identity.algorithm.to_string(),
            size_bytes: identity.size_bytes,
            modified_unix_ms: identity.modified_unix_ms,
            first_sample_digest: identity.first_sample_digest.clone(),
            middle_sample_digest: identity.middle_sample_digest.clone(),
            last_sample_digest: identity.last_sample_digest.clone(),
        }
    }

    fn tempfile_like_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("{name}-{}", std::process::id()))
    }
}
