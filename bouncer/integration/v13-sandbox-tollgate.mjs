/** Disposable nearcore ONLY. The seller and voucher are local fixtures; the
 * channel WASM is the provider's published binary, not its live deployment.
 * This test is not an audit, live service purchase, Circle payment or delivery. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import nearApi from 'near-api-js';
import {assertSandboxStatus,requireFinalSuccess} from './v11-sandbox-support.mjs';
import {loopbackSandboxUrl,withSandboxOnlyFetch} from './v11-sandbox-setup-rpc.mjs';
export const PUBLISHED_CHANNEL_SHA256='1142c2546565f70944d578cea15d03c58166797525cd40d863a3425b1afd6956';
const ROOT='testnet',OWNER='v13-owner.testnet',VAULT=`vault.${OWNER}`,PARENT='tollgate-busel.testnet',
 CHANNEL=`channels.${PARENT}`,SELLER=`seller.${PARENT}`;
const NEAR=10n**24n,TGAS=10n**12n,AMOUNT=2n*NEAR/100n,PRICE=NEAR/1000n;
const {transactions:tx,KeyPair,Account,KeyPairSigner}=nearApi;
const key=()=>KeyPair.fromRandom('ed25519'),pub=k=>String(k.getPublicKey());
const account=(id,p,k)=>new Account(id,p,new KeyPairSigner(k));
const fn=(method,args={},deposit=0n,gas=100n*TGAS)=>tx.functionCall(method,args,gas,deposit);
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');

/** Fail closed before constructing any signed actions; all inputs and traffic
 * must refer to the fresh local sandbox and reviewed fixture binaries. */
export async function exerciseV13TollgateSandbox({rpcUrl,root,v13Wasm,v13Sha256,channelWasm}={}){
 const endpoint=loopbackSandboxUrl(rpcUrl);
 let rootEndpoint;try{rootEndpoint=loopbackSandboxUrl(root?.provider?.connection?.url)}catch{throw Error('local sandbox root required')}
 if(root?.accountId!==ROOT||rootEndpoint!==endpoint||!Buffer.isBuffer(v13Wasm)||v13Wasm.length<100_000||v13Wasm.length>2_000_000||
  !/^[a-f0-9]{64}$/.test(v13Sha256??'')||sha(v13Wasm)!==v13Sha256||!v13Wasm.includes(Buffer.from('bouncer-agent-v13-tollgate-native-testnet'))||
  !Buffer.isBuffer(channelWasm)||sha(channelWasm)!==PUBLISHED_CHANNEL_SHA256)throw Error('local sandbox and exact fixture binaries required');
 return withSandboxOnlyFetch(endpoint,()=>exercise({endpoint,root,v13Wasm,channelWasm}));
}

