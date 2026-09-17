//! Complete page directories are the commit unit: XML and audio become visible together.
//! Incomplete staging directories never qualify as resumable packages.

use super::{
    api::{self, DanmakuElem, PlayProbe, ViewData, ViewPage},
    *,
};
use quick_xml::{events::Event, Reader};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    io::Write,
    path::{Component, Path},
};
use tokio::io::AsyncReadExt;

const XML_NAMESPACE: &str = "urn:danmakubox:xml:metadata:1";
const MANIFEST_NAME: &str = "download.json";
const MAX_XML_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FileReceipt {
    name: String,
    size: u64,
    sha256: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PackageReceipt {
    version: u8,
    bvid: String,
    aid: u64,
    cid: u64,
    page: u32,
    page_count: usize,
    part: String,
    duration_ms: u64,
    duration_source: String,
    exact_duration: bool,
    danmaku_count: usize,
    xml: FileReceipt,
    audio: Option<FileReceipt>,
}

pub(super) struct PageOutput {
    directory: PathBuf,
}

impl PageOutput {
    pub(super) fn new(
        folder: &Path,
        view: &ViewData,
        page: &ViewPage,
        audio: bool,
    ) -> DownloadResult<Self> {
        // Stable identities survive title edits, and distinguish XML-only from audio packages so
        // adding audio later never requires replacing the user's first XML download.
        Ok(Self {
            directory: folder.join(&view.bvid).join(format!(
                "P{:03}-{}{}",
                page.page,
                page.cid,
                if audio { "-audio" } else { "" }
            )),
        })
    }

    pub(super) async fn resume(
        &self,
        context: &RunContext,
        view: &ViewData,
        page: &ViewPage,
        audio: bool,
    ) -> DownloadResult<Option<BilibiliDownloadResult>> {
        if !self
            .directory
            .try_exists()
            .map_err(|e| DownloadError::io("无法检查已有下载", e))?
        {
            return Ok(None);
        }
        if !self.directory.is_dir() {
            return Err(DownloadError::permanent(
                "下载位置已有同名文件，已保留原文件，请选择其他文件夹。",
            ));
        }
        let path = self.directory.join(MANIFEST_NAME);
        let metadata = tokio::fs::metadata(&path).await.map_err(|_| DownloadError::permanent("该分 P 文件夹不是完整下载结果，未覆盖任何文件。请选择其他下载目录，或移走该文件夹后重试。"))?;
        if metadata.len() > 64 * 1024 {
            return Err(DownloadError::permanent("已有下载清单大小异常。"));
        }
        let bytes = tokio::fs::read(path)
            .await
            .map_err(|e| DownloadError::io("无法读取下载清单", e))?;
        let receipt: PackageReceipt = serde_json::from_slice(&bytes)
            .map_err(|_| DownloadError::permanent("已有下载清单无效，未覆盖任何文件。"))?;
        validate_receipt(&receipt, view, page, audio)?;
        context.progress(
            "metadata",
            0,
            0,
            page.page,
            0.0,
            format!("正在校验 P{} 已完成文件", page.page),
        );
        verify_file(context, &self.directory, &receipt.xml, MAX_XML_BYTES).await?;
        let xml = tokio::fs::read_to_string(self.directory.join(&receipt.xml.name))
            .await
            .map_err(|e| DownloadError::io("无法读取已完成 XML", e))?;
        validate_xml(&xml, &receipt)?;
        if let Some(audio) = &receipt.audio {
            verify_file(context, &self.directory, audio, 8 * 1024 * 1024 * 1024).await?;
            let mut file = tokio::fs::File::open(self.directory.join(&audio.name))
                .await
                .map_err(|e| DownloadError::io("无法校验音轨", e))?;
            let mut prefix = [0; 64];
            let count = file
                .read(&mut prefix)
                .await
                .map_err(|e| DownloadError::io("无法读取音轨容器", e))?;
            api::validate_audio_bytes(&prefix[..count], audio.size, Some(audio.size))?;
        }
        Ok(Some(receipt.result(&self.directory)))
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) async fn publish(
        &self,
        context: &RunContext,
        client: &reqwest::Client,
        view: &ViewData,
        page: &ViewPage,
        probe: &PlayProbe,
        comments: &[DanmakuElem],
        audio: bool,
        current: usize,
        total: usize,
    ) -> DownloadResult<BilibiliDownloadResult> {
        let parent = self
            .directory
            .parent()
            .ok_or_else(|| DownloadError::permanent("下载目录无效。"))?;
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| DownloadError::io("无法创建视频下载目录", e))?;
        let staging = StagingDirectory::create(parent)?;
        let stem = format!("P{:03} - {}", page.page, sanitize_file_name(&page.part));
        let xml_name = format!("{stem}.xml");
        let audio_name = audio.then(|| format!("{stem}.m4a"));
        let xml = build_xml(view, page, probe, comments, audio_name.as_deref());
        if xml.len() as u64 > MAX_XML_BYTES {
            return Err(DownloadError::permanent(
                "生成的 XML 超过当前可导入大小，未保存半成品。",
            ));
        }
        let mut receipt = PackageReceipt {
            version: 1,
            bvid: view.bvid.clone(),
            aid: view.aid,
            cid: page.cid,
            page: page.page,
            page_count: view.pages.len(),
            part: page.part.clone(),
            duration_ms: probe.duration_ms,
            duration_source: probe.duration_source.clone(),
            exact_duration: probe.exact_duration,
            danmaku_count: comments.len(),
            xml: FileReceipt {
                name: xml_name.clone(),
                size: xml.len() as u64,
                sha256: digest(xml.as_bytes()),
            },
            audio: None,
        };
        // Validate before network/audio work, then persist exactly those bytes.
        validate_xml(&xml, &receipt)?;
        write_new_file(&staging.path.join(&xml_name), xml.as_bytes())?;
        if let Some(name) = audio_name {
            let audio = probe
                .audio
                .as_ref()
                .ok_or_else(|| DownloadError::permanent("该分 P 没有普通 DASH 音轨。"))?;
            let downloaded = api::download_audio(
                context,
                client,
                audio,
                &staging.path.join(&name),
                current,
                total,
                page.page,
            )
            .await?;
            receipt.audio = Some(FileReceipt {
                name,
                size: downloaded.size,
                sha256: downloaded.sha256,
            });
        }
        let manifest = serde_json::to_vec_pretty(&receipt)
            .map_err(|_| DownloadError::permanent("无法生成下载清单。"))?;
        write_new_file(&staging.path.join(MANIFEST_NAME), &manifest)?;
        context.cancellation.check()?;
        staging.publish(&self.directory)?;
        Ok(receipt.result(&self.directory))
    }
}

