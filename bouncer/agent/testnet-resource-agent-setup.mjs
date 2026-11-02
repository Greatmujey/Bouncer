/** Offline construction and verification of three bounded TESTNET-only
 * resource-agent setup actions. NO broadcasting or journaling is provided here:
 * never use a live signature until a durable original-hash fence, receipt
 * verifier, recovery path and isolated nearcore tests exist. */
import crypto from 'node:crypto';
import nearApi from 'near-api-js';
import { validateOwnerBootstrapPlan } from './testnet-owner-bootstrap.mjs';
import { validateTestnetResourceAgentPlan } from './testnet-resource-agent-keyring.mjs';
import { inspectVaultCircleFunding } from './keyless-vault-circle-readiness.mjs';
import { readPinnedJsonView } from './read-only-near-rpc.mjs';
import { V11_NEAR_CODE_HASH } from './keyless-vault-bootstrap.mjs';
import { assertFreshFinalBlock } from '../shared/fresh-final-block.mjs';
import { pinnedAccessKeyNonce } from '../shared/pinned-access-key-nonce.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';
const TGAS=10n**12n, stages=['guard-probe','configure','install'];
const sha=b=>crypto.createHash('sha256').update(b).digest();
const samePolicy=(x,p)=>x!==null && typeof x==='object' && !Array.isArray(x) &&
  Object.keys(x).sort().join(',')==='daily_cap,per_tx_cap,token' && x.token===p.token &&
  x.per_tx_cap===p.per_tx_cap_atoms && x.daily_cap===p.daily_cap_atoms;
