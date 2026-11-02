/**
 * READ ONLY: stage-specific V11 OutLayer burn-diagnostic preflight. This is a
 * necessary state check, NOT authorization, a signer, a journal, proof of a
 * previous transaction, seller availability, or a payment. One trusted RPC
 * supplies every view at one fresh FINAL block. It refuses unknown/mixed state.
 */
import { isDeepStrictEqual as equal } from 'node:util';
import { inspectOutlayerV11Readiness, OUTLAYER_FAKE_USD as TOKEN, OUTLAYER_TESTNET as SELLER } from './outlayer-v11-readiness.mjs';
import { validateOutlayerBurnPlan, buildOutlayerBurnStage, OUTLAYER_BURN_REVIEW as TERMS } from './outlayer-v11-burn-plan.mjs';
import { CIRCLE_TESTNET_USDC as CIRCLE } from '../scripts/circle-testnet-setup.mjs';
import { readPinnedJsonView } from './read-only-near-rpc.mjs';
import { assertFreshFinalBlock } from '../shared/fresh-final-block.mjs';
import { pinnedAccessKeyNonce } from '../shared/pinned-access-key-nonce.mjs';

const WRAP='wrap.testnet', REF='ref-finance-101.testnet', USD='ol-project-usd', FUND='ol-funding', NATIVE='ol-project-native';
const providerCode='5waWVnt6g3FZfjR6vfYXZzpAi3sZdFy8cK2sLz4EJQDt';
const tokenCode='E1E1CJYxT5FjzVSF55QoEWzv6dbqTe2yB6Hpmjks7JJ7';
const wrapCode='DsbyUrKaSJAT91Pewfi71QExPLBooDp1z4sL9GUDhNHa';
const nano='20000000000000000000000', input='100000000000000', fee='10000', storage='1250000000000000000000';
const stages=['register-fake','wrap','swap-fake','fund-vault','configure','install-keys','fund-provider','run-project'];
const amount=x=>typeof x==='string'&&/^(0|[1-9][0-9]{0,38})$/.test(x)&&BigInt(x)<(1n<<128n);
const registered=x=>x&&typeof x==='object'&&amount(x.total)&&BigInt(x.total)>=BigInt(storage)&&amount(x.available)&&BigInt(x.available)<=BigInt(x.total);
const positive=x=>amount(x)&&BigInt(x)>0n;
const read=(observations,name)=>observations[name]?.status==='OBSERVED'?observations[name].value:undefined;
const permission=(entry,vault,methods,min,max)=>{
 const p=entry?.access_key?.permission?.FunctionCall;
 return p&&Object.keys(entry.access_key.permission).join(',')==='FunctionCall'&&p.receiver_id===vault&&equal(p.method_names,methods)&&
   positive(p.allowance)&&BigInt(p.allowance)>=min&&BigInt(p.allowance)<=max&&pinnedAccessKeyNonce(entry.access_key.nonce)!==null;
};
const oldAllowance=100000000000000000000000n, newAllowance=500000000000000000000000n, minimumForSend=400000000000000000000000n;
const policy=(value,token,cap)=>equal(value,{token,per_tx_cap:cap,daily_cap:cap});

