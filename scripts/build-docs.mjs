// Render docs/**/*.md to dist-web/docs/**/*.html using marked.
//
// Layout features:
//   - Nested directories: each section is a folder with an index.md plus
//     siblings. The sidebar groups them and shows hierarchy.
//   - Frontmatter (YAML-ish, optional):
//       ---
//       title: Page title (else falls back to the first <h1>)
//       order: 10           (sort key inside a section)
//       summary: short blurb (for the section index page)
//       ---
//   - Auto-generated anchors on h2/h3.
//   - Per-page table of contents (right rail) from h2/h3.
//   - Prev / Next navigation across the flat reading order.

import { marked } from 'marked';
import { readFile, writeFile, mkdir, readdir, watch as fsWatch, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const SRC = path.join(REPO, 'docs');
const OUT = path.join(REPO, 'dist-web', 'docs');

// Production origin used for canonical URLs, Open Graph URLs and the
// sitemap. Both deploys (Cloudflare Pages, GitHub Pages) resolve to this
// host, so canonicalising to it consolidates SEO signal.
const SITE_ORIGIN = 'https://urdf.deyuf.org';
const DEFAULT_OG_IMAGE = `${SITE_ORIGIN}/og-image.png`;

// Section ordering and labels — controls the sidebar group order. Sections
// not listed here are appended alphabetically.
const SECTION_ORDER = [
  { dir: '',              label: 'Overview' },
  { dir: 'quickstart',    label: 'Quickstart' },
  { dir: 'features',      label: 'Features' },
  { dir: 'architecture',  label: 'Architecture' },
  { dir: 'development',   label: 'Development' }
];

// ---------------------------------------------------------------------------
// Markdown parsing — anchors, frontmatter, link rewriting.
// ---------------------------------------------------------------------------

const slugify = text =>
  String(text)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

const escapeHtml = value =>
  String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));

function parseFrontmatter(raw) {
  if (!raw.startsWith('---\n')) {
    return { data: {}, body: raw };
  }
  const end = raw.indexOf('\n---', 4);
  if (end < 0) {
    return { data: {}, body: raw };
  }
  const block = raw.slice(4, end);
  const data = {};
  for (const line of block.split('\n')) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if (/^\d+$/.test(value)) {
      value = Number(value);
    }
    data[key] = value;
  }
  return { data, body: raw.slice(end + 4).replace(/^\n+/, '') };
}

function createRenderer(toc) {
  const renderer = new marked.Renderer();
  renderer.heading = function ({ depth, text, tokens }) {
    const inner = this.parser.parseInline(tokens);
    const id = slugify(text);
    if (depth === 2 || depth === 3) {
      toc.push({ depth, text: text.replace(/<[^>]+>/g, ''), id });
    }
    return `<h${depth} id="${id}"><a class="anchor" href="#${id}">#</a>${inner}</h${depth}>\n`;
  };
  renderer.link = function ({ href, title, text, tokens }) {
    const inner = this.parser.parseInline(tokens);
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
    return `<a href="${escapeHtml(href)}"${titleAttr}>${inner}</a>`;
  };
  return renderer;
}

// ---------------------------------------------------------------------------
// Filesystem walk.
// ---------------------------------------------------------------------------

async function walkDocs() {
  const root = await readSection('', SRC);
  return root;
}

