import * as THREE from 'three';
import { LoadingManager, Object3D } from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { ColladaLoader } from 'three/examples/jsm/loaders/ColladaLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import URDFLoader from 'urdf-loader';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree, MeshBVH } from 'three-mesh-bvh';
import type {
  CameraSnapshot,
  DisableCollisionEntry,
  JointInfo,
  LinkTreeNode,
  MimicInfo,
  PoseBookmark,
  PreviewState,
  RobotMetadata,
  SemanticMetadata,
  StudioDiagnostic,
  XacroArgument
} from '../core/types';
import { ellipsoidSemiAxes } from '../core/inertia';
import { buildMimicGraph, propagateMimicValue, type MimicGraph } from '../core/mimic';
import { buildBomCsv } from '../core/bom';
import { LabelsOverlay, type LabelsMode } from './labels';

(THREE.Mesh.prototype as unknown as { raycast: typeof acceleratedRaycast }).raycast = acceleratedRaycast;
(THREE.BufferGeometry.prototype as unknown as { computeBoundsTree: typeof computeBoundsTree }).computeBoundsTree = computeBoundsTree;
(THREE.BufferGeometry.prototype as unknown as { disposeBoundsTree: typeof disposeBoundsTree }).disposeBoundsTree = disposeBoundsTree;

type RenderMode = 'visual' | 'collision' | 'both';
type FramesMode = 'off' | 'selected' | 'all';

interface LoadRobotMessage {
  type: 'loadRobot';
  fileName: string;
  sourcePath: string;
  sourceBaseUri: string;
  format: 'urdf' | 'xacro';
  urdf: string;
  packageMap: Record<string, string>;
  metadata: RobotMetadata;
  semantic: SemanticMetadata;
  diagnostics: StudioDiagnostic[];
  xacroArgs: XacroArgument[];
  xacroArgValues: Record<string, unknown>;
  renderSettings: { renderMode: RenderMode; upAxis: '+X' | '+Y' | '+Z' };
  savedState?: PreviewState;
  bookmarks?: PoseBookmark[];
}

interface VsCodeApi {
  postMessage(message: unknown): void;
  setState(state: unknown): void;
  getState(): unknown;
}

const apiHost = globalThis as unknown as { acquireVsCodeApi?: () => VsCodeApi };
const vscode: VsCodeApi = typeof apiHost.acquireVsCodeApi === 'function'
  ? apiHost.acquireVsCodeApi()
  : { postMessage: () => undefined, setState: () => undefined, getState: () => undefined };

const meshCache = new Map<string, Promise<Object3D | null>>();
let scene: THREE.Scene;
let camera: THREE.PerspectiveCamera;
let renderer: THREE.WebGLRenderer;
let controls: OrbitControls;
let grid: THREE.GridHelper;
let axes: THREE.AxesHelper;
let robot: any;
let currentData: LoadRobotMessage | undefined;
let renderMode: RenderMode = 'visual';
let collisionGeometryLoaded = false;
let selectedLink: string | undefined;
let selectedBox: THREE.BoxHelper | undefined;
let linkNames = new Set<string>();
let dirty = true;
let hasRenderedOnce = false;
let robotReady = false;
let currentViewportWidth = 0;
let currentViewportHeight = 0;
let mimicGraph: MimicGraph = { followers: new Map() };
let bookmarks: PoseBookmark[] = [];
let robotBoundsRadius = 0.5;

let framesMode: FramesMode = 'off';
const linkAxesHelpers = new Map<string, THREE.AxesHelper>();
let labelsOverlay: LabelsOverlay | undefined;
let labelsMode: LabelsMode = 'off';
let measureMode = false;
const measurePoints: THREE.Vector3[] = [];
let measureLine: THREE.Line | undefined;
const measureMarkers: THREE.Mesh[] = [];
let inertiaVisible = false;
const inertiaHelpers = new Map<string, THREE.Group>();
let totalCoMMarker: THREE.Mesh | undefined;
let selfCollisionEnabled = false;
let selfCollisionPending = false;
const collisionMeshGeometry = new Map<string, { mesh: THREE.Mesh; ownerLink: string }>();
const linkCollisionMaterials = new Map<string, THREE.MeshStandardMaterial[]>();
const linkVisualMaterials = new Map<string, THREE.MeshStandardMaterial[]>();
const originalVisualColors = new Map<THREE.MeshStandardMaterial, THREE.Color>();
const highlightedCollisionLinks = new Set<string>();

let reachabilityPoints: THREE.Points | undefined;

document.getElementById('app')!.innerHTML = `
<div class="shell">
  <div class="toolbar">
    <div id="title" class="title">URDF Studio</div>
    <div class="toolbar-group">
      <button id="fit">Fit</button>
      <button data-view="front">Front</button>
      <button data-view="right">Right</button>
      <button data-view="top">Top</button>
      <button data-view="iso">Iso</button>
    </div>
    <div class="toolbar-group">
      <select id="render-mode" title="Geometry layer">
        <option value="visual">Visual</option>
        <option value="collision">Collision</option>
        <option value="both">Both</option>
      </select>
      <label><input id="wireframe" type="checkbox"> Wire</label>
      <label><input id="grid" type="checkbox" checked> Grid</label>
      <label><input id="axes" type="checkbox" checked> Axes</label>
    </div>
    <div class="toolbar-group toolbar-group-end">
      <label><input id="ignore-limits" type="checkbox"> Ignore limits</label>
      <select id="bookmark-select" title="Apply a saved bookmark"><option value="">Bookmarks</option></select>
      <button id="bookmark-save" title="Save current pose as a named bookmark">Save As</button>
      <button id="save-pose" class="primary">Save Pose</button>
    </div>
  </div>
  <div class="subtoolbar">
    <label>
      <select id="frames-mode" title="Per-link TF axes">
        <option value="off">Frames: off</option>
        <option value="selected">Frames: selected</option>
        <option value="all">Frames: all</option>
      </select>
    </label>
    <label title="Show inertia ellipsoids and centers of mass"><input id="inertia-toggle" type="checkbox"> Inertia</label>
    <label>
      <select id="labels-mode" title="3D labels for joints and links">
        <option value="off">Labels: off</option>
        <option value="joints">Labels: joints</option>
        <option value="links">Labels: links</option>
        <option value="both">Labels: both</option>
      </select>
    </label>
  </div>
  <div class="workspace">
    <div class="viewport-wrap">
      <canvas id="viewport"></canvas>
      <div id="hud" class="hud">Waiting for robot...</div>
    </div>
    <aside class="side">
      <div class="tabs">
        <button class="tab active" data-tab="joints">Joints</button>
        <button class="tab" data-tab="inspector">Inspector</button>
        <button class="tab" data-tab="checks">Checks</button>
        <button class="tab" data-tab="links">Links</button>
        <button class="tab" data-tab="source">Source</button>
        <button class="tab" data-tab="tools">Tools</button>
      </div>
      <section id="panel-joints" class="panel active"></section>
      <section id="panel-inspector" class="panel"></section>
      <section id="panel-checks" class="panel"></section>
      <section id="panel-links" class="panel tree"></section>
      <section id="panel-source" class="panel"></section>
      <section id="panel-tools" class="panel"></section>
    </aside>
  </div>
</div>`;

initThree();
bindChrome();
vscode.postMessage({ type: 'ready' });

window.addEventListener('message', event => {
  const message = event.data;
  if (!message?.type) {
    return;
  }
  if (message.type === 'loadRobot') {
    void loadRobot(message as LoadRobotMessage);
  } else if (message.type === 'recenter') {
    fitCamera('iso');
  } else if (message.type === 'exportPose') {
    vscode.postMessage({ type: 'exportPoseResult', pose: getPose(), camera: getCameraSnapshot() });
  } else if (message.type === 'captureScreenshot') {
    renderNow();
    vscode.postMessage({ type: 'screenshotResult', dataUrl: renderer.domElement.toDataURL('image/png') });
  } else if (message.type === 'sampleReachability') {
    void sampleReachability();
  } else if (message.type === 'requestPoseSnapshot') {
    vscode.postMessage({ type: 'poseSnapshot', pose: getPose(), camera: getCameraSnapshot() });
  } else if (message.type === 'bookmarksUpdated') {
    bookmarks = message.bookmarks ?? [];
    renderBookmarkSelect();
  } else if (message.type === 'disableCollisionsUpdated') {
    if (currentData) {
      currentData.semantic.disableCollisions = message.disableCollisions ?? [];
    }
  }
});

function initThree(): void {
  const canvas = qs<HTMLCanvasElement>('#viewport');
  canvas.style.opacity = '0';
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x181818);

  camera = new THREE.PerspectiveCamera(45, 1, 0.001, 1000);
  camera.up.set(0, 0, 1);
  camera.position.set(3, -5, 2.4);

  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.addEventListener('change', () => { dirty = true; });

  scene.add(new THREE.HemisphereLight(0xffffff, 0x333333, 1.1));
  const key = new THREE.DirectionalLight(0xffffff, 1.2);
  key.position.set(3, -4, 6);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xbad7ff, 0.45);
  fill.position.set(-4, 3, 2);
  scene.add(fill);

  grid = new THREE.GridHelper(5, 20, 0x5c5c5c, 0x333333);
  grid.rotation.x = Math.PI / 2;
  scene.add(grid);
  axes = new THREE.AxesHelper(0.75);
  scene.add(axes);

  labelsOverlay = new LabelsOverlay(canvas.parentElement!);

  observeViewportSize();
  window.addEventListener('resize', resize);
  canvas.addEventListener('click', event => onCanvasClick(event));

  // VS Code's webview preload forwards bubble-phase wheel events to scroll the
  // outer host panel.  The capture listener cancels the browser default; the
  // bubble listener stops propagation only AFTER OrbitControls has consumed
  // the event on the canvas.
  const viewportWrap = canvas.parentElement!;
  viewportWrap.addEventListener('wheel', event => {
    event.preventDefault();
    dirty = true;
  }, { passive: false, capture: true });
  viewportWrap.addEventListener('wheel', event => {
    event.stopPropagation();
  }, { passive: true });

  resize();
  animate();
}

