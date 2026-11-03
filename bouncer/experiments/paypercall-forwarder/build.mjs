/**
 * EXPERIMENT ONLY: generate an immutable, order-specific NEAR WASM forwarder.
 * This is not deployed, audited, a payment runner, or authorization to spend.
 * The module has fixed testnet owner/vault/token/escrow/terms and no upgrade
 * or arbitrary-call import. V11 must still separately authorize payment to it.
 * Local-clock validation, a code hash and model tests are NOT chain evidence.
 */
import crypto from 'node:crypto';
import nearApi from 'near-api-js';
import wabtFactory from 'wabt';
import { CIRCLE_TESTNET_USDC } from '../../scripts/circle-testnet-setup.mjs';
import { isTestnetAccount } from '../../shared/account-id.mjs';
import { buildPayPerCallMessage, PAYPERCALL_TESTNET_ESCROW } from '../../agent/paypercall-inspect.mjs';

const U128 = (1n << 128n) - 1n, LIFETIME_MS = 73 * 60 * 60 * 1000;
// A deliberately conservative testnet-only floor, not proof of future NEAR
// storage prices. Real setup must check the fresh protocol storage requirement.
const MIN_NATIVE_RESERVE = 10n ** 24n;
const UINT = x => typeof x === 'string' && /^(0|[1-9][0-9]{0,38})$/.test(x) && BigInt(x) <= U128;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const directChild = (child, parent) => child.endsWith(`.${parent}`) &&
  child.slice(0, -parent.length - 1).length > 0 && !child.slice(0, -parent.length - 1).includes('.');
function keyBytes(publicKey) {
  try {
    const key = nearApi.utils.PublicKey.from(publicKey);
    if (String(key) !== publicKey || !publicKey.startsWith('ed25519:') || key.ed25519Key?.data?.length !== 32) throw Error();
    return Buffer.concat([Buffer.from([0]), Buffer.from(key.ed25519Key.data)]);
  } catch { throw new Error('a canonical public ed25519 agent key is required'); }
}
function normalize(input, nowMs) {
  const names = ['adapter', 'forwarder_agent_public_key', 'vault_agent_public_key', 'policy_id', 'intent_id',
    'amount', 'expires_at_ms', 'native_return_cap', 'native_reserve', 'owner', 'request', 'service_id', 'vault'];
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new Error('invalid experimental forwarder terms');
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Object.keys(descriptors).sort().join(',') !== [...names].sort().join(',') ||
      names.some(name => !Object.hasOwn(descriptors[name], 'value'))) throw new Error('invalid experimental forwarder terms');
  const raw = Object.fromEntries(names.map(name => [name, descriptors[name].value]));
  if (!isTestnetAccount(raw.owner) || !isTestnetAccount(raw.vault) || !isTestnetAccount(raw.adapter) ||
      !directChild(raw.vault, raw.owner) || !directChild(raw.adapter, raw.owner) || raw.adapter === raw.vault ||
      typeof raw.policy_id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(raw.policy_id) ||
      typeof raw.intent_id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(raw.intent_id) ||
      !UINT(raw.amount) || raw.amount === '0' || !UINT(raw.native_return_cap) || !UINT(raw.native_reserve) ||
      BigInt(raw.native_reserve) < MIN_NATIVE_RESERVE || !Number.isSafeInteger(nowMs) || nowMs <= 0 ||
      !Number.isSafeInteger(raw.expires_at_ms) || raw.expires_at_ms <= nowMs || raw.expires_at_ms > nowMs + LIFETIME_MS) {
    throw new Error('invalid experimental forwarder terms');
  }
  const agent = keyBytes(raw.forwarder_agent_public_key), vaultAgent = keyBytes(raw.vault_agent_public_key);
  // A NEAR function-call key is scoped to one receiver. Reusing the same key
  // for both receivers would require excessive authority and is not allowed.
  if (agent.equals(vaultAgent)) throw new Error('distinct receiver-scoped agent keys are required');
  const message = buildPayPerCallMessage({ service_id: raw.service_id, request: raw.request, max_price: raw.amount });
  const review = { version: 'EXPERIMENTAL_PAYPERCALL_FORWARDER_V1', chain_assumption: 'testnet', owner: raw.owner,
    vault: raw.vault, adapter: raw.adapter, forwarder_agent_public_key: raw.forwarder_agent_public_key,
    vault_agent_public_key: raw.vault_agent_public_key, policy_id: raw.policy_id, intent_id: raw.intent_id,
    intent_memo: `bouncer:paypercall:${raw.intent_id}`,
    token: CIRCLE_TESTNET_USDC, escrow: PAYPERCALL_TESTNET_ESCROW, amount: raw.amount,
    service_id: raw.service_id, request: raw.request, request_hash: message.request_hash, referrer: null,
    max_price: raw.amount, expires_at_ms: raw.expires_at_ms, native_return_cap: raw.native_return_cap,
    native_reserve: raw.native_reserve };
  return { review, agent, msg: message.msg };
}

