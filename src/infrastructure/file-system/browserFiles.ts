export async function readTextFile(file: File): Promise<string> {
  try {
    if (typeof file.text === "function") {
      return await file.text();
    }
    return await readTextFileWithReader(file);
  } catch (error) {
    throw createFileReadError(file, error);
  }
}

function readTextFileWithReader(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      if (reader.result instanceof ArrayBuffer) {
        resolve(new TextDecoder().decode(reader.result));
        return;
      }
      resolve("");
    };
    reader.onerror = () => reject(new Error("读取文件失败。"));
    reader.readAsText(file);
  });
}

function createFileReadError(file: File, error: unknown): Error {
  const detail = error instanceof Error && error.message.trim().length > 0 ? `：${error.message}` : "";
  return new Error(`读取文件 ${file.name} 失败${detail}`);
}

export async function readFilesAsText(files: FileList | File[]): Promise<Array<{ file: File; text: string }>> {
  const fileArray = Array.from(files);
  return Promise.all(
    fileArray.map(async (file) => ({
      file,
      text: await readTextFile(file)
    }))
  );
}

export function createObjectUrl(file: File): string {
  return URL.createObjectURL(file);
}

export function revokeObjectUrl(url: string | null): void {
  if (url) {
    URL.revokeObjectURL(url);
  }
}

export interface TextDownloadFile {
  fileName: string;
  content: string;
}

export interface DownloadTextFilesResult {
  fileCount: number;
  archiveFileName: string | null;
  downloadedFileName: string | null;
}

const ILLEGAL_DOWNLOAD_FILE_NAME_CHARACTERS = "\\/:*?\"<>|";
const MAX_DOWNLOAD_FILE_NAME_LENGTH = 180;
const MAX_PRESERVED_EXTENSION_LENGTH = 24;
const TRAILING_WINDOWS_DOTS_AND_SPACES_PATTERN = /[. ]+$/g;
const RESERVED_WINDOWS_FILE_NAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9"
]);

export function sanitizeDownloadFileName(fileName: string, fallbackName = "download"): string {
  return sanitizeFileNameCandidate(fileName) ?? sanitizeFileNameCandidate(fallbackName) ?? "download";
}

export function downloadTextFile(fileName: string, content: string, type = "text/plain;charset=utf-8"): string {
  const blob = new Blob([content], { type });
  return downloadBlob(fileName, blob);
}

export function downloadTextFiles(
  files: TextDownloadFile[],
  type = "text/plain;charset=utf-8",
  archiveFileName = "danmaku-exports.zip"
): DownloadTextFilesResult {
  if (files.length === 0) {
    return {
      fileCount: 0,
      archiveFileName: null,
      downloadedFileName: null
    };
  }
  if (files.length === 1) {
    const downloadedFileName = downloadTextFile(files[0].fileName, files[0].content, type);
    return {
      fileCount: 1,
      archiveFileName: null,
      downloadedFileName
    };
  }
  const safeArchiveFileName = downloadBlob(
    archiveFileName,
    createStoredZip(files),
    "application/zip",
    "danmaku-exports.zip"
  );
  return {
    fileCount: files.length,
    archiveFileName: safeArchiveFileName,
    downloadedFileName: safeArchiveFileName
  };
}

export function createStoredZip(files: TextDownloadFile[]): Blob {
  const encoder = new TextEncoder();
  const entries = createStoredZipEntries(files).map((file) => {
    const nameBytes = encoder.encode(file.fileName);
    const data = encoder.encode(file.content);
    return {
      nameBytes,
      data,
      crc32: calculateCrc32(data)
    };
  });
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const localHeader = createZipLocalHeader(entry.nameBytes, entry.data, entry.crc32);
    localParts.push(localHeader, entry.data);
    centralParts.push(createZipCentralDirectoryHeader(entry.nameBytes, entry.data, entry.crc32, offset));
    offset += localHeader.byteLength + entry.data.byteLength;
  }
  const centralDirectoryOffset = offset;
  const centralDirectorySize = centralParts.reduce((sum, part) => sum + part.byteLength, 0);
  const endRecord = createZipEndOfCentralDirectory(entries.length, centralDirectorySize, centralDirectoryOffset);
  return new Blob([...localParts, ...centralParts, endRecord].map(copyBytesToArrayBuffer), { type: "application/zip" });
}

function downloadBlob(fileName: string, blob: Blob, type?: string, fallbackName = "download"): string {
  const resolvedBlob = type && blob.type !== type ? blob.slice(0, blob.size, type) : blob;
  const url = URL.createObjectURL(resolvedBlob);
  const anchor = document.createElement("a");
  anchor.href = url;
  const safeFileName = sanitizeDownloadFileName(fileName, fallbackName);
  anchor.download = safeFileName;
  anchor.click();
  URL.revokeObjectURL(url);
  return safeFileName;
}

/** Returns the exact logical names that `createStoredZip` writes into its deterministic ZIP. */
export function createStoredZipEntries(files: TextDownloadFile[]): TextDownloadFile[] {
  const usedNames = new Set<string>();
  return files.map((file) => {
    const safeName = sanitizeZipFileName(file.fileName);
    const safeNameKey = safeName.toLocaleLowerCase("en-US");
    if (!usedNames.has(safeNameKey)) {
      usedNames.add(safeNameKey);
      return { ...file, fileName: safeName };
    }
    const dotIndex = safeName.lastIndexOf(".");
    const base = dotIndex > 0 ? safeName.slice(0, dotIndex) : safeName;
    const extension = dotIndex > 0 ? safeName.slice(dotIndex) : "";
    let duplicateNumber = 2;
    let allocatedName = appendDuplicateSuffixToDownloadFileName(
      base,
      extension,
      duplicateNumber
    );
    while (usedNames.has(allocatedName.toLocaleLowerCase("en-US"))) {
      duplicateNumber += 1;
      allocatedName = appendDuplicateSuffixToDownloadFileName(base, extension, duplicateNumber);
    }
    usedNames.add(allocatedName.toLocaleLowerCase("en-US"));
    return {
      ...file,
      fileName: allocatedName
    };
  });
}

