#!/usr/bin/env node
/** Fixed, public-only inventory requested by the owner. This script never reads
 * keys, calls a faucet, signs, broadcasts or contacts a seller. */
import { ReadOnlyNearRpcProvider, readPinnedJsonView } from '../agent/read-only-near-rpc.mjs';
import { inspectNamedTestnetAccount } from '../agent/named-testnet-inventory.mjs';
import { assertFreshFinalBlock } from '../shared/fresh-final-block.mjs';

const TESTNET_ACCOUNT = 'greatmujey.testnet', MAINNET_ACCOUNT = 'greatmujey.near';
// Circle's published native NEAR mainnet token; view-only, never paid.
const MAINNET_CIRCLE = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const uint = x => typeof x === 'string' && /^(0|[1-9][0-9]{0,38})$/.test(x) && BigInt(x) <= (1n << 128n) - 1n;

async function mainnet(provider) {
  if ((await provider.viewNodeStatus())?.chain_id !== 'mainnet') throw Error('wrong network');
  const block = await provider.viewBlock({ finality: 'final' }), fresh = assertFreshFinalBlock(block, Date.now());
  const hash = fresh.hash;
  const results = await Promise.allSettled([
    provider.query({ request_type: 'view_account', account_id: MAINNET_ACCOUNT, block_id: hash }),
    readPinnedJsonView(provider, hash, MAINNET_CIRCLE, 'ft_balance_of', { account_id: MAINNET_ACCOUNT }),
  ]);
  const account = results[0].status === 'fulfilled' ? results[0].value : null;
  const balance = results[1].status === 'fulfilled' ? results[1].value : null;
  assertFreshFinalBlock({ header: { hash, timestamp_nanosec: block.header.timestamp_nanosec } }, Date.now());
  return { chain: 'mainnet', account_id: MAINNET_ACCOUNT, block_hash: hash,
    block_timestamp: new Date(fresh.timestamp_ms).toISOString(),
    native_balance_yocto: account?.block_hash === hash && uint(account.amount) ? account.amount : null,
    locked_yocto: account?.block_hash === hash && uint(account.locked) ? account.locked : null,
    circle_token: MAINNET_CIRCLE, circle_balance_atoms: uint(balance) ? balance : null,
    scope: 'read-only views of native NEAR and Circle USDC only; other tokens are not enumerated; no mainnet action' };
}

async function fallback(endpoints, inspect) {
  for (const endpoint of endpoints) {
    try {
      const provider = new ReadOnlyNearRpcProvider(endpoint, { timeoutMs: 10_000 });
      return { rpc: endpoint, ...(await inspect(provider)) };
    } catch { /* do not echo untrusted RPC responses */ }
  }
  return { status: 'UNKNOWN', scope: 'no endpoint returned a fresh valid FINAL snapshot' };
}
const [testnet, mainnetState] = await Promise.all([
  fallback(['https://rpc.testnet.near.org', 'https://test.rpc.fastnear.com'],
    provider => inspectNamedTestnetAccount({ provider, accountId: TESTNET_ACCOUNT })),
  fallback(['https://rpc.mainnet.fastnear.com', 'https://rpc.mainnet.near.org'], mainnet),
]);
console.log(JSON.stringify({ testnet, mainnet: mainnetState, signed: false, sent: false, helper_called: false,
  scope: 'public read-only RPC snapshots; unknown is not zero or proof of ownership' }, null, 2));
