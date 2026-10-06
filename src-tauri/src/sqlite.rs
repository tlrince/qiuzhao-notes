use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};

/// SQLite's physical layout version. This is deliberately independent from
/// the logical snapshot/backup schemaVersion stored inside the JSON snapshot.
pub const PHYSICAL_SCHEMA_VERSION: i64 = 3;
pub const V1_SNAPSHOT_VERSION: i64 = 1;
pub const V2_SNAPSHOT_VERSION: i64 = 2;

struct ApplicationProjection {
    id: String,
    current_event_id: Option<String>,
    current_status_id: String,
    current_stage_id: Option<String>,
    phase: String,
    outcome: String,
    failed_at: Value,
    applied_on: Option<String>,
}

struct ProjectedEvent {
    id: String,
    status_id: String,
    stage_id: Option<String>,
    context_stage_id: Option<String>,
    phase: String,
    outcome: String,
    failed_at: Value,
    active: bool,
    sequence: i64,
    previous_event_id: Option<String>,
}

struct ProgressProjection {
    application_id: String,
    applied_on: Option<String>,
    events: Vec<ProjectedEvent>,
}

pub struct SqliteStorage {
    path: PathBuf,
}

impl SqliteStorage {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, String> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
        }
        let storage = Self { path };
        let mut connection = storage.conn()?;
        migrate(&mut connection)?;
        Ok(storage)
    }

    fn conn(&self) -> Result<Connection, String> {
        Connection::open(&self.path).map_err(|e| e.to_string())
    }

    /// Read either supported logical snapshot version. The legacy command is
    /// kept version-agnostic so a v2-aware client can inspect v1 before upgrade.
    pub fn read_snapshot(&self) -> Result<(i64, Value), String> {
        let connection = self.conn()?;
        migrate_connection_if_needed(connection)
    }

    /// Explicit v2 IPC entry point. It intentionally also returns v1 snapshots
    /// so the caller can migrate them before its first v2 commit.
    pub fn read_snapshot_v2(&self) -> Result<(i64, Value), String> {
        self.read_snapshot()
    }

    pub fn commit_snapshot(&self, expected_revision: i64, data: Value) -> Result<i64, String> {
        let mut connection = self.conn()?;
        migrate(&mut connection)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        let (current_revision, _, current_data) = read_current(&transaction)?;
        if current_revision != expected_revision {
            return Err(format!(
                "CONFLICT: expected {expected_revision}, actual {current_revision}"
            ));
        }
        if snapshot_version(&current_data)? == V2_SNAPSHOT_VERSION {
            return Err(
                "BACKUP_INCOMPATIBLE:当前数据库已升级到 schemaVersion 2，旧客户端不能写入".into(),
            );
        }
        validate_v1_snapshot(&data)?;
        commit_data(transaction, current_revision, &data, V1_SNAPSHOT_VERSION)
    }

    /// The first v2 commit preserves the exact v1 snapshot and its revision in
    /// the same SQLite transaction as the CAS upgrade. Invalid data or a CAS
    /// conflict therefore cannot leave a partial backup or partial migration.
    pub fn commit_snapshot_v2(&self, expected_revision: i64, data: Value) -> Result<i64, String> {
        let mut connection = self.conn()?;
        migrate(&mut connection)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        let (current_revision, current_version, current_data) = read_current(&transaction)?;
        if current_revision != expected_revision {
            return Err(format!(
                "CONFLICT: expected {expected_revision}, actual {current_revision}"
            ));
        }
        validate_v2_snapshot(&data)?;

        if current_version == V1_SNAPSHOT_VERSION {
            validate_v1_snapshot(&current_data)
                .map_err(|error| format!("BACKUP_INCOMPATIBLE:无法安全升级旧快照: {error}"))?;
            transaction
                .execute(
                    "INSERT OR IGNORE INTO snapshot_recovery(id,source_schema_version,source_revision,snapshot) VALUES(1,?1,?2,?3)",
                    params![
                        V1_SNAPSHOT_VERSION,
                        current_revision,
                        serde_json::to_string(&current_data).map_err(|e| e.to_string())?
                    ],
                )
                .map_err(|e| e.to_string())?;
        }

        commit_data(transaction, current_revision, &data, V2_SNAPSHOT_VERSION)
    }

    /// Restore a full v2 backup after preserving the displaced v2 snapshot in
    /// the same SQLite transaction as revision-CAS replacement.
    pub fn restore_snapshot_v2(&self, expected_revision: i64, data: Value) -> Result<i64, String> {
        let mut connection = self.conn()?;
        migrate(&mut connection)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        let (current_revision, current_version, current_data) = read_current(&transaction)?;
        if current_revision != expected_revision {
            return Err(format!(
                "CONFLICT: expected {expected_revision}, actual {current_revision}"
            ));
        }
        if current_version != V2_SNAPSHOT_VERSION {
            return Err("BACKUP_INCOMPATIBLE:恢复前必须先迁移本地快照到 v2".into());
        }
        validate_v2_snapshot(&data)?;
        transaction
            .execute(
                "INSERT INTO snapshot_restore_recovery(source_revision,source_schema_version,snapshot) VALUES(?1,?2,?3)",
                params![
                    current_revision,
                    V2_SNAPSHOT_VERSION,
                    serde_json::to_string(&current_data).map_err(|e| e.to_string())?
                ],
            )
            .map_err(|e| e.to_string())?;
        commit_data(transaction, current_revision, &data, V2_SNAPSHOT_VERSION)
    }

    /// Returns immutable recovery copies with stable ids. Snapshot bodies are
    /// included for the Tauri adapter to normalize v1 copies before a restore.
    pub fn read_recovery_snapshots_v2(&self) -> Result<Value, String> {
        let mut connection = self.conn()?;
        migrate(&mut connection)?;
        let mut entries = Vec::new();
        {
            let mut statement = connection
                .prepare("SELECT source_revision,source_schema_version,snapshot FROM snapshot_restore_recovery")
                .map_err(|e| e.to_string())?;
            let rows = statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })
                .map_err(|e| e.to_string())?;
            for row in rows {
                let (revision, schema_version, raw) = row.map_err(|e| e.to_string())?;
                if revision < 0 || schema_version != V2_SNAPSHOT_VERSION {
                    return Err("BACKUP_INCOMPATIBLE:恢复副本版本信息无效".into());
                }
                let data: Value = serde_json::from_str(&raw)
                    .map_err(|e| format!("BACKUP_INCOMPATIBLE:恢复副本 JSON 损坏: {e}"))?;
                validate_v2_snapshot(&data)
                    .map_err(|e| format!("BACKUP_INCOMPATIBLE:恢复副本无效: {e}"))?;
                entries.push(json!({
                    "id": format!("restore-v2-{revision}"),
                    "sourceRevision": revision,
                    "sourceSchemaVersion": schema_version,
                    "data": data
                }));
            }
        }
        let legacy = connection
            .query_row(
                "SELECT source_revision,source_schema_version,snapshot FROM snapshot_recovery WHERE id=1",
                [],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, String>(2)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if let Some((revision, schema_version, raw)) = legacy {
            if revision < 0 || schema_version != V1_SNAPSHOT_VERSION {
                return Err("BACKUP_INCOMPATIBLE:旧版恢复副本版本信息无效".into());
            }
            let data: Value = serde_json::from_str(&raw)
                .map_err(|e| format!("BACKUP_INCOMPATIBLE:旧版恢复副本 JSON 损坏: {e}"))?;
            validate_v1_snapshot(&data)
                .map_err(|e| format!("BACKUP_INCOMPATIBLE:旧版恢复副本无效: {e}"))?;
            entries.push(json!({
                "id": format!("v1-{revision}"),
                "sourceRevision": revision,
                "sourceSchemaVersion": schema_version,
                "data": data
            }));
        }
        entries.sort_by(|a, b| {
            let a_revision = a
                .get("sourceRevision")
                .and_then(Value::as_i64)
                .unwrap_or_default();
            let b_revision = b
                .get("sourceRevision")
                .and_then(Value::as_i64)
                .unwrap_or_default();
            b_revision.cmp(&a_revision)
        });
        Ok(Value::Array(entries))
    }

    /// Restores one immutable recovery entry and retains the displaced current
    /// v2 snapshot in the same CAS transaction. `source_data` binds the IPC
    /// request to the chosen immutable entry; v1 conversion stays in TypeScript.
    pub fn restore_recovery_snapshot_v2(
        &self,
        expected_revision: i64,
        recovery_id: &str,
        data: Value,
        source_data: Value,
    ) -> Result<i64, String> {
        let mut connection = self.conn()?;
        migrate(&mut connection)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        let (current_revision, current_version, current_data) = read_current(&transaction)?;
        if current_revision != expected_revision {
            return Err(format!(
                "CONFLICT: expected {expected_revision}, actual {current_revision}"
            ));
        }
        if current_version != V2_SNAPSHOT_VERSION {
            return Err("BACKUP_INCOMPATIBLE:恢复前必须先迁移本地快照到 v2".into());
        }
        validate_v2_snapshot(&data)?;
        let (prefix, suffix) = recovery_id
            .split_once('-')
            .ok_or_else(|| "NOT_FOUND:恢复副本不存在".to_string())?;
        let source_revision = suffix
            .strip_prefix("v2-")
            .or_else(|| if prefix == "v1" { Some(suffix) } else { None })
            .ok_or_else(|| "NOT_FOUND:恢复副本不存在".to_string())?
            .parse::<i64>()
            .map_err(|_| "NOT_FOUND:恢复副本不存在".to_string())?;
        if source_revision < 0 {
            return Err("NOT_FOUND:恢复副本不存在".into());
        }
        let stored_source: Value;
        if recovery_id.starts_with("restore-v2-") {
            let selected = transaction
                .query_row(
                    "SELECT source_schema_version,snapshot FROM snapshot_restore_recovery WHERE source_revision=?1",
                    params![source_revision],
                    |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
                )
                .optional()
                .map_err(|e| e.to_string())?
                .ok_or_else(|| "NOT_FOUND:恢复副本不存在".to_string())?;
            if selected.0 != V2_SNAPSHOT_VERSION {
                return Err("BACKUP_INCOMPATIBLE:恢复副本版本无效".into());
            }
            stored_source = serde_json::from_str(&selected.1)
                .map_err(|e| format!("BACKUP_INCOMPATIBLE:恢复副本 JSON 损坏: {e}"))?;
            validate_v2_snapshot(&stored_source)?;
            if stored_source != source_data || stored_source != data {
                return Err("BACKUP_INCOMPATIBLE:恢复副本与选择的数据不一致".into());
            }
        } else if recovery_id.starts_with("v1-") {
            let selected = transaction
                .query_row(
                    "SELECT source_revision,source_schema_version,snapshot FROM snapshot_recovery WHERE id=1",
                    [],
                    |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, String>(2)?)),
                )
                .optional()
                .map_err(|e| e.to_string())?
                .ok_or_else(|| "NOT_FOUND:恢复副本不存在".to_string())?;
            if selected.0 != source_revision || selected.1 != V1_SNAPSHOT_VERSION {
                return Err("NOT_FOUND:恢复副本不存在".into());
            }
            stored_source = serde_json::from_str(&selected.2)
                .map_err(|e| format!("BACKUP_INCOMPATIBLE:旧版恢复副本 JSON 损坏: {e}"))?;
            validate_v1_snapshot(&stored_source)?;
            if stored_source != source_data {
                return Err("BACKUP_INCOMPATIBLE:旧版恢复副本与选择的数据不一致".into());
            }
        } else {
            return Err("NOT_FOUND:恢复副本不存在".into());
        }

        let displaced_revision = current_revision;
        transaction
            .execute(
                "INSERT INTO snapshot_restore_recovery(source_revision,source_schema_version,snapshot) VALUES(?1,?2,?3)",
                params![
                    displaced_revision,
                    V2_SNAPSHOT_VERSION,
                    serde_json::to_string(&current_data).map_err(|e| e.to_string())?
                ],
            )
            .map_err(|e| e.to_string())?;
        commit_data(transaction, current_revision, &data, V2_SNAPSHOT_VERSION)
    }

    /// Deletes one explicitly selected recovery entry in a revision-CAS
    /// transaction. No retention policy runs during ordinary commits.
    pub fn delete_recovery_snapshot_v2(
        &self,
        expected_revision: i64,
        recovery_id: &str,
    ) -> Result<i64, String> {
        let mut connection = self.conn()?;
        migrate(&mut connection)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        let (current_revision, current_version, _) = read_current(&transaction)?;
        if current_revision != expected_revision {
            return Err(format!(
                "CONFLICT: expected {expected_revision}, actual {current_revision}"
            ));
        }
        if current_version != V2_SNAPSHOT_VERSION {
            return Err("BACKUP_INCOMPATIBLE:删除恢复副本前必须先迁移本地快照到 v2".into());
        }
        let next_revision = current_revision
            .checked_add(1)
            .ok_or_else(|| "STORAGE:revision 超出范围".to_string())?;

        let removed = if let Some(suffix) = recovery_id.strip_prefix("restore-v2-") {
            let source_revision = suffix
                .parse::<i64>()
                .map_err(|_| "NOT_FOUND:恢复副本不存在".to_string())?;
            if source_revision < 0 || recovery_id != format!("restore-v2-{source_revision}") {
                return Err("NOT_FOUND:恢复副本不存在".into());
            }
            transaction
                .execute(
                    "DELETE FROM snapshot_restore_recovery WHERE source_revision=?1 AND source_schema_version=?2",
                    params![source_revision, V2_SNAPSHOT_VERSION],
                )
                .map_err(|e| e.to_string())?
        } else if let Some(suffix) = recovery_id.strip_prefix("v1-") {
            let source_revision = suffix
                .parse::<i64>()
                .map_err(|_| "NOT_FOUND:恢复副本不存在".to_string())?;
            if source_revision < 0 || recovery_id != format!("v1-{source_revision}") {
                return Err("NOT_FOUND:恢复副本不存在".into());
            }
            transaction
                .execute(
                    "DELETE FROM snapshot_recovery WHERE id=1 AND source_revision=?1 AND source_schema_version=?2",
                    params![source_revision, V1_SNAPSHOT_VERSION],
                )
                .map_err(|e| e.to_string())?
        } else {
            return Err("NOT_FOUND:恢复副本不存在".into());
        };
        if removed != 1 {
            return Err("NOT_FOUND:恢复副本不存在".into());
        }
        transaction
            .execute(
                "UPDATE meta SET value=?1 WHERE key='revision'",
                params![next_revision.to_string()],
            )
            .map_err(|e| e.to_string())?;
        transaction.commit().map_err(|e| e.to_string())?;
        Ok(next_revision)
    }

    /// Exposes the immutable pre-v2 recovery copy for recovery tooling and tests.
    #[cfg(test)]
    pub fn read_pre_v2_backup(&self) -> Result<Option<(i64, i64, Value)>, String> {
        let connection = self.conn()?;
        migrate_connection_if_needed(connection)?;
        let connection = self.conn()?;
        let row = connection
            .query_row(
                "SELECT source_schema_version,source_revision,snapshot FROM snapshot_recovery WHERE id=1",
                [],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(|e| e.to_string())?;
        row.map(|(version, revision, raw)| {
            let snapshot = serde_json::from_str(&raw)
                .map_err(|e| format!("BACKUP_INCOMPATIBLE:迁移恢复副本损坏: {e}"))?;
            Ok((version, revision, snapshot))
        })
        .transpose()
    }
}

