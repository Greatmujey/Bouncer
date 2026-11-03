#!/usr/bin/env node
/** Run the V12 diagnostic harness on a NEW loopback-only nearcore chain.
 * Synthetic token, stand-in receiver and ephemeral keys only. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import nearApi from 'near-api-js';
import { startSandbox, stopSandboxChild } from './v11-nearcore-sandbox.mjs';
import { readVerifiedFile, SANDBOX_SHA256, MOCK_FT_SHA256 } from './v11-sandbox-support.mjs';
import { exerciseSandboxOutlayerBurn } from './v12-sandbox-outlayer-burn.mjs';

const binary = process.env.BOUNCER_SANDBOX_BIN;
readVerifiedFile(binary, SANDBOX_SHA256);
const wasm = fs.readFileSync(process.env.BOUNCER_V12_WASM_PATH);
const mockFt = readVerifiedFile(process.env.BOUNCER_MOCK_FT_WASM_PATH, MOCK_FT_SHA256, { maxBytes: 4 * 1024 * 1024 });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-v12-ol-sandbox-'));
const genesisKey = nearApi.KeyPair.fromRandom('ed25519');
let sandbox;
try {
  sandbox = await startSandbox(binary, dir, String(genesisKey.getPublicKey()));
  const root = new nearApi.Account('testnet', sandbox.provider, new nearApi.KeyPairSigner(sandbox.rootKey));
  const result = await exerciseSandboxOutlayerBurn({ rpcUrl: sandbox.rpcUrl, root, wasm, mockFt });
  console.log(JSON.stringify(result, null, 2));
} finally {
  if (sandbox) await stopSandboxChild(sandbox.child);
  fs.rmSync(dir, { recursive: true, force: true });
}
