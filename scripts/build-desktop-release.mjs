import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";

// Encode individual compiler arguments so paths containing spaces stay intact.
// Public binaries must not embed the builder's account or private checkout path.
const flags = process.env.CARGO_ENCODED_RUSTFLAGS
  ? process.env.CARGO_ENCODED_RUSTFLAGS.split("\x1f")
  : (process.env.RUSTFLAGS ?? "").split(/\s+/).filter(Boolean);
flags.push(
  `--remap-path-prefix=${homedir()}=/build/user`,
  `--remap-path-prefix=${resolve(".")}=/build/studio`
);
if (process.platform === "win32") flags.push("-C", "link-arg=/PDBALTPATH:danmaku_studio.pdb");
const env = { ...process.env, CARGO_ENCODED_RUSTFLAGS: flags.join("\x1f") };
delete env.RUSTFLAGS;
const result = spawnSync("corepack pnpm exec tauri build", {
  shell: true,
  stdio: "inherit",
  env
});
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
