import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { RUN, LATEST_MISSION, explorerAccount, explorerTx, formatUnits, readCurrentBalances, shortId } from '../web/evidence.mjs';

test('recorded website evidence describes the real multi-token run and separate security account', () => {
  assert.equal(RUN.account, 'bouncer-42dcdfb7.testnet');
  assert.equal(RUN.securityAccount, 'bouncer-f646cc.testnet');
  assert.notEqual(RUN.account, RUN.securityAccount);
  assert.deepEqual(RUN.resources.map(r => r.id), ['compute', 'storage', 'api']);
  assert.deepEqual(RUN.resources.map(r => formatUnits(r.amount, r.decimals)), ['0.1', '1.5', '2']);
  assert.deepEqual(RUN.resources.map(r => formatUnits(r.vault, r.decimals)), ['0.9', '8.5', '8']);
  for (const r of RUN.resources) {
    assert.equal(BigInt(r.funded) - BigInt(r.amount), BigInt(r.vault));
    assert.ok(BigInt(r.amount) <= BigInt(r.perTx));
    assert.ok(BigInt(r.amount) <= BigInt(r.daily));
    assert.match(r.vendor, /\.bouncer-42dcdfb7\.testnet$/);
    assert.match(r.tx, /^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    assert.equal(explorerTx(r.tx), `https://testnet.nearblocks.io/txns/${r.tx}`);
  }
  assert.equal(explorerAccount(RUN.account), `https://testnet.nearblocks.io/address/${RUN.account}`);
  assert.match(explorerTx(RUN.securityRefundTx), /GkQL6ZNHC7gGmRmCHc9uFv7fSsNdeJkTZaHtNPcxfhtw$/);
});

test('recorded story inputs and service outputs match the real integration script', () => {
  const [compute, storage, api] = RUN.resources;
  let hash = Buffer.from('near-hub compute job');
  for (let i = 0; i < 1000; i++) hash = createHash('sha256').update(hash).digest();
  assert.equal(compute.story.result, `SHA-256 result: ${hash.toString('hex')}`);
  assert.match(compute.story.request, /1,000 rounds/);
  const note = 'Persisted by the Bouncer testnet provider.';
  assert.equal(Buffer.byteLength(note), 42);
  assert.ok(storage.story.result.includes(note));
  assert.match(storage.story.result, /stored and retrieved \(42 bytes\)/);
  const text = 'actual testnet resource API';
  assert.equal(text.split(/\s+/u).length, 4);
  assert.equal(Buffer.byteLength(text), 27);
  assert.match(api.story.result, /4 words and 27 bytes/);
  const script = fs.readFileSync(new URL('../demo-multi-resource.mjs', import.meta.url), 'utf8');
  for (const input of ['near-hub compute job', note, text]) assert.ok(script.includes(input));
});

test('token formatting is exact, validates inputs, and does not use floats', () => {
  assert.equal(formatUnits('0', 24), '0');
  assert.equal(formatUnits('10', 0), '10');
  assert.equal(formatUnits('1', 6), '0.000001');
  assert.equal(formatUnits('900000000000000000000000', 24), '0.9');
  assert.equal(formatUnits('123456789012345678901234567890', 24), '123456.78901234567890123456789');
  for (const [amount, decimals] of [['-1', 6], ['1.2', 6], ['01', 6], ['1', 25], ['1', -1]]) {
    assert.throws(() => formatUnits(amount, decimals), /Invalid token amount/);
  }
  assert.equal(shortId('abc'), 'abc');
  assert.equal(shortId('abcdefghijklmno', 4, 3), 'abcd…mno');
});

const rpcResponse = value => ({ ok: true, json: async () => ({ result: { result: [...new TextEncoder().encode(JSON.stringify(value))] } }) });

test('current balances are read only from the pinned contract via final view calls', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const request = JSON.parse(options.body);
    calls.push({ url, options, request });
    return rpcResponse(RUN.resources.find(r => r.id === request.id).vault);
  };
  const balances = await readCurrentBalances(fetchImpl);
  assert.deepEqual(balances, Object.fromEntries(RUN.resources.map(r => [r.id, r.vault])));
  assert.equal(calls.length, 3);
  for (const { url, options, request } of calls) {
    assert.equal(url, 'https://test.rpc.fastnear.com');
    assert.equal(options.method, 'POST'); // JSON-RPC view requests; no signing or transaction submission.
    assert.equal(request.method, 'query');
    assert.equal(request.params.request_type, 'call_function');
    assert.equal(request.params.finality, 'final');
    assert.equal(request.params.account_id, RUN.account);
    assert.equal(request.params.method_name, 'vault_balance');
    assert.deepEqual(JSON.parse(atob(request.params.args_base64)), { token: RUN.resources.find(r => r.id === request.id).token });
  }
});

