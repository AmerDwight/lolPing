//! lolPing on Tauri, proof of concept: the shell under the Electron app's own main process. That code runs unchanged in
//! the hidden `core` page on Node and Electron stand-ins (tauri-poc/web), which come here for what a page can't do:
//! files, processes, UDP, windows, the tray, the clipboard.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::net::UdpSocket;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::http::{Request, Response};
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::utils::config::BackgroundThrottlingPolicy;
use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalSize, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent, Wry,
};

/// Written out on first start, so the portable build is one file.
const HOOK_HELPER: &[u8] = include_bytes!(env!("LOLPING_POC_HELPER"));
const CORE: &str = "core";
const TRAY: &str = "main";
/// Where the stand-ins put the app's own files (`__dirname` is `<APP_ROOT>main`); read from the embedded assets.
const APP_ROOT: &str = "/__lolping_app__/";

#[derive(Default)]
struct CoreQueue {
    ready: bool,
    pending: Vec<String>,
}

struct Proc {
    child: Arc<Mutex<Child>>,
    stdin: Option<ChildStdin>,
}

struct Udp {
    sock: UdpSocket,
    closed: Arc<AtomicBool>,
}

struct Reply {
    ok: bool,
    value: Value,
    error: String,
}

#[derive(Default)]
struct State {
    core: Mutex<CoreQueue>,
    log: Mutex<Option<std::fs::File>>,
    procs: Mutex<HashMap<u32, Proc>>,
    udps: Mutex<HashMap<u32, Udp>>,
    replies: Mutex<HashMap<u64, tokio::sync::oneshot::Sender<Reply>>>,
    next_reply: AtomicU64,
    /// Windows asked to let the mouse through, applied again each time one is shown.
    click_through: Mutex<HashSet<String>>,
    /// The folder the hook helper was written to: process.resourcesPath.
    resources: Mutex<PathBuf>,
}

type Builder<'a> = WebviewWindowBuilder<'a, Wry, AppHandle>;

/// A Node-style error: `code` is what fs and child_process callers test (ENOENT, EEXIST...).
#[derive(Serialize, Debug)]
struct SysErr {
    code: String,
    message: String,
}

impl SysErr {
    fn new(code: &str, message: impl std::fmt::Display) -> Self {
        SysErr { code: code.into(), message: message.to_string() }
    }
}

impl From<std::io::Error> for SysErr {
    fn from(e: std::io::Error) -> Self {
        use std::io::ErrorKind::*;
        let code = match e.kind() {
            NotFound => "ENOENT",
            AlreadyExists => "EEXIST",
            PermissionDenied => "EPERM",
            DirectoryNotEmpty => "ENOTEMPTY",
            IsADirectory => "EISDIR",
            NotADirectory => "ENOTDIR",
            AddrInUse => "EADDRINUSE",
            AddrNotAvailable => "EADDRNOTAVAIL",
            InvalidInput => "EINVAL",
            _ => "EIO",
        };
        SysErr::new(code, e)
    }
}

type SysResult = Result<Value, SysErr>;

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

// --- files: the app's own (embedded) and the user's --------------------------------------------------------------

/// The embedded asset behind a path under APP_ROOT: renderer/X is the page tree, preload/X the built preloads.
fn app_asset_key(path: &str) -> Option<String> {
    let p = path.replace('\\', "/");
    let rest = p.strip_prefix(APP_ROOT)?;
    if let Some(r) = rest.strip_prefix("renderer/") {
        return Some(r.to_string());
    }
    rest.strip_prefix("preload/").map(|r| format!("__preload/{r}"))
}

fn app_asset(app: &AppHandle, key: &str) -> Option<Vec<u8>> {
    app.asset_resolver().get(key.to_string()).map(|a| a.bytes)
}

fn str_arg<'a>(a: &'a Value, k: &str) -> Result<&'a str, SysErr> {
    a.get(k).and_then(Value::as_str).ok_or_else(|| SysErr::new("EINVAL", format!("missing {k}")))
}

fn bool_arg(a: &Value, k: &str) -> bool {
    a.get(k).and_then(Value::as_bool).unwrap_or(false)
}

fn ms(t: std::io::Result<SystemTime>) -> f64 {
    t.ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs_f64() * 1000.0).unwrap_or(0.0)
}

