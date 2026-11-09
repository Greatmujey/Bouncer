/**
 * OFFLINE RESEARCH ONLY: construct an unsigned owner review for a fresh,
 * keyless V14 three-resource vault. No key generation, wallet prompt, RPC,
 * signing, transaction, spending authorization, or recovery fence occurs here.
 *
 * The caller must independently verify and retain the loader and V14 artifact
 * digests. A matching digest is not an audit, a guarantee of provenance, or
 * proof that the loader actually self-deploys that V14 code. The first stage
 * upgrades asynchronously; failure may leave funds in the loader account.
 * Never retry an uncertain stage; use independently retained original hashes,
 * fresh state and explicit owner-controlled recovery. Not wired to the UI.
 */
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { isDeepStrictEqual } from 'node:util';
import nearApi from 'near-api-js';
import { validateNativeMission } from './native-mission.mjs';
import { isDirectTestnetChild } from './native-oracle-wallet-plan.mjs';

const T = 10n ** 12n, MAX_U128 = (1n << 128n) - 1n, MAX_AGENT_GAS_ALLOWANCE = 10n ** 24n;
const MARKER = Buffer.from('bouncer-agent-v14-native-storage-testnet');
const MAGIC = Buffer.from([0,97,115,109,1,0,0,0]);
const DOMAIN = Buffer.from('bouncer-research-v14-phone-batch-v1\0');
const DUMMY_KEY = nearApi.utils.PublicKey.from('ed25519:11111111111111111111111111111111');
export const V14_PHONE_RESEARCH_STAGE_IDS = Object.freeze(['create_v14_research_vault','configure_compute','configure_api','configure_storage',
  'fund_native_vault','install_restricted_agents']);
const STAGE_IDS = V14_PHONE_RESEARCH_STAGE_IDS;
const plain = x => x && typeof x === 'object' && !Array.isArray(x) && [Object.prototype,null].includes(Object.getPrototypeOf(x));
const exact = (x, keys) => plain(x) && Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x,k));
const hex = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const codeHash = bytes => nearApi.utils.serialize.base_encode(crypto.createHash('sha256').update(bytes).digest());
function value(input,label) {
  if (typeof input !== 'string' || !/^[1-9][0-9]{0,38}$/.test(input) || BigInt(input) > MAX_U128) throw new Error(`invalid ${label}`);
  return BigInt(input);
}
function publicKey(raw) {
  try {
    const k = nearApi.utils.PublicKey.from(raw);
    if (typeof raw !== 'string' || String(k) !== raw || k.keyType !== 0 || k.ed25519Key?.data?.length !== 32) throw Error();
    return k;
  } catch { throw new Error('canonical Ed25519 PUBLIC key required'); }
}
function artifacts({ vaultWasm, loaderWasm, compressed, trustedArtifacts }, pinnedCode) {
  if (!exact(trustedArtifacts,['vault_sha256','loader_sha256']) ||
      !/^[a-f0-9]{64}$/.test(trustedArtifacts.vault_sha256 ?? '') || !/^[a-f0-9]{64}$/.test(trustedArtifacts.loader_sha256 ?? '') ||
      !(vaultWasm instanceof Uint8Array) || !(loaderWasm instanceof Uint8Array) || !(compressed instanceof Uint8Array)) {
    throw new Error('independently reviewed public artifacts and digests are required');
  }
  const vault = Buffer.from(vaultWasm), loader = Buffer.from(loaderWasm), packed = Buffer.from(compressed);
  if (vault.length < 8 || vault.length > 1_000_000 || loader.length < 8 || loader.length > 200_000 ||
      packed.length < 1 || packed.length > 200_000 || !vault.subarray(0,8).equals(MAGIC) || !vault.includes(MARKER) ||
      !loader.subarray(0,8).equals(MAGIC) || hex(vault) !== trustedArtifacts.vault_sha256 || hex(loader) !== trustedArtifacts.loader_sha256 ||
      codeHash(vault) !== pinnedCode) throw new Error('V14 or loader artifact differs from the independently reviewed digest');
  let expanded;
  try { expanded = zlib.inflateRawSync(packed,{maxOutputLength:vault.length,info:true}); }
  catch { throw new Error('invalid or oversized compressed V14 code'); }
  if (expanded.engine.bytesWritten !== packed.length || !expanded.buffer.equals(vault)) throw new Error('compressed V14 must match exactly with no trailing bytes');
  return { vault, loader, packed };
}

/** A dummy-key commitment to actions, NOT a signed transaction or original hash. */
export function v14PhoneBatchCommitment(batch) {
  if (!plain(batch) || !STAGE_IDS.includes(batch.id) || !isDirectTestnetChild(batch.vault, batch.signerId) ||
      batch.receiverId !== (batch.id === 'install_restricted_agents' ? batch.signerId : batch.vault) ||
      !Array.isArray(batch.actions) || batch.actions.length < 1 || batch.actions.length > 5) throw new Error('invalid V14 setup batch');
  try {
    const t = nearApi.transactions.createTransaction(batch.signerId,DUMMY_KEY,batch.receiverId,1n,batch.actions,Buffer.alloc(32));
    return crypto.createHash('sha256').update(DOMAIN).update(nearApi.transactions.encodeTransaction(t)).digest('hex');
  } catch { throw new Error('cannot encode V14 setup batch'); }
}

