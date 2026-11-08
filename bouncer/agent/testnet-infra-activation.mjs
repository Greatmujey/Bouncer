/** Wait for a separate, exact infrastructure activation instruction. Missing
 * or temporarily unreadable instructions only wait. Once activation begins,
 * any error is returned to the caller and is never retried here. This does not
 * authorize a wallet, sign or submit a transaction. */
export async function waitForTestnetInfraActivation({runId,readControl,activate,wait,now=Date.now,deadline}={}){
  if(!/^[1-9][0-9]{0,19}$/.test(runId??'') || typeof readControl!=='function' || typeof activate!=='function' ||
     typeof wait!=='function' || typeof now!=='function' || !Number.isSafeInteger(deadline))throw Error('invalid activation wait');
  while(now()<deadline){
    let control=null;
    try{control=await readControl()}catch{/* no valid instruction: never activate */}
    if(control && Object.getPrototypeOf(control)===Object.prototype && Object.keys(control).sort().join(',')==='mode,run_id,version' &&
       control.version===1 && control.run_id===runId && control.mode==='serve-testnet'){
      await activate(); // never catch or retry an uncertain activation
      return true;
    }
    await wait();
  }
  return false;
}
