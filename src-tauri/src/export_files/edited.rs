//! Explicit editable-XML delivery. This command never attests a projected time map.
use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};
const MAX_BYTES: usize = 256 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditedXmlExportRequest {
    directory_path: String,
    file_name: String,
    content_base64: String,
}

#[tauri::command]
pub async fn save_edited_xml_export(
    request: EditedXmlExportRequest,
) -> Result<SaveExportFileResult, String> {
    tauri::async_runtime::spawn_blocking(move || save(request))
        .await
        .map_err(|e| e.to_string())?
}

fn save(request: EditedXmlExportRequest) -> Result<SaveExportFileResult, String> {
    let directory = validate_export_directory(&request.directory_path)?;
    let name = validate_export_file_name(&request.file_name)?;
    if request.content_base64.len() > MAX_BYTES / 3 * 4 + 4 {
        return Err("本次导出超过 256 MiB，请分批导出。".into());
    }
    let bytes = STANDARD
        .decode(&request.content_base64)
        .map_err(|_| "导出内容编码无效。")?;
    if bytes.len() > MAX_BYTES {
        return Err("本次导出超过 256 MiB，请分批导出。".into());
    }
    if has_case_insensitive_extension(&name, "xml") {
        crate::xml_import_receipt::validate_edited_export_xml(&bytes)?;
    } else if has_case_insensitive_extension(&name, "zip") {
        let entries = parse_and_verify_stored_zip(&bytes)?;
        if entries.len() > 4096 {
            return Err("单次导出分集超过 4096，请分批导出。".into());
        }
        for (entry, content) in entries {
            validate_export_file_name(&entry)?;
            if !has_case_insensitive_extension(&entry, "xml") {
                return Err("弹幕归档只能包含 XML。".into());
            }
            crate::xml_import_receipt::validate_edited_export_xml(content)?;
        }
    } else {
        return Err("弹幕导出仅允许 XML 或包含 XML 的 ZIP。".into());
    }
    write_export_file(&directory, &name, &bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn actual_xml_export_validates_content_and_preserves_existing_file() {
        let mut nonce = [0u8; 12];
        getrandom::fill(&mut nonce).unwrap();
        let dir =
            std::env::temp_dir().join(format!("studio-edited-export-{:x}", Sha256::digest(nonce)));
        fs::create_dir(&dir).unwrap();
        fs::write(dir.join("episode.xml"), b"original").unwrap();
        let xml = br#"<i><d p="1,1,25,16777215,0,0,u,1">export</d></i>"#;
        let request = || EditedXmlExportRequest {
            directory_path: dir.to_string_lossy().into_owned(),
            file_name: "episode.xml".into(),
            content_base64: STANDARD.encode(xml),
        };
        let result = save(request()).unwrap();
        assert!(result.was_renamed);
        assert_eq!(fs::read(&result.file_path).unwrap(), xml);
        assert_eq!(fs::read(dir.join("episode.xml")).unwrap(), b"original");
        for xml in [
            b"<i></i>".as_slice(),
            br#"<i><d p="1,1,25,16777215,0,0,u,1"></d></i>"#,
        ] {
            let mut edited = request();
            edited.content_base64 = STANDARD.encode(xml);
            let result = save(edited).unwrap();
            assert_eq!(fs::read(result.file_path).unwrap(), xml);
        }
        let mut invalid = request();
        invalid.content_base64 = STANDARD.encode(b"<i><d>broken");
        assert!(save(invalid).is_err());
        let mut invalid = request();
        invalid.file_name = "../outside.xml".into();
        assert!(save(invalid).is_err());
        let zip =
            super::super::tests::create_test_stored_zip(&[("one.xml", xml), ("two.xml", xml)]);
        let mut batch = request();
        batch.file_name = "batch.zip".into();
        batch.content_base64 = STANDARD.encode(&zip);
        let result = save(batch).unwrap();
        assert_eq!(fs::read(result.file_path).unwrap(), zip);
        let bad = super::super::tests::create_test_stored_zip(&[
            ("one.xml", xml),
            ("other.txt", b"not XML"),
        ]);
        let mut invalid = request();
        invalid.file_name = "invalid.zip".into();
        invalid.content_base64 = STANDARD.encode(bad);
        assert!(save(invalid).is_err());
        assert!(!dir.join("invalid.zip").exists());
        fs::remove_dir_all(dir).unwrap();
    }
}
