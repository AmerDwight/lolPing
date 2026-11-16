//! lolPing on Tauri, proof of concept: the shell that Electron's main process was. It opens windows, runs the hook
//! helper and owns the tray. The logic stays TypeScript in the hidden `core` page (tauri-poc/web/core.ts).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::utils::config::BackgroundThrottlingPolicy;
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, RunEvent, WebviewUrl, WebviewWindowBuilder, Wry};

/// Defines `window.overlay` before the overlay page runs, as the Electron preload did.
const OVERLAY_SHIM: &str = include_str!("../../gen/overlay-shim.js");
/// Written out next to the app data on first start, so the portable build is one file.
const HOOK_HELPER: &[u8] = include_bytes!(env!("LOLPING_POC_HELPER"));
const CORE: &str = "core";
const TRAY: &str = "main";

#[derive(Default)]
struct CoreQueue {
    ready: bool,
    /// Script for the core page that arrived before it was listening.
    pending: Vec<String>,
}

#[derive(Default)]
struct State {
    helper: Mutex<Option<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
    core: Mutex<CoreQueue>,
    log: Mutex<Option<std::fs::File>>,
    /** Windows asked to let the mouse through, applied again each time one is shown. */
    click_through: Mutex<std::collections::HashSet<String>>,
}

type Builder<'a> = WebviewWindowBuilder<'a, Wry, AppHandle>;

