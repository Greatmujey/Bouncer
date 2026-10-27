// BOUNCER client — tiny wrapper over near-api-js.
import * as nearApi from 'near-api-js';
const { keyStores, KeyPair, InMemorySigner, Account, Connection, JsonRpcProvider } = nearApi;

const ONE_YOCTO = '1';
const DEFAULT_GAS = '300000000000000'; // 300 TGas

export function parseBouncerError(err) {
  const msg = (err && (err.kind?.ExecutionError || err.message || String(err))) || '';
  if (msg.includes('DepositWithFunctionCall')) {
    return 'Blocked by NEAR protocol (DepositWithFunctionCall) — function-call keys cannot attach deposit';
  }
  const m = msg.match(/"([^"]*)"/);
  if (m) return m[1];
  const m2 = msg.match(/: ([^:]{4,160})$/);
  return m2 ? m2[1] : msg.slice(0, 240);
}

async function makeAccount({ networkId, rpcUrl, accountId, keyPair }) {
  const keystore = new keyStores.InMemoryKeyStore();
  await keystore.setKey(networkId, accountId, keyPair);
  const provider = new JsonRpcProvider({ url: rpcUrl });
  const signer = new InMemorySigner(keystore);
  const connection = Connection.fromConfig({
    networkId, provider, signer,
    jsvmAccountId: `jsvm.${networkId}`,
  });
  return new Account(connection, accountId);
}

export class BouncerClient {
  constructor({ contractId, networkId = 'testnet', accountId, privateKey, rpcUrl }) {
    this.contractId = contractId;
    this.networkId = networkId;
    this.accountId = accountId;
    this.rpcUrl = rpcUrl || (networkId === 'mainnet'
      ? 'https://rpc.mainnet.near.org'
      : 'https://rpc.testnet.near.org');
    this._key = privateKey ? KeyPair.fromString(privateKey) : null;
    this._account = null;
    this._viewAccount = null;
  }

  async _getViewAccount() {
    if (this._viewAccount) return this._viewAccount;
    const kp = KeyPair.fromRandom('ed25519');
    this._viewAccount = await makeAccount({
      networkId: this.networkId, rpcUrl: this.rpcUrl,
      accountId: 'view.near', keyPair: kp,
    });
    return this._viewAccount;
  }

  async _getAccount() {
    if (this._account) return this._account;
    if (!this._key) throw new Error('no private key for this account');
    this._account = await makeAccount({
      networkId: this.networkId, rpcUrl: this.rpcUrl,
      accountId: this.accountId, keyPair: this._key,
    });
    return this._account;
  }

  async view(method, args = {}) {
    const acct = await this._getViewAccount();
    return acct.viewFunction({ contractId: this.contractId, methodName: method, args });
  }

  async call(method, args, { deposit = '0', gas = DEFAULT_GAS } = {}) {
    const account = await this._getAccount();
    try {
      const out = await account.functionCall({
        contractId: this.contractId,
        methodName: method,
        args,
        attachedDeposit: BigInt(deposit),
        gas: BigInt(gas),
      });
      return {
        ok: true,
        result: out,
        txHash: out.transaction_outcome?.id
          ? Buffer.from(out.transaction_outcome.id).toString('base64')
          : out.transaction.hash,
      };
    } catch (err) {
      return { ok: false, error: parseBouncerError(err), raw: err };
    }
  }

  // ----- View helpers -----
  async getPolicy(id) { return this.view('get_policy', { policy_id: id }); }
  async getSpends(id, { from = 0, limit = 100 } = {}) {
    return this.view('get_spends', { policy_id: id, from_index: from, limit });
  }
  async vaultBalance(t) { return (await this.view('vault_balance', { token: t })) || '0'; }
  async check(policyId, payee, amount) {
    return this.view('check', { policy_id: policyId, payee, amount });
  }
  async listInvoices(id, onlyOpen = true) {
    return this.view('list_invoices', { policy_id: id, only_open: onlyOpen });
  }
  async getCrossIntent(id) { return this.view('get_intent', { intent_id: id }); }

  // ----- Owner methods (1 yocto, full-access key only) -----
  async setPolicy(id, policy) {
    return this.call('set_policy', { policy_id: id, policy }, { deposit: ONE_YOCTO });
  }
  async withdraw(token, amount) {
    return this.call('withdraw', { token, amount }, { deposit: ONE_YOCTO });
  }

  // ----- Agent methods (0 deposit — reachable by function-call key) -----
  async execute(policyId, payee, amount, memo = '') {
    return this.call('execute', { policy_id: policyId, payee, amount, memo });
  }
  async payInvoice(policyId, invoiceId) {
    return this.call('pay_invoice', { policy_id: policyId, invoice_id: invoiceId });
  }
  async fileInvoice(policyId, payee, amount, memo = '') {
    return this.call('file_invoice', { policy_id: policyId, payee, amount, memo });
  }
  async openCrossChain(policyId, opts) {
    return this.call('open_cross_chain', { policy_id: policyId, ...opts });
  }
  async bidCrossChain(intentId, amountOut) {
    return this.call('bid', { intent_id: intentId, amount_out: amountOut });
  }
  async confirmCrossChain(intentId, fillTxHash) {
    return this.call('confirm_cross_chain', { intent_id: intentId, fill_tx_hash: fillTxHash });
  }
}

export function fmt(amountSmallest, decimals = 6) {
  const a = BigInt(amountSmallest.toString());
  const unit = 10n ** BigInt(decimals);
  const whole = a / unit;
  const frac = a % unit;
  return `${whole}.${frac.toString().padStart(decimals, '0').replace(/0+$/, '') || '0'}`;
}

export const NS = {
  SECOND: 1_000_000_000n,
  MINUTE: 60_000_000_000n,
  HOUR: 3_600_000_000_000n,
  DAY: 86_400_000_000_000n,
  MONTH: 30n * 86_400_000_000_000n,
};

// Generate a new ed25519 keypair and return the implicit account ID + secret.
// Used by the dashboard to create a fresh function-call key for the agent.
export function generateAgentKey() {
  const kp = KeyPair.fromRandom('ed25519');
  const publicKeyStr = kp.getPublicKey().toString();
  const secretKeyStr = kp.toString();
  return { publicKey: publicKeyStr, secretKey: secretKeyStr };
}
