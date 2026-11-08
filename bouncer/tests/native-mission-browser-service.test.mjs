// All keys, RPC views, backend and mission results here are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import nearApi from 'near-api-js';
import { FileJournal } from '../agent/procurement.mjs';
import { ORACLE_TESTNET_PROJECT } from '../agent/oracle-outlayer.mjs';
import { createAuthenticatedNativeMissionService } from '../agent/authenticated-native-mission-service.mjs';
import { createNativeMissionHttpServer } from '../agent/native-mission-http.mjs';
import { nativeMissionApprovalMessage } from '../web-src/native-mission-auth.mjs';
import { createNativeMissionClient, validatePublicNativeMissionReview } from '../web-src/native-mission-client.mjs';
import { nep413Payload } from '../web-src/cli-login.mjs';

const site = 'https://bouncer.example', owner = 'owner.testnet', vault = 'vault.testnet';
const codeHash = nearApi.utils.serialize.base_encode(Buffer.alloc(32, 42));
const program = { url: 'https://example.test/random.wasm', sha256: 'a'.repeat(64), build_target: 'wasm32-wasip1',
  max_instructions: 10_000_000, max_memory_mb: 128, max_execution_seconds: 60 };
const route = { project: { ...ORACLE_TESTNET_PROJECT }, route_revision: 1, policy_revision: 1, payee_revision: 1, active: true };
const storageRoute = { prefix: 'mission-', max_value_bytes: 4096, route_revision: 1, policy_revision: 1, payee_revision: 1, active: true };
const mission = { version: 1, id: 'browser-test', contract_id: vault, owner_account_id: owner, max_native_amount: '300',
  required_resources: ['compute','storage','api'], goals: [
    { kind:'random', goal: { id:'compute', contract_id:vault, owner_account_id:owner, policy_id:'compute', amount:'100', input:{min:1,max:10}, program } },
    { kind:'oracle', goal: { id:'price', contract_id:vault, owner_account_id:owner, policy_id:'price', amount:'100', route, max_age_seconds:300 } },
    { kind:'storage', goal: { id:'store', contract_id:vault, contract_code_hash:codeHash, owner_account_id:owner, policy_id:'storage', amount:'100',
      object_id:'mission-1', value:{from_goal_ids:['compute','price']}, route:storageRoute } },
  ] };
