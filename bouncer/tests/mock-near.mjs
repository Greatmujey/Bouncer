// Test-only NEAR transport. Used with `node --import` to exercise the real demo
// without accessing a network or pretending that these transactions are live.
import nearApi from 'near-api-js';

const { Account, providers } = nearApi;
const ONE_NEAR = 10n ** 24n;
const TGAS = 10n ** 12n;
const tokenBalances = new Map();
const policies = new Map();
const allowlists = new Map();
let owner;
let vault = 0n;
let spent = 0n;
let tx = 0;

const outcome = (logs = []) => ({
  transaction_outcome: { id: `mock-tx-${++tx}` },
  receipts_outcome: [{ outcome: { status: { SuccessValue: '' }, logs } }],
});
const credit = (id, delta) => tokenBalances.set(id, (tokenBalances.get(id) || 0n) + delta);
const fail = message => { throw new Error(message); };

// This preload is used only in subprocess tests; never in the live demo.
globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });
Account.prototype.deployContract = async function () { return outcome(); };
Account.prototype.createAccount = async function () { return outcome(); };
Account.prototype.callFunctionRaw = async function ({ contractId, methodName, args, deposit, gas, waitUntil }) {
  if (typeof deposit !== 'bigint' || typeof gas !== 'bigint') fail('gas and deposit must be bigint');
  if (waitUntil !== 'FINAL') fail('demo must wait for final execution');
  const expectedGas = ['storage_deposit', 'near_deposit'].includes(methodName) ? 50n * TGAS
    : ['ft_transfer_call', 'execute'].includes(methodName) ? 200n * TGAS : 100n * TGAS;
  if (gas !== expectedGas) fail(`incorrect gas for ${methodName}: ${gas}`);

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
    case 'allow_payee':
      if (deposit !== 1n || this.accountId !== owner) fail('not authorized');
      allowlists.set(args.policy_id, new Set([args.payee]));
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
      if (deposit !== 1n) fail('wrong deposit');
      const amount = BigInt(args.amount);
      const policy = policies.get(args.policy_id);
      if (amount > BigInt(policy.per_tx_cap)) fail('BLOCKED: amount exceeds per-tx cap');
      if (!allowlists.get(args.policy_id)?.has(args.payee)) fail('BLOCKED: payee not in allowlist');
      if (amount + spent > BigInt(policy.daily_cap)) {
        if (process.env.BOUNCER_MOCK_MODE === 'wrong_rejection') fail('RPC warning: connection lost');
        if (process.env.BOUNCER_MOCK_MODE !== 'allow_daily') fail('BLOCKED: daily cap exceeded for this policy');
      }
      if (amount > vault) fail('BLOCKED: insufficient vault balance');
      if (process.env.BOUNCER_MOCK_MODE === 'payment_refund') {
        const refunded = outcome(['BOUNCER ft_transfer failed; vault refunded']);
        refunded.receipts_outcome.push({ outcome: { status: { Failure: { error: 'transfer failed' } }, logs: [] } });
        return refunded;
      }
      vault -= amount;
      spent += amount;
      credit(contractId, -amount);
      credit(args.payee, amount);
      return outcome(['BOUNCER payment executed']);
    }
    default: fail(`unexpected method ${methodName}`);
  }
};
providers.JsonRpcProvider.prototype.callFunction = async function (contractId, method, args) {
  if (method === 'vault_balance') return vault.toString();
  if (method === 'ft_balance_of') return (tokenBalances.get(args.account_id) || 0n).toString();
  fail(`unexpected view ${contractId}.${method}`);
};