fn fs_op(app: &AppHandle, op: &str, a: &Value) -> SysResult {
    let path = str_arg(a, "path")?;
    if let Some(key) = app_asset_key(path) {
        let data = app_asset(app, &key);
        return match (op, data) {
            ("exists", d) => Ok(json!(d.is_some())),
            ("stat", Some(d)) => Ok(json!({ "isFile": true, "isDirectory": false, "size": d.len(), "mtimeMs": 0 })),
            ("readFile", Some(d)) => Ok(json!(B64.encode(d))),
            (_, None) => Err(SysErr::new("ENOENT", format!("no such file: {path}"))),
            _ => Err(SysErr::new("EROFS", format!("{path} is part of the app"))),
        };
    }
    let p = Path::new(path);
    match op {
        "exists" => Ok(json!(p.exists())),
        "stat" => {
            let m = std::fs::metadata(p)?;
            Ok(json!({ "isFile": m.is_file(), "isDirectory": m.is_dir(), "size": m.len(), "mtimeMs": ms(m.modified()) }))
        }
        "readFile" => Ok(json!(B64.encode(std::fs::read(p)?))),
        "writeFile" => {
            let data = B64.decode(str_arg(a, "data")?).map_err(|e| SysErr::new("EINVAL", e))?;
            if bool_arg(a, "append") {
                std::fs::OpenOptions::new().create(true).append(true).open(p)?.write_all(&data)?;
            } else {
                std::fs::write(p, data)?;
            }
            Ok(Value::Null)
        }
        "readdir" => {
            let mut names = vec![];
            for e in std::fs::read_dir(p)? {
                let e = e?;
                names.push(json!({ "name": e.file_name().to_string_lossy(), "isDirectory": e.file_type()?.is_dir() }));
            }
            Ok(json!(names))
        }
        "mkdir" => {
            if bool_arg(a, "recursive") {
                std::fs::create_dir_all(p)?;
            } else {
                std::fs::create_dir(p)?;
            }
            Ok(Value::Null)
        }
        "rm" => {
            let r = match std::fs::symlink_metadata(p) {
                Ok(m) if m.is_dir() => {
                    if bool_arg(a, "recursive") {
                        std::fs::remove_dir_all(p)
                    } else {
                        std::fs::remove_dir(p)
                    }
                }
                Ok(_) => std::fs::remove_file(p),
                Err(e) => Err(e),
            };
            match r {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound && bool_arg(a, "force") => Ok(Value::Null),
                r => r.map(|_| Value::Null).map_err(SysErr::from),
            }
        }
        "rename" => {
            std::fs::rename(p, str_arg(a, "to")?)?;
            Ok(Value::Null)
        }
        "copyFile" => {
            std::fs::copy(p, str_arg(a, "to")?)?;
            Ok(Value::Null)
        }
        _ => Err(SysErr::new("ENOSYS", format!("fs.{op}"))),
    }
}

// --- everything a stand-in may need to ask, sync or async --------------------------------------------------------

fn monitors(app: &AppHandle) -> SysResult {
    let primary = app.primary_monitor().map_err(|e| SysErr::new("EIO", e))?;
    let list = app.available_monitors().map_err(|e| SysErr::new("EIO", e))?;
    let mut out: Vec<Value> = list
        .iter()
        .enumerate()
        .map(|(i, m)| {
            let wa = m.work_area();
            json!({
                "id": i as u32 + 1, "x": m.position().x, "y": m.position().y,
                "width": m.size().width, "height": m.size().height, "scale": m.scale_factor(),
                "primary": primary.as_ref().is_some_and(|p| p.position() == m.position() && p.name() == m.name()),
                "work": { "x": wa.position.x, "y": wa.position.y, "width": wa.size.width, "height": wa.size.height },
            })
        })
        .collect();
    if !out.iter().any(|m| m["primary"] == json!(true)) {
        if let Some(first) = out.first_mut() {
            first["primary"] = json!(true);
        }
    }
    Ok(json!(out))
}

