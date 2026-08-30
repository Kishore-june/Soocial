use crate::catalog;
use crate::config::{self, Config};
use crate::services;
use crate::state::AppState;
use crate::webviews;
use serde_json::{json, Value};
use std::collections::HashSet;
use subtle::ConstantTimeEq;
use tauri::menu::{Menu, MenuItem};
use tauri::{AppHandle, Emitter, LogicalPosition, Manager, State, Window};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

const REPO_URL: &str = "https://github.com/MrJOYEN/soocial";
const PRODUCT_NAME: &str = "Soocial";
const VERSION: &str = env!("CARGO_PKG_VERSION");

fn config(state: &State<'_, AppState>) -> Config {
    state.config.lock().map(|value| value.clone()).unwrap_or_default()
}

/// Translate an i18n key using the configured UI language, falling back to the
/// key so the missing string is visible in development.
fn err(state: &State<'_, AppState>, key: &str) -> String {
    let preference = state
        .config
        .lock()
        .map(|value| value.language.clone())
        .unwrap_or_else(|_| "system".to_string());
    crate::i18n::dict(&preference)
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or(key)
        .to_string()
}

fn set_config(state: &State<'_, AppState>, next: Config) {
    if let Ok(mut current) = state.config.lock() {
        *current = next;
    }
    config::save(&state.app, state);
}

/// Reposition all service webviews. Called from the window resize handler,
/// because Tauri child webviews do not keep a manually-set bounds while the
/// parent is resizing on every platform.
pub fn relayout(app: &AppHandle, state: &AppState) {
    let cfg = state.config.lock().map(|value| value.clone()).unwrap_or_default();
    webviews::layout_views(app, state, &cfg);
}

fn broadcast_services(app: &AppHandle, state: &State<'_, AppState>) {
    let cfg = config(state);
    let list = cfg
        .ordered_services()
        .iter()
        .map(|service| services::service_for_renderer(&cfg, service))
        .collect::<Vec<_>>();
    let _ = app.emit("hub:services", json!({ "services": list }));
}

fn emit_active(app: &AppHandle, state: &State<'_, AppState>) {
    let active = state.active_id.lock().ok().and_then(|value| value.clone());
    let needs_code = active.as_deref().map(|id| needs_code(state, id)).unwrap_or(false);
    let _ = app.emit("hub:active", json!({ "id": active, "needsCode": needs_code }));
}

fn settings_snapshot(app: &AppHandle, state: &State<'_, AppState>) -> Value {
    let cfg = config(state);
    let dnd_active = cfg.dnd.active(webviews::now_ms());
    let has_lock = cfg.lock.has_hash();
    let data_dir = app
        .path()
        .app_data_dir()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let cache_dir = app
        .path()
        .app_cache_dir()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let downloads = cfg
        .downloads
        .clone()
        .unwrap_or_else(default_downloads_dir);
    let downloads_ok = std::fs::metadata(&downloads).is_ok();
    let install_dir = std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(|p| p.to_string_lossy().to_string()))
        .unwrap_or_else(|| ".".to_string());

    json!({
        "theme": cfg.theme,
        "glass": cfg.glass,
        "animations": cfg.animations,
        "sidebarCollapsed": cfg.sidebar_collapsed,
        "closeToTray": cfg.close_to_tray,
        "minimizeToTray": cfg.minimize_to_tray,
        "autostart": cfg.autostart,
        "autostartHidden": cfg.autostart_hidden,
        "spellcheck": cfg.spellcheck,
        "askWhereToSave": cfg.ask_where_to_save,
        "hardwareAcceleration": if cfg.hardware_acceleration.is_some() { cfg.hardware_acceleration } else { None },
        "language": cfg.language,
        "languageAvailable": ["en", "fr", "es"],
        "hasLock": has_lock,
        "productName": PRODUCT_NAME,
        "version": VERSION,
        "electron": "tauri",
        "chromium": "system-webview",
        "dnd": { "active": dnd_active, "until": cfg.dnd.until },
        "masterVolume": cfg.master_volume,
        "volumes": cfg.volumes,
        "downloads": downloads,
        "storage": {
            "downloads": downloads,
            "downloadsOk": downloads_ok,
            "downloadsWillCreate": !downloads_ok,
            "downloadsIsDefault": cfg.downloads.is_none(),
            "data": data_dir,
            "cache": cache_dir,
            "dataNote": null
        },
        "install": {
            "installDir": install_dir,
            "consistency": "match",
            "metadataPath": "tauri://app",
            "hasMetadata": true,
            "channel": "dev",
            "architecture": std::env::consts::ARCH
        },
        "update": { "state": "idle", "version": null }
    })
}

fn default_downloads_dir() -> String {
    dirs::download_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("Soocial")
        .to_string_lossy()
        .to_string()
}

fn needs_code(state: &State<'_, AppState>, id: &str) -> bool {
    let cfg = config(state);
    let is_protected = cfg
        .protected
        .get(id)
        .map(|entry| entry.has_hash())
        .unwrap_or(false);
    let unlocked = state
        .unlocked_ids
        .lock()
        .map(|set| set.contains(id))
        .unwrap_or(false);
    is_protected && !unlocked
}

