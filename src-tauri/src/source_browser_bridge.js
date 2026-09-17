// Runs in the separate source website window. No Tauri IPC or local credentials.
(() => {
  if (window !== window.top || !["ext.to", "nyaa.si"].includes(location.hostname)) return;
  const nonce = "__STUDIO_SOURCE_NONCE__";
  function send(magnet) {
    const url = new URL("studio-source://handoff");
    url.searchParams.set("nonce", nonce);
    url.searchParams.set("magnet", magnet);
    url.searchParams.set("title", (document.querySelector("h1")?.textContent || document.title).trim().slice(0, 400));
    location.href = url.href;
  }
  document.addEventListener("click", (event) => {
    const a = event.target instanceof Element ? event.target.closest('a[href^="magnet:"]') : null;
    if (a) { event.preventDefault(); event.stopImmediatePropagation(); send(a.getAttribute("href")); }
  }, true);
  function mount() {
    if (!document.body || document.getElementById("studio-source-handoff")) return;
    const host = document.createElement("div"); host.id = "studio-source-handoff";
    host.style.cssText = "position:fixed;left:12px;bottom:12px;z-index:2147483647;max-width:calc(100vw - 24px)";
    const root = host.attachShadow({mode:"open"});
    const panel = document.createElement("div");
    panel.style.cssText = "background:#202129;color:white;border:1px solid #8588a1;border-radius:12px;padding:12px;font:14px/1.5 system-ui;box-shadow:0 4px 24px #0006";
    const text = document.createElement("div");text.textContent = "Studio 原片助手：正常浏览并选择磁力。EXT 详情页可在 Technical → View Hash 显示哈希。";
    const button = document.createElement("button");button.type="button";button.textContent="把已显示的磁力送回 Studio";
    button.style.cssText="margin-top:8px;padding:8px 12px;border:0;border-radius:6px;background:#bfc5ff;color:#171a2b;cursor:pointer;font:inherit";
    button.onclick=()=>{
      const hash=document.querySelector("#torrent-hash-display")?.textContent?.trim();
      if(hash && /^[a-f\d]{40}$/i.test(hash)){send("magnet:?xt=urn:btih:"+hash);return;}
      const links=[...document.querySelectorAll('a[href^="magnet:"]')];
      if(links.length===1){send(links[0].getAttribute("href"));return;}
      text.textContent=links.length>1?"本页有多个磁力，请直接点击你要下载的那一项。":"尚未显示磁力。请先完成网站验证，再点击 View Hash 或网页中的磁力按钮。";
    };
    panel.append(text,button);root.append(panel);document.body.append(host);
  }
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",mount,{once:true});else mount();
})();