fn migrate_connection_if_needed(mut connection: Connection) -> Result<(i64, Value), String> {
    migrate(&mut connection)?;
    let (revision, _, data) = read_current(&connection)?;
    Ok((revision, data))
}

fn commit_data(
    transaction: Transaction<'_>,
    current_revision: i64,
    data: &Value,
    logical_version: i64,
) -> Result<i64, String> {
    let next_revision = current_revision
        .checked_add(1)
        .ok_or_else(|| "STORAGE:revision 超出范围".to_string())?;
    let snapshot = serde_json::to_string(data).map_err(|e| e.to_string())?;
    transaction
        .execute(
            "UPDATE meta SET value=?1 WHERE key='snapshot'",
            params![snapshot],
        )
        .map_err(|e| e.to_string())?;
    transaction
        .execute(
            "UPDATE meta SET value=?1 WHERE key='revision'",
            params![next_revision.to_string()],
        )
        .map_err(|e| e.to_string())?;
    transaction
        .execute(
            "INSERT INTO meta(key,value) VALUES('logical_schema_version',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![logical_version.to_string()],
        )
        .map_err(|e| e.to_string())?;
    transaction.commit().map_err(|e| e.to_string())?;
    Ok(next_revision)
}

fn read_current(connection: &Connection) -> Result<(i64, i64, Value), String> {
    let revision_text: String = connection
        .query_row("SELECT value FROM meta WHERE key='revision'", [], |row| {
            row.get(0)
        })
        .map_err(|e| format!("STORAGE:无法读取 revision: {e}"))?;
    let revision = revision_text
        .parse::<i64>()
        .map_err(|_| "BACKUP_INCOMPATIBLE:revision 损坏".to_string())?;
    if revision < 0 {
        return Err("BACKUP_INCOMPATIBLE:revision 不能为负数".into());
    }
    let raw: String = connection
        .query_row("SELECT value FROM meta WHERE key='snapshot'", [], |row| {
            row.get(0)
        })
        .map_err(|e| format!("STORAGE:无法读取快照: {e}"))?;
    let snapshot: Value = serde_json::from_str(&raw)
        .map_err(|e| format!("BACKUP_INCOMPATIBLE:快照 JSON 损坏: {e}"))?;
    let logical_version =
        snapshot_version(&snapshot).map_err(|error| format!("BACKUP_INCOMPATIBLE:{error}"))?;
    if let Some(stored_version) = connection
        .query_row(
            "SELECT value FROM meta WHERE key='logical_schema_version'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| format!("STORAGE:无法读取逻辑 schemaVersion: {e}"))?
    {
        let stored_version = stored_version
            .parse::<i64>()
            .map_err(|_| "BACKUP_INCOMPATIBLE:逻辑 schemaVersion 损坏".to_string())?;
        if stored_version != logical_version {
            return Err("BACKUP_INCOMPATIBLE:逻辑版本元数据与快照不一致".into());
        }
    }
    match logical_version {
        V1_SNAPSHOT_VERSION => validate_v1_snapshot(&snapshot)
            .map_err(|error| format!("BACKUP_INCOMPATIBLE:持久化 v1 快照无效: {error}"))?,
        V2_SNAPSHOT_VERSION => validate_v2_snapshot(&snapshot)
            .map_err(|error| format!("BACKUP_INCOMPATIBLE:持久化 v2 快照无效: {error}"))?,
        _ => return Err("BACKUP_INCOMPATIBLE:不支持的快照版本".into()),
    }
    Ok((revision, logical_version, snapshot))
}

fn snapshot_version(snapshot: &Value) -> Result<i64, String> {
    let object = snapshot
        .as_object()
        .ok_or_else(|| "快照必须是 JSON 对象".to_string())?;
    if let Some(version) = object.get("schemaVersion") {
        return version
            .as_i64()
            .ok_or_else(|| "顶层 schemaVersion 必须是整数".to_string());
    }
    object
        .get("settings")
        .and_then(Value::as_object)
        .and_then(|settings| settings.get("schemaVersion"))
        .and_then(Value::as_i64)
        .ok_or_else(|| "无法识别快照 schemaVersion".to_string())
}

fn validation_error(message: impl AsRef<str>) -> String {
    format!("VALIDATION:{}", message.as_ref())
}

fn object<'a>(value: &'a Value, path: &str) -> Result<&'a Map<String, Value>, String> {
    value
        .as_object()
        .ok_or_else(|| validation_error(format!("{path} 必须是对象")))
}

