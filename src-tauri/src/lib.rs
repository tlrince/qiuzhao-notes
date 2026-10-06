mod sqlite;
mod validation;

use std::{
    fs,
    sync::atomic::{AtomicBool, Ordering},
};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    webview::NewWindowResponse,
    Emitter, Manager,
};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::UpdaterExt;

#[derive(Default)]
struct Lifecycle {
    quitting: AtomicBool,
}

#[tauri::command]
async fn read_backup_file(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let Some(file) = app
        .dialog()
        .file()
        .add_filter("JSON 备份", &["json"])
        .blocking_pick_file()
    else {
        return Ok(None);
    };
    let path = file.into_path().map_err(|_| "仅支持本地文件")?;
    validation::read_backup(&path).map(Some)
}

#[tauri::command]
async fn save_backup_file(
    app: tauri::AppHandle,
    name: String,
    json: String,
) -> Result<String, String> {
    validation::validate_json(&json)?;
    if name.is_empty()
        || name.chars().count() > 180
        || name
            .chars()
            .any(|c| c.is_control() || matches!(c, '/' | '\\' | ':'))
    {
        return Err("无效的备份文件名".into());
    }
    validation::validate_json_path(std::path::Path::new(&name))?;
    let Some(file) = app
        .dialog()
        .file()
        .add_filter("JSON 备份", &["json"])
        .set_file_name(name)
        .blocking_save_file()
    else {
        return Ok("cancelled".into());
    };
    let path = file.into_path().map_err(|_| "仅支持本地文件")?;
    validation::validate_json_path(&path)?;
    validation::atomic_write(&path, json.as_bytes())?;
    Ok("saved".into())
}

#[tauri::command]
fn open_external(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let url = validation::validate_external(&url)?;
    app.opener()
        .open_url(url.as_str(), None::<&str>)
        .map_err(|_| "无法打开系统浏览器".into())
}

#[tauri::command]
fn get_app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

#[derive(serde::Serialize)]
struct AvailableUpdate {
    version: String,
    notes: Option<String>,
}

/// Asks the release feed whether a newer signed build exists.
#[tauri::command]
async fn check_for_update(app: tauri::AppHandle) -> Result<Option<AvailableUpdate>, String> {
    let update = app
        .updater()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| format!("检查更新失败：{error}"))?;
    Ok(update.map(|update| AvailableUpdate {
        version: update.version,
        notes: update.body,
    }))
}

/// Downloads, verifies and installs the newer build, then restarts into it.
/// The data directory lives outside the app bundle, so it is untouched.
#[tauri::command]
async fn install_update(app: tauri::AppHandle) -> Result<(), String> {
    let update = app
        .updater()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| format!("检查更新失败：{error}"))?
        .ok_or_else(|| "已经是最新版本".to_string())?;
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|error| format!("更新安装失败：{error}"))?;
    app.state::<Lifecycle>().quitting.store(true, Ordering::SeqCst);
    app.restart();
}

#[tauri::command]
fn load_last_route(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|_| "无法定位应用配置")?
        .join("last-route.json");
    if !path.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(path).map_err(|_| "无法读取页面配置")?;
    let route: String = serde_json::from_str(&text).map_err(|_| "页面配置损坏")?;
    Ok(validation::valid_route(&route).then_some(route))
}

#[tauri::command]
fn save_last_route(app: tauri::AppHandle, route: String) -> Result<(), String> {
    if !validation::valid_route(&route) {
        return Err("不支持的内部页面".into());
    }
    let directory = app.path().app_data_dir().map_err(|_| "无法定位应用配置")?;
    fs::create_dir_all(&directory).map_err(|_| "无法创建应用配置目录")?;
    validation::atomic_write(
        &directory.join("last-route.json"),
        serde_json::to_string(&route).unwrap().as_bytes(),
    )
}

#[tauri::command]
fn read_snapshot(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "无法定位应用数据目录")?;
    let (revision, data) =
        sqlite::SqliteStorage::open(dir.join("autumn-notes.sqlite"))?.read_snapshot()?;
    Ok(serde_json::json!({"revision": revision, "data": data}))
}
#[tauri::command]
fn read_snapshot_v2(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "无法定位应用数据目录")?;
    let (revision, data) =
        sqlite::SqliteStorage::open(dir.join("autumn-notes.sqlite"))?.read_snapshot_v2()?;
    Ok(serde_json::json!({"revision": revision, "data": data}))
}
#[tauri::command]
fn commit_snapshot(
    app: tauri::AppHandle,
    expected_revision: i64,
    data: serde_json::Value,
) -> Result<i64, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "无法定位应用数据目录")?;
    sqlite::SqliteStorage::open(dir.join("autumn-notes.sqlite"))?
        .commit_snapshot(expected_revision, data)
}
#[tauri::command]
fn commit_snapshot_v2(
    app: tauri::AppHandle,
    expected_revision: i64,
    data: serde_json::Value,
) -> Result<i64, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "无法定位应用数据目录")?;
    sqlite::SqliteStorage::open(dir.join("autumn-notes.sqlite"))?
        .commit_snapshot_v2(expected_revision, data)
}

#[tauri::command]
fn restore_snapshot_v2(
    app: tauri::AppHandle,
    expected_revision: i64,
    data: serde_json::Value,
) -> Result<i64, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "无法定位应用数据目录")?;
    sqlite::SqliteStorage::open(dir.join("autumn-notes.sqlite"))?
        .restore_snapshot_v2(expected_revision, data)
}

