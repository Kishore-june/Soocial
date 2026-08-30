use crate::config::Config;
use crate::scripts;
use crate::services;
use crate::state::AppState;
use serde_json::json;
use tauri::{
    Emitter, LogicalPosition, LogicalSize, Manager, Webview, WebviewBuilder, WebviewUrl, Window,
};

pub const SIDEBAR_WIDTH: f64 = 72.0;
pub const SIDEBAR_WIDTH_COLLAPSED: f64 = 60.0;
pub const TITLEBAR_HEIGHT: f64 = 40.0;
pub const SPLIT_GAP: f64 = 6.0;

/// Create (or reuse) the child webview for a service and position it over the
/// dashboard's content area. This is the Rust replacement for Electron's
/// `WebContentsView`.
pub fn ensure_webview(
    app: &tauri::AppHandle,
    window: &Window,
    state: &AppState,
    config: &Config,
    id: &str,
) -> Result<Webview, String> {
    if let Some(view) = state.webview(id) {
        return Ok(view);
    }

    let service = config
        .service(id)
        .ok_or_else(|| format!("service introuvable: {}", id))?;
    let url = url::Url::parse(&service.url)
        .map_err(|err| format!("URL invalide: {}", err))?;
    let label = format!("svc-{}", id);

    let mut builder = WebviewBuilder::new(label, WebviewUrl::External(url));
    if service.spoof_user_agent {
        builder = builder.user_agent(services::CHROME_UA);
    }

    let app_handle = app.clone();
    let service_id = id.to_string();
    builder = builder.on_document_title_changed(move |_webview, title| {
        let count = parse_badge(&title);
        let _ = app_handle.emit(
            "hub:badge",
            json!({ "id": service_id, "count": count }),
        );
    });

    let (position, size) = content_rect(window, config);
    let view = window
        .add_child(builder, position, size)
        .map_err(|err| err.to_string())?;

    if let Ok(mut map) = state.webviews.lock() {
        map.insert(id.to_string(), view.clone());
    }
    Ok(view)
}

pub fn remove_webview(state: &AppState, id: &str) {
    if let Some(view) = state.webviews.lock().ok().and_then(|mut map| map.remove(id)) {
        let _ = view.close();
    }
}

pub fn destroy_all(state: &AppState) {
    if let Ok(mut map) = state.webviews.lock() {
        for (_, view) in map.drain() {
            let _ = view.close();
        }
    }
}

/// Position and size of the content area in logical (CSS) pixels.
pub fn content_rect(window: &Window, config: &Config) -> (LogicalPosition<f64>, LogicalSize<f64>) {
    let scale = window.scale_factor().unwrap_or(1.0);
    let inner = window.inner_size().unwrap_or(tauri::PhysicalSize::new(0, 0));
    let width = inner.width as f64 / scale;
    let height = inner.height as f64 / scale;
    let sidebar = if config.sidebar_collapsed {
        SIDEBAR_WIDTH_COLLAPSED
    } else {
        SIDEBAR_WIDTH
    };
    (
        LogicalPosition::new(sidebar, TITLEBAR_HEIGHT),
        LogicalSize::new((width - sidebar).max(0.0), (height - TITLEBAR_HEIGHT).max(0.0)),
    )
}

