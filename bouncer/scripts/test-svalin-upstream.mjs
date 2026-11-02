#!/usr/bin/env node
/**
 * OPTIONAL offline interoperability test against a separately downloaded,
 * pinned Svalin source tree. This is a drift check, not a supply-chain audit:
 * the separately installed pnpm dependencies and Node runtime are trusted.
 * No third-party source or dependencies are copied into the Bouncer repository.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PIN = '7ebfb14f35630dfc1665b04993e684b5444133fb';
const SOURCE_DIGEST = 'd29f77ef96027f70c0964fb12fabca9608cb2fe097fe15136f13585878741130';
const BUILD_DIGEST = 'bdb20687e70cc2260c899a2041a7f3d428ab981932c432f06e2e78fa646446ab';
const IGNORED = new Set(['.git', 'node_modules', 'dist', '.pnpm-store', '.turbo', '.next', 'coverage']);

// Hash path, length and bytes in stable path order. Check the complete source
// tree and the two generated workspace packages used by the server. Installed
// node_modules are deliberately outside this digest; use a trusted install.
export function treeDigest(root, roots, source) {
  const files = [];
  function walk(relative) {
    const stat = fs.lstatSync(path.join(root, relative));
    if (stat.isSymbolicLink()) throw new Error('unexpected symbolic link in checked source/build tree');
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(path.join(root, relative)).sort()) {
        if (source && (IGNORED.has(name) || name.endsWith('.tsbuildinfo'))) continue;
        walk(path.posix.join(relative, name));
      }
    } else if (stat.isFile()) files.push(relative);
    else throw new Error('unexpected entry in checked source/build tree');
  }
  for (const item of roots) walk(item);
  files.sort();
  const digest = crypto.createHash('sha256');
  for (const relative of files) {
    const content = fs.readFileSync(path.join(root, relative));
    digest.update(`${Buffer.byteLength(relative)}:${relative}:${content.length}:`);
    digest.update(content);
  }
  return { files: files.length, sha256: digest.digest('hex') };
}

export function checkedSvalinSource(input) {
  if (typeof input !== 'string' || !input) throw new Error('set BOUNCER_SVALIN_SOURCE to the separately installed pinned source tree');
  const root = fs.realpathSync(input);
  const source = treeDigest(root, [''], true);
  if (source.files !== 161 || source.sha256 !== SOURCE_DIGEST) throw new Error(`Svalin source differs from pinned commit ${PIN}`);
  const build = treeDigest(root, ['packages/shared/dist', 'packages/chain-config/dist'], false);
  if (build.files !== 18 || build.sha256 !== BUILD_DIGEST) throw new Error('Svalin workspace build is missing or differs from the pinned build');
  const loader = path.join(root, 'apps/api/node_modules/tsx/dist/loader.mjs');
  if (!fs.statSync(loader).isFile()) throw new Error('Svalin tsx loader is missing');
  return { root, loader };
}

function main() {
  const { root, loader } = checkedSvalinSource(process.env.BOUNCER_SVALIN_SOURCE);
  const bouncer = fileURLToPath(new URL('../', import.meta.url));
  const test = fileURLToPath(new URL('../tests/svalin-upstream/interop.test.mjs', import.meta.url));
  console.log(`Testing pinned Svalin source ${PIN} with simulated chain, indexer and sample portfolio; no live service or blockchain.`);
  const result = spawnSync(process.execPath, ['--import', loader, '--test', test], {
    cwd: bouncer, stdio: 'inherit', timeout: 60_000,
    env: { ...process.env, BOUNCER_SVALIN_SOURCE: root },
  });
  if (result.error) throw result.error;
  if (result.signal || result.status !== 0) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (error) { console.error(`Svalin source interoperability test not run: ${error.message}`); process.exitCode = 1; }
}
