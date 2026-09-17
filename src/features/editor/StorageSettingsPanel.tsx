import { useEffect, useState } from "react";
import { Field } from "../../components/Field";
import { TextButton } from "../../components/TextButton";
import { pickSingleNativeDirectoryPath } from "../../infrastructure/file-system/nativeDialogs";
import {
  getStorageStatus,
  type StoragePaths,
  type StorageSettings,
  type StorageStatus
} from "../../infrastructure/settings/storageClient";

const pathLabels: Array<[keyof StoragePaths, string]> = [
  ["database", "项目库"],
  ["bilibili", "B 站输入"],
  ["originals", "Motrix 原片"],
  ["embyAudio", "完整音轨"],
  ["features", "可重建特征缓存"],
  ["exports", "默认导出"]
];

export function StorageSettingsPanel({
  value,
  onChange
}: {
  value: StorageSettings;
  onChange: (value: StorageSettings) => void;
}) {
  const [status, setStatus] = useState<StorageStatus | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void getStorageStatus()
      .then((v) => {
        if (active) setStatus(v);
      })
      .catch((e) => {
        if (active) setError(String(e));
      });
    return () => {
      active = false;
    };
  }, []);
  const choose = async (key: keyof StorageSettings) => {
    try {
      const path = await pickSingleNativeDirectoryPath({
        title: key === "rootDirectory" ? "选择 Studio 数据目录" : "选择缓存目录",
        defaultPath: value[key] || undefined
      });
      if (path) onChange({ ...value, [key]: path });
    } catch (e) {
      setError(String(e));
    }
  };
  return (
    <section className="grid gap-4" aria-label="存储目录设置">
      <div>
        <h3 className="text-sm font-semibold text-content-primary">存储目录</h3>
        <p className="mt-2 text-xs leading-5 text-content-muted">
          保存后，下次启动生效。项目库复制成功并校验后才切换；原库、既有素材和任务目录保留。请先保存项目，再自行退出并启动
          Studio。
        </p>
      </div>
      <Field
        label="Studio 数据目录"
        value={value.rootDirectory}
        placeholder="留空使用本机应用数据目录"
        onChange={(e) => onChange({ ...value, rootDirectory: e.target.value })}
      />
      <TextButton onClick={() => void choose("rootDirectory")}>选择数据目录</TextButton>
      <Field
        label="缓存目录（可选）"
        value={value.cacheDirectory}
        placeholder="留空使用数据目录下的 cache"
        onChange={(e) => onChange({ ...value, cacheDirectory: e.target.value })}
      />
      <TextButton onClick={() => void choose("cacheDirectory")}>选择缓存目录</TextButton>
      <p className="text-xs leading-5 text-content-muted">
        只影响之后新建的素材和缓存；已恢复的 B
        站任务、自选原片目录及导出目录继续使用原位置。更换目录不会清理旧音轨。
      </p>
      {error || status?.error ? (
        <p role="alert" className="text-xs text-feedback-danger">
          {error || status?.error} 项目库不会降级为空库。可恢复原目录设置后重新启动。
        </p>
      ) : null}
      {status?.restartRequired ? (
        <p role="status" className="text-xs text-accent-yellow">
          已保存目录变更，等待重新启动。
        </p>
      ) : null}
      {status?.active ? (
        <div className="rounded-panel border border-panel-line p-3">
          <h4 className="mb-2 text-xs font-medium">当前实际目录</h4>
          <dl className="grid gap-2 text-xs">
            {pathLabels.map(([key, label]) => (
              <div key={key}>
                <dt className="text-content-muted">{label}</dt>
                <dd className="select-text break-all text-content-primary">
                  {status.active?.[key]}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ) : !status && !error ? (
        <p role="status">正在读取实际目录…</p>
      ) : null}
      {status?.restartRequired && status.requested ? (
        <p className="break-all text-xs text-content-muted">
          下次项目库：{status.requested.database}
        </p>
      ) : null}
      {status?.fixedOutbox ? (
        <div className="text-xs leading-5 text-content-muted">
          <p>成品与发布记录（固定本机）</p>
          <p className="select-text break-all">{status.fixedOutbox}</p>
          <p>账户凭据和发布记录继续保留在本机应用数据目录，不随上述数据目录迁移。</p>
        </div>
      ) : null}
      {status?.retainedLegacyDirectories.length ? (
        <div className="text-xs leading-5 text-content-muted">
          <p>旧版目录保留</p>
          <ul>
            {status.retainedLegacyDirectories.map((path) => (
              <li key={path} className="select-text break-all">
                {path}
              </li>
            ))}
          </ul>
          <p>
            以上目录仍占用原磁盘空间；更换目录或清理当前缓存不会回收旧目录。其他曾选用的目录也保留原文件。
          </p>
        </div>
      ) : null}
      <p className="text-xs leading-5 text-content-muted">
        完整音轨是项目素材，保守保留所有修订、未保存项目和未知引用。可在“隐私与本地数据”独立清理匹配缓存和未完成的音轨临时文件。
      </p>
    </section>
  );
}
