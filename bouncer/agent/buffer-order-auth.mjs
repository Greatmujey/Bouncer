/** Adapter binding the Buffer journal's exact identity and ciphertext digest
 * to the existing durable, one-use NEP-413 owner authenticator. This exposes no
 * HTTP endpoint, seller request, wallet transaction or spending permission. */
import {bufferOrderAuthAction} from '../web-src/witnessed-buffer-order-auth.mjs';
export function createBufferOrderAuthenticator({auth}={}) {
  if(!auth || typeof auth.issue!=='function' || typeof auth.authenticate!=='function') throw Error('Buffer order authentication unavailable');
  return Object.freeze({
    issue:context=>auth.issue(bufferOrderAuthAction(context)),
    async authenticate({purpose,identity,capsule_sha256,evidence}={}) {
      try {
        const action=bufferOrderAuthAction({purpose,identity,...(purpose==='record'?{capsuleSha256:capsule_sha256}:{})});
        return await auth.authenticate({action,evidence})===true;
      } catch { return false; }
    },
  });
}
