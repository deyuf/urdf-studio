---
title: Use it in the browser
order: 1
summary: Open URDF and xacro robot models in your browser with URDF Studio. Pick a folder, choose a robot, and work offline — files are never uploaded.
---

# Use it in the browser

The browser version lives at [urdf.deyuf.org](https://urdf.deyuf.org). There
is nothing to install and no account.

## Your files stay on your computer

URDF Studio reads the folder you choose directly in the browser. Xacro is
expanded and meshes are loaded on your machine; no file is sent to a
server. Closing the tab ends access to the folder.

## Opening a folder

Choose the **package or workspace root** — the folder that contains
`package.xml`, or a folder that contains several packages. URDF Studio
needs the whole package, not just the robot file, because meshes and
included xacro files are found through `package://` paths.

There are three ways to open one:

| How | Works in |
|---|---|
| **Open folder** button | Chrome, Edge, Brave, Arc, Opera |
| Drag the folder onto the page | Chrome, Edge, Brave, Arc, Opera |
| **Pick files** button | All browsers, including Firefox and Safari |

**Pick files** reads every file in the folder up front, so opening a large
workspace takes longer than with **Open folder**.

Folders named `.git`, `node_modules`, `build`, `install` and `log` are
skipped while scanning.

## Choosing a robot

If the folder has one robot file, it opens straight away. If it has
several, they are listed in the middle of the page with complete robots
(files under `robots/`, `*.urdf.xacro`) before helper files such as macros
and SRDFs. All files are also in the menu in the top bar, so you can switch
robots at any time.

## Coming back later

In Chromium-based browsers, the page remembers the last folder you opened.
Next time, click **Reopen *folder name*** and allow access again — browsers
ask every session.

What else is remembered, per browser:

- Saved poses and bookmarks, per robot file — see
  [Save poses and export](../features/poses.html).
- Settings, the colour theme, and the side panel width.

Clearing the site's data in your browser removes all of these.

## Working with an edited file

You can edit the URDF in the **Source** tab and the 3D view updates as you
type. In the browser, **Ctrl+S** (**⌘S** on macOS) downloads the edited
file; it does not overwrite the original on disk. See
[Edit the source](../features/editing.html).

## The tour and the help button

The first visit shows a four-step tour. Press **Esc** to close it; the
**?** button in the top bar opens it again.

## If something doesn't load

See [Troubleshooting](../help/) — most problems are a folder chosen one
level too deep, or a package that lives elsewhere.
