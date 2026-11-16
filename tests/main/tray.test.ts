import { beforeEach, describe, expect, it, vi } from 'vitest';

// A fake Electron Tray that throws like the real one once destroyed.
const { FakeTray, created } = vi.hoisted(() => {
  const created: FakeTray[] = [];
  class FakeTray {
    destroyed = false;
    destroyCalls = 0;
    images: unknown[] = [];
    events: string[] = [];
    menus: unknown[] = [];
    constructor(image: unknown) {
      this.images.push(image);
      created.push(this);
    }
    private alive(): void {
      if (this.destroyed) throw new TypeError('Object has been destroyed');
    }
    on(event: string): void {
      this.alive();
      this.events.push(event);
    }
    setImage(image: unknown): void {
      this.alive();
      this.images.push(image);
    }
    tips: string[] = [];
    setToolTip(tip: string): void {
      this.alive();
      this.tips.push(tip);
    }
    setContextMenu(menu: unknown): void {
      this.alive();
      this.menus.push(menu);
    }
    destroy(): void {
      this.destroyCalls += 1;
      this.alive();
      this.destroyed = true;
    }
  }
  return { FakeTray, created };
});

const fakeImage = (): { template: boolean; [k: string]: unknown } => ({
  template: false,
  getSize: () => ({ width: 1, height: 1 }),
  toBitmap: () => Buffer.alloc(4),
  resize: () => fakeImage(),
  setTemplateImage(on: boolean) {
    this.template = on;
  },
});

vi.mock('electron', () => ({
  Tray: FakeTray,
  Menu: { buildFromTemplate: (items: unknown) => items },
  nativeImage: { createFromPath: () => fakeImage(), createFromBitmap: () => fakeImage() },
}));

import { AppTray, syncLines, trayUpdateFrom, type TraySync } from '../../src/main/tray';
import { strings } from '../../src/shared/i18n';

const room = {
  joinClipboard: vi.fn(), create: vi.fn(), copyCode: vi.fn(), setMuted: vi.fn(), syncNow: vi.fn(), leave: vi.fn(), openSettings: vi.fn(),
};
const update = { check: vi.fn(), start: vi.fn() };
const teammate = { stop: vi.fn(), openHistory: vi.fn(), setHistoryPaused: vi.fn() };
const handlers = {
  openSettings: vi.fn(), setEnabled: vi.fn(), retryHelper: vi.fn(), quit: vi.fn(), room, update, teammate,
};

type Item = { label?: string; type?: string; enabled?: boolean; checked?: boolean; submenu?: Item[]; click?: (item: Item) => void };
const roomMenu = (): Item[] => (created[0].menus.at(-1) as Item[]).find((i) => i.label === 'Room')!.submenu!;

const menuOf = (): Item[] => created[0].menus.at(-1) as Item[];

beforeEach(() => {
  created.length = 0;
  update.check.mockClear();
  update.start.mockClear();
});

