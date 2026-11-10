import { strict as assert } from 'node:assert';
import test from 'node:test';
import { rankTipLinks } from '../../src/renderer/logic/tipLinks';

const link = (name: string, parentJoint?: string, childJoints: string[] = []) => ({ name, parentJoint, childJoints });
const joint = (name: string, parent: string, child: string, type = 'revolute') => ({ name, parent, child, type });

test('a tool point comes first, then the deepest movable chain, then sensors on the base', () => {
  const metadata = {
    links: {
      base: link('base', undefined, ['j1', 'sensor_joint']),
      sensor: link('sensor', 'sensor_joint'),
      l1: link('l1', 'j1', ['j2']),
      l2: link('l2', 'j2', ['flange_joint']),
      flange: link('flange', 'flange_joint', ['tcp_joint', 'finger_joint']),
      tcp: link('tcp', 'tcp_joint'),
      finger: link('finger', 'finger_joint')
    },
    joints: {
      sensor_joint: joint('sensor_joint', 'base', 'sensor', 'fixed'),
      j1: joint('j1', 'base', 'l1'),
      j2: joint('j2', 'l1', 'l2'),
      flange_joint: joint('flange_joint', 'l2', 'flange', 'fixed'),
      tcp_joint: joint('tcp_joint', 'flange', 'tcp', 'fixed'),
      finger_joint: joint('finger_joint', 'flange', 'finger', 'prismatic')
    }
  };
  // tcp is named like a tool point; finger has 3 movable joints. The sensor
  // is bolted to the base (no movable joint), so it is not offered at all.
  assert.deepEqual(rankTipLinks(metadata as never), ['tcp', 'finger']);
});

test('without a tool-point name, the end of the longest movable chain wins', () => {
  const metadata = {
    links: {
      base: link('base', undefined, ['j1', 's']),
      imu: link('imu', 's'),
      hand: link('hand', 'j1')
    },
    joints: { j1: joint('j1', 'base', 'hand'), s: joint('s', 'base', 'imu', 'fixed') }
  };
  assert.deepEqual(rankTipLinks(metadata as never), ['hand']);
});

test('if nothing moves, the leaf links are still offered', () => {
  const metadata = {
    links: { base: link('base', undefined, ['s']), imu: link('imu', 's') },
    joints: { s: joint('s', 'base', 'imu', 'fixed') }
  };
  assert.deepEqual(rankTipLinks(metadata as never), ['imu']);
});

test('a cyclic parent chain does not loop forever', () => {
  const metadata = {
    links: { a: link('a', 'ja'), b: link('b', 'jb', []) },
    joints: { ja: joint('ja', 'b', 'a'), jb: joint('jb', 'a', 'b') }
  };
  assert.ok(Array.isArray(rankTipLinks(metadata as never)));
});
