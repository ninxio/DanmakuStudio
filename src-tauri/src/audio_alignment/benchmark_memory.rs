use super::benchmark_telemetry::{AlignmentBenchmarkRunTelemetry, ProcessTreeMemorySample};
use std::{
    collections::HashSet,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};

#[cfg(windows)]
use std::sync::OnceLock;

pub(super) struct AlignmentBenchmarkMemorySampler {
    telemetry: Arc<AlignmentBenchmarkRunTelemetry>,
    baseline_descendants: Arc<HashSet<u32>>,
    stop: Arc<AtomicBool>,
    join_handle: thread::JoinHandle<()>,
}

impl AlignmentBenchmarkMemorySampler {
    pub(super) fn spawn(
        telemetry: Arc<AlignmentBenchmarkRunTelemetry>,
        sample_interval_ms: u64,
        baseline_descendants: HashSet<u32>,
    ) -> Result<Self, String> {
        let baseline_descendants = Arc::new(baseline_descendants);
        let stop = Arc::new(AtomicBool::new(false));
        let thread_telemetry = telemetry.clone();
        let thread_baseline_descendants = baseline_descendants.clone();
        let thread_stop = stop.clone();
        let join_handle = thread::Builder::new()
            .name("alignment-benchmark-memory".to_string())
            .spawn(move || loop {
                let sampled_at = Instant::now();
                thread_telemetry.record_memory_sample(
                    sampled_at,
                    sample_process_tree(),
                    thread_baseline_descendants.as_ref(),
                );
                if thread_stop.load(Ordering::Acquire) {
                    break;
                }
                thread::sleep(Duration::from_millis(sample_interval_ms));
            })
            .map_err(|error| format!("内存采样线程启动失败：{error}"))?;
        Ok(Self {
            telemetry,
            baseline_descendants,
            stop,
            join_handle,
        })
    }

    pub(super) fn stop_and_join(self) {
        let Self {
            telemetry,
            baseline_descendants,
            stop,
            join_handle,
        } = self;
        stop.store(true, Ordering::Release);
        if join_handle.join().is_err() {
            telemetry.record_memory_sample(
                Instant::now(),
                Err("内存采样线程异常退出。".to_string()),
                baseline_descendants.as_ref(),
            );
        }
    }

    #[cfg(test)]
    fn panicking_for_test(
        telemetry: Arc<AlignmentBenchmarkRunTelemetry>,
        baseline_descendants: HashSet<u32>,
    ) -> Self {
        let baseline_descendants = Arc::new(baseline_descendants);
        let stop = Arc::new(AtomicBool::new(false));
        let join_handle = thread::spawn(|| panic!("benchmark memory sampler test panic"));
        Self {
            telemetry,
            baseline_descendants,
            stop,
            join_handle,
        }
    }
}

#[cfg(not(windows))]
pub(super) fn sample_process_tree() -> Result<ProcessTreeMemorySample, String> {
    Err("unsupported：Job Object working-set 采样当前只支持 Windows。".to_string())
}

#[cfg(windows)]
pub(super) fn sample_process_tree() -> Result<ProcessTreeMemorySample, String> {
    let job = accounting_job()?;
    sample_windows_job_hierarchy_memory(job)
}

#[cfg(windows)]
struct AlignmentBenchmarkAccountingJob {
    handle: usize,
}

#[cfg(windows)]
impl AlignmentBenchmarkAccountingJob {
    fn raw(&self) -> windows_sys::Win32::Foundation::HANDLE {
        self.handle as windows_sys::Win32::Foundation::HANDLE
    }
}

#[cfg(windows)]
static ALIGNMENT_BENCHMARK_ACCOUNTING_JOB: OnceLock<
    Result<AlignmentBenchmarkAccountingJob, String>,
> = OnceLock::new();

#[cfg(windows)]
fn accounting_job() -> Result<&'static AlignmentBenchmarkAccountingJob, String> {
    let result = ALIGNMENT_BENCHMARK_ACCOUNTING_JOB.get_or_init(create_accounting_job);
    result.as_ref().map_err(|error| error.clone())
}

