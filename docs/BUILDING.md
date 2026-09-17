# 构建与验证

主要支持 Windows x64。需要 Node.js 20、Corepack/pnpm 9、Rust stable、Visual Studio C++ Build Tools 和 WebView2。FFmpeg/FFprobe 与 libmpv 单独安装，应用设置中可配置路径。

```powershell
corepack pnpm install --frozen-lockfile
cargo fetch --manifest-path src-tauri/Cargo.toml --locked
corepack pnpm verify
cargo test --manifest-path src-tauri/Cargo.toml -- --test-threads=4
corepack pnpm test:e2e:release
corepack pnpm tauri:build
```

`verify` 包含主题、源码和许可检查、架构检查、lint、前端全测与生产构建。浏览器用例验证生产 dist 下的编辑交互，不能替代原生媒体解码；Rust 和 AAP 实媒体脚本补充后端路径。

```powershell
cargo build --manifest-path src-tauri/Cargo.toml --bin alignment_headless
python scripts/verify-visual-aap.py --ffmpeg C:/tools/ffmpeg/bin/ffmpeg.exe --headless src-tauri/target/debug/alignment_headless.exe --output artifacts/aap-verification
```

脚本只生成合成视频，不使用私人影片。JSON 请求支持 `algorithm: "visual-aap"`；省略时保留原音频行为。命令行程序从 stdin 读取请求、向 stdout 输出提案。

发行前还需检查源码导出集合、依赖公告、安装包和真实用户操作路径。构建成功或测试通过不代表任意视频都已正确对齐。生产浏览器自动化使用合成数据和受控服务回执，不访问个人账号。

## 公开源码快照

`python scripts/prepare-public-source.py --name DanmakuStudio` 将当前源码复制到新的 `.release-export/DanmakuStudio`。脚本使用明确的文件集合，保留构建、测试、许可和产品文档，不复制 `.git`、私人开发文档、日志、用户数据或构建产物；不会自动发布。目标已存在时拒绝覆盖。

导出后先核对 `PUBLIC_SOURCE_MANIFEST.json` 中的文件和 SHA-256，再检查个人信息。需要公开仓库时，在该新目录初始化 Git，并使用你选择的公开提交身份。不要把私人开发分支的历史合并到公开快照。文件清单降低误上传风险，但不能代替秘密检测和人工检查。

`tauri:build` 为 Rust 设置构建路径重映射，并避免 Windows 可执行文件记录私人 PDB 绝对路径。正式分享前仍应检查实际产物。
