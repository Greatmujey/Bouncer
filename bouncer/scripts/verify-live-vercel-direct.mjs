// Compare the actual public production site with the reviewed branch assets.
// No capability, wallet, signature, or NEAR transaction is used.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {PUBLIC_WEB_FILES} from './stage-public-web.mjs';
import {VERCEL_ORIGIN} from './staged-vercel-test-site.mjs';
const root=fileURLToPath(new URL('../web/',import.meta.url));
const sha=buffer=>createHash('sha256').update(buffer).digest('hex');
let checked=0;
for(const name of PUBLIC_WEB_FILES){
  const response=await fetch(`${VERCEL_ORIGIN}/${name==='index.html'?'':name}`,{cache:'no-store',redirect:'error',signal:AbortSignal.timeout(30000)});
  assert.equal(response.status,200,`${name} HTTP status`);
  const actual=Buffer.from(await response.arrayBuffer());
  if(name==='walletconnect-config.json'){
    // This public configuration is populated from a deployment setting.
    const config=JSON.parse(actual.toString('utf8'));
    assert.deepEqual(Object.keys(config),['projectId']);
    assert.match(config.projectId,/^(?:[a-f0-9]{32})?$/i);
  }else{
    const expected=fs.readFileSync(path.join(root,name));
    assert.equal(sha(actual),sha(expected),`${name} does not match the reviewed branch`);
  }
  if(name==='index.html'){
    const csp=response.headers.get('content-security-policy')||'';
    assert.match(csp,/script-src 'self' 'nonce-Qm91bmNlclRlc3RuZXQyMDI2' https:\/\/accounts\.google\.com/);
    assert.match(csp,/object-src 'none'/);assert.match(csp,/base-uri 'none'/);assert.doesNotMatch(csp,/'unsafe-inline'|https:\/\/\*/);
    assert.match(response.headers.get('cache-control')||'',/no-cache.*must-revalidate/);
  }
  checked++;
}
console.log(`::notice title=Public Vercel assets verified::${checked} reviewed assets, exact bytes except validated deployment configuration, and CSP headers. No wallet or transaction.`);
