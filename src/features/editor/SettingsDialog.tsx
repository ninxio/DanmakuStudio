import { ThemeControl } from "../../components/ThemeControl";
import { APP_VERSION } from "../../infrastructure/appVersion";
import { StorageSettingsPanel } from "./StorageSettingsPanel";
import {
  getHostEnvironment,
  type HostEnvironment
} from "../../infrastructure/settings/storageClient";
import { LogVarConnectionPanel } from "../export/LogVarConnectionPanel";
import { LogVarLibraryDialog } from "../export/LogVarLibraryDialog";
import { BilibiliAccountPanel } from "../assets/BilibiliAccountPanel";
import { Button } from "../../components/Button";
import {
  CircleAlert,
  CircleCheck,
  Download,
  FolderOpen,
  Info,
  MonitorCog,
  RefreshCw,
  Save,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  Upload,
  X
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Field } from "../../components/Field";
import { IconButton } from "../../components/IconButton";
import { TextButton } from "../../components/TextButton";
import { Dialog } from "../../components/Dialog";
import type { SpectralBackendPreference } from "../../domain/alignment/spectralBackendPreference";
import {
  DEFAULT_APP_SETTINGS,
  cloneAppSettings,
  loadAppSettings,
  parseAppSettingsTextStrict,
  serializeAppSettings,
  type AppSettings,
  type PreviewBackendPreference
} from "../../infrastructure/settings/appSettings";
import { downloadTextFile, readTextFile } from "../../infrastructure/file-system/browserFiles";
import { formatExportFileError } from "../../infrastructure/file-system/exportFiles";
import {
  probeCudaFftCapability,
  type CudaFftCapability
} from "../../infrastructure/alignment/cudaFftCapability";
import {
  clearAlignmentFeatureCaches,
  getAlignmentFeatureCacheStatus,
  type AlignmentFeatureCacheStatus
} from "../../infrastructure/alignment/tauriFeatureCache";
import {
  pickExportDirectoryPath,
  pickFfmpegExecutablePath,
  pickSingleNativeDirectoryPath
} from "../../infrastructure/file-system/nativeDialogs";
import {
  detectMediaTool,
  formatMpvSidecarError,
  type MediaToolDetectionResult,
  type MediaToolKind
} from "../../infrastructure/media/tauriMpvPlayer";
import { detectTauriLibMpvRuntime } from "../../infrastructure/media/tauriLibMpvPlayer";
import {
  clearDesktopAppSettings,
  formatDesktopSettingsError,
  readDesktopAppSettings,
  persistDesktopAppSettings
} from "../../infrastructure/settings/desktopAppSettings";
import {
  clearVolatileEmbyCredentials,
  isSameEmbyAccount,
  loadVolatileEmbyPassword,
  saveVolatileEmbyPassword
} from "../../infrastructure/settings/volatileEmbyCredentials";
import {
  clearEmbyAudioCache,
  getEmbyAudioCacheStatus,
  type EmbyAudioCacheStatus
} from "../../infrastructure/metadata/embyAudioDownload";
import { useEditorStore } from "../../stores/editorStore";

interface SettingsDialogProps {
  onClose: () => void;
}

type SettingsTab =
  | "storage"
  | "general"
  | "export"
  | "emby"
  | "tools"
  | "privacy"
  | "about"
  | "privateLibrary"
  | "bilibili";

const SETTINGS_TABS: Array<{ id: SettingsTab; label: string; icon: typeof MonitorCog }> = [
  { id: "general", label: "常规", icon: MonitorCog },
  { id: "storage", label: "存储目录", icon: FolderOpen },
  { id: "export", label: "导出", icon: FolderOpen },
  { id: "privateLibrary", label: "私人弹幕库", icon: Server },
  { id: "bilibili", label: "B 站账号", icon: ShieldCheck },
  { id: "emby", label: "Emby 连接", icon: Server },
  { id: "tools", label: "播放器与工具", icon: SlidersHorizontal },
  { id: "privacy", label: "隐私与本地数据", icon: ShieldCheck },
  { id: "about", label: "关于", icon: Info }
];

