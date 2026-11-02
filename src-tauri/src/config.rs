//! Configuration persistante (JSON lisible) + mode portable.
//!
//! Emplacement :
//! - normal   : %APPDATA%\Lanette\config.json
//! - portable : <dossier de l'exe>\data\config.json, activé si un fichier
//!   nommé `portable` (ou `portable.txt`) est posé à côté de Lanette.exe.
//!
//! L'écriture est atomique (fichier temporaire puis renommage) et la version
//! précédente est gardée en `config.bak.json` : une coupure de courant pendant
//! une sauvegarde ne peut pas corrompre la configuration.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

pub const CONFIG_VERSION: u32 = 1;
const APP_DIR_NAME: &str = "Lanette";

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    /// "system" | "dark" | "light"
    pub theme: String,
    /// Couleur d'accent "#RRGGBB"
    pub accent: String,
    /// "s" | "m" | "l"
    pub icon_size: String,
    /// "grid" | "list"
    pub view: String,
    /// Accélérateur au format Tauri, ex. "Alt+Space"
    pub hotkey: String,
    pub hide_after_launch: bool,
    pub show_recents: bool,
    /// Masque les chemins d'accès partout dans l'interface.
    pub hide_paths: bool,
    /// L'utilisateur a accepté que Lanette contacte GitHub pour les mises à jour.
    pub update_consent: bool,
    /// "fr" | "en"
    pub language: String,
    pub onboarded: bool,
    /// Propose d'ajouter les applications installées après Lanette.
    pub detect_new_apps: bool,
    /// Sections repliées dans l'onglet « Tout » ("pinned", "recents", "g:<id>", "loose").
    pub collapsed: Vec<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: "dark".into(),
            accent: "#4cc2ff".into(),
            icon_size: "m".into(),
            view: "grid".into(),
            hotkey: "Alt+Space".into(),
            hide_after_launch: true,
            show_recents: true,
            hide_paths: true,
            update_consent: false,
            language: "fr".into(),
            onboarded: false,
            detect_new_apps: true,
            collapsed: Vec::new(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Group {
    pub id: String,
    pub name: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Item {
    pub id: String,
    pub name: String,
    /// "exe" | "lnk" | "folder" | "file" | "url" | "app"
    pub kind: String,
    pub target: String,
    pub args: String,
    pub workdir: String,
    pub admin: bool,
    pub launch_on_start: bool,
    pub group_id: Option<String>,
    pub pinned: bool,
    /// Icône personnalisée (chemin d'une image, d'un .ico ou d'un .exe)
    pub icon: Option<String>,
    pub last_launched: Option<i64>,
    pub launch_count: u32,
    pub added_at: i64,
}

/// Application mise de côté dans la liste « Pour plus tard ».
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct LaterItem {
    pub name: String,
    pub kind: String,
    pub target: String,
    /// "startmenu" | "desktop" | "store"
    pub source: String,
    pub added_at: i64,
    /// Détectée mais pas encore montrée à l'utilisateur.
    pub fresh: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default, rename_all = "camelCase")]
pub struct Config {
    pub version: u32,
    pub settings: Settings,
    pub groups: Vec<Group>,
    pub items: Vec<Item>,
    pub later: Vec<LaterItem>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            version: CONFIG_VERSION,
            settings: Settings::default(),
            groups: vec![
                Group { id: "g-jeux".into(), name: "Jeux".into() },
                Group { id: "g-travail".into(), name: "Travail".into() },
                Group { id: "g-outils".into(), name: "Outils".into() },
            ],
            items: Vec::new(),
            later: Vec::new(),
        }
    }
}

impl Config {
    /// Nettoie une config venant du frontend ou d'un import : identifiants
    /// manquants, doublons, groupes inexistants, valeurs hors bornes.
    pub fn sanitize(mut self) -> Self {
        self.version = CONFIG_VERSION;
        let s = &mut self.settings;
        if !["system", "dark", "light"].contains(&s.theme.as_str()) {
            s.theme = "dark".into();
        }
        if !["s", "m", "l"].contains(&s.icon_size.as_str()) {
            s.icon_size = "m".into();
        }
        if !["grid", "list"].contains(&s.view.as_str()) {
            s.view = "grid".into();
        }
        if !is_hex_color(&s.accent) {
            s.accent = Settings::default().accent;
        }
        if s.hotkey.trim().is_empty() {
            s.hotkey = Settings::default().hotkey;
        }
        if !["fr", "en"].contains(&s.language.as_str()) {
            s.language = "fr".into();
        }
        s.collapsed.truncate(200);

        let mut seen = std::collections::HashSet::new();
        self.groups.retain(|g| !g.id.is_empty() && seen.insert(g.id.clone()));
        let group_ids: std::collections::HashSet<_> =
            self.groups.iter().map(|g| g.id.clone()).collect();

        let mut seen = std::collections::HashSet::new();
        let mut counter = 0u32;
        for it in self.items.iter_mut() {
            if it.id.is_empty() || seen.contains(&it.id) {
                counter += 1;
                it.id = format!("i-{}-{}", now_ms(), counter);
            }
            seen.insert(it.id.clone());
            if let Some(g) = &it.group_id {
                if !group_ids.contains(g) {
                    it.group_id = None;
                }
            }
            if it.name.trim().is_empty() {
                it.name = "Sans nom".into();
            }
        }
        self.items.retain(|it| !it.target.trim().is_empty());

        let mut seen = std::collections::HashSet::new();
        self.later.retain(|l| !l.target.trim().is_empty() && seen.insert(l.target.to_lowercase()));
        self.later.truncate(500);
        self
    }
}

