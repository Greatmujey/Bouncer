/**
 * Read-only preparation for the proposed temporary-key create. The invoke gate
 * is intentionally closed: the repository has no independently verified
 * restore/latest-head implementation yet. It cannot prompt a live wallet.
 * Synthetic sandbox success must never be used to open this gate.
 */
import {prepareV14BootstrapCreateOnceCore} from './v14-bootstrap-create-once-core.mjs';

export function prepareV14BootstrapCreateOnce(options={}) {
  // Set LAST: a caller cannot replace the missing real recovery gate with an
  // injected boolean. This remains a stop, even if an owner says "approved".
  return prepareV14BootstrapCreateOnceCore({...options,assertRecoveryReady:async()=>false});
}