impl PackageReceipt {
    fn result(&self, directory: &Path) -> BilibiliDownloadResult {
        BilibiliDownloadResult {
            bvid: self.bvid.clone(),
            aid: self.aid,
            cid: self.cid,
            page: self.page,
            part: self.part.clone(),
            duration_ms: self.duration_ms,
            duration_source: self.duration_source.clone(),
            exact_duration: self.exact_duration,
            danmaku_count: self.danmaku_count,
            xml_path: directory
                .join(&self.xml.name)
                .to_string_lossy()
                .into_owned(),
            audio_path: self
                .audio
                .as_ref()
                .map(|audio| directory.join(&audio.name).to_string_lossy().into_owned()),
        }
    }
}

fn validate_receipt(
    receipt: &PackageReceipt,
    view: &ViewData,
    page: &ViewPage,
    audio: bool,
) -> DownloadResult<()> {
    if receipt.version != 1
        || receipt.bvid != view.bvid
        || receipt.aid != view.aid
        || receipt.cid != page.cid
        || receipt.page != page.page
        || receipt.duration_ms > MAX_SAFE_INTEGER
        || receipt.danmaku_count > MAX_DANMAKUS
        || receipt.page_count == 0
        || !matches!(
            receipt.duration_source.as_str(),
            "playurl.dash.duration" | "playurl.timelength" | "view.pages.duration"
        )
        || receipt.audio.is_some() != audio
        || !safe_name(&receipt.xml.name, "xml")
        || receipt
            .audio
            .as_ref()
            .is_some_and(|file| !safe_name(&file.name, "m4a"))
    {
        return Err(DownloadError::permanent(
            "已有下载清单与当前分 P 不一致，未覆盖原文件。",
        ));
    }
    Ok(())
}

