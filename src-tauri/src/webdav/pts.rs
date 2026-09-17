//! Integer decoded-frame PTS evidence, not a claim of complete sample continuity.
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PtsEvidence {
    pub status: String,
    pub frame_count: u64,
    pub first_pts: String,
    pub last_pts: String,
}
#[derive(Default)]
pub(super) struct PtsGuard {
    carry: Vec<u8>,
    count: u64,
    first: Option<i64>,
    last: Option<i64>,
    pending: bool,
    bytes: usize,
}
impl PtsGuard {
    pub fn push(&mut self, bytes: &[u8]) -> Result<(), String> {
        self.bytes += bytes.len();
        if self.bytes > 256 * 1024 * 1024 {
            return Err("PTS 记录超过上限。".into());
        }
        for &b in bytes {
            if b == b'\n' {
                let line = String::from_utf8(std::mem::take(&mut self.carry))
                    .map_err(|_| "PTS 记录编码错误。")?;
                self.line(line.trim_end_matches('\r'))?;
            } else {
                self.carry.push(b);
                if self.carry.len() > 512 {
                    return Err("PTS 行超过上限。".into());
                }
            }
        }
        Ok(())
    }
    fn line(&mut self, line: &str) -> Result<(), String> {
        if self.pending {
            if line != "studio_pts=1" {
                return Err("PTS 帧元数据不完整。".into());
            }
            self.pending = false;
            self.count += 1;
            return Ok(());
        }
        let parts = line.split_whitespace().collect::<Vec<_>>();
        if parts.len() != 3 || !parts[2].starts_with("pts_time:") {
            return Err("无法验证解码帧 PTS。".into());
        }
        let frame = parts[0]
            .strip_prefix("frame:")
            .and_then(|s| s.parse::<u64>().ok());
        let pts = parts[1]
            .strip_prefix("pts:")
            .and_then(|s| s.parse::<i64>().ok())
            .ok_or("音轨帧缺少整数 PTS。")?;
        if frame != Some(self.count) || self.last.is_some_and(|prev| pts < prev) {
            return Err("音轨帧序或 PTS 回跳，停止获取。".into());
        }
        self.first.get_or_insert(pts);
        self.last = Some(pts);
        self.pending = true;
        Ok(())
    }
    pub fn finish(self) -> Result<PtsEvidence, String> {
        if self.pending || !self.carry.is_empty() || self.count == 0 {
            return Err("PTS 记录为空或未完整结束。".into());
        }
        Ok(PtsEvidence {
            status: "verified".into(),
            frame_count: self.count,
            first_pts: self.first.unwrap().to_string(),
            last_pts: self.last.unwrap().to_string(),
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn negative_first_and_integer_precision() {
        let mut g = PtsGuard::default();
        for b in b"frame:0 pts:-5 pts_time:-0.5\nstudio_pts=1\nframe:1 pts:9007199254740993 pts_time:9e15\nstudio_pts=1\n" {g.push(&[*b]).unwrap();}
        let e = g.finish().unwrap();
        assert_eq!(e.frame_count, 2);
        assert_eq!(e.last_pts, "9007199254740993");
    }
    #[test]
    fn rejects_invalid_missing_backwards_truncated() {
        for input in [
            "",
            "frame:0 pts:NOPTS pts_time:NOPTS\nstudio_pts=1\n",
            "frame:1 pts:0 pts_time:0\nstudio_pts=1\n",
            "frame:0 pts:2 pts_time:0\nstudio_pts=1\nframe:1 pts:1 pts_time:0\nstudio_pts=1\n",
            "frame:0 pts:2 pts_time:0\n",
        ] {
            let mut g = PtsGuard::default();
            assert!(g
                .push(input.as_bytes())
                .and_then(|_| g.finish().map(|_| ()))
                .is_err());
        }
    }
}