/** Public parameters only. No credentials, signatures, prompts or sends. */
export function buildV14PhoneResearchPlan({ mission: raw, ownerPublicKey, agentPublicKeys, gasAllowances, dailyCaps,
  vaultStorageFundingYocto, nativeDepositYocto, vaultWasm, loaderWasm, compressed, trustedArtifacts } = {}) {
  const mission = validateNativeMission(raw);
  if (!isDirectTestnetChild(mission.contract_id,mission.owner_account_id) ||
      mission.owner_account_id === 'bouncer-owner-12f343b795633e357ae5560d.testnet' ||
      mission.goals.length !== 3 || !['random,oracle,storage','oracle,market,storage'].includes(mission.goals.map(g=>g.kind).join(',')) ||
      !['compute','api','storage'].every(r=>mission.required_resources.includes(r))) {
    throw new Error('a fresh named-testnet three-resource mission with supported dependency order is required');
  }
  const compute = mission.goals.find(x=>['random','market'].includes(x.kind)).goal;
  const api = mission.goals.find(x=>x.kind==='oracle').goal, storage = mission.goals.find(x=>x.kind==='storage').goal;
  const ids = mission.goals.map(x=>x.goal.id), sources = mission.goals.slice(0,2).map(x=>x.goal.id);
  if (!isDeepStrictEqual(storage.value,{from_goal_ids:sources})) {
    throw new Error('storage must record both earlier verified compute and API results');
  }
  if (new Set(mission.goals.map(x=>x.goal.policy_id)).size !== 3 ||
      mission.goals.some(x=>!/^[A-Za-z0-9_-]{1,64}$/.test(x.goal.policy_id)) ||
      api.route.route_revision !== 1 || api.route.policy_revision !== 1 || api.route.payee_revision !== 1 ||
      storage.route.route_revision !== 1 || storage.route.policy_revision !== 1 || storage.route.payee_revision !== 1) {
    throw new Error('fresh distinct native policies and first route revisions are required');
  }
  if (!exact(agentPublicKeys,ids) || !exact(gasAllowances,ids) || !exact(dailyCaps,ids)) {
    throw new Error('exactly one public agent key, gas allowance and rolling cap per goal are required');
  }
  const ownerKey = String(publicKey(ownerPublicKey));
  const agents = Object.fromEntries(ids.map(id=>[id,String(publicKey(agentPublicKeys[id]))]));
  if (new Set([ownerKey,...Object.values(agents)]).size !== 4) throw new Error('owner and restricted agent public keys must be distinct');
  const allowances = Object.fromEntries(ids.map(id=>{
    const allowance=value(gasAllowances[id],'agent gas allowance');
    if (allowance > MAX_AGENT_GAS_ALLOWANCE) throw new Error('agent gas allowance exceeds the research limit');
    return [id,allowance.toString()];
  }));
  const rollingCaps = Object.fromEntries(mission.goals.map(({goal})=>{
    const cap=value(dailyCaps[goal.id],'rolling cap');
    if (cap < BigInt(goal.amount)) throw new Error('rolling cap is less than a goal maximum');
    return [goal.id,cap.toString()];
  }));
  const storageFunding = value(vaultStorageFundingYocto,'vault storage funding');
  const deposit = value(nativeDepositYocto,'native vault deposit');
  const needed = mission.goals.reduce((sum,x)=>sum+BigInt(x.goal.amount),0n);
  if (deposit < needed) throw new Error('native vault deposit is less than the reviewed goal maximums');
  const {vault,loader,packed} = artifacts({vaultWasm,loaderWasm,compressed,trustedArtifacts},storage.contract_code_hash);
  const {transactions:t} = nearApi, owner = mission.owner_account_id, vaultId = mission.contract_id;
  const call = (method,args,deposit=1n,gas=30n*T) => ({ action:t.functionCall(method,args,gas,deposit),
    summary:{type:'function_call',method,args:structuredClone(args),gas:String(gas),deposit_yocto:String(deposit)} });
  const config = (id,goal,payee,routeMethod,routeArgs) => {
    const calls = [call('set_policy',{policy_id:goal.policy_id,token:'native',per_tx_cap:goal.amount,daily_cap:rollingCaps[goal.id]}),
      call('allow_payee',{policy_id:goal.policy_id,payee}),call(routeMethod,routeArgs),
      call('grant_agent_key',{policy_id:goal.policy_id,public_key:agents[goal.id]})];
    return {id,signerId:owner,receiverId:vaultId,vault:vaultId,actions:calls.map(x=>x.action),summaries:calls.map(x=>x.summary)};
  };
  const batches = [
    {id:STAGE_IDS[0],signerId:owner,receiverId:vaultId,vault:vaultId,actions:[t.createAccount(),t.transfer(storageFunding),
      t.deployContract(loader),t.functionCall('loader_init',{},20n*T,1n),t.functionCall('loader_deploy',packed,240n*T,1n)],
      summaries:[{type:'create_account'},{type:'transfer',deposit_yocto:String(storageFunding)},
        {type:'deploy_contract',bytes:loader.length,sha256:hex(loader),near_code_hash:codeHash(loader)},
        {type:'function_call',method:'loader_init',args:{},gas:String(20n*T),deposit_yocto:'1'},
        {type:'function_call',method:'loader_deploy',args_encoding:'raw-deflate',args_bytes:packed.length,args_sha256:hex(packed),
          gas:String(240n*T),deposit_yocto:'1',expected_self_deploy_sha256:hex(vault),expected_owner:owner}]},
    config(STAGE_IDS[1],compute,'outlayer.testnet','set_outlayer_program',{policy_id:compute.policy_id,program:compute.program}),
    config(STAGE_IDS[2],api,'outlayer.testnet','set_outlayer_native_project',{policy_id:api.policy_id,project:api.route.project}),
    config(STAGE_IDS[3],storage,vaultId,'set_native_storage_route',{policy_id:storage.policy_id,prefix:storage.route.prefix,
      max_value_bytes:storage.route.max_value_bytes}),
    (()=>{const c=call('deposit_native',{},deposit); return {id:STAGE_IDS[4],signerId:owner,receiverId:vaultId,vault:vaultId,
      actions:[c.action],summaries:[c.summary]};})(),
    {id:STAGE_IDS[5],signerId:owner,receiverId:owner,vault:vaultId,actions:mission.goals.map(({kind,goal})=>
      t.addKey(publicKey(agents[goal.id]),t.functionCallAccessKey(vaultId,[['random','market'].includes(kind)?'execute_outlayer':
        kind === 'oracle'?'execute_outlayer_native_project':'execute_native_storage'],BigInt(allowances[goal.id])))),
      summaries:mission.goals.map(({kind,goal})=>({type:'add_function_call_key',public_key:agents[goal.id],receiver_id:vaultId,
        method_names:[['random','market'].includes(kind)?'execute_outlayer':kind === 'oracle'?'execute_outlayer_native_project':'execute_native_storage'],
        allowance_yocto:allowances[goal.id]}))},
  ];
  const stages = batches.map(b=>({id:b.id,signer_id:b.signerId,receiver_id:b.receiverId,actions:structuredClone(b.summaries),
    action_commitment_sha256:v14PhoneBatchCommitment(b)}));
  const review = {format:'bouncer-research-v14-phone-plan-v1',status:'UNSIGNED_OFFLINE_PLAN_ONLY',network:'testnet',
    owner,owner_public_key:ownerKey,vault:vaultId,mission,mission_sha256:hex(Buffer.from(JSON.stringify(mission))),
    agent_public_keys:agents,agent_gas_allowances_yocto:allowances,rolling_caps_yocto:rollingCaps,
    vault_storage_funding_yocto:String(storageFunding),
    native_deposit_yocto:String(deposit),artifacts:{vault_bytes:vault.length,vault_sha256:hex(vault),vault_code_hash:codeHash(vault),
      loader_bytes:loader.length,loader_sha256:hex(loader),loader_code_hash:codeHash(loader),compressed_bytes:packed.length,compressed_sha256:hex(packed)},
    stages,limitations:[
      'Research only: no owner approval, wallet prompt, transaction or provider delivery is established.',
      'The first transaction upgrades asynchronously; a failure can leave funds in the loader. Never retry an unknown original.',
      'Each stage requires a separately retained one-shot claim, original hash, receipt verification and fresh FINAL preflight before another prompt.',
      'Loader and vault digests must be independently reviewed; a digest and version marker do not prove safe code or build provenance.',
      'Public on-chain storage is not private or independent; storage collateral may remain locked, and gas is additional.',
    ],signing_authorized:false,transaction_sent:false};
  review.review_sha256 = hex(Buffer.from(JSON.stringify(review)));
  return {review,batches:batches.map(({summaries,...b})=>b)};
}

/** Reconstruct the entire unsigned plan against an independently retained digest. */
export function verifyV14PhoneResearchPlan({review,trustedReviewSha256,...inputs} = {}) {
  if (!plain(review) || !/^[a-f0-9]{64}$/.test(trustedReviewSha256 ?? '') || review.review_sha256 !== trustedReviewSha256) {
    throw new Error('an independently retained V14 review digest is required');
  }
  const plan = buildV14PhoneResearchPlan(inputs);
  if (!isDeepStrictEqual(plan.review,review)) throw new Error('V14 review differs from the reconstructed plan');
  return plan;
}
