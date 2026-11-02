/**
 * Narrow testnet-trial owner profile, not an on-chain access-control rule.
 * A V11 owner contract can forward a 1-yocto privileged call, so this profile
 * accepts only an initialized account with no local or global contract at the
 * pinned block. A trusted RPC, absence of earlier in-flight receipts and the
 * owner's future actions remain separate assumptions.
 */
import { isTransactionHash } from './direct-payment-settlement.mjs';

export const NO_LOCAL_CONTRACT_HASH = '11111111111111111111111111111111';
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const absentOrNull = (value, key) => !Object.hasOwn(value, key) || value[key] === null;

export function hasPlainOwnerProfileAt(account, blockHash) {
  return isTransactionHash(blockHash) && record(account) && account.block_hash === blockHash &&
    account.code_hash === NO_LOCAL_CONTRACT_HASH &&
    absentOrNull(account, 'global_contract_hash') && absentOrNull(account, 'global_contract_account_id') &&
    (!Object.hasOwn(account, 'state') || account.state === 'initialized') &&
    absentOrNull(account, 'bootstrap_nonce');
}
