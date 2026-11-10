import { strict as assert } from 'node:assert';
import test from 'node:test';
import { expandedUrdfName, isGeneratedSourcePath } from '../../src/core/sourceSave';

test('isGeneratedSourcePath is true for xacro and MJCF documents only', () => {
  assert.equal(isGeneratedSourcePath('/ws/robots/arm.urdf.xacro'), true);
  assert.equal(isGeneratedSourcePath('arm.XACRO'), true);
  assert.equal(isGeneratedSourcePath('/menagerie/panda/scene.xml'), true);
  assert.equal(isGeneratedSourcePath('humanoid.mjcf'), true);
  assert.equal(isGeneratedSourcePath('arm.urdf'), false);
  assert.equal(isGeneratedSourcePath('xacro_notes.txt'), false);
});

test('expandedUrdfName never yields a source-format name', () => {
  assert.equal(expandedUrdfName('fr3.urdf.xacro'), 'fr3.urdf');
  assert.equal(expandedUrdfName('hand.xacro'), 'hand.urdf');
  assert.equal(expandedUrdfName('panda.xml'), 'panda.urdf');
  assert.equal(expandedUrdfName('humanoid.mjcf'), 'humanoid.urdf');
  assert.equal(expandedUrdfName('arm.urdf'), 'arm.urdf');
  assert.equal(expandedUrdfName('.xacro'), 'robot.urdf');
});
