---
title: Testing
order: 20
---

# Testing

URDF Studio uses complementary test layers:

| Layer | Where | Run |
|---|---|---|
| Unit | `test/unit/*.test.ts` | `npm run test:unit` |
| Renderer and web shell | `test/renderer/*.spec.ts` | `npm run test:renderer` |
| Real VS Code | `test/integration/*.cjs` | `npm run test:vscode` (Linux: wrap with `xvfb-run`) |
| Real meshes | `scripts/test-franka.mjs` | `FRANKA_DIR=… node scripts/test-franka.mjs` |

## Unit tests

Node tests cover core parsing and analysis, editor and renderer logic, storage,
and release planning. Core tests install Node `CoreIo` so xacro and SRDF work
without a host. Release tests use temporary Git repositories and never publish.

Run alone:

```bash
npm run test:unit
```

## Renderer + web shell

Playwright drives a headless Chromium against the built artifacts.

```bash
npm run compile     # build extension + renderer
npm run web:build   # build web app
npx playwright test
```

The isolated harness covers renderer behavior and the web shell covers complete
browser flows, including real export downloads, blob cleanup, theme persistence,
keyboard navigation, and native 2K / 150% display scaling. Specs share a static
server helper while each test keeps its own browser state.

Set `CHROMIUM_PATH` to use an installed Chromium instead of Playwright's download.
HTML reports are written to `playwright-report/`; failed attempts retain traces
and screenshots in `test-results/`.

## Real VS Code

The suite opens Franka through the actual custom editor, then drives webview
controls to save source to disk, restore a saved pose after reopening, and
reload an included xacro file. Success requires every flow to complete and the
editor process to exit cleanly.

In release CI, `URDF_STUDIO_VSIX` and `URDF_STUDIO_EXPECTED_VERSION` make the runner
extract and load the candidate package, including its packaged assets. The same
VSIX is published after testing. Locally, the runner defaults to the development
build from `npm run compile`.

## Real-world smoke test

```bash
git clone https://github.com/frankarobotics/franka_description /tmp/franka_description
FRANKA_DIR=/tmp/franka_description node scripts/test-franka.mjs
```

Loads `fr3`, `fer`, and `fp3` end-to-end and asserts:

- The xacro expands without errors.
- Every mesh declared in the URDF resolves to a file on disk.
- No console errors during render.
- The canvas paints a non-trivial dataURL.

Override the targets:

```bash
FRANKA_TARGETS=fr3v2_1,mobile_fr3_duo_v0_2 node scripts/test-franka.mjs
```

## CI

[Release pipeline](../../.github/workflows/release.yml) runs unit, browser, and
real VS Code tests on branch pushes and pull requests. Reports are uploaded even
when a retry succeeds. [Release automation](releases.md) documents versioning and
how the tested VSIX reaches the beta or stable Marketplace channel.

The Franka smoke test is not in CI (cloning 226 MB on every run is
wasteful). Run it locally before merging changes to the mesh URL or
xacro pipelines.

## Adding tests

- **Pure core change?** Add a `node --test` case in
  `test/unit/core.test.ts`.
- **Renderer behavior?** Add a Playwright test in
  `test/renderer/features.spec.ts` using the harness's stub host.
- **End-to-end change?** Add to `test/renderer/web-shell.spec.ts`.

For fixtures: small URDFs go under `test/fixtures/`. The xacro fixture
and the leak-test pair are good templates.
