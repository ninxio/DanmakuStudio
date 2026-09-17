//! Bounded child-process execution for media tools.
//!
//! On Windows the child is created suspended and assigned to a private Job Object before its
//! first instruction runs.  Closing the job kills every descendant, which gives every error,
//! cancellation and timeout path a process-tree ownership root without ever terminating a raw
//! PID.  This lifecycle job is deliberately separate from the benchmark RSS sampler contract.

use std::{
    ffi::{OsStr, OsString},
    fmt,
    path::{Path, PathBuf},
    process::ExitStatus,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

static PROCESS_SUPERVISION_CLEANUP_FAULT: AtomicBool = AtomicBool::new(false);

pub(crate) fn process_supervision_cleanup_faulted() -> bool {
    PROCESS_SUPERVISION_CLEANUP_FAULT.load(Ordering::Acquire)
}

pub(crate) fn resolve_supervised_executable(
    program: impl AsRef<OsStr>,
) -> Result<PathBuf, SupervisedProcessError> {
    if process_supervision_cleanup_faulted() {
        return Err(SupervisedProcessError::new(
            SupervisedProcessErrorKind::Cleanup,
            "blocked:process-cleanup：先前的受监督进程未能可信收尾。",
        ));
    }
    platform::resolve_supervised_executable(program.as_ref())
}

#[cfg(test)]
pub(crate) fn mark_process_supervision_cleanup_fault_for_test() {
    PROCESS_SUPERVISION_CLEANUP_FAULT.store(true, Ordering::Release);
}

#[derive(Debug, Clone)]
pub(crate) struct SupervisedCommand {
    program: OsString,
    args: Vec<OsString>,
    current_dir: Option<PathBuf>,
}

impl SupervisedCommand {
    pub(crate) fn new(program: impl AsRef<OsStr>) -> Self {
        Self {
            program: program.as_ref().to_os_string(),
            args: Vec::new(),
            current_dir: None,
        }
    }

    pub(crate) fn arg(&mut self, arg: impl AsRef<OsStr>) -> &mut Self {
        self.args.push(arg.as_ref().to_os_string());
        self
    }

    pub(crate) fn args<I, S>(&mut self, args: I) -> &mut Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        self.args
            .extend(args.into_iter().map(|arg| arg.as_ref().to_os_string()));
        self
    }

    pub(crate) fn current_dir(&mut self, directory: impl AsRef<Path>) -> &mut Self {
        self.current_dir = Some(directory.as_ref().to_path_buf());
        self
    }

    pub(crate) fn output<F>(
        &self,
        limits: SupervisedOutputLimits,
        is_cancelled: F,
    ) -> Result<SupervisedOutput, SupervisedProcessError>
    where
        F: Fn() -> bool,
    {
        limits.validate()?;
        if process_supervision_cleanup_faulted() {
            return Err(SupervisedProcessError::new(
                SupervisedProcessErrorKind::Cleanup,
                "blocked:process-cleanup：先前的受监督进程未能可信收尾；本进程已 fail-closed。",
            ));
        }
        platform::run_supervised_output(self, limits, is_cancelled)
    }

    /// Streams stdout through a small bounded queue while retaining only bounded stderr.
    ///
    /// The consumer runs on the supervising thread and must return promptly.  Backpressure is
    /// intentional: once `stdout_buffered_chunks` are waiting, the stdout reader stops draining
    /// the anonymous pipe until the consumer catches up.  Cancellation, timeout and consumer
    /// failures still terminate the owned Windows Job Object and settle both reader threads.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn stream_stdout<F, C>(
        &self,
        limits: SupervisedStreamingLimits,
        is_cancelled: F,
        consume_stdout: C,
    ) -> Result<SupervisedStreamingOutput, SupervisedProcessError>
    where
        F: Fn() -> bool,
        C: FnMut(&[u8]) -> Result<(), String>,
    {
        limits.validate()?;
        if process_supervision_cleanup_faulted() {
            return Err(SupervisedProcessError::new(
                SupervisedProcessErrorKind::Cleanup,
                "blocked:process-cleanup：先前的受监督进程未能可信收尾；本进程已 fail-closed。",
            ));
        }
        platform::run_supervised_streaming(self, limits, is_cancelled, consume_stdout)
    }
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct SupervisedOutputLimits {
    pub execution_timeout: Duration,
    pub output_drain_timeout: Duration,
    pub termination_timeout: Duration,
    pub poll_interval: Duration,
    pub stdout_hard_limit: usize,
    pub stderr_hard_limit: usize,
}

impl SupervisedOutputLimits {
    fn validate(self) -> Result<(), SupervisedProcessError> {
        if self.execution_timeout.is_zero()
            || self.output_drain_timeout.is_zero()
            || self.termination_timeout.is_zero()
            || self.poll_interval.is_zero()
        {
            return Err(SupervisedProcessError::new(
                SupervisedProcessErrorKind::Spawn,
                "process supervision deadlines and poll interval must be non-zero",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy)]
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) struct SupervisedStreamingLimits {
    pub process: SupervisedOutputLimits,
    pub stdout_chunk_size: usize,
    pub stdout_buffered_chunks: usize,
    /// Maximum time without a newly consumed stdout byte or a clean stdout completion signal.
    /// `None` keeps only the process-wide execution deadline.
    pub stdout_inactivity_timeout: Option<Duration>,
}

#[cfg_attr(not(test), allow(dead_code))]
impl SupervisedStreamingLimits {
    fn validate(self) -> Result<(), SupervisedProcessError> {
        self.process.validate()?;
        if self.stdout_chunk_size == 0
            || self.stdout_buffered_chunks == 0
            || self
                .stdout_inactivity_timeout
                .is_some_and(|timeout| timeout.is_zero())
        {
            return Err(SupervisedProcessError::new(
                SupervisedProcessErrorKind::Spawn,
                "streaming stdout chunk size, buffered chunk count and optional inactivity timeout must be non-zero",
            ));
        }
        let retained_chunks = self.stdout_buffered_chunks.checked_add(1).ok_or_else(|| {
            SupervisedProcessError::new(
                SupervisedProcessErrorKind::Spawn,
                "streaming stdout buffered chunk count overflowed usize",
            )
        })?;
        self.stdout_chunk_size
            .checked_mul(retained_chunks)
            .ok_or_else(|| {
                SupervisedProcessError::new(
                    SupervisedProcessErrorKind::Spawn,
                    "streaming stdout buffer budget overflowed usize",
                )
            })?;
        Ok(())
    }
}

#[derive(Debug)]
pub(crate) struct SupervisedOutput {
    pub status: ExitStatus,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

#[derive(Debug)]
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) struct SupervisedStreamingOutput {
    pub status: ExitStatus,
    pub stdout_bytes: usize,
    pub stderr: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SupervisedProcessErrorKind {
    Spawn,
    Timeout,
    NoProgress,
    Cancelled,
    StdoutOverflow,
    StderrOverflow,
    Reader,
    Wait,
    Cleanup,
}

#[derive(Debug)]
pub(crate) struct SupervisedProcessError {
    kind: SupervisedProcessErrorKind,
    detail: String,
}

impl SupervisedProcessError {
    pub(crate) fn kind(&self) -> SupervisedProcessErrorKind {
        self.kind
    }

    fn new(kind: SupervisedProcessErrorKind, detail: impl Into<String>) -> Self {
        if kind == SupervisedProcessErrorKind::Cleanup {
            PROCESS_SUPERVISION_CLEANUP_FAULT.store(true, Ordering::Release);
        }
        Self {
            kind,
            detail: detail.into(),
        }
    }

    fn with_cleanup(mut self, cleanup: Result<(), String>) -> Self {
        if let Err(cleanup_error) = cleanup {
            PROCESS_SUPERVISION_CLEANUP_FAULT.store(true, Ordering::Release);
            self.kind = SupervisedProcessErrorKind::Cleanup;
            self.detail = format!(
                "blocked:process-cleanup：受监督进程未能可信收尾：{cleanup_error}; original failure: {}",
                self.detail
            );
        }
        self
    }
}

impl fmt::Display for SupervisedProcessError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}", self.detail)
    }
}

