"""lolPing on Tauri and lolPing on Electron in the same room, on one Windows desktop, with real input.

The Tauri build creates the room from its settings page, the Electron build joins with the code, then each places a
ping through SendInput and the test looks for it on the other's overlay. Then each imports a custom emote, and the
other's overlay must load it from its own data folder once the room has synced it. A paused app drops room pings too, so the two
apps get different trigger keys instead: Alt for Tauri, Shift for Electron. Before that the test changes a setting on
the Tauri settings page and reads it back from settings.json.

usage: python e2e_room.py --tauri <exe> --electron <exe> --out <dir>
needs: pip install websocket-client pillow psutil
"""
import argparse
import ctypes
import ctypes.wintypes as W
import json
import os
import subprocess
import sys
import time
import urllib.request

import psutil
import websocket
from PIL import ImageGrab

ap = argparse.ArgumentParser()
ap.add_argument('--tauri', required=True)
ap.add_argument('--electron', required=True)
ap.add_argument('--out', required=True)
args = ap.parse_args()
os.makedirs(args.out, exist_ok=True)

ctypes.windll.shcore.SetProcessDpiAwareness(2)
user32 = ctypes.WinDLL('user32', use_last_error=True)
SW, SH = user32.GetSystemMetrics(0), user32.GetSystemMetrics(1)
ULONG_PTR = ctypes.c_size_t


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [('dx', W.LONG), ('dy', W.LONG), ('mouseData', W.DWORD), ('dwFlags', W.DWORD), ('time', W.DWORD),
                ('dwExtraInfo', ULONG_PTR)]


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [('wVk', W.WORD), ('wScan', W.WORD), ('dwFlags', W.DWORD), ('time', W.DWORD), ('dwExtraInfo', ULONG_PTR)]


class HARDWAREINPUT(ctypes.Structure):
    _fields_ = [('uMsg', W.DWORD), ('wParamL', W.WORD), ('wParamH', W.WORD)]


class _U(ctypes.Union):
    _fields_ = [('mi', MOUSEINPUT), ('ki', KEYBDINPUT), ('hi', HARDWAREINPUT)]


class INPUT(ctypes.Structure):
    _fields_ = [('type', W.DWORD), ('u', _U)]


def send(i):
    if user32.SendInput(1, ctypes.byref(i), ctypes.sizeof(INPUT)) != 1:
        raise OSError(f'SendInput failed: {ctypes.get_last_error()}')


