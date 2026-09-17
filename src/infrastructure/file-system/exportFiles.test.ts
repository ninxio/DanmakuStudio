import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createProjectionDerivationCanonicalJson,
  createVerifiedExportVerification,
  downloadLegacyXmlFiles,
  getVerifiedExportUnavailableReason,
  openExportDirectoryPath,
  saveProjectedXmlExports,
  saveTextReportFile,
  type DesktopTextReportFileRequest,
  type DesktopVerifiedProjectedXmlExportRequest,
  type ExportFilesBridge,
  type SaveProjectedXmlExportsOptions,
  type VerifiedExportVerificationSeed
} from "./exportFiles";
import { sha256Hex } from "../../domain/shared/sha256";

describe("导出文件服务", () => {
  it("有桌面目录时仅通过文本报告命令写入 UTF-8 txt", async () => {
    const bridge = createBridge();

    const result = await saveTextReportFile(
      { fileName: "检查/报告:项目.txt", content: "健康检查通过" },
      { directoryPath: " D:\\exports ", type: "text/plain;charset=utf-8" },
      bridge
    );

    expect(result).toMatchObject({
      mode: "directory",
      fileName: "检查_报告_项目.txt",
      filePath: "D:\\exports\\检查_报告_项目.txt",
      directoryPath: "D:\\exports"
    });
    expect(bridge.saveTextReport).toHaveBeenCalledWith({
      directoryPath: "D:\\exports",
      fileName: "检查_报告_项目.txt",
      content: "健康检查通过"
    });
    expect(bridge.saveVerifiedProjectedXml).not.toHaveBeenCalled();
  });

  it("旧式多 XML 即使桌面 bridge 可用也只使用浏览器下载", async () => {
    const bridge = createBridge();
    await withBrowserDownloadMocks(async () => {
      const result = await downloadLegacyXmlFiles(
        [
          { fileName: "1.xml", content: "<i>1</i>" },
          { fileName: "2.xml", content: "<i>2</i>" }
        ],
        { archiveFileName: "合集/导出.zip" }
      );

      expect(result).toMatchObject({
        mode: "download",
        fileCount: 2,
        archiveFileName: "合集_导出.zip",
        downloadedFileName: "合集_导出.zip"
      });
    });
    expect(bridge.saveTextReport).not.toHaveBeenCalled();
    expect(bridge.saveVerifiedProjectedXml).not.toHaveBeenCalled();
  });

  it("文本报告 API 在进入 native bridge 前拒绝 XML 文件名", async () => {
    const bridge = createBridge();
    await expect(
      saveTextReportFile(
        { fileName: "projected.xml", content: "<i />" },
        { directoryPath: "D:\\exports" },
        bridge
      )
    ).rejects.toThrow("只能保存为 .txt");
    expect(bridge.saveTextReport).not.toHaveBeenCalled();
  });

  it("打开目录会调用桌面桥", async () => {
    const bridge = createBridge();

    await openExportDirectoryPath("D:\\exports", bridge);

    expect(bridge.openDirectory).toHaveBeenCalledWith("D:\\exports");
  });

  it("高精度导出只调用携带媒体依赖的原子复核写盘命令", async () => {
    const bridge = createBridge();
    const verification = createVerification();
    const isSnapshotCurrent = vi.fn(() => true);

    await saveProjectedXmlExports(
      [{ fileName: "episode.xml", content: "<i />" }],
      { directoryPath: "D:\\exports", verification, isSnapshotCurrent },
      bridge
    );

    expect(isSnapshotCurrent).toHaveBeenCalledTimes(1);
    expect(bridge.saveTextReport).not.toHaveBeenCalled();
    const [verifiedRequest] = vi.mocked(bridge.saveVerifiedProjectedXml!).mock.calls[0];
    expect(verifiedRequest.directoryPath).toBe("D:\\exports");
    expect(verifiedRequest.fileName).toBe("episode.xml");
    expect(verifiedRequest.contentBytes).toEqual(Array.from(new TextEncoder().encode("<i />")));
    expect(verifiedRequest.verification).toMatchObject(verification);
    expect(verifiedRequest.verification.archiveFileName).toBe("episode.xml");
    expect(verifiedRequest.verification.archiveContentDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(verifiedRequest.verification.manifestJson).toContain("verified-export-manifest-v3");
    expect(verifiedRequest.verification.manifestJson).not.toContain("projection-derivation-v2");
    expect(verifiedRequest.verification.manifestDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(verifiedRequest.verification.projectSnapshotDigest).toMatch(
      /^sha256:[0-9a-f]{64}$/
    );
    expect(verifiedRequest.verification.outputs).toHaveLength(1);
    expect(verifiedRequest.verification.outputs[0]?.fileName).toBe("episode.xml");
    expect(verifiedRequest.verification.outputs[0]?.contentDigest).toMatch(
      /^sha256:[0-9a-f]{64}$/
    );
  });

  it("内置自动验证 proof 使用独立 manifest 分支且不能与人工 proof 混用", () => {
    const seed = createVerification();
    const proof = seed.mapProofs[0];
    delete proof.manualVerification;
    proof.automaticVerification = {
      calibrationArtifactId: "alignment-v2.5-independent-holdout-policy",
      calibrationArtifactVersion: "1",
      verifier: "Danmaku Timeline Studio native+domain policy",
      verifiedAt: "2026-08-19T00:00:00.000Z"
    };

    const verification = createVerifiedExportVerification(
      seed,
      "episode.xml",
      new TextEncoder().encode("<i />"),
      [{ fileName: "episode.xml", content: "<i />" }]
    );
    const manifest = JSON.parse(verification.manifestJson) as unknown[][];
    expect((manifest[8] as unknown[][])[0]?.[11]).toEqual([
      "automatic-calibration",
      "alignment-v2.5-independent-holdout-policy",
      "1",
      "Danmaku Timeline Studio native+domain policy",
      "2026-08-19T00:00:00.000Z"
    ]);

    proof.manualVerification = {
      verificationId: "verification-1",
      issuerKeyId: "install-sha256:fixture",
      signatureAlgorithm: "hmac-sha256-v1",
      signature: "d".repeat(64),
      requestPayload: "[]",
      requestDigest: `sha256:${"e".repeat(64)}`
    };
    expect(() =>
      createVerifiedExportVerification(
        seed,
        "episode.xml",
        new TextEncoder().encode("<i />"),
        [{ fileName: "episode.xml", content: "<i />" }]
      )
    ).toThrow("必须且只能携带");
  });

  it("高精度多文件导出同时绑定 ZIP bytes 与每个逻辑 XML", async () => {
    const bridge = createBridge();
    const verification = createVerification();
    verification.projectionDerivation.targetOutputFiles = [
      { targetMediaId: "target-1", fileName: "1.xml" },
      { targetMediaId: "target-2", fileName: "2.xml" }
    ];
    await saveProjectedXmlExports(
      [
        { fileName: "1.xml", content: "<i>1</i>" },
        { fileName: "2.xml", content: "<i>2</i>" }
      ],
      {
        directoryPath: "D:\\exports",
        archiveFileName: "season.zip",
        verification,
        isSnapshotCurrent: () => true
      },
      bridge
    );

    const [request] = vi.mocked(bridge.saveVerifiedProjectedXml!).mock.calls[0];
    expect(request.fileName).toBe("season.zip");
    expect(request.contentBytes.slice(0, 4)).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(request.verification.archiveFileName).toBe("season.zip");
    expect(request.verification.archiveContentDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(request.verification.outputs.map((output) => output.fileName)).toEqual([
      "1.xml",
      "2.xml"
    ]);
    expect(request.verification.manifestJson).toContain("season.zip");
  });

  it("canonical manifest 按 UTF-8 bytes 排序非 BMP 文件名与 mapId", () => {
    const seed = createVerification();
    const privateUse = "\uE000";
    const emoji = "😀";
    const baseProof = seed.mapProofs[0];
    seed.mapProofs = [
      createProofForMapId(baseProof, `map-${emoji}`),
      createProofForMapId(baseProof, `map-${privateUse}`)
    ];
    seed.projectionDerivation.routes[0].timeMapId = `map-${emoji}`;
    seed.projectionDerivation.targetOutputFiles = [
      { targetMediaId: "target-private-use", fileName: `${privateUse}.xml` },
      { targetMediaId: "target-emoji", fileName: `${emoji}.xml` }
    ];
    seed.dependencies = [
      {
        ...seed.dependencies[0],
        mapIds: [`map-${emoji}`, `map-${privateUse}`]
      }
    ];

    const verification = createVerifiedExportVerification(
      seed,
      "season.zip",
      new Uint8Array([1, 2, 3]),
      [
        { fileName: `${emoji}.xml`, content: "emoji" },
        { fileName: `${privateUse}.xml`, content: "private-use" }
      ]
    );

    expect(verification.outputs.map((output) => output.fileName)).toEqual([
      `${privateUse}.xml`,
      `${emoji}.xml`
    ]);
    expect(verification.mapProofs.map((proof) => proof.mapId)).toEqual([
      `map-${privateUse}`,
      `map-${emoji}`
    ]);
    expect(verification.dependencies[0]?.mapIds).toEqual([`map-${privateUse}`, `map-${emoji}`]);
  });

  it("v3 manifest 以固定数组绑定 XML 收据与完整 derivation", () => {
    const seed = createVerification();
    seed.projectionDerivation.disabledItemIds = ["item-z", "item-a", "item-z"];
    seed.projectionDerivation.itemTimeAdjustments = [
      { itemId: "item-z", adjustmentMs: 20 },
      { itemId: "item-a", adjustmentMs: -10 }
    ];

    const verification = createVerifiedExportVerification(
      seed,
      "episode.xml",
      new TextEncoder().encode("<i />"),
      [{ fileName: "episode.xml", content: "<i />" }]
    );
    const manifest = JSON.parse(verification.manifestJson) as unknown[];
    const derivation = JSON.parse(
      createProjectionDerivationCanonicalJson(verification.projectionDerivation)
    ) as unknown[];

    expect(manifest.slice(0, 4)).toEqual([
      "verified-export-manifest-v3",
      3,
      "project-1",
      "2026-07-12T00:00:00.000Z"
    ]);
    expect(manifest).toHaveLength(10);
    expect(manifest[4]).toBe(verification.projectSnapshotDigest);
    expect(manifest[5]).toBe("episode.xml");
    expect((manifest[8] as unknown[][])[0]?.[6]).toBe(seed.mapProofs[0].coreCanonicalJson);
    expect(derivation.slice(0, 5)).toEqual([
      "projection-derivation-v2",
      "source-projection-v1",
      "bilibili-xml-export-v1",
      "project-1",
      "2026-07-12T00:00:00.000Z"
    ]);
    expect((derivation[5] as unknown[][]).map((media) => media[0])).toEqual([
      "source-1",
      "target-1"
    ]);
    expect((derivation[6] as unknown[][])[0]?.[2]).toEqual([
      "danmaku-xml-content-receipt-v1",
      1,
      `xmlr-sha256:${"a".repeat(64)}`,
      `sha256:${"b".repeat(64)}`,
      123,
      "bilibili-xml-native-v1",
      `sha256:${"d".repeat(64)}`,
      "xml-key-1",
      "hmac-sha256-v1",
      "e".repeat(64)
    ]);
    expect((derivation[6] as unknown[][])[0]?.[3]).toHaveLength(2);
    expect((derivation[8] as unknown[][]).map((route) => route[0])).toEqual([
      "route-content",
      "route-ignored"
    ]);
    expect(derivation[9]).toEqual(["item-a", "item-z"]);
    expect(derivation[10]).toEqual([
      ["item-a", -10],
      ["item-z", 20]
    ]);
    expect(derivation[11]).toEqual([["target-1", "episode.xml"]]);
    expect(`sha256:${sha256Hex(JSON.stringify(derivation))}`).toBe(
      verification.projectSnapshotDigest
    );
  });

  it("v3 verification 对缺失 inventory、快照错配和 TimeMap core 分离全部失败关闭", () => {
    const create = (seed: VerifiedExportVerificationSeed) =>
      createVerifiedExportVerification(seed, "episode.xml", new TextEncoder().encode("<i />"), [
        { fileName: "episode.xml", content: "<i />" }
      ]);

    const unsupported = createVerification();
    unsupported.schemaVersion = 1 as 3;
    expect(() => create(unsupported)).toThrow("版本不受支持");

    const mismatchedSnapshot = createVerification();
    mismatchedSnapshot.projectionDerivation.projectUpdatedAt = "2026-07-12T00:00:01.000Z";
    expect(() => create(mismatchedSnapshot)).toThrow("项目快照不一致");

    const tamperedCore = createVerification();
    tamperedCore.mapProofs[0].coreCanonicalJson += " ";
    expect(() => create(tamperedCore)).toThrow("coreCanonicalJson 与 coreDigest 不一致");

    const legacyCore = createVerification();
    const legacyCoreFields = JSON.parse(legacyCore.mapProofs[0].coreCanonicalJson) as unknown[];
    legacyCoreFields[0] = "media-time-map-core-v1";
    legacyCore.mapProofs[0].coreCanonicalJson = JSON.stringify(legacyCoreFields);
    legacyCore.mapProofs[0].coreDigest = `sha256:${sha256Hex(
      legacyCore.mapProofs[0].coreCanonicalJson
    )}`;
    expect(() => create(legacyCore)).toThrow("media-time-map-core-v2");

    const duplicateAdjustment = createVerification();
    duplicateAdjustment.projectionDerivation.itemTimeAdjustments.push({
      itemId: "item-1",
      adjustmentMs: 99
    });
    expect(() => create(duplicateAdjustment)).toThrow("重复的单条时间调整");

    const mismatchedLogicalOutput = createVerification();
    mismatchedLogicalOutput.projectionDerivation.targetOutputFiles[0].fileName = "other.xml";
    expect(() => create(mismatchedLogicalOutput)).toThrow("没有绑定对应的投影目标");

    const oversizedInventory = createVerification();
    const repeatedItem = oversizedInventory.projectionDerivation.xmlAssets[0].items[0];
    oversizedInventory.projectionDerivation.xmlAssets[0].items = Array.from(
      { length: 500_001 },
      () => repeatedItem
    );
    expect(() => create(oversizedInventory)).toThrow("最多处理 500,000 条");

    const oversizedRawFields = createVerification();
    oversizedRawFields.projectionDerivation.xmlAssets[0].items[0].rawPFields = Array.from(
      { length: 65 },
      () => ""
    );
    expect(() => create(oversizedRawFields)).toThrow("安全大小上限");
  });

  it("XML 内容收据变化会同时改变项目投影摘要与 manifest 摘要", () => {
    const original = createVerification();
    const changed = createVerification();
    changed.projectionDerivation.xmlAssets[0].sourceReceipt!.inventoryDigest =
      `sha256:${"f".repeat(64)}`;

    const first = createVerifiedExportVerification(
      original,
      "episode.xml",
      new TextEncoder().encode("<i />"),
      [{ fileName: "episode.xml", content: "<i />" }]
    );
    const second = createVerifiedExportVerification(
      changed,
      "episode.xml",
      new TextEncoder().encode("<i />"),
      [{ fileName: "episode.xml", content: "<i />" }]
    );

    expect(second.projectSnapshotDigest).not.toBe(first.projectSnapshotDigest);
    expect(second.manifestDigest).not.toBe(first.manifestDigest);
  });

  it("高精度导出在浏览器环境和缺少桌面目录时都严格阻断", async () => {
    const unavailableBridge = { ...createBridge(), isAvailable: () => false };
    await expect(
      saveProjectedXmlExports(
        [{ fileName: "episode.xml", content: "<i />" }],
        {
          directoryPath: "D:\\exports",
          verification: createVerification(),
          isSnapshotCurrent: () => true
        },
        unavailableBridge
      )
    ).rejects.toThrow("仅可在支持写盘前媒体身份复核的桌面端使用");

    await expect(
      saveProjectedXmlExports(
        [{ fileName: "episode.xml", content: "<i />" }],
        {
          verification: createVerification(),
          isSnapshotCurrent: () => true
        } as SaveProjectedXmlExportsOptions,
        createBridge()
      )
    ).rejects.toThrow("必须先在设置中选择桌面导出文件夹");
  });

  it("项目快照变化时不会向原子写盘命令发送内容", async () => {
    const bridge = createBridge();

    await expect(
      saveProjectedXmlExports(
        [
          { fileName: "1.xml", content: "<i>1</i>" },
          { fileName: "2.xml", content: "<i>2</i>" }
        ],
        {
          directoryPath: "D:\\exports",
          verification: createVerification(),
          isSnapshotCurrent: () => false
        },
        bridge
      )
    ).rejects.toThrow("项目或导出内容在身份核验期间发生变化");

    expect(bridge.saveVerifiedProjectedXml).not.toHaveBeenCalled();
    expect(bridge.saveTextReport).not.toHaveBeenCalled();
  });

  it("投影 XML 缺少 verified bridge、verification seed 或快照检查时全部失败关闭", async () => {
    const file = [{ fileName: "episode.xml", content: "<i />" }];

    const missingVerifiedBridge = { ...createBridge(), saveVerifiedProjectedXml: undefined };
    await expect(
      saveProjectedXmlExports(
        file,
        {
          directoryPath: "D:\\exports",
          verification: createVerification(),
          isSnapshotCurrent: () => true
        },
        missingVerifiedBridge
      )
    ).rejects.toThrow("身份复核");
    expect(missingVerifiedBridge.saveTextReport).not.toHaveBeenCalled();

    const missingSeedBridge = createBridge();
    await expect(
      saveProjectedXmlExports(
        file,
        {
          directoryPath: "D:\\exports",
          isSnapshotCurrent: () => true
        } as SaveProjectedXmlExportsOptions,
        missingSeedBridge
      )
    ).rejects.toThrow("缺少必需的映射复核凭据");
    expect(missingSeedBridge.saveTextReport).not.toHaveBeenCalled();
    expect(missingSeedBridge.saveVerifiedProjectedXml).not.toHaveBeenCalled();

    const missingSnapshotCheckBridge = createBridge();
    await expect(
      saveProjectedXmlExports(
        file,
        {
          directoryPath: "D:\\exports",
          verification: createVerification()
        } as SaveProjectedXmlExportsOptions,
        missingSnapshotCheckBridge
      )
    ).rejects.toThrow("缺少项目快照时效检查");
    expect(missingSnapshotCheckBridge.saveTextReport).not.toHaveBeenCalled();
    expect(missingSnapshotCheckBridge.saveVerifiedProjectedXml).not.toHaveBeenCalled();
  });

  it("投影导出调用点在架构上只能进入强类型 verified API", () => {
    const source = readFileSync(
      join(process.cwd(), "src", "features", "export", "exportProjectionService.ts"),
      "utf8"
    );
    const start = source.indexOf("export async function exportProjectionGroups");
    const end = source.indexOf("export function isProjectExportSnapshotCurrent", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const exportProjectionGroupsSource = source.slice(start, end);
    expect(exportProjectionGroupsSource).toContain("saveProjectedXmlExports(");
    expect(exportProjectionGroupsSource).not.toContain("downloadLegacyXmlFiles(");
    expect(exportProjectionGroupsSource).not.toContain("saveTextReportFile(");
  });

  it("native handler 与前端 bridge 都不再暴露 raw export writer", () => {
    const nativeHandlerSource = readFileSync(
      join(process.cwd(), "src-tauri", "src", "lib.rs"),
      "utf8"
    );
    const bridgeSource = readFileSync(
      join(process.cwd(), "src", "infrastructure", "file-system", "exportFiles.ts"),
      "utf8"
    );
    expect(nativeHandlerSource).toContain("export_files::save_text_report_file");
    expect(nativeHandlerSource).toContain("export_files::save_verified_projected_xml_export");
    expect(nativeHandlerSource).not.toContain("export_files::save_export_file");
    expect(nativeHandlerSource).not.toContain("export_files::save_verified_export_file");
    expect(bridgeSource).not.toContain('"save_export_file"');
    expect(bridgeSource).not.toContain('"save_verified_export_file"');
    expect(bridgeSource).toContain('"save_text_report_file"');
    expect(bridgeSource).toContain('"save_verified_projected_xml_export"');
  });

  it("可在点击前解释 verified save 的桌面能力或目录缺口", () => {
    expect(getVerifiedExportUnavailableReason("", createBridge())).toContain(
      "选择桌面导出文件夹"
    );
    expect(
      getVerifiedExportUnavailableReason("D:\\exports", {
        ...createBridge(),
        isAvailable: () => false
      })
    ).toContain("仅可在支持写盘前媒体身份复核的桌面端使用");
    expect(getVerifiedExportUnavailableReason("D:\\exports", createBridge())).toBeNull();
  });
});

function createBridge(): ExportFilesBridge {
  const createResult = (request: { directoryPath: string; fileName: string }) =>
    Promise.resolve({
      fileName: request.fileName,
      filePath: `${request.directoryPath}\\${request.fileName}`,
      directoryPath: request.directoryPath,
      wasRenamed: false
    });
  return {
    isAvailable: () => true,
    saveTextReport: vi.fn((request: DesktopTextReportFileRequest) => createResult(request)),
    saveVerifiedProjectedXml: vi.fn((request: DesktopVerifiedProjectedXmlExportRequest) =>
      createResult(request)
    ),
    openDirectory: vi.fn(() => Promise.resolve())
  };
}

async function withBrowserDownloadMocks(run: () => Promise<void>): Promise<void> {
  const createDescriptor = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
  const revokeDescriptor = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => undefined);
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => "blob:legacy-xml")
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn()
  });
  try {
    await run();
    expect(click).toHaveBeenCalledTimes(1);
  } finally {
    click.mockRestore();
    if (createDescriptor) {
      Object.defineProperty(URL, "createObjectURL", createDescriptor);
    } else {
      Reflect.deleteProperty(URL, "createObjectURL");
    }
    if (revokeDescriptor) {
      Object.defineProperty(URL, "revokeObjectURL", revokeDescriptor);
    } else {
      Reflect.deleteProperty(URL, "revokeObjectURL");
    }
  }
}

