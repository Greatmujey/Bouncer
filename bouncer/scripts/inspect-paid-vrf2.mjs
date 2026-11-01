#!/usr/bin/env node
/** READ ONLY. Independently inspect the retained one-shot VRF2 artifacts and
 * original FINAL hashes. No account keys, journal writes, sends or retries.
 * RPC, token, provider and the independently pinned VRF key remain trusted. */
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import nearApi from 'near-api-js';
import { PaymentRpcProvider } from '../agent/near-account.mjs';
import { validateFtCallGoal, verifyFtCallSettlement } from '../agent/ft-call.mjs';
import { validateProjectGoal, verifyProjectResult } from '../agent/outlayer-project.mjs';
import { verifyTestnetProbeSetupResult } from '../agent/testnet-probe-submit.mjs';
import { isTransactionHash } from '../shared/direct-payment-settlement.mjs';
import { assertVrf2Snapshot, readVrf2Snapshot } from './paid-vrf2-once.mjs';

const TOKEN = 'usdc.fakes.testnet', OUTLAYER = 'outlayer.testnet', PROJECT = 'connectors.outlayer.testnet/connector-probe';
const VERSION = '2d406ed8005a422c38aec0616990989970e2c444c1386d4f09d54cce59468fb9';
const KEY = 'c0c5aeae1688c2f7cc2350aae1ee3ce96eddc0de84d678db873de48268f8cfa8';
const WASM = '835f0baa51d08ddf3af6812df0caefb93283480735a63e3d382073e04fbaf8ee';
const MAX_NATIVE = '100000000000000000000000', MSG = '{"action":"deposit_balance"}';
const equal = isDeepStrictEqual;

export function assertVrf2Review(identity, funding, project) {
  const f = validateFtCallGoal(funding), p = validateProjectGoal(project);
  let publicKeys;
  try { publicKeys = ['vault_public_key', 'owner_public_key', 'funding_public_key', 'project_public_key'].map(field => {
    const key = nearApi.utils.PublicKey.from(identity[field]);
    if (key.keyType !== 0 || String(key) !== identity[field]) throw new Error();
    return String(key);
  }); } catch { throw new Error('invalid retained public keys'); }
  if (new Set(publicKeys).size !== 4 || identity?.purpose !== 'fresh-testnet-fake-token-independent-vrf-diagnostic' ||
      !/^bouncer-vrf2-[a-f0-9]{10}\.testnet$/.test(identity.vault) ||
      identity.owner !== identity.vault.replace('bouncer-vrf2-', 'owner-vrf2-') ||
      !/^bouncer_vrf2_[a-f0-9]{32}$/.test(identity.seed) || identity.vault_wasm_sha256 !== WASM ||
      identity.vault_code_hash !== nearApi.utils.serialize.base_encode(Buffer.from(WASM, 'hex')) ||
      f.id !== 'provider-prepaid-funding' || f.contract_id !== identity.vault || f.owner_account_id !== identity.owner ||
      f.policy_id !== 'provider-funding' || f.payee !== OUTLAYER || f.token !== TOKEN || f.amount !== '10000' || f.msg !== MSG ||
      p.id !== 'independent-vrf-diagnostic' || p.contract_id !== identity.vault || p.owner_account_id !== identity.owner ||
      p.native_policy_id !== 'project-native' || p.amount !== MAX_NATIVE || p.expected_author !== 'zavodil.testnet' ||
      p.expected_vrf_pubkey !== KEY || p.route.project.project_id !== PROJECT || p.route.project.version_key !== VERSION ||
      p.route.project.usd_policy_id !== 'project-token' || p.route.project.token !== TOKEN || p.route.project.attached_usd !== '10000' ||
      p.route.project.input_data !== JSON.stringify({ operation: 'vrf', seed: identity.seed }) ||
      !equal({ max_instructions: p.route.project.max_instructions, max_memory_mb: p.route.project.max_memory_mb,
        max_execution_seconds: p.route.project.max_execution_seconds }, { max_instructions: 1_000_000_000, max_memory_mb: 256, max_execution_seconds: 60 })) {
    throw new Error('retained identity, goals or pinned testnet terms differ from review');
  }
  return { funding: f, project: p };
}

function decodeArgs(value) {
  if (typeof value !== 'string' || value.length > 8192) throw new Error('invalid recorded policy arguments');
  const raw = Buffer.from(value, 'base64');
  if (raw.toString('base64') !== value) throw new Error('noncanonical recorded policy arguments');
  try { return JSON.parse(raw.toString('utf8')); } catch { throw new Error('invalid recorded policy arguments'); }
}
export function assertOwnerPolicyCalls(result, expected) {
  const actions = result?.transaction?.actions;
  if (!Array.isArray(actions) || actions.length !== expected.length) throw new Error('wrong owner policy action count');
  expected.forEach(({ method, args }, i) => {
    const call = actions[i]?.FunctionCall;
    if (!call || call.method_name !== method || String(call.deposit) !== '1' || !equal(decodeArgs(call.args), args)) {
      throw new Error('owner policy action, arguments or one-yocto deposit differs');
    }
  });
}

