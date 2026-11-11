# Kronos Download Manager (KDM)

A minimal, fast download manager for Windows, built from the Figma design
(“Download Manager”, light + dark mode), with the useful parts of IDM added.

## Features

**From the design notes**
- Multiple connections per download (1–32, default 8)
- Scheduler: start / stop the queue at set times on chosen days
- Run something when the queue finishes: shut down, sleep, hibernate, or exit (60 s countdown you can cancel)
- “How many downloads at a time” for the queue

**IDM-style extras**
- Dynamic segmentation: a finished connection takes over half of the largest remaining part
- “Start positions and progress by connections” map and a per-connection list (Details)
- Resume after pause, crash, or restart; automatic retries with backoff
- **Refresh link**: swap an expired link for a fresh one without losing what was already downloaded
- Browser integration (Chrome / Edge / Brave extension), so browser downloads go to the app
- Clipboard monitoring: copying a file link opens “Add Link”
- Automatic categories and folders (Video, Music, Compressed, Documents, Programs, General)
- Global and per-download speed limits
- “Online Watch” to stream video or audio before downloading (falls back to VLC / PotPlayer)
- Tray icon, progress on the taskbar button, notifications, and the system kept awake while downloading
- 10 themes: Light (default) and Dark from the design, plus Day, Night, Paper, Mint, Ocean, Neon, Jungle and Retro 95
- Paste several links at once or drag and drop links onto the window; copy a SHA-256 checksum

## Install

1. Run `KDM-Setup-0.1.0.exe` (or use `KDM-Portable-0.1.0.exe`, which needs no installation).
2. The build isn't code-signed, so Windows SmartScreen may warn you. Click **More info → Run anyway**.

### Browser extension
1. Open `edge://extensions` or `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick the extension folder (Settings → Browser integration → *Open extension folder*;
   after installing it's in `…\Kronos Download Manager\resources\extension`).

## Keyboard
`Ctrl+N` add link · `Ctrl+F` search · `Ctrl+V` paste link(s) · `Space` pause or resume · `Enter` open · `Delete` cancel or remove

## Develop

```bash
npm install
npm start          # run the app
npm test           # download-engine tests (against a local HTTP test server)
npm run dist:win   # build the Windows installer + portable exe into dist/ (Linux needs wine + wine32)
```

Layout:
- `src/main/engine/`: download engine (segments, resume, queue, scheduler)
- `src/main/`: Electron main process (windows, tray, IPC, browser bridge on `127.0.0.1:17842`, power actions)
- `src/renderer/`: UI (HTML/CSS/JS); icons are exported straight from the Figma file
- `extension/`: Manifest V3 browser extension
- `scripts/ui-check.js`, `scripts/ext-check.js`: end-to-end checks that drive the real app (and a real browser)

Font: the whole UI uses **Manrope** (bundled, SIL Open Font License), so it looks the same on every PC.
