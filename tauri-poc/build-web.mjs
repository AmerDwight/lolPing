// `node tauri-poc/build-web.mjs`, after `npx electron-vite build`: what the Tauri shell embeds, in tauri-poc/dist.
// - the Electron app's pages (out/renderer), unchanged but for letting their CSP reach Tauri's bridge;
// - core/: the Electron main process, src/main/index.ts as it is, on the Node and Electron stand-ins in web/;
// - __preload/: each src/preload file as it is, on the renderer-side Electron stand-in.
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const web = join(here, 'web');
const renderer = join(root, 'out', 'renderer');
if (!existsSync(join(renderer, 'overlay', 'index.html'))) {
  console.error('No out/renderer: run `npx electron-vite build` first.');
  process.exit(1);
}
const dist = join(here, 'dist');
// The platform the app is built for: this one, or LOLPING_POC_PLATFORM when building Windows from Linux.
const platform = process.env.LOLPING_POC_PLATFORM ?? process.platform;
rmSync(dist, { recursive: true, force: true });
cpSync(renderer, dist, { recursive: true });

// Tauri's bridge posts to ipc:// (http://ipc.localhost on Windows). Electron's pages had no reason to allow it.
// Windows serves the lolping scheme as http://lolping.localhost, so the pages may load emotes from there too.
const IPC = 'ipc: http://ipc.localhost';
for (const page of readdirSync(dist)) {
  const file = join(dist, page, 'index.html');
  if (!existsSync(file)) continue;
  const html = readFileSync(file, 'utf8');
  const patched = html.replace(/(http-equiv="Content-Security-Policy"\s+content=")([^"]*)"/, (_m, head, csp) => {
    const withEmotes = csp.replaceAll('lolping://emotes', 'lolping://emotes http://lolping.localhost');
    return `${head}${/connect-src/.test(withEmotes) ? withEmotes.replace(/connect-src/, `connect-src ${IPC}`) : `${withEmotes}; connect-src 'self' ${IPC}`}"`;
  });
  writeFileSync(file, patched);
}

const NODE = {
  'node:events': 'node/events.ts', events: 'node/events.ts',
  'node:buffer': 'node/buffer.ts',
  'node:fs': 'node/fs.ts',
  'node:fs/promises': 'node/fsPromises.ts',
  'node:path': 'node/path.ts',
  'node:os': 'node/os.ts',
  'node:crypto': 'node/crypto.ts',
  'node:child_process': 'node/childProcess.ts',
  'node:readline': 'node/readline.ts',
  'node:dgram': 'node/dgram.ts',
  'node:net': 'node/small.ts',
  'node:url': 'node/small.ts',
};

/** Points Electron and Node's modules at the stand-ins; any other node: module fails the build. */
const standIns = (electron) => ({
  name: 'tauri-stand-ins',
  setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: join(web, electron) }));
    b.onResolve({ filter: /^electron-updater$/ }, () => ({ path: join(web, 'electron/updater.ts') }));
    b.onResolve({ filter: /^(node:.*|events)$/ }, (a) =>
      NODE[a.path] ? { path: join(web, NODE[a.path]) } : { errors: [{ text: `${a.path} has no stand-in (from ${a.importer})` }] });
  },
});

const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const common = {
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'es2022',
  legalComments: 'none',
  logLevel: 'warning',
  // The noble libraries come from tauri-poc/node_modules; everything else from the app's.
  nodePaths: [join(here, 'node_modules'), join(root, 'node_modules')],
};

await build({
  ...common,
  entryPoints: [join(web, 'main.ts')],
  outfile: join(dist, 'core', 'core.js'),
  plugins: [standIns('electron/main.ts')],
  define: {
    __dirname: JSON.stringify('/__lolping_app__/main'),
    __filename: JSON.stringify('/__lolping_app__/main/index.js'),
    __LOLPING_VERSION__: JSON.stringify(version),
    'process.env.NODE_ENV': '"production"',
    'import.meta.url': JSON.stringify('lolping://app/core/core.js'),
  },
});
writeFileSync(join(dist, 'core', 'index.html'), `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy"
      content="default-src 'self'; script-src 'self'; img-src 'self' data: blob:; connect-src 'self' ${IPC} lolpingsys: http://lolpingsys.localhost wss: https:" />
    <title>lolPing</title>
  </head>
  <body>
    <script src="./core.js"></script>
  </body>
</html>
`);

// The preloads read process.platform.
for (const name of ['overlay', 'settings', 'text', 'panel', 'teammate']) {
  await build({
    ...common,
    entryPoints: [join(root, 'src', 'preload', `${name}.ts`)],
    outfile: join(dist, '__preload', `${name}.js`),
    plugins: [standIns('electron/renderer.ts')],
    define: { 'process.platform': JSON.stringify(platform) },
  });
}
mkdirSync(join(dist, '__preload'), { recursive: true });

// Imported and friends' emotes are lolping://emotes/<file> (src/shared/emotes.ts). The pages build these URLs, and so
// does the main process for emotes it puts on screen. WebView2 can't load a custom scheme by its own name: Tauri serves
// it as http://lolping.localhost/emotes/<file> there.
if (platform === 'win32') {
  const EMOTE_URL = '"lolping://emotes/"';
  const rewrite = (file) => {
    const js = readFileSync(file, 'utf8');
    if (!js.includes(EMOTE_URL)) return false;
    writeFileSync(file, js.replaceAll(EMOTE_URL, '"http://lolping.localhost/emotes/"'));
    return true;
  };
  for (const dir of ['assets', 'core', '__preload']) {
    const hits = readdirSync(join(dist, dir)).filter((n) => n.endsWith('.js') && rewrite(join(dist, dir, n)));
    if (hits.length === 0 && dir !== '__preload') {
      console.error(`No ${EMOTE_URL} in tauri-poc/dist/${dir}: emotes from the data folder would not load.`);
      process.exit(1);
    }
  }
}
console.log('tauri-poc/dist is ready');
