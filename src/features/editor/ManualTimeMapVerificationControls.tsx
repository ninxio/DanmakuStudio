import { isPlaybackAdopted } from "../../domain/alignment/playbackAdoption";
import { useState } from "react";
import { TextButton } from "../../components/TextButton";
import {
  assessManualMediaTimeMapVerificationEligibility,
  assessMediaTimeMapVerification
} from "../../domain/alignment/mediaTimeMap";
import {
  isTimeMapManualTakeoverExportApproved,
  readTimeMapManualTakeover
} from "../../domain/alignment/timeMapReviewDecision";
import type { MediaTimeMap } from "../../domain/project/types";
import { isManualVerificationAuthorityAvailable } from "../../infrastructure/media/manualVerificationAuthority";
import { useEditorStore } from "../../stores/editorStore";

const MANUAL_VERIFICATION_ARTIFACT_ID = "manual-a-b-review";
const MANUAL_VERIFICATION_ARTIFACT_VERSION = "1";
const MANUAL_VERIFIER = "本机用户";

export function ManualTimeMapVerificationControls({ timeMap }: { timeMap: MediaTimeMap }) {
  const issueManualVerification = useEditorStore(
    (state) => state.issueManualMediaTimeMapVerification
  );
  const revokeManualVerification = useEditorStore(
    (state) => state.revokeManualMediaTimeMapVerification
  );
  const [busy, setBusy] = useState(false);
  const persistedRecord =
    timeMap.verification?.recordVersion === 2 && timeMap.verification.revocation === null
      ? timeMap.verification
      : null;
  const verificationAssessment = assessMediaTimeMapVerification(timeMap);
  const manualTakeoverAt = readTimeMapManualTakeover(timeMap);
  const trustedRecord =
    persistedRecord && verificationAssessment.trusted ? persistedRecord : null;
  if (manualTakeoverAt && isTimeMapManualTakeoverExportApproved(timeMap)) {
    return (
      <section
        className="mt-3 rounded border border-feedback-warning/30 bg-feedback-warning/10 p-2.5 text-ui-caption"
        data-testid="manual-time-map-verification"
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-feedback-warning">
            {isPlaybackAdopted(timeMap) ? "已采用用于播放" : "人工接管方案"}
          </span>
          <span className="rounded border border-feedback-warning/40 bg-feedback-warning/10 px-2 py-0.5 text-feedback-warning">
            已允许导出
          </span>
          {trustedRecord ? (
            <span className="text-content-muted">既有本机签名仍保留</span>
          ) : null}
        </div>
        <p className="mt-1.5 leading-5 text-content-muted">
          你已于 {new Date(manualTakeoverAt).toLocaleString("zh-CN")} 明确采用当前人工方案。
          导出不会再被自动质量门槛重复否决；未验证区间和潜在错位仍保留在诊断中。
        </p>
      </section>
    );
  }
  const desktopAvailable = isManualVerificationAuthorityAvailable();
  const preflightInput = {
    calibrationArtifactId: MANUAL_VERIFICATION_ARTIFACT_ID,
    calibrationArtifactVersion: MANUAL_VERIFICATION_ARTIFACT_VERSION,
    verifier: MANUAL_VERIFIER,
    verifiedAt: new Date().toISOString()
  };
  const eligibility = assessManualMediaTimeMapVerificationEligibility(timeMap, preflightInput);
  const disabledReason = !desktopAvailable
    ? "安装级人工验证只在 Tauri 桌面端可用；浏览器预览不能签发或撤销凭据。"
    : eligibility.reason;

  const issue = async () => {
    if (!desktopAvailable || !eligibility.eligible || busy) return;
    setBusy(true);
    try {
      await issueManualVerification(timeMap.id, {
        ...preflightInput,
        verifiedAt: new Date().toISOString()
      });
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    if (!desktopAvailable || !trustedRecord || busy) return;
    setBusy(true);
    try {
      await revokeManualVerification(timeMap.id, {
        reason: "用户在编辑工作台撤销了人工 A/B 复核验证。",
        revokedBy: MANUAL_VERIFIER,
        revokedAt: new Date().toISOString()
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="mt-3 rounded border border-feedback-success/25 bg-feedback-success/10 p-2.5 text-ui-caption"
      data-testid="manual-time-map-verification"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-content-secondary">
          {manualTakeoverAt ? "人工方案签发" : "整图人工验证"}
        </span>
        {trustedRecord ? (
          <span className="rounded border border-feedback-success/40 bg-feedback-success/10 px-2 py-0.5 text-feedback-success">
            本机签名已验证
          </span>
        ) : persistedRecord ? (
          <span className="rounded border border-feedback-warning/40 bg-feedback-warning/10 px-2 py-0.5 text-feedback-warning">
            签名记录未在本机受信
          </span>
        ) : null}
        {trustedRecord ? (
          <TextButton
            className="ml-auto"
            tone="danger"
            disabled={!desktopAvailable || busy}
            onClick={() => void revoke()}
          >
            撤销人工验证
          </TextButton>
        ) : (
          <TextButton
            className="ml-auto"
            tone="primary"
            disabled={!desktopAvailable || !eligibility.eligible || busy}
            onClick={() => void issue()}
          >
            {manualTakeoverAt ? "签发人工方案并允许导出" : "完成复核并签发"}
          </TextButton>
        )}
      </div>
      <p className="mt-1.5 leading-5 text-content-muted">
        {manualTakeoverAt
          ? `你已于 ${new Date(manualTakeoverAt).toLocaleString("zh-CN")} 接管该候选。签发后允许导出，但诊断中的未验证区间不会被删除。`
          : "只有明确点击后，应用才会把当前 TimeMap、媒体身份和复核证据交给本机安装级验证机构签名。"}
      </p>
      {trustedRecord ? (
        <p className="mt-1 leading-5 text-content-muted">
          签发人：{trustedRecord.verifier} · 时间：
          {new Date(trustedRecord.verifiedAt).toLocaleString("zh-CN")} · 凭据：
          {trustedRecord.verificationId}
        </p>
      ) : persistedRecord ? (
        <p className="mt-1 leading-5 text-feedback-warning" role="status">
          当前签名不能作为导出依据：
          {verificationAssessment.reason ?? "本机验证机构尚未确认该签名。"}
          {eligibility.eligible ? " 可在完整复核后重新签发。" : ` ${eligibility.reason ?? ""}`}
        </p>
      ) : disabledReason ? (
        <p className="mt-1 leading-5 text-feedback-warning" role="status">
          当前不能签发：{disabledReason}
        </p>
      ) : (
        <p className="mt-1 leading-5 text-feedback-success">
          已通过签发预检；请确认完成所有 A/B 试听后再签发。
        </p>
      )}
    </section>
  );
}
