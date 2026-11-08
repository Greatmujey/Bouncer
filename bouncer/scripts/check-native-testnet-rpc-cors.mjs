// Read-only compatibility probe for the public testnet RPC and Bouncer's
// dedicated browser origin. It never creates, signs or broadcasts a transaction.
const endpoint='https://rpc.testnet.near.org',origin='https://bouncer-near.vercel.app';
const allowedOrigin=response=>['*',origin].includes(response.headers.get('access-control-allow-origin'));
const allows=(response,header,value)=>{
  const list=(response.headers.get(header)??'').toLowerCase().split(',').map(x=>x.trim());
  return list.includes('*') || list.includes(value);
};
try {
  const preflight=await fetch(endpoint,{method:'OPTIONS',redirect:'error',signal:AbortSignal.timeout(15_000),
    headers:{origin,'access-control-request-method':'POST','access-control-request-headers':'content-type'}});
  if(!preflight.ok || !allowedOrigin(preflight) || !allows(preflight,'access-control-allow-methods','post') ||
      !allows(preflight,'access-control-allow-headers','content-type'))throw Error('CORS preflight rejected');
  await preflight.body?.cancel();
  const id='bouncer-read-only-cors-probe';
  const response=await fetch(endpoint,{method:'POST',redirect:'error',signal:AbortSignal.timeout(15_000),
    headers:{origin,'content-type':'application/json',accept:'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id,method:'status',params:[]})});
  if(!response.ok || !allowedOrigin(response))throw Error('CORS status request rejected');
  const text=await response.text();if(text.length>200_000)throw Error('oversized response');
  const body=JSON.parse(text);
  if(body?.jsonrpc!=='2.0' || body.id!==id || body.error || body.result?.chain_id!=='testnet')throw Error('unexpected chain or RPC response');
  console.log('Public RPC CORS and testnet status: OK (read-only).');
  if(process.env.GITHUB_ACTIONS==='true')console.log('::notice title=Testnet RPC CORS::Read-only preflight and testnet status passed. This is not a real-phone test.');
} catch(error) {
  console.error(`Public RPC browser compatibility unconfirmed: ${error.message}. No transaction was sent.`);
  if(process.env.GITHUB_ACTIONS==='true')console.log('::warning title=Testnet RPC CORS::Read-only compatibility unconfirmed; do not attempt submission until resolved.');
  process.exitCode=1;
}
