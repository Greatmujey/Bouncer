/** Read-only post-install confirmation for the replacement testnet vault.
 * Every account, key and contract view is pinned to one fresh trusted-RPC
 * FINAL block. This is not a consensus proof or a backup/delivery guarantee. */
import { isDeepStrictEqual } from 'node:util';
import { validateOwnerBootstrapPlan } from './testnet-owner-bootstrap.mjs';
import { validateTestnetResourceAgentPlan } from './testnet-resource-agent-keyring.mjs';
import { V11_NEAR_CODE_HASH } from './keyless-vault-bootstrap.mjs';
import { readPinnedJsonView } from './read-only-near-rpc.mjs';
import { hasPlainOwnerProfileAt } from '../shared/plain-owner-profile.mjs';
import { assertFreshFinalBlock } from '../shared/fresh-final-block.mjs';
import { pinnedAccessKeyNonce } from '../shared/pinned-access-key-nonce.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';
const record=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const uint=x=>typeof x==='string'&&/^(0|[1-9][0-9]{0,38})$/.test(x)&&BigInt(x)<(1n<<128n);
function keyPermission(v,p){
 const f=v?.permission?.FunctionCall;
 return record(v?.permission)&&Object.keys(v.permission).join(',')==='FunctionCall'&&record(f)&&
  Object.keys(f).sort().join(',')==='allowance,method_names,receiver_id'&&f.allowance===p.gas_allowance_yocto&&
  f.receiver_id===p.vault&&isDeepStrictEqual(f.method_names,p.methods)&&pinnedAccessKeyNonce(v.nonce)!==null;
}
export async function inspectInstalledTestnetResourceAgent({ownerPlan,agentPlan,expectedCircleCodeHash,provider,now=Date.now}={}){
 const owner=validateOwnerBootstrapPlan(ownerPlan),p=validateTestnetResourceAgentPlan(agentPlan,owner);
 if(!isTransactionHash(expectedCircleCodeHash)||!provider||['viewNodeStatus','viewBlock','query','callFunctionRaw']
   .some(x=>typeof provider[x]!=='function')||typeof now!=='function')throw new Error('pinned post-install provider and Circle code hash required');
 if((await provider.viewNodeStatus())?.chain_id!=='testnet')throw new Error('resource-agent inspection requires testnet');
 const start=now(),block=await provider.viewBlock({finality:'final'}),fresh=assertFreshFinalBlock(block,start),hash=fresh.hash;
 const query=(request_type,account_id,extra={})=>provider.query({request_type,account_id,...extra,block_id:hash});
 const view=(account,method,args)=>readPinnedJsonView(provider,hash,account,method,args);
 const [account,keys,fullKey,agentKey,vault,vaultKeys,token,contractOwner,version,policy,grant,spent,
   ownerBalance,vaultActual,vaultTracked,bounds,registration,metadata]=await Promise.all([
  query('view_account',owner.account_id),query('view_access_key_list',owner.account_id),
  query('view_access_key',owner.account_id,{public_key:owner.public_key}),
  query('view_access_key',owner.account_id,{public_key:p.public_key}),
  query('view_account',p.vault),query('view_access_key_list',p.vault),query('view_account',p.token),
  view(p.vault,'get_owner',{}),view(p.vault,'contract_version',{}),view(p.vault,'get_policy',{policy_id:p.policy_id}),
  view(p.vault,'is_agent_key_allowed',{policy_id:p.policy_id,public_key:p.public_key}),view(p.vault,'daily_spent',{policy_id:p.policy_id}),
  view(p.token,'ft_balance_of',{account_id:owner.account_id}),view(p.token,'ft_balance_of',{account_id:p.vault}),
  view(p.vault,'vault_balance',{token:p.token}),view(p.token,'storage_balance_bounds',{}),
  view(p.token,'storage_balance_of',{account_id:p.vault}),view(p.token,'ft_metadata',{})
 ]);
 const ownerEntry=keys?.keys?.find(k=>k.public_key===owner.public_key),agentEntry=keys?.keys?.find(k=>k.public_key===p.public_key);
 const nonce=pinnedAccessKeyNonce(fullKey?.nonce);
 if(!hasPlainOwnerProfileAt(account,hash)||!uint(account.amount)||!uint(account.locked)||account.locked!=='0'||
  keys?.block_hash!==hash||!Array.isArray(keys.keys)||keys.keys.length!==2||!ownerEntry||!agentEntry||
  fullKey?.block_hash!==hash||fullKey.permission!=='FullAccess'||nonce===null||ownerEntry.access_key?.permission!=='FullAccess'||
  pinnedAccessKeyNonce(ownerEntry.access_key.nonce)!==nonce||agentKey?.block_hash!==hash||!keyPermission(agentKey,p)||
  !keyPermission(agentEntry.access_key,p)||!isDeepStrictEqual(agentKey.permission,agentEntry.access_key.permission)||
  pinnedAccessKeyNonce(agentKey.nonce)!==pinnedAccessKeyNonce(agentEntry.access_key.nonce))throw new Error('owner and restricted agent access keys differ');
 if(vault?.block_hash!==hash||vault.code_hash!==V11_NEAR_CODE_HASH||!uint(vault.amount)||vaultKeys?.block_hash!==hash||
  !Array.isArray(vaultKeys.keys)||vaultKeys.keys.length!==0||token?.block_hash!==hash||token.code_hash!==expectedCircleCodeHash||
  contractOwner!==owner.account_id||version!=='bouncer-agent-v11-exact-ft-testnet'||
  !record(policy)||Object.keys(policy).sort().join(',')!=='daily_cap,per_tx_cap,token'||policy.token!==p.token||
  policy.per_tx_cap!==p.per_tx_cap_atoms||policy.daily_cap!==p.daily_cap_atoms||grant!==true||spent!=='0'||
  ownerBalance!=='0'||vaultActual!=='6907'||vaultTracked!=='6907'||!record(metadata)||metadata.symbol!=='USDC'||metadata.decimals!==6||
  !record(bounds)||!uint(bounds.min)||bounds.min==='0'||!record(registration)||!uint(registration.total)||
  !uint(registration.available)||BigInt(registration.total)<BigInt(bounds.min)||BigInt(registration.available)>BigInt(registration.total)){
  throw new Error('post-install vault, policy or Circle state differs');
 }
 const end=now();if(!Number.isSafeInteger(end)||end<start)throw new Error('local clock moved backwards');
 assertFreshFinalBlock(block,end);
 return {version:1,status:'RESTRICTED_RESOURCE_AGENT_INSTALLED_AT_FINAL',network:'testnet',owner:owner.account_id,vault:p.vault,
  agent_public_key:p.public_key,block_hash:hash,block_timestamp_nanosec:block.header.timestamp_nanosec,
  observed_at:new Date(end).toISOString(),owner_key_nonce:nonce.toString(),owner_key_count:2,vault_key_count:0,
  agent_methods:p.methods,agent_gas_allowance_yocto:p.gas_allowance_yocto,policy,agent_granted:true,daily_spent_atoms:spent,
  circle_code_hash:token.code_hash,owner_circle_atoms:ownerBalance,vault_actual_circle_atoms:vaultActual,vault_tracked_circle_atoms:vaultTracked,
  signed:false,sent:false,seller_contacted:false,scope:'trusted-RPC pinned state only; not a backup, audit or independent provider delivery'};
}
