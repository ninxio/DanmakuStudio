//! Resolve magnet metadata using Motrix's installed aria2, then use MDXP's torrent path.
//! This avoids beta.36's broken automatically adopted BT child path. No video bytes are fetched here.
use super::*;
use crate::process_supervision::{SupervisedCommand, SupervisedOutputLimits};
use bendy::decoding::Decoder;

pub(super) fn info_hash(uri: &str) -> Result<String, String> {
    let url = magnet(uri)?;
    let value = url
        .query_pairs()
        .find(|(k, v)| k == "xt" && v.starts_with("urn:btih:"))
        .map(|(_, v)| v[9..].to_owned())
        .ok_or("Motrix 当前需要带 BTIH 的磁力链接。")?;
    if value.len() == 40 {
        return Ok(value.to_ascii_lowercase());
    }
    let mut accumulator = 0u32;
    let mut bits = 0;
    let mut bytes = Vec::with_capacity(20);
    for c in value.bytes().map(|c| c.to_ascii_uppercase()) {
        let number = match c {
            b'A'..=b'Z' => c - b'A',
            b'2'..=b'7' => c - b'2' + 26,
            _ => return Err("BTIH 编码无效。".into()),
        };
        accumulator = (accumulator << 5) | u32::from(number);
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            bytes.push((accumulator >> bits) as u8);
        }
    }
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

fn verify(bytes: &[u8], expected: &str) -> Result<(), String> {
    let mut decoder = Decoder::new(bytes).with_max_depth(32);
    let mut root = decoder
        .next_object()
        .map_err(|_| "种子格式无效。")?
        .ok_or("种子文件为空。")?
        .try_into_dictionary()
        .map_err(|_| "种子不是字典。")?;
    let mut hash = None;
    while let Some((key, value)) = root.next_pair().map_err(|_| "种子内容无效。")? {
        if key == b"info" {
            let raw = value
                .try_into_dictionary()
                .map_err(|_| "种子缺少 info 字典。")?
                .into_raw()
                .map_err(|_| "种子 info 无效。")?;
            hash = Some(ring::digest::digest(
                &ring::digest::SHA1_FOR_LEGACY_USE_ONLY,
                raw,
            ));
        }
    }
    drop(root);
    if decoder
        .next_object()
        .map_err(|_| "种子尾部无效。")?
        .is_some()
    {
        return Err("种子包含多余内容。".into());
    }
    let hash = hash.ok_or("种子缺少内容身份。")?;
    let actual: String = hash.as_ref().iter().map(|b| format!("{b:02x}")).collect();
    if actual != expected {
        return Err("种子内容与所选磁力不一致，未提交下载。".into());
    }
    Ok(())
}

fn read_verified(path: &Path, hash: &str) -> Result<Option<Vec<u8>>, String> {
    let meta = match std::fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("种子缓存无法读取。".into()),
    };
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > 4 * 1024 * 1024 {
        return Err("种子缓存大小或类型无效。".into());
    }
    let bytes = std::fs::read(path).map_err(|_| "种子缓存无法读取。")?;
    verify(&bytes, hash)?;
    Ok(Some(bytes))
}

fn engine() -> Result<PathBuf, String> {
    #[cfg(windows)]
    {
        let root = std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .ok_or("无法定位 Motrix。")?;
        let candidates = [
            root.join("Programs/Motrix/resources/extra/win32/x64/aria2c.exe"),
            PathBuf::from(r"C:\Program Files\Motrix\resources\extra\win32\x64\aria2c.exe"),
        ];
        candidates
            .into_iter()
            .find(|p| p.is_file())
            .ok_or("未找到 Motrix 的 aria2 引擎；请安装 Motrix 2，或使用已下载的原片。".into())
    }
    #[cfg(not(windows))]
    {
        Err("当前自动获取磁力元数据支持 Windows Motrix 2。".into())
    }
}

pub(super) async fn resolve(uri: String, cache: PathBuf) -> Result<Vec<u8>, String> {
    tokio::task::spawn_blocking(move || {
        let hash = info_hash(&uri)?;
        let folder = cache.join(&hash);
        std::fs::create_dir_all(&folder).map_err(|_| "无法创建种子缓存目录。")?;
        let path = folder.join(format!("{hash}.torrent"));
        if let Some(bytes) = read_verified(&path, &hash)? {
            return Ok(bytes);
        }
        let mut command = SupervisedCommand::new(engine()?);
        command
            .current_dir(&folder)
            .args([
                "--no-conf=true",
                "--bt-metadata-only=true",
                "--bt-save-metadata=true",
                "--follow-torrent=false",
                "--seed-time=0",
                "--enable-rpc=false",
                "--disable-ipv6=true",
                "--summary-interval=0",
                "--console-log-level=error",
                "--listen-port=49160-49260",
                "--dht-listen-port=49261-49360",
                "--auto-save-interval=0",
                "--max-tries=2",
                "--timeout=15",
                "--connect-timeout=10",
            ])
            .arg(format!(
                "--dir={}",
                task_state::interoperable_path(&folder.to_string_lossy())
            ))
            .arg(format!(
                "--dht-file-path={}",
                folder.join("dht.dat").to_string_lossy()
            ))
            .arg("--")
            .arg(uri);
        let output = command
            .output(
                SupervisedOutputLimits {
                    execution_timeout: Duration::from_secs(90),
                    output_drain_timeout: Duration::from_secs(2),
                    termination_timeout: Duration::from_secs(2),
                    poll_interval: Duration::from_millis(25),
                    stdout_hard_limit: 64 * 1024,
                    stderr_hard_limit: 64 * 1024,
                },
                || false,
            )
            .map_err(|_| "获取种子信息超时或中断，请检查资源做种情况后重试。")?;
        if !output.status.success() {
            return Err("未能获取种子信息，请检查磁力或稍后重试。".into());
        }
        read_verified(&path, &hash)?.ok_or("未获取到完整种子信息，未开始视频下载。".into())
    })
    .await
    .map_err(|_| "种子信息任务中断。".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn metadata_identity_is_verified_from_original_bencoded_bytes() {
        let raw_info = b"d6:lengthi4e4:name8:test.wave";
        let raw = b"d4:infod6:lengthi4e4:name8:test.wavee";
        let hash: String = ring::digest::digest(&ring::digest::SHA1_FOR_LEGACY_USE_ONLY, raw_info)
            .as_ref()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        assert!(verify(raw, &hash).is_ok());
        assert!(verify(raw, &"0".repeat(40)).is_err());
        assert!(verify(b"not a torrent", &hash).is_err());
        assert_eq!(
            info_hash("magnet:?xt=urn:btih:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA").unwrap(),
            "0".repeat(40)
        );
    }
}
