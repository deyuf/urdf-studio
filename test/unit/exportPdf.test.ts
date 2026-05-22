import { strict as assert } from 'node:assert';
import test from 'node:test';
import { buildReportPdf, bytesToBase64, type ExportableDocument } from '../../src/renderer/features/export';
import type { RobotMetadata, StudioDiagnostic } from '../../src/core/types';

// Minimal jsPDF stub: records every call so we can assert on the shape of
// the report without pulling jspdf into the unit-test process (it tries to
// reach the global `window` at import time).
function mockJsPdf() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  let pageCount = 1;
  const record = (method: string) => (...args: unknown[]) => {
    calls.push({ method, args });
    if (method === 'addPage') {
      pageCount++;
    }
  };
  return {
    calls,
    pageCount: () => pageCount,
    pdf: {
      internal: {
        pageSize: { getWidth: () => 595, getHeight: () => 842 }
      },
      setFont: record('setFont'),
      setFontSize: record('setFontSize'),
      text: record('text'),
      addImage: record('addImage'),
      addPage: record('addPage'),
      splitTextToSize: (input: string | string[]) => Array.isArray(input) ? input : [input]
    }
  };
}

function fixtureDoc(overrides: Partial<RobotMetadata> = {}, diagnostics: StudioDiagnostic[] = []): ExportableDocument {
  const metadata: RobotMetadata = {
    robotName: 'fixture',
    counts: { links: 2, joints: 1, movableJoints: 1, visualMeshes: 0, collisionMeshes: 0 },
    links: {
      base: { name: 'base', childJoints: ['joint1'] },
      tip: {
        name: 'tip',
        parentJoint: 'joint1',
        childJoints: [],
        inertial: { mass: 1.25, origin: [0, 0, 0], rotation: [0, 0, 0], ixx: 0.1, ixy: 0, ixz: 0, iyy: 0.2, iyz: 0, izz: 0.3 }
      }
    },
    joints: {
      joint1: { name: 'joint1', type: 'revolute', parent: 'base', child: 'tip', axis: [0, 0, 1], limit: { lower: -1, upper: 1 } }
    },
    meshes: [],
    rootLinks: ['base'],
    movableJointNames: ['joint1'],
    tree: [],
    totalMass: 1.25,
    diagnostics: [],
    ...overrides
  };
  return {
    fileName: 'fixture.urdf',
    sourcePath: '/path/to/fixture.urdf',
    metadata,
    diagnostics
  };
}

// =============================================================================
// buildReportPdf — shape only
// =============================================================================

test('buildReportPdf writes a header, robot summary, and links table', () => {
  const { pdf, calls } = mockJsPdf();
  buildReportPdf(pdf as never, fixtureDoc(), 'data:image/png;base64,iVBORw0KGgo=');

  const texts = calls.filter(c => c.method === 'text').map(c => c.args[0]);
  // Title + section headers
  assert.ok(texts.includes('URDF Studio Report'), `header missing in ${JSON.stringify(texts)}`);
  assert.ok(texts.includes('Counts'));
  assert.ok(texts.includes('Links'));
  // Robot name and source path appear
  assert.ok(texts.some(t => typeof t === 'string' && t.includes('fixture')));
  assert.ok(texts.some(t => typeof t === 'string' && t.includes('/path/to/fixture.urdf')));
  // Summary line includes counts
  assert.ok(texts.some(t => typeof t === 'string' && /\b2 links\b/.test(t)));
});

test('buildReportPdf records "No diagnostics." when the document is clean', () => {
  const { pdf, calls } = mockJsPdf();
  buildReportPdf(pdf as never, fixtureDoc(), 'data:image/png;base64,iVBORw0KGgo=');
  const texts = calls.filter(c => c.method === 'text').map(c => c.args[0]);
  assert.ok(texts.includes('No diagnostics.'));
});

test('buildReportPdf paginates: lists more than the first-page allotment', () => {
  // 80 diagnostics, threshold inside buildReportPdf is 60 → "and 20 more"
  // should appear.
  const diagnostics: StudioDiagnostic[] = Array.from({ length: 80 }, (_, i) => ({
    severity: 'warning' as const,
    message: `warn ${i}`,
    code: 'test.warn'
  }));
  const { pdf, calls } = mockJsPdf();
  buildReportPdf(pdf as never, fixtureDoc({}, diagnostics), 'data:image/png;base64,iVBORw0KGgo=');
  const texts = calls.filter(c => c.method === 'text').map(c => c.args[0]);
  assert.ok(texts.some(t => typeof t === 'string' && /and 20 more/.test(t)),
    `expected "and 20 more" marker, got texts ${JSON.stringify(texts.slice(-5))}`);
});

test('buildReportPdf survives a thrown addImage (tainted canvas case)', () => {
  const stub = mockJsPdf();
  stub.pdf.addImage = (() => { throw new Error('tainted canvas'); }) as never;
  // Must NOT throw; the rest of the report is still expected.
  buildReportPdf(stub.pdf as never, fixtureDoc(), 'data:image/png;base64,iVBORw0KGgo=');
  const texts = stub.calls.filter(c => c.method === 'text').map(c => c.args[0]);
  // Still wrote the title and Links section after the failed image.
  assert.ok(texts.includes('URDF Studio Report'));
  assert.ok(texts.includes('Links'));
});

// =============================================================================
// bytesToBase64
// =============================================================================

test('bytesToBase64 round-trips through atob to the original bytes', () => {
  const original = new Uint8Array([1, 2, 3, 255, 0, 128, 64]);
  const encoded = bytesToBase64(original);
  const decoded = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
  assert.deepEqual(Array.from(decoded), Array.from(original));
});

test('bytesToBase64 handles a buffer larger than its internal chunk size', () => {
  // chunkSize is 0x8000 = 32768. Use a 100k buffer to force three chunks.
  const big = new Uint8Array(100_000);
  for (let i = 0; i < big.length; i++) {
    big[i] = i & 0xff;
  }
  const encoded = bytesToBase64(big);
  const decoded = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
  assert.equal(decoded.length, big.length);
  // Spot-check a few bytes
  assert.equal(decoded[0], big[0]);
  assert.equal(decoded[12345], big[12345]);
  assert.equal(decoded[99999], big[99999]);
});

test('bytesToBase64 returns empty string for empty buffer', () => {
  assert.equal(bytesToBase64(new Uint8Array(0)), '');
});
