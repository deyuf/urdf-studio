import * as THREE from 'three';
import { LoadingManager, Object3D } from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { ColladaLoader } from 'three/examples/jsm/loaders/ColladaLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import URDFLoader from 'urdf-loader';
import type { URDFRobot } from 'urdf-loader/src/URDFClasses';
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
import { buildMimicGraph, propagateMimicValue, type MimicGraph } from '../core/mimic';
import { LabelsOverlay, type LabelsMode } from './labels';
import { buildDisplayGroups as buildDisplayGroupsPure, jointRange as jointRangePure } from './logic/displayGroups';
import {
  canonicalPair as canonicalPairPure,
  isAdjacent as isAdjacentPure
} from './logic/selfCollision';
import { mountSourcePane, type SourcePane } from './logic/sourcePane';
import { createLayoutController, type LayoutController } from './layout/fullscreen';
import { runAllRules, RULE_REGISTRY, type LintReport } from '../core/lintRules';
import { createLivePreview, type LivePreviewHandle } from '../editor/livePreview';
import type { CompletionContextProvider } from '../editor/completion';
import { html, setInnerHtml } from './html';
import {
  exportBom as exportBomFeature,
  exportPdfReport as exportPdfReportFeature,
  type ExportableDocument
} from './features/export';
import { Measurement } from './features/measurement';
import { Reachability } from './features/reachability';
import { InertiaVisualisation } from './features/inertia';
import { FramesOverlay, type FramesMode } from './features/frames';
import { SelfCollision } from './features/selfCollision';
import { applyRenderModeVisibility, type RenderMode } from './features/renderMode';

(THREE.Mesh.prototype as unknown as { raycast: typeof acceleratedRaycast }).raycast = acceleratedRaycast;
(THREE.BufferGeometry.prototype as unknown as { computeBoundsTree: typeof computeBoundsTree }).computeBoundsTree = computeBoundsTree;
(THREE.BufferGeometry.prototype as unknown as { disposeBoundsTree: typeof disposeBoundsTree }).disposeBoundsTree = disposeBoundsTree;

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
  // Web host only: maps `urdf-studio-vfs:///abs/path` URLs (declared in
  // packageMap / sourceBaseUri) back to blob: URLs the loaders can fetch.
  // VS Code host leaves these undefined and serves assets through the
  // webview's localResourceRoots whitelist instead.
  vfsUrlMap?: Record<string, string>;
  vfsUrlScheme?: string;
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
let robot: URDFRobot | undefined;
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

let framesOverlay: FramesOverlay | undefined;
let labelsOverlay: LabelsOverlay | undefined;
let sourcePane: SourcePane | undefined;
let _layoutController: LayoutController | undefined;
let livePreview: LivePreviewHandle | undefined;
let currentLintReport: LintReport | undefined;
let _editorDirtyText: string | undefined;
let labelsMode: LabelsMode = 'off';
let measurement: Measurement | undefined;
let inertia: InertiaVisualisation | undefined;
let selfCollision: SelfCollision | undefined;

