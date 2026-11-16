# lolPing on Tauri: proof of concept

A test of whether lolPing's Windows portable build can move from Electron to Tauri 2 and get smaller. It covers the
overlays and the input helper: the ping wheel, the emote wheel, pings, emotes and their sounds. Settings, rooms,
the teammate, updates and macOS are not part of it.

How it is put together:

- `src-tauri/` is the shell Electron's main process was: it opens windows, runs the hook helper and owns the tray.
  The helper is embedded in the executable and written to the app data folder on first start, so the portable build
  is one file.
- `web/core.ts` runs in a hidden page. It uses the Electron app's own `src/main/overlayManager.ts`, unchanged:
  `build-web.mjs` swaps its `electron` import for `web/electronShim.ts`, which does the same window calls through
  the shell.
- `web/overlayShim.ts` takes the place of `src/preload/overlay.ts`. The overlay page itself is the Electron app's
  page, unchanged but for its CSP.

## Build

```bash
npm run build:helper
npx electron-vite build
node tauri-poc/build-web.mjs
cd tauri-poc/src-tauri && cargo build --release
```

The portable build is `tauri-poc/src-tauri/target/release/lolping-tauri-poc.exe`. It needs the WebView2 runtime,
which Windows 11 includes.

## Test

`.github/workflows/tauri-poc.yml` builds it on a Windows runner and runs `e2e/e2e_win.py`, which drives the real
mouse and keyboard (SendInput) and reads the overlay page over the DevTools protocol. The same test runs on the
Electron app as the control.
