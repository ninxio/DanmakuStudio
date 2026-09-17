import { useRef } from "react";
import { useNativeVideoObstruction } from "../../components/useNativeVideoObstruction";
import { ChevronRight, CircleAlert, Info, ShieldCheck } from "lucide-react";
import type { UsabilityViewModel } from "../../domain/project/usabilityViewModel";
import type { WorkspacePage } from "../../stores/editorStore";

export function ContextRail({
  model,
  pageId
}: {
  model: UsabilityViewModel;
  pageId: WorkspacePage;
}) {
  const obstructionRef = useRef<HTMLElement>(null);
  useNativeVideoObstruction(obstructionRef);
  const step = model.steps.find((candidate) => candidate.id === pageId);
  const issues = model.issues.filter((issue) => issue.stepId === pageId);

  if (!step) {
    return null;
  }

  return (
    <aside
      ref={obstructionRef}
      className="thin-scrollbar w-[276px] shrink-0 overflow-y-auto border-l border-panel-line bg-surface-inset p-3"
      aria-label="当前步骤"
      data-testid="context-rail"
    >
      <div className="rounded-lg border border-panel-line bg-surface-raised p-3">
        <div className="flex items-center gap-2">
          <span className="rounded-md bg-accent-cyan/10 px-1.5 py-0.5 text-ui-caption font-medium text-accent-cyan">
            第 {step.order} 步
          </span>
          <span className="text-ui-caption text-content-muted">{step.stateLabel}</span>
        </div>
        <h2 className="mt-2 text-sm font-semibold text-content-primary">{step.headline}</h2>
        <p className="mt-1.5 text-ui-caption leading-5 text-content-muted">{step.detail}</p>
      </div>

      <section className="mt-3" aria-label="当前问题">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-ui-caption font-semibold text-content-muted">
            {issues.length > 0 ? "需要处理" : "当前状态"}
          </h3>
          <span className="text-ui-caption text-content-subtle">{issues.length} 项</span>
        </div>
        {issues.length > 0 ? (
          <div className="grid gap-2">
            {issues.map((issue) => (
              <div
                key={issue.id}
                className={`rounded-lg border p-2.5 ${
                  issue.severity === "blocking"
                    ? "border-accent-red/30 bg-accent-red/[0.07]"
                    : "border-accent-yellow/25 bg-accent-yellow/[0.06]"
                }`}
              >
                <div className="flex items-start gap-2">
                  <CircleAlert
                    size={14}
                    className={
                      issue.severity === "blocking"
                        ? "mt-0.5 text-accent-red"
                        : "mt-0.5 text-accent-yellow"
                    }
                  />
                  <div>
                    <div className="text-xs font-medium text-content-secondary">
                      {issue.title}
                    </div>
                    <p className="mt-1 text-ui-caption leading-4 text-content-muted">
                      {issue.detail}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-lg border border-accent-green/20 bg-accent-green/[0.05] p-3">
            <div className="flex items-center gap-2 text-xs text-accent-green">
              <ShieldCheck size={14} />
              当前没有需要处理的问题
            </div>
            <p className="mt-1.5 text-ui-caption leading-4 text-content-muted">
              系统仍会在导出前重新检查项目和 XML。
            </p>
          </div>
        )}
      </section>

      <details className="group mt-3 rounded-lg border border-panel-line bg-surface-inset">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-xs text-content-muted hover:text-content-secondary">
          <Info size={13} />
          技术详情
          <ChevronRight size={13} className="ml-auto transition group-open:rotate-90" />
        </summary>
        <div className="border-t border-panel-line px-3 py-2.5 text-ui-caption leading-5 text-content-muted">
          <div>项目：{model.projectName}</div>
          <div>
            工作方式：
            {model.workflowMode === "xml-only" ? "仅编辑弹幕 XML" : "视频对齐"}
          </div>
          {model.workflowMode === "xml-only" ? (
            <>
              <div>已导入 XML：{model.summary.xmlCount}</div>
              <div>视频素材：不需要</div>
            </>
          ) : (
            <>
              <div>已绑定 XML：{model.summary.boundXmlCount}</div>
              <div>
                匹配进度：{model.summary.matchedEpisodeCount}/{model.summary.totalEpisodeCount}
              </div>
              <div>可导出分集：{model.summary.exportableEpisodeCount}</div>
            </>
          )}
        </div>
      </details>
    </aside>
  );
}
