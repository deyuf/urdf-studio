---
title: Releasing
order: 40
---

# Releasing

URDF Studio's three artifacts ship through three channels, all of them
gated on CI:

- The **VS Code extension** publishes to the Marketplace.
- The **web app** auto-deploys to Cloudflare Pages.
- The **docs site** auto-deploys to GitHub Pages.

All three workflows are downstream of `ci.yml` and require it to have
finished successfully on the same commit. A failing CI run blocks
everything.

## Release pipeline

```
push to main
   │
   ▼
ci.yml  (type-check + unit + Playwright)
   │
   ├── on success ──▶ deploy-web.yml  (Cloudflare Pages)
   │                       │
   │                       └─────────────┐
   ├── on success ──▶ publish.yml ◀──────┤
   │                  (skips if version unchanged)
   │                       │             │
   │                       └─────────────┤
   │                                     ▼
   │                          deploy-docs.yml
   │                          (waits for both upstream
   │                           workflows to be green on
   │                           the same SHA, then ships
   │                           docs to GitHub Pages)
```

## VS Code Marketplace

`publish.yml` runs as a downstream of `ci.yml` via `workflow_run`:

1. A push to `main` triggers `ci.yml`.
2. When CI finishes with `conclusion: success`, GitHub fires a
   `workflow_run` event on the same SHA.
3. `publish.yml` checks out that SHA and compares
   `package.json#version` against the previous commit.
4. If the version changed (or `force=true` was passed via manual
   `workflow_dispatch`), it packages a `.vsix`, publishes it via
   `vsce publish`, and creates a matching `v<version>` GitHub release
   with the `.vsix` attached.
5. If the version is unchanged, it skips publish silently.

### To cut a release

Bump `version` in `package.json`, commit, push to `main`. Wait for CI
to go green; publish follows automatically.

### One-time setup

The workflow needs a `VSCE_PAT` repository secret — an Azure DevOps
Personal Access Token for the `deyuf` publisher with **Marketplace →
Manage** scope.

## Web app

`deploy-web.yml` follows the same pattern: triggers after `ci.yml`
succeeds, checks out the verified SHA, runs `npm run web:build`,
ensures the Pages project exists, and calls
`wrangler pages deploy dist-web --project-name=urdf-studio --branch=main`.

Required secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.

## Docs site

`deploy-docs.yml` listens to both `deploy-web.yml` and `publish.yml`
completion. When fired, it queries the GitHub API for the other
workflow's status on the same SHA — if either has not yet completed,
the job exits and waits for the next trigger. When both are finished
and green, it builds `dist-web/docs/` and uploads it as the Pages
artifact.

### One-time setup

In **Settings → Pages**, set **Source** to **GitHub Actions**. After
that, the workflow handles everything.

## Branch previews

Cloudflare Pages does not auto-deploy from non-main branches. To preview
a feature branch, run `preview-web.yml` manually:

1. **Actions → Preview web app on Cloudflare Pages → Run workflow**.
2. Optionally enter a branch name (defaults to the workflow ref).

The preview is served at `<branch-slug>.urdf-studio.pages.dev` and is
not promoted to production. Useful for reviewing visual changes or
running QA without merging to `main`.
