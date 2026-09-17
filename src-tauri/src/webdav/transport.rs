//! A capability URL exposes one pinned file to FFmpeg, never an arbitrary URL or credentials.
use super::{connection, *};
use axum::{
    body::Body,
    extract::State,
    http::{Request, StatusCode},
    response::Response,
    routing::any,
    Router,
};
use futures_util::{stream, StreamExt};
use reqwest::{
    header::{HeaderMap, HeaderValue},
    Client, Method, Url,
};
use std::sync::atomic::AtomicU64;
use tokio::sync::{oneshot, Semaphore};

const MAX_BYTES: u64 = 100 * 1024 * 1024 * 1024;
pub(super) fn client() -> Result<Client, String> {
    client_builder()
        .build()
        .map_err(|_| "无法初始化 WebDAV 网络客户端。".into())
}
fn client_builder() -> reqwest::ClientBuilder {
    Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_gzip()
        .no_brotli()
        .no_deflate()
        .no_zstd()
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(30))
}
fn authenticated_request(
    client: &Client,
    c: &connection::Connection,
    url: Url,
    method: Method,
) -> Result<reqwest::RequestBuilder, String> {
    let same_origin = url.origin() == connection::root(&c.root)?.origin();
    let request = client
        .request(method, url)
        .header("Accept-Encoding", "identity");
    Ok(if same_origin {
        request.basic_auth(&c.username, Some(&c.password))
    } else {
        request
    })
}
pub(super) fn status_error(s: StatusCode) -> String {
    match s.as_u16() {
        401 | 403 => "WebDAV 认证失败或没有访问权限。".into(),
        301 | 302 | 307 | 308 => "WebDAV 目录发生跳转，请将连接根目录设为最终地址。".into(),
        404 => "远端文件或目录已不存在。".into(),
        412 => "远端文件已改变，请重新探测。".into(),
        n => format!("WebDAV 请求未成功（HTTP {n}）。"),
    }
}
pub(super) async fn bounded_body(
    mut response: reqwest::Response,
    cap: usize,
) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "读取 WebDAV 响应失败。")?
    {
        if out.len() + chunk.len() > cap {
            return Err("WebDAV 响应超过大小限制。".into());
        }
        out.extend_from_slice(&chunk);
    }
    Ok(out)
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) struct Validator {
    pub size: u64,
    pub etag: Option<String>,
    pub modified: Option<String>,
}
impl Validator {
    fn from_headers(h: &HeaderMap, size: u64) -> Result<Self, String> {
        let etag = h
            .get("etag")
            .and_then(|v| v.to_str().ok())
            .filter(|s| s.starts_with('"') && s.ends_with('"') && s.len() < 512)
            .map(str::to_owned);
        let modified = h
            .get("last-modified")
            .and_then(|v| v.to_str().ok())
            .filter(|s| s.len() < 128)
            .map(str::to_owned);
        if etag.is_none() {
            return Err("服务器缺少强 ETag。请使用一次下载临时原片，再从本地选择音轨。".into());
        }
        if size == 0 || size > MAX_BYTES {
            return Err("源文件大小不受支持（上限 100 GiB）。".into());
        }
        Ok(Self {
            size,
            etag,
            modified,
        })
    }
    fn matches(&self, h: &HeaderMap, size: u64) -> bool {
        if self.size != size {
            return false;
        }
        if let Some(etag) = &self.etag {
            h.get("etag").and_then(|v| v.to_str().ok()) == Some(etag.as_str())
        } else {
            self.modified.as_deref() == h.get("last-modified").and_then(|v| v.to_str().ok())
        }
    }
}

