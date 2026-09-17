use std::{
    fs::File,
    path::{Path, PathBuf},
    sync::Arc,
};

/// Identity of one physical file object for the lifetime of a pinned handle.
///
/// On current Windows versions the 128-bit `FileIdInfo` identity is preferred. The legacy
/// volume-serial/file-index form is retained only as a compatibility fallback for file systems
/// that do not implement `FileIdInfo`. A legacy file index must not be persisted across runs: a
/// file system may reuse it after the last handle is closed. `PinnedPhysicalFile` keeps the handle
/// open, so reuse cannot occur during one batch.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum PhysicalFileObjectKey {
    #[cfg(windows)]
    WindowsFileId128 {
        volume_serial_number: u64,
        file_id: [u8; 16],
    },
    #[cfg(windows)]
    WindowsLegacyFileIndex64 {
        volume_serial_number: u32,
        file_index: u64,
    },
    #[cfg(not(windows))]
    Unsupported,
}

/// A read-only lease that pins one logical path to a stable Windows file object.
///
/// `open` returns an `Arc`, allowing every logical media binding that resolves to the same file
/// object to share one physical lease without cloning or transferring the underlying handle.
#[derive(Debug)]
pub(crate) struct PinnedPhysicalFile {
    // Retained for local diagnostics and tests; user-facing errors deliberately never disclose it.
    #[allow(dead_code)]
    logical_path: PathBuf,
    handle_final_path: PathBuf,
    object_key: PhysicalFileObjectKey,
    size_bytes: u64,
    last_write_time_ticks: u64,
    #[cfg(windows)]
    lease: File,
}

impl PinnedPhysicalFile {
    #[cfg(windows)]
    pub(crate) fn open(logical_path: &Path) -> Result<Arc<Self>, String> {
        crate::local_media_path::ensure_local_media_path(&logical_path.to_string_lossy())?;
        let lease = open_windows_read_pin(logical_path)?;
        if !lease
            .metadata()
            .map_err(|_| {
                "blocked:physical-file-pin：无法读取固定媒体的文件类型；路径已隐藏。".to_string()
            })?
            .is_file()
        {
            return Err(
                "blocked:physical-file-pin：物理媒体 lease 只接受本地普通文件。".to_string(),
            );
        }

        let snapshot = query_windows_file_snapshot(&lease, None)?;
        let handle_final_path = windows_handle_local_final_path(&lease)?;
        let pinned = Arc::new(Self {
            logical_path: logical_path.to_path_buf(),
            handle_final_path,
            object_key: snapshot.object_key,
            size_bytes: snapshot.size_bytes,
            last_write_time_ticks: snapshot.last_write_time_ticks,
            lease,
        });
        pinned.verify_handle_and_path()?;
        Ok(pinned)
    }

    #[cfg(not(windows))]
    pub(crate) fn open(_logical_path: &Path) -> Result<Arc<Self>, String> {
        Err("unsupported:physical-file-pin：物理文件对象 pin 当前只支持 Windows。".to_string())
    }

    #[cfg(test)]
    pub(crate) fn logical_path(&self) -> &Path {
        &self.logical_path
    }

    pub(crate) fn handle_final_path(&self) -> &Path {
        &self.handle_final_path
    }

    pub(crate) fn object_key(&self) -> PhysicalFileObjectKey {
        self.object_key
    }

    #[cfg(test)]
    pub(crate) fn size_bytes(&self) -> u64 {
        self.size_bytes
    }

    #[cfg(test)]
    pub(crate) fn last_write_time_ticks(&self) -> u64 {
        self.last_write_time_ticks
    }

