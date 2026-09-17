//! Origin-bound redirects and bounded response accumulation for Emby.
use std::time::Duration;

pub(crate) fn client(timeout: Duration) -> Result<reqwest::Client, reqwest::Error> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            let Some(origin) = attempt.previous().first() else {
                return attempt.stop();
            };
            if attempt.previous().len() >= 5 || attempt.url().origin() != origin.origin() {
                attempt.stop()
            } else {
                attempt.follow()
            }
        }))
        .build()
}

pub(crate) async fn read_text(
    mut response: reqwest::Response,
    limit: usize,
) -> Result<String, String> {
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err("Emby 响应超过大小上限。".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "Emby 响应读取失败。")? {
        if chunk.len() > limit.saturating_sub(bytes.len()) {
            return Err("Emby 响应超过大小上限。".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    String::from_utf8(bytes).map_err(|_| "Emby 响应不是有效 UTF-8。".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
    };

    #[tokio::test]
    async fn cross_origin_redirect_does_not_forward_token_or_login_body() {
        for status in [302, 307, 308] {
            let target = TcpListener::bind("127.0.0.1:0").unwrap();
            target.set_nonblocking(true).unwrap();
            let source = TcpListener::bind("127.0.0.1:0").unwrap();
            let url = format!("http://{}/login", source.local_addr().unwrap());
            let response = format!("HTTP/1.1 {status} Redirect\r\nLocation: http://{}/capture\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", target.local_addr().unwrap());
            let server = std::thread::spawn(move || {
                let (mut stream, _) = source.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut buf = [0; 4096];
                let _ = stream.read(&mut buf);
                stream.write_all(response.as_bytes()).unwrap();
            });
            let result = client(Duration::from_secs(5))
                .unwrap()
                .post(url)
                .header("X-Emby-Token", "synthetic-token")
                .body("synthetic-password")
                .send()
                .await
                .unwrap();
            assert_eq!(result.status().as_u16(), status);
            assert_eq!(
                target.accept().unwrap_err().kind(),
                std::io::ErrorKind::WouldBlock
            );
            server.join().unwrap();
        }
    }

    #[tokio::test]
    async fn stops_oversized_chunked_body_before_json_parsing() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = [0; 1024];
            let _ = stream.read(&mut buf);
            let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n8\r\n12345678\r\n8\r\n12345678\r\n0\r\n\r\n");
        });
        let response = client(Duration::from_secs(5))
            .unwrap()
            .get(url)
            .send()
            .await
            .unwrap();
        assert!(read_text(response, 10).await.unwrap_err().contains("上限"));
        server.join().unwrap();
    }
}
