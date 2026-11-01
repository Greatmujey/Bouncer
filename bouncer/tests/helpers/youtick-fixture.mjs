import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import nearApi from 'near-api-js';
import { FileJournal } from '../../agent/procurement.mjs';
import { inspectYoutickSource, reserveYoutickUploadSession } from '../../agent/youtick-session.mjs';
import { TESTNET_CIRCLE_USDC, YOUTICK_MARKET } from '../../agent/youtick-capabilities.mjs';
import { verifyFtCallSettlement } from '../../agent/ft-call.mjs';

export const vault = 'vault.testnet', owner = 'owner.testnet', now = 1_770_000_000_000;
export function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-youtick-session-'));
  const source = path.join(dir, 'clip.mp4'), file = path.join(dir, 'journal.json'), keyFile = path.join(dir, 'key');
  const key = crypto.randomBytes(32); fs.writeFileSync(keyFile, key, { mode: 0o600 });
  fs.writeFileSync(source, Buffer.alloc(1_048_576 + 13, 5));
  return { dir, source, file, keyFile, key, cleanup() { key.fill(0); fs.rmSync(dir, { recursive: true, force: true }); } };
}
export function input(f) { return { vault, owner, job_id: 'bouncer-job-1', title: 'Small test clip', price_usdc: '2000000',
  source: inspectYoutickSource(f.source), source_type: 'mp4', upload_key_expires_at_ms: String(now + 3600000) }; }
export function open(f, existing = false) { return new FileJournal(f.file, vault, owner, { encryptionKey: f.key, keyFile: f.keyFile, requireExisting: existing }); }


export function settledVideo(journal, f) {
  const value = input(f), session = reserveYoutickUploadSession({ journal, id: 'session', input: value, nowMs: now });
  const req = session.request, quote = { creator_id: vault, job_id: req.job_id, total_fee_usdc: '600000', quote_id: 'a'.repeat(64) };
  const msg = JSON.stringify({ action: 'create_paid_job', job_id: req.job_id, title: req.title, price_usdc: req.price_usdc,
    expected_source_bytes: req.expected_source_bytes, profile_id: req.profile_id, profile_config_sha256: req.profile_config_sha256,
    upload_public_key: req.upload_public_key, upload_key_expires_at_ms: req.upload_key_expires_at_ms,
    sponsor_quote: quote, sponsor_quote_signature: 'synthetic' });
  const goal = { id: 'payment', contract_id: vault, owner_account_id: owner, policy_id: 'video', payee: YOUTICK_MARKET,
    token: TESTNET_CIRCLE_USDC, amount: '600000', msg, policy_revision: 1, route_revision: 1 };
  const key = nearApi.KeyPair.fromRandom('ed25519').getPublicKey().toString();
  const hash = nearApi.utils.serialize.base_encode(Buffer.alloc(32, 7));
  const enc = x => Buffer.from(JSON.stringify(x)).toString('base64');
  const ids = [6, 7, 8].map(n => nearApi.utils.serialize.base_encode(Buffer.alloc(32, n)));
  const args = { policy_id: goal.policy_id, payee: goal.payee, amount: goal.amount, expected_token: goal.token,
    expected_msg: goal.msg, expected_policy_revision: 1, expected_route_revision: 1 };
  const call = (id, from, to, method, value, deposit) => ({ receipt_id: id, predecessor_id: from, receiver_id: to,
    receipt: { Action: { actions: [{ FunctionCall: { method_name: method, args: enc(value), deposit } }] } } });
  const outcome = (id, executor_id, status, logs = [], receipt_ids = []) => ({ id, outcome: { executor_id, status, logs, receipt_ids } });
  const result = { final_execution_status: 'FINAL', status: { SuccessValue: enc('600000') },
    transaction_outcome: { id: hash, outcome: { receipt_ids: [ids[0]] } },
    transaction: { hash, signer_id: owner, receiver_id: vault, public_key: key,
      actions: [{ FunctionCall: { method_name: 'execute_ft_call', deposit: '0', gas: '300000000000000', args: enc(args) } }] },
    receipts: [call(ids[1], vault, goal.token, 'ft_transfer_call', { receiver_id: goal.payee, amount: goal.amount, memo: 'bouncer:guarded-ft-call', msg }, '1'),
      call(ids[2], vault, vault, 'after_execute_ft_call', { policy_id: goal.policy_id, token: goal.token, amount: goal.amount,
        bucket: 24, policy_revision: 1, payee: goal.payee, msg }, '0')],
    receipts_outcome: [outcome(ids[0], vault, { SuccessReceiptId: ids[2] }, ['BOUNCER guarded ft_transfer_call initiated; full amount reserved'], [ids[1], ids[2]]),
      outcome(ids[1], goal.token, { SuccessReceiptId: ids[2] }),
      outcome(ids[2], vault, { SuccessValue: enc('600000') }, ['BOUNCER ft_transfer_call settled; used=600000; unused=0'])] };
  const settlement = verifyFtCallSettlement(goal, result, key);
  journal.put(goal.id, { fingerprint: crypto.createHash('sha256').update(JSON.stringify(goal)).digest('hex'), status: 'completed',
    ft_call_goal: goal, tx_hash: hash, agent_public_key: key, settlement });
  const job = { job_id: req.job_id, creator_id: vault, title: req.title, price_usdc: req.price_usdc, expected_source_bytes: req.expected_source_bytes,
    profile_id: req.profile_id, profile_config_sha256: req.profile_config_sha256, upload_public_key: req.upload_public_key,
    upload_key_expires_at_ms: req.upload_key_expires_at_ms, generation: 1, status: 'Authorized', published_at_ms: null,
    fee_asset: 'USDC', fee_amount: '600000', fee_usd_micro: '600000', fee_quote_hash: quote.quote_id };
  return { journal, sessionId: 'session', goal, paymentResult: result, job, sourceFile: f.source, nowMs: now };
}
