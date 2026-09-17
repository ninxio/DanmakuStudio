use quick_xml::{
    escape::unescape,
    events::{BytesStart, Event},
    Reader,
};
use serde::{
    ser::{SerializeSeq, Serializer},
    Deserialize, Serialize,
};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};

use crate::manual_verification::{
    lock_manual_time_map_verification_authority, ManualVerificationAuthorityGuard,
};

#[path = "xml_metadata_fragment.rs"]
mod metadata_fragment;

pub(crate) const XML_CONTENT_RECEIPT_DOMAIN: &str = "danmaku-xml-content-receipt-v1";
pub(crate) const XML_PARSER_VERSION: &str = "bilibili-xml-native-v1";
const XML_INVENTORY_DOMAIN: &str = "danmaku-xml-immutable-inventory-v1";
const XML_ITEM_DOMAIN: &str = "danmaku-xml-immutable-item-v1";
const XML_RECEIPT_SIGNATURE_DOMAIN: &str = "danmaku-xml-content-receipt-signature-v1";
const XML_RECEIPT_SIGNATURE_PAYLOAD_DOMAIN: &str =
    "danmaku-xml-content-receipt-signature-payload-v1";
const SIGNATURE_ALGORITHM: &str = "hmac-sha256-v1";
const XML_RECEIPT_STORAGE_DIRECTORY: &str = "xml-content-receipts-v1";
const XML_OBJECTS_DIRECTORY: &str = "objects";
const SHA256_DIRECTORY: &str = "sha256";
const MAX_BATCH_FILES: usize = 256;
const MAX_XML_FILE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_XML_BATCH_BYTES: u64 = 256 * 1024 * 1024;
const MAX_XML_ITEMS: usize = 250_000;
const MAX_XML_BATCH_ITEMS: usize = 500_000;
const MAX_DANMAKU_P_BYTES: usize = 16 * 1024;
const MAX_DANMAKU_P_FIELDS: usize = 64;
const MAX_DANMAKU_TEXT_BYTES: usize = 1024 * 1024;
const MAX_XML_WARNINGS: usize = 50_000;
const MAX_XML_DEPTH: usize = 256;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_WARNING_SNIPPET_CHARS: usize = 240;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportBilibiliXmlFilesRequest {
    pub paths: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportBilibiliXmlFilesResult {
    pub files: Vec<ImportedBilibiliXmlFile>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedBilibiliXmlFile {
    pub metadata_xml: Option<String>,
    pub file_name: String,
    pub receipt: XmlContentReceiptV1,
    pub items: Vec<XmlImmutableDanmakuItemV1>,
    pub warnings: Vec<XmlImportWarningV1>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct XmlContentReceiptV1 {
    pub(crate) domain: String,
    pub(crate) version: u8,
    pub(crate) receipt_id: String,
    pub(crate) content_digest: String,
    pub(crate) size_bytes: u64,
    pub(crate) parser_version: String,
    pub(crate) inventory_digest: String,
    pub(crate) issuer_key_id: String,
    pub(crate) signature_algorithm: String,
    pub(crate) signature: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct XmlImmutableDanmakuItemV1 {
    pub(crate) original_index: u64,
    pub(crate) source_time_ms: u64,
    pub(crate) mode: Option<i64>,
    pub(crate) font_size: Option<i64>,
    pub(crate) color: Option<i64>,
    pub(crate) timestamp: Option<i64>,
    pub(crate) pool: Option<i64>,
    pub(crate) user_hash: Option<String>,
    pub(crate) row_id: Option<String>,
    pub(crate) text: String,
    pub(crate) raw_p_fields: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XmlImportWarningV1 {
    pub original_index: Option<u64>,
    pub severity: &'static str,
    pub message: String,
    pub raw_snippet: String,
}

#[derive(Debug)]
struct ParsedXml {
    metadata_xml: Option<String>,
    items: Vec<XmlImmutableDanmakuItemV1>,
    warnings: Vec<XmlImportWarningV1>,
}

#[derive(Debug)]
struct PreparedXmlFile {
    file_name: String,
    bytes: Vec<u8>,
    content_digest: String,
    inventory_digest: String,
    parsed: ParsedXml,
}

#[derive(Debug)]
struct ReceiptSignature {
    issuer_key_id: String,
    signature: String,
}

#[derive(Debug)]
struct ActiveDanmaku {
    depth: usize,
    original_index: u64,
    p_value: Option<String>,
    text: String,
    raw_snippet: String,
}

#[tauri::command]
pub fn import_bilibili_xml_files(
    app: AppHandle,
    request: ImportBilibiliXmlFilesRequest,
) -> Result<ImportBilibiliXmlFilesResult, String> {
    let storage_root = xml_receipt_storage_root(&app)?;
    let prepared = prepare_xml_files(&request.paths)?;
    let authority = lock_manual_time_map_verification_authority(&app)?;
    import_prepared_xml_files(&storage_root, prepared, |payload| {
        let seal = authority.sign_domain_payload(XML_RECEIPT_SIGNATURE_DOMAIN, payload)?;
        Ok(ReceiptSignature {
            issuer_key_id: seal.issuer_key_id,
            signature: seal.signature,
        })
    })
}

/// Revalidates a signed receipt, the installation-owned CAS bytes, and the immutable item
/// inventory supplied by an export derivation. Callers that already hold the manual-verification
/// guard can use this without reacquiring the installation-key lock.
pub(crate) fn verify_xml_content_receipt(
    app: &AppHandle,
    authority: &ManualVerificationAuthorityGuard,
    receipt: &XmlContentReceiptV1,
    items: &[XmlImmutableDanmakuItemV1],
) -> Result<(), String> {
    let storage_root = xml_receipt_storage_root(app)?;
    verify_xml_content_receipt_at(
        &storage_root,
        receipt,
        items,
        |payload, key_id, signature| {
            authority.require_valid_domain_payload(
                XML_RECEIPT_SIGNATURE_DOMAIN,
                payload,
                key_id,
                signature,
            )
        },
    )
}

pub(crate) fn compute_xml_inventory_digest(
    items: &[XmlImmutableDanmakuItemV1],
) -> Result<String, String> {
    let mut hasher = Sha256::new();
    serde_json::to_writer(DigestWriter(&mut hasher), &CanonicalInventory { items })
        .map_err(|error| format!("无法规范化 XML 不可变清单：{error}"))?;
    Ok(format!("sha256:{}", hex_encode(&hasher.finalize())))
}

fn xml_receipt_storage_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map(|path| path.join(XML_RECEIPT_STORAGE_DIRECTORY))
        .map_err(|error| format!("无法定位 XML 内容收据存储目录：{error}"))
}

fn prepare_xml_files(paths: &[String]) -> Result<Vec<PreparedXmlFile>, String> {
    if paths.is_empty() || paths.len() > MAX_BATCH_FILES {
        return Err(format!(
            "一次必须导入 1 至 {MAX_BATCH_FILES} 个本地 XML 文件。"
        ));
    }

    let mut total_bytes = 0_u64;
    let mut total_items = 0_usize;
    let mut prepared = Vec::with_capacity(paths.len());
    for raw_path in paths {
        let path_text = raw_path.trim();
        if path_text.is_empty() || path_text.contains("://") {
            return Err("XML 导入只接受非空的本地绝对路径。".to_string());
        }
        let path = Path::new(path_text);
        if !path.is_absolute() || !has_xml_extension(path) {
            return Err("XML 导入只接受扩展名为 .xml 的本地绝对路径。".to_string());
        }
        let file_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .ok_or_else(|| "XML 文件名不是有效的 Unicode 文件名。".to_string())?
            .to_string();
        let bytes = read_pinned_file_bytes(path, MAX_XML_FILE_BYTES)?;
        total_bytes = checked_batch_byte_total(total_bytes, bytes.len() as u64)?;
        let parsed = parse_bilibili_xml(&bytes)?;
        total_items = checked_batch_item_total(total_items, parsed.items.len())?;
        let content_digest = sha256_digest(&bytes);
        let inventory_digest = compute_xml_inventory_digest(&parsed.items)?;
        prepared.push(PreparedXmlFile {
            file_name,
            bytes,
            content_digest,
            inventory_digest,
            parsed,
        });
    }
    Ok(prepared)
}

fn checked_batch_byte_total(current: u64, additional: u64) -> Result<u64, String> {
    let total = current
        .checked_add(additional)
        .ok_or_else(|| "XML 批量导入大小溢出。".to_string())?;
    if total > MAX_XML_BATCH_BYTES {
        return Err("一次导入的 XML 总大小超过 256 MiB 限制。".to_string());
    }
    Ok(total)
}

fn checked_batch_item_total(current: usize, additional: usize) -> Result<usize, String> {
    let total = current
        .checked_add(additional)
        .ok_or_else(|| "XML 批量弹幕数量溢出。".to_string())?;
    if total > MAX_XML_BATCH_ITEMS {
        return Err(format!(
            "一次导入的 XML 弹幕总数超过 {MAX_XML_BATCH_ITEMS} 条限制。"
        ));
    }
    Ok(total)
}

fn import_prepared_xml_files(
    storage_root: &Path,
    prepared: Vec<PreparedXmlFile>,
    mut sign: impl FnMut(&[u8]) -> Result<ReceiptSignature, String>,
) -> Result<ImportBilibiliXmlFilesResult, String> {
    let mut files = Vec::with_capacity(prepared.len());
    for file in prepared {
        let mut receipt = unsigned_receipt(
            &file.content_digest,
            file.bytes.len() as u64,
            &file.inventory_digest,
        )?;
        let signature_payload = receipt_signature_payload(&receipt)?;
        let signature = sign(&signature_payload)?;
        receipt.issuer_key_id = signature.issuer_key_id;
        receipt.signature = signature.signature;
        validate_receipt_shape(&receipt)?;
        persist_cas_object(storage_root, &file.content_digest, &file.bytes)?;
        files.push(ImportedBilibiliXmlFile {
            metadata_xml: file.parsed.metadata_xml,
            file_name: file.file_name,
            receipt,
            items: file.parsed.items,
            warnings: file.parsed.warnings,
        });
    }
    Ok(ImportBilibiliXmlFilesResult { files })
}

fn unsigned_receipt(
    content_digest: &str,
    size_bytes: u64,
    inventory_digest: &str,
) -> Result<XmlContentReceiptV1, String> {
    let identity = receipt_identity_bytes(content_digest, size_bytes, inventory_digest)?;
    Ok(XmlContentReceiptV1 {
        domain: XML_CONTENT_RECEIPT_DOMAIN.to_string(),
        version: 1,
        receipt_id: format!("xmlr-sha256:{}", sha256_hex(&identity)),
        content_digest: content_digest.to_string(),
        size_bytes,
        parser_version: XML_PARSER_VERSION.to_string(),
        inventory_digest: inventory_digest.to_string(),
        issuer_key_id: String::new(),
        signature_algorithm: SIGNATURE_ALGORITHM.to_string(),
        signature: String::new(),
    })
}

fn receipt_identity_bytes(
    content_digest: &str,
    size_bytes: u64,
    inventory_digest: &str,
) -> Result<Vec<u8>, String> {
    serde_json::to_vec(&(
        XML_CONTENT_RECEIPT_DOMAIN,
        1_u8,
        content_digest,
        size_bytes,
        XML_PARSER_VERSION,
        inventory_digest,
    ))
    .map_err(|error| format!("无法规范化 XML 内容收据身份：{error}"))
}

fn receipt_signature_payload(receipt: &XmlContentReceiptV1) -> Result<Vec<u8>, String> {
    serde_json::to_vec(&(
        XML_RECEIPT_SIGNATURE_PAYLOAD_DOMAIN,
        receipt.receipt_id.as_str(),
        receipt.domain.as_str(),
        receipt.version,
        receipt.content_digest.as_str(),
        receipt.size_bytes,
        receipt.parser_version.as_str(),
        receipt.inventory_digest.as_str(),
    ))
    .map_err(|error| format!("无法规范化 XML 内容收据签名载荷：{error}"))
}

fn verify_xml_content_receipt_at(
    storage_root: &Path,
    receipt: &XmlContentReceiptV1,
    items: &[XmlImmutableDanmakuItemV1],
    verify_signature: impl FnOnce(&[u8], &str, &str) -> Result<(), String>,
) -> Result<(), String> {
    validate_receipt_shape(receipt)?;
    let identity = receipt_identity_bytes(
        &receipt.content_digest,
        receipt.size_bytes,
        &receipt.inventory_digest,
    )?;
    let expected_receipt_id = format!("xmlr-sha256:{}", sha256_hex(&identity));
    if receipt.receipt_id != expected_receipt_id {
        return Err("XML 内容收据 ID 与规范化内容身份不一致。".to_string());
    }
    let signature_payload = receipt_signature_payload(receipt)?;
    verify_signature(
        &signature_payload,
        &receipt.issuer_key_id,
        &receipt.signature,
    )?;

    let expected_inventory_digest = compute_xml_inventory_digest(items)?;
    if expected_inventory_digest != receipt.inventory_digest {
        return Err("项目中的 XML 不可变弹幕清单已被修改，已阻断导出。".to_string());
    }

    let object_path = cas_object_path(storage_root, &receipt.content_digest)?;
    if !object_path.is_file() {
        return Err("本机 XML 内容对象缺失；请重新导入原始 XML。".to_string());
    }
    let bytes = read_pinned_file_bytes(&object_path, MAX_XML_FILE_BYTES)?;
    if bytes.len() as u64 != receipt.size_bytes || sha256_digest(&bytes) != receipt.content_digest {
        return Err("本机 XML 内容对象大小或摘要无效，已阻断导出。".to_string());
    }
    let reparsed = parse_bilibili_xml(&bytes)?;
    if compute_xml_inventory_digest(&reparsed.items)? != receipt.inventory_digest {
        return Err("本机 XML 内容对象无法重建收据中的不可变清单。".to_string());
    }
    Ok(())
}

fn validate_receipt_shape(receipt: &XmlContentReceiptV1) -> Result<(), String> {
    if receipt.domain != XML_CONTENT_RECEIPT_DOMAIN
        || receipt.version != 1
        || receipt.parser_version != XML_PARSER_VERSION
        || receipt.signature_algorithm != SIGNATURE_ALGORITHM
        || receipt.size_bytes > MAX_XML_FILE_BYTES
        || !has_prefixed_lower_hex(&receipt.receipt_id, "xmlr-sha256:", 64)
        || !has_prefixed_lower_hex(&receipt.content_digest, "sha256:", 64)
        || !has_prefixed_lower_hex(&receipt.inventory_digest, "sha256:", 64)
        || !has_prefixed_lower_hex(&receipt.issuer_key_id, "install-sha256:", 32)
        || !is_lower_hex(&receipt.signature, 64)
    {
        return Err("XML 内容收据格式、版本或算法无效。".to_string());
    }
    Ok(())
}

/// Publication reuses the strict parser without creating or signing an import receipt.
pub(crate) fn parse_publication_items(bytes: &[u8]) -> Result<Vec<XmlImmutableDanmakuItemV1>, String> {
    if bytes.len() as u64 > MAX_XML_FILE_BYTES { return Err("成品 XML 超过 64 MiB。".into()); }
    let parsed = parse_bilibili_xml(bytes)?;
    if !parsed.warnings.is_empty() { return Err("成品 XML 存在字段警告，请在编辑器修正后重新导出。".into()); }
    if parsed.items.is_empty() { return Err("成品 XML 没有弹幕。".into()); }
    Ok(parsed.items)
}

/// Ordinary editable exports retain the editor's empty/comment-warning semantics.
/// Structural and allocation limits still apply; this does not attest publication quality.
pub(crate) fn validate_edited_export_xml(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() as u64 > MAX_XML_FILE_BYTES {
        return Err("导出 XML 超过 64 MiB。".into());
    }
    parse_bilibili_xml(bytes).map(|_| ())
}

fn parse_bilibili_xml(bytes: &[u8]) -> Result<ParsedXml, String> {
    let xml = std::str::from_utf8(bytes)
        .map_err(|_| "XML 文件不是严格 UTF-8 编码，已拒绝导入。".to_string())?;
    let mut reader = Reader::from_str(xml);
    reader.config_mut().enable_all_checks(true);
    reader.config_mut().expand_empty_elements = false;
    reader.config_mut().trim_text(false);

    let mut depth = 0_usize;
    let mut root_seen = false;
    let mut root_closed = false;
    let mut declaration_seen = false;
    let mut active = Vec::<ActiveDanmaku>::new();
    let mut completed = Vec::<XmlImmutableDanmakuItemV1>::new();
    let mut warnings = Vec::<XmlImportWarningV1>::new();
    let mut next_original_index = 0_u64;
    let mut metadata = metadata_fragment::MetadataFragment::default();

    loop {
        let event_start = reader.buffer_position() as usize;
        let event = reader
            .read_event()
            .map_err(|error| format!("XML 结构畸形，已拒绝导入：{error}"))?;
        match event {
            Event::Decl(declaration) => {
                if declaration_seen || root_seen || depth != 0 {
                    return Err("XML 声明位置或数量无效，已拒绝导入。".to_string());
                }
                declaration_seen = true;
                validate_xml_declaration(&declaration, reader.decoder())?;
            }
            Event::DocType(_) => {
                return Err("XML 不允许包含 DTD/DOCTYPE，已拒绝导入。".to_string());
            }
            Event::Start(start) => {
                metadata.start(&start, depth, event_start, reader.buffer_position() as usize, xml, false)?;
                let p_value = validate_start_element(&start, reader.decoder())?;
                if depth == 0 {
                    if root_closed {
                        return Err("XML 只能包含一个根元素。".to_string());
                    }
                    root_seen = true;
                }
                depth = depth
                    .checked_add(1)
                    .ok_or_else(|| "XML 元素深度溢出。".to_string())?;
                if depth > MAX_XML_DEPTH {
                    return Err(format!("XML 元素嵌套超过 {MAX_XML_DEPTH} 层限制。"));
                }
                if start.name().as_ref() == b"d" {
                    if !active.is_empty() {
                        return Err("XML 不允许嵌套 <d> 弹幕节点。".to_string());
                    }
                    ensure_item_capacity(next_original_index)?;
                    active.push(active_danmaku(
                        &start,
                        p_value,
                        depth,
                        next_original_index,
                        false,
                    ));
                    next_original_index += 1;
                }
            }
            Event::Empty(start) => {
                metadata.start(&start, depth, event_start, reader.buffer_position() as usize, xml, true)?;
                let p_value = validate_start_element(&start, reader.decoder())?;
                if depth == 0 {
                    if root_closed {
                        return Err("XML 只能包含一个根元素。".to_string());
                    }
                    root_seen = true;
                    root_closed = true;
                }
                if start.name().as_ref() == b"d" {
                    if !active.is_empty() {
                        return Err("XML 不允许嵌套 <d> 弹幕节点。".to_string());
                    }
                    ensure_item_capacity(next_original_index)?;
                    let item =
                        active_danmaku(&start, p_value, depth + 1, next_original_index, true);
                    next_original_index += 1;
                    let parsed = finish_danmaku(item, &mut warnings)?;
                    completed.push(parsed);
                }
            }
            Event::Text(text) => {
                let normalized = text
                    .xml10_content()
                    .map_err(|error| format!("XML 文本不是有效 UTF-8：{error}"))?;
                let decoded = unescape(&normalized)
                    .map_err(|error| format!("XML 文本包含无效实体引用：{error}"))?;
                validate_xml_10_characters("XML 文本", &decoded)?;
                if depth == 0 && !decoded.chars().all(char::is_whitespace) {
                    return Err("XML 根元素外包含非空白文本。".to_string());
                }
                append_active_text(&mut active, &decoded)?;
            }
            Event::CData(cdata) => {
                if depth == 0 {
                    return Err("XML 根元素外不允许 CDATA。".to_string());
                }
                let decoded = cdata
                    .xml10_content()
                    .map_err(|error| format!("XML CDATA 不是有效 UTF-8：{error}"))?;
                validate_xml_10_characters("XML CDATA", &decoded)?;
                append_active_text(&mut active, &decoded)?;
            }
            Event::End(end) => {
                metadata.end(depth, reader.buffer_position() as usize, xml)?;
                if depth == 0 {
                    return Err("XML 包含未匹配的结束标签。".to_string());
                }
                if end.name().as_ref() == b"d"
                    && active.last().is_some_and(|item| item.depth == depth)
                {
                    let item = active.pop().expect("active danmaku checked above");
                    completed.push(finish_danmaku(item, &mut warnings)?);
                }
                depth -= 1;
                if depth == 0 {
                    root_closed = true;
                }
            }
            Event::GeneralRef(reference) => {
                let decoded = decode_general_reference(&reference)?;
                if depth == 0 && !decoded.chars().all(char::is_whitespace) {
                    return Err("XML 根元素外包含实体引用。".to_string());
                }
                append_active_text(&mut active, &decoded)?;
            }
            Event::Eof => break,
            Event::Comment(_) | Event::PI(_) => {}
        }
    }

    if !root_seen || !root_closed || depth != 0 || !active.is_empty() {
        return Err("XML 缺少完整且唯一的根元素。".to_string());
    }
    completed.sort_by_key(|item| item.original_index);
    warnings.sort_by_key(|warning| warning.original_index.unwrap_or(u64::MAX));
    Ok(ParsedXml {
        metadata_xml: metadata.finish(),
        items: completed,
        warnings,
    })
}

fn active_danmaku(
    start: &BytesStart<'_>,
    p_value: Option<String>,
    depth: usize,
    original_index: u64,
    empty: bool,
) -> ActiveDanmaku {
    ActiveDanmaku {
        depth,
        original_index,
        p_value,
        text: String::new(),
        raw_snippet: element_snippet(start, empty),
    }
}

fn validate_xml_declaration(
    declaration: &quick_xml::events::BytesDecl<'_>,
    decoder: quick_xml::encoding::Decoder,
) -> Result<(), String> {
    let content = std::str::from_utf8(declaration.as_ref())
        .map_err(|_| "XML 声明不是有效 UTF-8。".to_string())?;
    let declaration_start = BytesStart::from_content(content, 3);
    let mut fields = Vec::<(String, String)>::new();
    for attribute in declaration_start.attributes() {
        let attribute = attribute.map_err(|error| format!("XML 声明属性结构无效：{error}"))?;
        let key = std::str::from_utf8(attribute.key.as_ref())
            .map_err(|_| "XML 声明属性名不是 UTF-8。".to_string())?
            .to_string();
        let value = attribute
            .decode_and_unescape_value(decoder)
            .map_err(|error| format!("XML 声明属性值无效：{error}"))?
            .into_owned();
        fields.push((key, value));
    }
    if fields.is_empty() || fields[0].0 != "version" || fields[0].1 != "1.0" || fields.len() > 3 {
        return Err("XML 声明必须以 version=\"1.0\" 开始。".to_string());
    }
    let mut next_index = 1;
    if fields
        .get(next_index)
        .is_some_and(|(key, _)| key == "encoding")
    {
        if !fields[next_index].1.eq_ignore_ascii_case("utf-8") {
            return Err("XML 声明必须使用 UTF-8 编码。".to_string());
        }
        next_index += 1;
    }
    if let Some((key, value)) = fields.get(next_index) {
        if key != "standalone" || !matches!(value.as_str(), "yes" | "no") {
            return Err("XML 声明的 standalone 字段无效。".to_string());
        }
        next_index += 1;
    }
    if next_index != fields.len() {
        return Err("XML 声明包含重复、乱序或未知字段。".to_string());
    }
    Ok(())
}

fn validate_start_element(
    start: &BytesStart<'_>,
    decoder: quick_xml::encoding::Decoder,
) -> Result<Option<String>, String> {
    validate_xml_name("XML 元素名", start.name().as_ref())?;
    let is_danmaku = start.name().as_ref() == b"d";
    let mut p_value = None;
    for attribute in start.attributes() {
        let attribute = attribute.map_err(|error| format!("XML 属性结构无效：{error}"))?;
        validate_xml_name("XML 属性名", attribute.key.as_ref())?;
        let value = attribute
            .decode_and_unescape_value(decoder)
            .map_err(|error| format!("XML 属性值无效：{error}"))?;
        validate_xml_10_characters("XML 属性值", &value)?;
        if is_danmaku && attribute.key.as_ref() == b"p" {
            validate_danmaku_p_shape(&value)?;
            p_value = Some(value.into_owned());
        }
    }
    Ok(p_value)
}

fn validate_danmaku_p_shape(value: &str) -> Result<(), String> {
    if value.len() > MAX_DANMAKU_P_BYTES {
        return Err(format!(
            "XML 弹幕 p 属性超过 {} KiB 限制。",
            MAX_DANMAKU_P_BYTES / 1024
        ));
    }
    let field_count = if value.is_empty() {
        0
    } else {
        value.bytes().filter(|byte| *byte == b',').count() + 1
    };
    if field_count > MAX_DANMAKU_P_FIELDS {
        return Err(format!(
            "XML 弹幕 p 字段数量超过 {MAX_DANMAKU_P_FIELDS} 项限制。"
        ));
    }
    Ok(())
}

fn ensure_item_capacity(next_original_index: u64) -> Result<(), String> {
    if next_original_index as usize >= MAX_XML_ITEMS {
        return Err(format!("XML 弹幕数量超过 {MAX_XML_ITEMS} 条限制。"));
    }
    Ok(())
}

fn validate_xml_name(label: &str, bytes: &[u8]) -> Result<(), String> {
    let name = std::str::from_utf8(bytes).map_err(|_| format!("{label}不是有效 UTF-8。"))?;
    let mut characters = name.chars();
    if characters
        .next()
        .is_none_or(|value| !is_xml_name_start(value))
        || !characters.all(is_xml_name_character)
    {
        return Err(format!("{label}不符合 XML 1.0 Name 规则。"));
    }
    Ok(())
}

fn is_xml_name_start(value: char) -> bool {
    matches!(
        value,
        ':' | 'A'..='Z' | '_' | 'a'..='z'
            | '\u{C0}'..='\u{D6}'
            | '\u{D8}'..='\u{F6}'
            | '\u{F8}'..='\u{2FF}'
            | '\u{370}'..='\u{37D}'
            | '\u{37F}'..='\u{1FFF}'
            | '\u{200C}'..='\u{200D}'
            | '\u{2070}'..='\u{218F}'
            | '\u{2C00}'..='\u{2FEF}'
            | '\u{3001}'..='\u{D7FF}'
            | '\u{F900}'..='\u{FDCF}'
            | '\u{FDF0}'..='\u{FFFD}'
            | '\u{10000}'..='\u{EFFFF}'
    )
}

fn is_xml_name_character(value: char) -> bool {
    is_xml_name_start(value)
        || matches!(
            value,
            '-' | '.' | '0'..='9' | '\u{B7}' | '\u{300}'..='\u{36F}' | '\u{203F}'..='\u{2040}'
        )
}

fn validate_xml_10_characters(label: &str, value: &str) -> Result<(), String> {
    if value.chars().all(|character| {
        matches!(
            character,
            '\u{9}' | '\u{A}' | '\u{D}' | '\u{20}'..='\u{D7FF}' | '\u{E000}'..='\u{FFFD}' | '\u{10000}'..='\u{10FFFF}'
        )
    }) {
        Ok(())
    } else {
        Err(format!("{label}包含 XML 1.0 不允许的字符。"))
    }
}

fn append_active_text(active: &mut [ActiveDanmaku], text: &str) -> Result<(), String> {
    for item in active {
        let next_length = item
            .text
            .len()
            .checked_add(text.len())
            .ok_or_else(|| "XML 弹幕文本长度溢出。".to_string())?;
        if next_length > MAX_DANMAKU_TEXT_BYTES {
            return Err("单条 XML 弹幕文本超过 1 MiB 限制。".to_string());
        }
        item.text
            .try_reserve(text.len())
            .map_err(|_| "XML 弹幕文本过大，无法安全分配内存。".to_string())?;
        item.text.push_str(text);
    }
    Ok(())
}

fn decode_general_reference(reference: &quick_xml::events::BytesRef<'_>) -> Result<String, String> {
    if let Some(character) = reference
        .resolve_char_ref()
        .map_err(|error| format!("XML 包含无效字符引用：{error}"))?
    {
        let decoded = character.to_string();
        validate_xml_10_characters("XML 字符引用", &decoded)?;
        return Ok(decoded);
    }
    let name = reference
        .decode()
        .map_err(|error| format!("XML 实体引用不是有效 UTF-8：{error}"))?;
    match name.as_ref() {
        "lt" => Ok("<".to_string()),
        "gt" => Ok(">".to_string()),
        "amp" => Ok("&".to_string()),
        "apos" => Ok("'".to_string()),
        "quot" => Ok("\"".to_string()),
        _ => Err("XML 包含未声明的实体引用；DTD 已被禁用。".to_string()),
    }
}

fn finish_danmaku(
    active: ActiveDanmaku,
    warnings: &mut Vec<XmlImportWarningV1>,
) -> Result<XmlImmutableDanmakuItemV1, String> {
    let raw_p_fields = match active.p_value.as_deref() {
        Some(value) if !value.is_empty() => {
            // `validate_danmaku_p_shape` bounded both bytes and field count before this allocation.
            value.split(',').map(str::to_string).collect()
        }
        _ => Vec::new(),
    };
    if active.p_value.is_none() {
        push_item_warning(
            warnings,
            active.original_index,
            "缺少 p 字段，已使用 0ms 和空元数据。",
            &active.raw_snippet,
        )?;
    }
    if raw_p_fields.len() < 8 {
        push_item_warning(
            warnings,
            active.original_index,
            &format!(
                "p 字段数量不足：期望至少 8 项，实际 {} 项。",
                raw_p_fields.len()
            ),
            &active.raw_snippet,
        )?;
    }
    let parsed_time = raw_p_fields
        .first()
        .and_then(|value| parse_xml_seconds_to_milliseconds(value));
    if parsed_time.is_none() {
        push_item_warning(
            warnings,
            active.original_index,
            "时间字段非法，已使用 0ms。",
            &active.raw_snippet,
        )?;
    }
    if active.text.is_empty() {
        push_item_warning(
            warnings,
            active.original_index,
            "弹幕文本为空。",
            &active.raw_snippet,
        )?;
    }
    Ok(XmlImmutableDanmakuItemV1 {
        original_index: active.original_index,
        source_time_ms: parsed_time.unwrap_or(0),
        mode: parse_nullable_integer(raw_p_fields.get(1), "mode")?,
        font_size: parse_nullable_integer(raw_p_fields.get(2), "fontSize")?,
        color: parse_nullable_integer(raw_p_fields.get(3), "color")?,
        timestamp: parse_nullable_integer(raw_p_fields.get(4), "timestamp")?,
        pool: parse_nullable_integer(raw_p_fields.get(5), "pool")?,
        user_hash: raw_p_fields.get(6).cloned(),
        row_id: raw_p_fields.get(7).cloned(),
        text: active.text,
        raw_p_fields,
    })
}

fn item_warning(original_index: u64, message: &str, raw_snippet: &str) -> XmlImportWarningV1 {
    XmlImportWarningV1 {
        original_index: Some(original_index),
        severity: "warning",
        message: message.to_string(),
        raw_snippet: raw_snippet.to_string(),
    }
}

fn push_item_warning(
    warnings: &mut Vec<XmlImportWarningV1>,
    original_index: u64,
    message: &str,
    raw_snippet: &str,
) -> Result<(), String> {
    ensure_warning_capacity(warnings.len())?;
    warnings.push(item_warning(original_index, message, raw_snippet));
    Ok(())
}

fn ensure_warning_capacity(current: usize) -> Result<(), String> {
    if current >= MAX_XML_WARNINGS {
        return Err(format!(
            "XML 导入警告数量超过 {MAX_XML_WARNINGS} 条限制；请先修复源文件。"
        ));
    }
    Ok(())
}

fn parse_xml_seconds_to_milliseconds(value: &str) -> Option<u64> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let (whole, fraction) = trimmed.split_once('.').unwrap_or((trimmed, ""));
    if whole.is_empty()
        || !whole.bytes().all(|byte| byte.is_ascii_digit())
        || !fraction.bytes().all(|byte| byte.is_ascii_digit())
        || (trimmed.contains('.') && fraction.is_empty())
    {
        return None;
    }
    let whole_seconds = whole.parse::<u64>().ok()?;
    let mut milliseconds = 0_u64;
    for (index, byte) in fraction.bytes().take(3).enumerate() {
        milliseconds += u64::from(byte - b'0') * 10_u64.pow(2 - index as u32);
    }
    if fraction
        .as_bytes()
        .get(3)
        .is_some_and(|digit| *digit >= b'5')
    {
        milliseconds += 1;
    }
    let total = whole_seconds.checked_mul(1000)?.checked_add(milliseconds)?;
    (total <= MAX_SAFE_INTEGER).then_some(total)
}

fn parse_nullable_integer(value: Option<&String>, field_name: &str) -> Result<Option<i64>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let Ok(parsed) = trimmed.parse::<f64>() else {
        return Ok(None);
    };
    if !parsed.is_finite() {
        return Ok(None);
    }
    let truncated = parsed.trunc();
    if truncated < -(MAX_SAFE_INTEGER as f64) || truncated > MAX_SAFE_INTEGER as f64 {
        return Err(format!(
            "XML 弹幕 p 字段 {field_name} 超出 JavaScript 安全整数范围。"
        ));
    }
    Ok(Some(truncated as i64))
}

fn element_snippet(start: &BytesStart<'_>, empty: bool) -> String {
    let mut snippet = String::from("<");
    snippet.push_str(&String::from_utf8_lossy(start.as_ref()));
    snippet.push_str(if empty { "/>" } else { ">" });
    snippet.chars().take(MAX_WARNING_SNIPPET_CHARS).collect()
}

fn persist_cas_object(
    storage_root: &Path,
    content_digest: &str,
    bytes: &[u8],
) -> Result<(), String> {
    if sha256_digest(bytes) != content_digest {
        return Err("待持久化 XML 字节与内容摘要不一致。".to_string());
    }
    let destination = cas_object_path(storage_root, content_digest)?;
    if destination.exists() {
        return verify_existing_cas_object(&destination, content_digest, bytes.len() as u64);
    }
    let parent = destination
        .parent()
        .ok_or_else(|| "XML CAS 目标缺少父目录。".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("无法创建 XML CAS 目录：{error}"))?;
    let temp_path = parent.join(format!(
        ".{}.{}.tmp",
        destination
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("xml-object"),
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
            .map_err(|error| format!("无法创建 XML CAS 临时文件：{error}"))?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| format!("无法同步 XML CAS 临时文件：{error}"))?;
        match atomic_move_new_file(&temp_path, &destination) {
            Ok(()) => Ok(()),
            Err(error) if destination.exists() => {
                verify_existing_cas_object(&destination, content_digest, bytes.len() as u64)
                    .map_err(|verify_error| format!("{error}；{verify_error}"))
            }
            Err(error) => Err(error),
        }
    })();
    if result.is_err() || temp_path.exists() {
        let _ = fs::remove_file(&temp_path);
    }
    result
}

fn verify_existing_cas_object(
    path: &Path,
    content_digest: &str,
    expected_size: u64,
) -> Result<(), String> {
    let bytes = read_pinned_file_bytes(path, MAX_XML_FILE_BYTES)?;
    if bytes.len() as u64 != expected_size || sha256_digest(&bytes) != content_digest {
        return Err("已有 XML CAS 对象与内容地址不一致，已阻断覆盖。".to_string());
    }
    Ok(())
}

fn cas_object_path(storage_root: &Path, content_digest: &str) -> Result<PathBuf, String> {
    if !has_prefixed_lower_hex(content_digest, "sha256:", 64) {
        return Err("XML contentDigest 格式无效。".to_string());
    }
    Ok(storage_root
        .join(XML_OBJECTS_DIRECTORY)
        .join(SHA256_DIRECTORY)
        .join(&content_digest["sha256:".len()..]))
}

#[cfg(windows)]
fn read_pinned_file_bytes(path: &Path, max_bytes: u64) -> Result<Vec<u8>, String> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ;

    let mut options = OpenOptions::new();
    options.read(true).share_mode(FILE_SHARE_READ);
    read_exact_bytes_from_open_file(
        options
            .open(path)
            .map_err(|_| "无法取得 XML 文件的稳定只读 pin；路径已隐藏。".to_string())?,
        max_bytes,
    )
}