#[cfg(windows)]
fn create_accounting_job() -> Result<AlignmentBenchmarkAccountingJob, String> {
    use std::ptr::null;
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        System::{
            JobObjects::{AssignProcessToJobObject, CreateJobObjectW},
            Threading::GetCurrentProcess,
        },
    };

    // SAFETY: null security attributes and name create a private, unnamed Job Object.
    let handle = unsafe { CreateJobObjectW(null(), null()) };
    if handle.is_null() {
        return Err("Windows benchmark accounting Job Object 创建失败。".to_string());
    }
    // The current process becomes the root member once for the application lifetime. Every
    // subsequently spawned media process inherits this job; process_supervision then assigns the
    // suspended child to its private kill-on-close job, forming a nested child job on Windows 8+.
    // SAFETY: handle is an owned job handle and GetCurrentProcess returns the current pseudo handle.
    if unsafe { AssignProcessToJobObject(handle, GetCurrentProcess()) } == 0 {
        // SAFETY: assignment failed, so closing the otherwise-unpublished owned handle is safe.
        unsafe { CloseHandle(handle) };
        return Err(
            "当前进程无法加入 Windows benchmark accounting Job Object；不能生成正式内存证据。"
                .to_string(),
        );
    }
    Ok(AlignmentBenchmarkAccountingJob {
        handle: handle as usize,
    })
}

#[cfg(windows)]
fn sample_windows_job_hierarchy_memory(
    job: &AlignmentBenchmarkAccountingJob,
) -> Result<ProcessTreeMemorySample, String> {
    const MAX_STABLE_MEMBERSHIP_ATTEMPTS: usize = 8;
    for _ in 0..MAX_STABLE_MEMBERSHIP_ATTEMPTS {
        let before = query_windows_job_process_ids(job)?;
        let Ok(working_set_bytes) = read_windows_process_working_sets(&before) else {
            continue;
        };
        let after = query_windows_job_process_ids(job)?;
        if before != after {
            continue;
        }
        let root_pid = std::process::id();
        if before.binary_search(&root_pid).is_err() {
            return Err("Windows benchmark Job Object 成员列表缺少应用根进程。".to_string());
        }
        return Ok(ProcessTreeMemorySample {
            working_set_bytes,
            descendants: before.into_iter().filter(|pid| *pid != root_pid).collect(),
        });
    }
    Err("Windows benchmark Job Object 成员在采样期间持续变化，覆盖不完整。".to_string())
}

#[cfg(windows)]
fn query_windows_job_process_ids(
    job: &AlignmentBenchmarkAccountingJob,
) -> Result<Vec<u32>, String> {
    use std::{mem::size_of, ptr::null_mut};
    use windows_sys::Win32::System::JobObjects::{
        JobObjectBasicProcessIdList, QueryInformationJobObject, JOBOBJECT_BASIC_PROCESS_ID_LIST,
    };

    const MAX_ACCOUNTING_JOB_PROCESSES: usize = 4_096;
    let buffer_bytes = size_of::<JOBOBJECT_BASIC_PROCESS_ID_LIST>()
        .checked_add((MAX_ACCOUNTING_JOB_PROCESSES - 1) * size_of::<usize>())
        .ok_or_else(|| "Windows Job Object PID 缓冲区大小溢出。".to_string())?;
    let word_count = buffer_bytes.div_ceil(size_of::<usize>());
    let mut buffer = vec![0_usize; word_count];
    // SAFETY: buffer is writable, suitably aligned for the documented structure and bounded to u32.
    let queried = unsafe {
        QueryInformationJobObject(
            job.raw(),
            JobObjectBasicProcessIdList,
            buffer.as_mut_ptr().cast(),
            buffer_bytes as u32,
            null_mut(),
        )
    };
    if queried == 0 {
        return Err("Windows benchmark Job Object 成员查询失败或超过 4096 个进程。".to_string());
    }
    // SAFETY: QueryInformationJobObject initialized the structure at the start of buffer.
    let list = unsafe { &*(buffer.as_ptr().cast::<JOBOBJECT_BASIC_PROCESS_ID_LIST>()) };
    let assigned = list.NumberOfAssignedProcesses as usize;
    let returned = list.NumberOfProcessIdsInList as usize;
    if assigned == 0 || assigned != returned || returned > MAX_ACCOUNTING_JOB_PROCESSES {
        return Err("Windows benchmark Job Object 成员列表不完整。".to_string());
    }
    // SAFETY: returned was validated against the allocated variable-length PID array.
    let process_ids = unsafe { std::slice::from_raw_parts(list.ProcessIdList.as_ptr(), returned) };
    let mut pids = process_ids
        .iter()
        .map(|raw_pid| {
            u32::try_from(*raw_pid)
                .map_err(|_| "Windows benchmark Job Object 返回了越界 PID。".to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    pids.sort_unstable();
    if pids.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err("Windows benchmark Job Object 返回了重复 PID。".to_string());
    }
    Ok(pids)
}

#[cfg(windows)]
fn read_windows_process_working_sets(process_ids: &[u32]) -> Result<u64, String> {
    use std::mem::size_of;
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        System::{
            ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS},
            Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
        },
    };

    let mut working_set_bytes = 0_u64;
    for pid in process_ids {
        // SAFETY: pid comes from the owned Job Object membership list; no handle is inherited.
        let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, *pid) };
        if process.is_null() {
            return Err("Windows benchmark Job Object 中至少一个成员无法打开。".to_string());
        }
        let mut counters = PROCESS_MEMORY_COUNTERS {
            cb: size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
            ..PROCESS_MEMORY_COUNTERS::default()
        };
        // SAFETY: process is open and counters points to a writable structure of the given size.
        let read = unsafe {
            GetProcessMemoryInfo(
                process,
                &mut counters,
                size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
            )
        };
        // SAFETY: process is an owned handle returned by OpenProcess.
        unsafe { CloseHandle(process) };
        if read == 0 {
            return Err("Windows benchmark Job Object 成员 working set 读取失败。".to_string());
        }
        working_set_bytes = working_set_bytes
            .checked_add(counters.WorkingSetSize as u64)
            .ok_or_else(|| "Windows benchmark Job Object working set 求和溢出。".to_string())?;
    }
    Ok(working_set_bytes)
}

