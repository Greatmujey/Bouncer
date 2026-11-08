/**
 * Recover the one witnessed native trial on another cooperating device/process.
 * The anchored witness already contains the original hash BEFORE signing.
 * This copies only public identity and the original hash to an empty local
 * journal, then uses the existing receipt verifier. It never signs, broadcasts,
 * creates a replacement, or treats missing/unknown receipts as non-execution.
 */
import { isDeepStrictEqual } from 'node:util';
import { withExclusiveJournalOperation } from './journal-operation.mjs';
import { assertJournalScope } from './journal-write.mjs';
import { readNativeJournal, writeConfirmedNativeJournal } from './synchronous-native-journal.mjs';
import { recoverOracleGoal } from './oracle-outlayer.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';
import { validateWitnessedNativeOracleTrial, assertWitnessedNativeOracleTrial } from './native-oracle-phone-signer.mjs';

const fail=()=>new Error('witnessed native original is unavailable or inconsistent; stop and reconcile, never resend');

export async function recoverWitnessedNativeOracle({goal,review,identity,wasmBytes,loaderBytes,compressedBytes,trustedReviewHash,trustedOwnerPublicKey,
  witness,provider,journal,log=console.log,exclusiveJournalScope}={}) {
  if(!witness || typeof witness.inspect!=='function' || !journal || typeof journal.get!=='function' ||
      typeof journal.put!=='function' || !provider)throw fail();
  const checked=validateWitnessedNativeOracleTrial({goal,review,identity,wasmBytes,loaderBytes,compressedBytes,trustedReviewHash,trustedOwnerPublicKey});
  return withExclusiveJournalOperation(journal,async scope=>{
    assertJournalScope(journal,checked.goal.contract_id,checked.goal.owner_account_id);
    const snapshot=await witness.inspect(checked.identity.owner),original=snapshot?.state?.trial?.original_hash;
    const expected={goal_id:checked.goal.id,goal_sha256:checked.goalSha256,
      agent_public_key:checked.agentPublicKey,original_hash:original};
    assertWitnessedNativeOracleTrial(snapshot,checked.identity,expected);
    // Never restore a guessed or malformed original.
    if(!isTransactionHash(original))throw fail();
    const existing=readNativeJournal(journal,checked.goal.id);
    if(existing) {
      if(existing.fingerprint!==checked.goalSha256 || existing.tx_hash!==original ||
          existing.agent_public_key!==checked.agentPublicKey || !isDeepStrictEqual(existing.oracle_goal,checked.goal) ||
          !['pending','completed'].includes(existing.status))throw fail();
    } else {
      const pending={fingerprint:checked.goalSha256,status:'pending',oracle_goal:checked.goal,
        agent_public_key:checked.agentPublicKey,tx_hash:original,recovered_from_witness:true};
      writeConfirmedNativeJournal(journal,checked.goal.id,pending,null);
    }
    // This is receipt-only. Unknown or absent receipts remain unresolved.
    return recoverOracleGoal({goal:checked.goal,provider,journal,publicKey:checked.agentPublicKey,log,
      exclusiveJournalScope:scope});
  },exclusiveJournalScope);
}