export function SettingsDialog({ onClose }: SettingsDialogProps) {
  const [tab, setTab] = useState<SettingsTab>("general");
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [settings, setSettings] = useState<AppSettings>(() => loadAppSettings());
  const [embyPassword, setEmbyPassword] = useState(() =>
    loadVolatileEmbyPassword(settings.emby)
  );
  const settingsInputRef = useRef<HTMLInputElement | null>(null);
  const dirtyRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const updateSettings = (next: AppSettings) => {
    dirtyRef.current = true;
    if (!isSameEmbyAccount(settings.emby, next.emby)) setEmbyPassword("");
    setSettings(next);
  };
  const updatePassword = (next: string) => {
    dirtyRef.current = true;
    setEmbyPassword(next);
  };
  const requestClose = () => {
    if (!saving) onClose();
  };

  useEffect(() => {
    let mounted = true;
    void readDesktopAppSettings()
      .then((desktopSettings) => {
        if (mounted && desktopSettings && !dirtyRef.current) {
          setSettings(desktopSettings);
          setEmbyPassword(loadVolatileEmbyPassword(desktopSettings.emby));
        }
      })
      .catch((error) => {
        if (mounted) {
          setStatus(
            `读取桌面应用设置失败，已使用浏览器本地设置：${formatDesktopSettingsError(error)}`,
            "warning"
          );
        }
      });
    return () => {
      mounted = false;
    };
  }, []);

  const saveSettings = async () => {
    if (saving) return;
    dirtyRef.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      const storedInDesktop = await persistDesktopAppSettings(settings);
      saveVolatileEmbyPassword(embyPassword, settings.emby);
      setStatus(
        storedInDesktop ? "应用设置已保存。" : "应用设置已保存在本机浏览器。",
        "success"
      );
      onClose();
    } catch (error) {
      setSaveError(`保存未完成，修改已保留，请重试：${formatDesktopSettingsError(error)}`);
    } finally {
      setSaving(false);
    }
  };

  const exportSettingsBackup = () => {
    const fileName = downloadTextFile(
      "danmaku-settings.json",
      `${serializeAppSettings(settings)}\n`,
      "application/json;charset=utf-8"
    );
    setStatus(`已导出非敏感应用设置备份：${fileName}。`, "success");
  };

  const importSettingsBackup = async (file: File) => {
    try {
      const imported = parseAppSettingsTextStrict(await readTextFile(file));
      updateSettings(imported);
      setStatus("设置备份已载入草稿，保存后生效。", "success");
    } catch (error) {
      setStatus(formatSettingsImportError(file, error), "error");
    }
  };

  const restoreDefaults = () => {
    updateSettings({ ...cloneAppSettings(DEFAULT_APP_SETTINGS), storage: settings.storage });
    setStatus(
      "已在草稿中恢复默认设置，保存后生效；Emby 连接变化后需重新输入会话密码。",
      "neutral"
    );
  };

  const clearLocalSettings = async () => {
    if (saving) return;
    dirtyRef.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      const clearedDesktop = await clearDesktopAppSettings();
      clearVolatileEmbyCredentials();
      setSettings(loadAppSettings());
      setEmbyPassword("");
      setStatus(
        clearedDesktop
          ? "已清除桌面应用设置和本次会话密码。"
          : "已清除浏览器本地设置和本次会话密码。",
        "success"
      );
    } catch (error) {
      setSaveError(`清除本地配置未完成：${formatDesktopSettingsError(error)}`);
    } finally {
      setSaving(false);
    }
  };

  if (libraryOpen) return <LogVarLibraryDialog onClose={() => setLibraryOpen(false)} />;
  return (
    <Dialog
      ariaLabelledBy="settings-dialog-title"
      onClose={requestClose}
      overlayClassName="dialog-backdrop"
      className="grid h-[min(720px,calc(100vh-32px))] w-[min(860px,calc(100vw-32px))] grid-rows-[64px_minmax(0,1fr)_auto] overflow-hidden rounded-dialog border-panel-line bg-panel-raised"
    >
      <header className="flex items-center justify-between border-b border-panel-line px-4">
        <div>
          <h2 id="settings-dialog-title" className="text-sm font-semibold text-content-primary">
            设置中心
          </h2>
          <p className="text-ui-caption text-content-muted">
            {tab === "bilibili" || tab === "privateLibrary"
              ? "账号与连接操作立即保存到本机"
              : "配置保留为草稿，保存后生效"}
          </p>
        </div>
        <IconButton
          label="关闭设置"
          icon={<X size={16} />}
          onClick={requestClose}
          disabled={saving}
        />
      </header>
      <div className="grid min-h-0 grid-cols-[190px_minmax(0,1fr)]">
        <nav
          className="overflow-y-auto border-r border-panel-line bg-surface-inset p-2"
          aria-label="设置分类"
        >
          {SETTINGS_TABS.map((item) => {
            const Icon = item.icon;
            return (
              <Button
                tone="unstyled"
                key={item.id}
                type="button"
                aria-pressed={tab === item.id}
                className={`mb-1 flex h-9 w-full items-center gap-2 rounded px-2 text-left text-xs transition ${
                  tab === item.id
                    ? "bg-accent-cyan/15 text-accent-cyan"
                    : "text-content-muted hover:bg-panel-soft hover:text-content-primary"
                }`}
                onClick={() => setTab(item.id)}
              >
                <Icon size={15} />
                <span>{item.label}</span>
              </Button>
            );
          })}
        </nav>
        <fieldset disabled={saving} className="thin-scrollbar min-h-0 overflow-auto p-5">
          {tab === "general" ? <GeneralSettingsPanel /> : null}
          {tab === "privateLibrary" ? (
            <LogVarConnectionPanel onOpenLibrary={() => setLibraryOpen(true)} />
          ) : null}
          {tab === "bilibili" ? <BilibiliAccountPanel /> : null}
          {tab === "storage" ? (
            <StorageSettingsPanel
              value={settings.storage}
              onChange={(storage) => updateSettings({ ...settings, storage })}
            />
          ) : null}
          {tab === "export" ? (
            <ExportSettingsPanel settings={settings} onChange={updateSettings} />
          ) : null}
          {tab === "emby" ? (
            <EmbySettingsPanel
              settings={settings}
              password={embyPassword}
              onChange={updateSettings}
              onPasswordChange={updatePassword}
            />
          ) : null}
          {tab === "tools" ? (
            <PlayerToolsSettingsPanel settings={settings} onChange={updateSettings} />
          ) : null}
          {tab === "privacy" ? (
            <PrivacySettingsPanel
              onClearLocalSettings={() => void clearLocalSettings()}
              onExportSettings={exportSettingsBackup}
              onImportSettings={() => settingsInputRef.current?.click()}
            />
          ) : null}
          {tab === "about" ? <AboutSettingsPanel /> : null}
        </fieldset>
      </div>
      <footer className="grid gap-3 border-t border-panel-line p-4">
        {saveError ? (
          <p role="alert" className="text-sm text-feedback-danger">
            {saveError}
          </p>
        ) : null}
        <div className="flex items-center justify-between gap-3">
          <TextButton disabled={saving} onClick={restoreDefaults}>
            恢复默认
          </TextButton>
          <div className="flex gap-2">
            <TextButton disabled={saving} onClick={requestClose}>
              取消
            </TextButton>
            <TextButton tone="primary" disabled={saving} onClick={() => void saveSettings()}>
              <Save size={14} />
              {saving ? "正在保存…" : "保存设置并关闭"}
            </TextButton>
          </div>
        </div>
      </footer>
      <input
        ref={settingsInputRef}
        className="hidden"
        type="file"
        accept=".json,application/json"
        aria-label="导入设置文件"
        data-testid="settings-import-input"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) {
            void importSettingsBackup(file);
          }
          event.target.value = "";
        }}
      />
    </Dialog>
  );
}

