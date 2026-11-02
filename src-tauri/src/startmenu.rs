//! Import depuis le menu Démarrer (raccourcis .lnk / .url) et les applications
//! installées du Microsoft Store (dossier virtuel shell:AppsFolder).

use crate::shell::{self, take_pwstr, ComGuard};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use windows::Win32::UI::Shell::{
    BHID_EnumItems, FOLDERID_AppsFolder, FOLDERID_Desktop, FOLDERID_PublicDesktop, IEnumShellItems,
    IShellItem, SHGetKnownFolderItem, SHGetKnownFolderPath, KF_FLAG_DEFAULT, SIGDN_NORMALDISPLAY,
    SIGDN_PARENTRELATIVEPARSING,
};

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Candidate {
    pub name: String,
    pub kind: String,
    pub target: String,
    /// "startmenu" | "desktop" | "store"
    pub source: String,
}

/// Mots qui signalent un raccourci sans intérêt (désinstalleur, aide...).
const NOISE: &[&str] = &[
    "uninstall", "désinstaller", "desinstaller", "désinstallation", "readme", "read me",
    "lisez-moi", "lisezmoi", "help", "aide", "documentation", "manual", "manuel", "license",
    "licence", "release notes", "website", "site web", "changelog", "what's new", "support",
    "faq", "eula",
];

fn is_noise(name: &str) -> bool {
    let n = name.to_lowercase();
    NOISE.iter().any(|w| n.contains(w))
}

fn walk(dir: &Path, depth: u32, out: &mut Vec<PathBuf>) {
    if depth > 6 {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        match e.file_type() {
            Ok(ft) if ft.is_dir() => walk(&p, depth + 1, out),
            Ok(ft) if ft.is_file() => {
                let ext = shell::ext_lower(&p.to_string_lossy());
                if ext == "lnk" || ext == "url" {
                    out.push(p);
                }
            }
            _ => {}
        }
    }
}

fn start_menu_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    let rel = ["Microsoft", "Windows", "Start Menu", "Programs"];
    for var in ["APPDATA", "ProgramData"] {
        if let Some(base) = std::env::var_os(var) {
            let mut p = PathBuf::from(base);
            for r in rel {
                p.push(r);
            }
            roots.push(p);
        }
    }
    roots
}

/// Bureaux de l'utilisateur et public (beaucoup de jeux n'y créent qu'un raccourci).
fn desktop_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for id in [&FOLDERID_Desktop, &FOLDERID_PublicDesktop] {
        if let Ok(p) = unsafe { SHGetKnownFolderPath(id, KF_FLAG_DEFAULT, None) } {
            let s = unsafe { take_pwstr(p) };
            if !s.is_empty() {
                roots.push(PathBuf::from(s));
            }
        }
    }
    roots
}

/// Raccourcis (.lnk / .url) du menu Démarrer.
pub fn start_menu_files() -> Vec<PathBuf> {
    let mut files = Vec::new();
    for root in start_menu_roots() {
        walk(&root, 0, &mut files);
    }
    files
}

/// Raccourcis posés directement sur les bureaux (sans sous-dossiers).
pub fn desktop_files() -> Vec<PathBuf> {
    let mut files = Vec::new();
    for root in desktop_roots() {
        walk(&root, 6, &mut files);
    }
    files
}

/// Ce qu'on fait d'un raccourci trouvé sur le disque.
pub enum Verdict {
    Keep(Candidate),
    /// Sans intérêt (désinstalleur, document...) : on n'y reviendra pas.
    Skip,
    /// Cible absente : l'installation est peut-être encore en cours.
    Retry,
}

pub fn file_verdict(f: &Path, source: &str) -> Verdict {
    let path = f.to_string_lossy().into_owned();
    let name = f.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    if name.is_empty() || is_noise(&name) {
        return Verdict::Skip;
    }
    if shell::ext_lower(&path) == "lnk" {
        // On garde les raccourcis vers des programmes (ou sans cible lisible,
        // ex. raccourcis MSI "advertised"), pas ceux vers des documents.
        if let Some(info) = shell::resolve_lnk(&path) {
            let t = info.target.trim();
            if !t.is_empty() {
                let ext = shell::ext_lower(t);
                if !matches!(ext.as_str(), "exe" | "msc" | "cpl" | "bat" | "cmd") {
                    return Verdict::Skip;
                }
                if !shell::is_unc(t) && !Path::new(t).exists() {
                    return Verdict::Retry; // raccourci cassé, ou programme pas encore copié
                }
            }
        }
    }
    Verdict::Keep(Candidate { name, kind: "lnk".into(), target: path, source: source.into() })
}

/// Applications du Store / packagées : leur identifiant contient un "!".
pub fn store_apps() -> Vec<Candidate> {
    let mut out = Vec::new();
    unsafe {
        let Ok(folder) = SHGetKnownFolderItem::<IShellItem>(&FOLDERID_AppsFolder, KF_FLAG_DEFAULT, None) else {
            return out;
        };
        let Ok(en) = folder.BindToHandler::<_, IEnumShellItems>(None, &BHID_EnumItems) else {
            return out;
        };
        loop {
            let mut items: [Option<IShellItem>; 1] = [None];
            let mut fetched = 0u32;
            if en.Next(&mut items, Some(&mut fetched)).is_err() || fetched == 0 {
                break;
            }
            let Some(it) = items[0].take() else { break };
            let name = it.GetDisplayName(SIGDN_NORMALDISPLAY).map(|p| take_pwstr(p)).unwrap_or_default();
            let id = it.GetDisplayName(SIGDN_PARENTRELATIVEPARSING).map(|p| take_pwstr(p)).unwrap_or_default();
            if name.is_empty() || !id.contains('!') || is_noise(&name) {
                continue;
            }
            out.push(Candidate {
                name,
                kind: "app".into(),
                target: format!("shell:AppsFolder\\{id}"),
                source: "store".into(),
            });
        }
    }
    out
}

pub fn scan() -> Vec<Candidate> {
    let _com = ComGuard::new();
    let mut out = Vec::new();
    let mut seen = HashSet::new();

    for f in start_menu_files() {
        if let Verdict::Keep(c) = file_verdict(&f, "startmenu") {
            if seen.insert(c.name.to_lowercase()) {
                out.push(c);
            }
        }
    }
    for c in store_apps() {
        if seen.insert(c.name.to_lowercase()) {
            out.push(c);
        }
    }

    out.sort_by_key(|c| c.name.to_lowercase());
    out
}
