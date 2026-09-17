use super::{connection, transport, *};
use quick_xml::{events::Event, name::ResolveResult, reader::NsReader};
use reqwest::{Method, Url};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub href: String,
    pub name: String,
    pub directory: bool,
    pub size: Option<u64>,
}
#[derive(Default)]
struct Props {
    name: String,
    directory: bool,
    size: Option<u64>,
    size_text: String,
    status: String,
}
fn append(stack: &[String], href: &mut String, props: &mut Props, value: &str) {
    match stack.last().map(String::as_str) {
        Some("href") => href.push_str(value),
        Some("displayname") => props.name.push_str(value),
        Some("status") => props.status.push_str(value),
        Some("getcontentlength") => props.size_text.push_str(value),
        _ => {}
    }
}

pub(super) async fn list(
    c: &connection::Connection,
    directory: &str,
) -> Result<Vec<Entry>, String> {
    let root = connection::root(&c.root)?;
    let target = connection::href(&root, &root, directory)?;
    if !target.path().ends_with('/') {
        return Err("请选择目录。".into());
    }
    let client = transport::client()?;
    let response=client.request(Method::from_bytes(b"PROPFIND").unwrap(),target.clone())
        .basic_auth(&c.username,Some(&c.password)).header("Depth","1")
        .header("Content-Type","application/xml; charset=utf-8")
        .body(r#"<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:resourcetype/><d:getcontentlength/></d:prop></d:propfind>"#)
        .send().await.map_err(|_|"WebDAV 目录请求失败或超时。")?;
    if response.status().as_u16() != 207 {
        return Err(transport::status_error(response.status()));
    }
    let body = transport::bounded_body(response, 2 * 1024 * 1024).await?;
    parse(&root, &target, &body)
}

fn parse(root: &Url, base: &Url, body: &[u8]) -> Result<Vec<Entry>, String> {
    let mut reader = NsReader::from_reader(body);
    reader.config_mut().trim_text(false);
    reader.config_mut().expand_empty_elements = true;
    let mut stack: Vec<String> = Vec::new();
    let mut raw_href = String::new();
    let mut props = Props::default();
    let mut accepted = Props::default();
    let mut entries = Vec::new();
    let mut seen = std::collections::HashSet::new();
    loop {
        let (ns, event) = reader
            .read_resolved_event()
            .map_err(|_| "WebDAV XML 格式错误。")?;
        let dav = matches!(ns,ResolveResult::Bound(n) if n.as_ref()==b"DAV:");
        match event {
            Event::Start(e) => {
                let name = if dav {
                    String::from_utf8_lossy(e.local_name().as_ref()).into_owned()
                } else {
                    String::new()
                };
                if name == "response" {
                    raw_href.clear();
                    accepted = Props::default();
                }
                if name == "propstat" {
                    props = Props::default();
                }
                if name == "collection" && stack.iter().any(|s| s == "resourcetype") {
                    props.directory = true;
                }
                stack.push(name);
                if stack.len() > 16 {
                    return Err("WebDAV XML 嵌套过深。".into());
                }
            }
            Event::Text(t) => {
                let text = t.decode().map_err(|_| "WebDAV 文本编码错误。")?;
                append(&stack, &mut raw_href, &mut props, &text);
            }
            Event::CData(t) => {
                let text = t.decode().map_err(|_| "WebDAV CDATA 编码错误。")?;
                append(&stack, &mut raw_href, &mut props, &text);
            }
            Event::GeneralRef(r) => {
                let value = if let Some(c) = r
                    .resolve_char_ref()
                    .map_err(|_| "WebDAV 数字实体不合法。")?
                {
                    c.to_string()
                } else {
                    match r.decode().map_err(|_| "WebDAV 实体编码错误。")?.as_ref() {
                        "amp" => "&",
                        "lt" => "<",
                        "gt" => ">",
                        "apos" => "'",
                        "quot" => "\"",
                        _ => return Err("WebDAV XML 包含未知实体。".into()),
                    }
                    .into()
                };
                append(&stack, &mut raw_href, &mut props, &value);
            }
            Event::End(_) => match stack.pop().as_deref() {
                Some("propstat") if props.status.split_whitespace().nth(1) == Some("200") => {
                    props.size = props.size_text.trim().parse().ok();
                    if !props.name.is_empty() {
                        accepted.name = props.name.clone();
                    }
                    accepted.directory |= props.directory;
                    accepted.size = accepted.size.or(props.size);
                    accepted.status = "200".into();
                }
                Some("response") if accepted.status == "200" => {
                    let u = connection::href(root, base, raw_href.trim())?;
                    let Some(relative) = u.path().strip_prefix(base.path()) else {
                        return Err("目录结果不在当前目录。".into());
                    };
                    if relative.is_empty() {
                        continue;
                    }
                    if relative.trim_end_matches('/').contains('/') {
                        return Err("服务器未遵守 Depth:1。".into());
                    }
                    if accepted.directory && !u.path().ends_with('/') {
                        return Err("目录路径缺少结尾斜杠。".into());
                    }
                    if seen.insert(u.path().to_string()) {
                        entries.push(Entry {
                            href: u.path().to_string(),
                            name: if accepted.name.is_empty() {
                                relative.trim_end_matches('/').into()
                            } else {
                                accepted.name.clone()
                            },
                            directory: accepted.directory,
                            size: accepted.size,
                        });
                    }
                    if entries.len() > 2000 {
                        return Err("当前目录超过 2000 项，请使用更小的根目录。".into());
                    }
                }
                _ => {}
            },
            Event::DocType(_) => return Err("WebDAV XML 不允许文档类型声明。".into()),
            Event::Eof => break,
            _ => {}
        }
    }
    if !stack.is_empty() {
        return Err("WebDAV XML 未闭合。".into());
    }
    entries.sort_by(|a, b| b.directory.cmp(&a.directory).then(a.name.cmp(&b.name)));
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dav_namespace_and_propstat() {
        let root = connection::root("http://localhost/dav/").unwrap();
        let body=br#"<D:multistatus xmlns:D="DAV:"><D:response><D:href>/dav/a.mkv</D:href><D:propstat><D:prop><D:displayname>A</D:displayname><D:getcontentlength>12</D:getcontentlength><D:resourcetype/></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>"#;
        let e = parse(&root, &root, body).unwrap();
        assert_eq!(e.len(), 1);
        assert_eq!(e[0].size, Some(12));
        assert!(!e[0].directory);
        let bad = String::from_utf8_lossy(body).replace("/dav/a.mkv", "/dav2/a.mkv");
        assert!(parse(&root, &root, bad.as_bytes()).is_err());
    }
    #[test]
    fn entities_and_cdata_are_decoded_once() {
        let root = connection::root("http://localhost/dav/").unwrap();
        for (href, name) in [
            ("Tom%20&amp;%20Jerry.mkv", "Tom &amp; Jerry"),
            ("Tom%20&#38;%20Jerry.mkv", "Tom &#x26; Jerry"),
            ("Tom%20&amp;%20Jerry.mkv", "<![CDATA[Tom & Jerry]]>"),
        ] {
            let xml=format!("<multistatus xmlns='DAV:'><response><href>/dav/{href}</href><propstat><prop><displayname>{name}</displayname></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>");
            let entries = parse(&root, &root, xml.as_bytes()).unwrap();
            assert_eq!(entries[0].href, "/dav/Tom%20&%20Jerry.mkv");
            assert_eq!(entries[0].name, "Tom & Jerry");
            assert!(parse(
                &root,
                &root,
                xml.replace("&amp;", "&unknown;")
                    .replace("&#38;", "&unknown;")
                    .as_bytes()
            )
            .is_err());
        }
    }
}
