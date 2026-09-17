import type { XmlMediaMetadata } from "./xmlMediaMetadata";
import type { Milliseconds } from "../shared/time";
import type { BilibiliAcquisition } from "./bilibiliAcquisition";

export type ImportWarningSeverity = "info" | "warning" | "error";

export interface ImportWarning {
  id: string;
  assetId: string;
  originalIndex: number | null;
  severity: ImportWarningSeverity;
  message: string;
  rawSnippet: string;
}

export interface DanmakuItem {
  id: string;
  assetId: string;
  originalIndex: number;
  sourceTimeMs: Milliseconds;
  mode: number | null;
  fontSize: number | null;
  color: number | null;
  timestamp: number | null;
  pool: number | null;
  userHash: string | null;
  rowId: string | null;
  text: string;
  rawPFields: string[];
  enabled: boolean;
}

/**
 * 桌面端根据用户选择的原始 XML 字节签发的内容收据。
 *
 * 该收据只证明不可变的 XML 解析库存；项目内的 asset/item id、颜色、启用状态等
 * 可编辑元数据不属于签名内容。浏览器预览导入和旧项目迁移必须使用 null，不能在
 * renderer 中合成一份看似可信的收据。
 */
export interface DanmakuXmlSourceReceipt {
  domain: "danmaku-xml-content-receipt-v1";
  version: 1;
  receiptId: string;
  contentDigest: string;
  sizeBytes: number;
  parserVersion: "bilibili-xml-native-v1";
  inventoryDigest: string;
  issuerKeyId: string;
  signatureAlgorithm: "hmac-sha256-v1";
  signature: string;
}

const XML_SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const XML_RECEIPT_ID_PATTERN = /^xmlr-sha256:[0-9a-f]{64}$/;
const XML_ISSUER_KEY_ID_PATTERN = /^install-sha256:[0-9a-f]{32}$/;
const XML_SIGNATURE_PATTERN = /^[0-9a-f]{64}$/;
const XML_RECEIPT_KEYS = new Set([
  "domain",
  "version",
  "receiptId",
  "contentDigest",
  "sizeBytes",
  "parserVersion",
  "inventoryDigest",
  "issuerKeyId",
  "signatureAlgorithm",
  "signature"
]);

export function isDanmakuXmlSourceReceipt(value: unknown): value is DanmakuXmlSourceReceipt {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const receipt = value as Record<string, unknown>;
  return (
    Object.keys(receipt).length === XML_RECEIPT_KEYS.size &&
    Object.keys(receipt).every((key) => XML_RECEIPT_KEYS.has(key)) &&
    receipt.domain === "danmaku-xml-content-receipt-v1" &&
    receipt.version === 1 &&
    typeof receipt.receiptId === "string" &&
    XML_RECEIPT_ID_PATTERN.test(receipt.receiptId) &&
    typeof receipt.contentDigest === "string" &&
    XML_SHA256_DIGEST_PATTERN.test(receipt.contentDigest) &&
    Number.isSafeInteger(receipt.sizeBytes) &&
    (receipt.sizeBytes as number) >= 0 &&
    receipt.parserVersion === "bilibili-xml-native-v1" &&
    typeof receipt.inventoryDigest === "string" &&
    XML_SHA256_DIGEST_PATTERN.test(receipt.inventoryDigest) &&
    typeof receipt.issuerKeyId === "string" &&
    XML_ISSUER_KEY_ID_PATTERN.test(receipt.issuerKeyId) &&
    receipt.signatureAlgorithm === "hmac-sha256-v1" &&
    typeof receipt.signature === "string" &&
    XML_SIGNATURE_PATTERN.test(receipt.signature)
  );
}

export interface DanmakuAsset {
  /** Locator for naming and reopening; not part of the signed XML inventory. */
  sourcePath?: string;
  acquisition?: BilibiliAcquisition;
  xmlMetadata?: XmlMediaMetadata;
  id: string;
  name: string;
  fileName: string;
  color: string;
  items: DanmakuItem[];
  warnings: ImportWarning[];
  importedAt: string;
  sourceReceipt: DanmakuXmlSourceReceipt | null;
}

export interface DanmakuClip {
  id: string;
  assetId: string;
  name: string;
  timelineStartMs: Milliseconds;
  sourceInMs: Milliseconds;
  sourceOutMs: Milliseconds;
  localOffsetMs: Milliseconds;
  enabled: boolean;
}

export interface CutMarker {
  id: string;
  name: string;
  sourceAtMs: Milliseconds;
  targetGapMs: Milliseconds;
  note: string;
}

export interface SyncAnchor {
  id: string;
  sourceMs: Milliseconds;
  targetMs: Milliseconds;
  confidence?: number;
  origin: "manual" | "automatic";
}

export interface ResolvedDanmakuEvent {
  id: string;
  item: DanmakuItem;
  clip: DanmakuClip;
  asset: DanmakuAsset;
  finalTimeMs: Milliseconds;
  originalIndex: number;
  enabled: boolean;
}
