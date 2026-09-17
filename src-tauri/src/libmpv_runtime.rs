//! Bounded runtime discovery. Never search arbitrary application trees or the working directory.
use std::path::{Path, PathBuf};

const LIBRARY_NAMES: [&str; 4] = ["mpv-2.dll", "libmpv-2.dll", "mpv-1.dll", "libmpv-1.dll"];

pub(super) fn resolve_library_path(configured: &str) -> Result<PathBuf, String> {
    let configured = configured.trim();
    if !configured.is_empty() {
        let path = Path::new(configured);
        if !path.is_absolute() || !path.exists() {
            return Err("libmpv 配置路径不存在或不是绝对路径；请选择运行库目录或 DLL。".into());
        }
        if path.is_file()
            && path
                .extension()
                .is_some_and(|value| value.eq_ignore_ascii_case("dll"))
        {
            return canonicalize(path);
        }
        let directory = if path.is_dir() {
            path
        } else {
            path.parent().unwrap_or(path)
        };
        return find_in_directory(directory).ok_or_else(||
            "所选目录没有 libmpv DLL；只有 mpv.exe 的播放器包不能用于应用内播放，请选择 mpv-dev 运行库。".into());
    }
    let directories = discovery_directories();
    directories.iter().find_map(|path| find_in_directory(path)).ok_or_else(||
        "未发现 libmpv 运行库。请选择包含 mpv-2.dll 或 libmpv-2.dll 的 mpv-dev 目录；普通 mpv.exe 不足以启用应用内播放。".into())
}

fn canonicalize(path: &Path) -> Result<PathBuf, String> {
    path.canonicalize()
        .map_err(|error| format!("无法解析 libmpv 路径：{error}"))
}

fn find_in_directory(directory: &Path) -> Option<PathBuf> {
    LIBRARY_NAMES.iter().find_map(|name| {
        let path = directory.join(name);
        path.is_file().then(|| canonicalize(&path).ok()).flatten()
    })
}

fn discovery_directories() -> Vec<PathBuf> {
    let mut directories = Vec::new();
    if let Ok(executable) = std::env::current_exe() {
        if let Some(parent) = executable.parent() {
            directories.extend([
                parent.join("runtime/mpv"),
                parent.join("mpv"),
                parent.to_path_buf(),
            ]);
        }
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let local = PathBuf::from(local);
        directories.extend([
            local.join("studio.danmaku.timeline/runtime/mpv"),
            local.join("Programs/mpv"),
            local.join("mpv"),
        ]);
    }
    if let Some(profile) = std::env::var_os("USERPROFILE") {
        let profile = PathBuf::from(profile);
        directories.extend([
            profile.join("scoop/apps/mpv/current"),
            profile.join("scoop/apps/mpv.net/current"),
        ]);
    }
    if let Some(path) = std::env::var_os("PATH") {
        directories.extend(
            std::env::split_paths(&path)
                .filter(|path| path.is_absolute())
                .take(128),
        );
    }
    directories.dedup();
    directories
}

#[cfg(windows)]
pub(super) fn verify_architecture(path: &Path) -> Result<(), String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file =
        std::fs::File::open(path).map_err(|error| format!("无法读取 libmpv：{error}"))?;
    let mut dos = [0u8; 64];
    file.read_exact(&mut dos)
        .map_err(|_| "libmpv DLL 的 PE 文件头不完整。")?;
    if &dos[..2] != b"MZ" {
        return Err("选择的文件不是 Windows DLL。".into());
    }
    let offset = u32::from_le_bytes(dos[60..64].try_into().unwrap()) as u64;
    if offset > 16 * 1024 * 1024 {
        return Err("libmpv DLL 的 PE 文件头无效。".into());
    }
    file.seek(SeekFrom::Start(offset))
        .map_err(|error| error.to_string())?;
    let mut pe = [0u8; 6];
    file.read_exact(&mut pe)
        .map_err(|_| "libmpv DLL 的 PE 文件头不完整。")?;
    let machine = u16::from_le_bytes([pe[4], pe[5]]);
    let expected = if cfg!(target_arch = "aarch64") {
        0xaa64
    } else if cfg!(target_arch = "x86") {
        0x14c
    } else {
        0x8664
    };
    if &pe[..4] != b"PE\0\0" || machine != expected {
        return Err(format!(
            "libmpv 架构不匹配；当前应用需要 {} 运行库。",
            std::env::consts::ARCH
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_missing_path_never_falls_back_to_unrelated_runtime() {
        assert!(resolve_library_path("not-an-absolute-runtime")
            .unwrap_err()
            .contains("配置路径"));
    }

    #[test]
    fn executable_without_dll_is_not_a_runtime() {
        let root = std::env::temp_dir().join(format!("dts-runtime-test-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let executable = root.join("mpv.exe");
        std::fs::write(&executable, b"test").unwrap();
        assert!(resolve_library_path(executable.to_str().unwrap())
            .unwrap_err()
            .contains("mpv-dev"));
        let library = root.join("libmpv-2.dll");
        std::fs::write(&library, b"test").unwrap();
        assert_eq!(
            resolve_library_path(root.to_str().unwrap()).unwrap(),
            library.canonicalize().unwrap()
        );
        std::fs::remove_file(executable).unwrap();
        std::fs::remove_file(library).unwrap();
        std::fs::remove_dir(root).unwrap();
    }
}
