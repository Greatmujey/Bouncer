#!/usr/bin/env node
// Optional real-client stdio handshake smoke test. No model login or API key.
// Caller installs pinned client CLIs outside the repo and supplies their paths.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const gemini = process.env.BOUNCER_GEMINI_BIN;
const claude = process.env.BOUNCER_CLAUDE_BIN;
if (!gemini || !claude) throw new Error('Set BOUNCER_GEMINI_BIN and BOUNCER_CLAUDE_BIN to installed client executables');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-mcp-clients-'));
const home = path.join(scratch, 'home');
const workspace = path.join(scratch, 'workspace');
fs.mkdirSync(home);
fs.mkdirSync(path.join(workspace, '.gemini'), { recursive: true });
// Test exact checked-in project configuration without letting the clients
// write local settings into the user's actual checkout.
fs.copyFileSync(path.join(root, '.gemini/settings.json'), path.join(workspace, '.gemini/settings.json'));
fs.copyFileSync(path.join(root, '.mcp.json'), path.join(workspace, '.mcp.json'));
fs.symlinkSync(path.join(root, 'bouncer'), path.join(workspace, 'bouncer'), 'dir');
// Never pass user's cloud or AI credentials to the clients or server.
const env = {
  HOME: home,
  PATH: process.env.PATH,
  LANG: 'C.UTF-8',
  NO_COLOR: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  GEMINI_CLI_NO_RELAUNCH: 'true',
  // Trust only this temporary test session, not the user's actual settings.
  GEMINI_CLI_TRUST_WORKSPACE: 'true',
};
function run(command, args) {
  const result = spawnSync(command, args, { cwd: workspace, env, encoding: 'utf8', timeout: 25_000 });
  if (result.error || result.status !== 0) throw new Error(`Client command failed: ${result.error?.message || result.status}\n${result.stderr}\n${result.stdout}`);
  return `${result.stdout}\n${result.stderr}`.replace(/\x1b\[[0-9;]*m/g, '');
}
try {
  const geminiStatus = run(gemini, ['mcp', 'list']);
  assert.match(geminiStatus, /bouncer:.*Connected/, 'Gemini CLI did not connect with project config');
  console.log('Gemini CLI: project-configured stdio server connected.');

  const pending = run(claude, ['mcp', 'list']);
  assert.match(pending, /bouncer:.*Pending approval/, 'Claude Code project server must remain subject to approval');
  // Explicit local registration only in the disposable HOME tests a real
  // handshake without bypassing or changing the project approval flow.
  run(claude, ['mcp', 'add', '--scope', 'local', 'bouncer-smoke', '--', process.execPath, path.join(root, 'bouncer/mcp/server.mjs')]);
  const claudeStatus = run(claude, ['mcp', 'list']);
  assert.match(claudeStatus, /bouncer-smoke:.*Connected/, 'Claude Code did not connect via stdio');
  console.log('Claude Code: project server awaits approval; local test server connected.');
  console.log('No model inference, real user account or ChatGPT web connection was tested.');
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
