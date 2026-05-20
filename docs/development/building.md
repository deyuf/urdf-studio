---
title: Building
order: 10
---

# Building from source

## Prerequisites

- Node.js 20+ (any LTS works; CI runs on 20).
- npm (project pins versions via `package-lock.json`; use `npm ci` for
  reproducible installs).
- For the Playwright suites: a Chromium install
  (`npx playwright install --with-deps chromium`).

## Install

```bash
git clone https://github.com/deyuf/urdf-studio
cd urdf-studio
npm ci
```

## VS Code extension

```bash
npm run watch        # incremental compile of dist/extension.js + dist/renderer.js
```

Open the folder in VS Code, press **F5** to launch the Extension
Development Host. Any URDF/xacro file in the test host opens through
URDF Studio.

For a one-off production build:

```bash
npm run package      # writes dist/, minified, no sourcemaps
```

To produce an installable `.vsix`:

```bash
npm run vsce:package # → urdf-studio-<version>.vsix
```

## Web app

```bash
npm run web:dev      # http://127.0.0.1:5173 with live rebuild on file change
```

Browse there, click **Open Folder**, pick a ROS package. The page hot-
reloads when you change any web source file; the docs site rebuilds too.

For a one-off production build:

```bash
npm run web:build    # writes dist-web/ (app + docs)
```

## Docs

```bash
npm run docs:build       # render docs/**/*.md → dist-web/docs/**/*.html
npm run docs:watch       # rebuild on every .md change
```

Each `.md` may have a frontmatter block:

```
---
title: My page
order: 20
---
```

`order` controls the position inside its section's sidebar; `title`
overrides the first `# heading` as the page title.

## What every script does

| Script | Effect |
|---|---|
| `npm run compile` | Type-check + build VS Code extension (no production flags). |
| `npm run watch` | Incremental rebuild of extension + renderer. |
| `npm run check-types` | `tsc --noEmit`. |
| `npm run package` | Production build of the extension (minified, no maps). |
| `npm run test:unit` | Compile tests, run `node --test`. |
| `npm run test:renderer` | Compile + run Playwright suites. |
| `npm run web:dev` | Web dev server on `127.0.0.1:5173`. |
| `npm run web:build` | Web production build + docs site. |
| `npm run docs:build` | Just the docs. |
| `npm run docs:watch` | Docs in watch mode. |
| `npm run vsce:package` | Build + emit `.vsix`. |

## esbuild configuration

`esbuild.mjs` produces three artifacts depending on flags:

| Flag | Output | Platform | Target |
|---|---|---|---|
| (none) | `dist/extension.js` | `node` | `node18` |
| (none) | `dist/renderer.js` | `browser` | `chrome114` (VS Code's bundled Electron) |
| `--web` | `dist-web/app.js` | `browser` | `chrome114, firefox115, safari17` |

`--production` adds minification and strips sourcemaps. `--web --serve`
runs the dev server. The web build marks `jsdom`, `node:fs`, `node:path`,
`node:url` as `external` so Node-only code paths in `core/` never get
pulled into the browser bundle.

A useful sanity check after changes:

```bash
node esbuild.mjs --web --production
grep -c '"node:' dist-web/app.js   # should be 0
grep -c 'jsdom'  dist-web/app.js   # should be 0
```
