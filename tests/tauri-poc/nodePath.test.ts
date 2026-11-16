import * as node from 'node:path';
import { describe, expect, it } from 'vitest';
import { makePath } from '../../tauri-poc/web/node/path';

// The page's node:path has to agree with Node's on Windows and POSIX paths, or files land in the wrong folder.
const win = makePath(true, () => 'C:\\Users\\amer\\Desktop');
const nodeWin = { ...node.win32, resolve: (...p: string[]) => node.win32.resolve('C:\\Users\\amer\\Desktop', ...p) };
const nix = makePath(false, () => '/home/amer');
const nodeNix = { ...node.posix, resolve: (...p: string[]) => node.posix.resolve('/home/amer', ...p) };

const WIN = [
  'C:\\Users\\amer\\Desktop\\data', 'C:/Users/amer/data/settings.json', 'C:\\a\\..\\b\\.\\c\\', 'C:\\', 'C:', 'C:foo',
  '\\__lolping_app__\\main', '/__lolping_app__/renderer/textures/x.png', '\\\\server\\share\\dir\\f.txt', 'a\\b\\..\\..\\..',
  'relative\\path', '', '.', 'emotes\\', 'file.tar.gz', '.hidden',
];
const NIX = ['/home/amer/.config/lolPing', '/a/../b/./c/', '/', 'a/b/../../..', 'relative/path', '', '.', 'x/', 'f.tar.gz', '.hidden'];

describe('makePath', () => {
  it('normalizes, splits and joins Windows paths as Node does', () => {
    for (const p of WIN) {
      expect(win.normalize(p), p).toBe(node.win32.normalize(p));
      expect(win.dirname(p), p).toBe(node.win32.dirname(p));
      expect(win.basename(p), p).toBe(node.win32.basename(p));
      expect(win.extname(p), p).toBe(node.win32.extname(p));
      expect(win.isAbsolute(p), p).toBe(node.win32.isAbsolute(p));
      expect(win.join(p, 'emotes', 'x.png'), p).toBe(node.win32.join(p, 'emotes', 'x.png'));
    }
    expect(win.join('/__lolping_app__/main', '../renderer', 'textures', 'logo.png')).toBe(
      node.win32.join('/__lolping_app__/main', '../renderer', 'textures', 'logo.png'));
    expect(win.basename('C:\\a\\settings.json', '.json')).toBe('settings');
  });

  it('resolves and relates Windows paths as Node does', () => {
    const pairs: [string, string][] = [
      ['C:\\Users\\amer\\data', 'C:\\Users\\amer\\data\\emotes\\a.png'], ['C:\\a\\b', 'C:\\a\\c\\d'],
      ['C:\\A\\b', 'c:\\a\\B\\x'], ['C:\\a', 'D:\\b'], ['data', 'data\\emotes'],
    ];
    for (const [a, b] of pairs) {
      expect(win.relative(a, b), `${a} -> ${b}`).toBe(node.win32.relative(nodeWin.resolve(a), nodeWin.resolve(b)));
      expect(win.resolve(a, b)).toBe(nodeWin.resolve(a, b));
    }
    expect(win.resolve('data', '..', 'x')).toBe(nodeWin.resolve('data', '..', 'x'));
  });

  it('handles POSIX paths as Node does', () => {
    for (const p of NIX) {
      expect(nix.normalize(p), p).toBe(node.posix.normalize(p));
      expect(nix.dirname(p), p).toBe(node.posix.dirname(p));
      expect(nix.basename(p), p).toBe(node.posix.basename(p));
      expect(nix.extname(p), p).toBe(node.posix.extname(p));
      expect(nix.join(p, 'a', '..', 'b'), p).toBe(node.posix.join(p, 'a', '..', 'b'));
      expect(nix.resolve(p, 'x'), p).toBe(nodeNix.resolve(p, 'x'));
    }
    expect(nix.relative('/home/amer/data', '/home/amer/data/emotes/a')).toBe(node.posix.relative('/home/amer/data', '/home/amer/data/emotes/a'));
    expect(nix.relative('/a/b', '/c')).toBe(node.posix.relative('/a/b', '/c'));
  });
});
