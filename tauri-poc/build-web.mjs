// `node tauri-poc/build-web.mjs`, after `npx electron-vite build`: puts the pages the Tauri shell embeds in
// tauri-poc/dist (the Electron app's pages, unchanged but for their CSP, plus the core page) and the overlay
// preload stand-in in tauri-poc/gen.
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const renderer = join(root, 'out', 'renderer');
if (!existsSync(join(renderer, 'overlay', 'index.html'))) {
  console.error('No out/renderer: run `npx electron-vite build` first.');
  process.exit(1);
}
const dist = join(here, 'dist');
const gen = join(here, 'gen');
rmSync(dist, { recursive: true, force: true });
rmSync(gen, { recursive: true, force: true });
cpSync(renderer, dist, { recursive: true });
mkdirSync(gen, { recursive: true });

// Tauri's bridge posts to ipc:// (http://ipc.localhost on Windows). Electron's pages had no reason to allow it.
const IPC = 'ipc: http://ipc.localhost';
const overlayHtml = join(dist, 'overlay', 'index.html');
const html = readFileSync(overlayHtml, 'utf8');
const patched = html.replace("connect-src 'self'", `connect-src 'self' ${IPC}`);
if (patched === html) throw new Error('the overlay CSP has no connect-src to extend');
writeFileSync(overlayHtml, patched);

/** Main-process code gets the Tauri versions of Electron, node:events and paths.ts; any other node: import fails. */
const shims = {
  name: 'tauri-shims',
  setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: join(here, 'web', 'electronShim.ts') }));
    b.onResolve({ filter: /^node:events$/ }, () => ({ path: join(here, 'web', 'events.ts') }));
    b.onResolve({ filter: /^\.\/paths$/ }, (a) =>
      a.importer.startsWith(join(root, 'src', 'main')) ? { path: join(here, 'web', 'pathsShim.ts') } : undefined);
    b.onResolve({ filter: /^node:/ }, (a) => ({ errors: [{ text: `${a.path} has no page equivalent (from ${a.importer})` }] }));
  },
};
const common = {
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'es2022',
  legalComments: 'none',
  logLevel: 'warning',
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [shims],
};

await build({ ...common, entryPoints: [join(here, 'web', 'core.ts')], outfile: join(dist, 'core', 'core.js') });
writeFileSync(
  join(dist, 'core', 'index.html'),
  `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; connect-src 'self' ${IPC}; script-src 'self'" />
    <title>lolPing core</title>
  </head>
  <body>
    <script src="./core.js"></script>
  </body>
</html>
`,
);
await build({ ...common, entryPoints: [join(here, 'web', 'overlayShim.ts')], outfile: join(gen, 'overlay-shim.js') });
console.log('tauri-poc/dist and tauri-poc/gen are ready');
