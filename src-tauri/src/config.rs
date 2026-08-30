use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Config {
    pub window: WindowState,
    pub last_active_id: Option<String>,
    pub services: Vec<Service>,
    pub onboarded: bool,
    pub icons: HashMap<String, String>,
    pub order: Vec<String>,
    pub muted: HashMap<String, bool>,
    pub dnd: DndState,
    pub volumes: HashMap<String, f64>,
    pub master_volume: f64,
    pub language: String,
    pub autostart: bool,
    pub autostart_hidden: bool,
    pub spellcheck: bool,
    pub split_id: Option<String>,
    pub split_direction: String,
    pub split_ratio: f64,
    pub lock: LockState,
    pub protected: HashMap<String, LockState>,
    pub theme: String,
    pub glass: String,
    pub animations: String,
    pub sidebar_collapsed: bool,
    pub close_to_tray: bool,
    pub minimize_to_tray: bool,
    pub downloads: Option<String>,
    pub ask_where_to_save: bool,
    pub favorites: Vec<String>,
    pub last_page: Option<String>,
    pub first_launch_at: Option<String>,
    pub hardware_acceleration: Option<bool>,
}

impl Config {
    pub fn merge(&mut self, patch: &Value) -> Vec<String> {
        let mut applied = Vec::new();
        if let Some(object) = patch.as_object() {
            for (field, value) in object {
                match field.as_str() {
                    "theme" => {
                        if let Some(text) = value.as_str() {
                            self.theme = text.to_string();
                            applied.push(field.clone());
                        }
                    }
                    "glass" => {
                        if let Some(text) = value.as_str() {
                            self.glass = text.to_string();
                            applied.push(field.clone());
                        }
                    }
                    "animations" => {
                        if let Some(text) = value.as_str() {
                            self.animations = text.to_string();
                            applied.push(field.clone());
                        }
                    }
                    "sidebarCollapsed" => {
                        if let Some(flag) = value.as_bool() {
                            self.sidebar_collapsed = flag;
                            applied.push(field.clone());
                        }
                    }
                    "closeToTray" => {
                        if let Some(flag) = value.as_bool() {
                            self.close_to_tray = flag;
                            applied.push(field.clone());
                        }
                    }
                    "minimizeToTray" => {
                        if let Some(flag) = value.as_bool() {
                            self.minimize_to_tray = flag;
                            applied.push(field.clone());
                        }
                    }
                    "autostart" => {
                        if let Some(flag) = value.as_bool() {
                            self.autostart = flag;
                            applied.push(field.clone());
                        }
                    }
                    "autostartHidden" => {
                        if let Some(flag) = value.as_bool() {
                            self.autostart_hidden = flag;
                            applied.push(field.clone());
                        }
                    }
                    "spellcheck" => {
                        if let Some(flag) = value.as_bool() {
                            self.spellcheck = flag;
                            applied.push(field.clone());
                        }
                    }
                    "askWhereToSave" => {
                        if let Some(flag) = value.as_bool() {
                            self.ask_where_to_save = flag;
                            applied.push(field.clone());
                        }
                    }
                    "hardwareAcceleration" => {
                        if let Some(flag) = value.as_bool() {
                            self.hardware_acceleration = Some(flag);
                            applied.push(field.clone());
                        }
                    }
                    "language" => {
                        if let Some(text) = value.as_str() {
                            self.language = text.to_string();
                            applied.push(field.clone());
                        }
                    }
                    "splitDirection" => {
                        if let Some(text) = value.as_str() {
                            self.split_direction = text.to_string();
                            applied.push(field.clone());
                        }
                    }
                    _ => {}
                }
            }
        }
        applied
    }

    pub fn services(&self) -> Vec<Service> {
        self.services
            .iter()
            .map(|service| service.with_defaults())
            .collect()
    }

    pub fn service(&self, id: &str) -> Option<Service> {
        self.services().into_iter().find(|service| service.id == id)
    }

    /// Apply the same order semantics as the Electron app: stored order first,
    /// unknown ids ignored, unplaced services appended.
    pub fn ordered_services(&self) -> Vec<Service> {
        let services = self.services();
        let by_id: HashMap<String, Service> = services.iter().map(|s| (s.id.clone(), s.clone())).collect();
        let seen = std::collections::HashSet::new();
        let mut ordered = Vec::new();
        let mut seen = seen;
        for id in &self.order {
            if let Some(service) = by_id.get(id) {
                if seen.insert(service.id.clone()) {
                    ordered.push(service.clone());
                }
            }
        }
        for service in services {
            if seen.insert(service.id.clone()) {
                ordered.push(service);
            }
        }
        ordered
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct WindowState {
    pub width: f64,
    pub height: f64,
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub maximized: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Service {
    pub id: String,
    pub name: String,
    pub url: String,
    pub color: String,
    pub initials: String,
    pub spoof_user_agent: bool,
    pub preload: bool,
    pub hibernate_after: f64,
    pub icon: Option<String>,
    pub partition: Option<String>,
}

impl Default for Service {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            url: String::new(),
            color: "#45475a".to_string(),
            initials: String::new(),
            spoof_user_agent: false,
            preload: true,
            hibernate_after: 0.0,
            icon: None,
            partition: None,
        }
    }
}

impl Service {
    pub fn with_defaults(&self) -> Service {
        let mut next = self.clone();
        if next.partition.is_none() && !next.id.is_empty() {
            next.partition = Some(format!("persist:{}", next.id));
        }
        next
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct DndState {
    pub until: i64,
    pub choice: String,
}

impl DndState {
    pub fn active(&self, now_ms: i64) -> bool {
        self.until == -1 || self.until > now_ms
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct LockState {
    pub hash: Option<String>,
    pub salt: Option<String>,
    pub on_suspend: bool,
    pub idle_minutes: f64,
}

impl LockState {
    pub fn has_hash(&self) -> bool {
        self.hash.is_some() && self.salt.is_some()
    }
}

/// Config directory that matches the legacy Electron `app.getPath('userData')`
/// so an existing `config.json` carries over. Tauri's default
/// `app_config_dir()` is keyed off the bundle identifier (`com.soocial.desktop`),
/// which would orphan the old file.
pub fn config_dir() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| Path::new(".").to_path_buf())
        .join("soocial")
}

/// Load `config.json` from the app config directory.
/// Missing/corrupt files start from defaults without panicking.
pub fn load() -> Config {
    let config_dir = config_dir();
    let path = config_dir.join("config.json");
    if let Ok(raw) = fs::read_to_string(&path) {
        if let Ok(config) = serde_json::from_str::<Config>(&raw) {
            let mut config = config;
            if config.first_launch_at.is_none() {
                config.first_launch_at = Some(chrono::Utc::now().to_rfc3339());
            }
            return config;
        }
    }
    let mut config = Config::default();
    config.first_launch_at = Some(chrono::Utc::now().to_rfc3339());
    config
}

/// Persist the current config to disk. Errors are logged in the command layer;
/// an unwritable config file should never take the desktop shell down.
pub fn save(_app: &AppHandle, state: &crate::state::AppState) {
    if let Ok(config) = state.config.lock() {
        if let Ok(text) = serde_json::to_string_pretty(&*config) {
            let dir = state.config_path.parent().unwrap_or(Path::new(".")).to_path_buf();
            let _ = fs::create_dir_all(dir);
            let _ = fs::write(state.config_path.as_path(), text);
        }
    }
}
