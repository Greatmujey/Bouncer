// Pure, testable server-side NEP-413 verification for testnet checkpoint
// enrollment/recovery. The caller must independently reconstruct and validate
// its own exact message, nonce, action terms and expiry before and after this
// function. A trusted RPC supplies FINAL views; this is not a consensus proof.
import {nep413Payload} from '../web-src/cli-login.mjs';

const RPC='https://test.rpc.fastnear.com';
const B58='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export async function boundedV14Text(stream,limit) {
  if (!stream || typeof stream.getReader!=='function') throw Error();
  const reader=stream.getReader(),chunks=[];let size=0;
  try {
    for (;;) { const {done,value}=await reader.read(); if(done)break;
      if (!(value instanceof Uint8Array) || (size+=value.byteLength)>limit) {await reader.cancel();throw Error();}chunks.push(value); }
  } finally {reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
}
function base64(value,length) {
  if (typeof value!=='string' || value.length!==4*Math.ceil(length/3) || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw Error();
  const binary=atob(value);if(binary.length!==length || btoa(binary)!==value)throw Error();
  return Uint8Array.from(binary,c=>c.charCodeAt(0));
}
function base58(value) {
  if(typeof value!=='string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value))throw Error();
  let n=0n;for(const c of value)n=n*58n+BigInt(B58.indexOf(c));
  const bytes=[];while(n>0n){bytes.push(Number(n&255n));n>>=8n;}bytes.reverse();
  let leading=0;while(value[leading]==='1')leading++;
  const result=Uint8Array.from([...new Array(leading).fill(0),...bytes]);
  if(result.length!==32)throw Error();return result;
}
function freshBlock(block,clock) {
  const hash=block?.header?.hash,nanos=block?.header?.timestamp_nanosec;
  base58(hash);
  if(!Number.isSafeInteger(clock) || clock<1 || typeof nanos!=='string' || !/^[1-9][0-9]{0,19}$/.test(nanos))throw Error();
  const time=BigInt(nanos)/1_000_000n,local=BigInt(clock);
  if(time<local-120_000n || time>local+30_000n)throw Error();
  return hash;
}
export async function verifyFreshV14Owner({owner,ownerPublicKey,message,recipient,nonceBase64,signatureBase64,fetch:fetchImpl,crypto,now=Date.now} = {}) {
  if(typeof owner!=='string' || typeof ownerPublicKey!=='string' || !ownerPublicKey.startsWith('ed25519:') ||
     typeof message!=='string' || typeof recipient!=='string' || typeof fetchImpl!=='function' || typeof now!=='function' || !crypto?.subtle)throw Error();
  const nonce=base64(nonceBase64,32),signature=base64(signatureBase64,64),key=base58(ownerPublicKey.slice('ed25519:'.length));
  const verifyKey=await crypto.subtle.importKey('raw',key,{name:'Ed25519'},false,['verify']);
  const digest=await crypto.subtle.digest('SHA-256',nep413Payload({message,nonce,recipient}));
  if(!await crypto.subtle.verify({name:'Ed25519'},verifyKey,signature,digest))throw Error();
  async function rpc(method,params) {
    const response=await fetchImpl(RPC,{method:'POST',redirect:'error',credentials:'omit',cache:'no-store',
      headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'bouncer-v14-enrollment',method,params}),
      signal:AbortSignal.timeout(12_000)});
    if(!response.ok)throw Error();
    const result=JSON.parse(await boundedV14Text(response.body,16_384));
    if(result?.jsonrpc!=='2.0' || result.id!=='bouncer-v14-enrollment' || result.error || !result.result)throw Error();
    return result.result;
  }
  const status=await rpc('status',[]);if(status.chain_id!=='testnet')throw Error();
  const block=await rpc('block',{finality:'final'}),hash=freshBlock(block,now());
  const access=await rpc('query',{request_type:'view_access_key',block_id:hash,account_id:owner,public_key:ownerPublicKey});
  if(access.block_hash!==hash || access.permission!=='FullAccess')throw Error();
  freshBlock(block,now());return {block_hash:hash};
}
