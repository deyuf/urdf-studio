import { strict as assert } from 'node:assert';
import test from 'node:test';
import { expandedUrdfFileName, isXacroPath } from '../../src/core/sourceSave';

test('isXacroPath recognises xacro source regardless of directory or case', () => {
  assert.equal(isXacroPath('/ws/robot.xacro'), true);
  assert.equal(isXacroPath('/ws/robots/fr3/fr3.urdf.xacro'), true);
  assert.equal(isXacroPath('C:\\ws\\Robot.XACRO'), true);
  assert.equal(isXacroPath('/ws/robot.urdf'), false);
  assert.equal(isXacroPath('/ws/xacro/robot.urdf'), false);
  assert.equal(isXacroPath('/ws/robot.xacro.bak'), false);
});

test('expandedUrdfFileName swaps the xacro extension for .urdf', () => {
  assert.equal(expandedUrdfFileName('robot.xacro'), 'robot.urdf');
  assert.equal(expandedUrdfFileName('fr3.urdf.xacro'), 'fr3.urdf');
  assert.equal(expandedUrdfFileName('Arm.URDF.XACRO'), 'Arm.urdf');
  assert.equal(expandedUrdfFileName('.xacro'), 'robot.urdf');
});

test('expandedUrdfFileName never yields a xacro name and leaves plain URDF untouched', () => {
  for (const name of ['a.xacro', 'a.urdf.xacro', 'a.xacro.xacro']) {
    assert.equal(isXacroPath(expandedUrdfFileName(name)), false, name);
  }
  assert.equal(expandedUrdfFileName('robot.urdf'), 'robot.urdf');
});