async function readSection(rel, abs) {
  const entries = await readdir(abs, { withFileTypes: true });
  const pages = [];
  const subSections = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'docs.css') continue;
    const childAbs = path.join(abs, entry.name);
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      subSections.push(await readSection(childRel, childAbs));
    } else if (entry.name.endsWith('.md')) {
      const raw = await readFile(childAbs, 'utf8');
      const { data, body } = parseFrontmatter(raw);
      const slug = entry.name.replace(/\.md$/, '');
      pages.push({
        slug,
        section: rel,
        relPath: childRel,
        absPath: childAbs,
        outPath: rel
          ? slug === 'index'
            ? `${rel}/index.html`
            : `${rel}/${slug}.html`
          : slug === 'index'
            ? 'index.html'
            : `${slug}.html`,
        urlPath: rel
          ? slug === 'index'
            ? `${rel}/`
            : `${rel}/${slug}.html`
          : slug === 'index'
            ? './'
            : `${slug}.html`,
        data,
        body
      });
    }
  }
  pages.sort((a, b) => {
    // index always first; otherwise by data.order then by title.
    if (a.slug === 'index') return -1;
    if (b.slug === 'index') return 1;
    const orderA = typeof a.data.order === 'number' ? a.data.order : Infinity;
    const orderB = typeof b.data.order === 'number' ? b.data.order : Infinity;
    if (orderA !== orderB) return orderA - orderB;
    return String(a.data.title || a.slug).localeCompare(String(b.data.title || b.slug));
  });
  return { dir: rel, pages, subSections };
}

// ---------------------------------------------------------------------------
// Navigation flattening + sidebar HTML.
// ---------------------------------------------------------------------------

function flattenSections(rootSection) {
  const sections = [];
  const rootIndex = rootSection.pages.find(p => p.slug === 'index');
  const orderedDirs = [
    ...SECTION_ORDER,
    ...rootSection.subSections
      .map(s => s.dir)
      .filter(dir => !SECTION_ORDER.some(known => known.dir === dir))
      .map(dir => ({ dir, label: dir.charAt(0).toUpperCase() + dir.slice(1) }))
  ];

  for (const { dir, label } of orderedDirs) {
    if (dir === '') {
      if (rootIndex) {
        sections.push({ label, pages: [rootIndex] });
      }
      continue;
    }
    const sub = rootSection.subSections.find(s => s.dir === dir);
    if (!sub) continue;
    sections.push({ label, pages: sub.pages });
  }
  return sections;
}

function renderSidebar(sections, currentPage) {
  return sections
    .map(section => {
      const links = section.pages
        .map(page => {
          const title = page.data.title || pageTitleFromBody(page) || page.slug;
          const isActive = page.relPath === currentPage.relPath;
          const href = relativeUrl(currentPage, page);
          return `<li${isActive ? ' class="active"' : ''}><a href="${href}">${escapeHtml(title)}</a></li>`;
        })
        .join('\n');
      return `<div class="docs-sidebar-group"><h4>${escapeHtml(section.label)}</h4><ul>${links}</ul></div>`;
    })
    .join('\n');
}

function pageTitleFromBody(page) {
  const match = /^#\s+(.+)$/m.exec(page.body);
  return match ? match[1].trim() : undefined;
}

// Build a one-line meta description for the page. Order of preference:
//   1. `summary:` frontmatter (authors can write the snippet they want
//      Google to show).
//   2. First plain paragraph in the body — skipping headings, tables,
//      blockquotes, lists, and code fences. Markdown formatting is
//      stripped to keep the snippet readable.
//   3. A generic site fallback.
const SITE_FALLBACK_DESCRIPTION =
  'URDF Studio — browser-based viewer and VS Code extension for URDF and xacro robot models. Inspect links and joints, drive sliders, expand xacro, and validate inertias.';

function stripInlineMarkdown(text) {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')         // images
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')      // links
    .replace(/<[^>]+>/g, '')                      // raw html / autolinks
    .replace(/`([^`]+)`/g, '$1')                  // inline code
    .replace(/[*_~]+/g, '')                       // emphasis markers
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${cut.slice(0, lastSpace > 80 ? lastSpace : max).trimEnd()}…`;
}

