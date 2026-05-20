// Render docs/*.md to dist-web/docs/*.html using marked. Each page is wrapped
// in a tiny shared layout with a nav sidebar.

import { marked } from 'marked';
import { readFile, writeFile, mkdir, readdir, watch as fsWatch, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const SRC = path.join(REPO, 'docs');
const OUT = path.join(REPO, 'dist-web', 'docs');

const PAGES = [
  { slug: 'index',        title: 'Overview' },
  { slug: 'quickstart',   title: 'Quickstart' },
  { slug: 'features',     title: 'Features' },
  { slug: 'architecture', title: 'Architecture' },
  { slug: 'development',  title: 'Development' }
];

const PAGE_SLUGS = new Set(PAGES.map(page => page.slug));

const renderer = new marked.Renderer();
// Rewrite cross-page links (e.g. ./quickstart.html) to stay relative.
renderer.link = function rewriteLink({ href, title, text }) {
  if (!href) {
    return text;
  }
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
  return `<a href="${escapeHtml(href)}"${titleAttr}>${text}</a>`;
};

marked.use({
  renderer,
  gfm: true,
  breaks: false
});

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));
}

function layout({ title, slug, body }) {
  const nav = PAGES.map(page => {
    const href = page.slug === 'index' ? './' : `./${page.slug}.html`;
    const cls = page.slug === slug ? ' class="active"' : '';
    return `<li${cls}><a href="${href}">${escapeHtml(page.title)}</a></li>`;
  }).join('\n');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light dark">
  <title>${escapeHtml(title)} · URDF Studio</title>
  <link rel="stylesheet" href="./docs.css">
</head>
<body>
  <header class="docs-header">
    <a class="docs-brand" href="../">URDF Studio</a>
    <nav class="docs-nav-top"><a href="../">Launch app</a><a href="https://github.com/deyuf/urdf-studio">GitHub</a></nav>
  </header>
  <div class="docs-shell">
    <aside class="docs-sidebar">
      <ul>${nav}</ul>
    </aside>
    <main class="docs-main">
      ${body}
    </main>
  </div>
</body>
</html>
`;
}

async function build() {
  await mkdir(OUT, { recursive: true });
  const files = await readdir(SRC);
  let built = 0;
  for (const file of files) {
    if (!file.endsWith('.md')) {
      continue;
    }
    const slug = file.slice(0, -3);
    if (!PAGE_SLUGS.has(slug)) {
      // Skip stray markdown files not in the navigation.
      continue;
    }
    const page = PAGES.find(p => p.slug === slug);
    const md = await readFile(path.join(SRC, file), 'utf8');
    const body = marked.parse(md);
    await writeFile(
      path.join(OUT, slug === 'index' ? 'index.html' : `${slug}.html`),
      layout({ title: page.title, slug, body }),
      'utf8'
    );
    built++;
  }
  await copyFile(path.join(SRC, 'docs.css'), path.join(OUT, 'docs.css'));
  console.log(`Built ${built} doc pages → ${path.relative(REPO, OUT)}/`);
}

async function watch() {
  await build();
  console.log(`Watching ${path.relative(REPO, SRC)}/ for changes...`);
  const watcher = fsWatch(SRC, { recursive: true });
  for await (const _event of watcher) {
    try {
      await build();
    } catch (error) {
      console.error('Doc build failed:', error);
    }
  }
}

const mode = process.argv.includes('--watch') ? 'watch' : 'build';
if (mode === 'watch') {
  await watch();
} else {
  await build();
}