function bindChrome(): void {
  qs('#fit').addEventListener('click', () => fitCamera('iso'));
  qsa<HTMLButtonElement>('[data-view]').forEach(button => button.addEventListener('click', () => fitCamera(button.dataset.view as CameraView)));
  qs<HTMLSelectElement>('#render-mode').addEventListener('change', event => {
    renderMode = (event.target as HTMLSelectElement).value as RenderMode;
    if ((renderMode === 'collision' || renderMode === 'both') && !collisionGeometryLoaded && currentData) {
      void reloadWithCollisionGeometry();
      return;
    }
    applyRenderMode();
  });
  qs<HTMLInputElement>('#wireframe').addEventListener('change', event => {
    const enabled = (event.target as HTMLInputElement).checked;
    scene.traverse(object => {
      const mesh = object as THREE.Mesh;
      if (mesh.isMesh) {
        forEachMaterial(mesh, material => { material.wireframe = enabled; });
      }
    });
    dirty = true;
  });
  qs<HTMLInputElement>('#grid').addEventListener('change', event => {
    grid.visible = (event.target as HTMLInputElement).checked;
    dirty = true;
  });
  qs<HTMLInputElement>('#axes').addEventListener('change', event => {
    axes.visible = (event.target as HTMLInputElement).checked;
    dirty = true;
  });
  qs<HTMLInputElement>('#ignore-limits').addEventListener('change', event => {
    const enabled = (event.target as HTMLInputElement).checked;
    if (robot?.joints) {
      for (const jointName of currentData?.metadata.movableJointNames ?? []) {
        if (robot.joints[jointName]) {
          robot.joints[jointName].ignoreLimits = enabled;
        }
      }
    }
  });
  qs<HTMLSelectElement>('#frames-mode').addEventListener('change', event => {
    framesMode = (event.target as HTMLSelectElement).value as FramesMode;
    applyFramesMode();
  });
  qs<HTMLInputElement>('#inertia-toggle').addEventListener('change', event => {
    inertiaVisible = (event.target as HTMLInputElement).checked;
    applyInertiaVisibility();
    publishTestState();
  });
  qs<HTMLSelectElement>('#labels-mode').addEventListener('change', event => {
    labelsMode = (event.target as HTMLSelectElement).value as LabelsMode;
    labelsOverlay?.setMode(labelsMode);
    dirty = true;
  });
  qs('#save-pose').addEventListener('click', () => {
    vscode.postMessage({ type: 'requestSavePose', pose: getPose(), camera: getCameraSnapshot() });
  });
  qs('#bookmark-save').addEventListener('click', () => {
    const name = window.prompt('Bookmark name?');
    if (!name) {
      return;
    }
    vscode.postMessage({ type: 'requestSaveBookmark', name, pose: getPose(), camera: getCameraSnapshot() });
  });
  qs<HTMLSelectElement>('#bookmark-select').addEventListener('change', event => {
    const target = event.target as HTMLSelectElement;
    const name = target.value;
    if (!name) {
      return;
    }
    const bookmark = bookmarks.find(item => item.name === name);
    if (bookmark) {
      applyPose(bookmark.pose);
      if (bookmark.camera) {
        applyCameraSnapshot(bookmark.camera);
      }
    }
    target.value = '';
  });
  qsa<HTMLButtonElement>('.tab').forEach(tab => tab.addEventListener('click', () => switchTab(tab.dataset.tab!)));
}

async function loadRobot(data: LoadRobotMessage, forceCollisionGeometry = false): Promise<void> {
  currentData = data;
  bookmarks = data.bookmarks ?? [];
  renderMode = data.renderSettings.renderMode;
  qs<HTMLSelectElement>('#render-mode').value = renderMode;
  qs('#title').textContent = data.fileName;
  setStatus('Parsing robot...');
  selectedLink = undefined;
  linkNames = new Set(Object.keys(data.metadata.links));
  mimicGraph = buildMimicGraph(data.metadata.joints);

  clearSelfCollisionHighlights();
  collisionMeshGeometry.clear();
  linkCollisionMaterials.clear();
  linkVisualMaterials.clear();
  originalVisualColors.clear();
  disposeInertiaHelpers();
  disposeFrameHelpers();
  disposeReachability();
  clearMeasurement();
  labelsOverlay?.clear();

  if (robot) {
    scene.remove(robot);
    robot.traverse((object: Object3D) => disposeObject(object));
    robot = undefined;
  }
  if (selectedBox) {
    scene.remove(selectedBox);
    selectedBox = undefined;
  }

  applyUpAxis(data.renderSettings.upAxis);
  renderSummary(data);
  renderXacroArgs(data);
  renderChecks(data);
  renderLinks(data.metadata.tree);
  renderSource(data);
  renderInspector();
  renderToolsPanel();
  renderBookmarkSelect();

  const shouldLoadCollision = forceCollisionGeometry || renderMode === 'collision' || renderMode === 'both';
  const hasExternalMeshesToLoad = data.metadata.meshes.some(mesh => mesh.exists && (mesh.kind === 'visual' || shouldLoadCollision));
  let lastProgressUpdate = 0;
  let revealed = false;
  const revealRobot = () => {
    if (revealed) {
      return;
    }
    revealed = true;
    if (robot) {
      robot.visible = true;
      computeRobotBoundsRadius();
      buildInertiaHelpers();
      applyFramesMode();
      buildCollisionGeometryIndex();
      buildVisualMaterialIndex();
      buildLabels();
    }
    robotReady = true;
    renderer.domElement.style.opacity = '1';
    setStatus(`${data.metadata.robotName}: ${data.metadata.counts.links} links, ${data.metadata.counts.movableJoints} movable joints`);
    fitCamera(data.savedState?.camera ? undefined : 'iso');
    if (data.savedState?.camera) {
      applyCameraSnapshot(data.savedState.camera);
    }
    vscode.postMessage({
      type: 'geometryLoaded',
      linkCount: data.metadata.counts.links,
      jointCount: data.metadata.counts.joints,
      movableJointCount: data.metadata.counts.movableJoints
    });
  };

  const manager = new LoadingManager();
  manager.onProgress = (_url: string, loaded: number, total: number) => {
    const now = performance.now();
    if (now - lastProgressUpdate > 120 || loaded === total) {
      lastProgressUpdate = now;
      setStatus(`Loading meshes ${loaded}/${total}...`);
    }
  };
  manager.onError = (url: string) => setStatus(`Mesh failed: ${url}`);
  manager.onLoad = revealRobot;

  // Host-supplied URL rewriter (used by the web build to resolve
  // urdf-studio-vfs:// URLs to blob: URLs). VS Code build leaves it unset.
  const vfsUrlMap = (data as LoadRobotMessage & { vfsUrlMap?: Record<string, string>; vfsUrlScheme?: string }).vfsUrlMap;
  const vfsScheme = (data as LoadRobotMessage & { vfsUrlScheme?: string }).vfsUrlScheme;
  if (vfsUrlMap && vfsScheme) {
    manager.setURLModifier(url => {
      if (typeof url !== 'string' || !url.startsWith(vfsScheme)) {
        return url;
      }
      const mapped = vfsUrlMap[url];
      if (mapped) {
        return mapped;
      }
      // Try normalizing collapsed `..` segments (`/a/b/../c` → `/a/c`).
      const normalized = normalizeVfsUrl(url, vfsScheme);
      if (normalized !== url && vfsUrlMap[normalized]) {
        return vfsUrlMap[normalized];
      }
      console.warn('[urdf] unmapped VFS url', url);
      return url;
    });
  }

  const loader = new URDFLoader(manager);
  loader.packages = data.packageMap;
  loader.workingPath = data.sourceBaseUri;
  loader.parseVisual = true;
  loader.parseCollision = shouldLoadCollision;
  loader.loadMeshCb = loadMeshWithCache;

  try {
    robot = loader.parse(data.urdf);
    robot.visible = !hasExternalMeshesToLoad;
    collisionGeometryLoaded = shouldLoadCollision;
    scene.add(robot);
    robot.traverse((object: Object3D) => {
      object.matrixAutoUpdate = true;
      const mesh = object as THREE.Mesh;
      if (mesh.isMesh) {
        forEachMaterial(mesh, material => {
          material.side = THREE.DoubleSide;
          material.needsUpdate = true;
        });
      }
    });
    applyRenderMode();
    // Mimic joints are driven by the master joint; the URDF loader's own
    // limits (which may default to [0, 0] when <limit> is missing) would
    // otherwise clamp the propagated value to a useless number.
    for (const [name, info] of Object.entries(data.metadata.joints)) {
      if (info.mimic && robot.joints?.[name]) {
        robot.joints[name].ignoreLimits = true;
      }
    }
    renderJointPanel(data);
    if (data.savedState?.pose) {
      applyPose(data.savedState.pose);
    }
    if (!hasExternalMeshesToLoad) {
      revealRobot();
    }
    dirty = true;
  } catch (error) {
    setStatus(`Could not parse URDF: ${String(error)}`);
  }
}

async function reloadWithCollisionGeometry(): Promise<void> {
  if (!currentData) {
    return;
  }
  setStatus('Loading collision geometry...');
  const nextData: LoadRobotMessage = {
    ...currentData,
    renderSettings: {
      ...currentData.renderSettings,
      renderMode
    },
    savedState: {
      pose: getPose(),
      camera: getCameraSnapshot()
    }
  };
  await loadRobot(nextData, true);
}

function loadMeshWithCache(pathToModel: string, manager: LoadingManager, onComplete: (object: Object3D, error?: Error) => void): void {
  const key = pathToModel;
  if (!meshCache.has(key)) {
    meshCache.set(key, loadMesh(pathToModel, manager));
  }
  void meshCache.get(key)!.then(object => {
    onComplete(object ? cloneObject(object) : new Object3D());
  }).catch(error => {
    onComplete(new Object3D(), error instanceof Error ? error : new Error(String(error)));
  });
}