function pageDescription(page) {
  if (typeof page.data.summary === 'string' && page.data.summary.trim()) {
    return truncate(page.data.summary.trim(), 200);
  }
  const lines = page.body.split('\n');
  let inFence = false;
  let buffer = '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) { inFence = !inFence; buffer = ''; continue; }
    if (inFence) continue;
    if (!trimmed) { if (buffer) break; else continue; }
    if (/^#{1,6}\s/.test(trimmed)) { buffer = ''; continue; }
    if (trimmed.startsWith('|') || trimmed.startsWith('>') ||
        /^[-*+]\s/.test(trimmed) || /^\d+\.\s/.test(trimmed)) {
      if (buffer) break; else continue;
    }
    buffer = buffer ? `${buffer} ${trimmed}` : trimmed;
  }
  const cleaned = stripInlineMarkdown(buffer);
  if (cleaned.length >= 40) return truncate(cleaned, 200);
  return SITE_FALLBACK_DESCRIPTION;
}

function canonicalUrlFor(page) {
  // outPath examples:
  //   'index.html'           → /docs/
  //   'features/index.html'  → /docs/features/
  //   'features/joints.html' → /docs/features/joints.html
  let pathPart = page.outPath;
  if (pathPart === 'index.html') pathPart = '';
  else if (pathPart.endsWith('/index.html')) {
    pathPart = pathPart.slice(0, -'index.html'.length);
  }
  return `${SITE_ORIGIN}/docs/${pathPart}`;
}

function relativeUrl(fromPage, toPage) {
  const fromDir = path.posix.dirname(`/${fromPage.outPath}`);
  const target = `/${toPage.outPath}`;
  let rel = path.posix.relative(fromDir, target);
  // index.html → ./ for cleaner URLs.
  if (rel.endsWith('/index.html')) {
    rel = `${rel.slice(0, -'index.html'.length)}`;
  } else if (rel === 'index.html') {
    rel = './';
  }
  if (!rel.startsWith('.')) {
    rel = `./${rel}`;
  }
  return rel || './';
}

function renderToc(toc) {
  if (toc.length === 0) {
    return '';
  }
  const items = toc
    .map(item => `<li class="depth-${item.depth}"><a href="#${item.id}">${escapeHtml(item.text)}</a></li>`)
    .join('');
  return `<nav class="docs-toc" aria-label="On this page"><h5>On this page</h5><ul>${items}</ul></nav>`;
}

function renderPrevNext(flatPages, currentPage) {
  const index = flatPages.findIndex(p => p.relPath === currentPage.relPath);
  if (index < 0) return '';
  const prev = index > 0 ? flatPages[index - 1] : null;
  const next = index < flatPages.length - 1 ? flatPages[index + 1] : null;
  if (!prev && !next) return '';
  const link = (page, label) => {
    if (!page) return '<span></span>';
    const title = page.data.title || pageTitleFromBody(page) || page.slug;
    return `<a class="docs-pager-link" href="${relativeUrl(currentPage, page)}">
      <small>${label}</small><span>${escapeHtml(title)}</span>
    </a>`;
  };
  return `<nav class="docs-pager">${link(prev, '← Previous')}${link(next, 'Next →')}</nav>`;
}

