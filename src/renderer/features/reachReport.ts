// Reachability report (PDF): a summary sheet and a drawing sheet with the
// dexterity map in front, side and top view, laid out like a CAD drawing —
// aligned views at one scale, a scale bar, overall dimensions, centre lines
// through the robot base and a title block.
//
// jspdf is loaded on demand (see export.ts); this module only describes the
// pages, against the jsPDF instance it is given.

import type { jsPDF } from 'jspdf';
import { DIRECTION_BINS, dexterityColor, type DexterityMap } from '../logic/reachMap';
import { bytesToBase64 } from './export';
import {
  AXIS_NAMES,
  niceStep,
  projectMap,
  summarizeMap,
  type UpAxis,
  type ViewKey,
  type ViewRect,
  type ViewSpec,
  reportViews
} from '../logic/reachReport';

export interface ReachReportInput {
  robotName: string;
  sourcePath: string;
  tipLinkName: string;
  sampleCount: number;
  elapsedMs: number;
  up: UpAxis;
  map: DexterityMap;
  rects: Record<ViewKey, ViewRect>;
  /** Grey robot silhouettes (transparent PNG data URLs) covering each rect. */
  silhouettes?: Partial<Record<ViewKey, string>>;
  /** The 3D viewport, for the summary sheet. */
  perspectivePng?: string;
  /** Aspect ratio (width / height) of `perspectivePng`. */
  perspectiveAspect?: number;
  generated?: Date;
}

type Rgb = [number, number, number];

const PAGE_W = 842; // A4 landscape, points
const PAGE_H = 595;
const BORDER = 20;
const INK: Rgb = [33, 37, 41];
const MUTED: Rgb = [108, 117, 125];
const HAIR: Rgb = [206, 212, 218];
const PAPER: Rgb = [246, 247, 249];
const TITLE_W = 250;
const TITLE_H = 66;

