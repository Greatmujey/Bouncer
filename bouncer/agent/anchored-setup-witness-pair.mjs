/**
 * Construct both experimental setup witnesses against ONE Git checkout/branch
 * and ONE externally supplied checkpoint. This prevents an accidental pairing
 * of two different Git stores that happen to share an old commit hash.
 *
 * The anchor implementation must itself be separately operated and protected
 * against rollback; a local/in-memory checkpoint is for synthetic tests only.
 * This factory provisions nothing and does not make either coordinator a live
 * spending service or provide an owner-lock release/handoff.
 */
import { createGitBranchWitnessStore, createGitNativeOraclePromptWitnessStore } from './git-branch-witness-store.mjs';
import { createGitWitnessRangeAudit } from './git-witness-range-audit.mjs';
import { createAnchoredWitnessStore } from './anchored-witness-store.mjs';
import { createWalletPromptWitness } from './git-wallet-prompt-witness.mjs';
import { createNativeOraclePromptWitness } from './git-native-oracle-prompt-witness.mjs';

export function createAnchoredSetupWitnessPair({ repo, branch, initialHead, anchor } = {}) {
  const options = { repo, branch, initialHead }, audit = createGitWitnessRangeAudit({ repo });
  const walletStore = createAnchoredWitnessStore({ store: createGitBranchWitnessStore(options), anchor, audit });
  const nativeStore = createAnchoredWitnessStore({ store: createGitNativeOraclePromptWitnessStore(options), anchor, audit });
  return Object.freeze({ wallet: createWalletPromptWitness({ store: walletStore }),
    native: createNativeOraclePromptWitness({ store: nativeStore }) });
}
