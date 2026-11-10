import { strict as assert } from 'node:assert';
import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import '../../src/core/io.node';
import { convertMjcfToUrdf, isMjcfContent, quatToRpy } from '../../src/core/mjcf';
import { renderRobotDocument } from '../../src/core/xacro';
import { analyzeUrdf } from '../../src/core/urdfAnalysis';

const FIXTURES = path.resolve('test/fixtures/mjcf');

// --- tiny forward kinematics over the generated URDF ----------------------

type V = number[];
type M = number[][];
const mul = (a: M, b: M): M => a.map(row => b[0].map((_, j) => row.reduce((sum, value, k) => sum + value * b[k][j], 0)));
const apply = (m: M, v: V): V => m.map(r => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
const rx = (a: number): M => [[1, 0, 0], [0, Math.cos(a), -Math.sin(a)], [0, Math.sin(a), Math.cos(a)]];
const ry = (a: number): M => [[Math.cos(a), 0, Math.sin(a)], [0, 1, 0], [-Math.sin(a), 0, Math.cos(a)]];
const rz = (a: number): M => [[Math.cos(a), -Math.sin(a), 0], [Math.sin(a), Math.cos(a), 0], [0, 0, 1]];
function rodrigues([x, y, z]: V, a: number): M {
  const c = Math.cos(a), s = Math.sin(a), t = 1 - c;
  return [[c + x * x * t, x * y * t - z * s, x * z * t + y * s], [y * x * t + z * s, c + y * y * t, y * z * t - x * s], [z * x * t - y * s, z * y * t + x * s, c + z * z * t]];
}
const nums = (value: string | null, fallback: V): V => value ? value.trim().split(/\s+/).map(Number) : fallback;

/** World anchor and axis of every joint for the given joint values. */
function jointFrames(urdf: string, jointValues: Record<string, number>): Record<string, { anchor: V; axis: V }> {
  const doc = new DOMParser().parseFromString(urdf, 'text/xml');
  const joints = Array.from(doc.getElementsByTagName('joint'));
  const byChild = new Map(joints.map(j => [j.getElementsByTagName('child')[0].getAttribute('link')!, j]));
  const frames: Record<string, { anchor: V; axis: V }> = {};
  const cache = new Map<string, { p: V; R: M }>();
  const linkPose = (link: string): { p: V; R: M } => {
    const cached = cache.get(link);
    if (cached) return cached;
    const joint = byChild.get(link);
    let pose: { p: V; R: M } = { p: [0, 0, 0], R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] };
    if (joint) {
      const parent = linkPose(joint.getElementsByTagName('parent')[0].getAttribute('link')!);
      const origin = joint.getElementsByTagName('origin')[0];
      const xyz = nums(origin?.getAttribute('xyz') ?? null, [0, 0, 0]);
      const rpy = nums(origin?.getAttribute('rpy') ?? null, [0, 0, 0]);
      const anchor = apply(parent.R, xyz).map((v, i) => v + parent.p[i]);
      const R = mul(parent.R, mul(mul(rz(rpy[2]), ry(rpy[1])), rx(rpy[0])));
      const axis = nums(joint.getElementsByTagName('axis')[0]?.getAttribute('xyz') ?? null, [1, 0, 0]);
      const name = joint.getAttribute('name')!;
      const q = jointValues[name] ?? 0;
      const type = joint.getAttribute('type');
      frames[name] = { anchor, axis: apply(R, axis) };
      pose = type === 'prismatic'
        ? { p: apply(R, axis).map((v, i) => anchor[i] + v * q), R }
        : type === 'revolute' || type === 'continuous' ? { p: anchor, R: mul(R, rodrigues(axis, q)) } : { p: anchor, R };
    }
    cache.set(link, pose);
    return pose;
  };
  for (const link of byChild.keys()) linkPose(link);
  return frames;
}

const distance = (a: V, b: V): number => Math.hypot(...a.map((v, i) => v - b[i]));

// --- tests -----------------------------------------------------------------

