---
title: Testing
order: 20
---

# Testing

URDF Studio has three test layers:

| Layer | Where | Run | Count |
|---|---|---|---|
| Unit | `test/unit/core.test.ts` | `npm run test:unit` | 24 |
| Renderer + web shell | `test/renderer/*.spec.ts` | `npx playwright test` | 19 |
| Real-world smoke | `scripts/test-franka.mjs` | `FRANKA_DIR=… node scripts/test-franka.mjs` | 3 robots |

## Unit tests

Pure `node --test` against `src/core/*`. The test file installs the
Node `CoreIo` at the top so xacro expansion, URDF analysis, SRDF parsing
all work without a host. Fast (~500ms).

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

Three spec files:

- `renderer.spec.ts` — feeds a hand-crafted `loadRobot` message to the
  renderer in isolation (via the harness in `harness.html`) and checks
  the joint slider, render-mode toggle, and canvas output.
- `features.spec.ts` — joint sliders, frames, inertia toggle, bookmark
  flow, reachability sampling, collision-pair tool.
- `web-shell.spec.ts` — the full web app: folder picker via
  `webkitdirectory`, file selection, joint manipulation, onboarding
  tour, blob URL lifecycle.

Each test in `web-shell.spec.ts` instruments
`URL.createObjectURL`/`revokeObjectURL` to verify the two-generation
cache doesn't leak.

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

`.github/workflows/ci.yml` runs the unit and Playwright suites on every
push and PR. It caches the Playwright browser install and uploads the
HTML report on failure.

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
