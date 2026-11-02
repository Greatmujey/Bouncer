/**
 * Optional old NEAR VMLogic host cross-check, NOT nearcore 2.14 or a chain.
 * It uses uninstrumented contracts, zero/default mock gas charges, no receipt
 * execution and no protocol/access-key validation. Set the explicit directory
 * only after locally obtaining near-mock-vm 3.2.2; both upstream files are
 * checked against fixed hashes before the package is loaded. This test executes
 * third-party JS/WASM and the pins are not an independent security audit.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import nearApi from 'near-api-js';
import { buildExperimentalForwarder } from '../experiments/paypercall-forwarder/build.mjs';
import { OWNER, VAULT, AGENT_PK, TIME_NS } from './fixtures/v11-synthetic-host.mjs';
import { CIRCLE_TESTNET_USDC as TOKEN } from '../scripts/circle-testnet-setup.mjs';
import { PAYPERCALL_TESTNET_ESCROW as ESCROW } from '../agent/paypercall-inspect.mjs';

const dir = process.env.BOUNCER_LEGACY_MOCK_VM_DIR;
const skip = dir ? false : 'set BOUNCER_LEGACY_MOCK_VM_DIR to the hash-checked optional near-mock-vm pkg directory';
const expected = { 'near_mock_vm.js': 'b3941d6af28c7f7edd0b42f25f64cd039995841fcce106b39a5600291be2ed72',
  'near_mock_vm_bg.wasm': '798f2d355187fc109adc5ed720dac6d6032c773d70ae19fceadcc056082c6503' };
function loadVm() {
  for (const [name, digest] of Object.entries(expected)) {
    const file = path.join(dir, name), stat = fs.lstatSync(file);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size < 2_000_000);
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), digest, `unexpected optional ${name}`);
  }
  const require = createRequire(import.meta.url);
  return require(path.resolve(dir, 'near_mock_vm.js')).VM;
}

const ADAPTER = 'forward.owner.testnet', PK_BYTES = Buffer.concat([Buffer.from([0]), Buffer.alloc(32, 9)]);
const PK = `ed25519:${nearApi.utils.serialize.base_encode(PK_BYTES.subarray(1))}`;
const NOW = Number(TIME_NS / 1_000_000n), NEAR = (10n ** 24n).toString();
function vmFor(VM, wasm, { input = {}, deposit = '0' } = {}) {
  const context = { current_account_id: ADAPTER, signer_account_id: OWNER,
    signer_account_pk: nearApi.utils.serialize.base_encode(PK_BYTES), predecessor_account_id: OWNER,
    input: Buffer.from(JSON.stringify(input)).toString('base64'), block_index: 10, block_timestamp: 42, epoch_height: 20,
    account_balance: (10n ** 26n).toString(), account_locked_balance: '0', storage_usage: 10000,
    attached_deposit: deposit, prepaid_gas: 300000000000000, random_seed: '11111111111111111111111111111111',
    is_view: false, output_data_receivers: [] };
  let instance;
  const memory = {
    fits_memory(offset, length) { return Number(offset) + Number(length) <= instance.exports.memory.buffer.byteLength; },
    read_memory(offset, out) { out.set(new Uint8Array(instance.exports.memory.buffer, Number(offset), out.length)); },
    read_memory_u8(offset) { return new Uint8Array(instance.exports.memory.buffer)[Number(offset)]; },
    write_memory(offset, value) { new Uint8Array(instance.exports.memory.buffer).set(value, Number(offset)); },
  };
  const vm = new VM(context, memory); vm.set_block_timestamp(TIME_NS);
  const mod = new WebAssembly.Module(wasm), imports = Object.fromEntries(WebAssembly.Module.imports(mod).map(({ name }) =>
    [name, (...args) => { if (typeof vm[name] !== 'function') throw new Error(`old VM lacks ${name}`); return vm[name](...args); }]));
  instance = new WebAssembly.Instance(mod, { env: imports });
  return { vm, instance, receipts: () => JSON.parse(vm.created_receipts()) };
}

test('old mock NEAR VMLogic independently records the forwarder fixed calls and native transfer', { skip }, async () => {
  const VM = loadVm(), a = await buildExperimentalForwarder({ owner: OWNER, vault: VAULT, adapter: ADAPTER,
    vault_agent_public_key: AGENT_PK, forwarder_agent_public_key: PK, policy_id: 'forward', intent_id: 'forward-1',
    amount: '100', service_id: 7, request: 'wrap.testnet', expires_at_ms: NOW + 60_000,
    native_return_cap: NEAR, native_reserve: NEAR }, { nowMs: NOW });
  {
    const { vm, instance, receipts } = vmFor(VM, a.wasm);
    instance.exports.open();
    const [r] = receipts(), action = r.actions[0].FunctionCall;
    assert.equal(r.receiver_id, TOKEN); assert.equal(action.method_name, 'ft_transfer_call');
    assert.equal(action.deposit, 1); assert.equal(action.gas, 200000000000000);
    const args = JSON.parse(action.args);
    assert.equal(args.receiver_id, ESCROW); assert.equal(args.amount, '100');
    assert.deepEqual(JSON.parse(args.msg), { service_id: 7, request: 'wrap.testnet', referrer: null, max_price: '100' });
    assert.equal(vm.outcome().storage_usage, 17); // only the mock host's accounting
    vm.free();
  }
  {
    const { vm, instance, receipts } = vmFor(VM, a.wasm, { input: { amount: '40' } });
    instance.exports.return_tokens();
    const [r] = receipts(), action = r.actions[0].FunctionCall;
    assert.equal(r.receiver_id, TOKEN); assert.equal(action.method_name, 'ft_transfer_call');
    assert.equal(JSON.parse(action.args).receiver_id, VAULT); assert.equal(JSON.parse(action.args).amount, '40');
    vm.free();
  }
  {
    const { vm, instance, receipts } = vmFor(VM, a.wasm);
    instance.exports.claim();
    const [r] = receipts(), action = r.actions[0].FunctionCall;
    assert.equal(r.receiver_id, ESCROW); assert.equal(action.method_name, 'claim');
    assert.deepEqual(JSON.parse(action.args), { token: TOKEN }); assert.equal(action.deposit, 0);
    vm.free();
  }
  {
    const { vm, instance, receipts } = vmFor(VM, a.wasm, { input: { amount: '123456789' }, deposit: '1' });
    instance.exports.return_native();
    const [r] = receipts(); assert.equal(r.receiver_id, OWNER); assert.equal(r.actions[0].Transfer.deposit, 123456789);
    vm.free();
  }
});
