import { describe, it, expect } from "vitest";
import {
  normalizeMagnet,
  parseSourceSearch,
  parseSourceMagnet,
  sourceSearchUrl,
  validateSourceUrl
} from "./sourceProviders";
const hash = "a".repeat(40);
describe("原片网站插件", () => {
  it("查询编码且分离网站编号和 infohash", () => {
    expect(new URL(sourceSearchUrl("ext", "A&B 1968", 2)).searchParams.get("q")).toBe(
      "A&B 1968"
    );
    expect(() => normalizeMagnet("5860855")).toThrow();
    expect(normalizeMagnet(hash)).toContain(`urn:btih:${hash}`);
    expect(() => normalizeMagnet("magnet:?xt=urn:btih:111")).toThrow();
    expect(() => validateSourceUrl("https://ext.to.evil.test/")).toThrow();
  });
  it("读取 EXT 新版列表，不把注册验证码误判为封锁", () => {
    const html = `<input name="captcha_word"><table class="search-table"><tbody><tr><td><a class="torrent-title-link" href="/sample-123/">Sample &amp; Title 1968</a><a class="search-magnet-btn" data-id="123" href="javascript:void(0)">magnet</a></td><td><div class="add-block-wrapper"><span>Size</span><span>1 GB</span></div></td><td></td><td></td><td><div class="add-block-wrapper"><span>Seeds</span><span>12</span></div></td></tr></tbody></table><ul class="pages"><li class="active">1</li><li><a href="?page=2">2</a></li></ul>`;
    const value = parseSourceSearch("ext", html);
    expect(value.results[0]).toMatchObject({
      title: "Sample & Title 1968",
      size: "1 GB",
      seeds: "12",
      magnet: null,
      detailsUrl: "https://ext.to/sample-123/"
    });
    expect(value.hasNext).toBe(true);
  });
  it("Nyaa 只取标题链接与实际磁力，忽略评论链接", () => {
    const v = parseSourceSearch(
      "nyaa",
      `<table class="torrent-list"><tbody><tr class="default"><td></td><td><a href="/view/1#comments">3</a><a href="/view/1">Example S01E01</a></td><td><a href="magnet:?xt=urn:btih:${hash}&amp;dn=Example">magnet</a></td><td>2 GB</td><td></td><td>4</td></tr></tbody></table>`
    );
    expect(v.results[0].title).toBe("Example S01E01");
    expect(v.results[0].magnet).toContain("&dn=Example");
  });
  it("验证页面与结构变化不伪装零结果，隐藏按钮不伪装有效磁力", () => {
    expect(() => parseSourceSearch("ext", "<title>Just a moment...</title>")).toThrow(
      /浏览器验证/
    );
    expect(() => parseSourceSearch("nyaa", "<h1>Maintenance</h1>")).toThrow(/未返回/);
    expect(
      parseSourceMagnet(
        '<button id="show-hash-btn" data-id="123">View Hash</button><div id="torrent-hash-display">Loading...</div>'
      )
    ).toBeNull();
    expect(parseSourceMagnet(`<div id="torrent-hash-display">${hash}</div>`)).toContain(hash);
  });
});