function policyArgs(p){return {policy_id:p.policy_id,token:p.token,per_tx_cap:p.per_tx_cap_atoms,daily_cap:p.daily_cap_atoms}}
function actions(p,stage){
  if(stage==='guard-probe') return [nearApi.transactions.functionCall('set_policy',policyArgs(p),30n*TGAS,0n)];
  if(stage==='configure') return [nearApi.transactions.functionCall('set_policy',policyArgs(p),30n*TGAS,1n),
    nearApi.transactions.functionCall('grant_agent_key',{policy_id:p.policy_id,public_key:p.public_key},30n*TGAS,1n)];
  if(stage==='install') return [nearApi.transactions.addKey(nearApi.utils.PublicKey.from(p.public_key),
    nearApi.transactions.functionCallAccessKey(p.vault,p.methods,BigInt(p.gas_allowance_yocto)))];
  throw new Error('invalid restricted agent setup stage');
}
export async function inspectTestnetResourceAgentSetup({ownerPlan,agentPlan,provider,now=Date.now}={}) {
  const owner=validateOwnerBootstrapPlan(ownerPlan), p=validateTestnetResourceAgentPlan(agentPlan,owner);
  const base=await inspectVaultCircleFunding({plan:owner,provider,now}), hash=base.block_hash;
  const [policy,grant]=await Promise.all([
    readPinnedJsonView(provider,hash,p.vault,'get_policy',{policy_id:p.policy_id}),
    readPinnedJsonView(provider,hash,p.vault,'is_agent_key_allowed',{policy_id:p.policy_id,public_key:p.public_key})
  ]);
  const finished=now();
  if(!Number.isSafeInteger(finished)||finished<Date.parse(base.observed_at)) throw new Error('local clock moved backwards');
  assertFreshFinalBlock({header:{hash,timestamp_nanosec:base.block_timestamp_nanosec}},finished);
  if(base.vault_actual_circle_atoms!=='6907'||base.vault_tracked_circle_atoms!=='6907'||base.owner_circle_atoms!=='0'||
     base.vault_circle_registration!=='REGISTERED_AT_VIEW'||typeof grant!=='boolean') throw new Error('funded vault state differs');
  const empty=policy===null&&grant===false, configured=samePolicy(policy,p)&&grant===true;
  return {...base, agent_public_key:p.public_key, policy, agent_granted:grant,
    guard_probe_eligible:empty, configure_eligible:empty, install_eligible:configured,
    observed_at:new Date(finished).toISOString(),
    scope:'trusted-RPC pinned preflight only; no transaction sent, no payee approved, no independent provider delivery'};
}
function validateSnapshot(s,owner,p,stage,nowMs){
  if(!stages.includes(stage)||!s||s.network!=='testnet'||s.owner!==owner.account_id||s.public_key!==owner.public_key||
     s.vault!==p.vault||s.agent_public_key!==p.public_key||s.circle_token!==p.token||s.vault_code_hash!==V11_NEAR_CODE_HASH||
     s.vault_key_count!==0||s.vault_circle_registration!=='REGISTERED_AT_VIEW'||s.owner_circle_atoms!=='0'||
     s.vault_actual_circle_atoms!=='6907'||s.vault_tracked_circle_atoms!=='6907'||
     s.signed!==false||s.sent!==false||s.seller_contacted!==false||pinnedAccessKeyNonce(s.owner_key_nonce)===null||
     (stage==='install' ? !(s.install_eligible===true&&samePolicy(s.policy,p)&&s.agent_granted===true) :
       !(s[stage==='configure'?'configure_eligible':'guard_probe_eligible']===true&&s.policy===null&&s.agent_granted===false))) {
    throw new Error('fresh testnet agent setup snapshot is not eligible');
  }
  assertFreshFinalBlock({header:{hash:s.block_hash,timestamp_nanosec:s.block_timestamp_nanosec}},nowMs);
}
function terms(owner,p,stage,nonce,block){
  return {version:1,purpose:'bounded-testnet-resource-agent-setup',network:'testnet',stage,owner:owner.account_id,
    owner_public_key:owner.public_key,vault:p.vault,agent_public_key:p.public_key,policy_id:p.policy_id,
    nonce,block_hash:block,do_not_blindly_resend:true};
}
function check(e,owner,p){
  if(!e||e.version!==1||e.purpose!=='bounded-testnet-resource-agent-setup'||e.network!=='testnet'||!stages.includes(e.stage)||
    e.owner!==owner.account_id||e.owner_public_key!==owner.public_key||e.vault!==p.vault||e.agent_public_key!==p.public_key||
    e.policy_id!==p.policy_id||pinnedAccessKeyNonce(e.nonce)===null||e.nonce==='0'||!isTransactionHash(e.block_hash)||
    e.do_not_blindly_resend!==true) throw new Error('invalid restricted agent setup terms');
}
export async function signTestnetResourceAgentSetup({ownerPlan,agentPlan,snapshot,stage,keyPair,nowMs=Date.now()}={}) {
  const owner=validateOwnerBootstrapPlan(ownerPlan), p=validateTestnetResourceAgentPlan(agentPlan,owner);
  validateSnapshot(snapshot,owner,p,stage,nowMs);
  if(!keyPair||String(keyPair.getPublicKey())!==owner.public_key) throw new Error('setup signing key differs from owner');
  const e=terms(owner,p,stage,(pinnedAccessKeyNonce(snapshot.owner_key_nonce)+1n).toString(),snapshot.block_hash);
  const receiver=stage==='install'?owner.account_id:p.vault;
  const tx=nearApi.transactions.createTransaction(owner.account_id,keyPair.getPublicKey(),receiver,BigInt(e.nonce),
    actions(p,stage),nearApi.utils.serialize.base_decode(e.block_hash));
  const unsigned=Buffer.from(nearApi.transactions.encodeTransaction(tx)),digest=sha(unsigned);
  const [returned,signed]=await new nearApi.KeyPairSigner(keyPair).signTransaction(tx);
  if(!Buffer.from(returned??[]).equals(digest)||!Buffer.from(nearApi.transactions.encodeTransaction(signed.transaction)).equals(unsigned)||
    signed.signature?.enum!=='ed25519Signature'||!keyPair.getPublicKey().verify(digest,signed.signature.data)) throw new Error('setup signature differs');
  const envelope={...e,tx_hash:nearApi.utils.serialize.base_encode(digest),
    signed_tx_base64:Buffer.from(nearApi.transactions.encodeTransaction(signed)).toString('base64'),
    scope:'public bearer, NOT journaled or broadcast; never blindly resend'};
  verifySignedTestnetResourceAgentSetup(envelope,owner,p); return envelope;
}
export function verifySignedTestnetResourceAgentSetup(e,ownerPlan,agentPlan){
  const owner=validateOwnerBootstrapPlan(ownerPlan),p=validateTestnetResourceAgentPlan(agentPlan,owner); check(e,owner,p);
  if(!isTransactionHash(e.tx_hash)||typeof e.signed_tx_base64!=='string'||e.signed_tx_base64.length>8192||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(e.signed_tx_base64)) throw new Error('invalid restricted setup bearer');
  const bytes=Buffer.from(e.signed_tx_base64,'base64');
  if(!bytes.length||bytes.length>4096||bytes.toString('base64')!==e.signed_tx_base64) throw new Error('invalid restricted setup bytes');
  let signed; try{signed=nearApi.transactions.SignedTransaction.decode(bytes)}catch{throw new Error('invalid restricted setup bytes')}
  const key=nearApi.utils.PublicKey.from(owner.public_key),receiver=e.stage==='install'?owner.account_id:p.vault;
  const expected=nearApi.transactions.createTransaction(owner.account_id,key,receiver,BigInt(e.nonce),actions(p,e.stage),
    nearApi.utils.serialize.base_decode(e.block_hash));
  const actual=Buffer.from(nearApi.transactions.encodeTransaction(signed.transaction)),digest=sha(actual),sig=signed.signature?.ed25519Signature?.data;
  if(!Buffer.from(nearApi.transactions.encodeTransaction(signed)).equals(bytes)||
     !actual.equals(Buffer.from(nearApi.transactions.encodeTransaction(expected)))||!Array.isArray(sig)||sig.length!==64||
     !key.verify(digest,Uint8Array.from(sig))||nearApi.utils.serialize.base_encode(digest)!==e.tx_hash) throw new Error('restricted setup signature or action differs');
  return signed;
}