test('kinematics match MuJoCo for orientations, frames, offset joints and classes', async () => {
  const expected = JSON.parse(readFileSync(path.join(FIXTURES, 'stress.expected.json'), 'utf8')) as {
    pose: Record<string, number>;
    joints: Record<string, { anchor: V; axis: V }>;
  };
  const file = path.join(FIXTURES, 'stress.xml');
  const { urdf } = await convertMjcfToUrdf(file, readFileSync(file, 'utf8'));
  const frames = jointFrames(urdf, expected.pose);
  for (const [name, reference] of Object.entries(expected.joints)) {
    assert.ok(frames[name], `joint ${name} missing from the URDF`);
    assert.ok(distance(frames[name].anchor, reference.anchor) < 1e-6, `${name} anchor`);
    assert.ok(distance(frames[name].axis, reference.axis) < 1e-6, `${name} axis`);
  }
});

test('joint types and limits follow MJCF semantics', async () => {
  const file = path.join(FIXTURES, 'stress.xml');
  const { urdf, diagnostics } = await convertMjcfToUrdf(file, readFileSync(file, 'utf8'));
  const meta = analyzeUrdf(urdf, file, {});
  // Degrees are converted; the class default range applies to j_a.
  assert.equal(meta.joints.j_a.type, 'revolute');
  assert.ok(Math.abs(meta.joints.j_a.limit.upper! - Math.PI / 2) < 1e-9);
  assert.ok(Math.abs(meta.joints.j_b.limit.lower! + Math.PI / 6) < 1e-9);
  // Slide joint from the "slider" class keeps metres.
  assert.equal(meta.joints.j_c.type, 'prismatic');
  assert.deepEqual([meta.joints.j_c.limit.lower, meta.joints.j_c.limit.upper], [-0.1, 0.2]);
  // limited="false" overrides the inherited range.
  assert.equal(meta.joints.j_d.type, 'continuous');
  // Ball and free joints become fixed, with one note each.
  assert.ok(diagnostics.some(d => d.code === 'mjcf.freeJoint' && /float/.test(d.message)));
  assert.ok(diagnostics.some(d => d.code === 'mjcf.ballJoint' && /ball/.test(d.message)));
  assert.ok(diagnostics.some(d => d.code === 'mjcf.ellipsoid'));
  assert.equal(meta.counts.movableJoints, 4);
});

test('geoms map to visual and collision by group and contact flags', async () => {
  const file = path.join(FIXTURES, 'stress.xml');
  const { urdf } = await convertMjcfToUrdf(file, readFileSync(file, 'utf8'));
  const doc = new DOMParser().parseFromString(urdf, 'text/xml');
  const link = (name: string) => Array.from(doc.getElementsByTagName('link')).find(l => l.getAttribute('name') === name)!;
  // Capsule → cylinder + 2 spheres, drawn and colliding.
  assert.equal(link('two_joints').getElementsByTagName('visual').length, 3);
  assert.equal(link('two_joints').getElementsByTagName('collision').length, 3);
  // group 3 → collision only.
  assert.equal(link('tip').getElementsByTagName('visual').length, 0);
  assert.equal(link('tip').getElementsByTagName('collision').length, 1);
  // contype=conaffinity=0 → visual only.
  assert.equal(link('ball_and_free').getElementsByTagName('collision').length, 0);
  // Material colour is carried over.
  assert.match(new XMLSerializer().serializeToString(link('base')), /rgba="0.6 0.62 0.65 1"/);
  // Infinite floor planes are not drawn.
  assert.equal(link('world').getElementsByTagName('visual').length, 0);
});