fn array<'a>(value: &'a Value, path: &str) -> Result<&'a Vec<Value>, String> {
    value
        .as_array()
        .ok_or_else(|| validation_error(format!("{path} 必须是数组")))
}

fn field<'a>(object: &'a Map<String, Value>, key: &str, path: &str) -> Result<&'a Value, String> {
    object
        .get(key)
        .ok_or_else(|| validation_error(format!("{path}.{key} 缺失")))
}

fn string_at(value: &Value, path: &str) -> Result<String, String> {
    let text = value
        .as_str()
        .ok_or_else(|| validation_error(format!("{path} 必须是字符串")))?;
    if text.trim().is_empty() {
        return Err(validation_error(format!("{path} 不能为空")));
    }
    Ok(text.to_string())
}

fn nullable_string_at(value: &Value, path: &str) -> Result<Option<String>, String> {
    if value.is_null() {
        Ok(None)
    } else {
        string_at(value, path).map(Some)
    }
}

fn string_field(object: &Map<String, Value>, key: &str, path: &str) -> Result<String, String> {
    string_at(field(object, key, path)?, &format!("{path}.{key}"))
}

fn text_field(object: &Map<String, Value>, key: &str, path: &str) -> Result<(), String> {
    if field(object, key, path)?.is_string() {
        Ok(())
    } else {
        Err(validation_error(format!("{path}.{key} 必须是字符串")))
    }
}

fn nullable_string_field(
    object: &Map<String, Value>,
    key: &str,
    path: &str,
) -> Result<Option<String>, String> {
    nullable_string_at(field(object, key, path)?, &format!("{path}.{key}"))
}

fn require_bool(value: &Value, path: &str) -> Result<(), String> {
    if value.is_boolean() {
        Ok(())
    } else {
        Err(validation_error(format!("{path} 必须是布尔值")))
    }
}

fn require_integer(value: &Value, path: &str) -> Result<i64, String> {
    value
        .as_i64()
        .ok_or_else(|| validation_error(format!("{path} 必须是整数")))
}

fn require_enum(value: &Value, path: &str, choices: &[&str]) -> Result<String, String> {
    let text = string_at(value, path)?;
    if choices.contains(&text.as_str()) {
        Ok(text)
    } else {
        Err(validation_error(format!("{path} 值无效")))
    }
}

fn require_fields(object: &Map<String, Value>, keys: &[&str], path: &str) -> Result<(), String> {
    for key in keys {
        field(object, key, path)?;
    }
    Ok(())
}

fn unique_id(
    object: &Map<String, Value>,
    path: &str,
    seen: &mut Vec<String>,
) -> Result<String, String> {
    let id = string_field(object, "id", path)?;
    if seen.contains(&id) {
        return Err(validation_error(format!("{path}.id 重复")));
    }
    seen.push(id.clone());
    Ok(id)
}

fn validate_v1_snapshot(snapshot: &Value) -> Result<(), String> {
    let root = object(snapshot, "data")?;
    require_fields(
        root,
        &[
            "workspace",
            "seasons",
            "channels",
            "settings",
            "applications",
            "stageEvents",
            "outcomeEvents",
            "schedules",
        ],
        "data",
    )?;
    let workspace = object(field(root, "workspace", "data")?, "workspace")?;
    require_fields(
        workspace,
        &["id", "name", "timeZone", "activeSeasonId"],
        "workspace",
    )?;
    string_field(workspace, "id", "workspace")?;
    string_field(workspace, "name", "workspace")?;
    string_field(workspace, "timeZone", "workspace")?;
    nullable_string_field(workspace, "activeSeasonId", "workspace")?;
    for key in [
        "seasons",
        "channels",
        "applications",
        "stageEvents",
        "outcomeEvents",
        "schedules",
    ] {
        array(field(root, key, "data")?, &format!("data.{key}"))?;
    }
    let settings = object(field(root, "settings", "data")?, "settings")?;
    if require_integer(
        field(settings, "schemaVersion", "settings")?,
        "settings.schemaVersion",
    )? != V1_SNAPSHOT_VERSION
    {
        return Err(validation_error("v1 settings.schemaVersion 必须为 1"));
    }
    let last_backup = field(settings, "lastBackupAt", "settings")?;
    if !last_backup.is_null() && !last_backup.is_string() {
        return Err(validation_error(
            "settings.lastBackupAt 必须是字符串或 null",
        ));
    }
    object(
        field(settings, "preferences", "settings")?,
        "settings.preferences",
    )?;
    Ok(())
}