#[cfg(not(windows))]
fn read_pinned_file_bytes(path: &Path, max_bytes: u64) -> Result<Vec<u8>, String> {
    read_exact_bytes_from_open_file(
        File::open(path).map_err(|_| "无法读取 XML 本地文件；路径已隐藏。".to_string())?,
        max_bytes,
    )
}

fn read_exact_bytes_from_open_file(mut file: File, max_bytes: u64) -> Result<Vec<u8>, String> {
    let before = file
        .metadata()
        .map_err(|error| format!("无法读取 XML 文件元数据：{error}"))?;
    if !before.is_file() {
        return Err("XML 导入只接受本地普通文件。".to_string());
    }
    if before.len() > max_bytes {
        return Err(format!(
            "XML 文件超过 {} MiB 限制。",
            max_bytes / 1024 / 1024
        ));
    }
    let capacity = usize::try_from(before.len())
        .map_err(|_| "XML 文件大小无法在当前平台安全分配。".to_string())?;
    let mut bytes = Vec::with_capacity(capacity);
    (&mut file)
        .take(max_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("无法读取固定 XML 文件字节：{error}"))?;
    let after = file
        .metadata()
        .map_err(|error| format!("无法复核 XML 文件元数据：{error}"))?;
    if bytes.len() as u64 != before.len()
        || after.len() != before.len()
        || bytes.len() as u64 > max_bytes
        || before.modified().ok() != after.modified().ok()
    {
        return Err("XML 文件在固定读取期间发生变化，已拒绝导入。".to_string());
    }
    Ok(bytes)
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
    // SAFETY: Both paths are NUL-terminated UTF-16 buffers retained for the system call.
    let result = unsafe {
        MoveFileExW(
            source_wide.as_ptr(),
            destination_wide.as_ptr(),
            MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        return Err(format!(
            "无法原子创建 XML CAS 对象：{}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
fn atomic_move_new_file(source: &Path, destination: &Path) -> Result<(), String> {
    fs::hard_link(source, destination)
        .map_err(|error| format!("无法原子创建 XML CAS 对象：{error}"))?;
    fs::remove_file(source).map_err(|error| format!("无法删除 XML CAS 临时硬链接：{error}"))
}

fn has_xml_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("xml"))
}

fn has_prefixed_lower_hex(value: &str, prefix: &str, hex_length: usize) -> bool {
    value
        .strip_prefix(prefix)
        .is_some_and(|hex| is_lower_hex(hex, hex_length))
}

fn is_lower_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn sha256_digest(bytes: &[u8]) -> String {
    format!("sha256:{}", sha256_hex(bytes))
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex_encode(&Sha256::digest(bytes))
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

struct DigestWriter<'a>(&'a mut Sha256);

impl Write for DigestWriter<'_> {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        self.0.update(buffer);
        Ok(buffer.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

struct CanonicalInventory<'a> {
    items: &'a [XmlImmutableDanmakuItemV1],
}

impl Serialize for CanonicalInventory<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut sequence = serializer.serialize_seq(Some(4))?;
        sequence.serialize_element(XML_INVENTORY_DOMAIN)?;
        sequence.serialize_element(XML_PARSER_VERSION)?;
        sequence.serialize_element(&self.items.len())?;
        sequence.serialize_element(&CanonicalItems(self.items))?;
        sequence.end()
    }
}

struct CanonicalItems<'a>(&'a [XmlImmutableDanmakuItemV1]);