function loadMesh(pathToModel: string, manager: LoadingManager): Promise<Object3D | null> {
  const lower = pathToModel.toLowerCase();
  if (lower.endsWith('.stl')) {
    return new Promise((resolve, reject) => {
      new STLLoader(manager).load(pathToModel, (geometry: THREE.BufferGeometry) => {
        geometry.computeVertexNormals();
        const material = new THREE.MeshStandardMaterial({ color: 0xc7c9cc, roughness: 0.78, metalness: 0.05 });
        resolve(new THREE.Mesh(geometry, material));
      }, undefined, reject);
    });
  }
  if (lower.endsWith('.dae')) {
    return new Promise((resolve, reject) => new ColladaLoader(manager).load(pathToModel, result => resolve(result?.scene ?? null), undefined, reject));
  }
  if (lower.endsWith('.obj')) {
    return new Promise((resolve, reject) => new OBJLoader(manager).load(pathToModel, resolve, undefined, reject));
  }
  if (lower.endsWith('.gltf') || lower.endsWith('.glb')) {
    return new Promise((resolve, reject) => new GLTFLoader(manager).load(pathToModel, (result: { scene: Object3D }) => resolve(result.scene), undefined, reject));
  }
  return Promise.resolve(null);
}

function cloneObject(object: Object3D): Object3D {
  const clone = object.clone(true);
  clone.traverse((child: Object3D) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh) {
      if (Array.isArray(mesh.material)) {
        mesh.material = mesh.material.map((material: THREE.Material) => material.clone());
      } else {
        mesh.material = mesh.material.clone();
      }
    }
  });
  return clone;
}

function renderSummary(data: LoadRobotMessage): void {
  const panel = qs('#panel-joints');
  panel.innerHTML = `
    <div class="summary">
      <div class="metric"><b>${data.metadata.counts.links}</b><span>Links</span></div>
      <div class="metric"><b>${data.metadata.counts.joints}</b><span>Joints</span></div>
      <div class="metric"><b>${data.metadata.counts.movableJoints}</b><span>Movable</span></div>
    </div>
    <div id="xacro-args-host"></div>
    <div class="joint-filter">
      <input id="joint-search" type="search" placeholder="Search joints">
      <label><input id="joint-modified-only" type="checkbox"> Only modified</label>
    </div>
    <div id="joint-groups"></div>
  `;
  qs<HTMLInputElement>('#joint-search').addEventListener('input', () => applyJointFilter());
  qs<HTMLInputElement>('#joint-modified-only').addEventListener('change', () => applyJointFilter());
}

function renderXacroArgs(data: LoadRobotMessage): void {
  const host = qs('#xacro-args-host');
  if (data.format !== 'xacro' || data.xacroArgs.length === 0) {
    host.innerHTML = '';
    return;
  }
  host.innerHTML = `
    <div class="xacro-args">
      ${data.xacroArgs.map(arg => `
        <label>
          <span>${escapeHtml(arg.name)}</span>
          <input type="text" data-xacro-arg="${escapeHtml(arg.name)}" value="${escapeHtml(String(data.xacroArgValues[arg.name] ?? arg.defaultValue ?? ''))}">
        </label>
      `).join('')}
      <button id="apply-xacro" class="primary">Reload xacro</button>
    </div>
  `;
  qs('#apply-xacro').addEventListener('click', () => {
    const args: Record<string, string> = {};
    qsa<HTMLInputElement>('[data-xacro-arg]').forEach(input => {
      args[input.dataset.xacroArg!] = input.value;
    });
    vscode.postMessage({ type: 'reloadWithXacroArgs', args });
  });
}

function renderJointPanel(data: LoadRobotMessage): void {
  const host = qs('#joint-groups');
  const groups = buildDisplayGroups(data);
  host.innerHTML = groups.map(group => `
    <details open data-group="${escapeHtml(group.name)}">
      <summary>${escapeHtml(group.name)} (${group.joints.length})</summary>
      <div class="detail-body">
        <div class="state-buttons">
          ${data.semantic.states
            .filter(state => state.group === group.name || (group.name === 'all' && Object.keys(state.joints).length > 0))
            .map(state => `<button data-state="${escapeHtml(state.group)}:${escapeHtml(state.name)}">${escapeHtml(state.name)}</button>`)
            .join('')}
        </div>
        ${group.joints.map(jointName => renderJointRow(jointName, data.metadata.joints[jointName])).join('')}
      </div>
    </details>
  `).join('');

  qsa<HTMLInputElement>('[data-joint-slider]').forEach(slider => {
    slider.addEventListener('input', () => setJointValue(slider.dataset.jointSlider!, Number(slider.value), true));
  });
  qsa<HTMLInputElement>('[data-joint-number]').forEach(input => {
    input.addEventListener('change', () => setJointValue(input.dataset.jointNumber!, Number(input.value), true));
  });
  qsa<HTMLButtonElement>('[data-state]').forEach(button => {
    button.addEventListener('click', () => {
      const [group, name] = button.dataset.state!.split(':');
      const state = currentData?.semantic.states.find(item => item.group === group && item.name === name);
      if (state) {
        applyPose(state.joints);
      }
    });
  });
  applyJointFilter();
}

function buildDisplayGroups(data: LoadRobotMessage): Array<{ name: string; joints: string[] }> {
  const movable = new Set(data.metadata.movableJointNames);
  const semanticGroups = data.semantic.groups
    .map(group => ({ name: group.name, joints: group.joints.filter(joint => movable.has(joint)) }))
    .filter(group => group.joints.length > 0);
  if (semanticGroups.length > 0) {
    return semanticGroups;
  }

  const grouped = new Map<string, string[]>();
  for (const joint of data.metadata.movableJointNames) {
    const prefix = joint.includes('_') ? joint.split('_')[0] : 'all';
    if (!grouped.has(prefix)) {
      grouped.set(prefix, []);
    }
    grouped.get(prefix)!.push(joint);
  }
  return Array.from(grouped.entries()).map(([name, joints]) => ({ name, joints }));
}

function renderJointRow(jointName: string, joint: JointInfo | undefined): string {
  const value = Number(robot?.joints?.[jointName]?.angle ?? 0);
  const [min, max] = jointRange(joint);
  return `
    <div class="joint-row" data-joint-row="${escapeHtml(jointName)}">
      <span class="joint-name" title="${escapeHtml(jointName)}">${escapeHtml(jointName)}</span>
      <input data-joint-slider="${escapeHtml(jointName)}" type="range" min="${min}" max="${max}" step="0.001" value="${value}">
      <input data-joint-number="${escapeHtml(jointName)}" type="number" min="${min}" max="${max}" step="0.001" value="${value.toFixed(3)}">
    </div>
  `;
}

function applyJointFilter(): void {
  const searchInput = document.getElementById('joint-search') as HTMLInputElement | null;
  const modifiedOnlyInput = document.getElementById('joint-modified-only') as HTMLInputElement | null;
  if (!searchInput) {
    return;
  }
  const term = searchInput.value.trim().toLowerCase();
  const modifiedOnly = !!modifiedOnlyInput?.checked;
  qsa<HTMLDivElement>('[data-joint-row]').forEach(row => {
    const name = row.dataset.jointRow ?? '';
    const matchesTerm = !term || name.toLowerCase().includes(term);
    let matchesModified = true;
    if (modifiedOnly) {
      const value = Number(robot?.joints?.[name]?.angle ?? 0);
      matchesModified = Math.abs(value) > 1e-6;
    }
    row.style.display = matchesTerm && matchesModified ? '' : 'none';
  });
  qsa<HTMLDetailsElement>('[data-group]').forEach(details => {
    const visibleRows = Array.from(details.querySelectorAll<HTMLDivElement>('[data-joint-row]'))
      .some(row => row.style.display !== 'none');
    details.style.display = visibleRows ? '' : 'none';
  });
}

function jointRange(joint: JointInfo | undefined): [number, number] {
  if (!joint || joint.type === 'continuous') {
    return [-Math.PI, Math.PI];
  }
  if (joint.limit.lower !== undefined && joint.limit.upper !== undefined) {
    return [joint.limit.lower, joint.limit.upper];
  }
  return joint.type === 'prismatic' ? [-1, 1] : [-Math.PI, Math.PI];
}

function setJointValue(jointName: string, value: number, notify: boolean): void {
  if (!robot?.joints?.[jointName] || !Number.isFinite(value)) {
    return;
  }
  robot.setJointValue(jointName, value);
  syncJointInputs(jointName, value);

  const followers = propagateMimicValue(mimicGraph, jointName, value);
  for (const follower of followers) {
    if (robot.joints?.[follower.joint]) {
      robot.setJointValue(follower.joint, follower.value);
      syncJointInputs(follower.joint, follower.value);
    }
  }

  if (selectedBox) {
    selectedBox.update();
  }
  if (inertiaVisible) {
    updateTotalCoMMarker();
  }
  dirty = true;
  if (notify) {
    vscode.postMessage({ type: 'jointChanged', joint: jointName, value });
  }
  if (selfCollisionEnabled) {
    void scheduleSelfCollisionCheck();
  }
  publishTestState();
}

function syncJointInputs(jointName: string, value: number): void {
  qsa<HTMLInputElement>(`[data-joint-slider="${cssEscape(jointName)}"], [data-joint-number="${cssEscape(jointName)}"]`).forEach(input => {
    input.value = input.type === 'number' ? value.toFixed(3) : String(value);
  });
}

function applyPose(pose: Record<string, number>): void {
  for (const [joint, value] of Object.entries(pose)) {
    setJointValue(joint, Number(value), false);
  }
  dirty = true;
}

function getPose(): Record<string, number> {
  const pose: Record<string, number> = {};
  for (const jointName of currentData?.metadata.movableJointNames ?? []) {
    const value = robot?.joints?.[jointName]?.angle;
    if (Number.isFinite(value)) {
      pose[jointName] = Number(value);
    }
  }
  return pose;
}

