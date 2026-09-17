use std::path::{Path, PathBuf};

#[cfg(windows)]
use crate::process_supervision::resolve_supervised_executable;
#[cfg(windows)]
use sha2::{Digest, Sha256};
#[cfg(windows)]
use std::{
    env,
    ffi::{OsStr, OsString},
    fs::{File, OpenOptions},
    os::windows::{
        ffi::OsStringExt,
        fs::{FileExt, OpenOptionsExt},
        io::AsRawHandle,
    },
};

const MEDIA_TOOLCHAIN_CACHE_IDENTITY_VERSION: &str = "media-toolchain-sha256-v1";
#[cfg(not(windows))]
const MEDIA_TOOLCHAIN_UNSUPPORTED: &str =
    "unsupported：固定媒体工具链当前只支持 Windows；尚未启动任何媒体工具。";

#[cfg(windows)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct WindowsMediaToolFileIdentity {
    volume_serial_number: u32,
    file_index: u64,
    file_size: u64,
    last_write_time: u64,
}

/// One executable resolved once and held open for the complete product operation.
///
/// On Windows, the open handle shares reads only. Consequently another process cannot write,
/// delete or replace the final executable while this value is alive. `launch_path` is obtained
/// from that handle in the local Volume-GUID namespace rather than from a mutable drive mapping.
#[derive(Debug)]
pub(crate) struct PinnedMediaTool {
    launch_path: PathBuf,
    binary_digest: String,
    #[cfg(windows)]
    file: File,
    #[cfg(windows)]
    identity: WindowsMediaToolFileIdentity,
}

impl PinnedMediaTool {
    pub(crate) fn launch_path(&self) -> &Path {
        &self.launch_path
    }

    /// Lowercase full-file SHA-256 without a path or host-specific identifier.
    pub(crate) fn binary_digest(&self) -> &str {
        &self.binary_digest
    }

    pub(crate) fn verify(&self) -> Result<(), String> {
        #[cfg(windows)]
        {
            verify_pinned_media_tool(self)
        }
        #[cfg(not(windows))]
        {
            Err(MEDIA_TOOLCHAIN_UNSUPPORTED.to_string())
        }
    }

    #[cfg(windows)]
    fn pin_request(request: &str) -> Result<Self, String> {
        let resolved = resolve_media_tool_request(OsStr::new(request))?;
        Self::pin_resolved(&resolved)
    }

    #[cfg(windows)]
    fn pin_resolved(resolved: &Path) -> Result<Self, String> {
        let file = open_media_tool_read_pin(resolved)?;
        let identity = windows_media_tool_file_identity(&file)?;
        let launch_path = windows_media_tool_final_path(&file)?;
        verify_windows_pe_executable(&file, &launch_path, identity.file_size)?;
        let binary_digest = sha256_pinned_media_tool(&file, identity.file_size)?;
        let pinned = Self {
            launch_path,
            binary_digest,
            file,
            identity,
        };
        pinned.verify()?;
        Ok(pinned)
    }
}

/// A single immutable FFmpeg/FFprobe identity shared by an entire task or native batch.
#[derive(Debug)]
pub(crate) struct PinnedMediaToolchain {
    ffmpeg: PinnedMediaTool,
    ffprobe: PinnedMediaTool,
    cache_identity_fragment: String,
}

impl PinnedMediaToolchain {
    /// Resolves and pins both tools without executing either one.
    ///
    /// A missing or blank FFmpeg request means the bare name `ffmpeg`. Bare names search only
    /// absolute PATH entries and never the current working directory. When FFprobe is omitted,
    /// it is derived as the sibling `ffprobe.exe` of the already-resolved FFmpeg executable.
    pub(crate) fn pin(
        ffmpeg_request: Option<&str>,
        ffprobe_request: Option<&str>,
    ) -> Result<Self, String> {
        #[cfg(windows)]
        {
            let ffmpeg_request = ffmpeg_request
                .map(str::trim)
                .filter(|request| !request.is_empty())
                .unwrap_or("ffmpeg");
            let ffmpeg = PinnedMediaTool::pin_request(ffmpeg_request)?;
            let ffprobe = if let Some(request) = ffprobe_request
                .map(str::trim)
                .filter(|request| !request.is_empty())
            {
                PinnedMediaTool::pin_request(request)?
            } else {
                let sibling = ffmpeg.launch_path().with_file_name("ffprobe.exe");
                let resolved = resolve_media_tool_request(sibling.as_os_str())?;
                PinnedMediaTool::pin_resolved(&resolved)?
            };
            let cache_identity_fragment = format!(
                "toolchain={MEDIA_TOOLCHAIN_CACHE_IDENTITY_VERSION}|ffmpeg=sha256:{}|ffprobe=sha256:{}",
                ffmpeg.binary_digest(),
                ffprobe.binary_digest()
            );
            let pinned = Self {
                ffmpeg,
                ffprobe,
                cache_identity_fragment,
            };
            pinned.verify_at_start()?;
            Ok(pinned)
        }
        #[cfg(not(windows))]
        {
            let _ = (ffmpeg_request, ffprobe_request);
            Err(MEDIA_TOOLCHAIN_UNSUPPORTED.to_string())
        }
    }

