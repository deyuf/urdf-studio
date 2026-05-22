---
title: Core
order: 10
---

# Core

`src/core/*` holds the parsing, analysis and expansion logic that's
identical between hosts. The two rules are:

1. **No direct imports of Node-only modules** (`node:fs`, `node:path`,
   `jsdom`, …). The browser bundle refuses if you violate this.
2. **Fs/path/DOM access goes through `CoreIo`**, an interface defined in
   `src/core/io.ts`.

## The CoreIo interface

```ts
interface CoreIo {
  readText(absPath: string): Promise<string>;
  readTextSync(absPath: string): string;
  existsSync(absPath: string): boolean;
  readdir(absPath: string): Promise<DirEntry[]>;

  // posix-like path utilities, semantics matching the host platform
  dirname(p: string): string;
  basename(p: string, ext?: string): string;
  extname(p: string): string;
  resolve(...parts: string[]): string;
  join(...parts: string[]): string;
  isAbsolute(p: string): boolean;
  readonly sep: string;

  // DOM access for xacro expansion
  readonly DOMParser: { new (): DOMParser };
  readonly XMLSerializer: { new (): XMLSerializer };
}
```

The singleton is set by the entry point of each target *before* any core
function is called:

```ts
// VS Code (src/extension.ts)
import './core/io.node';  // side-effect: calls setCoreIo(nodeImpl)

// Web (src/web/main.ts)
import './ioBrowser';      // side-effect: calls setCoreIo(browserImpl)
```

The node impl wires `node:fs`, `node:path`, and `jsdom`'s DOM. The
browser impl wires the [`BrowserVfs`](./browser.html), a tiny POSIX path
utility, and the native `globalThis.DOMParser` / `XMLSerializer`.

## Core modules

| File | Purpose | Notes |
|---|---|---|
| `core/io.ts` | `CoreIo` interface, singleton, setter. | The contract every host must implement. |
| `core/xml.ts` | XML parsing with error capture. Uses `@xmldom/xmldom` (browser-safe). | Both hosts share this. |
| `core/urdfAnalysis.ts` | The big one. Parses URDF, builds the link/joint graph, validates structure, resolves mesh paths, computes inertia eigenvalues, builds the tree. | Pure but for `io.existsSync` for mesh files. |
| `core/xacro.ts` | Wraps `xacro-parser` with ROS-compat rewrites (Python ternary, `**`, slice, `load_yaml`). | Reads source/include files via `io.readText`; `load_yaml` is sync via `io.readTextSync`. |
| `core/srdf.ts` | Parses SRDF XML and `initial_positions.yaml`. | Reads via `io.readText`. |
| `core/packageMap.ts` | Recursive scan for `package.xml`, builds package → path map, resolves `package://` URIs. | Uses `io.readdir`, `io.readText`. |
| `core/inertia.ts` | Eigenvalues + ellipsoid semi-axes from a 3×3 symmetric tensor. | Pure math. |
| `core/mimic.ts` | Build mimic graph and propagate values. | Pure. |

## Testing

`test/unit/core.test.ts` exercises core via `node --test`. It side-effect
imports `core/io.node.ts` at the top, so the Node IO impl is installed
for every test.

## Why not just take fs/path as arguments?

A few reasons:

- Many of the core functions are called recursively or transitively, and
  threading `io` through every call site clutters the API.
- `load_yaml` lives inside the xacro expression evaluator, which is a
  third-party library. The cleanest hook is a module-scope singleton.
- The renderer (`src/renderer/main.ts`) is bundled separately and does
  not touch core directly. The two-host boundary is the post-message
  protocol, not the core API.

The trade-off is that core is **stateful** for the lifetime of the
process. Each host owns the singleton.
