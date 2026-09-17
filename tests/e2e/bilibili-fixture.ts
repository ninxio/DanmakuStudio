import type { Page } from "@playwright/test";

/** A deterministic native boundary; no request in this fixture reaches Bilibili. */
export async function installBilibiliFixture(page: Page) {
  await page.evaluate(() => {
    const host = window as unknown as {
      __TAURI_INTERNALS__: {
        invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
        transformCallback: (callback: (event: unknown) => void, once?: boolean) => number;
      };
      __BILI_FINISH__: () => void;
      __BILI_REQUESTS__: Array<{ selectedCids: number[]; downloadAudio: boolean }>;
      __BILI_EXPORTS__: Array<{
        directoryPath: string;
        fileName: string;
        contentBase64: string;
      }>;
    };
    const native = host.__TAURI_INTERNALS__;
    const originalInvoke = native.invoke;
    const originalTransform = native.transformCallback;
    const callbacks = new Map<number, (event: unknown) => void>();
    let progressHandler: number | null = null;
    let finish: (() => void) | null = null;
    let cancelled = false;
    host.__BILI_REQUESTS__ = [];
    host.__BILI_EXPORTS__ = [];
    host.__BILI_FINISH__ = () => finish?.();
    native.transformCallback = (callback, once) => {
      const id = originalTransform(callback, once);
      callbacks.set(id, callback);
      return id;
    };
    native.invoke = async (command, args = {}) => {
      if (command === "get_storage_status")
        return {
          active: { exports: "C:/Studio/exports", bilibili: "C:/Studio/inputs/bilibili" },
          error: null
        };
      if (command === "save_edited_xml_export") {
        const request = args.request as {
          directoryPath: string;
          fileName: string;
          contentBase64: string;
        };
        host.__BILI_EXPORTS__.push(request);
        return {
          fileName: request.fileName,
          directoryPath: request.directoryPath,
          filePath: `${request.directoryPath}/${request.fileName}`,
          wasRenamed: false
        };
      }
      if (command === "plugin:event|listen" && args.event === "bilibili-download-progress") {
        progressHandler = Number(args.handler);
        return 999;
      }
      if (command === "inspect_bilibili_video")
        return {
          bvid: "BV1xx411c7mD",
          aid: 170001,
          title: "工作流示例",
          ownerName: "示例作者",
          pageCount: 3,
          pages: [1, 2, 3].map((p) => ({
            cid: 100 + p,
            page: p,
            part: `第 ${p} 段`,
            durationMs: 60_000,
            durationSource: "view.pages.duration",
            exactDuration: false,
            audioAvailable: null,
            audioCodec: null,
            audioBandwidth: null
          })),
          warnings: []
        };
      if (command === "check_bilibili_login")
        return { loggedIn: false, username: null, message: "Cookie 已过期，请更新后重试。" };
      if (
        command === "plugin:dialog|open" &&
        (args.options as { title?: string })?.title === "选择 B 站素材保存文件夹"
      )
        return "C:/Bili";
      if (command === "download_bilibili_package") {
        const request = args.request as {
          requestId: string;
          selectedCids: number[];
          downloadAudio: boolean;
        };
        host.__BILI_REQUESTS__.push({
          selectedCids: request.selectedCids,
          downloadAudio: request.downloadAudio
        });
        cancelled = false;
        if (progressHandler !== null)
          callbacks.get(progressHandler)?.({
            event: "bilibili-download-progress",
            id: 999,
            payload: {
              requestId: request.requestId,
              stage: "danmaku",
              current: 1,
              total: request.selectedCids.length,
              page: 1,
              percent: 50,
              message: "正在获取 P1 的完整弹幕"
            }
          });
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return {
          requestId: request.requestId,
          status: cancelled ? "cancelled" : "completed",
          error: null,
          results: request.selectedCids.map((cid) => ({
            bvid: "BV1xx411c7mD",
            aid: 170001,
            cid,
            page: cid - 100,
            part: `第 ${cid - 100} 段`,
            durationMs: 60_000,
            exactDuration: true,
            danmakuCount: 1,
            xmlPath: `C:/Bili/P${cid - 100}.xml`,
            audioPath: request.downloadAudio ? `C:/Bili/P${cid - 100}.m4a` : null
          }))
        };
      }
      if (command === "cancel_bilibili_download") {
        cancelled = true;
        finish?.();
        return true;
      }
      if (command === "import_bilibili_xml_files") {
        const paths = (args.request as { paths: string[] }).paths;
        if (paths.every((path) => path.startsWith("C:/Bili/")))
          return {
            files: paths.map((path) => {
              const p = Number(/P(\d+)/.exec(path)?.[1]);
              const digest = String(p).repeat(64);
              const seconds = p === 1 ? 10 : 5;
              return {
                fileName: `P${p}.xml`,
                receipt: {
                  domain: "danmaku-xml-content-receipt-v1",
                  version: 1,
                  receiptId: `xmlr-sha256:${digest}`,
                  contentDigest: `sha256:${digest}`,
                  sizeBytes: 100,
                  parserVersion: "bilibili-xml-native-v1",
                  inventoryDigest: `sha256:${digest}`,
                  issuerKeyId: `install-sha256:${"a".repeat(32)}`,
                  signatureAlgorithm: "hmac-sha256-v1",
                  signature: "b".repeat(64)
                },
                items: [
                  {
                    originalIndex: 0,
                    sourceTimeMs: seconds * 1000,
                    mode: 1,
                    fontSize: 25,
                    color: 16777215,
                    timestamp: 0,
                    pool: 0,
                    userHash: "u",
                    rowId: String(p),
                    text: `第${p}段弹幕`,
                    rawPFields: [
                      String(seconds),
                      "1",
                      "25",
                      "16777215",
                      "0",
                      "0",
                      "u",
                      String(p)
                    ]
                  }
                ],
                warnings: []
              };
            })
          };
      }
      return originalInvoke(command, args);
    };
  });
}

export async function finishBilibiliFixture(page: Page) {
  await page.evaluate(() =>
    (window as unknown as { __BILI_FINISH__: () => void }).__BILI_FINISH__()
  );
}