fn info(app: &AppHandle) -> SysResult {
    let exe = std::env::current_exe()?;
    let dir = |r: tauri::Result<PathBuf>| r.map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    let paths = app.path();
    Ok(json!({
        "platform": match std::env::consts::OS { "windows" => "win32", "macos" => "darwin", _ => "linux" },
        "arch": std::env::consts::ARCH,
        "pid": std::process::id(),
        "exe": exe.to_string_lossy(),
        "exeDir": exe.parent().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default(),
        "args": std::env::args().skip(1).collect::<Vec<_>>(),
        "env": std::env::vars().collect::<HashMap<_, _>>(),
        "resources": app.state::<State>().resources.lock().unwrap().to_string_lossy(),
        "appData": dir(paths.config_dir()),
        "home": dir(paths.home_dir()),
        "temp": std::env::temp_dir().to_string_lossy(),
        "downloads": dir(paths.download_dir()),
        "version": app.package_info().version.to_string(),
        "monitors": monitors(app)?,
    }))
}

fn interfaces() -> SysResult {
    let list = if_addrs::get_if_addrs()?;
    Ok(json!(list
        .iter()
        .map(|i| {
            let (family, address, netmask) = match &i.addr {
                if_addrs::IfAddr::V4(a) => ("IPv4", a.ip.to_string(), a.netmask.to_string()),
                if_addrs::IfAddr::V6(a) => ("IPv6", a.ip.to_string(), a.netmask.to_string()),
            };
            json!({ "name": i.name, "family": family, "address": address, "netmask": netmask, "internal": i.is_loopback() })
        })
        .collect::<Vec<_>>()))
}

