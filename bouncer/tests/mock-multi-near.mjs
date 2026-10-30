// TEST-ONLY transport for demo-multi-resource.mjs. No network transactions.
import nearApi from 'near-api-js';
const { Account, providers } = nearApi;
const T = 10n ** 12n;
const balances = new Map();
const vault = new Map();
const tokens = new Map([['wrap.testnet', { symbol: 'wNEAR', decimals: 24 }]]);
const policies = new Map();
const spent = new Map();
const allowed = new Map();
const grants = new Map();
const accessKeys = new Map();
const transactionsByHash = new Map();
let owner;
let tx = 0;
const ok = (executor = 'mock.testnet') => ({
  final_execution_status: 'FINAL',
  transaction_outcome: { id: `mock-${++tx}` },
  receipts_outcome: [{ outcome: { executor_id: executor, status: { SuccessValue: '' }, logs: [] } }],
});
const balance = (token, id) => balances.get(`${token}|${id}`) || 0n;
const add = (token, id, delta) => balances.set(`${token}|${id}`, balance(token, id) + delta);
const setFor = (map, id) => { if (!map.has(id)) map.set(id, new Set()); return map.get(id); };
const fail = message => { throw new Error(message); };

const originalFetch = globalThis.fetch;
let publicModelCalls = 0;
globalThis.fetch = async (url, ...args) => {
  if (String(url) === 'https://model.example/v1/chat/completions') {
    const request = JSON.parse(args[0].body);
    const publicData = request.messages[1].content.includes('public GitHub repository metadata');
    const comparison = request.messages[1].content.includes('compare development providers');
    const tasks = publicData ? [{ resource: 'api', input: { repo: 'near/near-api-js' } }] : comparison ?
      [{ resource: 'compute', input: { text: 'compare development providers', rounds: 3 } }] : [
        { resource: 'compute', input: { text: 'near-hub compute job', rounds: 1000 } },
        { resource: 'storage', input: { name: 'bouncer-note', content: 'Persisted by the Bouncer testnet provider.' } },
        { resource: 'api', input: { text: 'actual testnet resource API' } },
      ];
    if (comparison && process.env.BOUNCER_MOCK_MODE === 'comparison_wrong') tasks[0].input.text = 'wrong';
    if (publicData) {
      publicModelCalls++;
      if (process.env.BOUNCER_MOCK_MODE === 'wrong_repo_always' || (process.env.BOUNCER_MOCK_MODE === 'wrong_repo_once' && publicModelCalls === 1)) {
        tasks[0].input.repo = 'near-api-js/near-api-js';
      }
    }
    if (process.env.BOUNCER_MOCK_MODE === 'model_attack') tasks[0].payee = 'attacker.testnet';
    if (process.env.BOUNCER_MOCK_MODE === 'model_wrong_input') tasks[0].input.text = 'different';
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ tasks }) } }] }));
  }
  if (String(url) === 'https://api.github.com/repos/near/near-api-js') {
    return new Response(JSON.stringify({ private: false, full_name: 'near/near-api-js', id: 184860689,
      description: 'Mock public data', stargazers_count: 10, forks_count: 3, open_issues_count: 2, license: { spdx_id: 'MIT' } }));
  }
  return String(url).startsWith('http://127.0.0.1:') ? originalFetch(url, ...args) : ({ ok: true, json: async () => ({}) });
};
Account.prototype.deployContract = async function () { return ok(); };
let accountAttempts = 0, setupAttempts = 0;
const setupError = (type, withOutcome = false) => Object.assign(new Error(type === 'Expired' ? 'Transaction has expired' : 'RPC timeout'),
  { type, ...(withOutcome ? { transaction_outcome: { id: 'known-outcome' } } : {}) });