describe('AppTray', () => {
  it('renders mode changes while alive', () => {
    const tray = new AppTray('icon.png', handlers);
    const before = created[0].images.length;
    tray.set('off', false);
    expect(created[0].images.length).toBe(before + 1);
  });

  it('ignores set() after destroy() instead of touching the destroyed Tray', () => {
    const tray = new AppTray('icon.png', handlers);
    tray.destroy();
    expect(() => tray.set('failed', false)).not.toThrow();
    expect(() => tray.set('on', true)).not.toThrow();
  });

  it('destroys the underlying Tray once, however often destroy() is called', () => {
    const tray = new AppTray('icon.png', handlers);
    tray.destroy();
    expect(() => tray.destroy()).not.toThrow();
    expect(created[0].destroyCalls).toBe(1);
  });

  it('uses template icons on macOS and leaves clicks to the menu', () => {
    const tray = new AppTray('icon.png', handlers, undefined, { on: 'on.png', off: 'off.png' });
    expect(created[0].events).not.toContain('click');
    expect((created[0].images[0] as { template: boolean }).template).toBe(true);
    tray.set('off', false);
    expect((created[0].images.at(-1) as { template: boolean }).template).toBe(true);
  });

  it('disables the Enabled item while Accessibility access is missing', () => {
    const tray = new AppTray('icon.png', handlers);
    tray.set('noAccess', true);
    const menu = created[0].menus.at(-1) as { label?: string; enabled?: boolean }[];
    expect(menu[0].enabled).toBe(false);
  });

  it('offers joining from the clipboard or creating a room when not in one', () => {
    new AppTray('icon.png', handlers);
    expect(roomMenu().map((i) => i.label)).toEqual(['Join from clipboard', 'Create room', 'Room settings…']);
    roomMenu()[0].click!({});
    expect(room.joinClipboard).toHaveBeenCalled();
  });

  it('shows the room, its size and the room actions while in one', () => {
    const tray = new AppTray('icon.png', handlers);
    tray.setRoom({ code: 'PING-7KQ4M-2HXTR', count: 3, muted: true });
    const items = roomMenu();
    expect(items[0]).toMatchObject({ label: 'PING-7KQ4M-2HXTR · 3 people', enabled: false });
    expect(items.filter((i) => i.type !== 'separator').map((i) => i.label)).toEqual([
      'PING-7KQ4M-2HXTR · 3 people', 'Copy code', 'Mute room', 'Leave room', 'Room settings…',
    ]);
    const mute = items.find((i) => i.label === 'Mute room')!;
    expect(mute).toMatchObject({ type: 'checkbox', checked: true });
    mute.click!({ checked: false });
    expect(room.setMuted).toHaveBeenCalledWith(false);
    tray.setRoom({ code: 'PING-7KQ4M-2HXTR', count: 1, muted: false });
    expect(roomMenu()[0].label).toBe('PING-7KQ4M-2HXTR · 1 person');
  });

  it('does not rebuild the menu when the room info is unchanged', () => {
    const tray = new AppTray('icon.png', handlers);
    tray.setRoom({ code: 'PING-7KQ4M-2HXTR', count: 2, muted: false });
    const menus = created[0].menus.length;
    tray.setRoom({ code: 'PING-7KQ4M-2HXTR', count: 2, muted: false });
    expect(created[0].menus.length).toBe(menus);
    tray.setRoom({ code: 'PING-7KQ4M-2HXTR', count: 3, muted: false });
    expect(created[0].menus.length).toBe(menus + 1);
  });

  it('shows Stop teammate only while an ask runs', () => {
    const tray = new AppTray('icon.png', handlers);
    const labels = (): (string | undefined)[] => menuOf().map((i) => i.label);
    expect(labels()).not.toContain('Teammate history…');
    tray.setTeammate({ running: false, historyOn: true, paused: false });
    expect(labels()).not.toContain('Stop teammate');
    expect(labels()).toContain('Teammate history…');
    tray.setTeammate({ running: true, historyOn: true, paused: false });
    menuOf().find((i) => i.label === 'Stop teammate')!.click!({});
    expect(teammate.stop).toHaveBeenCalledTimes(1);
    menuOf().find((i) => i.label === 'Pause history')!.click!({});
    expect(teammate.setHistoryPaused).toHaveBeenCalledWith(true);
    tray.setTeammate({ running: false, historyOn: true, paused: true });
    expect(labels()).not.toContain('Stop teammate');
    menuOf().find((i) => i.label === 'Resume history')!.click!({});
    expect(teammate.setHistoryPaused).toHaveBeenCalledWith(false);
    menuOf().find((i) => i.label === 'Teammate history…')!.click!({});
    expect(teammate.openHistory).toHaveBeenCalledTimes(1);
    tray.setTeammate({ running: false, historyOn: false, paused: false });
    expect(labels()).not.toContain('Pause history');
    tray.setTeammate(null);
    expect(labels()).not.toContain('Teammate history…');
  });

    it('ignores setRoom() after destroy()', () => {
    const tray = new AppTray('icon.png', handlers);
    tray.destroy();
    expect(() => tray.setRoom({ code: null, count: 0, muted: false })).not.toThrow();
  });
});

describe('trayUpdateFrom', () => {
  it('keeps the phase, and the version and percent where the state has them', () => {
    expect(trayUpdateFrom({ phase: 'idle', lastCheck: 5 })).toEqual({ phase: 'idle', version: undefined, percent: undefined });
    expect(trayUpdateFrom({ phase: 'checking', manual: false })).toEqual({ phase: 'checking', version: undefined, percent: undefined });
    expect(trayUpdateFrom({ phase: 'available', version: '0.5.1', notesUrl: 'https://example.test' }))
      .toEqual({ phase: 'available', version: '0.5.1', percent: undefined });
    expect(trayUpdateFrom({ phase: 'downloading', version: '0.5.1', percent: 42 })).toEqual({ phase: 'downloading', version: '0.5.1', percent: 42 });
    expect(trayUpdateFrom({ phase: 'installing', version: '0.5.1' })).toEqual({ phase: 'installing', version: '0.5.1', percent: undefined });
    expect(trayUpdateFrom({ phase: 'error', message: 'x', retry: 'download' })).toEqual({ phase: 'error', version: undefined, percent: undefined });
  });
});