function GeneralSettingsPanel() {
  return (
    <SettingsSection title="外观与工作区" description="外观立即生效，仅保存在当前设备。">
      <div className="flex items-center justify-between gap-4">
        <span>颜色模式</span>
        <ThemeControl />
      </div>
      <InfoBox>
        跟随系统会自动适应系统的浅色或深色外观。整体时间偏移、弹幕透明度和安全区可在编辑页的「常用修复」中调整，项目修改支持撤销。
      </InfoBox>
    </SettingsSection>
  );
}

function ExportSettingsPanel({
  settings,
  onChange
}: {
  settings: AppSettings;
  onChange: (settings: AppSettings) => void;
}) {
  const chooseDirectory = async () => {
    try {
      const path = await pickExportDirectoryPath(settings.export.defaultDirectory);
      if (!path) {
        return;
      }
      onChange({
        ...settings,
        export: { ...settings.export, defaultDirectory: path }
      });
      setStatus("已选择默认导出文件夹，保存设置后生效。", "success");
    } catch (error) {
      setStatus(`选择导出文件夹失败：${formatExportFileError(error)}`, "warning");
    }
  };

  return (
    <SettingsSection title="导出" description="设置单集 XML、分集 ZIP 和导出报告的默认去向。">
      <Field
        label="默认导出目录"
        value={settings.export.defaultDirectory}
        placeholder="留空使用存储目录下的 exports"
        onChange={(event) =>
          onChange({
            ...settings,
            export: { ...settings.export, defaultDirectory: event.target.value }
          })
        }
      />
      <div className="flex flex-wrap gap-2">
        <TextButton onClick={() => void chooseDirectory()}>
          <FolderOpen size={14} />
          选择目录
        </TextButton>
        <TextButton
          onClick={() =>
            onChange({
              ...settings,
              export: { ...settings.export, defaultDirectory: "" }
            })
          }
        >
          使用统一默认目录
        </TextButton>
      </div>
      <InfoBox>
        默认目录只保存在本机应用设置里；导出的 XML、ZIP
        和报告不会额外写入你的本地路径。目录不存在或没有写入权限时，导出时会直接提示你重新选择。
      </InfoBox>
    </SettingsSection>
  );
}

function EmbySettingsPanel({
  settings,
  password,
  onChange,
  onPasswordChange
}: {
  settings: AppSettings;
  password: string;
  onChange: (settings: AppSettings) => void;
  onPasswordChange: (password: string) => void;
}) {
  return (
    <SettingsSection
      title="Emby 连接"
      description="服务器、路径和用户名会保存到桌面配置文件；网页模式使用浏览器本地存储。密码只保存在本次应用会话。"
    >
      <Field
        label="服务器地址"
        value={settings.emby.serverUrl}
        placeholder="https://example.com:443"
        onChange={(event) =>
          onChange({
            ...settings,
            emby: { ...settings.emby, serverUrl: event.target.value }
          })
        }
      />
      <Field
        label="路径前缀"
        value={settings.emby.pathPrefix}
        placeholder="/emby"
        onChange={(event) =>
          onChange({
            ...settings,
            emby: { ...settings.emby, pathPrefix: event.target.value }
          })
        }
      />
      <Field
        label="用户名"
        value={settings.emby.username}
        autoComplete="username"
        onChange={(event) =>
          onChange({
            ...settings,
            emby: { ...settings.emby, username: event.target.value }
          })
        }
      />
      <Field
        label="本次会话密码"
        type="password"
        value={password}
        placeholder="关闭应用后自动失效"
        autoComplete="current-password"
        onChange={(event) => onPasswordChange(event.target.value)}
      />
      <InfoBox>
        主界面的 Emby 时长面板会直接读取这里的连接配置进行搜索。当前实验版不会把 Emby 密码或
        token 写入项目文件、桌面配置文件、localStorage 或明文设置；后续接入 Windows
        凭据管理器后再提供跨次启动记忆。
      </InfoBox>
    </SettingsSection>
  );
}

