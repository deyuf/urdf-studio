---
title: Releasing
order: 40
---

# Releasing

URDF Studio's three artifacts ship through one consolidated pipeline
in `.github/workflows/release.yml`:

- The **VS Code extension** publishes to the Marketplace.
- The **web app** auto-deploys to Cloudflare Pages.
- The **docs site** auto-deploys to GitHub Pages.

All three jobs depend on the `test` job at the top of the same workflow
via `needs:` — a failing test job blocks everything downstream.

## Pipeline

```
test  (always)
  │     ├─ type-check
  │     ├─ unit tests (24)
  │     ├─ Playwright (21)
  │     └─ uploads dist-web artifact (main only)
  │
  ├─ needs test ──▶ deploy-web ──┐
  │                              ├──▶ deploy-docs
  ├─ needs test ──▶ publish ─────┘
  │                  (skips if version unchanged)
```

## VS Code Marketplace

The `publish` job:

1. Checks out the same commit `test` verified (the job's `needs: test`
   guarantees it).
2. Compares `package.json#version` against `HEAD~1:package.json`.
3. If the version changed (or `force_publish=true` via manual dispatch),
   packages a `.vsix`, publishes via `vsce publish`, and creates a
   matching `v<version>` GitHub release with the `.vsix` attached.
4. If the version is unchanged, the job runs but the publish steps are
   skipped silently (`if:` on each).

### To cut a release

Bump `version` in `package.json`, commit, push to `main`. Wait for the
`test` job to go green; `publish` runs immediately after.

### One-time setup

`VSCE_PAT` repository secret — an Azure DevOps Personal Access Token
for the `deyuf` publisher with **Marketplace → Manage** scope.

## Web app

The `deploy-web` job downloads the `web-build` artifact from `test`,
verifies the output, checks that the Cloudflare Pages project exists
(via REST API, not by parsing wrangler), and calls
`wrangler pages deploy dist-web --project-name=urdf-studio --branch=main`.

Required secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`. See
[deployment.html](./deployment.html) for token-scope details.

## Docs site

The `deploy-docs` job has `needs: [deploy-web, publish]`. Both must
succeed before docs deploy. The job downloads the same `web-build`
artifact, uploads `dist-web/docs/` to GitHub Pages, and calls
`actions/deploy-pages`.

### One-time setup

In **Settings → Pages**, set **Source** to **GitHub Actions**.

## Branch previews

Cloudflare Pages does not auto-deploy from non-main branches. To preview
a feature branch, run `preview-web.yml` manually:

1. **Actions → Preview web app on Cloudflare Pages → Run workflow**.
2. Optionally enter a branch name (defaults to the workflow ref).

The preview is served at `<branch-slug>.urdf-studio.pages.dev` and is
not promoted to production. Useful for reviewing visual changes or
running QA without merging to `main`.