describe('AppTray update item', () => {
  it('shows no update item without an updater', () => {
    const tray = new AppTray('icon.png', handlers);
    expect(menuOf()[0].label).toBe('Enabled');
    tray.setUpdate(null);
    expect(menuOf()[0].label).toBe('Enabled');
    expect(menuOf().map((i) => i.label)).not.toContain('Check for updates');
  });

  it('offers the update first, with a separator after it', () => {
    const tray = new AppTray('icon.png', handlers);
    tray.setUpdate({ phase: 'available', version: '0.5.1' });
    const menu = menuOf();
    expect(menu[0].label).toBe('Update to 0.5.1…');
    expect(menu[0].enabled).not.toBe(false);
    expect(menu[1].type).toBe('separator');
    expect(menu[2].label).toBe('Enabled');
    menu[0].click!({});
    expect(update.start).toHaveBeenCalledTimes(1);
    expect(update.check).not.toHaveBeenCalled();
  });

  it('shows download progress, disabled', () => {
    const tray = new AppTray('icon.png', handlers);
    tray.setUpdate({ phase: 'downloading', version: '0.5.1', percent: 42 });
    expect(menuOf()[0]).toMatchObject({ label: 'Downloading update… 42%', enabled: false });
    tray.setUpdate({ phase: 'downloading', version: '0.5.1', percent: 43 });
    expect(menuOf()[0].label).toBe('Downloading update… 43%');
  });

  it('shows a download that has no percent yet as 0%', () => {
    const tray = new AppTray('icon.png', handlers);
    tray.setUpdate({ phase: 'downloading', version: '0.5.1' });
    expect(menuOf()[0]).toMatchObject({ label: 'Downloading update… 0%', enabled: false });
  });

  it('shows the install, disabled', () => {
    const tray = new AppTray('icon.png', handlers);
    tray.setUpdate({ phase: 'installing', version: '0.5.1' });
    expect(menuOf()[0]).toMatchObject({ label: 'Installing update…', enabled: false });
  });

  it('otherwise offers a check', () => {
    const tray = new AppTray('icon.png', handlers);
    for (const phase of ['idle', 'checking', 'error'] as const) {
      tray.setUpdate({ phase });
      expect(menuOf()[0].label, phase).toBe('Check for updates');
      expect(menuOf()[1].type).toBe('separator');
    }
    tray.setUpdate({ phase: 'idle' });
    menuOf()[0].click!({});
    expect(update.check).toHaveBeenCalledTimes(1);
    expect(update.start).not.toHaveBeenCalled();
  });

  it('removes the item again when the updater goes away', () => {
    const tray = new AppTray('icon.png', handlers);
    tray.setUpdate({ phase: 'idle' });
    tray.setUpdate(null);
    expect(menuOf()[0].label).toBe('Enabled');
  });

  it('does not rebuild the menu for an unchanged update state', () => {
    const tray = new AppTray('icon.png', handlers);
    tray.setUpdate({ phase: 'downloading', version: '0.5.1', percent: 10 });
    const menus = created[0].menus.length;
    tray.setUpdate({ phase: 'downloading', version: '0.5.1', percent: 10 });
    expect(created[0].menus.length).toBe(menus);
    tray.setUpdate({ phase: 'downloading', version: '0.5.1', percent: 11 });
    expect(created[0].menus.length).toBe(menus + 1);
  });

  it('is in the other language after setText', () => {
    const tray = new AppTray('icon.png', handlers);
    tray.setUpdate({ phase: 'available', version: '0.5.1' });
    tray.setText(strings('zh-CN'));
    expect(menuOf()[0].label).toBe(strings('zh-CN').trayUpdateTo('0.5.1'));
    expect(menuOf()[0].label).not.toBe('Update to 0.5.1…');
  });

  it('ignores setUpdate() after destroy()', () => {
    const tray = new AppTray('icon.png', handlers);
    tray.destroy();
    expect(() => tray.setUpdate({ phase: 'available', version: '0.5.1' })).not.toThrow();
  });
});

