// Source-pane rendering, extracted so we can:
//   1) replace the legacy `innerHTML +=` string assembly with safe DOM
//      construction (no XSS risk from URDF text), and
//   2) virtualise huge files (5000+ lines after xacro expansion) so we
//      don't blow ~50 ms parsing markup or pin ~25 MB to the DOM tree.
//
// The module owns its own root inside the panel `<section>`; the renderer
// just calls mountSourcePane on every load and setActiveLine when a link
// is selected.

export interface SourcePaneInput {
  fileName: string;
  format: 'urdf' | 'xacro';
  urdf: string;
}

export interface SourcePane {
  setActiveLine(line: number | undefined): void;
  /** For tests + diagnostics: how many DOM line elements are currently mounted. */
  mountedLineCount(): number;
  /** For tests: which line is currently highlighted (1-based) or undefined. */
  activeLine(): number | undefined;
  dispose(): void;
}

// Threshold above which we virtualise. Smaller documents render every line
// upfront — the DOM cost is negligible and we avoid any scroll-driven layout
// thrash. Tunable; kept conservative so behaviour-equivalence with the
// legacy renderer is preserved for typical robots.
export const VIRTUALIZE_THRESHOLD_LINES = 2000;

// How many extra lines to render above and below the visible window when
// virtualising. Big enough to absorb wheel-scroll bursts without flashes.
const OVERSCAN_LINES = 80;

interface SourcePaneInternals {
  meta: HTMLDivElement;
  pre: HTMLPreElement;
  code: HTMLElement;
  spacer?: HTMLDivElement;        // virtualised mode: holds total height
  rowsLayer?: HTMLDivElement;     // virtualised mode: absolutely positioned rows
  lineHeight: number;
}

