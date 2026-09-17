use std::io::{self, Read, Write};

const MAX_REQUEST_BYTES: u64 = 1024 * 1024;

fn main() {
    if let Err(error) = run() {
        let _ = writeln!(io::stderr(), "{error}");
        std::process::exit(2);
    }
}

fn run() -> Result<(), String> {
    let mut request = Vec::new();
    io::stdin()
        .take(MAX_REQUEST_BYTES + 1)
        .read_to_end(&mut request)
        .map_err(|error| format!("读取无界面对齐请求失败：{error}"))?;
    if request.is_empty() {
        return Err("无界面对齐请求为空。".to_string());
    }
    if request.len() as u64 > MAX_REQUEST_BYTES {
        return Err("无界面对齐请求超过 1 MiB 上限。".to_string());
    }
    let request =
        String::from_utf8(request).map_err(|_| "无界面对齐请求必须是 UTF-8 JSON。".to_string())?;
    let response = danmaku_timeline_studio_lib::run_headless_audio_alignment_json(&request)?;
    io::stdout()
        .write_all(response.as_bytes())
        .and_then(|_| io::stdout().write_all(b"\n"))
        .map_err(|error| format!("写出无界面对齐结果失败：{error}"))
}