export function buildReachabilityPdf(pdf: jsPDF, input: ReachReportInput): void {
  const generated = input.generated ?? new Date();
  const summary = summarizeMap(input.map, input.up);
  const views = reportViews(input.up);

  // ---- Sheet 1: summary --------------------------------------------------
  sheetFrame(pdf);
  titleBlock(pdf, input, generated, 'Summary', 1);
  const left = BORDER + 18;
  let y = BORDER + 34;
  setText(pdf, 'bold', 16, INK);
  pdf.text('Reachability report', left, y);
  y += 16;
  setText(pdf, 'normal', 9.5, MUTED);
  pdf.text(`${input.robotName} · tip link ${input.tipLinkName}`, left, y);
  y += 26;

  const best = summary.bestDirections;
  const upName = input.up.slice(1);
  const rows: Array<[string, string]> = [
    ['Tip link', input.tipLinkName],
    ['Approach direction', `Z axis of ${input.tipLinkName}, sorted into ${DIRECTION_BINS} directions`],
    ['Samples', `${input.sampleCount.toLocaleString('en-US')} random joint positions within limits (${formatSeconds(input.elapsedMs)})`],
    ['Cell size', `${formatLength(summary.voxelSize)} cubes · ${summary.voxelCount.toLocaleString('en-US')} reached`],
    ['Reached volume', `${summary.volume.toFixed(3)} m³`],
    ['Reach from base axis', `${summary.horizontalReach.toFixed(3)} m (horizontal, from the vertical ${upName} axis through the base)`],
    ['Reach from base origin', `${summary.sphericalReach.toFixed(3)} m`],
    ['Height range', `${upName} ${summary.heightRange[0].toFixed(3)} to ${summary.heightRange[1].toFixed(3)} m`],
    ['Best dexterity', `${best} of ${DIRECTION_BINS} approach directions`],
    ['Best region (centre)', `X ${summary.bestCentroid[0].toFixed(3)}  Y ${summary.bestCentroid[1].toFixed(3)}  Z ${summary.bestCentroid[2].toFixed(3)} m`]
  ];
  const labelW = 118;
  const tableW = 400;
  for (const [label, value] of rows) {
    setText(pdf, 'normal', 8.5, MUTED);
    pdf.text(label, left, y);
    setText(pdf, 'normal', 8.5, INK);
    const lines = pdf.splitTextToSize(value, tableW - labelW) as string[];
    pdf.text(lines, left + labelW, y);
    y += 6 + lines.length * 10.5;
    pdf.setDrawColor(...HAIR);
    pdf.setLineWidth(0.4);
    pdf.line(left, y - 9, left + tableW, y - 9);
  }

  y += 14;
  setText(pdf, 'bold', 10, INK);
  pdf.text('Share of reached volume by dexterity', left, y);
  y += 14;
  for (const band of [...summary.bands].reverse()) {
    const label = `${band.from}–${band.to} of ${DIRECTION_BINS} directions`;
    setText(pdf, 'normal', 8.5, INK);
    pdf.text(label, left, y);
    const barX = left + labelW;
    const barW = 230;
    pdf.setFillColor(...PAPER);
    pdf.rect(barX, y - 7.5, barW, 9, 'F');
    const t = (band.from + band.to) / 2 / DIRECTION_BINS;
    pdf.setFillColor(...rgb255(dexterityColor(t)));
    if (band.share > 0) {
      pdf.rect(barX, y - 7.5, Math.max(0.8, barW * band.share), 9, 'F');
    }
    setText(pdf, 'normal', 8.5, INK);
    pdf.text(`${(band.share * 100).toFixed(1)} %`, barX + barW + 8, y);
    y += 15;
  }
  y += 8;
  setText(pdf, 'normal', 7.5, MUTED);
  const notes = [
    'How to read this: space is divided into cubes. A cube\'s dexterity is how many of '
      + `${DIRECTION_BINS} evenly spread approach directions of the tip link's Z axis reached it in the samples. `
      + 'High dexterity means a part there can be approached from above, from the side or at an angle; '
      + 'the edge of the workspace is reachable from few directions only.',
    'Rotation about the approach axis is not counted. Samples are random joint positions within the '
      + 'joint limits; self-collision and the environment are not checked. More samples give smaller cubes and '
      + 'steadier figures. Coordinates are in the robot base frame.'
  ];
  for (const note of notes) {
    const lines = pdf.splitTextToSize(note, tableW + 10) as string[];
    pdf.text(lines, left, y);
    y += lines.length * 9 + 4;
  }

  if (input.perspectivePng) {
    const boxX = left + tableW + 32;
    const boxW = PAGE_W - BORDER - 18 - boxX;
    const boxTop = BORDER + 74;
    const boxH = PAGE_H - BORDER - TITLE_H - 28 - boxTop;
    const aspect = input.perspectiveAspect && input.perspectiveAspect > 0 ? input.perspectiveAspect : 4 / 3;
    let w = boxW;
    let h = w / aspect;
    if (h > boxH) {
      h = boxH;
      w = h * aspect;
    }
    try {
      pdf.addImage(input.perspectivePng, 'PNG', boxX, boxTop, w, h, undefined, 'FAST');
      pdf.setDrawColor(...HAIR);
      pdf.setLineWidth(0.5);
      pdf.rect(boxX, boxTop, w, h, 'S');
      setText(pdf, 'normal', 7.5, MUTED);
      pdf.text('3D view at the time of export', boxX, boxTop + h + 11);
    } catch (error) {
      console.warn('[urdf] reach report: could not embed the 3D view', error);
    }
  }

  // ---- Sheet 2: drawing ------------------------------------------------------
  pdf.addPage('a4', 'landscape');
  sheetFrame(pdf);
  titleBlock(pdf, input, generated, 'Front, side and top view', 2);
  drawViews(pdf, input, views, summary.horizontalReach);
}

// ---------------------------------------------------------------------------
// Drawing sheet
// ---------------------------------------------------------------------------

/** Space around each view for tick labels, dimensions and its title. */
const PAD = { left: 50, right: 14, top: 24, bottom: 46 };

