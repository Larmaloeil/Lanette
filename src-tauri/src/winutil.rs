//! Gestion de la fenêtre principale : affichage instantané, masquage,
//! multi-écrans, effet Mica et mémoire réduite quand la fenêtre est cachée.

use crate::AppState;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewWindow};

pub const MAIN: &str = "main";

pub fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(MAIN)
}

pub fn show_main(app: &AppHandle) {
    let Some(w) = main_window(app) else { return };
    let visible = w.is_visible().unwrap_or(false);
    if !visible {
        place_on_cursor_monitor(&w);
        set_memory_low(&w, false);
    }
    let _ = w.unminimize();
    let _ = w.show();
    let _ = w.set_focus();
    let _ = w.emit("lanette://shown", ());
}

pub fn hide_main(app: &AppHandle) {
    let Some(w) = main_window(app) else { return };
    if w.is_visible().unwrap_or(false) {
        let _ = w.hide();
        let _ = w.emit("lanette://hidden", ());
        set_memory_low(&w, true);
    }
}

/// Raccourci global / clic sur l'icône de notification.
pub fn toggle_main(app: &AppHandle) {
    let Some(w) = main_window(app) else { return };
    let visible = w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false);
    if visible {
        // Fenêtre au premier plan, ou qui vient de perdre le focus à cause
        // de ce clic même (icône de notification) : on la masque.
        let state = app.state::<AppState>();
        let just_blurred = state
            .last_blur
            .lock()
            .ok()
            .and_then(|t| *t)
            .is_some_and(|t| t.elapsed() < Duration::from_millis(400));
        if w.is_focused().unwrap_or(false) || just_blurred {
            hide_main(app);
        } else {
            show_main(app);
        }
        return;
    }
    // Un clic sur l'icône de notification fait d'abord perdre le focus à la
    // fenêtre (donc la masque) : sans ce garde-fou elle réapparaîtrait aussitôt.
    let state = app.state::<AppState>();
    let recently_hidden = state
        .last_blur_hide
        .lock()
        .ok()
        .and_then(|t| *t)
        .is_some_and(|t| t.elapsed() < Duration::from_millis(300));
    if !recently_hidden {
        show_main(app);
    }
}

/// Perte de focus : masque la fenêtre si l'option est active.
///
/// Windows envoie aussi une perte de focus quand on commence à déplacer ou
/// redimensionner une fenêtre sans bordure. On attend donc un court instant,
/// puis on ne masque que si la fenêtre n'a pas retrouvé le focus et que la
/// souris est hors de la fenêtre (vrai clic ailleurs).
pub fn on_blur(app: &AppHandle) {
    let state = app.state::<AppState>();
    if let Ok(mut t) = state.last_blur.lock() {
        *t = Some(Instant::now());
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(180));
        let state = app.state::<AppState>();
        if state.dialog_open.load(Ordering::SeqCst) {
            return; // un sélecteur de fichiers Windows est ouvert
        }
        let hide = state
            .config
            .lock()
            .map(|c| c.settings.hide_on_blur)
            .unwrap_or(false);
        if !hide {
            return;
        }
        let Some(w) = main_window(&app) else { return };
        // Réduite dans la barre des tâches : elle doit y rester.
        if !w.is_visible().unwrap_or(false)
            || w.is_minimized().unwrap_or(false)
            || w.is_focused().unwrap_or(false)
        {
            return;
        }
        if cursor_inside(&w) {
            return; // déplacement ou redimensionnement en cours
        }
        if let Ok(mut t) = state.last_blur_hide.lock() {
            *t = Some(Instant::now());
        }
        hide_main(&app);
    });
}

fn cursor_inside(w: &WebviewWindow) -> bool {
    let (Ok(c), Ok(p), Ok(s)) = (w.cursor_position(), w.outer_position(), w.outer_size()) else {
        return false;
    };
    c.x >= p.x as f64
        && c.y >= p.y as f64
        && c.x < p.x as f64 + s.width as f64
        && c.y < p.y as f64 + s.height as f64
}