let reachability: Reachability | undefined;

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
  <div class="workspace" id="workspace">
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
    applyFramesMode((event.target as HTMLSelectElement).value as FramesMode);
  });
  qs<HTMLInputElement>('#inertia-toggle').addEventListener('change', event => {
    applyInertiaVisibility((event.target as HTMLInputElement).checked);
  });
  qs<HTMLSelectElement>('#labels-mode').addEventListener('change', event => {
    labelsMode = (event.target as HTMLSelectElement).value as LabelsMode;
    labelsOverlay?.setMode(labelsMode);
    publishTestState();
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

  // Layout controller: F11 / Ctrl+Shift+F / Fullscreen button in source pane.
  _layoutController = createLayoutController(qs('#workspace'), () => {
    // Layout change can resize the viewport; force a Three.js resize.
    requestAnimationFrame(() => {
      resize();
      dirty = true;
    });
  });
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

  ensureSelfCollision().dispose();
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
  const vfsUrlMap = data.vfsUrlMap;
  const vfsScheme = data.vfsUrlScheme;
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
    const parsedRobot = loader.parse(data.urdf) as URDFRobot;
    robot = parsedRobot;
    parsedRobot.visible = !hasExternalMeshesToLoad;
    collisionGeometryLoaded = shouldLoadCollision;
    scene.add(parsedRobot);
    parsedRobot.traverse((object: Object3D) => {
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
      if (info.mimic && parsedRobot.joints?.[name]) {
        parsedRobot.joints[name].ignoreLimits = true;
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
  setInnerHtml(panel, html`
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
  `);
  qs<HTMLInputElement>('#joint-search').addEventListener('input', () => applyJointFilter());
  qs<HTMLInputElement>('#joint-modified-only').addEventListener('change', () => applyJointFilter());
}

function renderXacroArgs(data: LoadRobotMessage): void {
  const host = qs('#xacro-args-host');
  if (data.format !== 'xacro' || data.xacroArgs.length === 0) {
    host.replaceChildren();
    return;
  }
  setInnerHtml(host, html`
    <div class="xacro-args">
      ${data.xacroArgs.map(arg => html`
        <label>
          <span>${arg.name}</span>
          <input type="text" data-xacro-arg="${arg.name}" value="${String(data.xacroArgValues[arg.name] ?? arg.defaultValue ?? '')}">
        </label>
      `)}
      <button id="apply-xacro" class="primary">Reload xacro</button>
    </div>
  `);
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
  setInnerHtml(host, html`${groups.map(group => {
    const statesForGroup = data.semantic.states
      .filter(state => state.group === group.name || (group.name === 'all' && Object.keys(state.joints).length > 0));
    return html`
      <details open data-group="${group.name}">
        <summary>${group.name} (${group.joints.length})</summary>
        <div class="detail-body">
          <div class="state-buttons">
            ${statesForGroup.map(state => html`<button data-state="${state.group}:${state.name}">${state.name}</button>`)}
          </div>
          ${group.joints.map(jointName => renderJointRow(jointName, data.metadata.joints[jointName]))}
        </div>
      </details>`;
  })}`);

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
  return buildDisplayGroupsPure(data.metadata, data.semantic);
}

function renderJointRow(jointName: string, joint: JointInfo | undefined): ReturnType<typeof html> {
  const value = Number(robot?.joints?.[jointName]?.angle ?? 0);
  const [min, max] = jointRange(joint);
  return html`
    <div class="joint-row" data-joint-row="${jointName}">
      <span class="joint-name" title="${jointName}">${jointName}</span>
      <input data-joint-slider="${jointName}" type="range" min="${min}" max="${max}" step="0.001" value="${value}">
      <input data-joint-number="${jointName}" type="number" min="${min}" max="${max}" step="0.001" value="${value.toFixed(3)}">
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
  return jointRangePure(joint);
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
  if (inertia?.isVisible()) {
    updateTotalCoMMarker();
  }
  dirty = true;
  if (notify) {
    vscode.postMessage({ type: 'jointChanged', joint: jointName, value });
  }
  if (selfCollision?.isEnabled()) {
    scheduleSelfCollisionCheck();
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

  // Run the rule engine on top of the analyzeUrdf diagnostics so the
  // Checks panel always reflects the same data the editor's inline
  // linter shows. Rules are pure and run on the renderer side — fast,
  // no I/O.
  // Combine host-supplied diagnostics (analyzeUrdf + custom hooks like
  // package resolution, plus anything the extension layer added) with the
  // rule engine output. Diagnostics whose code isn't rebadged by any rule
  // (e.g., generic xacro warnings) still need to surface — we passthrough
  // them under a synthetic "OTHER" group.
  const combinedInputDiagnostics = [...data.metadata.diagnostics, ...data.diagnostics];
  const report = runAllRules({
    urdf: data.urdf,
    sourcePath: data.sourcePath,
    packages: {},
    metadata: { ...data.metadata, diagnostics: combinedInputDiagnostics }
  });
  // Passthrough: diagnostics from analyzeUrdf that no rule rebadged.
  const knownCodes = new Set(Object.keys(RULE_REGISTRY.reduce((acc, r) => { acc[r.code] = true; return acc; }, {} as Record<string, true>)));
  const rebadgedSourceCodes = new Set([
    'tree.cycle', 'joint.parentMissing', 'joint.childMissing',
    'link.duplicate', 'joint.duplicate', 'joint.mimicMissing',
    'inertial.notPositiveDefinite', 'inertial.massInvalid',
    'joint.limitMissing', 'mesh.missing', 'mesh.packageMissing',
    'mesh.packageMalformed', 'mesh.packageFallback'
  ]);
  const passthrough = combinedInputDiagnostics.filter(diag => {
    if (!diag.code) return true;
    if (knownCodes.has(diag.code)) return false;
    if (rebadgedSourceCodes.has(diag.code)) return false;
    return true;
  });
  if (passthrough.length > 0) {
    report.byRule['OTHER'] = (report.byRule['OTHER'] ?? []).concat(passthrough);
    report.diagnostics.push(...passthrough);
    for (const diag of passthrough) {
      report.counts[diag.severity] += 1;
    }
  }
  currentLintReport = report;

  // Push diagnostics into the editor's inline linter.
  sourcePane?.refreshDiagnostics(report.diagnostics);

  if (report.diagnostics.length === 0) {
    setInnerHtml(panel, html`
      <div class="checks-summary">
        <span class="health-score health-good">100</span>
        <div class="checks-counts"><span class="count-pill">No diagnostics</span></div>
      </div>
    `);
    return;
  }

  const grouped = new Map<string, typeof report.diagnostics>();
  for (const diag of report.diagnostics) {
    const code = diag.code ?? 'unknown';
    if (!grouped.has(code)) grouped.set(code, []);
    grouped.get(code)!.push(diag);
  }

  const healthClass = report.healthScore >= 90 ? 'health-good'
    : report.healthScore >= 70 ? 'health-warn'
    : 'health-poor';

  const groupHtml = Array.from(grouped.entries())
    .sort((a, b) => severityRank(b[1][0].severity) - severityRank(a[1][0].severity))
    .map(([code, diagnostics]) => {
      const description = RULE_REGISTRY.find(rule => rule.code === code)?.description ?? code;
      return html`
        <div class="checks-group">
          <div class="checks-group-header">
            <span>${code} · ${description}</span>
            <span class="muted">${diagnostics.length}</span>
          </div>
          <ul class="checks-group-list">
            ${diagnostics.map(diag => html`
              <li class="checks-group-item severity-${diag.severity}" data-line="${diag.line ?? ''}">
                ${diag.message}
                ${diag.line ? html`<span class="check-line">line ${diag.line}</span>` : ''}
              </li>`)}
          </ul>
        </div>`;
    });

  setInnerHtml(panel, html`
    <div class="checks-summary">
      <span class="health-score ${healthClass}" title="Health score (0-100)">${report.healthScore.toFixed(0)}</span>
      <div class="checks-counts">
        ${report.counts.error > 0 ? html`<span class="count-pill">${report.counts.error} error</span>` : ''}
        ${report.counts.warning > 0 ? html`<span class="count-pill">${report.counts.warning} warning</span>` : ''}
        ${report.counts.info > 0 ? html`<span class="count-pill">${report.counts.info} info</span>` : ''}
      </div>
    </div>
    ${groupHtml}
  `);

  // Wire clicks: jump editor to the offending line.
  panel.querySelectorAll<HTMLLIElement>('.checks-group-item[data-line]').forEach(item => {
    item.addEventListener('click', () => {
      const line = Number(item.dataset.line);
      if (!Number.isFinite(line) || line <= 0) return;
      sourcePane?.setActiveLine(line);
      switchTab('source');
    });
  });
}

function severityRank(severity: 'error' | 'warning' | 'info'): number {
  return severity === 'error' ? 3 : severity === 'warning' ? 2 : 1;
}

function renderLinks(tree: LinkTreeNode[]): void {
  const panel = qs('#panel-links');
  if (tree.length === 0) {
    setInnerHtml(panel, html`<div class="muted">No link tree.</div>`);
  } else {
    setInnerHtml(panel, html`<ul>${tree.map(renderTreeNode)}</ul>`);
  }
  qsa<HTMLButtonElement>('[data-link]').forEach(button => {
    button.addEventListener('click', () => selectLink(button.dataset.link));
  });
}

function renderTreeNode(node: LinkTreeNode): ReturnType<typeof html> {
  return html`
    <li>
      <button data-link="${node.link}">${node.link}${node.joint ? html` <span class="muted">via ${node.joint}</span>` : ''}</button>
      ${node.children.length > 0 ? html`<ul>${node.children.map(renderTreeNode)}</ul>` : ''}
    </li>
  `;
}

function renderInspector(): void {
  const panel = qs('#panel-inspector');
  if (!currentData || !selectedLink) {
    setInnerHtml(panel, html`<div class="muted">Select a link in the viewport or link tree.</div>`);
    return;
  }
  const link = currentData.metadata.links[selectedLink];
  const parentJoint = link?.parentJoint ? currentData.metadata.joints[link.parentJoint] : undefined;
  const meshes = currentData.metadata.meshes.filter(mesh => mesh.link === selectedLink);
  const inertial = link?.inertial;
  const limitText = parentJoint
    ? `${parentJoint.limit.lower ?? ''} .. ${parentJoint.limit.upper ?? ''}`
    : '';
  setInnerHtml(panel, html`
    <div class="inspector-grid">
      <b>Link</b><div class="value">${selectedLink}</div>
      <b>Parent</b><div class="value">${parentJoint?.name ?? 'none'}</div>
      <b>Type</b><div class="value">${parentJoint?.type ?? 'root'}</div>
      <b>Axis</b><div class="value">${parentJoint ? parentJoint.axis.join(' ') : ''}</div>
      <b>Limit</b><div class="value">${limitText}</div>
      <b>Mimic</b><div class="value">${parentJoint?.mimic ? formatMimic(parentJoint.mimic) : 'none'}</div>
      <b>Children</b><div class="value">${link?.childJoints.join(', ') || 'none'}</div>
      <b>Mass</b><div class="value">${inertial ? `${inertial.mass.toFixed(4)} kg` : 'n/a'}</div>
      ${inertial ? html`<b>CoM</b><div class="value">${inertial.origin.map(value => value.toFixed(3)).join(' ')}</div>` : ''}
    </div>
    <h3>Meshes</h3>
    <div class="mesh-list">
      ${meshes.length === 0
        ? html`<div class="muted">No meshes.</div>`
        : meshes.map(mesh => html`
          <div class="mesh-item">
            <b>${mesh.kind}</b>
            <div class="value">${mesh.filename} ${mesh.exists ? '' : html`<span class="severity error">missing</span>`}</div>
          </div>
        `)}
    </div>
  `);
}

function formatMimic(mimic: MimicInfo): string {
  return `${mimic.joint} × ${mimic.multiplier} + ${mimic.offset}`;
}

function onCanvasClick(event: MouseEvent): void {
  if (ensureMeasurement().handleClick(event)) {
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
  // Only auto-switch when the click actually hit a link. A miss in empty
  // viewport space deselects but should leave the user on whatever tab
  // (Joints, Source, ...) they were using.
  if (linkName) {
    switchTab('inspector');
  }
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
  applyRenderModeVisibility(robot, renderMode, { forEachMaterial });
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

function cssEscape(value: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(value) : value.replace(/["\\]/g, '\\$&');
}

// =============================================================================
// Bookmarks
// =============================================================================

function renderBookmarkSelect(): void {
  const select = qs<HTMLSelectElement>('#bookmark-select');
  const previous = select.value;
  setInnerHtml(select, html`
    <option value="">Bookmarks</option>
    ${bookmarks.map(item => html`<option value="${item.name}">${item.name}</option>`)}
  `);
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

function ensureFramesOverlay(): FramesOverlay {
  if (!framesOverlay) {
    framesOverlay = new FramesOverlay({
      getBoundsRadius: () => robotBoundsRadius,
      requestRedraw: () => { dirty = true; },
      onStateChange: () => publishTestState()
    });
  }
  return framesOverlay;
}

function disposeFrameHelpers(): void {
  ensureFramesOverlay().dispose();
}

function applyFramesMode(mode?: FramesMode): void {
  ensureFramesOverlay().apply(mode, robot, selectedLink);
}

interface TestState {
  framesMode: FramesMode;
  visibleLinkAxes: number;
  bookmarkCount: number;
  inertiaVisible: boolean;
  selfCollisionEnabled: boolean;
  reachabilityPointCount: number;
  jointAngles: Record<string, number>;
  labelsMode: LabelsMode;
  visibleJointLabels: number;
  visibleLinkLabels: number;
  totalLabels: number;
  measureMode: boolean;
  measurePointCount: number;
  measureDistance: number | null;
}

function publishTestState(): void {
  const visibleLinkAxes = framesOverlay?.visibleCount() ?? 0;
  const reachabilityPointCount = reachability?.pointCount() ?? 0;
  const jointAngles: Record<string, number> = {};
  for (const jointName of currentData?.metadata.movableJointNames ?? []) {
    jointAngles[jointName] = Number(robot?.joints?.[jointName]?.angle ?? 0);
  }
  for (const [name, info] of Object.entries(currentData?.metadata.joints ?? {})) {
    if (info.mimic) {
      jointAngles[name] = Number(robot?.joints?.[name]?.angle ?? 0);
    }
  }
  const visibleJointLabels = labelsOverlay?.visibleCount('joint') ?? 0;
  const visibleLinkLabels = labelsOverlay?.visibleCount('link') ?? 0;
  const totalLabels = labelsOverlay?.totalCount() ?? 0;
  const measureSnap = measurement?.snapshot() ?? { mode: false, pointCount: 0, distance: null };
  (window as unknown as { __urdfStudio?: TestState }).__urdfStudio = {
    framesMode: framesOverlay?.current() ?? 'off',
    visibleLinkAxes,
    bookmarkCount: bookmarks.length,
    inertiaVisible: inertia?.isVisible() ?? false,
    selfCollisionEnabled: selfCollision?.isEnabled() ?? false,
    reachabilityPointCount,
    jointAngles,
    labelsMode,
    visibleJointLabels,
    visibleLinkLabels,
    totalLabels,
    measureMode: measureSnap.mode,
    measurePointCount: measureSnap.pointCount,
    measureDistance: measureSnap.distance
  };
}

// =============================================================================
// Inertia & CoM
// =============================================================================

function ensureInertia(): InertiaVisualisation {
  if (!inertia) {
    inertia = new InertiaVisualisation({
      scene,
      getBoundsRadius: () => robotBoundsRadius,
      requestRedraw: () => { dirty = true; },
      onStateChange: () => publishTestState()
    });
  }
  return inertia;
}

function disposeInertiaHelpers(): void {
  ensureInertia().dispose();
}

function buildInertiaHelpers(): void {
  if (!currentData || !robot) {
    return;
  }
  ensureInertia().build(robot, currentData.metadata);
}

function updateTotalCoMMarker(): void {
  if (!currentData || !robot) {
    return;
  }
  ensureInertia().refreshTotal(robot, currentData.metadata);
}

function applyInertiaVisibility(visible: boolean): void {
  ensureInertia().setVisible(visible, robot, currentData?.metadata);
}

// =============================================================================
// Self-collision detection
// =============================================================================

function ensureSelfCollision(): SelfCollision {
  if (!selfCollision) {
    selfCollision = new SelfCollision({
      requestRedraw: () => { dirty = true; },
      onStateChange: () => publishTestState()
    });
  }
  return selfCollision;
}

function currentCollisionContext() {
  if (!robot || !currentData) {
    return undefined;
  }
  return {
    robot,
    metadata: currentData.metadata,
    semantic: currentData.semantic
  };
}

function buildCollisionGeometryIndex(): void {
  if (!robot) {
    return;
  }
  ensureSelfCollision().rebuildIndex(robot);
}

function clearSelfCollisionHighlights(): void {
  ensureSelfCollision().clearHighlights();
}

function scheduleSelfCollisionCheck(): void {
  const ctx = currentCollisionContext();
  if (!ctx) {
    return;
  }
  ensureSelfCollision().schedule(ctx);
}

function collectCollidingLinks(): { pairs: Array<[string, string]>; links: Set<string> } {
  const ctx = currentCollisionContext();
  if (!ctx) {
    return { pairs: [], links: new Set() };
  }
  return ensureSelfCollision().computeCollisions(ctx);
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

// =============================================================================
// Viewport screenshot (Tools panel)
// =============================================================================

function captureViewportPng(scale: number): string {
  // Force a synchronous render so the captured frame reflects the
  // current camera / pose. Then upscale by drawing into an offscreen
  // canvas at the requested multiplier — Three.js by default renders
  // at devicePixelRatio*viewport; the scale multiplier multiplies on top.
  renderNow();
  if (!Number.isFinite(scale) || scale <= 0) scale = 1;
  const source = renderer.domElement;
  if (scale === 1) {
    return source.toDataURL('image/png');
  }
  const target = document.createElement('canvas');
  target.width = Math.max(1, Math.round(source.width * scale));
  target.height = Math.max(1, Math.round(source.height * scale));
  const ctx = target.getContext('2d');
  if (!ctx) return source.toDataURL('image/png');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, target.width, target.height);
  return target.toDataURL('image/png');
}

function defaultScreenshotFileName(): string {
  const robotName = currentData?.metadata.robotName?.replace(/[^A-Za-z0-9_-]+/g, '_') || 'robot';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `${robotName}_${stamp}.png`;
}

function setScreenshotStatus(text: string, isError = false): void {
  const status = document.querySelector<HTMLDivElement>('#screenshot-status');
  if (!status) return;
  status.textContent = text;
  status.classList.toggle('error', isError);
}

function downloadViewportScreenshot(): void {
  try {
    const scale = Number((document.querySelector<HTMLSelectElement>('#screenshot-scale')?.value) ?? '2');
    const dataUrl = captureViewportPng(scale);
    const link = document.createElement('a');
    link.href = dataUrl;
    link.download = defaultScreenshotFileName();
    document.body.appendChild(link);
    link.click();
    link.remove();
    setScreenshotStatus(`Saved ${link.download}`);
  } catch (error) {
    setScreenshotStatus(`Screenshot failed: ${(error as Error).message}`, true);
  }
}

async function copyViewportScreenshot(): Promise<void> {
  try {
    const scale = Number((document.querySelector<HTMLSelectElement>('#screenshot-scale')?.value) ?? '2');
    const dataUrl = captureViewportPng(scale);
    // Convert data URL -> Blob for clipboard.
    const blob = await (await fetch(dataUrl)).blob();
    const clipboard = (navigator as Navigator & { clipboard?: { write?: (items: ClipboardItem[]) => Promise<void> } }).clipboard;
    if (!clipboard?.write) {
      setScreenshotStatus('Clipboard API not available in this browser.', true);
      return;
    }
    await clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    setScreenshotStatus('Copied to clipboard.');
  } catch (error) {
    setScreenshotStatus(`Copy failed: ${(error as Error).message}`, true);
  }
}

function renderToolsPanel(): void {
  const panel = qs('#panel-tools');
  const tipLinks = currentData
    ? Object.values(currentData.metadata.links).filter(link => link.childJoints.length === 0)
    : [];
  setInnerHtml(panel, html`
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
      <label>Tip link <select id="reach-tip">${tipLinks.map(link => html`<option value="${link.name}">${link.name}</option>`)}</select></label>
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
    <h3>Screenshot</h3>
    <div class="tool-block">
      <div class="row-buttons">
        <button id="screenshot-download" class="primary" title="Save the current 3D view as a PNG">Save PNG</button>
        <button id="screenshot-copy" title="Copy the current 3D view to the clipboard">Copy to clipboard</button>
        <label title="Higher = sharper, larger file"><span class="muted">Scale</span>
          <select id="screenshot-scale">
            <option value="1">1×</option>
            <option value="2" selected>2×</option>
            <option value="3">3×</option>
            <option value="4">4×</option>
          </select>
        </label>
      </div>
      <div class="muted" id="screenshot-status">PNG of the current 3D viewport, no UI chrome.</div>
    </div>
    <h3>Export</h3>
    <div class="tool-block">
      <div class="row-buttons">
        <button id="export-bom">Export BOM (CSV)</button>
        <button id="export-report">Export Report (PDF)</button>
      </div>
      <div class="muted" id="export-status">One row per link; PDF bundles screenshot + checks + summary.</div>
    </div>
  `);
  qs('#measure-toggle').addEventListener('click', () => toggleMeasureMode());
  qs('#measure-clear').addEventListener('click', () => clearMeasurement());
  qs('#reach-run').addEventListener('click', () => void sampleReachability());
  qs('#reach-clear').addEventListener('click', () => disposeReachability());
  qs('#srdf-run').addEventListener('click', () => void analyzeCollisionPairs());
  qs('#srdf-write').addEventListener('click', () => writeCollisionPairs());
  qs('#export-bom').addEventListener('click', () => exportBom());
  qs('#export-report').addEventListener('click', () => void exportPdfReport());
  qs('#screenshot-download').addEventListener('click', () => downloadViewportScreenshot());
  qs('#screenshot-copy').addEventListener('click', () => void copyViewportScreenshot());
  refreshMeasureUi();
}

// =============================================================================
// Source pane
// =============================================================================

function renderSource(data: LoadRobotMessage): void {
  const panel = qs('#panel-source');

  // Fast-path: if the new URDF matches what the editor is already
  // showing (a live-preview round-trip echoing the user's own edit
  // back), keep the editor mounted and just refresh diagnostics so
  // typing focus is preserved.
  if (sourcePane && sourcePane.getText() === data.urdf) {
    sourcePane.refreshDiagnostics(currentLintReport?.diagnostics ?? data.diagnostics);
    return;
  }

  sourcePane?.dispose();

  const completionProvider: CompletionContextProvider = {
    linkNames: () => Object.keys(currentData?.metadata.links ?? {}),
    jointNames: () => Object.keys(currentData?.metadata.joints ?? {}),
    movableJointNames: () => currentData?.metadata.movableJointNames ?? [],
    packageNames: () => Object.keys(currentData?.packageMap ?? {})
  };

  // Initialize live-preview pipeline. Edits push through here; debounce
  // is auto-bumped for large models so editing stays smooth.
  if (!livePreview) {
    livePreview = createLivePreview({
      debounceMs: 160,
      maxDebounceMs: 800,
      apply: text => {
        if (!currentData) return;
        _editorDirtyText = undefined;
        // Hand the new text to the host. The host re-runs analyze /
        // xacro expansion and dispatches a fresh loadRobot. Sending a
        // light-weight 'previewEdit' message keeps the protocol distinct
        // from "real" file changes.
        vscode.postMessage({ type: 'previewEdit', text });
      }
    });
  }

  sourcePane = mountSourcePane(panel, {
    fileName: data.fileName,
    format: data.format,
    urdf: data.urdf,
    editable: false,
    diagnostics: currentLintReport?.diagnostics ?? data.diagnostics,
    completionProvider,
    onChange: text => {
      _editorDirtyText = text;
      livePreview?.notify(text);
    },
    onSave: text => {
      _editorDirtyText = undefined;
      vscode.postMessage({ type: 'requestSaveSource', text });
    },
    onLineClick: line => {
      // Best-effort: open the line in the host editor for VS Code users.
      vscode.postMessage({ type: 'requestRevealRange', line });
    }
  });
}

function highlightSourceForLink(linkName: string | undefined): void {
  if (!sourcePane) {
    return;
  }
  if (!linkName || !currentData) {
    sourcePane.setActiveLine(undefined);
    return;
  }
  const line = currentData.metadata.links[linkName]?.line;
  sourcePane.setActiveLine(line);
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
  publishTestState();
}

// =============================================================================
// Measurement tool (delegates to features/measurement.ts)
// =============================================================================

function ensureMeasurement(): Measurement {
  if (!measurement) {
    measurement = new Measurement({
      scene,
      raycastFromEvent: event => raycastRobot(event),
      getBoundsRadius: () => robotBoundsRadius,
      requestRedraw: () => { dirty = true; },
      onStateChange: () => publishTestState()
    });
  }
  return measurement;
}

function toggleMeasureMode(): void { ensureMeasurement().toggle(); }
function clearMeasurement(): void { ensureMeasurement().clear(); }
function refreshMeasureUi(): void { ensureMeasurement().refresh(); }

// =============================================================================
// Export: BOM (CSV) and Report (PDF)
// =============================================================================

function exportBom(): void {
  if (!currentData) {
    return;
  }
  exportBomFeature(toExportableDocument(currentData), exportHost);
}

async function exportPdfReport(): Promise<void> {
  if (!currentData) {
    return;
  }
  // Force a render so the screenshot reflects the current frame.
  dirty = true;
  renderNow();
  const screenshotDataUrl = renderer.domElement.toDataURL('image/png');
  await exportPdfReportFeature(
    toExportableDocument(currentData),
    { screenshotDataUrl },
    exportHost
  );
}

function toExportableDocument(data: LoadRobotMessage): ExportableDocument {
  return {
    fileName: data.fileName,
    sourcePath: data.sourcePath,
    metadata: data.metadata,
    diagnostics: data.diagnostics
  };
}

const exportHost = {
  postMessage: (message: unknown) => vscode.postMessage(message),
  reportStatus: (text: string) => flashExportStatus(text)
};

function flashExportStatus(text: string): void {
  const status = document.getElementById('export-status');
  if (status) {
    status.textContent = text;
  }
}

function ensureReachability(): Reachability {
  if (!reachability) {
    reachability = new Reachability({
      scene,
      fitCameraToBox: box => fitCameraToBox(box),
      requestRedraw: () => { dirty = true; },
      onStateChange: () => publishTestState()
    });
  }
  return reachability;
}

async function sampleReachability(): Promise<void> {
  if (!currentData || !robot) {
    return;
  }
  const tip = (document.getElementById('reach-tip') as HTMLSelectElement | null)?.value;
  const sampleCount = Math.max(
    1,
    Math.min(
      20000,
      Number((document.getElementById('reach-samples') as HTMLInputElement | null)?.value ?? 1000) || 1000
    )
  );
  if (!tip) {
    setStatus('Pick a valid tip link first.');
    return;
  }
  await ensureReachability().sample({
    robot,
    metadata: currentData.metadata,
    tipLinkName: tip,
    sampleCount,
    poseBeforeSampling: getPose(),
    applyPose: pose => applyPose(pose),
    propagateMimics: (r, m) => applyMimicValuesAfterSample(r, m)
  });
}

function disposeReachability(): void {
  ensureReachability().dispose();
}

function fitCameraToBox(combined: THREE.Box3): void {
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

function applyMimicValuesAfterSample(activeRobot: URDFRobot, metadata: RobotMetadata): void {
  for (const [name, info] of Object.entries(metadata.joints)) {
    if (info.mimic) {
      const masterValue = Number(activeRobot.joints?.[info.mimic.joint]?.angle ?? 0);
      activeRobot.setJointValue(name, masterValue * info.mimic.multiplier + info.mimic.offset);
    }
  }
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
  if (!ensureSelfCollision().hasGeometryIndex()) {
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
      if (!isAdjacentPure(linkNamesArr[i], linkNamesArr[j], currentData.metadata.links, currentData.metadata.joints)) {
        allPairs.add(canonicalPairPure(linkNamesArr[i], linkNamesArr[j]));
      }
    }
  }

  for (let s = 0; s < samples; s += 1) {
    for (let j = 0; j < movable.length; j += 1) {
      const [min, max] = ranges[j];
      const value = min + Math.random() * (max - min);
      robot.setJointValue(movable[j], value);
    }
    applyMimicValuesAfterSample(robot, currentData.metadata);
    robot.updateMatrixWorld(true);
    const result = collectCollidingLinks();
    for (const [a, b] of result.pairs) {
      colliding.add(canonicalPairPure(a, b));
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
  if (neverColliding.length === 0) {
    setInnerHtml(list, html`<li class="muted">All non-adjacent pairs collide at least once. Increase samples?</li>`);
  } else {
    const shown = neverColliding.slice(0, 200);
    const overflow = neverColliding.length - shown.length;
    setInnerHtml(list, html`
      ${shown.map(entry => html`<li><code>${entry.link1} ↔ ${entry.link2}</code></li>`)}
      ${overflow > 0 ? html`<li class="muted">… and ${overflow} more</li>` : ''}
    `);
  }
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