function drawViews(pdf: jsPDF, input: ReachReportInput, views: ViewSpec[], horizontalReach: number): void {
  const byKey = Object.fromEntries(views.map(view => [view.key, view])) as Record<ViewKey, ViewSpec>;
  const front = input.rects.front;
  const side = input.rects.side;
  const top = input.rects.top;
  const a = front.hMax - front.hMin; // shared by front and top
  const b = side.hMax - side.hMin; // side's width = top's height
  const u = front.vMax - front.vMin; // shared by front and side

  const areaX = BORDER + 14;
  const areaY = BORDER + 12;
  const areaW = PAGE_W - 2 * BORDER - 28;
  const areaH = PAGE_H - 2 * BORDER - 24;
  const scale = Math.min(
    (areaW - 2 * (PAD.left + PAD.right)) / (a + b),
    (areaH - 2 * (PAD.top + PAD.bottom)) / (u + b)
  );

  // Front at top left, side to its right (same heights), top below front
  // (same widths). Explicit titles, so no projection convention is assumed.
  const frontX = areaX + PAD.left;
  const frontY = areaY + PAD.top;
  const sideX = frontX + a * scale + PAD.right + PAD.left;
  const topY = frontY + u * scale + PAD.bottom + PAD.top;

  const placements: Array<{ view: ViewSpec; rect: ViewRect; x: number; y: number }> = [
    { view: byKey.front, rect: front, x: frontX, y: frontY },
    { view: byKey.side, rect: side, x: sideX, y: frontY },
    { view: byKey.top, rect: top, x: frontX, y: topY }
  ];
  const best = input.map.count > 0 ? input.map.dexterity[0] : 0;
  // One tick spacing for every view, like one grid on a drawing.
  const step = niceStep(Math.max(a, b, u), 6);
  for (const placement of placements) {
    drawView(pdf, input, placement.view, placement.rect, placement.x, placement.y, scale, best, step);
  }

  // Reach circle in the plan view: the horizontal reach around the base axis.
  if (horizontalReach > 0) {
    const cx = frontX + (0 - top.hMin) * scale;
    const cy = topY + (top.vMax - 0) * scale;
    pdf.setDrawColor(...INK);
    pdf.setLineWidth(0.5);
    pdf.setLineDashPattern([4, 2], 0);
    pdf.circle(cx, cy, horizontalReach * scale, 'S');
    pdf.setLineDashPattern([], 0);
    const angle = Math.PI / 4;
    const ex = cx + Math.cos(angle) * horizontalReach * scale;
    const ey = cy - Math.sin(angle) * horizontalReach * scale;
    pdf.setLineWidth(0.4);
    pdf.line(cx, cy, ex, ey);
    arrowHead(pdf, cx, cy, ex, ey);
    setText(pdf, 'normal', 7.5, INK);
    pdf.text(`R ${horizontalReach.toFixed(3)}`, ex + 3, ey - 2);
  }

  // Legend and scale bar in the free quadrant under the side view.
  const legendX = sideX;
  const legendY = frontY + u * scale + PAD.bottom + PAD.top;
  const legendW = Math.min(220, PAGE_W - BORDER - 18 - legendX);
  setText(pdf, 'bold', 8.5, INK);
  pdf.text('Dexterity', legendX, legendY);
  setText(pdf, 'normal', 7.5, MUTED);
  const legendNote = pdf.splitTextToSize(
    `Approach directions reached, out of ${DIRECTION_BINS}. Each view shows the best cube along the line of sight.`,
    legendW
  ) as string[];
  pdf.text(legendNote, legendX, legendY + 11);
  const barY = legendY + 13 + legendNote.length * 9;
  const steps = 48;
  for (let i = 0; i < steps; i += 1) {
    pdf.setFillColor(...rgb255(dexterityColor(i / (steps - 1))));
    pdf.rect(legendX + (legendW * i) / steps, barY, legendW / steps + 0.3, 7, 'F');
  }
  setText(pdf, 'normal', 7.5, INK);
  pdf.text('1', legendX, barY + 16);
  pdf.text(`${Math.round(best * DIRECTION_BINS)}`, legendX + legendW, barY + 16, { align: 'right' });
  pdf.setFillColor(...PAPER);
  pdf.setDrawColor(...HAIR);
  pdf.rect(legendX, barY + 24, 10, 7, 'FD');
  setText(pdf, 'normal', 7.5, MUTED);
  pdf.text('not reached', legendX + 14, barY + 30);
  pdf.setFillColor(80, 80, 80);
  pdf.rect(legendX + 80, barY + 24, 10, 7, 'F');
  pdf.text('robot in its current pose', legendX + 94, barY + 30);

  // Scale bar: stays right even if the sheet is printed scaled.
  const barLength = niceStep(Math.max(a, b, u), 4);
  const sbY = barY + 52;
  const sbW = barLength * scale;
  pdf.setDrawColor(...INK);
  pdf.setLineWidth(0.6);
  for (let i = 0; i < 2; i += 1) {
    pdf.setFillColor(...(i === 0 ? INK : ([255, 255, 255] as Rgb)));
    pdf.rect(legendX + (i * sbW) / 2, sbY, sbW / 2, 4, 'FD');
  }
  setText(pdf, 'normal', 7.5, INK);
  pdf.text('0', legendX, sbY + 13, { align: 'center' });
  pdf.text(trimNumber(barLength / 2), legendX + sbW / 2, sbY + 13, { align: 'center' });
  pdf.text(`${trimNumber(barLength)} m`, legendX + sbW, sbY + 13, { align: 'center' });
  setText(pdf, 'normal', 7.5, MUTED);
  pdf.text(`All views at one scale (1 m = ${(scale * 25.4 / 72).toFixed(1)} mm on A4). Dimensions in metres.`, legendX, sbY + 25);
}

