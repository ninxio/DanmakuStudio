use super::*;
use cookie::Cookie;
use reqwest::{header::SET_COOKIE, Url};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct StoredCookie {
    name: String,
    value: String,
    domain: String,
    path: String,
    expires_at: Option<i64>,
    secure: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Credential {
    cookies: Vec<StoredCookie>,
    pub refresh_token: String,
    pub account: Account,
    pub last_verified_at: u64,
    #[serde(default)]
    pub needs_login: bool,
    #[serde(default)]
    pub pending_confirm: Option<String>,
}

impl Credential {
    pub fn from_response(
        headers: &reqwest::header::HeaderMap,
        value: &Value,
    ) -> Result<Self, AuthError> {
        let mut cookies = std::collections::BTreeMap::new();
        for header in headers.get_all(SET_COOKIE) {
            let raw = header.to_str().map_err(|_| AuthError::invalid())?;
            let cookie = Cookie::parse(raw).map_err(|_| AuthError::invalid())?;
            let domain = cookie
                .domain()
                .unwrap_or("passport.bilibili.com")
                .trim_start_matches('.');
            if domain != "bilibili.com" && domain != "passport.bilibili.com" {
                continue;
            }
            if cookie.name().len() > 128 || cookie.value().len() > 8192 {
                return Err(AuthError::invalid());
            }
            cookies.insert(
                cookie.name().to_owned(),
                StoredCookie {
                    name: cookie.name().into(),
                    value: cookie.value().into(),
                    domain: domain.into(),
                    path: cookie.path().unwrap_or("/").into(),
                    secure: cookie.secure().unwrap_or(false),
                    expires_at: cookie.expires_datetime().map(|date| date.unix_timestamp()),
                },
            );
        }
        for required in ["SESSDATA", "bili_jct", "DedeUserID"] {
            if !cookies.get(required).is_some_and(|c| !c.value.is_empty()) {
                return Err(AuthError::invalid());
            }
        }
        let token = value["data"]["refresh_token"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 8192)
            .ok_or_else(AuthError::invalid)?;
        Ok(Self {
            cookies: cookies.into_values().collect(),
            refresh_token: token.into(),
            account: Account {
                mid: String::new(),
                username: String::new(),
            },
            last_verified_at: 0,
            needs_login: false,
            pending_confirm: None,
        })
    }

    pub fn header(&self, url: &str) -> Result<String, AuthError> {
        let url = Url::parse(url).map_err(|_| AuthError::invalid())?;
        let host = url.host_str().ok_or_else(AuthError::invalid)?;
        if url.scheme() != "https" || !(host == "bilibili.com" || host.ends_with(".bilibili.com")) {
            return Err(AuthError::invalid());
        }
        let now = (now_ms() / 1000) as i64;
        let pairs: Vec<_> = self
            .cookies
            .iter()
            .filter(|cookie| {
                (host == cookie.domain
                    || (cookie.domain == "bilibili.com" && host.ends_with(".bilibili.com")))
                    && url.path().starts_with(&cookie.path)
                    && cookie.expires_at.is_none_or(|expires| expires > now)
                    && (!cookie.secure || url.scheme() == "https")
            })
            .map(|c| format!("{}={}", c.name, c.value))
            .collect();
        Ok(pairs.join("; "))
    }

    pub fn csrf(&self) -> Result<&str, AuthError> {
        self.cookies
            .iter()
            .find(|c| c.name == "bili_jct")
            .map(|c| c.value.as_str())
            .ok_or_else(AuthError::invalid)
    }
}

pub(super) fn path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    app.path()
        .app_local_data_dir()
        .map(|root| root.join("bilibili/credential.dpapi"))
        .map_err(|_| "无法定位 B 站账号目录。".into())
}

pub(super) fn load(path: &Path) -> Result<Option<Credential>, String> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("无法读取 B 站账号，请检查本机数据目录。".into()),
    };
    if bytes.len() > 64 * 1024 {
        return Err("B 站登录文件大小异常，原文件保留。".into());
    }
    let clear = crate::credential_protection::protect(&bytes, true)?;
    serde_json::from_slice(&clear)
        .map(Some)
        .map_err(|_| "B 站登录文件无法解析，原文件保留。".into())
}

pub(super) fn save(path: &Path, credential: &Credential) -> Result<(), String> {
    let clear = serde_json::to_vec(credential).map_err(|_| "B 站登录信息编码失败。")?;
    if clear.len() > 48 * 1024 {
        return Err("B 站登录信息超过容量上限。".into());
    }
    let bytes = crate::credential_protection::protect(&clear, false)?;
    std::fs::create_dir_all(path.parent().ok_or("B 站账号目录无效。")?)
        .map_err(|_| "无法创建 B 站账号目录。")?;
    crate::project_files::atomic_write(path, &bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_separate_cookies_with_comma_expiry_and_preserves_encoding() {
        let mut headers = reqwest::header::HeaderMap::new();
        for text in ["SESSDATA=abc%2Cxyz; Domain=.bilibili.com; Path=/; Expires=Wed, 01 Jan 2031 00:00:00 GMT; Secure", "bili_jct=csrf; Domain=.bilibili.com; Path=/", "DedeUserID=123; Domain=.bilibili.com; Path=/"] {
            headers.append(SET_COOKIE, text.parse().unwrap());
        }
        let credential = Credential::from_response(
            &headers,
            &serde_json::json!({"data":{"refresh_token":"refresh-secret"}}),
        )
        .unwrap();
        let header = credential
            .header("https://api.bilibili.com/x/web-interface/nav")
            .unwrap();
        assert!(header.contains("SESSDATA=abc%2Cxyz"));
        assert!(!header.contains("Expires"));
        assert!(credential.header("https://cdn.example.com/audio").is_err());
        assert!(credential
            .header("https://api.bilibili.com.evil.example/x")
            .is_err());
        #[cfg(windows)]
        {
            let root = std::env::temp_dir().join(format!("studio-bili-vault-{}", now_ms()));
            let path = root.join("credential.dpapi");
            save(&path, &credential).unwrap();
            let encrypted = std::fs::read(&path).unwrap();
            assert!(!encrypted.windows(14).any(|v| v == b"refresh-secret"));
            let loaded = load(&path).unwrap().unwrap();
            assert_eq!(
                loaded
                    .header("https://api.bilibili.com/x/web-interface/nav")
                    .unwrap(),
                header
            );
            std::fs::remove_file(path).unwrap();
            std::fs::remove_dir(root).unwrap();
        }
    }
}
