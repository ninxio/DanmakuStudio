/** Shared by acquisition and portable discovery; retain every download parameter. */
export function normalizeMagnet(value: string): string {
  const text = value.trim();
  if (text.length > 16384) throw new Error("磁力链接过长。");
  const rawHash = /^[a-f\d]{40}$/i.test(text) || /^[a-z2-7]{32}$/i.test(text);
  const url = new URL(rawHash ? `magnet:?xt=urn:btih:${text}` : text);
  if (
    url.protocol !== "magnet:" ||
    url.host ||
    url.pathname ||
    !url.searchParams
      .getAll("xt")
      .some(
        (xt) =>
          /^urn:btih:([a-f\d]{40}|[a-z2-7]{32})$/i.test(xt) ||
          /^urn:btmh:1220[a-f\d]{64}$/i.test(xt)
      )
  )
    throw new Error("请输入完整 magnet 链接或有效 Info Hash；网站的数字编号不是磁力哈希。");
  return url.href;
}
export function portableMagnet(value: string): string {
  const normalized = normalizeMagnet(value),
    url = new URL(normalized);
  const privateKey = /(?:passkey|token|password|auth|api[_-]?key|secret)/i;
  for (const [key, val] of url.searchParams) {
    if (privateKey.test(key))
      throw new Error("磁力含私密凭据，不能保存到可携带项目；请使用公共磁力。");
    if (["tr", "ws", "as", "xs", "x.pe"].includes(key)) {
      let endpoint: URL;
      try {
        endpoint = new URL(val);
      } catch {
        continue;
      }
      if (
        endpoint.username ||
        endpoint.password ||
        [...endpoint.searchParams.keys()].some((k) => privateKey.test(k)) ||
        /(?:passkey|token|password|auth|secret)[/=]/i.test(endpoint.pathname)
      )
        throw new Error(
          "磁力下载地址含账户或私密 passkey，不能持久化；请提供公共 tracker 链接。"
        );
    }
  }
  return normalized;
}
