//! Immutable exported bytes and independently saved publication drafts.
use super::*;
use std::{fs, path::Path, sync::Mutex};
static LOCK: Mutex<()> = Mutex::new(());
const MAX_BATCH: usize = 256 * 1024 * 1024;
const MAX_DRAFT: usize = 2 * 1024 * 1024;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeliveryFile {
    file_name: String,
    content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    target_file_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    duration_ms: Option<u64>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Delivery {
    project_id: String,
    project_updated_at: String,
    project_name: String,
    kind: String,
    created_at: String,
    files: Vec<DeliveryFile>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    library_profile: Option<LibraryProfile>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LibraryProfile {
    schema_version: u8,
    work_key: String,
    edition_key: String,
    source_key: String,
    title: String,
    aliases: Vec<String>,
    kind: Option<String>,
    year: Option<u16>,
    edition: String,
    source_label: String,
    season: Option<u16>,
}
impl LibraryProfile {
    fn valid(&self) -> bool {
        self.schema_version == 1
            && [&self.work_key, &self.edition_key, &self.source_key]
                .iter()
                .all(|k| {
                    !k.is_empty()
                        && k.len() <= 128
                        && k.as_bytes()[0].is_ascii_alphanumeric()
                        && k.bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
                })
            && [&self.title, &self.edition, &self.source_label]
                .iter()
                .all(|s| s.encode_utf16().count() <= 200)
            && self.aliases.len() <= 50
            && self.aliases.iter().all(|s| s.encode_utf16().count() <= 200)
            && self
                .kind
                .as_deref()
                .is_none_or(|v| matches!(v, "tv" | "movie"))
            && self.year.is_none_or(|v| (1880..=2200).contains(&v))
            && self.season.is_none_or(|v| v <= 999)
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    key: String,
    project_id: String,
    project_name: String,
    created_at: String,
    file_count: usize,
    byte_count: usize,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    key: String,
    delivery: Delivery,
    draft: Option<Value>,
}
fn root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map(|p| p.join("private-library/outbox"))
        .map_err(|_| "无法定位成品记录目录。".into())
}
fn key_path(root: &Path, key: &str, suffix: &str) -> Result<PathBuf, String> {
    if key.len() != 64 || !key.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("成品记录身份无效。".into());
    }
    Ok(root.join(format!("{key}.{suffix}.json")))
}
fn read_bounded(path: &Path, limit: usize) -> Result<Option<Vec<u8>>, String> {
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("读取成品记录失败，原文件保留。".into()),
    };
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > limit as u64 {
        return Err("成品记录类型或大小异常，原文件保留。".into());
    }
    let bytes = fs::read(path).map_err(|_| "读取成品记录失败。")?;
    if bytes.len() > limit {
        return Err("成品记录超过容量上限。".into());
    }
    Ok(Some(bytes))
}
fn index(root: &Path) -> Result<Vec<Summary>, String> {
    read_bounded(&root.join("index.json"), MAX_DRAFT)?
        .map(|b| serde_json::from_slice(&b).map_err(|_| "成品索引损坏，未覆盖旧记录。".into()))
        .unwrap_or_else(|| Ok(vec![]))
}
fn save_at(root: &Path, delivery: Delivery) -> Result<Summary, String> {
    if delivery.files.is_empty()
        || delivery
            .library_profile
            .as_ref()
            .is_some_and(|p| !p.valid())
        || delivery.files.len() > 1000
        || delivery.project_id.is_empty()
        || delivery.project_id.len() > 256
        || delivery.project_name.len() > 4096
        || delivery.created_at.len() > 64
        || delivery.project_updated_at.len() > 64
        || !matches!(delivery.kind.as_str(), "xml" | "family" | "projection")
    {
        return Err("成品批次信息无效或超过容量上限。".into());
    }
    let bytes = serde_json::to_vec(&delivery).map_err(|_| "成品编码失败。")?;
    if bytes.len() > MAX_BATCH
        || delivery
            .files
            .iter()
            .any(|f| f.content.len() > MAX_OBJECT_BYTES || f.file_name.len() > 4096)
    {
        return Err("单文件最多 64 MiB，单批成品最多 256 MiB。请分批导出。".into());
    }
    let key = hash(&bytes);
    let mut entries = index(root)?;
    let summary = Summary {
        key: key.clone(),
        project_id: delivery.project_id,
        project_name: delivery.project_name,
        created_at: delivery.created_at,
        file_count: delivery.files.len(),
        byte_count: bytes.len(),
    };
    if entries.iter().all(|e| e.key != key) {
        if entries.len() >= 2000 {
            return Err("成品记录达到 2000 批上限；未删除旧成品。".into());
        }
        entries.insert(0, summary.clone());
    }
    let index_bytes = serde_json::to_vec(&entries).map_err(|_| "成品索引编码失败。")?;
    if index_bytes.len() > MAX_DRAFT {
        return Err("成品索引达到容量上限；未覆盖旧记录。".into());
    }
    fs::create_dir_all(root).map_err(|_| "无法创建成品记录目录。")?;
    let path = key_path(root, &key, "delivery")?;
    if let Some(old) = read_bounded(&path, MAX_BATCH)? {
        if old != bytes {
            return Err("成品快照校验冲突，未覆盖。".into());
        }
    } else {
        crate::project_files::atomic_write(&path, &bytes)?;
    }
    crate::project_files::atomic_write(&root.join("index.json"), &index_bytes)?;
    Ok(summary)
}
fn load_at(root: &Path, key: &str) -> Result<Record, String> {
    let bytes =
        read_bounded(&key_path(root, key, "delivery")?, MAX_BATCH)?.ok_or("成品快照不存在。")?;
    if hash(&bytes) != key {
        return Err("成品快照校验失败，未用于发布。".into());
    }
    let delivery = serde_json::from_slice(&bytes).map_err(|_| "成品快照无法解析。")?;
    let draft = read_bounded(&key_path(root, key, "draft")?, MAX_DRAFT)?
        .map(|b| serde_json::from_slice(&b).map_err(|_| "发布草稿损坏，原文件保留。"))
        .transpose()?;
    Ok(Record {
        key: key.into(),
        delivery,
        draft,
    })
}
#[tauri::command]
pub async fn save_publication_delivery(
    app: AppHandle,
    delivery: Delivery,
) -> Result<Summary, String> {
    let root = root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = LOCK.lock().map_err(|_| "成品记录忙碌。")?;
        save_at(&root, delivery)
    })
    .await
    .map_err(|_| "成品写入任务中断。")?
}
#[tauri::command]
pub async fn list_publication_deliveries(app: AppHandle) -> Result<Vec<Summary>, String> {
    let root = root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = LOCK.lock().map_err(|_| "成品记录忙碌。")?;
        index(&root)
    })
    .await
    .map_err(|_| "成品读取任务中断。")?
}
#[tauri::command]
pub async fn load_publication_delivery(app: AppHandle, key: String) -> Result<Record, String> {
    let root = root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = LOCK.lock().map_err(|_| "成品记录忙碌。")?;
        load_at(&root, &key)
    })
    .await
    .map_err(|_| "成品读取任务中断。")?
}
#[tauri::command]
pub async fn save_publication_draft(
    app: AppHandle,
    key: String,
    draft: Value,
) -> Result<(), String> {
    let root = root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = LOCK.lock().map_err(|_| "成品记录忙碌。")?;
        let entries = index(&root)?;
        let record = entries
            .iter()
            .find(|r| r.key == key)
            .ok_or("成品记录不存在。")?;
        let bytes = serde_json::to_vec(&draft).map_err(|_| "发布草稿编码失败。")?;
        if bytes.len() > MAX_DRAFT
            || draft["schemaVersion"] != 1
            || draft["rows"]
                .as_array()
                .is_none_or(|r| r.len() != record.file_count)
        {
            return Err("发布草稿格式或容量无效。".into());
        }
        crate::project_files::atomic_write(&key_path(&root, &key, "draft")?, &bytes)
    })
    .await
    .map_err(|_| "草稿写入任务中断。")?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_snapshot_encoding_and_digest_remain_exact() {
        let old = br#"{"projectId":"p","projectUpdatedAt":"2026","projectName":"old","kind":"xml","createdAt":"2026","files":[{"fileName":"01.xml","content":"<i/>"}]}"#;
        let delivery: Delivery = serde_json::from_slice(old).unwrap();
        let encoded = serde_json::to_vec(&delivery).unwrap();
        assert_eq!(encoded, old);
        assert_eq!(hash(&encoded), hash(old));
        assert!(delivery.library_profile.is_none());
        let mut value: Value = serde_json::from_slice(old).unwrap();
        value["libraryProfile"] = serde_json::json!({"schemaVersion":1,"workKey":"w","editionKey":"e","sourceKey":"s","title":"new","aliases":["alias"],"kind":null,"year":null,"edition":"unknown","sourceLabel":"personal","season":null});
        let next: Delivery = serde_json::from_value(value.clone()).unwrap();
        assert!(next.library_profile.as_ref().unwrap().valid());
        assert_ne!(hash(&serde_json::to_vec(&next).unwrap()), hash(old));
        value["libraryProfile"]["publishToken"] = "secret".into();
        assert!(serde_json::from_value::<Delivery>(value).is_err());
    }
    #[test]
    fn durable_export_is_immutable_and_corrupt_data_is_not_published() {
        let dir = std::env::temp_dir().join(format!(
            "studio-outbox-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let d = Delivery {
            library_profile: None,
            project_id: "p".into(),
            project_name: "项目".into(),
            project_updated_at: "2026".into(),
            kind: "xml".into(),
            created_at: "2026".into(),
            files: vec![DeliveryFile {
                file_name: "01.xml".into(),
                content: "<i/>".into(),
                target_file_name: None,
                duration_ms: None,
            }],
        };
        let first = save_at(&dir, d.clone()).unwrap();
        assert_eq!(save_at(&dir, d.clone()).unwrap().key, first.key);
        assert_eq!(index(&dir).unwrap().len(), 1);
        let mut next = d;
        next.files[0].content = "<i><d/></i>".into();
        let second = save_at(&dir, next).unwrap();
        assert_ne!(first.key, second.key);
        assert_eq!(
            load_at(&dir, &first.key).unwrap().delivery.files[0].content,
            "<i/>"
        );
        fs::write(key_path(&dir, &first.key, "delivery").unwrap(), "changed").unwrap();
        assert!(load_at(&dir, &first.key).is_err());
        assert!(key_path(&dir, "../../outside", "draft").is_err());
    }
}
