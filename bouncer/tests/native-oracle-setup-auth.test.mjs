import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { KeyPair } from '@near-js/crypto';
import nearApi from 'near-api-js';
import { nep413Payload } from '../web-src/cli-login.mjs';
import { nativeSetupAuthAction, signReviewedNativeSetupChallenge } from '../web-src/native-oracle-setup-auth.mjs';

const OWNER = 'buyer.testnet', STAGES = ['create_keyless_native_vault','configure_native_oracle_policy','fund_native_vault','install_native_oracle_agent'];
const site = { origin: 'https://bouncer.example', host: 'bouncer.example' }, NOW = 1_800_000_000_000;
const hash = n => nearApi.utils.serialize.base_encode(Buffer.alloc(32, n));
function fixture() {
  const pair = KeyPair.fromRandom('ed25519'), key = String(pair.getPublicKey()); let prompts = 0, sends = 0;
  const identity = { owner: OWNER, owner_public_key: key, operation_id: 'a'.repeat(32), review_sha256: 'b'.repeat(64),
    stages: STAGES.map((stage_id, i) => ({ stage_id, action_commitment_sha256: String(i + 1).repeat(64) })) };
  const review = { format: 'bouncer-native-oracle-wallet-review-v1', owner: OWNER, review_sha256: identity.review_sha256,
    stages: identity.stages.map(s => ({ id: s.stage_id, action_commitment_sha256: s.action_commitment_sha256 })) };
  const context = { purpose: 'claim_native_setup_stage', owner: OWNER, ownerPublicKey: key, identity, stageId: STAGES[0] };
  const action = nativeSetupAuthAction(context), expires = NOW + 60_000, issued = expires - 120_000;
  const digest = createHash('sha256').update(JSON.stringify(action)).digest('hex');
  const challenge = { challenge_id: 'c'.repeat(32), nonce_base64: Buffer.alloc(32, 8).toString('base64'), recipient: site.host, expires_at_ms: expires,
    message: `Bouncer testnet owner authentication\nClaim one native setup prompt: ${STAGES[0]}\nAccount: ${OWNER}\nPublic key: ${key}\n` +
      `Action SHA-256: ${digest}\nSite: ${site.origin}\nIssued: ${new Date(issued).toISOString()}\nExpires: ${new Date(expires).toISOString()}\n` +
      'This message is not a transaction and does not itself approve spending.' };
  const wallet = { manifest: { id: 'near-mobile' }, async signMessage(p) {
    prompts++; assert.equal(p.accountId, OWNER); assert.equal(p.network, 'testnet');
    const signed = createHash('sha256').update(nep413Payload(p)).digest();
    return { accountId: OWNER, publicKey: key, signature: Buffer.from(pair.sign(signed).signature).toString('base64') };
  }, async signAndSendTransaction() { sends++; throw Error('unexpected transaction'); } };
  const fetch = async () => ({ ok: true, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 'bouncer-cli-login', result: { permission: 'FullAccess' } }) });
  return { context, challenge, identity, review, wallet, fetch, prompts: () => prompts, sends: () => sends,
    args: { wallet, context, challenge, location: site, crypto: webcrypto, fetch, now: () => NOW } };
}

test('native setup challenge signs only the exact off-chain owner authentication', async () => {
  const f = fixture(), result = await signReviewedNativeSetupChallenge(f.args);
  assert.equal(result.accountId, OWNER); assert.equal(result.challenge_id, f.challenge.challenge_id);
  assert.equal(f.prompts(), 1); assert.equal(f.sends(), 0);
});

test('native auth covers all exact stages, reservation, original recording and inspect', () => {
  const f = fixture(), common = { owner: OWNER, ownerPublicKey: f.context.ownerPublicKey };
  const reserve = nativeSetupAuthAction({ ...common, purpose: 'reserve_native_setup', review: f.review });
  assert.equal(reserve.stage_id, STAGES[0]); assert.equal(reserve.review_sha256, f.review.review_sha256);
  assert.equal(nativeSetupAuthAction({ ...common, purpose: 'inspect_native_setup' }).purpose, 'inspect_native_setup');
  const complete = nativeSetupAuthAction({ ...common, purpose: 'verify_native_setup_completion', identity: f.identity });
  assert.equal(complete.operation_id, f.identity.operation_id); assert.equal(complete.review_sha256, f.identity.review_sha256);
  assert.equal(Object.hasOwn(complete, 'stage_id'), false);
  for (let i = 0; i < STAGES.length; i++) {
    const context = { ...common, identity: f.identity, stageId: STAGES[i] };
    assert.equal(nativeSetupAuthAction({ ...context, purpose: 'claim_native_setup_stage' }).action_commitment_sha256, String(i + 1).repeat(64));
    const record = nativeSetupAuthAction({ ...context, purpose: 'record_native_setup_original', originalHash: hash(i + 1) });
    assert.equal(record.original_hash, hash(i + 1));
    assert.throws(() => nativeSetupAuthAction({ ...context, purpose: 'record_native_setup_original', originalHash: '1'.repeat(31) }));
  }
  assert.throws(() => nativeSetupAuthAction({ ...common, purpose: 'reserve_native_setup', review: { ...f.review, stages: f.review.stages.slice(0, 3) } }));
  assert.throws(() => nativeSetupAuthAction({ ...common, purpose: 'claim_native_setup_stage', identity: f.identity, stageId: 'other' }));
  assert.throws(() => nativeSetupAuthAction({ ...common, owner: 'buyer.near', purpose: 'inspect_native_setup' }));
});

