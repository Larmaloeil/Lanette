//! Lancement des éléments via ShellExecuteExW et vérification des chemins.

use crate::shell::{self, ComGuard};
use serde::{Deserialize, Serialize};
use std::path::Path;
use windows::core::{HSTRING, PCWSTR};
use windows::Win32::UI::Shell::{
    ShellExecuteExW, SEE_MASK_FLAG_NO_UI, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS,
    SHELLEXECUTEINFOW,
};
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LaunchRequest {
    pub kind: String,
    pub target: String,
    #[serde(default)]
    pub args: String,
    #[serde(default)]
    pub workdir: String,
    #[serde(default)]
    pub admin: bool,
}

#[derive(Serialize, Debug, Clone)]
pub struct LaunchError {
    /// "uac_cancelled" | "not_found" | "access_denied" | "no_association" | "other"
    pub code: String,
    pub message: String,
}

impl LaunchError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self { code: code.into(), message: message.into() }
    }
}

const ERROR_FILE_NOT_FOUND: u32 = 2;
const ERROR_PATH_NOT_FOUND: u32 = 3;
const ERROR_ACCESS_DENIED: u32 = 5;
const ERROR_NO_ASSOCIATION: u32 = 1155;
const ERROR_CANCELLED: u32 = 1223;

fn win32_code(e: &windows::core::Error) -> u32 {
    let hr = e.code().0 as u32;
    // HRESULT_FROM_WIN32 : 0x8007xxxx
    if hr & 0xFFFF_0000 == 0x8007_0000 {
        hr & 0xFFFF
    } else {
        hr
    }
}

fn shell_execute(verb: &str, file: &str, params: &str, dir: &str) -> Result<(), u32> {
    let verb_w = HSTRING::from(verb);
    let file_w = HSTRING::from(file);
    let params_w = HSTRING::from(params);
    let dir_w = HSTRING::from(dir);
    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI | SEE_MASK_NOCLOSEPROCESS,
        lpVerb: PCWSTR(verb_w.as_ptr()),
        lpFile: PCWSTR(file_w.as_ptr()),
        lpParameters: if params.is_empty() { PCWSTR::null() } else { PCWSTR(params_w.as_ptr()) },
        lpDirectory: if dir.is_empty() { PCWSTR::null() } else { PCWSTR(dir_w.as_ptr()) },
        nShow: SW_SHOWNORMAL.0,
        ..Default::default()
    };
    let res = unsafe { ShellExecuteExW(&mut info) };
    if !info.hProcess.is_invalid() && !info.hProcess.0.is_null() {
        unsafe {
            let _ = CloseHandle(info.hProcess);
        }
    }
    res.map_err(|e| win32_code(&e))
}

/// Lance un élément. Bloquant : à appeler hors du thread principal.
pub fn launch(req: &LaunchRequest) -> Result<(), LaunchError> {
    let _com = ComGuard::new();
    let target = shell::expand_env(req.target.trim());
    if target.is_empty() {
        return Err(LaunchError::new("not_found", "Chemin vide"));
    }

    let is_path_kind = !matches!(req.kind.as_str(), "url" | "app");
    if is_path_kind && !shell::is_unc(&target) && !Path::new(&target).exists() {
        return Err(LaunchError::new("not_found", target));
    }

    // Dossier de travail : celui choisi, sinon le dossier de l'exe (beaucoup de
    // jeux et d'outils plantent s'ils sont lancés depuis un autre dossier).
    let mut dir = shell::expand_env(req.workdir.trim());
    if dir.is_empty() && req.kind == "exe" {
        if let Some(p) = Path::new(&target).parent() {
            dir = p.to_string_lossy().into_owned();
        }
    }

    let can_elevate = matches!(req.kind.as_str(), "exe" | "lnk");
    let verb = if req.admin && can_elevate { "runas" } else { "open" };
    let args = if matches!(req.kind.as_str(), "exe" | "lnk") { req.args.trim() } else { "" };

    let result = shell_execute(verb, &target, args, &dir);

    match result {
        Ok(()) => Ok(()),
        Err(ERROR_NO_ASSOCIATION) => {
            // Aucun programme associé : on propose la boîte "Ouvrir avec".
            shell_execute("openas", &target, "", "")
                .map_err(|_| LaunchError::new("no_association", target.clone()))
        }
        Err(ERROR_CANCELLED) => Err(LaunchError::new("uac_cancelled", "")),
        Err(ERROR_FILE_NOT_FOUND) | Err(ERROR_PATH_NOT_FOUND) => {
            Err(LaunchError::new("not_found", target))
        }
        Err(ERROR_ACCESS_DENIED) => Err(LaunchError::new("access_denied", target)),
        Err(code) => Err(LaunchError::new("other", format!("Code Windows {code}"))),
    }
}

/// Ouvre l'Explorateur sur l'élément (sélectionné).
pub fn open_location(kind: &str, target: &str) -> Result<(), String> {
    let _com = ComGuard::new();
    let target = shell::expand_env(target.trim());
    if kind == "url" || kind == "app" {
        return Err("Pas d'emplacement pour cet élément".into());
    }
    let p = Path::new(&target);
    let res = if p.exists() {
        shell_execute("open", "explorer.exe", &format!("/select,\"{}\"", target), "")
    } else if let Some(parent) = p.parent().filter(|d| d.exists()) {
        shell_execute("open", &parent.to_string_lossy(), "", "")
    } else {
        return Err("Emplacement introuvable".into());
    };
    res.map_err(|c| format!("Code Windows {c}"))
}

#[derive(Deserialize, Debug)]
pub struct PathCheck {
    pub kind: String,
    pub target: String,
}

/// true = l'élément est utilisable. Les URL, applis Store et chemins réseau
/// ne sont pas sondés (toujours considérés valides).
pub fn check_path(c: &PathCheck) -> bool {
    if matches!(c.kind.as_str(), "url" | "app") {
        return true;
    }
    let t = shell::expand_env(c.target.trim());
    if t.is_empty() {
        return false;
    }
    if shell::is_unc(&t) {
        return true;
    }
    let p = Path::new(&t);
    if !p.exists() {
        return false;
    }
    if shell::ext_lower(&t) == "lnk" {
        if let Some(info) = shell::resolve_lnk(&t) {
            let tt = info.target.trim();
            if !tt.is_empty() && !shell::is_unc(tt) && !tt.contains('%') {
                return Path::new(tt).exists();
            }
        }
    }
    true
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NewItem {
    pub name: String,
    pub kind: String,
    pub target: String,
}

/// Transforme des chemins déposés/choisis en éléments prêts à ajouter.
pub fn inspect_paths(paths: &[String]) -> Vec<NewItem> {
    let _com = ComGuard::new();
    let mut out = Vec::new();
    for raw in paths {
        let path = raw.trim().trim_matches('"').to_string();
        if path.is_empty() {
            continue;
        }
        let p = Path::new(&path);
        let stem = p
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.clone());
        if p.is_dir() {
            let name = p
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                // Racine de lecteur (C:\) : pas de nom de fichier.
                .unwrap_or_else(|| path.trim_end_matches('\\').to_string());
            out.push(NewItem { name, kind: "folder".into(), target: path });
            continue;
        }
        let kind = match shell::ext_lower(&path).as_str() {
            "exe" | "bat" | "cmd" | "com" | "msc" | "ps1" => "exe",
            // .url = raccourci Internet ou de jeu (steam://...) : on garde le
            // fichier pour conserver son icône.
            "lnk" | "url" | "appref-ms" => "lnk",
            _ => "file",
        };
        out.push(NewItem { name: stem, kind: kind.into(), target: path });
    }
    out
}