fn hash_pin(pin: &str, salt: &str) -> Result<String, String> {
    let params = scrypt::Params::new(14, 8, 1, 32).map_err(|e| e.to_string())?;
    let salt_bytes = hex::decode(salt).map_err(|e| e.to_string())?;
    let mut key = [0u8; 32];
    scrypt::scrypt(pin.as_bytes(), &salt_bytes, &params, &mut key).map_err(|e| e.to_string())?;
    Ok(hex::encode(key))
}

fn matches_pin(pin: &str, hash: &str, salt: &str) -> bool {
    hash_pin(pin, salt)
        .map(|candidate| {
            candidate.as_bytes().ct_eq(hash.as_bytes()).into()
        })
        .unwrap_or(false)
}

fn random_salt() -> String {
    let mut bytes = [0u8; 16];
    use rand::RngCore;
    rand::thread_rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

#[tauri::command]
pub async fn bootstrap(app: AppHandle, state: State<'_, AppState>) -> Result<Value, String> {
    let mut cfg = config(&state);
    {
        // Restore the last active service across launches. The webview itself
        // is created lazily in this async command (never in a sync context),
        // which is required by Tauri on Windows.
        if let Some(mut guard) = state.active_id.lock().ok() {
            if guard.is_none() {
                *guard = cfg
                    .last_active_id
                    .clone()
                    .filter(|id| cfg.service(id).is_some())
                    .or_else(|| cfg.ordered_services().first().map(|s| s.id.clone()));
            }
        }
        if let Some(window) = app.get_window("main") {
            let id = state
                .active_id
                .lock()
                .ok()
                .and_then(|value| value.clone())
                ;
            if let Some(id) = id {
                let _ = do_select(&app, &window, &state, &id);
            }
        }
    }
    let cfg = config(&state);
    let services_list = cfg
        .ordered_services()
        .iter()
        .map(|service| services::service_for_renderer(&cfg, service))
        .collect::<Vec<_>>();
    let active_id = state.active_id.lock().ok().and_then(|value| value.clone());
    let split_id = state.split_id.lock().ok().and_then(|value| value.clone());
    let locked = state.locked.lock().map(|value| *value).unwrap_or(false);
    let preference = cfg.language.clone();
    let language = crate::i18n::resolve(&preference);
    let onboarding = !cfg.onboarded && cfg.services.is_empty();

    Ok(json!({
        "services": services_list,
        "activeId": active_id,
        "splitId": split_id,
        "version": VERSION,
        "onboarding": onboarding,
        "locked": locked,
        "activeNeedsCode": active_id.as_deref().map(|id| needs_code(&state, id)).unwrap_or(false),
        "layout": null,
        "strings": crate::i18n::dict(&preference),
        "language": language,
        "languagePreference": preference,
        "catalog": catalog::entries(),
        "catalogIcons": {},
        "update": null,
        "masterVolume": cfg.master_volume,
        "dnd": { "active": cfg.dnd.active(webviews::now_ms()), "until": cfg.dnd.until },
        "trayBase": null,
        "metrics": {
            "SIDEBAR_WIDTH": webviews::SIDEBAR_WIDTH,
            "SIDEBAR_WIDTH_COLLAPSED": webviews::SIDEBAR_WIDTH_COLLAPSED,
            "TITLEBAR_HEIGHT": webviews::TITLEBAR_HEIGHT,
            "SPLIT_GAP": webviews::SPLIT_GAP,
            "WINDOW_BUTTON_SIZE": 15.0,
            "WINDOW_BUTTON_GAP": 10.0,
            "WINDOW_BUTTON_INSET": 12.0,
            "WINDOW_GLYPH_SIZE": 8.0,
            "sidebarWidth": if cfg.sidebar_collapsed { webviews::SIDEBAR_WIDTH_COLLAPSED } else { webviews::SIDEBAR_WIDTH },
            "collapsed": cfg.sidebar_collapsed,
            "glass": cfg.glass,
            "theme": cfg.theme
        },
        "settings": settings_snapshot(&app, &state),
        "favorites": cfg.favorites,
        "lastPage": cfg.last_page,
        "theme": cfg.theme,
        "productName": PRODUCT_NAME,
        "tagline": "Your accounts, one window, watertight sessions."
    }))
}

fn do_select(
    app: &AppHandle,
    window: &Window,
    state: &State<'_, AppState>,
    id: &str,
) -> Result<(), String> {
    let cfg = config(state);
    if cfg.service(id).is_none() {
        return Err("service introuvable".to_string());
    }
    webviews::ensure_webview(app, window, state, &cfg, id)?;
    {
        let mut active = state.active_id.lock().map_err(|e| e.to_string())?;
        *active = Some(id.to_string());
    }
    {
        let mut split = state.split_id.lock().map_err(|e| e.to_string())?;
        if split.as_deref() == Some(id) {
            *split = None;
        }
    }
    if let Ok(mut all) = state.config.lock() {
        all.last_active_id = Some(id.to_string());
    }
    config::save(app, state);
    webviews::layout_views(app, state, &config(state));
    emit_active(app, state);
    Ok(())
}

#[tauri::command]
pub async fn select(
    app: AppHandle,
    window: Window,
    state: State<'_, AppState>,
    id: String,
) -> Result<Value, String> {
    do_select(&app, &window, &state, &id)?;
    Ok(json!({ "ok": true, "id": id }))
}

#[tauri::command]
pub async fn retry(app: AppHandle, window: Window, state: State<'_, AppState>, id: String) -> Result<(), String> {
    if let Some(view) = state.webview(&id) {
        let _ = view.eval("location.reload(); 'ok'");
    } else {
        let cfg = config(&state);
        webviews::ensure_webview(&app, &window, &state, &cfg, &id)?;
        webviews::layout_views(&app, &state, &cfg);
    }
    Ok(())
}

#[tauri::command]
pub fn save_service(state: State<'_, AppState>, draft: Value) -> Value {
    let mut cfg = config(&state);
    let mut result = services::save_service(&mut cfg, &draft);
    if let Some(key) = result.get("error").and_then(Value::as_str).map(str::to_string) {
        result["error"] = json!(err(&state, &key));
    }
    set_config(&state, cfg);
    broadcast_services(&state.app, &state);
    result
}

#[tauri::command]
pub fn delete_service(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<Value, String> {
    let mut cfg = config(&state);
    services::delete_service(&mut cfg, &id);
    set_config(&state, cfg);
    webviews::remove_webview(&state, &id);
    if let Ok(mut active) = state.active_id.lock() {
        if active.as_deref() == Some(id.as_str()) {
            let next = config(&state).ordered_services().first().map(|s| s.id.clone());
            *active = next;
        }
    }
    webviews::layout_views(&app, &state, &config(&state));
    broadcast_services(&app, &state);
    emit_active(&app, &state);
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn onboard_complete(app: AppHandle, window: Window, state: State<'_, AppState>, drafts: Value) -> Result<Value, String> {
    let mut cfg = config(&state);
    let result = services::onboard_complete(&mut cfg, &drafts);
    set_config(&state, cfg);
    let cfg = config(&state);
    if let Some(service) = cfg.ordered_services().first() {
        let _ = do_select(&app, &window, &state, &service.id);
    }
    broadcast_services(&app, &state);
    Ok(result)
}

#[tauri::command]
pub fn set_language(app: AppHandle, state: State<'_, AppState>, preference: String) -> Value {
    let resolved = crate::i18n::resolve(&preference);
    {
        if let Ok(mut cfg) = state.config.lock() {
            cfg.language = preference.clone();
        }
        if let Ok(mut lang) = state.language.lock() {
            *lang = resolved.clone();
        }
    }
    config::save(&app, &state);
    let strings = crate::i18n::dict(&preference);
    let _ = app.emit("hub:language", json!({ "strings": strings, "language": resolved, "preference": preference }));
    json!({ "strings": crate::i18n::dict(&resolved), "language": resolved, "preference": preference })
}

#[tauri::command]
pub fn reorder(app: AppHandle, state: State<'_, AppState>, ids: Vec<String>) -> Result<(), String> {
    let mut cfg = config(&state);
    let known: HashSet<String> = cfg.services.iter().map(|s| s.id.clone()).collect();
    let order: Vec<String> = ids.into_iter().filter(|id| known.contains(id)).collect();
    if order.len() == known.len() {
        cfg.order = order;
        set_config(&state, cfg);
        broadcast_services(&app, &state);
    }
    Ok(())
}

#[tauri::command]
pub fn set_volume(app: AppHandle, window: Window, state: State<'_, AppState>, id: String, value: f64) -> Result<(), String> {
    let mut cfg = config(&state);
    if cfg.service(&id).is_none() {
        return Err("service introuvable".to_string());
    }
    let level = services::clamp_volume(Some(value), 100.0);
    cfg.volumes.insert(id.clone(), level);
    set_config(&state, cfg);
    let cfg = config(&state);
    webviews::apply_volume(&state, &cfg, &id);
    webviews::layout_views(&app, &state, &cfg);
    let _ = app.emit("hub:volume", json!({ "id": id, "value": level, "muted": cfg.muted.get(&id).copied().unwrap_or(false) }));
    let _ = window;
    Ok(())
}

#[tauri::command]
pub fn set_master_volume(app: AppHandle, state: State<'_, AppState>, value: f64) -> Result<(), String> {
    let mut cfg = config(&state);
    cfg.master_volume = services::clamp_volume(Some(value), 100.0);
    set_config(&state, cfg);
    let cfg = config(&state);
    for id in cfg.services.iter().map(|s| s.id.clone()) {
        webviews::apply_volume(&state, &cfg, &id);
    }
    let _ = app.emit("hub:volume", json!({ "master": cfg.master_volume }));
    Ok(())
}

#[tauri::command]
pub fn set_dnd(app: AppHandle, state: State<'_, AppState>, choice: String) -> Result<(), String> {
    let mut cfg = config(&state);
    let until = services::dnd_compute(&choice, webviews::now_ms());
    cfg.dnd.until = until;
    cfg.dnd.choice = if until == 0 { "off".to_string() } else { choice.clone() };
    set_config(&state, cfg);
    let cfg = config(&state);
    for id in cfg.services.iter().map(|s| s.id.clone()) {
        webviews::apply_mute(&state, &cfg, &id);
    }
    let _ = app.emit("hub:dnd", json!({ "active": cfg.dnd.active(webviews::now_ms()), "until": cfg.dnd.until }));
    Ok(())
}

#[tauri::command]
pub fn unlock(app: AppHandle, state: State<'_, AppState>, pin: String) -> Result<Value, String> {
    let cfg = config(&state);
    let locked = *state.locked.lock().map_err(|e| e.to_string())?;
    if !locked {
        return Ok(json!({ "ok": true }));
    }
    let valid = match (&cfg.lock.hash, &cfg.lock.salt) {
        (Some(hash), Some(salt)) => matches_pin(&pin, hash, salt),
        _ => false,
    };
    if !valid {
        return Ok(json!({ "error": err(&state, "lock.wrong") }));
    }
    *state.locked.lock().map_err(|e| e.to_string())? = false;
    webviews::layout_views(&app, &state, &cfg);
    let _ = app.emit("hub:lock", json!({ "locked": false }));
    emit_active(&app, &state);
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub fn unlock_service(app: AppHandle, state: State<'_, AppState>, id: String, pin: String) -> Result<Value, String> {
    let cfg = config(&state);
    if !needs_code(&state, &id) {
        return Ok(json!({ "ok": true }));
    }
    let valid = cfg
        .protected
        .get(&id)
        .and_then(|entry| entry.hash.as_ref().zip(entry.salt.as_ref()))
        .map(|(hash, salt)| matches_pin(&pin, hash, salt))
        .unwrap_or(false);
    if !valid {
        return Ok(json!({ "error": err(&state, "lock.wrong") }));
    }
    if let Ok(mut set) = state.unlocked_ids.lock() {
        set.insert(id.clone());
    }
    webviews::layout_views(&app, &state, &cfg);
    emit_active(&app, &state);
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub fn protect_service(app: AppHandle, state: State<'_, AppState>, draft: Value) -> Result<Value, String> {
    let id = draft.get("id").and_then(Value::as_str).unwrap_or("").to_string();
    let enable = draft.get("enable").and_then(Value::as_bool).unwrap_or(false);
    let cfg = config(&state);
    if cfg.service(&id).is_none() {
        return Ok(json!({ "error": err(&state, "error.serviceMissing") }));
    }
    let mut cfg = cfg;
    if enable {
        let next = draft.get("next").and_then(Value::as_str).unwrap_or("");
        let confirm = draft.get("confirm").and_then(Value::as_str).unwrap_or("");
        if next.len() < 4 {
            return Ok(json!({ "error": err(&state, "lock.errorShort") }));
        }
        if next != confirm {
            return Ok(json!({ "error": err(&state, "lock.errorMismatch") }));
        }
        let salt = random_salt();
        let hash = hash_pin(next, &salt).unwrap_or_default();
        cfg.protected.insert(id.clone(), config::LockState {
            hash: Some(hash),
            salt: Some(salt),
            on_suspend: true,
            idle_minutes: 0.0,
        });
    } else {
        let code = draft.get("code").and_then(Value::as_str).unwrap_or("");
        let valid = cfg.protected.get(&id)
            .and_then(|entry| entry.hash.as_ref().zip(entry.salt.as_ref()))
            .map(|(hash, salt)| matches_pin(code, hash, salt))
            .unwrap_or(false);
        if !valid {
            return Ok(json!({ "error": err(&state, "lock.wrong") }));
        }
        cfg.protected.remove(&id);
    }
    set_config(&state, cfg);
    let cfg = config(&state);
    if let Ok(mut set) = state.unlocked_ids.lock() {
        set.remove(&id);
    }
    webviews::layout_views(&app, &state, &cfg);
    emit_active(&app, &state);
    broadcast_services(&app, &state);
    Ok(json!({ "ok": true, "protected": enable }))
}

#[tauri::command]
pub fn configure_lock(app: AppHandle, state: State<'_, AppState>, draft: Value) -> Result<Value, String> {
    let mode = draft.get("mode").and_then(Value::as_str).unwrap_or("set").to_string();
    let current = draft.get("current").and_then(Value::as_str).unwrap_or("");
    let next = draft.get("next").and_then(Value::as_str).unwrap_or("");
    let confirm = draft.get("confirm").and_then(Value::as_str).unwrap_or("");
    let mut cfg = config(&state);
    if cfg.lock.has_hash() && !matches_pin(current, cfg.lock.hash.as_deref().unwrap_or(""), cfg.lock.salt.as_deref().unwrap_or("")) {
        return Ok(json!({ "error": err(&state, "lock.errorCurrent") }));
    }
    if mode == "remove" {
        cfg.lock.hash = None;
        cfg.lock.salt = None;
        set_config(&state, cfg);
        return Ok(json!({ "ok": true }));
    }
    if next.len() < 4 {
        return Ok(json!({ "error": err(&state, "lock.errorShort") }));
    }
    if next != confirm {
        return Ok(json!({ "error": err(&state, "lock.errorMismatch") }));
    }
    let salt = random_salt();
    let hash = hash_pin(next, &salt).unwrap_or_default();
    cfg.lock.hash = Some(hash);
    cfg.lock.salt = Some(salt);
    set_config(&state, cfg);
    let _ = app;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub fn lock_now(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let cfg = config(&state);
    if !cfg.lock.has_hash() {
        return Ok(());
    }
    *state.locked.lock().map_err(|e| e.to_string())? = true;
    if let Ok(mut set) = state.unlocked_ids.lock() {
        set.clear();
    }
    webviews::layout_views(&app, &state, &cfg);
    let _ = app.emit("hub:lock", json!({ "locked": true }));
    Ok(())
}

#[tauri::command]
pub fn open_lock_setup(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let cfg = config(&state);
    let mode = if cfg.lock.has_hash() { "change" } else { "set" };
    let _ = app.emit("hub:lock-setup", json!({ "mode": mode }));
    Ok(())
}

#[tauri::command]
pub async fn set_split(app: AppHandle, window: Window, state: State<'_, AppState>, id: String) -> Result<(), String> {
    let cfg = config(&state);
    if cfg.service(&id).is_none() {
        return Err("service introuvable".to_string());
    }
    {
        let mut active = state.active_id.lock().map_err(|e| e.to_string())?;
        if active.as_deref() == Some(id.as_str()) {
            return Ok(());
        }
    }
    webviews::ensure_webview(&state.app, &window, &state, &cfg, &id)?;
    *state.split_id.lock().map_err(|e| e.to_string())? = Some(id.clone());
    webviews::layout_views(&app, &state, &cfg);
    let _ = app.emit("hub:split", json!({ "id": id }));
    Ok(())
}

#[tauri::command]
pub fn close_split(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    *state.split_id.lock().map_err(|e| e.to_string())? = None;
    let cfg = config(&state);
    webviews::layout_views(&app, &state, &cfg);
    let _ = app.emit("hub:split", json!({ "id": null }));
    Ok(())
}

#[tauri::command]
pub fn split_drag(app: AppHandle, state: State<'_, AppState>, dragging: bool) -> Result<(), String> {
    let cfg = config(&state);
    if dragging {
        if let Ok(map) = state.webviews.lock() {
            for (_, view) in map.iter() {
                let _ = view.hide();
            }
        }
    } else {
        webviews::layout_views(&app, &state, &cfg);
    }
    Ok(())
}

#[tauri::command]
pub fn set_split_ratio(app: AppHandle, state: State<'_, AppState>, ratio: Option<f64>) -> Result<(), String> {
    let mut cfg = config(&state);
    if let Some(value) = ratio {
        cfg.split_ratio = value.clamp(0.2, 0.8);
    }
    set_config(&state, cfg);
    webviews::layout_views(&app, &state, &config(&state));
    Ok(())
}

#[tauri::command]
pub fn set_modal_open(app: AppHandle, state: State<'_, AppState>, open: bool) -> Result<(), String> {
    let cfg = config(&state);
    if open {
        if let Ok(map) = state.webviews.lock() {
            for (_, view) in map.iter() {
                let _ = view.hide();
            }
        }
    } else {
        webviews::layout_views(&app, &state, &cfg);
    }
    Ok(())
}

#[tauri::command]
pub fn window_control(app: AppHandle, window: Window, _state: State<'_, AppState>, action: String) -> Result<(), String> {
    match action.as_str() {
        "minimize" => {
            let _ = window.minimize();
        }
        "maximize" => {
            if window.is_maximized().unwrap_or(false) {
                let _ = window.unmaximize();
            } else {
                let _ = window.maximize();
            }
        }
        "fullscreen" => {
            let _ = window.set_fullscreen(!window.is_fullscreen().unwrap_or(false));
        }
        "close" => {
            // Tauri port has no tray yet, so hiding the only window would leave
            // the app running with no visible surface. Quit instead.
            let _ = app.exit(0);
        }
        _ => {}
    }
    let _ = app.emit("hub:window-state", json!({
        "maximized": window.is_maximized().unwrap_or(false),
        "minimized": window.is_minimized().unwrap_or(false),
        "fullScreen": window.is_fullscreen().unwrap_or(false),
        "focused": window.is_focused().unwrap_or(false)
    }));
    Ok(())
}

#[tauri::command]
pub fn set_page(app: AppHandle, state: State<'_, AppState>, page: Option<String>) -> Result<(), String> {
    let allowed = ["home", "favorites", "settings", "help"];
    let next = page.filter(|value| allowed.contains(&value.as_str()));
    {
        if let Ok(mut cfg) = state.config.lock() {
            cfg.last_page = next.clone();
        }
    }
    config::save(&app, &state);
    let cfg = config(&state);
    if let Ok(map) = state.webviews.lock() {
        for (_, view) in map.iter() {
            if next.is_some() {
                let _ = view.hide();
            }
        }
    }
    if next.is_none() {
        webviews::layout_views(&app, &state, &cfg);
    }
    let _ = app.emit("hub:page", json!({ "page": next }));
    Ok(())
}

#[tauri::command]
pub fn nav_menu(window: Window, app: AppHandle, _state: State<'_, AppState>, rect: Value) -> Result<(), String> {
    let x = rect.get("x").and_then(Value::as_f64).unwrap_or(0.0);
    let y = rect.get("y").and_then(Value::as_f64).unwrap_or(0.0);
    let home = MenuItem::with_id(&app, "nav-home", "Home", true, None::<&str>).map_err(|e| e.to_string())?;
    let favorites = MenuItem::with_id(&app, "nav-favorites", "Favorites", true, None::<&str>).map_err(|e| e.to_string())?;
    let settings = MenuItem::with_id(&app, "nav-settings", "Settings", true, None::<&str>).map_err(|e| e.to_string())?;
    let help = MenuItem::with_id(&app, "nav-help", "Help", true, None::<&str>).map_err(|e| e.to_string())?;
    let menu = Menu::with_items(&app, &[&home, &favorites, &settings, &help]).map_err(|e| e.to_string())?;
    window
        .popup_menu_at(&menu, LogicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn service_menu(window: Window, app: AppHandle, _state: State<'_, AppState>, id: String) -> Result<(), String> {
    let prefix = format!("svc::{}::", id);
    let edit = MenuItem::with_id(&app, format!("{}edit", prefix), "Edit", true, None::<&str>).map_err(|e| e.to_string())?;
    let delete = MenuItem::with_id(&app, format!("{}delete", prefix), "Delete", true, None::<&str>).map_err(|e| e.to_string())?;
    let mute = MenuItem::with_id(&app, format!("{}mute", prefix), "Notifications", true, None::<&str>).map_err(|e| e.to_string())?;
    let sleep = MenuItem::with_id(&app, format!("{}sleep", prefix), "Sleep", true, None::<&str>).map_err(|e| e.to_string())?;
    let split = MenuItem::with_id(&app, format!("{}split", prefix), "Show on the right", true, None::<&str>).map_err(|e| e.to_string())?;
    let split_bottom = MenuItem::with_id(&app, format!("{}split-bottom", prefix), "Show below", true, None::<&str>).map_err(|e| e.to_string())?;
    let favorite = MenuItem::with_id(&app, format!("{}favorite", prefix), "Favorite", true, None::<&str>).map_err(|e| e.to_string())?;
    let open = MenuItem::with_id(&app, format!("{}open", prefix), "Open in browser", true, None::<&str>).map_err(|e| e.to_string())?;
    let menu = Menu::with_items(
        &app,
        &[&edit, &delete, &mute, &sleep, &split, &split_bottom, &favorite, &open],
    )
    .map_err(|e| e.to_string())?;
    window.popup_menu(&menu).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn dnd_menu(window: Window, app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let cfg = config(&state);
    let active = cfg.dnd.active(webviews::now_ms());
    let off = MenuItem::with_id(&app, "dnd-off", "Off", true, None::<&str>).map_err(|e| e.to_string())?;
    let m30 = MenuItem::with_id(&app, "dnd-30", "30 minutes", true, None::<&str>).map_err(|e| e.to_string())?;
    let m60 = MenuItem::with_id(&app, "dnd-60", "1 hour", true, None::<&str>).map_err(|e| e.to_string())?;
    let morning = MenuItem::with_id(&app, "dnd-morning", "Until tomorrow morning", true, None::<&str>).map_err(|e| e.to_string())?;
    let on = MenuItem::with_id(&app, "dnd-on", "Until I turn it off", true, None::<&str>).map_err(|e| e.to_string())?;
    // The menu still works without checkmarks; they would require
    // CheckMenuItem and a rebuild on state change.
    let _ = active;
    let menu = Menu::with_items(&app, &[&off, &m30, &m60, &morning, &on]).map_err(|e| e.to_string())?;
    window.popup_menu(&menu).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn settings(_app: AppHandle, state: State<'_, AppState>) -> Value {
    settings_snapshot(&_app, &state)
}

#[tauri::command]
pub fn update_settings(app: AppHandle, state: State<'_, AppState>, patch: Value) -> Value {
    let mut cfg = config(&state);
    let applied = cfg.merge(&patch);
    let theme = cfg.theme.clone();
    set_config(&state, cfg);
    let snapshot = settings_snapshot(&app, &state);
    if !applied.is_empty() {
        let _ = app.emit("hub:settings", snapshot.clone());
        if applied.iter().any(|key| key == "theme") {
            let _ = app.emit("hub:theme", json!({ "theme": theme }));
        }
    }
    json!({ "ok": true, "applied": applied, "rejected": [], "settings": snapshot })
}

#[tauri::command]
pub async fn pick_directory(state: State<'_, AppState>, purpose: String) -> Result<Value, String> {
    let path = state.app.dialog().file().blocking_pick_folder();
    match path {
        Some(file) => {
            let path_str = file.to_string();
            if purpose == "downloads" {
                let mut cfg = config(&state);
                cfg.downloads = Some(path_str.clone());
                set_config(&state, cfg);
                Ok(json!({ "ok": true, "path": path_str, "settings": settings_snapshot(&state.app, &state) }))
            } else {
                Ok(json!({ "ok": true, "path": path_str }))
            }
        }
        None => Ok(json!({ "ok": false, "canceled": true })),
    }
}
#[tauri::command]
pub fn verify_storage(state: State<'_, AppState>) -> Value {
    settings_snapshot(&state.app, &state)
}

#[tauri::command]
pub fn reset_downloads(app: AppHandle, state: State<'_, AppState>) -> Value {
    let mut cfg = config(&state);
    cfg.downloads = None;
    set_config(&state, cfg);
    let _ = app.emit("hub:settings", settings_snapshot(&app, &state));
    json!({ "ok": true, "settings": settings_snapshot(&app, &state) })
}

#[tauri::command]
pub fn open_location(state: State<'_, AppState>, kind: String) -> Value {
    let cfg = config(&state);
    let path = match kind.as_str() {
        "downloads" => cfg.downloads.clone().unwrap_or_else(default_downloads_dir),
        "data" => state.app.path().app_data_dir().unwrap_or_default().to_string_lossy().to_string(),
        "cache" => state.app.path().app_cache_dir().unwrap_or_default().to_string_lossy().to_string(),
        "install" => std::env::current_exe().ok().and_then(|p| p.parent().map(|x| x.to_string_lossy().to_string())).unwrap_or_default(),
        _ => return json!({ "ok": false, "error": err(&state, "error.locationUnknown") }),
    };
    match state.app.opener().open_path(&path, None::<&str>) {
        Ok(_) => json!({ "ok": true, "path": path }),
        Err(err) => json!({ "ok": false, "error": err.to_string() }),
    }
}

#[tauri::command]
pub fn diagnostics(state: State<'_, AppState>, options: Value) -> Value {
    let cfg = config(&state);
    let data = state.app.path().app_data_dir().unwrap_or_default().to_string_lossy().to_string();
    let cache = state.app.path().app_cache_dir().unwrap_or_default().to_string_lossy().to_string();
    let downloads = cfg.downloads.clone().unwrap_or_else(default_downloads_dir);
    let text = format!(
        "{name} {version}\nTauri v2 / system webview / Rust\n{platform} {arch} — packaged=yes\n\nconfig       {data}\ncache        {cache}\ndownloads    {downloads}\nservices     {count}\n",
        name = PRODUCT_NAME,
        version = VERSION,
        platform = std::env::consts::OS,
        arch = std::env::consts::ARCH,
        data = data,
        cache = cache,
        downloads = downloads,
        count = cfg.services.len()
    );
    // Copy-to-clipboard would require the clipboard-manager plugin. The text
    // is still returned so the renderer can put it in the diagnostics textarea
    // (and the user can copy it from there).
    let _ = options.get("copy").and_then(Value::as_bool).unwrap_or(false);
    json!({ "ok": true, "text": text })
}

#[tauri::command]
pub async fn about(state: State<'_, AppState>) -> Result<(), String> {
    let _ = state.app.dialog()
        .message(format!("{} {}\n\n{}\n\n{}", PRODUCT_NAME, VERSION, "Rust/Tauri backend", REPO_URL))
        .title("About Soocial")
        .blocking_show();
    Ok(())
}

#[tauri::command]
pub fn open_docs(state: State<'_, AppState>) -> Result<(), String> {
    state.app
        .opener()
        .open_url(format!("{}#readme", REPO_URL), None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn install_info(state: State<'_, AppState>) -> Value {
    let install_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|x| x.to_string_lossy().to_string()))
        .unwrap_or_default();
    json!({
        "installPath": install_dir,
        "version": VERSION,
        "channel": "dev",
        "architecture": std::env::consts::ARCH,
        "hasMetadata": true,
        "metadataPath": "tauri://app"
    })
}

#[tauri::command]
pub async fn service_action(app: AppHandle, window: Window, state: State<'_, AppState>, id: String, action: String) -> Result<Value, String> {
    let cfg = config(&state);
    if cfg.service(&id).is_none() {
        return Ok(json!({ "error": err(&state, "error.serviceMissing") }));
    }
    match action.as_str() {
        "reload" => {
            if let Some(view) = state.webview(&id) {
                let _ = view.eval("location.reload(); 'ok'");
            } else {
                webviews::ensure_webview(&app, &window, &state, &cfg, &id)?;
            }
            Ok(json!({ "ok": true }))
        }
        "hard-reload" => {
            if let Some(view) = state.webview(&id) {
                let _ = view.eval("location.reload(true); 'ok'");
                Ok(json!({ "ok": true }))
            } else {
                Ok(json!({ "ok": false, "error": err(&state, "overlay.sleepingTitle") }))
            }
        }
        "sleep" => {
            webviews::remove_webview(&state, &id);
            let _ = app.emit("hub:status", json!({ "id": id, "status": "hibernated", "message": null }));
            Ok(json!({ "ok": true }))
        }
        "wake" => {
            do_select(&app, &window, &state, &id)?;
            Ok(json!({ "ok": true }))
        }
        "mute" => {
            let mut cfg = config(&state);
            let current = cfg.muted.get(&id).copied().unwrap_or(false);
            cfg.muted.insert(id.clone(), !current);
            set_config(&state, cfg);
            let cfg = config(&state);
            webviews::apply_mute(&state, &cfg, &id);
            let _ = app.emit("hub:volume", json!({ "id": id, "value": services::clamp_volume(cfg.volumes.get(&id).copied(), 100.0), "muted": !current }));
            Ok(json!({ "ok": true, "muted": !current }))
        }
        "reset" => {
            webviews::remove_webview(&state, &id);
            let _ = app.emit("hub:status", json!({ "id": id, "status": "hibernated", "message": null }));
            Ok(json!({ "ok": true }))
        }
        "duplicate" => {
            let mut cfg = config(&state);
            let Some(service) = cfg.service(&id) else {
                return Ok(json!({ "error": err(&state, "error.serviceMissing") }));
            };
            let base = services::generate_id(&format!("{} 2", service.name), &cfg);
            let mut copy = service;
            copy.name = format!("{} (2)", copy.name);
            copy.id = base.clone();
            copy.partition = Some(format!("persist:{}", base));
            cfg.services.push(copy);
            if !cfg.order.contains(&base) {
                cfg.order.push(base.clone());
            }
            set_config(&state, cfg);
            broadcast_services(&app, &state);
            Ok(json!({ "ok": true, "id": base }))
        }
        "open-external" => {
            let service = cfg.service(&id).ok_or("service introuvable")?;
            state.app.opener().open_url(&service.url, None::<&str>).map_err(|e| e.to_string())?;
            Ok(json!({ "ok": true }))
        }
        _ => Ok(json!({ "error": err(&state, "error.actionUnknown") })),
    }
}

#[tauri::command]
pub fn favorite_toggle(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<Value, String> {
    let mut cfg = config(&state);
    let known = cfg.services.iter().any(|s| s.id == id);
    if !known {
        return Ok(json!({ "ok": false }));
    }
    if let Some(index) = cfg.favorites.iter().position(|entry| entry == &id) {
        cfg.favorites.remove(index);
    } else {
        cfg.favorites.push(id.clone());
    }
    set_config(&state, cfg);
    broadcast_services(&app, &state);
    Ok(json!({ "ok": true, "favorites": config(&state).favorites }))
}

#[tauri::command]
pub fn check_updates(_app: AppHandle, _state: State<'_, AppState>) -> Value {
    json!({ "state": "idle", "version": null })
}

#[tauri::command]
pub fn set_overlay_badge(_app: AppHandle, _state: State<'_, AppState>, _data_url: Option<String>, _description: Option<String>) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub fn set_tray_icon(_app: AppHandle, _state: State<'_, AppState>, _data_url: Option<String>) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub fn install_update(_app: AppHandle, _state: State<'_, AppState>) -> Result<(), String> {
    Ok(())
}

/// Handle clicks from native Tauri menus created by `service_menu`,
/// `nav_menu` and `dnd_menu`.
pub fn handle_menu_event(app: &AppHandle, id: &str) {
    if let Some(choice) = id.strip_prefix("dnd-") {
        let state = app.state::<AppState>();
        let _ = set_dnd(app.clone(), state, choice.to_string());
        return;
    }
    if let Some(page) = id.strip_prefix("nav-") {
        let state = app.state::<AppState>();
        let _ = set_page(app.clone(), state, Some(page.to_string()));
        return;
    }
    if let Some(suffix) = id.strip_prefix("svc::") {
        let Some((service_id, action)) = suffix.split_once("::") else {
            return;
        };
        let state = app.state::<AppState>();
        let window = app.get_window("main");
        match action {
            "edit" => {
                let _ = app.emit("hub:edit-service", json!({ "id": service_id }));
            }
            "delete" => {
                let _ = delete_service(app.clone(), state, service_id.to_string());
            }
            "mute" | "sleep" | "open" => {
                if let Some(window) = window {
                    let app = app.clone();
                    let action = action.to_string();
                    let service_id = service_id.to_string();
                    tauri::async_runtime::spawn(async move {
                        let state = app.state::<AppState>();
                        let _ = service_action(app.clone(), window, state, service_id, action).await;
                    });
                }
            }
            "split" | "split-bottom" => {
                if let Some(window) = window {
                    let app = app.clone();
                    let service_id = service_id.to_string();
                    if action == "split-bottom" {
                        let state = app.state::<AppState>();
                        let mut cfg = config(&state);
                        cfg.split_direction = "bottom".to_string();
                        set_config(&state, cfg);
                    }
                    tauri::async_runtime::spawn(async move {
                        let state = app.state::<AppState>();
                        let _ = set_split(app.clone(), window, state, service_id).await;
                    });
                }
            }
            "favorite" => {
                let _ = favorite_toggle(app.clone(), state, service_id.to_string());
            }
            _ => {}
        }
    }
}


