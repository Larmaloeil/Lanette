//! Petits utilitaires Win32/COM partagés.

use windows::core::{Interface, HSTRING, PWSTR};
use windows::Win32::Storage::FileSystem::WIN32_FIND_DATAW;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, IPersistFile,
    CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE, STGM_READ,
};
use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};

/// Initialise COM (STA) pour la durée de vie de l'objet.
/// Les API Shell (raccourcis, icônes, ShellExecute) l'exigent.
pub struct ComGuard {
    owned: bool,
}

impl ComGuard {
    pub fn new() -> Self {
        // S_FALSE (déjà initialisé) compte comme un succès qu'il faut équilibrer.
        let hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) };
        Self { owned: hr.is_ok() }
    }
}

impl Drop for ComGuard {
    fn drop(&mut self) {
        if self.owned {
            unsafe { CoUninitialize() };
        }
    }
}

/// Convertit un PWSTR alloué par le Shell en String et libère la mémoire.
pub unsafe fn take_pwstr(p: PWSTR) -> String {
    if p.is_null() {
        return String::new();
    }
    let s = p.to_string().unwrap_or_default();
    CoTaskMemFree(Some(p.0 as *const _));
    s
}

fn wide_buf_to_string(buf: &[u16]) -> String {
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..len])
}

/// Cible d'un raccourci .lnk.
#[derive(Default, Debug, Clone)]
pub struct LinkInfo {
    pub target: String,
}

/// Lit un .lnk sans le "réparer" ni afficher d'interface.
/// Les raccourcis "advertised" (MSI) ou vers des applis Store n'ont pas de
/// chemin cible : `target` est alors vide, ce qui n'est pas une erreur.
pub fn resolve_lnk(path: &str) -> Option<LinkInfo> {
    unsafe {
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).ok()?;
        let pf: IPersistFile = link.cast().ok()?;
        pf.Load(&HSTRING::from(path), STGM_READ).ok()?;

        let mut buf = vec![0u16; 2048];
        let mut fd = WIN32_FIND_DATAW::default();
        let _ = link.GetPath(&mut buf, &mut fd, 0);
        let target = wide_buf_to_string(&buf);

        Some(LinkInfo { target: expand_env(&target) })
    }
}

/// Développe %VARIABLES% (ex. %ProgramFiles%) sans dépendance externe.
pub fn expand_env(s: &str) -> String {
    if !s.contains('%') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%') {
            Some(end) => {
                let name = &after[..end];
                match std::env::var(name) {
                    Ok(v) if !name.is_empty() => out.push_str(&v),
                    _ => {
                        out.push('%');
                        out.push_str(name);
                        out.push('%');
                    }
                }
                rest = &after[end + 1..];
            }
            None => {
                out.push_str(&rest[start..]);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

/// Chemin réseau (\\serveur\partage) : on évite de le sonder, un serveur
/// injoignable peut bloquer plusieurs secondes.
pub fn is_unc(p: &str) -> bool {
    p.starts_with("\\\\") && !p.starts_with("\\\\?\\")
}

pub fn ext_lower(p: &str) -> String {
    std::path::Path::new(p)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default()
}
