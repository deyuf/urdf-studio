import { strict as assert } from 'node:assert';
import test from 'node:test';
import { expandedUrdfName, isXacroPath } from '../../src/core/sourceSave';

test('isXacroPath recognises xacro documents only', () => {
  assert.equal(isXacroPath('/ws/robots/arm.urdf.xacro'), true);
  assert.equal(isXacroPath('arm.XACRO'), true);
  assert.equal(isXacroPath('arm.urdf'), false);
  assert.equal(isXacroPath('xacro_notes.txt'), false);
});

test('expandedUrdfName never yields a .xacro name', () => {
  assert.equal(expandedUrdfName('fr3.urdf.xacro'), 'fr3.urdf');
  assert.equal(expandedUrdfName('hand.xacro'), 'hand.urdf');
  assert.equal(expandedUrdfName('arm.urdf'), 'arm.urdf');
  assert.equal(expandedUrdfName('.xacro'), 'robot.urdf');
});