    /// Verifies both the retained handle and a fresh open of the handle-derived final path.
    ///
    /// The retained handle was opened with `FILE_SHARE_READ` only. Normal Windows writers,
    /// deleters and path replacement therefore remain blocked for the lifetime of this value.
    /// This check additionally detects unsupported or out-of-band object/metadata changes and
    /// proves that tools reopening `handle_final_path` still reach the pinned object.
    #[cfg(windows)]
    pub(crate) fn verify_handle_and_path(&self) -> Result<(), String> {
        let expected = WindowsFileSnapshot {
            object_key: self.object_key,
            size_bytes: self.size_bytes,
            last_write_time_ticks: self.last_write_time_ticks,
        };
        let handle_snapshot = query_windows_file_snapshot(&self.lease, Some(&self.object_key))?;
        if handle_snapshot != expected {
            return Err(
                "blocked:physical-file-changed：固定媒体句柄的文件对象或元数据已变化。".to_string(),
            );
        }

        let reopened = open_windows_read_pin(&self.handle_final_path)?;
        let path_snapshot = query_windows_file_snapshot(&reopened, Some(&self.object_key))?;
        let reopened_final_path = windows_handle_local_final_path(&reopened)?;
        if path_snapshot != expected || reopened_final_path != self.handle_final_path {
            return Err(
                "blocked:physical-file-changed：固定媒体最终路径不再指向原文件对象。".to_string(),
            );
        }
        Ok(())
    }

    #[cfg(not(windows))]
    pub(crate) fn verify_handle_and_path(&self) -> Result<(), String> {
        Err("unsupported:physical-file-pin：物理文件对象复核当前只支持 Windows。".to_string())
    }
}

#[cfg(windows)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct WindowsFileSnapshot {
    object_key: PhysicalFileObjectKey,
    size_bytes: u64,
    last_write_time_ticks: u64,
}

#[cfg(windows)]
fn open_windows_read_pin(path: &Path) -> Result<File, String> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ;

    std::fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .open(path)
        .map_err(|_| {
            "blocked:physical-file-pin：无法取得禁止写入、删除和替换的媒体只读 pin；路径已隐藏。"
                .to_string()
        })
}

#[cfg(windows)]
fn query_windows_file_snapshot(
    file: &File,
    expected_key: Option<&PhysicalFileObjectKey>,
) -> Result<WindowsFileSnapshot, String> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };

    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: `file` owns a valid handle and `information` is the exact writable structure
    // required by GetFileInformationByHandle.
    let ok = unsafe { GetFileInformationByHandle(file.as_raw_handle().cast(), &mut information) };
    if ok == 0 {
        return Err("blocked:physical-file-identity：无法读取固定媒体的句柄元数据。".to_string());
    }

    let legacy_key = PhysicalFileObjectKey::WindowsLegacyFileIndex64 {
        volume_serial_number: information.dwVolumeSerialNumber,
        file_index: (u64::from(information.nFileIndexHigh) << 32)
            | u64::from(information.nFileIndexLow),
    };
    let object_key = match expected_key {
        Some(PhysicalFileObjectKey::WindowsFileId128 { .. }) => {
            try_query_windows_file_id_128(file)?.ok_or_else(|| {
                "blocked:physical-file-identity：固定媒体不再提供预期的 128 位文件对象身份。"
                    .to_string()
            })?
        }
        Some(PhysicalFileObjectKey::WindowsLegacyFileIndex64 { .. }) => legacy_key,
        None => try_query_windows_file_id_128(file)?.unwrap_or(legacy_key),
    };

    Ok(WindowsFileSnapshot {
        object_key,
        size_bytes: (u64::from(information.nFileSizeHigh) << 32)
            | u64::from(information.nFileSizeLow),
        last_write_time_ticks: (u64::from(information.ftLastWriteTime.dwHighDateTime) << 32)
            | u64::from(information.ftLastWriteTime.dwLowDateTime),
    })
}

