/**
 * Browser-safe Borsh encoding for exactly one native-oracle trial transaction.
 * The caller must first reconstruct the pinned review and independently check
 * the completion snapshot. This module cannot sign or broadcast.
 */
const ALPHABET='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export const NATIVE_ORACLE_TRIAL_GAS='300000000000000';
const GAS=BigInt(NATIVE_ORACLE_TRIAL_GAS),MAX_U64=(1n<<64n)-1n;
const text=new TextEncoder();
const fail=()=>new Error('native oracle transaction unavailable; stop and reconcile');

export function encodeBase58(bytes) {
  let n=0n;for(const byte of bytes)n=(n<<8n)+BigInt(byte);
  let out='';while(n){out=ALPHABET[Number(n%58n)]+out;n/=58n;}
  let zeros=0;while(zeros<bytes.length && bytes[zeros]===0)zeros++;
  return '1'.repeat(zeros)+out;
}
export function decodeNativeHash32(value) {
  if(typeof value!=='string' || value.length<32 || value.length>44)throw fail();
  let n=0n;for(const char of value){const digit=ALPHABET.indexOf(char);if(digit<0)throw fail();n=n*58n+BigInt(digit);}
  const tail=[];while(n){tail.push(Number(n&255n));n>>=8n;}tail.reverse();
  let zeros=0;while(value[zeros]==='1')zeros++;
  const bytes=Uint8Array.from([...new Array(zeros).fill(0),...tail]);
  if(bytes.length!==32 || encodeBase58(bytes)!==value)throw fail();
  return bytes;
}
function little(value,width) {
  let n=BigInt(value);if(n<0n || n>=(1n<<BigInt(width*8)))throw fail();
  const result=new Uint8Array(width);for(let i=0;i<width;i++){result[i]=Number(n&255n);n>>=8n;}return result;
}
function concat(parts) {
  const length=parts.reduce((sum,part)=>sum+part.length,0),out=new Uint8Array(length);let pos=0;
  for(const part of parts){out.set(part,pos);pos+=part.length;}return out;
}
function byteString(value) {const bytes=text.encode(value);return concat([little(bytes.length,4),bytes]);}

/** Snapshot is trusted-RPC data from the checked setup completion, not consent.
 * Use the exact nonce and block seen at that FINAL block; do not retry a stale
 * or ambiguous signed transaction with a different nonce. */
export function buildNativeOracleTrialBytes(review,completion) {
  if(!review || !completion || typeof review.agent_public_key!=='string' || !review.agent_public_key.startsWith('ed25519:') ||
      typeof completion.agent_key_nonce!=='string' || !/^(?:0|[1-9][0-9]{0,19})$/.test(completion.agent_key_nonce))throw fail();
  const nonce=BigInt(completion.agent_key_nonce)+1n;
  // The RPC preflight must not have rounded its JSON number before we sign.
  if(nonce>MAX_U64 || nonce>BigInt(Number.MAX_SAFE_INTEGER))throw fail();
  const block=decodeNativeHash32(completion.block_hash),publicKey=decodeNativeHash32(review.agent_public_key.slice(8));
  const route={project:review.project,route_revision:1,policy_revision:1,payee_revision:1,active:true};
  const args={policy_id:review.policy_id,amount:review.per_tx_cap_yocto,expected_route:route};
  const argBytes=text.encode(JSON.stringify(args));
  // NEAR Transaction V0, one FunctionCall action (variant 2), zero attached
  // deposit. The vault itself applies the reviewed native maximum and policy.
  const unsigned=concat([
    byteString(review.owner),Uint8Array.of(0),publicKey,little(nonce,8),byteString(review.vault),block,
    little(1,4),Uint8Array.of(2),byteString('execute_outlayer_native_project'),
    little(argBytes.length,4),argBytes,little(GAS,8),little(0,16),
  ]);
  return {unsigned,nonce:nonce.toString(),block_hash:completion.block_hash};
}

/** SignedTransaction is the transaction followed by Ed25519 variant 0 + 64 bytes. */
export function appendNativeOracleSignature(unsigned,signature) {
  if(!(unsigned instanceof Uint8Array) || !(signature instanceof Uint8Array) || signature.length!==64)throw fail();
  return concat([unsigned,Uint8Array.of(0),signature]);
}