/** Build entirely offline; caller supplies only public terms. Does not write a
 * file, perform an RPC call, create keys, sign, broadcast or fund anything. */
export async function buildExperimentalForwarder(raw, { nowMs = Date.now() } = {}) {
  const { review, agent, msg } = normalize(raw, nowMs);
  const reviewHash = sha(Buffer.from(JSON.stringify(review)));
  const view = { ...review, review_sha256: reviewHash, signed: false, sent: false,
    scope: 'EXPERIMENT ONLY; unaudited, no runtime or deployed-code proof' };
  const entries = [];
  let next = 4096;
  const add = input => {
    const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');
    const item = { ptr: next, len: bytes.length, bytes }; next += bytes.length + 8; entries.push(item); return item;
  };
  const owner = add(review.owner), vault = add(review.vault), adapter = add(review.adapter), token = add(review.token),
    escrow = add(review.escrow), agentKey = add(agent), openKey = add('forwarder:opened'), oneValue = add(Buffer.from([1])),
    err = add('FORWARDER BLOCKED: invalid authority, state, amount or reserve'),
    fTransferCall = add('ft_transfer_call'), fClaim = add('claim'), fStorageWithdraw = add('storage_withdraw'),
    jsonEmpty = add('{}'), openArgs = add(JSON.stringify({ receiver_id: review.escrow, amount: review.amount,
      memo: 'bouncer:experimental-forwarder', msg })), claimArgs = add(JSON.stringify({ token: review.token })),
    inputPrefix = add('{"amount":"'), inputSuffix = add('"}'), amountCap = add(review.amount), nativeCap = add(review.native_return_cap),
    returnPrefix = add(`{"receiver_id":"${review.vault}","amount":"`),
    returnSuffix = add('","memo":"bouncer:forwarder-return","msg":"bouncer:forwarder-return"}'),
    config = add(JSON.stringify(view)), literalTrue = add('true'), literalFalse = add('false');
  if (next >= 30_000) throw new Error('experimental forwarder constants are oversized');
  const escaped = item => [...item.bytes].map(b => `\\${b.toString(16).padStart(2, '0')}`).join('');
  const data = entries.map(item => `(data (i32.const ${item.ptr}) "${escaped(item)}")`).join('\n');
  // Fixed scratch regions and an output buffer are disjoint from constants.
  const REG = 32768, INPUT = 33792, OUT = 34816, DEPOSIT = 36000, AMOUNT = 36032, BALANCE = 36064;
  const reserve = BigInt(review.native_reserve), reserveLo = reserve & ((1n << 64n) - 1n), reserveHi = reserve >> 64n;
  const signed64 = n => n >= (1n << 63n) ? n - (1n << 64n) : n;
  const wat = `(module
    (import "env" "current_account_id" (func $current (param i64)))
    (import "env" "predecessor_account_id" (func $predecessor (param i64)))
    (import "env" "signer_account_id" (func $signer (param i64)))
    (import "env" "signer_account_pk" (func $signer_pk (param i64)))
    (import "env" "attached_deposit" (func $deposit (param i64)))
    (import "env" "account_balance" (func $balance (param i64)))
    (import "env" "block_timestamp" (func $timestamp (result i64)))
    (import "env" "input" (func $input (param i64)))
    (import "env" "register_len" (func $reg_len (param i64) (result i64)))
    (import "env" "read_register" (func $read_reg (param i64 i64)))
    (import "env" "storage_has_key" (func $has (param i64 i64) (result i64)))
    (import "env" "storage_write" (func $write (param i64 i64 i64 i64 i64) (result i64)))
    (import "env" "value_return" (func $value (param i64 i64)))
    (import "env" "panic_utf8" (func $panic (param i64 i64)))
    (import "env" "promise_batch_create" (func $promise (param i64 i64) (result i64)))
    (import "env" "promise_batch_action_function_call" (func $call (param i64 i64 i64 i64 i64 i64 i64)))
    (import "env" "promise_batch_action_transfer" (func $transfer (param i64 i64)))
    (import "env" "promise_return" (func $return (param i64)))
    (memory (export "memory") 2)
    ${data}
    (func $die
      (call $panic (i64.const ${err.len}) (i64.const ${err.ptr})) unreachable)
    (func $assert (param $test i32)
      (if (i32.eqz (local.get $test)) (then (call $die))))
    (func $match (param $ptr i32) (param $len i32) (local $i i32)
      (call $assert (i64.eq (call $reg_len (i64.const 0)) (i64.extend_i32_u (local.get $len))))
      (call $read_reg (i64.const 0) (i64.const ${REG}))
      (block $done (loop $loop
        (br_if $done (i32.ge_u (local.get $i) (local.get $len)))
        (call $assert (i32.eq (i32.load8_u (i32.add (i32.const ${REG}) (local.get $i)))
          (i32.load8_u (i32.add (local.get $ptr) (local.get $i)))))
        (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $loop))))
    (func $identity
      (call $current (i64.const 0)) (call $match (i32.const ${adapter.ptr}) (i32.const ${adapter.len}))
      (call $predecessor (i64.const 0)) (call $match (i32.const ${owner.ptr}) (i32.const ${owner.len}))
      (call $signer (i64.const 0)) (call $match (i32.const ${owner.ptr}) (i32.const ${owner.len})))
    (func $agent
      (call $identity) (call $deposit (i64.const ${DEPOSIT}))
      (call $assert (i32.and (i64.eqz (i64.load (i32.const ${DEPOSIT}))) (i64.eqz (i64.load offset=8 (i32.const ${DEPOSIT})))))
      (call $signer_pk (i64.const 0)) (call $match (i32.const ${agentKey.ptr}) (i32.const ${agentKey.len})))
    (func $owner
      (call $identity) (call $deposit (i64.const ${DEPOSIT}))
      (call $assert (i32.and (i64.eq (i64.load (i32.const ${DEPOSIT})) (i64.const 1))
        (i64.eqz (i64.load offset=8 (i32.const ${DEPOSIT}))))))
    (func $actor
      (call $identity) (call $deposit (i64.const ${DEPOSIT}))
      (call $assert (i64.eqz (i64.load offset=8 (i32.const ${DEPOSIT}))))
      (if (i64.eqz (i64.load (i32.const ${DEPOSIT})))
        (then (call $signer_pk (i64.const 0)) (call $match (i32.const ${agentKey.ptr}) (i32.const ${agentKey.len})))
        (else (call $assert (i64.eq (i64.load (i32.const ${DEPOSIT})) (i64.const 1))))))
    (func $copy (param $src i32) (param $dst i32) (param $len i32) (local $i i32)
      (block $done (loop $loop
        (br_if $done (i32.ge_u (local.get $i) (local.get $len)))
        (i32.store8 (i32.add (local.get $dst) (local.get $i)) (i32.load8_u (i32.add (local.get $src) (local.get $i))))
        (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $loop))))
    ;; Accept only the exact JSON object {"amount":"<canonical positive decimal>"}.
    ;; Bound it lexicographically against a reviewed u128 cap before using it.
    (func $read_amount (param $cap i32) (param $caplen i32) (result i32)
      (local $len i32) (local $n i32) (local $i i32) (local $a i32) (local $b i32) (local $less i32)
      (call $input (i64.const 0))
      (call $assert (i64.le_u (call $reg_len (i64.const 0)) (i64.const 80)))
      (local.set $len (i32.wrap_i64 (call $reg_len (i64.const 0))))
      (call $assert (i32.ge_u (local.get $len) (i32.const ${inputPrefix.len + inputSuffix.len + 1})))
      (call $read_reg (i64.const 0) (i64.const ${INPUT}))
      (block $pdone (loop $prefix
        (br_if $pdone (i32.ge_u (local.get $i) (i32.const ${inputPrefix.len})))
        (call $assert (i32.eq (i32.load8_u (i32.add (i32.const ${INPUT}) (local.get $i)))
          (i32.load8_u (i32.add (i32.const ${inputPrefix.ptr}) (local.get $i)))))
        (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $prefix)))
      (local.set $n (i32.sub (local.get $len) (i32.const ${inputPrefix.len + inputSuffix.len})))
      (call $assert (i32.and (i32.le_u (local.get $n) (i32.const 39)) (i32.le_u (local.get $n) (local.get $caplen))))
      (call $assert (i32.eq (i32.load8_u (i32.add (i32.const ${INPUT + inputPrefix.len}) (local.get $n))) (i32.const 34)))
      (call $assert (i32.eq (i32.load8_u (i32.add (i32.const ${INPUT + inputPrefix.len + 1}) (local.get $n))) (i32.const 125)))
      (call $assert (i32.ne (i32.load8_u (i32.const ${INPUT + inputPrefix.len})) (i32.const 48)))
      (local.set $i (i32.const 0))
      (block $ddone (loop $digits
        (br_if $ddone (i32.ge_u (local.get $i) (local.get $n)))
        (local.set $a (i32.load8_u (i32.add (i32.const ${INPUT + inputPrefix.len}) (local.get $i))))
        (call $assert (i32.and (i32.ge_u (local.get $a) (i32.const 48)) (i32.le_u (local.get $a) (i32.const 57))))
        (if (i32.and (i32.eq (local.get $n) (local.get $caplen)) (i32.eqz (local.get $less))) (then
          (local.set $b (i32.load8_u (i32.add (local.get $cap) (local.get $i))))
          (call $assert (i32.le_u (local.get $a) (local.get $b)))
          (if (i32.lt_u (local.get $a) (local.get $b)) (then (local.set $less (i32.const 1))))))
        (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $digits)))
      (local.get $n))
    ;; Convert already bounded canonical decimal to little-endian u128, checking
    ;; overflow independently. Two 32-bit halves avoid needing a mul-high op.
    (func $to_u128 (param $n i32) (local $i i32) (local $lo i64) (local $hi i64)
      (local $x i64) (local $y i64) (local $carry i64) (local $digit i64)
      (block $done (loop $loop
        (br_if $done (i32.ge_u (local.get $i) (local.get $n)))
        (local.set $digit (i64.extend_i32_u (i32.sub (i32.load8_u
          (i32.add (i32.const ${INPUT + inputPrefix.len}) (local.get $i))) (i32.const 48))))
        (local.set $x (i64.add (i64.mul (i64.and (local.get $lo) (i64.const 4294967295)) (i64.const 10)) (local.get $digit)))
        (local.set $y (i64.add (i64.mul (i64.shr_u (local.get $lo) (i64.const 32)) (i64.const 10)) (i64.shr_u (local.get $x) (i64.const 32))))
        (local.set $carry (i64.shr_u (local.get $y) (i64.const 32)))
        (local.set $lo (i64.or (i64.shl (local.get $y) (i64.const 32)) (i64.and (local.get $x) (i64.const 4294967295))))
        (call $assert (i64.le_u (local.get $hi) (i64.div_u (i64.sub (i64.const -1) (local.get $carry)) (i64.const 10))))
        (local.set $hi (i64.add (i64.mul (local.get $hi) (i64.const 10)) (local.get $carry)))
        (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $loop)))
      (i64.store (i32.const ${AMOUNT}) (local.get $lo))
      (i64.store offset=8 (i32.const ${AMOUNT}) (local.get $hi)))
    (func $token_call (param $args i32) (param $len i32) (local $p i64)
      (local.set $p (call $promise (i64.const ${token.len}) (i64.const ${token.ptr})))
      (i64.store (i32.const ${DEPOSIT}) (i64.const 1)) (i64.store offset=8 (i32.const ${DEPOSIT}) (i64.const 0))
      (call $call (local.get $p) (i64.const ${fTransferCall.len}) (i64.const ${fTransferCall.ptr})
        (i64.extend_i32_u (local.get $len)) (i64.extend_i32_u (local.get $args)) (i64.const ${DEPOSIT}) (i64.const 200000000000000))
      (call $return (local.get $p)))
    (func $escrow_call (param $method i32) (param $mlen i32) (param $args i32) (param $alen i32) (param $gas i64) (local $p i64)
      (local.set $p (call $promise (i64.const ${escrow.len}) (i64.const ${escrow.ptr})))
      (i64.store (i32.const ${DEPOSIT}) (i64.const 0)) (i64.store offset=8 (i32.const ${DEPOSIT}) (i64.const 0))
      (call $call (local.get $p) (i64.extend_i32_u (local.get $mlen)) (i64.extend_i32_u (local.get $method))
        (i64.extend_i32_u (local.get $alen)) (i64.extend_i32_u (local.get $args)) (i64.const ${DEPOSIT}) (local.get $gas))
      (call $return (local.get $p)))
    (func (export "configuration")
      (call $value (i64.const ${config.len}) (i64.const ${config.ptr})))
    (func (export "opened")
      (if (i64.ne (call $has (i64.const ${openKey.len}) (i64.const ${openKey.ptr})) (i64.const 0))
        (then (call $value (i64.const ${literalTrue.len}) (i64.const ${literalTrue.ptr})))
        (else (call $value (i64.const ${literalFalse.len}) (i64.const ${literalFalse.ptr})))))
    (func (export "open")
      (call $agent)
      (call $assert (i64.le_u (i64.div_u (call $timestamp) (i64.const 1000000)) (i64.const ${review.expires_at_ms})))
      (call $assert (i64.eqz (call $has (i64.const ${openKey.len}) (i64.const ${openKey.ptr}))))
      (drop (call $write (i64.const ${openKey.len}) (i64.const ${openKey.ptr}) (i64.const 1) (i64.const ${oneValue.ptr}) (i64.const 1)))
      (call $token_call (i32.const ${openArgs.ptr}) (i32.const ${openArgs.len})))
    (func (export "return_tokens") (local $n i32)
      (call $actor)
      (local.set $n (call $read_amount (i32.const ${amountCap.ptr}) (i32.const ${amountCap.len})))
      (call $copy (i32.const ${returnPrefix.ptr}) (i32.const ${OUT}) (i32.const ${returnPrefix.len}))
      (call $copy (i32.const ${INPUT + inputPrefix.len}) (i32.const ${OUT + returnPrefix.len}) (local.get $n))
      (call $copy (i32.const ${returnSuffix.ptr}) (i32.add (i32.const ${OUT + returnPrefix.len}) (local.get $n)) (i32.const ${returnSuffix.len}))
      (call $token_call (i32.const ${OUT}) (i32.add (i32.const ${returnPrefix.len + returnSuffix.len}) (local.get $n))))
    (func (export "claim")
      (call $actor) (call $escrow_call (i32.const ${fClaim.ptr}) (i32.const ${fClaim.len})
        (i32.const ${claimArgs.ptr}) (i32.const ${claimArgs.len}) (i64.const 70000000000000)))
    (func (export "withdraw_storage")
      (call $owner) (call $escrow_call (i32.const ${fStorageWithdraw.ptr}) (i32.const ${fStorageWithdraw.len})
        (i32.const ${jsonEmpty.ptr}) (i32.const ${jsonEmpty.len}) (i64.const 30000000000000)))
    (func (export "return_native") (local $n i32) (local $lo i64) (local $hi i64) (local $borrow i64) (local $p i64)
      (call $owner) (local.set $n (call $read_amount (i32.const ${nativeCap.ptr}) (i32.const ${nativeCap.len}))) (call $to_u128 (local.get $n))
      (call $balance (i64.const ${BALANCE}))
      (local.set $lo (i64.load (i32.const ${BALANCE}))) (local.set $hi (i64.load offset=8 (i32.const ${BALANCE})))
      (call $assert (i32.or (i64.gt_u (local.get $hi) (i64.const ${signed64(reserveHi)}))
        (i32.and (i64.eq (local.get $hi) (i64.const ${signed64(reserveHi)})) (i64.ge_u (local.get $lo) (i64.const ${signed64(reserveLo)})))))
      (local.set $borrow (i64.extend_i32_u (i64.lt_u (local.get $lo) (i64.const ${signed64(reserveLo)}))))
      (local.set $lo (i64.sub (local.get $lo) (i64.const ${signed64(reserveLo)})))
      (local.set $hi (i64.sub (i64.sub (local.get $hi) (i64.const ${signed64(reserveHi)})) (local.get $borrow)))
      (call $assert (i32.or (i64.lt_u (i64.load offset=8 (i32.const ${AMOUNT})) (local.get $hi))
        (i32.and (i64.eq (i64.load offset=8 (i32.const ${AMOUNT})) (local.get $hi)) (i64.le_u (i64.load (i32.const ${AMOUNT})) (local.get $lo)))))
      (local.set $p (call $promise (i64.const ${owner.len}) (i64.const ${owner.ptr})))
      (call $transfer (local.get $p) (i64.const ${AMOUNT})) (call $return (local.get $p)))
  )`;
  const wabt = await wabtFactory(), parsed = wabt.parseWat('experimental-forwarder.wat', wat);
  try {
    parsed.validate();
    const wasm = Buffer.from(parsed.toBinary({ log: false, write_debug_names: false }).buffer);
    const module = new WebAssembly.Module(wasm);
    const imports = WebAssembly.Module.imports(module), exports = WebAssembly.Module.exports(module);
    if (imports.some(i => i.module !== 'env' || i.kind !== 'function') ||
        imports.some(i => /deploy|delete|add_key|delegate|create_account/i.test(i.name)) ||
        exports.map(e => e.name).sort().join(',') !== ['memory', 'configuration', 'opened', 'open', 'return_tokens',
          'claim', 'withdraw_storage', 'return_native'].sort().join(',')) {
      throw new Error('unexpected experimental WASM interface');
    }
    return { wasm, wasm_sha256: sha(wasm), review: view, imports: imports.map(i => i.name) };
  } finally { parsed.destroy(); }
}