/// Position every live webview. Only the active service and (optionally) the
/// split service are shown; background services are hidden instead of destroyed
/// so that their sessions stay warm.
pub fn layout_views(app: &tauri::AppHandle, state: &AppState, config: &Config) {
    if let Some(window) = app.get_window("main") {
        let scale = window.scale_factor().unwrap_or(1.0);
        let inner = window.inner_size().unwrap_or(tauri::PhysicalSize::new(0, 0));
        let width = inner.width as f64 / scale;
        let height = inner.height as f64 / scale;
        let sidebar = if config.sidebar_collapsed {
            SIDEBAR_WIDTH_COLLAPSED
        } else {
            SIDEBAR_WIDTH
        };
        let area_width = (width - sidebar).max(0.0);
        let area_height = (height - TITLEBAR_HEIGHT).max(0.0);

        let split_id = state.split_id.lock().ok().and_then(|value| value.clone()).flatten();
        let active_id = state.active_id.lock().ok().and_then(|value| value.clone()).flatten();
        let ratio = config.split_ratio.clamp(0.2, 0.8);
        let split_bottom = config.split_direction == "bottom";
        let split_active = split_id.is_some();

        let active_bounds = if split_active && split_bottom {
            let top = ((area_height - SPLIT_GAP) * ratio).floor();
            (
                LogicalPosition::new(sidebar, TITLEBAR_HEIGHT),
                LogicalSize::new(area_width, top),
            )
        } else if split_active {
            let left = ((area_width - SPLIT_GAP) * ratio).floor();
            (
                LogicalPosition::new(sidebar, TITLEBAR_HEIGHT),
                LogicalSize::new(left, area_height),
            )
        } else {
            (
                LogicalPosition::new(sidebar, TITLEBAR_HEIGHT),
                LogicalSize::new(area_width, area_height),
            )
        };

        let split_bounds = if split_active && split_bottom {
            let top = ((area_height - SPLIT_GAP) * ratio).floor() + SPLIT_GAP;
            (
                LogicalPosition::new(sidebar, TITLEBAR_HEIGHT + top),
                LogicalSize::new(area_width, area_height - top),
            )
        } else if split_active {
            let left = ((area_width - SPLIT_GAP) * ratio).floor() + SPLIT_GAP;
            (
                LogicalPosition::new(sidebar + left, TITLEBAR_HEIGHT),
                LogicalSize::new(area_width - left, area_height),
            )
        } else {
            (LogicalPosition::new(0.0, 0.0), LogicalSize::new(0.0, 0.0))
        };

        if let Ok(map) = state.webviews.lock() {
            for (id, view) in map.iter() {
                let is_active = active_id.as_deref() == Some(id.as_str());
                let is_split = split_id.as_deref() == Some(id.as_str());
                let should_show = !state.locked.lock().map(|v| *v).unwrap_or(false)
                    && (is_active || is_split);
                let (position, size) = if is_split {
                    (&split_bounds.0, &split_bounds.1)
                } else {
                    (&active_bounds.0, &active_bounds.1)
                };
                if should_show {
                    let _ = view.set_position(position.clone());
                    let _ = view.set_size(size.clone());
                    let _ = view.show();
                } else {
                    let _ = view.hide();
                }
            }
        }

        let divider = if split_active {
            Some(if split_bottom {
                json!({ "orientation": "h", "pos": (area_height - SPLIT_GAP) * ratio })
            } else {
                json!({ "orientation": "v", "pos": (area_width - SPLIT_GAP) * ratio })
            })
        } else {
            None
        };

        let _ = app.emit(
            "hub:layout",
            json!({
                "active": { "width": active_bounds.1.width, "height": active_bounds.1.height },
                "divider": divider,
                "origin": { "x": sidebar, "y": TITLEBAR_HEIGHT },
                "sidebar": sidebar,
                "titlebar": TITLEBAR_HEIGHT,
            }),
        );
    }
}

pub fn apply_volume(state: &AppState, config: &Config, id: &str) {
    let level = services::effective_level(config, id);
    if let Some(view) = state.webview(id) {
        let _ = view.eval(&scripts::volume_patch(level));
    }
}

pub fn apply_mute(state: &AppState, config: &Config, id: &str) {
    let muted = config.muted.get(id).copied().unwrap_or(false) || config.dnd.active(now_ms());
    if let Some(view) = state.webview(id) {
        let muted = muted;
        let _ = view.eval(&scripts::notification_patch(muted));
    }
}

pub fn parse_badge(title: &str) -> i64 {
    if let Some(open) = title.find('(') {
        if let Some(close) = title[open..].find(')') {
            let inner = &title[open + 1..open + close];
            if let Ok(count) = inner.parse::<i64>() {
                return count;
            }
        }
    }
    if title.trim_start().starts_with('•') || title.trim_start().starts_with('●') || title.trim_start().starts_with('*') {
        -1
    } else {
        0
    }
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
