//! Descriptive metadata is not a projection proof. Only this inert vocabulary may
//! accompany independently reconstructed and verified comment bytes.
use quick_xml::{events::Event, Reader};

pub(super) fn validate(fragment: &str) -> Result<(), String> {
    if fragment.len() > 1024 * 1024 {
        return Err("XML 媒体元数据超限。".into());
    }
    let mut reader = Reader::from_str(fragment);
    reader.config_mut().enable_all_checks(true);
    let mut stack: Vec<String> = Vec::new();
    let mut root_seen = false;
    let mut source_count = 0;
    loop {
        match reader
            .read_event()
            .map_err(|e| format!("XML 媒体元数据无效：{e}"))?
        {
            Event::Start(ref start) | Event::Empty(ref start) => {
                let name = String::from_utf8_lossy(start.name().as_ref()).into_owned();
                let allowed = match (stack.last().map(String::as_str), name.as_str()) {
                    (None, "dts:metadata") if !root_seen => {
                        root_seen = true;
                        true
                    }
                    (Some("dts:metadata"), "dbx:meta") => {
                        source_count += 1;
                        source_count <= 1024
                    }
                    (Some("dbx:meta"), "dbx:audio") => true,
                    _ => false,
                };
                if !allowed {
                    return Err("XML 媒体元数据包含不允许的元素。".into());
                }
                let mut attrs = std::collections::HashMap::new();
                for attribute in start.attributes() {
                    let a = attribute.map_err(|e| e.to_string())?;
                    let key = String::from_utf8_lossy(a.key.as_ref()).into_owned();
                    let value = a
                        .decode_and_unescape_value(reader.decoder())
                        .map_err(|e| e.to_string())?
                        .into_owned();
                    if value.len() > 16384
                        || value
                            .chars()
                            .any(|c| c < ' ' && !matches!(c, '\t' | '\r' | '\n'))
                    {
                        return Err("XML 媒体元数据属性无效。".into());
                    }
                    attrs.insert(key, value);
                }
                let keys: &[&str] = match name.as_str() {
                    "dts:metadata" => &["xmlns:dts", "schema-version", "duration-ms"],
                    "dbx:meta" => &[
                        "xmlns:dbx",
                        "schema-version",
                        "source",
                        "bvid",
                        "aid",
                        "cid",
                        "page-index",
                        "page-count",
                        "title",
                        "part",
                        "duration-ms",
                        "duration-source",
                        "duration-source-unit",
                        "exact-duration",
                    ],
                    _ => &["included", "file", "container", "codec", "bandwidth"],
                };
                if attrs.keys().any(|k| !keys.contains(&k.as_str())) {
                    return Err("XML 媒体元数据包含未知属性。".into());
                }
                let get = |key: &str| attrs.get(key).map(String::as_str);
                if (name == "dts:metadata"
                    && (get("xmlns:dts") != Some("urn:danmaku-studio:xml:metadata:1")
                        || get("schema-version") != Some("1")))
                    || (name == "dbx:meta"
                        && (get("xmlns:dbx") != Some("urn:danmakubox:xml:metadata:1")
                            || get("schema-version") != Some("1")
                            || get("source") != Some("bilibili")))
                {
                    return Err("XML 媒体元数据命名空间或版本无效。".into());
                }
                for key in [
                    "duration-ms",
                    "aid",
                    "cid",
                    "page-index",
                    "page-count",
                    "bandwidth",
                ] {
                    if let Some(value) = get(key) {
                        if value.is_empty()
                            || !value.bytes().all(|c| c.is_ascii_digit())
                            || value
                                .parse::<u64>()
                                .map_or(true, |n| n > 9_007_199_254_740_991)
                        {
                            return Err("XML 媒体元数据数值无效。".into());
                        }
                    }
                }
                // read_event is borrowed above; an empty tag ends at '/>'.
                let end = reader.buffer_position() as usize;
                if !fragment[..end].ends_with("/>") {
                    stack.push(name);
                }
            }
            Event::End(_) => {
                stack.pop().ok_or("XML 媒体元数据未匹配结束标签。")?;
            }
            Event::Text(text) if text.iter().all(u8::is_ascii_whitespace) => {}
            Event::Eof if root_seen && stack.is_empty() => return Ok(()),
            _ => return Err("XML 媒体元数据只允许描述性属性，不允许弹幕或其他内容。".into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn inert_metadata_only() {
        let good = "  <dts:metadata xmlns:dts=\"urn:danmaku-studio:xml:metadata:1\" schema-version=\"1\" duration-ms=\"1000\">\n  </dts:metadata>";
        assert!(validate(good).is_ok());
        let with_source = good.replace("  </dts:metadata>", r#"    <dbx:meta xmlns:dbx="urn:danmakubox:xml:metadata:1" schema-version="1" source="bilibili" bvid="BV1xx411c7mD" duration-ms="280123" title="示例 &amp; 剧集"><dbx:audio included="true" file="reference.m4a" /></dbx:meta>
  </dts:metadata>"#);
        assert!(validate(&with_source).is_ok());

        for bad in [
            good.replace("</dts:metadata>", "<d p=\"1\">injected</d></dts:metadata>"),
            format!("<!DOCTYPE x>{good}"),
            format!("{good}{good}"),
            good.replace("duration-ms=\"1000\"", "duration-ms=\"9007199254740992\""),
            good.replace("urn:danmaku-studio:xml:metadata:1", "urn:fake"),
        ] {
            assert!(validate(&bad).is_err());
        }
    }
}
