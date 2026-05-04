import * as THREE from 'three';
import { LoadingManager, Object3D } from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { ColladaLoader } from 'three/examples/jsm/loaders/ColladaLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import URDFLoader from 'urdf-loader';
import type {
  CameraSnapshot,
  JointInfo,
  LinkTreeNode,
  PreviewState,
  RobotMetadata,
  SemanticMetadata,
  StudioDiagnostic,
  XacroArgument
} from '../core/types';

type RenderMode = 'visual' | 'collision' | 'both';

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
    <div class="toolbar-spacer"></div>
    <div class="toolbar-group">
      <label><input id="ignore-limits" type="checkbox"> Ignore limits</label>
      <button id="save-pose" class="primary">Save Pose</button>
    </div>
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
      </div>
      <section id="panel-joints" class="panel active"></section>
      <section id="panel-inspector" class="panel"></section>
      <section id="panel-checks" class="panel"></section>
      <section id="panel-links" class="panel tree"></section>
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
  }
});

function initThree(): void {
  const canvas = qs<HTMLCanvasElement>('#viewport');
  // Hide canvas until the first real frame is rendered so the user never sees
  // the default 300x150 buffer being CSS-stretched to fill the viewport.
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

  observeViewportSize();
  window.addEventListener('resize', resize);
  canvas.addEventListener('click', event => selectFromPointer(event));

  // --- Wheel-zoom fix for VS Code webviews ---
  // VS Code's webview preload injects a bubble-phase wheel handler on the
  // contentWindow that UNCONDITIONALLY forwards every wheel event to the host
  // for scrolling (it does NOT check event.defaultPrevented).  That means our
  // preventDefault() alone can't stop the host from scrolling the outer panel.
  //
  // Strategy: two listeners, both on the viewport wrapper.
  //
  //  1. Capture phase: call preventDefault() to suppress the browser's own
  //     scroll default.  Do NOT stopPropagation — let the event continue to
  //     the canvas so OrbitControls receives it normally and dollies the camera.
  //
  //  2. Bubble phase: AFTER OrbitControls (on the canvas) has handled the event
  //     in the target/bubble phase, the event bubbles up from the canvas to the
  //     viewport wrapper.  Here we call stopImmediatePropagation() so the event
  //     never reaches the window and VS Code's forwarding handler never fires.
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
  qs('#save-pose').addEventListener('click', () => {
    vscode.postMessage({ type: 'requestSavePose', pose: getPose(), camera: getCameraSnapshot() });
  });
  qsa<HTMLButtonElement>('.tab').forEach(tab => tab.addEventListener('click', () => switchTab(tab.dataset.tab!)));
}

async function loadRobot(data: LoadRobotMessage, forceCollisionGeometry = false): Promise<void> {
  currentData = data;
  renderMode = data.renderSettings.renderMode;
  qs<HTMLSelectElement>('#render-mode').value = renderMode;
  qs('#title').textContent = data.fileName;
  setStatus('Parsing robot...');
  selectedLink = undefined;
  linkNames = new Set(Object.keys(data.metadata.links));

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
  renderInspector();

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
    }
    robotReady = true;
    // Ensure the canvas is visible now that we have something to show.
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
    <div id="joint-groups"></div>
  `;
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
    <details open>
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
    <div class="joint-row">
      <span class="joint-name" title="${escapeHtml(jointName)}">${escapeHtml(jointName)}</span>
      <input data-joint-slider="${escapeHtml(jointName)}" type="range" min="${min}" max="${max}" step="0.001" value="${value}">
      <input data-joint-number="${escapeHtml(jointName)}" type="number" min="${min}" max="${max}" step="0.001" value="${value.toFixed(3)}">
    </div>
  `;
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
  qsa<HTMLInputElement>(`[data-joint-slider="${cssEscape(jointName)}"], [data-joint-number="${cssEscape(jointName)}"]`).forEach(input => {
    input.value = input.type === 'number' ? value.toFixed(3) : String(value);
  });
  if (selectedBox) {
    selectedBox.update();
  }
  dirty = true;
  if (notify) {
    vscode.postMessage({ type: 'jointChanged', joint: jointName, value });
  }
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
  panel.innerHTML = `
    <div class="inspector-grid">
      <b>Link</b><div class="value">${escapeHtml(selectedLink)}</div>
      <b>Parent</b><div class="value">${escapeHtml(parentJoint?.name ?? 'none')}</div>
      <b>Type</b><div class="value">${escapeHtml(parentJoint?.type ?? 'root')}</div>
      <b>Axis</b><div class="value">${escapeHtml(parentJoint ? parentJoint.axis.join(' ') : '')}</div>
      <b>Limit</b><div class="value">${escapeHtml(parentJoint ? `${parentJoint.limit.lower ?? ''} .. ${parentJoint.limit.upper ?? ''}` : '')}</div>
      <b>Children</b><div class="value">${escapeHtml(link?.childJoints.join(', ') || 'none')}</div>
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

function selectFromPointer(event: MouseEvent): void {
  if (!robot) {
    return;
  }
  const rect = renderer.domElement.getBoundingClientRect();
  const mouse = new THREE.Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1
  );
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(mouse, camera);
  const hit = raycaster.intersectObject(robot, true)[0];
  selectLink(hit ? findOwningLink(hit.object) : undefined);
}

function selectLink(linkName: string | undefined): void {
  selectedLink = linkName;
  if (selectedBox) {
    scene.remove(selectedBox);
    selectedBox = undefined;
  }
  if (linkName && robot?.links?.[linkName]) {
    selectedBox = new THREE.BoxHelper(robot.links[linkName], 0xffd866);
    scene.add(selectedBox);
    vscode.postMessage({ type: 'selectionChanged', link: linkName, joint: currentData?.metadata.links[linkName]?.parentJoint });
  }
  renderInspector();
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
    // Coalesce multiple resize callbacks into a single rAF so we don't paint
    // a frame mid-layout (which is what made the model briefly 'jump' when
    // the joints tab finished laying out).
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
  // controls.update() returns true while damping is settling; in that case
  // OrbitControls also dispatches its 'change' event which sets `dirty`.
  controls.update();
  renderNow();
}

function renderNow(): void {
  // Skip rendering until the robot is loaded and visible.
  // This prevents the grid/axes from flashing before geometry is ready.
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
  hasRenderedOnce = true;
  dirty = false;
}

function disposeObject(object: Object3D): void {
  const mesh = object as THREE.Mesh;
  if (mesh.isMesh) {
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