fn js_str(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

fn log_line(app: &AppHandle, msg: &str) {
    eprintln!("{msg}");
    if let Some(f) = app.state::<State>().log.lock().unwrap().as_mut() {
        let _ = writeln!(f, "{} {msg}", now_ms());
    }
}

/// Runs `js` in the core page, in order, holding it until the page said it is ready.
fn to_core(app: &AppHandle, js: String) {
    let state = app.state::<State>();
    let mut q = state.core.lock().unwrap();
    if !q.ready {
        q.pending.push(js);
        return;
    }
    if let Some(w) = app.get_webview_window(CORE) {
        let _ = w.eval(&js);
    }
}

/// Every webview shares one WebView2 browser process, so all of them get the same arguments.
#[cfg(windows)]
fn browser_args(b: Builder<'_>) -> Builder<'_> {
    // Tauri's own defaults, which these replace, then what Electron's overlays had: sound without a user gesture, and no
    // throttling of a page that is hidden, parked off its display or covered.
    let mut args = String::from(
        "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion \
         --autoplay-policy=no-user-gesture-required --disable-background-timer-throttling \
         --disable-renderer-backgrounding --disable-backgrounding-occluded-windows",
    );
    if let Ok(port) = std::env::var("LOLPING_POC_CDP_PORT") {
        args.push_str(&format!(" --remote-debugging-port={port}"));
    }
    b.additional_browser_args(&args)
}

#[cfg(not(windows))]
fn browser_args(b: Builder<'_>) -> Builder<'_> {
    b
}

#[derive(Serialize)]
struct Mon {
    id: u32,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    scale: f64,
    primary: bool,
}

#[derive(Serialize)]
struct AppInfo {
    /// As Node's process.platform names it, for platformOf.
    platform: &'static str,
    monitors: Vec<Mon>,
}

#[tauri::command]
async fn app_info(app: AppHandle) -> Result<AppInfo, String> {
    let primary = app.primary_monitor().map_err(err)?;
    let monitors = app.available_monitors().map_err(err)?;
    let mut mons: Vec<Mon> = monitors
        .iter()
        .enumerate()
        .map(|(i, m)| Mon {
            id: i as u32 + 1,
            x: m.position().x,
            y: m.position().y,
            width: m.size().width,
            height: m.size().height,
            scale: m.scale_factor(),
            primary: primary.as_ref().is_some_and(|p| p.position() == m.position() && p.name() == m.name()),
        })
        .collect();
    if !mons.iter().any(|m| m.primary) {
        if let Some(first) = mons.first_mut() {
            first.primary = true;
        }
    }
    let platform = match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        _ => "linux",
    };
    Ok(AppInfo { platform, monitors: mons })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WinOpts {
    label: String,
    url: String,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    transparent: bool,
    focusable: bool,
    always_on_top: bool,
    skip_taskbar: bool,
    /// Gets the overlay preload.
    overlay: bool,
}

// Async: a window built in a synchronous command can deadlock on Windows.
#[tauri::command]
async fn win_create(app: AppHandle, opts: WinOpts) -> Result<(), String> {
    let mut b = WebviewWindowBuilder::new(&app, &opts.label, WebviewUrl::App(opts.url.into()))
        .title("lolPing")
        .decorations(false)
        .transparent(opts.transparent)
        .shadow(false)
        .resizable(false)
        .always_on_top(opts.always_on_top)
        .skip_taskbar(opts.skip_taskbar)
        .focused(false)
        .focusable(opts.focusable)
        .visible(false)
        .background_throttling(BackgroundThrottlingPolicy::Disabled);
    if opts.overlay {
        b = b.initialization_script(OVERLAY_SHIM);
    }
    let w = browser_args(b).build().map_err(err)?;
    w.set_position(PhysicalPosition::new(opts.x, opts.y)).map_err(err)?;
    w.set_size(PhysicalSize::new(opts.width, opts.height)).map_err(err)?;
    Ok(())
}

#[tauri::command]
fn win_op(app: AppHandle, label: String, op: String, args: Value) -> Result<(), String> {
    let Some(w) = app.get_webview_window(&label) else { return Ok(()) };
    let state = app.state::<State>();
    let on = args.get("on").and_then(Value::as_bool).unwrap_or(false);
    let num = |k: &str| args.get(k).and_then(Value::as_f64).unwrap_or(0.0).round();
    let r = match op.as_str() {
        "bounds" => w
            .set_position(PhysicalPosition::new(num("x") as i32, num("y") as i32))
            .and_then(|_| w.set_size(PhysicalSize::new(num("width") as u32, num("height") as u32))),
        "show" => w.show().and_then(|_| {
            let through = state.click_through.lock().unwrap().contains(&label);
            if through { w.set_ignore_cursor_events(true) } else { Ok(()) }
        }),
        "hide" => w.hide(),
        "ignoreMouse" => {
            let mut through = state.click_through.lock().unwrap();
            if on { through.insert(label.clone()) } else { through.remove(&label) };
            // tao on Linux can only shape the input of a window that is on screen; "show" applies it there.
            if cfg!(target_os = "linux") && !w.is_visible().unwrap_or(false) { Ok(()) } else { w.set_ignore_cursor_events(on) }
        }
        "topmost" => w.set_always_on_top(on),
        "contentProtection" => w.set_content_protected(on),
        "allWorkspaces" => w.set_visible_on_all_workspaces(on),
        "destroy" => w.destroy(),
        _ => return Err(format!("unknown window op {op}")),
    };
    r.map_err(err)
}

/// webContents.send: runs the page's listeners for `channel`.
#[tauri::command]
fn win_send(app: AppHandle, label: String, channel: String, payload: Value) -> Result<(), String> {
    let Some(w) = app.get_webview_window(&label) else { return Ok(()) };
    let js = format!("window.__lolpingOverlay&&window.__lolpingOverlay.dispatch({},{})", js_str(&channel), payload);
    w.eval(&js).map_err(err)
}

/// ipcRenderer.send from an overlay: handed to ipcMain in the core page with the sender's label.
#[tauri::command]
fn ipc_send(app: AppHandle, window: tauri::WebviewWindow, channel: String, payload: Value) {
    to_core(&app, format!("window.__core.ipc({},{},{})", js_str(window.label()), js_str(&channel), payload));
}

#[tauri::command]
fn core_ready(app: AppHandle) {
    let state = app.state::<State>();
    let mut q = state.core.lock().unwrap();
    q.ready = true;
    if let Some(w) = app.get_webview_window(CORE) {
        for js in q.pending.drain(..) {
            let _ = w.eval(&js);
        }
    }
}

fn fnv1a(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325, |h, b| (h ^ u64::from(*b)).wrapping_mul(0x0100_0000_01b3))
}

fn extract_helper(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_local_data_dir().map_err(err)?.join("bin");
    std::fs::create_dir_all(&dir).map_err(err)?;
    let path = dir.join(format!("hook-helper-{:016x}{}", fnv1a(HOOK_HELPER), std::env::consts::EXE_SUFFIX));
    if std::fs::metadata(&path).is_ok_and(|m| m.len() == HOOK_HELPER.len() as u64) {
        return Ok(path);
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, HOOK_HELPER).map_err(err)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755)).map_err(err)?;
    }
    std::fs::rename(&tmp, &path).map_err(err)?;
    Ok(path)
}

