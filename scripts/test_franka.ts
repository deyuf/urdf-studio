/**
 * End-to-end test harness: try to render + analyze every xacro/urdf.xacro
 * file in ~/franka_description and report any errors/warnings.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { discoverPackages } from '../src/core/packageMap';
import { renderRobotDocument, setLogger } from '../src/core/xacro';
import { analyzeUrdf } from '../src/core/urdfAnalysis';
import type { StudioDiagnostic } from '../src/core/types';

const FRANKA_ROOT = path.resolve(process.env.HOME ?? '', 'franka_description');

const URDF_XACROS = [
  'end_effectors/cobot_pump/cobot_pump.urdf.xacro',
  'end_effectors/franka_hand/franka_hand.urdf.xacro',
  'robots/fer/fer.urdf.xacro',
  'robots/fr3/fr3.urdf.xacro',
  'robots/fr3v2/fr3v2.urdf.xacro',
  'robots/fr3v2_1/fr3v2_1.urdf.xacro',
  'robots/fp3/fp3.urdf.xacro',
  'robots/fr3_duo/fr3_duo.urdf.xacro',
  'robots/tmrv0_2/tmrv0_2.urdf.xacro',
  'robots/mobile_fr3_duo_v0_2/mobile_fr3_duo_v0_2.urdf.xacro',
  // SRDF xacros also opened in the editor; should expand without errors even
  // though the analyzer will see only group/disable_collisions content.
  'end_effectors/franka_hand/franka_hand.srdf.xacro',
  'robots/fer/fer.srdf.xacro',
  'robots/fr3/fr3.srdf.xacro',
  'robots/fr3v2/fr3v2.srdf.xacro',
  'robots/fr3v2_1/fr3v2_1.srdf.xacro',
  'robots/fp3/fp3.srdf.xacro',
  'robots/fr3_duo/fr3_duo.srdf.xacro',
  'robots/mobile_fr3_duo_v0_2/mobile_fr3_duo_v0_2.srdf.xacro'
];

interface Result {
  file: string;
  ok: boolean;
  renderErrors: StudioDiagnostic[];
  renderWarnings: StudioDiagnostic[];
  analyzeErrors: StudioDiagnostic[];
  analyzeWarnings: StudioDiagnostic[];
  links: number;
  joints: number;
  meshes: number;
  fatal?: string;
}

function fmtDiag(diag: StudioDiagnostic): string {
  return `[${diag.severity}] ${diag.code ?? ''} ${diag.message}`;
}

async function run(): Promise<void> {
  setLogger(message => console.log(`  log: ${message}`));

  if (!existsSync(FRANKA_ROOT)) {
    console.error(`franka_description not found at ${FRANKA_ROOT}`);
    process.exit(2);
  }

  console.log(`Scanning packages under ${FRANKA_ROOT}`);
  const packages = await discoverPackages([FRANKA_ROOT]);
  console.log(`Discovered packages: ${Object.keys(packages).join(', ') || '(none)'}`);

  const results: Result[] = [];

  for (const relative of URDF_XACROS) {
    const sourcePath = path.join(FRANKA_ROOT, relative);
    if (!existsSync(sourcePath)) {
      console.warn(`Skipping missing file: ${sourcePath}`);
      continue;
    }
    console.log(`\n=== ${relative} ===`);
    const result: Result = {
      file: relative,
      ok: false,
      renderErrors: [],
      renderWarnings: [],
      analyzeErrors: [],
      analyzeWarnings: [],
      links: 0,
      joints: 0,
      meshes: 0
    };
    try {
      const rendered = await renderRobotDocument(sourcePath, packages, {});
      result.renderErrors = rendered.diagnostics.filter(d => d.severity === 'error');
      result.renderWarnings = rendered.diagnostics.filter(d => d.severity === 'warning');
      const meta = analyzeUrdf(rendered.urdf, sourcePath, packages);
      result.analyzeErrors = meta.diagnostics.filter(d => d.severity === 'error');
      result.analyzeWarnings = meta.diagnostics.filter(d => d.severity === 'warning');
      result.links = meta.counts.links;
      result.joints = meta.counts.joints;
      result.meshes = meta.counts.visualMeshes + meta.counts.collisionMeshes;
      result.ok = result.renderErrors.length === 0 && result.analyzeErrors.length === 0;
      console.log(
        `  links=${result.links} joints=${result.joints} meshes=${result.meshes} ` +
          `renderErr=${result.renderErrors.length} renderWarn=${result.renderWarnings.length} ` +
          `analyzeErr=${result.analyzeErrors.length} analyzeWarn=${result.analyzeWarnings.length}`
      );
      const all = [
        ...result.renderErrors,
        ...result.renderWarnings,
        ...result.analyzeErrors,
        ...result.analyzeWarnings
      ];
      for (const d of all.slice(0, 30)) {
        console.log(`  ${fmtDiag(d)}`);
      }
      if (all.length > 30) {
        console.log(`  ... (${all.length - 30} more diagnostics)`);
      }
    } catch (error) {
      result.fatal = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
      console.error(`  FATAL: ${result.fatal}`);
    }
    results.push(result);
  }

  console.log('\n================= SUMMARY =================');
  for (const r of results) {
    const status = r.fatal ? 'FATAL' : r.ok ? 'OK' : 'ISSUES';
    console.log(
      `${status.padEnd(6)} ${r.file.padEnd(70)} ` +
        `L${r.links} J${r.joints} M${r.meshes} ` +
        `rE${r.renderErrors.length}/rW${r.renderWarnings.length} ` +
        `aE${r.analyzeErrors.length}/aW${r.analyzeWarnings.length}` +
        (r.fatal ? ` :: ${r.fatal.split('\n')[0]}` : '')
    );
  }

  const anyFail = results.some(r => r.fatal || !r.ok);
  process.exit(anyFail ? 1 : 0);
}

run().catch(err => {
  console.error(err);
  process.exit(2);
});
