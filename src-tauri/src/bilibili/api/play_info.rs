//! Play metadata and optional audio are independent. Bilibili can return both
//! camelCase and snake_case keys in one object; Serde aliases reject that shape.
use serde::Deserialize;
use serde_json::Value;

#[derive(Debug, Deserialize)]
#[serde(try_from = "Value")]
pub(super) struct PlayUrlData {
    pub timelength: Option<u64>,
    pub dash: Option<DashInfo>,
}

#[derive(Debug, Deserialize)]
#[serde(try_from = "Value")]
pub(in crate::bilibili) struct DashInfo {
    pub duration: Option<f64>,
    pub audio: Vec<DashAudio>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(try_from = "Value")]
pub(in crate::bilibili) struct DashAudio {
    pub base_url: String,
    pub backup_url: Vec<String>,
    pub bandwidth: u64,
    pub codecs: String,
    pub mime_type: String,
}

impl TryFrom<Value> for PlayUrlData {
    type Error = &'static str;
    fn try_from(mut value: Value) -> Result<Self, Self::Error> {
        if !value.is_object() {
            return Err("播放信息不是对象");
        }
        Ok(Self {
            timelength: value.get("timelength").and_then(Value::as_u64),
            dash: value
                .get_mut("dash")
                .map(Value::take)
                .and_then(|v| DashInfo::try_from(v).ok()),
        })
    }
}

impl TryFrom<Value> for DashInfo {
    type Error = &'static str;
    fn try_from(mut value: Value) -> Result<Self, Self::Error> {
        if !value.is_object() {
            return Err("DASH 信息不是对象");
        }
        Ok(Self {
            duration: value.get("duration").and_then(Value::as_f64),
            // Missing/null/malformed optional audio must not destroy valid duration.
            audio: value
                .get_mut("audio")
                .and_then(Value::as_array_mut)
                .map(|rows| {
                    rows.iter_mut()
                        .filter_map(|row| DashAudio::try_from(row.take()).ok())
                        .collect()
                })
                .unwrap_or_default(),
        })
    }
}

impl TryFrom<Value> for DashAudio {
    type Error = &'static str;
    fn try_from(value: Value) -> Result<Self, Self::Error> {
        if !value.is_object() {
            return Err("DASH 音轨不是对象");
        }
        let text = |keys: &[&str]| {
            keys.iter()
                .filter_map(|key| {
                    value
                        .get(key)
                        .and_then(Value::as_str)
                        .filter(|s| !s.trim().is_empty())
                })
                .next()
                .unwrap_or_default()
                .to_string()
        };
        let mut backup_url = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for key in ["backupUrl", "backup_url"] {
            if let Some(urls) = value.get(key).and_then(Value::as_array) {
                for url in urls
                    .iter()
                    .filter_map(Value::as_str)
                    .filter(|s| !s.trim().is_empty())
                {
                    if seen.insert(url) {
                        backup_url.push(url.to_string());
                    }
                }
            }
        }
        Ok(Self {
            base_url: text(&["baseUrl", "base_url"]),
            backup_url,
            bandwidth: value
                .get("bandwidth")
                .and_then(Value::as_u64)
                .unwrap_or_default(),
            codecs: text(&["codecs"]),
            mime_type: text(&["mimeType", "mime_type"]),
        })
    }
}
