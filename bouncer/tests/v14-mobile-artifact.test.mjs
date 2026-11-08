import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import nearApi from 'near-api-js';
import { inspectV14MobileArtifact, METEOR_MOBILE_BRIDGE_LIMIT } from '../scripts/inspect-v14-mobile-artifact.mjs';

const magic = Buffer.from([0,97,115,109,1,0,0,0]);
const marker = Buffer.from('bouncer-agent-v14-native-storage-testnet');
const stub = size => Buffer.concat([magic, marker, Buffer.alloc(size - magic.length - marker.length)]);

test('V14 artifact inspection reports a necessary Meteor size bound, not compatibility', () => {
  const bytes = stub(300_001), result = inspectV14MobileArtifact(bytes);
  assert.equal(result.wasm_bytes, bytes.length);
  assert.equal(result.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
  assert.equal(result.near_code_hash, nearApi.utils.serialize.base_encode(Buffer.from(result.sha256, 'hex')));
  assert.equal(result.raw_base64_bytes, bytes.toString('base64').length);
  assert.equal(METEOR_MOBILE_BRIDGE_LIMIT, 400_000);
  assert.equal(result.raw_code_field_exceeds_meteor_limit, true);
  assert.ok(result.experimental_deflate_base64_bytes < result.raw_base64_bytes);
  assert.match(result.limitations, /No wallet compatibility/);
  assert.equal(inspectV14MobileArtifact(stub(299_997)).raw_code_field_exceeds_meteor_limit, false);
});

test('rejects missing V14 marker, invalid header and unbounded inputs', () => {
  for (const bytes of [null, Buffer.alloc(0), marker, Buffer.concat([magic, Buffer.from('v9')]), Buffer.alloc(20_000_001)]) {
    assert.throws(() => inspectV14MobileArtifact(bytes));
  }
});

test('research loader pin is derived only from explicit local V14 bytes and cannot overwrite a file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'bouncer-v14-loader-pin-'));
  try {
    const wasm = path.join(dir,'v14.wasm'), pin = path.join(dir,'pin.rs'), bytes = stub(99);
    fs.writeFileSync(wasm, bytes);
    const script = new URL('../scripts/write-v14-loader-research-pin.mjs',import.meta.url).pathname;
    const run = () => spawnSync(process.execPath,[script,wasm,pin],{encoding:'utf8'});
    assert.equal(run().status,0);
    const source = fs.readFileSync(pin,'utf8');
    assert.match(source,/const CODE_LEN: usize = 99;/);
    const digest = crypto.createHash('sha256').update(bytes).digest();
    for (const byte of digest) assert.ok(source.includes(`0x${byte.toString(16).padStart(2,'0')}`));
    assert.notEqual(run().status,0); assert.equal(fs.readFileSync(pin,'utf8'),source);
    fs.writeFileSync(wasm,Buffer.from('bad'));
    assert.notEqual(spawnSync(process.execPath,[script,wasm,path.join(dir,'bad.rs')],{encoding:'utf8'}).status,0);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