fn safe_name(name: &str, extension: &str) -> bool {
    let path = Path::new(name);
    !name.is_empty()
        && !name.contains(['/', '\\', ':'])
        && path.components().count() == 1
        && matches!(path.components().next(), Some(Component::Normal(_)))
        && path.extension().and_then(|v| v.to_str()) == Some(extension)
}

async fn verify_file(
    context: &RunContext,
    directory: &Path,
    receipt: &FileReceipt,
    maximum: u64,
) -> DownloadResult<()> {
    if receipt.size == 0
        || receipt.size > maximum
        || receipt.sha256.len() != 64
        || !receipt.sha256.bytes().all(|c| c.is_ascii_hexdigit())
    {
        return Err(DownloadError::permanent("已有下载文件清单无效。"));
    }
    context
        .cancellation
        .run(async {
            let mut file = tokio::fs::File::open(directory.join(&receipt.name))
                .await
                .map_err(|e| DownloadError::io("下载文件缺失或不可读", e))?;
            let metadata = file
                .metadata()
                .await
                .map_err(|e| DownloadError::io("无法读取下载文件信息", e))?;
            if !metadata.is_file() || metadata.len() != receipt.size {
                return Err(DownloadError::permanent(
                    "已有下载文件不完整或已修改，未覆盖原文件。",
                ));
            }
            let mut hasher = Sha256::new();
            let mut buffer = vec![0; 256 * 1024];
            let mut size = 0u64;
            loop {
                let count = file
                    .read(&mut buffer)
                    .await
                    .map_err(|e| DownloadError::io("无法校验下载文件", e))?;
                if count == 0 {
                    break;
                }
                size += count as u64;
                if size > receipt.size {
                    return Err(DownloadError::permanent("校验时文件发生变化。"));
                }
                hasher.update(&buffer[..count]);
            }
            if size != receipt.size || format!("{:x}", hasher.finalize()) != receipt.sha256 {
                return Err(DownloadError::permanent(
                    "已有下载文件校验失败，未将其当作完成结果，请使用其他目录重新下载。",
                ));
            }
            Ok(())
        })
        .await
}

struct StagingDirectory {
    path: PathBuf,
}

impl StagingDirectory {
    fn create(parent: &Path) -> DownloadResult<Self> {
        let mut random = [0u8; 16];
        getrandom::fill(&mut random)
            .map_err(|_| DownloadError::permanent("无法创建安全的下载临时目录。"))?;
        let suffix: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let path = parent.join(format!(".dts-download-{suffix}.partial"));
        std::fs::create_dir(&path).map_err(|e| DownloadError::io("无法创建下载临时目录", e))?;
        Ok(Self { path })
    }

    fn publish(self, target: &Path) -> DownloadResult<()> {
        if target
            .try_exists()
            .map_err(|e| DownloadError::io("无法检查下载目标", e))?
        {
            return Err(DownloadError::permanent(
                "下载期间目标文件夹已出现，已停止发布以保护已有文件。",
            ));
        }
        // Windows MoveFileExW with no REPLACE_EXISTING flag rejects even a concurrent empty
        // destination directory. On other platforms rename rejects a populated destination.
        publish_directory(&self.path, target)
            .map_err(|e| DownloadError::io("无法发布完整分 P 文件夹", e))?;
        Ok(())
    }
}

