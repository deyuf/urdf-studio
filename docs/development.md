# Development

## Prerequisites

- Node.js 20+ (any LTS works; CI runs on 20).
- `npm` (project pins versions via `package-lock.json`; use `npm ci` for reproducible installs).
- For the renderer Playwright suite: Chromium browser (`npx playwright install --with-deps chromium`).

## Local dev loop

```bash
npm install
```

### VS Code extension

```bash
npm run watch        # incremental compile (dist/extension.js, dist/renderer.js)
```

Then open this folder in VS Code and hit `F5` to launch the Extension Development Host. Open any `.urdf`, `.urdf.xacro` or `.xacro` file — URDF Studio is the default editor.

### Web app

```bash
npm run web:dev      # http://127.0.0.1:5173 with live rebuild
```

Open the URL, click **Open Folder**, pick a ROS package. The page reloads when you re-build.

For a one-off production-shaped build:

```bash
npm run web:build    # writes dist-web/
```

## Tests

```bash
npm run test:unit       # 24 node:test cases under test/unit/
npx playwright test     # 18 Playwright tests under test/renderer/
```

`test/renderer/` covers both the renderer in isolation (`renderer.spec.ts`, `features.spec.ts`, `ui-behavior.spec.ts`) and the assembled web shell (`web-shell.spec.ts`).

The Playwright config is at `playwright.config.ts`; the test harness in `test/renderer/harness.html` mounts only the renderer (no host), useful for testing renderer behavior with stubbed messages.

## Docs

```bash
npm run docs:build      # renders docs/*.md → dist-web/docs/*.html
npm run docs:watch      # rebuild on file change
```

Docs are plain Markdown. A small `scripts/build-docs.mjs` converts each file to a styled HTML page using `marked`. Pages share `docs.css` for typography and `_layout.html` for the chrome.

## Deploying

The repository ships three GitHub Actions workflows under `.github/workflows/`:

| Workflow | Trigger | Job |
| --- | --- | --- |
| `ci.yml` | Every push and PR | Type-check, unit tests, Playwright suite (renderer + web shell). |
| `preview-web.yml` | PR opened/updated | Builds and deploys a Cloudflare Pages preview, comments the URL on the PR. |
| `deploy-web.yml` | Push to `main` | Deploys `dist-web/` to Cloudflare Pages production. |
| `publish.yml` | Push to `main` with bumped `package.json` version | Packages and publishes the VS Code extension to the Marketplace. |

### Cloudflare Pages secrets

Set the following secrets in **Settings → Secrets and variables → Actions**:

- `CLOUDFLARE_API_TOKEN` — a Pages-scoped API token. Create at https://dash.cloudflare.com/profile/api-tokens → **Cloudflare Pages: Edit**.
- `CLOUDFLARE_ACCOUNT_ID` — find under any Cloudflare account page → right sidebar.

The Pages project must already exist (one-time): `npx wrangler pages project create urdf-studio --production-branch=main` or via the dashboard.

### VS Code Marketplace

The `VSCE_PAT` secret holds an Azure DevOps Personal Access Token for the `deyuf` publisher with **Marketplace → Manage** scope. Bumping `package.json#version` and merging to `main` triggers a publish.

## Code style

- TypeScript strict mode (`tsconfig.json` has `strict: true`).
- No new comments unless they explain a non-obvious *why* — file headers and surprising workarounds get a short note; obvious code doesn't.
- Use `getCoreIo()` for any fs/path/DOM access in `src/core/*`. Never import `node:*` from there — the web bundle would refuse.
- `src/renderer/main.ts` is the boundary between host and three.js. Keep host-specific assumptions out; if the renderer needs new capability, add a field to the loadRobot message rather than a global.