    pub(crate) fn ffmpeg(&self) -> &PinnedMediaTool {
        &self.ffmpeg
    }

    pub(crate) fn ffprobe(&self) -> &PinnedMediaTool {
        &self.ffprobe
    }

    /// Cache identity intentionally contains no executable path. Aliases of the same binaries
    /// therefore share artifacts, while changing either binary always changes the key fragment.
    pub(crate) fn cache_identity_fragment(&self) -> &str {
        &self.cache_identity_fragment
    }

    pub(crate) fn verify_at_start(&self) -> Result<(), String> {
        self.verify_for_phase("start")
    }

    pub(crate) fn verify_at_finalization(&self) -> Result<(), String> {
        self.verify_for_phase("final")
    }

    fn verify_for_phase(&self, phase: &str) -> Result<(), String> {
        self.ffmpeg.verify().map_err(|_| {
            format!(
                "blocked:media-toolchain-integrity：{phase} FFmpeg 固定身份复核失败；路径已隐藏。"
            )
        })?;
        self.ffprobe.verify().map_err(|_| {
            format!(
                "blocked:media-toolchain-integrity：{phase} FFprobe 固定身份复核失败；路径已隐藏。"
            )
        })
    }
}

#[cfg(windows)]
fn resolve_media_tool_request(request: &OsStr) -> Result<PathBuf, String> {
    resolve_media_tool_request_with_path(request, env::var_os("PATH").as_deref())
}

#[cfg(windows)]
fn resolve_media_tool_request_with_path(
    request: &OsStr,
    path_value: Option<&OsStr>,
) -> Result<PathBuf, String> {
    if request.is_empty() {
        return Err("blocked:media-toolchain-resolution：媒体工具请求为空。".to_string());
    }
    let requested = Path::new(request);
    if requested.is_absolute() {
        return resolve_supervised_executable(requested).map_err(|_| {
            "blocked:media-toolchain-resolution：无法安全解析绝对媒体工具路径；路径已隐藏。"
                .to_string()
        });
    }
    if requested.components().count() != 1 {
        return Err(
            "blocked:media-toolchain-resolution：带目录的媒体工具路径必须是绝对路径。".to_string(),
        );
    }

    let names = if requested.extension().is_some() {
        vec![requested.to_path_buf()]
    } else {
        vec![requested.with_extension("exe")]
    };
    let path_value = path_value.ok_or_else(|| {
        "blocked:media-toolchain-resolution：PATH 不可用，无法解析媒体工具。".to_string()
    })?;
    for directory in env::split_paths(path_value) {
        // Empty and relative PATH entries are aliases for a mutable current directory. Skipping
        // both is essential: a bare request must never be resolved through CWD implicitly.
        if directory.as_os_str().is_empty() || !directory.is_absolute() {
            continue;
        }
        for name in &names {
            let candidate = directory.join(name);
            if candidate.is_file() {
                return resolve_supervised_executable(&candidate).map_err(|_| {
                    "blocked:media-toolchain-resolution：PATH 中的媒体工具未通过安全解析；路径已隐藏。"
                        .to_string()
                });
            }
        }
    }
    Err("blocked:media-toolchain-resolution：PATH 中未找到媒体工具。".to_string())
}

#[cfg(windows)]
fn open_media_tool_read_pin(path: &Path) -> Result<File, String> {
    use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ;

    OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .open(path)
        .map_err(|_| {
            "blocked:media-toolchain-pin：无法取得禁止写入、删除和替换的媒体工具只读 pin；路径已隐藏。"
                .to_string()
        })
}