/// Starts the hook helper unless it runs. Its stdout lines go to the core page, then helperExit() when it ends.
#[tauri::command]
fn helper_start(app: AppHandle) -> Result<(), String> {
    let state = app.state::<State>();
    let mut slot = state.helper.lock().unwrap();
    if let Some(child) = slot.as_mut() {
        if matches!(child.try_wait(), Ok(None)) {
            return Ok(());
        }
    }
    let exe = extract_helper(&app)?;
    let mut cmd = Command::new(&exe);
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = cmd.spawn().map_err(|e| format!("{}: {e}", exe.display()))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    *state.stdin.lock().unwrap() = child.stdin.take();
    *slot = Some(child);
    let a = app.clone();
    std::thread::spawn(move || {
        if let Some(out) = stdout {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                to_core(&a, format!("window.__core.helperLine({})", js_str(&line)));
            }
        }
        to_core(&a, "window.__core.helperExit()".into());
    });
    let a = app.clone();
    std::thread::spawn(move || {
        if let Some(e) = stderr {
            for line in BufReader::new(e).lines().map_while(Result::ok) {
                log_line(&a, &format!("helper: {line}"));
            }
        }
    });
    Ok(())
}

#[tauri::command]
fn helper_write(app: AppHandle, line: String) -> Result<(), String> {
    let state = app.state::<State>();
    let mut stdin = state.stdin.lock().unwrap();
    let Some(stdin) = stdin.as_mut() else { return Ok(()) };
    let line = if line.ends_with('\n') { line } else { format!("{line}\n") };
    stdin.write_all(line.as_bytes()).and_then(|_| stdin.flush()).map_err(err)
}

/// The tray's text comes from the core page, which has the strings.
#[tauri::command]
fn set_tray(app: AppHandle, tooltip: String, quit: String) -> Result<(), String> {
    let item = MenuItem::with_id(&app, "quit", quit, true, None::<&str>).map_err(err)?;
    let menu = Menu::with_items(&app, &[&item]).map_err(err)?;
    if let Some(tray) = app.tray_by_id(TRAY) {
        tray.set_menu(Some(menu)).map_err(err)?;
        return tray.set_tooltip(Some(tooltip)).map_err(err);
    }
    let icon = app.default_window_icon().cloned().ok_or("no app icon")?;
    TrayIconBuilder::with_id(TRAY)
        .icon(icon)
        .tooltip(tooltip)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, e| {
            if e.id().as_ref() == "quit" {
                shutdown(app);
                app.exit(0);
            }
        })
        .build(&app)
        .map_err(err)?;
    Ok(())
}

#[tauri::command]
fn log(app: AppHandle, msg: String) {
    log_line(&app, &msg);
}

#[tauri::command]
fn quit(app: AppHandle) {
    shutdown(&app);
    app.exit(0);
}

/// Asks the helper to stop, as InputBridge.stop does, and kills it after a second.
fn shutdown(app: &AppHandle) {
    let state = app.state::<State>();
    let stdin = state.stdin.lock().unwrap().take();
    if let Some(mut stdin) = stdin {
        let _ = stdin.write_all(b"{\"type\":\"shutdown\"}\n");
    }
    let child = state.helper.lock().unwrap().take();
    let Some(mut child) = child else { return };
    for _ in 0..20 {
        if matches!(child.try_wait(), Ok(Some(_))) {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let _ = child.kill();
}

fn main() {
    let log_file = std::env::var_os("LOLPING_POC_LOG")
        .and_then(|p| std::fs::OpenOptions::new().create(true).append(true).open(p).ok());
    let app = tauri::Builder::default()
        .manage(State { log: Mutex::new(log_file), ..Default::default() })
        .invoke_handler(tauri::generate_handler![
            app_info, win_create, win_op, win_send, ipc_send, core_ready, helper_start, helper_write, set_tray, log, quit
        ])
        .setup(|app| {
            log_line(app.handle(), "shell started");
            let core = WebviewWindowBuilder::new(app.handle(), CORE, WebviewUrl::App("core/index.html".into()))
                .title("lolPing")
                .visible(false)
                .skip_taskbar(true);
            browser_args(core).build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("lolPing could not start");
    app.run(|app, event| {
        if let RunEvent::Exit = event {
            shutdown(app);
        }
    });
}