fn is_hex_color(s: &str) -> bool {
    s.len() == 7 && s.starts_with('#') && s[1..].chars().all(|c| c.is_ascii_hexdigit())
}

/// Langue de l'interface, pour les rares textes produits côté Rust.
pub fn is_english(state: &crate::AppState) -> bool {
    state.config.lock().map(|c| c.settings.language == "en").unwrap_or(false)
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

struct Dirs {
    data: PathBuf,
    portable: bool,
}

static DIRS: OnceLock<Dirs> = OnceLock::new();

fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe().ok()?.parent().map(Path::to_path_buf)
}

fn portable_marker_present(dir: &Path) -> bool {
    ["portable", "portable.txt", "portable.flag"]
        .iter()
        .any(|n| dir.join(n).is_file())
}

fn dir_writable(dir: &Path) -> bool {
    if fs::create_dir_all(dir).is_err() {
        return false;
    }
    let probe = dir.join(".write-test");
    let ok = fs::write(&probe, b"ok").is_ok();
    let _ = fs::remove_file(&probe);
    ok
}

fn dirs() -> &'static Dirs {
    DIRS.get_or_init(|| {
        if let Some(exe) = exe_dir() {
            if portable_marker_present(&exe) {
                let d = exe.join("data");
                // Ex. exe copié dans "Program Files" : pas de droit d'écriture,
                // on retombe proprement sur AppData.
                if dir_writable(&d) {
                    return Dirs { data: d, portable: true };
                }
            }
        }
        let base = std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .or_else(|| exe_dir().map(|e| e.join("data")))
            .unwrap_or_else(|| PathBuf::from("."));
        let d = base.join(APP_DIR_NAME);
        let _ = fs::create_dir_all(&d);
        Dirs { data: d, portable: false }
    })
}

pub fn data_dir() -> &'static Path {
    &dirs().data
}

pub fn is_portable() -> bool {
    dirs().portable
}

pub fn icon_cache_dir() -> PathBuf {
    data_dir().join("cache").join("icons")
}

fn config_path() -> PathBuf {
    data_dir().join("config.json")
}

fn backup_path() -> PathBuf {
    data_dir().join("config.bak.json")
}

fn read_config(path: &Path) -> Option<Config> {
    let text = fs::read_to_string(path).ok()?;
    // Tolère un BOM UTF-8 (fichier édité avec le Bloc-notes).
    let text = text.trim_start_matches('\u{feff}');
    serde_json::from_str::<Config>(text).ok().map(Config::sanitize)
}

/// Charge la config ; en cas de fichier corrompu, le met de côté et tente la
/// sauvegarde `.bak`, sinon repart d'une config par défaut.
pub fn load() -> Config {
    let path = config_path();
    if !path.exists() {
        return Config::default();
    }
    if let Some(c) = read_config(&path) {
        return c;
    }
    let corrupt = data_dir().join(format!("config.corrompu-{}.json", now_ms()));
    let _ = fs::rename(&path, &corrupt);
    read_config(&backup_path()).unwrap_or_default()
}

pub fn save(cfg: &Config) -> Result<(), String> {
    let json = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    write_atomic(&config_path(), json.as_bytes(), Some(&backup_path()))
}

pub fn write_atomic(path: &Path, data: &[u8], backup: Option<&Path>) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, data).map_err(|e| format!("Écriture impossible : {e}"))?;
    if let Some(b) = backup {
        if path.exists() {
            let _ = fs::copy(path, b);
        }
    }
    // std::fs::rename remplace la destination sous Windows (MoveFileEx).
    fs::rename(&tmp, path).map_err(|e| format!("Remplacement impossible : {e}"))
}

/// Lit une config exportée (pour l'import).
pub fn parse_import(text: &str) -> Result<Config, String> {
    let text = text.trim_start_matches('\u{feff}');
    serde_json::from_str::<Config>(text)
        .map(Config::sanitize)
        .map_err(|e| format!("Fichier invalide : {e}"))
}