function layout({ title, description, canonical, sidebar, toc, body, pager, depth }) {
  const upPrefix = '../'.repeat(depth);
  const cssHref = `${upPrefix}docs.css`;
  const iconHref = `${upPrefix}icon.png`;
  const indexHref = `${upPrefix}index.html`;
  const appHref = `${'../'.repeat(depth + 1)}`;
  const ghHref = 'https://github.com/deyuf/urdf-studio';
  const fullTitle = `${title} · URDF Studio`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light dark">
  <meta name="theme-color" content="#1a73e8">
  <title>${escapeHtml(fullTitle)}</title>
  <meta name="description" content="${escapeHtml(description)}">
  <link rel="canonical" href="${escapeHtml(canonical)}">
  <meta property="og:type" content="article">
  <meta property="og:site_name" content="URDF Studio">
  <meta property="og:title" content="${escapeHtml(fullTitle)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:url" content="${escapeHtml(canonical)}">
  <meta property="og:image" content="${escapeHtml(DEFAULT_OG_IMAGE)}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(fullTitle)}">
  <meta name="twitter:description" content="${escapeHtml(description)}">
  <meta name="twitter:image" content="${escapeHtml(DEFAULT_OG_IMAGE)}">
  <link rel="icon" type="image/png" href="${iconHref}">
  <link rel="apple-touch-icon" href="${iconHref}">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Google+Sans:wght@400;500;600;700&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap">
  <link rel="stylesheet" href="${cssHref}">
</head>
<body>
  <header class="docs-header">
    <a class="docs-brand" href="${indexHref}">
      <img class="docs-brand-mark" src="${iconHref}" alt="" width="28" height="28">
      URDF&nbsp;Studio
    </a>
    <nav class="docs-nav-top">
      <a class="docs-cta" href="${appHref}">Launch app ↗</a>
      <a href="${ghHref}">GitHub</a>
    </nav>
  </header>
  <div class="docs-shell">
    <aside class="docs-sidebar" aria-label="Documentation navigation">
      ${sidebar}
    </aside>
    <main class="docs-main">
      <article class="docs-article">
        ${body}
        ${pager}
      </article>
    </main>
    <aside class="docs-rail" aria-label="On this page">
      ${toc}
    </aside>
  </div>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Sitemap.
// ---------------------------------------------------------------------------

// Emit sitemap.xml at the dist-web root (i.e. one level above OUT) so it
// lives at https://urdf.deyuf.org/sitemap.xml, matching what robots.txt
// advertises. The root and the docs subtree are both deployed from
// dist-web/, so a single sitemap covers both.
async function writeSitemap(docUrls) {
  const today = new Date().toISOString().slice(0, 10);
  const urls = [
    { loc: `${SITE_ORIGIN}/`, priority: '1.0', changefreq: 'weekly' },
    ...docUrls.map(loc => ({ loc, priority: '0.6', changefreq: 'monthly' }))
  ];
  const body = urls
    .map(({ loc, priority, changefreq }) =>
      `  <url>\n    <loc>${escapeHtml(loc)}</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>${changefreq}</changefreq>\n    <priority>${priority}</priority>\n  </url>`)
    .join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
  const sitemapPath = path.join(OUT, '..', 'sitemap.xml');
  await writeFile(sitemapPath, xml, 'utf8');
}

// ---------------------------------------------------------------------------
// Build.
// ---------------------------------------------------------------------------

async function build() {
  const tree = await walkDocs();
  const sections = flattenSections(tree);
  const flatPages = sections.flatMap(s => s.pages);

  await mkdir(OUT, { recursive: true });
  let built = 0;
  const sitemapEntries = [];
  for (const page of flatPages) {
    const toc = [];
    const renderer = createRenderer(toc);
    marked.setOptions({ renderer, gfm: true, breaks: false });
    const html = marked.parse(page.body);
    const title = page.data.title || pageTitleFromBody(page) || page.slug;
    const description = pageDescription(page);
    const canonical = canonicalUrlFor(page);
    const depth = page.section ? page.section.split('/').length : 0;
    const sidebar = renderSidebar(sections, page);
    const tocHtml = renderToc(toc);
    const pager = renderPrevNext(flatPages, page);

    const outPath = path.join(OUT, page.outPath);
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(
      outPath,
      layout({ title, description, canonical, sidebar, toc: tocHtml, body: html, pager, depth }),
      'utf8'
    );
    sitemapEntries.push(canonical);
    built++;
  }

  await writeSitemap(sitemapEntries);

  // Static assets.
  await copyFile(path.join(SRC, 'docs.css'), path.join(OUT, 'docs.css'));
  // The docs pages reference ../icon.png at depth 0 (i.e. /icon.png at the
  // dist-web/docs root). When deployed to GitHub Pages, the docs subtree is
  // the site root, so the file has to exist alongside the docs themselves.
  await copyFile(path.join(REPO, 'media', 'icon.png'), path.join(OUT, '..', 'icon.png'))
    .catch(() => undefined);
  await copyFile(path.join(REPO, 'media', 'icon.png'), path.join(OUT, 'icon.png'));

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
