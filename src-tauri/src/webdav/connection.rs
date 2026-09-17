//! The vault is local to the Windows account. Public summaries never contain credentials.
use super::*;
use reqwest::Url;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Connection {
    pub id: String,
    pub name: String,
    pub root: String,
    pub username: String,
    pub password: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionSummary {
    pub id: String,
    pub name: String,
    pub root: String,
}
impl Connection {
    pub fn summary(&self) -> ConnectionSummary {
        ConnectionSummary {
            id: self.id.clone(),
            name: self.name.clone(),
            root: self.root.clone(),
        }
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInput {
    pub name: String,
    pub root: String,
    pub username: String,
    pub password: String,
}

pub(super) fn load(path: &Path) -> Result<Vec<Connection>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let bytes = read_bounded(path, 128 * 1024)?;
    let plain = crate::credential_protection::protect(&bytes, true)
        .map_err(|_| "无法解密 WebDAV 连接。原文件已保留，请使用原 Windows 账户。")?;
    serde_json::from_slice(&plain).map_err(|_| "WebDAV 连接记录损坏，原文件已保留。".into())
}
pub(super) fn save(path: &Path, connections: &[Connection]) -> Result<(), String> {
    let plain = serde_json::to_vec(connections).map_err(|_| "无法编码连接。")?;
    if plain.len() > 96 * 1024 {
        return Err("连接记录超过上限。".into());
    }
    let bytes = crate::credential_protection::protect(&plain, false)
        .map_err(|_| "WebDAV 连接加密失败，未保存。")?;
    crate::project_files::atomic_write(path, &bytes)
        .map_err(|_| "WebDAV 连接写盘失败，未保存。".into())
}

pub(super) fn url(raw: &str) -> Result<Url, String> {
    if raw.len() > 8192 || raw.chars().any(|c| c.is_control() || c == '\\') {
        return Err("WebDAV 地址不合法。".into());
    }
    // Reject ambiguous path encodings before URL parsing normalizes dot segments.
    let raw_path = raw.split(['?', '#']).next().unwrap_or(raw);
    let lower = raw_path.to_ascii_lowercase();
    if ["%2f", "%5c", "%2e", "%25"]
        .iter()
        .any(|v| lower.contains(v))
        || raw_path.split('/').any(|p| p == "." || p == "..")
    {
        return Err("WebDAV 路径含不安全编码或父目录跳转。".into());
    }
    let u = Url::parse(raw).map_err(|_| "WebDAV 地址不合法。")?;
    if !matches!(u.scheme(), "http" | "https")
        || u.host_str().is_none()
        || !u.username().is_empty()
        || u.password().is_some()
        || u.fragment().is_some()
    {
        return Err("只接受不含账户或片段的 HTTP(S) 地址。".into());
    }
    Ok(u)
}
pub(super) fn root(raw: &str) -> Result<Url, String> {
    let mut u = url(raw.trim())?;
    if u.query().is_some() {
        return Err("WebDAV 根目录不能含查询参数。".into());
    }
    if !u.path().ends_with('/') {
        u.set_path(&format!("{}/", u.path()));
    }
    Ok(u)
}
pub(super) fn display_name(url: &Url) -> String {
    let raw = url
        .path_segments()
        .and_then(|mut s| s.next_back())
        .unwrap_or("WebDAV media");
    percent_encoding::percent_decode_str(raw)
        .decode_utf8_lossy()
        .chars()
        .filter(|c| !c.is_control())
        .take(240)
        .collect()
}
pub(super) fn inside(root: &Url, candidate: &Url) -> bool {
    root.origin() == candidate.origin()
        && candidate.query().is_none()
        && (candidate.path() == root.path().trim_end_matches('/')
            || candidate.path().starts_with(root.path()))
}
pub(super) fn href(root: &Url, base: &Url, raw: &str) -> Result<Url, String> {
    // Validate the unnormalized reference too; Url::join otherwise hides ../.
    let lower = raw.to_ascii_lowercase();
    if raw.len() > 8192
        || raw.contains('\\')
        || raw.chars().any(char::is_control)
        || raw.split('/').any(|s| s == "." || s == "..")
        || ["%2e", "%2f", "%5c", "%25"]
            .iter()
            .any(|v| lower.contains(v))
    {
        return Err("服务器返回了不安全路径。".into());
    }
    let u = base.join(raw).map_err(|_| "服务器路径无法解析。")?;
    let u = url(u.as_str())?;
    if !inside(root, &u) {
        return Err("服务器路径超出所选 WebDAV 根目录。".into());
    }
    Ok(u)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn boundaries() {
        let r = root("https://example.com/dav").unwrap();
        for bad in [
            "/dav2/a",
            "../a",
            "/dav/%2e%2e/a",
            "/dav/%252e/a",
            "https://u:p@example.com/dav/a",
            "https://other/dav/a",
            "/dav/a#x",
            "/dav/a?q=secret",
        ] {
            assert!(href(&r, &r, bad).is_err(), "{bad}");
        }
        assert!(href(&r, &r, "/dav/film%20name.mkv").is_ok());
    }
    #[cfg(windows)]
    #[test]
    fn dpapi_round_trip_and_corruption_preserves_file() {
        let dir = std::env::temp_dir().join(format!("studio-dav-vault-{}", random_id().unwrap()));
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("vault.dpapi");
        let c = Connection {
            id: "id".into(),
            name: "name".into(),
            root: "https://example.com/dav/".into(),
            username: "user".into(),
            password: "fixture-secret-only".into(),
        };
        save(&path, &[c]).unwrap();
        let cipher = std::fs::read(&path).unwrap();
        assert!(!String::from_utf8_lossy(&cipher).contains("fixture-secret-only"));
        assert_eq!(load(&path).unwrap()[0].password, "fixture-secret-only");
        std::fs::write(&path, b"broken").unwrap();
        assert!(load(&path).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"broken");
        std::fs::remove_file(path).unwrap();
        std::fs::remove_dir(dir).unwrap();
    }
}