function renderChecks(data: LoadRobotMessage): void {
  const panel = qs('#panel-checks');
  const diagnostics = data.diagnostics;
  panel.innerHTML = diagnostics.length === 0
    ? '<div class="muted">No diagnostics.</div>'
    : diagnostics.map(diagnostic => `
      <div class="diagnostic">
        <div class="severity ${diagnostic.severity}">${diagnostic.severity}</div>
        <div>
          <div>${escapeHtml(diagnostic.message)}</div>
          <div class="muted">${escapeHtml([diagnostic.code, diagnostic.target, diagnostic.line ? `line ${diagnostic.line}` : ''].filter(Boolean).join(' | '))}</div>
        </div>
      </div>
    `).join('');
}

function renderLinks(tree: LinkTreeNode[]): void {
  qs('#panel-links').innerHTML = tree.length === 0
    ? '<div class="muted">No link tree.</div>'
    : `<ul>${tree.map(renderTreeNode).join('')}</ul>`;
  qsa<HTMLButtonElement>('[data-link]').forEach(button => {
    button.addEventListener('click', () => selectLink(button.dataset.link));
  });
}

function renderTreeNode(node: LinkTreeNode): string {
  return `
    <li>
      <button data-link="${escapeHtml(node.link)}">${escapeHtml(node.link)}${node.joint ? ` <span class="muted">via ${escapeHtml(node.joint)}</span>` : ''}</button>
      ${node.children.length > 0 ? `<ul>${node.children.map(renderTreeNode).join('')}</ul>` : ''}
    </li>
  `;
}

function renderInspector(): void {
  const panel = qs('#panel-inspector');
  if (!currentData || !selectedLink) {
    panel.innerHTML = '<div class="muted">Select a link in the viewport or link tree.</div>';
    return;
  }
  const link = currentData.metadata.links[selectedLink];
  const parentJoint = link?.parentJoint ? currentData.metadata.joints[link.parentJoint] : undefined;
  const meshes = currentData.metadata.meshes.filter(mesh => mesh.link === selectedLink);
  const inertial = link?.inertial;
  panel.innerHTML = `
    <div class="inspector-grid">
      <b>Link</b><div class="value">${escapeHtml(selectedLink)}</div>
      <b>Parent</b><div class="value">${escapeHtml(parentJoint?.name ?? 'none')}</div>
      <b>Type</b><div class="value">${escapeHtml(parentJoint?.type ?? 'root')}</div>
      <b>Axis</b><div class="value">${escapeHtml(parentJoint ? parentJoint.axis.join(' ') : '')}</div>
      <b>Limit</b><div class="value">${escapeHtml(parentJoint ? `${parentJoint.limit.lower ?? ''} .. ${parentJoint.limit.upper ?? ''}` : '')}</div>
      <b>Mimic</b><div class="value">${parentJoint?.mimic ? formatMimic(parentJoint.mimic) : 'none'}</div>
      <b>Children</b><div class="value">${escapeHtml(link?.childJoints.join(', ') || 'none')}</div>
      <b>Mass</b><div class="value">${inertial ? `${inertial.mass.toFixed(4)} kg` : 'n/a'}</div>
      ${inertial ? `<b>CoM</b><div class="value">${inertial.origin.map(value => value.toFixed(3)).join(' ')}</div>` : ''}
    </div>
    <h3>Meshes</h3>
    <div class="mesh-list">
      ${meshes.map(mesh => `
        <div class="mesh-item">
          <b>${mesh.kind}</b>
          <div class="value">${escapeHtml(mesh.filename)} ${mesh.exists ? '' : '<span class="severity error">missing</span>'}</div>
        </div>
      `).join('') || '<div class="muted">No meshes.</div>'}
    </div>
  `;
}

function formatMimic(mimic: MimicInfo): string {
  return escapeHtml(`${mimic.joint} × ${mimic.multiplier} + ${mimic.offset}`);
}

function onCanvasClick(event: MouseEvent): void {
  if (measureMode) {
    addMeasurePoint(event);
    return;
  }
  selectFromPointer(event);
}

function raycastRobot(event: MouseEvent): THREE.Intersection | undefined {
  if (!robot) {
    return undefined;
  }
  const rect = renderer.domElement.getBoundingClientRect();
  const mouse = new THREE.Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1
  );
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(mouse, camera);
  return raycaster.intersectObject(robot, true)[0];
}

function selectFromPointer(event: MouseEvent): void {
  const hit = raycastRobot(event);
  selectLink(hit ? findOwningLink(hit.object) : undefined);
}

function selectLink(linkName: string | undefined): void {
  selectedLink = linkName;
  if (selectedBox) {
    scene.remove(selectedBox);
    selectedBox = undefined;
  }
  if (linkName && robot?.links?.[linkName]) {
    // urdf-loader keys robot.visual by <visual name="..."> attribute, which is
    // optional and frequently omitted (e.g. Franka FR3 has none). Find the
    // link's direct URDFVisual children so the box hugs only this link's own
    // visual meshes, not descendant links' geometry.
    const link = robot.links[linkName] as Object3D;
    const visualChildren = link.children.filter(child => (child as { isURDFVisual?: boolean }).isURDFVisual);
    if (visualChildren.length === 1) {
      selectedBox = new THREE.BoxHelper(visualChildren[0], 0xffd866);
      scene.add(selectedBox);
    } else if (visualChildren.length > 1) {
      // Multiple <visual> per link: anchor BoxHelper at the link itself but
      // hide collision/sub-link children so the box ignores them. Simpler than
      // unioning bounds each frame and rare enough in practice (FR3 doesn't
      // hit this branch).
      selectedBox = new THREE.BoxHelper(link, 0xffd866);
      scene.add(selectedBox);
    }
    vscode.postMessage({ type: 'selectionChanged', link: linkName, joint: currentData?.metadata.links[linkName]?.parentJoint });
  }
  renderInspector();
  applyFramesMode();
  highlightSourceForLink(linkName);
  requestRevealForLink(linkName);
  switchTab('inspector');
  dirty = true;
}

function findOwningLink(object: Object3D): string | undefined {
  let cursor: Object3D | null = object;
  while (cursor) {
    if (linkNames.has(cursor.name)) {
      return cursor.name;
    }
    cursor = cursor.parent;
  }
  return undefined;
}

function applyRenderMode(): void {
  if (!robot) {
    return;
  }
  for (const visual of Object.values(robot.visual ?? {}) as Object3D[]) {
    visual.visible = renderMode === 'visual' || renderMode === 'both';
  }
  for (const collider of Object.values(robot.colliders ?? {}) as Object3D[]) {
    collider.visible = renderMode === 'collision' || renderMode === 'both';
    collider.traverse((child: Object3D) => {
      const mesh = child as THREE.Mesh;
      if (mesh.isMesh) {
        forEachMaterial(mesh, material => {
          material.transparent = true;
          material.opacity = renderMode === 'both' ? 0.26 : 0.62;
          material.color.set(0x71d0ff);
        });
      }
    });
  }
  dirty = true;
}

type CameraView = 'front' | 'right' | 'top' | 'iso' | undefined;

function fitCamera(view: CameraView = 'iso'): void {
  if (!robot) {
    return;
  }
  const box = new THREE.Box3().setFromObject(robot);
  if (box.isEmpty()) {
    return;
  }
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z, 0.1);
  const distance = radius / (2 * Math.tan((camera.fov * Math.PI) / 360)) * 1.65;
  const directions: Record<Exclude<CameraView, undefined>, THREE.Vector3> = {
    front: new THREE.Vector3(0, -1, 0.32),
    right: new THREE.Vector3(1, 0, 0.32),
    top: new THREE.Vector3(0, 0, 1),
    iso: new THREE.Vector3(1, -1, 0.68)
  };
  const direction = directions[view ?? 'iso'].normalize();
  camera.position.copy(center).addScaledVector(direction, distance);
  camera.near = Math.max(0.001, distance / 200);
  camera.far = distance * 200;
  camera.updateProjectionMatrix();
  controls.target.copy(center);
  controls.update();
  dirty = true;
}

function getCameraSnapshot(): CameraSnapshot {
  return {
    position: camera.position.toArray() as [number, number, number],
    target: controls.target.toArray() as [number, number, number],
    up: camera.up.toArray() as [number, number, number]
  };
}

function applyCameraSnapshot(snapshot: CameraSnapshot): void {
  camera.position.fromArray(snapshot.position);
  camera.up.fromArray(snapshot.up);
  controls.target.fromArray(snapshot.target);
  controls.update();
  dirty = true;
}

function applyUpAxis(axis: '+X' | '+Y' | '+Z'): void {
  if (axis === '+X') {
    camera.up.set(1, 0, 0);
    grid.rotation.set(0, Math.PI / 2, 0);
  } else if (axis === '+Y') {
    camera.up.set(0, 1, 0);
    grid.rotation.set(0, 0, 0);
  } else {
    camera.up.set(0, 0, 1);
    grid.rotation.set(Math.PI / 2, 0, 0);
  }
  controls.update();
}

function switchTab(name: string): void {
  qsa('.tab').forEach(tab => tab.classList.toggle('active', (tab as HTMLElement).dataset.tab === name));
  qsa('.panel').forEach(panel => panel.classList.toggle('active', panel.id === `panel-${name}`));
  if (name === 'source') {
    // The active line was marked while the panel was hidden, so scrollIntoView
    // was a no-op then. Re-scroll now that the panel has layout.
    const active = document.querySelector<HTMLDivElement>('#panel-source .source-line.active');
    if (active) {
      active.scrollIntoView({ block: 'center' });
    }
  }
}

function resize(): boolean {
  const canvas = renderer.domElement;
  const parent = canvas.parentElement!;
  const width = Math.max(1, Math.floor(parent.clientWidth));
  const height = Math.max(1, Math.floor(parent.clientHeight));
  if (width === currentViewportWidth && height === currentViewportHeight) {
    return false;
  }
  currentViewportWidth = width;
  currentViewportHeight = height;
  renderer.setSize(width, height, false);
  labelsOverlay?.setSize(width, height);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  dirty = true;
  return true;
}