impl Drop for StagingDirectory {
    fn drop(&mut self) {
        // This exact random directory was exclusively created by this object. A published
        // package has moved out of it, so cleanup can never remove an earlier user download.
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

#[cfg(windows)]
fn publish_directory(source: &Path, target: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::MoveFileExW;
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    if unsafe { MoveFileExW(source.as_ptr(), target.as_ptr(), 0) } == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn publish_directory(source: &Path, target: &Path) -> std::io::Result<()> {
    std::fs::rename(source, target)
}

fn write_new_file(path: &Path, content: &[u8]) -> DownloadResult<()> {
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|e| DownloadError::io("无法创建下载文件", e))?;
    file.write_all(content)
        .map_err(|e| DownloadError::io("无法写入下载文件", e))?;
    file.sync_all()
        .map_err(|e| DownloadError::io("无法保存下载文件", e))
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn attributes(
    element: &quick_xml::events::BytesStart<'_>,
    reader: &Reader<&[u8]>,
) -> DownloadResult<HashMap<String, String>> {
    element
        .attributes()
        .map(|attribute| {
            let attribute =
                attribute.map_err(|_| DownloadError::permanent("XML 包含无效或重复属性。"))?;
            let key = std::str::from_utf8(attribute.key.as_ref())
                .map_err(|_| DownloadError::permanent("XML 属性名无效。"))?
                .to_string();
            let value = attribute
                .decode_and_unescape_value(reader.decoder())
                .map_err(|_| DownloadError::permanent("XML 属性内容无效。"))?
                .into_owned();
            Ok((key, value))
        })
        .collect()
}

fn validate_xml(xml: &str, receipt: &PackageReceipt) -> DownloadResult<()> {
    if xml.chars().any(|ch| !matches!(ch, '\u{9}' | '\u{a}' | '\u{d}' | '\u{20}'..='\u{d7ff}' | '\u{e000}'..='\u{fffd}' | '\u{10000}'..='\u{10ffff}')) {
        return Err(DownloadError::permanent("弹幕含 XML 不支持的控制字符，未保存不完整文件。"));
    }
    let mut reader = Reader::from_str(xml);
    let mut depth = 0usize;
    let mut root_seen = false;
    let mut root_closed = false;
    let mut metadata_seen = false;
    let mut count = 0usize;
    loop {
        match reader
            .read_event()
            .map_err(|_| DownloadError::permanent("弹幕 XML 结构损坏或被截断。"))?
        {
            Event::Start(element) => {
                if depth == 0 {
                    if root_seen || element.name().as_ref() != b"i" {
                        return Err(DownloadError::permanent("弹幕 XML 根元素无效。"));
                    }
                    root_seen = true;
                }
                if element.name().as_ref() == b"dbx:meta" {
                    if depth != 1 || metadata_seen {
                        return Err(DownloadError::permanent("弹幕 XML 元数据结构无效。"));
                    }
                    let attrs = attributes(&element, &reader)?;
                    for (name, expected) in [
                        ("xmlns:dbx", XML_NAMESPACE.to_string()),
                        ("bvid", receipt.bvid.clone()),
                        ("aid", receipt.aid.to_string()),
                        ("cid", receipt.cid.to_string()),
                        ("page-index", receipt.page.to_string()),
                        ("page-count", receipt.page_count.to_string()),
                        ("duration-ms", receipt.duration_ms.to_string()),
                        ("duration-source", receipt.duration_source.clone()),
                        ("exact-duration", receipt.exact_duration.to_string()),
                    ] {
                        if attrs.get(name) != Some(&expected) {
                            return Err(DownloadError::permanent(
                                "弹幕 XML 与下载身份或时长清单不一致。",
                            ));
                        }
                    }
                    metadata_seen = true;
                }
                if element.name().as_ref() == b"d" {
                    if depth != 1 {
                        return Err(DownloadError::permanent("弹幕 XML 的条目位置无效。"));
                    }
                    let attrs = attributes(&element, &reader)?;
                    let fields: Vec<_> = attrs
                        .get("p")
                        .ok_or_else(|| DownloadError::permanent("弹幕 XML 缺少 p 字段。"))?
                        .split(',')
                        .collect();
                    if fields.len() < 8
                        || fields[0]
                            .parse::<f64>()
                            .ok()
                            .is_none_or(|v| !v.is_finite() || v < 0.0)
                    {
                        return Err(DownloadError::permanent("弹幕 XML 的时间或 p 字段无效。"));
                    }
                    count += 1;
                }
                depth += 1;
                if depth > 8 {
                    return Err(DownloadError::permanent("弹幕 XML 层级异常。"));
                }
            }
            Event::End(_) => {
                if depth == 0 {
                    return Err(DownloadError::permanent("弹幕 XML 闭合结构无效。"));
                }
                depth -= 1;
                if depth == 0 {
                    root_closed = true;
                }
            }
            Event::Empty(element) => {
                if depth == 0
                    || element.name().as_ref() == b"d"
                    || element.name().as_ref() == b"dbx:meta"
                {
                    return Err(DownloadError::permanent("弹幕 XML 包含不完整条目。"));
                }
                attributes(&element, &reader)?;
            }
            Event::Text(text) => {
                let text = text
                    .decode()
                    .map_err(|_| DownloadError::permanent("弹幕 XML 文本编码无效。"))?;
                if depth == 0 && !text.trim().is_empty() {
                    return Err(DownloadError::permanent("弹幕 XML 根元素外存在额外内容。"));
                }
            }
            Event::DocType(_) => {
                return Err(DownloadError::permanent("下载 XML 不允许外部文档声明。"))
            }
            Event::Eof => break,
            _ => {}
        }
    }
    if depth != 0 || !root_seen || !root_closed || !metadata_seen || count != receipt.danmaku_count
    {
        return Err(DownloadError::permanent(
            "弹幕 XML 未完整闭合或弹幕条数不一致。",
        ));
    }
    Ok(())
}

fn build_xml(
    view: &ViewData,
    page: &ViewPage,
    probe: &PlayProbe,
    comments: &[DanmakuElem],
    audio_name: Option<&str>,
) -> String {
    let mut xml = format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<i>\n  <chatserver>chat.bilibili.com</chatserver>\n  <chatid>{}</chatid>\n  <mission>0</mission>\n  <maxlimit>{}</maxlimit>\n  <state>0</state>\n  <real_name>0</real_name>\n  <source>k-v</source>\n", page.cid, comments.len());
    xml.push_str(&format!("  <dbx:meta xmlns:dbx=\"{XML_NAMESPACE}\" schema-version=\"1\" source=\"bilibili\" bvid=\"{}\" aid=\"{}\" cid=\"{}\" page-index=\"{}\" page-count=\"{}\" title=\"{}\" part=\"{}\" duration-ms=\"{}\" duration-source=\"{}\" duration-source-unit=\"{}\" exact-duration=\"{}\">\n",
        escape_xml(&view.bvid), view.aid, page.cid, page.page, view.pages.len(), escape_xml(&view.title), escape_xml(&page.part),
        probe.duration_ms, escape_xml(&probe.duration_source), if probe.duration_source == "playurl.timelength" { "millisecond" } else { "second" }, probe.exact_duration));
    if let (Some(name), Some(audio)) = (audio_name, probe.audio.as_ref()) {
        xml.push_str(&format!("    <dbx:audio included=\"true\" file=\"{}\" container=\"m4a\" codec=\"{}\" bandwidth=\"{}\" />\n", escape_xml(name), escape_xml(&audio.codecs), audio.bandwidth));
    } else {
        xml.push_str("    <dbx:audio included=\"false\" />\n");
    }
    xml.push_str("  </dbx:meta>\n");
    for item in comments {
        let row_id = if item.id_str.is_empty() {
            item.id.to_string()
        } else {
            item.id_str.clone()
        };
        xml.push_str(&format!(
            "  <d p=\"{},{},{},{},{},{},{},{}\">{}</d>\n",
            format_seconds(item.progress),
            item.mode,
            item.fontsize,
            item.color,
            item.ctime,
            item.pool,
            escape_xml(&item.mid_hash),
            escape_xml(&row_id),
            escape_xml(&item.content)
        ));
    }
    xml.push_str("</i>\n");
    xml
}

fn format_seconds(milliseconds: i32) -> String {
    let value = milliseconds.max(0);
    let fraction = value % 1_000;
    if fraction == 0 {
        (value / 1_000).to_string()
    } else {
        format!("{}.{fraction:03}", value / 1_000)
            .trim_end_matches('0')
            .to_string()
    }
}

fn escape_xml(value: &str) -> String {
    quick_xml::escape::escape(value).into_owned()
}

fn sanitize_file_name(value: &str) -> String {
    let value: String = value
        .chars()
        .map(|ch| {
            if ch.is_control() || matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
            {
                '-'
            } else {
                ch
            }
        })
        .take(70)
        .collect();
    let value = value.trim().trim_end_matches(['.', ' ']);
    if value.is_empty() {
        "弹幕来源".into()
    } else {
        value.into()
    }
}

#[cfg(test)]
mod tests;