fn sys(app: &AppHandle, op: &str, a: &Value) -> SysResult {
    if let Some(fs) = op.strip_prefix("fs.") {
        return fs_op(app, fs, a);
    }
    match op {
        "info" => info(app),
        "monitors" => monitors(app),
        "cursor" => {
            let p = app.cursor_position().map_err(|e| SysErr::new("EIO", e))?;
            Ok(json!({ "x": p.x, "y": p.y }))
        }
        "interfaces" => interfaces(),
        "clipboard.read" => {
            let text = arboard::Clipboard::new().and_then(|mut c| c.get_text()).unwrap_or_default();
            Ok(json!(text))
        }
        "clipboard.write" => {
            let text = str_arg(a, "text")?.to_string();
            arboard::Clipboard::new().and_then(|mut c| c.set_text(text)).map_err(|e| SysErr::new("EIO", e))?;
            Ok(Value::Null)
        }
        "open" => {
            open::that_detached(str_arg(a, "target")?)?;
            Ok(Value::Null)
        }
        "reveal" => {
            let path = str_arg(a, "path")?;
            #[cfg(windows)]
            Command::new("explorer").arg(format!("/select,{path}")).spawn()?;
            #[cfg(not(windows))]
            open::that_detached(Path::new(path).parent().unwrap_or(Path::new(path)))?;
            Ok(Value::Null)
        }
        "win.state" => {
            let Some(w) = app.get_webview_window(str_arg(a, "label")?) else { return Ok(Value::Null) };
            Ok(json!({
                "minimized": w.is_minimized().unwrap_or(false),
                "visible": w.is_visible().unwrap_or(false),
                "focused": w.is_focused().unwrap_or(false),
            }))
        }
        _ => Err(SysErr::new("ENOSYS", op)),
    }
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Some(v) = std::str::from_utf8(&b[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(if b[i] == b'+' { b' ' } else { b[i] });
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// lolpingsys://localhost/<op>?a=<JSON>: the stand-ins' synchronous calls (a sync XHR), answered off the main thread.
fn sys_request(app: &AppHandle, req: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let op = req.uri().path().trim_start_matches('/');
    let raw = req.uri().query().and_then(|q| q.split('&').find_map(|kv| kv.strip_prefix("a="))).unwrap_or("{}");
    let body = match serde_json::from_str::<Value>(&percent_decode(raw)) {
        Ok(a) => match sys(app, op, &a) {
            Ok(v) => json!({ "ok": true, "value": v }),
            Err(e) => json!({ "ok": false, "code": e.code, "message": e.message }),
        },
        Err(e) => json!({ "ok": false, "code": "EINVAL", "message": e.to_string() }),
    };
    Response::builder()
        .status(200)
        .header("Content-Type", "application/json")
        .header("Access-Control-Allow-Origin", "*")
        .body(body.to_string().into_bytes())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

/// The same calls, for the stand-ins' async APIs (fs/promises, shell).
#[tauri::command]
async fn sys_async(app: AppHandle, op: String, args: Value) -> Result<Value, SysErr> {
    tauri::async_runtime::spawn_blocking(move || sys(&app, &op, &args))
        .await
        .map_err(|e| SysErr::new("EIO", e))?
}

// --- child processes ------------------------------------------------------------------------------------------------

#[tauri::command]
fn proc_spawn(
    app: AppHandle,
    id: u32,
    command: String,
    args: Vec<String>,
    cwd: Option<String>,
    env: Option<HashMap<String, String>>,
) -> Result<u32, SysErr> {
    let mut cmd = Command::new(&command);
    cmd.args(&args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    if let Some(env) = env {
        cmd.env_clear().envs(env);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = cmd.spawn()?;
    let pid = child.id();
    let pipes: [(Option<Box<dyn Read + Send>>, &str); 2] = [
        (child.stdout.take().map(|s| Box::new(s) as Box<dyn Read + Send>), "stdout"),
        (child.stderr.take().map(|s| Box::new(s) as Box<dyn Read + Send>), "stderr"),
    ];
    let stdin = child.stdin.take();
    let child = Arc::new(Mutex::new(child));
    let mut readers = vec![];
    for (pipe, name) in pipes {
        let Some(mut pipe) = pipe else { continue };
        let a = app.clone();
        readers.push(std::thread::spawn(move || {
            let mut buf = [0u8; 16384];
            loop {
                match pipe.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => to_core(&a, format!("window.__core.proc({id},'{name}',{})", js_str(&B64.encode(&buf[..n])))),
                }
            }
        }));
    }
    let waiter = child.clone();
    let a = app.clone();
    std::thread::spawn(move || {
        let code = loop {
            if let Ok(Some(status)) = waiter.lock().unwrap().try_wait() {
                break status.code();
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        for r in readers {
            let _ = r.join();
        }
        let code = code.map(|c| c.to_string()).unwrap_or_else(|| "null".into());
        to_core(&a, format!("window.__core.proc({id},'exit',{code})"));
        a.state::<State>().procs.lock().unwrap().remove(&id);
    });
    app.state::<State>().procs.lock().unwrap().insert(id, Proc { child, stdin });
    Ok(pid)
}

#[tauri::command]
fn proc_write(app: AppHandle, id: u32, data: String) -> Result<(), SysErr> {
    let bytes = B64.decode(data).map_err(|e| SysErr::new("EINVAL", e))?;
    let state = app.state::<State>();
    let mut procs = state.procs.lock().unwrap();
    let stdin = procs.get_mut(&id).and_then(|p| p.stdin.as_mut()).ok_or_else(|| SysErr::new("EPIPE", "stdin closed"))?;
    stdin.write_all(&bytes)?;
    stdin.flush()?;
    Ok(())
}

#[tauri::command]
fn proc_end(app: AppHandle, id: u32) {
    if let Some(p) = app.state::<State>().procs.lock().unwrap().get_mut(&id) {
        p.stdin = None;
    }
}

#[tauri::command]
fn proc_kill(app: AppHandle, id: u32) {
    let child = app.state::<State>().procs.lock().unwrap().get(&id).map(|p| p.child.clone());
    if let Some(c) = child {
        let _ = c.lock().unwrap().kill();
    }
}

// --- UDP ------------------------------------------------------------------------------------------------------------

#[tauri::command]
fn udp_bind(app: AppHandle, id: u32, port: u16, address: String) -> Result<Value, SysErr> {
    let sock = UdpSocket::bind((address.as_str(), port))?;
    sock.set_read_timeout(Some(Duration::from_millis(200)))?;
    let local = sock.local_addr()?;
    let rx = sock.try_clone()?;
    let closed = Arc::new(AtomicBool::new(false));
    let stop = closed.clone();
    let a = app.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 65536];
        while !stop.load(Ordering::Relaxed) {
            match rx.recv_from(&mut buf) {
                Ok((n, from)) => to_core(
                    &a,
                    format!(
                        "window.__core.udp({id},{},{},{})",
                        js_str(&B64.encode(&buf[..n])),
                        js_str(&from.ip().to_string()),
                        from.port()
                    ),
                ),
                // A timeout is how the loop sees `closed`; Windows also reports an earlier send's unreachable port here.
                Err(_) => continue,
            }
        }
    });
    app.state::<State>().udps.lock().unwrap().insert(id, Udp { sock, closed });
    Ok(json!({ "address": local.ip().to_string(), "port": local.port() }))
}

#[tauri::command]
fn udp_broadcast(app: AppHandle, id: u32, on: bool) -> Result<(), SysErr> {
    if let Some(u) = app.state::<State>().udps.lock().unwrap().get(&id) {
        u.sock.set_broadcast(on)?;
    }
    Ok(())
}

#[tauri::command]
fn udp_send(app: AppHandle, id: u32, data: String, host: String, port: u16) -> Result<(), SysErr> {
    let bytes = B64.decode(data).map_err(|e| SysErr::new("EINVAL", e))?;
    let state = app.state::<State>();
    let udps = state.udps.lock().unwrap();
    let u = udps.get(&id).ok_or_else(|| SysErr::new("ERR_SOCKET_DGRAM_NOT_RUNNING", "socket closed"))?;
    u.sock.send_to(&bytes, (host.as_str(), port))?;
    Ok(())
}

#[tauri::command]
fn udp_close(app: AppHandle, id: u32) {
    if let Some(u) = app.state::<State>().udps.lock().unwrap().remove(&id) {
        u.closed.store(true, Ordering::Relaxed);
    }
}

// --- windows --------------------------------------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WinOpts {
    label: String,
    url: String,
    title: String,
    /// x, y, width, height are physical pixels; otherwise width and height are logical and the window is centred.
    physical: bool,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    min_width: Option<f64>,
    min_height: Option<f64>,
    decorations: bool,
    transparent: bool,
    focusable: bool,
    always_on_top: bool,
    skip_taskbar: bool,
    resizable: bool,
    /// The built preload (dist/__preload/<name>.js) to run before the page's own scripts.
    preload: Option<String>,
}

// Async: a window built in a synchronous command can deadlock on Windows.
#[tauri::command]
async fn win_create(app: AppHandle, opts: WinOpts) -> Result<(), String> {
    let mut b = WebviewWindowBuilder::new(&app, &opts.label, WebviewUrl::App(opts.url.into()))
        .title(&opts.title)
        .decorations(opts.decorations)
        .transparent(opts.transparent)
        .shadow(opts.decorations)
        .resizable(opts.resizable)
        .always_on_top(opts.always_on_top)
        .skip_taskbar(opts.skip_taskbar)
        .focused(false)
        .focusable(opts.focusable)
        .visible(false)
        .background_throttling(BackgroundThrottlingPolicy::Disabled);
    if !opts.physical {
        b = b.inner_size(opts.width, opts.height).center();
        if let (Some(w), Some(h)) = (opts.min_width, opts.min_height) {
            b = b.min_inner_size(w, h);
        }
    }
    if let Some(name) = &opts.preload {
        let script = app_asset(&app, &format!("__preload/{name}.js")).ok_or(format!("no preload {name}"))?;
        b = b.initialization_script(String::from_utf8_lossy(&script).into_owned());
    }
    let w = browser_args(b).build().map_err(err)?;
    if opts.physical {
        w.set_position(PhysicalPosition::new(opts.x.round() as i32, opts.y.round() as i32)).map_err(err)?;
        w.set_size(PhysicalSize::new(opts.width.round() as u32, opts.height.round() as u32)).map_err(err)?;
    }
    let a = app.clone();
    let label = opts.label.clone();
    w.on_window_event(move |e| {
        let ev = match e {
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close(); // the core page decides, as Electron's 'close' listeners do
                "close"
            }
            WindowEvent::Destroyed => "closed",
            WindowEvent::Focused(true) => "focus",
            WindowEvent::Focused(false) => "blur",
            _ => return,
        };
        to_core(&a, format!("window.__core.win({},'{ev}')", js_str(&label)));
    });
    Ok(())
}

#[tauri::command]
fn win_op(app: AppHandle, label: String, op: String, args: Value) -> Result<(), String> {
    let Some(w) = app.get_webview_window(&label) else { return Ok(()) };
    let state = app.state::<State>();
    let on = bool_arg(&args, "on");
    let num = |k: &str| args.get(k).and_then(Value::as_f64).unwrap_or(0.0).round();
    let r = match op.as_str() {
        "bounds" => w
            .set_position(PhysicalPosition::new(num("x") as i32, num("y") as i32))
            .and_then(|_| w.set_size(PhysicalSize::new(num("width") as u32, num("height") as u32))),
        "show" => w.show().and_then(|_| {
            let through = state.click_through.lock().unwrap().contains(&label);
            if through {
                w.set_ignore_cursor_events(true)
            } else {
                Ok(())
            }
        }),
        "hide" => w.hide(),
        "focus" => w.unminimize().and_then(|_| w.set_focus()),
        "minimize" => w.minimize(),
        "restore" => w.unminimize(),
        "title" => w.set_title(args.get("title").and_then(Value::as_str).unwrap_or("")),
        "ignoreMouse" => {
            let mut through = state.click_through.lock().unwrap();
            if on {
                through.insert(label.clone());
            } else {
                through.remove(&label);
            }
            // tao on Linux can only shape the input of a window that is on screen; "show" applies it there.
            if cfg!(target_os = "linux") && !w.is_visible().unwrap_or(false) {
                Ok(())
            } else {
                w.set_ignore_cursor_events(on)
            }
        }
        "topmost" => w.set_always_on_top(on),
        "contentProtection" => w.set_content_protected(on),
        "allWorkspaces" => w.set_visible_on_all_workspaces(on),
        "destroy" => w.destroy(),
        _ => return Err(format!("unknown window op {op}")),
    };
    r.map_err(err)
}

/// webContents.send: runs the page's ipcRenderer listeners for `channel`.
#[tauri::command]
fn win_send(app: AppHandle, label: String, channel: String, args: Value) -> Result<(), String> {
    let Some(w) = app.get_webview_window(&label) else { return Ok(()) };
    w.eval(&format!("window.__lolpingIpc&&window.__lolpingIpc.dispatch({},{})", js_str(&channel), args)).map_err(err)
}

// --- IPC from the pages to the core page ----------------------------------------------------------------------------

#[tauri::command]
fn ipc_send(app: AppHandle, window: tauri::WebviewWindow, channel: String, args: Value) {
    to_core(&app, format!("window.__core.ipc({},{},{})", js_str(window.label()), js_str(&channel), args));
}

/// ipcRenderer.invoke: answered by the core page's ipcMain.handle through ipc_reply.
#[tauri::command]
async fn ipc_invoke(app: AppHandle, window: tauri::WebviewWindow, channel: String, args: Value) -> Result<Value, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let id = {
        let state = app.state::<State>();
        let id = state.next_reply.fetch_add(1, Ordering::Relaxed);
        state.replies.lock().unwrap().insert(id, tx);
        id
    };
    to_core(&app, format!("window.__core.invoke({id},{},{},{})", js_str(window.label()), js_str(&channel), args));
    match rx.await {
        Ok(r) if r.ok => Ok(r.value),
        Ok(r) => Err(r.error),
        Err(_) => Err("lolPing stopped".into()),
    }
}

#[tauri::command]
fn ipc_reply(app: AppHandle, id: u64, ok: bool, value: Value, error: Option<String>) {
    let tx = app.state::<State>().replies.lock().unwrap().remove(&id);
    if let Some(tx) = tx {
        let _ = tx.send(Reply { ok, value, error: error.unwrap_or_default() });
    }
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

// --- the tray -------------------------------------------------------------------------------------------------------

#[derive(Deserialize)]
struct MenuSpec {
    id: String,
    /// normal, checkbox, separator or submenu
    kind: String,
    label: String,
    enabled: bool,
    checked: bool,
    items: Vec<MenuSpec>,
}

#[derive(Deserialize)]
struct IconSpec {
    /// Straight (not premultiplied) RGBA, base64.
    rgba: String,
    width: u32,
    height: u32,
}

fn menu_items(app: &AppHandle, specs: &[MenuSpec]) -> tauri::Result<Vec<Box<dyn IsMenuItem<Wry>>>> {
    let mut out: Vec<Box<dyn IsMenuItem<Wry>>> = vec![];
    for s in specs {
        match s.kind.as_str() {
            "separator" => out.push(Box::new(PredefinedMenuItem::separator(app)?)),
            "checkbox" => out.push(Box::new(CheckMenuItem::with_id(app, &s.id, &s.label, s.enabled, s.checked, None::<&str>)?)),
            "submenu" => {
                let items = menu_items(app, &s.items)?;
                let refs: Vec<&dyn IsMenuItem<Wry>> = items.iter().map(|b| b.as_ref()).collect();
                out.push(Box::new(Submenu::with_id_and_items(app, &s.id, &s.label, s.enabled, &refs)?));
            }
            _ => out.push(Box::new(MenuItem::with_id(app, &s.id, &s.label, s.enabled, None::<&str>)?)),
        }
    }
    Ok(out)
}

#[tauri::command]
fn tray_set(app: AppHandle, icon: Option<IconSpec>, tooltip: Option<String>, menu: Option<Vec<MenuSpec>>) -> Result<(), String> {
    let image = match icon {
        Some(i) => Some(Image::new_owned(B64.decode(i.rgba).map_err(err)?, i.width, i.height)),
        None => None,
    };
    let menu = match menu {
        Some(specs) => {
            let items = menu_items(&app, &specs).map_err(err)?;
            let refs: Vec<&dyn IsMenuItem<Wry>> = items.iter().map(|b| b.as_ref()).collect();
            Some(Menu::with_items(&app, &refs).map_err(err)?)
        }
        None => None,
    };
    let tray = match app.tray_by_id(TRAY) {
        Some(t) => t,
        None => {
            let icon = image.clone().or_else(|| app.default_window_icon().cloned()).ok_or("no icon")?;
            TrayIconBuilder::with_id(TRAY)
                .icon(icon)
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, e| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                        to_core(tray.app_handle(), "window.__core.tray('click')".into());
                    }
                })
                .build(&app)
                .map_err(err)?
        }
    };
    if let Some(i) = image {
        tray.set_icon(Some(i)).map_err(err)?;
    }
    if let Some(t) = tooltip {
        tray.set_tooltip(Some(t)).map_err(err)?;
    }
    if let Some(m) = menu {
        tray.set_menu(Some(m)).map_err(err)?;
    }
    Ok(())
}