const digest = x => crypto.createHash('sha256').update(x).digest('hex');
function testAuthenticator(pair) {
  const issued = new Map(); let next = 1;
  return {
    async issue(action) {
      const id = (next++).toString(16).padStart(32, '0'), nonce = crypto.randomBytes(32), now = Date.now(), expires = now + 120_000;
      const actionDigest = digest(JSON.stringify(action));
      const challenge = { challenge_id: id, nonce_base64: nonce.toString('base64'), recipient:'bouncer.example',
        message: nativeMissionApprovalMessage(action, actionDigest, site, now, expires), expires_at_ms:expires };
      issued.set(id, { action: structuredClone(action), nonce, challenge, used:false }); return challenge;
    },
    async authenticate({ action, evidence }) {
      const row = issued.get(evidence?.challenge_id);
      if (!row || row.used || JSON.stringify(row.action) !== JSON.stringify(action) || evidence.accountId !== owner || evidence.publicKey !== String(pair.getPublicKey())) return false;
      const data = nep413Payload({ message:row.challenge.message, nonce:new Uint8Array(row.nonce), recipient:row.challenge.recipient });
      const hash = crypto.createHash('sha256').update(data).digest();
      if (!pair.getPublicKey().verify(hash, Buffer.from(evidence.signature, 'base64'))) return false;
      row.used = true; return true;
    },
  };
}
async function fixture({ blocked = false, executeThrows = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-mission-browser-'));
  const journal = new FileJournal(path.join(dir,'journal.json'), vault, owner);
  const ownerKey = nearApi.KeyPair.fromRandom('ed25519'), ownerPublicKey = String(ownerKey.getPublicKey());
  const auth = testAuthenticator(ownerKey), signers = Object.fromEntries(mission.goals.map(({goal}) => [goal.id, { account:{}, publicKey:'synthetic' }]));
  let previews = 0, runs = 0, recovers = 0, prompts = 0, evidenceSeen;
  const run = async options => {
    assert.deepEqual(options.mission, mission);
    if (options.recoverOnly) { recovers++; assert.deepEqual(options.signers, {}); return {status:'RECOVERED',new_payments:0,deliveries:[]}; }
    if (!options.execute) { previews++; return { status:blocked?'BLOCKED':'READY', budget:{required_yocto:'300'} }; }
    runs++; if (executeThrows) throw Error('synthetic lost acknowledgement');
    return {status:'FULFILLED',new_payments:3,deliveries:[],note:'synthetic only'};
  };
  const service = createAuthenticatedNativeMissionService({ mission, provider:{}, signers, journal, auth, run });
  const server = createNativeMissionHttpServer({ service, siteOrigin:site });
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const local = `http://127.0.0.1:${server.address().port}`;
  const browserFetch = async (url, options = {}) => {
    if (url === 'https://test.rpc.fastnear.com') return new Response(JSON.stringify({ jsonrpc:'2.0', id:'bouncer-cli-login', result:{permission:'FullAccess'} }));
    assert.ok(typeof url === 'string' && url.startsWith('/api/native-mission/'));
    if (url.endsWith('/execute')) evidenceSeen = JSON.parse(options.body).evidence;
    return fetch(`${local}${url}`, { ...options, headers:{...options.headers,origin:site} });
  };
  const wallet = { manifest:{id:'meteor-wallet'}, async signMessage({message,nonce,recipient,signerId}) {
    prompts++; assert.equal(signerId,owner); assert.equal(recipient,'bouncer.example');
    const bytes = nep413Payload({message,nonce,recipient}), hash = crypto.createHash('sha256').update(bytes).digest();
    return {accountId:owner,publicKey:ownerPublicKey,signature:Buffer.from(ownerKey.sign(hash).signature).toString('base64')};
  } };
  const client = createNativeMissionClient({ wallet, accountId:owner, ownerPublicKey, location:{origin:site,host:'bouncer.example'},
    crypto:crypto.webcrypto, fetch:browserFetch });
  return { client, service, server, auth, ownerPublicKey, local, wallet, browserFetch,
    get previews(){return previews}, get runs(){return runs}, get recovers(){return recovers}, get prompts(){return prompts},
    get evidence(){return evidenceSeen}, async close(){await new Promise(resolve=>server.close(resolve)); journal.close(); fs.rmSync(dir,{recursive:true,force:true})} };
}
async function use(fn, options) { const f=await fixture(options); try { await fn(f); } finally { await f.close(); } }

test('browser reviews exact mission, signs explicit consent once, runs fixed backend and can recover without signing', () => use(async f => {
  const {review,preview} = await f.client.preview();
  assert.equal(preview.status,'READY'); assert.equal(f.runs,0); assert.equal(f.prompts,0);
  assert.equal(review.mission.owner_account_id,owner); assert.ok(Object.isFrozen(review.mission.goals[0].goal));
  const result = await f.client.approve(review);
  assert.equal(result.status,'FULFILLED'); assert.equal(f.prompts,1); assert.equal(f.runs,1);
  assert.equal((await f.client.recover(review)).status,'RECOVERED');
  assert.equal(f.runs,1); assert.equal(f.prompts,1); assert.equal(f.recovers,1);
  await assert.rejects(f.client.approve(review), /UNAVAILABLE/);
  await assert.rejects(f.service.execute({missionSha256:review.mission_sha256,ownerPublicKey:f.ownerPublicKey,evidence:f.evidence}), /reconcile/);
  assert.equal(f.runs,1);
}));

test('blocked preflight, mismatched review and wrong account never open a wallet or run', () => use(async f => {
  const {review,preview} = await f.client.preview(); assert.equal(preview.status,'BLOCKED');
  await assert.rejects(f.client.approve(review), /UNAVAILABLE/);
  await assert.rejects(f.service.issue({missionSha256:review.mission_sha256,ownerPublicKey:f.ownerPublicKey}), /reconcile/);
  const changed=structuredClone(review); changed.mission.max_native_amount='301';
  await assert.rejects(validatePublicNativeMissionReview(changed,{accountId:owner,crypto:crypto.webcrypto}), /UNAVAILABLE/);
  await assert.rejects(validatePublicNativeMissionReview(review,{accountId:'other.testnet',crypto:crypto.webcrypto}), /UNAVAILABLE/);
  assert.equal(f.prompts,0); assert.equal(f.runs,0);
}, {blocked:true}));

test('unknown result does not reopen the approval; receipt-only recovery never executes', () => use(async f => {
  const {review} = await f.client.preview();
  await assert.rejects(f.client.approve(review), /UNAVAILABLE/); assert.equal(f.runs,1); assert.equal(f.prompts,1);
  await assert.rejects(f.client.approve(review), /UNAVAILABLE/); assert.equal(f.runs,1);
  assert.equal((await f.client.recover(review)).new_payments,0); assert.equal(f.runs,1); assert.equal(f.recovers,1);
}, {executeThrows:true}));

test('HTTP rejects other origins, missing headers, extra fields and client-selected signers', () => use(async f => {
  const review=f.service.getReview(), headers={'x-bouncer-native-mission':'v1','content-type':'application/json'};
  const req=(origin,body,more={})=>fetch(`${f.local}/api/native-mission/execute`,{method:'POST',headers:{...headers,origin,...more},body:JSON.stringify(body)});
  const body={missionSha256:review.mission_sha256,ownerPublicKey:f.ownerPublicKey,evidence:{}};
  assert.equal((await req('https://evil.example',body)).status,403);
  assert.equal((await req(site,{...body,signer:'private-key'})).status,400);
  assert.equal((await fetch(`${f.local}/api/native-mission/config`)).status,403);
  assert.equal((await req(site,{...body,missionSha256:'0'.repeat(64)})).status,409);
  assert.equal(f.runs,0); assert.equal(f.prompts,0);
}));
