import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectRefEcho } from '../scripts/probe-ref-echo.mjs';

const methods = ['get_client_echo_token_id_whitelist', 'get_client_echo_sender_id_whitelist', 'get_secure_sender_whitelist'];
function mock(lists, chain = 'testnet') {
  const calls = [];
  return { calls, async viewNodeStatus() { return { chain_id: chain }; }, async callFunction(account, method, args, finality) {
    calls.push({ account, method, args, finality });
    if (lists[method] instanceof Error) throw lists[method];
    return lists[method];
  }, async query(request) { calls.push(request); return { code_hash: 'A'.repeat(44) }; } };
}
function input(provider) { return { provider, sender: 'bouncer.example.testnet', inputToken: 'wrap.testnet' }; }

test('Ref echo inspector uses only finalized testnet views and recognizes exact and suffix allowlists', async () => {
  const provider = mock({ [methods[0]]: ['wrap.testnet'], [methods[1]]: ['*.testnet'], [methods[2]]: [] });
  const result = await inspectRefEcho(input(provider));
  assert.equal(result.source_rule_allows, true);
  assert.deepEqual(result.matches, { input_token: true, sender: true, secure_sender: false });
  assert.equal(result.code_hash, 'A'.repeat(44));
  assert.equal(provider.calls.length, 4);
  assert.ok(provider.calls.every(c => c.account === 'ref-finance-101.testnet' || c.account_id === 'ref-finance-101.testnet'));
  assert.ok(provider.calls.every(c => c.finality === 'final' || c.finality?.finality === 'final'));
  assert.match(result.warning, /not deployed-code correspondence/);
});

test('secure-sender matches bypass source token/sender lists but an uncertain view never guesses', async () => {
  let provider = mock({ [methods[0]]: new Error('unavailable'), [methods[1]]: [], [methods[2]]: ['bouncer.example.testnet'] });
  let result = await inspectRefEcho(input(provider));
  assert.equal(result.source_rule_allows, true); assert.equal(result.matches.input_token, null);
  provider = mock({ [methods[0]]: ['wrap.testnet'], [methods[1]]: ['*.testnet'], [methods[2]]: new Error('not supported') });
  result = await inspectRefEcho(input(provider));
  assert.equal(result.source_rule_allows, null);
  assert.deepEqual(result.whitelists.secure_senders, { observed: false, entries: null });
});

test('mismatched suffix, malformed or oversized lists and wrong chain fail closed', async () => {
  let provider = mock({ [methods[0]]: ['wrap.testnet'], [methods[1]]: ['*.example.testnet'], [methods[2]]: [] });
  let result = await inspectRefEcho({ ...input(provider), sender: 'example.testnet' });
  assert.equal(result.matches.sender, false); assert.equal(result.source_rule_allows, false);
  provider = mock({ [methods[0]]: ['*'], [methods[1]]: ['*.testnet'], [methods[2]]: [] });
  result = await inspectRefEcho(input(provider)); assert.equal(result.matches.input_token, null); assert.equal(result.source_rule_allows, null);
  provider = mock({ [methods[0]]: Array(1025).fill('wrap.testnet'), [methods[1]]: [], [methods[2]]: [] });
  result = await inspectRefEcho(input(provider)); assert.equal(result.matches.input_token, null);
  await assert.rejects(inspectRefEcho(input(mock({}, 'mainnet'))), /testnet/);
  await assert.rejects(inspectRefEcho({ ...input(mock({})), sender: 'owner.near' }), /testnet/);
});
