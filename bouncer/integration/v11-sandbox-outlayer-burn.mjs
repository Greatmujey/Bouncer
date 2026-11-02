/**
 * TEST ONLY. Exercise six EXACT offline burn-plan stages against a disposable,
 * loopback-only nearcore. nearcore's example FT is deployed at the fake token
 * name and another keyless V11 vault stands in for OutLayer. It ignores the
 * deposit message and has NO OutLayer request_execution implementation.
 *
 * Wrap/swap are deliberately NOT tested: the mock FT is transferred locally
 * to the owner between stages. A failed request demonstrates conservative
 * V11 prepaid/native accounting, not a provider refund or live delivery. No
 * journal coordinator or production sender is implied by this direct harness.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import nearApi from 'near-api-js';
import {createOutlayerBurnPlan,buildOutlayerBurnStage} from '../agent/outlayer-v11-burn-plan.mjs';
import {verifyFtCallSettlement} from '../agent/ft-call.mjs';
import {V11_SHA256,MOCK_FT_SHA256,assertSandboxStatus,requireFinalSuccess} from './v11-sandbox-support.mjs';
import {loopbackSandboxUrl,withSandboxOnlyFetch} from './v11-sandbox-setup-rpc.mjs';

const ROOT='testnet',OWNER='bouncer-owner-000000000000000000000001.testnet';
const VAULT=`vault.${OWNER}`, PARENT='fakes.testnet',TOKEN='usdc.fakes.testnet',SELLER='outlayer.testnet';
const NEAR=10n**24n,TGAS=10n**12n,{transactions:tx,KeyPair,Account,KeyPairSigner,utils}=nearApi;
const key=()=>KeyPair.fromRandom('ed25519'),pub=k=>String(k.getPublicKey());
const account=(id,p,k)=>new Account(id,p,new KeyPairSigner(k));
const fn=(method,args={},deposit=0n,gas=100n*TGAS)=>tx.functionCall(method,args,gas,deposit);
const sha=b=>crypto.createHash('sha256').update(b).digest();
const hashSigned=s=>utils.serialize.base_encode(sha(tx.encodeTransaction(s.transaction)));

/** Validate local-chain-only inputs before constructing any signed transaction. */
export async function exerciseSandboxOutlayerBurn({rpcUrl,root,wasm,mockFt,checkpoint=()=>{}}={}){
 const endpoint=loopbackSandboxUrl(rpcUrl);
 let rootEndpoint;try{rootEndpoint=loopbackSandboxUrl(root?.provider?.connection?.url)}catch{throw Error('local sandbox root required')}
 if(root?.accountId!==ROOT||rootEndpoint!==endpoint||!Buffer.isBuffer(wasm)||!Buffer.isBuffer(mockFt)||
   sha(wasm).toString('hex')!==V11_SHA256||sha(mockFt).toString('hex')!==MOCK_FT_SHA256||typeof checkpoint!=='function'){
  throw Error('local sandbox and exact pinned fixture bytecode required');
 }
 return withSandboxOnlyFetch(endpoint,()=>exercise({endpoint,root,wasm,mockFt,checkpoint}));
}

