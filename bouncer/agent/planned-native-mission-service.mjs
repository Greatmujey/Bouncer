/** One bounded model proposal becomes the EXACT manifest exposed by the
 * existing owner-review service. This module starts no server and performs no
 * transaction. It is not wired into the hosted startup: a caller must obtain
 * separate approval before sharing an objective with a model or incurring any
 * model charge. The resulting mission still requires the normal explicit
 * owner consent, restrictive keys, durable originals and per-leg checks. */
import {planNativeObjective,validateNativePlanningCatalog} from './native-mission-planner.mjs';
import {createAuthenticatedNativeMissionService} from './authenticated-native-mission-service.mjs';

export async function createPlannedNativeMissionService({objective,catalog:inputCatalog,modelClient,modelRequestApproved=false,
  provider,signers,journal,auth,run,log}={}) {
  if(modelRequestApproved!==true)throw new Error('explicit approval to share the objective with the selected model is required');
  if(!signers||typeof signers!=='object'||Array.isArray(signers)||!Object.keys(signers).length) {
    throw new Error('configured restricted signers are required for a new planned mission');
  }
  // Capture the owner-controlled authority BEFORE an asynchronous model call.
  // A model can select only bounded task inputs; it cannot select these keys,
  // the provider, journal, account, budget, routes or storage destination.
  const signerSnapshot=Object.fromEntries(Object.entries(signers).map(([id,signer])=>[
    id,Object.freeze({account:signer?.account,publicKey:signer?.publicKey}),
  ]));
  Object.freeze(signerSnapshot);
  const catalog=validateNativePlanningCatalog(inputCatalog);
  const options={provider,signers:signerSnapshot,journal,auth,run,log};
  // Reject incomplete service configuration before contacting a potentially
  // billed model. Constructors do not run, preview, mutate a journal or send.
  for(const mission of [catalog.market.mission,catalog.random.mission]) {
    createAuthenticatedNativeMissionService({...options,mission});
  }
  const mission=await planNativeObjective({objective,catalog,modelClient});
  // Freeze one validated plan into the existing hash-bound review service.
  // A changed proposal cannot replace the mission after the owner reviews it.
  return createAuthenticatedNativeMissionService({...options,mission});
}
