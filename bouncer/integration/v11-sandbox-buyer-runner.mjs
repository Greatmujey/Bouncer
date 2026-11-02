/**
 * TEST ONLY: run the actual experimental exact-FT buyer and same-hash recovery
 * after the separate sandbox owner runner has created and funded its vault.
 *
 * The seller's offer and reservation are in-process fixtures; there is no
 * seller network traffic, activation or delivery. The token is the example FT
 * at a Circle-shaped address in the disposable sandbox genesis, NOT Circle.
 * This aliases the local chain ID and simulates approvals only here. It must
 * never be imported by production code or used as permission for testnet.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import nearApi from 'near-api-js';
import { FileJournal } from '../agent/procurement.mjs';
import { PaymentRpcProvider, MonotonicAccount } from '../agent/near-account.mjs';
import { prepareSvalinProSession, reserveSvalinProOnce, prepareSvalinProExactFt } from '../agent/svalin-pro-session.mjs';
import { paySvalinProExactFtOnce, recoverSvalinProPayment } from '../agent/svalin-pro-runner.mjs';
import { CIRCLE_TESTNET_USDC as TOKEN } from '../scripts/circle-testnet-setup.mjs';
import { SVALIN_ORIGIN, SVALIN_PAYEE } from '../agent/svalin-pro-readiness.mjs';
import { RUNNER_OWNER, RUNNER_VAULT } from './v11-sandbox-owner-runner.mjs';
import { assertSandboxStatus } from './v11-sandbox-support.mjs';
import { loopbackSandboxUrl, withSandboxOnlyFetch } from './v11-sandbox-setup-rpc.mjs';

const GOAL_ID = 'sandbox-buyer-only', POLICY = 'svalin';
const AMOUNT = '5004217', INITIAL = 5009999n;
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest();
const originalHash = signed => nearApi.utils.serialize.base_encode(sha256(nearApi.transactions.encodeTransaction(signed.transaction)));

/** Local-only adapter around the same single-send transport used by the buyer.
 * The guard and fetch fence are additional test isolation, not production RPC
 * or chain-ID validation. Only the one sandbox owner/vault method is permitted. */
