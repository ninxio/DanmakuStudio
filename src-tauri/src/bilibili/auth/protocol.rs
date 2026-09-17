//! Web passport protocol; primary references are recorded in docs/BILIBILI_ACCOUNT.md.
use super::*;
use reqwest::{Client, Response};
use rsa::{pkcs8::DecodePublicKey, rand_core::OsRng, Oaep, RsaPublicKey};
use sha2::Sha256;

pub(super) const NAV: &str = "https://api.bilibili.com/x/web-interface/nav";
const PASSPORT: &str = "https://passport.bilibili.com/x/passport-login/web";

pub(super) fn client(
    credential: Option<&credential::Credential>,
    url: &str,
) -> Result<Client, AuthError> {
    let cookie = credential.map(|c| c.header(url)).transpose()?;
    super::super::api::build_client(cookie.as_deref(), false)
        .map_err(|_| AuthError::other("无法建立 B 站登录连接。"))
}

pub(super) async fn response(request: reqwest::RequestBuilder) -> Result<Response, AuthError> {
    let result = request
        .send()
        .await
        .map_err(|_| AuthError::other("B 站连接失败或超时，已保留本机登录。"))?;
    if !result.status().is_success() {
        return Err(AuthError::other(&format!(
            "B 站返回 HTTP {}，请稍后重试。",
            result.status().as_u16()
        )));
    }
    Ok(result)
}

