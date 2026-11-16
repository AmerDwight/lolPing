"""End-to-end check of a lolPing build on a Windows desktop, with real (SendInput) mouse and keyboard input.

Runs the same checks on the Electron app and on the Tauri proof of concept, so the Electron run shows the test itself
holds on this machine. It drives the default keys: Alt+drag for the ping wheel, Ctrl+drag for the emote wheel.

usage: python e2e_win.py --kind tauri|electron --app <exe> --assets out/renderer --out <dir> [--portable <exe>]
--assets is the folder the build ships (emotes, sounds, textures), --portable an Electron portable exe to time too.
needs: pip install websocket-client pillow psutil
"""
import argparse
import ctypes
import ctypes.wintypes as W
import json
import os
import subprocess
import sys
import threading
import time
import urllib.request

import psutil
import websocket
from PIL import ImageGrab

ap = argparse.ArgumentParser()
ap.add_argument('--kind', choices=['tauri', 'electron'], required=True)
ap.add_argument('--app', required=True)
ap.add_argument('--assets', required=True)
ap.add_argument('--out', required=True)
ap.add_argument('--port', type=int, default=9333)
ap.add_argument('--portable', help='an Electron portable exe: its start is timed as well')
ap.add_argument('--reps', type=int, default=5, help='wheels opened from idle for the latency figures')
args = ap.parse_args()
os.makedirs(args.out, exist_ok=True)
HERE = os.path.dirname(os.path.abspath(__file__))

ctypes.windll.shcore.SetProcessDpiAwareness(2)
user32 = ctypes.WinDLL('user32', use_last_error=True)
user32.GetWindowLongPtrW.restype = ctypes.c_ssize_t
user32.GetWindowLongPtrW.argtypes = [W.HWND, ctypes.c_int]
SW, SH = user32.GetSystemMetrics(0), user32.GetSystemMetrics(1)

ULONG_PTR = ctypes.c_size_t


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [('dx', W.LONG), ('dy', W.LONG), ('mouseData', W.DWORD), ('dwFlags', W.DWORD), ('time', W.DWORD),
                ('dwExtraInfo', ULONG_PTR)]


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [('wVk', W.WORD), ('wScan', W.WORD), ('dwFlags', W.DWORD), ('time', W.DWORD), ('dwExtraInfo', ULONG_PTR)]


class HARDWAREINPUT(ctypes.Structure):
    _fields_ = [('uMsg', W.DWORD), ('wParamL', W.WORD), ('wParamH', W.WORD)]


class _INPUT_UNION(ctypes.Union):
    _fields_ = [('mi', MOUSEINPUT), ('ki', KEYBDINPUT), ('hi', HARDWAREINPUT)]


class INPUT(ctypes.Structure):
    _fields_ = [('type', W.DWORD), ('u', _INPUT_UNION)]


def send(inp):
    if user32.SendInput(1, ctypes.byref(inp), ctypes.sizeof(INPUT)) != 1:
        raise OSError(f'SendInput failed: {ctypes.get_last_error()}')


def mouse(flags, x=0, y=0):
    i = INPUT(type=0)
    i.u.mi = MOUSEINPUT(dx=x * 65535 // (SW - 1), dy=y * 65535 // (SH - 1), dwFlags=flags)
    send(i)


def move(x, y):
    mouse(0x0001 | 0x8000, x, y)  # MOVE | ABSOLUTE


def button(down):
    mouse(0x0002 if down else 0x0004)


def key(vk, down):
    i = INPUT(type=1)
    i.u.ki = KEYBDINPUT(wVk=vk, wScan=user32.MapVirtualKeyW(vk, 0), dwFlags=0 if down else 0x0002)
    send(i)


def click(x, y):
    move(x, y)
    time.sleep(0.05)
    button(True)
    time.sleep(0.05)
    button(False)


def foreground_title():
    h = user32.GetForegroundWindow()
    buf = ctypes.create_unicode_buffer(256)
    user32.GetWindowTextW(h, buf, 256)
    return buf.value


def top_windows(pid):
    """Visible top-level windows of a process: (hwnd, rect, exstyle)."""
    found = []

    @ctypes.WINFUNCTYPE(W.BOOL, W.HWND, W.LPARAM)
    def each(hwnd, _):
        p = W.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(p))
        if p.value == pid and user32.IsWindowVisible(hwnd):
            r = W.RECT()
            user32.GetWindowRect(hwnd, ctypes.byref(r))
            found.append((hwnd, (r.left, r.top, r.right, r.bottom), user32.GetWindowLongPtrW(hwnd, -20)))
        return True

    user32.EnumWindows(each, 0)
    return found


