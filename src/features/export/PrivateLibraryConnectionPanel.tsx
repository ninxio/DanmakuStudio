import { useEffect, useState } from "react";
import { Button } from "../../components/Button";
import { Field } from "../../components/Field";
import {
  privateLibraryStatus,
  configurePrivateLibrary,
  clearPrivateLibrary,
  testPrivateLibrary,
  privateLibraryPlayerUrl,
  privateLibraryError
} from "../../infrastructure/private-library/privateLibrary";

export function PrivateLibraryConnectionPanel({
  onOpenLibrary
}: { onOpenLibrary?: () => void } = {}) {
  const [baseUrl, setBaseUrl] = useState("");
  const [publishToken, setPublishToken] = useState("");
  const [readToken, setReadToken] = useState("");
  const [configured, setConfigured] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    let active = true;
    void privateLibraryStatus()
      .then((s) => {
        if (active) {
          setBaseUrl(s.baseUrl);
          setConfigured(s.configured);
        }
      })
      .catch((e) => {
        if (active) setMessage(privateLibraryError(e));
      });
    return () => {
      active = false;
    };
  }, []);
  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      await action();
    } catch (e) {
      setMessage(privateLibraryError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="grid gap-3" aria-label="私人弹幕库连接">
      <h3 className="text-base font-semibold text-content-primary">私人弹幕库</h3>
      <p>连接一次，之后可检查、更新私人弹幕库。凭据由 Windows 加密保存在本机。</p>
      <fieldset disabled={busy} className="grid gap-3">
        <Field
          label="服务地址"
          placeholder="https://你的服务.workers.dev"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
        />
        <Field
          label="发布凭据"
          type="password"
          autoComplete="off"
          placeholder={configured ? "已保存；留空继续使用" : "仅供 Studio 发布使用"}
          value={publishToken}
          onChange={(e) => setPublishToken(e.target.value)}
        />
        <Field
          label="播放器读取凭据"
          type="password"
          autoComplete="off"
          placeholder={configured ? "留空保留已保存凭据" : "用于生成播放器地址"}
          value={readToken}
          onChange={(e) => setReadToken(e.target.value)}
        />
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() =>
              void run(async () => {
                const result = await configurePrivateLibrary({
                  baseUrl: baseUrl.trim(),
                  publishToken: publishToken.trim(),
                  readToken: readToken.trim()
                });
                setConfigured(result.configured);
                setBaseUrl(result.baseUrl);
                setPublishToken("");
                setReadToken("");
                setMessage("连接验证通过，凭据已加密保存。");
              })
            }
          >
            验证并保存连接
          </Button>
          <Button
            disabled={!configured}
            onClick={() =>
              void run(async () => {
                const result = await testPrivateLibrary();
                setMessage(
                  result.currentEpisodeCount === undefined
                    ? `连接正常，云端有 ${result.episodeCount} 条导入记录；数量不代表成品质量。`
                    : `连接正常，${result.currentEpisodeCount} 个当前分集，${result.pendingEpisodeCount ?? 0} 个待检查，${result.visibleEpisodeCount ?? 0} 个播放器可见。`
                );
              })
            }
          >
            检查连接
          </Button>
          <Button
            disabled={!configured}
            onClick={() =>
              void run(async () => {
                await navigator.clipboard.writeText(await privateLibraryPlayerUrl());
                setMessage(
                  "已复制只读 API 地址，可粘贴到 Hills Lite 或 Filebar。请妥善保管这个地址。"
                );
              })
            }
          >
            复制播放器 API 地址
          </Button>
          <Button
            disabled={!configured}
            onClick={() =>
              void run(async () => {
                await clearPrivateLibrary();
                setConfigured(false);
                setPublishToken("");
                setReadToken("");
                setMessage("本机连接已移除；云端成品保留。");
              })
            }
          >
            移除本机连接
          </Button>
        </div>
      </fieldset>
      <p role="status">{busy ? "正在处理连接…" : message}</p>
      {onOpenLibrary && (
        <Button disabled={busy} onClick={onOpenLibrary}>
          管理私人弹幕库
        </Button>
      )}
    </section>
  );
}
