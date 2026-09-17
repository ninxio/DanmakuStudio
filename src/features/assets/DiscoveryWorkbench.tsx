import { useEffect, useState } from "react";
import { Button } from "../../components/Button";
import { Field } from "../../components/Field";
import { ToolSheet } from "../../components/ToolSheet";
import { createId } from "../../domain/project/factory";
import {
  createLibraryProfile,
  parseDiscoveryLink,
  type DiscoveryItem,
  type LibraryProfile
} from "../../domain/project/discovery";
import { useEditorStore } from "../../stores/editorStore";
import { openBilibiliAcquisition } from "../../stores/bilibiliAcquisitionStore";
import { discoveryMotrixPrefill, type MotrixPrefill } from "../../application/discoveryPrefill";
import {
  applyWorkflowDefaults,
  currentWorkflowDefaults,
  removeWorkflowPreset,
  saveWorkflowPreset
} from "../../application/workflowPresets";
import { loadAppSettings } from "../../infrastructure/settings/appSettings";
import { LogVarLibraryDialog } from "../export/LogVarLibraryDialog";

/** Mounted owner retains form drafts while the tool sheet is closed. */
export function DiscoveryWorkbench({
  onMotrix
}: {
  onMotrix: (request: MotrixPrefill) => void;
}) {
  const project = useEditorStore((s) => s.project),
    epoch = useEditorStore((s) => s.projectEpoch);
  const [open, setOpen] = useState(false),
    [cloud, setCloud] = useState(false);
  const [link, setLink] = useState(""),
    [title, setTitle] = useState(""),
    [note, setNote] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [profile, setProfile] = useState(() =>
    structuredClone(project.libraryProfile ?? createLibraryProfile(createId("profile")))
  );
  const [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  const [presetName, setPresetName] = useState(""),
    [presets, setPresets] = useState(() => loadAppSettings().workflowPresets ?? []);
  const [defaults, setDefaults] = useState(currentWorkflowDefaults);
  const savedProfile = JSON.stringify(project.libraryProfile ?? null);
  useEffect(() => {
    const saved = useEditorStore.getState().project.libraryProfile;
    setProfile(structuredClone(saved ?? createLibraryProfile(createId("profile"))));
    setEditing(null);
  }, [savedProfile]);
  const current = () => {
    const s = useEditorStore.getState();
    if (
      s.project.id !== project.id ||
      s.projectEpoch !== epoch ||
      s.projectLibrary.switchingProject
    )
      throw new Error("项目已切换，请重新打开发现与整理。");
    return s;
  };
  const save = (items: DiscoveryItem[], next = project.libraryProfile) => {
    if (!current().saveDiscovery(items, next)) throw new Error("资料未保存，请检查字段。");
    setMessage("已记录到项目，支持撤销；项目保存状态见工作台。");
  };
  const run = (action: () => void) => {
    try {
      action();
    } catch (e) {
      setMessage(String(e));
    }
  };
  const change = (patch: Partial<LibraryProfile>) => setProfile((p) => ({ ...p, ...patch }));
  const prefill = (item: DiscoveryItem) =>
    run(() => {
      current();
      if (item.kind === "bilibili")
        openBilibiliAcquisition({
          input: item.link,
          projectId: project.id,
          projectEpoch: epoch
        });
      else
        onMotrix(
          discoveryMotrixPrefill(
            item,
            { projectId: project.id, projectEpoch: epoch },
            createId("prefill"),
            currentWorkflowDefaults().provider
          )
        );
      setOpen(false);
    });
  return (
    <>
      <div className="flex shrink-0 items-center gap-3 border-b border-panel-line px-3 py-1">
        <Button
          onClick={() => {
            setOpen(true);
            setDefaults(currentWorkflowDefaults());
            setPresets(loadAppSettings().workflowPresets ?? []);
          }}
        >
          发现与整理
        </Button>
        <span className="truncate text-xs text-content-muted">
          {project.libraryProfile?.title || "作品资料未填写"} · 待办{" "}
          {(project.discoveryItems ?? []).filter((i) => i.status === "todo").length}
        </span>
      </div>
      <ToolSheet
        title="发现与整理"
        open={open}
        wide
        onClose={() => {
          if (!busy) setOpen(false);
        }}
      >
        <div className="grid gap-4 text-sm">
          {message && (
            <p
              role="status"
              className="sticky top-0 z-10 rounded border border-boundary bg-surface-base p-2"
            >
              {message}
            </p>
          )}
          <p>
            先保存想看的链接与作品信息，再带入现有采集窗口。不会自动下载、推断集号或修改时间映射。
          </p>
          <form
            className="grid gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              run(() => {
                const parsed = parseDiscoveryLink(link);
                save([
                  ...(current().project.discoveryItems ?? []),
                  {
                    ...parsed,
                    id: createId("discovery"),
                    title: title.trim(),
                    note: note.trim(),
                    status: "todo"
                  }
                ]);
                setLink("");
                setTitle("");
                setNote("");
              });
            }}
          >
            <Field
              label="收藏链接"
              value={link}
              onChange={(e) => setLink(e.target.value)}
              placeholder="B站 / 豆瓣 / EXT / Nyaa / magnet"
            />
            <div className="grid gap-2 sm:grid-cols-2">
              <Field
                label="待办作品名称"
                maxLength={200}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
              <Field
                label="待办笔记"
                maxLength={2000}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </div>
            <Button type="submit">保存链接待办</Button>
          </form>
          <div className="grid gap-2">
            {(project.discoveryItems ?? []).map((item) => (
              <section key={item.id} className="rounded border border-boundary p-2">
                <p className="break-all">
                  {item.title || item.kind} · {item.status === "done" ? "已整理" : "待整理"}
                </p>
                <p className="break-all text-xs text-content-muted">{item.link}</p>
                {item.note && <p>{item.note}</p>}
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button onClick={() => prefill(item)}>
                    {item.kind === "bilibili" ? "带入 B站获取" : "带入 Motrix"}
                  </Button>
                  <Button
                    onClick={() => {
                      setEditing(item.id);
                      setProfile(
                        structuredClone(
                          item.profile ?? createLibraryProfile(createId("profile"), item.title)
                        )
                      );
                    }}
                  >
                    编辑此待办作品资料
                  </Button>
                  <Button
                    onClick={() =>
                      run(() =>
                        save(
                          (current().project.discoveryItems ?? []).map((i) =>
                            i.id === item.id
                              ? { ...i, status: i.status === "todo" ? "done" : "todo" }
                              : i
                          )
                        )
                      )
                    }
                  >
                    {item.status === "todo" ? "标记已整理" : "恢复待办"}
                  </Button>
                  <Button
                    onClick={() =>
                      run(() =>
                        save(
                          (current().project.discoveryItems ?? []).filter(
                            (i) => i.id !== item.id
                          )
                        )
                      )
                    }
                  >
                    移除待办
                  </Button>
                </div>
              </section>
            ))}
          </div>
          <fieldset className="grid gap-2 rounded border border-boundary p-3">
            <legend>{editing ? "待办作品资料 → 本项目" : "本项目作品资料"}</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              <Field
                label="资料作品名称"
                maxLength={200}
                value={profile.title}
                onChange={(e) => change({ title: e.target.value })}
              />
              <label>
                作品类型
                <select
                  aria-label="资料作品类型"
                  className="ml-2 rounded border border-boundary bg-surface-base p-2"
                  value={profile.kind ?? ""}
                  onChange={(e) =>
                    change({ kind: (e.target.value || null) as LibraryProfile["kind"] })
                  }
                >
                  <option value="">待确认</option>
                  <option value="tv">剧集</option>
                  <option value="movie">电影</option>
                </select>
              </label>
              <Field
                label="资料年份（未知留空）"
                type="number"
                value={profile.year ?? ""}
                onChange={(e) =>
                  change({ year: e.target.value === "" ? null : Number(e.target.value) })
                }
              />
              <Field
                label="资料季号（未知留空）"
                type="number"
                value={profile.season ?? ""}
                onChange={(e) =>
                  change({ season: e.target.value === "" ? null : Number(e.target.value) })
                }
              />
            </div>
            <p className="text-content-muted">
              只需正式片名和季集。发布时在私人库选择已有影视；旧项目的来源、别名和身份记录自动保留。
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={() =>
                  run(() => {
                    const clean = {
                      ...profile,
                      title: profile.title.trim(),
                      aliases: profile.aliases.filter(Boolean)
                    };
                    if (!clean.title) throw new Error("请填写作品名称。");
                    save(
                      (current().project.discoveryItems ?? []).map((i) =>
                        i.id === editing ? { ...i, title: clean.title, profile: clean } : i
                      ),
                      clean
                    );
                  })
                }
              >
                保存资料并用于本项目
              </Button>
              <Button
                onClick={() => {
                  setEditing(null);
                  setProfile(createLibraryProfile(createId("profile")));
                }}
              >
                填写新的作品资料
              </Button>
            </div>
            <p className="text-xs text-content-muted">
              只作为后续导出与发布初值；旧成品、草稿和已发布内容不随这里改动。
            </p>
          </fieldset>
          <fieldset disabled={busy} className="grid gap-2 rounded border border-boundary p-3">
            <legend>工作流预设</legend>
            <p>
              当前：B站{defaults.downloadAudio ? "弹幕与音轨" : "仅弹幕"}；
              {defaults.provider.toUpperCase()}；{defaults.spectralBackend}；窗口{" "}
              {defaults.windowMs}ms，间隔 {defaults.minGapMs}ms，阈值 {defaults.matchThreshold}
              。
            </p>
            <Field
              label="预设名称"
              maxLength={100}
              value={presetName}
              onChange={(e) => setPresetName(e.target.value)}
            />
            <Button
              onClick={() => {
                setBusy(true);
                void saveWorkflowPreset({
                  id: createId("preset"),
                  name: presetName.trim(),
                  defaults: currentWorkflowDefaults()
                })
                  .then(() => {
                    setPresets(loadAppSettings().workflowPresets ?? []);
                    setMessage("当前实际默认选项已保存为预设，不包含路径或凭据。");
                  })
                  .catch((e) => setMessage(String(e)))
                  .finally(() => setBusy(false));
              }}
            >
              保存当前默认选项为预设
            </Button>
            {presets.map((p) => (
              <div key={p.id} className="flex items-center justify-between gap-2">
                <span>{p.name}</span>
                <Button
                  onClick={() => {
                    setBusy(true);
                    void applyWorkflowDefaults(p.defaults)
                      .then(() => {
                        setDefaults(currentWorkflowDefaults());
                        setMessage("已应用到后续新任务；运行中及恢复队列继续使用原配置。");
                      })
                      .catch((e) => setMessage(String(e)))
                      .finally(() => setBusy(false));
                  }}
                >
                  应用到后续任务
                </Button>
                <Button
                  onClick={() => {
                    setBusy(true);
                    void removeWorkflowPreset(p.id)
                      .then(() => {
                        setPresets(loadAppSettings().workflowPresets ?? []);
                        setMessage("已删除该预设；当前默认选项和已有任务未改动。");
                      })
                      .catch((e) => setMessage(String(e)))
                      .finally(() => setBusy(false));
                  }}
                >
                  删除预设
                </Button>
              </div>
            ))}
          </fieldset>
          <Button
            onClick={() => {
              setOpen(false);
              setCloud(true);
            }}
          >
            管理私人弹幕库
          </Button>
        </div>
      </ToolSheet>
      {cloud && (
        <LogVarLibraryDialog
          onClose={() => setCloud(false)}
          onChooseProfile={(chosen) =>
            run(() => {
              current();
              setProfile(structuredClone(chosen));
              setEditing(null);
              setCloud(false);
              setOpen(true);
              setMessage(
                "已带回云端作品、来源和版本身份，请核对后点击保存资料并用于本项目；不会改变已有发布记录。"
              );
            })
          }
        />
      )}
    </>
  );
}