function observeViewportSize(): void {
  const parent = renderer.domElement.parentElement;
  if (!parent || typeof ResizeObserver === 'undefined') {
    return;
  }
  let scheduled = false;
  const observer = new ResizeObserver(() => {
    if (scheduled) {
      return;
    }
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      if (resize() && hasRenderedOnce) {
        renderer.render(scene, camera);
        dirty = false;
      }
    });
  });
  observer.observe(parent);
}

function animate(): void {
  requestAnimationFrame(animate);
  controls.update();
  renderNow();
}

function renderNow(): void {
  if (!robotReady) {
    return;
  }
  if (!dirty) {
    return;
  }
  if (currentViewportWidth === 0 || currentViewportHeight === 0) {
    return;
  }
  if (selectedBox) {
    selectedBox.update();
  }
  renderer.render(scene, camera);
  labelsOverlay?.render(scene, camera);
  hasRenderedOnce = true;
  dirty = false;
}

function disposeObject(object: Object3D): void {
  const mesh = object as THREE.Mesh;
  if (mesh.isMesh) {
    const geometry = mesh.geometry as (THREE.BufferGeometry & { boundsTree?: MeshBVH; disposeBoundsTree?: () => void }) | undefined;
    geometry?.disposeBoundsTree?.();
    mesh.geometry?.dispose();
    forEachMaterial(mesh, material => material.dispose());
  }
}

function forEachMaterial(mesh: THREE.Mesh, callback: (material: THREE.MeshStandardMaterial) => void): void {
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const material of materials) {
    callback(material as THREE.MeshStandardMaterial);
  }
}

function setStatus(text: string): void {
  qs('#hud').textContent = text;
}

