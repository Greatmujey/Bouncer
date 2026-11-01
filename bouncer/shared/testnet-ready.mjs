/**
 * After the testnet helper reports account creation, wait for the exact new
 * access key to become visible on the optimistic RPC used for signing. This
 * only repeats read-only queries before a transaction is created; it never
 * retries a broadcast, an ambiguous payment or a different RPC failure.
 */
const MISSING = new Set(['AccessKeyDoesNotExist', 'AccountDoesNotExist', 'UnknownAccount']);
export async function waitForNewTestnetKey(provider, accountId, publicKey, {
  attempts = 12, delay = () => new Promise(resolve => setTimeout(resolve, 1000)),
} = {}) {
  if (!provider || typeof provider.viewAccessKey !== 'function' || typeof accountId !== 'string' || !accountId || !publicKey ||
      !Number.isInteger(attempts) || attempts < 1 || attempts > 30 || typeof delay !== 'function') throw new Error('invalid testnet key readiness check');
  for (let i = 0; i < attempts; i++) {
    try {
      const access = await provider.viewAccessKey(accountId, publicKey, { finality: 'optimistic' });
      if (!access || access.permission !== 'FullAccess') throw new Error('new testnet helper key is not full access');
      return;
    } catch (error) {
      if (!MISSING.has(error?.type) || i === attempts - 1) throw error;
      await delay();
    }
  }
}

/**
 * A new helper account can be visible optimistically before it is final.
 * Repeat only missing-account/key FINAL reads, never a transaction broadcast.
 * Return the account view only after the expected full-access key is FINAL.
 */
export async function waitForFinalTestnetAccount(provider, accountId, publicKey, {
  attempts = 20, delay = () => new Promise(resolve => setTimeout(resolve, 1000)),
} = {}) {
  if (!provider || typeof provider.query !== 'function' || typeof provider.viewAccessKey !== 'function' ||
      typeof accountId !== 'string' || !accountId || !publicKey || !Number.isInteger(attempts) || attempts < 1 || attempts > 30 ||
      typeof delay !== 'function') throw new Error('invalid finalized testnet account readiness check');
  for (let i = 0; i < attempts; i++) {
    try {
      const account = await provider.query({ request_type: 'view_account', account_id: accountId, finality: 'final' });
      const key = await provider.viewAccessKey(accountId, publicKey, { finality: 'final' });
      if (!account || typeof account.amount !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(account.amount) ||
          !Number.isSafeInteger(account.storage_usage) || account.storage_usage < 0 || key?.permission !== 'FullAccess') {
        throw new Error('invalid finalized testnet account or full-access key');
      }
      return account;
    } catch (error) {
      if (!MISSING.has(error?.type) || i === attempts - 1) throw error;
      await delay();
    }
  }
}
