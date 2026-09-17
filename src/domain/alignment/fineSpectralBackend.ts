export interface SpectralBackendExecutionIdentity {
  backendId: string;
  requestedBackend: string;
  backendDetail: string;
  fallbackReason: string | null;
}

const CUDA_SPECTRAL_BACKEND_ID = "cuda-cufft-r2c-512-v1";
const CPU_SPECTRAL_BACKEND_ID = "cpu-radix2-f64-r2c-512-v1";
const CPU_COMPATIBLE_COARSE_BACKEND_IDS = new Set([
  CPU_SPECTRAL_BACKEND_ID,
  "cpu-streaming-radix2-f64-r2c-512-v1",
  "cuda-cufft-r2c-512+cpu-streaming-radix2-f64-v1"
]);

/** Mirrors Rust lock_fine_spectral_backend_request for cross-boundary evidence validation. */
export function deriveLockedFineSpectralBackendIdentity(
  coarse: SpectralBackendExecutionIdentity
): SpectralBackendExecutionIdentity | null {
  if (coarse.backendId === CUDA_SPECTRAL_BACKEND_ID) {
    return {
      backendId: CUDA_SPECTRAL_BACKEND_ID,
      requestedBackend: coarse.requestedBackend,
      backendDetail: coarse.backendDetail,
      fallbackReason: coarse.fallbackReason
    };
  }
  if (!CPU_COMPATIBLE_COARSE_BACKEND_IDS.has(coarse.backendId)) return null;
  return {
    backendId: CPU_SPECTRAL_BACKEND_ID,
    requestedBackend: coarse.requestedBackend,
    backendDetail:
      "CPU radix-2 f64 FFT; fineBackendLock=cpu-after-coarse; " +
      `coarseBackend=${coarse.backendId}; coarseDetail=${coarse.backendDetail}`,
    fallbackReason: coarse.fallbackReason
  };
}

export function isLockedFineSpectralBackendIdentity(
  coarse: SpectralBackendExecutionIdentity,
  fine: SpectralBackendExecutionIdentity
): boolean {
  const locked = deriveLockedFineSpectralBackendIdentity(coarse);
  return (
    locked !== null &&
    fine.backendId === locked.backendId &&
    fine.requestedBackend === locked.requestedBackend &&
    fine.backendDetail === locked.backendDetail &&
    fine.fallbackReason === locked.fallbackReason
  );
}
