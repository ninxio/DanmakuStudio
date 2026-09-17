import { isTauri } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/Button";
import {
  cancelBilibiliQr,
  getBilibiliAccount,
  logoutBilibili,
  pollBilibiliQr,
  startBilibiliQr,
  type BilibiliAccountStatus,
  type BilibiliQr
} from "../../infrastructure/bilibili/bilibiliAccount";

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export function BilibiliAccountPanel() {
  const [status, setStatus] = useState<BilibiliAccountStatus | null>(null);
  const [qr, setQr] = useState<BilibiliQr | null>(null);
  const [message, setMessage] = useState("正在读取本机账号…");
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false);
  const activeQr = useRef<string | null>(null);
  const sequence = useRef(0);

  useEffect(() => {
    mounted.current = true;
    const id = ++sequence.current;
    void getBilibiliAccount()
      .then((result) => {
        if (mounted.current && id === sequence.current) {
          setStatus(result);
          setMessage(result.message);
        }
      })
      .catch((error) => {
        if (mounted.current && id === sequence.current) setMessage(errorMessage(error));
      });
    return () => {
      mounted.current = false;
      if (activeQr.current) void cancelBilibiliQr(activeQr.current).catch(() => {});
      activeQr.current = null;
    };
  }, []);

  useEffect(() => {
    if (!qr) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (Date.now() >= qr.expiresAt) {
        setQr(null);
        setMessage("二维码已过期，请重新生成。");
        void cancelBilibiliQr(qr.attemptId).catch(() => {});
        activeQr.current = null;
        return;
      }
      try {
        const result = await pollBilibiliQr(qr.attemptId);
        if (stopped || activeQr.current !== qr.attemptId) return;
        setMessage(result.message);
        if (result.phase === "completed" && result.persisted) {
          activeQr.current = null;
          setQr(null);
          setStatus({
            state: "authenticated",
            account: result.account,
            persisted: true,
            lastVerifiedAt: Date.now(),
            message: result.message
          });
          return;
        }
        if (result.phase === "expired" || result.phase === "failed") {
          activeQr.current = null;
          setQr(null);
          return;
        }
      } catch (error) {
        if (!stopped) setMessage(errorMessage(error));
      }
      if (!stopped) timer = setTimeout(() => void poll(), 2_000);
    };
    timer = setTimeout(() => void poll(), 2_000);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [qr]);

  const run = async (action: (id: number) => Promise<void>) => {
    const id = ++sequence.current;
    setBusy(true);
    try {
      await action(id);
    } catch (error) {
      if (mounted.current && id === sequence.current) setMessage(errorMessage(error));
    } finally {
      if (mounted.current && id === sequence.current) setBusy(false);
    }
  };
  const stopQr = async () => {
    const id = activeQr.current;
    activeQr.current = null;
    setQr(null);
    if (id) await cancelBilibiliQr(id);
  };
  return (
    <section aria-label="B 站账号" className="space-y-3 rounded border border-panel-line p-3">
      <div>
        <h3 className="font-medium text-content-primary">B 站账号</h3>
        <p className="mt-1 text-xs text-content-muted">
          用 B 站 App 扫码并确认。登录加密保存在这台电脑，重启 Studio 后继续使用。
        </p>
      </div>
      {status?.account && (
        <p>
          {status.account.username}{" "}
          <span className="text-content-muted">（UID {status.account.mid}）</span>
        </p>
      )}
      <p role="status">{message}</p>
      {qr && (
        <div className="space-y-2">
          <img
            src={qr.qrImage}
            width={240}
            height={240}
            alt="B 站登录二维码，请用 B 站 App 扫码"
            className="rounded bg-white p-2"
          />
          <p className="text-xs text-content-muted">
            二维码约 3 分钟内有效，手机确认后自动保存。
          </p>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={busy || !isTauri()}
          onClick={() =>
            void run(async (id) => {
              await stopQr();
              const next = await startBilibiliQr();
              if (!mounted.current || id !== sequence.current) {
                await cancelBilibiliQr(next.attemptId);
                return;
              }
              activeQr.current = next.attemptId;
              setQr(next);
              setMessage("请用 B 站 App 扫码。");
            })
          }
        >
          {qr ? "重新生成二维码" : status?.persisted ? "重新扫码登录" : "扫码登录"}
        </Button>
        {qr && (
          <Button
            disabled={busy}
            onClick={() =>
              void run(async (id) => {
                await stopQr();
                const current = await getBilibiliAccount();
                if (mounted.current && id === sequence.current) {
                  setStatus(current);
                  setMessage(current.persisted ? current.message : "已取消扫码。");
                }
              })
            }
          >
            取消扫码
          </Button>
        )}
        {status?.persisted && (
          <>
            <Button
              disabled={busy || Boolean(qr)}
              onClick={() =>
                void run(async (id) => {
                  const result = await getBilibiliAccount(true);
                  if (mounted.current && id === sequence.current) {
                    setStatus(result);
                    setMessage(result.message);
                  }
                })
              }
            >
              检查登录
            </Button>
            <Button
              disabled={busy}
              onClick={() =>
                void run(async (id) => {
                  await stopQr();
                  await logoutBilibili();
                  if (mounted.current && id === sequence.current) {
                    setStatus(null);
                    setMessage("已退出并清除本机保存的登录。手机等其它设备不受影响。");
                  }
                })
              }
            >
              退出并清除本机登录
            </Button>
          </>
        )}
      </div>
    </section>
  );
}