async function exercise({endpoint,root,wasm,mockFt,checkpoint}){
 const provider=new nearApi.providers.JsonRpcProvider({url:endpoint});assertSandboxStatus(await provider.status());
 const ownerKey=key(),existingKey=key(),fundKey=key(),projectKey=key(),parentKey=key(),tokenKey=key();
 const owner=account(OWNER,provider,ownerKey),parent=account(PARENT,provider,parentKey),token=account(TOKEN,provider,tokenKey),
   fund=account(OWNER,provider,fundKey),project=account(OWNER,provider,projectKey);
 const batch=async(signer,receiverId,actions,label)=>{
  const result=await signer.signAndSendTransaction({receiverId,actions,waitUntil:'FINAL',throwOnFailure:false});
  requireFinalSuccess(result,label);return result;
 };
 const call=(signer,id,method,args={},deposit=0n,gas=100n*TGAS)=>batch(signer,id,[fn(method,args,deposit,gas)],method);
 const view=(id,method,args={})=>provider.callFunction(id,method,args,{finality:'final'});
 await batch(root,OWNER,[tx.createAccount(),tx.transfer(25n*NEAR),tx.addKey(ownerKey.getPublicKey(),tx.fullAccessKey())],'create local owner');
 await batch(owner,VAULT,[tx.createAccount(),tx.transfer(8n*NEAR),tx.deployContract(wasm),fn('new',{owner:OWNER})],'create local keyless vault');
 await batch(owner,OWNER,[tx.addKey(existingKey.getPublicKey(),tx.functionCallAccessKey(VAULT,['execute','execute_ft_call'],NEAR/10n))],'install local existing agent');
 await batch(root,SELLER,[tx.createAccount(),tx.transfer(8n*NEAR),tx.deployContract(wasm),fn('new',{owner:ROOT})],'create local receiver stand-in');
 await batch(root,PARENT,[tx.createAccount(),tx.transfer(15n*NEAR),tx.addKey(parentKey.getPublicKey(),tx.fullAccessKey())],'create local token parent');
 await batch(parent,TOKEN,[tx.createAccount(),tx.transfer(8n*NEAR),tx.addKey(tokenKey.getPublicKey(),tx.fullAccessKey())],'create local token');
 await batch(token,TOKEN,[tx.deployContract(mockFt),fn('new_default_meta',{owner_id:ROOT,total_supply:'1000000'},0n,50n*TGAS)],'deploy local example FT');
 assert.equal((await view(TOKEN,'storage_balance_bounds')).min,'1250000000000000000000','fixture storage minimum must match the fixed stage');
 await call(root,TOKEN,'storage_deposit',{account_id:SELLER,registration_only:true},1250000000000000000000n,50n*TGAS);
 const ownerPlan={version:1,purpose:'new-bouncer-testnet-owner',network:'testnet',account_id:OWNER,public_key:pub(ownerKey)};
 const plan=createOutlayerBurnPlan({ownerPlan,existingResourcePublicKey:pub(existingKey),fundingPublicKey:pub(fundKey),projectPublicKey:pub(projectKey)});
 const evidence={};
 const sendStage=async(stage,signer,success=true)=>{
  const built=buildOutlayerBurnStage({ownerPlan,plan,stage});assert.equal(built.signer_id,OWNER);assert.equal(built.signer_public_key,pub(signer===owner?ownerKey:signer===fund?fundKey:projectKey));
  const signed=await signer.createSignedTransaction(built.receiver_id,built.actions),original=hashSigned(signed);
  const result=await provider.sendTransactionUntil(signed,'FINAL');assert.equal(result.transaction_outcome.id,original);
  const receipts=await provider.txStatusReceipts(original,OWNER,'FINAL');assert.equal(receipts.transaction_outcome.id,original);
  if(success)requireFinalSuccess(receipts,stage);else {assert.equal(receipts.final_execution_status,'FINAL');assert.ok(receipts.status?.Failure,'stand-in has no project method');}
  evidence[stage]=original;return receipts;
 };
 await sendStage('register-fake',owner);
 assert.ok(await view(TOKEN,'storage_balance_of',{account_id:OWNER}));assert.ok(await view(TOKEN,'storage_balance_of',{account_id:VAULT}));
 // Stand-in funding, NOT the real wrap and Ref swap stages.
 await call(root,TOKEN,'ft_transfer',{receiver_id:OWNER,amount:'21645',memo:'sandbox fixture only'},1n,50n*TGAS);
 await sendStage('fund-vault',owner);
 assert.equal(await view(TOKEN,'ft_balance_of',{account_id:VAULT}),'10000');
 assert.equal(await view(VAULT,'vault_balance',{token:TOKEN}),'10000');
 await sendStage('configure',owner);
 const projected=JSON.parse(Buffer.from(buildOutlayerBurnStage({ownerPlan,plan,stage:'run-project'}).actions[0].functionCall.args).toString()).expected_route;
 assert.deepEqual(await view(VAULT,'get_outlayer_project',{native_policy_id:'ol-project-native'}),projected);
 await sendStage('install-keys',owner);
 const keys=(await provider.viewAccessKeyList(OWNER,{finality:'final'})).keys;
 const k=pk=>keys.find(x=>x.public_key===pk)?.access_key?.permission?.FunctionCall;
 assert.deepEqual(k(pub(fundKey))?.method_names,['execute_ft_call']);assert.deepEqual(k(pub(projectKey))?.method_names,['execute_outlayer_project']);
 assert.equal(k(pub(fundKey))?.receiver_id,VAULT);assert.equal(k(pub(projectKey))?.receiver_id,VAULT);
 const settlement=await sendStage('fund-provider',fund);
 const goal={id:'sandbox-outlayer-funding',contract_id:VAULT,owner_account_id:OWNER,policy_id:'ol-funding',payee:SELLER,
  token:TOKEN,amount:'10000',msg:'{"action":"deposit_balance"}',policy_revision:1,route_revision:1};
 const verified=verifyFtCallSettlement(goal,settlement,pub(fundKey));assert.equal(verified.tx_hash,evidence['fund-provider']);assert.equal(verified.used,'10000');
 assert.equal(await view(TOKEN,'ft_balance_of',{account_id:SELLER}),'10000');
 assert.equal(await view(VAULT,'vault_balance',{token:TOKEN}),'0');assert.equal(await view(VAULT,'outlayer_prepaid_balance',{token:TOKEN}),'10000');
 // This stand-in intentionally has no request_execution. The failed promise
 // must leave the already-reserved budgets conservative, not optimistically refunded.
 const failed=await sendStage('run-project',project,false);
 assert.match(JSON.stringify(failed.status.Failure),/MethodNotFound|method.*not found|does not exist/i);
 assert.equal(await view(VAULT,'outlayer_prepaid_balance',{token:TOKEN}),'0');assert.equal(await view(VAULT,'vault_balance',{token:'native'}),'0');
 assert.equal(await view(VAULT,'daily_spent',{policy_id:'ol-project-usd'}),'10000');
 assert.equal(await view(VAULT,'daily_spent',{policy_id:'ol-project-native'}),'20000000000000000000000');
 assert.equal(await view(TOKEN,'ft_balance_of',{account_id:SELLER}),'10000');
 checkpoint('six exact local burn-plan stages executed; mock FT settlement verified and stand-in project failure kept prepaid/native budgets reserved');
 return {scope:'isolated nearcore ONLY; example FT and V11 receiver stand-in, not Circle, Ref, wrap, OutLayer, an audit or fulfillment',
  exact_stages:['register-fake','fund-vault','configure','install-keys','fund-provider','run-project'],
  wrap_and_swap_tested:false,owner_fake_funding:'local fixture transfer',seller_is_v11_standin:true,project_failed_as_expected:true,
  ft_settlement_verified:true,conservative_prepaid_and_native_reservations_checked:true,live_seller_contacted:false,independent_fulfillment_verified:false,
  sandbox_transaction_hashes:evidence};
}
