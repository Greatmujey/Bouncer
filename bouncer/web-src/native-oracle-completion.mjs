/**
 * Shape/freshness validation for a setup completion returned by the trusted,
 * separately authenticated backend. This is NOT RPC consensus proof, owner
 * consent, independent storage verification or a nonce reservation. Callers
 * must verify the review and authenticate the source of this snapshot.
 */
import { decodeNativeHash32 } from './native-oracle-transaction.mjs';
const plain=x=>x && typeof x==='object' && !Array.isArray(x) && Object.getPrototypeOf(x)===Object.prototype;
const fail=()=>new Error('native oracle signing unavailable or uncertain; stop and reconcile, never retry automatically');
const CHECKS=['plain_owner','exact_owner_key','owner_native_estimate','protocol_and_selected_features',
  'agent_gas_allowance_estimate','pinned_project_identity_and_native_pricing','exact_agent_key','exact_keyless_vault',
  'native_policy_state','vault_native_balance','onchain_policy_check'];
export function assertNativeOracleCompletion(snapshot,review,clock,{maxAgeMs=5000}={}) {
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs<1 || maxAgeMs>120_000) throw fail();
  const observed=Date.parse(snapshot?.observed_at);
  const atomic=review?.format==='bouncer-atomic-native-oracle-wallet-review-v1';
  if (!atomic && review?.format!=='bouncer-native-oracle-wallet-review-v1') throw fail();
  const count=atomic?2:4, expectedStatus=atomic?'TWO_ORIGINALS_AND_STATE_MATCH_NOT_AUTHORIZED':'FOUR_ORIGINALS_AND_STATE_MATCH_NOT_AUTHORIZED';
  if (!plain(snapshot) || snapshot.version!==1 || snapshot.network!=='testnet' ||
      snapshot.status!==expectedStatus || snapshot.stage_id!=='verify_native_setup_completion' ||
      snapshot.owner!==review?.owner || snapshot.vault!==review?.vault || snapshot.review_sha256!==review?.review_sha256 ||
      snapshot.independently_witnessed!==true || !/^[a-f0-9]{40}$/.test(snapshot.witness_head??'') ||
      snapshot.execution_authorized!==false || snapshot.signing_authorized!==false || snapshot.transaction_sent!==false ||
      snapshot.owner_approval_obtained!==false || snapshot.wallet_prompt_authorized!==false ||
      !Array.isArray(snapshot.prior_original_hashes) || snapshot.prior_original_hashes.length!==count ||
      new Set(snapshot.prior_original_hashes).size!==count || !plain(snapshot.checks) ||
      CHECKS.some(k=>snapshot.checks[k]!==true) || Object.values(snapshot.checks).some(v=>v!==true) ||
      !Array.isArray(snapshot.blockers) || snapshot.blockers.length || !Number.isSafeInteger(clock) || clock<1 ||
      !Number.isSafeInteger(observed) || new Date(observed).toISOString()!==snapshot.observed_at || clock<observed || clock-observed>maxAgeMs ||
      !Number.isSafeInteger(snapshot.block_height) || snapshot.block_height<1 ||
      typeof snapshot.block_timestamp_nanosec!=='string' || !/^[1-9][0-9]{0,19}$/.test(snapshot.block_timestamp_nanosec) ||
      typeof snapshot.agent_key_nonce!=='string' || !/^(?:0|[1-9][0-9]{0,15})$/.test(snapshot.agent_key_nonce) ||
      BigInt(snapshot.agent_key_nonce)>=BigInt(Number.MAX_SAFE_INTEGER))throw fail();
  const blockMs=BigInt(snapshot.block_timestamp_nanosec)/1_000_000n;
  if(blockMs<BigInt(clock)-120_000n || blockMs>BigInt(clock)+30_000n)throw fail();
  try {decodeNativeHash32(snapshot.block_hash);for(const hash of snapshot.prior_original_hashes)decodeNativeHash32(hash)}catch{throw fail()}
  return true;
}
