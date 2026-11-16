// node:path for main-process code in a page: Node's posix and win32 rules for the functions src/main uses.

interface Flavor {
  sep: '/' | '\\';
  win: boolean;
}

const isSep = (f: Flavor, c: string): boolean => c === '/' || (f.win && c === '\\');

/**
 * The root of `p` normalized ('C:\\', '\\\\server\\share\\', '\\', '/' or ''), the rest, and the root as written, which
 * dirname keeps as Node does.
 */
function splitRoot(f: Flavor, p: string): [string, string, string] {
  if (!f.win) {
    const m = /^\/+/.exec(p);
    return m ? ['/', p.slice(m[0].length), m[0]] : ['', p, ''];
  }
  const unc = /^[\\/]{2}([^\\/]+)[\\/]+([^\\/]+)(?:[\\/]+|$)/.exec(p);
  if (unc) return [`\\\\${unc[1]}\\${unc[2]}\\`, p.slice(unc[0].length), unc[0]];
  const drive = /^([A-Za-z]:)([\\/]*)/.exec(p);
  if (drive) return [drive[2] ? `${drive[1]}\\` : drive[1], p.slice(drive[0].length), drive[1] + drive[2].slice(0, 1)];
  const lead = /^[\\/]+/.exec(p);
  if (lead) return ['\\', p.slice(lead[0].length), p[0]];
  return ['', p, ''];
}

function normalizeOf(f: Flavor, p: string): string {
  if (p === '') return '.';
  const [root, rest] = splitRoot(f, p);
  const trailing = p.length > root.length && isSep(f, p[p.length - 1]);
  const out: string[] = [];
  for (const seg of rest.split(f.win ? /[\\/]+/ : /\/+/)) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else if (!root) out.push('..');
      continue;
    }
    out.push(seg);
  }
  let body = out.join(f.sep);
  if (body === '' && !root) return trailing ? `.${f.sep}` : '.';
  if (body === '' && !root.endsWith(f.sep)) return `${root}.`; // 'C:' is the current folder of drive C
  if (trailing && body) body += f.sep;
  return root + body;
}

const isAbsoluteOf = (f: Flavor, p: string): boolean => {
  if (!f.win) return p.startsWith('/');
  return /^[A-Za-z]:[\\/]/.test(p) || (p.length > 0 && isSep(f, p[0]));
};

function joinOf(f: Flavor, parts: string[]): string {
  const kept = parts.filter((p) => p !== '');
  return kept.length === 0 ? '.' : normalizeOf(f, kept.join(f.sep));
}

function resolveOf(f: Flavor, cwd: () => string, parts: string[]): string {
  let acc = '';
  for (let i = parts.length - 1; i >= 0 && !isAbsoluteOf(f, acc); i--) {
    if (parts[i]) acc = acc ? `${parts[i]}${f.sep}${acc}` : parts[i];
  }
  if (!isAbsoluteOf(f, acc)) acc = acc ? `${cwd()}${f.sep}${acc}` : cwd();
  const n = normalizeOf(f, acc);
  const [root] = splitRoot(f, n);
  return n.length > root.length && isSep(f, n[n.length - 1]) ? n.slice(0, -1) : n;
}

function dirnameOf(f: Flavor, p: string): string {
  if (p === '') return '.';
  const [, rest, root] = splitRoot(f, p);
  let end = rest.length;
  while (end > 0 && isSep(f, rest[end - 1])) end--;
  let cut = end;
  while (cut > 0 && !isSep(f, rest[cut - 1])) cut--;
  if (cut === 0) return root || '.';
  let stop = cut;
  while (stop > 0 && isSep(f, rest[stop - 1])) stop--;
  return root + rest.slice(0, stop);
}

function basenameOf(f: Flavor, p: string, ext?: string): string {
  const [root, rest] = splitRoot(f, p);
  if (rest === '' && root) return '';
  let end = rest.length;
  while (end > 0 && isSep(f, rest[end - 1])) end--;
  let start = end;
  while (start > 0 && !isSep(f, rest[start - 1])) start--;
  const base = rest.slice(start, end);
  return ext && base !== ext && base.endsWith(ext) ? base.slice(0, -ext.length) : base;
}

function extnameOf(f: Flavor, p: string): string {
  const base = basenameOf(f, p);
  const dot = base.lastIndexOf('.');
  return dot <= 0 || base === '..' ? '' : base.slice(dot);
}

function relativeOf(f: Flavor, cwd: () => string, from: string, to: string): string {
  const a = resolveOf(f, cwd, [from]);
  const b = resolveOf(f, cwd, [to]);
  const same = (x: string, y: string): boolean => (f.win ? x.toLowerCase() === y.toLowerCase() : x === y);
  if (same(a, b)) return '';
  const [ra] = splitRoot(f, a);
  const [rb] = splitRoot(f, b);
  if (!same(ra, rb)) return b;
  const pa = a.slice(ra.length).split(f.sep).filter(Boolean);
  const pb = b.slice(rb.length).split(f.sep).filter(Boolean);
  let i = 0;
  while (i < pa.length && i < pb.length && same(pa[i], pb[i])) i++;
  return [...pa.slice(i).map(() => '..'), ...pb.slice(i)].join(f.sep);
}

export interface PathModule {
  sep: string;
  delimiter: string;
  normalize(p: string): string;
  join(...parts: string[]): string;
  resolve(...parts: string[]): string;
  dirname(p: string): string;
  basename(p: string, ext?: string): string;
  extname(p: string): string;
  isAbsolute(p: string): boolean;
  relative(from: string, to: string): string;
  toNamespacedPath(p: string): string;
}

export function makePath(win: boolean, cwd: () => string = () => (win ? 'C:\\' : '/')): PathModule {
  const f: Flavor = { sep: win ? '\\' : '/', win };
  return {
    sep: f.sep,
    delimiter: win ? ';' : ':',
    normalize: (p) => normalizeOf(f, p),
    join: (...parts) => joinOf(f, parts),
    resolve: (...parts) => resolveOf(f, cwd, parts),
    dirname: (p) => dirnameOf(f, p),
    basename: (p, ext) => basenameOf(f, p, ext),
    extname: (p) => extnameOf(f, p),
    isAbsolute: (p) => isAbsoluteOf(f, p),
    relative: (from, to) => relativeOf(f, cwd, from, to),
    toNamespacedPath: (p) => p,
  };
}

const onWindows = typeof process !== 'undefined' && process.platform === 'win32';
const cwd = (): string => (typeof process !== 'undefined' ? process.cwd() : '/');
const here = makePath(onWindows, cwd);

export const posix = makePath(false, cwd);
export const win32 = makePath(true, cwd);
export const { sep, delimiter, normalize, join, resolve, dirname, basename, extname, isAbsolute, relative, toNamespacedPath } = here;
export default { ...here, posix, win32 };
