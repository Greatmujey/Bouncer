// Shared synthetic chain and receipt fixtures. No external service is called.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import nearApi from 'near-api-js';
import { reserveYoutickUploadSession } from '../../agent/youtick-session.mjs';
import { reserveYoutickPlaybackSession, YOUTICK_PLAY_ORIGIN_HASH, YOUTICK_PLAY_TTL_MS } from '../../agent/youtick-playback.mjs';
import { YOUTICK_ACCESS_CODE_HASH } from '../../agent/youtick-grant-runner.mjs';
import { YOUTICK_MARKET, YOUTICK_ACCESS } from '../../agent/youtick-capabilities.mjs';
import { YOUTICK_V1_CODE_HASH } from '../../agent/youtick-quote.mjs';
import { fixture, input, open, settledVideo, vault, owner, now } from './youtick-fixture.mjs';

export const hash = byte => nearApi.utils.serialize.base_encode(Buffer.alloc(32, byte));
const enc = value => Buffer.from(JSON.stringify(value)).toString('base64');
export const blockHash = hash(21), vaultHash = hash(22);

export function setup() {
  const f = fixture(), journal = open(f);
  reserveYoutickUploadSession({ journal, id: 'session', input: input(f), nowMs: now });
  const playback = reserveYoutickPlaybackSession({ journal, sessionId: 'session', nowMs: now });
  const video = settledVideo(journal, f); video.job.status = 'Published'; video.job.published_at_ms = now - 100;
  const publication = { publication_id: video.job.job_id, creator_id: vault, title: video.job.title, price_usdc: video.job.price_usdc,
    generation: 1, expected_source_bytes: video.job.expected_source_bytes, verified_source_bytes: video.job.expected_source_bytes,
    profile_id: video.job.profile_id, profile_config_sha256: video.job.profile_config_sha256,
    asset_id_hash: 'b'.repeat(64), project_id_hash: 'c'.repeat(64), playback_id: 'synthetic-playback', availability: 'ACTIVE',
    published_availability: 'ACTIVE', published_at_ms: video.job.published_at_ms, ready_at_ms: String(now - 200), provider_source_fingerprint: null };
  const ownerKey = nearApi.KeyPair.fromRandom('ed25519');
  const account = { accountId: owner, signer: new nearApi.KeyPairSigner(ownerKey),
    createTransaction: async (receiver, actions, publicKey) => nearApi.transactions.createTransaction(owner, publicKey, receiver, 1n, actions, Buffer.alloc(32, 24)) };
  const settings = { chain: 'testnet', vaultHash, accessHash: YOUTICK_ACCESS_CODE_HASH, marketHash: YOUTICK_V1_CODE_HASH,
    vaultOwner: owner, version: 'bouncer-agent-v10-youtick-testnet', state: { market_contract_id: YOUTICK_MARKET, paused: false, grant_issuance_enabled: true },
    policy: { max_ttl_ms: 600_000, require_origin: true, require_device: true }, entitlement: true, permission: 'FullAccess',
    job: video.job, publication, paymentResult: video.paymentResult, grant: null, grantResult: null, sent: 0, atSend: () => {} };
  const provider = {
    async viewNodeStatus() { return { chain_id: settings.chain }; },
    async query({ account_id, blockId }) {
      const result = { block_hash: settings.wrongBlock && account_id === YOUTICK_ACCESS ? hash(30) : blockId ?? blockHash };
      if (account_id === vault) result.code_hash = settings.vaultHash;
      else if (account_id === YOUTICK_ACCESS) result.code_hash = settings.accessHash;
      else if (account_id === YOUTICK_MARKET) result.code_hash = settings.marketHash;
      else throw new Error('unexpected view_account');
      return result;
    },
    async callFunction(target, method, args, block) {
      assert.equal(block.blockId, blockHash);
      if (target === vault && method === 'contract_version') return settings.version;
      if (target === vault && method === 'get_owner') return settings.vaultOwner;
      if (target === YOUTICK_ACCESS && method === 'get_contract_state') return settings.state;
      if (target === YOUTICK_ACCESS && method === 'get_scope_policy') return settings.policy;
      if (target === YOUTICK_MARKET && method === 'get_media_job') { assert.equal(args.job_id, video.job.job_id); return settings.job; }
      if (target === YOUTICK_MARKET && method === 'get_publication') { assert.equal(args.publication_id, video.job.job_id); return settings.publication; }
      if (target === YOUTICK_MARKET && method === 'has_entitlement') { assert.deepEqual(args, { account_id: vault, publication_id: video.job.job_id }); return settings.entitlement; }
      if (target === YOUTICK_ACCESS && method === 'get_session_grant') return settings.grant;
      if (target === YOUTICK_ACCESS && method === 'verify_session_grant') {
        assert.deepEqual(args, { session_pk: playback.session_pk, scope: 'Play', resource_id: video.job.job_id,
          origin_hash: YOUTICK_PLAY_ORIGIN_HASH, device_hash: playback.device_hash });
        if (settings.verification) return settings.verification;
        return settings.grant ? { valid: true, owner_id: vault, reason: null } : { valid: false, owner_id: null, reason: 'Session grant not found' };
      }
      throw new Error(`unexpected view ${target}.${method}`);
    },
    async viewAccessKey(accountId, publicKey, block) {
      assert.equal(accountId, owner); assert.equal(String(publicKey), String(ownerKey.getPublicKey())); assert.equal(block.blockId, blockHash);
      return { permission: settings.permission };
    },
    async txStatusReceipts(txHash, accountId, finality) {
      assert.equal(accountId, owner); assert.equal(finality, 'FINAL');
      if (txHash === video.paymentResult.transaction.hash) return settings.paymentResult;
      if (txHash === settings.grantResult?.transaction.hash && !settings.grantNotVisible) return settings.grantResult;
      throw new Error('unknown or unavailable transaction');
    },
    async sendTransactionUntil(signed, wait) {
      settings.sent++; assert.equal(wait, 'FINAL'); await settings.atSend(signed);
      if (settings.failBeforeApply) throw new Error('ambiguous transport failure');
      const transaction = signed.transaction, fc = transaction.actions[0].functionCall;
      const txHash = nearApi.utils.serialize.base_encode(crypto.createHash('sha256').update(nearApi.transactions.encodeTransaction(transaction)).digest());
      const args = JSON.parse(Buffer.from(fc.args).toString('utf8'));
      const grant = { owner_id: vault, session_pk: args.session_pk, scope: 'Play', resource_id: args.job_id,
        expires_at_ms: now + YOUTICK_PLAY_TTL_MS, origin_hash: YOUTICK_PLAY_ORIGIN_HASH, device_hash: args.device_hash, revoked: false };
      const accessArgs = { target_owner_id: vault, session_pk: args.session_pk, scope: 'Play', resource_id: args.job_id,
        ttl_ms: YOUTICK_PLAY_TTL_MS, origin_hash: YOUTICK_PLAY_ORIGIN_HASH, device_hash: args.device_hash, session_pok: args.session_pok };
      const initId = hash(25), accessId = hash(26);
      settings.grant = grant;
      settings.grantResult = { final_execution_status: 'FINAL', status: { SuccessValue: enc(grant) },
        transaction_outcome: { id: txHash, outcome: { status: { SuccessReceiptId: initId }, receipt_ids: [initId] } },
        transaction: { hash: txHash, signer_id: owner, receiver_id: vault, public_key: String(transaction.publicKey),
          actions: [{ FunctionCall: { method_name: fc.methodName, deposit: String(fc.deposit), gas: String(fc.gas), args: enc(args) } }] },
        receipts: [{ receipt_id: accessId, predecessor_id: vault, receiver_id: YOUTICK_ACCESS,
          receipt: { Action: { actions: [{ FunctionCall: { method_name: 'issue_session_grant', deposit: '0', gas: '70000000000000', args: enc({ request: accessArgs }) } }] } } }],
        receipts_outcome: [{ id: initId, outcome: { executor_id: vault, status: { SuccessReceiptId: accessId }, receipt_ids: [accessId] } },
          { id: accessId, outcome: { executor_id: YOUTICK_ACCESS, status: { SuccessValue: enc(grant) }, receipt_ids: [] } }] };
      if (settings.failAfterApply) throw new Error('response lost after send');
      return settings.grantResult;
    },
  };
  const opts = { journal, grantId: 'grant', sessionId: 'session', goal: video.goal, sourceFile: f.source,
    vaultCodeHash: vaultHash, provider, account, publicKey: ownerKey.getPublicKey(), clock: () => now };
  return { f, journal, video, publication, ownerKey, provider, settings, opts, close() { journal.close(); f.cleanup(); } };
}
