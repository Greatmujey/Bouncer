/** Hash-pinned, deliberately incomplete local host for V11 bytecode tests.
 * No network, chain, gas, real accounts or receipt scheduling. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';

export const EXPECTED_SHA256 = '1acf931c07a530257999478c121193863ecf7201d357812a44b4d61c16a77921';
export const EXPECTED_SIZE = 536_325;
export const OWNER = 'owner.testnet';
export const VAULT = 'trial.owner.testnet';
export const TOKEN = 'token.testnet';
export const PAYEE = 'vendor.testnet';
// Public, deterministic synthetic key; its bytes and this name carry no funds.
export const AGENT_PK = 'ed25519:US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx';
export const AGENT_BYTES = Buffer.concat([Buffer.from([0]), Buffer.alloc(32, 7)]);
export const TIME_NS = 1_800_000_000_000_000_000n;
export function readExactArtifact(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    assert.ok(stat.isFile() && stat.size === EXPECTED_SIZE, 'wrong V11 artifact size or file type');
    const data = Buffer.alloc(EXPECTED_SIZE);
    let offset = 0;
    while (offset < data.length) {
      const n = fs.readSync(fd, data, offset, data.length - offset, null);
      assert.ok(n > 0, 'short artifact read');
      offset += n;
    }
    assert.equal(fs.readSync(fd, Buffer.alloc(1), 0, 1, null), 0, 'artifact grew while reading');
    assert.equal(fs.fstatSync(fd).size, EXPECTED_SIZE, 'artifact changed size while reading');
    assert.equal(crypto.createHash('sha256').update(data).digest('hex'), EXPECTED_SHA256, 'wrong V11 artifact hash');
    return data;
  } finally { fs.closeSync(fd); }
}

/** A deliberately incomplete host, with a new WASM instance per call.
 * State and promise effects are rolled back when the mocked call throws.
 * Every unused host import throws, so a new path cannot silently pass by
 * using an unimplemented function. The checked artifact hash is the trust
 * boundary for executing this code; tests must not run arbitrary binaries. */
