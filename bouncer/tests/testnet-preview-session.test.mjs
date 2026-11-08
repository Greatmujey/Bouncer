import test from 'node:test';
import assert from 'node:assert/strict';
import {isQuickTunnelOrigin,findQuickTunnelOrigin,validatePreviewEndpoints,emptyReadOnlyBridge} from '../agent/testnet-preview-session.mjs';

test('only an exact HTTPS quick-tunnel origin is accepted',()=>{
  const site='https://blue-book-test.trycloudflare.com';
  assert.equal(isQuickTunnelOrigin(site),true);
  for(const value of ['http://blue-book-test.trycloudflare.com','https://blue-book-test.trycloudflare.com/path',
    'https://blue-book-test.trycloudflare.com.evil.test','https://user@blue-book-test.trycloudflare.com','https://blue-book-test.trycloudflare.com:443'])assert.equal(isQuickTunnelOrigin(value),false);
  assert.equal(findQuickTunnelOrigin(`ready ${site}\n`),site);
  assert.throws(()=>findQuickTunnelOrigin(`${site} https://other.trycloudflare.com`));
});

test('endpoints must be distinct, exact, and bound to the runner site and run',()=>{
  const site='https://blue-book-test.trycloudflare.com';
  const input={version:1,run_id:'123',mode:'connect-testnet-preview',site_origin:site,checkpoint_origin:'https://another-tunnel.trycloudflare.com'};
  assert.deepEqual(validatePreviewEndpoints(input,'123',site),input);
  for(const invalid of [{...input,run_id:'124'},{...input,checkpoint_origin:site},{...input,extra:true},{...input,site_origin:'https://other.trycloudflare.com'}]){
    assert.throws(()=>validatePreviewEndpoints(invalid,'123',site));
  }
});

test('direct-read preview has no relay work or accepted results',()=>{
  const bridge=emptyReadOnlyBridge();assert.deepEqual(bridge.pending(),[]);assert.equal(bridge.take(),null);assert.equal(bridge.takeForBrowser(),null);
  assert.equal(bridge.submit(),false);assert.equal(bridge.submitEncrypted(),false);
});
