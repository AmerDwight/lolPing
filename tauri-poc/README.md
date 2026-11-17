# lolPing on Tauri: proof of concept

A test of whether lolPing's Windows portable build can move from Electron to Tauri 2 and get smaller, while the
app's own code stays as it is.

How it is put together:

- `src-tauri/` is a small Rust shell. It opens windows, runs processes (the hook helper), owns UDP sockets, the tray
  and its menu, and answers file, clipboard, display and network questions. The helper is embedded in the executable
  and written to the app data folder on first start, so the portable build is one file.
- A hidden page runs the Electron main process, `src/main/index.ts`, unchanged. `build-web.mjs` bundles it with
  stand-ins for what it imports from Node and Electron:
  - `web/node/` has `fs`, `path`, `os`, `crypto`, `child_process`, `dgram`, `events` and the rest. Calls that must
    be synchronous in Node go to the shell as a synchronous request; the others go through Tauri commands.
  - `web/electron/main.ts` has `app`, `BrowserWindow`, `ipcMain`, `screen`, `Tray`, `Menu`, `nativeImage` and the
    smaller modules. `web/electron/renderer.ts` has `ipcRenderer` and `contextBridge`, so the app's own preloads run
    in each window as they are.
- Room encryption and signing use the noble libraries. `tests/tauri-poc/nodeCrypto.test.ts` checks them byte for
  byte against Node, so a Tauri peer and an Electron peer understand each other.
- The portable build keeps its data in a `data` folder next to the executable, as the Electron portable build does.
- Imported and friends' emotes are `lolping://emotes/...`, answered by the app's own handler in the core page. On
  Windows the pages ask for `http://lolping.localhost/emotes/...` instead, the only form WebView2 loads.

Not done: the teammate, the single-instance lock, updates, secure storage of keys, file dialogs, macOS.

## Build

```bash
npm ci && npm ci --prefix tauri-poc
npm run build:helper
npx electron-vite build
node tauri-poc/build-web.mjs
cd tauri-poc/src-tauri && cargo build --release
```

The portable build is `tauri-poc/src-tauri/target/release/lolping-tauri-poc.exe`. It needs the WebView2 runtime,
which Windows 11 includes.

### Windows build from Linux

For testing when no Windows machine or runner is at hand. It needs MinGW-w64 (`x86_64-w64-mingw32-g++`) and the
Rust library source for the installed toolchain in `$(rustc --print sysroot)/lib/rustlib/src/rust/library`, since
the Windows standard library is built from source here.

```bash
cd native/hook-helper
x86_64-w64-mingw32-g++ -std=c++20 -O2 -DUNICODE -D_UNICODE -municode -static -s src/main_win.cpp src/hooks_win.cpp \
  src/simulate.cpp src/commands.cpp src/output.cpp src/json.cpp src/decision.cpp -o /tmp/hook-helper.exe -luser32
cd ../..
npx electron-vite build
LOLPING_POC_PLATFORM=win32 node tauri-poc/build-web.mjs
cd tauri-poc/src-tauri
RUSTC_BOOTSTRAP=1 CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER=x86_64-w64-mingw32-gcc \
  LOLPING_POC_HELPER=/tmp/hook-helper.exe \
  cargo build --release --locked -Zbuild-std=std,panic_abort --target x86_64-pc-windows-gnu
```

Unlike the MSVC build, this one loads `WebView2Loader.dll` at start. The build puts it next to the executable in
`target/x86_64-pc-windows-gnu/release`, and the two files go together.

## Test

`.github/workflows/tauri-poc.yml` builds it on a Windows runner and runs:

- `e2e/e2e_win.py` on the Tauri build and on the Electron build as the control. It drives the real mouse and
  keyboard (SendInput) and reads the pages over the DevTools protocol: pass-through, pings, emotes, latency,
  memory, startup time.
- `e2e/e2e_room.py` on both portable builds together. The Tauri build changes a setting and checks
  `data/settings.json`, creates a room, the Electron build joins it, and each sends a ping that the other draws.
  Then each imports a custom emote and the other's overlay loads it once the room has synced it.

The `tests/tauri-poc` unit tests need `npm ci --prefix tauri-poc` first.
