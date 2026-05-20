---
title: Releasing
order: 40
---

# Releasing

URDF Studio's two artifacts ship through two channels:

- The **VS Code extension** publishes to the Marketplace.
- The **web app** auto-deploys to Cloudflare Pages on every merge.

## VS Code Marketplace

`.github/workflows/publish.yml` automates publishing. On every push to
`main`:

1. Run `check-types` and `test:unit` as a gate.
2. Compare `package.json#version` against the previous commit.
3. If the version changed (or `force=true` was passed via
   `workflow_dispatch`), package a `.vsix`, publish it via
   `vsce publish`, and create a matching `v<version>` GitHub release with
   the `.vsix` attached.
4. If the version is unchanged, skip publish silently (re-publishing the
   same version is rejected by the Marketplace anyway).

### To cut a release

Bump `version` in `package.json`, commit, push to `main`. That's it.

### One-time setup

The workflow needs a `VSCE_PAT` repository secret — an Azure DevOps
Personal Access Token for the `deyuf` publisher with **Marketplace →
Manage** scope.

Create at <https://dev.azure.com> → User settings → Personal access
tokens. Add to GitHub at **Settings → Secrets and variables → Actions →
New repository secret**.

## Web app

Every push to `main` that touches `src/`, `docs/`, `public/`, `media/`,
`esbuild.mjs`, `package.json`, `package-lock.json`, `tsconfig.json`, or
`wrangler.toml` triggers `deploy-web.yml`. The workflow:

1. Installs dependencies.
2. Runs `npm run web:build` (which includes `docs:build`).
3. Calls `wrangler pages deploy dist-web --project-name=urdf-studio
   --branch=main`.

No version bump needed; the deploy is identified by the commit SHA.

## Branch previews

Cloudflare Pages does not auto-deploy from non-main branches. To preview
a feature branch, run `preview-web.yml` manually:

1. **Actions → Preview web app on Cloudflare Pages → Run workflow**.
2. Optionally enter a branch name (defaults to the workflow ref).

The preview is served at `<branch-slug>.urdf-studio.pages.dev` and is
not promoted to production. Useful for reviewing visual changes or
running QA without merging to `main`.
