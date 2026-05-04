import * as esbuild from 'esbuild';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
const buildTests = process.argv.includes('--tests');

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

async function buildOnce() {
  if (production) {
    await rm('dist', { recursive: true, force: true });
  }
  await mkdir('dist', { recursive: true });
  const builds = [
    esbuild.build({
      ...common,
      entryPoints: ['src/extension.ts'],
      outfile: 'dist/extension.js',
      platform: 'node',
      format: 'cjs',
      target: 'node18',
      external: ['vscode', './xhr-sync-worker.js']
    }),
    esbuild.build({
      ...common,
      entryPoints: ['src/renderer/main.ts'],
      outfile: 'dist/renderer.js',
      platform: 'browser',
      format: 'esm',
      target: ['chrome114']
    })
  ];

  if (buildTests) {
    await mkdir('dist/test', { recursive: true });
    builds.push(esbuild.build({
      ...common,
      entryPoints: ['test/unit/core.test.ts'],
      outfile: 'dist/test/core.test.cjs',
      platform: 'node',
      format: 'cjs',
      target: 'node18',
      external: ['vscode', './xhr-sync-worker.js']
    }));
  }

  await Promise.all(builds);
  await copyMedia(buildTests);
}

if (watch) {
  const contexts = await Promise.all([
    esbuild.context({
      ...common,
      entryPoints: ['src/extension.ts'],
      outfile: 'dist/extension.js',
      platform: 'node',
      format: 'cjs',
      target: 'node18',
      external: ['vscode', './xhr-sync-worker.js']
    }),
    esbuild.context({
      ...common,
      entryPoints: ['src/renderer/main.ts'],
      outfile: 'dist/renderer.js',
      platform: 'browser',
      format: 'esm',
      target: ['chrome114']
    })
  ]);
  await Promise.all(contexts.map(context => context.watch()));
  await copyMedia(false);
  console.log('URDF Studio watch started.');
} else {
  buildOnce().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
