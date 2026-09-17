import { describe, expect, it, vi } from "vitest";
import { probeCudaFftCapability, type CudaFftCapability } from "./cudaFftCapability";

const READY: CudaFftCapability = {
  backendId: "cuda-cufft-r2c-512-v1",
  bindingsVersion: "CUDA 13.x ABI via cudarc 0.19.8",
  available: true,
  status: "ready",
  reason: "smoke transform succeeded",
  remediation: null,
  driverLibraryLoaded: true,
  driverLibraryName: "nvcuda.dll",
  cufftLibraryLoaded: true,
  cufftLibraryName: "cufft64_12.dll",
  driverRuntimeVersion: 13030,
  cufftRuntimeVersion: 12300,
  deviceCount: 1,
  selectedDeviceOrdinal: 0,
  selectedDeviceName: "NVIDIA GeForce RTX 4090",
  defaultBatchMemory: {
    batchFrames: 4096,
    inputBytes: 8_388_608,
    outputBytes: 8_421_376,
    worstCaseCufftWorkspaceBytes: 134_217_728,
    worstCaseTotalDeviceBytes: 151_027_712
  }
};

describe("probeCudaFftCapability", () => {
  it("返回原生 smoke test 的完整设备与内存证据", async () => {
    const invoker = vi.fn(() => Promise.resolve(READY));

    await expect(probeCudaFftCapability(0, invoker)).resolves.toEqual(READY);
    expect(invoker).toHaveBeenCalledWith(0);
  });

  it("在调用原生层前拒绝无效设备序号", async () => {
    const invoker = vi.fn(() => Promise.resolve(READY));

    await expect(probeCudaFftCapability(-1, invoker)).rejects.toThrow("CUDA 设备序号");
    expect(invoker).not.toHaveBeenCalled();
  });
});
