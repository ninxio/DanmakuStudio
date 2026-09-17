const SHA256_HEX = /\b[a-f0-9]{64}\b/giu;
const WINDOWS_DRIVE_PATH = /^[a-z]:[\\/]/i;
const WINDOWS_UNC_PATH = /^(?:\\\\|\/\/)[^\\/?]/u;

/** Redact known media secrets across common Windows-equivalent and JSON-escaped spellings. */
export function redactSensitiveText(
  text: string,
  secrets: readonly string[],
  replacement = "[已隐藏本地媒体]"
): string {
  let redacted = text;
  for (const variant of collectSensitiveTextVariants(secrets)) {
    redacted = redacted.replace(new RegExp(escapeRegExp(variant), "giu"), replacement);
  }
  return redacted.replace(SHA256_HEX, "[已隐藏 SHA-256]");
}

export function containsSensitiveText(text: string, secrets: readonly string[]): boolean {
  return collectSensitiveTextVariants(secrets).some((variant) =>
    new RegExp(escapeRegExp(variant), "iu").test(text)
  );
}

export function collectSensitiveTextVariants(secrets: readonly string[]): string[] {
  const variants = new Map<string, string>();
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    const direct = collectSecretVariants(secret);
    for (const value of [...direct, ...direct.map(jsonEscapeWithoutQuotes)]) {
      if (value.length > 0) variants.set(value.toLocaleLowerCase(), value);
    }
  }
  return [...variants.values()].sort((left, right) => right.length - left.length);
}

function collectSecretVariants(secret: string): string[] {
  const variants = [secret];
  const extendedUncMatch = /^(?:\\\\\?\\UNC\\|\/\/\?\/UNC\/)(.*)$/iu.exec(secret);
  const ordinaryUnc = extendedUncMatch ? `\\\\${extendedUncMatch[1] ?? ""}` : secret;
  if (WINDOWS_UNC_PATH.test(ordinaryUnc)) {
    const tail = ordinaryUnc.slice(2);
    const backslashTail = tail.replace(/\//gu, "\\");
    const slashTail = tail.replace(/\\/gu, "/");
    variants.push(
      `\\\\${backslashTail}`,
      `//${slashTail}`,
      `\\\\?\\UNC\\${backslashTail}`,
      `//?/UNC/${slashTail}`
    );
    return variants;
  }
  const withoutExtendedPrefix = secret.replace(/^\\\\\?\\/u, "").replace(/^\/\/\?\//u, "");
  if (WINDOWS_DRIVE_PATH.test(withoutExtendedPrefix)) {
    const backslash = withoutExtendedPrefix.replace(/\//gu, "\\");
    const slash = withoutExtendedPrefix.replace(/\\/gu, "/");
    variants.push(backslash, slash, `\\\\?\\${backslash}`, `//?/${slash}`);
  }
  return variants;
}

function jsonEscapeWithoutQuotes(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
