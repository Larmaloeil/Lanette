//! Détection des applications nouvellement installées.
//!
//! Un fil d'arrière-plan compare régulièrement les raccourcis du menu
//! Démarrer, des bureaux et la liste des applis du Store avec ce qu'il a déjà
//! vu (fichier `known-apps.json`). Ce qui est nouveau est envoyé au frontend,
//! qui propose de l'ajouter ou de le garder « Pour plus tard ».
//!
//! Au tout premier passage, tout ce qui existe déjà est simplement mémorisé :
//! seules les installations faites ensuite sont proposées.

use crate::config;
use crate::shell::ComGuard;
use crate::startmenu::{self, Candidate, Verdict};
use crate::AppState;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

const FIRST_DELAY: Duration = Duration::from_secs(8);
const INTERVAL: Duration = Duration::from_secs(40);
/// Un raccourci dont la cible n'existe pas encore est réexaminé ~15 minutes.
const MAX_RETRIES: u32 = 22;

fn known_path() -> PathBuf {
    config::data_dir().join("known-apps.json")
}

fn load_known() -> Option<HashSet<String>> {
    let text = std::fs::read_to_string(known_path()).ok()?;
    serde_json::from_str::<Vec<String>>(&text).ok().map(|v| v.into_iter().collect())
}

fn save_known(known: &HashSet<String>) {
    let mut v: Vec<&String> = known.iter().collect();
    v.sort();
    if let Ok(json) = serde_json::to_string(&v) {
        let _ = config::write_atomic(&known_path(), json.as_bytes(), None);
    }
}

fn enabled(app: &AppHandle) -> bool {
    app.state::<AppState>()
        .config
        .lock()
        .map(|c| c.settings.detect_new_apps)
        .unwrap_or(false)
}

struct Watcher {
    known: Option<HashSet<String>>,
    retries: HashMap<String, u32>,
}

impl Watcher {
    fn tick(&mut self) -> Vec<Candidate> {
        let _com = ComGuard::new();
        let mut files: Vec<(String, PathBuf, &str)> = Vec::new();
        for f in startmenu::start_menu_files() {
            files.push((f.to_string_lossy().to_lowercase(), f, "startmenu"));
        }
        for f in startmenu::desktop_files() {
            files.push((f.to_string_lossy().to_lowercase(), f, "desktop"));
        }
        let apps = startmenu::store_apps();

        let current: HashSet<String> = files
            .iter()
            .map(|(k, _, _)| k.clone())
            .chain(apps.iter().map(|a| a.target.to_lowercase()))
            .collect();

        if self.known.is_none() {
            // Premier passage : on mémorise l'existant sans rien proposer.
            save_known(&current);
            self.known = Some(current);
            return Vec::new();
        }
        let Some(known) = self.known.as_mut() else { return Vec::new() };

        let mut found = Vec::new();
        let mut names = HashSet::new();
        let mut next: HashSet<String> = known.intersection(&current).cloned().collect();
        for (key, path, source) in &files {
            if known.contains(key) {
                continue;
            }
            match startmenu::file_verdict(path, source) {
                Verdict::Keep(c) => {
                    next.insert(key.clone());
                    self.retries.remove(key);
                    if names.insert(c.name.to_lowercase()) {
                        found.push(c);
                    }
                }
                Verdict::Skip => {
                    next.insert(key.clone());
                }
                Verdict::Retry => {
                    let n = self.retries.entry(key.clone()).or_insert(0);
                    *n += 1;
                    if *n >= MAX_RETRIES {
                        next.insert(key.clone());
                        self.retries.remove(key);
                    }
                }
            }
        }
        for a in apps {
            let key = a.target.to_lowercase();
            if known.contains(&key) {
                continue;
            }
            next.insert(key);
            if names.insert(a.name.to_lowercase()) {
                found.push(a);
            }
        }
        // Les clés disparues (logiciel désinstallé) sont oubliées : une
        // réinstallation sera de nouveau proposée.
        if next != *known {
            save_known(&next);
            *known = next;
        }
        self.retries.retain(|k, _| current.contains(k));
        found
    }
}

pub fn start(app: AppHandle) {
    std::thread::Builder::new()
        .name("lanette-watcher".into())
        .spawn(move || {
            let mut w = Watcher { known: load_known(), retries: HashMap::new() };
            std::thread::sleep(FIRST_DELAY);
            loop {
                if enabled(&app) {
                    let found = w.tick();
                    if !found.is_empty() {
                        let _ = app.emit("lanette://new-apps", found);
                    }
                } else if w.known.is_some() {
                    // Option désactivée : à la réactivation, on repartira de l'existant.
                    w.known = None;
                    let _ = std::fs::remove_file(known_path());
                }
                std::thread::sleep(INTERVAL);
            }
        })
        .ok();
}