export class SyntheticNearHost {
  constructor(bytes) {
    this.module = new WebAssembly.Module(bytes);
    this.storage = new Map();
    this.registers = new Map();
    this.promises = [];
    this.logs = [];
    this.context = {};
    this.input = Buffer.from('{}');
    this.result = undefined;
    const imports = WebAssembly.Module.imports(this.module);
    assert.ok(imports.every(i => i.module === 'env' && i.kind === 'function'), 'unexpected WASM imports');
    this.env = Object.fromEntries(imports.map(i => [i.name, () => { throw new Error(`unimplemented host function: ${i.name}`); }]));
    Object.assign(this.env, {
      input: id => this.register(id, this.input),
      register_len: id => this.registers.has(String(id)) ? BigInt(this.registers.get(String(id)).length) : 0xffffffffffffffffn,
      read_register: (id, pointer) => {
        const value = this.registers.get(String(id));
        if (!value) throw new Error('missing mocked register');
        this.write(pointer, value);
      },
      current_account_id: id => this.register(id, Buffer.from(this.context.current ?? VAULT)),
      predecessor_account_id: id => this.register(id, Buffer.from(this.context.predecessor ?? OWNER)),
      signer_account_id: id => this.register(id, Buffer.from(this.context.signer ?? OWNER)),
      signer_account_pk: id => this.register(id, this.context.signerPk ?? AGENT_BYTES),
      attached_deposit: pointer => this.writeU128(pointer, this.context.deposit ?? 0n),
      account_balance: pointer => this.writeU128(pointer, this.context.balance ?? 10n ** 26n),
      block_timestamp: () => this.context.timestamp ?? TIME_NS,
      storage_usage: () => BigInt([...this.storage].reduce((n, [k, v]) => n + k.length / 2 + v.length, 0)),
      storage_read: (length, pointer, registerId) => {
        const key = this.read(pointer, length).toString('hex');
        if (!this.storage.has(key)) return 0n;
        this.register(registerId, this.storage.get(key)); return 1n;
      },
      storage_write: (keyLength, keyPointer, valueLength, valuePointer, registerId) => {
        const key = this.read(keyPointer, keyLength).toString('hex');
        const existed = this.storage.has(key);
        if (existed) this.register(registerId, this.storage.get(key));
        this.storage.set(key, this.read(valuePointer, valueLength));
        return existed ? 1n : 0n;
      },
      storage_remove: (length, pointer, registerId) => {
        const key = this.read(pointer, length).toString('hex');
        if (!this.storage.has(key)) return 0n;
        this.register(registerId, this.storage.get(key)); this.storage.delete(key); return 1n;
      },
      storage_has_key: (length, pointer) => this.storage.has(this.read(pointer, length).toString('hex')) ? 1n : 0n,
      value_return: (length, pointer) => { this.result = this.read(pointer, length); },
      log_utf8: (length, pointer) => this.logs.push(this.read(pointer, length).toString('utf8')),
      panic_utf8: (length, pointer) => { throw new Error(`WASM panic: ${this.read(pointer, length).toString('utf8')}`); },
      promise_batch_create: (length, pointer) => this.newPromise(this.read(pointer, length).toString('utf8')),
      promise_batch_then: (parent, length, pointer) => this.newPromise(this.read(pointer, length).toString('utf8'), Number(parent)),
      promise_batch_action_function_call: (...args) => this.recordCall(...args, 0n),
      promise_batch_action_function_call_weight: (...args) => this.recordCall(...args),
      promise_return: id => { this.returnedPromise = Number(id); },
      promise_result: (index, registerId) => {
        assert.equal(index, 0n, 'unexpected mocked promise result index');
        if (this.context.promiseResult === 'failed') return 2n;
        if (this.context.promiseResult === 'success') { this.register(registerId, Buffer.alloc(0)); return 1n; }
        throw new Error('promise result was not supplied to the synthetic host');
      },
    });
  }
  number(value) {
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < 0) throw new Error('invalid mocked memory offset');
    return n;
  }
  read(pointer, length) {
    const p = this.number(pointer), n = this.number(length);
    const memory = new Uint8Array(this.instance.exports.memory.buffer);
    if (p + n > memory.length) throw new Error('mocked memory read out of bounds');
    return Buffer.from(memory.slice(p, p + n));
  }
  write(pointer, value) {
    const p = this.number(pointer), memory = new Uint8Array(this.instance.exports.memory.buffer);
    if (p + value.length > memory.length) throw new Error('mocked memory write out of bounds');
    memory.set(value, p);
  }
  writeU128(pointer, value) {
    let n = BigInt(value); const bytes = Buffer.alloc(16);
    if (n < 0n) throw new Error('invalid mocked u128');
    for (let i = 0; i < 16; i++) { bytes[i] = Number(n & 255n); n >>= 8n; }
    if (n) throw new Error('invalid mocked u128');
    this.write(pointer, bytes);
  }
  register(id, value) { this.registers.set(String(id), Buffer.from(value)); }
  newPromise(receiver, parent = null) {
    const index = this.promises.length;
    this.promises.push({ receiver, parent, actions: [] });
    return BigInt(index);
  }
  recordCall(id, methodLength, methodPointer, argsLength, argsPointer, depositPointer, gas, weight) {
    const promise = this.promises[this.number(id)];
    if (!promise) throw new Error('unknown mocked promise');
    const depositBytes = this.read(depositPointer, 16);
    const deposit = depositBytes.readBigUInt64LE(0) + (depositBytes.readBigUInt64LE(8) << 64n);
    promise.actions.push({ method: this.read(methodPointer, methodLength).toString('utf8'),
      args: JSON.parse(this.read(argsPointer, argsLength).toString('utf8')),
      deposit: deposit.toString(), gas: gas.toString(), weight: weight.toString() });
  }
  call(method, args, context = {}) {
    this.input = Buffer.from(JSON.stringify(args));
    this.context = context; this.result = undefined; this.promises = []; this.logs = [];
    this.returnedPromise = undefined; this.registers.clear();
    // A real NEAR receipt starts with a fresh instance; in particular, a trap
    // must not leave a corrupted WASM stack pointer for the next mocked call.
    this.instance = new WebAssembly.Instance(this.module, { env: this.env });
    const before = new Map([...this.storage].map(([key, value]) => [key, Buffer.from(value)]));
    try {
      this.instance.exports[method]();
      const value = this.result === undefined ? undefined : JSON.parse(this.result.toString('utf8'));
      return { value, promises: structuredClone(this.promises), logs: [...this.logs], returnedPromise: this.returnedPromise };
    } catch (error) {
      this.storage = before; this.promises = []; this.logs = [];
      throw error;
    }
  }
}