#[cfg(windows)]
fn try_query_windows_file_id_128(file: &File) -> Result<Option<PhysicalFileObjectKey>, String> {
    use std::{mem::size_of, os::windows::io::AsRawHandle};
    use windows_sys::Win32::Storage::FileSystem::{
        FileIdInfo, GetFileInformationByHandleEx, FILE_ID_INFO,
    };

    let mut information = FILE_ID_INFO::default();
    // SAFETY: `file` owns a valid handle and `information` is writable for the exact byte count
    // supplied. A false return is treated as an unsupported-file-system compatibility signal;
    // the caller falls back to the legacy identity while retaining the lease.
    let ok = unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle().cast(),
            FileIdInfo,
            (&mut information as *mut FILE_ID_INFO).cast(),
            size_of::<FILE_ID_INFO>() as u32,
        )
    };
    if ok == 0 {
        return Ok(None);
    }
    Ok(Some(PhysicalFileObjectKey::WindowsFileId128 {
        volume_serial_number: information.VolumeSerialNumber,
        file_id: information.FileId.Identifier,
    }))
}

#[cfg(windows)]
fn windows_handle_local_final_path(file: &File) -> Result<PathBuf, String> {
    use std::{ffi::OsString, os::windows::ffi::OsStringExt, os::windows::io::AsRawHandle};
    use windows_sys::Win32::Storage::FileSystem::{
        GetFinalPathNameByHandleW, FILE_NAME_NORMALIZED, VOLUME_NAME_GUID,
    };

    let mut buffer = vec![0_u16; 32_768];
    // SAFETY: `file` owns a valid handle and `buffer` is writable for the supplied length.
    let length = unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle().cast(),
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            FILE_NAME_NORMALIZED | VOLUME_NAME_GUID,
        )
    } as usize;
    if length == 0 || length >= buffer.len() {
        return Err(
            "unsupported:physical-file-path：固定媒体句柄无法解析本地卷 GUID 最终路径。"
                .to_string(),
        );
    }
    buffer.truncate(length);
    let raw = OsString::from_wide(&buffer).to_string_lossy().into_owned();
    if !is_local_volume_guid_path(&raw) {
        return Err(
            "unsupported:physical-file-path：固定媒体不位于可复核的 Windows 本地卷。".to_string(),
        );
    }
    Ok(PathBuf::from(raw))
}

