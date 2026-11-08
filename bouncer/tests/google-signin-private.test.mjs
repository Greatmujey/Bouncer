import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../web/google-signin.mjs',import.meta.url),'utf8');
async function harness({hash='',stored='',origin='https://bouncer-near.vercel.app'}={}) {
  const events=new Map(),elements=new Map(),requests=[],scripts=[];
  function element(selector) {
    if(!elements.has(selector)) {
      const handlers=new Map();
      elements.set(selector,{hidden:false,disabled:false,textContent:'',parentElement:{clientWidth:280},
        addEventListener(type,fn){handlers.set(type,fn)}, fire(type){handlers.get(type)?.()},replaceChildren(){},append(){},setAttribute(){}});
    }
    return elements.get(selector);
  }
  const location={origin,hash,href:`${origin}/${hash}`};
  const document={querySelector:element,createElement(){return {}},head:{append(script){scripts.push(script)}}};
  const window={addEventListener(type,fn){events.set(type,fn)}};
  const context={document,window,location,sessionStorage:{getItem(){return stored}},URL,AbortSignal,
    setTimeout(){return 1},clearTimeout(){},
    fetch:async(url)=>{requests.push(String(url));return {ok:true,json:async()=>String(url).includes('challenge=1')
      ?{clientId:'synthetic',nonce:'synthetic'}:{authenticated:false}}}};
  vm.runInNewContext(source,context);
  await new Promise(resolve=>setImmediate(resolve));
  return {element,events,requests,scripts};
}

test('a direct-test link does not automatically load Google when the wallet picker opens',async()=>{
  for(const options of [{hash:`#bouncer-direct=${'a'.repeat(43)}`},{hash:'#connect',stored:'a'.repeat(43)}]){
    const h=await harness(options);assert.equal(h.requests.length,1);
    h.events.get('bouncer:account-picker-open')();await new Promise(resolve=>setImmediate(resolve));
    assert.equal(h.requests.length,1);assert.equal(h.scripts.length,0);
    h.element('#google-start').fire('click');await new Promise(resolve=>setImmediate(resolve));
    assert.equal(h.requests.length,2);assert.equal(h.scripts.length,1); // Explicit selection still works.
  }
});

test('ordinary public-site picker retains automatic Google setup',async()=>{
  const h=await harness();h.events.get('bouncer:account-picker-open')();
  await new Promise(resolve=>setImmediate(resolve));assert.equal(h.requests.length,2);assert.equal(h.scripts.length,1);
});