export async function inspectOutlayerBurnStage({ownerPlan,plan:raw,stage,provider,now=Date.now}={}){
 const plan=validateOutlayerBurnPlan(raw,ownerPlan);
 if(!stages.includes(stage))throw new Error('unknown burn diagnostic stage');
 const base=await inspectOutlayerV11Readiness({ownerPlan,provider,now}), hash=base.block_hash, o=base.observations;
 const view=(id,method,args={})=>readPinnedJsonView(provider,hash,id,method,args);
 const [protocol,gasPrice,ownerAccount,ownerKeys,vaultAccount,wrapAccount,circleActual,circleTracked,wrapMeta,wrapRegistration,wrapBalance,refWrap,refToken,
   fundPolicy,usdPolicy,nativePolicy,fundRoute,projectRoute,fundGrant,usdGrant,nativeGrant,fundLock,usdLock,pairLock,fundSpent,usdSpent,nativeSpent,
   circlePolicy,circleGrant,circleSpent,fundVerdict,nativeVerdict]=await Promise.all([
   provider.experimental_protocolConfig({blockId:hash}),provider.gasPrice(hash),
   provider.query({request_type:'view_account',account_id:plan.owner,block_id:hash}),
   provider.query({request_type:'view_access_key_list',account_id:plan.owner,block_id:hash}),
   provider.query({request_type:'view_account',account_id:plan.vault,block_id:hash}),
   provider.query({request_type:'view_account',account_id:WRAP,block_id:hash}),
   view(CIRCLE,'ft_balance_of',{account_id:plan.vault}),view(plan.vault,'vault_balance',{token:CIRCLE}),
   view(WRAP,'ft_metadata'),view(WRAP,'storage_balance_of',{account_id:plan.owner}),view(WRAP,'ft_balance_of',{account_id:plan.owner}),
   view(WRAP,'storage_balance_of',{account_id:REF}),view(TOKEN,'storage_balance_of',{account_id:REF}),
   ...[FUND,USD,NATIVE].map(policy_id=>view(plan.vault,'get_policy',{policy_id})),
   view(plan.vault,'get_ft_call_route',{policy_id:FUND,payee:SELLER}),view(plan.vault,'get_outlayer_project',{native_policy_id:NATIVE}),
   view(plan.vault,'is_agent_key_allowed',{policy_id:FUND,public_key:plan.funding_public_key}),
   view(plan.vault,'is_agent_key_allowed',{policy_id:USD,public_key:plan.project_public_key}),
   view(plan.vault,'is_agent_key_allowed',{policy_id:NATIVE,public_key:plan.project_public_key}),
   view(plan.vault,'is_exact_ft_policy_locked',{policy_id:FUND}),view(plan.vault,'is_exact_ft_policy_locked',{policy_id:USD}),
   view(plan.vault,'is_exact_ft_payee_locked',{token:TOKEN,payee:SELLER}),
   ...[FUND,USD,NATIVE].map(policy_id=>view(plan.vault,'daily_spent',{policy_id})),
   view(plan.vault,'get_policy',{policy_id:'circle-resources'}),
   view(plan.vault,'is_agent_key_allowed',{policy_id:'circle-resources',public_key:plan.existing_resource_public_key}),
   view(plan.vault,'daily_spent',{policy_id:'circle-resources'}),
   view(plan.vault,'check',{policy_id:FUND,payee:SELLER,amount:fee}),
   view(plan.vault,'check',{policy_id:NATIVE,payee:SELLER,amount:nano}),
 ]);
 const blockers=[], require=(name,condition)=>{if(!condition)blockers.push(name)};
 const cost=protocol?.runtime_config?.storage_amount_per_byte,gas=gasPrice?.gas_price;
 // 300 Tgas plus a conservative 30% margin and 0.001 NEAR overhead. This is
 // an estimate, not a protocol reservation; admission prices may move.
 const gasEstimate=positive(gas)?300n*10n**12n*BigInt(gas)*13n/10n+10n**21n:null;
 const needed=gasEstimate!==null&&gasEstimate>minimumForSend?gasEstimate:minimumForSend;
 require('bounded_agent_gas',gasEstimate!==null&&needed<=newAllowance);
 const available=account=>amount(account?.amount)&&Number.isSafeInteger(account.storage_usage)&&account.storage_usage>=0&&positive(cost)?
   BigInt(account.amount)-BigInt(account.storage_usage)*BigInt(cost):-1n;
 require('protocol',protocol?.chain_id==='testnet'&&positive(cost));
 require('owner_account',ownerAccount?.block_hash===hash&&available(ownerAccount)>10n**24n);
 // The base inspector has already pinned code hash, owner and zero access keys.
 require('keyless_vault_reserve',vaultAccount?.block_hash===hash&&vaultAccount.code_hash===plan.vault_code_hash&&available(vaultAccount)>=10n**23n);
 require('wrap_code_and_metadata',wrapAccount?.block_hash===hash&&wrapAccount.code_hash===wrapCode&&wrapMeta?.symbol==='wNEAR'&&wrapMeta.decimals===24);
 require('wrap_and_ref_registration',registered(wrapRegistration)&&registered(refWrap)&&registered(refToken));
 require('wrap_balance_known',amount(wrapBalance));
 require('circle_balance_and_policy_unchanged',circleActual==='6907'&&circleTracked==='6907'&&
   equal(circlePolicy,{token:CIRCLE,per_tx_cap:'3000',daily_cap:'6907'})&&circleGrant===true&&circleSpent==='0');
 const keys=ownerKeys?.keys, lookup=pub=>Array.isArray(keys)?keys.find(x=>x.public_key===pub):null;
 const owner=lookup(plan.owner_public_key),existing=lookup(plan.existing_resource_public_key),fund=lookup(plan.funding_public_key),proj=lookup(plan.project_public_key);
 const ownerNonce=pinnedAccessKeyNonce(owner?.access_key?.nonce);
 require('known_owner_keys',ownerKeys?.block_hash===hash&&Array.isArray(keys)&&owner?.access_key?.permission==='FullAccess'&&ownerNonce!==null&&
   keys.filter(x=>x?.access_key?.permission==='FullAccess').length===1&&
   permission(existing,plan.vault,['execute','execute_ft_call'],1n,oldAllowance));
 const installed=stage==='fund-provider'||stage==='run-project';
 require('dedicated_keys',Array.isArray(keys)&&(installed?
   keys.length===4&&permission(fund,plan.vault,['execute_ft_call'],stage==='fund-provider'?needed:1n,newAllowance)&&
     permission(proj,plan.vault,['execute_outlayer_project'],needed,newAllowance):
   keys.length===2&&!fund&&!proj));
 const config=read(o,'configured_token'),meta=read(o,'fake_token_metadata'),bounds=read(o,'fake_storage_bounds');
 const priced=read(o,'pricing'), project=read(o,'project'), version=read(o,'project_version'), estimate=read(o,'native_estimate');
 const providerAccount=read(o,'provider_account'),tokenAccount=read(o,'fake_token_account');
 require('provider_token_code',providerAccount?.code_hash===providerCode&&tokenAccount?.code_hash===tokenCode&&
   providerAccount.key_count===1&&providerAccount.full_access_keys===1&&tokenAccount.key_count===1&&tokenAccount.full_access_keys===1&&
   config===TOKEN&&meta?.symbol==='USDC.e'&&meta?.decimals===6&&bounds?.min===storage&&bounds?.max===storage&&registered(read(o,'outlayer_fake_registration')));
 require('provider_terms',project?.project_id===TERMS.project&&project?.owner==='connectors.outlayer.testnet'&&project?.active_version===TERMS.version&&
   version?.wasm_hash===TERMS.version&&version?.is_active===true&&version?.source?.WasmUrl?.hash===TERMS.version&&
   version?.source?.WasmUrl?.url===`https://test.fastfs.io/outlayer-alice.testnet/outlayer.testnet/${TERMS.version}.wasm`&&
   version?.source?.WasmUrl?.build_target==='wasm32-wasip2'&&
   priced?.author_account_id===TERMS.author&&priced?.operation?.operation==='burn'&&priced.operation.price_usd===fee&&priced.operation.developer_share_bp===3333&&
   positive(estimate)&&BigInt(estimate)<=BigInt(nano));
 const pool=read(o,'pool'), quote=o.quotes?.[0];
 require('bounded_ref_quote',pool?.pool_kind==='SIMPLE_POOL'&&Array.isArray(pool.token_account_ids)&&pool.token_account_ids.length===2&&
   pool.token_account_ids.includes(TOKEN)&&pool.token_account_ids.includes(WRAP)&&Array.isArray(pool.amounts)&&pool.amounts.length===2&&
   pool.amounts.every(positive)&&quote?.wnear_input_yocto===input&&quote.status==='OBSERVED'&&amount(quote.value)&&
   BigInt(quote.value)>=15000n&&BigInt(quote.value)<=25000n);
 const ownerReg=read(o,'owner_fake_registration'),vaultReg=read(o,'vault_fake_registration'),
   ownerFake=read(o,'owner_fake_balance'),vaultFake=read(o,'vault_fake_balance'),tracked=read(o,'vault_tracked_fake'),
   native=read(o,'vault_tracked_native'),credit=read(o,'vault_prepaid_allowance'),providerCredit=read(o,'provider_vault_credit');
 require('balances_known',[ownerFake,vaultFake,tracked,native,credit,providerCredit].every(amount));
 require('exact_ft_locks_clear',fundLock===false&&usdLock===false&&pairLock===false);
 require('rolling_spend',fundSpent===(stage==='run-project'?fee:'0')&&usdSpent==='0'&&nativeSpent==='0');
 const passing=x=>Array.isArray(x)&&x.length===2&&x[0]===true&&typeof x[1]==='string';
 if(stage==='fund-provider')require('funding_payee_and_policy_verdict',passing(fundVerdict));
 if(stage==='run-project')require('native_payee_and_policy_verdict',passing(nativeVerdict));
 const notConfigured=fundPolicy===null&&usdPolicy===null&&nativePolicy===null&&fundRoute===null&&projectRoute===null&&
   fundGrant===false&&usdGrant===false&&nativeGrant===false;
 const expectedProject=JSON.parse(Buffer.from(buildOutlayerBurnStage({plan,ownerPlan,stage:'run-project'}).actions[0].functionCall.args).toString()).expected_route;
 const configured=policy(fundPolicy,TOKEN,fee)&&policy(usdPolicy,TOKEN,fee)&&policy(nativePolicy,'native',nano)&&
   equal(fundRoute,{token:TOKEN,msg:'{"action":"deposit_balance"}',policy_revision:1,route_revision:1,active:true})&&
   equal(projectRoute,expectedProject)&&fundGrant===true&&usdGrant===true&&nativeGrant===true;
 const regNone=ownerReg===null&&vaultReg===null, regBoth=registered(ownerReg)&&registered(vaultReg);
 const emptyVault=vaultFake==='0'&&tracked==='0'&&native==='0'&&credit==='0'&&providerCredit==='0';
 if(stage==='register-fake')require('stage_state',regNone&&ownerFake==='0'&&emptyVault&&notConfigured&&wrapBalance==='0');
 if(stage==='wrap')require('stage_state',regBoth&&ownerFake==='0'&&emptyVault&&notConfigured&&wrapBalance==='0');
 if(stage==='swap-fake')require('stage_state',regBoth&&ownerFake==='0'&&emptyVault&&notConfigured&&wrapBalance===input);
 if(stage==='fund-vault')require('stage_state',regBoth&&amount(ownerFake)&&BigInt(ownerFake)>=10000n&&emptyVault&&notConfigured&&wrapBalance==='0');
 if(stage==='configure')require('stage_state',regBoth&&vaultFake===fee&&tracked===fee&&native==='0'&&credit==='0'&&providerCredit==='0'&&notConfigured&&wrapBalance==='0');
 if(stage==='install-keys'||stage==='fund-provider')require('stage_state',regBoth&&vaultFake===fee&&tracked===fee&&native===nano&&
   credit==='0'&&providerCredit==='0'&&configured&&wrapBalance==='0');
 if(stage==='run-project')require('stage_state',regBoth&&vaultFake==='0'&&tracked==='0'&&native===nano&&credit===fee&&providerCredit===fee&&configured&&wrapBalance==='0');
 const signer=stage==='fund-provider'?fund:stage==='run-project'?proj:owner;
 const signerNonce=pinnedAccessKeyNonce(signer?.access_key?.nonce);
 require('signer_nonce',signerNonce!==null);
 const end=now();if(!Number.isSafeInteger(end)||end<Date.parse(base.observed_at))throw new Error('local clock moved backwards');
 assertFreshFinalBlock({header:{hash,timestamp_nanosec:base.block_timestamp_nanosec}},end);
 return {version:1,stage,network:'testnet',owner:plan.owner,vault:plan.vault,block_hash:hash,
   block_timestamp_nanosec:base.block_timestamp_nanosec,observed_at:new Date(end).toISOString(),
   signer_public_key:stage==='fund-provider'?plan.funding_public_key:stage==='run-project'?plan.project_public_key:plan.owner_public_key,
   signer_key_nonce:signerNonce?.toString()??null,gas_price_yocto_per_gas:positive(gas)?gas:null,
   estimated_minimum_agent_allowance_yocto:gasEstimate===null?null:needed.toString(),eligible:blockers.length===0,blockers,
   signed:false,sent:false,seller_contacted:false,independent_fulfillment_verified:false,
   scope:'trusted-RPC state indication only; prior original receipts, durable journal, key custody and one-shot sender are separately required'};
}
