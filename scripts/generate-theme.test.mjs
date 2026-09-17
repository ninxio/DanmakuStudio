import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { redFromArgb, greenFromArgb, blueFromArgb } from "@material/material-color-utilities";
import { createThemeTokens } from "./generate-theme.mjs";
const base = JSON.parse(readFileSync("src/design/theme.json", "utf8"));
const luminance = (argb) =>
  [redFromArgb(argb), greenFromArgb(argb), blueFromArgb(argb)]
    .map((c) => c / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    .reduce((sum, c, index) => sum + c * [0.2126, 0.7152, 0.0722][index], 0);
const ratio = (a, b) =>
  (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
for (const seed of [base.seed, "#9B386D", "#297864"]) {
  test(`${seed}: both modes retain the same roles and readable text`, () => {
    const light = createThemeTokens({ ...base, seed }, false);
    const dark = createThemeTokens({ ...base, seed }, true);
    assert.deepEqual(Object.keys(light), Object.keys(dark));
    for (const theme of [light, dark]) {
      for (const surface of ["surface-base", "surface-inset", "surface-raised", "surface-soft"])
        for (const text of [
          "content-primary",
          "content-secondary",
          "content-muted",
          "content-subtle"
        ])
          assert.ok(ratio(theme[surface], theme[text]) >= 4.5, `${seed} ${surface}/${text}`);
      assert.ok(ratio(theme.primary, theme["on-primary"]) >= 4.5);
      assert.ok(ratio(theme["primary-container"], theme["on-primary-container"]) >= 4.5);
    }
  });
}
