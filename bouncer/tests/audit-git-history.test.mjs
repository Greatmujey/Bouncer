import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scanner = fileURLToPath(new URL('../scripts/audit-git-history.py', import.meta.url));
function git(repo, ...args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-history-test-'));
  const repo = path.join(dir, 'repo'); fs.mkdirSync(repo);
  git(repo, 'init', '--quiet'); git(repo, 'config', 'user.name', 'Test Contributor');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  return { dir, repo, clean: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
function commit(repo, message) { git(repo, 'add', '-A'); git(repo, 'commit', '--quiet', '-m', message); }
function scan(repo, ...args) {
  return spawnSync('python3', [scanner, ...args], { cwd: repo, encoding: 'utf8' });
}

test('finds a deleted historical credential without printing or saving its value', () => {
  const f = fixture();
  try {
    const fake = 'ed' + '25519:' + '2'.repeat(87); // synthetic; never a real credential
    fs.writeFileSync(path.join(f.repo, 'old.txt'), `private_key = "${fake}"\n`);
    commit(f.repo, 'add historical fixture');
    fs.unlinkSync(path.join(f.repo, 'old.txt')); fs.writeFileSync(path.join(f.repo, 'safe.txt'), 'safe\n');
    commit(f.repo, 'remove historical fixture');
    git(f.repo, 'remote', 'add', 'inspect', f.repo);
    const report = path.join(f.dir, 'review.json'), out = scan(f.repo, '--remote', 'inspect', '--report', report);
    assert.equal(out.status, 1, out.stderr);
    assert.equal(out.stdout.includes(fake), false); assert.equal(out.stderr.includes(fake), false);
    const summary = JSON.parse(out.stdout);
    assert.equal(summary.status, 'PATTERN_MATCHES_REVIEW_REQUIRED');
    assert.ok(summary.matches_by_pattern.near_ed25519_secret >= 1);
    assert.equal(summary.remote_refs_requested, true); assert.equal(summary.private_report_written, true);
    const reportText = fs.readFileSync(report, 'utf8');
    assert.ok(reportText.includes('old.txt')); assert.equal(reportText.includes(fake), false);
    assert.equal(fs.statSync(report).mode & 0o777, 0o600);
    const again = scan(f.repo, '--report', report);
    assert.equal(again.status, 2, 'a report may not overwrite existing recovery material');
    assert.equal(fs.readFileSync(report, 'utf8'), reportText);
    assert.equal(scan(f.repo, '--report', path.join(f.repo, 'report.json')).status, 2);
  } finally { f.clean(); }
});

test('no pattern matches still requires manual review and reports skipped binaries and large blobs', () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.repo, 'safe.txt'), 'ordinary text\n');
    fs.writeFileSync(path.join(f.repo, 'binary.bin'), Buffer.from([0, 1, 2, 3]));
    fs.writeFileSync(path.join(f.repo, 'large.txt'), Buffer.alloc(3_000_001, 0x78));
    commit(f.repo, 'safe fixture');
    const out = scan(f.repo);
    assert.equal(out.status, 0, out.stderr);
    const summary = JSON.parse(out.stdout);
    assert.equal(summary.status, 'NO_PATTERN_MATCHES_MANUAL_REVIEW_REQUIRED');
    assert.equal(summary.binary_blobs_skipped, 1); assert.equal(summary.oversize_blobs_skipped, 1);
    assert.ok(summary.not_scanned.includes('Actions artifacts and logs'));
  } finally { f.clean(); }
});

test('fails closed for a shallow checkout or a remote ref missing locally', () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.repo, 'safe.txt'), 'first\n'); commit(f.repo, 'first');
    fs.writeFileSync(path.join(f.repo, 'safe.txt'), 'second\n'); commit(f.repo, 'second');
    const shallow = path.join(f.dir, 'shallow');
    execFileSync('git', ['clone', '--quiet', '--depth=1', `file://${f.repo}`, shallow]);
    const out = scan(shallow);
    assert.equal(out.status, 2); assert.match(out.stderr, /shallow checkout/);
    const clone = path.join(f.dir, 'clone');
    execFileSync('git', ['clone', '--quiet', '--no-hardlinks', f.repo, clone]);
    fs.writeFileSync(path.join(f.repo, 'safe.txt'), 'third\n'); commit(f.repo, 'third');
    const missing = scan(clone, '--remote', 'origin');
    assert.equal(missing.status, 2); assert.match(missing.stderr, /Git read failed/);
    assert.equal(scan(clone, '--remote', '--upload-pack=bad').status, 2);
  } finally { f.clean(); }
});
