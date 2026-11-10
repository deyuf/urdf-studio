# Contributing to URDF Studio

Thanks for helping. This page is for people working on URDF Studio itself.
For using it, see the [user documentation](https://urdf.deyuf.org/docs/).

## Set up

```bash
git clone https://github.com/deyuf/urdf-studio
cd urdf-studio
npm ci
```

## Everyday commands

```bash
npm run web:dev        # browser app at http://127.0.0.1:5173, rebuilds on change
npm run watch          # VS Code extension; press F5 in VS Code to launch it
npm run docs:watch     # rebuild the docs site on every change in docs/

npm run lint
npm run test:unit      # core, editor, renderer logic, browser storage
npm run test:renderer  # builds both targets, then runs the Playwright suites
npm run test:vscode    # real VS Code integration (Linux: run under xvfb-run)
```

Set `CHROMIUM_PATH=/path/to/chromium` to run Playwright against an
installed browser.

## How the code is organised

One TypeScript codebase produces both the VS Code extension and the
browser app:

```
                src/core/                 — parsing, xacro, checks; no fs/DOM imports
                     ▲
       ┌─────────────┴─────────────┐
   io.node.ts                   ioBrowser.ts
   (node:fs + jsdom)            (File System Access + DOM)
       ▲                              ▲
  src/extension.ts               src/web/host.ts
       ▲                              ▲
       └─────────── postMessage ──────┘
                     ▼
              src/renderer/main.ts     — Three.js viewer and side panels, shared
```

The renderer is identical in both targets; only the host that feeds it
messages differs. Details are in [`dev-docs/architecture`](dev-docs/architecture/).

## Documentation

| Folder | Audience | Published |
|---|---|---|
| `docs/` | People using URDF Studio | [urdf.deyuf.org/docs](https://urdf.deyuf.org/docs/) |
| `dev-docs/` | Contributors | In this repository only |
| `README.md` | Everyone — also the Marketplace page | GitHub and Marketplace |

When you change behaviour a user can see, update the matching page in
`docs/`. Write it for someone using the app, not reading the code:
describe what to click and what happens, not how it is implemented.
`docs/images/` holds screenshots used by the docs.

## Real-world smoke test

```bash
git clone https://github.com/frankarobotics/franka_description /tmp/franka_description
npm run web:build
FRANKA_DIR=/tmp/franka_description node scripts/test-franka.mjs
```

| Robot | Result |
|---|---|
| Franka Research 3 (`fr3`) | 8 joints · 25 links · 0 errors |
| Franka Research (`fer`) | 8 joints · 25 links · 0 errors |
| Franka Production 3 (`fp3`) | 8 joints · 25 links · 0 errors |

## Screenshots

The README and docs screenshots need `ffmpeg` and the Franka meshes (not
checked in):

```bash
cp -a test/fixtures/franka_description /tmp/urdf-readme-franka
cp -a /path/to/franka_description/meshes /tmp/urdf-readme-franka/meshes
npm run web:build
FRANKA_DIR=/tmp/urdf-readme-franka node scripts/capture-screenshots.mjs
```

Regenerate the PNG icon from its SVG with `node scripts/build-icon.mjs`.

## Builds and releases

```bash
npm run package        # VS Code extension → dist/
npm run web:build      # browser app and docs → dist-web/
npm run vsce:package   # .vsix to install with: code --install-extension urdf-studio-*.vsix
```

Merges to `main` pick the next stable version, run the full test suite
against the packaged VSIX, publish it to the Marketplace and create a
GitHub release. No manual version bump is needed. See
[`dev-docs/development/releases.md`](dev-docs/development/releases.md).

More: [building](dev-docs/development/building.md) ·
[testing](dev-docs/development/testing.md).

## Pull requests

- Keep changes focused, and include tests for behaviour changes.
- Run `npm run lint` and `npm run test:unit` before pushing; CI runs the
  browser suites too.
