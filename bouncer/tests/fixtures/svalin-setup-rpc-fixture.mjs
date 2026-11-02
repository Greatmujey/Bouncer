/** Synthetic pinned RPC/state fixtures; none represent a deployed chain. */
import { CIRCLE_TESTNET_USDC as TOKEN } from '../../scripts/circle-testnet-setup.mjs';
import { SVALIN_PAYEE } from '../../agent/svalin-pro-readiness.mjs';
import { STAGES, OWNER, VAULT, hash, resultFor } from './svalin-setup-fixture.mjs';

export const BLOCK = hash(30), OTHER = hash(31), NOW = 1_800_000_000_000;
export const REG = '1250000000000000000000', COST = '10000000000000000000';
export const MAX = '5009999', ALLOWANCE = '100000000000000000000000';
export const UNFUNDED = 'BLOCKED: insufficient vault balance (fund first)';
export const stageName = i => i < STAGES.length ? STAGES[i] : 'verify_funded_vault';

export function snapshot(f, index) {
  const agentKey = f.inputs.agentPublicKey, installed = index >= 3, configured = index >= 2, funded = index === 5;
  const keys = [{ public_key: f.ownerKey, access_key: { permission: 'FullAccess' } }];
  if (installed) keys.push({ public_key: agentKey, access_key: { permission: { FunctionCall: {
    receiver_id: VAULT, method_names: ['execute_exact_ft'], allowance: ALLOWANCE } } } });
  return {
    network: 'testnet', block: { header: { hash: BLOCK, timestamp_nanosec: String(BigInt(NOW) * 1_000_000n) } },
    protocol: { chain_id: 'testnet', protocol_version: 88, runtime_config: { storage_amount_per_byte: COST } },
    owner: { block_hash: BLOCK, amount: 20n * 10n ** 24n, storage_usage: 10_000 },
    ownerKey: { block_hash: BLOCK, nonce: 2n, permission: 'FullAccess' },
    ownerKeys: { block_hash: BLOCK, keys },
    vault: { block_hash: BLOCK, amount: 7n * 10n ** 24n, storage_usage: 10_000,
      code_hash: f.inputs.goal.vault_code_hash },
    vaultKeys: { block_hash: BLOCK, keys: [] },
    presence: { exists: false, block_hash: BLOCK },
    contractOwner: OWNER, version: 'bouncer-agent-v11-exact-ft-testnet',
    policy: configured ? { token: TOKEN, per_tx_cap: MAX, daily_cap: MAX } : null,
    policyLocked: configured, pairLocked: false, agentGranted: configured, daily: '0',
    tracked: funded ? MAX : '0', vaultUsdc: funded ? MAX : '0',
    ownerUsdc: funded ? '0' : MAX,
    bounds: { min: REG, max: REG }, ownerRegistration: { total: REG, available: '0' },
    sellerRegistration: { total: REG, available: '0' },
    vaultRegistration: index >= 4 ? { total: REG, available: '0' } : null,
    verdict: funded ? [true, 'ok: within cap, payee allowed, daily ok, vault funded'] : [false, UNFUNDED],
    calls: [], failures: new Set(), raw: {}, hook: null,
  };
}
export function providerFor(f, s) {
  let ranHook = false;
  async function note(name, args) {
    s.calls.push([name, ...args]);
    if (s.failures.has(name)) throw Error('untrusted-rpc-secret-should-not-leak');
    if (!ranHook && s.hook) { ranHook = true; await s.hook(name); }
  }
  const registration = { [OWNER]: 'ownerRegistration', [VAULT]: 'vaultRegistration', [SVALIN_PAYEE]: 'sellerRegistration' };
  const names = { get_owner: 'contractOwner', contract_version: 'version', get_policy: 'policy',
    is_exact_ft_policy_locked: 'policyLocked', is_exact_ft_payee_locked: 'pairLocked',
    is_agent_key_allowed: 'agentGranted', daily_spent: 'daily', vault_balance: 'tracked',
    check: 'verdict', storage_balance_bounds: 'bounds' };
  return {
    async viewNodeStatus() { await note('status', []); return { chain_id: s.network }; },
    async viewBlock(ref) { await note('block', [ref]); return s.block; },
    async experimental_protocolConfig(ref) { await note('protocol', [ref]); return s.protocol; },
    async viewAccount(account, ref) {
      const name = account === OWNER ? 'owner' : 'vault'; await note(name, [account, ref]); return s[name];
    },
    async viewAccessKey(account, key, ref) { await note('ownerKey', [account, key, ref]); return s.ownerKey; },
    async viewAccessKeyList(account, ref) {
      const name = account === OWNER ? 'ownerKeys' : 'vaultKeys'; await note(name, [account, ref]); return s[name];
    },
    async viewTestnetAccountPresenceAt(account, block) { await note('presence', [account, block]); return s.presence; },
    async callFunctionRaw(contract, method, args, ref) {
      const name = method === 'storage_balance_of' ? registration[args.account_id] : method === 'ft_balance_of' ?
        (args.account_id === OWNER ? 'ownerUsdc' : 'vaultUsdc') : names[method];
      await note(name, [contract, method, args, ref]);
      if (!name || (['ownerRegistration', 'vaultRegistration', 'sellerRegistration', 'ownerUsdc', 'vaultUsdc', 'bounds'].includes(name)
        ? contract !== TOKEN : contract !== VAULT)) throw Error('unexpected synthetic view');
      if (Object.hasOwn(s.raw, name)) return s.raw[name];
      return { block_hash: BLOCK, result: [...Buffer.from(JSON.stringify(s[name]))] };
    },
  };
}
export async function completeThrough(f, index) {
  await f.init();
  for (let i = 0; i < index; i++) {
    const tx = await f.signed(i, BigInt(i + 1));
    await f.record(i, tx.signed);
    await f.reconcile(i, resultFor(f, i, tx.txHash));
  }
}