function qs<T extends Element = HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Missing element ${selector}`);
  }
  return element;
}

function qsa<T extends Element = HTMLElement>(selector: string): T[] {
  return Array.from(document.querySelectorAll<T>(selector));
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]!));
}

function cssEscape(value: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(value) : value.replace(/["\\]/g, '\\$&');
}

// =============================================================================
// Bookmarks
// =============================================================================

function renderBookmarkSelect(): void {
  const select = qs<HTMLSelectElement>('#bookmark-select');
  const previous = select.value;
  select.innerHTML = '<option value="">Bookmarks</option>'
    + bookmarks.map(item => `<option value="${escapeHtml(item.name)}">${escapeHtml(item.name)}</option>`).join('');
  if (bookmarks.some(item => item.name === previous)) {
    select.value = previous;
  } else {
    select.value = '';
  }
  publishTestState();
}

// =============================================================================
// Frames overlay
// =============================================================================

function disposeFrameHelpers(): void {
  for (const helper of linkAxesHelpers.values()) {
    helper.parent?.remove(helper);
    helper.dispose();
  }
  linkAxesHelpers.clear();
}

function applyFramesMode(): void {
  if (!robot?.links) {
    publishTestState();
    return;
  }
  const visibleLinks = new Set<string>();
  if (framesMode === 'all') {
    for (const linkName of Object.keys(robot.links)) {
      visibleLinks.add(linkName);
    }
  } else if (framesMode === 'selected' && selectedLink) {
    visibleLinks.add(selectedLink);
  }
  const size = Math.max(0.05, robotBoundsRadius * 0.06);
  for (const linkName of Object.keys(robot.links)) {
    const linkObject = robot.links[linkName] as Object3D;
    let helper = linkAxesHelpers.get(linkName);
    if (visibleLinks.has(linkName)) {
      if (!helper) {
        helper = new THREE.AxesHelper(size);
        linkAxesHelpers.set(linkName, helper);
        linkObject.add(helper);
      } else {
        helper.scale.setScalar(size / 0.5);
      }
      helper.visible = true;
    } else if (helper) {
      helper.visible = false;
    }
  }
  publishTestState();
  dirty = true;
}

interface TestState {
  framesMode: FramesMode;
  visibleLinkAxes: number;
  bookmarkCount: number;
  inertiaVisible: boolean;
  selfCollisionEnabled: boolean;
  reachabilityPointCount: number;
  jointAngles: Record<string, number>;
}

function publishTestState(): void {
  const visibleLinkAxes = Array.from(linkAxesHelpers.values()).filter(helper => helper.visible).length;
  const reachabilityPointCount = reachabilityPoints
    ? (reachabilityPoints.geometry.getAttribute('position')?.count ?? 0)
    : 0;
  const jointAngles: Record<string, number> = {};
  for (const jointName of currentData?.metadata.movableJointNames ?? []) {
    jointAngles[jointName] = Number(robot?.joints?.[jointName]?.angle ?? 0);
  }
  for (const [name, info] of Object.entries(currentData?.metadata.joints ?? {})) {
    if (info.mimic) {
      jointAngles[name] = Number(robot?.joints?.[name]?.angle ?? 0);
    }
  }
  (window as unknown as { __urdfStudio?: TestState }).__urdfStudio = {
    framesMode,
    visibleLinkAxes,
    bookmarkCount: bookmarks.length,
    inertiaVisible,
    selfCollisionEnabled,
    reachabilityPointCount,
    jointAngles
  };
}

// =============================================================================
// Inertia & CoM
// =============================================================================

function disposeInertiaHelpers(): void {
  for (const group of inertiaHelpers.values()) {
    group.parent?.remove(group);
    group.traverse(object => {
      const mesh = object as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.geometry?.dispose();
        forEachMaterial(mesh, material => material.dispose());
      }
    });
  }
  inertiaHelpers.clear();
  if (totalCoMMarker) {
    scene.remove(totalCoMMarker);
    totalCoMMarker.geometry.dispose();
    (totalCoMMarker.material as THREE.Material).dispose();
    totalCoMMarker = undefined;
  }
}

function buildInertiaHelpers(): void {
  if (!currentData || !robot?.links) {
    return;
  }
  for (const link of Object.values(currentData.metadata.links)) {
    const inertial = link.inertial;
    if (!inertial || inertial.mass <= 0) {
      continue;
    }
    const linkObject = robot.links[link.name] as Object3D | undefined;
    if (!linkObject) {
      continue;
    }
    const group = new THREE.Group();
    group.position.set(inertial.origin[0], inertial.origin[1], inertial.origin[2]);
    group.rotation.set(inertial.rotation[0], inertial.rotation[1], inertial.rotation[2]);

    const semi = ellipsoidSemiAxes(inertial);
    const ellipsoidGeometry = new THREE.SphereGeometry(1, 24, 16);
    ellipsoidGeometry.scale(Math.max(semi[0], 1e-4), Math.max(semi[1], 1e-4), Math.max(semi[2], 1e-4));
    const ellipsoidMaterial = new THREE.MeshStandardMaterial({
      color: 0x9ad7ff,
      transparent: true,
      opacity: 0.35,
      roughness: 0.5,
      metalness: 0,
      depthWrite: false
    });
    group.add(new THREE.Mesh(ellipsoidGeometry, ellipsoidMaterial));

    const sphereSize = Math.max(0.005, robotBoundsRadius * 0.01);
    const comMarker = new THREE.Mesh(
      new THREE.SphereGeometry(sphereSize, 14, 10),
      new THREE.MeshBasicMaterial({ color: 0xffaa44 })
    );
    group.add(comMarker);

    group.visible = inertiaVisible;
    linkObject.add(group);
    inertiaHelpers.set(link.name, group);
  }

  if (currentData.metadata.totalMass > 0) {
    const sphereSize = Math.max(0.01, robotBoundsRadius * 0.018);
    totalCoMMarker = new THREE.Mesh(
      new THREE.SphereGeometry(sphereSize, 18, 12),
      new THREE.MeshBasicMaterial({ color: 0xff8855 })
    );
    totalCoMMarker.visible = inertiaVisible;
    scene.add(totalCoMMarker);
    updateTotalCoMMarker();
  }
}

function updateTotalCoMMarker(): void {
  if (!totalCoMMarker || !currentData || !robot?.links) {
    return;
  }
  const com = new THREE.Vector3();
  let totalMass = 0;
  const linkLocal = new THREE.Vector3();
  for (const link of Object.values(currentData.metadata.links)) {
    const inertial = link.inertial;
    const linkObject = robot.links[link.name] as Object3D | undefined;
    if (!inertial || inertial.mass <= 0 || !linkObject) {
      continue;
    }
    linkObject.updateWorldMatrix(true, false);
    linkLocal.set(inertial.origin[0], inertial.origin[1], inertial.origin[2]);
    const world = linkLocal.applyMatrix4(linkObject.matrixWorld);
    com.addScaledVector(world, inertial.mass);
    totalMass += inertial.mass;
  }
  if (totalMass > 0) {
    com.multiplyScalar(1 / totalMass);
    totalCoMMarker.position.copy(com);
  }
}

function applyInertiaVisibility(): void {
  for (const group of inertiaHelpers.values()) {
    group.visible = inertiaVisible;
  }
  if (totalCoMMarker) {
    totalCoMMarker.visible = inertiaVisible;
  }
  if (inertiaVisible) {
    updateTotalCoMMarker();
  }
  dirty = true;
}

// =============================================================================
// Self-collision detection
// =============================================================================

function buildCollisionGeometryIndex(): void {
  if (!robot?.colliders) {
    return;
  }
  for (const [linkName, collider] of Object.entries(robot.colliders)) {
    const obj = collider as Object3D;
    obj.traverse(child => {
      const mesh = child as THREE.Mesh;
      if (mesh.isMesh && mesh.geometry instanceof THREE.BufferGeometry) {
        const geometry = mesh.geometry as THREE.BufferGeometry & { boundsTree?: MeshBVH; computeBoundsTree?: () => void };
        if (!geometry.boundsTree) {
          try {
            geometry.computeBoundsTree?.();
          } catch {
            return;
          }
        }
        collisionMeshGeometry.set(`${linkName}::${mesh.uuid}`, { mesh, ownerLink: linkName });
        if (!linkCollisionMaterials.has(linkName)) {
          linkCollisionMaterials.set(linkName, []);
        }
        forEachMaterial(mesh, material => linkCollisionMaterials.get(linkName)!.push(material));
      }
    });
  }
}

function buildVisualMaterialIndex(): void {
  linkVisualMaterials.clear();
  originalVisualColors.clear();
  if (!robot?.visual) {
    return;
  }
  for (const [linkName, visual] of Object.entries(robot.visual)) {
    const obj = visual as Object3D;
    const materials: THREE.MeshStandardMaterial[] = [];
    obj.traverse(child => {
      const mesh = child as THREE.Mesh;
      if (mesh.isMesh) {
        forEachMaterial(mesh, material => {
          materials.push(material);
          if (!originalVisualColors.has(material)) {
            originalVisualColors.set(material, material.color.clone());
          }
        });
      }
    });
    if (materials.length > 0) {
      linkVisualMaterials.set(linkName, materials);
    }
  }
}

function getDisabledPairs(): Set<string> {
  const set = new Set<string>();
  if (!currentData) {
    return set;
  }
  for (const entry of currentData.semantic.disableCollisions ?? []) {
    set.add(canonicalPair(entry.link1, entry.link2));
  }
  return set;
}

function isAdjacent(linkA: string, linkB: string): boolean {
  if (!currentData) {
    return false;
  }
  const a = currentData.metadata.links[linkA];
  const b = currentData.metadata.links[linkB];
  if (!a || !b) {
    return false;
  }
  if (a.parentJoint && currentData.metadata.joints[a.parentJoint]?.parent === linkB) {
    return true;
  }
  if (b.parentJoint && currentData.metadata.joints[b.parentJoint]?.parent === linkA) {
    return true;
  }
  return false;
}

function canonicalPair(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function collectCollidingLinks(): { pairs: Array<[string, string]>; links: Set<string> } {
  const pairs: Array<[string, string]> = [];
  const links = new Set<string>();
  if (collisionMeshGeometry.size === 0 || !robot) {
    return { pairs, links };
  }
  robot.updateMatrixWorld(true);

  const disabled = getDisabledPairs();
  const checked = new Set<string>();
  const meshes = Array.from(collisionMeshGeometry.values());

  const worldBoxes = new Map<string, THREE.Box3>();
  for (const entry of meshes) {
    const box = new THREE.Box3().setFromObject(entry.mesh);
    worldBoxes.set(entry.mesh.uuid, box);
  }

  for (let i = 0; i < meshes.length; i += 1) {
    for (let j = i + 1; j < meshes.length; j += 1) {
      const a = meshes[i];
      const b = meshes[j];
      if (a.ownerLink === b.ownerLink) {
        continue;
      }
      const key = canonicalPair(a.ownerLink, b.ownerLink);
      if (checked.has(key) || disabled.has(key) || isAdjacent(a.ownerLink, b.ownerLink)) {
        continue;
      }
      const boxA = worldBoxes.get(a.mesh.uuid)!;
      const boxB = worldBoxes.get(b.mesh.uuid)!;
      if (!boxA.intersectsBox(boxB)) {
        continue;
      }
      const geomA = a.mesh.geometry as THREE.BufferGeometry & { boundsTree?: MeshBVH };
      const geomB = b.mesh.geometry as THREE.BufferGeometry & { boundsTree?: MeshBVH };
      if (!geomA.boundsTree || !geomB.boundsTree) {
        continue;
      }
      a.mesh.updateMatrixWorld(true);
      b.mesh.updateMatrixWorld(true);
      const inverseB = new THREE.Matrix4().copy(b.mesh.matrixWorld).invert();
      const aToB = new THREE.Matrix4().multiplyMatrices(inverseB, a.mesh.matrixWorld);
      const intersects = geomA.boundsTree.intersectsGeometry(geomB, aToB);
      if (intersects) {
        checked.add(key);
        pairs.push([a.ownerLink, b.ownerLink]);
        links.add(a.ownerLink);
        links.add(b.ownerLink);
      }
    }
  }
  return { pairs, links };
}

async function scheduleSelfCollisionCheck(): Promise<void> {
  if (selfCollisionPending || !selfCollisionEnabled) {
    return;
  }
  selfCollisionPending = true;
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  selfCollisionPending = false;
  if (!selfCollisionEnabled) {
    return;
  }
  const result = collectCollidingLinks();
  applySelfCollisionHighlights(result.links, result.pairs.length);
}

function applySelfCollisionHighlights(links: Set<string>, pairCount = 0): void {
  // Restore previously-highlighted links that are no longer colliding.
  for (const link of highlightedCollisionLinks) {
    if (!links.has(link)) {
      restoreLinkColors(link);
    }
  }
  // Tint the colliding links red on BOTH visual and collision meshes so the
  // user sees the highlight regardless of the active render mode.
  for (const link of links) {
    tintLinkRed(link);
  }
  highlightedCollisionLinks.clear();
  for (const link of links) {
    highlightedCollisionLinks.add(link);
  }
  updateCollideHud(pairCount);
  dirty = true;
}

function tintLinkRed(linkName: string): void {
  const collisionMaterials = linkCollisionMaterials.get(linkName) ?? [];
  for (const material of collisionMaterials) {
    material.color.set(0xff4040);
    material.needsUpdate = true;
  }
  const visualMaterials = linkVisualMaterials.get(linkName) ?? [];
  for (const material of visualMaterials) {
    material.color.set(0xff4040);
    material.needsUpdate = true;
  }
}

function restoreLinkColors(linkName: string): void {
  const collisionMaterials = linkCollisionMaterials.get(linkName) ?? [];
  for (const material of collisionMaterials) {
    // Collision meshes are recolored to cyan by applyRenderMode, just match.
    material.color.set(0x71d0ff);
    material.needsUpdate = true;
  }
  const visualMaterials = linkVisualMaterials.get(linkName) ?? [];
  for (const material of visualMaterials) {
    const original = originalVisualColors.get(material);
    if (original) {
      material.color.copy(original);
    }
    material.needsUpdate = true;
  }
}

function clearSelfCollisionHighlights(): void {
  applySelfCollisionHighlights(new Set(), 0);
}

function updateCollideHud(pairCount: number): void {
  const hud = document.getElementById('collide-hud');
  if (!hud) {
    return;
  }
  if (!selfCollisionEnabled) {
    hud.textContent = '';
    return;
  }
  hud.textContent = pairCount === 0
    ? 'No self-collisions.'
    : `${pairCount} self-collision pair${pairCount === 1 ? '' : 's'}.`;
}

function computeRobotBoundsRadius(): void {
  if (!robot) {
    return;
  }
  const box = new THREE.Box3().setFromObject(robot);
  if (box.isEmpty()) {
    robotBoundsRadius = 0.5;
    return;
  }
  const size = new THREE.Vector3();
  box.getSize(size);
  robotBoundsRadius = Math.max(size.x, size.y, size.z, 0.1);
}

// =============================================================================
// Reachability + collision-pair wizard (Tools tab)
// =============================================================================

function renderToolsPanel(): void {
  const panel = qs('#panel-tools');
  const tipOptions = currentData
    ? Object.values(currentData.metadata.links)
      .filter(link => link.childJoints.length === 0)
      .map(link => `<option value="${escapeHtml(link.name)}">${escapeHtml(link.name)}</option>`)
      .join('')
    : '';
  panel.innerHTML = `
    <h3>Measure</h3>
    <div class="tool-block">
      <div class="row-buttons">
        <button id="measure-toggle" class="primary">Start measuring</button>
        <button id="measure-clear">Clear</button>
      </div>
      <div class="muted" id="measure-status">Click two points on the robot to measure distance.</div>
      <div id="measure-readout" class="measure-readout"></div>
    </div>
    <h3>Reachability</h3>
    <div class="tool-block">
      <label>Tip link <select id="reach-tip">${tipOptions}</select></label>
      <label>Samples <input id="reach-samples" type="number" min="50" max="20000" step="50" value="1000"></label>
      <button id="reach-run" class="primary">Sample</button>
      <button id="reach-clear">Clear</button>
      <span class="muted" id="reach-status"></span>
    </div>
    <h3>Collision pairs (SRDF)</h3>
    <div class="tool-block">
      <label>Random poses <input id="srdf-samples" type="number" min="100" max="20000" step="100" value="1000"></label>
      <button id="srdf-run" class="primary">Analyze</button>
      <button id="srdf-write" disabled>Write to SRDF</button>
      <div class="muted" id="srdf-status">Run analysis to find never-colliding pairs.</div>
      <ul id="srdf-results" class="srdf-results"></ul>
    </div>
    <h3>Export</h3>
    <div class="tool-block">
      <div class="row-buttons">
        <button id="export-bom">Export BOM (CSV)</button>
        <button id="export-report">Export Report (PDF)</button>
      </div>
      <div class="muted" id="export-status">One row per link; PDF bundles screenshot + checks + summary.</div>
    </div>
  `;
  qs('#measure-toggle').addEventListener('click', () => toggleMeasureMode());
  qs('#measure-clear').addEventListener('click', () => clearMeasurement());
  qs('#reach-run').addEventListener('click', () => void sampleReachability());
  qs('#reach-clear').addEventListener('click', () => disposeReachability());
  qs('#srdf-run').addEventListener('click', () => void analyzeCollisionPairs());
  qs('#srdf-write').addEventListener('click', () => writeCollisionPairs());
  qs('#export-bom').addEventListener('click', () => exportBom());
  qs('#export-report').addEventListener('click', () => void exportPdfReport());
  refreshMeasureUi();
}

// =============================================================================
// Source pane
// =============================================================================

function renderSource(data: LoadRobotMessage): void {
  const panel = qs('#panel-source');
  const lines = data.urdf.split('\n');
  const numWidth = String(lines.length).length;
  panel.innerHTML = `
    <div class="source-meta muted">${escapeHtml(data.fileName)} · ${lines.length} lines${data.format === 'xacro' ? ' (expanded xacro)' : ''}</div>
    <pre class="source-view"><code>${lines.map((line, index) => {
      const lineNo = index + 1;
      const padded = String(lineNo).padStart(numWidth, ' ');
      return `<div class="source-line" data-source-line="${lineNo}"><span class="source-gutter">${padded}</span><span class="source-text">${escapeHtml(line) || ' '}</span></div>`;
    }).join('')}</code></pre>
  `;
}

function highlightSourceForLink(linkName: string | undefined): void {
  const panel = document.getElementById('panel-source');
  if (!panel) {
    return;
  }
  panel.querySelectorAll('.source-line.active').forEach(el => el.classList.remove('active'));
  if (!linkName || !currentData) {
    return;
  }
  const line = currentData.metadata.links[linkName]?.line;
  if (!line) {
    return;
  }
  const target = panel.querySelector<HTMLDivElement>(`[data-source-line="${line}"]`);
  if (target) {
    target.classList.add('active');
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

function requestRevealForLink(linkName: string | undefined): void {
  // Only meaningful for plain URDF: the line numbers we track refer to the
  // expanded document, which equals the original file for .urdf but not for
  // .xacro. Skip xacro to avoid revealing the wrong range in the editor.
  if (!linkName || !currentData || currentData.format !== 'urdf') {
    return;
  }
  const line = currentData.metadata.links[linkName]?.line;
  if (!line) {
    return;
  }
  vscode.postMessage({ type: 'requestRevealRange', line, link: linkName });
}

// =============================================================================
// Labels overlay (joints / links)
// =============================================================================

function buildLabels(): void {
  if (!labelsOverlay || !robot || !currentData) {
    return;
  }
  labelsOverlay.clear();
  for (const jointName of Object.keys(robot.joints ?? {})) {
    labelsOverlay.addJoint(jointName, robot.joints[jointName] as THREE.Object3D);
  }
  for (const linkName of Object.keys(robot.links ?? {})) {
    labelsOverlay.addLink(linkName, robot.links[linkName] as THREE.Object3D);
  }
  labelsOverlay.setMode(labelsMode);
}

// =============================================================================
// Measurement tool
// =============================================================================

function toggleMeasureMode(): void {
  measureMode = !measureMode;
  if (!measureMode) {
    // Keep the existing markers; just stop accepting clicks. Clear button
    // wipes the line.
  } else {
    // Starting a fresh measurement: reset the previous one.
    clearMeasurement();
    measureMode = true;
  }
  refreshMeasureUi();
}

function addMeasurePoint(event: MouseEvent): void {
  const hit = raycastRobot(event);
  if (!hit) {
    setMeasureStatus('Click on the robot geometry.');
    return;
  }
  if (measurePoints.length >= 2) {
    // Already have two points: a new click starts a new measurement.
    clearMeasurement();
    measureMode = true;
  }
  const point = hit.point.clone();
  measurePoints.push(point);
  addMeasureMarker(point);
  if (measurePoints.length === 2) {
    buildMeasureLine();
    measureMode = false;
  }
  refreshMeasureUi();
  dirty = true;
}

function addMeasureMarker(point: THREE.Vector3): void {
  const size = Math.max(0.006, robotBoundsRadius * 0.012);
  const marker = new THREE.Mesh(
    new THREE.SphereGeometry(size, 14, 10),
    new THREE.MeshBasicMaterial({ color: 0xffd866, depthTest: false })
  );
  marker.renderOrder = 999;
  marker.position.copy(point);
  scene.add(marker);
  measureMarkers.push(marker);
}

function buildMeasureLine(): void {
  if (measurePoints.length !== 2) {
    return;
  }
  const geometry = new THREE.BufferGeometry().setFromPoints(measurePoints);
  const material = new THREE.LineBasicMaterial({ color: 0xffd866, depthTest: false });
  measureLine = new THREE.Line(geometry, material);
  measureLine.renderOrder = 998;
  scene.add(measureLine);
}

function clearMeasurement(): void {
  for (const marker of measureMarkers) {
    scene.remove(marker);
    marker.geometry.dispose();
    (marker.material as THREE.Material).dispose();
  }
  measureMarkers.length = 0;
  if (measureLine) {
    scene.remove(measureLine);
    measureLine.geometry.dispose();
    (measureLine.material as THREE.Material).dispose();
    measureLine = undefined;
  }
  measurePoints.length = 0;
  measureMode = false;
  refreshMeasureUi();
  dirty = true;
}

function refreshMeasureUi(): void {
  const toggle = document.getElementById('measure-toggle');
  if (toggle) {
    toggle.textContent = measureMode
      ? (measurePoints.length === 0 ? 'Pick point 1…' : 'Pick point 2…')
      : 'Start measuring';
    toggle.classList.toggle('primary', !measureMode);
    toggle.classList.toggle('active', measureMode);
  }
  const readout = document.getElementById('measure-readout');
  if (readout) {
    if (measurePoints.length === 2) {
      const a = measurePoints[0];
      const b = measurePoints[1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dz = b.z - a.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      readout.innerHTML = `
        <div><b>Distance</b> ${dist.toFixed(4)} m</div>
        <div><b>Δx</b> ${dx.toFixed(4)} <b>Δy</b> ${dy.toFixed(4)} <b>Δz</b> ${dz.toFixed(4)}</div>
        <div class="muted">A (${a.x.toFixed(3)}, ${a.y.toFixed(3)}, ${a.z.toFixed(3)})</div>
        <div class="muted">B (${b.x.toFixed(3)}, ${b.y.toFixed(3)}, ${b.z.toFixed(3)})</div>
      `;
    } else {
      readout.innerHTML = '';
    }
  }
  setMeasureStatus(measureMode
    ? 'Click on the robot to drop a point. Click off to cancel.'
    : measurePoints.length === 2
      ? 'Measurement set. Click "Start measuring" for a new one.'
      : 'Click two points on the robot to measure distance.');
}

function setMeasureStatus(text: string): void {
  const status = document.getElementById('measure-status');
  if (status) {
    status.textContent = text;
  }
}

// =============================================================================
// Export: BOM (CSV) and Report (PDF)
// =============================================================================

function exportBom(): void {
  if (!currentData) {
    return;
  }
  const csv = buildBomCsv(currentData.metadata);
  const baseName = currentData.fileName.replace(/\.[^./\\]+$/, '') || 'robot';
  vscode.postMessage({ type: 'requestSaveBom', csv, filename: `${baseName}-bom.csv` });
  flashExportStatus(`BOM ready (${currentData.metadata.counts.links} links).`);
}

async function exportPdfReport(): Promise<void> {
  if (!currentData) {
    return;
  }
  flashExportStatus('Building PDF…');
  // Force a render so the screenshot reflects the current frame.
  dirty = true;
  renderNow();
  const dataUrl = renderer.domElement.toDataURL('image/png');
  try {
    const { jsPDF } = await import('jspdf');
    const pdf = new jsPDF({ unit: 'pt', format: 'a4' });
    buildReportPdf(pdf, currentData, dataUrl);
    const blob = pdf.output('blob');
    const arrayBuffer = await blob.arrayBuffer();
    const base64 = bytesToBase64(new Uint8Array(arrayBuffer));
    const baseName = currentData.fileName.replace(/\.[^./\\]+$/, '') || 'robot';
    vscode.postMessage({
      type: 'requestSaveReport',
      base64,
      filename: `${baseName}-report.pdf`
    });
    flashExportStatus('PDF ready.');
  } catch (error) {
    flashExportStatus(`PDF failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function buildReportPdf(
  pdf: import('jspdf').jsPDF,
  data: LoadRobotMessage,
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
  pdf.text(data.metadata.robotName || data.fileName, margin, cursorY);
  cursorY += 14;
  pdf.text(`Source: ${data.sourcePath}`, margin, cursorY);
  cursorY += 12;
  pdf.text(`Generated: ${new Date().toISOString()}`, margin, cursorY);
  cursorY += 18;

  // Counts row.
  pdf.setFont('helvetica', 'bold');
  pdf.text('Counts', margin, cursorY);
  cursorY += 12;
  pdf.setFont('helvetica', 'normal');
  const counts = data.metadata.counts;
  const summaryParts = [
    `${counts.links} links`,
    `${counts.joints} joints`,
    `${counts.movableJoints} movable`,
    `${counts.visualMeshes} visual meshes`,
    `${counts.collisionMeshes} collision meshes`,
    `total mass ${data.metadata.totalMass.toFixed(3)} kg`
  ];
  pdf.text(summaryParts.join(' · '), margin, cursorY);
  cursorY += 18;

  // Screenshot.
  try {
    const imgWidth = pageWidth - margin * 2;
    const imgHeight = Math.min(360, pageHeight - cursorY - margin - 220);
    pdf.addImage(screenshotDataUrl, 'PNG', margin, cursorY, imgWidth, imgHeight, undefined, 'FAST');
    cursorY += imgHeight + 14;
  } catch {
    // Skip image silently if jsPDF can't decode it.
  }

  // Diagnostics.
  pdf.setFont('helvetica', 'bold');
  pdf.text(`Checks (${data.diagnostics.length})`, margin, cursorY);
  cursorY += 12;
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(9);
  if (data.diagnostics.length === 0) {
    pdf.text('No diagnostics.', margin, cursorY);
    cursorY += 12;
  } else {
    for (const diag of data.diagnostics.slice(0, 60)) {
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
    if (data.diagnostics.length > 60) {
      pdf.text(`… and ${data.diagnostics.length - 60} more`, margin, cursorY);
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
  const sortedLinks = Object.values(data.metadata.links).sort((a, b) => a.name.localeCompare(b.name));
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

function bytesToBase64(bytes: Uint8Array): string {
  // Chunked btoa to avoid stack overflows on big buffers.
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunkSize)) as number[]);
  }
  return btoa(binary);
}