#[tauri::command]
fn read_recovery_snapshots_v2(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "无法定位应用数据目录")?;
    sqlite::SqliteStorage::open(dir.join("autumn-notes.sqlite"))?.read_recovery_snapshots_v2()
}

#[tauri::command]
fn restore_recovery_snapshot_v2(
    app: tauri::AppHandle,
    expected_revision: i64,
    recovery_id: String,
    data: serde_json::Value,
    source_data: serde_json::Value,
) -> Result<i64, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "无法定位应用数据目录")?;
    sqlite::SqliteStorage::open(dir.join("autumn-notes.sqlite"))?.restore_recovery_snapshot_v2(
        expected_revision,
        &recovery_id,
        data,
        source_data,
    )
}

#[tauri::command]
fn delete_recovery_snapshot_v2(
    app: tauri::AppHandle,
    expected_revision: i64,
    recovery_id: String,
) -> Result<i64, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "无法定位应用数据目录")?;
    sqlite::SqliteStorage::open(dir.join("autumn-notes.sqlite"))?
        .delete_recovery_snapshot_v2(expected_revision, &recovery_id)
}

#[tauri::command]
fn finish_window_action(app: tauri::AppHandle, action: String) -> Result<(), String> {
    match action.as_str() {
        "close" => app
            .get_webview_window("main")
            .ok_or("窗口不存在")?
            .hide()
            .map_err(|_| "无法隐藏窗口".into()),
        "quit" => {
            app.state::<Lifecycle>()
                .quitting
                .store(true, Ordering::SeqCst);
            app.exit(0);
            Ok(())
        }
        _ => Err("不支持的窗口操作".into()),
    }
}

fn request_action(app: &tauri::AppHandle, action: &str) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.emit("window-action-requested", action);
    }
}

fn app_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let settings = MenuItem::with_id(app, "settings", "设置…", true, Some("CmdOrCtrl+,"))?;
    let quit = MenuItem::with_id(app, "quit", "退出秋招手记", true, Some("CmdOrCtrl+Q"))?;
    let app_items = Submenu::with_items(
        app,
        "秋招手记",
        true,
        &[
            &PredefinedMenuItem::about(app, Some("关于秋招手记"), None)?,
            &PredefinedMenuItem::separator(app)?,
            &settings,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, Some("隐藏秋招手记"))?,
            &PredefinedMenuItem::hide_others(app, Some("隐藏其他"))?,
            &PredefinedMenuItem::show_all(app, Some("全部显示"))?,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    let file = Submenu::with_items(
        app,
        "文件",
        true,
        &[
            &MenuItem::with_id(app, "new", "新增投递", true, Some("CmdOrCtrl+N"))?,
            &MenuItem::with_id(app, "backup", "导出备份…", true, Some("CmdOrCtrl+Shift+E"))?,
            &MenuItem::with_id(app, "restore", "恢复备份…", true, None::<&str>)?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "编辑",
        true,
        &[
            &PredefinedMenuItem::undo(app, Some("撤销"))?,
            &PredefinedMenuItem::redo(app, Some("重做"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, Some("剪切"))?,
            &PredefinedMenuItem::copy(app, Some("复制"))?,
            &PredefinedMenuItem::paste(app, Some("粘贴"))?,
            &PredefinedMenuItem::select_all(app, Some("全选"))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "find", "查找", true, Some("CmdOrCtrl+F"))?,
        ],
    )?;
    let window = Submenu::with_items(
        app,
        "窗口",
        true,
        &[
            &PredefinedMenuItem::minimize(app, Some("最小化"))?,
            &PredefinedMenuItem::fullscreen(app, Some("切换全屏"))?,
            &MenuItem::with_id(app, "close", "关闭窗口", true, Some("CmdOrCtrl+W"))?,
        ],
    )?;
    Menu::with_items(app, &[&app_items, &file, &edit, &window])
}

pub fn run() {
    let app = tauri::Builder::default()
        .manage(Lifecycle::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            read_backup_file,
            save_backup_file,
            open_external,
            get_app_version,
            check_for_update,
            install_update,
            load_last_route,
            save_last_route,
            finish_window_action,
            read_snapshot,
            commit_snapshot,
            read_snapshot_v2,
            commit_snapshot_v2,
            restore_snapshot_v2,
            read_recovery_snapshots_v2,
            restore_recovery_snapshot_v2,
            delete_recovery_snapshot_v2
        ])
        .setup(|app| {
            tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("秋招手记")
            .inner_size(1280., 820.)
            .min_inner_size(960., 640.)
            .center()
            .on_navigation(|url| {
                (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
                    || (cfg!(debug_assertions)
                        && url.scheme() == "http"
                        && url.host_str() == Some("127.0.0.1")
                        && url.port() == Some(1420))
            })
            .on_new_window(|_, _| NewWindowResponse::Deny)
            .build()?;
            app.set_menu(app_menu(app.handle())?)?;
            Ok(())
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "settings" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                    let _ = window.emit("navigate-settings", ());
                }
            }
            action @ ("new" | "backup" | "restore" | "find") => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                    let _ = window.emit("menu-action", action);
                }
            }
            "quit" => request_action(app, "quit"),
            "close" => request_action(app, "close"),
            _ => {}
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                request_action(window.app_handle(), "close");
            }
        })
        .build(tauri::generate_context!())
        .expect("无法启动秋招手记");
    app.run(|app, event| match event {
        tauri::RunEvent::ExitRequested { api, .. } => {
            if !app.state::<Lifecycle>().quitting.load(Ordering::SeqCst) {
                api.prevent_exit();
                request_action(app, "quit");
            }
        }
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        _ => {}
    });
}