async fn bytes(mut response: Response) -> Result<Vec<u8>, AuthError> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| AuthError::invalid())? {
        if bytes.len() + chunk.len() > 1024 * 1024 {
            return Err(AuthError::invalid());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

pub(super) async fn json(response: Response) -> Result<Value, AuthError> {
    let value: Value =
        serde_json::from_slice(&bytes(response).await?).map_err(|_| AuthError::invalid())?;
    match value["code"].as_i64() {
        Some(0) => Ok(value),
        Some(-101) => Err(AuthError {
            needs_login: true,
            message: "B 站登录已失效，请重新扫码。".into(),
        }),
        Some(code) => Err(AuthError::other(&format!(
            "B 站未完成请求（代码 {code}），请稍后重试。"
        ))),
        None => Err(AuthError::invalid()),
    }
}

pub(super) async fn generate() -> Result<(String, String), AuthError> {
    let url = format!("{PASSPORT}/qrcode/generate");
    let value = json(response(client(None, &url)?.get(&url)).await?).await?;
    let qr = value["data"]["url"]
        .as_str()
        .filter(|s| s.len() <= 4096)
        .ok_or_else(AuthError::invalid)?;
    let parsed = reqwest::Url::parse(qr).map_err(|_| AuthError::invalid())?;
    if parsed.scheme() != "https"
        || !matches!(parsed.host_str(), Some("passport.bilibili.com" | "account.bilibili.com"))
        || !parsed.username().is_empty() || parsed.password().is_some()
        || parsed.port_or_known_default() != Some(443) {
        return Err(AuthError::invalid());
    }
    let key = value["data"]["qrcode_key"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() < 512)
        .ok_or_else(AuthError::invalid)?;
    Ok((qr.into(), key.into()))
}

pub(super) async fn poll(key: &str) -> Result<(Value, reqwest::header::HeaderMap), AuthError> {
    let url = format!("{PASSPORT}/qrcode/poll");
    let response = response(client(None, &url)?.get(&url).query(&[("qrcode_key", key)])).await?;
    let headers = response.headers().clone();
    Ok((json(response).await?, headers))
}

pub(super) async fn verify(credential: &mut credential::Credential) -> Result<(), AuthError> {
    let value = json(response(client(Some(credential), NAV)?.get(NAV)).await?).await?;
    if value["data"]["isLogin"] != true {
        return Err(AuthError {
            needs_login: true,
            message: "B 站登录已失效，请重新扫码。".into(),
        });
    }
    let mid = value["data"]["mid"]
        .as_u64()
        .filter(|id| *id > 0)
        .ok_or_else(AuthError::invalid)?;
    let username = value["data"]["uname"]
        .as_str()
        .filter(|s| s.len() < 512)
        .ok_or_else(AuthError::invalid)?;
    credential.account = Account {
        mid: mid.to_string(),
        username: username.into(),
    };
    credential.last_verified_at = now_ms();
    credential.needs_login = false;
    Ok(())
}

fn correspond_path() -> Result<String, AuthError> {
    // Protocol public key, not a credential. RSA-OAEP encryption uses the standard RustCrypto library.
    let public_key = RsaPublicKey::from_public_key_pem("-----BEGIN PUBLIC KEY-----\nMIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDLgd2OAkcGVtoE3ThUREbio0Eg\nUc/prcajMKXvkCKFCWhJYJcLkcM2DKKcSeFpD/j6Boy538YXnR6VhcuUJOhH2x71\nnzPjfdTcqMz7djHum0qSZA0AyCBDABUqCrfNgCiJ00Ra7GmRj+YCK1NJEuewlb40\nJNrRuoEUXpabUzGB8QIDAQAB\n-----END PUBLIC KEY-----").map_err(|_| AuthError::invalid())?;
    let encrypted = public_key
        .encrypt(
            &mut OsRng,
            Oaep::new::<Sha256>(),
            format!("refresh_{}", now_ms().saturating_sub(20_000)).as_bytes(),
        )
        .map_err(|_| AuthError::invalid())?;
    Ok(encrypted.iter().map(|byte| format!("{byte:02x}")).collect())
}

pub(super) async fn maintained(
    mut credential: credential::Credential,
) -> Result<credential::Credential, AuthError> {
    verify(&mut credential).await?;
    if credential.pending_confirm.is_some() {
        return Ok(credential);
    }
    let url = format!("{PASSPORT}/cookie/info");
    let info = json(response(client(Some(&credential), &url)?.get(&url)).await?).await?;
    if info["data"]["refresh"] == false {
        return Ok(credential);
    }
    if info["data"]["refresh"] != true {
        return Err(AuthError::invalid());
    }
    let url = format!(
        "https://www.bilibili.com/correspond/1/{}",
        correspond_path()?
    );
    let html = String::from_utf8(
        bytes(response(client(Some(&credential), &url)?.get(&url)).await?).await?,
    )
    .map_err(|_| AuthError::invalid())?;
    let csrf = refresh_csrf(&html)?;
    let url = format!("{PASSPORT}/cookie/refresh");
    let response = response(client(Some(&credential), &url)?.post(&url).form(&[
        ("csrf", credential.csrf()?),
        ("refresh_csrf", csrf.as_str()),
        ("refresh_token", credential.refresh_token.as_str()),
        ("source", "main_web"),
    ]))
    .await?;
    let headers = response.headers().clone();
    let value = json(response).await?;
    let mut next = credential::Credential::from_response(&headers, &value)?;
    verify(&mut next).await?;
    next.pending_confirm = Some(credential.refresh_token);
    Ok(next)
}

fn refresh_csrf(html: &str) -> Result<String, AuthError> {
    // This protocol returns a fixed minimal element, not arbitrary rendered markup.
    let value = html
        .split_once("<div id=\"1-name\">")
        .and_then(|(_, tail)| tail.split_once("</div>"))
        .map(|(value, _)| value.trim())
        .filter(|s| !s.is_empty() && s.len() < 1024 && !s.contains(['<', '>', '\r', '\n']))
        .ok_or_else(AuthError::invalid)?;
    Ok(value.into())
}

pub(super) async fn confirm(credential: &credential::Credential) -> Result<(), AuthError> {
    let Some(previous) = &credential.pending_confirm else {
        return Ok(());
    };
    let url = format!("{PASSPORT}/confirm/refresh");
    json(
        response(client(Some(credential), &url)?.post(&url).form(&[
            ("csrf", credential.csrf()?),
            ("refresh_token", previous.as_str()),
        ]))
        .await?,
    )
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn csrf_and_correspond_use_bounded_protocol_values() {
        assert_eq!(
            refresh_csrf("<html><div id=\"1-name\">abcdef</div></html>").unwrap(),
            "abcdef"
        );
        assert!(refresh_csrf("verification needed").is_err());
        assert_eq!(correspond_path().unwrap().len(), 256);
    }
    #[tokio::test]
    #[ignore = "live QR generation and waiting state, does not log in"]
    async fn live_generate_and_poll() {
        let (_, key) = generate().await.unwrap();
        let (value, _) = poll(&key).await.unwrap();
        assert_eq!(value["data"]["code"], 86101);
    }
}
