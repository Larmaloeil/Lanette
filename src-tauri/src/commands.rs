//! Commandes appelées par le frontend (window.__TAURI__.core.invoke).
//! Tout ce qui touche au disque ou au Shell tourne hors du thread principal.

use crate::config::{self, Config};
use crate::launcher::{self, LaunchError, LaunchRequest, NewItem, PathCheck};
use crate::startmenu::{self, Candidate};
use crate::updater::{self, UpdateError, UpdateInfo};
use crate::{icons, tray, winutil, AppState};
use serde::Serialize;
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn load_config(state: State<'_, AppState>) -> Config {
    state.config.lock().map(|c| c.clone()).unwrap_or_default()
}

#[tauri::command]
pub async fn save_config(app: AppHandle, config: Config) -> Result<(), String> {
    let cfg = config.sanitize();
    {
        let state = app.state::<AppState>();
        let mut guard = state.config.lock().map_err(|e| e.to_string())?;
        *guard = cfg.clone();
    }
    blocking(move || config::save(&cfg)).await?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvInfo {
    version: String,
    mica: bool,
    portable: bool,
    data_dir: String,
    autostart: bool,
    hotkey_error: Option<String>,
    windows_build: u32,
}

#[tauri::command]
pub fn get_env(app: AppHandle, state: State<'_, AppState>) -> EnvInfo {
    EnvInfo {
        version: app.package_info().version.to_string(),
        mica: state.mica.load(Ordering::SeqCst),
        portable: config::is_portable(),
        data_dir: config::data_dir().to_string_lossy().into_owned(),
        autostart: app.autolaunch().is_enabled().unwrap_or(false),
        hotkey_error: state.hotkey_error.lock().ok().and_then(|e| e.clone()),
        windows_build: winutil::windows_build(),
    }
}

#[tauri::command]
pub fn app_ready(app: AppHandle) {
    winutil::mark_ready(&app);
}

#[tauri::command]
pub fn hide_window(app: AppHandle) {
    winutil::hide_main(&app);
}

#[tauri::command]
pub fn quit_app(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
pub fn set_window_theme(app: AppHandle, theme: String) {
    if let Some(w) = winutil::main_window(&app) {
        winutil::set_theme(&w, &theme);
    }
}

#[tauri::command]
pub async fn launch_item(req: LaunchRequest) -> Result<(), LaunchError> {
    blocking(move || launcher::launch(&req))
        .await
        .map_err(|e| LaunchError { code: "other".into(), message: e })?
}

#[tauri::command]
pub async fn open_location(kind: String, target: String) -> Result<(), String> {
    blocking(move || launcher::open_location(&kind, &target)).await?
}

#[tauri::command]
pub async fn check_paths(items: Vec<PathCheck>) -> Result<Vec<bool>, String> {
    blocking(move || {
        let _com = crate::shell::ComGuard::new();
        items.iter().map(launcher::check_path).collect()
    })
    .await
}

#[tauri::command]
pub async fn inspect_paths(paths: Vec<String>) -> Result<Vec<NewItem>, String> {
    blocking(move || launcher::inspect_paths(&paths)).await
}

#[tauri::command]
pub async fn scan_start_menu() -> Result<Vec<Candidate>, String> {
    blocking(startmenu::scan).await
}

/// Empêche le masquage automatique pendant qu'un sélecteur Windows est ouvert.
struct DialogGuard<'a>(&'a AppState);
impl<'a> DialogGuard<'a> {
    fn new(s: &'a AppState) -> Self {
        s.dialog_open.store(true, Ordering::SeqCst);
        Self(s)
    }
}
impl Drop for DialogGuard<'_> {
    fn drop(&mut self) {
        self.0.dialog_open.store(false, Ordering::SeqCst);
    }
}

/// Sélecteurs de fichiers natifs.
/// kind : "files" | "folder" | "icon" | "target" | "workdir"
#[tauri::command]
pub async fn pick(app: AppHandle, kind: String) -> Result<Vec<String>, String> {
    let state = app.state::<AppState>();
    let _guard = DialogGuard::new(&state);
    let en = config::is_english(&state);
    let tr = |fr: &'static str, en_text: &'static str| if en { en_text } else { fr };
    let mut d = app.dialog().file();
    if let Some(w) = winutil::main_window(&app) {
        d = d.set_parent(&w);
    }
    let to_strings = |v: Vec<tauri_plugin_dialog::FilePath>| -> Vec<String> {
        v.into_iter()
            .filter_map(|p| p.into_path().ok())
            .map(|p| p.to_string_lossy().into_owned())
            .collect()
    };
    let res = match kind.as_str() {
        "files" => d
            .set_title(tr("Ajouter des éléments", "Add items"))
            .add_filter(tr("Programmes et raccourcis", "Programs and shortcuts"), &["exe", "lnk", "url", "bat", "cmd", "msc"])
            .add_filter(tr("Tous les fichiers", "All files"), &["*"])
            .blocking_pick_files()
            .map(to_strings),
        "target" => d
            .set_title(tr("Choisir le nouvel emplacement", "Choose the new location"))
            .add_filter(tr("Tous les fichiers", "All files"), &["*"])
            .blocking_pick_file()
            .map(|p| to_strings(vec![p])),
        "icon" => d
            .set_title(tr("Choisir une icône", "Choose an icon"))
            .add_filter(tr("Images et icônes", "Images and icons"), &["png", "jpg", "jpeg", "ico", "webp", "svg", "bmp", "exe", "dll"])
            .blocking_pick_file()
            .map(|p| to_strings(vec![p])),
        "folder" | "workdir" => d
            .set_title(if kind == "folder" { tr("Ajouter un dossier", "Add a folder") } else { tr("Dossier de travail", "Working folder") })
            .blocking_pick_folders()
            .map(to_strings),
        _ => return Err("unknown picker".into()),
    };
    Ok(res.unwrap_or_default())
}