// Redirects may reach a CDN, but each hop gets freshly built headers. Basic only goes to the
// configured origin. No cookie jar, Referer, URL userinfo or HTTPS downgrade is allowed.
pub(super) async fn request(
    c: &connection::Connection,
    target: &Url,
    method: Method,
    range: Option<&str>,
    validator: Option<&Validator>,
) -> Result<reqwest::Response, String> {
    let origin = connection::root(&c.root)?.origin();
    let mut url = target.clone();
    for _ in 0..6 {
        let client = if url.origin() != origin {
            let host = url.host_str().ok_or("跳转地址缺少主机。")?;
            let addresses = tokio::time::timeout(
                Duration::from_secs(10),
                tokio::net::lookup_host((host, url.port_or_known_default().unwrap_or(443))),
            )
            .await
            .map_err(|_| "CDN 地址解析超时。")?
            .map_err(|_| "CDN 地址无法解析。")?
            .collect::<Vec<_>>();
            if addresses.is_empty() || addresses.iter().any(|a| !public_ip(a.ip())) {
                return Err("拒绝媒体跨域跳转到本机或私有网络。".into());
            }
            client_builder()
                .no_proxy()
                .resolve_to_addrs(host, &addresses)
                .build()
                .map_err(|_| "CDN 连接初始化失败。")?
        } else {
            client()?
        };
        let mut req = authenticated_request(&client, c, url.clone(), method.clone())?;
        if let Some(r) = range {
            req = req.header("Range", r);
        }
        if let Some(v) = validator {
            if let Some(etag) = &v.etag {
                req = req.header("If-Match", etag);
            } else if let Some(m) = &v.modified {
                req = req.header("If-Unmodified-Since", m);
            }
        }
        let response = req
            .send()
            .await
            .map_err(|_| "WebDAV 媒体请求失败或读取超时。")?;
        if !response.status().is_redirection() {
            return Ok(response);
        }
        if !matches!(response.status().as_u16(), 301 | 302 | 303 | 307 | 308) {
            return Err("不支持此媒体跳转。".into());
        }
        let location = response
            .headers()
            .get("location")
            .and_then(|h| h.to_str().ok())
            .ok_or("媒体跳转缺少地址。")?;
        let next = url.join(location).map_err(|_| "媒体跳转地址不合法。")?;
        let next = connection::url(next.as_str())?;
        if url.scheme() == "https" && next.scheme() != "https" {
            return Err("拒绝 HTTPS 媒体降级跳转。".into());
        }
        url = next;
    }
    Err("媒体跳转次数超过限制。".into())
}
fn public_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v) => {
            !v.is_private()
                && !v.is_loopback()
                && !v.is_link_local()
                && !v.is_unspecified()
                && !v.is_broadcast()
                && !v.is_multicast()
                && v.octets()[0] != 0
                && v.octets()[0] < 224
                && !(v.octets()[0] == 100 && (64..=127).contains(&v.octets()[1]))
        }
        std::net::IpAddr::V6(v) => v
            .to_ipv4_mapped()
            .map(|v| public_ip(v.into()))
            .unwrap_or_else(|| {
                !v.is_loopback()
                    && !v.is_unspecified()
                    && !v.is_multicast()
                    && (v.segments()[0] & 0xfe00) != 0xfc00
                    && (v.segments()[0] & 0xffc0) != 0xfe80
            }),
    }
}
fn content_range(h: &HeaderMap) -> Result<(u64, u64, u64), String> {
    let s = h
        .get("content-range")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("bytes "))
        .ok_or("服务器未提供有效 Content-Range。")?;
    let (span, total) = s.split_once('/').ok_or("无效 Content-Range。")?;
    let (start, end) = span.split_once('-').ok_or("无效 Content-Range。")?;
    let (a, b, n) = (
        start.parse::<u64>().map_err(|_| "无效范围。")?,
        end.parse::<u64>().map_err(|_| "无效范围。")?,
        total.parse::<u64>().map_err(|_| "无效大小。")?,
    );
    if a > b || b >= n {
        return Err("远端返回了错误字节范围。".into());
    }
    Ok((a, b, n))
}
pub(super) async fn pin(c: &connection::Connection, target: &Url) -> Result<Validator, String> {
    let response = request(c, target, Method::GET, Some("bytes=0-0"), None).await?;
    if response.status() != StatusCode::PARTIAL_CONTENT {
        return Err("服务器未支持可靠字节范围读取。请使用一次下载临时原片。".into());
    }
    let (start, end, size) = content_range(response.headers())?;
    if start != 0 || end != 0 {
        return Err("服务器返回了错误探测范围。".into());
    }
    let validator = Validator::from_headers(response.headers(), size)?;
    let body = bounded_body(response, 1).await?;
    if body.len() != 1 {
        return Err("媒体探测范围响应被截断。".into());
    }
    Ok(validator)
}

