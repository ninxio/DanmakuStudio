//! Optional CUDA/cuFFT backend for the 512-point spectral transform used by C137.
//!
//! This module deliberately keeps CUDA acceleration outside the alignment domain model.
//! A NVIDIA display driver (`nvcuda.dll`) is necessary but not sufficient: readiness is
//! reported only after the CUDA driver and cuFFT libraries load, a device context opens,
//! and a real 512-point R2C plan executes successfully.

use cudarc::{
    cufft::{safe::CudaFft, sys as cufft_sys},
    driver::{safe::CudaContext, safe::CudaStream, sys as driver_sys},
};
use libloading::Library;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fmt,
    mem::size_of,
    panic::{catch_unwind, AssertUnwindSafe},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

pub const CUDA_FFT_BACKEND_ID: &str = "cuda-cufft-r2c-512-v1";
pub const CUDA_FFT_BINDINGS_VERSION: &str = "CUDA 13.x ABI via cudarc 0.19.8";
pub const CUDA_FFT_FRAME_LEN: usize = 512;
pub const CUDA_FFT_BINS_PER_FRAME: usize = CUDA_FFT_FRAME_LEN / 2 + 1;
pub const CUDA_FFT_DEFAULT_BATCH_FRAMES: usize = 4_096;
pub const CUDA_FFT_MAX_BATCH_FRAMES: usize = 16_384;

