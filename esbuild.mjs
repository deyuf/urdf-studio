import * as esbuild from 'esbuild';
import { copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
const buildTests = process.argv.includes('--tests');
const web = process.argv.includes('--web');
const serve = process.argv.includes('--serve');

const common = {
  bundle: true,
  sourcemap: !production,
  minify: production,
  logLevel: 'info'
};

async function copyMedia(includeTestWorker = false) {
  await mkdir('dist/media', { recursive: true });
  await copyFile('media/styles.css', 'dist/media/styles.css');
  await copyFile(
    'node_modules/jsdom/lib/jsdom/living/xhr/xhr-sync-worker.js',
    'dist/xhr-sync-worker.js'
  ).catch(() => undefined);
  if (includeTestWorker) {
    await mkdir('dist/test', { recursive: true });
    await copyFile(
      'node_modules/jsdom/lib/jsdom/living/xhr/xhr-sync-worker.js',
      'dist/test/xhr-sync-worker.js'
    ).catch(() => undefined);
  }
}

async function copyWebAssets() {
  await mkdir('dist-web', { recursive: true });
  await copyFile('public/index.html', 'dist-web/index.html');
  await copyFile('media/styles.css', 'dist-web/styles.css');
  await copyFile('src/web/ui/web.css', 'dist-web/web.css');
  await copyFile('media/icon.png', 'dist-web/icon.png');
  await copyFile('public/_headers', 'dist-web/_headers').catch(() => undefined);
}

// VS Code extension build (unchanged from prior shape).
const extensionBuilds = (includeTests, testEntries = []) => {
  const builds = [
    {
      ...common,
      entryPoints: ['src/extension.ts'],
      outfile: 'dist/extension.js',
      platform: 'node',
      format: 'cjs',
      target: 'node18',
      external: ['vscode', './xhr-sync-worker.js']
    },
    {
      ...common,
      entryPoints: ['src/renderer/main.ts'],
      outfile: 'dist/renderer.js',
      platform: 'browser',
      format: 'esm',
      target: ['chrome114']
    }
  ];
  if (includeTests) {
    for (const entry of testEntries) {
      const base = path.basename(entry, '.test.ts');
      builds.push({
        ...common,
        entryPoints: [entry],
        outfile: `dist/test/${base}.test.cjs`,
        platform: 'node',
        format: 'cjs',
        target: 'node18',
        external: ['vscode', './xhr-sync-worker.js']
      });
    }
  }
  return builds;
};

async function discoverTestEntries() {
  const dir = 'test/unit';
  const entries = await readdir(dir);
  return entries
    .filter(name => name.endsWith('.test.ts'))
    .sort()
    .map(name => path.join(dir, name));
}

async function buildExtension() {
  if (production) {
    await rm('dist', { recursive: true, force: true });
  }
  await mkdir('dist', { recursive: true });
  const testEntries = buildTests ? await discoverTestEntries() : [];
  if (buildTests) {
    await mkdir('dist/test', { recursive: true });
  }
  await Promise.all(extensionBuilds(buildTests, testEntries).map(options => esbuild.build(options)));
  await copyMedia(buildTests);
}

async function watchExtension() {
  const contexts = await Promise.all(extensionBuilds(false, []).map(options => esbuild.context(options)));
  await Promise.all(contexts.map(context => context.watch()));
  await copyMedia(false);
  console.log('URDF Studio watch started.');
}

// Web build options. The web entry never imports io.node, but the core module
// graph carries optional jsdom-side helpers via the xacro-parser vendor. Mark
// Node-only packages as external so esbuild does not try to resolve them.
const webBuildOptions = {
  ...common,
  entryPoints: ['src/web/main.ts'],
  outfile: 'dist-web/app.js',
  platform: 'browser',
  format: 'esm',
  target: ['chrome114', 'firefox115', 'safari17'],
  external: ['jsdom', 'node:fs', 'node:path', 'node:url']
};

async function buildWeb() {
  if (production) {
    await rm('dist-web', { recursive: true, force: true });
  }
  await mkdir('dist-web', { recursive: true });
  await esbuild.build(webBuildOptions);
  await copyWebAssets();
}

async function serveWeb() {
  await mkdir('dist-web', { recursive: true });
  await copyWebAssets();
  const context = await esbuild.context(webBuildOptions);
  await context.watch();
  const result = await context.serve({
    servedir: 'dist-web',
    port: 5173,
    host: '127.0.0.1'
  });
  const host = result.host || '127.0.0.1';
  console.log(`URDF Studio web dev server: http://${host}:${result.port}`);
}

async function main() {
  if (web && serve) {
    await serveWeb();
    return;
  }
  if (web) {
    await buildWeb();
    return;
  }
  if (watch) {
    await watchExtension();
    return;
  }
  await buildExtension();
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
