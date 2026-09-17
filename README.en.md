# Danmaku Studio

[简体中文](README.md) · **English**

Bring danmaku from a different video edition to the version you actually want to watch.

Danmaku Studio is a local Windows tool for aligning and editing timed video comments. Import comment XML and media, find matching sections, review uncertain areas, and export comments for your target video. It also supports XML editing without video.

[Download](https://github.com/ninxio/DanmakuStudio/releases/latest) · [User guide (Chinese)](docs/USER_GUIDE.md) · [LogVar setup](docs/LOGVAR.md#english-quick-start) · [Changelog](CHANGELOG.md)

## Preview

Real interface, authored sample comments, no saved accounts or private media. These screenshots demonstrate the UI, not alignment accuracy. The application UI is currently in Simplified Chinese; this English README does not imply an English UI.

![Materials workspace](docs/images/workspace.png)

<details>
<summary>Comment editor and LogVar connection</summary>

![Comment editor](docs/images/editor.png)

![LogVar connection](docs/images/logvar.png)

</details>

## Features

- **Audio alignment:** match common audio with CPU processing and optional CUDA spectral computation.
- **AAP visual alignment:** compare perceptual frame hashes and build piecewise time mappings, including videos with different soundtracks or no audio.
- **Review and correction:** inspect common sections, edition differences and uncertain boundaries; preview, adjust and calibrate manually.
- **Editing and export:** retain original timestamps; work with multiple XML files and video parts; undo, save, restore, and export XML/ASS.
- **Optional media sources:** acquire accessible Bilibili comments and reference audio, or use Emby, WebDAV and Motrix.
- **Optional private library:** connect your own [LogVar / danmu_api](https://github.com/huangxd-/danmu_api) service and upload reviewed comments for compatible players.

Original XML and media are not overwritten. Alignment runs on your computer. No OpenAI, Gemini or other cloud model API is required. An API server is optional for the main editing workflow.

## How it works

A comment XML file is a list of messages and the time when each should appear. The challenge is that 90 seconds in the reference edition may correspond to a different point in your viewing edition.

Studio finds common sound or images, then builds a time conversion table for each matching section. An extra 12-second intro needs a different offset; another cut halfway through changes the offset again. A single adjustment for the whole video would not be enough.

Audio alignment listens for the same passage. AAP gives sampled images compact visual fingerprints and looks for consistent sequences. Studio uses the resulting map to move comments. Sections without reliable evidence stay available for review instead of being assigned to an arbitrary nearby frame.

## Start with your files

| What you have | Workflow |
| --- | --- |
| XML only | Materials → import XML → edit → export |
| Reference audio/video, target video and XML | Materials → audio matching → review → export |
| Similar pictures but different soundtracks | Materials → AAP visual matching → review → export |

1. **Prepare:** reference media is the edition the comments originally belong to; target media is the edition you will watch.
2. **Import:** add files in 素材 (Materials) and associate each XML with the correct reference, especially for multipart uploads.
3. **Match:** choose audio or AAP in 匹配 (Matching). AAP needs pictures on both sides; an audio download is not a substitute.
4. **Review:** check the beginning, edit points and ending in 编辑 (Editing). Resolve repeated shots, unmatched areas and uncertain boundaries.
5. **Export and play:** confirm the export scope, save XML/ASS and check it with the actual target video. Save your project separately to continue editing later.
6. **Optional upload:** connect LogVar, check title/year/season/episode, preview additions and replacements, then upload and verify the returned player data.

AAP candidates currently require review. A 250 ms sampling interval is not a guarantee of 250 ms accuracy on arbitrary media. Severe crops, redraws, repeated scenes and reordered shots can require manual work. See [algorithm details (Chinese)](docs/ALGORITHMS.md).

Studio is not a general aggregation API. If an existing API already gives your player suitable comments, you may not need it. Bilibili acquisition handles comments and reference audio from accessible posts; it cannot recover removed videos and is not a full video archiving tool.

## Download and first launch

Download the **Windows x64 setup executable** from [Releases](https://github.com/ninxio/DanmakuStudio/releases). GitHub's automatic “Source code” downloads are not installers.

- XML-only editing needs no external media tools.
- Matching needs FFmpeg and FFprobe; configure them in 设置 → 播放器与工具 (Settings → Player & tools).
- In-app MKV/HEVC preview needs a compatible x64 libmpv DLL.
- FFmpeg, libmpv and videos are not bundled. Windows needs WebView2. Use media you have permission to process.

**New users do not inherit the developer's configuration.** Bilibili starts signed out; API connections and addresses start empty. Data directories belong to the current Windows user. Sign into your own account and configure your own service if needed. Upgrades retain configuration already saved on that computer.

For the optional library, deploy [huangxd-/danmu_api](https://github.com/huangxd-/danmu_api). Studio accepts `https://your-service/TOKEN` or `https://your-service/TOKEN/api/v2`; uploads normally also require `ADMIN_TOKEN`. Existing legacy service connections remain separately available without automatic credential or content migration. [Setup and limits](docs/LOGVAR.md#english-quick-start).

## Development history

This is a capability overview, not an exact release-by-release record.

| Stage | Main changes |
| --- | --- |
| Early / 0.1 series | XML parsing, offsets and ASS export grew into audio alignment, timeline editing and a desktop application. |
| 0.2 series | Unified workspaces; recovery, episode handling, private library and local storage. |
| 0.3 | Improved title metadata, season/episode catalogues and media workflows. |
| 0.4 | Added local AAP visual matching, removed Gemini and prepared privacy-reviewed public source. |
| 0.4.1 | LogVar as the default library integration, upload previews, bounds checks, readback verification and bilingual documentation. |

## Run from source

Use Node.js 20, pnpm 9, stable Rust, the Windows C++ build tools required by Tauri 2, and WebView2.

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm tauri:dev
```

`corepack pnpm dev` provides a browser preview. Native file access, persistence, alignment and LogVar require the desktop backend. See [build instructions](docs/BUILDING.md).

## Thanks

- [bili-danmaku-mapper](https://github.com/dowdah/bili-danmaku-mapper) for the AAP perceptual-hash matching direction. Studio's segment solver and time mapping integration are independent implementations.
- [LogVar / danmu_api](https://github.com/huangxd-/danmu_api) for aggregation, player APIs and a local comment library that can consume Studio's output.
- [DanmakuBox contributors](docs/licenses/DanmakuBox-MIT.txt) for MIT-licensed code adapted in Bilibili acquisition, with its notice retained.
- [FFmpeg](https://ffmpeg.org/) and [mpv](https://mpv.io/) for media processing and preview. Runtime components are installed separately.
- [Tauri](https://tauri.app/), [React](https://react.dev/), [Lucide](https://lucide.dev/) and [Material Color Utilities](https://github.com/material-foundation/material-color-utilities) for the desktop framework, UI, icons and theme colors.

## Feedback and maintenance

Report reproducible steps, synthetic samples and incorrect timestamps without private data. Explain how the two editions differ. Do not share account credentials, authorized playback URLs or media you cannot redistribute. Project backups contain local media paths; review them before sharing.

This is an early personal project serving a niche need. It currently meets my own needs, and further version updates are unlikely.

Licensed under [GPL-3.0-only](LICENSE). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for dependency notices.
