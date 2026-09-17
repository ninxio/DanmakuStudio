import { describe, it, expect } from "vitest";
import { createLibraryProfile, isLibraryProfile, parseDiscoveryLink } from "./discovery";
import { createEmptyProject } from "./factory";
import { parseProjectJson, serializeProject } from "./schema";
import { useEditorStore } from "../../stores/editorStore";
import { createHistoryState } from "../history/history";
import { discoveryMotrixPrefill } from "../../application/discoveryPrefill";
describe("发现资料合同", () => {
  it("preserves public trackers and rejects explicit private credentials without stripping them", () => {
    const magnet = `magnet:?xt=urn:btih:${"a".repeat(40)}&dn=Movie&tr=${encodeURIComponent("udp://tracker.example:80/announce")}&tr=${encodeURIComponent("https://tracker.example/announce")}&xl=123`;
    const result = parseDiscoveryLink(magnet);
    expect(new URL(result.link).searchParams.getAll("tr")).toEqual([
      "udp://tracker.example:80/announce",
      "https://tracker.example/announce"
    ]);
    expect(new URL(result.link).searchParams.get("xl")).toBe("123");
    expect(() =>
      parseDiscoveryLink(
        magnet + `&tr=${encodeURIComponent("https://u:p@tracker.example/announce")}`
      )
    ).toThrow(/私密/);
    expect(() =>
      parseDiscoveryLink(
        magnet + `&tr=${encodeURIComponent("https://tracker.example/announce?passkey=private")}`
      )
    ).toThrow(/私密/);
    expect(
      parseDiscoveryLink("https://www.bilibili.com/video/BV1xx411c7mD?p=2&share_token=secret")
        .link
    ).toBe("https://www.bilibili.com/video/BV1xx411c7mD?p=2");
  });
  it("routes search pages to search and actual details to explicit resolution", () => {
    for (const link of ["https://ext.to/browse/?q=Dark", "https://nyaa.si/?q=Dark"]) {
      const parsed = parseDiscoveryLink(link);
      const item = { ...parsed, id: "a", title: "", note: "", status: "todo" as const };
      expect(
        discoveryMotrixPrefill(item, { projectId: "p", projectEpoch: 2 }, "request", "ext")
      ).toMatchObject({ kind: "search", value: "Dark" });
    }
    const parsed = parseDiscoveryLink("https://nyaa.si/view/123");
    expect(
      discoveryMotrixPrefill(
        { ...parsed, id: "a", title: "Film", note: "", status: "todo" },
        { projectId: "p", projectEpoch: 2 },
        "request",
        "ext"
      )
    ).toMatchObject({ kind: "detail", value: parsed.link });
  });
  it("round trips through project serialization and undo without altering maps or keys", () => {
    const project = createEmptyProject();
    useEditorStore.setState({
      project,
      history: createHistoryState(),
      projectLibrary: { ...useEditorStore.getState().projectLibrary, switchingProject: false }
    });
    const profile = createLibraryProfile("stable", "作品");
    const item = {
      ...parseDiscoveryLink("https://movie.douban.com/subject/1/"),
      id: "d",
      title: "作品",
      note: "待核对",
      status: "todo" as const,
      profile
    };
    expect(useEditorStore.getState().saveDiscovery([item], profile)).toBe(true);
    const snapshot = serializeProject(useEditorStore.getState().project);
    expect(parseProjectJson(snapshot).discoveryItems).toEqual([item]);
    useEditorStore
      .getState()
      .saveDiscovery([item], { ...profile, title: "新名称", aliases: ["Alias"] });
    expect(useEditorStore.getState().project.libraryProfile?.workKey).toBe(profile.workKey);
    useEditorStore.getState().undo();
    expect(useEditorStore.getState().project.libraryProfile).toEqual(profile);
    expect(useEditorStore.getState().project.mediaTimeMaps).toEqual(project.mediaTimeMaps);
    expect(parseProjectJson(serializeProject(project)).libraryProfile).toBeUndefined();
    expect(isLibraryProfile({ ...profile, publishToken: "secret" })).toBe(false);
  });
});
