mod catalog;
mod commands;
mod config;
mod i18n;
mod scripts;
mod services;
mod state;
mod webviews;

use state::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .on_menu_event(|app_handle, event| {
            commands::handle_menu_event(app_handle, event.id().0.as_ref());
        })
        .on_window_event(|window, event| {
            use tauri::WindowEvent;
            let app = window.app_handle();
            let state = app.state::<AppState>();
            let geometry_changed =
                matches!(event, WindowEvent::Resized(_) | WindowEvent::Moved(_) | WindowEvent::ScaleFactorChanged { .. });
            if geometry_changed {
                if let Ok(mut cfg) = state.config.lock() {
                    if let Ok(inner) = window.inner_size() {
                        cfg.window.width = inner.width as f64;
                        cfg.window.height = inner.height as f64;
                    }
                    if let Ok(outer) = window.outer_position() {
                        cfg.window.x = Some(outer.x as f64);
                        cfg.window.y = Some(outer.y as f64);
                    }
                    cfg.window.maximized = window.is_maximized().unwrap_or(false);
                }
                config::save(app, &state);
            }
            if matches!(event, WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. }) {
                commands::relayout(app, &state);
            }
        })
        .setup(|app| {
            let config = config::load();
            let state = AppState::new(app.handle().clone(), config);

            if let Some(window) = app.get_webview_window("main") {
                if let Ok(cfg) = state.config.lock() {
                    if cfg.window.width > 0.0 && cfg.window.height > 0.0 {
                        let _ = window.set_size(tauri::LogicalSize::new(cfg.window.width, cfg.window.height));
                    }
                    if let (Some(x), Some(y)) = (cfg.window.x, cfg.window.y) {
                        let _ = window.set_position(tauri::LogicalPosition::new(x, y));
                    }
                    if cfg.window.maximized {
                        let _ = window.maximize();
                    }
                }
            }

            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::bootstrap,
            commands::select,
            commands::retry,
            commands::save_service,
            commands::delete_service,
            commands::onboard_complete,
            commands::set_language,
            commands::reorder,
            commands::set_volume,
            commands::set_master_volume,
            commands::set_dnd,
            commands::unlock,
            commands::unlock_service,
            commands::protect_service,
            commands::configure_lock,
            commands::lock_now,
            commands::open_lock_setup,
            commands::set_split,
            commands::close_split,
            commands::split_drag,
            commands::set_split_ratio,
            commands::set_modal_open,
            commands::window_control,
            commands::set_page,
            commands::nav_menu,
            commands::service_menu,
            commands::dnd_menu,
            commands::settings,
            commands::update_settings,
            commands::pick_directory,
            commands::verify_storage,
            commands::reset_downloads,
            commands::open_location,
            commands::diagnostics,
            commands::about,
            commands::open_docs,
            commands::install_info,
            commands::service_action,
            commands::favorite_toggle,
            commands::check_updates,
            commands::set_overlay_badge,
            commands::set_tray_icon,
            commands::install_update,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Soocial on Tauri");
}
