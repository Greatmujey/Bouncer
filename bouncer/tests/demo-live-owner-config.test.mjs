import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import nearApi from 'near-api-js';

const { KeyPair } = nearApi;

const { resolveDemoOwnerConfig } = await import('../demo-owner-config.mjs');

test('resolveDemoOwnerConfig uses the funded owner and reads its matching local key', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-owner-config-'));
  const pair = KeyPair.fromRandom('ed25519');
  const dir = path.join(home, '.near-credentials', 'testnet');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const credPath = path.join(dir, 'great_mujey.testnet.json');
  fs.writeFileSync(credPath, JSON.stringify({ account_id: 'great_mujey.testnet', private_key: pair.toString() }, null, 2), { mode: 0o600 });

  const config = resolveDemoOwnerConfig({ env: {}, home });
  assert.equal(config.accountId, 'great_mujey.testnet');
  assert.equal(String(config.keyPair.getPublicKey()), String(pair.getPublicKey()));
  assert.match(config.contractAccountId, /^bouncer-[a-f0-9]{6}\.great_mujey\.testnet$/);
});

test('resolveDemoOwnerConfig fails closed when the funded owner credential is absent', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-owner-config-fallback-'));
  assert.throws(() => resolveDemoOwnerConfig({ env: {}, home }), /No local NEAR testnet credential for great_mujey\.testnet/);
});
