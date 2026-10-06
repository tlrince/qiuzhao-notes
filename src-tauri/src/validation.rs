use std::{
    fs,
    io::{Read, Write},
    path::Path,
};

pub const MAX_BACKUP_BYTES: usize = 25 * 1024 * 1024;

pub fn validate_json(text: &str) -> Result<(), String> {
    if text.len() > MAX_BACKUP_BYTES {
        return Err("备份文件超过 25 MB 限制".into());
    }
    serde_json::from_str::<serde_json::Value>(text).map_err(|_| "备份不是有效 JSON".to_string())?;
    Ok(())
}

pub fn validate_json_path(path: &Path) -> Result<(), String> {
    if !path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("json"))
    {
        return Err("请选择 .json 备份文件".into());
    }
    Ok(())
}

pub fn read_backup(path: &Path) -> Result<String, String> {
    validate_json_path(path)?;
    let file = fs::File::open(path).map_err(|_| "无法打开备份文件".to_string())?;
    if !file.metadata().map_err(|_| "无法读取文件信息")?.is_file() {
        return Err("请选择普通文件".into());
    }
    let mut bytes = Vec::new();
    file.take((MAX_BACKUP_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "无法读取备份文件")?;
    if bytes.len() > MAX_BACKUP_BYTES {
        return Err("备份文件超过 25 MB 限制".into());
    }
    let text = String::from_utf8(bytes).map_err(|_| "备份文件必须使用 UTF-8 编码")?;
    validate_json(&text)?;
    Ok(text)
}

// A sibling temporary file keeps replacement atomic on the same filesystem.
// Existing contents remain intact if writing or syncing the new file fails.
pub fn atomic_write(path: &Path, contents: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("无效的保存路径")?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(|_| "无法创建临时文件")?;
    temporary.write_all(contents).map_err(|_| "无法写入文件")?;
    temporary.as_file().sync_all().map_err(|_| "无法同步文件")?;
    temporary
        .persist(path)
        .map_err(|_| "无法替换目标文件，请检查权限")?;
    Ok(())
}

pub fn validate_external(raw: &str) -> Result<url::Url, String> {
    if raw
        .chars()
        .any(|c| c.is_whitespace() || c.is_control() || c == '\\')
        || !(raw.starts_with("http://") || raw.starts_with("https://"))
    {
        return Err("链接格式不正确".into());
    }
    let url = url::Url::parse(raw).map_err(|_| "链接格式不正确")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("仅支持不含登录信息的 HTTP / HTTPS 链接".into());
    }
    Ok(url)
}

pub fn valid_route(route: &str) -> bool {
    if route.len() > 2048 || route.contains(['\\', '\r', '\n', '#']) {
        return false;
    }
    let path = route.split('?').next().unwrap_or("");
    if matches!(
        path,
        "/overview" | "/applications" | "/board" | "/analytics" | "/settings" | "/design-system"
    ) {
        return true;
    }
    path.strip_prefix("/applications/").is_some_and(|id| {
        !id.is_empty()
            && id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn external_urls_reject_native_schemes_and_credentials() {
        for value in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "tauri://localhost",
            "https://user:secret@example.com",
            "not a url",
        ] {
            assert!(validate_external(value).is_err());
        }
        assert!(validate_external("https://example.com/jobs?q=中文").is_ok());
    }

    #[test]
    fn routes_are_internal_and_allowlisted() {
        for value in [
            "/analytics",
            "/applications/job-123?stage=applied",
            "/settings",
        ] {
            assert!(valid_route(value));
        }
        for value in [
            "https://example.com",
            "//example.com",
            "/unknown",
            "/applications/../settings",
            "/applications/%2fetc",
            "/settings#x",
        ] {
            assert!(!valid_route(value));
        }
    }

    #[test]
    fn backups_require_json_utf8_extension_and_size() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("backup.json");
        fs::write(&path, b"{\"records\":[]}").unwrap();
        assert_eq!(read_backup(&path).unwrap(), "{\"records\":[]}");
        fs::write(&path, [0xff]).unwrap();
        assert!(read_backup(&path).is_err());
        assert!(validate_json_path(Path::new("backup.txt")).is_err());
        assert!(validate_json("{broken").is_err());
        assert!(validate_json(&" ".repeat(MAX_BACKUP_BYTES + 1)).is_err());
    }

    #[test]
    fn atomic_replacement_and_failed_save_preserve_existing_files() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("backup.json");
        fs::write(&path, b"old").unwrap();
        atomic_write(&path, b"new").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"new");
        let folder = directory.path().join("folder.json");
        fs::create_dir(&folder).unwrap();
        fs::write(folder.join("keep"), b"safe").unwrap();
        assert!(atomic_write(&folder, b"replacement").is_err());
        assert_eq!(fs::read(folder.join("keep")).unwrap(), b"safe");
    }
}