function sanitizeZipFileName(fileName: string): string {
  return sanitizeDownloadFileName(fileName, "export.xml");
}

function sanitizeFileNameCandidate(fileName: string): string | null {
  const sanitized = Array.from(fileName.trim())
    .reduce(replaceIllegalDownloadFileNameCharacter, "")
    .replace(TRAILING_WINDOWS_DOTS_AND_SPACES_PATTERN, "");
  if (sanitized.length === 0 || sanitized === "." || sanitized === "..") {
    return null;
  }
  const baseName = sanitized.split(".")[0].toUpperCase();
  if (RESERVED_WINDOWS_FILE_NAMES.has(baseName)) {
    return truncateDownloadFileName(`_${sanitized}`);
  }
  return truncateDownloadFileName(sanitized);
}

function replaceIllegalDownloadFileNameCharacter(result: string, character: string): string {
  if (!isIllegalDownloadFileNameCharacter(character)) {
    return `${result}${character}`;
  }
  return result.endsWith("_") ? result : `${result}_`;
}

function isIllegalDownloadFileNameCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0) ?? 0;
  return codePoint < 32 || codePoint === 127 || ILLEGAL_DOWNLOAD_FILE_NAME_CHARACTERS.includes(character);
}

function truncateDownloadFileName(fileName: string): string {
  const characters = Array.from(fileName);
  if (characters.length <= MAX_DOWNLOAD_FILE_NAME_LENGTH) {
    return fileName;
  }
  const extensionStart = fileName.lastIndexOf(".");
  const extension =
    extensionStart > 0 && Array.from(fileName.slice(extensionStart)).length <= MAX_PRESERVED_EXTENSION_LENGTH
      ? fileName.slice(extensionStart)
      : "";
  const extensionLength = Array.from(extension).length;
  const base = extension ? fileName.slice(0, extensionStart) : fileName;
  const baseLength = Math.max(1, MAX_DOWNLOAD_FILE_NAME_LENGTH - extensionLength);
  const truncatedBase = Array.from(base)
    .slice(0, baseLength)
    .join("")
    .replace(TRAILING_WINDOWS_DOTS_AND_SPACES_PATTERN, "");
  return `${truncatedBase}${extension}`;
}

function appendDuplicateSuffixToDownloadFileName(base: string, extension: string, duplicateNumber: number): string {
  const suffix = ` (${duplicateNumber})`;
  const extensionLength = Array.from(extension).length;
  const suffixLength = Array.from(suffix).length;
  const baseLength = Math.max(1, MAX_DOWNLOAD_FILE_NAME_LENGTH - extensionLength - suffixLength);
  const truncatedBase = Array.from(base)
    .slice(0, baseLength)
    .join("")
    .replace(TRAILING_WINDOWS_DOTS_AND_SPACES_PATTERN, "");
  return `${truncatedBase || "export"}${suffix}${extension}`;
}

function createZipLocalHeader(nameBytes: Uint8Array, data: Uint8Array, crc32: number): Uint8Array {
  const header = new Uint8Array(30 + nameBytes.byteLength);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 0x0800, true);
  view.setUint16(8, 0, true);
  view.setUint16(10, 0, true);
  view.setUint16(12, 0x0021, true);
  view.setUint32(14, crc32, true);
  view.setUint32(18, data.byteLength, true);
  view.setUint32(22, data.byteLength, true);
  view.setUint16(26, nameBytes.byteLength, true);
  view.setUint16(28, 0, true);
  header.set(nameBytes, 30);
  return header;
}

function createZipCentralDirectoryHeader(
  nameBytes: Uint8Array,
  data: Uint8Array,
  crc32: number,
  localHeaderOffset: number
): Uint8Array {
  const header = new Uint8Array(46 + nameBytes.byteLength);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x02014b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 20, true);
  view.setUint16(8, 0x0800, true);
  view.setUint16(10, 0, true);
  view.setUint16(12, 0, true);
  view.setUint16(14, 0x0021, true);
  view.setUint32(16, crc32, true);
  view.setUint32(20, data.byteLength, true);
  view.setUint32(24, data.byteLength, true);
  view.setUint16(28, nameBytes.byteLength, true);
  view.setUint16(30, 0, true);
  view.setUint16(32, 0, true);
  view.setUint16(34, 0, true);
  view.setUint16(36, 0, true);
  view.setUint32(38, 0, true);
  view.setUint32(42, localHeaderOffset, true);
  header.set(nameBytes, 46);
  return header;
}

function createZipEndOfCentralDirectory(
  entryCount: number,
  centralDirectorySize: number,
  centralDirectoryOffset: number
): Uint8Array {
  const header = new Uint8Array(22);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(4, 0, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, entryCount, true);
  view.setUint16(10, entryCount, true);
  view.setUint32(12, centralDirectorySize, true);
  view.setUint32(16, centralDirectoryOffset, true);
  view.setUint16(20, 0, true);
  return header;
}

function calculateCrc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function copyBytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

const CRC32_TABLE = createCrc32Table();

function createCrc32Table(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}