async function exercise({endpoint,root,v13Wasm,channelWasm}){
 const provider=new nearApi.providers.JsonRpcProvider({url:endpoint});assertSandboxStatus(await provider.status());
 const ownerKey=key(),agentKey=key(),voucherKey=key(),parentKey=key(),sellerKey=key();
 const owner=account(OWNER,provider,ownerKey),agent=account(OWNER,provider,agentKey),parent=account(PARENT,provider,parentKey),seller=account(SELLER,provider,sellerKey);
 const batch=async(signer,receiverId,actions,label)=>{
  const result=await signer.signAndSendTransaction({receiverId,actions,waitUntil:'FINAL',throwOnFailure:false});
  requireFinalSuccess(result,label);return result;
 };
 const call=(signer,id,method,args={},deposit=0n,gas=100n*TGAS)=>batch(signer,id,[fn(method,args,deposit,gas)],method);
 const view=(id,method,args={})=>provider.callFunction(id,method,args,{finality:'final'});
 await batch(root,OWNER,[tx.createAccount(),tx.transfer(20n*NEAR),tx.addKey(ownerKey.getPublicKey(),tx.fullAccessKey())],'create local owner');
 await batch(owner,VAULT,[tx.createAccount(),tx.transfer(6n*NEAR),tx.deployContract(v13Wasm),fn('new',{owner:OWNER})],'create keyless V13');
 await batch(root,PARENT,[tx.createAccount(),tx.transfer(20n*NEAR),tx.addKey(parentKey.getPublicKey(),tx.fullAccessKey())],'create local provider parent');
 await batch(parent,CHANNEL,[tx.createAccount(),tx.transfer(6n*NEAR),tx.deployContract(channelWasm),fn('new',{min_dispute_window_sec:'15',max_expiry_sec:'2592000'})],'deploy published channel WASM locally');
 await batch(parent,SELLER,[tx.createAccount(),tx.transfer(4n*NEAR),tx.addKey(sellerKey.getPublicKey(),tx.fullAccessKey())],'create local seller');
 assert.equal(await view(VAULT,'contract_version'),'bouncer-agent-v13-tollgate-native-testnet');
 assert.equal((await provider.viewAccessKeyList(VAULT,{finality:'final'})).keys.length,0);
 const config=await view(CHANNEL,'get_config');assert.equal(config.min_channel_deposit,'10000000000000000000000');
 await call(owner,VAULT,'deposit_native',{},AMOUNT);
 await call(owner,VAULT,'set_policy',{policy_id:'data',token:'native',per_tx_cap:AMOUNT.toString(),daily_cap:AMOUNT.toString()},1n);
 await call(owner,VAULT,'allow_payee',{policy_id:'data',payee:CHANNEL},1n);
 await call(owner,VAULT,'allow_payee',{policy_id:'data',payee:SELLER},1n);
 await call(owner,VAULT,'grant_agent_key',{policy_id:'data',public_key:pub(agentKey)},1n);
 const block=await provider.viewBlock({finality:'final'}),expiresAt=(BigInt(block.header.timestamp_nanosec)/1_000_000n+120_000n).toString();
 await call(owner,VAULT,'set_tollgate_intent',{intent_id:'local-data-1',policy_id:'data',amount:AMOUNT.toString(),
  agent_public_key:pub(agentKey),voucher_public_key:pub(voucherKey),review_hash:'a'.repeat(64),expires_at_ms:expiresAt,
  channel_lifetime_sec:'600',dispute_window_sec:'15'},1n);
 await batch(owner,OWNER,[tx.addKey(agentKey.getPublicKey(),tx.functionCallAccessKey(VAULT,['execute_tollgate_intent'],NEAR/2n))],'install local restricted key');
 // Owner's zero-deposit call must not escalate policy, even though the owner
 // is correctly identified; a function-call key cannot attach one yocto.
 const guard=await owner.signAndSendTransaction({receiverId:VAULT,actions:[fn('set_policy',{policy_id:'data',token:'native',per_tx_cap:NEAR.toString(),daily_cap:NEAR.toString()})],waitUntil:'FINAL',throwOnFailure:false});
 assert.ok(guard.status?.Failure);assert.match(JSON.stringify(guard.status.Failure),/exactly 1 yoctoNEAR/);
 const opened=await call(agent,VAULT,'execute_tollgate_intent',{intent_id:'local-data-1'},0n,150n*TGAS);
 const intent=await view(VAULT,'get_tollgate_intent',{intent_id:'local-data-1'});
 assert.equal(intent.consumed,true);assert.equal(intent.callback_recorded,true);assert.equal(intent.failed,false);assert.equal(intent.channel_id,'0');
 let channel=await view(CHANNEL,'get_channel',{channel_id:intent.channel_id});
 assert.equal(channel.owner,VAULT);assert.equal(channel.seller,SELLER);assert.equal(channel.agent_pubkey,pub(voucherKey));
 assert.equal(BigInt(channel.deposit)+BigInt(channel.storage_fee),AMOUNT);assert.ok(BigInt(channel.deposit)>=NEAR/100n);
 assert.equal(await view(VAULT,'vault_balance',{token:'native'}),'0');assert.equal(await view(VAULT,'daily_spent',{policy_id:'data'}),AMOUNT.toString());
 const replay=await agent.signAndSendTransaction({receiverId:VAULT,actions:[fn('execute_tollgate_intent',{intent_id:'local-data-1'},0n,150n*TGAS)],waitUntil:'FINAL',throwOnFailure:false});
 assert.ok(replay.status?.Failure);assert.match(JSON.stringify(replay.status.Failure),/consumed|stale/);
 // Local seller submits a locally signed voucher. No HTTP call or real seller.
 const message=`tollgate:v1:${CHANNEL}:${intent.channel_id}:${PRICE}:1`;
 const signature=Buffer.from(voucherKey.sign(Buffer.from(message)).signature).toString('base64');
 await call(seller,CHANNEL,'settle',{channel_id:intent.channel_id,cumulative_amount:PRICE.toString(),nonce:'1',signature});
 channel=await view(CHANNEL,'get_channel',{channel_id:intent.channel_id});assert.equal(channel.settled,PRICE.toString());
 await call(owner,VAULT,'start_tollgate_close',{intent_id:'local-data-1'},1n);
 channel=await view(CHANNEL,'get_channel',{channel_id:intent.channel_id});assert.equal(channel.status,'Closing');
 let ready=false;
 for(let i=0;i<40;i++){
  const b=await provider.viewBlock({finality:'final'});
  if(BigInt(b.header.timestamp_nanosec)>=BigInt(channel.settle_deadline_ns)){ready=true;break}
  await delay(1000);
 }
 assert.equal(ready,true,'local channel dispute window did not expire in time');
 const before=await provider.viewAccount(VAULT,{finality:'final'});
 const finalization=await call(owner,VAULT,'finalize_tollgate_close',{intent_id:'local-data-1'},1n);
 channel=await view(CHANNEL,'get_channel',{channel_id:intent.channel_id});assert.equal(channel.status,'Closed');
 assert.equal(BigInt(channel.refunded),BigInt(channel.deposit)-PRICE);
 const after=await provider.viewAccount(VAULT,{finality:'final'});
 assert.ok(BigInt(after.amount)>=BigInt(before.amount)+BigInt(channel.refunded),'detached refund must reach the local vault account');
 // Detached native transfer does not call deposit_native. Neither the tracked
 // native balance nor the rolling charge is optimistically credited.
 assert.equal(await view(VAULT,'vault_balance',{token:'native'}),'0');assert.equal(await view(VAULT,'daily_spent',{policy_id:'data'}),AMOUNT.toString());
 await call(owner,VAULT,'withdraw_native_surplus',{amount:channel.refunded},1n);
 return {scope:'isolated nearcore only; local seller, synthetic voucher and published channel binary, no HTTP or real provider delivery',
  v13_sha256:sha(v13Wasm),channel_sha256:sha(channelWasm),one_yocto_guard_verified:true,restricted_agent_key:true,
  open_once_and_replay_rejected:true,local_voucher_settled:true,unilateral_close:true,detached_refund_arrived:true,
  native_ledger_and_rolling_budget_conservative:true,owner_surplus_recovery:true,
  local_open_tx:opened.transaction_outcome.id,local_finalize_tx:finalization.transaction_outcome.id,
  live_seller_contacted:false,circle_payment:false,independent_fulfillment_verified:false};
}
