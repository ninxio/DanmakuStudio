import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  argbFromHex,
  Hct,
  SchemeTonalSpot,
  MaterialDynamicColors,
  TonalPalette,
  redFromArgb,
  greenFromArgb,
  blueFromArgb
} from "@material/material-color-utilities";

/** Build-time only. A theme is seed data; pages, SVG and Canvas share these semantic roles. */
export function createThemeTokens(spec, dark) {
  const scheme = new SchemeTonalSpot(Hct.fromInt(argbFromHex(spec.seed)), dark, 0);
  const dynamic = (name) => MaterialDynamicColors[name].getArgb(scheme);
  const neutral = (light, night) => scheme.neutralPalette.tone(dark ? night : light);
  const custom = (name, light = 38, night = 80) =>
    TonalPalette.fromInt(argbFromHex(spec[name])).tone(dark ? night : light);
  return {
    "surface-canvas": neutral(97, 6),
    "surface-base": neutral(100, 10),
    "surface-raised": neutral(96, 16),
    "surface-inset": neutral(98, 8),
    "surface-soft": neutral(94, 20),
    "boundary-default": neutral(88, 25),
    "boundary-strong": dynamic("outline"),
    "content-primary": dynamic("onSurface"),
    "content-secondary": dynamic("onSurfaceVariant"),
    "content-muted": neutral(40, 73),
    "content-subtle": neutral(42, 68),
    primary: dynamic("primary"),
    "on-primary": dynamic("onPrimary"),
    "primary-container": dynamic("primaryContainer"),
    "on-primary-container": dynamic("onPrimaryContainer"),
    "feedback-running": dynamic("primary"),
    "feedback-success": custom("success"),
    "feedback-warning": custom("warning"),
    "feedback-danger": dynamic("error"),
    "timeline-track-alternate": neutral(95, 13),
    "timeline-label": neutral(40, 73),
    "timeline-guide": neutral(78, 36),
    "timeline-axis-text": dynamic("onSurfaceVariant"),
    "timeline-bright": dynamic("primary"),
    "timeline-video": dynamic("secondaryContainer"),
    "timeline-video-text": dynamic("onSecondaryContainer"),
    "timeline-clip-outline": neutral(25, 6),
    "timeline-clip-text": neutral(8, 8),
    "timeline-correction": custom("warning"),
    "timeline-correction-text": custom("warning", 30, 85),
    "timeline-danger-panel": dynamic("errorContainer"),
    "timeline-danger-outline": dynamic("error"),
    "timeline-danger-text": dynamic("onErrorContainer"),
    "evidence-supported": custom("success"),
    "evidence-source-only": custom("sourceOnly", 46, 78),
    "evidence-target-only": custom("targetOnly", 44, 78),
    "evidence-cut": custom("warning", 46, 76),
    "evidence-replacement": custom("replacement", 46, 78),
    "evidence-recovered": dynamic("primary"),
    scrim: neutral(5, 5),
    "focus-ring": dynamic("primary")
  };
}

export function createThemeCss(spec) {
  const rules = [false, true].map((dark) => {
    const tokens = createThemeTokens(spec, dark);
    const declarations = Object.entries(tokens).map(
      ([key, argb]) =>
        `  --color-${key}: ${redFromArgb(argb)} ${greenFromArgb(argb)} ${blueFromArgb(argb)};`
    );
    return `${dark ? ':root[data-theme="dark"]' : ":root"} {\n${declarations.join("\n")}\n  color-scheme: ${dark ? "dark" : "light"};\n}`;
  });
  return `/* Generated from src/design/theme.json by pnpm theme:generate. Do not edit palette values here. */\n${rules.join("\n\n")}\n\n:root {\n  --motion-fast: 120ms;\n  --motion-standard: 180ms;\n  --motion-enter: 220ms;\n  --motion-easing: cubic-bezier(0.2, 0, 0, 1);\n  --workspace-gutter-standard: 1.5rem;\n  --workspace-gutter-compact: 1rem;\n}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const spec = JSON.parse(readFileSync("src/design/theme.json", "utf8"));
  const css = createThemeCss(spec);
  const destination = "src/app/styles/theme.css";
  if (process.argv.includes("--check")) {
    if (readFileSync(destination, "utf8").replaceAll("\r\n", "\n") !== css)
      throw new Error("Theme output is stale. Run pnpm theme:generate.");
    console.log("Theme contract is current: one definition, two palettes.");
  } else {
    writeFileSync(destination, css);
    console.log(`Generated ${spec.name} light and dark themes.`);
  }
}
