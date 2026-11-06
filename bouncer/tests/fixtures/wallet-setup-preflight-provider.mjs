// Synthetic FINAL state for database/prompt integration tests. No real RPC,
// wallet, account, key, signature, order or transaction is used here.
import nearApi from 'near-api-js';
import { CIRCLE_TESTNET_USDC as TOKEN } from '../../scripts/circle-testnet-setup.mjs';
import { BUFFER_TESTNET_CONTRACT as SELLER } from '../../experiments/buffer-forwarder/build.mjs';
import { CIRCLE_TESTNET_CODE_HASH } from '../../agent/keyless-vault-v12-readiness.mjs';

const ONE = 10n ** 24n;
const registered = () => ({ total: '1250000000000000000000', available: '0' });
const hash = n => nearApi.utils.serialize.base_encode(Buffer.alloc(32, n));

export function firstSetupPreflightFixture({ owner, ownerKey, sellerHash = hash(5) }) {
  const vault = `vault.${owner}`, blockHash = hash(20);
  const account = (code_hash, amount = 20n * ONE) => ({ block_hash: blockHash, code_hash, amount: String(amount), storage_usage: 1000 });
  const state = {
    network: 'testnet', blockAgeMs: 0, calls: [], fail: new Set(), hook: null,
    protocol: { chain_id: 'testnet', protocol_version: 88, runtime_config: { storage_amount_per_byte: '10000000000000000000',
      wasm_config: { global_contract_host_fns: true, reftypes_bulk_memory: true, gas_key_host_fns: true, universal_accounts: true } } },
    owner: account('11111111111111111111111111111111'),
    ownerKey: { block_hash: blockHash, nonce: 123, permission: 'FullAccess' },
    ownerKeys: { block_hash: blockHash, keys: [{ public_key: ownerKey, access_key: { permission: 'FullAccess', nonce: 123 } }] },
    vaultPresence: { block_hash: blockHash, exists: false }, token: account(CIRCLE_TESTNET_CODE_HASH), seller: account(sellerHash),
    bounds: { min: '1250000000000000000000', max: '1250000000000000000000' }, metadata: { symbol: 'USDC', decimals: 6 },
    ownerRegistration: registered(), vaultRegistration: null, sellerRegistration: registered(),
    ownerTokens: '20000000', vaultTokens: '0',
    sellerConfig: { owner: 'seller.testnet', agent: 'worker.testnet', owner_payout: 'seller.testnet', contributor: 'seller.testnet',
      paused: false, token_id: TOKEN, policy_version: 1 },
    sellerRules: [['custom-brief', { min_price: '5000000', max_price: '50000000', max_expense_bps: 5000, active: true }]],
    sellerProducts: [['weekly-market-brief', { price: '20000000', max_expense: '0', active: true }]],
  };
  let hooked = false;
  async function note(name, args) {
    state.calls.push([name, ...args]);
    if (state.fail.has(name)) throw new Error('synthetic private RPC error must not leak');
    if (!hooked && state.hook) { hooked = true; await state.hook(); }
  }
  const accounts = { [owner]: 'owner', [TOKEN]: 'token', [SELLER]: 'seller' };
  const registrations = { [owner]: 'ownerRegistration', [vault]: 'vaultRegistration', [SELLER]: 'sellerRegistration' };
  const methods = { storage_balance_bounds: 'bounds', ft_metadata: 'metadata', get_config: 'sellerConfig',
    get_quote_rules: 'sellerRules', get_products: 'sellerProducts' };
  const provider = {
    async viewNodeStatus() { await note('status', []); return { chain_id: state.network }; },
    async viewBlock(ref) { await note('block', [ref]); return { header: { hash: blockHash, height: 123,
      timestamp_nanosec: String(BigInt(Date.now() - state.blockAgeMs) * 1_000_000n) } }; },
    async experimental_protocolConfig(ref) { await note('protocol', [ref]); return state.protocol; },
    async viewAccount(id, ref) { const name = accounts[id]; await note(name, [id, ref]); if (!name) throw Error(); return state[name]; },
    async viewAccessKey(id, key, ref) { await note('ownerKey', [id, key, ref]); return state.ownerKey; },
    async viewAccessKeyList(id, ref) { await note('ownerKeys', [id, ref]); if (id !== owner) throw Error(); return state.ownerKeys; },
    async viewTestnetAccountPresenceAt(id, block) { await note('vaultPresence', [id, block]); if (id !== vault) throw Error(); return state.vaultPresence; },
    async callFunctionRaw(contract, method, args, ref) {
      const name = method === 'storage_balance_of' ? registrations[args.account_id] : method === 'ft_balance_of'
        ? ({ [owner]: 'ownerTokens', [vault]: 'vaultTokens' })[args.account_id] : methods[method];
      await note(name, [contract, method, args, ref]);
      const expected = ['storage_balance_of', 'ft_balance_of', 'storage_balance_bounds', 'ft_metadata'].includes(method) ? TOKEN : SELLER;
      if (!name || contract !== expected) throw Error();
      return { block_hash: blockHash, result: [...Buffer.from(JSON.stringify(state[name]))] };
    },
  };
  return { provider, state, blockHash };
}