function flashExportStatus(text: string): void {
  const status = document.getElementById('export-status');
  if (status) {
    status.textContent = text;
  }
}

async function sampleReachability(): Promise<void> {
  if (!currentData || !robot) {
    return;
  }
  const tip = (document.getElementById('reach-tip') as HTMLSelectElement | null)?.value;
  const sampleCount = Math.max(1, Math.min(20000, Number((document.getElementById('reach-samples') as HTMLInputElement | null)?.value ?? 1000) || 1000));
  if (!tip || !robot.links?.[tip]) {
    setStatus('Pick a valid tip link first.');
    return;
  }
  const status = document.getElementById('reach-status');
  if (status) {
    status.textContent = `Sampling ${sampleCount}…`;
  }

  const movable = currentData.metadata.movableJointNames;
  if (movable.length === 0) {
    if (status) {
      status.textContent = 'No movable joints to sample.';
    }
    return;
  }
  const ranges = movable.map(name => jointRange(currentData!.metadata.joints[name]));
  const previousPose = getPose();

  disposeReachability();

  // URDFLoader clamps setJointValue to its OWN parsed limits, which may
  // default to [0, 0] when the URDF omits <limit>.  Bypass clamping during
  // sampling so the cloud reflects our metadata's joint ranges.
  const previousIgnoreLimits: Record<string, boolean> = {};
  for (const name of movable) {
    const joint = robot.joints?.[name];
    if (joint) {
      previousIgnoreLimits[name] = !!joint.ignoreLimits;
      joint.ignoreLimits = true;
    }
  }
  // Mimic followers are also driven and need ignoreLimits.
  for (const [name, info] of Object.entries(currentData.metadata.joints)) {
    if (info.mimic && robot.joints?.[name]) {
      previousIgnoreLimits[name] = !!robot.joints[name].ignoreLimits;
      robot.joints[name].ignoreLimits = true;
    }
  }

  const positions = new Float32Array(sampleCount * 3);
  const colors = new Float32Array(sampleCount * 3);
  const tmp = new THREE.Vector3();
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  for (let i = 0; i < sampleCount; i += 1) {
    for (let j = 0; j < movable.length; j += 1) {
      const [min, max] = ranges[j];
      const value = min + Math.random() * (max - min);
      robot.setJointValue(movable[j], value);
    }
    applyMimicValuesAfterSample();
    robot.updateMatrixWorld(true);
    (robot.links[tip] as Object3D).getWorldPosition(tmp);
    positions[i * 3] = tmp.x;
    positions[i * 3 + 1] = tmp.y;
    positions[i * 3 + 2] = tmp.z;
    if (tmp.x < minX) minX = tmp.x;
    if (tmp.y < minY) minY = tmp.y;
    if (tmp.z < minZ) minZ = tmp.z;
    if (tmp.x > maxX) maxX = tmp.x;
    if (tmp.y > maxY) maxY = tmp.y;
    if (tmp.z > maxZ) maxZ = tmp.z;
    if (i % 200 === 0 && i > 0) {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
  }

  // Restore ignoreLimits flags.
  for (const [name, value] of Object.entries(previousIgnoreLimits)) {
    if (robot.joints?.[name]) {
      robot.joints[name].ignoreLimits = value;
    }
  }

  // Color points by relative height for legibility (so dense regions are
  // distinguishable from a flat sphere).
  const span = Math.max(1e-6, maxZ - minZ);
  for (let i = 0; i < sampleCount; i += 1) {
    const t = (positions[i * 3 + 2] - minZ) / span;
    colors[i * 3] = 0.2 + 0.8 * t;
    colors[i * 3 + 1] = 0.9 - 0.4 * t;
    colors[i * 3 + 2] = 0.4 + 0.5 * (1 - t);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const reachExtent = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1e-3);
  const pointSize = Math.max(0.01, reachExtent * 0.015);
  const material = new THREE.PointsMaterial({ size: pointSize, sizeAttenuation: true, vertexColors: true });
  reachabilityPoints = new THREE.Points(geometry, material);
  scene.add(reachabilityPoints);

  applyPose(previousPose);
  if (status) {
    status.textContent = `${sampleCount} samples · X[${minX.toFixed(2)}, ${maxX.toFixed(2)}] Y[${minY.toFixed(2)}, ${maxY.toFixed(2)}] Z[${minZ.toFixed(2)}, ${maxZ.toFixed(2)}].`;
  }
  // Refit camera so the cloud is in view alongside the robot.
  fitCameraToCloud();
  dirty = true;
  publishTestState();
}

function fitCameraToCloud(): void {
  if (!robot || !reachabilityPoints) {
    return;
  }
  const robotBox = new THREE.Box3().setFromObject(robot);
  const cloudBox = new THREE.Box3().setFromObject(reachabilityPoints);
  const combined = robotBox.union(cloudBox);
  if (combined.isEmpty()) {
    return;
  }
  const center = combined.getCenter(new THREE.Vector3());
  const size = combined.getSize(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z, 0.1);
  const distance = radius / (2 * Math.tan((camera.fov * Math.PI) / 360)) * 1.55;
  const direction = camera.position.clone().sub(controls.target).normalize();
  if (!Number.isFinite(direction.length()) || direction.lengthSq() < 1e-6) {
    direction.set(1, -1, 0.68).normalize();
  }
  camera.position.copy(center).addScaledVector(direction, distance);
  camera.near = Math.max(0.001, distance / 200);
  camera.far = distance * 200;
  camera.updateProjectionMatrix();
  controls.target.copy(center);
  controls.update();
}

function applyMimicValuesAfterSample(): void {
  if (!currentData) {
    return;
  }
  for (const [name, info] of Object.entries(currentData.metadata.joints)) {
    if (info.mimic) {
      const masterValue = Number(robot.joints?.[info.mimic.joint]?.angle ?? 0);
      robot.setJointValue(name, masterValue * info.mimic.multiplier + info.mimic.offset);
    }
  }
}

function disposeReachability(): void {
  if (reachabilityPoints) {
    scene.remove(reachabilityPoints);
    reachabilityPoints.geometry.dispose();
    (reachabilityPoints.material as THREE.Material).dispose();
    reachabilityPoints = undefined;
    dirty = true;
  }
  const status = document.getElementById('reach-status');
  if (status) {
    status.textContent = '';
  }
  publishTestState();
}

let lastCollisionAnalysis: DisableCollisionEntry[] = [];

async function analyzeCollisionPairs(): Promise<void> {
  if (!currentData || !robot) {
    return;
  }
  if (!collisionGeometryLoaded) {
    setStatus('Load collision geometry first (set render mode to Collision/Both).');
    qs('#srdf-status').textContent = 'Load collision geometry first.';
    return;
  }
  if (collisionMeshGeometry.size === 0) {
    qs('#srdf-status').textContent = 'No collision meshes available.';
    return;
  }
  const samples = Math.max(50, Math.min(20000, Number((document.getElementById('srdf-samples') as HTMLInputElement | null)?.value ?? 1000) || 1000));
  qs('#srdf-status').textContent = `Sampling ${samples} poses…`;

  const movable = currentData.metadata.movableJointNames;
  const ranges = movable.map(name => jointRange(currentData!.metadata.joints[name]));
  const previousPose = getPose();
  const allPairs = new Set<string>();
  const colliding = new Set<string>();
  const linkNamesArr = Object.keys(currentData.metadata.links);
  for (let i = 0; i < linkNamesArr.length; i += 1) {
    for (let j = i + 1; j < linkNamesArr.length; j += 1) {
      if (!isAdjacent(linkNamesArr[i], linkNamesArr[j])) {
        allPairs.add(canonicalPair(linkNamesArr[i], linkNamesArr[j]));
      }
    }
  }

  for (let s = 0; s < samples; s += 1) {
    for (let j = 0; j < movable.length; j += 1) {
      const [min, max] = ranges[j];
      const value = min + Math.random() * (max - min);
      robot.setJointValue(movable[j], value);
    }
    applyMimicValuesAfterSample();
    robot.updateMatrixWorld(true);
    const result = collectCollidingLinks();
    for (const [a, b] of result.pairs) {
      colliding.add(canonicalPair(a, b));
    }
    if (s % 50 === 0 && s > 0) {
      qs('#srdf-status').textContent = `Sampling ${s}/${samples}…`;
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
  }

  const neverColliding: DisableCollisionEntry[] = [];
  for (const pair of allPairs) {
    if (!colliding.has(pair)) {
      const [link1, link2] = pair.split('|');
      neverColliding.push({ link1, link2, reason: 'Never' });
    }
  }
  lastCollisionAnalysis = neverColliding;

  const list = qs('#srdf-results');
  list.innerHTML = neverColliding.length === 0
    ? '<li class="muted">All non-adjacent pairs collide at least once. Increase samples?</li>'
    : neverColliding.slice(0, 200).map(entry => `<li><code>${escapeHtml(entry.link1)} ↔ ${escapeHtml(entry.link2)}</code></li>`).join('')
      + (neverColliding.length > 200 ? `<li class="muted">… and ${neverColliding.length - 200} more</li>` : '');
  qs('#srdf-status').textContent = `${neverColliding.length} never-colliding pairs found from ${samples} samples.`;
  qs<HTMLButtonElement>('#srdf-write').disabled = neverColliding.length === 0;

  applyPose(previousPose);
  clearSelfCollisionHighlights();
}

function writeCollisionPairs(): void {
  if (lastCollisionAnalysis.length === 0) {
    return;
  }
  vscode.postMessage({ type: 'requestWriteDisableCollisions', entries: lastCollisionAnalysis });
}

function normalizeVfsUrl(url: string, scheme: string): string {
  // Normalize the path portion of a urdf-studio-vfs URL:
  // collapse empty segments (`a//b` → `a/b`), drop `.`, resolve `..` against
  // the stack. The scheme always carries `//` (e.g. `urdf-studio-vfs://`) and
  // the returned URL has exactly one slash between scheme and path.
  const path = url.slice(scheme.length).replace(/^\/+/, '');
  const segments = path.split('/');
  const stack: string[] = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      if (stack.length > 0) {
        stack.pop();
      }
      continue;
    }
    stack.push(segment);
  }
  return `${scheme}/${stack.join('/')}`;
}
