import { strict as assert } from 'node:assert';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { Box3, Mesh, MeshPhongMaterial, type Object3D } from 'three';
import URDFLoader from 'urdf-loader';
import { parseUrdfWithCapsules } from '../../src/renderer/parseUrdf';

const dom = new JSDOM();
Object.assign(globalThis, {
  DOMParser: dom.window.DOMParser,
  Document: dom.window.Document,
  Element: dom.window.Element
});

function loader() {
  const result = new URDFLoader();
  result.parseCollision = true;
  return result;
}

function model(geometry: string, tag = 'collision', origin = '') {
  return `<robot name="capsule_fixture"><link name="base"><${tag} name="shape">${origin}
    <geometry>${geometry}</geometry><material name="blue"><color rgba="0 0 1 0.4"/></material>
    </${tag}></link></robot>`;
}

function close(actual: number[], expected: number[]) {
  actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 1e-6, `${actual} != ${expected}`));
}

test('capsule length is the cylindrical core, with one radius at either Z end', () => {
  const robot = parseUrdfWithCapsules(loader(), model('<capsule radius="0.1" length="0.4"/>'));
  const shape = robot.colliders.shape;
  assert.equal(shape.children.length, 1);
  const mesh = shape.children[0] as Mesh;
  assert.equal(mesh.geometry.type, 'CapsuleGeometry');
  const box = new Box3().setFromObject(robot);
  close(box.min.toArray(), [-0.1, -0.1, -0.3]);
  close(box.max.toArray(), [0.1, 0.1, 0.3]);
  assert.equal(robot.urdfRobotNode!.querySelectorAll('geometry > capsule').length, 1);
  assert.equal(robot.urdfRobotNode!.querySelectorAll('geometry > cylinder').length, 0);
});

test('capsule keeps origin/RPY and visual material opacity', () => {
  const robot = parseUrdfWithCapsules(loader(), model('<capsule radius="0.1" length="0.4"/>', 'visual',
    '<origin xyz="1 2 3" rpy="0 1.5707963267948966 0"/>'));
  const box = new Box3().setFromObject(robot);
  close(box.min.toArray(), [0.7, 1.9, 2.9]);
  close(box.max.toArray(), [1.3, 2.1, 3.1]);
  const material = (robot.visual.shape.children[0] as Mesh).material as MeshPhongMaterial;
  assert.equal(material.color.getHexString(), '0000ff');
  assert.equal(material.opacity, 0.4);
  assert.equal(material.transparent, true);
});

test('unnamed collision elements receive capsule geometry too', () => {
  const robot = parseUrdfWithCapsules(loader(), model('<capsule radius="0.1" length="0.4"/>').replace(' name="shape"', ''));
  const meshes: Mesh[] = [];
  robot.traverse((object: Object3D) => { if ((object as Mesh).isMesh) meshes.push(object as Mesh); });
  assert.equal(meshes.length, 1);
  assert.equal(meshes[0].geometry.type, 'CapsuleGeometry');
});

test('zero core length is a finite sphere-sized capsule', () => {
  const robot = parseUrdfWithCapsules(loader(), model('<capsule radius="0.1" length="0"/>'));
  const mesh = robot.colliders.shape.children[0] as Mesh;
  assert.equal(mesh.geometry.type, 'CapsuleGeometry');
  for (const name of ['position', 'normal']) {
    assert.ok(Array.from(mesh.geometry.getAttribute(name).array).every(Number.isFinite));
  }
  const box = new Box3().setFromObject(robot);
  close(box.min.toArray(), [-0.1, -0.1, -0.1]);
  close(box.max.toArray(), [0.1, 0.1, 0.1]);
});

test('capsules respect visual/collision parsing flags', () => {
  const xml = '<robot name="flags"><link name="base">' +
    '<visual><geometry><capsule radius="0.1" length="0.4"/></geometry></visual>' +
    '<collision><geometry><capsule radius="0.1" length="0.4"/></geometry></collision></link></robot>';
  for (const visual of [true, false]) for (const collision of [true, false]) {
    const configured = loader();
    configured.parseVisual = visual;
    configured.parseCollision = collision;
    let meshes = 0;
    parseUrdfWithCapsules(configured, xml).traverse((object: Object3D) => { if ((object as Mesh).isMesh) meshes++; });
    assert.equal(meshes, Number(visual) + Number(collision));
  }
});