describe('the tray’s sync status', () => {
  const en = strings('en');
  const sync = (over: Partial<TraySync> = {}): TraySync => ({ mine: { have: 12, total: 18 }, members: [], unshared: 0, ...over });
  const alex: TraySync['members'][number] = { name: 'Alex', path: 'lan', got: { have: 0, total: 5 }, sync: { have: 6, total: 6 } };
  const old: TraySync['members'][number] = { name: 'Old', path: 'internet', got: { have: 6, total: 6 }, sync: null };
  const labels = (): (string | undefined)[] => roomMenu().map((i) => i.label);

  it('says how much of what the room announces is here, as a percentage that only reaches 100 when all of it is', () => {
    expect(syncLines(sync(), en)).toEqual(['Sync: 66% (12 of 18)']);
    expect(syncLines(sync({ mine: { have: 199, total: 200 } }), en)).toEqual(['Sync: 99% (199 of 200)']);
    expect(syncLines(sync({ mine: { have: 18, total: 18 } }), en)).toEqual(['Sync: done (18 of 18)']);
    expect(syncLines(sync({ mine: { have: 0, total: 0 } }), en)).toEqual(['Sync: nothing to fetch']);
    expect(syncLines(sync({ mine: null }), en)).toEqual(['Sync: off (friends’ custom emotes are hidden)']);
  });

  it('says for each member how they are reached, what is here of theirs, and what they say they have', () => {
    const lines = syncLines(sync({ members: [alex, old, { name: 'New', path: 'connecting', got: null, sync: { have: 0, total: 0 } }], unshared: 2 }), en);
    expect(lines).toEqual([
      'Sync: 66% (12 of 18)',
      'Alex (LAN): got 0 of their 5; they have 100% of the room’s',
      'Old (internet): got 6 of their 6; they don’t report (older version, or sync off)',
      'New (connecting): shares no files; they have 100% of the room’s',
      '2 of your sounds have no copy to share yet',
    ]);
    expect(syncLines(sync({ unshared: 1 }), en).at(-1)).toBe('1 of your sounds has no copy to share yet');
  });

  it('doubles an ampersand in a member’s name, which a menu would otherwise read as a shortcut mark', () => {
    expect(syncLines(sync({ members: [{ ...old, name: 'A&B' }] }), en)[1]).toMatch(/^A&&B \(/);
  });

  it('has the same lines in Chinese', () => {
    const zh = strings('zh-CN');
    expect(syncLines(sync({ members: [alex, old], unshared: 1 }), zh)).toEqual([
      '同步：66%（12/18）', 'Alex（局域网）：已收到对方 0/5；对方已收到房间的 100%',
      'Old（互联网）：已收到对方 6/6；对方未回报（旧版本，或已关闭同步）', '你有 1 个声音还没有可分享的副本',
    ]);
  });

  it('shows the lines and a Sync now command in the Room submenu, and redraws when a count moves', () => {
    const tray = new AppTray('icon.png', handlers);
    tray.setRoom({ code: 'PING-7KQ4M-2HXTR', count: 2, muted: false, sync: sync({ members: [alex] }) });
    expect(labels().slice(0, 4)).toEqual([
      'PING-7KQ4M-2HXTR · 2 people', 'Sync: 66% (12 of 18)', 'Alex (LAN): got 0 of their 5; they have 100% of the room’s', 'Sync now',
    ]);
    expect(roomMenu().slice(1, 3).every((i) => i.enabled === false)).toBe(true);
    roomMenu().find((i) => i.label === 'Sync now')!.click!({});
    expect(room.syncNow).toHaveBeenCalledTimes(1);

    const menus = created[0].menus.length;
    tray.setRoom({ code: 'PING-7KQ4M-2HXTR', count: 2, muted: false, sync: sync({ members: [alex] }) });
    expect(created[0].menus.length).toBe(menus); // nothing moved
    tray.setRoom({ code: 'PING-7KQ4M-2HXTR', count: 2, muted: false, sync: sync({ members: [{ ...alex, got: { have: 1, total: 5 } }] }) });
    expect(created[0].menus.length).toBe(menus + 1);
    expect(labels()[2]).toBe('Alex (LAN): got 1 of their 5; they have 100% of the room’s');
  });

  it('puts the percentage in the tooltip only while files are still on their way', () => {
    const tray = new AppTray('icon.png', handlers);
    tray.setRoom({ code: 'PING-7KQ4M-2HXTR', count: 2, muted: false, sync: sync() });
    expect(created[0].tips.at(-1)).toBe('lolPing: pings on · syncing 66%');
    tray.setRoom({ code: 'PING-7KQ4M-2HXTR', count: 2, muted: false, sync: sync({ mine: { have: 18, total: 18 } }) });
    expect(created[0].tips.at(-1)).toBe('lolPing: pings on');
    tray.setRoom({ code: null, count: 0, muted: false, sync: sync() }); // left the room with files still missing
    expect(created[0].tips.at(-1)).toBe('lolPing: pings on');
  });
});
