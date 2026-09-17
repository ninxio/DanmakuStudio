export type SafeAlignmentFailureCode =
  | "blocked:cuda-fft-unavailable"
  | "blocked:cuda-fft-runtime"
  | "blocked:spectral-backend-config"
  | "blocked:spectral-backend-policy-mismatch"
  | "blocked:spectral-backend-continuity"
  | "blocked:spectral-backend-identity";

export interface SafeAlignmentFailureDisclosure {
  code: SafeAlignmentFailureCode;
  message: string;
}

const SAFE_DISCLOSURES: Readonly<Record<SafeAlignmentFailureCode, string>> = {
  "blocked:cuda-fft-unavailable":
    "强制 GPU 已安全停止：CUDA/cuFFT 能力不可用。修复建议：在设置中运行“检测 4090 / CUDA”，安装或修复 NVIDIA 驱动与 CUDA Toolkit/cuFFT 后完全重启应用。",
  "blocked:cuda-fft-runtime":
    "强制 GPU 已安全停止：CUDA/cuFFT 执行失败，且未回退 CPU。修复建议：检查驱动、CUDA Toolkit/cuFFT 与设备稳定性；如需继续，可明确改为“自动推荐”或“强制 CPU”后重试。",
  "blocked:spectral-backend-config":
    "声谱计算策略配置无效，任务已安全停止。修复建议：在设置中重新选择“自动推荐”“强制 GPU”或“强制 CPU”。",
  "blocked:spectral-backend-policy-mismatch":
    "声谱制品与本次 CPU/GPU 策略不一致，任务已安全停止。修复建议：保持同一次运行的计算策略一致，并重新开始匹配。",
  "blocked:spectral-backend-continuity":
    "粗匹配与精匹配的声谱后端不连续，任务已安全停止。修复建议：重新开始匹配；若问题持续，请切换为“强制 CPU”进行基线复核。",
  "blocked:spectral-backend-identity":
    "原生结果缺少可验证的声谱后端身份，任务已安全停止。修复建议：重新开始匹配，并确认应用与原生组件来自同一版本。"
};

const TRUSTED_ERROR_CODE_PREFIXES = ["音频对齐任务启动失败："] as const;

export function discloseKnownAlignmentFailure(
  error: unknown
): SafeAlignmentFailureDisclosure | null {
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : null;
  if (!text) return null;
  for (const code of Object.keys(SAFE_DISCLOSURES) as SafeAlignmentFailureCode[]) {
    if (containsExactErrorCode(text, code)) {
      return { code, message: SAFE_DISCLOSURES[code] };
    }
  }
  return null;
}

function containsExactErrorCode(text: string, code: SafeAlignmentFailureCode): boolean {
  const candidate = unwrapTrustedErrorCodePrefix(text);
  if (!candidate.startsWith(code)) return false;
  const next = candidate[code.length];
  return next === undefined || next === ":" || next === "：" || /\s/.test(next);
}

function unwrapTrustedErrorCodePrefix(text: string): string {
  for (const prefix of TRUSTED_ERROR_CODE_PREFIXES) {
    if (text.startsWith(prefix)) {
      return text.slice(prefix.length);
    }
  }
  return text;
}