test('includes, meshdir, unnamed meshes and childclass resolve like MuJoCo', async () => {
  const file = path.join(FIXTURES, 'arm', 'scene.xml');
  const rendered = await renderRobotDocument(file, {}, {});
  assert.equal(rendered.format, 'mjcf');
  assert.deepEqual(rendered.includedFiles, [path.join(FIXTURES, 'arm', 'arm.xml')]);
  const meta = analyzeUrdf(rendered.urdf, file, {});
  assert.equal(meta.counts.movableJoints, 2);
  // The mesh is named after its file, found under meshdir, and exists.
  assert.ok(meta.meshes.length >= 2);
  assert.ok(meta.meshes.every(mesh => mesh.exists && mesh.filename === 'assets/link.stl'), JSON.stringify(meta.meshes));
  assert.match(rendered.urdf, /scale="0.5 0.5 0.5"/);
  // childclass="arm" supplies the joint range (radians here).
  assert.equal(meta.joints.shoulder_pan.limit.upper, 1.5);
  // The visual class (contype 0) is drawn but does not collide; the
  // collision class (group 3) collides but is not drawn.
  const shoulder = Array.from(new DOMParser().parseFromString(rendered.urdf, 'text/xml').getElementsByTagName('link'))
    .find(l => l.getAttribute('name') === 'shoulder')!;
  assert.equal(shoulder.getElementsByTagName('visual').length, 1);
  assert.equal(shoulder.getElementsByTagName('collision').length, 3);
  assert.equal(rendered.diagnostics.length, 0, JSON.stringify(rendered.diagnostics));
});

test('a missing or cyclic include is reported and the rest still converts', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'urdfstudio-mjcf-'));
  await fs.writeFile(path.join(dir, 'a.xml'), '<mujoco><include file="b.xml"/><include file="nope.xml"/><worldbody><body name="kept"/></worldbody></mujoco>');
  await fs.writeFile(path.join(dir, 'b.xml'), '<mujoco><include file="a.xml"/></mujoco>');
  const file = path.join(dir, 'a.xml');
  const rendered = await renderRobotDocument(file, {}, {});
  assert.ok(rendered.diagnostics.some(d => /Include cycle/.test(d.message)));
  assert.ok(rendered.diagnostics.some(d => /Could not include "nope.xml"/.test(d.message)));
  assert.match(rendered.urdf, /<link name="kept">/);
});

test('MJCF detection only matches a <mujoco> root', () => {
  assert.equal(isMjcfContent('<?xml version="1.0"?>\n<!-- model -->\n<mujoco model="x"/>'), true);
  assert.equal(isMjcfContent('<mujoco>'), true);
  assert.equal(isMjcfContent('<robot name="r"/>'), false);
  assert.equal(isMjcfContent('<package format="3"><name>mujoco</name></package>'), false);
});

test('unreadable MJCF becomes a diagnostic, not an exception', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'urdfstudio-mjcf-'));
  const file = path.join(dir, 'broken.xml');
  // Truncated mid-tag: a real XML error (mismatched closing tags are only
  // warnings, matching what browsers accept).
  await fs.writeFile(file, '<mujoco><worldbody');
  const rendered = await renderRobotDocument(file, {}, {});
  assert.equal(rendered.format, 'mjcf');
  assert.ok(rendered.diagnostics.some(d => d.code === 'mjcf.parse'));
});

test('quatToRpy round-trips through URDF rotation order, including gimbal lock', () => {
  const toMatrix = (rpy: V) => mul(mul(rz(rpy[2]), ry(rpy[1])), rx(rpy[0]));
  const fromAxisAngle = (axis: V, angle: number): [number, number, number, number] => {
    const n = Math.hypot(...axis), s = Math.sin(angle / 2) / n;
    return [Math.cos(angle / 2), axis[0] * s, axis[1] * s, axis[2] * s];
  };
  const cases: Array<[V, number]> = [[[1, 0, 0], 0.3], [[0, 1, 0], Math.PI / 2], [[0, 1, 0], -Math.PI / 2], [[1, 2, 3], 2.5], [[0, 0, 1], Math.PI]];
  for (const [axis, angle] of cases) {
    const rpy = quatToRpy(fromAxisAngle(axis, angle));
    const expected = rodrigues(axis.map(v => v / Math.hypot(...axis)), angle);
    const actual = toMatrix(rpy);
    const error = Math.max(...actual.flatMap((row, i) => row.map((v, j) => Math.abs(v - expected[i][j]))));
    assert.ok(error < 1e-9, `axis ${axis} angle ${angle}: error ${error}`);
  }
});