test('current balance read fails closed on HTTP, RPC, and malformed values', async () => {
  await assert.rejects(readCurrentBalances(async () => ({ ok: false, status: 503 })), /HTTP 503/);
  await assert.rejects(readCurrentBalances(async () => ({ ok: true, json: async () => ({ error: { code: -1 } }) })), /invalid response/);
  for (const value of [42, '-1', '1.2', '01', null]) {
    await assert.rejects(readCurrentBalances(async () => rpcResponse(value)), /invalid balance/);
  }
});

test('latest oracle-led mission links to the verified testnet data and three resource payments', () => {
  assert.equal(LATEST_MISSION.account, 'bouncer-oracle-6a42bf32.testnet');
  assert.equal(LATEST_MISSION.owner, 'owner.bouncer-oracle-6a42bf32.testnet');
  assert.notEqual(LATEST_MISSION.account, LATEST_MISSION.owner);
  assert.equal(LATEST_MISSION.testToken, '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af');
  assert.equal(LATEST_MISSION.resourceMicroUsdc, '1000');
  assert.equal(LATEST_MISSION.priceUsd, '4.27625');
  const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  for (const key of ['setupSwapTx', 'fundingTx', 'oracleTx', 'computeTx', 'storageTx', 'apiTx']) {
    assert.match(LATEST_MISSION[key], /^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    assert.ok(html.includes(explorerTx(LATEST_MISSION[key])), `missing link for ${key}`);
  }
  assert.ok(html.includes(LATEST_MISSION.actionUrl));
  assert.ok(html.includes(LATEST_MISSION.aiActionUrl));
  assert.match(html, /Coinbase’s public endpoint through OutLayer/);
  assert.match(html, /testnet NEAR/);
  assert.match(html, /Circle testnet USDC/);
  assert.match(html, /self-hosted development examples/);
  assert.match(html, /no real value/);
  assert.match(html, /not independently verified for accuracy or market freshness/);
  assert.match(html, /intentionally corrupted result stopped later payments/);
  assert.match(html, /independent execution was not paid in USDC/);
  assert.match(html, /process is non-atomic/);
  assert.equal((html.match(/class="track-card"/g) || []).length, 6);
});

test('website discloses snapshot, synthetic credits, self-hosted services, and testnet limitations', () => {
  const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  assert.match(html, /Verified testnet snapshot/);
  assert.match(html, /not a running agent/);
  assert.match(html, /self-hosted development examples, not commercial vendors/);
  assert.match(html, /newly created testnet tokens/);
  assert.match(html, /Unaudited/);
  assert.match(html, /separate refund test/);
  assert.doesNotMatch(html, /Start buying/i);
  assert.match(html, /Connect a testnet wallet/i);
  assert.match(html, /does not create a vault, grant an agent access, sign a transaction, or spend funds/i);
  assert.match(html, /Gemini CLI and Claude Code passed local connection checks/i);
  assert.match(html, /ChatGPT web and other hosted assistants need HTTPS/i);
  assert.match(html, /Model conversations have not been tested/i);
  assert.match(html, /id="welcome-tour"/);
  assert.match(html, /local AI model to propose resource tasks/i);
  assert.match(html, /not yet an open marketplace/i);
  assert.match(html, /FUTURE WE’RE BUILDING TOWARD · NOT AVAILABLE YET/);
  assert.match(html, /goal, not a completed demo/i);
  assert.equal((html.match(/data-story-tab=/g) || []).length, 3);
});