function drawView(
  pdf: jsPDF,
  input: ReachReportInput,
  view: ViewSpec,
  rect: ViewRect,
  x: number,
  y: number,
  scale: number,
  best: number,
  step: number
): void {
  const w = (rect.hMax - rect.hMin) * scale;
  const h = (rect.vMax - rect.vMin) * scale;
  const toX = (hValue: number) => x + (hValue - rect.hMin) * scale;
  const toY = (vValue: number) => y + (rect.vMax - vValue) * scale;

  pdf.setFillColor(...PAPER);
  pdf.rect(x, y, w, h, 'F');

  // Dexterity cells. Drawn a hair larger than the cell so neighbours don't
  // show seams in PDF viewers.
  const projection = projectMap(input.map, view);
  const minT = 1 / DIRECTION_BINS;
  const span = Math.max(best - minT, 1e-6);
  const cell = projection.cellSize * scale;
  for (let row = 0; row < projection.rows; row += 1) {
    for (let column = 0; column < projection.columns; column += 1) {
      const value = projection.values[row * projection.columns + column];
      if (value <= 0) {
        continue;
      }
      pdf.setFillColor(...rgb255(dexterityColor(best > minT ? (value - minT) / span : 1)));
      const cellH = projection.hMin + column * projection.cellSize;
      const cellV = projection.vMin + (row + 1) * projection.cellSize;
      pdf.rect(toX(cellH), toY(cellV), cell + 0.25, cell + 0.25, 'F');
    }
  }

  const silhouette = input.silhouettes?.[view.key];
  if (silhouette) {
    try {
      pdf.addImage(silhouette, 'PNG', x, y, w, h, undefined, 'FAST');
    } catch (error) {
      console.warn('[urdf] reach report: could not embed a silhouette', error);
    }
  }

  // Ticks on the left and bottom edges.
  setText(pdf, 'normal', 6.5, MUTED);
  pdf.setDrawColor(...MUTED);
  pdf.setLineWidth(0.4);
  for (let value = Math.ceil(rect.hMin / step) * step; value <= rect.hMax + 1e-9; value += step) {
    const px = toX(value);
    pdf.line(px, y + h, px, y + h + 3);
    pdf.text(trimNumber(value), px, y + h + 10, { align: 'center' });
  }
  for (let value = Math.ceil(rect.vMin / step) * step; value <= rect.vMax + 1e-9; value += step) {
    const py = toY(value);
    pdf.line(x - 3, py, x, py);
    pdf.text(trimNumber(value), x - 5, py + 2.2, { align: 'right' });
  }

  // Centre lines through the base origin (dash-dot, as in a drawing).
  pdf.setDrawColor(...INK);
  pdf.setLineWidth(0.35);
  pdf.setLineDashPattern([9, 2, 1.5, 2], 0);
  if (rect.hMin < 0 && rect.hMax > 0) {
    pdf.line(toX(0), y - 4, toX(0), y + h + 4);
  }
  if (rect.vMin < 0 && rect.vMax > 0) {
    pdf.line(x - 4, toY(0), x + w + 4, toY(0));
  }
  pdf.setLineDashPattern([], 0);

  pdf.setDrawColor(...INK);
  pdf.setLineWidth(0.7);
  pdf.rect(x, y, w, h, 'S');

  // Overall dimensions of the reached region.
  const reachedH: [number, number] = [projection.hMin, projection.hMin + projection.columns * projection.cellSize];
  const reachedV: [number, number] = [projection.vMin, projection.vMin + projection.rows * projection.cellSize];
  if (projection.columns > 0) {
    horizontalDimension(pdf, toX(reachedH[0]), toX(reachedH[1]), y + h, y + h + 26, reachedH[1] - reachedH[0]);
    verticalDimension(pdf, toY(reachedV[1]), toY(reachedV[0]), x, x - 34, reachedV[1] - reachedV[0]);
  }

  // View title and axis names.
  setText(pdf, 'bold', 8.5, INK);
  const title = `${view.title.toUpperCase()} VIEW`;
  pdf.text(title, x, y - 8);
  const titleWidth = pdf.getTextWidth(title);
  setText(pdf, 'normal', 7.5, MUTED);
  pdf.text(`${AXIS_NAMES[view.h]} to the right, ${AXIS_NAMES[view.v]} up`, x + titleWidth + 12, y - 8);
}

