// PDF + BOM export.
//
// Extracted from renderer/main.ts so that:
//   1. The heavy jspdf dependency (≈400 kB minified) can be loaded only when
//      the user actually clicks "Export Report (PDF)". With esbuild's web
//      build setting splitting=true, the dynamic import emits a separate
//      chunk that the browser fetches on demand.
//   2. The PDF assembly logic gets a clean dependency surface
//      (RobotMetadata + screenshot + posting hook) and can be unit-tested
//      independently of THREE / WebGL.

import type { jsPDF } from 'jspdf';
import type { RobotMetadata, StudioDiagnostic } from '../../core/types';
import { buildBomCsv } from '../../core/bom';

export interface ExportableDocument {
  fileName: string;
  sourcePath: string;
  metadata: RobotMetadata;
  diagnostics: StudioDiagnostic[];
}

export interface ExportHost {
  /** Forward a host-bound message ("requestSaveBom" / "requestSaveReport"). */
  postMessage(message: unknown): void;
  /** Surface a short status string in the renderer's #export-status slot. */
  reportStatus(text: string): void;
}

export function exportBom(doc: ExportableDocument, host: ExportHost): void {
  const csv = buildBomCsv(doc.metadata);
  host.postMessage({
    type: 'requestSaveBom',
    csv,
    filename: `${baseName(doc.fileName)}-bom.csv`
  });
  host.reportStatus(`BOM ready (${doc.metadata.counts.links} links).`);
}

export interface PdfExportContext {
  /** Snapshot of the current 3D viewport, as a `data:image/png;base64,...` URL. */
  screenshotDataUrl: string;
}

export async function exportPdfReport(
  doc: ExportableDocument,
  ctx: PdfExportContext,
  host: ExportHost
): Promise<void> {
  host.reportStatus('Building PDF…');
  try {
    // Dynamic import: with splitting enabled this becomes a separate chunk
    // that the browser fetches the first time the user invokes export.
    const { jsPDF } = await import('jspdf');
    const pdf = new jsPDF({ unit: 'pt', format: 'a4' });
    buildReportPdf(pdf, doc, ctx.screenshotDataUrl);
    const blob = pdf.output('blob');
    const arrayBuffer = await blob.arrayBuffer();
    const base64 = bytesToBase64(new Uint8Array(arrayBuffer));
    host.postMessage({
      type: 'requestSaveReport',
      base64,
      filename: `${baseName(doc.fileName)}-report.pdf`
    });
    host.reportStatus('PDF ready.');
  } catch (error) {
    host.reportStatus(`PDF failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Exported so unit tests can drive a mock jsPDF through it without going
// through the dynamic import.
export function buildReportPdf(
  pdf: jsPDF,
  doc: ExportableDocument,
  screenshotDataUrl: string
): void {
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const margin = 36;
  let cursorY = margin;

  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(18);
  pdf.text('URDF Studio Report', margin, cursorY);
  cursorY += 22;

  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(10);
  pdf.text(doc.metadata.robotName || doc.fileName, margin, cursorY);
  cursorY += 14;
  pdf.text(`Source: ${doc.sourcePath}`, margin, cursorY);
  cursorY += 12;
  pdf.text(`Generated: ${new Date().toISOString()}`, margin, cursorY);
  cursorY += 18;

  pdf.setFont('helvetica', 'bold');
  pdf.text('Counts', margin, cursorY);
  cursorY += 12;
  pdf.setFont('helvetica', 'normal');
  const counts = doc.metadata.counts;
  const summaryParts = [
    `${counts.links} links`,
    `${counts.joints} joints`,
    `${counts.movableJoints} movable`,
    `${counts.visualMeshes} visual meshes`,
    `${counts.collisionMeshes} collision meshes`,
    `total mass ${doc.metadata.totalMass.toFixed(3)} kg`
  ];
  pdf.text(summaryParts.join(' · '), margin, cursorY);
  cursorY += 18;

  // Screenshot. Wrap in try/catch — some browsers refuse toDataURL on
  // tainted canvases (e.g. when a cross-origin image was rendered into
  // the scene); we want the rest of the report to still come out.
  try {
    const imgWidth = pageWidth - margin * 2;
    const imgHeight = Math.min(360, pageHeight - cursorY - margin - 220);
    pdf.addImage(screenshotDataUrl, 'PNG', margin, cursorY, imgWidth, imgHeight, undefined, 'FAST');
    cursorY += imgHeight + 14;
  } catch (error) {
    console.warn('[urdf] PDF: could not embed screenshot', error);
  }

  // Diagnostics.
  pdf.setFont('helvetica', 'bold');
  pdf.text(`Checks (${doc.diagnostics.length})`, margin, cursorY);
  cursorY += 12;
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(9);
  if (doc.diagnostics.length === 0) {
    pdf.text('No diagnostics.', margin, cursorY);
    cursorY += 12;
  } else {
    for (const diag of doc.diagnostics.slice(0, 60)) {
      if (cursorY > pageHeight - margin) {
        pdf.addPage();
        cursorY = margin;
      }
      const tag = `[${diag.severity.toUpperCase()}${diag.code ? ' ' + diag.code : ''}${diag.line ? ' :' + diag.line : ''}]`;
      const text = `${tag} ${diag.message}`;
      const lines = pdf.splitTextToSize(text, pageWidth - margin * 2);
      pdf.text(lines, margin, cursorY);
      cursorY += lines.length * 11;
    }
    if (doc.diagnostics.length > 60) {
      pdf.text(`… and ${doc.diagnostics.length - 60} more`, margin, cursorY);
      cursorY += 12;
    }
  }
  cursorY += 6;

  // Links table.
  pdf.addPage();
  cursorY = margin;
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(12);
  pdf.text('Links', margin, cursorY);
  cursorY += 16;
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(9);
  const colWidths = [180, 70, 200];
  const headers = ['Link', 'Mass (kg)', 'Parent joint'];
  let x = margin;
  pdf.setFont('helvetica', 'bold');
  for (let i = 0; i < headers.length; i += 1) {
    pdf.text(headers[i], x, cursorY);
    x += colWidths[i];
  }
  cursorY += 12;
  pdf.setFont('helvetica', 'normal');
  const sortedLinks = Object.values(doc.metadata.links).sort((a, b) => a.name.localeCompare(b.name));
  for (const link of sortedLinks) {
    if (cursorY > pageHeight - margin) {
      pdf.addPage();
      cursorY = margin;
    }
    const cells = [
      link.name,
      link.inertial ? link.inertial.mass.toFixed(4) : '—',
      link.parentJoint ?? '—'
    ];
    x = margin;
    for (let i = 0; i < cells.length; i += 1) {
      pdf.text(pdf.splitTextToSize(cells[i], colWidths[i] - 4), x, cursorY);
      x += colWidths[i];
    }
    cursorY += 11;
  }
}

export function bytesToBase64(bytes: Uint8Array): string {
  // Chunked btoa to avoid stack overflows on big buffers — String.fromCharCode
  // is variadic and node's argument limit is ~2^16 on most platforms.
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunkSize)) as number[]);
  }
  return btoa(binary);
}

function baseName(fileName: string): string {
  return fileName.replace(/\.[^./\\]+$/, '') || 'robot';
}
