import { loadAppSettings, type AppSettings } from "./appSettings";
type EmbyAccount = AppSettings["emby"];
let sessionCredential: { password: string; account: string | null } | null = null;

function accountKey(account: EmbyAccount): string | null {
  try {
    const url = new URL(account.serverUrl.trim());
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return null;
    const path = `${url.pathname}/${account.pathPrefix.trim()}`
      .replace(/\/+/g, "/")
      .replace(/\/$/, "");
    return JSON.stringify([url.origin, path, account.username.trim()]);
  } catch {
    return null;
  }
}

export function isSameEmbyAccount(left: EmbyAccount, right: EmbyAccount): boolean {
  const key = accountKey(left);
  return key !== null && key === accountKey(right);
}

// No account is only for the trusted settings input. Network consumers supply their destination.
export function loadVolatileEmbyPassword(account?: EmbyAccount): string {
  if (!sessionCredential) return "";
  if (
    account &&
    (!sessionCredential.account || accountKey(account) !== sessionCredential.account)
  )
    return "";
  return sessionCredential.password;
}

export function saveVolatileEmbyPassword(
  password: string,
  account = loadAppSettings().emby
): void {
  sessionCredential = { password, account: accountKey(account) };
}

export function clearVolatileEmbyCredentials(): void {
  sessionCredential = null;
}