Account.prototype.createAccount = async function () {
  accountAttempts++;
  if ((process.env.BOUNCER_MOCK_MODE === 'setup_expired_once' && accountAttempts === 1) ||
      process.env.BOUNCER_MOCK_MODE === 'setup_expired_twice') throw setupError('Expired');
  if (process.env.BOUNCER_MOCK_MODE === 'setup_timeout') throw setupError('Timeout');
  if (process.env.BOUNCER_MOCK_MODE === 'setup_expired_with_outcome') throw setupError('Expired', true);
  return ok();
};
Account.prototype.signAndSendTransaction = async function ({ receiverId, actions, waitUntil }) {
  const added = actions?.[0]?.addKey;
  const permission = added?.accessKey?.permission?.functionCall;
  if (receiverId !== this.accountId || waitUntil !== 'FINAL' || !permission) fail('invalid access key action');
  accessKeys.set(added.publicKey.toString(), { receiver_id: permission.receiverId, method_names: permission.methodNames });
  return ok();
};
providers.JsonRpcProvider.prototype.viewNodeStatus = async () => ({ chain_id: process.env.BOUNCER_MOCK_MODE === 'wrong_chain' ? 'mainnet' : (process.env.MOCK_CHAIN || 'testnet') });
providers.JsonRpcProvider.prototype.viewAccessKey = async function (_id, publicKey) {
  const permission = accessKeys.get(publicKey.toString());
  return { permission: permission ? { FunctionCall: permission } : 'FullAccess' };
};
Account.prototype.callFunctionRaw = async function ({ contractId, methodName, args, deposit, gas, waitUntil }) {
  if (typeof gas !== 'bigint' || typeof deposit !== 'bigint' || waitUntil !== 'FINAL') fail('invalid call options');
  const pk = (await this.signer.getPublicKey()).toString();
  if (accessKeys.has(pk) && (methodName !== 'execute' || deposit !== 0n)) fail('restricted key misuse');
  if (methodName === 'grant_agent_key' && process.env.BOUNCER_MOCK_MODE === 'setup_policy_expired_once' && setupAttempts++ === 0) throw setupError('Expired');
  if (methodName === 'execute' && process.env.BOUNCER_MOCK_MODE === 'payment_expired') throw setupError('Expired');
  switch (methodName) {
    case 'new': owner = args.owner; return ok(contractId);
    case 'create_token': {
      if (process.env.BOUNCER_MOCK_MODE === 'factory_failure') fail('factory unavailable');
      if (gas !== 300n * T || deposit <= 0n) fail('invalid factory funding');
      const info = args.args;
      const tokenId = `${info.metadata.symbol.toLowerCase()}.token.primitives.testnet`;
      tokens.set(tokenId, info.metadata);
      add(tokenId, info.owner_id, BigInt(info.total_supply));
      return ok('token.primitives.testnet');
    }
    case 'storage_deposit': return ok(contractId);
    case 'near_deposit': add(contractId, this.accountId, deposit); return ok(contractId);
    case 'set_policy':
      if (deposit !== 1n || this.accountId !== owner) fail('unauthorized policy setter');
      policies.set(args.policy_id, { token: args.token, per_tx_cap: args.per_tx_cap, daily_cap: args.daily_cap });
      return ok(contractId);
    case 'allow_payee':
      if (deposit !== 1n || this.accountId !== owner) fail('unauthorized allowlist setter');
      setFor(allowed, args.policy_id).add(args.payee);
      return ok(contractId);
    case 'grant_agent_key':
      if (deposit !== 1n || this.accountId !== owner) fail('unauthorized grant');
      setFor(grants, args.policy_id).add(args.public_key);
      return ok(contractId);
    case 'ft_transfer_call': {
      const amount = BigInt(args.amount);
      if (deposit !== 1n || balance(contractId, this.accountId) < amount) fail('invalid funding');
      add(contractId, this.accountId, -amount);
      add(contractId, args.receiver_id, amount);
      vault.set(contractId, (vault.get(contractId) || 0n) + amount);
      return ok(contractId);
    }
    case 'execute': {
      if (deposit !== 0n || this.accountId !== owner || !grants.get(args.policy_id)?.has(pk)) fail('unauthorized execute');
      const policy = policies.get(args.policy_id);
      const amount = BigInt(args.amount);
      if (policy?.token !== args.expected_token || !allowed.get(args.policy_id)?.has(args.payee) ||
          amount > BigInt(policy.per_tx_cap) || amount > (vault.get(policy.token) || 0n)) fail('policy rejected');
      vault.set(policy.token, vault.get(policy.token) - amount);
      spent.set(args.policy_id, (spent.get(args.policy_id) || 0n) + amount);
      add(policy.token, contractId, -amount);
      add(policy.token, args.payee, amount);
      const result = ok(policy.token);
      result.status = { SuccessValue: '' };
      result.transaction = {
        hash: result.transaction_outcome.id, signer_id: this.accountId, receiver_id: contractId,
        actions: [{ FunctionCall: { method_name: methodName, deposit: deposit.toString(), args: Buffer.from(JSON.stringify(args)).toString('base64') } }],
      };
      transactionsByHash.set(result.transaction.hash, result);
      return result;
    }
    default: fail(`unexpected method ${methodName}`);
  }
};
providers.JsonRpcProvider.prototype.callFunction = async function (id, method, args) {
  switch (method) {
    case 'contract_version': return 'bouncer-agent-v8';
    case 'get_required': return (2n * 10n ** 24n).toString();
    case 'ft_metadata': return tokens.get(id);
    case 'storage_balance_bounds': return { min: '1250000000000000000000', max: null };
    case 'ft_balance_of': return balance(id, args.account_id).toString();
    case 'vault_balance': return (vault.get(args.token) || 0n).toString();
    case 'get_policy': return policies.get(args.policy_id) || null;
    case 'daily_spent': return (spent.get(args.policy_id) || 0n).toString();
    case 'is_agent_key_allowed': return grants.get(args.policy_id)?.has(args.public_key) || false;
    case 'check': {
      const policy = policies.get(args.policy_id);
      const valid = policy && allowed.get(args.policy_id)?.has(args.payee) &&
        BigInt(args.amount) <= BigInt(policy.per_tx_cap) && BigInt(args.amount) <= (vault.get(policy.token) || 0n);
      return [!!valid, valid ? 'ok' : 'blocked'];
    }
    default: fail(`unexpected view ${id}.${method}`);
  }
};

providers.JsonRpcProvider.prototype.viewTransactionStatus = async function (hash, accountId, waitUntil) {
  if (accountId !== owner || waitUntil !== 'FINAL' || !transactionsByHash.has(hash)) fail('unknown transaction');
  return transactionsByHash.get(hash);
};
