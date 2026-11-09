/** Two-copy, one-shot temporary-vault bootstrap originals. The encrypted local
 * store and separately operated remote store must already exist. No method
 * here opens a wallet, signs, sends, verifies a receipt or proves freshness.
 * A mismatch or uncertain write permanently stops this witness instance; do
 * not initialize a replacement or re-prompt. Restored history is read-only
 * until a separately retained latest head and on-chain receipts are checked. */
import {bootstrapSha256} from '../shared/v14-bootstrap-protocol.mjs';
import {decodeNativeHash32} from './native-oracle-transaction.mjs';

const HEX=/^[a-f0-9]{64}$/,SCOPE=/^[a-f0-9]{32}$/,ZERO='0'.repeat(64);
const TYPES=['create_claim','create_original','deploy_claim','deploy_original'];
const exact=(v,fields)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===fields.length&&fields.every(k=>Object.hasOwn(v,k));
const fail=()=>new Error('bootstrap originals are missing, changed or uncertain; stop and never repeat the wallet prompt or send');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function hash32(value){try{decodeNativeHash32(value);return true}catch{return false}}

/** Domain-separated key for the existing encrypted IndexedDB witness store.
 * The capability itself stays in the encrypted recovery kit and memory. */
export async function bootstrapLocalJournalKey({capability,crypto=globalThis.crypto}={}) {
  if(!HEX.test(capability??'')||!crypto?.subtle)throw fail();
  return bootstrapSha256(crypto,`bouncer-v14-bootstrap-local-witness-v1\0${capability}`);
}
export async function inspectBootstrapOriginals({snapshot,scopeId,reviewSha256,crypto=globalThis.crypto}={}) {
  if(!SCOPE.test(scopeId??'')||!HEX.test(reviewSha256??'')||!crypto?.subtle||
    !exact(snapshot,['revision','head_sha256','events'])||!Number.isSafeInteger(snapshot.revision)||
    snapshot.revision<0||snapshot.revision>4||!HEX.test(snapshot.head_sha256??'')||
    !Array.isArray(snapshot.events)||snapshot.events.length!==snapshot.revision)throw fail();
  let head=ZERO,createOriginal=null,deployOriginal=null;
  for(let i=0;i<snapshot.events.length;i++) {
    const line=snapshot.events[i];if(typeof line!=='string'||line.length>4096||/[\r\n]/.test(line))throw fail();
    let event;try{event=JSON.parse(line)}catch{throw fail()}
    if(!exact(event,['format','seq','previous_sha256','type','data'])||JSON.stringify(event)!==line||
      event.format!=='bouncer-v14-original-event-v1'||event.seq!==i+1||event.previous_sha256!==head||event.type!==TYPES[i]||
      !exact(event.data,['scope_id','review_sha256','tx_hash'])||event.data.scope_id!==scopeId||event.data.review_sha256!==reviewSha256||
      (i%2===0?event.data.tx_hash!==null:!hash32(event.data.tx_hash)))throw fail();
    if(i===1)createOriginal=event.data.tx_hash;if(i===3)deployOriginal=event.data.tx_hash;
    head=await bootstrapSha256(crypto,line);
  }
  if(head!==snapshot.head_sha256)throw fail();
  return {revision:snapshot.revision,head_sha256:head,create_original:createOriginal,deploy_original:deployOriginal,
    next_event:TYPES[snapshot.revision]??null};
}

/** A trusted independent verifier is required before claimDeployment; neither
 * the stores nor an appended hash establish create success. Deployment receipt
 * and key absence must also be verified before any mission configuration. */
export function createBootstrapTwoCopyWitness({scopeId,reviewSha256,localStore,remoteStore,verifyCreateFinal,
  crypto=globalThis.crypto,now=Date.now}={}) {
  if(!SCOPE.test(scopeId??'')||!HEX.test(reviewSha256??'')||!crypto?.subtle||typeof now!=='function'||
    !localStore||typeof localStore.read!=='function'||typeof localStore.append!=='function'||
    !remoteStore||typeof remoteStore.read!=='function'||typeof remoteStore.append!=='function'||
    (verifyCreateFinal!==undefined&&typeof verifyCreateFinal!=='function'))throw fail();
  let stopped=false,busy=false,verifying=false;
  const binding={scopeId,reviewSha256,crypto};
  async function checked() {
    const [local,remote]=await Promise.all([localStore.read(),remoteStore.read()]);
    const a=await inspectBootstrapOriginals({...binding,snapshot:local}),b=await inspectBootstrapOriginals({...binding,snapshot:remote});
    if(!same(local,remote)||!same(a,b))throw fail();
    return {snapshot:local,state:a};
  }
  async function append(type,txHash) {
    if(stopped||busy)throw fail();busy=true;
    try {
      const {snapshot,state}=await checked();if(state.next_event!==type||
        (type.endsWith('_claim')?txHash!==null:!hash32(txHash)))throw fail();
      const record=JSON.stringify({format:'bouncer-v14-original-event-v1',seq:snapshot.revision+1,
        previous_sha256:snapshot.head_sha256,type,data:{scope_id:scopeId,review_sha256:reviewSha256,tx_hash:txHash}});
      const request={expected_revision:snapshot.revision,expected_head_sha256:snapshot.head_sha256,record};
      const local=await localStore.append(request);
      const remote=await remoteStore.append(request); // never retry an uncertain write
      if(!same(local,remote)||local.revision!==snapshot.revision+1||local.events.at(-1)!==record)throw fail();
      const confirmed=await checked();if(!same(confirmed.snapshot,local))throw fail();
      return confirmed.state;
    }catch{stopped=true;throw fail()}finally{busy=false}
  }
  return Object.freeze({
    inspect:async()=>{if(stopped||busy)throw fail();try{return (await checked()).state}catch{stopped=true;throw fail()}},
    claimCreate:()=>append('create_claim',null),
    retainCreateOriginal:txHash=>append('create_original',txHash),
    claimDeployment:async()=>{
      if(stopped||busy||verifying||typeof verifyCreateFinal!=='function')throw fail();
      verifying=true;
      try {
        const {state}=await checked();if(state.next_event!=='deploy_claim'||!state.create_original)throw fail();
        const proof=await verifyCreateFinal({scope_id:scopeId,review_sha256:reviewSha256,original_hash:state.create_original});
        const fields=['status','network','scope_id','review_sha256','original_hash','final_block_hash','checked_at_ms',
          'final_execution_verified','temporary_full_access_key_present','transaction_sent'];
        const time=now();
        if(!exact(proof,fields)||proof.status!=='CREATE_FINAL_AND_VAULT_KEY_VERIFIED'||proof.network!=='testnet'||
          proof.scope_id!==scopeId||proof.review_sha256!==reviewSha256||proof.original_hash!==state.create_original||
          !hash32(proof.final_block_hash)||!Number.isSafeInteger(proof.checked_at_ms)||!Number.isSafeInteger(time)||
          time<proof.checked_at_ms||time-proof.checked_at_ms>5_000||proof.final_execution_verified!==true||
          proof.temporary_full_access_key_present!==true||proof.transaction_sent!==false)throw fail();
        return await append('deploy_claim',null);
      }catch{stopped=true;throw fail()}finally{verifying=false}
    },
    retainDeploymentOriginal:txHash=>append('deploy_original',txHash),
  });
}
