//! An OS lock proves runtime ownership without PID reuse or heartbeat timeouts.
use std::{
    fs::{File, OpenOptions, TryLockError},
    io,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum OwnerState {
    Alive,
    Dead,
    Unknown,
}

pub(super) struct RuntimeLease {
    directory: PathBuf,
    // Keep the file and its exclusive lock alive for the complete SQLite actor lifetime.
    _file: File,
}

impl RuntimeLease {
    pub fn acquire(database: &Path, runtime_id: &str) -> io::Result<Self> {
        let directory = database.with_extension("runtime-leases");
        std::fs::create_dir_all(&directory)?;
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(directory.join(format!("{runtime_id}.lease")))?;
        file.try_lock().map_err(io::Error::from)?;
        Ok(Self {
            directory,
            _file: file,
        })
    }

    pub fn owner_state(&self, runtime_id: &str) -> io::Result<OwnerState> {
        // Database text must never become an arbitrary filesystem path.
        if runtime_id.is_empty()
            || runtime_id.len() > 128
            || !runtime_id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
        {
            return Ok(OwnerState::Unknown);
        }
        let file = match OpenOptions::new()
            .read(true)
            .write(true)
            .open(self.directory.join(format!("{runtime_id}.lease")))
        {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Ok(OwnerState::Unknown)
            }
            Err(error) => return Err(error),
        };
        match file.try_lock() {
            Ok(()) => Ok(OwnerState::Dead), // probe handle drops and releases its lock
            Err(TryLockError::WouldBlock) => Ok(OwnerState::Alive),
            Err(TryLockError::Error(error)) => Err(error),
        }
    }
}

// Lease files remain as zero-byte tombstones: absence must not be mistaken for death
// when an older app version has not implemented leases.

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, Read, Write};
    use std::process::{Command, Stdio};

    #[test]
    #[ignore = "subprocess helper for the OS runtime lease test"]
    fn lease_child_hold() {
        let Ok(path) = std::env::var("DTS_LEASE_TEST_DATABASE") else {
            return;
        };
        let _lease = RuntimeLease::acquire(Path::new(&path), "child_runtime").unwrap();
        println!("LEASE_READY");
        std::io::stdout().flush().unwrap();
        let _ = std::io::stdin().read(&mut [0u8]);
    }

    #[test]
    fn actual_process_lock_survives_idle_and_is_released_after_termination() {
        let mut random = [0u8; 12];
        getrandom::fill(&mut random).unwrap();
        let suffix = random
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let directory = std::env::temp_dir().join(format!("dts-process-lease-{suffix}"));
        std::fs::create_dir(&directory).unwrap();
        let database = directory.join("library.sqlite3");
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "project_library::runtime_lease::tests::lease_child_hold",
                "--ignored",
                "--nocapture",
            ])
            .env("DTS_LEASE_TEST_DATABASE", &database)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        let mut child = command.spawn().unwrap();
        let reader = std::io::BufReader::new(child.stdout.take().unwrap());
        let ready = reader
            .lines()
            .map_while(Result::ok)
            .any(|line| line.contains("LEASE_READY"));
        if !ready {
            let _ = child.kill();
            let _ = child.wait();
            panic!("lease helper exited before acquiring its lock");
        }
        let observer = RuntimeLease::acquire(&database, "observer_runtime").unwrap();
        let alive = observer.owner_state("child_runtime").unwrap();
        child.kill().unwrap();
        child.wait().unwrap();
        assert_eq!(alive, OwnerState::Alive);
        assert_eq!(
            observer.owner_state("child_runtime").unwrap(),
            OwnerState::Dead
        );
        assert_eq!(
            observer.owner_state("legacy_runtime").unwrap(),
            OwnerState::Unknown
        );
        drop(observer);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
