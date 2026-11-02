//! Lanette — lanceur d'applications pour Windows 10/11.
//!
//! Architecture :
//! - `config`    : JSON dans AppData (ou dossier portable), écriture atomique
//! - `launcher`  : ShellExecuteExW (admin/UAC, arguments, dossier de travail)
//! - `icons`     : extraction Shell + cache PNG + protocole icon:// asynchrone
//! - `startmenu` : import du menu Démarrer et des applis du Store
//! - `winutil`   : fenêtre (affichage instantané, multi-écrans, Mica, mémoire)
//! - `tray`      : zone de notification
//! - `updater`   : mises à jour depuis les Releases GitHub (sur demande)
//! - `commands`  : API exposée au frontend

mod commands;
mod config;
mod icons;
mod launcher;
mod shell;
mod startmenu;
mod tray;
mod updater;
mod winutil;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::menu::CheckMenuItem;
use tauri::{Manager, WindowEvent, Wry};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_global_shortcut::{Shortcut, ShortcutState};

pub struct AppState {
    pub config: Mutex<config::Config>,
    pub hotkey: Mutex<Option<Shortcut>>,
    pub hotkey_error: Mutex<Option<String>>,
    pub dialog_open: AtomicBool,
    pub last_blur: Mutex<Option<Instant>>,
    pub last_blur_hide: Mutex<Option<Instant>>,
    pub autostart_item: Mutex<Option<CheckMenuItem<Wry>>>,
    pub start_hidden: bool,
    pub ready: AtomicBool,
    pub mica: AtomicBool,
}

pub fn run() {
    // Lancé par Windows au démarrage de session : on reste dans la zone de notification.
    let start_hidden = std::env::args().any(|a| a == "--hidden");
    let cfg = config::load();

    tauri::Builder::default()
        // Doit être le premier plugin : une 2e instance ramène la fenêtre existante.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            winutil::show_main(app);
        }))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        winutil::toggle_main(app);
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ))
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            config: Mutex::new(cfg),
            hotkey: Mutex::new(None),
            hotkey_error: Mutex::new(None),
            dialog_open: AtomicBool::new(false),
            last_blur: Mutex::new(None),
            last_blur_hide: Mutex::new(None),
            autostart_item: Mutex::new(None),
            start_hidden,
            ready: AtomicBool::new(false),
            mica: AtomicBool::new(false),
        })
        .register_asynchronous_uri_scheme_protocol("icon", icons::protocol_handler)
        .setup(move |app| {
            let handle = app.handle().clone();
            let state = app.state::<AppState>();
            let settings = state.config.lock().map(|c| c.settings.clone()).unwrap_or_default();

            if let Some(w) = winutil::main_window(&handle) {
                winutil::set_theme(&w, &settings.theme);
                let mica = winutil::apply_effects(&w);
                state.mica.store(mica, Ordering::SeqCst);
            }

            tray::build(&handle)?;

            if let Err(e) = commands::apply_hotkey(&handle, &settings.hotkey) {
                if let Ok(mut slot) = state.hotkey_error.lock() {
                    *slot = Some(e);
                }
            }

            // Éléments marqués "lancer au démarrage d'Lanette".
            let startup: Vec<launcher::LaunchRequest> = state
                .config
                .lock()
                .map(|c| {
                    c.items
                        .iter()
                        .filter(|i| i.launch_on_start)
                        .map(|i| launcher::LaunchRequest {
                            kind: i.kind.clone(),
                            target: i.target.clone(),
                            args: i.args.clone(),
                            workdir: i.workdir.clone(),
                            admin: i.admin,
                        })
                        .collect()
                })
                .unwrap_or_default();
            if !startup.is_empty() {
                std::thread::spawn(move || {
                    for req in startup {
                        let _ = launcher::launch(&req);
                    }
                });
            }

            // Filet de sécurité : si le frontend ne signale pas qu'il est prêt,
            // on affiche quand même la fenêtre.
            if !start_hidden {
                let h = handle.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(2500));
                    winutil::mark_ready(&h);
                });
            }
            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                // Fermer = masquer dans la zone de notification.
                api.prevent_close();
                winutil::hide_main(window.app_handle());
            }
            WindowEvent::Focused(false) => winutil::on_blur(window.app_handle()),
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            commands::load_config,
            commands::save_config,
            commands::get_env,
            commands::app_ready,
            commands::hide_window,
            commands::quit_app,
            commands::set_window_theme,
            commands::launch_item,
            commands::open_location,
            commands::check_paths,
            commands::inspect_paths,
            commands::scan_start_menu,
            commands::pick,
            commands::export_config,
            commands::import_config,
            commands::set_hotkey,
            commands::set_autostart,
            commands::clear_icon_cache,
            commands::open_data_dir,
            commands::check_update,
            commands::install_update,
        ])
        .run(tauri::generate_context!())
        .expect("impossible de démarrer Lanette");
}