#[cfg(windows)]
fn windows_media_tool_file_identity(file: &File) -> Result<WindowsMediaToolFileIdentity, String> {
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };

    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: file owns a valid Windows handle and information is the exact writable structure
    // required by GetFileInformationByHandle.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle().cast(), &mut information) } == 0 {
        return Err("blocked:media-toolchain-pin：媒体工具固定句柄身份读取失败。".to_string());
    }
    Ok(WindowsMediaToolFileIdentity {
        volume_serial_number: information.dwVolumeSerialNumber,
        file_index: (u64::from(information.nFileIndexHigh) << 32)
            | u64::from(information.nFileIndexLow),
        file_size: (u64::from(information.nFileSizeHigh) << 32)
            | u64::from(information.nFileSizeLow),
        last_write_time: (u64::from(information.ftLastWriteTime.dwHighDateTime) << 32)
            | u64::from(information.ftLastWriteTime.dwLowDateTime),
    })
}

#[cfg(windows)]
fn windows_media_tool_final_path(file: &File) -> Result<PathBuf, String> {
    use windows_sys::Win32::Storage::FileSystem::{
        GetFinalPathNameByHandleW, FILE_NAME_NORMALIZED, VOLUME_NAME_GUID,
    };

    let mut buffer = vec![0_u16; 32_768];
    // SAFETY: file owns a valid handle and buffer is writable for the supplied capacity.
    let length = unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle().cast(),
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            FILE_NAME_NORMALIZED | VOLUME_NAME_GUID,
        )
    } as usize;
    if length == 0 || length >= buffer.len() {
        return Err("blocked:media-toolchain-pin：媒体工具不是可固定的本地卷文件。".to_string());
    }
    buffer.truncate(length);
    let path = OsString::from_wide(&buffer);
    if !is_local_volume_guid_path(&path.to_string_lossy()) {
        return Err(
            "blocked:media-toolchain-pin：媒体工具没有解析到规范本地卷 GUID 路径。".to_string(),
        );
    }
    Ok(PathBuf::from(path))
}

