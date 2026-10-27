// Test-only NEAR transport for exercising the actual demo without a network.
// These simulated calls are not evidence of live blockchain behavior.
import nearApi from 'near-api-js';

const { Account, providers } = nearApi;
const TGAS = 10n ** 12n;
const tokenBalances = new Map();
const policies = new Map();
const allowlists = new Map();
const agentGrants = new Map();
const accessKeys = new Map();
const spent = new Map();
let owner;
let vault = 0n;
let tx = 0;
let refundAttempts = 0;
let rejectionAttempts = 0;

const outcome = (logs = []) => ({
  transaction_outcome: { id: `mock-tx-${++tx}` },
  receipts_outcome: [{ outcome: { status: { SuccessValue: '' }, logs } }],
});
const credit = (id, delta) => tokenBalances.set(id, (tokenBalances.get(id) || 0n) + delta);
const fail = (message, type) => { const error = new Error(message); if (type) error.type = type; throw error; };
const setFor = (map, name) => { if (!map.has(name)) map.set(name, new Set()); return map.get(name); };

globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });
Account.prototype.deployContract = async function () { return outcome(); };
Account.prototype.createAccount = async function () { return outcome(); };
Account.prototype.signAndSendTransaction = async function ({ receiverId, actions, waitUntil }) {
  const added = actions?.[0]?.addKey;
  const permission = added?.accessKey?.permission?.functionCall;
  if (receiverId !== this.accountId || this.accountId !== owner || waitUntil !== 'FINAL' || !permission) fail('invalid access key action');
  accessKeys.set(added.publicKey.toString(), { receiver_id: permission.receiverId, method_names: permission.methodNames });
  return outcome();
};
Account.prototype.deleteKey = async function (publicKey) {
  if (!accessKeys.delete(publicKey.toString())) fail('unknown key');
  return outcome();
};
providers.JsonRpcProvider.prototype.viewAccessKey = async function (_accountId, publicKey) {
  const permission = accessKeys.get(publicKey.toString());
  if (!permission) fail('access key not found');
  return { permission: { FunctionCall: permission } };
};
Account.prototype.callFunctionRaw = async function ({ contractId, methodName, args, deposit, gas, waitUntil }) {
  if (typeof deposit !== 'bigint' || typeof gas !== 'bigint') fail('gas and deposit must be bigint');
  if (waitUntil !== 'FINAL') fail('demo must wait for final execution');
  const expectedGas = ['storage_deposit', 'near_deposit'].includes(methodName) ? 50n * TGAS
    : ['ft_transfer_call', 'execute'].includes(methodName) ? 200n * TGAS : 100n * TGAS;
  if (gas !== expectedGas) fail(`incorrect gas for ${methodName}: ${gas}`);
  const signingKey = (await this.signer.getPublicKey()).toString();
  const permission = accessKeys.get(signingKey);
  if (permission) {
    if (contractId !== permission.receiver_id) fail('ReceiverMismatch', 'ReceiverMismatch');
    if (deposit !== 0n && process.env.BOUNCER_MOCK_MODE !== 'missing_protocol_guard') {
      fail('DepositWithFunctionCall', 'DepositWithFunctionCall');
    }
    if (!permission.method_names.includes(methodName)) fail('MethodNameMismatch', 'MethodNameMismatch');
  }
  switch (methodName) {
    case 'new': owner = args.owner; return outcome();
    case 'storage_deposit':
      if (process.env.BOUNCER_MOCK_MODE === 'storage_failure') fail('RPC warning: storage failed');
      if (deposit !== 1_250_000_000_000_000_000_000n) fail('incorrect storage deposit');
      return outcome();
    case 'near_deposit':
      credit(this.accountId, deposit);
      return outcome();
    case 'set_policy':
      if (deposit !== 1n) fail('ESCALATION BLOCKED: owner-only method requires exactly 1 yoctoNEAR');
      if (this.accountId !== owner) fail('ESCALATION BLOCKED: caller is not owner');
      policies.set(args.policy_id, { ...args });
      return outcome();
    case 'grant_agent_key':
      if (deposit !== 1n || this.accountId !== owner) fail('not authorized');
      setFor(agentGrants, args.policy_id).add(args.public_key);
      return outcome();
    case 'revoke_agent_key':
      if (deposit !== 1n || this.accountId !== owner) fail('not authorized');
      setFor(agentGrants, args.policy_id).delete(args.public_key);
      return outcome();
    case 'allow_payee':
      if (deposit !== 1n || this.accountId !== owner) fail('not authorized');
      setFor(allowlists, args.policy_id).add(args.payee);
      return outcome();
    case 'revoke_payee':
      if (deposit !== 1n || this.accountId !== owner) fail('not authorized');
      setFor(allowlists, args.policy_id).delete(args.payee);
      return outcome();
    case 'ft_transfer_call': {
      if (deposit !== 1n) fail('wrong deposit');
      const amount = BigInt(args.amount);
      credit(this.accountId, -amount);
      credit(args.receiver_id, amount);
      vault += amount;
      return outcome(['BOUNCER deposit received']);
    }
    case 'execute': {
      if (deposit !== 0n) fail('BLOCKED: execute requires zero deposit');
      if (this.accountId !== owner) fail('BLOCKED: caller is not the owner account');
      if (!agentGrants.get(args.policy_id)?.has(signingKey)) fail('BLOCKED: signing key is not authorized for this policy');
      const amount = BigInt(args.amount);
      const policy = policies.get(args.policy_id);
      if (amount > BigInt(policy.per_tx_cap)) fail('BLOCKED: amount exceeds per-tx cap');
      if (!allowlists.get(args.policy_id)?.has(args.payee)) fail('BLOCKED: payee not in allowlist');
      if (args.expected_token !== policy.token) fail('BLOCKED: policy token does not match expected token');
      if (amount + (spent.get(args.policy_id) || 0n) > BigInt(policy.daily_cap)) {
        rejectionAttempts++;
        if (process.env.BOUNCER_MOCK_MODE === 'rejection_expired_twice' ||
            (process.env.BOUNCER_MOCK_MODE === 'rejection_expired_once' && rejectionAttempts === 1)) fail('Transaction has expired', 'Expired');
        if (process.env.BOUNCER_MOCK_MODE === 'wrong_rejection') fail('RPC warning: connection lost');
        if (process.env.BOUNCER_MOCK_MODE !== 'allow_daily') fail('BLOCKED: daily cap exceeded for this policy');
      }
      if (amount > vault) fail('BLOCKED: insufficient vault balance');
      if (args.payee.startsWith('unregistered-')) {
        refundAttempts++;
        if (process.env.BOUNCER_MOCK_MODE === 'probe_timeout') fail('RPC timed out', 'Timeout');
        if (process.env.BOUNCER_MOCK_MODE === 'probe_expired_twice' ||
            (process.env.BOUNCER_MOCK_MODE === 'probe_expired_once' && refundAttempts === 1)) fail('Transaction has expired', 'Expired');
        const refunded = outcome();
        refunded.receipts_outcome = [
          { outcome: { executor_id: owner, status: { SuccessValue: '' }, logs: ['BOUNCER payment initiated'] } },
          { outcome: { executor_id: 'wrap.testnet', status: process.env.BOUNCER_MOCK_MODE === 'missing_ft_failure' ? { SuccessValue: '' } : { Failure: { error: 'not registered' } }, logs: [] } },
          { outcome: { executor_id: owner, status: { SuccessValue: '' }, logs: process.env.BOUNCER_MOCK_MODE === 'missing_refund_log' ? [] : ['BOUNCER ft_transfer failed; vault refunded'] } },
        ];
        if (process.env.BOUNCER_MOCK_MODE === 'broken_refund') vault -= amount;
        if (['broken_refund', 'broken_daily_refund'].includes(process.env.BOUNCER_MOCK_MODE)) spent.set(args.policy_id, (spent.get(args.policy_id) || 0n) + amount);
        return refunded;
      }
      if (process.env.BOUNCER_MOCK_MODE === 'payment_refund') {
        const refunded = outcome(['BOUNCER ft_transfer failed; vault refunded']);
        refunded.receipts_outcome.push({ outcome: { status: { Failure: { error: 'transfer failed' } }, logs: [] } });
        return refunded;
      }
      vault -= amount;
      spent.set(args.policy_id, (spent.get(args.policy_id) || 0n) + amount);
      credit(contractId, -amount);
      credit(args.payee, amount);
      return outcome(['BOUNCER payment initiated']);
    }
    default: fail(`unexpected method ${methodName}`);
  }
};
providers.JsonRpcProvider.prototype.callFunction = async function (contractId, method, args) {
  if (method === 'contract_version') return 'bouncer-agent-v4';
  if (method === 'get_policy') { const p = policies.get(args.policy_id); return p ? { token: p.token, per_tx_cap: p.per_tx_cap, daily_cap: p.daily_cap } : null; }
  if (method === 'vault_balance') return vault.toString();
  if (method === 'storage_balance_of') return null;
  if (method === 'check') {
    const policy = policies.get(args.policy_id);
    return [!!policy && allowlists.get(args.policy_id)?.has(args.payee) && BigInt(args.amount) <= BigInt(policy.per_tx_cap) &&
      BigInt(args.amount) + (spent.get(args.policy_id) || 0n) <= BigInt(policy.daily_cap) && BigInt(args.amount) <= vault, 'mock verdict'];
  }
  if (method === 'ft_balance_of') return (tokenBalances.get(args.account_id) || 0n).toString();
  if (method === 'is_agent_key_allowed') return agentGrants.get(args.policy_id)?.has(args.public_key) || false;
  fail(`unexpected view ${contractId}.${method}`);
};