fn validate_v2_snapshot(snapshot: &Value) -> Result<(), String> {
    let root = object(snapshot, "data")?;
    if require_integer(field(root, "schemaVersion", "data")?, "data.schemaVersion")?
        != V2_SNAPSHOT_VERSION
    {
        return Err(validation_error("顶层 schemaVersion 必须为 2"));
    }
    require_fields(
        root,
        &[
            "workspace",
            "seasons",
            "channels",
            "settings",
            "applications",
            "schedules",
            "definitions",
            "progressRecords",
            "legacyHistory",
            "migration",
        ],
        "data",
    )?;

    let workspace = object(field(root, "workspace", "data")?, "workspace")?;
    require_fields(
        workspace,
        &["id", "name", "timeZone", "activeSeasonId"],
        "workspace",
    )?;
    string_field(workspace, "id", "workspace")?;
    string_field(workspace, "name", "workspace")?;
    string_field(workspace, "timeZone", "workspace")?;
    let active_season_id = nullable_string_field(workspace, "activeSeasonId", "workspace")?;

    let mut season_ids = Vec::new();
    for (index, item) in array(field(root, "seasons", "data")?, "data.seasons")?
        .iter()
        .enumerate()
    {
        let path = format!("seasons[{index}]");
        let season = object(item, &path)?;
        require_fields(
            season,
            &[
                "id",
                "name",
                "startDate",
                "endDate",
                "targetCount",
                "archivedAt",
            ],
            &path,
        )?;
        unique_id(season, &path, &mut season_ids)?;
        string_field(season, "name", &path)?;
        string_field(season, "startDate", &path)?;
        string_field(season, "endDate", &path)?;
        if require_integer(
            field(season, "targetCount", &path)?,
            &format!("{path}.targetCount"),
        )? < 1
        {
            return Err(validation_error(format!("{path}.targetCount 必须大于 0")));
        }
        nullable_string_field(season, "archivedAt", &path)?;
    }
    if active_season_id
        .as_ref()
        .is_some_and(|id| !season_ids.contains(id))
    {
        return Err(validation_error(
            "workspace.activeSeasonId 引用了不存在的招聘季",
        ));
    }

    let mut channel_ids = Vec::new();
    for (index, item) in array(field(root, "channels", "data")?, "data.channels")?
        .iter()
        .enumerate()
    {
        let path = format!("channels[{index}]");
        let channel = object(item, &path)?;
        require_fields(channel, &["id", "name", "archivedAt"], &path)?;
        unique_id(channel, &path, &mut channel_ids)?;
        string_field(channel, "name", &path)?;
        nullable_string_field(channel, "archivedAt", &path)?;
    }

    let settings = object(field(root, "settings", "data")?, "settings")?;
    require_fields(
        settings,
        &["schemaVersion", "lastBackupAt", "preferences"],
        "settings",
    )?;
    if require_integer(
        field(settings, "schemaVersion", "settings")?,
        "settings.schemaVersion",
    )? != V2_SNAPSHOT_VERSION
    {
        return Err(validation_error("settings.schemaVersion 必须为 2"));
    }
    let last_backup = field(settings, "lastBackupAt", "settings")?;
    if !last_backup.is_null() && !last_backup.is_string() {
        return Err(validation_error(
            "settings.lastBackupAt 必须是字符串或 null",
        ));
    }
    object(
        field(settings, "preferences", "settings")?,
        "settings.preferences",
    )?;

    let definitions = object(field(root, "definitions", "data")?, "definitions")?;
    require_fields(definitions, &["stages", "statuses"], "definitions")?;
    let mut stage_ids = Vec::new();
    for (index, item) in array(
        field(definitions, "stages", "definitions")?,
        "definitions.stages",
    )?
    .iter()
    .enumerate()
    {
        let path = format!("definitions.stages[{index}]");
        let stage = object(item, &path)?;
        require_fields(
            stage,
            &[
                "id",
                "name",
                "category",
                "sortOrder",
                "archivedAt",
                "countsAsInterview",
            ],
            &path,
        )?;
        unique_id(stage, &path, &mut stage_ids)?;
        string_field(stage, "name", &path)?;
        require_enum(
            field(stage, "category", &path)?,
            &format!("{path}.category"),
            &[
                "screening",
                "written_test",
                "assessment",
                "ai_interview",
                "interview",
                "pool",
                "offer",
                "custom",
            ],
        )?;
        require_integer(
            field(stage, "sortOrder", &path)?,
            &format!("{path}.sortOrder"),
        )?;
        nullable_string_field(stage, "archivedAt", &path)?;
        require_bool(
            field(stage, "countsAsInterview", &path)?,
            &format!("{path}.countsAsInterview"),
        )?;
        if let Some(round) = stage.get("interviewRound") {
            if require_integer(round, &format!("{path}.interviewRound"))? < 0 {
                return Err(validation_error(format!(
                    "{path}.interviewRound 不能为负数"
                )));
            }
        }
    }

    let mut status_ids = Vec::new();
    let statuses = array(
        field(definitions, "statuses", "definitions")?,
        "definitions.statuses",
    )?;
    for (index, item) in statuses.iter().enumerate() {
        let path = format!("definitions.statuses[{index}]");
        let status = object(item, &path)?;
        require_fields(
            status,
            &[
                "id",
                "name",
                "color",
                "sortOrder",
                "version",
                "archivedAt",
                "semantic",
                "stageId",
                "defaultPhase",
                "statisticsCategory",
                "semanticsHistory",
            ],
            &path,
        )?;
        unique_id(status, &path, &mut status_ids)?;
        string_field(status, "name", &path)?;
        string_field(status, "color", &path)?;
        require_integer(
            field(status, "sortOrder", &path)?,
            &format!("{path}.sortOrder"),
        )?;
        let version =
            require_integer(field(status, "version", &path)?, &format!("{path}.version"))?;
        if version < 1 {
            return Err(validation_error(format!("{path}.version 必须为正数")));
        }
        nullable_string_field(status, "archivedAt", &path)?;
        require_enum(
            field(status, "semantic", &path)?,
            &format!("{path}.semantic"),
            &[
                "draft",
                "submitted",
                "screening",
                "pool",
                "stage",
                "offer_received",
                "offer_accepted",
                "offer_declined",
                "failed",
                "withdrawn",
                "custom",
            ],
        )?;
        let stage_id = nullable_string_field(status, "stageId", &path)?;
        if stage_id.as_ref().is_some_and(|id| !stage_ids.contains(id)) {
            return Err(validation_error(format!(
                "{path}.stageId 引用了不存在的环节"
            )));
        }
        require_enum(
            field(status, "defaultPhase", &path)?,
            &format!("{path}.defaultPhase"),
            &[
                "unknown",
                "waiting",
                "in_progress",
                "awaiting_result",
                "passed",
            ],
        )?;
        nullable_string_field(status, "statisticsCategory", &path)?;
        let history = array(
            field(status, "semanticsHistory", &path)?,
            &format!("{path}.semanticsHistory"),
        )?;
        if history.len() != version as usize {
            return Err(validation_error(format!(
                "{path}.semanticsHistory 与 version 不一致"
            )));
        }
        for (history_index, revision) in history.iter().enumerate() {
            let history_path = format!("{path}.semanticsHistory[{history_index}]");
            let revision = object(revision, &history_path)?;
            require_fields(
                revision,
                &[
                    "version",
                    "semantic",
                    "stageId",
                    "stageCategory",
                    "defaultPhase",
                    "statisticsCategory",
                    "countsAsInterview",
                ],
                &history_path,
            )?;
            if require_integer(
                field(revision, "version", &history_path)?,
                &format!("{history_path}.version"),
            )? != history_index as i64 + 1
            {
                return Err(validation_error(format!("{history_path}.version 顺序无效")));
            }
            require_enum(
                field(revision, "semantic", &history_path)?,
                &format!("{history_path}.semantic"),
                &[
                    "draft",
                    "submitted",
                    "screening",
                    "pool",
                    "stage",
                    "offer_received",
                    "offer_accepted",
                    "offer_declined",
                    "failed",
                    "withdrawn",
                    "custom",
                ],
            )?;
            let revision_stage_id = nullable_string_field(revision, "stageId", &history_path)?;
            if revision_stage_id
                .as_ref()
                .is_some_and(|id| !stage_ids.contains(id))
            {
                return Err(validation_error(format!(
                    "{history_path}.stageId 引用了不存在的环节"
                )));
            }
            let stage_category = nullable_string_field(revision, "stageCategory", &history_path)?;
            if stage_category.is_some()
                && ![
                    "screening",
                    "written_test",
                    "assessment",
                    "ai_interview",
                    "interview",
                    "pool",
                    "offer",
                    "custom",
                ]
                .contains(&stage_category.as_deref().unwrap_or(""))
            {
                return Err(validation_error(format!(
                    "{history_path}.stageCategory 无效"
                )));
            }
            require_enum(
                field(revision, "defaultPhase", &history_path)?,
                &format!("{history_path}.defaultPhase"),
                &[
                    "unknown",
                    "waiting",
                    "in_progress",
                    "awaiting_result",
                    "passed",
                ],
            )?;
            nullable_string_field(revision, "statisticsCategory", &history_path)?;
            require_bool(
                field(revision, "countsAsInterview", &history_path)?,
                &format!("{history_path}.countsAsInterview"),
            )?;
        }
    }

    let mut application_ids = Vec::new();
    let mut application_current: Vec<ApplicationProjection> = Vec::new();
    for (index, item) in array(field(root, "applications", "data")?, "data.applications")?
        .iter()
        .enumerate()
    {
        let path = format!("applications[{index}]");
        let application = object(item, &path)?;
        require_fields(
            application,
            &[
                "id",
                "seasonId",
                "company",
                "role",
                "city",
                "channelId",
                "jobUrl",
                "trackingUrl",
                "appliedOn",
                "currentStatusId",
                "currentStage",
                "phase",
                "outcome",
                "failedAt",
                "currentEventId",
                "isStarred",
                "notes",
                "createdAt",
                "updatedAt",
            ],
            &path,
        )?;
        let id = unique_id(application, &path, &mut application_ids)?;
        if !season_ids.contains(&string_field(application, "seasonId", &path)?) {
            return Err(validation_error(format!(
                "{path}.seasonId 引用了不存在的招聘季"
            )));
        }
        string_field(application, "company", &path)?;
        string_field(application, "role", &path)?;
        text_field(application, "city", &path)?;
        if !channel_ids.contains(&string_field(application, "channelId", &path)?) {
            return Err(validation_error(format!(
                "{path}.channelId 引用了不存在的渠道"
            )));
        }
        text_field(application, "jobUrl", &path)?;
        text_field(application, "trackingUrl", &path)?;
        let applied_on = nullable_string_field(application, "appliedOn", &path)?;
        let current_status = string_field(application, "currentStatusId", &path)?;
        if !status_ids.contains(&current_status) {
            return Err(validation_error(format!(
                "{path}.currentStatusId 引用了不存在的状态"
            )));
        }
        let current_stage_id = nullable_string_field(application, "currentStage", &path)?;
        if current_stage_id
            .as_ref()
            .is_some_and(|stage| !stage_ids.contains(stage))
        {
            return Err(validation_error(format!(
                "{path}.currentStage 引用了不存在的环节"
            )));
        }
        let phase = require_enum(
            field(application, "phase", &path)?,
            &format!("{path}.phase"),
            &[
                "unknown",
                "waiting",
                "in_progress",
                "awaiting_result",
                "passed",
            ],
        )?;
        let outcome = require_enum(
            field(application, "outcome", &path)?,
            &format!("{path}.outcome"),
            &[
                "active",
                "failed",
                "offer_received",
                "offer_accepted",
                "offer_declined",
                "withdrawn",
            ],
        )?;
        let failed_at = field(application, "failedAt", &path)?;
        if !failed_at.is_null() && !failed_at.is_string() && !failed_at.is_object() {
            return Err(validation_error(format!("{path}.failedAt 格式无效")));
        }
        if failed_at.is_string() && failed_at != "unknown" {
            return Err(validation_error(format!(
                "{path}.failedAt 字符串只能是 unknown"
            )));
        }
        if let Some(failed) = failed_at.as_object() {
            let failed_stage = string_field(failed, "stageId", &format!("{path}.failedAt"))?;
            if !stage_ids.contains(&failed_stage) {
                return Err(validation_error(format!(
                    "{path}.failedAt.stageId 引用了不存在的环节"
                )));
            }
            string_field(failed, "stageNameSnapshot", &format!("{path}.failedAt"))?;
        }
        let current_event = nullable_string_field(application, "currentEventId", &path)?;
        require_bool(
            field(application, "isStarred", &path)?,
            &format!("{path}.isStarred"),
        )?;
        text_field(application, "notes", &path)?;
        string_field(application, "createdAt", &path)?;
        string_field(application, "updatedAt", &path)?;
        application_current.push(ApplicationProjection {
            id,
            current_event_id: current_event,
            current_status_id: current_status,
            current_stage_id,
            phase,
            outcome,
            failed_at: failed_at.clone(),
            applied_on,
        });
    }

    let mut progress_application_ids = Vec::new();
    let mut global_event_ids = Vec::new();
    let mut events_by_application: Vec<ProgressProjection> = Vec::new();
    for (index, item) in array(
        field(root, "progressRecords", "data")?,
        "data.progressRecords",
    )?
    .iter()
    .enumerate()
    {
        let path = format!("progressRecords[{index}]");
        let record = object(item, &path)?;
        require_fields(
            record,
            &["applicationId", "appliedOn", "events", "annotations"],
            &path,
        )?;
        let app_id = string_field(record, "applicationId", &path)?;
        if !application_ids.contains(&app_id) || progress_application_ids.contains(&app_id) {
            return Err(validation_error(format!("{path}.applicationId 无效或重复")));
        }
        progress_application_ids.push(app_id.clone());
        let record_applied_on = nullable_string_field(record, "appliedOn", &path)?;
        let mut projected_events = Vec::new();
        for (event_index, event_value) in
            array(field(record, "events", &path)?, &format!("{path}.events"))?
                .iter()
                .enumerate()
        {
            let event_path = format!("{path}.events[{event_index}]");
            let event = object(event_value, &event_path)?;
            require_fields(
                event,
                &[
                    "id",
                    "applicationId",
                    "commandId",
                    "statusId",
                    "statusNameSnapshot",
                    "definitionVersion",
                    "semantics",
                    "phase",
                    "occurredOn",
                    "createdAt",
                    "sequence",
                    "previousEventId",
                    "visitId",
                    "source",
                    "visitAction",
                    "insertedBeforeEventId",
                    "reopenReason",
                    "reopensEventId",
                    "correctionOfEventId",
                    "failedAt",
                    "contextStageId",
                    "notes",
                    "invalidatedAt",
                ],
                &event_path,
            )?;
            let event_id = string_field(event, "id", &event_path)?;
            if global_event_ids.contains(&event_id) {
                return Err(validation_error(format!("{event_path}.id 重复")));
            }
            global_event_ids.push(event_id.clone());
            if string_field(event, "applicationId", &event_path)? != app_id {
                return Err(validation_error(format!(
                    "{event_path}.applicationId 与 progressRecord 不一致"
                )));
            }
            string_field(event, "commandId", &event_path)?;
            let status_id = string_field(event, "statusId", &event_path)?;
            if !status_ids.contains(&status_id) {
                return Err(validation_error(format!(
                    "{event_path}.statusId 引用了不存在的状态"
                )));
            }
            string_field(event, "statusNameSnapshot", &event_path)?;
            if require_integer(
                field(event, "definitionVersion", &event_path)?,
                &format!("{event_path}.definitionVersion"),
            )? < 1
            {
                return Err(validation_error(format!(
                    "{event_path}.definitionVersion 必须为正数"
                )));
            }
            let semantics = object(
                field(event, "semantics", &event_path)?,
                &format!("{event_path}.semantics"),
            )?;
            require_fields(
                semantics,
                &[
                    "semantic",
                    "stageId",
                    "stageCategory",
                    "stageNameSnapshot",
                    "countsAsInterview",
                    "statisticsCategory",
                    "terminalOutcome",
                ],
                &format!("{event_path}.semantics"),
            )?;
            let semantic = require_enum(
                field(semantics, "semantic", &format!("{event_path}.semantics"))?,
                &format!("{event_path}.semantics.semantic"),
                &[
                    "draft",
                    "submitted",
                    "screening",
                    "pool",
                    "stage",
                    "offer_received",
                    "offer_accepted",
                    "offer_declined",
                    "failed",
                    "withdrawn",
                    "custom",
                ],
            )?;
            let semantic_stage =
                nullable_string_field(semantics, "stageId", &format!("{event_path}.semantics"))?;
            if semantic_stage
                .as_ref()
                .is_some_and(|stage| !stage_ids.contains(stage))
            {
                return Err(validation_error(format!(
                    "{event_path}.semantics.stageId 引用了不存在的环节"
                )));
            }
            nullable_string_field(
                semantics,
                "stageCategory",
                &format!("{event_path}.semantics"),
            )?;
            nullable_string_field(
                semantics,
                "stageNameSnapshot",
                &format!("{event_path}.semantics"),
            )?;
            require_bool(
                field(
                    semantics,
                    "countsAsInterview",
                    &format!("{event_path}.semantics"),
                )?,
                &format!("{event_path}.semantics.countsAsInterview"),
            )?;
            nullable_string_field(
                semantics,
                "statisticsCategory",
                &format!("{event_path}.semantics"),
            )?;
            let terminal_outcome = require_enum(
                field(
                    semantics,
                    "terminalOutcome",
                    &format!("{event_path}.semantics"),
                )?,
                &format!("{event_path}.semantics.terminalOutcome"),
                &[
                    "active",
                    "offer_received",
                    "offer_accepted",
                    "offer_declined",
                    "failed",
                    "withdrawn",
                ],
            )?;
            let expected_outcome = match semantic.as_str() {
                "offer_received" => "offer_received",
                "offer_accepted" => "offer_accepted",
                "offer_declined" => "offer_declined",
                "failed" => "failed",
                "withdrawn" => "withdrawn",
                _ => "active",
            };
            if terminal_outcome != expected_outcome {
                return Err(validation_error(format!(
                    "{event_path}.semantics.terminalOutcome 与 semantic 不一致"
                )));
            }
            let phase = require_enum(
                field(event, "phase", &event_path)?,
                &format!("{event_path}.phase"),
                &[
                    "unknown",
                    "waiting",
                    "in_progress",
                    "awaiting_result",
                    "passed",
                ],
            )?;
            string_field(event, "occurredOn", &event_path)?;
            string_field(event, "createdAt", &event_path)?;
            let sequence = require_integer(
                field(event, "sequence", &event_path)?,
                &format!("{event_path}.sequence"),
            )?;
            if sequence < 1 {
                return Err(validation_error(format!(
                    "{event_path}.sequence 必须大于 0"
                )));
            }
            let previous_event_id = nullable_string_field(event, "previousEventId", &event_path)?;
            string_field(event, "visitId", &event_path)?;
            require_enum(
                field(event, "source", &event_path)?,
                &format!("{event_path}.source"),
                &[
                    "entered",
                    "continued",
                    "reopened",
                    "backfilled",
                    "migration",
                ],
            )?;
            require_enum(
                field(event, "visitAction", &event_path)?,
                &format!("{event_path}.visitAction"),
                &["new", "continue"],
            )?;
            nullable_string_field(event, "insertedBeforeEventId", &event_path)?;
            nullable_string_field(event, "reopenReason", &event_path)?;
            nullable_string_field(event, "reopensEventId", &event_path)?;
            nullable_string_field(event, "correctionOfEventId", &event_path)?;
            let failed_at = field(event, "failedAt", &event_path)?;
            if !failed_at.is_null() && failed_at != "unknown" && !failed_at.is_object() {
                return Err(validation_error(format!("{event_path}.failedAt 格式无效")));
            }
            if terminal_outcome == "failed" {
                if failed_at.is_null() {
                    return Err(validation_error(format!(
                        "{event_path}.failedAt 必须记录环节或 unknown"
                    )));
                }
            } else if !failed_at.is_null() {
                return Err(validation_error(format!(
                    "{event_path}.failedAt 只能用于挂掉事件"
                )));
            }
            if let Some(failed) = failed_at.as_object() {
                let failed_stage =
                    string_field(failed, "stageId", &format!("{event_path}.failedAt"))?;
                if !stage_ids.contains(&failed_stage) {
                    return Err(validation_error(format!(
                        "{event_path}.failedAt.stageId 引用了不存在的环节"
                    )));
                }
                string_field(
                    failed,
                    "stageNameSnapshot",
                    &format!("{event_path}.failedAt"),
                )?;
            }
            let context_stage = nullable_string_field(event, "contextStageId", &event_path)?;
            if context_stage
                .as_ref()
                .is_some_and(|stage| !stage_ids.contains(stage))
            {
                return Err(validation_error(format!(
                    "{event_path}.contextStageId 引用了不存在的环节"
                )));
            }
            text_field(event, "notes", &event_path)?;
            let active = nullable_string_field(event, "invalidatedAt", &event_path)?.is_none();
            projected_events.push(ProjectedEvent {
                id: event_id,
                status_id,
                stage_id: semantic_stage,
                context_stage_id: context_stage,
                phase,
                outcome: terminal_outcome,
                failed_at: failed_at.clone(),
                active,
                sequence,
                previous_event_id,
            });
        }
        let mut annotation_ids = Vec::new();
        for (annotation_index, annotation_value) in array(
            field(record, "annotations", &path)?,
            &format!("{path}.annotations"),
        )?
        .iter()
        .enumerate()
        {
            let annotation_path = format!("{path}.annotations[{annotation_index}]");
            let annotation = object(annotation_value, &annotation_path)?;
            require_fields(
                annotation,
                &[
                    "id",
                    "applicationId",
                    "commandId",
                    "stageId",
                    "kind",
                    "notes",
                    "createdAt",
                    "invalidatedAt",
                ],
                &annotation_path,
            )?;
            unique_id(annotation, &annotation_path, &mut annotation_ids)?;
            if string_field(annotation, "applicationId", &annotation_path)? != app_id {
                return Err(validation_error(format!(
                    "{annotation_path}.applicationId 与 progressRecord 不一致"
                )));
            }
            string_field(annotation, "commandId", &annotation_path)?;
            if !stage_ids.contains(&string_field(annotation, "stageId", &annotation_path)?) {
                return Err(validation_error(format!(
                    "{annotation_path}.stageId 引用了不存在的环节"
                )));
            }
            require_enum(
                field(annotation, "kind", &annotation_path)?,
                &format!("{annotation_path}.kind"),
                &["skipped"],
            )?;
            text_field(annotation, "notes", &annotation_path)?;
            string_field(annotation, "createdAt", &annotation_path)?;
            nullable_string_field(annotation, "invalidatedAt", &annotation_path)?;
        }
        events_by_application.push(ProgressProjection {
            application_id: app_id,
            applied_on: record_applied_on,
            events: projected_events,
        });
    }
    if progress_application_ids.len() != application_ids.len() {
        return Err(validation_error("每条投递必须有且仅有一个 progressRecord"));
    }
    for application in application_current {
        let record = events_by_application
            .iter()
            .find(|record| record.application_id == application.id)
            .ok_or_else(|| {
                validation_error(format!(
                    "application {} 缺少 progressRecord",
                    application.id
                ))
            })?;
        if record.applied_on != application.applied_on {
            return Err(validation_error(format!(
                "application {}.appliedOn 与 progressRecord 不一致",
                application.id
            )));
        }

        let mut active_events: Vec<&ProjectedEvent> =
            record.events.iter().filter(|event| event.active).collect();
        active_events.sort_by_key(|event| event.sequence);
        for (index, event) in active_events.iter().enumerate() {
            let expected_previous = index
                .checked_sub(1)
                .map(|previous_index| active_events[previous_index].id.as_str());
            if event.sequence != index as i64 + 1
                || event.previous_event_id.as_deref() != expected_previous
            {
                return Err(validation_error(format!(
                    "application {} 有效进度事件顺序或 previousEventId 不连续",
                    application.id
                )));
            }
        }

        match application.current_event_id {
            Some(current_event_id) => {
                let current = record
                    .events
                    .iter()
                    .find(|event| event.id == current_event_id)
                    .ok_or_else(|| {
                        validation_error(format!(
                            "application {}.currentEventId 引用不存在的事件",
                            application.id
                        ))
                    })?;
                if !current.active
                    || current.status_id != application.current_status_id
                    || current
                        .stage_id
                        .as_ref()
                        .or(current.context_stage_id.as_ref())
                        != application.current_stage_id.as_ref()
                    || current.phase != application.phase
                    || current.outcome != application.outcome
                    || current.failed_at != application.failed_at
                    || active_events.last().map(|event| event.id.as_str())
                        != Some(current.id.as_str())
                {
                    return Err(validation_error(format!(
                        "application {} 当前状态投影与 currentEventId 不一致",
                        application.id
                    )));
                }
            }
            None if !active_events.is_empty() => {
                return Err(validation_error(format!(
                    "application {} 有有效历史但缺少 currentEventId",
                    application.id
                )));
            }
            None => {
                let status = statuses
                    .iter()
                    .find(|status| {
                        status.get("id").and_then(Value::as_str)
                            == Some(application.current_status_id.as_str())
                    })
                    .ok_or_else(|| validation_error("无历史投递的 currentStatusId 不存在"))?;
                let status = object(status, "definitions.statuses")?;
                if status.get("semantic").and_then(Value::as_str) != Some("draft")
                    || application.current_stage_id.is_some()
                    || application.phase != "unknown"
                    || application.outcome != "active"
                    || !application.failed_at.is_null()
                {
                    return Err(validation_error(format!(
                        "application {} 无有效历史时必须为 draft/active/unknown/null",
                        application.id
                    )));
                }
            }
        }
    }

    for record in &events_by_application {
        let event_ids: Vec<&str> = record
            .events
            .iter()
            .map(|event| event.id.as_str())
            .collect();
        for event in &record.events {
            for (key, reference) in [
                ("previousEventId", event.previous_event_id.as_deref()),
                ("insertedBeforeEventId", None),
                ("reopensEventId", None),
                ("correctionOfEventId", None),
            ] {
                if let Some(reference) = reference {
                    if !event_ids.contains(&reference) {
                        return Err(validation_error(format!(
                            "progressRecords.{}.events.{}.{} 引用了其他投递或不存在的事件",
                            record.application_id, event.id, key
                        )));
                    }
                }
            }
        }
        let source_record = array(
            field(root, "progressRecords", "data")?,
            "data.progressRecords",
        )?
        .iter()
        .find(|item| {
            item.get("applicationId").and_then(Value::as_str)
                == Some(record.application_id.as_str())
        })
        .ok_or_else(|| validation_error("progressRecord 丢失"))?;
        let source_record = object(source_record, "progressRecord")?;
        for (event_index, event_value) in array(
            field(source_record, "events", "progressRecord")?,
            "progressRecord.events",
        )?
        .iter()
        .enumerate()
        {
            let event = object(event_value, "progressRecord.event")?;
            for key in [
                "insertedBeforeEventId",
                "reopensEventId",
                "correctionOfEventId",
            ] {
                if let Some(reference) = event.get(key).and_then(Value::as_str) {
                    if !event_ids.contains(&reference) {
                        return Err(validation_error(format!(
                            "progressRecord.events[{event_index}].{key} 引用了其他投递或不存在的事件"
                        )));
                    }
                }
            }
        }
    }

    let mut schedule_ids = Vec::new();
    for (index, schedule_value) in array(field(root, "schedules", "data")?, "data.schedules")?
        .iter()
        .enumerate()
    {
        let path = format!("schedules[{index}]");
        let schedule = object(schedule_value, &path)?;
        require_fields(
            schedule,
            &[
                "id",
                "applicationId",
                "type",
                "title",
                "startsAt",
                "status",
                "notes",
            ],
            &path,
        )?;
        unique_id(schedule, &path, &mut schedule_ids)?;
        if !application_ids.contains(&string_field(schedule, "applicationId", &path)?) {
            return Err(validation_error(format!(
                "{path}.applicationId 引用了不存在的投递"
            )));
        }
        require_enum(
            field(schedule, "type", &path)?,
            &format!("{path}.type"),
            &["assessment", "interview", "follow_up", "other"],
        )?;
        string_field(schedule, "title", &path)?;
        string_field(schedule, "startsAt", &path)?;
        require_enum(
            field(schedule, "status", &path)?,
            &format!("{path}.status"),
            &["pending", "completed", "cancelled"],
        )?;
        text_field(schedule, "notes", &path)?;
    }

    array(field(root, "legacyHistory", "data")?, "data.legacyHistory")?;
    match field(root, "migration", "data")? {
        Value::Null => {}
        migration_value => {
            let migration = object(migration_value, "migration")?;
            require_fields(
                migration,
                &["sourceSchemaVersion", "migratedAt", "warnings"],
                "migration",
            )?;
            if require_integer(
                field(migration, "sourceSchemaVersion", "migration")?,
                "migration.sourceSchemaVersion",
            )? != V1_SNAPSHOT_VERSION
            {
                return Err(validation_error("migration.sourceSchemaVersion 必须为 1"));
            }
            string_field(migration, "migratedAt", "migration")?;
            for warning in array(
                field(migration, "warnings", "migration")?,
                "migration.warnings",
            )? {
                string_at(warning, "migration.warnings[]")?;
            }
        }
    }
    Ok(())
}

