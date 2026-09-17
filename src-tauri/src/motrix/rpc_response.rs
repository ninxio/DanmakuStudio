//! MDXP business errors may use HTTP 500; do not confuse them with lost receipts.
use super::*;

#[derive(Debug)]
pub(super) struct Failure {
    pub status: &'static str,
    pub message: String,
}
impl From<String> for Failure {
    fn from(message: String) -> Self {
        Self {
            status: "uncertain",
            message,
        }
    }
}
impl From<&str> for Failure {
    fn from(message: &str) -> Self {
        message.to_owned().into()
    }
}

pub(super) fn decode(status: reqwest::StatusCode, value: Value) -> Result<Value, Failure> {
    let error = &value["error"];
    // Translate only known protocol reasons; arbitrary upstream messages may contain secrets.
    if let Some(reason) = error["message"]
        .as_str()
        .and_then(|m| m.strip_prefix("Torrent duplicate conflict: "))
    {
        let (state, message) = match reason {
            "active-info-hash" => ("duplicate_conflict", "Motrix 中已有同一资源的任务，旧失败任务也可能占用它。点击“修复重复任务并重试”，核对已有下载或清理失败记录；下载文件保留。"),
            "selection-mismatch" => ("duplicate_conflict", "Motrix 中同一资源已有不同文件选择的任务。点击“修复重复任务并重试”核对已有任务，保留原文件选择。"),
            "existing-files" => ("file_conflict", "下载目录已有同名文件，Motrix 未覆盖它们。请在 Motrix 中确认现有文件，或选择新的下载文件夹。"),
            _ => ("uncertain", "Motrix 报告未识别的重复任务冲突，请在 Motrix 中查看详情。"),
        };
        return Err(Failure {
            status: state,
            message: message.into(),
        });
    }
    if matches!(status.as_u16(), 401 | 403) {
        return Err(Failure {
            status: "rejected",
            message: "Motrix 拒绝本机连接授权，请重启 Motrix 后刷新连接。".into(),
        });
    }
    if let Some(code) = error["code"].as_i64() {
        let (state, explanation) = match code {
            -32601 => ("rejected", "当前 Motrix 不支持此操作，请检查版本。"),
            -32602 => ("rejected", "Motrix 拒绝了下载参数，请核对磁力和目录。"),
            _ => (
                "uncertain",
                "Motrix 未返回可确认的任务，请刷新或用原请求重试。",
            ),
        };
        return Err(Failure {
            status: state,
            message: format!("{explanation}（HTTP {}，代码 {code}）", status.as_u16()),
        });
    }
    if !status.is_success() {
        return Err(format!(
            "Motrix 返回 HTTP {}，请检查本机版本和连接。",
            status.as_u16()
        )
        .into());
    }
    if !error.is_null() {
        return Err("Motrix 返回了无法识别的错误，未确认下载任务。".into());
    }
    value
        .get("result")
        .cloned()
        .ok_or_else(|| "Motrix 响应缺少结果。".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn actual_http_500_duplicate_is_a_confirmed_conflict_not_a_connection_failure() {
        let error = decode(
            reqwest::StatusCode::INTERNAL_SERVER_ERROR,
            json!({
                "jsonrpc":"2.0", "id":"studio",
                "error":{"code":-32001,"message":"Torrent duplicate conflict: active-info-hash"}
            }),
        )
        .unwrap_err();
        assert_eq!(error.status, "duplicate_conflict");
        assert!(error.message.contains("同一资源"));
        assert!(!error.message.contains("连接"));
    }

    #[test]
    fn file_conflicts_auth_and_unknown_errors_keep_distinct_recovery_actions() {
        for (reason, expected) in [
            ("existing-files", "file_conflict"),
            ("selection-mismatch", "duplicate_conflict"),
        ] {
            let e = decode(reqwest::StatusCode::INTERNAL_SERVER_ERROR, json!({"error":{"code":-32001,"message":format!("Torrent duplicate conflict: {reason}")}})).unwrap_err();
            assert_eq!(e.status, expected);
        }
        assert_eq!(
            decode(reqwest::StatusCode::FORBIDDEN, json!({}))
                .unwrap_err()
                .status,
            "rejected"
        );
        let e = decode(reqwest::StatusCode::INTERNAL_SERVER_ERROR, json!({"error":{"code":-32001,"message":"secret=private-token https://private.example"}})).unwrap_err();
        assert_eq!(e.status, "uncertain");
        assert!(e.message.contains("-32001"));
        assert!(!e.message.contains("private"));
        assert_eq!(
            decode(reqwest::StatusCode::OK, json!({"result":{"id":"accepted"}})).unwrap()["id"],
            "accepted"
        );
    }
}
