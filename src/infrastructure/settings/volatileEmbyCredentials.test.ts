import { afterEach, expect, it } from "vitest";
import {
  clearVolatileEmbyCredentials,
  loadVolatileEmbyPassword,
  saveVolatileEmbyPassword
} from "./volatileEmbyCredentials";
afterEach(clearVolatileEmbyCredentials);
const account = {
  serverUrl: "https://media.example.test",
  pathPrefix: "/emby",
  username: "viewer"
};
it("never reuses a password for an imported project's different destination or account", () => {
  saveVolatileEmbyPassword("synthetic-password", account);
  expect(loadVolatileEmbyPassword(account)).toBe("synthetic-password");
  for (const changed of [
    { serverUrl: "https://untrusted.example.test" },
    { serverUrl: "http://media.example.test" },
    { serverUrl: "https://media.example.test:8443" },
    { username: "another" },
    { pathPrefix: "/another" },
    { serverUrl: "https://media.example.test@untrusted.example.test" }
  ])
    expect(loadVolatileEmbyPassword({ ...account, ...changed })).toBe("");
});
it("normalizes equivalent origins and clears the session", () => {
  saveVolatileEmbyPassword("synthetic-password", account);
  expect(
    loadVolatileEmbyPassword({
      ...account,
      serverUrl: "https://MEDIA.example.test:443/",
      pathPrefix: "emby/"
    })
  ).toBe("synthetic-password");
  clearVolatileEmbyCredentials();
  expect(loadVolatileEmbyPassword(account)).toBe("");
});
