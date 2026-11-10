// Explicitly requested status check. This never connects a wallet or sends a transaction.
export function setupRailwayConnection(doc,{fetch:fetchImpl=globalThis.fetch}={}) {
  const button=doc.querySelector('#railway-connection-check'),result=doc.querySelector('#railway-connection-status');
  if(!button||!result)return;
  let busy=false;
  button.addEventListener('click',async()=>{
    if(busy)return;busy=true;button.disabled=true;result.textContent='Checking the Railway backend…';
    try {
      const response=await fetchImpl('/api/railway-connection',{method:'GET',cache:'no-store',credentials:'omit',redirect:'error',
        signal:AbortSignal.timeout(12_000)});
      if(!response.ok||!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')??''))throw Error();
      const text=await response.text();if(text.length>1024)throw Error();const value=JSON.parse(text);
      if(!value||Array.isArray(value)||Object.keys(value).sort().join(',')!=='mission_enabled,status,transactions_enabled'||
        value.status!=='connected_standby'||value.mission_enabled!==false||value.transactions_enabled!==false)throw Error();
      result.textContent='Connected to the Railway backend. It is in standby: missions and transactions are off.';
    }catch{result.textContent='Could not confirm the Railway backend. Its current status is unknown; no transaction was sent.'}
    finally{busy=false;button.disabled=false}
  });
}
