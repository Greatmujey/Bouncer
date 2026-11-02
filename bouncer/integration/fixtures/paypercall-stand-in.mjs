/**
 * TEST FIXTURE ONLY. This is not PayPerCall's code or an escrow implementation.
 * It returns 40 unused mock tokens when called through the mock FT, then can
 * send a fixed 60-token plain return to the one local forwarder account. It has
 * no service registry, storage credit, operator, pricing, delivery or claims.
 * The caller must enforce a disposable loopback-only sandbox independently.
 */
import wabtFactory from 'wabt';
import { CIRCLE_TESTNET_USDC as TOKEN } from '../../scripts/circle-testnet-setup.mjs';

export const FIXTURE_FORWARDER = 'bridge.forward-buyer.testnet';
const esc = value => [...Buffer.from(value)].map(b => `\\${b.toString(16).padStart(2, '0')}`).join('');
export async function buildSandboxEscrowStandIn() {
  const method = 'ft_transfer';
  const args = JSON.stringify({ receiver_id: FIXTURE_FORWARDER, amount: '60', memo: 'isolated fixture refund' });
  const wat = `(module
    (import "env" "value_return" (func $value (param i64 i64)))
    (import "env" "promise_batch_create" (func $create (param i64 i64) (result i64)))
    (import "env" "promise_batch_action_function_call" (func $call (param i64 i64 i64 i64 i64 i64 i64)))
    (import "env" "promise_return" (func $return (param i64)))
    (memory (export "memory") 1)
    (data (i32.const 128) "${esc('"40"')}")
    (data (i32.const 256) "${esc(TOKEN)}")
    (data (i32.const 400) "${esc(method)}")
    (data (i32.const 512) "${esc(args)}")
    (func (export "ft_on_transfer") (call $value (i64.const 4) (i64.const 128)))
    (func (export "fixture_refund_later") (local $p i64)
      (local.set $p (call $create (i64.const ${Buffer.byteLength(TOKEN)}) (i64.const 256)))
      (i64.store (i32.const 1024) (i64.const 1))
      (i64.store offset=8 (i32.const 1024) (i64.const 0))
      (call $call (local.get $p) (i64.const ${Buffer.byteLength(method)}) (i64.const 400)
        (i64.const ${Buffer.byteLength(args)}) (i64.const 512) (i64.const 1024) (i64.const 50000000000000))
      (call $return (local.get $p))))`;
  const wabt = await wabtFactory(), module = wabt.parseWat('sandbox-stand-in.wat', wat);
  try { module.validate(); return Buffer.from(module.toBinary({ log: false, write_debug_names: false }).buffer); }
  finally { module.destroy(); }
}
