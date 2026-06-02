// Render-mode visibility toggling.
//
// Regression guard for the bug where switching to Collision and back to
// Visual/Both left the collision geometry on screen. urdf-loader only keys
// robot.visual / robot.colliders by the optional <visual name>/<collision
// name> attribute, so for the common case where those names are omitted the
// old map-based toggle was a no-op. applyRenderModeVisibility traverses by the
// isURDFVisual / isURDFCollider flags instead, which are present regardless of
// naming.

import { strict as assert } from 'node:assert';
import test from 'node:test';
import * as THREE from 'three';
import { applyRenderModeVisibility, type RenderModeDeps } from '../../src/renderer/features/renderMode';

const deps: RenderModeDeps = {
  forEachMaterial(mesh, callback) {
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      callback(material as THREE.MeshStandardMaterial);
    }
  }
};

interface URDFNode extends THREE.Object3D {
  isURDFVisual?: boolean;
  isURDFCollider?: boolean;
}

/**
 * Build a robot whose <visual>/<collision> elements carry NO name attribute —
 * exactly the case urdf-loader leaves out of robot.visual / robot.colliders.
 */
function makeRobot(): { robot: THREE.Group; visualNodes: URDFNode[]; colliderNodes: URDFNode[]; colliderMeshes: THREE.Mesh[] } {
  const robot = new THREE.Group();
  const visualNodes: URDFNode[] = [];
  const colliderNodes: URDFNode[] = [];
  const colliderMeshes: THREE.Mesh[] = [];
  for (let i = 0; i < 3; i++) {
    const link = new THREE.Object3D();
    robot.add(link);

    const visual = new THREE.Object3D() as URDFNode;
    visual.isURDFVisual = true;
    visual.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()));
    link.add(visual);
    visualNodes.push(visual);

    const collider = new THREE.Object3D() as URDFNode;
    collider.isURDFCollider = true;
    const colliderMesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ color: 0x123456 }));
    collider.add(colliderMesh);
    link.add(collider);
    colliderNodes.push(collider);
    colliderMeshes.push(colliderMesh);
  }
  return { robot, visualNodes, colliderNodes, colliderMeshes };
}

test('collision mode shows colliders and hides visuals', () => {
  const { robot, visualNodes, colliderNodes } = makeRobot();
  applyRenderModeVisibility(robot, 'collision', deps);
  assert.ok(visualNodes.every(n => n.visible === false), 'visuals hidden');
  assert.ok(colliderNodes.every(n => n.visible === true), 'colliders shown');
});

test('visual mode shows visuals and hides colliders', () => {
  const { robot, visualNodes, colliderNodes } = makeRobot();
  applyRenderModeVisibility(robot, 'visual', deps);
  assert.ok(visualNodes.every(n => n.visible === true), 'visuals shown');
  assert.ok(colliderNodes.every(n => n.visible === false), 'colliders hidden');
});

test('both mode shows visuals and colliders', () => {
  const { robot, visualNodes, colliderNodes } = makeRobot();
  applyRenderModeVisibility(robot, 'both', deps);
  assert.ok(visualNodes.every(n => n.visible === true), 'visuals shown');
  assert.ok(colliderNodes.every(n => n.visible === true), 'colliders shown');
});

test('switching collision -> visual actually switches back (the reported bug)', () => {
  const { robot, visualNodes, colliderNodes } = makeRobot();
  applyRenderModeVisibility(robot, 'collision', deps);
  applyRenderModeVisibility(robot, 'visual', deps);
  assert.ok(visualNodes.every(n => n.visible === true), 'visuals visible again');
  assert.ok(colliderNodes.every(n => n.visible === false), 'colliders hidden again');
});

test('switching collision -> both restores visuals while keeping colliders', () => {
  const { robot, visualNodes, colliderNodes } = makeRobot();
  applyRenderModeVisibility(robot, 'collision', deps);
  applyRenderModeVisibility(robot, 'both', deps);
  assert.ok(visualNodes.every(n => n.visible === true), 'visuals visible again');
  assert.ok(colliderNodes.every(n => n.visible === true), 'colliders still shown');
});

test('collider meshes are recoloured cyan and made transparent', () => {
  const { robot, colliderMeshes } = makeRobot();
  applyRenderModeVisibility(robot, 'collision', deps);
  for (const mesh of colliderMeshes) {
    const material = mesh.material as THREE.MeshStandardMaterial;
    assert.equal(material.transparent, true);
    assert.equal(material.color.getHex(), 0x71d0ff);
    assert.equal(material.opacity, 0.62);
  }
  applyRenderModeVisibility(robot, 'both', deps);
  for (const mesh of colliderMeshes) {
    assert.equal((mesh.material as THREE.MeshStandardMaterial).opacity, 0.26);
  }
});