struct ProxyState {
    connection: connection::Connection,
    target: Url,
    validator: Validator,
    token: String,
    failure: Mutex<Option<String>>,
    stop: AtomicBool,
    stopped: tokio::sync::Notify,
    bytes: AtomicU64,
    semaphore: Arc<Semaphore>,
}
impl ProxyState {
    fn fail(&self, msg: &str) {
        if let Ok(mut f) = self.failure.lock() {
            if f.is_none() {
                *f = Some(msg.into());
            }
        }
    }
}
pub(super) struct Proxy {
    pub url: String,
    state: Arc<ProxyState>,
    shutdown: Option<oneshot::Sender<()>>,
    task: Option<tokio::task::JoinHandle<std::io::Result<()>>>,
}
impl Proxy {
    pub async fn open(
        c: connection::Connection,
        target: Url,
        validator: Validator,
    ) -> Result<Self, String> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|_| "无法建立本地媒体通道。")?;
        let addr = listener
            .local_addr()
            .map_err(|_| "无法读取本地通道地址。")?;
        let token = super::random_id()?;
        let state = Arc::new(ProxyState {
            connection: c,
            target,
            validator,
            token: token.clone(),
            failure: Mutex::new(None),
            stop: AtomicBool::new(false),
            stopped: tokio::sync::Notify::new(),
            bytes: AtomicU64::new(0),
            semaphore: Arc::new(Semaphore::new(4)),
        });
        let router = Router::new()
            .fallback(any(proxy_request))
            .with_state(state.clone());
        let (tx, rx) = oneshot::channel();
        let task = tokio::spawn(async move {
            axum::serve(listener, router)
                .with_graceful_shutdown(async {
                    let _ = rx.await;
                })
                .await
        });
        Ok(Self {
            url: format!("http://{addr}/{token}"),
            state,
            shutdown: Some(tx),
            task: Some(task),
        })
    }
    pub async fn close(mut self) -> Result<(), String> {
        self.state.stop.store(true, Ordering::Release);
        self.state.stopped.notify_waiters();
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
        if let Some(mut task) = self.task.take() {
            match tokio::time::timeout(Duration::from_secs(5), &mut task).await {
                Ok(Ok(Ok(()))) => {}
                _ => {
                    task.abort();
                    let _ = task.await;
                    self.state.fail("本地媒体通道未能完整收尾。");
                }
            }
        }
        if tokio::time::timeout(
            Duration::from_secs(5),
            self.state.semaphore.clone().acquire_many_owned(4),
        )
        .await
        .is_err()
        {
            self.state.fail("媒体请求未能收尾。");
        }
        self.state
            .failure
            .lock()
            .map_err(|_| "媒体通道状态损坏。")?
            .clone()
            .map_or(Ok(()), Err)
    }
}
impl Drop for Proxy {
    fn drop(&mut self) {
        self.state.stop.store(true, Ordering::Release);
        self.state.stopped.notify_waiters();
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

async fn proxy_request(State(s): State<Arc<ProxyState>>, req: Request<Body>) -> Response {
    if req.uri().path() != format!("/{}", s.token) || req.uri().query().is_some() {
        return Response::builder().status(404).body(Body::empty()).unwrap();
    }
    if !matches!(*req.method(), Method::GET | Method::HEAD) {
        return Response::builder().status(405).body(Body::empty()).unwrap();
    }
    let result = forward(s.clone(), req).await;
    match result {
        Ok(r) => r,
        Err(e) => {
            s.fail(&e);
            Response::builder().status(502).body(Body::empty()).unwrap()
        }
    }
}
async fn forward(s: Arc<ProxyState>, req: Request<Body>) -> Result<Response, String> {
    if s.stop.load(Ordering::Acquire) {
        return Err("媒体通道已关闭。".into());
    }
    let permit = s
        .semaphore
        .clone()
        .try_acquire_owned()
        .map_err(|_| "媒体并发请求超过上限。")?;
    let range = req
        .headers()
        .get("range")
        .map(|v| v.to_str().map(str::to_owned))
        .transpose()
        .map_err(|_| "无效媒体范围。")?;
    let requested = if let Some(range) = &range {
        let value = range.strip_prefix("bytes=").ok_or("不支持此字节范围。")?;
        let (a, b) = value.split_once('-').ok_or("不支持此字节范围。")?;
        let start = a.parse::<u64>().map_err(|_| "不支持后缀或多段字节范围。")?;
        let end = if b.is_empty() {
            s.validator.size - 1
        } else {
            b.parse::<u64>()
                .map_err(|_| "无效范围尾部。")?
                .min(s.validator.size - 1)
        };
        if start > end {
            return Err("媒体范围越界。".into());
        }
        Some((start, end))
    } else {
        None
    };
    let response = tokio::select! {r=request(&s.connection,&s.target,req.method().clone(),range.as_deref(),Some(&s.validator))=>r?,_=s.stopped.notified()=>return Response::builder().status(503).body(Body::empty()).map_err(|_|"媒体通道已关闭。".into())};
    let status = response.status();
    if !status.is_success() {
        return Err(status_error(status));
    }
    let expected = if let Some((a, b)) = requested {
        if status != StatusCode::PARTIAL_CONTENT {
            return Err("服务器忽略了媒体字节范围。".into());
        }
        let (start, end, size) = content_range(response.headers())?;
        if start != a || end != b || !s.validator.matches(response.headers(), size) {
            return Err("源文件版本或范围发生变化，停止获取。".into());
        }
        b - a + 1
    } else {
        let length = response
            .headers()
            .get("content-length")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse().ok())
            .ok_or("媒体响应缺少长度。")?;
        if status != StatusCode::OK || !s.validator.matches(response.headers(), length) {
            return Err("源文件版本发生变化，停止获取。".into());
        }
        length
    };
    if response
        .headers()
        .get("content-encoding")
        .is_some_and(|v| v != "identity")
    {
        return Err("不接受压缩的媒体字节范围。".into());
    }
    let mut builder = Response::builder().status(status);
    for name in [
        "content-length",
        "content-range",
        "content-type",
        "etag",
        "last-modified",
        "accept-ranges",
    ] {
        if let Some(v) = response.headers().get(name) {
            builder = builder.header(name, v.clone());
        }
    }
    builder = builder.header("Cache-Control", HeaderValue::from_static("no-store"));
    if req.method() == Method::HEAD {
        return builder
            .body(Body::empty())
            .map_err(|_| "媒体响应失败。".into());
    }
    let stream = response.bytes_stream();
    let body = stream::unfold(
        (stream, s, permit, 0_u64, false),
        move |(mut upstream, s, permit, count, done)| async move {
            if done || s.stop.load(Ordering::Acquire) {
                return None;
            }
            let chunk = tokio::select! {r=upstream.next()=>r,_=s.stopped.notified()=>return None};
            match chunk {
                Some(Ok(bytes)) => {
                    let n = count + bytes.len() as u64;
                    let total = s.bytes.fetch_add(bytes.len() as u64, Ordering::AcqRel)
                        + bytes.len() as u64;
                    if n > expected || total > MAX_BYTES * 2 {
                        s.fail("媒体读取超过长度或流量上限。");
                        Some((
                            Err(std::io::Error::other("media-limit")),
                            (upstream, s, permit, n, true),
                        ))
                    } else {
                        Some((Ok(bytes), (upstream, s, permit, n, false)))
                    }
                }
                Some(Err(_)) => {
                    s.fail("媒体响应读取失败。");
                    Some((
                        Err(std::io::Error::other("upstream-read")),
                        (upstream, s, permit, count, true),
                    ))
                }
                None if count != expected => {
                    s.fail("媒体响应被截断。");
                    Some((
                        Err(std::io::Error::other("upstream-truncated")),
                        (upstream, s, permit, count, true),
                    ))
                }
                None => None,
            }
        },
    );
    builder
        .body(Body::from_stream(body))
        .map_err(|_| "无法创建媒体响应。".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validators_and_network_boundaries() {
        assert!(!public_ip("127.0.0.1".parse().unwrap()));
        assert!(!public_ip("::ffff:127.0.0.1".parse().unwrap()));
        assert!(public_ip("8.8.8.8".parse().unwrap()));
        let mut h = HeaderMap::new();
        h.insert("etag", HeaderValue::from_static("\"a\""));
        let v = Validator::from_headers(&h, 10).unwrap();
        assert!(v.matches(&h, 10));
        assert!(!v.matches(&h, 11));
        h.insert("etag", HeaderValue::from_static("\"b\""));
        assert!(!v.matches(&h, 10));
    }
    #[test]
    fn basic_is_origin_scoped_and_signed_query_remains_ephemeral() {
        let c = connection::Connection {
            id: "c".into(),
            name: "c".into(),
            root: "https://example.com/dav/".into(),
            username: "u".into(),
            password: "secret".into(),
        };
        let client = client().unwrap();
        for u in [
            "https://cdn.example.com/a?sign=a%2Fb%25c",
            "http://example.com/a",
            "https://example.com:444/a",
        ] {
            let url = connection::url(u).unwrap();
            let r = authenticated_request(&client, &c, url, Method::GET)
                .unwrap()
                .build()
                .unwrap();
            assert!(r.headers().get("authorization").is_none());
            assert!(r.headers().get("cookie").is_none());
            assert!(r.headers().get("referer").is_none());
        }
        let r = authenticated_request(
            &client,
            &c,
            connection::url("https://example.com/dav/a").unwrap(),
            Method::GET,
        )
        .unwrap()
        .build()
        .unwrap();
        assert!(r.headers().get("authorization").is_some());
    }
}