#[tauri::command]
pub async fn export_config(app: AppHandle, config: Config) -> Result<bool, String> {
    let state = app.state::<AppState>();
    let _guard = DialogGuard::new(&state);
    let en = config::is_english(&state);
    let mut d = app
        .dialog()
        .file()
        .set_title(if en { "Export settings" } else { "Exporter la configuration" })
        .set_file_name("lanette-sauvegarde.json")
        .add_filter("JSON", &["json"]);
    if let Some(w) = winutil::main_window(&app) {
        d = d.set_parent(&w);
    }
    let Some(path) = d.blocking_save_file().and_then(|p| p.into_path().ok()) else {
        return Ok(false);
    };
    let json = serde_json::to_string_pretty(&config.sanitize()).map_err(|e| e.to_string())?;
    config::write_atomic(&path, json.as_bytes(), None)?;
    Ok(true)
}

#[tauri::command]
pub async fn import_config(app: AppHandle) -> Result<Option<Config>, String> {
    let state = app.state::<AppState>();
    let _guard = DialogGuard::new(&state);
    let en = config::is_english(&state);
    let mut d = app
        .dialog()
        .file()
        .set_title(if en { "Import settings" } else { "Importer une configuration" })
        .add_filter("JSON", &["json"]);
    if let Some(w) = winutil::main_window(&app) {
        d = d.set_parent(&w);
    }
    let Some(path) = d.blocking_pick_file().and_then(|p| p.into_path().ok()) else {
        return Ok(None);
    };
    let text = std::fs::read_to_string(&path).map_err(|e| format!("Lecture impossible : {e}"))?;
    config::parse_import(&text).map(Some)
}

/// (Ré)enregistre le raccourci global. En cas d'échec, l'ancien est conservé.
pub fn apply_hotkey(app: &AppHandle, accel: &str) -> Result<(), String> {
    let state = app.state::<AppState>();
    let en = config::is_english(&state);
    let sc: Shortcut = accel.parse().map_err(|_| {
        if en { format!("Invalid shortcut: \"{accel}\"") } else { format!("Raccourci invalide : « {accel} »") }
    })?;
    let gs = app.global_shortcut();
    let mut current = state.hotkey.lock().map_err(|e| e.to_string())?;
    if *current == Some(sc) {
        return Ok(());
    }
    if let Some(old) = *current {
        let _ = gs.unregister(old);
    }
    match gs.register(sc) {
        Ok(()) => {
            *current = Some(sc);
            if let Ok(mut e) = state.hotkey_error.lock() {
                *e = None;
            }
            Ok(())
        }
        Err(_) => {
            if let Some(old) = *current {
                let _ = gs.register(old);
            }
            Err(if en {
                format!("\"{accel}\" is already used by Windows or another app.")
            } else {
                format!("« {accel} » est déjà utilisé par Windows ou une autre application.")
            })
        }
    }
}

#[tauri::command]
pub fn set_hotkey(app: AppHandle, accel: String) -> Result<(), String> {
    apply_hotkey(&app, &accel)
}

#[tauri::command]
pub fn set_autostart(app: AppHandle, enabled: bool) -> Result<bool, String> {
    tray::set_autostart(&app, enabled)?;
    Ok(app.autolaunch().is_enabled().unwrap_or(enabled))
}

#[tauri::command]
pub async fn clear_icon_cache() -> Result<(), String> {
    blocking(icons::clear_cache).await?
}

#[tauri::command]
pub async fn open_data_dir() -> Result<(), String> {
    let dir = config::data_dir().to_string_lossy().into_owned();
    blocking(move || {
        launcher::launch(&LaunchRequest {
            kind: "folder".into(),
            target: dir,
            args: String::new(),
            workdir: String::new(),
            admin: false,
        })
        .map_err(|e| e.message)
    })
    .await?
}

#[tauri::command]
pub async fn check_update(app: AppHandle) -> Result<UpdateInfo, UpdateError> {
    let current = app.package_info().version.to_string();
    blocking(move || updater::check(&current))
        .await
        .map_err(|e| UpdateError { code: "network".into(), message: e })?
}

#[tauri::command]
pub async fn install_update(app: AppHandle, url: String, size: u64, version: String) -> Result<(), UpdateError> {
    blocking(move || updater::download_and_install(&app, &url, size, &version))
        .await
        .map_err(|e| UpdateError { code: "download".into(), message: e })?
}

#[tauri::command]
pub fn set_language(app: AppHandle, lang: String) {
    tray::relabel(&app, &lang);
}

/// Nombre d'applications détectées pas encore vues (infobulle de l'icône).
#[tauri::command]
pub fn set_pending(app: AppHandle, count: u32) {
    let en = config::is_english(&app.state::<AppState>());
    tray::set_pending(&app, count, if en { "en" } else { "fr" });
}
