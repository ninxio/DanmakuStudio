import { invoke, isTauri } from "@tauri-apps/api/core";

export type CudaFftCapabilityStatus =
  | "ready"
  | "driver_library_missing"
  | "cufft_library_missing"
  | "driver_initialization_failed"
  | "device_unavailable"
  | "cufft_initialization_failed"
  | "runtime_panicked";

export interface CudaFftMemoryBudget {
  batchFrames: number;
  inputBytes: number;
  outputBytes: number;
  worstCaseCufftWorkspaceBytes: number;
  worstCaseTotalDeviceBytes: number;
}

export interface CudaFftCapability {
  backendId: string;
  bindingsVersion: string;
  available: boolean;
  status: CudaFftCapabilityStatus;
  reason: string;
  remediation: string | null;
  driverLibraryLoaded: boolean;
  driverLibraryName: string | null;
  cufftLibraryLoaded: boolean;
  cufftLibraryName: string | null;
  driverRuntimeVersion: number | null;
  cufftRuntimeVersion: number | null;
  deviceCount: number | null;
  selectedDeviceOrdinal: number | null;
  selectedDeviceName: string | null;
  defaultBatchMemory: CudaFftMemoryBudget;
}

export type CudaFftCapabilityInvoker = (deviceOrdinal: number) => Promise<CudaFftCapability>;

export async function probeCudaFftCapability(
  deviceOrdinal = 0,
  invoker: CudaFftCapabilityInvoker = defaultInvoker
): Promise<CudaFftCapability> {
  if (!Number.isSafeInteger(deviceOrdinal) || deviceOrdinal < 0) {
    throw new RangeError("CUDA 设备序号必须是非负整数。");
  }
  if (invoker === defaultInvoker && !isTauri()) {
    throw new Error("CUDA/cuFFT 能力检测需要在 Tauri 桌面端运行。");
  }
  return invoker(deviceOrdinal);
}

function defaultInvoker(deviceOrdinal: number): Promise<CudaFftCapability> {
  return invoke<CudaFftCapability>("probe_cuda_fft_capability", { deviceOrdinal });
}
