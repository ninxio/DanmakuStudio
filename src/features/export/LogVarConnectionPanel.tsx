import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/Button";
import { Field } from "../../components/Field";
import {
  clearLogvar,
  configureLogvar,
  listLogvarLibrary,
  logvarPlayerUrl,
  logvarStatus,
  type LogVarStatus
} from "../../infrastructure/private-library/logvar";
import { privateLibraryError } from "../../infrastructure/private-library/privateLibrary";

export function LogVarConnectionPanel({
  onConnected,
  onOpenLibrary
}: {
  onConnected?: () => void;
  onOpenLibrary?: () => void;
}) {
  const [status, setStatus] = useState<LogVarStatus>({
    configured: false,
    serviceUrl: "",
    hasAdminToken: false
  });
  const [address, setAddress] = useState("");
  const [readToken, setReadToken] = useState("");
  const [adminToken, setAdminToken] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  useEffect(() => {
    let active = true;
    void logvarStatus()
      .then((s) => {
        if (active) setStatus(s);
      })
      .catch((e) => {
        if (active) setMessage(privateLibraryError(e));
      });
    return () => {
      active = false;
    };
  }, []);
  const run = async (action: () => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setMessage("");
    try {
      await action();
    } catch (e) {
      setMessage(privateLibraryError(e));
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  return (
    <section aria-label="LogVar 弹幕库连接" className="grid gap-3">
      <h3 className="text-base font-semibold text-content-primary">私人弹幕库 · LogVar</h3>
      <p>
        连接你部署的 danmu_api，上传整理好的弹幕供播放器使用。新安装不带任何账号或服务地址。
      </p>
      {status.configured && <p>已连接：{status.serviceUrl}（TOKEN 不回显）</p>}
      <fieldset disabled={busy} className="grid gap-3">
        <Field
          label="LogVar 接口地址"
          type="password"
          autoComplete="off"
          value={address}
          placeholder={
            status.configured
              ? "留空保留当前地址；更换服务时填写新地址"
              : "https://你的服务/TOKEN 或 …/TOKEN/api/v2"
          }
          onChange={(e) => setAddress(e.target.value)}
        />
        <Field
          label="播放器 TOKEN（地址已含 TOKEN 时可留空）"
          type="password"
          autoComplete="off"
          value={readToken}
          onChange={(e) => setReadToken(e.target.value)}
        />
        <Field
          label="ADMIN_TOKEN（上传权限）"
          type="password"
          autoComplete="off"
          value={adminToken}
          placeholder={
            status.hasAdminToken ? "已加密保存；留空保留" : "服务允许普通 TOKEN 上传时可留空"
          }
          onChange={(e) => setAdminToken(e.target.value)}
        />
        <p className="text-xs text-content-muted">
          也可填写服务根地址并单独填写 TOKEN。凭据仅由 Windows 加密保存在本机；HTTP
          连接不加密传输。播放器地址使用 TOKEN，不包含单独保存的 ADMIN_TOKEN。
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() =>
              void run(async () => {
                const saved = await configureLogvar({
                  apiAddress: address.trim(),
                  readToken: readToken.trim(),
                  adminToken: adminToken.trim()
                });
                setStatus(saved);
                setAddress("");
                setReadToken("");
                setAdminToken("");
                setMessage(
                  "连接与读取验证通过，凭据已加密保存。上传权限以服务端实际回执为准。"
                );
                onConnected?.();
              })
            }
          >
            验证并保存连接
          </Button>
          <Button
            disabled={!status.configured}
            onClick={() =>
              void run(async () => {
                const rows = await listLogvarLibrary();
                setMessage(
                  `连接正常，LogVar 本地库有 ${rows.length} 份弹幕。条数不代表对齐质量。`
                );
              })
            }
          >
            检查连接
          </Button>
          <Button
            disabled={!status.configured}
            onClick={() =>
              void run(async () => {
                await navigator.clipboard.writeText(await logvarPlayerUrl());
                setMessage("已复制播放器 API 地址。它包含 TOKEN，请只粘贴到你信任的播放器。");
              })
            }
          >
            复制播放器 API 地址
          </Button>
          <Button
            disabled={!status.configured}
            onClick={() =>
              void run(async () => {
                await clearLogvar();
                setStatus({ configured: false, serviceUrl: "", hasAdminToken: false });
                setAddress("");
                setReadToken("");
                setAdminToken("");
                setMessage("已移除本机连接，服务端弹幕保留。");
                onConnected?.();
              })
            }
          >
            移除本机连接
          </Button>
        </div>
      </fieldset>
      <p role="status">{busy ? "正在验证连接…" : message}</p>
      {onOpenLibrary && (
        <Button onClick={onOpenLibrary} disabled={busy}>
          管理私人弹幕库
        </Button>
      )}
    </section>
  );
}