test('invalid capsule dimensions are rejected before creating geometry', () => {
  for (const attributes of ['radius="-1" length="1"', 'radius="0" length="1"',
    'radius="NaN" length="1"', 'radius="1" length="-1"', 'radius="1" length="Infinity"',
    'radius="1"', 'length="1"', 'radius="1" length=""']) {
    assert.throws(() => parseUrdfWithCapsules(loader(), model(`<capsule ${attributes}/>`)), /capsule/i);
  }
});

test('disabled collision geometry is neither validated nor rendered', () => {
  const configured = loader();
  configured.parseCollision = false;
  const robot = parseUrdfWithCapsules(configured, model('<capsule radius="-1" length="1"/>'));
  assert.deepEqual(Object.keys(robot.colliders), []);
});

test('ordinary primitives and joint updates retain the loader behavior', () => {
  const xml = '<robot name="mixed"><link name="base"/><link name="tip">' +
    '<collision name="shape"><geometry><cylinder radius="0.1" length="0.4"/></geometry></collision>' +
    '</link><joint name="turn" type="continuous"><parent link="base"/><child link="tip"/>' +
    '<origin xyz="1 2 3"/><axis xyz="0 1 0"/></joint></robot>';
  const expected = loader().parse(xml);
  const actual = parseUrdfWithCapsules(loader(), xml);
  for (const robot of [expected, actual]) { robot.setJointValue('turn', 0.6); robot.updateMatrixWorld(true); }
  assert.deepEqual(actual.links.tip.matrixWorld.toArray(), expected.links.tip.matrixWorld.toArray());
  assert.deepEqual((actual.colliders.shape.children[0] as Mesh).geometry.getAttribute('position').array,
    (expected.colliders.shape.children[0] as Mesh).geometry.getAttribute('position').array);
});

test('capsules in ignored robot and link extensions do not affect the preview', () => {
  const payload = '<visual><geometry><capsule><radius>0.1</radius><length>0.4</length></capsule></geometry></visual>' +
    '<collision><geometry><capsule radius="invalid" length="-1"/></geometry></collision>';
  const extension = `<gazebo><plugin name="sdf_payload">${payload}` +
    `<robot name="nested"><link name="ignored">${payload}</link></robot></plugin></gazebo>`;
  for (const tag of ['visual', 'collision']) {
    const xml = model('<capsule radius="0.1" length="0.4"/>', tag)
      .replace('<link name="base">', `${extension}<link name="base">${extension}`);
    const robot = parseUrdfWithCapsules(loader(), xml);
    const shapes = tag === 'visual' ? robot.visual : robot.colliders;
    assert.equal((shapes.shape.children[0] as Mesh).geometry.type, 'CapsuleGeometry');
    assert.deepEqual(Object.keys(robot.links), ['base']);
    const original = new DOMParser().parseFromString(xml, 'text/xml');
    assert.deepEqual(Array.from(robot.urdfRobotNode!.querySelectorAll('gazebo'), node => node.outerHTML),
      Array.from(original.querySelectorAll('gazebo'), node => node.outerHTML));
  }
});

test('nested extension cylinders cannot hide a direct capsule geometry', () => {
  for (const tag of ['visual', 'collision']) {
    const xml = model('<capsule radius="0.1" length="0.4"/>', tag).replace('<geometry>',
      '<extension><geometry><cylinder radius="5" length="10"/></geometry></extension><geometry>');
    const robot = parseUrdfWithCapsules(loader(), xml);
    const shapes = tag === 'visual' ? robot.visual : robot.colliders;
    assert.equal((shapes.shape.children[0] as Mesh).geometry.type, 'CapsuleGeometry');
    close(new Box3().setFromObject(robot).max.toArray(), [0.1, 0.1, 0.3]);
    assert.equal(robot.urdfRobotNode!.querySelector('extension cylinder')!.getAttribute('length'), '10');
  }
});