export function mountSourcePane(host: HTMLElement, input: SourcePaneInput): SourcePane {
  while (host.firstChild) {
    host.removeChild(host.firstChild);
  }

  const lines = input.urdf.split('\n');
  const numWidth = String(lines.length).length;

  const meta = document.createElement('div');
  meta.className = 'source-meta muted';
  meta.textContent = `${input.fileName} · ${lines.length} lines${input.format === 'xacro' ? ' (expanded xacro)' : ''}`;
  host.appendChild(meta);

  const pre = document.createElement('pre');
  pre.className = 'source-view';
  const code = document.createElement('code');
  pre.appendChild(code);
  host.appendChild(pre);

  let activeLine: number | undefined;
  const internals: SourcePaneInternals = { meta, pre, code, lineHeight: 18 };

  if (lines.length <= VIRTUALIZE_THRESHOLD_LINES) {
    // Eager mode: drop every line into a fragment in one shot. Cheaper than
    // the legacy innerHTML concatenation because we never serialise then
    // re-parse the markup.
    const frag = document.createDocumentFragment();
    for (let i = 0; i < lines.length; i++) {
      frag.appendChild(buildLineNode(lines[i], i + 1, numWidth));
    }
    code.appendChild(frag);

    return {
      setActiveLine(line) {
        activeLine = applyActiveLine(code, line);
      },
      mountedLineCount: () => code.childElementCount,
      activeLine: () => activeLine,
      dispose() { /* GCed with host */ }
    };
  }

  // Virtualised mode. Layout:
  //   <pre class="source-view">
  //     <code style="position:relative; height: TOTAL">
  //       <div class="source-rows" style="position:absolute; top:0; left:0; right:0">
  //         (only visible lines + overscan)
  //       </div>
  //     </code>
  //   </pre>
  // The <pre> is the scroll container (CSS already sets overflow: auto).
  const rowsLayer = document.createElement('div');
  rowsLayer.className = 'source-rows';
  rowsLayer.style.position = 'absolute';
  rowsLayer.style.top = '0';
  rowsLayer.style.left = '0';
  rowsLayer.style.right = '0';

  code.style.position = 'relative';
  code.style.display = 'block';
  code.style.minHeight = '0';

  // Use the gutter+text of a probe line to determine the actual rendered
  // line height. Falls back to 18px if the probe can't be measured (e.g.
  // panel hidden when first mounted).
  const probe = buildLineNode(lines[0] ?? '', 1, numWidth);
  code.appendChild(probe);
  const probeRect = probe.getBoundingClientRect();
  if (probeRect.height > 0) {
    internals.lineHeight = probeRect.height;
  }
  code.removeChild(probe);

  const spacer = document.createElement('div');
  spacer.setAttribute('aria-hidden', 'true');
  spacer.style.height = `${lines.length * internals.lineHeight}px`;
  spacer.style.width = '1px';
  code.appendChild(spacer);
  code.appendChild(rowsLayer);

  internals.spacer = spacer;
  internals.rowsLayer = rowsLayer;

  let mountedRange: [number, number] = [-1, -1];

  const renderWindow = (): void => {
    const viewportTop = pre.scrollTop;
    const viewportHeight = pre.clientHeight || 600;
    const first = Math.max(0, Math.floor(viewportTop / internals.lineHeight) - OVERSCAN_LINES);
    const visibleCount = Math.ceil(viewportHeight / internals.lineHeight);
    const last = Math.min(lines.length, first + visibleCount + OVERSCAN_LINES * 2);
    if (mountedRange[0] === first && mountedRange[1] === last) {
      return;
    }
    mountedRange = [first, last];

    while (rowsLayer.firstChild) {
      rowsLayer.removeChild(rowsLayer.firstChild);
    }
    rowsLayer.style.transform = `translateY(${first * internals.lineHeight}px)`;
    const frag = document.createDocumentFragment();
    for (let i = first; i < last; i++) {
      frag.appendChild(buildLineNode(lines[i], i + 1, numWidth));
    }
    rowsLayer.appendChild(frag);
    if (activeLine !== undefined) {
      applyActiveLine(rowsLayer, activeLine);
    }
  };

  let scheduled = false;
  const onScroll = (): void => {
    if (scheduled) {
      return;
    }
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      renderWindow();
    });
  };

  pre.addEventListener('scroll', onScroll, { passive: true });
  renderWindow();

  return {
    setActiveLine(line) {
      activeLine = line;
      if (line === undefined) {
        applyActiveLine(rowsLayer, undefined);
        return;
      }
      // Bring the line into the window even if it's currently virtualised.
      const desiredTop = Math.max(0, (line - 1) * internals.lineHeight - pre.clientHeight / 2);
      pre.scrollTop = desiredTop;
      renderWindow();
      const node = rowsLayer.querySelector<HTMLDivElement>(`[data-source-line="${line}"]`);
      if (node) {
        applyActiveLine(rowsLayer, line);
        node.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    },
    mountedLineCount: () => rowsLayer.childElementCount,
    activeLine: () => activeLine,
    dispose() {
      pre.removeEventListener('scroll', onScroll);
    }
  };
}

// Build a single line element. Returns a fresh detached node — the caller
// chooses whether to append to a fragment or a live tree.
function buildLineNode(text: string, lineNo: number, numWidth: number): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'source-line';
  row.dataset.sourceLine = String(lineNo);

  const gutter = document.createElement('span');
  gutter.className = 'source-gutter';
  gutter.textContent = String(lineNo).padStart(numWidth, ' ');
  row.appendChild(gutter);

  const body = document.createElement('span');
  body.className = 'source-text';
  // Empty lines need a non-breaking space placeholder so the row still has
  // visible height — matches the legacy `escapeHtml(line) || ' '` fallback.
  body.textContent = text.length > 0 ? text : ' ';
  row.appendChild(body);

  return row;
}

function applyActiveLine(scope: ParentNode, line: number | undefined): number | undefined {
  scope.querySelectorAll('.source-line.active').forEach(el => el.classList.remove('active'));
  if (!line) {
    return undefined;
  }
  const target = scope.querySelector<HTMLElement>(`[data-source-line="${line}"]`);
  if (target) {
    target.classList.add('active');
  }
  return line;
}
