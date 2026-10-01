import { strict as assert } from 'node:assert';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const { planRelease, shouldPublish, marketplaceVersions, createCheckpoint, readCheckpoints } = require('../../scripts/release.cjs');
const sourceSha = 'a'.repeat(40);
const stable = { version: '0.4.2', channel: 'stable' };
const beta = { version: '0.5.132', channel: 'beta' };
const plan = (overrides: Record<string, unknown> = {}) => planRelease({
  channel: 'stable', baseVersion: '0.4.2', sourceSha, runNumber: 134,
  published: [stable, beta], ...overrides
});

test('stable release overtakes published beta and keeps an even minor', () => {
  assert.equal(plan().version, '0.6.0');
});
test('stable release increments the published stable patch without a manual manifest bump', () => {
  assert.equal(plan({ published: [stable, { version: '0.6.0', channel: 'stable' }] }).version, '0.6.1');
});
test('major and even-minor increments are available for manual dispatch', () => {
  assert.equal(plan({ bump: 'major' }).version, '1.0.0');
  assert.equal(plan({ published: [{ version: '0.6.2', channel: 'stable' }], bump: 'minor' }).version, '0.8.0');
});
test('new beta follows the highest stable release and the workflow run number', () => {
  assert.equal(plan({ channel: 'beta', published: [{ version: '0.6.0', channel: 'stable' }] }).version, '0.7.134');
});
test('beta remains monotonic if workflow run numbers reset or older beta tags exist', () => {
  assert.equal(plan({ channel: 'beta', runNumber: 100 }).version, '0.5.133');
  assert.equal(plan({ channel: 'beta', checkpoints: [{ version: '0.7.200', channel: 'beta' }] }).version, '0.7.201');
});
test('reruns reuse a checkpoint for the same source and channel', () => {
  const checkpoint = { ...plan(), tag: 'v0.6.0' };
  assert.deepEqual(plan({ runNumber: 999, checkpoints: [checkpoint] }), checkpoint);
  assert.notEqual(plan({ channel: 'beta', checkpoints: [checkpoint] }).tag, checkpoint.tag);
});
test('an unpublished stale checkpoint is replanned above newer releases', () => {
  const checkpoint = plan();
  assert.equal(plan({ checkpoints: [checkpoint], published: [{ version: '0.7.140', channel: 'beta' }] }).version, '0.8.0');
  assert.deepEqual(plan({ checkpoints: [checkpoint], published: [{ version: '0.6.0', channel: 'stable' }, { version: '0.7.140', channel: 'beta' }] }), checkpoint);
});
test('a deliberate major dispatch differs from a default retry of the same source', () => {
  const checkpoint = plan();
  assert.equal(plan({ checkpoints: [checkpoint], published: [{ version: '0.6.0', channel: 'stable' }], bump: 'major' }).version, '1.0.0');
});
test('PR and ordinary branches keep the source version without a release tag', () => {
  assert.deepEqual(plan({ channel: 'none' }), { channel: 'none', version: '0.4.2', sourceSha, tag: '' });
});
test('Marketplace channel properties and platform duplicates are handled', () => {
  const versions = marketplaceVersions({ versions: [
    { version: '0.4.2' },
    { version: '0.5.132', properties: [{ key: 'Microsoft.VisualStudio.Code.PreRelease', value: 'true' }] },
    { version: '0.5.132', properties: [{ key: 'Microsoft.VisualStudio.Code.PreRelease', value: 'true' }] }
  ] });
  assert.equal(shouldPublish({ channel: 'beta', version: '0.5.132' }, versions), false);
});
test('a partially published version is skipped on retry, without republishing', () => {
  assert.equal(shouldPublish(plan(), [{ version: '0.6.0', channel: 'stable' }]), false);
  assert.equal(shouldPublish(plan(), [stable, beta]), true);
});
test('stale plans and cross-channel version reuse fail before publishing', () => {
  assert.throws(() => shouldPublish(plan(), [{ version: '0.7.140', channel: 'beta' }]), /Marketplace advanced/);
  assert.throws(() => shouldPublish({ version: '0.5.132', channel: 'stable' }, [beta]), /another Marketplace channel/);
});
test('missing Marketplace history and malformed release inputs fail closed', () => {
  assert.throws(() => marketplaceVersions({ versions: [] }), /no version history/);
  assert.throws(() => plan({ baseVersion: '0.4.2-rc.1' }), /Invalid numeric/);
  assert.throws(() => plan({ sourceSha: 'main' }), /source commit/);
  assert.throws(() => plan({ bump: 'anything' }), /increment/);
  assert.throws(() => plan({ channel: 'beta', runNumber: 0 }), /run number/);
});

test('checkpoint tags tested manifests, preserves main, and is immutable on retry', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'urdf-release-'));
  const repo = path.join(dir, 'repo'), remote = path.join(dir, 'remote.git'), artifacts = path.join(dir, 'artifacts');
  mkdirSync(repo); mkdirSync(artifacts);
  const git = (args: string[], cwd = repo) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git(['init', '--bare', remote], dir);
    git(['init', '-b', 'main']);
    git(['config', 'user.name', 'Test']); git(['config', 'user.email', 'test@example.com']);
    writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ version: '0.4.2' }));
    writeFileSync(path.join(repo, 'package-lock.json'), JSON.stringify({ version: '0.4.2', packages: { '': { version: '0.4.2' } } }));
    git(['add', '.']); git(['commit', '-m', 'Source']); git(['remote', 'add', 'origin', remote]);
    const sha = git(['rev-parse', 'HEAD']);
    const release = plan({ sourceSha: sha });
    writeFileSync(path.join(artifacts, 'package.json'), JSON.stringify({ version: release.version }));
    writeFileSync(path.join(artifacts, 'package-lock.json'), JSON.stringify({ version: release.version, packages: { '': { version: release.version } } }));
    createCheckpoint(release, artifacts, repo);
    assert.equal(git(['rev-parse', 'main']), sha);
    assert.equal(JSON.parse(git(['show', `${release.tag}:package.json`])).version, '0.6.0');
    assert.deepEqual(readCheckpoints(repo), [release]);
    const tag = git(['rev-parse', release.tag]);
    createCheckpoint(release, artifacts, repo);
    assert.equal(git(['rev-parse', release.tag]), tag);
    assert.throws(() => createCheckpoint({ ...release, sourceSha }, artifacts, repo), /different source/);
    assert.equal(JSON.parse(readFileSync(path.join(artifacts, 'package-lock.json'), 'utf8')).version, release.version);
    writeFileSync(path.join(artifacts, 'package.json'), JSON.stringify({ version: '9.0.0' }));
    assert.throws(() => createCheckpoint(release, artifacts, repo), /manifests do not match/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
