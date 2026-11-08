#!/usr/bin/env node
// Netlify can restore a previous dist directory from its build cache. Prepare
// a fresh allowlisted site first, then replace only this project's generated
// dist. No cached or unrelated files are published. The general staging helper
// remains exclusive and refuses to write into an existing destination.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stagePublicWeb } from './stage-public-web.mjs';

const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));

export function stageNetlifyPublicWeb(projectRoot = PROJECT_ROOT, options = {}) {
  const root = path.resolve(projectRoot);
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Project root must be a real directory');
  const destination = path.join(root, 'dist');
  // Keep the temporary directory on the same filesystem so the final rename
  // cannot fail just because /tmp is on a different mount.
  const temporary = fs.mkdtempSync(path.join(root, '.netlify-stage-'));
  try {
    const staged = path.join(temporary, 'site');
    // Validate and stage before touching the prior output. A failed build will
    // not publish or erase it. rmSync unlinks symlinks, rather than following
    // them, and its target is the fixed build-output path under projectRoot.
    const files = stagePublicWeb(staged, path.join(root, 'web'), options);
    fs.rmSync(destination, { recursive:true, force:true });
    fs.renameSync(staged, destination);
    return files;
  } finally {
    fs.rmSync(temporary, { recursive:true, force:true });
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  if (process.argv.length !== 2) throw new Error('Usage: node stage-netlify-public-web.mjs');
  const files = stageNetlifyPublicWeb();
  console.log(`Replaced Netlify dist with ${files.length} reviewed public website files. No mission backend was deployed.`);
}
