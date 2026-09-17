//! Reject implicit network/device paths before filesystem metadata can trigger authentication.
pub(crate) fn ensure_local_media_path(raw: &str) -> Result<(), String> {
    let normalized = raw.trim().replace('/', "\\");
    let path = normalized.strip_prefix(r"\\?\").unwrap_or(&normalized);
    let extended_drive = normalized.starts_with(r"\\?\")
        && path.as_bytes().get(1) == Some(&b':')
        && path.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)
        && path.as_bytes().get(2) == Some(&b'\\');
    let extended_volume = normalized.starts_with(r"\\?\")
        && path
            .get(..7)
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case("Volume{"))
        && path.get(7..43).is_some_and(|guid| {
            guid.bytes().enumerate().all(|(i, c)| {
                if [8, 13, 18, 23].contains(&i) {
                    c == b'-'
                } else {
                    c.is_ascii_hexdigit()
                }
            })
        })
        && path.get(43..45) == Some("}\\");
    if raw.contains('\0')
        || (normalized.starts_with(r"\\") && !extended_drive && !extended_volume)
        || normalized.starts_with(r"\??\")
        || raw.contains("://")
    {
        return Err(
            "媒体引用不能隐式访问网络共享或设备路径；请先保存为本地文件，或使用 WebDAV/Emby 连接。"
                .into(),
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_network_paths_without_filesystem_access() {
        for path in [
            r"\\untrusted.example.test\share\video.mkv",
            "//untrusted.example.test/share/video.mkv",
            r"\\?\UNC\untrusted.example.test\share\video.mkv",
            r"\\.\pipe\media",
            r"\??\UNC\host\media",
            "file://host/media",
        ] {
            assert!(ensure_local_media_path(path).is_err(), "{path}");
        }
        for path in [
            r"C:\media\film.mkv",
            r"\\?\C:\media\film.mkv",
            r"\\?\Volume{12345678-1234-1234-1234-123456789abc}\film.mkv",
            "/tmp/film.mkv",
        ] {
            assert!(ensure_local_media_path(path).is_ok(), "{path}");
        }
    }
}
