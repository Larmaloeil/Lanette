//! Icône de la zone de notification et son menu.

use crate::{winutil, AppState};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_autostart::ManagerExt;

/// Libellés du menu (le reste de l'interface est traduit côté frontend).
fn labels(lang: &str) -> [&'static str; 5] {
    match lang {
        "en" => ["Open Lanette", "Settings", "Start with Windows", "Quit", "Check for updates"],
        _ => ["Ouvrir Lanette", "Paramètres", "Lancer avec Windows", "Quitter", "Vérifier les mises à jour"],
    }
}

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let lang = app
        .state::<AppState>()
        .config
        .lock()
        .map(|c| c.settings.language.clone())
        .unwrap_or_default();
    let [open, settings, autostart, quit, update] = labels(&lang);
    let auto_on = app.autolaunch().is_enabled().unwrap_or(false);

    let open_i = MenuItem::with_id(app, "open", open, true, None::<&str>)?;
    let settings_i = MenuItem::with_id(app, "settings", settings, true, None::<&str>)?;
    let auto_i = CheckMenuItem::with_id(app, "autostart", autostart, true, auto_on, None::<&str>)?;
    let update_i = MenuItem::with_id(app, "update", update, true, None::<&str>)?;
    let quit_i = MenuItem::with_id(app, "quit", quit, true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&open_i, &settings_i, &update_i, &sep1, &auto_i, &sep2, &quit_i])?;

    if let Ok(mut slot) = app.state::<AppState>().autostart_item.lock() {
        *slot = Some(auto_i.clone());
    }

    let mut builder = TrayIconBuilder::with_id("lanette-tray")
        .tooltip("Lanette")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => winutil::show_main(app),
            "settings" => {
                winutil::show_main(app);
                let _ = app.emit("lanette://open-settings", ());
            }
            "update" => {
                winutil::show_main(app);
                let _ = app.emit("lanette://check-update", ());
            }
            "autostart" => {
                let enabled = app.autolaunch().is_enabled().unwrap_or(false);
                let _ = set_autostart(app, !enabled);
                let _ = app.emit("lanette://autostart-changed", !enabled);
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                winutil::toggle_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

pub fn set_autostart(app: &AppHandle, enabled: bool) -> Result<(), String> {
    let al = app.autolaunch();
    let res = if enabled { al.enable() } else { al.disable() };
    res.map_err(|e| e.to_string())?;
    let now = al.is_enabled().unwrap_or(enabled);
    if let Ok(slot) = app.state::<AppState>().autostart_item.lock() {
        if let Some(item) = slot.as_ref() {
            let _ = item.set_checked(now);
        }
    }
    Ok(())
}
