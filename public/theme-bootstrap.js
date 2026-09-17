// Runs synchronously before first paint; keep the key aligned with themePreferences.ts.
(function () {
  var preference = "system";
  try {
    preference = localStorage.getItem("danmaku.studio.theme.v1") || "system";
  } catch {
    /* Session theme still works without storage. */
  }
  var theme =
    preference === "dark" || preference === "light"
      ? preference
      : matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
})();
