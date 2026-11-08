#!/usr/bin/env node
/** Verify public Supabase pooler TLS without sending credentials or SQL. */
import net from 'node:net';
import tls from 'node:tls';
import { testnetPoolerSsl } from '../agent/testnet-infra-session-config.mjs';

const regions=['us-east-1','us-west-1'];
function probe(host){
  return new Promise(resolve=>{
    let done=false,encrypted,raw;
    const finish=ok=>{if(done)return;done=true;clearTimeout(timer);encrypted?.destroy();raw?.destroy();resolve(ok)};
    const timer=setTimeout(()=>finish(false),10_000);
    raw=net.connect({host,port:5432},()=>raw.write(Buffer.from('0000000804d2162f','hex')));
    raw.on('error',()=>finish(false));
    raw.once('data',data=>{
      if(data.length!==1 || data[0]!==0x53)return finish(false);
      encrypted=tls.connect({socket:raw,servername:host,...testnetPoolerSsl()},()=>finish(encrypted.authorized===true));
      encrypted.on('error',()=>finish(false));
    });
  });
}
let ok=true;
for(const region of regions){
  const results=await Promise.all([0,1].map(async index=>({index,ok:await probe(`aws-${index}-${region}.pooler.supabase.com`)})));
  for(const r of results)console.log(`::notice title=Supabase pooler TLS::${region} cluster-${r.index} ${r.ok?'verified':'unavailable'}`);
  if(!results.some(r=>r.ok))ok=false;
}
if(!ok){console.error('A verified pooler TLS connection was unavailable. No database password or wallet was used.');process.exitCode=1}
else console.log('Pooler certificate chains and hostnames verified without credentials.');
