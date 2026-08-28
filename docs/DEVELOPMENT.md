# Development notes

Everything a contributor needs: how the app is put together, the decisions
that are not obvious from the code, and the traps we already fell into so you
do not have to.

## Layout

```
main.js            main process: window, sessions, views, menus, IPC
preload.js         contextBridge surface (window.hub), the only renderer API
renderer/          the sidebar UI: vanilla HTML/CSS/JS, no framework
services.js        shared constants (Chrome UA string, per-service defaults)
catalog.js         the "known services" list offered in the add form
catalog-icons.js   fetching and caching of catalogue logos
images.js          image format sniffing and ICO/WebP helpers
i18n.js            translations, loaded in the main process only
locales/           en.json (reference), fr.json, es.json
assets/            app icon used at runtime (brand sources in assets/brand)
installer/         electron-builder buildResources: exe icon, installer artwork,
                   custom.nsh (the install-location page and everything it guards)
shared/            policy both processes read, never a copy of it:
                   path-rules.js      what a folder may be (resolveTargetDirectory,
                                      classifyTarget, validation, MAX_PATH)
                   install-metadata.js the install.json contract, including how to
                                      rescue a truncated one
                   installer-codes.js the exit codes NSIS returns and what they mean
                   product.js         names, registry key, file names
                   layout-metrics.js  sidebar/title-bar/split geometry, once
main/              the installer's counterparts inside the app:
                   install-layout.js  reads install.json, checks the running path
                   storage-layout.js  resolves data/cache roots before app.whenReady
                   downloads.js       the user-chosen download folder, with a write
                                      test and unique file names
                   migrate-legacy.js  moves an old Nexus profile to Soocial
renderer/          + glass.css (design tokens), titlebar.js, pages.js (settings
                   panel), sidebar.js
test/              run.mjs (npm test), run-ui.mjs (npm run test:ui), path rules,
                   metadata, installer contract, CDP suites, installer/compile-check.sh
```

