/**
 * Verify a connected named testnet wallet with a fresh NEP-413 message.
 * This is a browser-only identity check: it does not request a transaction,
 * approve a vault, add a key, authorize spending, or authenticate a server.
 * The wallet and the fixed testnet RPC remain trust boundaries.
 */
import { isTestnetAccount } from './wallet-utils.mjs';
import { verifyCliLogin } from './cli-login.mjs';

export async function verifyConnectedWalletOwner({ wallet, accountId, location, crypto, fetch } = {}) {
  if (!wallet || typeof wallet.signMessage !== 'function' || !isTestnetAccount(accountId) ||
      !crypto?.getRandomValues || !crypto?.subtle || typeof fetch !== 'function' ||
      !location || typeof location.origin !== 'string' || typeof location.host !== 'string') {
    throw new Error('WALLET_OWNER_VERIFICATION_UNAVAILABLE');
  }
  let url;
  try { url = new URL(location.origin); } catch { throw new Error('WALLET_OWNER_VERIFICATION_UNAVAILABLE'); }
  if (url.origin !== location.origin || url.host !== location.host ||
      !['https:', 'http:'].includes(url.protocol) ||
      (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('WALLET_OWNER_VERIFICATION_UNAVAILABLE');
  }
  const nonce = crypto.getRandomValues(new Uint8Array(32));
  const expectedNonce = new Uint8Array(nonce); // the wallet never receives this copy
  const recipient = url.host;
  const message = `Verify ${accountId} for Bouncer on NEAR testnet.\n\n` +
    `This is an off-chain identity message. It does not approve a transaction, transfer funds, add a key, or grant spending access.\n\nSite: ${url.origin}`;
  // Only a copy of the nonce goes to the adapter. A stale signature or an
  // adapter-mutated challenge cannot be reused against the retained bytes.
  // The pinned NEAR Mobile executor uses the nonstandard accountId option;
  // other Near Connect adapters receive the standard signerId field.
  const mobileAccount = wallet.manifest?.id === 'near-mobile' ? { accountId } : {};
  const signed = await wallet.signMessage({ network: 'testnet', signerId: accountId, ...mobileAccount,
    message, nonce: new Uint8Array(nonce), recipient });
  const account = { accountId, publicKey: signed?.publicKey, signedMessage: signed };
  await verifyCliLogin({ account, message, nonce: expectedNonce, recipient, crypto, fetch });
  return Object.freeze({ accountId, publicKey: signed.publicKey, network: 'testnet',
    walletControlVerified: true, transactionApproved: false, spendingAccessGranted: false });
}