#[cfg(test)]
mod tests {
    use super::{sample_process_tree, AlignmentBenchmarkMemorySampler};
    use crate::audio_alignment::benchmark_telemetry::{
        AlignmentBenchmarkCacheCounts, AlignmentBenchmarkRunTelemetry,
    };
    use std::{
        collections::HashSet,
        sync::Arc,
        thread,
        time::{Duration, Instant},
    };

    const TEST_SAMPLE_INTERVAL_MS: u64 = 10;

    fn test_telemetry() -> Arc<AlignmentBenchmarkRunTelemetry> {
        Arc::new(AlignmentBenchmarkRunTelemetry::new(
            Instant::now(),
            TEST_SAMPLE_INTERVAL_MS,
            0,
            AlignmentBenchmarkCacheCounts::default(),
        ))
    }

    fn recorded_sample_attempts(telemetry: &AlignmentBenchmarkRunTelemetry) -> u64 {
        let memory = telemetry.snapshot().expect("snapshot telemetry").memory;
        memory.sample_count + memory.failed_sample_count
    }

    #[cfg(windows)]
    #[test]
    fn opaque_sampler_stops_and_records_nothing_after_join() {
        let baseline_descendants = sample_process_tree()
            .expect("capture benchmark process baseline")
            .descendants;
        let telemetry = test_telemetry();
        let sampler = AlignmentBenchmarkMemorySampler::spawn(
            telemetry.clone(),
            TEST_SAMPLE_INTERVAL_MS,
            baseline_descendants,
        )
        .expect("spawn benchmark memory sampler");

        let deadline = Instant::now() + Duration::from_secs(2);
        while telemetry
            .snapshot()
            .expect("snapshot sampler telemetry")
            .memory
            .sample_count
            == 0
        {
            assert!(
                Instant::now() < deadline,
                "sampler did not record a successful sample before the bounded deadline"
            );
            thread::sleep(Duration::from_millis(1));
        }

        sampler.stop_and_join();
        let attempts_after_join = recorded_sample_attempts(telemetry.as_ref());
        thread::sleep(Duration::from_millis(TEST_SAMPLE_INTERVAL_MS * 2));
        assert_eq!(
            recorded_sample_attempts(telemetry.as_ref()),
            attempts_after_join
        );
    }

    #[test]
    fn join_panic_records_one_fail_closed_memory_sample() {
        let telemetry = test_telemetry();
        let sampler =
            AlignmentBenchmarkMemorySampler::panicking_for_test(telemetry.clone(), HashSet::new());

        sampler.stop_and_join();

        let memory = telemetry.snapshot().expect("snapshot telemetry").memory;
        assert_eq!(memory.sample_count, 0);
        assert_eq!(memory.failed_sample_count, 1);
        assert!(!memory.coverage_complete);
    }
}