function PlayerToolsSettingsPanel({
  settings,
  onChange
}: {
  settings: AppSettings;
  onChange: (settings: AppSettings) => void;
}) {
  const [host, setHost] = useState<HostEnvironment | null>(null);
  const [hostError, setHostError] = useState("");
  useEffect(() => {
    let active = true;
    void getHostEnvironment()
      .then((v) => {
        if (active) setHost(v);
      })
      .catch((e) => {
        if (active) setHostError(String(e));
      });
    return () => {
      active = false;
    };
  }, []);
  const [checkingTool, setCheckingTool] = useState<MediaToolKind | null>(null);
  const [checkingCuda, setCheckingCuda] = useState(false);
  const [cudaCapability, setCudaCapability] = useState<CudaFftCapability | null>(null);
  const [toolResults, setToolResults] = useState<
    Record<MediaToolKind, MediaToolDetectionResult | null>
  >({
    ffmpeg: null,
    mpv: null
  });

  const chooseFfmpeg = async () => {
    try {
      const path = await pickFfmpegExecutablePath(settings.alignment.ffmpegPath);
      if (!path) {
        return;
      }
      onChange({
        ...settings,
        alignment: { ...settings.alignment, ffmpegPath: path }
      });
      setStatus("已选择 FFmpeg 路径，保存设置后生效。", "success");
    } catch (error) {
      setStatus(`选择 FFmpeg 失败：${formatMpvSidecarError(error)}`, "warning");
    }
  };

  const chooseMpv = async () => {
    try {
      const path = await pickSingleNativeDirectoryPath({
        title: "选择包含 libmpv DLL 的目录",
        defaultPath: settings.player.mpvPath || undefined
      });
      if (!path) {
        return;
      }
      onChange({
        ...settings,
        player: { ...settings.player, mpvPath: path }
      });
      setStatus("已选择 mpv 目录。请点击“检测 libmpv”确认同目录 DLL 可用。", "success");
    } catch (error) {
      setStatus(`选择 mpv 失败：${formatMpvSidecarError(error)}`, "warning");
    }
  };

  const checkTool = async (tool: MediaToolKind) => {
    setCheckingTool(tool);
    try {
      if (tool === "mpv") {
        const runtime = await detectTauriLibMpvRuntime({ mpvPath: settings.player.mpvPath });
        const result: MediaToolDetectionResult = {
          tool,
          executablePath: runtime.libraryPath ?? settings.player.mpvPath,
          available: runtime.available,
          version: runtime.clientApiVersion,
          message: runtime.message
        };
        setToolResults((current) => ({ ...current, mpv: result }));
        setStatus(result.message, result.available ? "success" : "warning");
        return;
      }
      const result = await detectMediaTool({
        tool,
        executablePath: settings.alignment.ffmpegPath || null
      });
      setToolResults((current) => ({ ...current, [tool]: result }));
      setStatus(result.message, result.available ? "success" : "warning");
    } catch (error) {
      setStatus(
        `检测 ${formatToolName(tool)} 失败：${formatMpvSidecarError(error)}`,
        "warning"
      );
    } finally {
      setCheckingTool(null);
    }
  };

  const checkCuda = async () => {
    setCheckingCuda(true);
    try {
      const capability = await probeCudaFftCapability();
      setCudaCapability(capability);
      setStatus(
        capability.available
          ? `CUDA/cuFFT 已就绪：${capability.selectedDeviceName ?? "NVIDIA GPU"}。当前计算策略：${formatSpectralBackendPreference(settings.alignment.spectralBackend)}。`
          : `CUDA/cuFFT 尚不可用：${capability.reason}`,
        capability.available ? "success" : "warning"
      );
    } catch (error) {
      setStatus(`检测 CUDA/cuFFT 失败：${formatMpvSidecarError(error)}`, "warning");
    } finally {
      setCheckingCuda(false);
    }
  };

  return (
    <SettingsSection
      title="播放器与工具"
      description="管理本机 FFmpeg、mpv 和预览后端；这些路径只保存在本机设置中。"
    >
      <p className="text-xs text-content-muted">
        {host
          ? `实际运行环境：${host.os} / ${host.architecture}；可用逻辑 CPU：${host.logicalCpus ?? "未知"}`
          : hostError || "桌面版启动后可读取实际 CPU 环境。"}
      </p>
      <Field
        label="FFmpeg 路径"
        value={settings.alignment.ffmpegPath}
        placeholder="留空使用 PATH 中的 ffmpeg"
        onChange={(event) =>
          onChange({
            ...settings,
            alignment: { ...settings.alignment, ffmpegPath: event.target.value }
          })
        }
      />
      <div className="flex flex-wrap gap-2">
        <TextButton onClick={() => void chooseFfmpeg()}>
          <FolderOpen size={14} />
          选择 FFmpeg
        </TextButton>
        <TextButton onClick={() => void checkTool("ffmpeg")} disabled={checkingTool !== null}>
          <RefreshCw size={14} />
          {checkingTool === "ffmpeg" ? "检测中" : "检测 FFmpeg"}
        </TextButton>
      </div>
      <ToolDetectionRow
        result={toolResults.ffmpeg}
        fallback="尚未检测 FFmpeg；留空时会尝试使用 PATH 中的 ffmpeg。"
      />
      <div className="rounded border border-panel-line/70 bg-surface-inset p-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <div className="text-xs font-medium text-content-secondary">
              NVIDIA CUDA/cuFFT 加速
            </div>
            <p className="mt-1 text-xs leading-5 text-content-muted">
              此设置影响之后启动的所有单次和批量匹配，不改变已有候选。GPU 只负责声谱 FFT；FFmpeg
              音频解码、候选决策、DP 和边界判定仍由 CPU 完成。
            </p>
          </div>
          <TextButton onClick={() => void checkCuda()} disabled={checkingCuda}>
            <RefreshCw size={14} />
            {checkingCuda ? "检测中" : "检测 CUDA/cuFFT"}
          </TextButton>
        </div>
        <SpectralBackendPreferenceControl
          value={settings.alignment.spectralBackend}
          onChange={(spectralBackend) =>
            onChange({
              ...settings,
              alignment: { ...settings.alignment, spectralBackend }
            })
          }
        />
        <CudaCapabilityRow capability={cudaCapability} />
      </div>
      <Field
        label="libmpv 所在目录"
        value={settings.player.mpvPath}
        placeholder="选择与 mpv-2.dll / mpv-1.dll 同目录的 mpv.exe"
        onChange={(event) =>
          onChange({
            ...settings,
            player: { ...settings.player, mpvPath: event.target.value }
          })
        }
      />
      <label className="grid gap-2 text-xs text-content-secondary">
        播放后端
        <select
          value={settings.player.preferredBackend}
          className="h-9 rounded border border-panel-line bg-panel-base px-2 text-xs text-content-primary outline-none focus:border-accent-cyan"
          onChange={(event) =>
            onChange({
              ...settings,
              player: {
                ...settings.player,
                preferredBackend: readPreviewBackendPreferenceInput(event.target.value)
              }
            })
          }
        >
          <option value="auto">自动选择</option>
          <option value="htmlVideo">HTML Video</option>
          <option value="nativeMpv">应用内 libmpv</option>
        </select>
      </label>
      <div className="flex flex-wrap gap-2">
        <TextButton onClick={() => void chooseMpv()}>
          <FolderOpen size={14} />
          选择 libmpv 目录
        </TextButton>
        <TextButton onClick={() => void checkTool("mpv")} disabled={checkingTool !== null}>
          <RefreshCw size={14} />
          {checkingTool === "mpv" ? "检测中" : "检测 libmpv"}
        </TextButton>
      </div>
      <ToolDetectionRow
        result={toolResults.mpv}
        fallback="留空会自动查找应用目录、用户 mpv 目录与 PATH。也可选择包含 x64 libmpv DLL 的文件夹；仅有 mpv.exe 不够。"
      />
      <div className="grid grid-cols-3 gap-3">
        <Field
          label="窗口 ms"
          type="number"
          min={1}
          value={settings.alignment.windowMs}
          onChange={(event) =>
            onChange({
              ...settings,
              alignment: {
                ...settings.alignment,
                windowMs: readNumericInput(event.target.value)
              }
            })
          }
        />
        <Field
          label="最小缺失 ms"
          type="number"
          min={0}
          value={settings.alignment.minGapMs}
          onChange={(event) =>
            onChange({
              ...settings,
              alignment: {
                ...settings.alignment,
                minGapMs: readNumericInput(event.target.value)
              }
            })
          }
        />
        <Field
          label="匹配阈值"
          type="number"
          min={0.01}
          step={0.01}
          value={settings.alignment.matchThreshold}
          onChange={(event) =>
            onChange({
              ...settings,
              alignment: {
                ...settings.alignment,
                matchThreshold: readNumericInput(event.target.value)
              }
            })
          }
        />
      </div>
      <InfoBox>
        当前后端偏好：{formatPreviewBackendPreference(settings.player.preferredBackend)}。普通
        MP4/WebM 可使用 HTML Video；MKV/复杂编码即使沿用旧的 HTML 偏好，也会在 libmpv
        可用时自动切换，避免黑屏。
      </InfoBox>
      <InfoBox>窗口越小越容易靠近真实边界，但特征数量和运算量也会增加。</InfoBox>
    </SettingsSection>
  );
}