function horizontalDimension(pdf: jsPDF, x1: number, x2: number, fromY: number, lineY: number, length: number): void {
  pdf.setDrawColor(...INK);
  pdf.setLineWidth(0.3);
  pdf.line(x1, fromY + 12, x1, lineY + 3);
  pdf.line(x2, fromY + 12, x2, lineY + 3);
  pdf.line(x1, lineY, x2, lineY);
  arrowHead(pdf, x2, lineY, x1, lineY);
  arrowHead(pdf, x1, lineY, x2, lineY);
  const label = length.toFixed(3);
  setText(pdf, 'normal', 7.5, INK);
  const width = pdf.getTextWidth(label);
  pdf.setFillColor(255, 255, 255);
  pdf.rect((x1 + x2) / 2 - width / 2 - 2, lineY - 4.5, width + 4, 8, 'F');
  pdf.text(label, (x1 + x2) / 2, lineY + 2.5, { align: 'center' });
}

function verticalDimension(pdf: jsPDF, y1: number, y2: number, fromX: number, lineX: number, length: number): void {
  pdf.setDrawColor(...INK);
  pdf.setLineWidth(0.3);
  pdf.line(fromX - 22, y1, lineX - 3, y1);
  pdf.line(fromX - 22, y2, lineX - 3, y2);
  pdf.line(lineX, y1, lineX, y2);
  arrowHead(pdf, lineX, y2, lineX, y1);
  arrowHead(pdf, lineX, y1, lineX, y2);
  const label = length.toFixed(3);
  setText(pdf, 'normal', 7.5, INK);
  const width = pdf.getTextWidth(label);
  pdf.setFillColor(255, 255, 255);
  pdf.rect(lineX - 4.5, (y1 + y2) / 2 - width / 2 - 2, 8, width + 4, 'F');
  pdf.text(label, lineX + 2.5, (y1 + y2) / 2 + width / 2, { angle: 90 });
}

/** Filled arrow head at (toX, toY), pointing away from (fromX, fromY). */
function arrowHead(pdf: jsPDF, fromX: number, fromY: number, toX: number, toY: number): void {
  const angle = Math.atan2(toY - fromY, toX - fromX);
  const length = 5;
  const spread = 0.32;
  pdf.setFillColor(...INK);
  pdf.triangle(
    toX, toY,
    toX - length * Math.cos(angle - spread), toY - length * Math.sin(angle - spread),
    toX - length * Math.cos(angle + spread), toY - length * Math.sin(angle + spread),
    'F'
  );
}

// ---------------------------------------------------------------------------
// Sheet furniture
// ---------------------------------------------------------------------------