def overlay_windows(pid):
    """The overlays: windows at least as big as the display, wherever they are parked."""
    return [w for w in top_windows(pid) if w[1][2] - w[1][0] >= SW - 2 and w[1][3] - w[1][1] >= SH - 2]


def on_display(rect):
    return rect[0] <= 0 and rect[1] <= 0 and rect[2] >= SW and rect[3] >= SH - 1


EX = {'TOPMOST': 0x8, 'TRANSPARENT': 0x20, 'TOOLWINDOW': 0x80, 'LAYERED': 0x80000, 'NOACTIVATE': 0x08000000}


def flags(ex):
    return [n for n, bit in EX.items() if ex & bit]


class Page:
    """One page over the DevTools protocol."""

    def __init__(self, ws_url):
        self.ws = websocket.create_connection(ws_url, timeout=60, suppress_origin=True)
        self.seq = 0

    def eval(self, expr):
        self.seq += 1
        self.ws.send(json.dumps({'id': self.seq, 'method': 'Runtime.evaluate',
                                 'params': {'expression': expr, 'awaitPromise': True, 'returnByValue': True}}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get('id') == self.seq:
                res = msg.get('result', {})
                if 'exceptionDetails' in res:
                    raise RuntimeError(json.dumps(res['exceptionDetails'])[:500])
                return res.get('result', {}).get('value')


results, metrics = {}, {}


def check(name, ok, detail=''):
    results[name] = bool(ok)
    print(f"{'PASS' if ok else 'FAIL'} {name} {detail}", flush=True)


def shot(name):
    ImageGrab.grab().save(os.path.join(args.out, f'{name}.png'))


def wait(cond, timeout, step=0.05):
    end = time.time() + timeout
    while time.time() < end:
        v = cond()
        if v:
            return v
        time.sleep(step)
    return None


def target_log():
    with open(target_log_path, encoding='utf-8') as f:
        return f.read().splitlines()


def helpers():
    return [p for p in psutil.process_iter(['name']) if (p.info['name'] or '').lower().startswith('hook-helper')]


# --- start the target window and the app -----------------------------------------------------------------------
target_log_path = os.path.join(args.out, 'target.log')
open(target_log_path, 'w').close()
target = subprocess.Popen([sys.executable, os.path.join(HERE, 'target_app.py'), target_log_path])
wait(lambda: any('started' in line for line in target_log()), 20)
time.sleep(1)
click(300, 100)  # bring it to the front
time.sleep(0.5)

app_log = os.path.join(args.out, 'app.log')
env = dict(os.environ)
cmd = [args.app]
if args.kind == 'tauri':
    env['LOLPING_POC_CDP_PORT'] = str(args.port)
    env['LOLPING_POC_LOG'] = app_log
else:
    cmd += [f'--remote-debugging-port={args.port}', '--hidden']
t_launch = time.time()
app = subprocess.Popen(cmd, env=env, stdout=open(os.path.join(args.out, 'stdout.txt'), 'w'), stderr=subprocess.STDOUT)
proc = psutil.Process(app.pid)


def overlay_target():
    try:
        with urllib.request.urlopen(f'http://127.0.0.1:{args.port}/json/list', timeout=2) as r:
            pages = json.load(r)
    except OSError:
        return None
    return next((p for p in pages if 'overlay/index.html' in p.get('url', '')), None)


ov = wait(overlay_target, 90, 0.25)
check('overlay_page_found', ov, ov['url'] if ov else '')
if not ov:
    shot('no_overlay')
    app.kill()
    sys.exit(1)
page = Page(ov['webSocketDebuggerUrl'])
ready = wait(lambda: page.eval("typeof window.overlay === 'object' && document.readyState === 'complete'"), 30)
metrics['startup_to_overlay_s'] = round(time.time() - t_launch, 2)
check('overlay_api_present', ready)
check('hook_helper_running', wait(helpers, 30))
time.sleep(4)  # the startup sound and image warm-up, and the overlay parking once it is idle
shot('started')

# --- what the page can do ---------------------------------------------------------------------------------------
state = page.eval("""(async () => {
  const c = new AudioContext(); await new Promise((r) => setTimeout(r, 300)); const s = c.state; await c.close();
  return { audio: s, lang: navigator.language, ua: navigator.userAgent };
})()""")
check('sound_without_user_gesture', state['audio'] == 'running', state['audio'])
metrics['user_agent'] = state['ua']
metrics['page_language'] = state['lang']

files = []
for sub in ('emotes', 'sounds', 'textures'):
    for name in sorted(os.listdir(os.path.join(args.assets, sub))):
        files.append(f'{sub}/{name}')
bad = page.eval("""(async (files) => {
  const ctx = new OfflineAudioContext(1, 1, 44100); const bad = [];
  for (const f of files) {
    try {
      const res = await fetch('../' + f); if (!res.ok) throw new Error('http ' + res.status);
      const blob = await res.blob();
      if (/\\.(webp|png)$/.test(f)) { const b = await createImageBitmap(blob); if (!b.width) throw new Error('empty'); b.close(); }
      else if (/\\.(wav|ogg)$/.test(f)) await ctx.decodeAudioData(await blob.arrayBuffer());
    } catch (e) { bad.push(f + ': ' + e.message); }
  }
  return bad;
})(""" + json.dumps(files) + ')')
check('every_asset_loads_and_decodes', not bad, f'{len(files)} files, bad: {bad[:5]}')

page.eval("""(() => {
  window.__e2e = { starts: 0, events: [] };
  const mark = (what) => window.__e2e.events.push({ what, t: Date.now() });
  new MutationObserver(() => mark('pings')).observe(document.getElementById('pings'), { childList: true });
  new MutationObserver(() => mark('emotes')).observe(document.getElementById('emotes'), { childList: true });
  for (const id of ['wheel', 'emoteWheel'])
    new MutationObserver(() => mark(document.getElementById(id).classList.contains('open') ? id + ':open' : id + ':closed'))
      .observe(document.getElementById(id), { attributes: true, attributeFilter: ['class'] });
  const start = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (...a) { window.__e2e.starts++; return start.apply(this, a); };
  return true;
})()""")


def e2e():
    return page.eval('window.__e2e')


# --- input reaches the app underneath while lolPing idles -----------------------------------------------------
n = len(target_log())
click(320, 260)
check('click_passes_through_when_idle', wait(lambda: any(l.split()[1:3] == ['down', '1'] for l in target_log()[n:]), 3))
n = len(target_log())
key(0x41, True)
key(0x41, False)
check('key_passes_through_when_idle', wait(lambda: any(l.endswith('key a') for l in target_log()[n:]), 3))
check('target_in_front_before_gestures', foreground_title() == 'lolPing e2e target', foreground_title())

ovs = overlay_windows(proc.pid)
metrics['overlay_windows'] = [{'rect': r, 'flags': flags(ex)} for _, r, ex in ovs]
check('overlay_window_found', ovs, str(metrics['overlay_windows']))
check('overlay_is_topmost_and_click_through',
      ovs and all({'TOPMOST', 'TRANSPARENT', 'LAYERED'} <= set(flags(ex)) for _, _, ex in ovs))


def gesture(vk, x, y, name, sound_from):
    """Holds `vk`, drags up from (x, y) onto the wheel's top slice and lets go. Returns latencies in ms."""
    before = e2e()
    n = len(target_log())
    placed = {}

    def watch():
        # When the overlay is back on its display after waiting parked: what the user sees, not just the DOM.
        t = wait(lambda: any(on_display(r) for _, r, _ in overlay_windows(proc.pid)) and time.time(), 3, 0.002)
        placed['t'] = t

    move(x, y)
    time.sleep(0.1)
    key(vk, True)
    time.sleep(0.05)
    button(True)
    time.sleep(0.03)
    th = threading.Thread(target=watch)
    th.start()
    t_drag = None
    for i in range(1, 11):
        move(x, y - 14 * i)
        if t_drag is None:
            t_drag = time.time()
        time.sleep(0.015)
    time.sleep(0.3)
    shot(f'{name}_wheel')
    button(False)
    key(vk, False)
    th.join()
    time.sleep(0.25)
    after = e2e()
    events = after['events'][len(before['events']):]
    opened = next((e['t'] for e in events if e['what'].endswith(':open')), None)
    lat = {
        'wheel_in_dom_ms': round(opened - t_drag * 1000) if opened else None,
        'overlay_on_display_ms': round((placed['t'] - t_drag) * 1000) if placed.get('t') else None,
    }
    metrics[f'{name}_latency'] = lat
    check(f'{name}_wheel_opened', opened, json.dumps(lat))
    check(f'{name}_sound_played', after['starts'] > before['starts'] + sound_from, f"{after['starts'] - before['starts']} plays")
    downs = [l for l in target_log()[n:] if l.split()[1:3] == ['down', '1']]
    check(f'{name}_click_kept_from_app_underneath', not downs, str(downs))
    check(f'{name}_focus_stays_on_app', foreground_title() == 'lolPing e2e target', foreground_title())
    return events


ping_events = gesture(0xA4, 260, 330, 'ping', 0)  # left Alt
check('ping_drawn', any(e['what'] == 'pings' for e in ping_events))
# The ping is drawn where the wheel opened: a click right on it must still reach the window below.
n = len(target_log())
click(260, 330)
check('click_on_a_drawn_ping_passes_through', wait(lambda: any(l.split()[1:3] == ['down', '1'] for l in target_log()[n:]), 3))
shot('ping_after')
time.sleep(1)

emote_events = gesture(0xA2, 420, 360, 'emote', 0)  # left Ctrl
check('emote_drawn', any(e['what'] == 'emotes' for e in emote_events))
time.sleep(0.6)
img = page.eval("""(() => { const i = document.querySelector('#emotes img');
  return i ? { src: i.src, w: i.naturalWidth, done: i.complete } : null; })()""")
check('emote_animation_loaded', img and img['w'] > 0 and img['done'], json.dumps(img))
shot('emote_playing')

# --- latency from idle, several times -------------------------------------------------------------------------


def parked():
    ovs = overlay_windows(proc.pid)
    return ovs and not any(on_display(r) for _, r, _ in ovs)


def open_wheel_from_idle():
    """Alt+drag once the overlay is parked again. Returns (ms to the wheel in the page, ms to the overlay on display)."""
    if not wait(parked, 15, 0.1):
        return None, None
    time.sleep(0.5)
    before = len(e2e()['events'])
    placed = {}
    th = threading.Thread(target=lambda: placed.update(
        t=wait(lambda: any(on_display(r) for _, r, _ in overlay_windows(proc.pid)) and time.time(), 3, 0.002)))
    move(700, 500)
    time.sleep(0.1)
    key(0xA4, True)
    time.sleep(0.05)
    button(True)
    time.sleep(0.03)
    th.start()
    t_drag = None
    for i in range(1, 11):
        move(700, 500 - 14 * i)
        t_drag = t_drag or time.time()
        time.sleep(0.015)
    time.sleep(0.2)
    move(700, 500)  # back to the centre: let go there and no ping is placed, so the overlay idles again soon
    time.sleep(0.1)
    button(False)
    key(0xA4, False)
    th.join()
    opened = next((e['t'] for e in e2e()['events'][before:] if e['what'].endswith(':open')), None)
    return (round(opened - t_drag * 1000) if opened else None,
            round((placed['t'] - t_drag) * 1000) if placed.get('t') else None)


def median(xs):
    xs = sorted(x for x in xs if x is not None)
    return xs[len(xs) // 2] if xs else None


samples = [open_wheel_from_idle() for _ in range(args.reps)]
metrics['wheel_from_idle_ms'] = {
    'samples': samples,
    'in_page_median': median(s[0] for s in samples), 'in_page_max': max((s[0] for s in samples if s[0] is not None), default=None),
    'on_display_median': median(s[1] for s in samples), 'on_display_max': max((s[1] for s in samples if s[1] is not None), default=None),
}
check('wheel_opens_every_time', all(s[0] is not None and s[1] is not None for s in samples), json.dumps(samples))

# --- cost ---------------------------------------------------------------------------------------------------------
procs = [proc] + proc.children(recursive=True)
mem = [p.memory_info() for p in procs if p.is_running()]
metrics['processes'] = len(mem)
metrics['working_set_mb'] = round(sum(m.rss for m in mem) / 2**20, 1)
metrics['private_mb'] = round(sum(getattr(m, 'private', 0) for m in mem) / 2**20, 1)
metrics['exe_mb'] = round(os.path.getsize(args.app) / 2**20, 1)

# --- the helper goes when the app goes ------------------------------------------------------------------------------
# Only the app's own processes: the helper must notice by itself that lolPing is gone.
for p in procs:
    try:
        if not (p.name() or '').lower().startswith('hook-helper'):
            p.kill()
    except psutil.Error:
        pass
check('hook_helper_exits_with_app', wait(lambda: not helpers(), 10))
target.kill()
metrics['startup_first_s'] = metrics.pop('startup_to_overlay_s')


def time_to_overlay(command):
    """Seconds from launch until the overlay page is loaded and wired up, then stops the app and waits for it."""
    time.sleep(2)
    t0 = time.time()
    p = subprocess.Popen(command, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    took = None
    try:
        ov = wait(overlay_target, 120, 0.05)
        if ov:
            pg = Page(ov['webSocketDebuggerUrl'])
            if wait(lambda: pg.eval("typeof window.overlay === 'object' && document.readyState === 'complete'"), 30, 0.02):
                took = round(time.time() - t0, 2)
    finally:
        tree = [psutil.Process(p.pid)] + psutil.Process(p.pid).children(recursive=True)
        for q in tree:
            try:
                q.kill()
            except psutil.Error:
                pass
        psutil.wait_procs(tree, timeout=10)
        wait(lambda: not helpers(), 10)
    return took


metrics['startup_again_s'] = [time_to_overlay(cmd) for _ in range(2)]
if args.portable:
    pcmd = [args.portable] + cmd[1:]
    metrics['portable_startup_s'] = [time_to_overlay(pcmd) for _ in range(3)]
    metrics['portable_mb'] = round(os.path.getsize(args.portable) / 2**20, 1)

report = {'kind': args.kind, 'passed': all(results.values()), 'results': results, 'metrics': metrics}
with open(os.path.join(args.out, 'report.json'), 'w') as f:
    json.dump(report, f, indent=2)
print(json.dumps(metrics, indent=2))
summary = os.environ.get('GITHUB_STEP_SUMMARY')
if summary:
    with open(summary, 'a', encoding='utf-8') as f:
        f.write(f"### {args.kind}: {'passed' if report['passed'] else 'FAILED'}\n\n| check | result |\n| --- | --- |\n")
        for k, v in results.items():
            f.write(f"| {k} | {'pass' if v else '**FAIL**'} |\n")
        f.write(f"\n```json\n{json.dumps(metrics, indent=2)}\n```\n\n")
sys.exit(0 if report['passed'] else 1)
