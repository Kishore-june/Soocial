#!/usr/bin/env node
// Copy the Electron renderer + assets into `src-tauri/ui` so the Tauri app is
// self-contained and does not bundle node_modules or the rest of the repo.
//
// Run after changing anything under `renderer/`, `assets/` or `bridge.js`:
//   npm run sync:ui
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ui = path.join(root, 'src-tauri', 'ui');

mkdirSync(ui, { recursive: true });
rmSync(path.join(ui, 'renderer'), { recursive: true, force: true });
rmSync(path.join(ui, 'assets'), { recursive: true, force: true });
rmSync(path.join(ui, 'bridge.js'), { force: true });

cpSync(path.join(root, 'renderer'), path.join(ui, 'renderer'), { recursive: true });
cpSync(path.join(root, 'assets'), path.join(ui, 'assets'), { recursive: true });
cpSync(path.join(root, 'bridge.js'), path.join(ui, 'bridge.js'));

// The Electron renderer intentionally does not load the Tauri bridge (its
// preload.js provides `window.hub`). The Tauri copy needs the bridge script
// before sidebar.js, so inject it only into the copied HTML.
const htmlPath = path.join(ui, 'renderer', 'index.html');
let html = readFileSync(htmlPath, 'utf8');
if (!html.includes('src="../bridge.js"')) {
  html = html.replace(
    '<script src="sidebar.js"></script>',
    '<script src="../bridge.js"></script>\n    <script src="sidebar.js"></script>',
  );
  writeFileSync(htmlPath, html);
}
console.log('[tauri-ui] synced renderer/, assets/, bridge.js -> src-tauri/ui/');