impl Serialize for CanonicalItems<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut sequence = serializer.serialize_seq(Some(self.0.len()))?;
        for item in self.0 {
            sequence.serialize_element(&CanonicalItem(item))?;
        }
        sequence.end()
    }
}

struct CanonicalItem<'a>(&'a XmlImmutableDanmakuItemV1);

impl Serialize for CanonicalItem<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let item = self.0;
        let mut sequence = serializer.serialize_seq(Some(12))?;
        sequence.serialize_element(XML_ITEM_DOMAIN)?;
        sequence.serialize_element(&item.original_index)?;
        sequence.serialize_element(&item.source_time_ms)?;
        sequence.serialize_element(&item.mode)?;
        sequence.serialize_element(&item.font_size)?;
        sequence.serialize_element(&item.color)?;
        sequence.serialize_element(&item.timestamp)?;
        sequence.serialize_element(&item.pool)?;
        sequence.serialize_element(&item.user_hash)?;
        sequence.serialize_element(&item.row_id)?;
        sequence.serialize_element(&item.text)?;
        sequence.serialize_element(&item.raw_p_fields)?;
        sequence.end()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(1);
    const TEST_KEY_ID: &str = "install-sha256:0123456789abcdef0123456789abcdef";
    const VALID_XML: &[u8] = br#"<?xml version="1.0" encoding="UTF-8"?>
