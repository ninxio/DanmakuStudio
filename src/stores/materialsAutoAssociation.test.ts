import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as NativeXmlReceiptModule from "../infrastructure/xml/nativeXmlReceipt";
const native = vi.hoisted(() => ({ importPaths: vi.fn() }));
vi.mock("../infrastructure/xml/nativeXmlReceipt", async (importOriginal) => ({
  ...(await importOriginal<typeof NativeXmlReceiptModule>()),
  importNativeXmlPaths: native.importPaths
}));
import { createEmptyProject } from "../domain/project/factory";
import { createHistoryState } from "../domain/history/history";
import {
  createDanmakuSourceBinding,
  createLocalPathMediaReference
} from "../domain/project/mediaLibrary";
import { createMaterialIntakePlan } from "../domain/project/materialIntakePlan";
import { parseBilibiliXml } from "../infrastructure/xml/bilibiliXml";
import type { NativeXmlImportedFile } from "../infrastructure/xml/nativeXmlReceipt";
import type { EditorProject } from "../domain/project/types";
import { useEditorStore } from "./editorStore";

function xml(name: string) {
  return new File([`<i><d p="1.25,1,25,16777215,0,0,u,r">${name}</d></i>`], name, {
    type: "text/xml"
  });
}
function asset(name: string) {
  return parseBilibiliXml(`<i><d p="1.25,1,25,16777215,0,0,u,r">${name}</d></i>`, {
    fileName: name
  });
}
function reset(project: EditorProject = createEmptyProject()) {
  useEditorStore.setState({
    project,
    projectEpoch: 0,
    projectContentRevision: 0,
    history: createHistoryState(),
    importProgress: null,
    exportDraft: null,
    status: { message: "准备就绪", tone: "neutral" },
    selection: { kind: "none", ids: [] }
  });
}
function nativeFile(fileName: string): NativeXmlImportedFile {
  const parsed = asset(fileName);
  return {
    fileName,
    warnings: [],
    items: parsed.items.map(
      ({
        originalIndex,
        sourceTimeMs,
        mode,
        fontSize,
        color,
        timestamp,
        pool,
        userHash,
        rowId,
        text,
        rawPFields
      }) => ({
        originalIndex,
        sourceTimeMs,
        mode,
        fontSize,
        color,
        timestamp,
        pool,
        userHash,
        rowId,
        text,
        rawPFields
      })
    ),
    receipt: {
      domain: "danmaku-xml-content-receipt-v1",
      version: 1,
      receiptId: `xmlr-sha256:${"1".repeat(64)}`,
      contentDigest: `sha256:${"2".repeat(64)}`,
      sizeBytes: 100,
      parserVersion: "bilibili-xml-native-v1",
      inventoryDigest: `sha256:${"3".repeat(64)}`,
      issuerKeyId: `install-sha256:${"4".repeat(32)}`,
      signatureAlgorithm: "hmac-sha256-v1",
      signature: "5".repeat(64)
    }
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("import source association", () => {
  beforeEach(() => {
    reset();
    native.importPaths.mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  it.each(["xml-first", "reference-first"])(
    "14 P 乱序 %s 自动关联，并和第二次导入一起单步撤销",
    async (order) => {
      const originals = createLocalPathMediaReference(
        "original",
        "targetOriginal",
        "C:/原片.mkv"
      );
      reset({ ...createEmptyProject(), mediaLibrary: [originals] });
      const names = Array.from(
        { length: 14 },
        (_, index) => `影片_P${String(index + 1).padStart(2, "0")}`
      );
      const references = () =>
        useEditorStore.getState().importMediaPaths(
          [...names].reverse().map((name) => `C:/${name}.mp4`),
          "bilibiliReference"
        );
      const xmls = () =>
        useEditorStore
          .getState()
          .importXmlFiles(
            [...names.slice(7), ...names.slice(0, 7)].map((name) => xml(`${name}.xml`))
          );
      if (order === "xml-first") await xmls();
      else references();
      const beforeSecond = structuredClone(useEditorStore.getState().project);
      if (order === "xml-first") references();
      else await xmls();
      const state = useEditorStore.getState();
      expect(state.project.danmakuSourceBindings).toHaveLength(14);
      expect(state.history.past).toHaveLength(2);
      expect(state.status.message).toContain("已自动关联 14 组");
      for (const binding of state.project.danmakuSourceBindings) {
        const name = state.project.assets.find((item) => item.id === binding.assetId)!.fileName;
        const media = state.project.mediaLibrary.find(
          (item) => item.id === binding.sourceMediaId
        )!;
        expect(media.fileName).toBe(name.replace(/\.xml$/, ".mp4"));
      }
      expect(state.project.mediaTimeMaps).toEqual([]);
      expect(state.project.danmakuSourceSegments).toEqual([]);
      state.undo();
      expect(useEditorStore.getState().project).toEqual(beforeSecond);
      useEditorStore.getState().redo();
      expect(useEditorStore.getState().project.danmakuSourceBindings).toHaveLength(14);
    }
  );

  it("原生 XML 与浏览器媒体入口也在单个导入事务内自动关联", async () => {
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:reference"),
      revokeObjectURL: vi.fn()
    });
    try {
      useEditorStore
        .getState()
        .importMediaFiles([new File(["media"], "P1.m4a")], "bilibiliReference");
      native.importPaths.mockResolvedValue([nativeFile("P01.xml")]);
      await useEditorStore.getState().importXmlPaths(["C:/P01.xml"]);
      const state = useEditorStore.getState();
      expect(state.project.danmakuSourceBindings).toHaveLength(1);
      expect(state.project.assets[0].sourceReceipt).not.toBeNull();
      expect(state.history.past).toHaveLength(2);
      state.undo();
      expect(useEditorStore.getState().project.assets).toEqual([]);
      expect(useEditorStore.getState().project.danmakuSourceBindings).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("仅处理本批新增ID，保留人工绑定，明确应用入口仍可修复旧项目", async () => {
    const oldAsset = asset("Old.S01E01.xml");
    const oldReference = createLocalPathMediaReference(
      "old",
      "bilibiliReference",
      "C:/Old.S01E01.mp4"
    );
    const manualAsset = asset("P02.xml");
    const manualReference = createLocalPathMediaReference(
      "manual",
      "bilibiliReference",
      "C:/人工选择.mp4"
    );
    const manualBinding = createDanmakuSourceBinding(
      "manual-binding",
      manualAsset.id,
      manualReference.id
    );
    reset({
      ...createEmptyProject(),
      assets: [oldAsset, manualAsset],
      mediaLibrary: [oldReference, manualReference],
      danmakuSourceBindings: [manualBinding]
    });
    useEditorStore
      .getState()
      .importMediaPaths(["C:/P01.mp4", "C:/P02.mp4"], "bilibiliReference");
    await useEditorStore.getState().importXmlFiles([xml("P01.xml")]);
    expect(useEditorStore.getState().project.danmakuSourceBindings).toEqual(
      expect.arrayContaining([manualBinding])
    );
    expect(useEditorStore.getState().project.danmakuSourceBindings).toHaveLength(2);
    const plan = createMaterialIntakePlan(useEditorStore.getState().project);
    expect(plan.suggestions.map((row) => row.assetId)).toEqual([oldAsset.id]);
    useEditorStore.getState().applyMaterialIntakeSuggestions(
      plan,
      plan.suggestions.map((row) => row.id)
    );
    expect(useEditorStore.getState().project.danmakuSourceBindings).toHaveLength(3);
    useEditorStore.getState().undo();
    expect(useEditorStore.getState().project.danmakuSourceBindings).toHaveLength(2);
    useEditorStore.getState().importMediaPaths(["C:/不相关.mkv"], "targetOriginal");
    expect(useEditorStore.getState().project.danmakuSourceBindings).toHaveLength(2);
  });

  it("歧义不自动选择，同批重复、跨作品和跨季仍集中待处理", async () => {
    useEditorStore
      .getState()
      .importMediaPaths(
        ["C:/P01.mp4", "C:/P1.m4a", "C:/P02.mp4", "C:/作品乙.S01E03.mp4", "C:/S02E04.mp4"],
        "bilibiliReference"
      );
    await useEditorStore
      .getState()
      .importXmlFiles([
        xml("P01.xml"),
        xml("P02.xml"),
        xml("p2.xml"),
        xml("作品甲.S01E03.xml"),
        xml("S01E04.xml")
      ]);
    const plan = createMaterialIntakePlan(useEditorStore.getState().project);
    expect(useEditorStore.getState().project.danmakuSourceBindings).toEqual([]);
    expect(plan.conflicts).toHaveLength(4);
    expect(plan.unresolved).toHaveLength(1);
  });

  it("沿既有明确季集规则自动关联，原生收据认领旧ID不会重新应用人工解绑", async () => {
    useEditorStore
      .getState()
      .importMediaPaths(["C:/Reference.S01E01.mp4"], "bilibiliReference");
    await useEditorStore.getState().importXmlFiles([xml("01 - S01E01.xml")]);
    const imported = useEditorStore.getState().project.assets[0];
    expect(useEditorStore.getState().project.danmakuSourceBindings).toHaveLength(1);
    useEditorStore.getState().clearXmlSourceBinding(imported.id);
    native.importPaths.mockResolvedValue([nativeFile("01 - S01E01.xml")]);
    await useEditorStore.getState().importXmlPaths(["C:/01 - S01E01.xml"]);
    expect(useEditorStore.getState().project.assets).toHaveLength(1);
    expect(useEditorStore.getState().project.assets[0].id).toBe(imported.id);
    expect(useEditorStore.getState().project.assets[0].sourceReceipt).not.toBeNull();
    expect(useEditorStore.getState().project.danmakuSourceBindings).toEqual([]);
  });

  it.each(["browser", "native"])(
    "%s XML 跨 projectId 或同ID新epoch 的迟到成功/失败不写项目和新会话状态",
    async (kind) => {
      for (const change of ["id", "epoch"] as const) {
        for (const fails of [false, true]) {
          reset();
          const pending = deferred<NativeXmlImportedFile[]>();
          const fileRead = deferred<string>();
          const file = xml("P01.xml");
          Object.defineProperty(file, "text", { value: () => fileRead.promise });
          native.importPaths.mockReturnValue(pending.promise);
          const operation =
            kind === "native"
              ? useEditorStore.getState().importXmlPaths(["C:/P01.xml"])
              : useEditorStore.getState().importXmlFiles([file]);
          const old = useEditorStore.getState().project;
          const replacement = {
            ...createEmptyProject("新会话"),
            id: change === "id" ? "different-id" : old.id
          };
          const status = { message: "新会话正在导入", tone: "neutral" as const };
          useEditorStore.setState({
            project: replacement,
            projectEpoch: change === "epoch" ? 1 : 0,
            importProgress: 0.4,
            status
          });
          if (kind === "native") {
            if (fails) pending.reject(new Error("old failure"));
            else pending.resolve([nativeFile("P01.xml")]);
          } else {
            if (fails) fileRead.reject(new Error("old failure"));
            else fileRead.resolve('<i><d p="1,1,25,1,0,0,u,r">迟到</d></i>');
          }
          await operation;
          expect(useEditorStore.getState().project).toBe(replacement);
          expect(useEditorStore.getState().status).toEqual(status);
          expect(useEditorStore.getState().importProgress).toBe(0.4);
          expect(useEditorStore.getState().history.past).toEqual([]);
        }
      }
    }
  );
});
