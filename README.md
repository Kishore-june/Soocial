# Soocial

One beautiful Windows window for all the web apps you keep open all day.

[![Latest release](https://img.shields.io/github/v/release/Kishore-june/Soocial)](https://github.com/Kishore-june/Soocial/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Soocial is a lightweight desktop hub for Windows. Each service (like WhatsApp, Discord, your mail, your calendar) runs in its own isolated session, side by side in a single window, with native notifications and unread counters. 

Say goodbye to hunting for the right browser tab.

## Why Soocial?

**1. End Tab Overload:**
Your most important apps end up scattered across fifty browser tabs. Soocial pins them in a sidebar. One click (or `Ctrl+1` to `Ctrl+9`), and you are there.

**2. Isolated Sessions (Multiple Accounts):**
A normal browser only keeps one WhatsApp Web session alive at a time. Soocial gives every service its own isolated session! This means three WhatsApp accounts on three different numbers can stay signed in together, right next to two Discord accounts. They never sign each other out.

## Key Features

- **Isolated Sessions:** Cookies, storage, and logins never mix.
- **Native Notifications:** Windows notifications with per-service mute (sound included).
- **Volume Mixer:** A volume level per service, with a mixer panel and a master level.
- **Do Not Disturb:** Silence everything for 30 minutes, 1 hour, or until tomorrow morning.
- **Split View:** View two services side by side or stacked, with a draggable divider.
- **App Lock:** Secure your apps with a pin code (globally or per-service).
- **Resource Management:** Per-service sleep to free memory, manual or automatic.

## Installation

1. Go to the [Releases page](https://github.com/Kishore-june/Soocial/releases).
2. Download the latest `Soocial Setup.exe`.
3. Run the installer. On the first launch, pick your language (English, French, or Spanish) and the services you want to use.

*(Note: Uninstalling safely removes the folder, shortcuts, and registry entries without touching your personal files).*

## Keyboard Shortcuts

| Keys | Action |
| ---- | ------ |
| `Ctrl+1` to `Ctrl+9` | Switch to the Nth service |
| `Ctrl+N` | Add a service |
| `Ctrl+R` | Reload the active service |
| `Ctrl+M` | Open the volume mixer |
| `Ctrl+D` | Toggle do not disturb |
| `Ctrl+L` | Lock Soocial (once a code is set) |
| `Ctrl+Q` | Quit (the close button only hides to the tray) |
| `Alt` | Show the menu bar |

## Build from Source (For Developers)

Requires **Node.js 20+**.

```bash
# Install dependencies
npm install

# Run in development mode
npm start

# Build the Windows installer (creates an .exe in /dist)
npm run build
```

## License

[MIT](LICENSE)
