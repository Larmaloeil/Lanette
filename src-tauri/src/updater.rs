//! Mises à jour depuis les Releases GitHub du dépôt.
//!
//! Aucune connexion n'a lieu en arrière-plan : la vérification ne se fait que
//! lorsque l'utilisateur la demande (et l'a acceptée). L'installeur NSIS de la
//! nouvelle version est téléchargé dans le dossier temporaire puis lancé ;
//! il remplace l'ancienne version en conservant les données (AppData).

use serde::Serialize;
use std::io::{Read, Write};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

pub const REPO: &str = "Larmaloeil/Lanette";
const USER_AGENT: &str = concat!("Lanette/", env!("CARGO_PKG_VERSION"));

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub available: bool,
    pub current: String,
    pub latest: String,
    pub notes: String,
    pub url: String,
    pub size: u64,
    pub page: String,
}

/// Erreur avec un code traduit côté interface :
/// "not_found" (aucune version publique), "network", "no_asset", "download", "install".
#[derive(Serialize, Debug, Clone)]
pub struct UpdateError {
    pub code: String,
    pub message: String,
}

fn err(code: &str, message: impl Into<String>) -> UpdateError {
    UpdateError { code: code.into(), message: message.into() }
}

fn agent() -> ureq::Agent {
    let mut b = ureq::AgentBuilder::new();
    if let Ok(tls) = native_tls::TlsConnector::new() {
        b = b.tls_connector(std::sync::Arc::new(tls));
    }
    b
        .timeout_connect(Duration::from_secs(10))
        .timeout_read(Duration::from_secs(30))
        .user_agent(USER_AGENT)
        .build()
}

/// Compare deux versions "1.2.3" (les suffixes non numériques sont ignorés).
pub fn is_newer(latest: &str, current: &str) -> bool {
    let parse = |v: &str| -> Vec<u64> {
        v.trim()
            .trim_start_matches(['v', 'V'])
            .split(['.', '-', '+'])
            .take(3)
            .map(|p| p.chars().take_while(|c| c.is_ascii_digit()).collect::<String>().parse().unwrap_or(0))
            .collect()
    };
    let (mut a, mut b) = (parse(latest), parse(current));
    a.resize(3, 0);
    b.resize(3, 0);
    a > b
}

pub fn check(current: &str) -> Result<UpdateInfo, UpdateError> {
    let url = format!("https://api.github.com/repos/{REPO}/releases/latest");
    let resp = agent()
        .get(&url)
        .set("Accept", "application/vnd.github+json")
        .call();
    let resp = match resp {
        Ok(r) => r,
        // 404 : aucune Release publiée, ou dépôt privé (invisible sans compte).
        Err(ureq::Error::Status(404, _)) => return Err(err("not_found", "")),
        Err(ureq::Error::Status(code, _)) => return Err(err("network", format!("HTTP {code}"))),
        Err(e) => return Err(err("network", e.to_string())),
    };
    let text = resp.into_string().map_err(|e| err("network", e.to_string()))?;
    let json: serde_json::Value = serde_json::from_str(&text).map_err(|e| err("network", e.to_string()))?;

    let latest = json["tag_name"].as_str().unwrap_or("").trim_start_matches(['v', 'V']).to_string();
    let notes = json["body"].as_str().unwrap_or("").to_string();
    let page = json["html_url"]
        .as_str()
        .map(String::from)
        .unwrap_or_else(|| format!("https://github.com/{REPO}/releases"));
    let asset = json["assets"].as_array().and_then(|assets| {
        assets.iter().find(|a| {
            a["name"].as_str().is_some_and(|n| n.to_lowercase().ends_with("-setup.exe"))
        })
    });
    let (url, size) = asset
        .map(|a| (a["browser_download_url"].as_str().unwrap_or("").to_string(), a["size"].as_u64().unwrap_or(0)))
        .unwrap_or_default();

    let available = !latest.is_empty() && is_newer(&latest, current);
    if available && url.is_empty() {
        return Err(err("no_asset", latest));
    }
    Ok(UpdateInfo { available, current: current.to_string(), latest, notes, url, size, page })
}

#[derive(Serialize, Clone)]
struct Progress {
    done: u64,
    total: u64,
}

/// Télécharge l'installeur (avec progression) puis le lance et quitte Lanette.
pub fn download_and_install(app: &AppHandle, url: &str, expected: u64, version: &str) -> Result<(), UpdateError> {
    if !url.starts_with("https://github.com/") && !url.starts_with("https://objects.githubusercontent.com/") {
        return Err(err("download", "Adresse de téléchargement inattendue"));
    }
    let resp = agent().get(url).call().map_err(|e| err("download", e.to_string()))?;
    let total = resp
        .header("Content-Length")
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(expected);

    let safe_version: String = version.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '.').collect();
    let path = std::env::temp_dir().join(format!("Lanette_{safe_version}_setup.exe"));
    let mut file = std::fs::File::create(&path).map_err(|e| err("download", e.to_string()))?;
    let mut reader = resp.into_reader();
    let mut buf = vec![0u8; 64 * 1024];
    let mut done: u64 = 0;
    let mut last_emit = Instant::now();
    loop {
        let n = reader.read(&mut buf).map_err(|e| err("download", e.to_string()))?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n]).map_err(|e| err("download", e.to_string()))?;
        done += n as u64;
        if last_emit.elapsed() > Duration::from_millis(80) {
            let _ = app.emit("lanette://update-progress", Progress { done, total });
            last_emit = Instant::now();
        }
    }
    file.flush().map_err(|e| err("download", e.to_string()))?;
    drop(file);
    let _ = app.emit("lanette://update-progress", Progress { done, total: total.max(done) });

    // Téléchargement tronqué (connexion coupée) : on n'exécute pas un fichier incomplet.
    if done == 0 || (expected > 0 && done != expected) {
        let _ = std::fs::remove_file(&path);
        return Err(err("download", format!("Fichier incomplet ({done} / {expected} octets)")));
    }

    // /P : installation « passive » (barre de progression, aucune question).
    // /UPDATE : mise à jour (raccourcis existants conservés tels quels).
    // /R : relancer Lanette une fois l'installation terminée.
    std::process::Command::new(&path)
        .args(["/P", "/UPDATE", "/R"])
        .spawn()
        .map_err(|e| err("install", e.to_string()))?;

    // Laisse l'installeur démarrer, puis libère l'exécutable à remplacer.
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(400));
        app.exit(0);
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::is_newer;

    #[test]
    fn compares_versions() {
        assert!(is_newer("1.1.0", "1.0.0"));
        assert!(is_newer("v2.0.0", "1.9.9"));
        assert!(is_newer("1.0.10", "1.0.9"));
        assert!(!is_newer("1.0.0", "1.0.0"));
        assert!(!is_newer("1.0.0", "1.1.0"));
        assert!(!is_newer("", "1.0.0"));
    }
}