fn empty_v1_snapshot() -> Value {
    json!({
        "workspace": {"id":"local","name":"秋招工作空间","timeZone":"Asia/Shanghai","activeSeasonId":null},
        "seasons": [],
        "channels": [
            {"id":"official","name":"官网","archivedAt":null},
            {"id":"referral","name":"内推","archivedAt":null},
            {"id":"platform","name":"招聘平台","archivedAt":null},
            {"id":"campus","name":"校园宣讲","archivedAt":null},
            {"id":"other","name":"其他","archivedAt":null},
            {"id":"unspecified","name":"未填写","archivedAt":null}
        ],
        "settings":{"schemaVersion":1,"lastBackupAt":null,"preferences":{}},
        "applications":[],"stageEvents":[],"outcomeEvents":[],"schedules":[]
    })
}

fn migrate(connection: &mut Connection) -> Result<(), String> {
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| e.to_string())?;
    let current_physical: i64 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|e| e.to_string())?;
    if current_physical > PHYSICAL_SCHEMA_VERSION {
        return Err(format!(
            "BACKUP_INCOMPATIBLE:SQLite 物理 schema {current_physical} 高于当前支持版本 {PHYSICAL_SCHEMA_VERSION}"
        ));
    }
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    transaction
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS workspace(id TEXT PRIMARY KEY,name TEXT NOT NULL,time_zone TEXT NOT NULL,active_season_id TEXT);
             CREATE TABLE IF NOT EXISTS seasons(id TEXT PRIMARY KEY,name TEXT NOT NULL,start_date TEXT NOT NULL,end_date TEXT NOT NULL,target_count INTEGER NOT NULL,archived_at TEXT);
             CREATE TABLE IF NOT EXISTS channels(id TEXT PRIMARY KEY,name TEXT NOT NULL,archived_at TEXT);
             CREATE TABLE IF NOT EXISTS applications(id TEXT PRIMARY KEY,season_id TEXT NOT NULL REFERENCES seasons(id),company TEXT NOT NULL,role TEXT NOT NULL,city TEXT NOT NULL,channel_id TEXT NOT NULL REFERENCES channels(id),job_url TEXT NOT NULL,applied_on TEXT,current_stage TEXT NOT NULL,outcome TEXT NOT NULL,is_starred INTEGER NOT NULL,notes TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS stage_events(id TEXT PRIMARY KEY,application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,stage TEXT NOT NULL,occurred_on TEXT NOT NULL,created_at TEXT NOT NULL,superseded_at TEXT,source TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS outcome_events(id TEXT PRIMARY KEY,application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,outcome TEXT NOT NULL,occurred_on TEXT NOT NULL,created_at TEXT NOT NULL,superseded_at TEXT);
             CREATE TABLE IF NOT EXISTS schedules(id TEXT PRIMARY KEY,application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,type TEXT NOT NULL,title TEXT NOT NULL,starts_at TEXT NOT NULL,status TEXT NOT NULL,notes TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1),schema_version INTEGER NOT NULL,last_backup_at TEXT,preferences TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS snapshot_recovery(id INTEGER PRIMARY KEY CHECK(id=1),source_schema_version INTEGER NOT NULL,source_revision INTEGER NOT NULL,snapshot TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS snapshot_restore_recovery(source_revision INTEGER PRIMARY KEY,source_schema_version INTEGER NOT NULL,snapshot TEXT NOT NULL);
             INSERT OR IGNORE INTO meta(key,value) VALUES('revision','0');",
        )
        .map_err(|e| e.to_string())?;
    transaction
        .execute(
            "INSERT OR IGNORE INTO meta(key,value) VALUES('snapshot',?1)",
            params![serde_json::to_string(&empty_v1_snapshot()).map_err(|e| e.to_string())?],
        )
        .map_err(|e| e.to_string())?;
    let legacy_schema: Option<String> = transaction
        .query_row(
            "SELECT value FROM meta WHERE key='schema_version'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    transaction
        .execute(
            "INSERT OR IGNORE INTO meta(key,value) VALUES('logical_schema_version',?1)",
            params![legacy_schema.unwrap_or_else(|| "1".into())],
        )
        .map_err(|e| e.to_string())?;
    // The former key described the logical payload. Keep one authoritative
    // logical version and use PRAGMA user_version for physical schema only.
    transaction
        .execute("DELETE FROM meta WHERE key='schema_version'", [])
        .map_err(|e| e.to_string())?;
    transaction
        .pragma_update(None, "user_version", PHYSICAL_SCHEMA_VERSION)
        .map_err(|e| e.to_string())?;
    transaction.commit().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn v1_snapshot() -> Value {
        json!({
            "workspace":{"id":"w","name":"秋招","timeZone":"Asia/Shanghai","activeSeasonId":"s"},
            "seasons":[{"id":"s","name":"2026 秋招","startDate":"2026-07-01","endDate":"2026-12-31","targetCount":50,"archivedAt":null}],
            "channels":[{"id":"c","name":"官网","archivedAt":null}],
            "settings":{"schemaVersion":1,"lastBackupAt":null,"preferences":{}},
            "applications":[],"stageEvents":[],"outcomeEvents":[],"schedules":[]
        })
    }

    fn v2_snapshot() -> Value {
        json!({
            "schemaVersion":2,
            "workspace":{"id":"w","name":"秋招","timeZone":"Asia/Shanghai","activeSeasonId":"s"},
            "seasons":[{"id":"s","name":"2026 秋招","startDate":"2026-07-01","endDate":"2026-12-31","targetCount":50,"archivedAt":null}],
            "channels":[{"id":"c","name":"官网","archivedAt":null}],
            "settings":{"schemaVersion":2,"lastBackupAt":null,"preferences":{}},
            "applications":[{"id":"a","seasonId":"s","company":"示例公司","role":"工程师","city":"上海","channelId":"c","jobUrl":"https://example.com/job","trackingUrl":"","appliedOn":null,"currentStatusId":"draft","currentStage":null,"phase":"unknown","outcome":"active","failedAt":null,"currentEventId":null,"isStarred":false,"notes":"","createdAt":"2026-09-17T00:00:00.000Z","updatedAt":"2026-09-17T00:00:00.000Z"}],
            "schedules":[],
            "definitions":{"stages":[],"statuses":[{"id":"draft","name":"待投递","color":"#9b8f83","sortOrder":0,"version":1,"archivedAt":null,"semantic":"draft","stageId":null,"defaultPhase":"unknown","statisticsCategory":null,"semanticsHistory":[{"version":1,"semantic":"draft","stageId":null,"stageCategory":null,"defaultPhase":"unknown","statisticsCategory":null,"countsAsInterview":false}]}]},
            "progressRecords":[{"applicationId":"a","appliedOn":null,"events":[],"annotations":[]}],
            "legacyHistory":[],"migration":{"sourceSchemaVersion":1,"migratedAt":"2026-09-17T00:00:00.000Z","warnings":[]}
        })
    }

    #[test]
    fn first_v2_commit_preserves_revisioned_v1_copy_and_upgrades_atomically() {
        let directory = tempdir().unwrap();
        let storage = SqliteStorage::open(directory.path().join("data.sqlite")).unwrap();
        let old = v1_snapshot();
        assert_eq!(storage.commit_snapshot(0, old.clone()).unwrap(), 1);
        let next = v2_snapshot();
        assert_eq!(storage.commit_snapshot_v2(1, next.clone()).unwrap(), 2);

        let (revision, persisted) = storage.read_snapshot_v2().unwrap();
        assert_eq!(revision, 2);
        assert_eq!(persisted, next);
        let (source_schema, source_revision, backup) =
            storage.read_pre_v2_backup().unwrap().unwrap();
        assert_eq!(source_schema, 1);
        assert_eq!(source_revision, 1);
        assert_eq!(backup, old);
        let connection = storage.conn().unwrap();
        let physical: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(physical, PHYSICAL_SCHEMA_VERSION);
        let logical: String = connection
            .query_row(
                "SELECT value FROM meta WHERE key='logical_schema_version'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(logical, "2");
        let stale_logical_key: Option<String> = connection
            .query_row(
                "SELECT value FROM meta WHERE key='schema_version'",
                [],
                |row| row.get(0),
            )
            .optional()
            .unwrap();
        assert!(stale_logical_key.is_none());
    }

    #[test]
    fn v2_cas_conflict_does_not_replace_snapshot_or_recovery_copy() {
        let directory = tempdir().unwrap();
        let storage = SqliteStorage::open(directory.path().join("data.sqlite")).unwrap();
        let old = v1_snapshot();
        storage.commit_snapshot(0, old.clone()).unwrap();
        let error = storage.commit_snapshot_v2(0, v2_snapshot()).unwrap_err();
        assert!(error.starts_with("CONFLICT:"));
        let (revision, snapshot) = storage.read_snapshot().unwrap();
        assert_eq!(revision, 1);
        assert_eq!(snapshot, old);
        assert!(storage.read_pre_v2_backup().unwrap().is_none());
    }

    #[test]
    fn invalid_v2_rolls_back_snapshot_revision_and_backup() {
        let directory = tempdir().unwrap();
        let storage = SqliteStorage::open(directory.path().join("data.sqlite")).unwrap();
        let old = v1_snapshot();
        storage.commit_snapshot(0, old.clone()).unwrap();
        let mut invalid = v2_snapshot();
        invalid["applications"][0]["seasonId"] = json!("missing-season");
        let error = storage.commit_snapshot_v2(1, invalid).unwrap_err();
        assert!(error.starts_with("VALIDATION:"));
        let (revision, snapshot) = storage.read_snapshot().unwrap();
        assert_eq!(revision, 1);
        assert_eq!(snapshot, old);
        assert!(storage.read_pre_v2_backup().unwrap().is_none());
    }

    #[test]
    fn v2_restore_keeps_recovery_copy_and_rolls_back_invalid_or_conflicting_replacements() {
        let directory = tempdir().unwrap();
        let storage = SqliteStorage::open(directory.path().join("data.sqlite")).unwrap();
        storage.commit_snapshot(0, v1_snapshot()).unwrap();
        storage.commit_snapshot_v2(1, v2_snapshot()).unwrap();
        let displaced = storage.read_snapshot_v2().unwrap().1;

        let mut replacement = v2_snapshot();
        replacement["workspace"]["name"] = json!("从备份恢复");
        assert_eq!(
            storage.restore_snapshot_v2(2, replacement.clone()).unwrap(),
            3
        );
        let (revision, persisted) = storage.read_snapshot_v2().unwrap();
        assert_eq!(revision, 3);
        assert_eq!(persisted, replacement);

        let connection = storage.conn().unwrap();
        let (source_schema, source_revision, recovery): (i64, i64, String) = connection
            .query_row(
                "SELECT source_schema_version,source_revision,snapshot FROM snapshot_restore_recovery WHERE source_revision=2",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(source_schema, 2);
        assert_eq!(source_revision, 2);
        assert_eq!(serde_json::from_str::<Value>(&recovery).unwrap(), displaced);

        let mut invalid = v2_snapshot();
        invalid["applications"][0]["seasonId"] = json!("missing-season");
        assert!(storage
            .restore_snapshot_v2(3, invalid)
            .unwrap_err()
            .starts_with("VALIDATION:"));
        assert!(storage
            .restore_snapshot_v2(2, v2_snapshot())
            .unwrap_err()
            .starts_with("CONFLICT:"));
        assert_eq!(
            storage.read_snapshot_v2().unwrap(),
            (3, replacement.clone())
        );
        let recovery_count: i64 = storage
            .conn()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM snapshot_restore_recovery",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(recovery_count, 1);

        let error = storage.commit_snapshot(3, v1_snapshot()).unwrap_err();
        assert!(error.starts_with("BACKUP_INCOMPATIBLE:"));
        assert_eq!(storage.read_snapshot_v2().unwrap(), (3, replacement));
    }

    #[test]
    fn recovery_copy_listing_and_selected_restore_are_atomic_and_keep_both_copies() {
        let directory = tempdir().unwrap();
        let storage = SqliteStorage::open(directory.path().join("data.sqlite")).unwrap();
        let legacy = v1_snapshot();
        storage.commit_snapshot(0, legacy.clone()).unwrap();
        let migrated = v2_snapshot();
        storage.commit_snapshot_v2(1, migrated.clone()).unwrap();

        let listed = storage.read_recovery_snapshots_v2().unwrap();
        assert_eq!(listed.as_array().unwrap().len(), 1);
        assert_eq!(listed[0]["id"], json!("v1-1"));
        assert_eq!(listed[0]["data"], legacy);

        let selected = json!({ "recovered": "v1 copy" });
        let error = storage
            .restore_recovery_snapshot_v2(2, "v1-1", selected.clone(), legacy.clone())
            .unwrap_err();
        assert!(error.starts_with("VALIDATION:"));
        assert_eq!(storage.read_snapshot_v2().unwrap(), (2, migrated.clone()));
        assert_eq!(
            storage
                .read_recovery_snapshots_v2()
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            1
        );

        assert_eq!(
            storage
                .restore_recovery_snapshot_v2(2, "v1-1", migrated.clone(), legacy.clone())
                .unwrap(),
            3
        );
        assert_eq!(storage.read_snapshot_v2().unwrap(), (3, migrated.clone()));
        let listed = storage.read_recovery_snapshots_v2().unwrap();
        assert_eq!(listed.as_array().unwrap().len(), 2);
        assert!(listed
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["id"] == json!("v1-1")));
        assert!(listed
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["id"] == json!("restore-v2-2")));

        let mut selected_v2 = migrated.clone();
        selected_v2["workspace"]["name"] = json!("旧恢复副本");
        assert_eq!(
            storage.restore_snapshot_v2(3, selected_v2.clone()).unwrap(),
            4
        );
        assert_eq!(
            storage
                .restore_recovery_snapshot_v2(4, "restore-v2-2", migrated.clone(), migrated.clone())
                .unwrap(),
            5
        );
        assert_eq!(storage.read_snapshot_v2().unwrap(), (5, migrated));
        let before = storage.read_snapshot_v2().unwrap();
        let count_before = storage
            .read_recovery_snapshots_v2()
            .unwrap()
            .as_array()
            .unwrap()
            .len();
        assert!(storage
            .restore_recovery_snapshot_v2(4, "restore-v2-2", before.1.clone(), before.1.clone())
            .unwrap_err()
            .starts_with("CONFLICT:"));
        assert_eq!(storage.read_snapshot_v2().unwrap(), before);
        assert_eq!(
            storage
                .read_recovery_snapshots_v2()
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            count_before
        );
    }

    #[test]
    fn deleting_recovery_copy_is_single_id_revision_cas_and_keeps_snapshot_and_other_copies() {
        let directory = tempdir().unwrap();
        let storage = SqliteStorage::open(directory.path().join("data.sqlite")).unwrap();
        storage.commit_snapshot(0, v1_snapshot()).unwrap();
        let migrated = v2_snapshot();
        storage.commit_snapshot_v2(1, migrated.clone()).unwrap();
        let mut replacement = migrated.clone();
        replacement["workspace"]["name"] = json!("恢复后");
        assert_eq!(
            storage.restore_snapshot_v2(2, replacement.clone()).unwrap(),
            3
        );
        let before = storage.read_snapshot_v2().unwrap();
        assert_eq!(
            storage
                .read_recovery_snapshots_v2()
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            2
        );

        assert!(storage
            .delete_recovery_snapshot_v2(2, "v1-1")
            .unwrap_err()
            .starts_with("CONFLICT:"));
        assert_eq!(
            storage
                .read_recovery_snapshots_v2()
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert!(storage
            .delete_recovery_snapshot_v2(3, "restore-v2-999")
            .unwrap_err()
            .starts_with("NOT_FOUND:"));
        assert_eq!(storage.read_snapshot_v2().unwrap(), before);
        assert_eq!(
            storage
                .read_recovery_snapshots_v2()
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            2
        );

        assert_eq!(storage.delete_recovery_snapshot_v2(3, "v1-1").unwrap(), 4);
        assert_eq!(
            storage.read_snapshot_v2().unwrap(),
            (4, replacement.clone())
        );
        let remaining = storage.read_recovery_snapshots_v2().unwrap();
        assert_eq!(remaining.as_array().unwrap().len(), 1);
        assert_eq!(remaining[0]["id"], json!("restore-v2-2"));
        assert!(storage
            .delete_recovery_snapshot_v2(3, "restore-v2-2")
            .unwrap_err()
            .starts_with("CONFLICT:"));
        assert_eq!(storage.read_recovery_snapshots_v2().unwrap(), remaining);
        assert_eq!(
            storage
                .delete_recovery_snapshot_v2(4, "restore-v2-2")
                .unwrap(),
            5
        );
        assert!(storage
            .read_recovery_snapshots_v2()
            .unwrap()
            .as_array()
            .unwrap()
            .is_empty());
        assert_eq!(
            storage.read_snapshot_v2().unwrap(),
            (5, replacement.clone())
        );
        assert!(storage
            .delete_recovery_snapshot_v2(5, "v1-01")
            .unwrap_err()
            .starts_with("NOT_FOUND:"));
        assert_eq!(storage.read_snapshot_v2().unwrap(), (5, replacement));
    }

    #[test]
    fn v2_restore_requires_migration_and_does_not_change_a_v1_snapshot() {
        let directory = tempdir().unwrap();
        let storage = SqliteStorage::open(directory.path().join("data.sqlite")).unwrap();
        let legacy = v1_snapshot();
        storage.commit_snapshot(0, legacy.clone()).unwrap();
        let error = storage.restore_snapshot_v2(1, v2_snapshot()).unwrap_err();
        assert!(error.starts_with("BACKUP_INCOMPATIBLE:"));
        assert_eq!(storage.read_snapshot().unwrap(), (1, legacy));
        let recovery_count: i64 = storage
            .conn()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM snapshot_restore_recovery",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(recovery_count, 0);
    }

    #[test]
    fn v2_snapshot_survives_reopen_and_legacy_writer_is_refused() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("data.sqlite");
        let old = v1_snapshot();
        let next = v2_snapshot();
        {
            let storage = SqliteStorage::open(&path).unwrap();
            storage.commit_snapshot(0, old.clone()).unwrap();
            storage.commit_snapshot_v2(1, next.clone()).unwrap();
        }
        let reopened = SqliteStorage::open(&path).unwrap();
        let (revision, persisted) = reopened.read_snapshot().unwrap();
        assert_eq!(revision, 2);
        assert_eq!(persisted, next);
        let error = reopened.commit_snapshot(2, old).unwrap_err();
        assert!(error.starts_with("BACKUP_INCOMPATIBLE:"));
        assert_eq!(reopened.read_snapshot().unwrap().0, 2);
    }

    #[test]
    fn strict_v2_validation_checks_schema_required_fields_and_references() {
        let mut wrong_version = v2_snapshot();
        wrong_version["schemaVersion"] = json!(1);
        assert!(validate_v2_snapshot(&wrong_version)
            .unwrap_err()
            .starts_with("VALIDATION:"));

        let mut missing = v2_snapshot();
        missing.as_object_mut().unwrap().remove("legacyHistory");
        assert!(validate_v2_snapshot(&missing)
            .unwrap_err()
            .contains("legacyHistory"));

        let mut bad_ref = v2_snapshot();
        bad_ref["applications"][0]["currentStatusId"] = json!("not-defined");
        assert!(validate_v2_snapshot(&bad_ref)
            .unwrap_err()
            .contains("currentStatusId"));

        let mut bad_empty_projection = v2_snapshot();
        bad_empty_projection["applications"][0]["outcome"] = json!("failed");
        assert!(validate_v2_snapshot(&bad_empty_projection)
            .unwrap_err()
            .contains("无有效历史"));

        let mut bad_empty_failure = v2_snapshot();
        bad_empty_failure["applications"][0]["failedAt"] = json!("unknown");
        assert!(validate_v2_snapshot(&bad_empty_failure)
            .unwrap_err()
            .contains("无有效历史"));
    }

    #[test]
    fn current_event_must_be_the_active_chain_tail() {
        let mut snapshot = v2_snapshot();
        let make_event = |id: &str, sequence: i64, previous_event_id: Value| {
            json!({
                "id":id,"applicationId":"a","commandId":id,"statusId":"draft","statusNameSnapshot":"待投递","definitionVersion":1,
                "semantics":{"semantic":"draft","stageId":null,"stageCategory":null,"stageNameSnapshot":null,"countsAsInterview":false,"statisticsCategory":null,"terminalOutcome":"active"},
                "phase":"unknown","occurredOn":"2026-09-17","createdAt":"2026-09-17T00:00:00.000Z","sequence":sequence,"previousEventId":previous_event_id,
                "visitId":format!("visit-{id}"),"source":"migration","visitAction":"new","insertedBeforeEventId":null,"reopenReason":null,"reopensEventId":null,
                "correctionOfEventId":null,"failedAt":null,"contextStageId":null,"notes":"","invalidatedAt":null
            })
        };
        snapshot["applications"][0]["currentEventId"] = json!("event-1");
        snapshot["progressRecords"][0]["events"] = json!([
            make_event("event-1", 1, Value::Null),
            make_event("event-2", 2, json!("event-1"))
        ]);
        assert!(validate_v2_snapshot(&snapshot)
            .unwrap_err()
            .contains("当前状态投影"));
    }

    #[test]
    fn current_stage_prefers_event_semantics_over_its_context_stage() {
        let mut snapshot = v2_snapshot();
        snapshot["definitions"]["stages"] = json!([
            {"id":"interview_1","name":"一面","category":"interview","sortOrder":10,"archivedAt":null,"countsAsInterview":true,"interviewRound":1},
            {"id":"interview_2","name":"二面","category":"interview","sortOrder":20,"archivedAt":null,"countsAsInterview":true,"interviewRound":2}
        ]);
        snapshot["definitions"]["statuses"] = json!([
            {"id":"draft","name":"待投递","color":"#9b8f83","sortOrder":0,"version":1,"archivedAt":null,"semantic":"draft","stageId":null,"defaultPhase":"unknown","statisticsCategory":null,"semanticsHistory":[{"version":1,"semantic":"draft","stageId":null,"stageCategory":null,"defaultPhase":"unknown","statisticsCategory":null,"countsAsInterview":false}]},
            {"id":"interview_2_active","name":"二面中","color":"#b87962","sortOrder":21,"version":1,"archivedAt":null,"semantic":"stage","stageId":"interview_2","defaultPhase":"in_progress","statisticsCategory":"interview_2","semanticsHistory":[{"version":1,"semantic":"stage","stageId":"interview_2","stageCategory":"interview","defaultPhase":"in_progress","statisticsCategory":"interview_2","countsAsInterview":true}]}
        ]);
        snapshot["applications"][0]["currentStatusId"] = json!("interview_2_active");
        snapshot["applications"][0]["currentStage"] = json!("interview_1");
        snapshot["applications"][0]["phase"] = json!("in_progress");
        snapshot["applications"][0]["currentEventId"] = json!("event-interview-2");
        snapshot["progressRecords"][0]["events"] = json!([{
            "id":"event-interview-2","applicationId":"a","commandId":"migration-event-interview-2","statusId":"interview_2_active","statusNameSnapshot":"二面中","definitionVersion":1,
            "semantics":{"semantic":"stage","stageId":"interview_2","stageCategory":"interview","stageNameSnapshot":"二面","countsAsInterview":true,"statisticsCategory":"interview_2","terminalOutcome":"active"},
            "phase":"in_progress","occurredOn":"2026-09-17","createdAt":"2026-09-17T00:00:00.000Z","sequence":1,"previousEventId":null,
            "visitId":"visit-interview-2","source":"migration","visitAction":"new","insertedBeforeEventId":null,"reopenReason":null,"reopensEventId":null,
            "correctionOfEventId":null,"failedAt":null,"contextStageId":"interview_1","notes":"","invalidatedAt":null
        }]);

        let error = validate_v2_snapshot(&snapshot).unwrap_err();
        assert!(error.contains("当前状态投影"));

        snapshot["applications"][0]["currentStage"] = json!("interview_2");
        assert!(validate_v2_snapshot(&snapshot).is_ok());
    }

    #[test]
    fn damaged_persisted_snapshot_is_reported_and_never_reset_to_empty() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("data.sqlite");
        let storage = SqliteStorage::open(&path).unwrap();
        let bad = "{broken";
        storage
            .conn()
            .unwrap()
            .execute(
                "UPDATE meta SET value=?1 WHERE key='snapshot'",
                params![bad],
            )
            .unwrap();
        let error = SqliteStorage::open(&path)
            .unwrap()
            .read_snapshot()
            .unwrap_err();
        assert!(error.starts_with("BACKUP_INCOMPATIBLE:"));
        let persisted: String = storage
            .conn()
            .unwrap()
            .query_row("SELECT value FROM meta WHERE key='snapshot'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(persisted, bad);
    }
}
