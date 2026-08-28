# Installation on Windows

Choosing a folder is a supported install location, not a power-user option.
Everything below describes what the installer, the updater and the uninstaller
do with the path you picked, and how to verify each of those behaviours.

Two rules govern the whole feature:

1. **The chosen path is authoritative.** Once accepted, it is used by every
   later stage: shortcuts, registry, updater, uninstaller. Nothing ever falls
   back to `C:\Program Files` silently.
2. **The app never owns more than its own folder.** The app installs into
   `<parent>\Soocial`, and only that folder is ever written to or removed.

## What lands where

| Content | Location | Moves with a custom install path? |
| --- | --- | --- |
| Executable, resources, `app.asar` | install dir (default `C:\Program Files\Soocial`) | yes |
| Settings, service list, tray state | `%APPDATA%\Soocial` | no |
| Logins and sessions (one partition per service) | `%APPDATA%\Soocial` | no |
| HTTP cache, GPU cache | `%LOCALAPPDATA%\Soocial` | no |
| Downloads | the folder you pick in Settings > Storage, default `%USERPROFILE%\Downloads\Soocial` | no |

Keeping data outside the install dir is what makes an uninstall non-destructive
and an update cheap. It also means two installs on the same machine (one on
`C:`, one on `D:`) do not share sessions by accident, and that a custom path
never drags your logins onto a drive you then unplug.

`installer/custom.nsh` writes the cache directory with `--disk-cache-dir`
before the app is ready, so the split is decided before Chromium creates
anything.

## Install

`Soocial Setup 1.0.0.exe` opens on a page asking for a location.

* **Default** — `C:\Program Files\Soocial`.
* **Advanced** — you select the **parent** folder (`D:\Apps`), and Soocial is
  installed into `D:\Apps\Soocial`. The selected folder itself is never used as
  the install dir: mixing program files into `D:\Apps` is how an uninstall ends
  up owning your photos.

The path is accepted only if all of these hold, and each refusal says which one
failed:

| Check | Refused when | Code |
| --- | --- | --- |
| Absolute | drive letter missing, relative path | 3 |
| Drive present | card reader empty, external disk unplugged, network share down | 21 |
| Writable | test file cannot be created in the parent | 5 |
| Name legal | a segment contains a character Windows refuses, or a reserved name | 123 |
| Length | full path longer than 259 characters (warned above 240) | 206 |
| Existing `Soocial` folder | another Soocial is there: you are asked to repair, replace or cancel | — |
| Not a parent of itself | target resolves to the selected folder | 3 |

A missing folder in the parent is offered to you (`Create`), never created
behind your back. `D:\` alone is legal and becomes `D:\Soocial`. Trailing
spaces, dots and separators are trimmed before validation, so pasting
`E:\Tools\Soocial ` behaves like `E:\Tools\Soocial`.

Silent installs (`/S`) accept the same rules and exit with the number in the
table above; they never fall back to the default location, because a fallback
in a script is a wrong path nobody notices.

## After the files are copied

Two records are written next to the executable:

* `install.json` — what the app reads: `product`, `installPath`, `version`,
  `channel`, `architecture`, `installationId`, `firstInstall`, `updatedAt`, the
  shortcut targets, and a `verified` flag.
* `install.ini` — what the installer reads. NSIS can parse an INI and nothing
  else, so the values an update needs to survive (`installationId`,
  `firstInstall`) live here too, and are carried over instead of rewritten.

Then the installer verifies the copy: `Soocial.exe`, both metadata files, and
the Start Menu and desktop shortcuts must exist and point inside the install
dir. Anything missing aborts the install with code **1604** and removes the
half-written folder — an unusable install left in place is worse than none.

A `.install-incomplete` marker is present for the duration of the copy. If the
machine loses power mid-install, the next run finds the marker, offers to
finish or clean, and only deletes the folder when the incomplete install is
its own.

## Update

The updater (`electron-updater`) reads `install.json` before it touches
anything and compares the recorded `installPath` with the running
`process.env.APP_PATH`:

* same path — patch in place;
* path moved or `install.json` truncated — the app says so in
  Settings > Storage and offers to install the downloaded package, which asks
  for elevation and reuses the folder that is now in use. It never silently
  reinstalls into `C:`.

`firstInstall` and `installationId` are preserved through the update, so a
user who has moved the app once is not told they installed it today.

## Uninstall

`Soocial Uninstall.exe` shows what will be removed before asking:

* the install folder — and only that folder;
* the desktop and Start Menu shortcuts that point inside it;
* the registry entry `Software\Soocial`;
* optionally `%APPDATA%\Soocial` and `%LOCALAPPDATA%\Soocial`, only if you tick
  the box (off by default, because that is where your logins are).

The uninstaller refuses to run on a folder that is not named `Soocial` and does
not contain our own markers: instead of deleting `D:\Apps` because a registry
value drifted, it exits with code **1605** and leaves everything alone.
Unrelated siblings (`D:\Apps\Photoshop`) are never touched, which is the point
of the "parent folder" design.

## Verifying a custom install by hand

`test/installer/verify-install.ps1` runs this list and prints one line per item;
it is a script because the same checks are repeated for every release.

1. Fresh install to `D:\Apps` → folder `D:\Apps\Soocial` exists, no stray files
   in `D:\Apps`.
2. Spaces and Unicode: install to `D:\Mon Dossier Été` → shortcuts, tray icon
   and window title all say Soocial.
3. First launch from a different account on the same machine.
4. Settings > Storage shows the chosen path and `install.json` reads
   `verified: true`.
5. Add a download folder on an unmapped network drive → the picker warns, the
   old value stays.
6. Update with a newer version → same path, `firstInstall` unchanged, sessions
   still logged in.
7. Reboot → app still starts from the chosen path (shortcuts and registry).
8. Uninstall → `D:\Apps\Photoshop` intact, `D:\Apps` still there, and
   `%APPDATA%\Soocial` still there unless the data box was ticked.
9. Reinstall to the same path → previous settings return.
10. Interrupt the install (kill it after the copy starts) → rerun repairs or
    cleans, no `.install-incomplete` is left behind.
11. Install to `C:\` root, to a missing drive letter, to a folder without write
    permission → each refusal names its reason, and nothing lands on `C:`.
12. DPI 100 / 125 / 150 / 175 / 200 % → title bar buttons hit, sidebar and split
    keep their proportions.

## When a folder is refused

Every refusal names its reason on screen and, in a silent run, comes back as the
process exit code from the table above. A deployment script can therefore treat
`21` as "the drive is not plugged in" and `5` as "the account may not write
here", without parsing text.

For a report that says only "it refused my folder", drop an empty file named
`SOO_DEBUG` next to `Soocial Setup …​.exe` and run it again: the installer turns
on NSIS logging, which in silent mode goes to standard output, so
`"Soocial Setup 1.0.0.exe" /S /D=D:\Apps > journal.txt 2>&1` captures the whole
decision. Without the marker file the installer logs nothing and writes nothing
extra.

## What is verified where

The installer script itself is checked here without Windows:

```bash
npm run test:installer        # makensis, install + uninstall passes
npm test                      # path rules, metadata, installer contract
npm run test:ui               # boots the app under xvfb, drives it over CDP
```

`test/installer/compile-check.sh` compiles the generated `.nsi` in both passes;
`NSI_WORK=/tmp/nsi NSI_VERBOSE=1 npm run test:installer` keeps the sources
around to read them.
