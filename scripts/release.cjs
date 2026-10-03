'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function parse(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Invalid numeric version: ${version}`);
  const parts = version.split('.').map(Number);
  if (parts.some(part => !Number.isSafeInteger(part))) throw new Error('Version component is too large');
  return parts;
}
function compare(a, b) {
  const x = parse(a), y = parse(b);
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}
function maximum(versions, fallback) {
  return versions.reduce((best, version) => !best || compare(version, best) > 0 ? version : best, fallback);
}
function marketplaceVersions(extension) {
  if (!extension || !Array.isArray(extension.versions) || extension.versions.length === 0) {
    throw new Error('Marketplace returned no version history; refusing to guess a release version');
  }
  return extension.versions.map(entry => {
    parse(entry.version);
    const beta = entry.properties?.some(property => property.key === 'Microsoft.VisualStudio.Code.PreRelease' && property.value !== 'false');
    return { version: entry.version, channel: beta ? 'beta' : 'stable' };
  });
}
function planRelease({ channel, baseVersion, sourceSha, runNumber, bump = 'auto', published = [], checkpoints = [] }) {
  parse(baseVersion);
  if (!/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error('Expected a full source commit SHA');
  if (!['none', 'stable', 'beta'].includes(channel)) throw new Error('Invalid release channel');
  if (!['auto', 'minor', 'major'].includes(bump)) throw new Error('Invalid release increment');
  if (channel === 'none') return { channel, version: baseVersion, sourceSha, tag: '' };
  const increment = channel === 'stable' ? bump : 'auto';
  const previous = checkpoints.filter(entry => entry.sourceSha === sourceSha && entry.channel === channel
    && (entry.increment || 'auto') === increment).sort((a, b) => compare(b.version, a.version))[0];
  if (previous) {
    const publishedAlready = published.some(entry => entry.version === previous.version && entry.channel === channel);
    const latestPublished = maximum(published.map(entry => entry.version));
    if (publishedAlready || !latestPublished || compare(previous.version, latestPublished) > 0) {
      return { channel, version: previous.version, sourceSha, tag: previous.tag, increment };
    }
    // An unpublished reservation may become stale while testing. Keep its tag
    // immutable, but replan and retest a newer candidate on a full rerun.
  }
  const history = [...published, ...checkpoints];
  const stable = maximum(history.filter(entry => entry.channel === 'stable').map(entry => entry.version), baseVersion);
  const [major, minor, patch] = parse(stable);
  let version;
  if (channel === 'beta') {
    if (!Number.isSafeInteger(runNumber) || runNumber < 1) throw new Error('Expected a positive workflow run number');
    const highest = maximum(history.map(entry => entry.version), stable);
    const [highMajor, highMinor, highPatch] = parse(highest);
    const nextMinor = highMinor % 2 ? highMinor : highMinor + 1;
    const nextPatch = highMinor === nextMinor ? Math.max(runNumber, highPatch + 1) : runNumber;
    version = `${highMajor}.${nextMinor}.${nextPatch}`;
  } else {
    version = bump === 'major' ? `${major + 1}.0.0`
      : bump === 'minor' ? `${major}.${minor + (minor % 2 ? 1 : 2)}.0`
      : `${major}.${minor}.${patch + 1}`;
    // A stable release must overtake the beta so opted-in users can upgrade.
    const highest = maximum(history.map(entry => entry.version), stable);
    if (parse(version)[1] % 2 || compare(version, highest) <= 0) {
      const [highMajor, highMinor] = parse(highest);
      version = `${highMajor}.${highMinor + (highMinor % 2 ? 1 : 2)}.0`;
    }
  }
  return { channel, version, sourceSha, tag: channel === 'stable' ? `v${version}` : `beta/v${version}`, increment };
}
function shouldPublish(plan, published) {
  const same = published.filter(entry => entry.version === plan.version);
  if (same.length) {
    if (same.some(entry => entry.channel !== plan.channel)) throw new Error('Version already belongs to another Marketplace channel');
    return false;
  }
  const latest = maximum(published.map(entry => entry.version));
  if (latest && compare(plan.version, latest) <= 0) {
    throw new Error(`Marketplace advanced to ${latest}; rerun the entire workflow to plan and test a newer version`);
  }
  return true;
}
function git(args, cwd = process.cwd()) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}
function readCheckpoints(cwd = process.cwd()) {
  return git(['tag', '--list'], cwd).split('\n').filter(tag => /^(beta\/)?v\d+\.\d+\.\d+$/.test(tag)).map(tag => {
    const version = tag.replace(/^(beta\/)?v/, '');
    const text = git(['for-each-ref', '--format=%(contents)', `refs/tags/${tag}`], cwd);
    let metadata;
    try { metadata = JSON.parse(text); } catch { /* Existing release tags predate automation. */ }
    if (metadata?.version === version && metadata.tag === tag && /^[a-f0-9]{40}$/.test(metadata.sourceSha)
        && metadata.channel === (tag.startsWith('beta/') ? 'beta' : 'stable')) return metadata;
    // Legacy odd-minor tags came from the beta line. Marketplace properties
    // supply the actual channel when available; these tags only set a floor.
    return { tag, version, channel: tag.startsWith('beta/') || parse(version)[1] % 2 ? 'beta' : 'stable' };
  });
}
function createCheckpoint(plan, manifests, cwd = process.cwd()) {
  parse(plan.version);
  if (!/^[a-f0-9]{40}$/.test(plan.sourceSha)) throw new Error('Expected a full source commit SHA');
  const expected = plan.channel === 'stable' ? `v${plan.version}` : `beta/v${plan.version}`;
  if (plan.channel === 'none' || plan.tag !== expected) throw new Error('Invalid release tag');
  for (const name of ['package.json', 'package-lock.json']) {
    const json = JSON.parse(fs.readFileSync(path.join(manifests, name), 'utf8'));
    if (json.version !== plan.version || (name === 'package-lock.json' && json.packages[''].version !== plan.version)) {
      throw new Error('Release manifests do not match the tested version');
    }
  }
  const existing = readCheckpoints(cwd).find(entry => entry.tag === plan.tag);
  if (existing) {
    if (existing.sourceSha !== plan.sourceSha || existing.channel !== plan.channel) throw new Error('Release tag belongs to different source');
    return; // Retry uses its original immutable checkpoint.
  }
  git(['checkout', '--detach', plan.sourceSha], cwd);
  git(['config', 'user.name', 'github-actions[bot]'], cwd);
  git(['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com'], cwd);
  for (const name of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(manifests, name), path.join(cwd, name));
  git(['add', 'package.json', 'package-lock.json'], cwd);
  if (git(['diff', '--cached', '--name-only'], cwd)) git(['commit', '-m', `Release ${plan.tag}`], cwd);
  git(['tag', '-a', plan.tag, '-m', JSON.stringify(plan)], cwd);
  git(['push', 'origin', `refs/tags/${plan.tag}`], cwd);
}
function output(values) {
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(''));
  }
  console.log(JSON.stringify(values));
}
function main() {
  const command = process.argv[2];
  const planPath = process.env.RELEASE_PLAN_PATH;
  if (!planPath) throw new Error('RELEASE_PLAN_PATH is required');
  if (command === 'plan') {
    const channel = process.env.RELEASE_CHANNEL;
    const plan = planRelease({
      channel, baseVersion: JSON.parse(fs.readFileSync('package.json', 'utf8')).version,
      sourceSha: process.env.GITHUB_SHA, runNumber: Number(process.env.GITHUB_RUN_NUMBER),
      bump: process.env.RELEASE_BUMP || 'auto',
      published: channel === 'none' ? [] : marketplaceVersions(JSON.parse(fs.readFileSync(process.env.MARKETPLACE_PATH, 'utf8'))),
      checkpoints: channel === 'none' ? [] : readCheckpoints()
    });
    fs.writeFileSync(planPath, JSON.stringify(plan, null, 2) + '\n');
    output(plan);
  } else {
    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    if (command === 'checkpoint') createCheckpoint(plan, process.env.RELEASE_ARTIFACT_DIR);
    else if (command === 'verify') output({ should_publish: shouldPublish(plan, marketplaceVersions(JSON.parse(fs.readFileSync(process.env.MARKETPLACE_PATH, 'utf8')))) });
    else throw new Error('Expected plan, checkpoint, or verify');
  }
}
module.exports = { compare, marketplaceVersions, planRelease, shouldPublish, readCheckpoints, createCheckpoint };
if (require.main === module) main();
