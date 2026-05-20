---
title: Deployment
order: 30
---

# Deployment — Cloudflare Pages

The web app is a fully static SPA + docs site (no backend). Cloudflare
Pages is the reference deploy, but any static host that supports
`_headers`-style metadata will work.

## CI workflows

`.github/workflows/` ships three workflows that handle deployment:

| Workflow | Trigger | Effect |
|---|---|---|
| `ci.yml` | Every push & PR | Type-check, unit tests, Playwright. |
| `preview-web.yml` | PR opened/updated | Deploy a per-PR preview to Cloudflare Pages, sticky-comment the URL. |
| `deploy-web.yml` | Push to `main` | Deploy production. |

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

## Hosting elsewhere

The build produces a plain static directory. To host on:

- **Netlify** — drag-drop `dist-web/`, or connect Git with build
  `npm run web:build`, publish directory `dist-web`.
- **GitHub Pages** — push `dist-web/` to a `gh-pages` branch.
- **Vercel** — same as Netlify; uses `vercel.json` for headers.
- **Nginx / Caddy** — serve `dist-web/` as a static root; copy
  `_headers` content into the server config.

The only constraint is HTTPS — File System Access API refuses to
authenticate on plain HTTP.