const CUDA_FFT_INPUT_STRIDE: usize = CUDA_FFT_FRAME_LEN;
const CUDA_FFT_OUTPUT_STRIDE: usize = CUDA_FFT_BINS_PER_FRAME;
const CUFFT_WORST_CASE_COMPLEX_WORK_ELEMENTS_PER_SAMPLE: usize = 8;
const DRIVER_REQUIRED_SYMBOLS: &[&str] = &[
    "cuInit",
    "cuDeviceGetCount",
    "cuDeviceGet",
    "cuDevicePrimaryCtxRetain",
    "cuCtxGetCurrent",
    "cuCtxSetCurrent",
];
const CUFFT_REQUIRED_SYMBOLS: &[&str] = &[
    "cufftGetVersion",
    "cufftPlanMany",
    "cufftSetStream",
    "cufftExecR2C",
    "cufftDestroy",
];

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CudaComplex32 {
    pub real: f32,
    pub imaginary: f32,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CudaFftTransformContract {
    pub backend_id: String,
    pub transform: String,
    pub frame_len: usize,
    pub bins_per_frame: usize,
    pub input_scalar: String,
    pub output_scalar: String,
    pub input_stride: usize,
    pub output_stride: usize,
    pub normalization: String,
    pub frame_order: String,
    pub numeric_equivalence: String,
    pub cancellation_boundary: String,
}

pub fn cuda_fft_r2c_512_contract() -> CudaFftTransformContract {
    CudaFftTransformContract {
        backend_id: CUDA_FFT_BACKEND_ID.to_owned(),
        transform: "batched 1D real-to-complex forward FFT".to_owned(),
        frame_len: CUDA_FFT_FRAME_LEN,
        bins_per_frame: CUDA_FFT_BINS_PER_FRAME,
        input_scalar: "f32, contiguous frame-major [frame][512]".to_owned(),
        output_scalar: "f32 complex, contiguous frame-major [frame][257]".to_owned(),
        input_stride: CUDA_FFT_INPUT_STRIDE,
        output_stride: CUDA_FFT_OUTPUT_STRIDE,
        normalization: "none (cuFFT forward convention, matching the CPU radix-2 path)".to_owned(),
        frame_order: "output frame i and bin k are spectra[i * 257 + k]".to_owned(),
        numeric_equivalence: "compare after f64 promotion with abs <= 1e-3 + 3e-5 * abs(cpu)"
            .to_owned(),
        cancellation_boundary: format!(
            "checked before allocation and before/after every GPU batch; an in-flight cuFFT call is not interrupted; at most {} frames remain in flight",
            CUDA_FFT_MAX_BATCH_FRAMES
        ),
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CudaFftMemoryBudget {
    pub batch_frames: usize,
    pub input_bytes: usize,
    pub output_bytes: usize,
    pub worst_case_cufft_workspace_bytes: usize,
    pub worst_case_total_device_bytes: usize,
}

impl CudaFftMemoryBudget {
    pub fn for_batch(batch_frames: usize) -> Result<Self, CudaFftBatchError> {
        validate_batch_size(batch_frames)?;

        let input_bytes = checked_product(&[batch_frames, CUDA_FFT_FRAME_LEN, size_of::<f32>()])?;
        let output_bytes = checked_product(&[
            batch_frames,
            CUDA_FFT_BINS_PER_FRAME,
            size_of::<CudaComplex32>(),
        ])?;
        // NVIDIA documents an upper bound of 8 * batch * transform elements of
        // cufftComplex workspace for a single-precision plan. Actual 512-point plans
        // normally consume less; this conservative bound is used for admission control.
        let worst_case_cufft_workspace_bytes = checked_product(&[
            CUFFT_WORST_CASE_COMPLEX_WORK_ELEMENTS_PER_SAMPLE,
            batch_frames,
            CUDA_FFT_FRAME_LEN,
            size_of::<CudaComplex32>(),
        ])?;
        let worst_case_total_device_bytes = input_bytes
            .checked_add(output_bytes)
            .and_then(|value| value.checked_add(worst_case_cufft_workspace_bytes))
            .ok_or_else(|| CudaFftBatchError::invalid("CUDA 设备内存预算计算溢出"))?;

        Ok(Self {
            batch_frames,
            input_bytes,
            output_bytes,
            worst_case_cufft_workspace_bytes,
            worst_case_total_device_bytes,
        })
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CudaFftCapabilityStatus {
    Ready,
    DriverLibraryMissing,
    CufftLibraryMissing,
    DriverInitializationFailed,
    DeviceUnavailable,
    CufftInitializationFailed,
    RuntimePanicked,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CudaFftCapability {
    pub backend_id: String,
    pub bindings_version: String,
    pub available: bool,
    pub status: CudaFftCapabilityStatus,
    pub reason: String,
    pub remediation: Option<String>,
    pub driver_library_loaded: bool,
    pub driver_library_name: Option<String>,
    pub cufft_library_loaded: bool,
    pub cufft_library_name: Option<String>,
    pub driver_runtime_version: Option<i32>,
    pub cufft_runtime_version: Option<i32>,
    pub device_count: Option<i32>,
    pub selected_device_ordinal: Option<usize>,
    pub selected_device_name: Option<String>,
    pub default_batch_memory: CudaFftMemoryBudget,
    pub contract: CudaFftTransformContract,
}

/// Probes the whole executable path. Merely finding an NVIDIA driver never produces
/// `Ready`; the function must also execute a cuFFT R2C smoke transform.
#[tauri::command]
pub fn probe_cuda_fft_capability(device_ordinal: usize) -> CudaFftCapability {
    let default_batch_memory = CudaFftMemoryBudget::for_batch(CUDA_FFT_DEFAULT_BATCH_FRAMES)
        .expect("the compile-time CUDA FFT default batch must have a valid memory budget");

    let driver_probe = probe_dynamic_library(&["cuda", "nvcuda"], DRIVER_REQUIRED_SYMBOLS);
    if !driver_probe.loaded {
        return capability_unavailable(
            CudaFftCapabilityStatus::DriverLibraryMissing,
            driver_probe.reason.clone(),
            driver_probe,
            DynamicLibraryProbe::not_attempted("CUDA 驱动缺失，因此未继续检测 cuFFT。"),
            default_batch_memory,
        );
    }

    let cufft_probe = probe_dynamic_library(&["cufft"], CUFFT_REQUIRED_SYMBOLS);
    if !cufft_probe.loaded {
        return capability_unavailable(
            CudaFftCapabilityStatus::CufftLibraryMissing,
            format!(
                "{} 仅有 NVIDIA 驱动不能启用 GPU FFT；请确认 CUDA Toolkit 13.x 的 bin 与 bin\\x64 已写入 PATH，然后完全退出并重新启动应用。",
                cufft_probe.reason
            ),
            driver_probe,
            cufft_probe,
            default_batch_memory,
        );
    }

    let guarded = catch_unwind(AssertUnwindSafe(|| probe_cudarc_stack(device_ordinal)));
    match guarded {
        Ok(Ok(ready)) => CudaFftCapability {
            backend_id: CUDA_FFT_BACKEND_ID.to_owned(),
            bindings_version: CUDA_FFT_BINDINGS_VERSION.to_owned(),
            available: true,
            status: CudaFftCapabilityStatus::Ready,
            reason: "CUDA context 与 512 点 cuFFT R2C smoke transform 均已通过。".to_owned(),
            remediation: None,
            driver_library_loaded: true,
            driver_library_name: driver_probe.loaded_name,
            cufft_library_loaded: true,
            cufft_library_name: cufft_probe.loaded_name,
            driver_runtime_version: Some(ready.driver_runtime_version),
            cufft_runtime_version: Some(ready.cufft_runtime_version),
            device_count: Some(ready.device_count),
            selected_device_ordinal: Some(device_ordinal),
            selected_device_name: Some(ready.device_name),
            default_batch_memory,
            contract: cuda_fft_r2c_512_contract(),
        },
        Ok(Err(error)) => {
            let mut capability = capability_unavailable(
                error.status,
                error.reason,
                driver_probe,
                cufft_probe,
                default_batch_memory,
            );
            capability.device_count = error.device_count;
            capability.selected_device_ordinal = Some(device_ordinal);
            capability
        }
        Err(payload) => capability_unavailable(
            CudaFftCapabilityStatus::RuntimePanicked,
            format!(
                "CUDA/cuFFT 动态调用发生异常，已安全拦截：{}",
                panic_payload_message(payload)
            ),
            driver_probe,
            cufft_probe,
            default_batch_memory,
        ),
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CudaFftBatchErrorCode {
    InvalidInput,
    BackendUnavailable,
    Cancelled,
    DriverFailure,
    CufftFailure,
    RuntimePanicked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CudaFftBatchError {
    pub code: CudaFftBatchErrorCode,
    pub message: String,
    pub completed_frames: usize,
    pub retryable_on_cpu: bool,
}

impl CudaFftBatchError {
    fn invalid(message: impl Into<String>) -> Self {
        Self {
            code: CudaFftBatchErrorCode::InvalidInput,
            message: message.into(),
            completed_frames: 0,
            retryable_on_cpu: true,
        }
    }

    fn runtime(
        code: CudaFftBatchErrorCode,
        message: impl Into<String>,
        completed_frames: usize,
    ) -> Self {
        Self {
            code,
            message: message.into(),
            completed_frames,
            retryable_on_cpu: true,
        }
    }
}

impl fmt::Display for CudaFftBatchError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{:?}: {}", self.code, self.message)
    }
}

impl std::error::Error for CudaFftBatchError {}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CudaFftBatchOutput {
    pub frame_count: usize,
    pub bins_per_frame: usize,
    pub spectra: Vec<CudaComplex32>,
}

/// Reusable CUDA context, stream, and shape-specific cuFFT plan for C137 extraction.
///
/// Construct one session for an alignment run, then feed it bounded chunks. A plan is
/// created lazily for the first chunk and reused while the frame count remains unchanged.
/// Changing chunk size replaces the old plan before allocating the new workspace, so the
/// per-batch memory budget remains an upper bound.
pub struct CudaFftR2c512Session {
    device_ordinal: usize,
    stream: Arc<CudaStream>,
    active_plan: Option<(usize, CudaFft)>,
    poisoned: bool,
    #[cfg(test)]
    plan_creation_count: usize,
}

impl CudaFftR2c512Session {
    /// Opens one CUDA context after a non-panicking driver/cuFFT library preflight.
    /// The first `transform_batch` call performs actual cuFFT planning and execution.
    pub fn new(device_ordinal: usize) -> Result<Self, CudaFftBatchError> {
        preflight_cuda_fft_runtime()?;
        match catch_unwind(AssertUnwindSafe(|| {
            let device_count = CudaContext::device_count().map_err(|error| {
                CudaFftBatchError::runtime(
                    CudaFftBatchErrorCode::DriverFailure,
                    format!("CUDA 驱动初始化失败：{error}"),
                    0,
                )
            })?;
            if device_count <= 0 || device_ordinal >= device_count as usize {
                return Err(CudaFftBatchError::runtime(
                    CudaFftBatchErrorCode::BackendUnavailable,
                    format!(
                        "CUDA 设备序号 {device_ordinal} 不可用；当前检测到 {device_count} 个设备"
                    ),
                    0,
                ));
            }
            let context = CudaContext::new(device_ordinal).map_err(|error| {
                CudaFftBatchError::runtime(
                    CudaFftBatchErrorCode::DriverFailure,
                    format!("无法打开 CUDA 设备 {device_ordinal}：{error}"),
                    0,
                )
            })?;
            Ok(Self {
                device_ordinal,
                stream: context.default_stream(),
                active_plan: None,
                poisoned: false,
                #[cfg(test)]
                plan_creation_count: 0,
            })
        })) {
            Ok(result) => result,
            Err(payload) => Err(CudaFftBatchError::runtime(
                CudaFftBatchErrorCode::RuntimePanicked,
                format!(
                    "CUDA 会话初始化发生异常，已安全拦截：{}",
                    panic_payload_message(payload)
                ),
                0,
            )),
        }
    }

    pub fn device_ordinal(&self) -> usize {
        self.device_ordinal
    }

    /// Transforms exactly one bounded chunk. Input must contain 1..=16384 complete frames.
    /// The returned buffer is frame-major `[frame][257]`; no partial output is returned.
    pub fn transform_batch(
        &mut self,
        input_frames: &[f32],
        cancellation: &AtomicBool,
    ) -> Result<CudaFftBatchOutput, CudaFftBatchError> {
        validate_input_frames(input_frames, Some(CUDA_FFT_MAX_BATCH_FRAMES))?;
        if self.poisoned {
            return Err(CudaFftBatchError::runtime(
                CudaFftBatchErrorCode::RuntimePanicked,
                "CUDA FFT 会话此前发生异常，当前会话已停止继续使用",
                0,
            ));
        }
        if cancellation.load(Ordering::Acquire) {
            return Err(CudaFftBatchError::runtime(
                CudaFftBatchErrorCode::Cancelled,
                "CUDA FFT 批次在分配内存前已取消",
                0,
            ));
        }

        match catch_unwind(AssertUnwindSafe(|| {
            self.transform_batch_inner(input_frames, cancellation)
        })) {
            Ok(result) => result,
            Err(payload) => {
                self.poisoned = true;
                Err(CudaFftBatchError::runtime(
                    CudaFftBatchErrorCode::RuntimePanicked,
                    format!(
                        "CUDA/cuFFT 批次发生异常，已安全拦截：{}",
                        panic_payload_message(payload)
                    ),
                    0,
                ))
            }
        }
    }

    fn transform_batch_inner(
        &mut self,
        input_frames: &[f32],
        cancellation: &AtomicBool,
    ) -> Result<CudaFftBatchOutput, CudaFftBatchError> {
        let batch_frames = input_frames.len() / CUDA_FFT_FRAME_LEN;
        self.ensure_plan(batch_frames)?;
        let input_device = self.stream.clone_htod(input_frames).map_err(|error| {
            CudaFftBatchError::runtime(
                CudaFftBatchErrorCode::DriverFailure,
                format!("CUDA FFT 批次上传失败：{error}"),
                0,
            )
        })?;
        let mut output_device = self
            .stream
            .alloc_zeros::<cufft_sys::float2>(batch_frames * CUDA_FFT_BINS_PER_FRAME)
            .map_err(|error| {
                CudaFftBatchError::runtime(
                    CudaFftBatchErrorCode::DriverFailure,
                    format!("CUDA FFT 输出内存分配失败：{error}"),
                    0,
                )
            })?;
        let plan = &self
            .active_plan
            .as_ref()
            .ok_or_else(|| {
                CudaFftBatchError::runtime(
                    CudaFftBatchErrorCode::CufftFailure,
                    "cuFFT 执行计划未被正确保留",
                    0,
                )
            })?
            .1;
        plan.exec_r2c(&input_device, &mut output_device)
            .map_err(|error| {
                CudaFftBatchError::runtime(
                    CudaFftBatchErrorCode::CufftFailure,
                    format!("cuFFT R2C 执行失败：{error}"),
                    0,
                )
            })?;
        self.stream.synchronize().map_err(|error| {
            CudaFftBatchError::runtime(
                CudaFftBatchErrorCode::DriverFailure,
                format!("CUDA FFT 流同步失败：{error}"),
                0,
            )
        })?;
        if cancellation.load(Ordering::Acquire) {
            return Err(CudaFftBatchError::runtime(
                CudaFftBatchErrorCode::Cancelled,
                "CUDA FFT 批次在 GPU 完成计算后已取消",
                batch_frames,
            ));
        }
        let output_host: Vec<cufft_sys::float2> =
            self.stream.clone_dtoh(&output_device).map_err(|error| {
                CudaFftBatchError::runtime(
                    CudaFftBatchErrorCode::DriverFailure,
                    format!("CUDA FFT 输出下载失败：{error}"),
                    0,
                )
            })?;
        if cancellation.load(Ordering::Acquire) {
            return Err(CudaFftBatchError::runtime(
                CudaFftBatchErrorCode::Cancelled,
                "CUDA FFT 批次在输出传输后已取消",
                batch_frames,
            ));
        }

        Ok(CudaFftBatchOutput {
            frame_count: batch_frames,
            bins_per_frame: CUDA_FFT_BINS_PER_FRAME,
            spectra: output_host
                .into_iter()
                .map(|value| CudaComplex32 {
                    real: value.x,
                    imaginary: value.y,
                })
                .collect(),
        })
    }

    fn ensure_plan(&mut self, batch_frames: usize) -> Result<(), CudaFftBatchError> {
        if self
            .active_plan
            .as_ref()
            .is_some_and(|(planned_frames, _)| *planned_frames == batch_frames)
        {
            return Ok(());
        }

        drop(self.active_plan.take());
        let plan = CudaFft::plan_many(
            &[CUDA_FFT_FRAME_LEN as i32],
            Some(&[CUDA_FFT_FRAME_LEN as i32]),
            1,
            CUDA_FFT_INPUT_STRIDE as i32,
            Some(&[CUDA_FFT_BINS_PER_FRAME as i32]),
            1,
            CUDA_FFT_OUTPUT_STRIDE as i32,
            cufft_sys::cufftType::CUFFT_R2C,
            batch_frames as i32,
            self.stream.clone(),
        )
        .map_err(|error| {
            CudaFftBatchError::runtime(
                CudaFftBatchErrorCode::CufftFailure,
                format!("批量 cuFFT 执行计划创建失败：{error}"),
                0,
            )
        })?;
        self.active_plan = Some((batch_frames, plan));
        #[cfg(test)]
        {
            self.plan_creation_count = self.plan_creation_count.saturating_add(1);
        }
        Ok(())
    }
}

/// Executes one or more contiguous 512-sample frames through batched cuFFT R2C.
///
/// Cancellation is cooperative at `max_frames_per_gpu_batch` boundaries. If cancellation
/// wins, partial spectra are discarded and `completed_frames` reports the completed prefix,
/// allowing the caller to restart the complete request on CPU without mixing backends.
pub fn r2c_512_batched(
    input_frames: &[f32],
    max_frames_per_gpu_batch: usize,
    cancellation: &AtomicBool,
    device_ordinal: usize,
) -> Result<CudaFftBatchOutput, CudaFftBatchError> {
    validate_batch_size(max_frames_per_gpu_batch)?;
    validate_input_frames(input_frames, None)?;
    if cancellation.load(Ordering::Acquire) {
        return Err(CudaFftBatchError::runtime(
            CudaFftBatchErrorCode::Cancelled,
            "CUDA FFT 请求在分配内存前已取消",
            0,
        ));
    }
    let mut session = CudaFftR2c512Session::new(device_ordinal)?;
    let frame_count = input_frames.len() / CUDA_FFT_FRAME_LEN;
    let output_len = frame_count
        .checked_mul(CUDA_FFT_BINS_PER_FRAME)
        .ok_or_else(|| CudaFftBatchError::invalid("FFT 输出长度计算溢出"))?;
    let mut spectra = Vec::with_capacity(output_len);
    let mut completed_frames = 0usize;

    while completed_frames < frame_count {
        if cancellation.load(Ordering::Acquire) {
            return Err(CudaFftBatchError::runtime(
                CudaFftBatchErrorCode::Cancelled,
                "CUDA FFT 请求在批次边界已取消",
                completed_frames,
            ));
        }

        let batch_frames = (frame_count - completed_frames).min(max_frames_per_gpu_batch);
        let input_start = completed_frames * CUDA_FFT_FRAME_LEN;
        let input_end = input_start + batch_frames * CUDA_FFT_FRAME_LEN;
        let batch_output = session
            .transform_batch(&input_frames[input_start..input_end], cancellation)
            .map_err(|mut error| {
                error.completed_frames = error.completed_frames.saturating_add(completed_frames);
                error
            })?;
        spectra.extend(batch_output.spectra);
        completed_frames += batch_frames;
    }

    Ok(CudaFftBatchOutput {
        frame_count,
        bins_per_frame: CUDA_FFT_BINS_PER_FRAME,
        spectra,
    })
}

#[derive(Debug)]
struct DynamicLibraryProbe {
    loaded: bool,
    loaded_name: Option<String>,
    reason: String,
}

impl DynamicLibraryProbe {
    fn not_attempted(reason: impl Into<String>) -> Self {
        Self {
            loaded: false,
            loaded_name: None,
            reason: reason.into(),
        }
    }
}

fn probe_dynamic_library(logical_names: &[&str], required_symbols: &[&str]) -> DynamicLibraryProbe {
    let mut candidates = Vec::new();
    let mut seen = HashSet::new();
    for logical_name in logical_names {
        for candidate in cudarc::get_lib_name_candidates(logical_name) {
            if seen.insert(candidate.clone()) {
                candidates.push(candidate);
            }
        }
    }

    let mut load_errors = Vec::new();
    for candidate in &candidates {
        // SAFETY: The library is opened only for symbol-presence validation and remains
        // alive while symbols are inspected. No untrusted symbol is invoked here.
        match unsafe { Library::new(candidate) } {
            Ok(library) => {
                let mut missing_symbols = Vec::new();
                for symbol in required_symbols {
                    // SAFETY: We never dereference or call the symbol. The pointer type is
                    // used solely to ask libloading whether the exported name exists.
                    if unsafe {
                        library
                            .get::<*const core::ffi::c_void>(symbol.as_bytes())
                            .is_err()
                    } {
                        missing_symbols.push(*symbol);
                    }
                }
                if missing_symbols.is_empty() {
                    return DynamicLibraryProbe {
                        loaded: true,
                        loaded_name: Some(candidate.clone()),
                        reason: format!("已加载 {candidate}，并找到全部必需符号。"),
                    };
                }
                load_errors.push(format!(
                    "{candidate} 缺少符号 {}",
                    missing_symbols.join(", ")
                ));
            }
            Err(error) => load_errors.push(format!("{candidate}: {error}")),
        }
    }

    let logical_label = logical_names.join("/");
    DynamicLibraryProbe {
        loaded: false,
        loaded_name: None,
        reason: if load_errors.is_empty() {
            format!("没有为 {logical_label} 生成可检测的动态库候选。")
        } else {
            format!(
                "无法加载可用的 {logical_label} 动态库（已检测 {} 个候选）。",
                candidates.len()
            )
        },
    }
}

struct ReadyStackProbe {
    driver_runtime_version: i32,
    cufft_runtime_version: i32,
    device_count: i32,
    device_name: String,
}

struct StackProbeError {
    status: CudaFftCapabilityStatus,
    reason: String,
    device_count: Option<i32>,
}

fn probe_cudarc_stack(device_ordinal: usize) -> Result<ReadyStackProbe, StackProbeError> {
    let device_count = CudaContext::device_count().map_err(|error| StackProbeError {
        status: CudaFftCapabilityStatus::DriverInitializationFailed,
        reason: format!("CUDA 驱动初始化失败：{error}"),
        device_count: None,
    })?;
    if device_count <= 0 || device_ordinal >= device_count as usize {
        return Err(StackProbeError {
            status: CudaFftCapabilityStatus::DeviceUnavailable,
            reason: format!(
                "CUDA 设备序号 {device_ordinal} 不可用；检测到 {device_count} 个设备。"
            ),
            device_count: Some(device_count),
        });
    }

    let context = CudaContext::new(device_ordinal).map_err(|error| StackProbeError {
        status: CudaFftCapabilityStatus::DriverInitializationFailed,
        reason: format!("无法打开 CUDA 设备 {device_ordinal}：{error}"),
        device_count: Some(device_count),
    })?;
    let device_name = context.name().map_err(|error| StackProbeError {
        status: CudaFftCapabilityStatus::DriverInitializationFailed,
        reason: format!("无法读取 CUDA 设备名称：{error}"),
        device_count: Some(device_count),
    })?;

    let mut driver_runtime_version = 0i32;
    // SAFETY: A valid mutable pointer is supplied and the driver library/symbol was
    // preflighted before this function is entered.
    let driver_status = unsafe { driver_sys::cuDriverGetVersion(&mut driver_runtime_version) };
    if driver_status != driver_sys::CUresult::CUDA_SUCCESS {
        return Err(StackProbeError {
            status: CudaFftCapabilityStatus::DriverInitializationFailed,
            reason: format!("cuDriverGetVersion 调用失败：{driver_status:?}"),
            device_count: Some(device_count),
        });
    }

    let mut cufft_runtime_version = 0i32;
    // SAFETY: A valid mutable pointer is supplied and cufftGetVersion was preflighted.
    let cufft_status = unsafe { cufft_sys::cufftGetVersion(&mut cufft_runtime_version) };
    if cufft_status != cufft_sys::cufftResult::CUFFT_SUCCESS {
        return Err(StackProbeError {
            status: CudaFftCapabilityStatus::CufftInitializationFailed,
            reason: format!("cufftGetVersion 调用失败：{cufft_status:?}"),
            device_count: Some(device_count),
        });
    }

    let stream = context.default_stream();
    let input = stream
        .clone_htod(&[0.0f32; CUDA_FFT_FRAME_LEN])
        .map_err(|error| StackProbeError {
            status: CudaFftCapabilityStatus::DriverInitializationFailed,
            reason: format!("CUDA smoke test 上传失败：{error}"),
            device_count: Some(device_count),
        })?;
    let mut output = stream
        .alloc_zeros::<cufft_sys::float2>(CUDA_FFT_BINS_PER_FRAME)
        .map_err(|error| StackProbeError {
            status: CudaFftCapabilityStatus::DriverInitializationFailed,
            reason: format!("CUDA smoke test 显存分配失败：{error}"),
            device_count: Some(device_count),
        })?;
    let plan = CudaFft::plan_1d(
        CUDA_FFT_FRAME_LEN as i32,
        cufft_sys::cufftType::CUFFT_R2C,
        1,
        stream.clone(),
    )
    .map_err(|error| StackProbeError {
        status: CudaFftCapabilityStatus::CufftInitializationFailed,
        reason: format!("512 点 cuFFT plan 创建失败：{error}"),
        device_count: Some(device_count),
    })?;
    plan.exec_r2c(&input, &mut output)
        .map_err(|error| StackProbeError {
            status: CudaFftCapabilityStatus::CufftInitializationFailed,
            reason: format!("512 点 cuFFT smoke transform 失败：{error}"),
            device_count: Some(device_count),
        })?;
    stream.synchronize().map_err(|error| StackProbeError {
        status: CudaFftCapabilityStatus::DriverInitializationFailed,
        reason: format!("CUDA smoke test 同步失败：{error}"),
        device_count: Some(device_count),
    })?;

    Ok(ReadyStackProbe {
        driver_runtime_version,
        cufft_runtime_version,
        device_count,
        device_name,
    })
}

fn capability_unavailable(
    status: CudaFftCapabilityStatus,
    reason: String,
    driver_probe: DynamicLibraryProbe,
    cufft_probe: DynamicLibraryProbe,
    default_batch_memory: CudaFftMemoryBudget,
) -> CudaFftCapability {
    CudaFftCapability {
        backend_id: CUDA_FFT_BACKEND_ID.to_owned(),
        bindings_version: CUDA_FFT_BINDINGS_VERSION.to_owned(),
        available: false,
        status,
        reason,
        remediation: Some(capability_remediation(status).to_owned()),
        driver_library_loaded: driver_probe.loaded,
        driver_library_name: driver_probe.loaded_name,
        cufft_library_loaded: cufft_probe.loaded,
        cufft_library_name: cufft_probe.loaded_name,
        driver_runtime_version: None,
        cufft_runtime_version: None,
        device_count: None,
        selected_device_ordinal: None,
        selected_device_name: None,
        default_batch_memory,
        contract: cuda_fft_r2c_512_contract(),
    }
}

fn capability_remediation(status: CudaFftCapabilityStatus) -> &'static str {
    match status {
        CudaFftCapabilityStatus::Ready => "无需操作。",
        CudaFftCapabilityStatus::DriverLibraryMissing => {
            "请安装或更新 NVIDIA 显卡驱动，确保系统可加载 nvcuda.dll。"
        }
        CudaFftCapabilityStatus::CufftLibraryMissing => {
            "请安装包含 cuFFT 的 CUDA Toolkit 13.x，把 bin 与 bin\\x64 加入 PATH，然后完全退出并重启应用。"
        }
        CudaFftCapabilityStatus::DeviceUnavailable => {
            "请选择存在的 CUDA 设备序号，并确认 NVIDIA GPU 已启用。"
        }
        CudaFftCapabilityStatus::DriverInitializationFailed => {
            "更新 NVIDIA 驱动后请重启应用；自动模式仍可回退 CPU。"
        }
        CudaFftCapabilityStatus::CufftInitializationFailed => {
            "请修复 CUDA Toolkit/cuFFT 及其运行依赖，然后重启应用。"
        }
        CudaFftCapabilityStatus::RuntimePanicked => {
            "请保留 CPU 自动回退，并检查 CUDA/cuFFT 运行时兼容性后再试。"
        }
    }
}

fn preflight_cuda_fft_runtime() -> Result<(), CudaFftBatchError> {
    let driver_probe = probe_dynamic_library(&["cuda", "nvcuda"], DRIVER_REQUIRED_SYMBOLS);
    if !driver_probe.loaded {
        return Err(CudaFftBatchError::runtime(
            CudaFftBatchErrorCode::BackendUnavailable,
            format!(
                "CUDA 驱动库不可用：{} {}",
                driver_probe.reason,
                capability_remediation(CudaFftCapabilityStatus::DriverLibraryMissing)
            ),
            0,
        ));
    }
    let cufft_probe = probe_dynamic_library(&["cufft"], CUFFT_REQUIRED_SYMBOLS);
    if !cufft_probe.loaded {
        return Err(CudaFftBatchError::runtime(
            CudaFftBatchErrorCode::BackendUnavailable,
            format!(
                "已检测到 NVIDIA 驱动，但 cuFFT runtime 不可用：{} {}",
                cufft_probe.reason,
                capability_remediation(CudaFftCapabilityStatus::CufftLibraryMissing)
            ),
            0,
        ));
    }
    Ok(())
}

fn validate_batch_size(batch_frames: usize) -> Result<(), CudaFftBatchError> {
    if batch_frames == 0 || batch_frames > CUDA_FFT_MAX_BATCH_FRAMES {
        return Err(CudaFftBatchError::invalid(format!(
            "GPU 批次帧数必须位于 1–{CUDA_FFT_MAX_BATCH_FRAMES}。"
        )));
    }
    Ok(())
}

fn validate_input_frames(
    input_frames: &[f32],
    maximum_frames: Option<usize>,
) -> Result<(), CudaFftBatchError> {
    if input_frames.is_empty() || !input_frames.len().is_multiple_of(CUDA_FFT_FRAME_LEN) {
        return Err(CudaFftBatchError::invalid(format!(
            "输入必须包含非空且完整的 {CUDA_FFT_FRAME_LEN} 采样点帧"
        )));
    }
    let frame_count = input_frames.len() / CUDA_FFT_FRAME_LEN;
    if maximum_frames.is_some_and(|maximum| frame_count > maximum) {
        return Err(CudaFftBatchError::invalid(format!(
            "单个可复用会话批次最多可包含 {CUDA_FFT_MAX_BATCH_FRAMES} 帧"
        )));
    }
    Ok(())
}

fn checked_product(values: &[usize]) -> Result<usize, CudaFftBatchError> {
    values.iter().try_fold(1usize, |product, value| {
        product
            .checked_mul(*value)
            .ok_or_else(|| CudaFftBatchError::invalid("CUDA 设备内存预算计算溢出"))
    })
}

fn panic_payload_message(payload: Box<dyn std::any::Any + Send>) -> String {
    if let Some(message) = payload.downcast_ref::<&str>() {
        (*message).to_owned()
    } else if let Some(message) = payload.downcast_ref::<String>() {
        message.clone()
    } else {
        "异常信息不是字符串".to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn contract_exposes_exact_frame_major_r2c_layout() {
        let contract = cuda_fft_r2c_512_contract();

        assert_eq!(contract.frame_len, 512);
        assert_eq!(contract.bins_per_frame, 257);
        assert_eq!(contract.input_stride, 512);
        assert_eq!(contract.output_stride, 257);
        assert!(contract.normalization.starts_with("none"));
    }

    #[test]
    fn memory_budget_includes_documented_worst_case_cufft_workspace() {
        let budget = CudaFftMemoryBudget::for_batch(4_096).expect("valid batch");

        assert_eq!(budget.input_bytes, 4_096 * 512 * 4);
        assert_eq!(budget.output_bytes, 4_096 * 257 * 8);
        assert_eq!(budget.worst_case_cufft_workspace_bytes, 8 * 4_096 * 512 * 8);
        assert_eq!(
            budget.worst_case_total_device_bytes,
            budget.input_bytes + budget.output_bytes + budget.worst_case_cufft_workspace_bytes
        );
    }

    #[test]
    fn invalid_batch_or_frame_shape_is_rejected_before_runtime_probe() {
        let cancellation = AtomicBool::new(false);
        let error =
            r2c_512_batched(&[0.0; 511], 1, &cancellation, 0).expect_err("partial frame must fail");
        assert_eq!(error.code, CudaFftBatchErrorCode::InvalidInput);

        let error =
            r2c_512_batched(&[0.0; 512], 0, &cancellation, 0).expect_err("zero batch must fail");
        assert_eq!(error.code, CudaFftBatchErrorCode::InvalidInput);
    }

    #[test]
    fn missing_library_probe_is_structured_and_never_panics() {
        let probe = probe_dynamic_library(
            &["c137_library_that_does_not_exist_47a66e"],
            &["not_a_symbol"],
        );

        assert!(!probe.loaded);
        assert!(probe.loaded_name.is_none());
        assert!(probe.reason.contains("无法加载可用的"));
    }

    #[test]
    fn live_capability_never_equates_driver_presence_with_cufft_readiness() {
        let capability = probe_cuda_fft_capability(0);

        assert_eq!(
            capability.available,
            capability.status == CudaFftCapabilityStatus::Ready
        );
        if capability.available {
            assert!(capability.driver_library_loaded);
            assert!(capability.cufft_library_loaded);
            assert!(capability.selected_device_name.is_some());
            assert!(capability.cufft_runtime_version.is_some());
        } else if capability.driver_library_loaded && !capability.cufft_library_loaded {
            assert_eq!(
                capability.status,
                CudaFftCapabilityStatus::CufftLibraryMissing
            );
        }
    }

    #[test]
    fn unavailable_backend_returns_error_instead_of_panicking() {
        let capability = probe_cuda_fft_capability(0);
        if capability.available {
            return;
        }

        let cancellation = AtomicBool::new(false);
        let error = r2c_512_batched(&[0.0; 512], 1, &cancellation, 0)
            .expect_err("unavailable backend must return a structured error");
        assert_eq!(error.code, CudaFftBatchErrorCode::BackendUnavailable);
        assert!(error.retryable_on_cpu);
    }

    #[test]
    fn available_backend_executes_batch_and_preserves_impulse_spectrum() {
        let capability = probe_cuda_fft_capability(0);
        let require_cuda = std::env::var("C137_REQUIRE_CUDA_FFT").as_deref() == Ok("1");
        if require_cuda {
            eprintln!(
                "{}",
                serde_json::to_string_pretty(&capability).expect("capability DTO must serialize")
            );
        }
        if !capability.available {
            assert!(
                !require_cuda,
                "CUDA FFT was required for this test but capability probe failed: {}",
                capability.reason
            );
            return;
        }

        let cancellation = AtomicBool::new(false);
        let mut frames = vec![0.0f32; CUDA_FFT_FRAME_LEN * 2];
        frames[0] = 1.0;
        frames[CUDA_FFT_FRAME_LEN] = 1.0;
        let output = r2c_512_batched(&frames, 1, &cancellation, 0)
            .expect("available backend must transform both frames");

        assert_eq!(output.frame_count, 2);
        assert_eq!(output.spectra.len(), 2 * CUDA_FFT_BINS_PER_FRAME);
        for value in output.spectra {
            assert!((value.real - 1.0).abs() <= 1e-4);
            assert!(value.imaginary.abs() <= 1e-4);
        }
    }

    #[test]
    fn reusable_session_reuses_same_shape_plan_and_replaces_changed_shape() {
        let capability = probe_cuda_fft_capability(0);
        if !capability.available {
            return;
        }

        let cancellation = AtomicBool::new(false);
        let mut session = CudaFftR2c512Session::new(0).expect("ready session must open");
        let one_frame = vec![0.0f32; CUDA_FFT_FRAME_LEN];
        session
            .transform_batch(&one_frame, &cancellation)
            .expect("first batch must execute");
        session
            .transform_batch(&one_frame, &cancellation)
            .expect("same-shape batch must reuse the plan");
        assert_eq!(session.plan_creation_count, 1);

        let two_frames = vec![0.0f32; CUDA_FFT_FRAME_LEN * 2];
        session
            .transform_batch(&two_frames, &cancellation)
            .expect("changed-shape batch must execute with a replacement plan");
        session
            .transform_batch(&two_frames, &cancellation)
            .expect("replacement plan must then be reused");
        assert_eq!(session.plan_creation_count, 2);
        assert_eq!(session.device_ordinal(), 0);
    }

    #[test]
    fn available_backend_matches_forward_dft_phase_and_magnitude_contract() {
        let capability = probe_cuda_fft_capability(0);
        if !capability.available {
            return;
        }

        let frame: Vec<f32> = (0..CUDA_FFT_FRAME_LEN)
            .map(|index| {
                let phase = 2.0 * std::f32::consts::PI * index as f32 / CUDA_FFT_FRAME_LEN as f32;
                (17.0 * phase).sin() + 0.25 * (63.0 * phase).cos()
            })
            .collect();
        let cancellation = AtomicBool::new(false);
        let output = r2c_512_batched(&frame, 1, &cancellation, 0)
            .expect("available backend must execute deterministic DFT comparison");

        for (bin, actual) in output.spectra.iter().enumerate() {
            let mut expected_real = 0.0f64;
            let mut expected_imaginary = 0.0f64;
            for (sample_index, sample) in frame.iter().enumerate() {
                let angle = 2.0 * std::f64::consts::PI * bin as f64 * sample_index as f64
                    / CUDA_FFT_FRAME_LEN as f64;
                expected_real += *sample as f64 * angle.cos();
                expected_imaginary -= *sample as f64 * angle.sin();
            }
            let real_tolerance = 1e-3 + 3e-5 * expected_real.abs();
            let imaginary_tolerance = 1e-3 + 3e-5 * expected_imaginary.abs();
            assert!(
                (actual.real as f64 - expected_real).abs() <= real_tolerance,
                "real mismatch at bin {bin}: actual={}, expected={expected_real}",
                actual.real
            );
            assert!(
                (actual.imaginary as f64 - expected_imaginary).abs() <= imaginary_tolerance,
                "imaginary mismatch at bin {bin}: actual={}, expected={expected_imaginary}",
                actual.imaginary
            );
        }
    }

    #[test]
    fn cancellation_before_allocation_is_structured() {
        let cancellation = AtomicBool::new(true);
        let error = r2c_512_batched(&[0.0; CUDA_FFT_FRAME_LEN], 1, &cancellation, 0)
            .expect_err("pre-cancelled request must stop before capability probing");

        assert_eq!(error.code, CudaFftBatchErrorCode::Cancelled);
        assert_eq!(error.completed_frames, 0);
        assert!(error.retryable_on_cpu);
    }
}