#[cfg(windows)]
fn is_local_volume_guid_path(path: &str) -> bool {
    const PREFIX: &str = r"\\?\Volume{";
    let Some(prefix) = path
        .get(..PREFIX.len())
        .filter(|value| value.eq_ignore_ascii_case(PREFIX))
    else {
        return false;
    };
    let Some(remainder) = path.get(prefix.len()..) else {
        return false;
    };
    let Some(close) = remainder.find(r"}\") else {
        return false;
    };
    let identifier = &remainder[..close];
    identifier.len() == 36
        && identifier.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

#[cfg(windows)]
fn verify_windows_pe_executable(
    file: &File,
    launch_path: &Path,
    file_size: u64,
) -> Result<(), String> {
    const DOS_HEADER_BYTES: usize = 64;
    const MAX_PE_HEADER_OFFSET: u64 = 16 * 1024 * 1024;

    if !launch_path
        .extension()
        .and_then(OsStr::to_str)
        .is_some_and(|extension| extension.eq_ignore_ascii_case("exe"))
        || file_size < DOS_HEADER_BYTES as u64 + 4
    {
        return Err(
            "blocked:media-toolchain-pin：固定媒体工具不是受支持的 Windows 可执行文件。"
                .to_string(),
        );
    }
    let mut dos_header = [0_u8; DOS_HEADER_BYTES];
    read_exact_pinned_file_at(file, &mut dos_header, 0)?;
    if &dos_header[..2] != b"MZ" {
        return Err("blocked:media-toolchain-pin：固定媒体工具缺少 Windows PE 标识。".to_string());
    }
    let pe_offset = u64::from(u32::from_le_bytes(
        dos_header[0x3c..0x40]
            .try_into()
            .expect("DOS header slice has a fixed length"),
    ));
    if pe_offset < DOS_HEADER_BYTES as u64
        || pe_offset > MAX_PE_HEADER_OFFSET
        || pe_offset.saturating_add(4) > file_size
    {
        return Err("blocked:media-toolchain-pin：固定媒体工具 PE header 偏移无效。".to_string());
    }
    let mut signature = [0_u8; 4];
    read_exact_pinned_file_at(file, &mut signature, pe_offset)?;
    if signature != *b"PE\0\0" {
        return Err("blocked:media-toolchain-pin：固定媒体工具 PE signature 无效。".to_string());
    }
    Ok(())
}

#[cfg(windows)]
fn read_exact_pinned_file_at(
    file: &File,
    mut buffer: &mut [u8],
    mut offset: u64,
) -> Result<(), String> {
    while !buffer.is_empty() {
        let read = file
            .seek_read(buffer, offset)
            .map_err(|_| "blocked:media-toolchain-pin：媒体工具固定句柄读取失败。".to_string())?;
        if read == 0 {
            return Err("blocked:media-toolchain-pin：媒体工具固定句柄提前到达 EOF。".to_string());
        }
        offset = offset
            .checked_add(read as u64)
            .ok_or_else(|| "blocked:media-toolchain-pin：媒体工具读取偏移溢出。".to_string())?;
        buffer = &mut buffer[read..];
    }
    Ok(())
}

#[cfg(windows)]
fn sha256_pinned_media_tool(file: &File, expected_size: u64) -> Result<String, String> {
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    let mut offset = 0_u64;
    while offset < expected_size {
        let remaining = expected_size - offset;
        let requested = usize::try_from(remaining.min(buffer.len() as u64))
            .map_err(|_| "blocked:media-toolchain-pin：媒体工具摘要窗口溢出。".to_string())?;
        let read = file
            .seek_read(&mut buffer[..requested], offset)
            .map_err(|_| {
                "blocked:media-toolchain-pin：媒体工具固定句柄摘要读取失败。".to_string()
            })?;
        if read == 0 {
            return Err("blocked:media-toolchain-pin：媒体工具摘要未覆盖完整文件。".to_string());
        }
        hasher.update(&buffer[..read]);
        offset = offset
            .checked_add(read as u64)
            .ok_or_else(|| "blocked:media-toolchain-pin：媒体工具摘要偏移溢出。".to_string())?;
    }
    if offset != expected_size {
        return Err("blocked:media-toolchain-pin：媒体工具摘要长度与句柄身份不一致。".to_string());
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

#[cfg(windows)]
fn verify_pinned_media_tool(pinned: &PinnedMediaTool) -> Result<(), String> {
    let handle_identity = windows_media_tool_file_identity(&pinned.file)?;
    let current_path_file = open_media_tool_read_pin(&pinned.launch_path)?;
    let current_path_identity = windows_media_tool_file_identity(&current_path_file)?;
    let current_final_path = windows_media_tool_final_path(&current_path_file)?;
    let current_digest = sha256_pinned_media_tool(&pinned.file, pinned.identity.file_size)?;
    if handle_identity != pinned.identity
        || current_path_identity != pinned.identity
        || current_final_path != pinned.launch_path
        || current_digest != pinned.binary_digest
    {
        return Err(
            "blocked:media-toolchain-integrity：媒体工具固定文件身份或完整摘要发生变化。"
                .to_string(),
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    mod windows {
        use super::*;
        use std::{
            fs,
            io::Write,
            process::Command,
            time::{SystemTime, UNIX_EPOCH},
        };

        struct FixtureDirectory(PathBuf);

        impl FixtureDirectory {
            fn new(label: &str) -> Self {
                let unique = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .expect("system clock after Unix epoch")
                    .as_nanos();
                let path = env::temp_dir().join(format!(
                    "danmaku-media-toolchain-{label}-{}-{unique}",
                    std::process::id()
                ));
                fs::create_dir(&path).expect("create media toolchain fixture directory");
                Self(path)
            }

            fn path(&self) -> &Path {
                &self.0
            }
        }

        impl Drop for FixtureDirectory {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }

        fn copy_test_executable(destination: &Path) {
            fs::copy(
                env::current_exe().expect("current test executable"),
                destination,
            )
            .expect("copy PE executable fixture");
        }

        #[test]
        fn same_binary_path_aliases_have_the_same_file_and_cache_identity() {
            let fixture = FixtureDirectory::new("alias");
            let original = fixture.path().join("ffmpeg.exe");
            let alias = fixture.path().join("ffmpeg-alias.exe");
            let ffprobe = fixture.path().join("ffprobe.exe");
            copy_test_executable(&original);
            fs::hard_link(&original, &alias).expect("create executable hard-link alias");
            copy_test_executable(&ffprobe);

            let original_chain = PinnedMediaToolchain::pin(
                Some(original.to_string_lossy().as_ref()),
                Some(ffprobe.to_string_lossy().as_ref()),
            )
            .unwrap();
            let alias_chain = PinnedMediaToolchain::pin(
                Some(alias.to_string_lossy().as_ref()),
                Some(ffprobe.to_string_lossy().as_ref()),
            )
            .unwrap();

            assert_eq!(
                original_chain.ffmpeg().identity,
                alias_chain.ffmpeg().identity
            );
            assert_eq!(
                original_chain.ffmpeg().binary_digest(),
                alias_chain.ffmpeg().binary_digest()
            );
            assert_eq!(
                original_chain.cache_identity_fragment(),
                alias_chain.cache_identity_fragment()
            );
            assert_ne!(
                original_chain.ffmpeg().launch_path(),
                alias_chain.ffmpeg().launch_path()
            );
        }

        #[test]
        fn binary_content_change_changes_digest_and_toolchain_cache_identity() {
            let fixture = FixtureDirectory::new("digest-change");
            let ffmpeg = fixture.path().join("ffmpeg.exe");
            let ffprobe = fixture.path().join("ffprobe.exe");
            copy_test_executable(&ffmpeg);
            copy_test_executable(&ffprobe);

            let first =
                PinnedMediaToolchain::pin(Some(ffmpeg.to_string_lossy().as_ref()), None).unwrap();
            let expected_probe = open_media_tool_read_pin(&ffprobe).unwrap();
            assert_eq!(
                first.ffprobe().identity,
                windows_media_tool_file_identity(&expected_probe).unwrap(),
                "implicit FFprobe must be pinned from the resolved Volume-GUID FFmpeg sibling"
            );
            let first_digest = first.ffmpeg().binary_digest().to_string();
            let first_cache_identity = first.cache_identity_fragment().to_string();
            assert!(!first_cache_identity.contains(fixture.path().to_string_lossy().as_ref()));
            drop(first);
            drop(expected_probe);

            OpenOptions::new()
                .append(true)
                .open(&ffmpeg)
                .expect("open unpinned executable")
                .write_all(b"content-change")
                .expect("mutate executable after pin drop");

            let second =
                PinnedMediaToolchain::pin(Some(ffmpeg.to_string_lossy().as_ref()), None).unwrap();
            assert_ne!(first_digest, second.ffmpeg().binary_digest());
            assert_ne!(first_cache_identity, second.cache_identity_fragment());
            second.ffprobe().verify().unwrap();
            second.verify_at_finalization().unwrap();
        }

        #[test]
        fn pin_lifetime_denies_write_and_delete_until_drop() {
            let fixture = FixtureDirectory::new("lifetime");
            let executable = fixture.path().join("ffmpeg.exe");
            copy_test_executable(&executable);
            let pinned = PinnedMediaTool::pin_request(&executable.to_string_lossy()).unwrap();

            assert!(OpenOptions::new().write(true).open(&executable).is_err());
            assert!(fs::remove_file(&executable).is_err());
            pinned.verify().unwrap();

            drop(pinned);
            assert!(OpenOptions::new().write(true).open(&executable).is_ok());
            fs::remove_file(executable).unwrap();
        }

        #[test]
        fn cwd_same_name_does_not_hijack_bare_path_resolution() {
            let fixture = FixtureDirectory::new("cwd-search");
            let cwd = fixture.path().join("cwd");
            let path_bin = fixture.path().join("path-bin");
            fs::create_dir(&cwd).unwrap();
            fs::create_dir(&path_bin).unwrap();
            copy_test_executable(&cwd.join("ffmpeg.exe"));
            let expected = path_bin.join("ffmpeg.exe");
            copy_test_executable(&expected);

            let status = Command::new(env::current_exe().unwrap())
                .args([
                    "--ignored",
                    "--exact",
                    "media_toolchain::tests::windows::cwd_path_resolution_helper",
                    "--nocapture",
                ])
                .current_dir(&cwd)
                .env("PATH", &path_bin)
                .env("C137_MEDIA_TOOLCHAIN_HELPER", "1")
                .env("C137_MEDIA_TOOLCHAIN_EXPECTED", &expected)
                .status()
                .expect("run isolated CWD/PATH resolver helper");

            assert!(status.success());
        }

        #[test]
        #[ignore = "isolated helper for the CWD/PATH media-tool resolution test"]
        fn cwd_path_resolution_helper() {
            if env::var_os("C137_MEDIA_TOOLCHAIN_HELPER").is_none() {
                return;
            }
            let expected = PathBuf::from(
                env::var_os("C137_MEDIA_TOOLCHAIN_EXPECTED").expect("expected helper tool path"),
            );
            let pinned = PinnedMediaTool::pin_request("ffmpeg").unwrap();
            let expected_file = open_media_tool_read_pin(&expected).unwrap();
            let expected_identity = windows_media_tool_file_identity(&expected_file).unwrap();
            assert_eq!(pinned.identity, expected_identity);
        }
    }

    #[cfg(not(windows))]
    #[test]
    fn non_windows_pin_fails_before_any_tool_execution() {
        let error = PinnedMediaToolchain::pin(None, None).unwrap_err();
        assert_eq!(error, MEDIA_TOOLCHAIN_UNSUPPORTED);
    }
}
