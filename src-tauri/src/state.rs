use crate::config::Config;
use crate::i18n;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Webview};

/// App-wide state shared between Tauri commands.
///
/// Small, deliberately cheap structures. Soocial's first constraint on this
/// migration was RAM: we keep only the state needed to route UI events and
/// position child webviews. Everything persistent is stored on disk in the
/// same JSON shape that `electron-store` used, so an existing user keeps their
/// config (and their sessions, which live outside this file).
pub struct AppState {
    /// Called by the JS bridge to emit `hub:*` events to the sidebar.
    pub app: AppHandle,
    /// JSON state file (`config.json`) under the app data directory.
    pub config_path: PathBuf,
    /// The persisted configuration. Mutex is enough: reads/writes are tiny and
    /// this file is hit a handful of times per user action.
    pub config: Mutex<Config>,
    /// The sidebar webview label; the only window hosting the dashboard UI.
    pub main_webview: String,
    /// `service_id -> child webview` loaded with that service's external URL.
    pub webviews: Mutex<HashMap<String, Webview>>,
    /// Currently displayed service (the "left" pane in split mode).
    pub active_id: Mutex<Option<String>>,
    /// Optional second service in split view.
    pub split_id: Mutex<Option<String>>,
    /// Window is locked behind the PIN screen.
    pub locked: Mutex<bool>,
    /// Services that were unlocked since the current lock session.
    pub unlocked_ids: Mutex<HashSet<String>>,
    /// Resolved UI language (`en`, `fr`, `es`).
    pub language: Mutex<String>,
}

impl AppState {
    pub fn new(app: AppHandle, config: Config) -> Self {
        let config_path = crate::config::config_dir().join("config.json");
        Self {
            app,
            config_path,
            config: Mutex::new(config),
            main_webview: "main".to_string(),
            webviews: Mutex::new(HashMap::new()),
            active_id: Mutex::new(None),
            split_id: Mutex::new(None),
            locked: Mutex::new(false),
            unlocked_ids: Mutex::new(HashSet::new()),
            language: Mutex::new(i18n::FALLBACK.to_string()),
        }
    }

    pub fn webview(&self, id: &str) -> Option<Webview> {
        self.webviews
            .lock()
            .ok()
            .and_then(|map| map.get(id).cloned())
    }
}
