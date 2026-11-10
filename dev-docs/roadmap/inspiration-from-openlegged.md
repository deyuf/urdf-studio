# Roadmap — Inspiration from OpenLegged/URDF-Studio

Reference: <https://github.com/OpenLegged/URDF-Studio>

This document compares the OpenLegged project with ours, identifies which
ideas are worth borrowing given our project's identity, and proposes a
prioritized roadmap.

---

## 1. Positioning — how the two projects differ

| Axis | Ours (`deyuf/urdf-studio`) | Reference (`OpenLegged/URDF-Studio`) |
|---|---|---|
| Mission | **Inspect, visualize, drive** ROS robot models | **Author, edit, assemble** robot models end-to-end |
| Targets | VS Code extension **and** browser, single codebase | Browser web app (workspaces, packages/**) |
| UI stack | Vanilla TS + Three.js + URDFLoader, ~2500 LOC renderer/UI | React 19 + React Three Fiber + Zustand + Tailwind + Monaco |
| Inputs | `.urdf`, `.urdf.xacro`, `.xacro` from local folder / FS Access | URDF + MJCF + USD; single files, folders, ZIP, `.usp` archives |
| Outputs | PNG screenshot, JSON pose, merged SRDF | URDF, MJCF, USD, SDF, Xacro, CSV/BOM, PDF, ZIP, `.usp` |
| Editing | Read-only viewer + joint driving + reachability sampling | Full topology/geometry/hardware editing |
| AI | None | NL→robot generation, automated inspection, code review |
| Footprint | Lean, no server, no API keys | Heavy, optional OpenAI integration |

**Identity to protect.** Our differentiators are (a) the dual VS Code +
browser target from one codebase, (b) zero-server / zero-account / no
LLM key required, and (c) a small, auditable surface. The plan below
borrows ideas that strengthen our viewer/inspector identity and skips
ideas that would force a rewrite or pull in heavy dependencies.

---

## 2. Decision matrix — what to borrow

### 2.1 Adopt — high value, low identity cost

| Idea | Why it fits |
|---|---|
| **Source ↔ 3D bidirectional sync** (click link in viewport → highlight in XML; click in XML → highlight in viewport) | We already have a Links tree and Inspector; the source pane is the missing third leg. In VS Code this maps to existing `revealRange`; in the browser we ship a read-only Monaco or CodeMirror panel. |
| **Drag-drop ZIP / folder import** in the browser | Filling an obvious gap for non-Chromium browsers that lack File System Access. `libarchive.js` or `fflate` handles ZIP/TGZ. |
| **`.usp`-style project archive** (pose + camera + bookmarks + robot bundle in a single shareable file) | A natural extension of our existing Export Pose. Lets users share a reproduction without committing 50 MB of meshes. |
| **CSV / BOM export** (link list with mass, CoM, mesh path) | Trivial given our existing Inspector data; useful for review and BOM diffs. |
| **PDF report** (Checks + Inspector summary + screenshot) | Most teams already do this manually. Renderer's `captureScreenshot` + `jsPDF` covers it. |
| **Measurements tool** (point-to-point, link-to-link distance & angle in viewport) | Pure renderer addition, no model mutation. Fits "inspect" mandate. |
| **Helper overlay labels** (joint axis labels, link names in 3D) | Builds on existing Frames overlay. CSS2DRenderer or sprite labels. |
| **Snapshot gallery** (capture multiple poses, side-by-side compare, export sheet) | Extends current PNG screenshot with a strip view; great for change-review screenshots. |
| **Multi-robot scene** (load N robots, with a transform offset per robot) | Read-only composition — no bridge-joint editor yet. Useful for cell layouts. |
| **MJCF read-only viewer** | MuJoCo XML is increasingly common in RL/sim. A thin loader gives us "URDF + MJCF Studio" without USD's complexity. |
| **Optional AI inspection** (paste an OpenAI/Anthropic key, get a NL summary + diagnostic explanation) | Strictly opt-in, browser-side fetch only. Key stored in `localStorage`. Skips robot *generation*; sticks to inspection. |

### 2.2 Defer — interesting but expensive

| Idea | Why defer |
|---|---|
| **USD viewer with vendored runtime** | Multi-MB WASM, worker plumbing, large maintenance surface. Revisit only if users ask. |
| **Topology editor** (add/remove links and joints from the UI) | Fundamentally turns us into an authoring tool. Big UX surface, big test burden. Out of scope until we have a stable viewer. |
| **Hardware config tab** (motor / transmission / damping / friction editors) | Same identity shift. We can *display* `<transmission>` in the Inspector without enabling edits. |
| **AI robot generation from natural language** | Requires either a server or shipping prompts that depend on remote models. Doesn't match "no server" promise. |

### 2.3 Skip — incompatible

- React + Zustand rewrite. Our vanilla-TS renderer is one of our selling
  points (small, fast cold load, easy to embed). Borrow ideas, not the
  framework.
- Monaco as a hard dependency in VS Code. We already *are* the editor
  there. Optional CodeMirror/Monaco only in the browser shell.

---

## 3. Phased roadmap

Each phase is sized so it can land as a self-contained PR set. Numbers
are nominal effort (S/M/L) for one engineer.

### Phase A — "Inspect, harder" (closest to today's identity)

Goal: deepen the viewer story without changing the model.

1. **Source pane with selection sync** — M
   - Browser: read-only CodeMirror 6 panel beside the viewport,
     resolves clicked link → source line via the existing parse map.
   - VS Code: emit a `revealRange` postMessage on selection (host
     already has the document).
2. **Measurements tool** — S
   - Two-click point picker on visual geometry → distance / Δaxis
     readout, persisted in the pose bookmark.
3. **Helper overlay labels** — S
   - Toggle in the existing overlay menu: link names, joint names,
     axis labels via `CSS2DRenderer`.
4. **CSV / BOM export** — S
   - "Export → BOM (CSV)" emits one row per link (name, mass, CoM xyz,
     inertia eigenvalues, mesh path, mesh sha if cached).
5. **PDF report** — M
   - Bundles current screenshot + Checks table + Inspector snapshot.
     `jsPDF` only; no headless browser.

### Phase B — "Share what you see"

Goal: make a session portable.

6. **ZIP / folder drag-drop** — M
   - Single drop zone in the topbar. Detects archive (`fflate`) or
     directory handle, builds a virtual `packageMap` from the
     `package.xml` files inside.
7. **Project archive (`.urdfstudio`)** — M
   - ZIP containing: pose JSON, camera, bookmarks, settings, optional
     bundled robot dir (`include-meshes` flag). Importing a `.urdfstudio`
     restores the exact viewport.
8. **Snapshot gallery / strip** — S
   - Capture N named poses, render a side-by-side PNG sheet.
9. **Multi-robot scene (read-only)** — L
   - Load multiple robot files into a single workspace tree, each with
     an editable world offset. No bridge joints yet; just `<robotN>`
     grouping in the scene graph and the Links tree.

### Phase C — "Beyond URDF"

Goal: meet users where their models actually live.

10. **MJCF reader (read-only)** — L
    - New `src/core/mjcf.ts` that maps MJCF → the same internal robot
      type the URDF loader emits. Renderer stays identical.
11. **Transmission / hardware display in Inspector** — S
    - Surface `<transmission>` blocks already present in URDF (we
      currently ignore them).

### Phase D — "Optional AI assist" (strictly opt-in)

12. **Inspection assistant** — M
    - "Explain this robot" / "Explain this Check" buttons. Sends only
      the relevant XML slice + diagnostic to the provider chosen by the
      user. API key in `localStorage`, never logged, never sent
      anywhere else.
13. **Diagnostic suggestions** — S
    - Same plumbing; for each warning code, an "Ask AI for a fix" link
      that drops the snippet into the chat panel.

> AI features are gated behind a settings toggle that is **off** by
> default. The web app and the VS Code extension both refuse to load
> the assistant module unless the toggle is on, so the
> non-AI build stays free of `openai`/`@anthropic-ai/sdk` weight.

---

## 4. Architecture notes

- **Stay vanilla.** Each Phase A/B item ships as a new module under
  `src/web/ui/` and a small renderer extension. No framework swap.
- **Core stays pure.** New formats (MJCF) and new exports (CSV/PDF) go
  under `src/core/`, behind the same `CoreIo` boundary, so both hosts
  pick them up for free.
- **Workers where the reference uses them.** PDF generation and large
  ZIP imports run in a Web Worker so the viewport stays at 60 fps.
- **Test parity.** Every new export gets a Playwright fixture against
  `franka_description` matching the existing `test-franka.mjs` style.

---

## 5. Open questions for the maintainer

1. Is "share-as-archive" (`.urdfstudio`) interesting enough to design
   the schema now, or is "share-as-link" (URL-encoded pose + remote
   robot URL) closer to what users ask for?
2. MJCF read-only first, or wait until there's a concrete request? It's
   ~1.5–2 weeks of work and adds a parser surface to maintain.
3. AI assist — would you prefer (a) bring-your-own-key in browser,
   (b) a thin Cloudflare Worker proxy you operate, or (c) skip AI
   entirely and let users paste XML into ChatGPT themselves?
4. Anything from the reference's editor (topology / hardware) that you
   *do* want long-term, so we can avoid painting ourselves into a
   corner?
