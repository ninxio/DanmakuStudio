import { AlertTriangle, CheckCircle2, Sparkles, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { WorkspaceTabs } from "../../components/WorkspaceTabs";
import { WorkspaceMenu } from "../../components/WorkspaceMenu";
import { ToolSheet } from "../../components/ToolSheet";
import { TextButton } from "../../components/TextButton";
import type { ProjectMatchAssessment } from "../../domain/project/matchAssessment";
import type {
  MediaBinding,
  MediaReference,
  ProjectMediaReference,
  ProjectMediaRole
} from "../../domain/project/types";
import { formatTimecode } from "../../domain/shared/time";
import type { WorkspaceIntentRequest } from "../../application/workspaceIntent";
import { EmptyState, Row } from "./assetPanelShared";
import {
  MaterialsSummaryPanel,
  MediaLibrarySection,
  MediaRoleGuidePanel,
  ProjectMatchAssessmentPanel,
  TargetMediaBindingPanel
} from "./materialsPanels";
import type { MediaLibraryItemViewModel } from "./materialsPanelModels";

interface XmlMaterialRow {
  assetId: string;
  color: string;
  fileName: string;
  itemCount: number;
  hasSourceReceipt: boolean;
  sourceMediaId: string | null;
  sourceMediaFileName: string | null;
  earliestMs: number;
  latestMs: number;
  warningCount: number;
}

interface MaterialIntakeSuggestionRow {
  id: string;
  assetId: string;
  assetFileName: string;
  sourceMediaFileName: string;
  targetMediaFileName: string | null;
  episodeLabel: string;
  reason: string;
}

interface MaterialIntakeExceptionRow {
  id: string;
  assetId: string;
  assetFileName: string;
  episodeLabel: string | null;
  message: string;
  candidateFileNames: string[];
}

interface MaterialsWorkspaceViewModel {
  summary: {
    originalCount: number;
    referenceCount: number;
    xmlCount: number;
    unplacedXmlCount: number;
    hasTimeline: boolean;
    unboundXmlCount: number;
    reconnectCount: number;
    audioIssueCount: number;
    firstAudioIssueMediaId: string | null;
    audioBusy: boolean;
    audioPaused: boolean;
    audioCancelling: boolean;
    audioRestartRequired: boolean;
    audioTerminalMessage: string | null;
    workspaceIntentRequest: WorkspaceIntentRequest | null;
  };
  workflow: {
    alignmentEnabled: boolean;
  };
  mediaGroups: {
    targetOriginal: MediaLibraryItemViewModel[];
    bilibiliReference: MediaLibraryItemViewModel[];
  };
  xmlMaterials: {
    importProgress: number | null;
    sourceOptions: Array<{ id: string; name: string }>;
    assetRows: XmlMaterialRow[];
  };
  intakePlan: {
    visible: boolean;
    suggestions: MaterialIntakeSuggestionRow[];
    exceptions: {
      conflicts: MaterialIntakeExceptionRow[];
      unresolved: MaterialIntakeExceptionRow[];
    };
    preservedCount: number;
  };
  legacyCompatibility: {
    binding: MediaBinding | null;
    media: MediaReference | null;
    mediaLibrary: ProjectMediaReference[];
    assessment: ProjectMatchAssessment;
    validatingTarget: boolean;
  };
}

type MaterialsWorkspaceIntent =
  | {
      area: "navigation";
      action: "continueToMatching" | "beginXmlEditing";
    }
  | {
      area: "media";
      action: "requestImport";
      role: ProjectMediaRole;
    }
  | {
      area: "media";
      action: "importFiles";
      role: ProjectMediaRole;
      files: File[];
    }
  | { area: "media"; action: "requestEmbyAudio" }
  | { area: "media"; action: "requestBilibili" }
  | { area: "media"; action: "requestMotrix" }
  | { area: "media"; action: "requestWebDav" }
  | { area: "media"; action: "requestReconnect"; mediaId: string }
  | { area: "media"; action: "remove"; mediaId: string }
  | {
      area: "audio";
      action: "setIntent";
      mediaId: string;
      intent: { mode: "auto" } | { mode: "explicit"; streamIndex: number };
    }
  | { area: "audio"; action: "cancel" | "refresh" }
  | { area: "audio"; action: "focusHandled"; sequence: number }
  | { area: "xml"; action: "requestImport" }
  | { area: "xml"; action: "importFiles"; files: File[] }
  | {
      area: "xml";
      action: "changeSource";
      assetId: string;
      sourceMediaId: string | null;
    }
  | { area: "xml"; action: "remove"; assetId: string }
  | {
      area: "intakePlan";
      action: "applySuggestions";
      suggestionIds: string[];
    }
  | {
      area: "compatibility";
      action: "bindLocalTarget" | "validateEmbyTarget" | "clearTargetBinding" | "previewMatch";
    };

interface MaterialsWorkspacePresentationProps {
  familyWorkbench?: ReactNode;
  viewModel: MaterialsWorkspaceViewModel;
  onIntent: (intent: MaterialsWorkspaceIntent) => void;
}

interface MaterialIntakePlanSectionProps {
  plan: MaterialsWorkspaceViewModel["intakePlan"];
  onApply: (suggestionIds: string[]) => void;
  onResolveAsset: (assetId: string) => void;
}

export function MaterialsWorkspacePresentation({
  viewModel,
  onIntent,
  familyWorkbench
}: MaterialsWorkspacePresentationProps) {
  const [tab, setTab] = useState<
    "xml" | "targetOriginal" | "bilibiliReference" | "issues" | "family"
  >("xml");
  const [legacyMaterialsOpen, setLegacyMaterialsOpen] = useState(false);
  const [xmlDropActive, setXmlDropActive] = useState(false);
  const [xmlQuery, setXmlQuery] = useState("");
  const [pendingFocusMediaId, setPendingFocusMediaId] = useState<string | null>(null);
  const [pendingFocusAssetId, setPendingFocusAssetId] = useState<string | null>(null);
  const xmlSourceSelectRefs = useRef(new Map<string, HTMLSelectElement>());
  const mediaDetailsSummaryRefs = useRef(new Map<string, HTMLElement>());
  const alignmentMaterialsDetailsRef = useRef<HTMLDetailsElement | null>(null);
  const firstUnboundAssetId = viewModel.xmlMaterials.assetRows.find(
    (asset) => asset.sourceMediaId === null
  )?.assetId;

  useEffect(() => {
    const request = viewModel.summary.workspaceIntentRequest;
    if (!request || request.intent.page !== "materials") return;
    const target = request.intent.target;
    if (target.kind === "xml") {
      if (tab !== "xml" || xmlQuery) {
        setTab("xml");
        setXmlQuery("");
        return;
      }
      const select = xmlSourceSelectRefs.current.get(target.assetId);
      if (!select) {
        setXmlQuery("");
        return;
      }
      select.focus({ preventScroll: true });
      select.scrollIntoView?.({ block: "nearest" });
      onIntent({ area: "audio", action: "focusHandled", sequence: request.sequence });
      return;
    }
    if (target.kind !== "media" && target.kind !== "audioIssue") return;
    const wanted = viewModel.mediaGroups.targetOriginal.some(
      (media) => media.id === target.mediaId
    )
      ? "targetOriginal"
      : "bilibiliReference";
    if (tab !== wanted) {
      setTab(wanted);
      return;
    }
    alignmentMaterialsDetailsRef.current?.setAttribute("open", "");
    const summary = mediaDetailsSummaryRefs.current.get(target.mediaId);
    if (!summary) return;
    const fileDetails = summary.closest("details");
    if (fileDetails instanceof HTMLDetailsElement) fileDetails.open = true;
    summary.click();
    summary.focus({ preventScroll: true });
    summary.scrollIntoView?.({ block: "nearest" });
    onIntent({ area: "audio", action: "focusHandled", sequence: request.sequence });
  }, [
    onIntent,
    viewModel.summary.workspaceIntentRequest,
    viewModel.mediaGroups.targetOriginal,
    xmlQuery,
    tab
  ]);

  useEffect(() => {
    if (!pendingFocusAssetId) return;
    if (tab !== "xml") {
      setTab("xml");
      return;
    }
    const select = xmlSourceSelectRefs.current.get(pendingFocusAssetId);
    if (!select) return;
    select.focus({ preventScroll: true });
    select.scrollIntoView?.({ block: "nearest" });
    setPendingFocusAssetId(null);
  }, [pendingFocusAssetId, xmlQuery, tab]);

  useEffect(() => {
    if (!pendingFocusMediaId) return;
    const wanted = viewModel.mediaGroups.targetOriginal.some(
      (media) => media.id === pendingFocusMediaId
    )
      ? "targetOriginal"
      : "bilibiliReference";
    if (tab !== wanted) {
      setTab(wanted);
      return;
    }
    mediaDetailsSummaryRefs.current.get(pendingFocusMediaId)?.click();
    setPendingFocusMediaId(null);
  }, [pendingFocusMediaId, tab, viewModel.mediaGroups.targetOriginal]);

  return (
    <section
      className="workspace-page"
      role="region"
      aria-label="素材工作台"
      data-testid="materials-intake-workbench"
    >
      <div className="min-w-0 shrink-0">
        <MaterialsSummaryPanel
          originalCount={viewModel.summary.originalCount}
          referenceCount={viewModel.summary.referenceCount}
          xmlCount={viewModel.summary.xmlCount}
          unplacedXmlCount={viewModel.summary.unplacedXmlCount}
          hasTimeline={viewModel.summary.hasTimeline}
          unboundXmlCount={viewModel.summary.unboundXmlCount}
          reconnectCount={viewModel.summary.reconnectCount}
          audioIssueCount={viewModel.summary.audioIssueCount}
          audioBusy={viewModel.summary.audioBusy}
          audioPaused={viewModel.summary.audioPaused}
          audioCancelling={viewModel.summary.audioCancelling}
          audioRestartRequired={viewModel.summary.audioRestartRequired}
          audioTerminalMessage={viewModel.summary.audioTerminalMessage}
          pendingSuggestionCount={viewModel.intakePlan.suggestions.length}
          onAddOriginal={() => {
            setTab("targetOriginal");
            onIntent({
              area: "media",
              action: "requestImport",
              role: "targetOriginal"
            });
          }}
          onAddReference={() => {
            setTab("bilibiliReference");
            onIntent({
              area: "media",
              action: "requestImport",
              role: "bilibiliReference"
            });
          }}
          onAddXml={() => {
            setTab("xml");
            setXmlQuery("");
            onIntent({ area: "xml", action: "requestImport" });
          }}
          onAcquireBilibili={() => {
            setTab("xml");
            setXmlQuery("");
            onIntent({ area: "media", action: "requestBilibili" });
          }}
          onAddEmby={() => {
            setTab("targetOriginal");
            onIntent({ area: "media", action: "requestEmbyAudio" });
          }}
          onAcquireOriginal={()=>{setTab("targetOriginal");onIntent({area:"media",action:"requestMotrix"});}}
          onAddWebDav={()=>{setTab("targetOriginal");onIntent({area:"media",action:"requestWebDav"});}}
          onReviewBindings={() => {
            if (firstUnboundAssetId) {
              setTab("xml");
              setXmlQuery("");
              setPendingFocusAssetId(firstUnboundAssetId);
            }
          }}
          onReviewAudio={() => setPendingFocusMediaId(viewModel.summary.firstAudioIssueMediaId)}
          onCancelAudio={() => onIntent({ area: "audio", action: "cancel" })}
          onRefreshAudio={() => onIntent({ area: "audio", action: "refresh" })}
          onContinue={() => onIntent({ area: "navigation", action: "continueToMatching" })}
          onEditXml={() => onIntent({ area: "navigation", action: "beginXmlEditing" })}
          alignmentEnabled={viewModel.workflow.alignmentEnabled}
        />
      </div>
      <div className="workspace-bar">
        <WorkspaceTabs
          label="素材分类"
          value={tab}
          onChange={setTab}
          items={[
            { id: "family", label: "智能分集", count: viewModel.summary.xmlCount },
            { id: "xml", label: "弹幕 XML", count: viewModel.summary.xmlCount },
            { id: "targetOriginal", label: "原片", count: viewModel.summary.originalCount },
            { id: "bilibiliReference", label: "参考", count: viewModel.summary.referenceCount },
            {
              id: "issues",
              label: "待处理",
              count: viewModel.workflow.alignmentEnabled
                ? viewModel.summary.unboundXmlCount + viewModel.summary.audioIssueCount
                : 0
            }
          ]}
        />
        <WorkspaceMenu
          label="素材工具"
          items={[
            { id: "relations", label: "分集与自动关联", onSelect: () => setTab("family") },
            {
              id: "compatibility",
              label: "单目标绑定与素材说明",
              onSelect: () => setLegacyMaterialsOpen(true)
            }
          ]}
        />
      </div>
      <div className="page-scroll thin-scrollbar" data-testid="intake-materials-pane">
        <div hidden={tab !== "family"}>{familyWorkbench}</div>
        <div hidden={tab !== "issues" && tab !== "family"} data-testid="intake-issues-pane">
          {viewModel.workflow.alignmentEnabled && viewModel.summary.audioIssueCount > 0 ? (
            <section aria-label="音轨与文件问题" className="mb-6">
              <h3 className="text-sm font-semibold text-content-primary">需要检查的素材</h3>
              <p className="mt-1 mb-3 text-xs text-content-muted">
                检查音轨或重新连接文件后，就可以继续匹配。
              </p>
              <ul className="divide-y divide-boundary">
                {[
                  ...viewModel.mediaGroups.targetOriginal,
                  ...viewModel.mediaGroups.bilibiliReference
                ]
                  .filter((media) => media.audioPreparation.tone !== "success")
                  .map((media) => (
                    <li key={media.id} className="flex items-center gap-4 py-3">
                      <AlertTriangle size={16} className="shrink-0 text-feedback-warning" />
                      <div className="min-w-0 flex-1">
                        <p
                          className="truncate text-sm text-content-primary"
                          title={media.fileName}
                        >
                          {media.fileName}
                        </p>
                        <p className="mt-1 text-xs text-content-muted">
                          {media.reconnectWarning ?? media.audioPreparation.statusText}
                        </p>
                      </div>
                      <TextButton
                        aria-label={`处理 ${media.fileName}`}
                        onClick={() => setPendingFocusMediaId(media.id)}
                      >
                        处理
                      </TextButton>
                    </li>
                  ))}
              </ul>
            </section>
          ) : null}
          {viewModel.intakePlan.visible &&
          viewModel.summary.originalCount + viewModel.summary.referenceCount > 0 ? (
            <MaterialIntakePlanSection
              plan={viewModel.intakePlan}
              onApply={(suggestionIds) =>
                onIntent({
                  area: "intakePlan",
                  action: "applySuggestions",
                  suggestionIds
                })
              }
              onResolveAsset={(assetId) => {
                setTab("xml");
                setXmlQuery("");
                setPendingFocusAssetId(assetId);
              }}
            />
          ) : (
            <EmptyState title="无需关联视频" text="纯 XML 项目可以直接编辑和导出。" />
          )}
        </div>
        <details
          ref={alignmentMaterialsDetailsRef}
          hidden={tab !== "targetOriginal" && tab !== "bilibiliReference"}
          className="media-category text-sm text-content-secondary"
          open
        >
          <summary className="sr-only">视频对齐素材</summary>
          <div>
            <div hidden={tab !== "targetOriginal"}>
              <MediaLibrarySection
                title="原片素材"
                description="原片素材是弹幕最终要匹配到的标准时间轴。可导入视频，也可只导入提取好的音频；纯音频能完成匹配和试听，但没有画面复核。"
                role="targetOriginal"
                mediaItems={viewModel.mediaGroups.targetOriginal}
                onDropFiles={(files) =>
                  onIntent({
                    area: "media",
                    action: "importFiles",
                    role: "targetOriginal",
                    files: Array.from(files)
                  })
                }
                onReconnect={(mediaId) =>
                  onIntent({ area: "media", action: "requestReconnect", mediaId })
                }
                onDelete={(mediaId) => onIntent({ area: "media", action: "remove", mediaId })}
                onAudioSelection={(mediaId, value) =>
                  onIntent({
                    area: "audio",
                    action: "setIntent",
                    mediaId,
                    intent:
                      value === "auto"
                        ? { mode: "auto" }
                        : {
                            mode: "explicit",
                            streamIndex: Number(value.slice("explicit:".length))
                          }
                  })
                }
                onDetailsSummaryRef={(mediaId, element) => {
                  if (element) mediaDetailsSummaryRefs.current.set(mediaId, element);
                  else mediaDetailsSummaryRefs.current.delete(mediaId);
                }}
              />
            </div>
            <div hidden={tab !== "bilibiliReference"}>
              <MediaLibrarySection
                title="B 站参考素材"
                description="参考素材用于理解弹幕 XML 的原始时间轴。可导入单集、合集、删减版视频或对应音频，但它不是最终输出目标。"
                role="bilibiliReference"
                mediaItems={viewModel.mediaGroups.bilibiliReference}
                onDropFiles={(files) =>
                  onIntent({
                    area: "media",
                    action: "importFiles",
                    role: "bilibiliReference",
                    files: Array.from(files)
                  })
                }
                onReconnect={(mediaId) =>
                  onIntent({ area: "media", action: "requestReconnect", mediaId })
                }
                onDelete={(mediaId) => onIntent({ area: "media", action: "remove", mediaId })}
                onAudioSelection={(mediaId, value) =>
                  onIntent({
                    area: "audio",
                    action: "setIntent",
                    mediaId,
                    intent:
                      value === "auto"
                        ? { mode: "auto" }
                        : {
                            mode: "explicit",
                            streamIndex: Number(value.slice("explicit:".length))
                          }
                  })
                }
                onDetailsSummaryRef={(mediaId, element) => {
                  if (element) mediaDetailsSummaryRefs.current.set(mediaId, element);
                  else mediaDetailsSummaryRefs.current.delete(mediaId);
                }}
              />
            </div>
          </div>
        </details>
        <section
          id="xml-materials"
          hidden={tab !== "xml"}
          className={`xml-list-surface text-sm text-content-secondary transition ${
            xmlDropActive ? "border-accent-cyan bg-accent-cyan/10" : "border-transparent"
          }`}
          data-testid="xml-material-dropzone"
          onDragEnter={(event) => {
            if (event.dataTransfer.types.includes("Files")) {
              event.preventDefault();
              event.stopPropagation();
              setXmlDropActive(true);
            }
          }}
          onDragOver={(event) => {
            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer.dropEffect = "copy";
          }}
          onDragLeave={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (!event.currentTarget.contains(event.relatedTarget as Node)) {
              setXmlDropActive(false);
            }
          }}
          onDrop={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setXmlDropActive(false);
            onIntent({
              area: "xml",
              action: "importFiles",
              files: Array.from(event.dataTransfer.files)
            });
          }}
        >
          {viewModel.xmlMaterials.importProgress !== null ? (
            <div className="mt-2 rounded border border-panel-line bg-surface-inset p-2 text-content-secondary">
              正在导入 XML... {Math.round(viewModel.xmlMaterials.importProgress * 100)}%
            </div>
          ) : null}
          {viewModel.xmlMaterials.assetRows.length === 0 ? (
            <EmptyState title="尚未导入 XML" text="可一次选择多个 Bilibili XML 分 P 文件。" />
          ) : (
            <div className="mt-3">
              <div className="mb-3 flex items-center justify-between gap-3">
                <label className="flex min-w-0 items-center gap-2 text-content-muted">
                  <span className="shrink-0">查找素材</span>
                  <input
                    type="search"
                    aria-label="查找弹幕素材"
                    placeholder="文件名…"
                    value={xmlQuery}
                    onChange={(event) => setXmlQuery(event.target.value)}
                    className="h-9 w-64 min-w-0 border px-3 text-sm"
                  />
                </label>
                <span className="text-ui-caption text-content-muted">
                  可随时修改自动识别的来源
                </span>
              </div>
              <table className="materials-table" aria-label="弹幕素材与来源关系">
                <thead>
                  <tr>
                    <th>弹幕文件</th>
                    <th>弹幕数量</th>
                    <th>来源参考素材</th>
                    <th>状态</th>
                    <th>
                      <span className="sr-only">操作</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {viewModel.xmlMaterials.assetRows
                    .filter((asset) =>
                      asset.fileName
                        .toLocaleLowerCase()
                        .includes(xmlQuery.trim().toLocaleLowerCase())
                    )
                    .map((asset) => (
                      <tr key={asset.assetId} data-testid="asset-card">
                        <td>
                          <details>
                            <summary
                              className="flex cursor-pointer items-center gap-2 font-medium text-content-primary"
                              title={asset.fileName}
                            >
                              <span
                                className="h-2.5 w-2.5 shrink-0 rounded-full"
                                style={{ background: asset.color }}
                              />
                              <span className="truncate">{asset.fileName}</span>
                            </summary>
                            <div className="mt-3 grid gap-2 text-ui-caption text-content-muted">
                              <Row
                                label="来源验证"
                                value={asset.hasSourceReceipt ? "已受验证" : "仅预览"}
                              />
                              <Row label="最早时间" value={formatTimecode(asset.earliestMs)} />
                              <Row label="最晚时间" value={formatTimecode(asset.latestMs)} />
                              <Row label="导入警告" value={String(asset.warningCount)} />
                              <p>
                                {asset.hasSourceReceipt
                                  ? "桌面端已核验原始 XML，可用于受验证投影。"
                                  : "单文件 XML 可直接编辑和导出；正式原片投影前需在桌面端重新导入原文件以验证来源。"}
                              </p>
                              {asset.sourceMediaId ? (
                                <TextButton
                                  onClick={() =>
                                    onIntent({
                                      area: "xml",
                                      action: "changeSource",
                                      assetId: asset.assetId,
                                      sourceMediaId: null
                                    })
                                  }
                                >
                                  解除绑定
                                </TextButton>
                              ) : null}
                            </div>
                          </details>
                        </td>
                        <td className="tabular-nums text-content-muted">
                          {asset.itemCount.toLocaleString("zh-CN")} 条弹幕
                        </td>
                        <td>
                          <select
                            ref={(element) => {
                              if (element)
                                xmlSourceSelectRefs.current.set(asset.assetId, element);
                              else xmlSourceSelectRefs.current.delete(asset.assetId);
                            }}
                            aria-label={asset.fileName + " 弹幕来源素材"}
                            data-unbound-xml={asset.sourceMediaId ? undefined : "true"}
                            className="h-9 w-full min-w-0 border px-2 text-sm"
                            value={asset.sourceMediaId ?? ""}
                            onChange={(event) =>
                              onIntent({
                                area: "xml",
                                action: "changeSource",
                                assetId: asset.assetId,
                                sourceMediaId: event.target.value || null
                              })
                            }
                          >
                            <option value="">
                              {viewModel.workflow.alignmentEnabled
                                ? "选择参考素材…"
                                : "仅 XML 编辑（无需绑定）"}
                            </option>
                            {viewModel.xmlMaterials.sourceOptions.map((media) => (
                              <option key={media.id} value={media.id}>
                                {media.name}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <span
                            className={
                              asset.warningCount > 0 ||
                              (viewModel.workflow.alignmentEnabled && !asset.sourceMediaId)
                                ? "text-feedback-warning"
                                : "text-feedback-success"
                            }
                          >
                            {asset.warningCount > 0
                              ? asset.warningCount + " 项提示"
                              : viewModel.workflow.alignmentEnabled
                                ? asset.sourceMediaId
                                  ? "已关联"
                                  : "待选来源"
                                : "可编辑"}
                          </span>
                        </td>
                        <td>
                          <TextButton
                            tone="danger"
                            title="删除资源及关联片段"
                            onClick={() =>
                              onIntent({
                                area: "xml",
                                action: "remove",
                                assetId: asset.assetId
                              })
                            }
                          >
                            <Trash2 size={14} />
                            <span className="sr-only">删除</span>
                          </TextButton>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
              {viewModel.xmlMaterials.assetRows.every(
                (asset) =>
                  !asset.fileName
                    .toLocaleLowerCase()
                    .includes(xmlQuery.trim().toLocaleLowerCase())
              ) ? (
                <p className="py-5 text-center text-content-muted">
                  没有找到匹配文件，试试其他名称。
                </p>
              ) : null}
            </div>
          )}
        </section>
        <ToolSheet
          title="单目标绑定与素材说明"
          open={legacyMaterialsOpen}
          onClose={() => setLegacyMaterialsOpen(false)}
        >
          <div className="grid gap-4">
            <MediaRoleGuidePanel
              targetCount={viewModel.summary.originalCount}
              referenceCount={viewModel.summary.referenceCount}
              alignmentEnabled={viewModel.workflow.alignmentEnabled}
            />
            <TargetMediaBindingPanel
              binding={viewModel.legacyCompatibility.binding}
              media={viewModel.legacyCompatibility.media}
              mediaLibrary={viewModel.legacyCompatibility.mediaLibrary}
              validating={viewModel.legacyCompatibility.validatingTarget}
              onBindLocalPath={() =>
                onIntent({ area: "compatibility", action: "bindLocalTarget" })
              }
              onValidateEmby={() =>
                onIntent({
                  area: "compatibility",
                  action: "validateEmbyTarget"
                })
              }
              onClear={() =>
                onIntent({
                  area: "compatibility",
                  action: "clearTargetBinding"
                })
              }
            />
            <ProjectMatchAssessmentPanel
              assessment={viewModel.legacyCompatibility.assessment}
              onPreview={() => onIntent({ area: "compatibility", action: "previewMatch" })}
            />
          </div>
        </ToolSheet>
      </div>
    </section>
  );
}

function MaterialIntakePlanSection({
  plan,
  onApply,
  onResolveAsset
}: MaterialIntakePlanSectionProps) {
  const exceptions = [
    ...plan.exceptions.conflicts.map((row) => ({
      ...row,
      kind: "冲突" as const
    })),
    ...plan.exceptions.unresolved.map((row) => ({
      ...row,
      kind: "未识别" as const
    }))
  ];

  if (!plan.visible) {
    return (
      <section
        data-testid="material-intake-plan"
        aria-labelledby="material-intake-plan-title"
        className="rounded-lg border border-panel-line bg-panel-soft p-3 text-xs text-content-secondary"
      >
        <h3
          id="material-intake-plan-title"
          className="text-sm font-medium text-content-primary"
        >
          来源关系检查
        </h3>
        <p className="mt-2 leading-5 text-content-muted">
          导入素材后，关系建议与需要处理的异常会集中出现在这里。
        </p>
      </section>
    );
  }

  return (
    <section
      data-testid="material-intake-plan"
      aria-labelledby="material-intake-plan-title"
      className="rounded-lg border border-panel-line bg-panel-soft p-3 text-xs text-content-secondary"
    >
      <h3 id="material-intake-plan-title" className="text-sm font-medium text-content-primary">
        来源关系检查
      </h3>
      <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Sparkles size={15} className="text-accent-cyan" aria-hidden="true" />
            <h4 className="text-sm font-medium text-content-primary">批量关系建议</h4>
          </div>
          <p className="mt-1 leading-5 text-content-muted">
            导入时自动关联明确且唯一的来源；这里可补齐旧项目或处理重名文件。
          </p>
        </div>
        {plan.suggestions.length > 0 ? (
          <TextButton
            tone="primary"
            onClick={() => onApply(plan.suggestions.map((suggestion) => suggestion.id))}
          >
            <CheckCircle2 size={14} />
            一次应用 {plan.suggestions.length} 条建议
          </TextButton>
        ) : null}
      </div>
      <div className="mt-3 flex flex-wrap gap-2 text-ui-caption">
        <span className="rounded border border-accent-cyan/30 bg-accent-cyan/10 px-2 py-1 text-accent-cyan">
          可一次应用 {plan.suggestions.length}
        </span>
        <span className="rounded border border-accent-yellow/30 bg-accent-yellow/10 px-2 py-1 text-accent-yellow">
          需处理 {exceptions.length}
        </span>
        <span className="rounded border border-accent-green/30 bg-accent-green/10 px-2 py-1 text-accent-green">
          已保留 {plan.preservedCount}
        </span>
      </div>
      {plan.suggestions.length > 0 ? (
        <details className="mt-3 rounded border border-accent-cyan/20 bg-accent-cyan/5">
          <summary className="cursor-pointer px-2.5 py-2 text-ui-caption text-accent-cyan">
            查看 {plan.suggestions.length} 条建议与理由
          </summary>
          <div
            className="grid gap-2 border-t border-accent-cyan/20 p-2.5 md:grid-cols-2"
            aria-label="可应用关系建议"
          >
            {plan.suggestions.map((suggestion) => (
              <article
                key={suggestion.id}
                className="rounded border border-accent-cyan/20 bg-surface-inset p-2.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <strong className="truncate text-content-primary">
                    {suggestion.episodeLabel}
                  </strong>
                  <span className="shrink-0 text-ui-caption text-accent-cyan">唯一建议</span>
                </div>
                <p
                  className="mt-1 truncate text-content-secondary"
                  title={suggestion.assetFileName}
                >
                  {suggestion.assetFileName} → {suggestion.sourceMediaFileName}
                </p>
                {suggestion.targetMediaFileName ? (
                  <p className="mt-1 truncate text-ui-caption text-content-muted">
                    同集原片：{suggestion.targetMediaFileName}
                  </p>
                ) : null}
                <p className="mt-2 line-clamp-2 text-ui-caption leading-5 text-content-muted">
                  {suggestion.reason}
                </p>
              </article>
            ))}
          </div>
        </details>
      ) : null}
      {exceptions.length > 0 ? (
        <div className="mt-3 rounded border border-accent-yellow/25 bg-accent-yellow/5 p-2.5">
          <div className="flex items-center gap-2 text-accent-yellow">
            <AlertTriangle size={14} aria-hidden="true" />
            <h4 className="font-medium">需要逐项确认</h4>
          </div>
          <div className="mt-2 grid gap-2 md:grid-cols-2">
            {exceptions.map((row) => (
              <article
                key={row.id}
                className="rounded border border-panel-line bg-surface-inset p-2.5"
              >
                <div className="flex items-center gap-2">
                  <span className="rounded border border-accent-yellow/30 px-1.5 py-0.5 text-ui-caption text-accent-yellow">
                    {row.kind}
                  </span>
                  <strong className="min-w-0 flex-1 truncate text-content-primary">
                    {row.assetFileName}
                  </strong>
                </div>
                {row.episodeLabel ? (
                  <p className="mt-1 text-ui-caption text-content-muted">{row.episodeLabel}</p>
                ) : null}
                <p className="mt-1 text-ui-caption leading-5 text-content-muted">
                  {row.message}
                </p>
                {row.candidateFileNames.length > 0 ? (
                  <p className="mt-1 truncate text-ui-caption text-content-muted">
                    候选：{row.candidateFileNames.join("；")}
                  </p>
                ) : null}
                <div className="mt-2 flex justify-end">
                  <TextButton
                    aria-label={`处理 ${row.assetFileName}`}
                    onClick={() => onResolveAsset(row.assetId)}
                  >
                    逐项选择
                  </TextButton>
                </div>
              </article>
            ))}
          </div>
        </div>
      ) : null}
      {plan.suggestions.length === 0 && exceptions.length === 0 ? (
        <p className="mt-3 rounded border border-accent-green/25 bg-accent-green/5 p-2 text-accent-green">
          全部 XML 已关联，无需逐项选择。
        </p>
      ) : null}
    </section>
  );
}