#[tauri::command]
fn tray_destroy(app: AppHandle) {
    let _ = app.remove_tray_by_id(TRAY);
}

#[tauri::command]
fn log(app: AppHandle, msg: String) {
    log_line(&app, &msg);
}

/// app.exit: the core page has already said goodbye to rooms and saved settings.
#[tauri::command]
fn quit(app: AppHandle, code: Option<i32>) {
    stop_children(&app);
    app.exit(code.unwrap_or(0));
}

fn stop_children(app: &AppHandle) {
    let procs: Vec<Proc> = app.state::<State>().procs.lock().unwrap().drain().map(|(_, p)| p).collect();
    for p in procs {
        drop(p.stdin);
        let _ = p.child.lock().unwrap().kill();
    }
}

fn fnv1a(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325, |h, b| (h ^ u64::from(*b)).wrapping_mul(0x0100_0000_01b3))
}

/// Writes the embedded hook helper to <app local data>/bin/<hash>/, which becomes process.resourcesPath.
fn extract_helper(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_local_data_dir().map_err(err)?.join("bin").join(format!("{:016x}", fnv1a(HOOK_HELPER)));
    std::fs::create_dir_all(&dir).map_err(err)?;
    let path = dir.join(format!("hook-helper{}", std::env::consts::EXE_SUFFIX));
    if std::fs::metadata(&path).is_ok_and(|m| m.len() == HOOK_HELPER.len() as u64) {
        return Ok(dir);
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, HOOK_HELPER).map_err(err)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755)).map_err(err)?;
    }
    std::fs::rename(&tmp, &path).map_err(err)?;
    Ok(dir)
}