/// Centre la fenêtre sur l'écran où se trouve la souris, sauf si elle y est
/// déjà (on respecte alors la position choisie par l'utilisateur).
fn place_on_cursor_monitor(w: &WebviewWindow) {
    let Ok(cursor) = w.cursor_position() else { return };
    let Ok(monitors) = w.available_monitors() else { return };
    let contains = |m: &tauri::Monitor, x: f64, y: f64| {
        let p = m.position();
        let s = m.size();
        x >= p.x as f64 && y >= p.y as f64 && x < p.x as f64 + s.width as f64 && y < p.y as f64 + s.height as f64
    };
    let Some(target) = monitors.iter().find(|m| contains(m, cursor.x, cursor.y)) else { return };

    let (Ok(pos), Ok(size), Ok(scale)) = (w.outer_position(), w.outer_size(), w.scale_factor()) else { return };
    let cx = pos.x as f64 + size.width as f64 / 2.0;
    let cy = pos.y as f64 + size.height as f64 / 2.0;
    if contains(target, cx, cy) {
        return;
    }
    // Taille convertie au facteur d'échelle (DPI) de l'écran de destination.
    let logical = size.to_logical::<f64>(scale);
    let phys = logical.to_physical::<i32>(target.scale_factor());
    let area = target.work_area();
    let x = area.position.x + (area.size.width as i32 - phys.width) / 2;
    let y = area.position.y + (area.size.height as i32 - phys.height) / 2;
    let _ = w.set_position(PhysicalPosition::new(x, y.max(area.position.y)));
}

/// Indique à WebView2 de libérer un maximum de mémoire quand l'app est cachée.
fn set_memory_low(w: &WebviewWindow, low: bool) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
    };
    use windows::core::Interface;
    let level = if low {
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
    } else {
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
    };
    let _ = w.with_webview(move |pw| unsafe {
        if let Ok(core) = pw.controller().CoreWebView2() {
            if let Ok(c19) = core.cast::<ICoreWebView2_19>() {
                let _ = c19.SetMemoryUsageTargetLevel(level);
            }
        }
    });
}

/// Numéro de build Windows (22000+ = Windows 11).
pub fn windows_build() -> u32 {
    use windows::Wdk::System::SystemServices::RtlGetVersion;
    use windows::Win32::System::SystemInformation::OSVERSIONINFOW;
    let mut info = OSVERSIONINFOW {
        dwOSVersionInfoSize: std::mem::size_of::<OSVERSIONINFOW>() as u32,
        ..Default::default()
    };
    let status = unsafe { RtlGetVersion(&mut info) };
    if status.is_ok() {
        info.dwBuildNumber
    } else {
        0
    }
}

/// Active l'effet Mica sous Windows 11. Sous Windows 10, l'interface utilise
/// un fond opaque (l'Acrylic de Windows 10 rend le déplacement saccadé).
pub fn apply_effects(w: &WebviewWindow) -> bool {
    use tauri::window::{Effect, EffectState, EffectsBuilder};
    if windows_build() < 22000 {
        return false;
    }
    let cfg = EffectsBuilder::new()
        .effect(Effect::Mica)
        .state(EffectState::FollowsWindowActiveState)
        .build();
    w.set_effects(cfg).is_ok()
}

pub fn set_theme(w: &WebviewWindow, theme: &str) {
    let t = match theme {
        "dark" => Some(tauri::Theme::Dark),
        "light" => Some(tauri::Theme::Light),
        _ => None, // suit le système
    };
    let _ = w.set_theme(t);
}

pub fn mark_ready(app: &AppHandle) {
    let state = app.state::<AppState>();
    let first = !state.ready.swap(true, Ordering::SeqCst);
    if first && !state.start_hidden {
        show_main(app);
    }
}