function createVerification(): VerifiedExportVerificationSeed {
  const identity = {
    algorithm: "sha256-full-file-v2" as const,
    sizeBytes: 1024,
    modifiedUnixMs: 1_752_278_400_000,
    firstSampleDigest: "a".repeat(64),
    middleSampleDigest: "a".repeat(64),
    lastSampleDigest: "a".repeat(64)
  };
  const coreCanonicalJson = createTimeMapCoreCanonicalJson("map-1", identity);
  const coreDigest = `sha256:${sha256Hex(coreCanonicalJson)}`;
  const requestPayload = JSON.stringify([
    "manual-time-map-verification-request-v1",
    "manual-review",
    "map-1",
    1,
    coreDigest,
    [
      identity.algorithm,
      identity.sizeBytes,
      identity.modifiedUnixMs,
      identity.firstSampleDigest,
      identity.middleSampleDigest,
      identity.lastSampleDigest
    ],
    [
      identity.algorithm,
      identity.sizeBytes,
      identity.modifiedUnixMs,
      identity.firstSampleDigest,
      identity.middleSampleDigest,
      identity.lastSampleDigest
    ],
    "manual-a-b-review",
    "1",
    `sha256:${"c".repeat(64)}`,
    "本机用户",
    "2026-07-12T00:00:00.000Z"
  ]);
  return {
    schemaVersion: 3,
    projectId: "project-1",
    projectUpdatedAt: "2026-07-12T00:00:00.000Z",
    projectionDerivation: {
      domain: "projection-derivation-v2",
      projectionPolicyVersion: "source-projection-v1",
      serializerVersion: "bilibili-xml-export-v1",
      projectId: "project-1",
      projectUpdatedAt: "2026-07-12T00:00:00.000Z",
      media: [
        {
          mediaId: "source-1",
          role: "bilibiliReference",
          name: "B 站参考",
          mediaFileName: "source.mkv",
          durationMs: 2_000,
          episodeLabel: null,
          contentIdentity: identity
        },
        {
          mediaId: "target-1",
          role: "targetOriginal",
          name: "原片",
          mediaFileName: "episode.mkv",
          durationMs: 1_000,
          episodeLabel: "第 1 集",
          contentIdentity: identity
        }
      ],
      xmlAssets: [
        {
          assetId: "asset-1",
          sourceFileName: "source.xml",
          sourceReceipt: {
            domain: "danmaku-xml-content-receipt-v1",
            version: 1,
            receiptId: `xmlr-sha256:${"a".repeat(64)}`,
            contentDigest: `sha256:${"b".repeat(64)}`,
            sizeBytes: 123,
            parserVersion: "bilibili-xml-native-v1",
            inventoryDigest: `sha256:${"d".repeat(64)}`,
            issuerKeyId: "xml-key-1",
            signatureAlgorithm: "hmac-sha256-v1",
            signature: "e".repeat(64)
          },
          items: [
            createDerivationItem("item-1", 0, 500, "正文"),
            createDerivationItem("item-2", 1, 1_500, "忽略")
          ]
        }
      ],
      sourceBindings: [
        { bindingId: "binding-1", assetId: "asset-1", sourceMediaId: "source-1" }
      ],
      routes: [
        {
          routeId: "route-content",
          kind: "content",
          assetId: "asset-1",
          sourceMediaId: "source-1",
          sourceStartMs: 0,
          sourceEndMs: 1_000,
          targetMediaId: "target-1",
          targetStartMs: 0,
          timeMapId: "map-1",
          timingRules: [{ ruleId: "legacy-rule", sourceAtMs: 500, gapMs: 0 }]
        },
        {
          routeId: "route-ignored",
          kind: "ignored",
          assetId: "asset-1",
          sourceMediaId: "source-1",
          sourceStartMs: 1_000,
          sourceEndMs: 2_000,
          targetMediaId: null,
          targetStartMs: null,
          timeMapId: null,
          timingRules: []
        }
      ],
      disabledItemIds: ["item-2"],
      itemTimeAdjustments: [{ itemId: "item-1", adjustmentMs: 25 }],
      targetOutputFiles: [{ targetMediaId: "target-1", fileName: "episode.xml" }]
    },
    mapProofs: [
      {
        mapId: "map-1",
        revision: 1,
        state: "confirmed",
        declaredQuality: "verified",
        spanKinds: ["matched"],
        coreDigest,
        coreCanonicalJson,
        sourceMediaId: "source-1",
        targetMediaId: "target-1",
        sourceIdentity: identity,
        targetIdentity: identity,
        manualVerification: {
          verificationId: "verification-1",
          issuerKeyId: "install-sha256:fixture",
          signatureAlgorithm: "hmac-sha256-v1",
          signature: "d".repeat(64),
          requestPayload,
          requestDigest: `sha256:${"e".repeat(64)}`
        }
      }
    ],
    dependencies: [
      {
        mediaId: "source-1",
        path: "D:\\media\\source.mkv",
        expectedIdentity: identity,
        mapIds: ["map-1"]
      },
      {
        mediaId: "target-1",
        path: "D:\\media\\target.mkv",
        expectedIdentity: identity,
        mapIds: ["map-1"]
      }
    ]
  };
}