fn main() {
    let log_file = std::env::var_os("LOLPING_POC_LOG")
        .and_then(|p| std::fs::OpenOptions::new().create(true).append(true).open(p).ok());
    let app = tauri::Builder::default()
        .manage(State { log: Mutex::new(log_file), ..Default::default() })
        .register_asynchronous_uri_scheme_protocol("lolpingsys", |ctx, req, responder| {
            let app = ctx.app_handle().clone();
            // Off the main thread: monitors, the cursor and window state are answered by the main thread.
            std::thread::spawn(move || responder.respond(sys_request(&app, &req)));
        })
        .invoke_handler(tauri::generate_handler![
            sys_async, proc_spawn, proc_write, proc_end, proc_kill, udp_bind, udp_broadcast, udp_send, udp_close,
            win_create, win_op, win_send, ipc_send, ipc_invoke, ipc_reply, core_ready, tray_set, tray_destroy, log, quit
        ])
        .setup(|app| {
            log_line(app.handle(), "shell started");
            let resources = extract_helper(app.handle())?;
            *app.state::<State>().resources.lock().unwrap() = resources;
            app.on_menu_event(|app, e| to_core(app, format!("window.__core.menu({})", js_str(e.id().as_ref()))));
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
            stop_children(app);
        }
    });
}
