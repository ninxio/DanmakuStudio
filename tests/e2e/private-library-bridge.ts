import type { Page } from "@playwright/test";
// UI-only native bridge fixture. Real D1/R2 semantics are verified by the API tests.
export async function installLibraryBridge(page: Page) {
  await page.evaluate(() => {
    const host = window as unknown as {
      isTauri: boolean;
      __LIBRARY_CALLS__: string[];
      __TAURI_EVENT_PLUGIN_INTERNALS__: unknown;
      __TAURI_INTERNALS__: {
        invoke: (name: string, args?: Record<string, unknown>) => Promise<unknown>;
        metadata: unknown;
        transformCallback: () => number;
        unregisterCallback: () => void;
        convertFileSrc: (p: string) => string;
      };
    };
    const previous = host.__TAURI_INTERNALS__?.invoke;
    host.isTauri = true;
    host.__LIBRARY_CALLS__ = [];
    host.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    let delivery: unknown = null,
      draft: unknown = null;
    let catalogSaved = false;
    const work = {
      workKey: "e2e-show",
      title: "测试作品",
      kind: "tv",
      year: null,
      episodeCount: 1,
      seasonCount: 1,
      pendingCount: 1,
      visibleCount: 0
    };
    const metadata = {
      ...work,
      editionKey: "current",
      edition: "当前弹幕",
      sourceKey: "personal",
      sourceLabel: "收藏",
      aliases: []
    };
    host.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => 1,
      unregisterCallback: () => {},
      convertFileSrc: (p) => p,
      invoke: async (name, args = {}) => {
        host.__LIBRARY_CALLS__.push(name);
        if (name === "logvar_status")
          return { configured: false, serviceUrl: "", hasAdminToken: false };
        if (name === "get_private_library_status")
          return { configured: true, baseUrl: "https://example.com", hasReadToken: true };
        if (name === "private_library_catalog") {
          const request = args.request as {
            action: string;
            data?: { season: number; expectedPlan?: string };
          };
          const candidate = {
            provider: "tmdb",
            kind: "tv",
            id: 42,
            titleZh: "测试作品",
            titleEn: "Example Show",
            originalTitle: "Example Show",
            workYear: 2022,
            workDate: "2022-09-01",
            overview: ""
          };
          const snapshot = {
            ...candidate,
            season: { number: 1, airDate: "2022-09-01", year: 2022, tmdbAirDate: "2022-09-01" }
          };
          if (request.action === "search") return { results: [candidate], hasMore: false };
          if (request.action === "work")
            return {
              work: {
                ...candidate,
                workKey: "e2e-show",
                seasons: [
                  { number: 1, airDate: "2022-09-01", year: 2022, episodeCount: 8 },
                  { number: 2, airDate: "2023-10-15", year: 2023, episodeCount: 8 }
                ]
              }
            };
          if (request.action === "profile")
            return {
              profile: catalogSaved
                ? {
                    workKey: "e2e-show",
                    version: 1,
                    work: { ...snapshot, season: null },
                    seasons: [
                      {
                        snapshot,
                        episodes: [{ number: 1, titleZh: "开场", titleEn: "Opening" }]
                      }
                    ]
                  }
                : null
            };
          if (request.action === "plan")
            return {
              planId: "d".repeat(64),
              snapshot,
              previous: null,
              affectedEpisodes: 1,
              episodes: [{ number: 1, titleZh: "开场", titleEn: "Opening" }]
            };
          if (request.action === "save") {
            catalogSaved = true;
            if (request.data?.expectedPlan !== "d".repeat(64))
              throw new Error("Missing reviewed catalogue plan");
            return { workKey: "e2e-show", version: 1, snapshot };
          }
        }
        if (name === "save_publication_delivery") {
          delivery = args.delivery;
          return {
            key: "ui-batch",
            projectId: "p",
            projectName: "测试",
            createdAt: new Date().toISOString(),
            fileCount: 1,
            byteCount: 100
          };
        }
        if (name === "load_publication_delivery") return { key: "ui-batch", delivery, draft };
        if (name === "save_publication_draft") {
          draft = args.draft;
          return;
        }
        if (name === "browse_private_library")
          return args.workKey
            ? {
                episodes: [
                  {
                    episodeId: 50,
                    revision: "a".repeat(64),
                    metadataVersion: 1,
                    reviewStatus: "pending",
                    isVisible: false,
                    canonicalMetadata: metadata,
                    manifest: {
                      ...metadata,
                      season: 1,
                      episode: 1,
                      commentCount: 200,
                      xmlHash: "c".repeat(64)
                    }
                  }
                ]
              }
            : { works: [work] };
        if (name === "prepare_private_library_publication")
          return {
            expectedRevision: "a".repeat(64),
            connectionScope: "https://example.com",
            identity: "ui"
          };
        if (name === "publish_private_library_xml")
          return {
            episodeId: 50,
            animeId: 100,
            revision: "b".repeat(64),
            commentCount: 1,
            metadataVersion: 1
          };
        if (name === "review_private_library_episode") return { success: true };
        if (name.startsWith("plugin:event|")) return 1;
        return previous ? previous(name, args) : null;
      }
    };
  });
}