The window is a `BrowserWindow` whose own webContents renders the sidebar.
Each service is a `WebContentsView` laid over the content area, offset by the
sidebar width. Only the active view is visible, plus a second one on the
right half when split view is on. Security settings are the same everywhere:
`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.

The service list itself lives in `config.json`
(`%APPDATA%\Soocial\config.json`), not in code. It is created by the first-run
onboarding and edited from the app.

## Install location, and why the app does not live with your data

`C:\Program Files\Soocial` is the default; an advanced page lets the user pick
any parent folder and the app lands in `<parent>\Soocial`. That is a product
requirement, not an installer cosmetic, so the rule is written once, in
`shared/path-rules.js`, and read from both sides: `installer/custom.nsh` (which
cannot import JavaScript, and is therefore checked against the same table by
`test/installer-script.mjs`) and `main/install-layout.js`.

The split that makes a custom path safe:

| What | Where | Why there |
| --- | --- | --- |
| program files | the chosen folder | an update patches it in place |
| settings, logins, sessions | `%APPDATA%\Soocial` | survives uninstall, move, reinstall |
| HTTP/GPU cache | `%LOCALAPPDATA%\Soocial` | disposable, never roams |
| downloads | user's choice, default `%USERPROFILE%\Downloads\Soocial` | the user's file, not the app's |

Two records sit next to the exe: `install.json` (read by the app: path,
version, channel, `installationId`, `firstInstall`, shortcuts, `verified`) and
`install.ini` (read by NSIS, which can parse nothing else). The `.ini` is what
lets an update keep `firstInstall` instead of resetting it.

Never fall back to `C:` silently. A fallback in a script is a wrong install
nobody notices, and the uninstaller would then be pointed at the wrong folder.
When a path is refused, the installer exits with the number from
`shared/installer-codes.js` and says which rule refused it.

The uninstaller may only remove a folder named `Soocial` that contains our own
markers. Anything else: it removes shortcuts and registry entries, leaves every
file alone, and exits 1605. That is why `D:\Apps\Photoshop` is still there
after Soocial is uninstalled from `D:\Apps`.

## Sessions

Every service gets `session.fromPartition('persist:<id>')`. Different
partitions mean fully separate cookies, localStorage, IndexedDB and service
workers. That is the core feature: several accounts of the same site stay
signed in at once.

Two related details:

- The `persistent-storage` permission is granted. Without it Chromium may
  evict a site's IndexedDB under disk pressure, which signs the account out.
- `backgroundThrottling: false` on every view, otherwise Chromium throttles
  timers and WebSockets of hidden views and background services miss their
  notifications.

## WhatsApp and the User-Agent

WhatsApp Web rejects browsers whose User-Agent contains "Electron". Services
flagged `spoofUserAgent` get a standard Chrome desktop UA, applied both as
the session UA and in `onBeforeSendHeaders`. The `sec-ch-ua*` Client Hint
headers are stripped as well, because they reveal Electron even when the UA
string is clean.

## Notifications and mute

Muting a service has to close four doors, not one:

1. `window.Notification`, wrapped inside the page via `executeJavaScript`
   (a preload cannot touch the page's `window` under contextIsolation).
2. `ServiceWorkerRegistration.showNotification`, wrapped the same way.
3. The Chromium permission itself, denied while muted, which covers push
   events handled entirely inside the service worker.
4. Page audio. WhatsApp plays its chime itself through the audio API, outside
   the notification system entirely, so mute also calls `setAudioMuted`.
   Consequence: a muted service is silent during calls too.

The wrapper is installed on `dom-ready`, before the site keeps a reference to
the native constructor. After that only a flag flips, so mute is instant.

## Unread badges

The only reliable, stable source is the page title: `(3) WhatsApp`,
`(1) Discord`. Parsing the DOM instead would break at every redesign. Keep in
mind that the number means whatever the service wants it to mean: WhatsApp
counts unread conversations, not messages.

A title with a marker but no number (`• Discord`) shows a dot badge. Totals
are drawn on canvas in the renderer and pushed to the taskbar overlay icon
and to the tray icon (Windows has no `setBadgeCount`).

## Sleep (hibernation)

A sleeping service is destroyed: its Chromium process is gone and so are its
badges and notifications until it is reopened. That is the honest trade-off;
a service that notifies is a service that runs. The auto-sleep countdown
starts when a service leaves the foreground and is cancelled when it comes
back. Do not rearm it on every service switch or nothing ever sleeps for an
active user. A service shown in the right half of split view counts as
foreground: visible services never sleep.

## Split view

`splitId` designates a second service laid beside (or below) the active one;
`activeId` keeps the first part and stays "the active service" everywhere
else (shortcuts, badges, menus). Clicking the tile of the service already
split swaps the two parts instead of showing it twice. Direction and ratio
are persisted along with the pair, and split closes itself when its service
is deleted.

The 6px band between the two views is not covered by any native layer, so
the sidebar's own webContents shows through and receives the mouse: that is
the draggable divider. During a drag the views are hidden and the renderer
draws two placeholder panes instead, because native views would swallow the
mouse the moment the pointer crossed them; the real views come back on
release. Main broadcasts the current layout (`hub:layout`) so the renderer
can place the divider and size the code screen of a protected service to the
active part only.

## App lock

A lock screen in the sidebar renderer covers the whole window while every
`WebContentsView` is hidden (they are native layers: anything drawn by the
renderer would stay under them). The code is stored as scrypt hash + salt in
the config, verified in the main process only. While locked, service
switching and app shortcuts are ignored.

Be honest about what this is: a privacy screen, not encryption. The sessions
on disk stay readable outside Soocial. A forgotten code is removed by deleting
the `lock` section from `%APPDATA%\Soocial\config.json`; services stay signed
in. Auto-lock listens to `powerMonitor` (`lock-screen`, `suspend`) and polls
`getSystemIdleTime` every 30 s for the idle timeout, because idleness is not
an event.

A single service can also be locked on its own, from a button in its edit
form, and each protected service carries its OWN code, unrelated to the app
code and to other services. The toggle is a proof, not a checkbox: enabling
creates the service's code (two entries), disabling asks for that code and
deletes it, so re-enabling starts over with a fresh code. Both paths land
back on the form, and nothing flips on a wrong code.

A protected service keeps loading in the background, badges and
notifications included; only its view stays hidden behind a code screen
sized to its part of the window, sidebar still usable. The code is asked at
every opening: leaving the service (switch, split closed, sleep, app lock)
re-arms it. The only exception is the service you are looking at when you
enable the option, which never locks itself under your eyes.

## Spell checking

Chromium's own spell checker, enabled per session. Languages follow the
interface language plus English, filtered by
`availableSpellCheckerLanguages`; dictionaries are downloaded on demand into
the profile. Suggestions live in a context menu attached to each view, shown
only in editable fields: elsewhere many web apps (Discord, Notion) draw
their own menu and a second one on top would be noise. Menu actions call
`wc.cut()` and friends explicitly rather than menu roles, because a role
targets the focused webContents, not necessarily the one that was clicked.

## Start with Windows

`app.setLoginItemSettings`, applied only when packaged (in dev it would
register electron.exe). The "start hidden" option passes `--hidden`, which
skips the initial `show()` and leaves the app in the tray; a saved maximized
state is applied on the first real show, because `maximize()` would reveal
the window.

## Icons

Priority for a service icon: user-picked image, then `icon` declared on the
service, then the site favicon, then coloured initials. Favicons are compared
by real pixel size, not file size, and the best score is kept for the whole
page load because sites announce several favicons in no particular order
(Discord announces its vector icon first, then a 16px canvas version with an
unread counter drawn in).

Catalogue logos are fetched from each service's site (apple-touch-icon, the
DuckDuckGo icon service, favicon.ico, then the root domain as fallback),
cached in `%APPDATA%\Soocial\catalog-icons.json` and refreshed monthly.
Prefetch starts right after launch so the grid is warm before the add form
ever opens. Nothing is bundled: bundled logos go stale.

The cache key is the domain, except for entries with a declared `icon`
source, which get their own key. Gmail and Google Chat both live on
mail.google.com; a shared key made Gmail wear the Chat logo. The cache file
carries a version number: bump it when fetching logic changes, or wrong
entries survive for a month. Declared sources also cover services whose
detectable icons are 32px, too soft for a 44px tile on a HiDPI screen.

Hard-earned lessons encoded in `images.js`:

- Sniff formats from magic bytes; servers lie about content types.
- A single-page app answers 200 with its `index.html` on any unknown path,
  so an "icon" that starts with `<` may be a web page, not SVG.
- WhatsApp serves its favicon as WebP, which `nativeImage` cannot measure;
  the dimensions are read from the RIFF header directly.
- A `.ico` is a container with the same icon at many sizes. Keep the smallest
  frame that is large enough (128px), not the whole file.

## i18n

English is the reference locale and the fallback. The main process alone
reads `locales/*.json`; the sandboxed renderer receives the resolved
dictionary at bootstrap. Static labels carry `data-i18n` attributes filled
before first paint. Language lives under File in the menu bar, is chosen
during onboarding, and switches live: menus and tray are rebuilt, the
sidebar re-translates in place, services are untouched.

To add a language: copy `locales/en.json`, translate, add the code to
`AVAILABLE` in `i18n.js` and its native name to `LANGUAGE_NAMES` in
`main.js`.

## Updates and releases

`electron-updater` checks GitHub Releases at startup and every four hours,
downloads in the background, and installs only on explicit user action.

```bash
npm version patch
set GH_TOKEN=<token with repo scope>
npm run release
```

`npm run build` stays local. The `.blockmap` next to the installer enables
differential updates and must ship with every release. The app is not code
signed, so updates are not signature-verified: anyone controlling the
repository could push a version. Known trade-off of unsigned distribution.

## Packaging

`build.files` in `package.json` is include-everything with targeted
exclusions. It used to be a whitelist of filenames, and two installers
shipped without newly added modules and died on startup. New files must ship
by default. After touching packaging, do not trust a green build: run
`dist/win-unpacked/Soocial.exe` with a scratch `--user-data-dir` and check that
it creates its profile.

Wine is not a substitute: `npm run build` on Linux finishes (makensis runs
natively, and electron-builder's one wine call - extracting the uninstaller stub -
works with `wine32:i386` installed), but *running* the produced
`Soocial Setup …​.exe` under wine exits with code 2 having created the folder and
copied nothing. A control build with `nsis.include` removed fails identically, so
this is electron-builder's payload extraction under wine, not `custom.nsh`. The
install/uninstall lifecycle therefore has to be run on Windows: that is what
`test/installer/verify-install.ps1` and the `windows` job in
`.github/workflows/ci.yml` are for. What wine did prove is recorded in
docs/INSTALLATION.md: validation runs before anything is written, a refused
folder returns its exit code, and no sibling file is touched.

Related trap: electron-builder silently excludes the `buildResources`
directory from the packaged app. It once pointed at `assets/`, so the
installer built fine and the app ran, but `assets/icon.ico` did not exist at
runtime: blank tray icon, no logo on the onboarding and lock screens. Hence
the split: `assets/` ships with the app, `installer/` (buildResources) feeds
electron-builder only, and the icon exists in both.

## UI testing

Every CDP suite drives a running instance through the Chrome DevTools
Protocol (no dependency; on Node < 22 the launcher adds
`--experimental-websocket` because `WebSocket` is not a global yet). Run them
through the launcher, which does the other half of the job:

```bash
npm run test:ui          # boots the app, waits for the port, runs every ui suite
HUB_UI_PROFILE=/tmp/p npm run test:ui   # same, but keep the profile to inspect it
node test/ui-glass.mjs 9224             # one suite, against an instance you started
```

`test/run-ui.mjs` starts the app on a **free port** (a fixed one collides with a
lingering instance, and the resulting "cannot start http server for devtools"
reads like a regression) and inside a **throwaway profile**, so a run never
inherits the services, lock code or theme of the last one. The order of the
files is explicit, not alphabetical: `ui-lock.mjs` starts from an empty profile
and verifies the onboarding, so it goes first; the others create what they need.

What they cover: `ui-lock.mjs` the whole lock journey (onboarding, protecting a
service from its form, wrong and right codes, global lock, re-arming after
unlock); `ui-glass.mjs` the title bar, the settings panel, the glass tokens and
the reduced-motion switch, with real clicks on real buttons; `ui-volume.mjs`
the tile badge, the wheel and the mixer panel; `audio-volume.mjs` the audio
graph itself.

Three harness limits to know:

- CDP-injected keystrokes never reach `before-input-event`, so app shortcuts
  (Ctrl+L, Ctrl+digit) cannot be tested this way - the tests call the same
  action through IPC instead.
- `ui-lock.mjs` clicks catalogue tiles by index and deliberately avoids
  Discord, which triggers a Windows passkey prompt on some machines.
- Under `xvfb` there is no window manager, so a `minimize()` never reports
  `isMinimized()`. Those suites assert the payload shape, not the state. And
  on Linux they prove the DOM, the IPC and the CSS - never Windows behaviour.

`npm test` skips CDP suites unless a debug port is advertised
(`HUB_CDP_PORT`), so the headless half stays fast and green on its own.

## Development tips

- **Isolated profile.** Dev and the installed app share `%APPDATA%\Soocial`
  and a single-instance lock. Use
  `npx electron . --user-data-dir="%TEMP%\soocial-test"` for a scratch profile;
  it is also the only way to test onboarding without wiping your real config.
- **`ELECTRON_RUN_AS_NODE`.** Some IDE terminals export it. Electron then
  boots as plain Node, `require('electron')` returns no API and the app dies
  on the first `app.` call (or the packaged exe rejects Chromium flags with
  "bad option"). Unset it.
- **App identity.** The AppUserModelID differs between dev and packaged
  (`com.mehdi.soocial.dev` vs `com.mehdi.soocial`). Windows resolves that ID to a
  Start Menu shortcut and borrows its icon and label for the taskbar; when
  both claimed the same ID, the stray dev shortcut hijacked the installed
  app's identity.
- **Menu accelerators.** App shortcuts are handled in `before-input-event`
  on the sidebar and on every service view. Menu items display their shortcut
  with `registerAccelerator: false`; otherwise each keypress fires twice.
- **Keyboard layouts.** Match digits on `input.code` (`Digit1`..`Digit9`),
  never on `input.key`: an AZERTY top row produces `& é "` without Shift, so
  `Ctrl+1` never carries the character "1". And ignore events with
  `input.alt` set, because AZERTY's AltGr arrives as Ctrl+Alt and typing
  `~ # { [` inside a service would trigger the shortcuts.
- **Native layers win.** A `WebContentsView` sits above the page, so nothing
  the sidebar draws can overlap it. Tooltips are native `title` attributes,
  and the active view is hidden while the add form is open.

## Troubleshooting

**WhatsApp shows "browser not supported".** The UA spoof is on for flagged
services; if WhatsApp tightens the check, bump the Chrome version in
`CHROME_UA` (`services.js`), clear the partition under
`%APPDATA%\Soocial\Partitions`, and reload.

**Two accounts sign each other out.** Their services share a partition. This
cannot happen through the app (each new service gets its own); it only
happens after hand-editing `config.json`.

**No Windows notifications.** Check the site's own notification setting
first, then Windows Settings > Notifications, then that the app was quit
rather than hidden to the tray. In dev, toasts may show "Electron" as the
sender; the installed app shows Soocial.

**A service hangs on loading.** Fifteen-second timeout, then a Retry button.
`Ctrl+Shift+I` opens the service devtools to see the real error.