impl std::error::Error for SupervisedProcessError {}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::{
        env,
        fs::{File, Metadata},
        io::{self, Read},
        mem::{size_of, size_of_val},
        os::windows::{
            ffi::OsStrExt,
            fs::MetadataExt,
            io::{AsRawHandle, FromRawHandle},
            process::ExitStatusExt,
        },
        path::{Component, Prefix},
        ptr::{null, null_mut},
        sync::{
            mpsc::{self, Receiver, SyncSender, TryRecvError, TrySendError},
            Arc,
        },
        thread,
        time::Instant,
    };
    use windows_sys::Win32::{
        Foundation::{
            CloseHandle, GetLastError, SetHandleInformation, ERROR_NOT_FOUND, HANDLE,
            HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE, WAIT_OBJECT_0, WAIT_TIMEOUT,
        },
        Security::SECURITY_ATTRIBUTES,
        Storage::FileSystem::{
            GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW,
            FILE_ATTRIBUTE_REPARSE_POINT,
        },
        System::{
            JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicAccountingInformation,
                JobObjectBasicProcessIdList, JobObjectExtendedLimitInformation,
                QueryInformationJobObject, SetInformationJobObject, TerminateJobObject,
                JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_BASIC_PROCESS_ID_LIST,
                JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            },
            Pipes::CreatePipe,
            Threading::{
                CreateProcessW, DeleteProcThreadAttributeList, GetExitCodeProcess,
                InitializeProcThreadAttributeList, OpenProcess, ResumeThread, TerminateProcess,
                UpdateProcThreadAttribute, WaitForSingleObject, CREATE_NO_WINDOW, CREATE_SUSPENDED,
                EXTENDED_STARTUPINFO_PRESENT, PROCESS_INFORMATION, PROCESS_SYNCHRONIZE,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST, STARTF_USESTDHANDLES, STARTUPINFOEXW,
            },
            IO::CancelSynchronousIo,
        },
    };

    const TERMINATION_EXIT_CODE: u32 = 0xC137_0001;

    #[derive(Debug)]
    struct OwnedHandle(HANDLE);

    impl OwnedHandle {
        fn new(handle: HANDLE, context: &str) -> Result<Self, SupervisedProcessError> {
            if handle.is_null() || handle == INVALID_HANDLE_VALUE {
                return Err(last_error(SupervisedProcessErrorKind::Spawn, context));
            }
            Ok(Self(handle))
        }

        fn raw(&self) -> HANDLE {
            self.0
        }

        fn is_valid(&self) -> bool {
            !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE
        }

        fn into_raw(mut self) -> HANDLE {
            let handle = self.0;
            self.0 = null_mut();
            handle
        }
    }

    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
                // SAFETY: this type owns exactly one live Win32 handle.
                unsafe {
                    CloseHandle(self.0);
                }
            }
        }
    }

    struct AttributeList {
        storage: Vec<usize>,
        initialized: bool,
    }

    impl AttributeList {
        fn new(inherited_handles: &[HANDLE]) -> Result<Self, SupervisedProcessError> {
            let mut required_bytes = 0usize;
            // SAFETY: the documented first call supplies null only to query the required size.
            unsafe {
                InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut required_bytes);
            }
            if required_bytes == 0 {
                return Err(last_error(
                    SupervisedProcessErrorKind::Spawn,
                    "query process attribute-list size",
                ));
            }
            let words = required_bytes.div_ceil(size_of::<usize>());
            let mut result = Self {
                storage: vec![0usize; words],
                initialized: false,
            };
            // SAFETY: the usize-backed allocation is suitably aligned and has the queried size.
            let initialized = unsafe {
                InitializeProcThreadAttributeList(result.pointer(), 1, 0, &mut required_bytes)
            };
            if initialized == 0 {
                return Err(last_error(
                    SupervisedProcessErrorKind::Spawn,
                    "initialize process attribute list",
                ));
            }
            result.initialized = true;
            // SAFETY: the attribute list is initialized and the handle slice remains live through
            // this call; CreateProcess copies the handle list before returning.
            let updated = unsafe {
                UpdateProcThreadAttribute(
                    result.pointer(),
                    0,
                    PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                    inherited_handles.as_ptr().cast(),
                    size_of_val(inherited_handles),
                    null_mut(),
                    null(),
                )
            };
            if updated == 0 {
                return Err(last_error(
                    SupervisedProcessErrorKind::Spawn,
                    "restrict inherited process handles",
                ));
            }
            Ok(result)
        }

        fn pointer(
            &mut self,
        ) -> windows_sys::Win32::System::Threading::LPPROC_THREAD_ATTRIBUTE_LIST {
            self.storage.as_mut_ptr().cast()
        }
    }

    impl Drop for AttributeList {
        fn drop(&mut self) {
            if self.initialized {
                // SAFETY: successful construction initialized this list exactly once.
                unsafe {
                    DeleteProcThreadAttributeList(self.pointer());
                }
            }
        }
    }

    struct WindowsChild {
        process: OwnedHandle,
        job: OwnedHandle,
    }

    impl WindowsChild {
        fn exit_code(&self) -> Result<Option<u32>, SupervisedProcessError> {
            // SAFETY: process is a live process handle. Waiting with a zero timeout is a pure poll
            // and disambiguates the valid exit code 259 from Windows' STILL_ACTIVE sentinel.
            match unsafe { WaitForSingleObject(self.process.raw(), 0) } {
                WAIT_TIMEOUT => return Ok(None),
                WAIT_OBJECT_0 => {}
                _ => {
                    return Err(last_error(
                        SupervisedProcessErrorKind::Wait,
                        "poll supervised process handle",
                    ));
                }
            }
            let mut exit_code = 0u32;
            // SAFETY: process is a live process handle with query rights from CreateProcessW.
            let success = unsafe { GetExitCodeProcess(self.process.raw(), &mut exit_code) };
            if success == 0 {
                return Err(last_error(
                    SupervisedProcessErrorKind::Wait,
                    "query supervised process exit status",
                ));
            }
            Ok(Some(exit_code))
        }

        fn active_processes(&self) -> Result<u32, SupervisedProcessError> {
            let mut accounting = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
            // SAFETY: the buffer has the exact structure and size required by this info class.
            let success = unsafe {
                QueryInformationJobObject(
                    self.job.raw(),
                    JobObjectBasicAccountingInformation,
                    (&mut accounting as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                    size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                    null_mut(),
                )
            };
            if success == 0 {
                return Err(last_error(
                    SupervisedProcessErrorKind::Wait,
                    "query supervised job process count",
                ));
            }
            Ok(accounting.ActiveProcesses)
        }

        fn open_member_synchronization_handles(&self) -> Result<Vec<OwnedHandle>, String> {
            const MAX_SUPERVISED_JOB_PROCESSES: usize = 4_096;
            let buffer_bytes = size_of::<JOBOBJECT_BASIC_PROCESS_ID_LIST>()
                .checked_add((MAX_SUPERVISED_JOB_PROCESSES - 1) * size_of::<usize>())
                .ok_or_else(|| "supervised Job member buffer size overflowed".to_string())?;
            let word_count = buffer_bytes.div_ceil(size_of::<usize>());
            let mut buffer = vec![0_usize; word_count];
            // SAFETY: buffer is writable, suitably aligned and sized for the variable PID list.
            let queried = unsafe {
                QueryInformationJobObject(
                    self.job.raw(),
                    JobObjectBasicProcessIdList,
                    buffer.as_mut_ptr().cast(),
                    buffer_bytes as u32,
                    null_mut(),
                )
            };
            if queried == 0 {
                return Err(
                    "query supervised Job members failed or exceeded the process bound".into(),
                );
            }
            // SAFETY: the successful query initialized the structure at the buffer start.
            let list = unsafe { &*(buffer.as_ptr().cast::<JOBOBJECT_BASIC_PROCESS_ID_LIST>()) };
            let assigned = list.NumberOfAssignedProcesses as usize;
            let returned = list.NumberOfProcessIdsInList as usize;
            if assigned != returned || returned > MAX_SUPERVISED_JOB_PROCESSES {
                return Err("supervised Job member list was incomplete".into());
            }
            // SAFETY: returned is bounded by the allocated variable-length PID array.
            let process_ids =
                unsafe { std::slice::from_raw_parts(list.ProcessIdList.as_ptr(), returned) };
            let mut handles = Vec::with_capacity(returned);
            for raw_pid in process_ids {
                let pid = u32::try_from(*raw_pid)
                    .map_err(|_| "supervised Job returned an out-of-range PID".to_string())?;
                // SAFETY: the PID came from this private Job membership snapshot; the handle is
                // opened only for bounded synchronization and never used to terminate by PID.
                let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
                if handle.is_null() {
                    return Err("open supervised Job member synchronization handle failed".into());
                }
                handles.push(OwnedHandle(handle));
            }
            Ok(handles)
        }

        fn terminate_tree(&self, timeout: Duration) -> Result<(), String> {
            let started = Instant::now();
            let (member_handles, mut termination_error) =
                match self.open_member_synchronization_handles() {
                    Ok(handles) => (handles, None),
                    Err(error) => (Vec::new(), Some(error)),
                };
            // SAFETY: job is this child's private Job Object and is never shared externally.
            let job_terminated =
                unsafe { TerminateJobObject(self.job.raw(), TERMINATION_EXIT_CODE) };
            if job_terminated == 0 {
                let job_error = unsafe { GetLastError() };
                // The assignment path guarantees membership, but direct-handle termination is a
                // fail-safe for partial Windows failures.  It never opens or acts on a raw PID.
                // SAFETY: process is the direct child handle returned by CreateProcessW.
                let direct_terminated =
                    unsafe { TerminateProcess(self.process.raw(), TERMINATION_EXIT_CODE) };
                if direct_terminated == 0 {
                    let error = format!(
                        "TerminateJobObject failed with Windows error {job_error}, and direct-handle termination failed with Windows error {}",
                        unsafe { GetLastError() }
                    );
                    termination_error = Some(match termination_error {
                        Some(previous) => format!("{previous}; {error}"),
                        None => error,
                    });
                } else {
                    let error = format!(
                        "TerminateJobObject failed with Windows error {job_error}; only the direct-child fail-safe succeeded"
                    );
                    termination_error = Some(match termination_error {
                        Some(previous) => format!("{previous}; {error}"),
                        None => error,
                    });
                }
            }

            loop {
                match self.active_processes() {
                    Ok(0) => break,
                    Ok(_) => {}
                    Err(error) => return Err(error.to_string()),
                }
                if started.elapsed() >= timeout {
                    return Err("supervised Job Object did not become empty before deadline".into());
                }
                thread::sleep(Duration::from_millis(5));
            }

            let remaining = timeout.saturating_sub(started.elapsed());
            let wait_ms = duration_to_wait_millis(remaining);
            // SAFETY: process is a live direct-child handle.
            let wait = unsafe { WaitForSingleObject(self.process.raw(), wait_ms) };
            match wait {
                WAIT_OBJECT_0 => Ok(()),
                WAIT_TIMEOUT => Err("direct child did not exit before cleanup deadline".into()),
                _ => Err(last_error(
                    SupervisedProcessErrorKind::Cleanup,
                    "wait for terminated direct child",
                )
                .to_string()),
            }?;

            for handle in member_handles {
                let remaining = timeout.saturating_sub(started.elapsed());
                // SAFETY: each handle is an owned synchronization handle captured from the Job
                // before termination. Waiting proves every known member reached an OS terminal
                // state instead of trusting accounting to become zero slightly earlier.
                match unsafe {
                    WaitForSingleObject(handle.raw(), duration_to_wait_millis(remaining))
                } {
                    WAIT_OBJECT_0 => {}
                    WAIT_TIMEOUT => {
                        return Err(
                            "supervised Job member did not exit before cleanup deadline".into()
                        );
                    }
                    _ => {
                        return Err(last_error(
                            SupervisedProcessErrorKind::Cleanup,
                            "wait for terminated supervised Job member",
                        )
                        .to_string());
                    }
                }
            }

            match termination_error {
                Some(error) => Err(error),
                None => Ok(()),
            }
        }
    }

    impl Drop for WindowsChild {
        fn drop(&mut self) {
            // KILL_ON_JOB_CLOSE is the final fail-safe.  Explicit termination makes intent clear
            // and starts teardown before the process handle is closed.
            // SAFETY: the job handle remains owned and live throughout this call.
            unsafe {
                TerminateJobObject(self.job.raw(), TERMINATION_EXIT_CODE);
            }
        }
    }

    enum ReaderResult {
        Complete(Vec<u8>),
        Overflow,
        Failed(String),
    }

    #[derive(Clone, Copy)]
    enum StreamKind {
        Stdout,
        Stderr,
    }

    struct ReaderMessage {
        stream: StreamKind,
        result: ReaderResult,
    }

    #[cfg_attr(not(test), allow(dead_code))]
    enum StreamingReaderMessage {
        Chunk(Vec<u8>),
        Complete,
        Overflow,
        Failed(String),
    }

    #[derive(Default)]
    #[cfg_attr(not(test), allow(dead_code))]
    struct StreamingOutputState {
        stdout_complete: bool,
        stdout_bytes: usize,
        stderr: Option<Vec<u8>>,
    }

    #[derive(Default)]
    struct ReaderThreads {
        stdout: Option<thread::JoinHandle<()>>,
        stderr: Option<thread::JoinHandle<()>>,
    }

    impl ReaderThreads {
        fn settle(
            &mut self,
            drain_timeout: Duration,
            cancellation_timeout: Duration,
        ) -> Result<(), String> {
            let drain_deadline = Instant::now() + drain_timeout;
            while !self.all_finished() && Instant::now() < drain_deadline {
                thread::sleep(Duration::from_millis(2));
            }
            if !self.all_finished() {
                let mut cancellation_errors = Vec::new();
                for (name, reader) in [
                    ("stdout", self.stdout.as_ref()),
                    ("stderr", self.stderr.as_ref()),
                ] {
                    let Some(reader) = reader.filter(|reader| !reader.is_finished()) else {
                        continue;
                    };
                    // SAFETY: JoinHandle owns a live OS thread handle for this exact reader.
                    let cancelled =
                        unsafe { CancelSynchronousIo(reader.as_raw_handle() as HANDLE) };
                    if cancelled == 0 {
                        // ERROR_NOT_FOUND means the thread had no synchronous I/O in flight; it
                        // may be between read completion and return, so the second wait still owns
                        // the terminal decision.
                        let code = unsafe { GetLastError() };
                        if code != ERROR_NOT_FOUND {
                            cancellation_errors.push(format!(
                                "cancel supervised {name} reader failed with Windows error {code}"
                            ));
                        }
                    }
                }

                let cancellation_deadline = Instant::now() + cancellation_timeout;
                while !self.all_finished() && Instant::now() < cancellation_deadline {
                    thread::sleep(Duration::from_millis(2));
                }
                if !self.all_finished() {
                    cancellation_errors.push(
                        "supervised output readers did not stop after CancelSynchronousIo"
                            .to_string(),
                    );
                }
                if !cancellation_errors.is_empty() {
                    return Err(cancellation_errors.join("; "));
                }
            }

            self.join_finished()
        }

        fn all_finished(&self) -> bool {
            [&self.stdout, &self.stderr]
                .into_iter()
                .all(|reader| reader.as_ref().is_none_or(thread::JoinHandle::is_finished))
        }

        fn join_finished(&mut self) -> Result<(), String> {
            for (name, reader) in [("stdout", &mut self.stdout), ("stderr", &mut self.stderr)] {
                let Some(handle) = reader.take() else {
                    continue;
                };
                if !handle.is_finished() {
                    *reader = Some(handle);
                    return Err(format!("supervised {name} reader is still running"));
                }
                if handle.join().is_err() {
                    return Err(format!("supervised {name} reader panicked"));
                }
            }
            Ok(())
        }
    }

    pub(super) fn run_supervised_output<F>(
        command: &SupervisedCommand,
        limits: SupervisedOutputLimits,
        is_cancelled: F,
    ) -> Result<SupervisedOutput, SupervisedProcessError>
    where
        F: Fn() -> bool,
    {
        let executable = resolve_executable(&command.program)?;
        run_supervised_output_at(command, &executable, limits, is_cancelled)
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub(super) fn run_supervised_streaming<F, C>(
        command: &SupervisedCommand,
        limits: SupervisedStreamingLimits,
        is_cancelled: F,
        consume_stdout: C,
    ) -> Result<SupervisedStreamingOutput, SupervisedProcessError>
    where
        F: Fn() -> bool,
        C: FnMut(&[u8]) -> Result<(), String>,
    {
        let executable = resolve_executable(&command.program)?;
        run_supervised_streaming_at(command, &executable, limits, is_cancelled, consume_stdout)
    }

    #[cfg_attr(not(test), allow(dead_code))]
    fn run_supervised_streaming_at<F, C>(
        command: &SupervisedCommand,
        executable: &Path,
        limits: SupervisedStreamingLimits,
        is_cancelled: F,
        consume_stdout: C,
    ) -> Result<SupervisedStreamingOutput, SupervisedProcessError>
    where
        F: Fn() -> bool,
        C: FnMut(&[u8]) -> Result<(), String>,
    {
        let (mut child, stdout, stderr) = spawn_suspended_in_job(command, executable)?;
        let stopped = Arc::new(AtomicBool::new(false));
        let (stdout_sender, stdout_receiver) = mpsc::sync_channel(limits.stdout_buffered_chunks);
        let (stderr_sender, stderr_receiver) = mpsc::channel();
        let stdout_stopped = stopped.clone();
        let stdout_thread = match thread::Builder::new()
            .name("supervised-stdout-stream".into())
            .spawn(move || {
                read_streaming_stdout(
                    stdout,
                    limits.process.stdout_hard_limit,
                    limits.stdout_chunk_size,
                    stdout_sender,
                    &stdout_stopped,
                );
            }) {
            Ok(thread) => thread,
            Err(error) => {
                return Err(SupervisedProcessError::new(
                    SupervisedProcessErrorKind::Spawn,
                    format!("start supervised streaming stdout reader: {error}"),
                )
                .with_cleanup(child.terminate_tree(limits.process.termination_timeout)));
            }
        };
        let stderr_thread = match thread::Builder::new()
            .name("supervised-stderr".into())
            .spawn(move || {
                let result = read_bounded(stderr, limits.process.stderr_hard_limit);
                let _ = stderr_sender.send(result);
            }) {
            Ok(thread) => thread,
            Err(error) => {
                stopped.store(true, Ordering::Release);
                let mut readers = ReaderThreads {
                    stdout: Some(stdout_thread),
                    stderr: None,
                };
                let cleanup = combine_cleanup_results(
                    child.terminate_tree(limits.process.termination_timeout),
                    readers.settle(
                        limits.process.output_drain_timeout,
                        limits.process.termination_timeout,
                    ),
                );
                return Err(SupervisedProcessError::new(
                    SupervisedProcessErrorKind::Spawn,
                    format!("start supervised stderr reader: {error}"),
                )
                .with_cleanup(cleanup));
            }
        };
        let mut readers = ReaderThreads {
            stdout: Some(stdout_thread),
            stderr: Some(stderr_thread),
        };

        match supervise_streaming_output(
            &mut child,
            stdout_receiver,
            stderr_receiver,
            limits,
            is_cancelled,
            consume_stdout,
        ) {
            Ok(output) => {
                stopped.store(true, Ordering::Release);
                if let Err(reader_error) = readers.settle(
                    limits.process.output_drain_timeout,
                    limits.process.termination_timeout,
                ) {
                    let cleanup = combine_cleanup_results(
                        child.terminate_tree(limits.process.termination_timeout),
                        Err(reader_error),
                    );
                    return Err(SupervisedProcessError::new(
                        SupervisedProcessErrorKind::Cleanup,
                        "supervised streaming output completed but reader cleanup failed",
                    )
                    .with_cleanup(cleanup));
                }
                Ok(output)
            }
            Err(error) => {
                stopped.store(true, Ordering::Release);
                let cleanup = combine_cleanup_results(
                    child.terminate_tree(limits.process.termination_timeout),
                    readers.settle(
                        limits.process.output_drain_timeout,
                        limits.process.termination_timeout,
                    ),
                );
                Err(error.with_cleanup(cleanup))
            }
        }
    }

    fn run_supervised_output_at<F>(
        command: &SupervisedCommand,
        executable: &Path,
        limits: SupervisedOutputLimits,
        is_cancelled: F,
    ) -> Result<SupervisedOutput, SupervisedProcessError>
    where
        F: Fn() -> bool,
    {
        let (mut child, stdout, stderr) = spawn_suspended_in_job(command, executable)?;
        let (sender, receiver) = mpsc::channel();
        let stdout_sender = sender.clone();
        let stdout_thread = match thread::Builder::new()
            .name("supervised-stdout".into())
            .spawn(move || {
                let result = read_bounded(stdout, limits.stdout_hard_limit);
                let _ = stdout_sender.send(ReaderMessage {
                    stream: StreamKind::Stdout,
                    result,
                });
            }) {
            Ok(thread) => thread,
            Err(error) => {
                return Err(SupervisedProcessError::new(
                    SupervisedProcessErrorKind::Spawn,
                    format!("start supervised stdout reader: {error}"),
                )
                .with_cleanup(child.terminate_tree(limits.termination_timeout)));
            }
        };
        let stderr_thread = match thread::Builder::new()
            .name("supervised-stderr".into())
            .spawn(move || {
                let result = read_bounded(stderr, limits.stderr_hard_limit);
                let _ = sender.send(ReaderMessage {
                    stream: StreamKind::Stderr,
                    result,
                });
            }) {
            Ok(thread) => thread,
            Err(error) => {
                let mut readers = ReaderThreads {
                    stdout: Some(stdout_thread),
                    stderr: None,
                };
                let cleanup = combine_cleanup_results(
                    child.terminate_tree(limits.termination_timeout),
                    readers.settle(limits.output_drain_timeout, limits.termination_timeout),
                );
                return Err(SupervisedProcessError::new(
                    SupervisedProcessErrorKind::Spawn,
                    format!("start supervised stderr reader: {error}"),
                )
                .with_cleanup(cleanup));
            }
        };
        let mut readers = ReaderThreads {
            stdout: Some(stdout_thread),
            stderr: Some(stderr_thread),
        };

        match supervise_output(&mut child, receiver, limits, is_cancelled) {
            Ok(output) => {
                if let Err(reader_error) =
                    readers.settle(limits.output_drain_timeout, limits.termination_timeout)
                {
                    let cleanup = combine_cleanup_results(
                        child.terminate_tree(limits.termination_timeout),
                        Err(reader_error),
                    );
                    return Err(SupervisedProcessError::new(
                        SupervisedProcessErrorKind::Cleanup,
                        "supervised output completed but reader cleanup failed",
                    )
                    .with_cleanup(cleanup));
                }
                Ok(output)
            }
            Err(error) => {
                let cleanup = combine_cleanup_results(
                    child.terminate_tree(limits.termination_timeout),
                    readers.settle(limits.output_drain_timeout, limits.termination_timeout),
                );
                Err(error.with_cleanup(cleanup))
            }
        }
    }

    fn supervise_output<F>(
        child: &mut WindowsChild,
        receiver: Receiver<ReaderMessage>,
        limits: SupervisedOutputLimits,
        is_cancelled: F,
    ) -> Result<SupervisedOutput, SupervisedProcessError>
    where
        F: Fn() -> bool,
    {
        let execution_deadline = Instant::now() + limits.execution_timeout;
        let mut output_deadline = None;
        let mut root_exit_code = None;
        let mut stdout = None;
        let mut stderr = None;

        loop {
            drain_reader_messages(&receiver, &mut stdout, &mut stderr)?;

            if is_cancelled() {
                return Err(SupervisedProcessError::new(
                    SupervisedProcessErrorKind::Cancelled,
                    "supervised process was cancelled",
                ));
            }

            root_exit_code = root_exit_code.or(child.exit_code()?);
            let active_processes = child.active_processes()?;
            if active_processes == 0 && output_deadline.is_none() {
                output_deadline = Some(Instant::now() + limits.output_drain_timeout);
            }

            // Never call `take` as part of a refutable tuple pattern. Pattern operands are
            // evaluated eagerly, so doing that would discard a completed stream whenever the
            // root or its peer stream was not ready in the same poll iteration. Keep every
            // completed reader result intact until the whole Job is empty and all three pieces
            // are known to be present.
            let all_results_ready =
                root_exit_code.is_some() && stdout.is_some() && stderr.is_some();
            if active_processes == 0 && all_results_ready {
                let (Some(exit_code), Some(stdout), Some(stderr)) =
                    (root_exit_code.take(), stdout.take(), stderr.take())
                else {
                    unreachable!("reader readiness was checked without consuming results");
                };
                return Ok(SupervisedOutput {
                    status: ExitStatus::from_raw(exit_code),
                    stdout,
                    stderr,
                });
            }

            let now = Instant::now();
            if now >= execution_deadline {
                return Err(SupervisedProcessError::new(
                    SupervisedProcessErrorKind::Timeout,
                    format!(
                        "supervised process tree exceeded its execution deadline (rootExited={}, activeProcesses={active_processes}, stdoutComplete={}, stderrComplete={})",
                        root_exit_code.is_some(),
                        stdout.is_some(),
                        stderr.is_some()
                    ),
                ));
            }
            if output_deadline.is_some_and(|deadline| now >= deadline) {
                return Err(SupervisedProcessError::new(
                    SupervisedProcessErrorKind::Timeout,
                    "supervised output readers exceeded their drain deadline",
                ));
            }
            thread::sleep(limits.poll_interval.min(Duration::from_millis(20)));
        }
    }

    #[cfg_attr(not(test), allow(dead_code))]
    fn supervise_streaming_output<F, C>(
        child: &mut WindowsChild,
        stdout_receiver: Receiver<StreamingReaderMessage>,
        stderr_receiver: Receiver<ReaderResult>,
        limits: SupervisedStreamingLimits,
        is_cancelled: F,
        mut consume_stdout: C,
    ) -> Result<SupervisedStreamingOutput, SupervisedProcessError>
    where
        F: Fn() -> bool,
        C: FnMut(&[u8]) -> Result<(), String>,
    {
        let execution_deadline = Instant::now() + limits.process.execution_timeout;
        let mut output_deadline = None;
        let mut root_exit_code = None;
        let mut output = StreamingOutputState::default();
        let mut stdout_progress_at = Instant::now();

        loop {
            let stdout_bytes_before = output.stdout_bytes;
            let stdout_complete_before = output.stdout_complete;
            drain_streaming_reader_messages(
                &stdout_receiver,
                &stderr_receiver,
                &mut output,
                limits.process.stdout_hard_limit,
                64,
                limits.process.poll_interval.min(Duration::from_millis(20)),
                &mut consume_stdout,
            )?;
            if output.stdout_bytes != stdout_bytes_before
                || (!stdout_complete_before && output.stdout_complete)
            {
                stdout_progress_at = Instant::now();
            }
            let stdout_made_progress = output.stdout_bytes != stdout_bytes_before
                || (!stdout_complete_before && output.stdout_complete);

            if is_cancelled() {
                return Err(SupervisedProcessError::new(
                    SupervisedProcessErrorKind::Cancelled,
                    "supervised process was cancelled",
                ));
            }

            root_exit_code = root_exit_code.or(child.exit_code()?);
            let active_processes = child.active_processes()?;
            if active_processes == 0 && output_deadline.is_none() {
                output_deadline = Some(Instant::now() + limits.process.output_drain_timeout);
            }

            if active_processes == 0
                && root_exit_code.is_some()
                && output.stdout_complete
                && output.stderr.is_some()
            {
                let Some(exit_code) = root_exit_code.take() else {
                    unreachable!("streaming root-exit readiness was checked");
                };
                let Some(stderr) = output.stderr.take() else {
                    unreachable!("streaming stderr readiness was checked");
                };
                return Ok(SupervisedStreamingOutput {
                    status: ExitStatus::from_raw(exit_code),
                    stdout_bytes: output.stdout_bytes,
                    stderr,
                });
            }

            let now = Instant::now();
            if now >= execution_deadline {
                return Err(SupervisedProcessError::new(
                    SupervisedProcessErrorKind::Timeout,
                    format!(
                        "supervised process tree exceeded its execution deadline (rootExited={}, activeProcesses={active_processes}, stdoutComplete={}, stderrComplete={})",
                        root_exit_code.is_some(),
                        output.stdout_complete,
                        output.stderr.is_some()
                    ),
                ));
            }
            if active_processes != 0
                && limits
                    .stdout_inactivity_timeout
                    .is_some_and(|timeout| now.duration_since(stdout_progress_at) >= timeout)
            {
                return Err(SupervisedProcessError::new(
                    SupervisedProcessErrorKind::NoProgress,
                    format!(
                        "supervised streaming process produced no stdout progress before its inactivity deadline (rootExited={}, activeProcesses={active_processes}, stdoutBytes={}, stdoutComplete={})",
                        root_exit_code.is_some(),
                        output.stdout_bytes,
                        output.stdout_complete
                    ),
                ));
            }
            if output_deadline.is_some_and(|deadline| now >= deadline) {
                return Err(SupervisedProcessError::new(
                    SupervisedProcessErrorKind::Timeout,
                    "supervised streaming readers exceeded their drain deadline",
                ));
            }
            if stdout_made_progress {
                // The bounded queue already limits resident output and each pass processes only a
                // finite message budget. When bytes were available, immediately revisit
                // cancellation, deadlines and Job state instead of adding one fixed poll delay per
                // pair of chunks. This keeps the same cooperative checkpoints without throttling a
                // high-volume FFprobe/FFmpeg stream to the supervisor's idle polling cadence.
                thread::yield_now();
            } else {
                thread::sleep(limits.process.poll_interval.min(Duration::from_millis(20)));
            }
        }
    }

    fn combine_cleanup_results(
        first: Result<(), String>,
        second: Result<(), String>,
    ) -> Result<(), String> {
        match (first, second) {
            (Ok(()), Ok(())) => Ok(()),
            (Err(error), Ok(())) | (Ok(()), Err(error)) => Err(error),
            (Err(first), Err(second)) => Err(format!("{first}; {second}")),
        }
    }

    fn drain_reader_messages(
        receiver: &Receiver<ReaderMessage>,
        stdout: &mut Option<Vec<u8>>,
        stderr: &mut Option<Vec<u8>>,
    ) -> Result<(), SupervisedProcessError> {
        loop {
            let message = match receiver.try_recv() {
                Ok(message) => message,
                Err(TryRecvError::Empty) => return Ok(()),
                Err(TryRecvError::Disconnected) => {
                    if stdout.is_none() || stderr.is_none() {
                        return Err(SupervisedProcessError::new(
                            SupervisedProcessErrorKind::Reader,
                            "supervised output reader disconnected without a result",
                        ));
                    }
                    return Ok(());
                }
            };
            let destination = match message.stream {
                StreamKind::Stdout => &mut *stdout,
                StreamKind::Stderr => &mut *stderr,
            };
            if destination.is_some() {
                return Err(SupervisedProcessError::new(
                    SupervisedProcessErrorKind::Reader,
                    "supervised output reader returned a duplicate result",
                ));
            }
            match message.result {
                ReaderResult::Complete(bytes) => *destination = Some(bytes),
                ReaderResult::Overflow => {
                    let (kind, stream) = match message.stream {
                        StreamKind::Stdout => {
                            (SupervisedProcessErrorKind::StdoutOverflow, "stdout")
                        }
                        StreamKind::Stderr => {
                            (SupervisedProcessErrorKind::StderrOverflow, "stderr")
                        }
                    };
                    return Err(SupervisedProcessError::new(
                        kind,
                        format!("supervised {stream} exceeded its hard byte limit"),
                    ));
                }
                ReaderResult::Failed(error) => {
                    return Err(SupervisedProcessError::new(
                        SupervisedProcessErrorKind::Reader,
                        format!("supervised output read failed: {error}"),
                    ));
                }
            }
        }
    }

    #[cfg_attr(not(test), allow(dead_code))]
    fn drain_streaming_reader_messages<C>(
        stdout_receiver: &Receiver<StreamingReaderMessage>,
        stderr_receiver: &Receiver<ReaderResult>,
        output: &mut StreamingOutputState,
        stdout_hard_limit: usize,
        message_budget: usize,
        consume_time_budget: Duration,
        consume_stdout: &mut C,
    ) -> Result<(), SupervisedProcessError>
    where
        C: FnMut(&[u8]) -> Result<(), String>,
    {
        match stderr_receiver.try_recv() {
            Ok(result) => {
                if output.stderr.is_some() {
                    return Err(SupervisedProcessError::new(
                        SupervisedProcessErrorKind::Reader,
                        "supervised stderr reader returned a duplicate result",
                    ));
                }
                match result {
                    ReaderResult::Complete(bytes) => output.stderr = Some(bytes),
                    ReaderResult::Overflow => {
                        return Err(SupervisedProcessError::new(
                            SupervisedProcessErrorKind::StderrOverflow,
                            "supervised stderr exceeded its hard byte limit",
                        ));
                    }
                    ReaderResult::Failed(error) => {
                        return Err(SupervisedProcessError::new(
                            SupervisedProcessErrorKind::Reader,
                            format!("supervised stderr read failed: {error}"),
                        ));
                    }
                }
            }
            Err(TryRecvError::Empty) => {}
            Err(TryRecvError::Disconnected) if output.stderr.is_some() => {}
            Err(TryRecvError::Disconnected) => {
                return Err(SupervisedProcessError::new(
                    SupervisedProcessErrorKind::Reader,
                    "supervised stderr reader disconnected without a result",
                ));
            }
        }

        let consume_started_at = Instant::now();
        for message_index in 0..message_budget {
            let message = match stdout_receiver.try_recv() {
                Ok(message) => message,
                Err(TryRecvError::Empty) => return Ok(()),
                Err(TryRecvError::Disconnected) => {
                    if !output.stdout_complete {
                        return Err(SupervisedProcessError::new(
                            SupervisedProcessErrorKind::Reader,
                            "supervised streaming stdout reader disconnected without completion",
                        ));
                    }
                    return Ok(());
                }
            };
            match message {
                StreamingReaderMessage::Chunk(chunk) => {
                    if output.stdout_complete {
                        return Err(SupervisedProcessError::new(
                            SupervisedProcessErrorKind::Reader,
                            "supervised streaming stdout produced bytes after completion",
                        ));
                    }
                    let next_total =
                        output
                            .stdout_bytes
                            .checked_add(chunk.len())
                            .ok_or_else(|| {
                                SupervisedProcessError::new(
                                    SupervisedProcessErrorKind::StdoutOverflow,
                                    "supervised streaming stdout byte count overflowed usize",
                                )
                            })?;
                    if next_total > stdout_hard_limit {
                        return Err(SupervisedProcessError::new(
                            SupervisedProcessErrorKind::StdoutOverflow,
                            "supervised streaming stdout exceeded its hard byte limit",
                        ));
                    }
                    consume_stdout(&chunk).map_err(|error| {
                        SupervisedProcessError::new(
                            SupervisedProcessErrorKind::Reader,
                            format!("supervised stdout consumer failed: {error}"),
                        )
                    })?;
                    output.stdout_bytes = next_total;
                }
                StreamingReaderMessage::Complete => {
                    if std::mem::replace(&mut output.stdout_complete, true) {
                        return Err(SupervisedProcessError::new(
                            SupervisedProcessErrorKind::Reader,
                            "supervised streaming stdout returned duplicate completion",
                        ));
                    }
                }
                StreamingReaderMessage::Overflow => {
                    return Err(SupervisedProcessError::new(
                        SupervisedProcessErrorKind::StdoutOverflow,
                        "supervised streaming stdout exceeded its hard byte limit",
                    ));
                }
                StreamingReaderMessage::Failed(error) => {
                    return Err(SupervisedProcessError::new(
                        SupervisedProcessErrorKind::Reader,
                        format!("supervised streaming stdout read failed: {error}"),
                    ));
                }
            }
            if message_index + 1 < message_budget
                && consume_started_at.elapsed() >= consume_time_budget
            {
                return Ok(());
            }
        }
        // A producer may refill the bounded queue as quickly as it is drained. Yield after a
        // finite batch so sustained output cannot starve cancellation, timeout or Job polling.
        Ok(())
    }

    fn read_bounded(mut reader: File, hard_limit: usize) -> ReaderResult {
        let mut output = Vec::with_capacity(hard_limit.min(64 * 1024));
        let mut buffer = [0u8; 16 * 1024];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => return ReaderResult::Complete(output),
                Ok(read) if output.len().saturating_add(read) > hard_limit => {
                    return ReaderResult::Overflow;
                }
                Ok(read) => output.extend_from_slice(&buffer[..read]),
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                // Anonymous Windows pipes report ERROR_BROKEN_PIPE after the final buffered
                // bytes are drained. For a dedicated child stdout/stderr pipe that is the normal
                // EOF signal, not an evidence-reader failure.
                Err(error) if error.kind() == io::ErrorKind::BrokenPipe => {
                    return ReaderResult::Complete(output);
                }
                Err(error) => return ReaderResult::Failed(error.to_string()),
            }
        }
    }

    #[cfg_attr(not(test), allow(dead_code))]
    fn read_streaming_stdout(
        mut reader: File,
        hard_limit: usize,
        chunk_size: usize,
        sender: SyncSender<StreamingReaderMessage>,
        stopped: &AtomicBool,
    ) {
        let mut total = 0usize;
        let mut buffer = vec![0u8; chunk_size];
        let mut filled = 0usize;
        loop {
            if stopped.load(Ordering::Acquire) {
                return;
            }
            match reader.read(&mut buffer[filled..]) {
                Ok(0) => {
                    let _ = finish_streaming_stdout(&sender, &buffer[..filled], stopped);
                    return;
                }
                Ok(read) => {
                    let Some(next_total) = total.checked_add(read) else {
                        let _ = send_streaming_reader_message(
                            &sender,
                            StreamingReaderMessage::Overflow,
                            stopped,
                        );
                        return;
                    };
                    if next_total > hard_limit {
                        let _ = send_streaming_reader_message(
                            &sender,
                            StreamingReaderMessage::Overflow,
                            stopped,
                        );
                        return;
                    }
                    total = next_total;
                    filled += read;
                    if filled == buffer.len() {
                        if !send_streaming_reader_message(
                            &sender,
                            StreamingReaderMessage::Chunk(buffer.clone()),
                            stopped,
                        ) {
                            return;
                        }
                        filled = 0;
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) if error.kind() == io::ErrorKind::BrokenPipe => {
                    let _ = finish_streaming_stdout(&sender, &buffer[..filled], stopped);
                    return;
                }
                Err(error) => {
                    let _ = send_streaming_reader_message(
                        &sender,
                        StreamingReaderMessage::Failed(error.to_string()),
                        stopped,
                    );
                    return;
                }
            }
        }
    }

    fn finish_streaming_stdout(
        sender: &SyncSender<StreamingReaderMessage>,
        residual: &[u8],
        stopped: &AtomicBool,
    ) -> bool {
        if !residual.is_empty()
            && !send_streaming_reader_message(
                sender,
                StreamingReaderMessage::Chunk(residual.to_vec()),
                stopped,
            )
        {
            return false;
        }
        send_streaming_reader_message(sender, StreamingReaderMessage::Complete, stopped)
    }

    #[cfg_attr(not(test), allow(dead_code))]
    fn send_streaming_reader_message(
        sender: &SyncSender<StreamingReaderMessage>,
        mut message: StreamingReaderMessage,
        stopped: &AtomicBool,
    ) -> bool {
        loop {
            if stopped.load(Ordering::Acquire) {
                return false;
            }
            match sender.try_send(message) {
                Ok(()) => return true,
                Err(TrySendError::Full(returned)) => {
                    message = returned;
                    thread::sleep(Duration::from_millis(1));
                }
                Err(TrySendError::Disconnected(_)) => return false,
            }
        }
    }

    fn spawn_suspended_in_job(
        command: &SupervisedCommand,
        executable: &Path,
    ) -> Result<(WindowsChild, File, File), SupervisedProcessError> {
        let executable_wide = wide_nul(executable.as_os_str(), "executable path")?;
        let mut command_line = encode_command_line(executable.as_os_str(), &command.args)?;
        let current_directory_wide = command
            .current_dir
            .as_ref()
            .map(|directory| wide_nul(directory.as_os_str(), "current directory"))
            .transpose()?;
        let current_directory = current_directory_wide
            .as_ref()
            .map_or(null(), |directory| directory.as_ptr());

        // SAFETY: null security attributes and a null name create a private, unnamed Job Object.
        let job = OwnedHandle::new(
            unsafe { CreateJobObjectW(null(), null()) },
            "create Job Object",
        )?;
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: limits has the exact type and length required by this information class.
        let configured = unsafe {
            SetInformationJobObject(
                job.raw(),
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if configured == 0 {
            return Err(last_error(
                SupervisedProcessErrorKind::Spawn,
                "configure Job Object kill-on-close",
            ));
        }

        let (stdin_read, stdin_write) = create_pipe_pair("stdin")?;
        set_non_inheritable(stdin_write.raw(), "stdin write handle")?;
        let (stdout_read, stdout_write) = create_pipe_pair("stdout")?;
        set_non_inheritable(stdout_read.raw(), "stdout read handle")?;
        let (stderr_read, stderr_write) = create_pipe_pair("stderr")?;
        set_non_inheritable(stderr_read.raw(), "stderr read handle")?;
        let inherited = [stdin_read.raw(), stdout_write.raw(), stderr_write.raw()];
        let mut attribute_list = AttributeList::new(&inherited)?;

        let mut startup = STARTUPINFOEXW::default();
        startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = stdin_read.raw();
        startup.StartupInfo.hStdOutput = stdout_write.raw();
        startup.StartupInfo.hStdError = stderr_write.raw();
        startup.lpAttributeList = attribute_list.pointer();
        let mut process_information = PROCESS_INFORMATION::default();

        // SAFETY: all pointers reference live, correctly sized buffers. The child is suspended,
        // and the explicit handle list contains only its three standard handles.
        let created = unsafe {
            CreateProcessW(
                executable_wide.as_ptr(),
                command_line.as_mut_ptr(),
                null(),
                null(),
                1,
                CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT,
                null(),
                current_directory,
                &startup.StartupInfo,
                &mut process_information,
            )
        };
        if created == 0 {
            return Err(last_error(
                SupervisedProcessErrorKind::Spawn,
                "create suspended supervised process",
            ));
        }
        let process = OwnedHandle(process_information.hProcess);
        let thread_handle = OwnedHandle(process_information.hThread);
        if !process.is_valid() || !thread_handle.is_valid() {
            let cleanup = if process.is_valid() {
                terminate_direct_child_bounded(&process, Duration::from_secs(2))
            } else {
                Err("CreateProcessW returned no process handle for suspended child cleanup".into())
            };
            return Err(SupervisedProcessError::new(
                SupervisedProcessErrorKind::Spawn,
                "CreateProcessW returned incomplete process information",
            )
            .with_cleanup(cleanup));
        }

        // SAFETY: both handles are live; the child cannot run before assignment succeeds.
        let assigned = unsafe { AssignProcessToJobObject(job.raw(), process.raw()) };
        if assigned == 0 {
            let error = last_error(
                SupervisedProcessErrorKind::Spawn,
                "assign suspended child to Job Object",
            );
            return Err(error.with_cleanup(terminate_direct_child_bounded(
                &process,
                Duration::from_secs(2),
            )));
        }

        // SAFETY: hThread is the primary thread created suspended by this CreateProcessW call.
        let previous_suspend_count = unsafe { ResumeThread(thread_handle.raw()) };
        if previous_suspend_count != 1 {
            let error = if previous_suspend_count == u32::MAX {
                last_error(
                    SupervisedProcessErrorKind::Spawn,
                    "resume supervised primary thread",
                )
            } else {
                SupervisedProcessError::new(
                    SupervisedProcessErrorKind::Spawn,
                    format!(
                        "supervised primary thread had unexpected suspend count {previous_suspend_count}"
                    ),
                )
            };
            let child = WindowsChild { process, job };
            return Err(error.with_cleanup(child.terminate_tree(Duration::from_secs(2))));
        }

        drop(thread_handle);
        drop(stdin_read);
        drop(stdin_write);
        drop(stdout_write);
        drop(stderr_write);
        drop(attribute_list);

        let stdout_raw = stdout_read.into_raw();
        let stderr_raw = stderr_read.into_raw();
        // SAFETY: ownership of each unique pipe read handle is transferred exactly once to File.
        let stdout = unsafe { File::from_raw_handle(stdout_raw) };
        // SAFETY: ownership of each unique pipe read handle is transferred exactly once to File.
        let stderr = unsafe { File::from_raw_handle(stderr_raw) };
        Ok((WindowsChild { process, job }, stdout, stderr))
    }

    fn create_pipe_pair(
        stream: &str,
    ) -> Result<(OwnedHandle, OwnedHandle), SupervisedProcessError> {
        let attributes = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: null_mut(),
            bInheritHandle: 1,
        };
        let mut read = null_mut();
        let mut write = null_mut();
        // SAFETY: output pointers are valid and security attributes are correctly initialized.
        let created = unsafe { CreatePipe(&mut read, &mut write, &attributes, 0) };
        if created == 0 {
            return Err(last_error(
                SupervisedProcessErrorKind::Spawn,
                &format!("create supervised {stream} pipe"),
            ));
        }
        let read = OwnedHandle(read);
        let write = OwnedHandle(write);
        if !read.is_valid() || !write.is_valid() {
            return Err(SupervisedProcessError::new(
                SupervisedProcessErrorKind::Spawn,
                format!("CreatePipe returned incomplete {stream} handles"),
            ));
        }
        Ok((read, write))
    }

    fn terminate_direct_child_bounded(
        process: &OwnedHandle,
        timeout: Duration,
    ) -> Result<(), String> {
        // SAFETY: process is the exact owned direct-child handle returned by CreateProcessW.
        let terminated = unsafe { TerminateProcess(process.raw(), TERMINATION_EXIT_CODE) };
        if terminated == 0 {
            // A child which already exited is already clean; disambiguate that from a failed kill.
            // SAFETY: zero-time wait only polls this owned process handle.
            if unsafe { WaitForSingleObject(process.raw(), 0) } != WAIT_OBJECT_0 {
                return Err(format!(
                    "direct-child termination failed with Windows error {}",
                    unsafe { GetLastError() }
                ));
            }
        }
        // SAFETY: the process handle stays live for the bounded wait.
        match unsafe { WaitForSingleObject(process.raw(), duration_to_wait_millis(timeout)) } {
            WAIT_OBJECT_0 => Ok(()),
            WAIT_TIMEOUT => Err("suspended direct child did not terminate before deadline".into()),
            _ => Err(format!(
                "direct-child cleanup wait failed with Windows error {}",
                unsafe { GetLastError() }
            )),
        }
    }

    fn set_non_inheritable(handle: HANDLE, context: &str) -> Result<(), SupervisedProcessError> {
        // SAFETY: handle is a live pipe handle and only its inherit flag is modified.
        let success = unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0) };
        if success == 0 {
            return Err(last_error(SupervisedProcessErrorKind::Spawn, context));
        }
        Ok(())
    }

    pub(super) fn resolve_supervised_executable(
        program: &OsStr,
    ) -> Result<PathBuf, SupervisedProcessError> {
        resolve_executable(program)
    }

    fn resolve_executable(program: &OsStr) -> Result<PathBuf, SupervisedProcessError> {
        let resolved = resolve_executable_path(program)?;
        resolve_verified_chocolatey_shim(&resolved)
    }

    fn resolve_executable_path(program: &OsStr) -> Result<PathBuf, SupervisedProcessError> {
        if program.is_empty() {
            return Err(SupervisedProcessError::new(
                SupervisedProcessErrorKind::Spawn,
                "supervised executable path is empty",
            ));
        }
        let requested = Path::new(program);
        let has_directory = requested.is_absolute() || requested.components().count() > 1;
        let mut candidates = Vec::new();
        if has_directory {
            candidates.push(requested.to_path_buf());
            if requested.extension().is_none() {
                candidates.push(requested.with_extension("exe"));
            }
        } else {
            let names = executable_names(requested);
            if let Ok(current_dir) = env::current_dir() {
                candidates.extend(names.iter().map(|name| current_dir.join(name)));
            }
            if let Some(path) = env::var_os("PATH") {
                for directory in env::split_paths(&path) {
                    candidates.extend(names.iter().map(|name| directory.join(name)));
                }
            }
        }
        for candidate in candidates {
            let candidate = if candidate.is_absolute() {
                candidate
            } else {
                let current_directory = env::current_dir().map_err(|_| {
                    SupervisedProcessError::new(
                        SupervisedProcessErrorKind::Spawn,
                        "supervised executable lookup could not read the current directory",
                    )
                })?;
                current_directory.join(candidate)
            };
            if candidate.is_file() {
                // Chocolatey candidates must remain lexical here.  Canonicalizing a PATH entry
                // before validating every component could already traverse a junction or mount
                // point and erase the evidence needed by the trust decision below.
                return Ok(candidate);
            }
        }
        Err(SupervisedProcessError::new(
            SupervisedProcessErrorKind::Spawn,
            "supervised executable was not found",
        ))
    }

    fn executable_names(requested: &Path) -> Vec<PathBuf> {
        if requested.extension().is_some() {
            return vec![requested.to_path_buf()];
        }
        let mut names = vec![requested.to_path_buf(), requested.with_extension("exe")];
        if let Some(path_ext) = env::var_os("PATHEXT") {
            for extension in path_ext.to_string_lossy().split(';') {
                let extension = extension.trim().trim_start_matches('.');
                if !extension.is_empty() && extension.eq_ignore_ascii_case("exe") {
                    let candidate = requested.with_extension(extension);
                    if !names.iter().any(|known| known == &candidate) {
                        names.push(candidate);
                    }
                }
            }
        }
        names
    }

    fn resolve_verified_chocolatey_shim(
        executable: &Path,
    ) -> Result<PathBuf, SupervisedProcessError> {
        let path_looks_like_chocolatey_bin = path_looks_like_chocolatey_bin(executable);
        // A path that is not recognizably Chocolatey may still be a relocated ShimGen binary.
        // Read its resource once to detect that case.  For a lexically suspicious Chocolatey bin
        // path, defer even that read until the full path has passed the no-reparse trust walk.
        let prevalidated_version = if path_looks_like_chocolatey_bin {
            None
        } else {
            read_windows_file_version_strings(executable)
        };
        let verified_shimgen = prevalidated_version
            .as_ref()
            .is_some_and(|version| version_identifies_chocolatey_shimgen(executable, version));
        if !verified_shimgen && !path_looks_like_chocolatey_bin {
            return canonicalize_regular_executable(executable);
        }

        let layout = trusted_chocolatey_layout()?;
        let executable = canonicalize_no_reparse(executable, TrustedPathKind::File)?;
        let parent = executable.parent().ok_or_else(|| {
            SupervisedProcessError::new(
                SupervisedProcessErrorKind::Spawn,
                "possible Chocolatey shim has no parent directory",
            )
        })?;
        if !windows_paths_equal(parent, &layout.bin) {
            return Err(SupervisedProcessError::new(
                SupervisedProcessErrorKind::Spawn,
                "possible Chocolatey shim did not pass canonical path validation",
            ));
        }
        let version = if let Some(version) = prevalidated_version {
            version
        } else {
            read_windows_file_version_strings(&executable).ok_or_else(|| {
                SupervisedProcessError::new(
                    SupervisedProcessErrorKind::Spawn,
                    "possible Chocolatey shim did not pass bounded version validation",
                )
            })?
        };
        if !version_identifies_chocolatey_shimgen(&executable, &version) {
            return Err(SupervisedProcessError::new(
                SupervisedProcessErrorKind::Spawn,
                "possible Chocolatey shim did not pass bounded version validation",
            ));
        }
        let expected_name = executable.file_name().ok_or_else(|| {
            SupervisedProcessError::new(
                SupervisedProcessErrorKind::Spawn,
                "Chocolatey shim has no executable file name",
            )
        })?;
        find_unique_chocolatey_package_executable(&layout.lib, expected_name, &executable)
    }

    fn canonicalize_regular_executable(
        executable: &Path,
    ) -> Result<PathBuf, SupervisedProcessError> {
        executable.canonicalize().map_err(|_| {
            SupervisedProcessError::new(
                SupervisedProcessErrorKind::Spawn,
                "supervised executable could not be canonicalized",
            )
        })
    }

    fn path_looks_like_chocolatey_bin(executable: &Path) -> bool {
        let conventional = executable.parent().is_some_and(|bin| {
            bin.file_name()
                .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case("bin"))
                && bin.parent().is_some_and(|root| {
                    root.file_name().is_some_and(|name| {
                        name.to_string_lossy().eq_ignore_ascii_case("chocolatey")
                    })
                })
        });
        if conventional {
            return true;
        }
        let Some(configured_root) = env::var_os("ChocolateyInstall") else {
            return false;
        };
        executable.parent().is_some_and(|parent| {
            windows_paths_equal(parent, &PathBuf::from(configured_root).join("bin"))
        })
    }

    struct TrustedChocolateyLayout {
        bin: PathBuf,
        lib: PathBuf,
    }

    fn trusted_chocolatey_layout() -> Result<TrustedChocolateyLayout, SupervisedProcessError> {
        let chocolatey_install = env::var_os("ChocolateyInstall").ok_or_else(|| {
            SupervisedProcessError::new(
                SupervisedProcessErrorKind::Spawn,
                "a possible Chocolatey shim was found but ChocolateyInstall is unavailable",
            )
        })?;
        let chocolatey_root = canonicalize_no_reparse(
            &PathBuf::from(chocolatey_install),
            TrustedPathKind::Directory,
        )?;
        let chocolatey_bin =
            canonicalize_no_reparse(&chocolatey_root.join("bin"), TrustedPathKind::Directory)?;
        let chocolatey_lib =
            canonicalize_no_reparse(&chocolatey_root.join("lib"), TrustedPathKind::Directory)?;
        if !chocolatey_bin
            .parent()
            .is_some_and(|parent| windows_paths_equal(parent, &chocolatey_root))
            || !chocolatey_lib
                .parent()
                .is_some_and(|parent| windows_paths_equal(parent, &chocolatey_root))
        {
            return Err(SupervisedProcessError::new(
                SupervisedProcessErrorKind::Spawn,
                "Chocolatey bin or package directory escaped its trusted canonical root",
            ));
        }
        Ok(TrustedChocolateyLayout {
            bin: chocolatey_bin,
            lib: chocolatey_lib,
        })
    }

    #[derive(Clone, Copy)]
    enum TrustedPathKind {
        File,
        Directory,
    }

    fn canonicalize_no_reparse(
        path: &Path,
        expected_kind: TrustedPathKind,
    ) -> Result<PathBuf, SupervisedProcessError> {
        validate_absolute_path_without_reparse(path, expected_kind)?;
        let canonical = path.canonicalize().map_err(|_| {
            SupervisedProcessError::new(
                SupervisedProcessErrorKind::Spawn,
                "trusted Chocolatey path could not be canonicalized",
            )
        })?;
        validate_absolute_path_without_reparse(&canonical, expected_kind)?;
        Ok(canonical)
    }

    fn validate_absolute_path_without_reparse(
        path: &Path,
        expected_kind: TrustedPathKind,
    ) -> Result<(), SupervisedProcessError> {
        const MAX_TRUSTED_PATH_COMPONENTS: usize = 64;

        if !path.is_absolute() {
            return Err(SupervisedProcessError::new(
                SupervisedProcessErrorKind::Spawn,
                "trusted Chocolatey path must be an absolute local-disk path",
            ));
        }
        let mut current = PathBuf::new();
        let mut saw_local_disk_prefix = false;
        let mut saw_root = false;
        let mut normal_components = 0usize;
        let mut last_metadata: Option<Metadata> = None;
        for component in path.components() {
            match component {
                Component::Prefix(prefix) => {
                    if saw_local_disk_prefix
                        || !matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_))
                    {
                        return Err(SupervisedProcessError::new(
                            SupervisedProcessErrorKind::Spawn,
                            "trusted Chocolatey path must use one bounded local-disk prefix",
                        ));
                    }
                    saw_local_disk_prefix = true;
                    current.push(prefix.as_os_str());
                }
                Component::RootDir => {
                    if !saw_local_disk_prefix || saw_root {
                        return Err(SupervisedProcessError::new(
                            SupervisedProcessErrorKind::Spawn,
                            "trusted Chocolatey path has an invalid root",
                        ));
                    }
                    saw_root = true;
                    current.push(component.as_os_str());
                    last_metadata = Some(non_reparse_metadata(&current)?);
                }
                Component::CurDir => {}
                Component::ParentDir => {
                    return Err(SupervisedProcessError::new(
                        SupervisedProcessErrorKind::Spawn,
                        "trusted Chocolatey path cannot contain parent traversal",
                    ));
                }
                Component::Normal(part) => {
                    if !saw_root {
                        return Err(SupervisedProcessError::new(
                            SupervisedProcessErrorKind::Spawn,
                            "trusted Chocolatey path has no local-disk root",
                        ));
                    }
                    normal_components = normal_components.saturating_add(1);
                    if normal_components > MAX_TRUSTED_PATH_COMPONENTS {
                        return Err(SupervisedProcessError::new(
                            SupervisedProcessErrorKind::Spawn,
                            "trusted Chocolatey path exceeded its component hard limit",
                        ));
                    }
                    current.push(part);
                    last_metadata = Some(non_reparse_metadata(&current)?);
                }
            }
        }
        if !saw_local_disk_prefix || !saw_root {
            return Err(SupervisedProcessError::new(
                SupervisedProcessErrorKind::Spawn,
                "trusted Chocolatey path has no valid local-disk root",
            ));
        }
        let metadata = last_metadata.ok_or_else(|| {
            SupervisedProcessError::new(
                SupervisedProcessErrorKind::Spawn,
                "trusted Chocolatey path has no readable final component",
            )
        })?;
        let expected_kind_matches = match expected_kind {
            TrustedPathKind::File => metadata.is_file(),
            TrustedPathKind::Directory => metadata.is_dir(),
        };
        if !expected_kind_matches {
            return Err(SupervisedProcessError::new(
                SupervisedProcessErrorKind::Spawn,
                "trusted Chocolatey path had an unexpected object type",
            ));
        }
        Ok(())
    }

    fn non_reparse_metadata(path: &Path) -> Result<Metadata, SupervisedProcessError> {
        let metadata = std::fs::symlink_metadata(path).map_err(|_| {
            SupervisedProcessError::new(
                SupervisedProcessErrorKind::Spawn,
                "trusted Chocolatey path component could not be inspected",
            )
        })?;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(SupervisedProcessError::new(
                SupervisedProcessErrorKind::Spawn,
                "trusted Chocolatey path contains a reparse point",
            ));
        }
        Ok(metadata)
    }

    fn find_unique_chocolatey_package_executable(
        chocolatey_lib: &Path,
        expected_name: &OsStr,
        excluded_shim: &Path,
    ) -> Result<PathBuf, SupervisedProcessError> {
        const MAX_CHOCOLATEY_SEARCH_DEPTH: usize = 12;
        const MAX_CHOCOLATEY_SEARCH_ENTRIES: usize = 20_000;

        let canonical_library =
            canonicalize_no_reparse(chocolatey_lib, TrustedPathKind::Directory)?;
        if !windows_paths_equal(&canonical_library, chocolatey_lib) {
            return Err(SupervisedProcessError::new(
                SupervisedProcessErrorKind::Spawn,
                "Chocolatey package search requires its trusted canonical root",
            ));
        }
        let mut stack = vec![(canonical_library.clone(), 0usize)];
        let mut visited_entries = 0usize;
        let mut candidates = Vec::new();
        while let Some((directory, depth)) = stack.pop() {
            validate_absolute_path_without_reparse(&directory, TrustedPathKind::Directory)?;
            let entries = std::fs::read_dir(&directory).map_err(|_| {
                SupervisedProcessError::new(
                    SupervisedProcessErrorKind::Spawn,
                    "Chocolatey package search could not read every directory",
                )
            })?;
            for entry in entries {
                let entry = entry.map_err(|_| {
                    SupervisedProcessError::new(
                        SupervisedProcessErrorKind::Spawn,
                        "Chocolatey package search returned an unreadable entry",
                    )
                })?;
                visited_entries = visited_entries.saturating_add(1);
                if visited_entries > MAX_CHOCOLATEY_SEARCH_ENTRIES {
                    return Err(SupervisedProcessError::new(
                        SupervisedProcessErrorKind::Spawn,
                        "Chocolatey package search exceeded its entry hard limit",
                    ));
                }
                // FileType::is_symlink is insufficient on Windows: junctions, mount points, and
                // other name-surrogate objects are reparse points too.  Every encountered item is
                // inspected by its raw FILE_ATTRIBUTE_REPARSE_POINT bit and any such item makes
                // the uniqueness proof fail closed.
                let metadata = non_reparse_metadata(&entry.path())?;
                if metadata.is_dir() {
                    if depth >= MAX_CHOCOLATEY_SEARCH_DEPTH {
                        return Err(SupervisedProcessError::new(
                            SupervisedProcessErrorKind::Spawn,
                            "Chocolatey package search exceeded its depth hard limit and is incomplete",
                        ));
                    }
                    stack.push((entry.path(), depth + 1));
                    continue;
                }
                if !metadata.is_file()
                    || !entry
                        .file_name()
                        .to_string_lossy()
                        .eq_ignore_ascii_case(&expected_name.to_string_lossy())
                {
                    continue;
                }
                let canonical = canonicalize_no_reparse(&entry.path(), TrustedPathKind::File)?;
                if !windows_path_is_within(&canonical, &canonical_library) {
                    return Err(SupervisedProcessError::new(
                        SupervisedProcessErrorKind::Spawn,
                        "Chocolatey executable candidate escaped the trusted package root",
                    ));
                }
                if !windows_paths_equal(&canonical, excluded_shim)
                    && !is_verified_chocolatey_shimgen(&canonical)
                {
                    candidates.push(canonical);
                    if candidates.len() > 1 {
                        break;
                    }
                }
            }
            if candidates.len() > 1 {
                break;
            }
        }
        if candidates.len() != 1 {
            return Err(SupervisedProcessError::new(
                SupervisedProcessErrorKind::Spawn,
                "Chocolatey shim did not have exactly one trusted package executable; configure the real path explicitly",
            ));
        }
        Ok(candidates.remove(0))
    }

    fn is_verified_chocolatey_shimgen(executable: &Path) -> bool {
        read_windows_file_version_strings(executable)
            .as_ref()
            .is_some_and(|version| version_identifies_chocolatey_shimgen(executable, version))
    }

    struct WindowsFileVersionStrings {
        product_name: String,
        file_description: String,
        company_name: String,
        original_filename: String,
    }

    fn version_identifies_chocolatey_shimgen(
        executable: &Path,
        version: &WindowsFileVersionStrings,
    ) -> bool {
        const SHIMGEN_DESCRIPTION: &str = "ShimGen generated shim - Chocolatey Shim";
        const CHOCOLATEY_COMPANY_PREFIX: &str = "Chocolatey Software, Inc";

        version
            .product_name
            .eq_ignore_ascii_case(SHIMGEN_DESCRIPTION)
            && version
                .file_description
                .eq_ignore_ascii_case(SHIMGEN_DESCRIPTION)
            && version
                .company_name
                .get(..CHOCOLATEY_COMPANY_PREFIX.len())
                .is_some_and(|prefix| prefix.eq_ignore_ascii_case(CHOCOLATEY_COMPANY_PREFIX))
            && executable.file_name().is_some_and(|name| {
                name.to_string_lossy()
                    .eq_ignore_ascii_case(&version.original_filename)
            })
    }

    fn read_windows_file_version_strings(executable: &Path) -> Option<WindowsFileVersionStrings> {
        const MAX_VERSION_INFO_BYTES: u32 = 1024 * 1024;
        let path = wide_nul(executable.as_os_str(), "version resource path").ok()?;
        let mut ignored = 0u32;
        // SAFETY: path is a live NUL-terminated UTF-16 file name.
        let byte_count = unsafe { GetFileVersionInfoSizeW(path.as_ptr(), &mut ignored) };
        if byte_count == 0 || byte_count > MAX_VERSION_INFO_BYTES {
            return None;
        }
        let mut storage = vec![0usize; (byte_count as usize).div_ceil(size_of::<usize>())];
        // SAFETY: storage is writable, suitably aligned, and at least byte_count bytes long.
        if unsafe { GetFileVersionInfoW(path.as_ptr(), 0, byte_count, storage.as_mut_ptr().cast()) }
            == 0
        {
            return None;
        }

        let translation_query = wide_literal(r"\VarFileInfo\Translation");
        let mut translations = null_mut();
        let mut translation_bytes = 0u32;
        // SAFETY: the version block and query are live; the API returns an interior pointer.
        if unsafe {
            VerQueryValueW(
                storage.as_ptr().cast(),
                translation_query.as_ptr(),
                &mut translations,
                &mut translation_bytes,
            )
        } == 0
            || bounded_version_translation_count(translation_bytes).is_none()
            || !version_block_contains_range(
                &storage,
                byte_count as usize,
                translations.cast_const(),
                translation_bytes as usize,
            )
        {
            return None;
        }
        let translation_count = bounded_version_translation_count(translation_bytes)?;
        for index in 0..translation_count {
            // SAFETY: each translation is two adjacent u16 values within translation_bytes.
            let language =
                unsafe { std::ptr::read_unaligned(translations.cast::<u16>().add(index * 2)) };
            // SAFETY: same bounds proof as above for the second u16.
            let code_page =
                unsafe { std::ptr::read_unaligned(translations.cast::<u16>().add(index * 2 + 1)) };
            let product_name = query_bounded_version_string(
                &storage,
                byte_count as usize,
                language,
                code_page,
                "ProductName",
            );
            let file_description = query_bounded_version_string(
                &storage,
                byte_count as usize,
                language,
                code_page,
                "FileDescription",
            );
            let company_name = query_bounded_version_string(
                &storage,
                byte_count as usize,
                language,
                code_page,
                "CompanyName",
            );
            let original_filename = query_bounded_version_string(
                &storage,
                byte_count as usize,
                language,
                code_page,
                "OriginalFilename",
            );
            if let (
                Some(product_name),
                Some(file_description),
                Some(company_name),
                Some(original_filename),
            ) = (
                product_name,
                file_description,
                company_name,
                original_filename,
            ) {
                return Some(WindowsFileVersionStrings {
                    product_name,
                    file_description,
                    company_name,
                    original_filename,
                });
            }
        }
        None
    }

    fn query_bounded_version_string(
        storage: &[usize],
        block_bytes: usize,
        language: u16,
        code_page: u16,
        key: &str,
    ) -> Option<String> {
        let query = wide_literal(&format!(
            r"\StringFileInfo\{language:04x}{code_page:04x}\{key}"
        ));
        let mut value = null_mut();
        let mut character_count = 0u32;
        // SAFETY: version block/query are live and the API returns an interior UTF-16 string.
        if unsafe {
            VerQueryValueW(
                storage.as_ptr().cast(),
                query.as_ptr(),
                &mut value,
                &mut character_count,
            )
        } == 0
        {
            return None;
        }
        let character_count = character_count as usize;
        let value_bytes = character_count.checked_mul(size_of::<u16>())?;
        if !bounded_version_string_length(character_count)
            || !version_block_contains_range(storage, block_bytes, value.cast_const(), value_bytes)
        {
            return None;
        }
        // SAFETY: the preceding block-range and hard-limit checks prove this interior slice is
        // initialized and bounded by the single GetFileVersionInfoW allocation.
        let units = unsafe { std::slice::from_raw_parts(value.cast::<u16>(), character_count) };
        decode_bounded_version_string(units)
    }

    fn bounded_version_translation_count(translation_bytes: u32) -> Option<usize> {
        const MAX_VERSION_TRANSLATIONS: usize = 32;

        if translation_bytes < 4 || !translation_bytes.is_multiple_of(4) {
            return None;
        }
        let count = translation_bytes as usize / 4;
        (count <= MAX_VERSION_TRANSLATIONS).then_some(count)
    }

    fn bounded_version_string_length(character_count: usize) -> bool {
        const MAX_VERSION_FIELD_UTF16_UNITS: usize = 512;

        (2..=MAX_VERSION_FIELD_UTF16_UNITS).contains(&character_count)
    }

    fn decode_bounded_version_string(units: &[u16]) -> Option<String> {
        if !bounded_version_string_length(units.len()) {
            return None;
        }
        let (&terminator, value_units) = units.split_last()?;
        if terminator != 0 || value_units.is_empty() || value_units.contains(&0) {
            return None;
        }
        String::from_utf16(value_units).ok()
    }

    fn version_block_contains_range<T>(
        storage: &[usize],
        block_bytes: usize,
        pointer: *const T,
        range_bytes: usize,
    ) -> bool {
        if pointer.is_null() || range_bytes == 0 || block_bytes > size_of_val(storage) {
            return false;
        }
        let block_start = storage.as_ptr() as usize;
        let Some(block_end) = block_start.checked_add(block_bytes) else {
            return false;
        };
        let range_start = pointer as usize;
        range_start >= block_start
            && range_start
                .checked_add(range_bytes)
                .is_some_and(|range_end| range_end <= block_end)
    }

    fn windows_paths_equal(left: &Path, right: &Path) -> bool {
        left.to_string_lossy()
            .eq_ignore_ascii_case(&right.to_string_lossy())
    }

    fn windows_path_is_within(path: &Path, directory: &Path) -> bool {
        let path = path.to_string_lossy().to_ascii_lowercase();
        let mut directory = directory.to_string_lossy().to_ascii_lowercase();
        if !directory.ends_with('\\') && !directory.ends_with('/') {
            directory.push('\\');
        }
        path.starts_with(&directory)
    }

    fn wide_literal(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn encode_command_line(
        program: &OsStr,
        args: &[OsString],
    ) -> Result<Vec<u16>, SupervisedProcessError> {
        let mut encoded = Vec::new();
        append_quoted_argument(&mut encoded, program)?;
        for arg in args {
            encoded.push(b' ' as u16);
            append_quoted_argument(&mut encoded, arg)?;
        }
        encoded.push(0);
        Ok(encoded)
    }

    fn append_quoted_argument(
        output: &mut Vec<u16>,
        argument: &OsStr,
    ) -> Result<(), SupervisedProcessError> {
        let units = argument.encode_wide().collect::<Vec<_>>();
        if units.contains(&0) {
            return Err(SupervisedProcessError::new(
                SupervisedProcessErrorKind::Spawn,
                "supervised process argument contains a NUL character",
            ));
        }
        let needs_quotes = units.is_empty()
            || units
                .iter()
                .any(|unit| *unit == 0x20 || *unit == 0x09 || *unit == b'"' as u16);
        if !needs_quotes {
            output.extend_from_slice(&units);
            return Ok(());
        }
        output.push(b'"' as u16);
        let mut backslashes = 0usize;
        for unit in units {
            if unit == b'\\' as u16 {
                backslashes += 1;
            } else if unit == b'"' as u16 {
                output.extend(std::iter::repeat_n(b'\\' as u16, backslashes * 2 + 1));
                output.push(unit);
                backslashes = 0;
            } else {
                output.extend(std::iter::repeat_n(b'\\' as u16, backslashes));
                output.push(unit);
                backslashes = 0;
            }
        }
        output.extend(std::iter::repeat_n(b'\\' as u16, backslashes * 2));
        output.push(b'"' as u16);
        Ok(())
    }

    fn wide_nul(value: &OsStr, context: &str) -> Result<Vec<u16>, SupervisedProcessError> {
        let mut wide = value.encode_wide().collect::<Vec<_>>();
        if wide.contains(&0) {
            return Err(SupervisedProcessError::new(
                SupervisedProcessErrorKind::Spawn,
                format!("{context} contains a NUL character"),
            ));
        }
        wide.push(0);
        Ok(wide)
    }

    fn duration_to_wait_millis(duration: Duration) -> u32 {
        duration.as_millis().clamp(1, u32::MAX as u128) as u32
    }

    fn last_error(kind: SupervisedProcessErrorKind, context: &str) -> SupervisedProcessError {
        // SAFETY: GetLastError has no preconditions and is called immediately after failure.
        let code = unsafe { GetLastError() };
        SupervisedProcessError::new(kind, format!("{context} failed with Windows error {code}"))
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::{
            fs,
            io::Write,
            os::windows::{ffi::OsStringExt, io::AsRawHandle},
            path::PathBuf,
            process::{Child, Command, Stdio},
            time::{SystemTime, UNIX_EPOCH},
        };
        use windows_sys::Win32::{
            Foundation::LocalFree,
            System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE},
            UI::Shell::CommandLineToArgvW,
        };

        struct ChildGuard(Child);

        impl Drop for ChildGuard {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }

        struct JunctionGuard(PathBuf);

        impl JunctionGuard {
            fn create(link: PathBuf, target: &Path) -> Self {
                let status = Command::new("cmd.exe")
                    .args(["/d", "/c", "mklink", "/J"])
                    .arg(&link)
                    .arg(target)
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status()
                    .expect("invoke mklink for junction fixture");
                assert!(status.success(), "create junction fixture");
                Self(link)
            }
        }

        impl Drop for JunctionGuard {
            fn drop(&mut self) {
                let _ = fs::remove_dir(&self.0);
            }
        }

        struct FixtureDirectory(PathBuf);

        impl Drop for FixtureDirectory {
            fn drop(&mut self) {
                let _ = fs::remove_file(self.0.join("descendant.pid"));
                let _ = fs::remove_file(self.0.join("descendant.ack"));
                let _ = fs::remove_dir(&self.0);
            }
        }

        struct TempTree(PathBuf);

        impl TempTree {
            fn new(label: &str) -> Self {
                let path = env::temp_dir().join(format!(
                    "c137-{label}-{}-{}",
                    std::process::id(),
                    SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .expect("clock")
                        .as_nanos()
                ));
                fs::create_dir(&path).expect("create temp tree");
                Self(path)
            }
        }

        impl Drop for TempTree {
            fn drop(&mut self) {
                if self.0.starts_with(env::temp_dir()) {
                    let _ = fs::remove_dir_all(&self.0);
                }
            }
        }

        #[test]
        fn command_line_quoting_preserves_windows_arguments() {
            let args = vec![
                OsString::from("plain"),
                OsString::from("space here"),
                OsString::from(r#"ends-with-\"#),
                OsString::from(r#"quote\"here"#),
                OsString::new(),
            ];
            let encoded = encode_command_line(OsStr::new(r"C:\Program Files\tool.exe"), &args)
                .expect("encode");
            assert_eq!(encoded.last(), Some(&0));
            let mut count = 0i32;
            // SAFETY: encoded is a live NUL-terminated UTF-16 command line. Shell32 allocates the
            // returned argv block, which is released exactly once with LocalFree below.
            let argv = unsafe { CommandLineToArgvW(encoded.as_ptr(), &mut count) };
            assert!(!argv.is_null());
            assert_eq!(count, args.len() as i32 + 1);
            let decoded = (0..count)
                .map(|index| {
                    // SAFETY: CommandLineToArgvW returned count live NUL-terminated string pointers.
                    let pointer = unsafe { *argv.add(index as usize) };
                    let mut length = 0usize;
                    // SAFETY: pointer addresses a NUL-terminated UTF-16 argument.
                    while unsafe { *pointer.add(length) } != 0 {
                        length += 1;
                    }
                    // SAFETY: the preceding scan established the exact initialized string length.
                    OsString::from_wide(unsafe { std::slice::from_raw_parts(pointer, length) })
                })
                .collect::<Vec<_>>();
            // SAFETY: argv is the allocation returned by CommandLineToArgvW and is freed once.
            unsafe { LocalFree(argv.cast()) };
            let expected = std::iter::once(OsString::from(r"C:\Program Files\tool.exe"))
                .chain(args)
                .collect::<Vec<_>>();
            assert_eq!(decoded, expected);
        }

        #[test]
        fn bounded_version_resource_helpers_reject_oversized_or_malformed_data() {
            assert_eq!(bounded_version_translation_count(4), Some(1));
            assert_eq!(bounded_version_translation_count(32 * 4), Some(32));
            assert_eq!(bounded_version_translation_count(0), None);
            assert_eq!(bounded_version_translation_count(6), None);
            assert_eq!(bounded_version_translation_count(33 * 4), None);

            let mut largest_valid = vec![b'a' as u16; 511];
            largest_valid.push(0);
            assert_eq!(
                decode_bounded_version_string(&largest_valid),
                Some("a".repeat(511))
            );
            let mut oversized = vec![b'a' as u16; 512];
            oversized.push(0);
            assert_eq!(decode_bounded_version_string(&oversized), None);
            assert_eq!(decode_bounded_version_string(&[b'a' as u16]), None);
            assert_eq!(
                decode_bounded_version_string(&[b'a' as u16, 0, b'b' as u16, 0]),
                None
            );
            assert_eq!(decode_bounded_version_string(&[0xD800, 0]), None);

            let storage = vec![0usize; 4];
            let inside = storage.as_ptr().cast::<u8>().wrapping_add(8);
            assert!(version_block_contains_range(&storage, 24, inside, 16));
            assert!(!version_block_contains_range(&storage, 24, inside, 17));
            assert!(!version_block_contains_range(
                &storage,
                size_of_val(storage.as_slice()) + 1,
                inside,
                1,
            ));
        }

        #[test]
        fn shimgen_identity_requires_all_four_bounded_fields() {
            let executable = Path::new("ffmpeg.exe");
            let mut version = WindowsFileVersionStrings {
                product_name: "ShimGen generated shim - Chocolatey Shim".into(),
                file_description: "ShimGen generated shim - Chocolatey Shim".into(),
                company_name: "Chocolatey Software, Inc.".into(),
                original_filename: "ffmpeg.exe".into(),
            };
            assert!(version_identifies_chocolatey_shimgen(executable, &version));
            version.original_filename = "ffprobe.exe".into();
            assert!(!version_identifies_chocolatey_shimgen(executable, &version));
        }

        #[test]
        fn trusted_path_walk_rejects_parent_traversal_before_canonicalization() {
            let tree = TempTree::new("chocolatey-parent-traversal");
            let child = tree.0.join("child");
            fs::create_dir(&child).expect("create child");
            let error = validate_absolute_path_without_reparse(
                &child.join(".."),
                TrustedPathKind::Directory,
            )
            .expect_err("parent traversal must fail closed");
            assert!(error.to_string().contains("parent traversal"));
        }

        #[test]
        fn trusted_path_walk_rejects_a_directory_junction_before_canonicalization() {
            let tree = TempTree::new("chocolatey-root-junction");
            let target = tree.0.join("real-root");
            fs::create_dir(&target).expect("create junction target");
            let junction = tree.0.join("configured-root");
            let _junction_guard = JunctionGuard::create(junction.clone(), &target);

            let error = canonicalize_no_reparse(&junction, TrustedPathKind::Directory)
                .expect_err("configured root junction must fail closed");
            assert!(error.to_string().contains("reparse point"));
        }

        #[test]
        fn chocolatey_package_search_requires_exactly_one_real_executable() {
            let tree = TempTree::new("chocolatey-search");
            let library = tree.0.join("lib");
            let first = library.join("ffmpeg").join("tools").join("bin");
            fs::create_dir_all(&first).expect("create first package");
            let first_executable = first.join("ffmpeg.exe");
            fs::write(&first_executable, b"first-real-binary").expect("write first executable");
            let excluded_shim = tree.0.join("bin").join("ffmpeg.exe");
            let canonical_library = library.canonicalize().expect("canonical library");

            let resolved = find_unique_chocolatey_package_executable(
                &canonical_library,
                OsStr::new("ffmpeg.exe"),
                &excluded_shim,
            )
            .expect("one candidate must resolve");
            assert_eq!(resolved, first_executable.canonicalize().unwrap());

            let second = library.join("other-package").join("tools");
            fs::create_dir_all(&second).expect("create second package");
            fs::write(second.join("ffmpeg.exe"), b"second-real-binary")
                .expect("write second executable");
            let error = find_unique_chocolatey_package_executable(
                &canonical_library,
                OsStr::new("ffmpeg.exe"),
                &excluded_shim,
            )
            .expect_err("multiple candidates must fail closed");
            assert!(error.to_string().contains("exactly one"));
        }

        #[test]
        fn chocolatey_package_search_rejects_an_unexplored_deep_candidate() {
            let tree = TempTree::new("chocolatey-depth");
            let library = tree.0.join("lib");
            fs::create_dir_all(library.join("shallow")).expect("create shallow package");
            fs::write(library.join("shallow").join("ffmpeg.exe"), b"shallow")
                .expect("write shallow candidate");
            let mut deep = library.join("deep");
            for index in 0..13 {
                deep = deep.join(format!("level-{index}"));
            }
            fs::create_dir_all(&deep).expect("create deep package");
            fs::write(deep.join("ffmpeg.exe"), b"deep").expect("write deep candidate");
            let canonical_library = library.canonicalize().expect("canonical library");

            let error = find_unique_chocolatey_package_executable(
                &canonical_library,
                OsStr::new("ffmpeg.exe"),
                &tree.0.join("bin").join("ffmpeg.exe"),
            )
            .expect_err("an unexplored deep directory must invalidate uniqueness");
            assert!(error.to_string().contains("depth hard limit"));
        }

        #[test]
        fn chocolatey_package_search_rejects_an_unrelated_directory_junction() {
            let tree = TempTree::new("chocolatey-junction");
            let library = tree.0.join("lib");
            let package = library.join("ffmpeg").join("tools");
            let junction_target = tree.0.join("outside-library");
            fs::create_dir_all(&package).expect("create package");
            fs::create_dir(&junction_target).expect("create junction target");
            fs::write(package.join("ffmpeg.exe"), b"real-binary").expect("write real candidate");
            let junction = library.join("unrelated-junction");
            let _junction_guard = JunctionGuard::create(junction.clone(), &junction_target);
            let attributes = fs::symlink_metadata(&junction)
                .expect("junction metadata")
                .file_attributes();
            assert_ne!(attributes & FILE_ATTRIBUTE_REPARSE_POINT, 0);

            let error = find_unique_chocolatey_package_executable(
                &library.canonicalize().expect("canonical library"),
                OsStr::new("ffmpeg.exe"),
                &tree.0.join("bin").join("ffmpeg.exe"),
            )
            .expect_err("any traversed reparse point must invalidate the search");
            assert!(error.to_string().contains("reparse point"));
        }

        #[test]
        fn installed_chocolatey_shim_resolves_to_a_non_shim_package_binary() {
            let Ok(path_entry) = resolve_executable_path(OsStr::new("ffmpeg")) else {
                return;
            };
            if !is_verified_chocolatey_shimgen(&path_entry) {
                return;
            }
            let resolved = resolve_executable(OsStr::new("ffmpeg"))
                .expect("installed Chocolatey shim must resolve uniquely");
            assert!(!windows_paths_equal(&resolved, &path_entry));
            assert!(!is_verified_chocolatey_shimgen(&resolved));
            assert!(resolved.is_file());
        }

        #[test]
        #[ignore = "ChocolateyInstall-missing fail-closed helper"]
        fn missing_chocolatey_install_helper() {
            assert!(env::var_os("ChocolateyInstall").is_none());
            let Ok(path_entry) = resolve_executable_path(OsStr::new("ffmpeg")) else {
                return;
            };
            if !is_verified_chocolatey_shimgen(&path_entry) {
                return;
            }
            let error = resolve_verified_chocolatey_shim(&path_entry)
                .expect_err("a verified shim without ChocolateyInstall must fail closed");
            assert!(error
                .to_string()
                .contains("ChocolateyInstall is unavailable"));
        }

        #[test]
        fn verified_shim_never_runs_when_chocolatey_install_is_missing() {
            let status = Command::new(env::current_exe().expect("current test executable"))
                .args([
                    "--ignored",
                    "--exact",
                    "process_supervision::platform::tests::missing_chocolatey_install_helper",
                    "--nocapture",
                ])
                .env_remove("ChocolateyInstall")
                .status()
                .expect("run isolated ChocolateyInstall test");
            assert!(status.success());
        }

        const STREAMING_TEST_PAYLOAD_BYTES: usize = 512 * 1024;

        fn supervised_streaming_helper_command(test_name: &str) -> SupervisedCommand {
            let mut command = SupervisedCommand::new(
                env::current_exe().expect("current test executable for streaming helper"),
            );
            command.args(["--ignored", "--exact", test_name, "--nocapture"]);
            command
        }

        fn supervised_streaming_test_limits(
            stdout_hard_limit: usize,
            stderr_hard_limit: usize,
        ) -> SupervisedStreamingLimits {
            SupervisedStreamingLimits {
                process: SupervisedOutputLimits {
                    execution_timeout: Duration::from_secs(5),
                    output_drain_timeout: Duration::from_secs(2),
                    termination_timeout: Duration::from_secs(2),
                    poll_interval: Duration::from_millis(2),
                    stdout_hard_limit,
                    stderr_hard_limit,
                },
                stdout_chunk_size: 4 * 1024,
                stdout_buffered_chunks: 1,
                stdout_inactivity_timeout: None,
            }
        }

        #[test]
        #[ignore = "supervised streaming stdout payload helper"]
        fn streaming_stdout_payload_helper() {
            let stdout = std::io::stdout();
            let mut stdout = stdout.lock();
            let block = [0xA5u8; 4096];
            for _ in 0..STREAMING_TEST_PAYLOAD_BYTES / block.len() {
                stdout.write_all(&block).expect("write streaming payload");
            }
            stdout.flush().expect("flush streaming payload");
            eprintln!("streaming-stderr-marker");
        }

        #[test]
        #[ignore = "supervised streaming stderr overflow helper"]
        fn streaming_stderr_overflow_helper() {
            let stderr = std::io::stderr();
            let mut stderr = stderr.lock();
            let block = [0xB6u8; 4096];
            for _ in 0..64 {
                stderr.write_all(&block).expect("write oversized stderr");
            }
            stderr.flush().expect("flush oversized stderr");
            println!("stdout-remains-streamed");
        }

        #[test]
        #[ignore = "supervised streaming stdout inactivity helper"]
        fn streaming_stdout_inactivity_helper() {
            let stdout = std::io::stdout();
            let mut stdout = stdout.lock();
            stdout
                .write_all(b"initial-stream-progress")
                .expect("write initial streaming progress");
            stdout.flush().expect("flush initial streaming progress");
            thread::sleep(Duration::from_secs(5));
        }

        #[test]
        fn streaming_stdout_is_chunked_with_bounded_backpressure_and_bounded_stderr() {
            let command = supervised_streaming_helper_command(
                "process_supervision::platform::tests::streaming_stdout_payload_helper",
            );
            let mut payload_bytes = 0usize;
            let mut maximum_chunk = 0usize;
            let mut chunk_count = 0usize;
            let output = command
                .stream_stdout(
                    supervised_streaming_test_limits(2 * 1024 * 1024, 64 * 1024),
                    || false,
                    |chunk| {
                        maximum_chunk = maximum_chunk.max(chunk.len());
                        payload_bytes += chunk.iter().filter(|byte| **byte == 0xA5).count();
                        chunk_count += 1;
                        // A one-slot queue plus a deliberately slower consumer exercises actual
                        // reader/pipe backpressure without retaining the complete payload.
                        thread::sleep(Duration::from_millis(1));
                        Ok(())
                    },
                )
                .expect("streaming process must complete");

            assert!(output.status.success());
            assert_eq!(payload_bytes, STREAMING_TEST_PAYLOAD_BYTES);
            assert!(output.stdout_bytes >= STREAMING_TEST_PAYLOAD_BYTES);
            assert!(chunk_count > 32);
            assert!(maximum_chunk <= 4 * 1024);
            assert!(String::from_utf8_lossy(&output.stderr).contains("streaming-stderr-marker"));
        }

        #[test]
        fn streaming_stdout_total_hard_limit_still_terminates_the_owned_process() {
            let command = supervised_streaming_helper_command(
                "process_supervision::platform::tests::streaming_stdout_payload_helper",
            );
            let error = command
                .stream_stdout(
                    supervised_streaming_test_limits(32 * 1024, 64 * 1024),
                    || false,
                    |_| Ok(()),
                )
                .expect_err("streaming stdout must retain a total hard limit");
            assert_eq!(error.kind(), SupervisedProcessErrorKind::StdoutOverflow);
        }

        #[test]
        fn streaming_stderr_hard_limit_is_enforced_while_stdout_is_streamed() {
            let command = supervised_streaming_helper_command(
                "process_supervision::platform::tests::streaming_stderr_overflow_helper",
            );
            let error = command
                .stream_stdout(
                    supervised_streaming_test_limits(64 * 1024, 4 * 1024),
                    || false,
                    |_| Ok(()),
                )
                .expect_err("streaming stderr must remain bounded");
            assert_eq!(error.kind(), SupervisedProcessErrorKind::StderrOverflow);
        }

        #[test]
        fn streaming_stdout_inactivity_terminates_the_owned_process() {
            let command = supervised_streaming_helper_command(
                "process_supervision::platform::tests::streaming_stdout_inactivity_helper",
            );
            let mut limits = supervised_streaming_test_limits(64 * 1024, 64 * 1024);
            limits.stdout_inactivity_timeout = Some(Duration::from_millis(150));
            let error = command
                .stream_stdout(limits, || false, |_| Ok(()))
                .expect_err("silent streaming process must not occupy the worker indefinitely");

            assert_eq!(error.kind(), SupervisedProcessErrorKind::NoProgress);
            assert!(!process_supervision_cleanup_faulted());
        }

        #[test]
        fn streaming_consumer_failure_terminates_instead_of_leaking_a_blocked_writer() {
            let command = supervised_streaming_helper_command(
                "process_supervision::platform::tests::streaming_stdout_payload_helper",
            );
            let error = command
                .stream_stdout(
                    supervised_streaming_test_limits(2 * 1024 * 1024, 64 * 1024),
                    || false,
                    |chunk| {
                        if chunk.contains(&0xA5) {
                            Err("fixture consumer rejected a chunk".to_string())
                        } else {
                            Ok(())
                        }
                    },
                )
                .expect_err("consumer failure must abort the owned process tree");
            assert_eq!(error.kind(), SupervisedProcessErrorKind::Reader);
        }

        #[test]
        #[ignore = "supervised streaming cancellation descendant helper"]
        fn streaming_cancellation_descendant_helper() {
            let descendant = Command::new("ping.exe")
                .args(["-t", "127.0.0.1"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .expect("spawn streaming descendant");
            fs::write("streaming-descendant.pid", descendant.id().to_string())
                .expect("record streaming descendant pid");
            let ack_deadline = Instant::now() + Duration::from_secs(2);
            while !Path::new("streaming-descendant.ack").is_file() && Instant::now() < ack_deadline
            {
                thread::sleep(Duration::from_millis(2));
            }
            assert!(
                Path::new("streaming-descendant.ack").is_file(),
                "parent did not bind streaming descendant handle"
            );
            std::mem::forget(descendant);

            let stdout = std::io::stdout();
            let mut stdout = stdout.lock();
            let block = [0xF3u8; 4096];
            loop {
                stdout.write_all(&block).expect("write cancellable stream");
                stdout.flush().expect("flush cancellable stream");
            }
        }

        #[test]
        fn streaming_cancellation_kills_the_owned_job_descendant() {
            let fixture_directory = FixtureDirectory(env::temp_dir().join(format!(
                "c137-process-streaming-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .expect("clock")
                    .as_nanos()
            )));
            fs::create_dir(&fixture_directory.0).expect("create streaming fixture directory");
            let marker_path = fixture_directory.0.join("streaming-descendant.pid");
            let ack_path = fixture_directory.0.join("streaming-descendant.ack");
            let descendant_monitor = thread::spawn(move || -> Result<usize, String> {
                let deadline = Instant::now() + Duration::from_secs(2);
                loop {
                    if let Ok(pid_text) = fs::read_to_string(&marker_path) {
                        let pid = pid_text
                            .parse::<u32>()
                            .map_err(|error| format!("parse streaming descendant pid: {error}"))?;
                        // SAFETY: the helper waits for the ack before it emits the cancellation
                        // marker, so this handle binds the just-created descendant before teardown.
                        let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
                        if !handle.is_null() {
                            fs::write(&ack_path, b"bound")
                                .map_err(|error| format!("write streaming ack: {error}"))?;
                            return Ok(handle as usize);
                        }
                    }
                    if Instant::now() >= deadline {
                        return Err(
                            "streaming descendant marker did not yield a live handle".into()
                        );
                    }
                    thread::sleep(Duration::from_millis(2));
                }
            });

            let mut command = supervised_streaming_helper_command(
                "process_supervision::platform::tests::streaming_cancellation_descendant_helper",
            );
            command.current_dir(&fixture_directory.0);
            let cancelled = Arc::new(AtomicBool::new(false));
            let cancellation_check = cancelled.clone();
            let cancellation_signal = cancelled.clone();
            let started = Instant::now();
            let error = command
                .stream_stdout(
                    supervised_streaming_test_limits(8 * 1024 * 1024, 64 * 1024),
                    move || cancellation_check.load(Ordering::Acquire),
                    move |chunk| {
                        if chunk.contains(&0xF3) {
                            cancellation_signal.store(true, Ordering::Release);
                        }
                        Ok(())
                    },
                )
                .expect_err("streaming cancellation must stop the process tree");
            assert_eq!(error.kind(), SupervisedProcessErrorKind::Cancelled);
            assert!(started.elapsed() < Duration::from_secs(4));

            let descendant_handle = descendant_monitor
                .join()
                .expect("streaming descendant monitor panicked")
                .expect("bind streaming descendant handle")
                as HANDLE;
            let descendant_wait = unsafe { WaitForSingleObject(descendant_handle, 0) };
            unsafe { CloseHandle(descendant_handle) };
            assert_eq!(
                descendant_wait, WAIT_OBJECT_0,
                "streaming Job descendant survived bounded cancellation cleanup"
            );
        }

        #[test]
        #[ignore = "staggered supervised stderr descendant helper"]
        fn staggered_stderr_descendant_helper() {
            thread::sleep(Duration::from_millis(450));
            eprintln!("stderr-late-from-descendant");
            std::io::stderr().flush().expect("flush delayed stderr");
        }

        #[test]
        #[ignore = "staggered supervised reader root helper"]
        fn staggered_reader_root_helper() {
            let descendant = Command::new(env::current_exe().expect("current test executable"))
                .args([
                    "--ignored",
                    "--exact",
                    "process_supervision::platform::tests::staggered_stderr_descendant_helper",
                    "--nocapture",
                ])
                .stdout(Stdio::null())
                .stderr(Stdio::inherit())
                .spawn()
                .expect("spawn delayed stderr descendant");
            let stdout = std::io::stdout();
            {
                let mut locked = stdout.lock();
                writeln!(locked, "stdout-completes-first").expect("write early stdout");
                locked.flush().expect("flush early stdout");
            }
            let stdout_handle = stdout.as_raw_handle() as HANDLE;
            assert!(!stdout_handle.is_null(), "stdout handle must be live");
            // SAFETY: this isolated helper owns its inherited process stdout handle for the
            // remainder of its short lifetime and deliberately closes it exactly once to create
            // EOF while the root process is still alive.
            assert_ne!(unsafe { CloseHandle(stdout_handle) }, 0);

            eprintln!("stderr-from-root");
            std::io::stderr().flush().expect("flush root stderr");
            // Give the supervisor several polls in which stdout is complete while the root is
            // still running. The descendant retains stderr beyond root exit and completes it
            // later, establishing the exact ordering that used to lose stdout via Option::take.
            thread::sleep(Duration::from_millis(150));
            std::mem::forget(descendant);
        }

        #[test]
        fn staggered_reader_completion_preserves_the_first_stream_result() {
            let mut command = SupervisedCommand::new(
                env::current_exe().expect("current test executable for staggered reader"),
            );
            command.args([
                "--ignored",
                "--exact",
                "process_supervision::platform::tests::staggered_reader_root_helper",
                "--nocapture",
            ]);
            let output = command
                .output(
                    SupervisedOutputLimits {
                        execution_timeout: Duration::from_secs(5),
                        output_drain_timeout: Duration::from_secs(2),
                        termination_timeout: Duration::from_secs(2),
                        poll_interval: Duration::from_millis(5),
                        stdout_hard_limit: 64 * 1024,
                        stderr_hard_limit: 64 * 1024,
                    },
                    || false,
                )
                .expect("staggered reader results must both survive until Job completion");
            assert!(output.status.success());
            let stdout = String::from_utf8(output.stdout).expect("UTF-8 stdout fixture");
            let stderr = String::from_utf8(output.stderr).expect("UTF-8 stderr fixture");
            assert!(stdout.contains("stdout-completes-first"));
            assert!(stderr.contains("stderr-from-root"));
            assert!(stderr.contains("stderr-late-from-descendant"));
        }

        #[test]
        #[ignore = "process-supervision descendant helper"]
        fn descendant_pipe_holder_helper() {
            let descendant = Command::new("ping.exe")
                .args(["127.0.0.1", "-n", "6", "-w", "1000"])
                .spawn()
                .expect("spawn descendant");
            fs::write("descendant.pid", descendant.id().to_string())
                .expect("record descendant pid");
            println!("descendant={}", descendant.id());
            std::io::stdout().flush().expect("flush descendant pid");
            let ack_deadline = Instant::now() + Duration::from_secs(2);
            while !Path::new("descendant.ack").is_file() && Instant::now() < ack_deadline {
                thread::sleep(Duration::from_millis(2));
            }
            assert!(
                Path::new("descendant.ack").is_file(),
                "parent did not bind descendant handle"
            );
            std::mem::forget(descendant);
        }

        #[test]
        fn timeout_kills_only_the_owned_job_tree_and_does_not_wait_forever() {
            let mut collateral = ChildGuard(
                Command::new("ping.exe")
                    .args(["-t", "127.0.0.1"])
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .spawn()
                    .expect("spawn collateral process"),
            );
            let fixture_directory = FixtureDirectory(env::temp_dir().join(format!(
                "c137-process-supervision-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .expect("clock")
                    .as_nanos()
            )));
            fs::create_dir(&fixture_directory.0).expect("create fixture directory");
            let executable = env::current_exe().expect("current test executable");
            let mut command = SupervisedCommand::new(executable);
            command.current_dir(&fixture_directory.0);
            command.args([
                "--ignored",
                "--exact",
                "process_supervision::platform::tests::descendant_pipe_holder_helper",
                "--nocapture",
            ]);
            let marker_path = fixture_directory.0.join("descendant.pid");
            let ack_path = fixture_directory.0.join("descendant.ack");
            let descendant_monitor = thread::spawn(move || -> Result<usize, String> {
                let deadline = Instant::now() + Duration::from_secs(2);
                loop {
                    if let Ok(pid_text) = fs::read_to_string(&marker_path) {
                        let pid = pid_text
                            .parse::<u32>()
                            .map_err(|error| format!("parse descendant pid: {error}"))?;
                        // SAFETY: the helper remains alive until this monitor writes the ack, so
                        // this PID still names its just-created descendant and cannot be reused.
                        let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
                        if !handle.is_null() {
                            fs::write(&ack_path, b"bound")
                                .map_err(|error| format!("write descendant ack: {error}"))?;
                            return Ok(handle as usize);
                        }
                    }
                    if Instant::now() >= deadline {
                        return Err("descendant marker did not yield a live process handle".into());
                    }
                    thread::sleep(Duration::from_millis(2));
                }
            });
            let started = Instant::now();
            let error = command
                .output(
                    SupervisedOutputLimits {
                        execution_timeout: Duration::from_millis(400),
                        output_drain_timeout: Duration::from_millis(200),
                        termination_timeout: Duration::from_secs(2),
                        poll_interval: Duration::from_millis(5),
                        stdout_hard_limit: 64 * 1024,
                        stderr_hard_limit: 64 * 1024,
                    },
                    || false,
                )
                .expect_err("persistent descendant must reach the deadline");
            assert_eq!(error.kind(), SupervisedProcessErrorKind::Timeout);
            assert!(started.elapsed() < Duration::from_secs(4));

            let descendant_handle = descendant_monitor
                .join()
                .expect("descendant monitor panicked")
                .expect("bind descendant handle") as HANDLE;
            let descendant_wait = unsafe { WaitForSingleObject(descendant_handle, 0) };
            unsafe { CloseHandle(descendant_handle) };
            assert_eq!(
                descendant_wait, WAIT_OBJECT_0,
                "Job descendant survived bounded cleanup"
            );

            let collateral_handle =
                unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, collateral.0.id()) };
            assert!(!collateral_handle.is_null());
            let collateral_wait = unsafe { WaitForSingleObject(collateral_handle, 0) };
            unsafe { CloseHandle(collateral_handle) };
            assert_eq!(
                collateral_wait, WAIT_TIMEOUT,
                "collateral process was killed"
            );

            collateral.0.kill().expect("stop collateral process");
            collateral.0.wait().expect("reap collateral process");
        }
    }
}

#[cfg(not(windows))]
mod platform {
    use super::*;
    use std::{process::Command, time::Instant};

    pub(super) fn resolve_supervised_executable(
        _program: &OsStr,
    ) -> Result<PathBuf, SupervisedProcessError> {
        Err(SupervisedProcessError::new(
            SupervisedProcessErrorKind::Spawn,
            "safe executable resolution is currently supported only on Windows",
        ))
    }

    pub(super) fn run_supervised_output<F>(
        command: &SupervisedCommand,
        limits: SupervisedOutputLimits,
        is_cancelled: F,
    ) -> Result<SupervisedOutput, SupervisedProcessError>
    where
        F: Fn() -> bool,
    {
        // C137's ownership guarantee is a Windows Job Object contract.  Fail closed elsewhere
        // instead of silently providing root-only termination under the same API name.
        let _ = (
            command,
            limits,
            is_cancelled,
            Command::new(""),
            Instant::now(),
        );
        Err(SupervisedProcessError::new(
            SupervisedProcessErrorKind::Spawn,
            "safe process-tree supervision is currently supported only on Windows",
        ))
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub(super) fn run_supervised_streaming<F, C>(
        command: &SupervisedCommand,
        limits: SupervisedStreamingLimits,
        is_cancelled: F,
        consume_stdout: C,
    ) -> Result<SupervisedStreamingOutput, SupervisedProcessError>
    where
        F: Fn() -> bool,
        C: FnMut(&[u8]) -> Result<(), String>,
    {
        // Keep the streaming API under the same fail-closed Windows Job Object contract as the
        // collecting API; do not silently degrade to root-process-only supervision elsewhere.
        let _ = (
            command,
            limits,
            is_cancelled,
            consume_stdout,
            Command::new(""),
            Instant::now(),
        );
        Err(SupervisedProcessError::new(
            SupervisedProcessErrorKind::Spawn,
            "safe process-tree supervision is currently supported only on Windows",
        ))
    }
}