#[cfg(windows)]
fn is_local_volume_guid_path(path: &str) -> bool {
    const PREFIX: &str = r"\\?\Volume{";
    let Some(prefix) = path
        .get(..PREFIX.len())
        .filter(|candidate| candidate.eq_ignore_ascii_case(PREFIX))
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

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::{
        fs::{self, OpenOptions},
        io::Write,
        sync::{atomic::AtomicU64, atomic::Ordering, Mutex},
        time::{SystemTime, UNIX_EPOCH},
    };

    static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(1);
    static FILE_SYSTEM_TEST_LOCK: Mutex<()> = Mutex::new(());

    struct TempFixture {
        root: PathBuf,
    }

    impl TempFixture {
        fn new(label: &str) -> Self {
            let sequence = TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let epoch_nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("test clock")
                .as_nanos();
            let root = std::env::temp_dir().join(format!(
                "c137-physical-file-{label}-{}-{epoch_nanos}-{sequence}",
                std::process::id()
            ));
            fs::create_dir(&root).expect("create physical-file fixture directory");
            Self { root }
        }

        fn write(&self, name: &str, bytes: &[u8]) -> PathBuf {
            let path = self.root.join(name);
            fs::write(&path, bytes).expect("write physical-file fixture");
            path
        }
    }

    impl Drop for TempFixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    struct CurrentDirectoryGuard {
        previous: PathBuf,
    }

    impl CurrentDirectoryGuard {
        fn change_to(path: &Path) -> Self {
            let previous = std::env::current_dir().expect("read current directory");
            std::env::set_current_dir(path).expect("change current directory");
            Self { previous }
        }
    }

    impl Drop for CurrentDirectoryGuard {
        fn drop(&mut self) {
            std::env::set_current_dir(&self.previous).expect("restore current directory");
        }
    }

    #[test]
    fn same_relative_absolute_and_case_aliases_resolve_to_one_object_key() {
        let _lock = FILE_SYSTEM_TEST_LOCK.lock().expect("filesystem test lock");
        let fixture = TempFixture::new("aliases");
        let absolute_path = fixture.write("EpisodeCase.MKV", b"same physical media");
        let first = PinnedPhysicalFile::open(&absolute_path).expect("open absolute pin");
        let same_path = PinnedPhysicalFile::open(&absolute_path).expect("open same path pin");
        assert_eq!(first.object_key(), same_path.object_key());
        assert_eq!(first.size_bytes(), b"same physical media".len() as u64);
        assert!(first.last_write_time_ticks() > 0);
        first.verify_handle_and_path().expect("verify first pin");

        let _cwd = CurrentDirectoryGuard::change_to(&fixture.root);
        let relative =
            PinnedPhysicalFile::open(Path::new("EpisodeCase.MKV")).expect("open relative pin");
        assert_eq!(first.object_key(), relative.object_key());
        assert_eq!(relative.logical_path(), Path::new("EpisodeCase.MKV"));
        assert_eq!(first.handle_final_path(), relative.handle_final_path());

        let case_alias_path = fixture.root.join("episodecase.mkv");
        if let Ok(case_alias) = PinnedPhysicalFile::open(&case_alias_path) {
            assert_eq!(first.object_key(), case_alias.object_key());
        }
    }

    #[test]
    fn ntfs_hard_link_aliases_share_a_key_but_an_independent_copy_does_not() {
        let _lock = FILE_SYSTEM_TEST_LOCK.lock().expect("filesystem test lock");
        let fixture = TempFixture::new("hard-link");
        let original_path = fixture.write("original.mkv", b"identical container bytes");
        let hard_link_path = fixture.root.join("hard-link.mkv");
        fs::hard_link(&original_path, &hard_link_path).expect("create NTFS hard link");
        let copied_path = fixture.root.join("copy.mkv");
        fs::copy(&original_path, &copied_path).expect("create independent copy");

        let original = PinnedPhysicalFile::open(&original_path).expect("open original pin");
        let hard_link = PinnedPhysicalFile::open(&hard_link_path).expect("open hard-link pin");
        let copy = PinnedPhysicalFile::open(&copied_path).expect("open copied-file pin");
        assert_eq!(original.object_key(), hard_link.object_key());
        assert_ne!(original.object_key(), copy.object_key());
    }

    #[test]
    fn shared_pin_lifetime_blocks_write_delete_and_replacement_until_last_arc_drops() {
        let _lock = FILE_SYSTEM_TEST_LOCK.lock().expect("filesystem test lock");
        let fixture = TempFixture::new("lease");
        let path = fixture.write("leased.mkv", b"stable media");
        let first = PinnedPhysicalFile::open(&path).expect("open shared pin");
        let last = Arc::clone(&first);
        drop(first);

        assert!(OpenOptions::new().write(true).open(&path).is_err());
        assert!(fs::remove_file(&path).is_err());
        last.verify_handle_and_path().expect("verify shared pin");

        drop(last);
        let mut writable = OpenOptions::new()
            .write(true)
            .open(&path)
            .expect("write must be available after final Arc drops");
        writable
            .write_all(b"updated media")
            .expect("write after lease release");
        drop(writable);
        fs::remove_file(&path).expect("delete after lease release");
    }
}

#[cfg(all(test, not(windows)))]
mod non_windows_tests {
    use super::*;

    #[test]
    fn physical_file_pin_is_explicitly_unsupported() {
        let error = PinnedPhysicalFile::open(Path::new("media.mkv"))
            .expect_err("non-Windows physical-file pin must fail closed");
        assert!(error.starts_with("unsupported:physical-file-pin"));
    }
}
