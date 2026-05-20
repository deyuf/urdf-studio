---
title: Deployment
order: 30
---

# Deployment — Cloudflare Pages

The web app is a fully static SPA + docs site (no backend). Cloudflare
Pages is the reference deploy, but any static host that supports
`_headers`-style metadata will work.

## CI / CD — one consolidated workflow

`.github/workflows/release.yml` is the entire CI/CD pipeline. Four jobs
in one workflow, connected by `needs:` dependencies:

```
push to main (or PR / any-branch push)
   │
   ▼
test  (always — type-check + unit + Playwright + build web bundle)
   │      └─ uploads dist-web as an artifact (main pushes only)
   │
   ├─ needs test ──▶ deploy-web    (main only, Cloudflare Pages)
   │                       │
   │                       └─────┐
   ├─ needs test ──▶ publish ◀────┤
   │                  (skips if  │
   │                   version    │
   │                   unchanged) │
   │                       │     │
   │                       └─────┤
   │                             ▼
   │                  deploy-docs (main only, GitHub Pages)
```

Manual `workflow_dispatch` is also supported, with one optional input —
`force_publish` — that bypasses the version-bump check.

| Job | Runs when | Effect |
|---|---|---|
| `test` | Always (every branch + PR) | Type-check, unit tests, Playwright. Uploads `dist-web` artifact on main pushes. |
| `deploy-web` | main + tests passed | Cloudflare Pages production deploy. |
| `publish` | main + tests passed | VS Code Marketplace publish (only if `package.json#version` changed). |
| `deploy-docs` | main + deploy-web + publish succeeded | GitHub Pages docs deploy. |

`preview-web.yml` is a separate, manual-dispatch-only workflow for
ad-hoc branch previews to Cloudflare Pages.

## Required secrets

| Secret | Used by | Scope |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | `deploy-web` | Cloudflare Pages: Edit. |
| `CLOUDFLARE_ACCOUNT_ID` | `deploy-web` | The account where the Pages project lives. |
| `VSCE_PAT` | `publish` | Azure DevOps PAT for the `deyuf` publisher with **Marketplace → Manage** scope. |

If `CLOUDFLARE_*` secrets are absent, `deploy-web` fails fast with an
embedded how-to in the log. The preflight runs before any wrangler call,
so the failure mode is unambiguous.

## First-time setup

1. **Cloudflare Pages project.** The workflow creates it automatically
   via the Cloudflare REST API on first run, but you can also do it
   manually:
   ```bash
   npx wrangler pages project create urdf-studio --production-branch=main
   ```
2. **GitHub Pages.** **Settings → Pages → Build and deployment → Source:
   GitHub Actions**. The workflow uploads the artifact; no branch or
   folder selection is needed.
3. **Secrets.** Set the three listed above under **Settings → Secrets
   and variables → Actions**.

## Why use the Cloudflare REST API for the project check?

An earlier version parsed `wrangler pages project list` with `awk` to
detect whether the project already existed. Wrangler's table output
changed across minor versions and broke the parse — producing the
infamous `process npx failed with exit code 1` with no useful detail.

The current workflow hits
`GET /accounts/<id>/pages/projects/<name>` directly with `curl`. A 200
means the project exists, 404 means we should create it. 401/403 means
the API token doesn't have the right scope, and the workflow says so
out loud. No more wrangler-output parsing.

Required GitHub secrets:

- `CLOUDFLARE_API_TOKEN` — Pages: Edit scope.
- `CLOUDFLARE_ACCOUNT_ID` — visible in any Cloudflare dashboard page.

## First-time Cloudflare setup

```bash
# Create the Pages project once.
npx wrangler pages project create urdf-studio --production-branch=main
```

Or via the dashboard: **Workers & Pages → Create application → Pages →
Direct Upload → name = `urdf-studio` → Create**.

## Manual deploy (no CI)

```bash
npm run web:build
npx wrangler pages deploy dist-web --project-name=urdf-studio
```

Output URL is shown at the end (`https://<hash>.urdf-studio.pages.dev`).
Re-running deploys a new version; the latest one always serves at
`https://urdf-studio.pages.dev`.

## Custom domain

Already have a domain on Cloudflare (zone `example.com`)?

1. Dashboard → **Workers & Pages → urdf-studio → Custom domains → Set up
   a custom domain**.
2. Enter the subdomain (e.g. `urdf.example.com`).
3. Cloudflare adds a `CNAME` to your DNS zone automatically and signs a
   Universal SSL cert. DNS propagation: seconds. Cert issuance: 1–3
   minutes.

No CI changes needed — custom domains are routing metadata on the Pages
project, not part of the deploy command.

If the domain lives on a different registrar, add a `CNAME` record there
pointing to `urdf-studio.pages.dev` and Cloudflare will validate
ownership before activating.

## Headers

`public/_headers` ships with the build and is read by Cloudflare Pages:

```
/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: credentialless
  Permissions-Policy: clipboard-read=(self), clipboard-write=(self)
  Referrer-Policy: strict-origin-when-cross-origin
  X-Content-Type-Options: nosniff

/app.js
  Cache-Control: public, max-age=31536000, immutable
```

The COOP/COEP headers are required for any future SharedArrayBuffer use
(currently unused; cost-free to set). The cache headers on `app.js` and
CSS are aggressive because every deployment changes the file path via
Cloudflare's atomic deploy IDs.

## Verifying a deployment

```bash
curl -I https://urdf.example.com           # 200, content-type text/html
curl -I https://urdf.example.com/app.js    # 200, cache-control immutable
curl -I https://urdf.example.com/docs/     # 200
```

Manual checks in the browser:

- File System Access API works (requires HTTPS — Cloudflare gives you
  HTTPS, so this is automatic).
- The welcome tour shows on a fresh profile, persists after dismissing.
- Loading a folder doesn't surface any console errors.

## GitHub Pages docs

The docs site is also published to GitHub Pages at
`https://<owner>.github.io/<repo>/` via `deploy-docs.yml`. Two
prerequisites are one-time:

1. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
   No branch / folder selection; the workflow uploads the artifact.
2. Ensure the workflow has `pages: write` and `id-token: write`
   permissions (already declared at workflow scope).

The deploy fires automatically after every production cycle on `main`:
when both `deploy-web` and `publish` have completed successfully on the
same commit, `deploy-docs` checks out that commit, runs
`npm run docs:build`, and uploads `dist-web/docs/` as the Pages
artifact.

## Hosting elsewhere

The build produces a plain static directory. To host on:

- **Netlify** — drag-drop `dist-web/`, or connect Git with build
  `npm run web:build`, publish directory `dist-web`.
- **GitHub Pages** — already automated via `deploy-docs.yml`.
- **Vercel** — same as Netlify; uses `vercel.json` for headers.
- **Nginx / Caddy** — serve `dist-web/` as a static root; copy
  `_headers` content into the server config.

The only constraint for the **web app** (not the docs) is HTTPS — File
System Access API refuses to authenticate on plain HTTP.