export class SandboxBuyerRpc extends PaymentRpcProvider {
  #transportCalls = 0;
  #loseNextAcknowledgement = false;
  constructor(url) {
    super(loopbackSandboxUrl(url));
    Object.defineProperty(this, 'connection', { value: Object.freeze({ ...this.connection }),
      enumerable: true, writable: false, configurable: false });
  }
  get transportCalls() { return this.#transportCalls; }
  loseNextAcknowledgementForTest() {
    if (this.#loseNextAcknowledgement) throw new Error('sandbox buyer fault is already armed');
    this.#loseNextAcknowledgement = true;
  }
  async viewNodeStatus() {
    const actual = await super.viewNodeStatus();
    assertSandboxStatus(actual);
    return { ...actual, chain_id: 'testnet' };
  }
  async sendTransactionOnce(signed, finality) {
    const tx = signed?.transaction, call = tx?.actions?.[0]?.functionCall;
    if (finality !== 'FINAL' || tx?.signerId !== RUNNER_OWNER || tx?.receiverId !== RUNNER_VAULT ||
        !Array.isArray(tx.actions) || tx.actions.length !== 1 || tx.actions[0]?.enum !== 'functionCall' ||
        call?.methodName !== 'execute_exact_ft' || call.deposit !== 0n || call.gas !== 200n * 10n ** 12n) {
      throw new Error('sandbox buyer transport permits only its restricted zero-deposit call');
    }
    await this.viewNodeStatus();
    this.#transportCalls++;
    const result = await super.sendTransactionOnce(signed, finality);
    if (this.#loseNextAcknowledgement) {
      this.#loseNextAcknowledgement = false;
      throw new Error('sandbox-only simulated lost buyer acknowledgement after one send');
    }
    return result;
  }
}

/** All inputs are provided by the isolated harness, never by environment or a
 * user endpoint. `pinIntent` signs with the disposable local owner; the buyer
 * itself only receives the restricted agent signer. */
export async function exerciseSandboxBuyerRunner(args) {
  return withSandboxOnlyFetch(args.rpcUrl, () => exerciseWithFencedFetch(args));
}

async function exerciseWithFencedFetch({ rpcUrl, wasm, directory, agentKey, pinIntent, checkpoint }) {
  if (!Buffer.isBuffer(wasm) || typeof pinIntent !== 'function' || typeof checkpoint !== 'function') {
    throw new Error('invalid sandbox buyer harness inputs');
  }
  const codeHash = nearApi.utils.serialize.base_encode(sha256(wasm));
  const goal = { version: 1, id: GOAL_ID, vault: RUNNER_VAULT, owner: RUNNER_OWNER, vault_code_hash: codeHash,
    policy_id: POLICY, accept_unsigned_seller_risk: true, accept_exact_amount_matching_risk: true };
  const rpc = new SandboxBuyerRpc(rpcUrl);
  await rpc.viewNodeStatus(); // refuse a different local node before the test owner signs
  const publicKey = agentKey.getPublicKey();
  const account = new MonotonicAccount(RUNNER_OWNER, rpc, new nearApi.KeyPairSigner(agentKey));
  const journalKey = crypto.randomBytes(32), journalPath = path.join(directory, 'sandbox-buyer-journal.json');
  let journal, offerGets = 0, reservationPosts = 0, journalChecks = 0;
  try {
    journal = new FileJournal(journalPath, RUNNER_VAULT, RUNNER_OWNER, { encryptionKey: journalKey });
    const session = () => journal.get(`${GOAL_ID}-svalin-pro`);
    // This fake never calls fetch, opens a socket, contacts Svalin or handles a
    // real credential. Unexpected URLs/methods are rejected locally.
    const syntheticSeller = async (url, options) => {
      assert.equal(options.redirect, 'error');
      assert.equal(options.cache, 'no-store');
      if (url === `${SVALIN_ORIGIN}/v1/pro` && options.method === 'GET') {
        offerGets++;
        return new Response(JSON.stringify({ plans: [{ id: 'month', usd: 5, days: 30 }], callsPerDay: 100,
          near: { network: 'near:testnet', environment: 'testnet', payTo: SVALIN_PAYEE, token: TOKEN } }));
      }
      if (url === `${SVALIN_ORIGIN}/v1/pro/near` && options.method === 'POST') {
        reservationPosts++;
        const body = JSON.parse(options.body);
        assert.equal(session()?.svalin?.phase, 'reservation_requested');
        assert.deepEqual(body, { code: session().svalin.code, plan: 'month' });
        assert.equal(fs.readFileSync(journalPath, 'utf8').includes(body.code), false);
        return new Response(JSON.stringify({ plan: 'month', network: 'near:testnet', payTo: SVALIN_PAYEE, token: TOKEN,
          amount: '5.004217', expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString() }));
      }
      throw new Error('sandbox buyer forbids any other synthetic seller request');
    };
    const common = () => ({ goal, journal, provider: rpc, account, publicKey, fetchImpl: syntheticSeller,
      execute: true, acknowledgeBackup: true }); // deliberately NOT real owner approval/backup
    await prepareSvalinProSession(common());
    assert.equal((await reserveSvalinProOnce(common())).phase, 'reserved');
    assert.equal(reservationPosts, 1);
    const prepared = await prepareSvalinProExactFt({ ...common(), agentPublicKey: String(publicKey) });
    assert.equal(prepared.owner_call.receiver_id, RUNNER_VAULT);
    assert.equal(prepared.owner_call.method, 'set_exact_ft_intent');
    assert.equal(prepared.owner_call.attached_yocto, '1');
    assert.equal(prepared.owner_call.args.amount, AMOUNT);
    // Owner-only action is signed by the test harness, not by the agent.
    await pinIntent(prepared.owner_call);
    checkpoint('test owner pinned the exact synthetic checkout on the local vault');

    const sellerBefore = BigInt(await rpc.callFunction(TOKEN, 'ft_balance_of', { account_id: SVALIN_PAYEE }, { finality: 'final' }));
    assert.equal(await rpc.callFunction(TOKEN, 'ft_balance_of', { account_id: RUNNER_VAULT }, { finality: 'final' }), INITIAL.toString());
    const send = rpc.sendTransactionOnce.bind(rpc);
    rpc.sendTransactionOnce = async (signed, finality) => {
      const hash = originalHash(signed), pending = journal.get(GOAL_ID), bearer = session().svalin.code;
      assert.equal(pending?.status, 'pending', 'the actual buyer must journal before sending');
      assert.equal(pending.tx_hash, hash);
      const disk = fs.readFileSync(journalPath, 'utf8');
      assert.equal(disk.includes(hash), false, 'original hash must be encrypted on disk');
      assert.equal(disk.includes(bearer), false, 'synthetic bearer must be encrypted on disk');
      journalChecks++;
      return send(signed, finality);
    };
    rpc.loseNextAcknowledgementForTest();
    await assert.rejects(paySvalinProExactFtOnce(common()), /unresolved.*never automatically resend/);
    assert.equal(rpc.transportCalls, 1);
    assert.equal(journalChecks, 1);
    const hash = journal.get(GOAL_ID)?.tx_hash;
    assert.equal(journal.get(GOAL_ID)?.status, 'pending');
    // Reopen the same encrypted journal. A pending original must fence a second
    // send even though the simulated acknowledgement was lost.
    journal.close();
    journal = new FileJournal(journalPath, RUNNER_VAULT, RUNNER_OWNER, { encryptionKey: journalKey, requireExisting: true });
    await assert.rejects(paySvalinProExactFtOnce(common()), /already recorded/);
    assert.equal(rpc.transportCalls, 1);
    const sellerCallsBeforeRecovery = offerGets + reservationPosts;
    const recovered = await recoverSvalinProPayment({ goal, journal, provider: rpc });
    assert.equal(recovered.status, 'RECOVERED_PAYMENT_ONLY');
    assert.equal(recovered.settlement.tx_hash, hash);
    assert.equal(recovered.settlement.amount, AMOUNT);
    assert.equal(recovered.sends, 0);
    assert.equal(recovered.seller_requests, 0);
    assert.equal(offerGets + reservationPosts, sellerCallsBeforeRecovery);
    assert.equal(journal.get(GOAL_ID)?.status, 'completed');
    assert.equal(rpc.transportCalls, 1);
    assert.equal(await rpc.callFunction(TOKEN, 'ft_balance_of', { account_id: RUNNER_VAULT }, { finality: 'final' }),
      (INITIAL - BigInt(AMOUNT)).toString());
    assert.equal(await rpc.callFunction(RUNNER_VAULT, 'vault_balance', { token: TOKEN }, { finality: 'final' }),
      (INITIAL - BigInt(AMOUNT)).toString());
    assert.equal(await rpc.callFunction(RUNNER_VAULT, 'daily_spent', { policy_id: POLICY }, { finality: 'final' }), AMOUNT);
    assert.equal(BigInt(await rpc.callFunction(TOKEN, 'ft_balance_of', { account_id: SVALIN_PAYEE }, { finality: 'final' })),
      sellerBefore + BigInt(AMOUNT));
    checkpoint('actual buyer recovered its original local mock-FT payment without a second send');
    return { scope: 'ONLY disposable local nearcore and an in-process fake seller; not testnet, Circle, consent, attribution or delivery',
      local_chain_id_aliased_for_test_only: true, simulated_approvals_are_not_user_consent_or_review: true,
      seller_contacted: false, seller_offer_and_reservation_are_synthetic: true,
      encrypted_original_hash_journaled_before_transport: journalChecks === 1,
      payment_transport_calls: rpc.transportCalls, sandbox_transaction_hash: hash,
      acknowledgement_lost_and_original_hash_recovered: true, payment_evidence: recovered.status,
      seller_attribution_verified: false, fulfillment_verified: false };
  } finally {
    journal?.close();
    journalKey.fill(0);
  }
}