function createProofForMapId(
  baseProof: VerifiedExportVerificationSeed["mapProofs"][number],
  mapId: string
): VerifiedExportVerificationSeed["mapProofs"][number] {
  const coreCanonicalJson = createTimeMapCoreCanonicalJson(mapId, baseProof.sourceIdentity);
  return {
    ...baseProof,
    mapId,
    coreCanonicalJson,
    coreDigest: `sha256:${sha256Hex(coreCanonicalJson)}`
  };
}

function createTimeMapCoreCanonicalJson(
  mapId: string,
  identity: VerifiedExportVerificationSeed["mapProofs"][number]["sourceIdentity"]
): string {
  const canonicalIdentity = [
    identity.algorithm,
    identity.sizeBytes,
    identity.modifiedUnixMs,
    identity.firstSampleDigest,
    identity.middleSampleDigest,
    identity.lastSampleDigest
  ];
  return JSON.stringify([
    "media-time-map-core-v2",
    mapId,
    1,
    "source-1",
    "target-1",
    null,
    null,
    canonicalIdentity,
    canonicalIdentity,
    0,
    1_000,
    0,
    1_000,
    [
      [
        `${mapId}:span:0001`,
        "matched",
        0,
        1_000,
        0,
        1_000,
        "测试时间图的完整逐段证据。",
        [
          "verified",
          "measured",
          0.999,
          1,
          1,
          1,
          1,
          1,
          0,
          0,
          0,
          0,
          0,
          "supported",
          "supported",
          ["used", "blocked", "blocked"],
          ["测试逐段质量证据。"]
        ],
        [
          [
            "notApplicable",
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            "连续匹配段的起点无需删减边界细化。"
          ],
          [
            "notApplicable",
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            "连续匹配段的终点无需删减边界细化。"
          ]
        ],
        []
      ]
    ],
    [0.999, "measured", 1, 1, 0, 0, 0, 0, 0, 1, 1, 1, 1, ["测试图级质量证据。"]],
    [["audio", "manual"], 1, 0, 1, 1, 1, false, "测试轨道选择。", [], ["测试证据。"]],
    "engine-v1",
    "feature-v1",
    "parameters-v1"
  ]);
}

function createDerivationItem(
  itemId: string,
  originalIndex: number,
  sourceTimeMs: number,
  text: string
): VerifiedExportVerificationSeed["projectionDerivation"]["xmlAssets"][number]["items"][number] {
  return {
    itemId,
    assetId: "asset-1",
    originalIndex,
    sourceTimeMs,
    mode: 1,
    fontSize: 25,
    color: 16_777_215,
    timestamp: 0,
    pool: 0,
    userHash: "user",
    rowId: `row-${originalIndex}`,
    text,
    rawPFields: [
      (sourceTimeMs / 1_000).toFixed(3),
      "1",
      "25",
      "16777215",
      "0",
      "0",
      "user",
      `row-${originalIndex}`
    ],
    enabled: true
  };
}
