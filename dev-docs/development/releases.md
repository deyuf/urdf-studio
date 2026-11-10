---
title: Releases
order: 30
---

# Automated releases

Merging to `main` automatically tests and publishes a stable VS Code extension,
creates a GitHub Release with generated notes and its VSIX, and deploys the web
app and documentation. No manual package-version edit is required.

Pushes to `develop` and `design/quiet-studio` use the beta channel. Pull requests
and other branches run the same checks without publishing an extension.

## Version selection

The workflow reads Marketplace versions and annotated release tags before testing.
Stable versions use an even minor; beta versions use an odd minor.

- Stable normally increments the latest stable patch.
- If a newer beta exists, stable advances to the next even minor above it. For
  example, stable `0.4.2` plus beta `0.5.132` becomes stable `0.6.0`.
- Beta follows the latest release line and uses the workflow run number, with a
  monotonic fallback if that counter is smaller than an existing beta patch.
  After stable `0.6.0`, a new beta is `0.7.<run number>`.
- A retry of the same source commit and channel reuses its existing checkpoint
  version instead of generating a second release.

For a deliberate larger stable increment, run **Release pipeline** manually on
`main`, selecting `minor` or `major`. The default `auto` uses the rules above.

The source manifest is a version floor. CI updates `package.json` and
`package-lock.json` in its workspace before testing. Release tags point to a
commit containing those generated manifests and the tested source; CI pushes
only the tag, so branch protection and automatic version commits do not cause
release loops. Download the VSIX from the GitHub Release, or check out its tag
to reproduce the released version locally.

## What gates publication

The workflow performs type checking, lint, unit tests, production builds, and
browser tests, including native 2K and scaled layouts. It then packages the
candidate VSIX and extracts that exact file for the real VS Code integration
suite: Franka loading, source saving, saved-pose restoration, and included-file
reload. Publication consumes the uploaded VSIX without rebuilding it.

A failed check prevents Marketplace publication and production web deployment.
Browser reports are retained, with screenshots and traces for failed attempts.
The separately triggered manual web-preview workflow is for preview deployments;
it does not publish an extension or deploy the production site.

## Recovery and credentials

The existing `VSCE_PAT` secret must grant Marketplace publishing access. The
workflow's `GITHUB_TOKEN` needs `contents: write` to push release tags and create
GitHub Releases. Cloudflare and Pages keep their existing credentials/settings.
No additional PAT for pushing to `main` is needed.

A release checkpoint is pushed only after the candidate passes all tests, and
before Marketplace publication. Stable tags are `v<version>`; beta checkpoints
are `beta/v<version>`. Their annotations record the original source commit.

If publication fails after the checkpoint, rerun **all jobs** in the same workflow
run. It retests the checkpoint version, skips a version already present on the
Marketplace, and creates a missing GitHub Release or uploads a missing VSIX
asset. An unavailable Marketplace history aborts planning instead of guessing.

Both channels share a publication lock. If another release advances Marketplace
state while a candidate is being tested, that outdated candidate fails before
publication. Rerun all jobs to select and test an appropriate new version.

To validate planning locally without publishing:

```bash
npm run test:unit
```

The release unit tests include a temporary Git remote to verify checkpoint
immutability and that the source branch is unchanged. They do not publish to the
Marketplace or write to the real repository.
