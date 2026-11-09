/** Disposable isolated-chain rehearsal ONLY. The callback stands in for a
 * recovery gate which does not yet exist; it proves no real backup, freshness,
 * wallet, authorization or mainnet/testnet behavior. Never import this into
 * the public web bundle or use it with live accounts or wallet adapters. */
import {prepareV14BootstrapCreateOnceCore} from '../web-src/v14-bootstrap-create-once-core.mjs';

export function prepareIsolatedBootstrapCreateOnce(options={}) {
  return prepareV14BootstrapCreateOnceCore({...options,assertRecoveryReady:async()=>true});
}