function sheetFrame(pdf: jsPDF): void {
  pdf.setDrawColor(...INK);
  pdf.setLineWidth(0.9);
  pdf.rect(BORDER, BORDER, PAGE_W - 2 * BORDER, PAGE_H - 2 * BORDER, 'S');
}

function titleBlock(pdf: jsPDF, input: ReachReportInput, generated: Date, sheetTitle: string, sheet: number): void {
  const x = PAGE_W - BORDER - TITLE_W;
  const y = PAGE_H - BORDER - TITLE_H;
  pdf.setFillColor(255, 255, 255);
  pdf.setDrawColor(...INK);
  pdf.setLineWidth(0.7);
  pdf.rect(x, y, TITLE_W, TITLE_H, 'FD');
  pdf.setLineWidth(0.35);
  pdf.line(x, y + 22, x + TITLE_W, y + 22);
  pdf.line(x, y + 44, x + TITLE_W, y + 44);
  pdf.line(x + 170, y + 22, x + 170, y + TITLE_H);

  setText(pdf, 'bold', 9.5, INK);
  pdf.text(fit(pdf, input.robotName, TITLE_W - 70), x + 6, y + 14);
  setText(pdf, 'normal', 7, MUTED);
  pdf.text('REACHABILITY', x + TITLE_W - 6, y + 14, { align: 'right' });

  cell(pdf, x + 6, y + 22, 'Sheet', sheetTitle, 160);
  cell(pdf, x + 176, y + 22, 'Sheet no.', `${sheet} / 2`, 68);
  cell(pdf, x + 6, y + 44, 'Source', fit(pdf, input.sourcePath, 160), 160);
  cell(pdf, x + 176, y + 44, 'Date', generated.toISOString().slice(0, 10), 68);
}

function cell(pdf: jsPDF, x: number, y: number, label: string, value: string, width: number): void {
  setText(pdf, 'normal', 6, MUTED);
  pdf.text(label.toUpperCase(), x, y + 7);
  setText(pdf, 'normal', 8, INK);
  pdf.text(fit(pdf, value, width), x, y + 17);
}

/** Shorten text from the left (keeping the end of a path) to fit a width. */
function fit(pdf: jsPDF, text: string, width: number): string {
  if (pdf.getTextWidth(text) <= width) {
    return text;
  }
  let shortened = text;
  while (shortened.length > 1 && pdf.getTextWidth(`…${shortened}`) > width) {
    shortened = shortened.slice(1);
  }
  return `…${shortened}`;
}

function setText(pdf: jsPDF, style: 'normal' | 'bold', size: number, color: Rgb): void {
  pdf.setFont('helvetica', style);
  pdf.setFontSize(size);
  pdf.setTextColor(...color);
}

function rgb255(color: [number, number, number]): Rgb {
  return [Math.round(color[0] * 255), Math.round(color[1] * 255), Math.round(color[2] * 255)];
}

function trimNumber(value: number): string {
  const rounded = Math.round(value * 1000) / 1000;
  return (Object.is(rounded, -0) ? 0 : rounded).toString();
}

function formatSeconds(ms: number): string {
  return ms < 1000 ? `${Math.max(1, Math.round(ms))} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function formatLength(metres: number): string {
  return metres < 0.1 ? `${(metres * 100).toFixed(1)} cm` : `${metres.toFixed(2)} m`;
}

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

export interface ReachExportHost {
  postMessage(message: unknown): void;
  reportStatus(text: string): void;
}

/** Build the PDF (loading jspdf on first use) and hand it to the host to save. */
export async function saveReachabilityReport(input: ReachReportInput, fileBase: string, host: ReachExportHost): Promise<void> {
  host.reportStatus('Building report…');
  try {
    const { jsPDF } = await import('jspdf');
    const pdf = new jsPDF({ unit: 'pt', format: 'a4', orientation: 'landscape' });
    buildReachabilityPdf(pdf, input);
    const bytes = new Uint8Array(await pdf.output('blob').arrayBuffer());
    host.postMessage({ type: 'requestSaveReport', base64: bytesToBase64(bytes), filename: `${fileBase}-reachability.pdf` });
    host.reportStatus('Report ready.');
  } catch (error) {
    host.reportStatus(`Report failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
