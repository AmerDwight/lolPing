// The hidden core page: the part of src/main/index.ts that runs the hook helper and the overlays, on Tauri.
// OverlayManager is the Electron app's own file, unchanged; the build swaps its Electron imports for electronShim.ts.
import { OverlayManager, type SharedEmote, type SharedPing } from '../../src/main/overlayManager';
import { RestartPolicy } from '../../src/main/restartPolicy';
import { isBundledEmote, type EmoteArt, type EmoteRef } from '../../src/shared/emotes';
import { resolveLang, strings } from '../../src/shared/i18n';
import { platformOf } from '../../src/shared/platform';
import { HELPER_VERSION, configCommand, parseHelperLine, serializeCommand, type HelperCommand } from '../../src/shared/protocol';
import { DEFAULT_SETTINGS, overlaySettings } from '../../src/shared/settings';
import { sameMonitors, toDisplays, type Monitor } from './displays';
import { dispatchIpc, screen } from './electronShim';
import { setPlatform } from './pathsShim';
import { invoke } from './tauri';

interface AppInfo {
  platform: string;
  monitors: Monitor[];
}

declare global {
  interface Window {
    /** Where the shell delivers helper output and the overlays' messages. */
    __core?: {
      helperLine(line: string): void;
      helperExit(): void;
      ipc(label: string, channel: string, payload: unknown): void;
    };
  }
}

const log = (msg: string): void => {
  invoke('log', { msg }).catch(() => undefined);
};

/** The proof of concept has no settings file or imported emotes yet: the defaults, bundled emotes only. */
const settings = DEFAULT_SETTINGS;
const resolveArt = (ref: EmoteRef): EmoteArt => (isBundledEmote(ref) ? { kind: 'bundled', slug: ref } : { kind: 'placeholder' });

async function start(): Promise<void> {
  const info = await invoke<AppInfo>('app_info');
  const platform = platformOf(info.platform);
  setPlatform(platform);
  let monitors = info.monitors;
  screen.update(toDisplays(monitors));
  const lang = resolveLang(settings.language, navigator.language);
  const t = strings(lang, platform);

  const overlays = new OverlayManager(overlaySettings(settings, lang), resolveArt);
  overlays.on('shared', (p: SharedPing) => log(`pinged ${p.id} at ${Math.round(p.x)},${Math.round(p.y)} on display ${p.displayId}`));
  overlays.on('sharedEmote', (p: SharedEmote) => log(`emoted ${p.ref} at ${Math.round(p.x)},${Math.round(p.y)} on display ${p.displayId}`));

  const policy = new RestartPolicy();
  const write = (cmd: HelperCommand): void => {
    invoke('helper_write', { line: serializeCommand(cmd) }).catch((e: unknown) => log(`helper_write: ${String(e)}`));
  };
  window.__core = {
    helperLine(line) {
      const ev = parseHelperLine(line);
      if (!ev) {
        log(`unparsed helper output: ${line}`);
        return;
      }
      if (ev.type === 'ready') {
        log(`helper ready, version ${ev.version}${ev.version === HELPER_VERSION ? '' : ` (this build expects ${HELPER_VERSION})`}`);
        write(configCommand(settings, settings.enabledOnStart));
      }
      if (ev.type === 'error') log(`helper error: ${ev.message}`);
      overlays.handle(ev);
    },
    helperExit() {
      overlays.cancelWheel();
      const delay = policy.onExit(Date.now());
      log(delay === 'giveUp' ? 'helper stopped, not restarting' : `helper stopped, restarting in ${delay} ms`);
      if (delay !== 'giveUp') setTimeout(() => invoke('helper_start').catch((e: unknown) => log(`helper_start: ${String(e)}`)), delay);
    },
    ipc: dispatchIpc,
  };

  overlays.start();
  await invoke('set_tray', { tooltip: t.trayTip(true), quit: t.trayQuit });
  await invoke('core_ready');
  await invoke('helper_start');
  log(`core started: ${monitors.length} display(s), locale ${navigator.language}, UI ${lang}`);

  // Tauri has no display-change event: look every 2 s. OverlayManager also checks before each wheel, as on Electron.
  setInterval(() => {
    invoke<AppInfo>('app_info')
      .then((next) => {
        if (sameMonitors(monitors, next.monitors)) return;
        monitors = next.monitors;
        screen.update(toDisplays(monitors));
      })
      .catch(() => undefined);
  }, 2000);
}

start().catch((e: unknown) => log(`core failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`));
