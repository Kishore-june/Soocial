# Soocial on Tauri v2

This directory is the **Tauri v2 port** of the Electron/Node.js shell. The goal
was to keep the existing dashboard UI and its logic as close to the original as
possible while moving persistent state, config, service CRUD, PIN hashing and
the service-view lifecycle into Rust.

## Why Tauri

- **RAM first.** The desktop shell no longer carries a full Node.js/Chromium
  main process. The window runs one system webview (WebView2 / WKWebView /
  WebKitGTK) plus the Rust binary. Electron's `WebContentsView` per service was
  replaced with one Tauri child webview per service; background services can be
  slept to release their webview (the original app did the same).
- The frontend design is untouched: `renderer/*.html`, `renderer/*.css`,
  `renderer/*.js` are reused verbatim.
- The preload bridge is re-created by `bridge.js`, which exposes the exact
  `window.hub` surface the renderer already uses.

## Layout

```
package.json                  # npm scripts: tauri:dev / tauri:build
bridge.js                     # window.hub -> Tauri invoke/listen bridge
renderer/                     # unchanged Electron-era UI
src-tauri/
  Cargo.toml
  tauri.conf.json             # Tauri v2 config
  capabilities/main.json      # permissions for the main window
  catalog-data.json           # generated copy of catalog.js (embedded in Rust)
  ui/                         # copied renderer + assets + bridge.js for Tauri dist
  src/
    lib.rs                    # builder, plugin + command registration
    commands.rs               # all hub commands
    config.rs                 # JSON config state (electron-store compatible)
    services.rs               # service CRUD, URL normalisation, PIN helpers
    webviews.rs               # Window::add_child service views + layout
    i18n.rs                   # embeds locales/en|fr|es.json
    scripts.rs                # in-page volume/notification patches
    state.rs                  # shared AppState
scripts/sync-tauri-ui.mjs     # refresh src-tauri/ui from renderer/assets/bridge.js
```

## Run it

Prerequisites: Rust, platform webview (WebView2 on Windows, WebKitGTK on Linux,
WKWebView on macOS), Node.

```bash
npm install
npm run tauri:dev
```

The first launch shows the same onboarding. Config is stored in the same
`userData` directory used by the Electron app (`soocial` under
`APPDATA`/`Application Support`/`XDG_CONFIG_HOME`) as `config.json`, in the same
camelCase shape Electron `electron-store` wrote, so settings and services carry
over from an existing install.

After changing `renderer/`, `assets/` or `bridge.js`, refresh the bundled copy:

```bash
npm run sync:ui
```

## What moved to Rust

| Feature                                  | Electron / Node.js                                      | Tauri v2 / Rust                                        |
| ---------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------ |
| Service storage                          | `electron-store` (`config.json`)                        | `config.rs` JSON store in app config dir               |
| Service CRUD / onboarding / order        | IPC handlers in `main.js`                               | `commands::{save_service, delete_service, ...}`        |
| Service isolation view                   | `WebContentsView` + `session.fromPartition`             | `Window::add_child` child webview per service          |
| PIN hashing                             | `crypto.scryptSync(pin, salt, 32)`                      | `scrypt` crate with the same parameters                |
| DND timeout                             | `dnd.js`                                                | `services::dnd_compute`                                |
| Volume / mute patch                     | `audio.js` + `notificationPatch`                        | `scripts.rs` (same JS injected into the service page)  |
| Settings snapshot                       | `settingsSnapshot()`                                    | `commands::settings_snapshot`                           |
| Diagnostics / paths                     | `app.getPath()` / `storageLayout`                       | `dirs`, `std::env::current_exe`, app data dirs          |

## Known Tauri limitations (graceful fallbacks)

These Electron features cannot be reproduced exactly on Tauri without native
plugins. The bridge keeps the calls but the Rust side returns a no-op or a
safe fallback so the UI never crashes.

- **Native context menus.** `service_menu`, `dnd_menu` and `nav_menu` are
  implemented with Tauri's built-in `Menu`/`Window::popup_menu` API. The item
  labels in this first pass are English; they can be localised from the same
  dictionaries later.
- **Tray icon / overlay badge.** No system tray yet; `set_tray_icon` and
  `set_overlay_badge` are stubs. Because there is no tray, the titlebar Close
  quits immediately instead of hiding to the tray.
- **Per-real-page favicon resolution.** `hub:catalog-icon` / per-service favicon
  events are not yet re-implemented; the renderer falls back to coloured
  initials (it already handles that case).
- **electron-updater / Microsoft Store channels.** `check_updates` returns
  `state: "idle"`; OS-managed updates are the intended Tauri path.
- **Autostart settings** are persisted in `config.json` but not yet registered
  with the OS. A future `tauri-plugin-autostart` or Windows StartupTask should
  be wired here.
- **Session per service in the system webview.** Tauri does not expose Chromium
  style persistent partitions. Each service still gets its own webview, but
  session isolation depends on the OS webview profile rather than the Electron
  `persist:<id>` partition. Sleeping/recreating a service is the recommended way
  to reset a session until a profile-aware plugin is added.

## Plumbing notes

- `frontendDist` points at `src-tauri/ui`, a small copy of the renderer,
  assets and `bridge.js`. This is necessary because the historical renderer
  uses `../assets/...` relative paths; it also keeps `node_modules`, `src-tauri`
  source and the `.git` directory out of the production bundle. Run
  `npm run sync:ui` after editing the live `renderer/`/`assets/`/`bridge.js`.
- Commands that create a service webview (`select`, `retry`, `service_action`,
  `set_split`, `onboard_complete`) are `async` on purpose: Tauri's
  `WebviewBuilder::new` deadlocks if called from a synchronous command or a
  synchronous event handler on Windows.
- `Window::add_child` is behind Tauri's `unstable` feature. On Windows there is a
  known z-order issue where a new child webview can render behind the main
  dashboard webview; the port keeps the dashboard webview visible and relies on
  `layout_views` to size/hide children, but a small Window z-order tweak may be
  needed for a production Windows build.
- Child webview positions are re-applied from `tauri::WindowEvent::Resized` /
  `ScaleFactorChanged` in `lib.rs`, because Tauri's manual child bounds do not
  reliably survive maximize/restore on Windows.
