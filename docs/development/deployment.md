---
title: Deployment
order: 30
---

# Deployment — Cloudflare Pages

The web app is a fully static SPA + docs site (no backend). Cloudflare
Pages is the reference deploy, but any static host that supports
`_headers`-style metadata will work.

## CI workflows

`.github/workflows/` ships five workflows. The split is intentional:

- **Tests** run on every branch — feature branches included.
- **Deploys** and **publishes** are restricted to `main` *and* gated on
  CI success on the same commit. Nothing ships unless tests pass.
- **Docs** deploy to GitHub Pages only after both the web app deploy
  and the Marketplace publish have completed successfully.

| Workflow | Trigger | Effect |
|---|---|---|
| `ci.yml` | Every push and PR | Type-check, unit tests, Playwright. |
| `deploy-web.yml` | `workflow_run` after CI succeeds on `main` (or manual dispatch on `main`) | Deploy production to Cloudflare Pages. |
| `publish.yml` | `workflow_run` after CI succeeds on `main` (or manual dispatch on `main`) | Publish `.vsix` to the Marketplace when `package.json#version` changes. |
| `deploy-docs.yml` | `workflow_run` after `deploy-web` *and* `publish` both succeed on `main` (or manual dispatch) | Build docs and publish to GitHub Pages. |
| `preview-web.yml` | Manual dispatch only | Ad-hoc preview deploy for a feature branch. |

The dependency chain on a push to `main` is:

```
ci.yml
  └─ on success ──▶ deploy-web.yml ──┐
                                     ├─▶ deploy-docs.yml
  └─ on success ──▶ publish.yml ─────┘
                    (skips if version unchanged)
```

`deploy-docs.yml` listens to both `deploy-web.yml` and `publish.yml`
completions. When triggered by one, it consults the GitHub API for the
other workflow's status on the same SHA; if the other hasn't finished
yet, the job exits cleanly and waits for the next trigger. When both are
finished and green, it builds the docs and ships them.

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
