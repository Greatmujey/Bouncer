/** Pinned read-only identity and exact-intent boundaries for the V11 legacy
 * FT-call and prepaid-project runners. No signatures or payments here. A
 * truthful RPC is still required and state can change after this snapshot. */
import { isDeepStrictEqual } from 'node:util';
import { V11_NEAR_CODE_HASH } from './keyless-vault-bootstrap.mjs';
import { readPinnedJsonView } from './read-only-near-rpc.mjs';
import { assertFreshFinalBlock } from '../shared/fresh-final-block.mjs';
import { isTestnetAccount, isTestnetToken } from '../shared/account-id.mjs';
import { estimateV11ResourceGasAllowance } from '../shared/access-key-gas.mjs';

export const V11_RESOURCE_VERSION = 'bouncer-agent-v11-exact-ft-testnet';
const methods = new Set(['execute_ft_call', 'execute_outlayer_project']);

/** Returns a view function bound to the same block. Callers must retain their
 * own exact-route, spend, price and journal checks. V11 enforces the policy
 * lock for both methods and the payee lock for direct FT calls on chain. Its
 * prepaid-project method does NOT enforce the pair lock: that extra project
 * check here is only a snapshot and can race or be bypassed by a signer. */
export async function inspectV11ResourceBoundary({ provider, contract, owner, publicKey, method, policyId, token, payee, now = Date.now } = {}) {
  if (!isTestnetAccount(contract) || !isTestnetAccount(owner) || !isTestnetAccount(payee) || !isTestnetToken(token) ||
      typeof publicKey !== 'string' || !publicKey.startsWith('ed25519:') || !methods.has(method) ||
      typeof policyId !== 'string' || !policyId.length || policyId.length > 128 || !provider ||
      ['viewNodeStatus','viewBlock','query','callFunctionRaw','gasPrice'].some(k => typeof provider[k] !== 'function') || typeof now !== 'function') {
    throw new Error('V11 resource preflight requires exact testnet identity and a pinned provider');
  }
  if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('V11 resource preflight requires testnet');
  const start=now(), block=await provider.viewBlock({finality:'final'}), hash=assertFreshFinalBlock(block,start).hash;
  const query=(request_type,account_id,extra={})=>provider.query({request_type,account_id,...extra,block_id:hash});
  const view=(account,name,args={})=>readPinnedJsonView(provider,hash,account,name,args);
  const [account,keys,key,version,actualOwner,lockedPolicy,lockedPayee,gasPrice]=await Promise.all([
    query('view_account',contract),query('view_access_key_list',contract),query('view_access_key',owner,{public_key:publicKey}),
    view(contract,'contract_version'),view(contract,'get_owner'),view(contract,'is_exact_ft_policy_locked',{policy_id:policyId}),
    view(contract,'is_exact_ft_payee_locked',{token,payee}),provider.gasPrice(hash),
  ]);
  const permission=key?.permission?.FunctionCall;
  if(account?.block_hash!==hash||account.code_hash!==V11_NEAR_CODE_HASH||keys?.block_hash!==hash||
     !Array.isArray(keys.keys)||keys.keys.length!==0||key?.block_hash!==hash||
     !key.permission||Object.keys(key.permission).join(',')!=='FunctionCall'||!permission||
     typeof permission.allowance!=='string'||!/^[1-9][0-9]{0,38}$/.test(permission.allowance)||BigInt(permission.allowance)>((1n<<128n)-1n)||
     permission.receiver_id!==contract||!isDeepStrictEqual(permission.method_names,[method])||
     version!==V11_RESOURCE_VERSION||actualOwner!==owner||lockedPolicy!==false||lockedPayee!==false) {
    throw new Error('V11 vault code, keyless state, restricted key or exact-intent lock differs');
  }
  const estimatedAllowance=estimateV11ResourceGasAllowance(gasPrice?.gas_price);
  if(BigInt(permission.allowance)<estimatedAllowance)throw new Error('restricted key gas allowance is below the pinned-price estimate; stop before signing');
  const end=now();if(!Number.isSafeInteger(end)||end<start)throw new Error('local clock moved backwards');
  assertFreshFinalBlock(block,end);
  return {block_hash:hash,block_timestamp_nanosec:block.header.timestamp_nanosec,view,
    gas_price_yocto_per_gas:gasPrice.gas_price,estimated_minimum_agent_allowance_yocto:estimatedAllowance.toString(),
    scope:'trusted-RPC pinned V11 boundary only; gas is an estimate, not admission; project payee lock is off-chain only; not an audit or provider delivery'};
}
