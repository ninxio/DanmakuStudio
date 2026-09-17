import { useEffect, useMemo, useRef } from "react";
import {
  buildAlignmentMultimodalRuleSnapshot
} from "../../domain/alignment/alignmentMultimodalRuleSnapshot";
import type { EditorProject } from "../../domain/project/types";
import { multimodalRuleSnapshotRuleSetKey } from "../../infrastructure/alignment/multimodalRuleSnapshotArchive";
import { ensureDesktopMultimodalRuleSnapshot } from "../../infrastructure/alignment/multimodalRuleSnapshotArchiveStore";

export function MultimodalRuleSnapshotAutoArchive({
  project
}: {
  project: EditorProject;
}) {
  const lastRuleSetKey = useRef<string | null>(null);
  const writeInFlight = useRef<string | null>(null);
  const snapshotResult = useMemo(
    () => buildAlignmentMultimodalRuleSnapshot({ mediaTimeMaps: project.mediaTimeMaps }),
    [project.mediaTimeMaps]
  );
  const snapshot = snapshotResult.snapshot;
  const ruleSetKey = useMemo(
    () => (snapshot ? multimodalRuleSnapshotRuleSetKey(snapshot) : null),
    [snapshot]
  );

  useEffect(() => {
    if (!snapshot || !ruleSetKey) {
      lastRuleSetKey.current = null;
      return;
    }
    if (
      lastRuleSetKey.current === ruleSetKey ||
      writeInFlight.current === ruleSetKey
    ) {
      return;
    }
    writeInFlight.current = ruleSetKey;
    let active = true;
    void ensureDesktopMultimodalRuleSnapshot(snapshot)
      .then(() => {
        lastRuleSetKey.current = ruleSetKey;
        writeInFlight.current = null;
      })
      .catch((error: unknown) => {
        writeInFlight.current = null;
        if (!active) return;
        console.warn(
          "视觉对照规则自动归档失败；核心匹配结果不受影响。",
          error
        );
      });
    return () => {
      active = false;
    };
  }, [ruleSetKey, snapshot]);

  return null;
}