function CudaCapabilityRow({ capability }: { capability: CudaFftCapability | null }) {
  if (!capability) {
    return (
      <p className="mt-2 text-xs leading-5 text-content-muted">
        尚未运行完整 CUDA context + 512 点 cuFFT smoke test；仅检测到显卡驱动不代表可用。
      </p>
    );
  }
  const Icon = capability.available ? CircleCheck : CircleAlert;
  return (
    <div
      className={`mt-2 flex items-start gap-2 text-xs leading-5 ${capability.available ? "text-accent-green" : "text-accent-yellow"}`}
      role="status"
      data-testid="cuda-capability-result"
    >
      <Icon size={14} className="mt-0.5 shrink-0" />
      <span>
        {capability.available
          ? `${capability.selectedDeviceName ?? "NVIDIA GPU"} · ${capability.cufftLibraryName ?? "cuFFT"} · 单批显存上界 ${formatMemoryMiB(capability.defaultBatchMemory.worstCaseTotalDeviceBytes)} MiB · 可用于自动推荐或强制 GPU`
          : `${capability.reason}${capability.remediation ? `；${capability.remediation}` : ""}`}
      </span>
    </div>
  );
}

function SpectralBackendPreferenceControl({
  value,
  onChange
}: {
  value: SpectralBackendPreference;
  onChange: (value: SpectralBackendPreference) => void;
}) {
  const options: Array<{
    value: SpectralBackendPreference;
    label: string;
    description: string;
  }> = [
    {
      value: "auto",
      label: "自动推荐",
      description: "CUDA 可用时加速声谱 FFT；不可用或运行失败时改用 CPU。"
    },
    {
      value: "cuda",
      label: "强制 GPU",
      description: "只使用 CUDA/cuFFT；检测、初始化或执行失败会停止匹配，不会回退 CPU。"
    },
    {
      value: "cpu",
      label: "强制 CPU",
      description: "完全禁用 CUDA，始终使用 CPU；适合基线复核和排查 GPU 差异。"
    }
  ];
  return (
    <fieldset className="grid gap-2" aria-describedby="spectral-backend-description">
      <legend className="text-xs font-medium text-content-secondary">声谱计算策略</legend>
      <p
        id="spectral-backend-description"
        className="text-ui-caption leading-5 text-content-muted"
      >
        保存后应用于新启动的匹配任务；每次批量任务只使用同一策略。
      </p>
      <div className="grid gap-2 sm:grid-cols-3">
        {options.map((option) => {
          const selected = value === option.value;
          return (
            <label
              key={option.value}
              className={`flex cursor-pointer items-start gap-2 rounded border p-2.5 text-left transition focus-within:ring-1 focus-within:ring-accent-cyan/60 ${
                selected
                  ? "border-accent-cyan/70 bg-accent-cyan/10"
                  : "border-panel-line bg-panel-base hover:border-boundary"
              }`}
            >
              <input
                type="radio"
                name="spectral-backend-preference"
                value={option.value}
                checked={selected}
                className="mt-0.5 h-4 w-4 shrink-0 accent-accent-cyan"
                onChange={() => onChange(option.value)}
              />
              <span>
                <span className="block text-xs font-medium text-content-secondary">
                  {option.label}
                </span>
                <span className="mt-1 block text-ui-caption leading-4 text-content-muted">
                  {option.description}
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

function formatMemoryMiB(bytes: number): string {
  return Number.isFinite(bytes) && bytes >= 0 ? (bytes / (1024 * 1024)).toFixed(0) : "未知";
}

function ToolDetectionRow({
  result,
  fallback
}: {
  result: MediaToolDetectionResult | null;
  fallback: string;
}) {
  if (!result) {
    return <p className="text-xs leading-5 text-content-muted">{fallback}</p>;
  }
  const Icon = result.available ? CircleCheck : CircleAlert;
  return (
    <div
      className={`flex items-start gap-2 text-xs leading-5 ${result.available ? "text-accent-green" : "text-accent-yellow"}`}
    >
      <Icon size={14} className="mt-0.5 shrink-0" />
      <span>
        {result.message}
        {result.version ? `（${result.version}）` : ""}
      </span>
    </div>
  );
}

function PrivacySettingsPanel({
  onClearLocalSettings,
  onExportSettings,
  onImportSettings
}: {
  onClearLocalSettings: () => void;
  onExportSettings: () => void;
  onImportSettings: () => void;
}) {
  const [cacheStatus, setCacheStatus] = useState<AlignmentFeatureCacheStatus | null>(null);
  const [cacheBusy, setCacheBusy] = useState(false);
  const [cacheError, setCacheError] = useState<string | null>(null);
  const [confirmCacheClear, setConfirmCacheClear] = useState(false);
  const [embyAudioCacheStatus, setEmbyAudioCacheStatus] = useState<EmbyAudioCacheStatus | null>(
    null
  );
  const [embyAudioCacheBusy, setEmbyAudioCacheBusy] = useState(false);
  const [confirmEmbyAudioClear, setConfirmEmbyAudioClear] = useState(false);

  const refreshCacheStatus = async () => {
    setCacheBusy(true);
    setCacheError(null);
    try {
      setCacheStatus(await getAlignmentFeatureCacheStatus());
    } catch (error) {
      setCacheError(formatDesktopSettingsError(error));
    } finally {
      setCacheBusy(false);
    }
  };

  useEffect(() => {
    void refreshCacheStatus();
    void refreshEmbyAudioCacheStatus();
  }, []);

  const refreshEmbyAudioCacheStatus = async () => {
    setEmbyAudioCacheBusy(true);
    setCacheError(null);
    try {
      setEmbyAudioCacheStatus(await getEmbyAudioCacheStatus());
    } catch (error) {
      setCacheError(formatDesktopSettingsError(error));
    } finally {
      setEmbyAudioCacheBusy(false);
    }
  };

  const clearCaches = async () => {
    if (!confirmCacheClear) {
      setConfirmCacheClear(true);
      return;
    }
    setCacheBusy(true);
    setCacheError(null);
    try {
      const receipt = await clearAlignmentFeatureCaches();
      setCacheStatus(receipt.after);
      setConfirmCacheClear(false);
      setStatus(
        `已清理 ${receipt.removedFiles} 个缓存文件，释放 ${formatCacheBytes(receipt.removedBytes)}。`,
        "success"
      );
    } catch (error) {
      const message = formatDesktopSettingsError(error);
      setCacheError(message);
      setStatus(message, "error");
    } finally {
      setCacheBusy(false);
    }
  };

  const clearDownloadedEmbyAudio = async () => {
    if (!confirmEmbyAudioClear) {
      setConfirmEmbyAudioClear(true);
      return;
    }
    setEmbyAudioCacheBusy(true);
    setCacheError(null);
    try {
      const receipt = await clearEmbyAudioCache();
      setEmbyAudioCacheStatus(receipt.after);
      setConfirmEmbyAudioClear(false);
      setStatus(
        `已清理 ${receipt.removedFiles} 个未完成音轨临时文件，释放 ${formatCacheBytes(receipt.removedBytes)}。完整音轨和项目引用已保留。`,
        "success"
      );
    } catch (error) {
      const message = formatDesktopSettingsError(error);
      setCacheError(message);
      setStatus(message, "error");
    } finally {
      setEmbyAudioCacheBusy(false);
    }
  };

  return (
    <SettingsSection
      title="隐私与本地数据"
      description="本工具默认以本地文件和本机授权服务为边界。"
    >
      <div className="flex flex-wrap gap-2">
        <TextButton tone="danger" onClick={onClearLocalSettings}>
          <Trash2 size={14} />
          清除本地设置
        </TextButton>
        <TextButton onClick={onExportSettings}>
          <Download size={14} />
          导出设置
        </TextButton>
        <TextButton onClick={onImportSettings}>
          <Upload size={14} />
          导入设置
        </TextButton>
      </div>
      <div className="grid gap-3 rounded border border-panel-line bg-surface-base p-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-content-secondary">匹配特征缓存</p>
            <p className="mt-1 text-xs leading-5 text-content-muted">
              重新导入同一文件时复用粗索引、选中区间单声道 PCM
              和画面摘要；不保存完整视频或原始画面。
            </p>
          </div>
          <TextButton disabled={cacheBusy} onClick={() => void refreshCacheStatus()}>
            <RefreshCw size={14} className={cacheBusy ? "animate-spin" : ""} />
            刷新
          </TextButton>
        </div>
        {cacheStatus ? (
          <div className="grid gap-2 md:grid-cols-3">
            <CacheStatusCard label="粗音频索引" status={cacheStatus.coarse} />
            <CacheStatusCard label="精对齐音频窗口" status={cacheStatus.finePcm} />
            <CacheStatusCard label="画面摘要" status={cacheStatus.visual} />
          </div>
        ) : (
          <p className="text-xs text-content-muted">
            {cacheBusy ? "正在读取缓存状态…" : "桌面端启动后可查看缓存容量。"}
          </p>
        )}
        {cacheError ? (
          <p className="text-xs leading-5 text-accent-yellow">{cacheError}</p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <TextButton tone="danger" disabled={cacheBusy} onClick={() => void clearCaches()}>
            <Trash2 size={14} />
            {confirmCacheClear ? "再次点击确认清理" : "清理匹配缓存"}
          </TextButton>
          {confirmCacheClear ? (
            <Button
              tone="unstyled"
              type="button"
              className="text-xs text-content-muted hover:text-content-secondary"
              onClick={() => setConfirmCacheClear(false)}
            >
              取消
            </Button>
          ) : null}
        </div>
      </div>
      <div className="grid gap-3 rounded border border-panel-line bg-surface-base p-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-content-secondary">Emby 完整音频缓存</p>
            <p className="mt-1 text-xs leading-5 text-content-muted">
              “从 Emby 获取音频”保存的 FLAC/AAC
              原片。它们能还原完整声音，并作为项目中的本地原片路径复用。
            </p>
          </div>
          <TextButton
            disabled={embyAudioCacheBusy}
            onClick={() => void refreshEmbyAudioCacheStatus()}
          >
            <RefreshCw size={14} className={embyAudioCacheBusy ? "animate-spin" : ""} />
            刷新
          </TextButton>
        </div>
        {embyAudioCacheStatus ? (
          <div className="rounded border border-panel-line bg-panel-soft p-3 text-xs">
            <p className="font-medium text-content-secondary">
              {embyAudioCacheStatus.fileCount} 条音轨 ·{" "}
              {formatCacheBytes(embyAudioCacheStatus.totalBytes)}
            </p>
            <p
              className="mt-1 truncate text-ui-caption text-content-muted"
              title={embyAudioCacheStatus.directoryPath}
            >
              {embyAudioCacheStatus.directoryPath || "网页模式不保存 Emby 音频缓存"}
            </p>
          </div>
        ) : (
          <p className="text-xs text-content-muted">
            {embyAudioCacheBusy ? "正在读取 Emby 音频缓存…" : "桌面端启动后可查看缓存容量。"}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <TextButton
            tone="danger"
            disabled={embyAudioCacheBusy}
            onClick={() => void clearDownloadedEmbyAudio()}
          >
            <Trash2 size={14} />
            {confirmEmbyAudioClear ? "再次点击确认清理临时文件" : "清理未完成音轨文件"}
          </TextButton>
          {confirmEmbyAudioClear ? (
            <Button
              tone="unstyled"
              type="button"
              className="text-xs text-content-muted hover:text-content-secondary"
              onClick={() => setConfirmEmbyAudioClear(false)}
            >
              取消
            </Button>
          ) : null}
        </div>
      </div>
      <InfoBox>
        项目文件只保存弹幕、媒体引用、本地路径引用和编辑状态，不嵌入视频内容，也不会保存 Emby
        密码或 token。完整音轨及收据均保守保留，覆盖历史修订、未保存项目与未知引用。
      </InfoBox>
      <InfoBox>
        本地应用设置只保存默认导出目录、服务器地址、路径前缀、用户名、FFmpeg 路径、mpv
        路径、播放器后端偏好、声谱计算策略和对齐默认参数。设置备份会带
        schemaVersion，旧版无版本备份仍可导入。桌面端优先写入 Tauri
        应用配置目录，网页模式使用浏览器本地存储。Emby 密码
        只保存在当前应用进程内，关闭应用后失效；它们不会进入设置备份。
      </InfoBox>
      <InfoBox>完整音轨不参与自动清理；匹配特征缓存可以重新计算。</InfoBox>
    </SettingsSection>
  );
}

function CacheStatusCard({
  label,
  status
}: {
  label: string;
  status: AlignmentFeatureCacheStatus["coarse"];
}) {
  return (
    <div className="rounded border border-panel-line bg-panel-soft p-3 text-xs">
      <p className="font-medium text-content-secondary">{label}</p>
      <p className="mt-2 text-content-muted">
        {status.persistentEntries} 项 · {formatCacheBytes(status.persistentBytes)}
      </p>
      <p className="mt-1 text-ui-caption text-content-subtle">
        上限 {status.maxPersistentEntries} 项 / {formatCacheBytes(status.maxPersistentBytes)}
      </p>
    </div>
  );
}

function AboutSettingsPanel() {
  return (
    <SettingsSection
      title="关于"
      description="Danmaku Timeline Studio 配置保留为草稿，保存后生效。"
    >
      <div className="grid gap-2 text-xs text-content-secondary">
        <InfoRow label="版本" value={APP_VERSION} />
        <InfoRow
          label="风格方向"
          value="Windows 11 / PowerToys 式工具外壳 + 深色专业时间线工作区"
        />
        <InfoRow
          label="当前阶段"
          value="成熟度提升主线：播放器工具链、音频对齐与项目安全硬化"
        />
        <InfoRow label="数据边界" value="用户主动导入的本地文件和用户授权访问的媒体元数据" />
      </div>
    </SettingsSection>
  );
}

function SettingsSection({
  title,
  description,
  children
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-4">
      <div>
        <h3 className="text-base font-semibold text-content-primary">{title}</h3>
        <p className="mt-1 text-xs leading-5 text-content-muted">{description}</p>
      </div>
      <div className="grid gap-4 rounded border border-panel-line bg-panel-soft p-4">
        {children}
      </div>
    </section>
  );
}

function InfoBox({ children }: { children: ReactNode }) {
  return (
    <div className="rounded border border-accent-cyan/20 bg-accent-cyan/10 p-3 text-xs leading-5 text-content-secondary">
      {children}
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[92px_minmax(0,1fr)] gap-3 border-b border-panel-line py-2 last:border-b-0">
      <span className="text-content-muted">{label}</span>
      <span className="text-content-secondary">{value}</span>
    </div>
  );
}

function readNumericInput(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatCacheBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function readPreviewBackendPreferenceInput(value: string): PreviewBackendPreference {
  return value === "auto" || value === "htmlVideo" || value === "nativeMpv" ? value : "auto";
}

function formatPreviewBackendPreference(value: PreviewBackendPreference): string {
  if (value === "nativeMpv") {
    return "优先使用应用内 libmpv";
  }
  if (value === "htmlVideo") {
    return "只使用 HTML Video 轻量预览";
  }
  return "自动选择可用后端";
}

function formatSpectralBackendPreference(value: SpectralBackendPreference): string {
  if (value === "cuda") {
    return "强制 GPU（失败不回退 CPU）";
  }
  if (value === "cpu") {
    return "强制 CPU（CUDA 已禁用）";
  }
  return "自动推荐（需要时回退 CPU）";
}

function formatToolName(tool: MediaToolKind): string {
  return tool === "ffmpeg" ? "FFmpeg" : "mpv";
}

function setStatus(message: string, tone: "success" | "warning" | "error" | "neutral") {
  useEditorStore.setState({ status: { message, tone } });
}

function formatSettingsImportError(file: File, error: unknown): string {
  const detail = formatDesktopSettingsError(error);
  if (detail.includes(file.name)) {
    return `导入设置失败：${detail}`;
  }
  return `导入设置失败：${file.name}：${detail}`;
}