async function main() {
  const dir = process.argv[2];
  if (!dir || process.argv.length !== 3) throw new Error('usage: node inspect-paid-vrf2.mjs RETAINED_EVIDENCE_DIRECTORY');
  const read = name => {
    const file = path.join(dir, name), stat = fs.statSync(file);
    if (!stat.isFile() || stat.size < 2 || stat.size > 5_000_000) throw new Error(`invalid retained ${name}`);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  };
  const identity = read('identity.json'), fundingGoal = read('funding-goal.json'), projectGoal = read('project-goal.json');
  const reviewed = assertVrf2Review(identity, fundingGoal, projectGoal);
  const fundingIntent = read('provider-prepaid-funding-intent.json'), projectIntent = read('independent-vrf-diagnostic-intent.json');
  if (!isTransactionHash(fundingIntent.tx_hash) || !isTransactionHash(projectIntent.tx_hash) || fundingIntent.tx_hash === projectIntent.tx_hash ||
      fundingIntent.id !== reviewed.funding.id || projectIntent.id !== reviewed.project.id || fundingIntent.vault !== identity.vault ||
      projectIntent.vault !== identity.vault || fundingIntent.owner !== identity.owner || projectIntent.owner !== identity.owner ||
      fundingIntent.signer_public_key !== identity.funding_public_key || projectIntent.signer_public_key !== identity.project_public_key ||
      fundingIntent.do_not_resend !== true || projectIntent.do_not_resend !== true) throw new Error('retained original payment intents differ');
  const before = read('before-snapshot.json'), funded = read('funded-snapshot.json'), fulfilled = read('fulfilled-snapshot.json');
  for (const [stage, snap] of [['before', before], ['funded', funded], ['fulfilled', fulfilled]]) assertVrf2Snapshot(stage, snap);
  const provider = new PaymentRpcProvider(process.env.NEAR_TESTNET_RPC || 'https://test.rpc.fastnear.com', { receiptTimeoutMs: 60_000 });
  if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('inspection requires testnet');
  const stages = ['deployment', 'funding-policy', 'native-policy', 'token-policy', 'project-route'];
  const setup = {};
  for (const stage of stages) {
    const intent = read(`${stage}-intent.json`);
    const signer = stage === 'deployment' ? identity.vault : identity.owner;
    const publicKey = stage === 'deployment' ? identity.vault_public_key : identity.owner_public_key;
    if (intent.id !== stage || !isTransactionHash(intent.tx_hash) || intent.signer_id !== signer ||
        intent.receiver_id !== identity.vault || intent.public_key !== publicKey) throw new Error(`${stage} original setup intent differs`);
    const result = await provider.txStatusReceipts(intent.tx_hash, signer, 'FINAL');
    verifyTestnetProbeSetupResult({ result, txHash: intent.tx_hash, signerId: signer, receiverId: identity.vault, publicKey });
    setup[stage] = { hash: intent.tx_hash, result };
  }
  const policy = (policy_id, token, cap) => ({ method: 'set_policy', args: { policy_id, token, per_tx_cap: cap, daily_cap: cap } });
  const allow = policy_id => ({ method: 'allow_payee', args: { policy_id, payee: OUTLAYER } });
  const grant = (policy_id, public_key) => ({ method: 'grant_agent_key', args: { policy_id, public_key } });
  assertOwnerPolicyCalls(setup['funding-policy'].result, [policy('provider-funding', TOKEN, '10000'), allow('provider-funding'),
    { method: 'set_ft_call_message', args: { policy_id: 'provider-funding', payee: OUTLAYER, msg: MSG } },
    grant('provider-funding', identity.funding_public_key)]);
  assertOwnerPolicyCalls(setup['native-policy'].result, [policy('project-native', 'native', MAX_NATIVE), allow('project-native'),
    grant('project-native', identity.project_public_key)]);
  assertOwnerPolicyCalls(setup['token-policy'].result, [policy('project-token', TOKEN, '10000'), allow('project-token'),
    grant('project-token', identity.project_public_key)]);
  assertOwnerPolicyCalls(setup['project-route'].result, [{ method: 'set_outlayer_project',
    args: { native_policy_id: 'project-native', project: projectGoal.route.project } }]);
  const [fundingResult, projectResult, beforeActual, fundedActual, fulfilledActual] = await Promise.all([
    provider.txStatusReceipts(fundingIntent.tx_hash, identity.owner, 'FINAL'), provider.txStatusReceipts(projectIntent.tx_hash, identity.owner, 'FINAL'),
    readVrf2Snapshot(provider, identity.vault, before.block_hash), readVrf2Snapshot(provider, identity.vault, funded.block_hash),
    readVrf2Snapshot(provider, identity.vault, fulfilled.block_hash),
  ]);
  if (!equal(beforeActual, before) || !equal(fundedActual, funded) || !equal(fulfilledActual, fulfilled)) {
    throw new Error('retained snapshots do not match their original FINAL block views');
  }
  const funding = verifyFtCallSettlement(reviewed.funding, fundingResult, identity.funding_public_key);
  const delivery = verifyProjectResult(reviewed.project, projectResult, identity.project_public_key);
  if (funding.tx_hash !== fundingIntent.tx_hash || funding.used !== '10000' || funding.unused !== '0' ||
      delivery.tx_hash !== projectIntent.tx_hash || delivery.prepaid_charged !== '10000') throw new Error('original FT payment or VRF delivery mismatch');
  const at = { blockId: before.block_hash };
  const [account, keys, version, owner, fundingAccess, projectAccess, fundingPolicy, tokenPolicy, nativePolicy, ftRoute, projectRoute] = await Promise.all([
    provider.query({ request_type: 'view_account', account_id: identity.vault, ...at }),
    provider.query({ request_type: 'view_access_key_list', account_id: identity.vault, ...at }),
    provider.callFunction(identity.vault, 'contract_version', {}, at), provider.callFunction(identity.vault, 'get_owner', {}, at),
    provider.viewAccessKey(identity.owner, identity.funding_public_key, at), provider.viewAccessKey(identity.owner, identity.project_public_key, at),
    provider.callFunction(identity.vault, 'get_policy', { policy_id: 'provider-funding' }, at),
    provider.callFunction(identity.vault, 'get_policy', { policy_id: 'project-token' }, at),
    provider.callFunction(identity.vault, 'get_policy', { policy_id: 'project-native' }, at),
    provider.callFunction(identity.vault, 'get_ft_call_route', { policy_id: 'provider-funding', payee: OUTLAYER }, at),
    provider.callFunction(identity.vault, 'get_outlayer_project', { native_policy_id: 'project-native' }, at),
  ]);
  const permissionOk = (access, method) => access?.permission?.FunctionCall?.receiver_id === identity.vault &&
    equal(access.permission.FunctionCall.method_names, [method]);
  const policyOk = (actual, token, cap) => actual?.token === token && actual.per_tx_cap === cap && actual.daily_cap === cap;
  if (account.code_hash !== identity.vault_code_hash || !Array.isArray(keys.keys) || keys.keys.length || keys.block_hash !== before.block_hash ||
      version !== 'bouncer-agent-v9' || owner !== identity.owner || !permissionOk(fundingAccess, 'execute_ft_call') ||
      !permissionOk(projectAccess, 'execute_outlayer_project') || !policyOk(fundingPolicy, TOKEN, '10000') ||
      !policyOk(tokenPolicy, TOKEN, '10000') || !policyOk(nativePolicy, 'native', MAX_NATIVE) ||
      !equal(ftRoute, { token: TOKEN, msg: MSG, policy_revision: reviewed.funding.policy_revision,
        route_revision: reviewed.funding.route_revision, active: true }) || !equal(projectRoute, reviewed.project.route)) {
    throw new Error('FINAL vault identity, scoped keys, caps or reviewed routes differ');
  }
  const report = read('report.json');
  if (!equal(report.funding, funding) || !equal(report.delivery, delivery) || !equal(report.before, before) || !equal(report.funded, funded) ||
      !equal(report.fulfilled, fulfilled) || report.funding_sends !== 1 || report.project_sends !== 1) throw new Error('retained report differs from reverified evidence');
  const summary = { vault: identity.vault, owner: identity.owner, funding_tx: funding.tx_hash, project_tx: delivery.tx_hash,
    setup_hashes: Object.fromEntries(stages.map(stage => [stage, setup[stage].hash])), funding, delivery, before, funded, fulfilled,
    owner_policy_calls_one_yocto: true, scoped_agent_keys: true, deployed_vault_keys_removed: true,
    inspection_sends: 0, inspection_journal_writes: 0,
    scope: 'read-only original FINAL receipts, same-block views and pinned-key VRF signature; fake test USDC.e and native NEAR, not Circle USDC, commercial services, TEE or unbiased-key proof' };
  console.log(`::notice title=Read-only independent VRF2 original-hash inspection::${JSON.stringify(summary).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    const detail = String(error.message || error).slice(0, 2000).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
    console.error(`[inspect-paid-vrf2] ${error.message}`); console.log(`::error title=Read-only VRF2 inspection failed::${detail}`);
    process.exitCode = 1;
  });
}