<i><d p="1.2345,1,25,16777215,1700000000,0,user,row">A &amp; B</d></i>"#;

    struct TempFixture {
        root: PathBuf,
    }

    impl TempFixture {
        fn new(label: &str) -> Self {
            let sequence = TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("test clock")
                .as_nanos();
            let root = std::env::temp_dir().join(format!(
                "c137-xml-receipt-{label}-{}-{nanos}-{sequence}",
                std::process::id()
            ));
            fs::create_dir(&root).expect("create test root");
            Self { root }
        }

        fn write_xml(&self, name: &str, bytes: &[u8]) -> PathBuf {
            let path = self.root.join(name);
            fs::write(&path, bytes).expect("write XML fixture");
            path
        }
    }

    impl Drop for TempFixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn test_signature(payload: &[u8]) -> String {
        let mut hasher = Sha256::new();
        hasher.update(b"c137-test-install-key\0");
        hasher.update(payload);
        hex_encode(&hasher.finalize())
    }

    fn test_sign(payload: &[u8]) -> Result<ReceiptSignature, String> {
        Ok(ReceiptSignature {
            issuer_key_id: TEST_KEY_ID.to_string(),
            signature: test_signature(payload),
        })
    }

    fn test_verify(payload: &[u8], key_id: &str, signature: &str) -> Result<(), String> {
        if key_id == TEST_KEY_ID && signature == test_signature(payload) {
            Ok(())
        } else {
            Err("test signature rejected".to_string())
        }
    }

    fn import_fixture(fixture: &TempFixture, inputs: &[PathBuf]) -> ImportBilibiliXmlFilesResult {
        let paths: Vec<String> = inputs
            .iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect();
        let prepared = prepare_xml_files(&paths).expect("prepare XML batch");
        import_prepared_xml_files(&fixture.root.join("cas"), prepared, test_sign)
            .expect("import XML batch")
    }

    #[test]
    fn imports_normal_batch_and_deduplicates_identical_cas_bytes() {
        let fixture = TempFixture::new("normal-batch");
        let first = fixture.write_xml("one.xml", VALID_XML);
        let second = fixture.write_xml("two.XML", VALID_XML);
        let result = import_fixture(&fixture, &[first, second]);
        assert_eq!(result.files.len(), 2);
        assert_eq!(result.files[0].receipt, result.files[1].receipt);
        assert_eq!(result.files[0].items.len(), 1);
        assert_eq!(result.files[0].items[0].source_time_ms, 1235);
        assert_eq!(result.files[0].items[0].text, "A & B");
        let object = cas_object_path(
            &fixture.root.join("cas"),
            &result.files[0].receipt.content_digest,
        )
        .unwrap();
        assert_eq!(fs::read(object).unwrap(), VALID_XML);
        verify_xml_content_receipt_at(
            &fixture.root.join("cas"),
            &result.files[0].receipt,
            &result.files[0].items,
            test_verify,
        )
        .expect("verify normal receipt");
    }

    #[test]
    fn metadata_fragment_preserves_namespaces_without_copying_comment_inventory() {
        let source = include_str!("../../fixtures/bilibili/media-metadata.xml");
        let parsed = parse_bilibili_xml(source.as_bytes()).unwrap();
        let fragment = parsed.metadata_xml.unwrap();
        assert!(fragment.contains("xmlns:dbx="));
        assert!(fragment.contains("duration-ms=\"280123\""));
        assert!(!fragment.contains("<d p="));
        assert_eq!(parsed.items.len(), 1);
        let reparsed = parse_bilibili_xml(fragment.as_bytes()).unwrap();
        assert_eq!(reparsed.metadata_xml.unwrap(), fragment);
        let empty = parse_bilibili_xml(b"<i xmlns:m=\"urn:x\"><m:meta /></i>").unwrap();
        assert!(empty.metadata_xml.unwrap().contains("<m:meta />"));
    }

    #[test]
    fn metadata_fragment_bounds_size_and_ignores_nested_comment_markup() {
        let nested = parse_bilibili_xml(b"<i><d p=\"1\"><meta>text</meta></d></i>").unwrap();
        assert!(nested.metadata_xml.is_none());
        let huge = format!("<i><metadata>{}</metadata></i>", "x".repeat(1024 * 1024));
        assert!(parse_bilibili_xml(huge.as_bytes()).unwrap_err().contains("1 MiB"));
    }

    #[test]
    fn rejects_dtd_invalid_utf8_and_malformed_xml() {
        assert!(parse_bilibili_xml(b"<!DOCTYPE i><i></i>")
            .unwrap_err()
            .contains("DTD/DOCTYPE"));
        assert!(parse_bilibili_xml(b"<i>\xff</i>")
            .unwrap_err()
            .contains("UTF-8"));
        assert!(parse_bilibili_xml(b"<i><d></i>")
            .unwrap_err()
            .contains("畸形"));
        assert!(parse_bilibili_xml(b"<i></i><i></i>")
            .unwrap_err()
            .contains("一个根元素"));
        assert!(parse_bilibili_xml(b"<?xml version=\"1.1\"?><i/>")
            .unwrap_err()
            .contains("version=\"1.0\""));
        assert!(parse_bilibili_xml(b"<i>\x01</i>")
            .unwrap_err()
            .contains("XML 1.0"));
        assert!(parse_bilibili_xml(b"<i>&unknown;</i>")
            .unwrap_err()
            .contains("未声明的实体"));
        assert!(parse_bilibili_xml(b"<i duplicated=\"1\" duplicated=\"2\"/>").is_err());
    }

    #[test]
    fn exact_original_bytes_have_independent_content_identity() {
        let mut with_trailing_newline = VALID_XML.to_vec();
        with_trailing_newline.push(b'\n');
        let first = parse_bilibili_xml(VALID_XML).unwrap();
        let second = parse_bilibili_xml(&with_trailing_newline).unwrap();
        assert_eq!(
            compute_xml_inventory_digest(&first.items).unwrap(),
            compute_xml_inventory_digest(&second.items).unwrap()
        );
        assert_ne!(
            sha256_digest(VALID_XML),
            sha256_digest(&with_trailing_newline)
        );
    }

    #[test]
    fn rejects_nullable_numbers_outside_javascript_safe_integer_range() {
        let positive = parse_bilibili_xml(
            br#"<i><d p="0,9007199254740992,25,16777215,0,0,user,row">x</d></i>"#,
        )
        .unwrap_err();
        assert!(positive.contains("mode 超出 JavaScript 安全整数范围"));

        let negative = parse_bilibili_xml(
            br#"<i><d p="0,1,25,16777215,-9007199254740992,0,user,row">x</d></i>"#,
        )
        .unwrap_err();
        assert!(negative.contains("timestamp 超出 JavaScript 安全整数范围"));

        let boundary = parse_bilibili_xml(
            br#"<i><d p="0,9007199254740991,25,16777215,-9007199254740991,0,user,row">x</d></i>"#,
        )
        .unwrap();
        assert_eq!(boundary.items[0].mode, Some(9_007_199_254_740_991));
        assert_eq!(boundary.items[0].timestamp, Some(-9_007_199_254_740_991));
    }

    #[test]
    fn rejects_nested_d_before_large_text_can_be_amplified() {
        let large_text = "x".repeat(2 * 1024 * 1024);
        let xml = format!(
            "<i><d p=\"0,1,25,1,0,0,u,outer\"><d p=\"0,1,25,1,0,0,u,inner\">{large_text}</d></d></i>"
        );
        let error = parse_bilibili_xml(xml.as_bytes()).unwrap_err();
        assert!(error.contains("不允许嵌套 <d>"));
    }

    #[test]
    fn rejects_excessive_p_bytes_and_field_count_before_split_allocation() {
        let too_many_fields = vec!["0"; MAX_DANMAKU_P_FIELDS + 1].join(",");
        let xml = format!("<i><d p=\"{too_many_fields}\">x</d></i>");
        let error = parse_bilibili_xml(xml.as_bytes()).unwrap_err();
        assert!(error.contains("p 字段数量超过 64"));

        let oversized_p = "x".repeat(MAX_DANMAKU_P_BYTES + 1);
        let xml = format!("<i><d p=\"{oversized_p}\">x</d></i>");
        let error = parse_bilibili_xml(xml.as_bytes()).unwrap_err();
        assert!(error.contains("p 属性超过 16 KiB"));
    }

    #[test]
    fn rejects_single_danmaku_text_over_one_mib_incrementally() {
        let oversized_text = "x".repeat(MAX_DANMAKU_TEXT_BYTES + 1);
        let xml = format!("<i><d p=\"0,1,25,1,0,0,u,r\">{oversized_text}</d></i>");
        let error = parse_bilibili_xml(xml.as_bytes()).unwrap_err();
        assert!(error.contains("文本超过 1 MiB"));
    }

    #[test]
    fn item_batch_and_warning_caps_fail_closed_at_the_boundary() {
        assert!(ensure_item_capacity((MAX_XML_ITEMS - 1) as u64).is_ok());
        assert!(ensure_item_capacity(MAX_XML_ITEMS as u64).is_err());

        assert_eq!(
            checked_batch_byte_total(MAX_XML_BATCH_BYTES - 1, 1).unwrap(),
            MAX_XML_BATCH_BYTES
        );
        assert!(checked_batch_byte_total(MAX_XML_BATCH_BYTES, 1).is_err());

        assert_eq!(
            checked_batch_item_total(MAX_XML_BATCH_ITEMS - 1, 1).unwrap(),
            MAX_XML_BATCH_ITEMS
        );
        assert!(checked_batch_item_total(MAX_XML_BATCH_ITEMS, 1).is_err());

        assert!(ensure_warning_capacity(MAX_XML_WARNINGS - 1).is_ok());
        assert!(ensure_warning_capacity(MAX_XML_WARNINGS).is_err());
    }

    #[test]
    fn receipt_or_signature_tampering_is_rejected() {
        let fixture = TempFixture::new("receipt-tamper");
        let input = fixture.write_xml("input.xml", VALID_XML);
        let mut result = import_fixture(&fixture, &[input]);
        let imported = &mut result.files[0];
        imported.receipt.size_bytes += 1;
        assert!(verify_xml_content_receipt_at(
            &fixture.root.join("cas"),
            &imported.receipt,
            &imported.items,
            test_verify,
        )
        .is_err());

        imported.receipt.size_bytes -= 1;
        let replacement = if imported.receipt.signature.starts_with('0') {
            "1"
        } else {
            "0"
        };
        imported.receipt.signature.replace_range(..1, replacement);
        assert!(verify_xml_content_receipt_at(
            &fixture.root.join("cas"),
            &imported.receipt,
            &imported.items,
            test_verify,
        )
        .is_err());
    }

    #[test]
    fn missing_or_tampered_cas_object_is_rejected() {
        let fixture = TempFixture::new("cas-tamper");
        let input = fixture.write_xml("input.xml", VALID_XML);
        let result = import_fixture(&fixture, &[input]);
        let imported = &result.files[0];
        let object =
            cas_object_path(&fixture.root.join("cas"), &imported.receipt.content_digest).unwrap();
        fs::remove_file(&object).unwrap();
        assert!(verify_xml_content_receipt_at(
            &fixture.root.join("cas"),
            &imported.receipt,
            &imported.items,
            test_verify,
        )
        .unwrap_err()
        .contains("对象缺失"));

        fs::write(&object, b"<i></i>").unwrap();
        assert!(verify_xml_content_receipt_at(
            &fixture.root.join("cas"),
            &imported.receipt,
            &imported.items,
            test_verify,
        )
        .unwrap_err()
        .contains("大小或摘要无效"));
    }

    #[test]
    fn canonical_inventory_changes_for_every_immutable_edit() {
        let parsed = parse_bilibili_xml(VALID_XML).unwrap();
        let baseline = compute_xml_inventory_digest(&parsed.items).unwrap();
        let mut changed = parsed.items.clone();
        changed[0].text.push('!');
        assert_ne!(baseline, compute_xml_inventory_digest(&changed).unwrap());
        changed = parsed.items.clone();
        changed[0].raw_p_fields[0] = "1.235".to_string();
        assert_ne!(baseline, compute_xml_inventory_digest(&changed).unwrap());
        changed = parsed.items.clone();
        changed[0].source_time_ms += 1;
        assert_ne!(baseline, compute_xml_inventory_digest(&changed).unwrap());
    }

    #[test]
    fn project_inventory_tampering_is_rejected_even_with_valid_receipt_and_cas() {
        let fixture = TempFixture::new("inventory-tamper");
        let input = fixture.write_xml("input.xml", VALID_XML);
        let result = import_fixture(&fixture, &[input]);
        let imported = &result.files[0];
        let mut changed = imported.items.clone();
        changed[0].user_hash = Some("attacker".to_string());
        assert!(verify_xml_content_receipt_at(
            &fixture.root.join("cas"),
            &imported.receipt,
            &changed,
            test_verify,
        )
        .unwrap_err()
        .contains("不可变弹幕清单已被修改"));
    }

    #[test]
    fn cdata_nested_text_and_frontend_warning_fallbacks_are_preserved() {
        let parsed =
            parse_bilibili_xml(br#"<i><d p="bad"><b>A</b><![CDATA[<B>]]>&amp;</d><d /></i>"#)
                .unwrap();
        assert_eq!(parsed.items.len(), 2);
        assert_eq!(parsed.items[0].text, "A<B>&");
        assert_eq!(parsed.items[0].source_time_ms, 0);
        assert_eq!(parsed.items[1].raw_p_fields, Vec::<String>::new());
        assert!(parsed
            .warnings
            .iter()
            .any(|warning| warning.message.contains("时间字段非法")));
        assert!(parsed
            .warnings
            .iter()
            .any(|warning| warning.message.contains("缺少 p 字段")));
    }
}
