# Danmaku Studio

[简体中文](README.md) · **English**

Bring danmaku from a different video edition to the version you actually want to watch.

Danmaku Studio is a local Windows tool for aligning and editing timed video comments. Import comment XML and media, find matching sections, review uncertain areas, and export comments for your target video. It also supports XML editing without video.

[Download](https://github.com/ninxio/DanmakuStudio/releases/latest) · [User guide (Chinese)](docs/USER_GUIDE.md) · [LogVar setup](docs/LOGVAR.md#english-quick-start) · [Changelog](CHANGELOG.md)

## Preview

Materials, comment editing and service connections. The application UI is currently in Simplified Chinese.

![Materials workspace](docs/images/workspace.png)

<details>
<summary>Comment editor and LogVar connection</summary>

![Comment editor](docs/images/editor.png)

![LogVar connection](docs/images/logvar.png)

</details>

## Features

- **Audio alignment:** match common audio with CPU processing and optional CUDA spectral computation.
- **AAP visual alignment (experimental):** an attempt at piecewise alignment using perceptual frame hashes. It has not been tested in actual use and remains a starting point for future forks.
- **Review and correction:** inspect common sections, edition differences and uncertain boundaries; preview, adjust and calibrate manually.
- **Editing and export:** retain original timestamps; work with multiple XML files and video parts; undo, save, restore, and export XML/ASS.
- **Optional media sources:** acquire accessible Bilibili comments and reference audio, or use Emby, WebDAV and Motrix.
- **Optional private library:** connect your own [LogVar / danmu_api](https://github.com/huangxd-/danmu_api) service and upload reviewed comments for compatible players.

Editing preserves the original XML and media. Alignment runs locally without cloud models.

## How it works

Studio compares the reference and target media to find common sections and build a piecewise time mapping. Audio alignment matches shared sound; AAP compares perceptual frame hashes to find corresponding sequences.

Comment timestamps are converted through this mapping, allowing different offsets around introductions, cuts and inserted sections. Repeated shots, unmatched regions and uncertain boundaries need review or manual calibration. See [algorithm details (Chinese)](docs/ALGORITHMS.md).

## Start with your files

| What you have | Workflow |
| --- | --- |
| XML only | Materials → import XML → edit → export |
| Reference audio/video, target video and XML | Materials → audio matching → review → export |
| Similar pictures but different soundtracks | Try experimental AAP → review and calibrate each segment → export |

1. **Prepare:** reference media is the edition the comments originally belong to; target media is the edition you will watch.
2. **Import:** add files in 素材 (Materials) and associate each XML with the correct reference, especially for multipart uploads.
3. **Match:** choose audio matching or try experimental AAP in 匹配 (Matching). AAP needs pictures on both sides; an audio download is not a substitute.
4. **Review:** check the beginning, edit points and ending in 编辑 (Editing). Resolve repeated shots, unmatched areas and uncertain boundaries.
5. **Export and play:** confirm the export scope, save XML/ASS and check it with the actual target video. Save your project separately to continue editing later.
6. **Optional upload:** connect LogVar, check title/year/season/episode, preview additions and replacements, then upload and verify the returned player data.

AAP requires video on both sides. Use audio matching when only reference audio is available. AAP has only undergone automated and synthetic-sample checks, not actual-use testing; results on real films are not established. Future forks are welcome to validate and improve it.

## Download and requirements

Windows x64: [Download the installer](https://github.com/ninxio/DanmakuStudio/releases).

- XML-only editing needs no external media tools.
- Matching needs FFmpeg and FFprobe; configure them in 设置 → 播放器与工具 (Settings → Player & tools).
- In-app MKV/HEVC preview needs a compatible x64 libmpv DLL.
- FFmpeg, libmpv and videos are not bundled. Windows needs WebView2. Use media you have permission to process.

The optional private library works with your own [LogVar / danmu_api](https://github.com/huangxd-/danmu_api) deployment. See the [setup guide](docs/LOGVAR.md#english-quick-start) for address formats and upload permissions. Local editing, alignment and export do not require an API server.

[User guide (Chinese)](docs/USER_GUIDE.md) · [Local data and privacy (Chinese)](docs/PRIVACY.md)

## Development history

This is a capability overview, not an exact release-by-release record.

| Stage | Main changes |
| --- | --- |
| Early / 0.1 series | XML parsing, offsets and ASS export grew into audio alignment, timeline editing and a desktop application. |
| 0.2 series | Unified workspaces; recovery, episode handling, private library and local storage. |
| 0.3 | Improved title metadata, season/episode catalogues and media workflows. |
| 0.4 | Introduced an experimental AAP implementation for further exploration. |
| 0.4.1 | LogVar as the default library integration, upload previews, bounds checks, readback verification and bilingual documentation. |

## Run from source

Use Node.js 20, pnpm 9, stable Rust, the Windows C++ build tools required by Tauri 2, and WebView2.

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm tauri:dev
```

`corepack pnpm dev` provides a browser preview. Native file access, persistence, alignment and LogVar require the desktop backend. See [build instructions](docs/BUILDING.md).

## Thanks

- [DanDanPlayForAndroid](https://github.com/xyoye/DanDanPlayForAndroid) for early workflow inspiration around local video and danmaku.
- [DanmakuPlayer](https://github.com/Poker-sang/DanmakuPlayer) for product references on comment preview and playback synchronization.
- [danmubox-develop](https://github.com/danmubox/danmubox-develop) for early references on importing, organizing and exporting comments.
- [Bilibili-Evolved](https://github.com/the1812/Bilibili-Evolved) for public implementations consulted when researching comments, multipart durations and media acquisition workflows.
- [dandanplay Open Platform documentation](https://doc.dandanplay.com/open/) for research into player API compatibility.
- [bili-danmaku-mapper](https://github.com/dowdah/bili-danmaku-mapper) for the AAP perceptual-hash matching idea. Studio's implementation is exploratory, has not been tested in actual use, and is retained as a starting point for future forks.
- [LogVar / danmu_api](https://github.com/huangxd-/danmu_api) for aggregation, player APIs and a local comment library that can consume Studio's output.
- [FFmpeg](https://ffmpeg.org/) and [mpv](https://mpv.io/) for media processing and preview. Runtime components are installed separately.
- [Tauri](https://tauri.app/), [React](https://react.dev/), [Lucide](https://lucide.dev/) and [Material Color Utilities](https://github.com/material-foundation/material-color-utilities) for the desktop framework, UI, icons and theme colors.

## Feedback and maintenance

Report reproducible steps, synthetic samples and incorrect timestamps without private data. Explain how the two editions differ. Do not share account credentials, authorized playback URLs or media you cannot redistribute. Project backups contain local media paths; review them before sharing.

This is an early personal project serving a niche need. It currently meets my own needs, and further version updates are unlikely.

## Use and rights

This project was created for personal learning and interest, and its source is released under an open-source license. It is not affiliated with or officially endorsed by the third-party platforms it interacts with. Use third-party content and services in accordance with applicable laws, platform rules and the permissions required.

If you believe any code, documentation or example in this repository infringes your rights, please contact the maintainer through an [issue](https://github.com/ninxio/DanmakuStudio/issues), identifying the material and the basis of your claim. Reports will be reviewed promptly, and substantiated concerns will be addressed through removal, takedown or other appropriate action. Do not include identity documents, account credentials or other sensitive information in public reports.

Licensed under [GPL-3.0-only](LICENSE). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for dependency notices.
