import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { KeyPair } from '@near-js/crypto';
import { nep413Payload } from '../web-src/cli-login.mjs';
import { setupAuthAction, signReviewedSetupChallenge } from '../web-src/witnessed-setup-auth.mjs';

const OWNER = 'buyer.testnet', STAGES = ['create_keyless_vault','register_vault_circle','fund_vault_circle'];
const site = { origin: 'https://bouncer.example', host: 'bouncer.example' };
const NOW = 1_800_000_000_000;
function fixture() {
  const pair = KeyPair.fromRandom('ed25519'), key = String(pair.getPublicKey()); let prompts = 0, sends = 0;
  const identity = { owner: OWNER, owner_public_key: key, operation_id: 'a'.repeat(32), review_sha256: 'b'.repeat(64),
    stages: STAGES.map((stage_id, i) => ({ stage_id, action_commitment_sha256: String(i+1).repeat(64) })) };
  const context = { purpose: 'claim_prompt', owner: OWNER, ownerPublicKey: key, identity, stageId: STAGES[0] };
  const action = setupAuthAction(context), expires = NOW + 60_000, issued = expires - 120_000;
  const digest = createHash('sha256').update(JSON.stringify(action)).digest('hex');
  const challenge = { challenge_id: 'c'.repeat(32), nonce_base64: Buffer.alloc(32, 8).toString('base64'), recipient: site.host, expires_at_ms: expires,
    message: `Bouncer testnet owner authentication\nClaim one setup prompt: ${STAGES[0]}\nAccount: ${OWNER}\nPublic key: ${key}\n` +
      `Action SHA-256: ${digest}\nSite: ${site.origin}\nIssued: ${new Date(issued).toISOString()}\nExpires: ${new Date(expires).toISOString()}\n` +
      'This message is not a transaction and does not itself approve spending.' };
  const wallet = { manifest: { id: 'near-mobile' }, async signMessage(p) {
    prompts++; assert.equal(p.accountId, OWNER); assert.equal(p.network, 'testnet');
    const signed = createHash('sha256').update(nep413Payload(p)).digest();
    return { accountId: OWNER, publicKey: key, signature: Buffer.from(pair.sign(signed).signature).toString('base64') };
  }, async signAndSendTransaction() { sends++; throw Error('unexpected transaction'); } };
  const fetch = async () => ({ ok: true, text: async () => JSON.stringify({ jsonrpc:'2.0', id:'bouncer-cli-login', result:{ permission:'FullAccess' } }) });
  return { context, challenge, wallet, fetch, prompts: () => prompts, sends: () => sends,
    args: { wallet, context, challenge, location: site, crypto: webcrypto, fetch, now: () => NOW } };
}

test('phone wallet signs only the exact off-chain setup authentication challenge', async () => {
  const f = fixture(), result = await signReviewedSetupChallenge(f.args);
  assert.equal(result.accountId, OWNER); assert.equal(result.challenge_id, f.challenge.challenge_id);
  assert.equal(f.prompts(), 1); assert.equal(f.sends(), 0);
});

test('changed action, origin, expiry or message is rejected before a wallet prompt', async () => {
  const f = fixture();
  const attempts = [
    { challenge: { ...f.challenge, message: f.challenge.message.replace('not a transaction', 'a transaction') } },
    { challenge: { ...f.challenge, recipient: 'evil.example' } },
    { location: { origin: 'https://evil.example', host: 'evil.example' } },
    { now: () => f.challenge.expires_at_ms },
    { context: { ...f.context, identity: { ...f.context.identity, review_sha256: 'f'.repeat(64) } } },
    { context: { ...f.context, stageId: STAGES[1] } },
  ];
  for (const patch of attempts) await assert.rejects(signReviewedSetupChallenge({ ...f.args, ...patch }), /SETUP_AUTHENTICATION_UNAVAILABLE/);
  assert.equal(f.prompts(), 0); assert.equal(f.sends(), 0);
});

test('invalid wallet result, restricted key, or expiration during the prompt fails closed', async () => {
  const f = fixture();
  await assert.rejects(signReviewedSetupChallenge({ ...f.args, wallet: { async signMessage() {
    return { accountId: 'other.testnet', publicKey: f.context.ownerPublicKey, signature: 'bad' };
  } } }), /SETUP_AUTHENTICATION_UNAVAILABLE/);
  const limited = async () => ({ ok: true, text: async () => JSON.stringify({ jsonrpc:'2.0', id:'bouncer-cli-login',
    result:{ permission:{ FunctionCall:{} } } }) });
  await assert.rejects(signReviewedSetupChallenge({ ...f.args, fetch: limited }), /CLI_KEY_NOT_FULL_ACCESS/);
  let ticks = 0;
  await assert.rejects(signReviewedSetupChallenge({ ...f.args, now: () => ticks++ ? f.challenge.expires_at_ms : NOW }), /SETUP_AUTHENTICATION_UNAVAILABLE/);
  assert.equal(f.sends(), 0);
});
