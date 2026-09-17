//! File identities come from verified torrent metadata, never a search result's display title.
use super::*;
use bendy::{
    decoding::{Decoder, FromBencode},
    value::Value as BValue,
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ContentFile {
    path: String,
    length: u64,
}

fn field<'a, 'b>(value: &'a BValue<'b>, key: &str) -> Option<&'a BValue<'b>> {
    if let BValue::Dict(dict) = value {
        dict.get(key.as_bytes())
    } else {
        None
    }
}
fn component(value: &BValue<'_>) -> Result<String, String> {
    let BValue::Bytes(bytes) = value else {
        return Err("种子文件名不是文本。".into());
    };
    let name = std::str::from_utf8(bytes).map_err(|_| "种子文件名编码不受支持。")?;
    if name.is_empty()
        || name.len() > 255
        || name == "."
        || name == ".."
        || name
            .chars()
            .any(|c| c.is_control() || "<>:\"/\\|?*".contains(c))
        || name.ends_with([' ', '.'])
    {
        return Err("种子包含不能安全用于本机路径的文件名。".into());
    }
    Ok(name.into())
}
fn length(value: &BValue<'_>) -> Result<u64, String> {
    match field(value, "length") {
        Some(BValue::Integer(n)) if *n >= 0 => Ok(*n as u64),
        _ => Err("种子文件长度无效。".into()),
    }
}
pub(super) fn manifest(bytes: &[u8]) -> Result<Vec<ContentFile>, String> {
    let mut decoder = Decoder::new(bytes).with_max_depth(32);
    let object = decoder
        .next_object()
        .map_err(|_| "种子结构无效。")?
        .ok_or("种子为空。")?;
    let value = BValue::decode_bencode_object(object).map_err(|_| "种子结构无效。")?;
    let info = field(&value, "info").ok_or("种子缺少 info。")?;
    let name = component(
        field(info, "name.utf-8")
            .or_else(|| field(info, "name"))
            .ok_or("种子缺少名称。")?,
    )?;
    let Some(files) = field(info, "files") else {
        return Ok(vec![ContentFile {
            path: name,
            length: length(info)?,
        }]);
    };
    let BValue::List(files) = files else {
        return Err("种子文件列表无效。".into());
    };
    if files.is_empty() || files.len() > 5000 {
        return Err("种子文件数量超出可管理范围。".into());
    }
    let mut result = Vec::new();
    for file in files {
        let Some(BValue::List(parts)) = field(file, "path.utf-8").or_else(|| field(file, "path"))
        else {
            return Err("种子文件路径无效。".into());
        };
        if parts.is_empty() || parts.len() > 12 || field(file, "symlink path").is_some() {
            return Err("种子包含不支持的路径。".into());
        }
        let mut path = PathBuf::from(&name);
        for part in parts {
            path.push(component(part)?);
        }
        result.push(ContentFile {
            path: path.to_string_lossy().into_owned(),
            length: length(file)?,
        });
    }
    Ok(result)
}

pub(super) fn verified(root: &Path, manifest: &[ContentFile]) -> Result<Vec<String>, String> {
    let root = root.canonicalize().map_err(|_| "原片目录不可访问。")?;
    let mut files = Vec::new();
    for file in manifest
        .iter()
        .filter(|file| file.length > 0 && media_file(Path::new(&file.path)))
    {
        // Reject escaping paths even if a corrupted old queue is loaded.
        if Path::new(&file.path).is_absolute()
            || Path::new(&file.path)
                .components()
                .any(|c| !matches!(c, std::path::Component::Normal(_)))
        {
            return Err("下载记录中的文件路径无效。".into());
        }
        let path = root.join(&file.path);
        let metadata = match std::fs::symlink_metadata(&path) {
            Ok(meta) => meta,
            Err(_) => continue,
        };
        if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() != file.length
        {
            continue;
        }
        let canonical = path.canonicalize().map_err(|_| "无法核对已下载文件。")?;
        if !canonical.starts_with(&root) {
            return Err("已下载文件指向本次目录之外。".into());
        }
        files.push(task_state::interoperable_path(&canonical.to_string_lossy()));
    }
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn torrent_file_manifest_rejects_traversal_and_excludes_incomplete_media() {
        assert!(manifest(b"d4:infod6:lengthi4e4:name9:../bad.mkee").is_err());
        let files = manifest(b"d4:infod6:lengthi4e4:name8:test.wavee").unwrap();
        let root = std::env::temp_dir().join(format!("studio-content-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("test.wav"), b"x").unwrap();
        assert!(verified(&root, &files).unwrap().is_empty());
        std::fs::write(root.join("test.wav"), b"abcd").unwrap();
        assert_eq!(verified(&root, &files).unwrap().len(), 1);
        std::fs::remove_file(root.join("test.wav")).unwrap();
        std::fs::remove_dir(root).unwrap();
    }
}