def mouse(flags, x=0, y=0):
    i = INPUT(type=0)
    i.u.mi = MOUSEINPUT(dx=x * 65535 // (SW - 1), dy=y * 65535 // (SH - 1), dwFlags=flags)
    send(i)


def move(x, y):
    mouse(0x0001 | 0x8000, x, y)


def key(vk, down):
    i = INPUT(type=1)
    i.u.ki = KEYBDINPUT(wVk=vk, wScan=user32.MapVirtualKeyW(vk, 0), dwFlags=0 if down else 0x0002)
    send(i)


ALT, SHIFT = 0xA4, 0xA0


def trigger_drag(vk, x, y):
    """Trigger+drag up onto the wheel's top slice: a ping where the wheel opened."""
    move(x, y)
    time.sleep(0.1)
    key(vk, True)
    time.sleep(0.05)
    mouse(0x0002)
    time.sleep(0.03)
    for i in range(1, 11):
        move(x, y - 14 * i)
        time.sleep(0.015)
    time.sleep(0.3)
    mouse(0x0004)
    key(vk, False)


class Page:
    """One page over the DevTools protocol."""

    def __init__(self, ws_url):
        self.ws = websocket.create_connection(ws_url, timeout=90, suppress_origin=True)
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
                    raise RuntimeError(json.dumps(res['exceptionDetails'])[:600])
                return res.get('result', {}).get('value')


def page(port, path, timeout=90):
    end = time.time() + timeout
    while time.time() < end:
        try:
            with urllib.request.urlopen(f'http://127.0.0.1:{port}/json/list', timeout=2) as r:
                hit = next((p for p in json.load(r) if path in p.get('url', '')), None)
            if hit:
                pg = Page(hit['webSocketDebuggerUrl'])
                if wait(lambda: pg.eval("document.readyState === 'complete' && !!(window.settingsApi || window.overlay)"), 30):
                    return pg
        except OSError:
            pass
        time.sleep(0.25)
    return None


def wait(cond, timeout, step=0.1):
    end = time.time() + timeout
    while time.time() < end:
        try:
            v = cond()
        except Exception:  # a page reloading, a file being replaced: try again
            v = None
        if v:
            return v
        time.sleep(step)
    return None


results, notes = {}, {}


def check(name, ok, detail=''):
    results[name] = bool(ok)
    print(f"{'PASS' if ok else 'FAIL'} {name} {detail}", flush=True)


def shot(name):
    ImageGrab.grab().save(os.path.join(args.out, f'{name}.png'))


# A 96x96 WebP drawn in the page, imported the way the settings window imports a picked image.
IMPORT_EMOTE = """(async () => {
  const c = document.createElement('canvas');
  c.width = c.height = 96;
  const g = c.getContext('2d');
  g.fillStyle = '%s';
  g.fillRect(0, 0, 96, 96);
  g.fillStyle = '#fff';
  g.fillRect(24, 24, 48, 48);
  const blob = await new Promise((r) => c.toBlob(r, 'image/webp', 0.9));
  return window.settingsApi.importEmote({ name: 'e2e', still: new Uint8Array(await blob.arrayBuffer()) });
})()"""

# What the overlay does with an emote: an <img> for the still, fetch() for sounds. Both must work from its own origin.
LOAD_EMOTE = """(async () => {
  const url = %s;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) return { status: res.status };
  const img = new Image();
  img.src = url;
  await img.decode();
  return { status: res.status, type: res.headers.get('content-type'), w: img.naturalWidth };
})()"""

COUNT_PINGS = """(() => {
  if (!window.__seen) {
    window.__seen = { pings: 0 };
    new MutationObserver((list) => { for (const m of list) window.__seen.pings += m.addedNodes.length; })
      .observe(document.getElementById('pings'), { childList: true });
  }
  return window.__seen.pings;
})()"""

class Stop(Exception):
    """A check failed that the rest depends on."""


procs = []
try:
    # --- Tauri: settings ------------------------------------------------------------------------------------------
    tauri_log = os.path.join(args.out, 'tauri.log')
    env = {**os.environ, 'LOLPING_POC_CDP_PORT': '9333', 'LOLPING_POC_LOG': tauri_log}
    procs.append(subprocess.Popen([args.tauri], env=env))
    t_set = page(9333, 'settings/index.html')
    check('tauri_settings_page_opens', t_set)
    if not t_set:
        shot('no_settings')
        raise Stop
    t_ov = page(9333, 'overlay/index.html')
    shot('tauri_settings')
    s = t_set.eval('window.settingsApi.getSettings()')
    check('tauri_settings_load', isinstance(s, dict) and s.get('trigger'), f"trigger={s.get('trigger')}")
    status = wait(lambda: (lambda st: st if st['helper'] == 'running' else None)(t_set.eval('window.settingsApi.getStatus()')), 30)
    check('tauri_status_helper_running', status, json.dumps(status))
    data_file = os.path.join(os.path.dirname(os.path.abspath(args.tauri)), 'data', 'settings.json')
    want = not s.get('clickPing')
    t_set.eval(f'window.settingsApi.setSettings({{ clickPing: {json.dumps(want)} }})')
    saved = wait(lambda: json.load(open(data_file, encoding='utf-8')).get('clickPing') == want, 5)
    check('tauri_setting_saved_to_file', saved, data_file)
    t_set.eval(f'window.settingsApi.setSettings({{ clickPing: {json.dumps(not want)} }})')

    # --- Tauri creates a room, Electron joins ----------------------------------------------------------------------
    t_set.eval('window.settingsApi.createRoom()')
    room = wait(lambda: (lambda r: r if r['phase'] == 'active' and r['code'] else None)(t_set.eval('window.settingsApi.getRoom()')), 90, 0.5)
    check('tauri_creates_room', room, json.dumps({k: room[k] for k in ('code', 'lan', 'internet')}) if room else '')
    if not room:
        shot('no_room')
        raise Stop
    code = room['code']

    procs.append(subprocess.Popen([args.electron, '--remote-debugging-port=9334']))
    e_set = page(9334, 'settings/index.html')
    e_ov = page(9334, 'overlay/index.html')
    check('electron_starts', e_set and e_ov)
    if not (e_set and e_ov and t_ov):
        shot('no_electron')
        raise Stop
    t_set.eval("window.settingsApi.setSettings({ trigger: 'alt' })")
    e_set.eval("window.settingsApi.setSettings({ trigger: 'shift' })")
    triggers = (t_set.eval('window.settingsApi.getSettings()')['trigger'], e_set.eval('window.settingsApi.getSettings()')['trigger'])
    check('trigger_keys_set', triggers == ('alt', 'shift'), json.dumps(triggers))
    joined = e_set.eval(f'window.settingsApi.joinRoom({json.dumps(code)})')
    check('electron_join_accepted', joined and joined.get('ok'), json.dumps(joined))

    def other(pg):
        r = pg.eval('window.settingsApi.getRoom()')
        m = [x for x in r['members'] if not x['self']]
        return m[0] if m and m[0]['path'] in ('lan', 'internet') else None

    e_sees = wait(lambda: other(e_set), 120, 0.5)
    t_sees = wait(lambda: other(t_set), 60, 0.5)
    check('electron_sees_tauri_member', e_sees, json.dumps(e_sees and {k: e_sees[k] for k in ('name', 'path', 'needsUpdate')}))
    check('tauri_sees_electron_member', t_sees, json.dumps(t_sees and {k: t_sees[k] for k in ('name', 'path', 'needsUpdate')}))
    shot('both_in_room')

    # --- pings both ways -------------------------------------------------------------------------------------------
    def ping_from(vk, sender_ov, receiver_ov, name, x):
        sent, before = sender_ov.eval(COUNT_PINGS), receiver_ov.eval(COUNT_PINGS)
        trigger_drag(vk, x, 600)
        drawn = wait(lambda: sender_ov.eval(COUNT_PINGS) > sent, 5, 0.1)
        got = wait(lambda: receiver_ov.eval(COUNT_PINGS) > before, 15, 0.2)
        shot(f'ping_from_{name}')
        return drawn, got

    if e_sees and t_sees:
        drawn, got = ping_from(ALT, t_ov, e_ov, 'tauri', 300)
        check('tauri_draws_own_ping', drawn)
        check('tauri_ping_reaches_electron', got)
        time.sleep(2)
        drawn, got = ping_from(SHIFT, e_ov, t_ov, 'electron', 700)
        check('electron_draws_own_ping', drawn)
        check('electron_ping_reaches_tauri', got)

        # --- custom emotes both ways ---------------------------------------------------------------------------------
        e_imp = e_set.eval(IMPORT_EMOTE % '#e0457b')
        t_imp = t_set.eval(IMPORT_EMOTE % '#2f8fd8')
        check('electron_imports_emote', e_imp and e_imp.get('ok'), json.dumps(e_imp))
        check('tauri_imports_emote', t_imp and t_imp.get('ok'), json.dumps(t_imp))
        tauri_url = lambda ref: json.dumps(f'http://lolping.localhost/emotes/{ref[2:]}.webp')
        electron_url = lambda ref: json.dumps(f'lolping://emotes/{ref[2:]}.webp')

        def loads(ov, url):
            r = ov.eval(LOAD_EMOTE % url)
            return r if r and r.get('w') == 96 else None

        if t_imp and t_imp.get('ok'):
            r = wait(lambda: loads(t_ov, tauri_url(t_imp['id'])), 10, 0.5)
            check('tauri_overlay_loads_own_emote', r, json.dumps(r))
            r = wait(lambda: loads(e_ov, electron_url(t_imp['id'])), 90, 1)
            check('electron_overlay_loads_emote_from_tauri', r, json.dumps(r))
        if e_imp and e_imp.get('ok'):
            r = wait(lambda: loads(t_ov, tauri_url(e_imp['id'])), 90, 1)
            check('tauri_overlay_loads_emote_from_electron', r, json.dumps(r))
            if not r:
                try:
                    print('last try:', t_ov.eval(LOAD_EMOTE % tauri_url(e_imp['id'])))
                except RuntimeError as e:
                    print('last try:', e)
    t_set.eval('window.settingsApi.leaveRoom()')
    e_set.eval('window.settingsApi.leaveRoom()')
    time.sleep(1)
except Stop:
    pass
finally:
    for p in procs:
        try:
            tree = [psutil.Process(p.pid)] + psutil.Process(p.pid).children(recursive=True)
        except psutil.Error:
            continue
        for q in tree:
            try:
                q.kill()
            except psutil.Error:
                pass
    if os.path.exists(os.path.join(args.out, 'tauri.log')):
        print('--- tauri log ---')
        print(open(os.path.join(args.out, 'tauri.log'), encoding='utf-8', errors='replace').read()[-3000:])

report = {'passed': bool(results) and all(results.values()), 'results': results}
with open(os.path.join(args.out, 'report.json'), 'w') as f:
    json.dump(report, f, indent=2)
summary = os.environ.get('GITHUB_STEP_SUMMARY')
if summary:
    with open(summary, 'a', encoding='utf-8') as f:
        f.write(f"### Tauri and Electron in one room: {'passed' if report['passed'] else 'FAILED'}\n\n| check | result |\n| --- | --- |\n")
        for k, v in results.items():
            f.write(f"| {k} | {'pass' if v else '**FAIL**'} |\n")
sys.exit(0 if report['passed'] else 1)