test('changed action, origin, message, expiry or wallet result fails closed before a transaction', async () => {
  const f = fixture();
  for (const patch of [
    { challenge: { ...f.challenge, message: f.challenge.message.replace('not a transaction', 'a transaction') } },
    { challenge: { ...f.challenge, recipient: 'evil.example' } },
    { location: { origin: 'https://evil.example', host: 'evil.example' } },
    { now: () => f.challenge.expires_at_ms },
    { context: { ...f.context, identity: { ...f.identity, review_sha256: 'f'.repeat(64) } } },
    { context: { ...f.context, stageId: STAGES[1] } },
  ]) await assert.rejects(signReviewedNativeSetupChallenge({ ...f.args, ...patch }), /NATIVE_SETUP_AUTHENTICATION_UNAVAILABLE/);
  assert.equal(f.prompts(), 0); assert.equal(f.sends(), 0);
  await assert.rejects(signReviewedNativeSetupChallenge({ ...f.args, wallet: { async signMessage() {
    return { accountId: 'other.testnet', publicKey: f.context.ownerPublicKey, signature: 'bad' };
  } } }), /NATIVE_SETUP_AUTHENTICATION_UNAVAILABLE/);
  const limited = async () => ({ ok: true, text: async () => JSON.stringify({ jsonrpc:'2.0', id:'bouncer-cli-login', result:{ permission:{ FunctionCall:{} } } }) });
  await assert.rejects(signReviewedNativeSetupChallenge({ ...f.args, fetch: limited }), /CLI_KEY_NOT_FULL_ACCESS/);
  assert.equal(f.sends(), 0);
});

test('trial-hash challenge binds owner, exact goal, agent key, original and witness head', async () => {
  const f=fixture(),agent=String(nearApi.KeyPair.fromRandom('ed25519').getPublicKey());
  const trial={goal_id:'native-oracle-trial-1',goal_sha256:'d'.repeat(64),agent_public_key:agent,original_hash:hash(50)};
  const context={owner:OWNER,ownerPublicKey:f.context.ownerPublicKey,identity:f.identity,purpose:'claim_native_oracle_trial',
    trial,expectedWitnessHead:'e'.repeat(40)};
  const action=nativeSetupAuthAction(context),digest=createHash('sha256').update(JSON.stringify(action)).digest('hex');
  const expires=f.challenge.expires_at_ms,issued=expires-120_000;
  const challenge={...f.challenge,message:`Bouncer testnet owner authentication\nRetain original native trial hash\nAccount: ${OWNER}\n`+
    `Public key: ${context.ownerPublicKey}\nAction SHA-256: ${digest}\nSite: ${site.origin}\n`+
    `Issued: ${new Date(issued).toISOString()}\nExpires: ${new Date(expires).toISOString()}\n`+
    'This message is not a transaction and does not itself approve spending.'};
  for(const bad of [{...trial,original_hash:hash(51)},{...trial,goal_sha256:'f'.repeat(64)},
    {...trial,agent_public_key:context.ownerPublicKey},{...trial,extra:'unexpected'}]) {
    await assert.rejects(signReviewedNativeSetupChallenge({...f.args,context:{...context,trial:bad},challenge}));
  }
  await assert.rejects(signReviewedNativeSetupChallenge({...f.args,context:{...context,expectedWitnessHead:'f'.repeat(40)},challenge}));
  assert.equal(f.prompts(),0);
  const signed=await signReviewedNativeSetupChallenge({...f.args,context,challenge});
  assert.equal(signed.publicKey,context.ownerPublicKey);assert.equal(f.prompts(),1);assert.equal(f.sends(),0);
});
