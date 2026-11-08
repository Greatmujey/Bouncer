//! RESEARCH ONLY. The wallet/review UI path is default-off and not publicly deployed.
//!
//! A freshly created, keyless testnet account initializes its owner in the
//! same receipt as deploying this small loader. The owner can then provide a
//! bounded raw-DEFLATE stream and one yocto. The loader accepts ONLY the exact
//! pinned V9 byte length and SHA-256 (or the separately compiled CI-only V14
//! research pin), and schedules a self-deploy plus `new` in one promise. A
//! separate owner-only refund method exists if the loader remains
//! installed. An unknown original, failed promise, uninitialized loader, absent
//! state or unverified phone/receipt must NEVER authorize an automatic retry.
//!
//! This experiment has not been audited and retains tiny loader-specific keys
//! in storage after the upgrade. It is deliberately not a replacement for the
//! independently anchored witness, wallet review, recovery or real-phone tests.

use miniz_oxide::inflate::decompress_to_vec_with_limit;

const OWNER_KEY: &[u8] = b"__bouncer_phone_loader_owner_v1";
const PENDING_KEY: &[u8] = b"__bouncer_phone_loader_pending_v1";
#[cfg(not(feature = "v14-research"))]
const CODE_LEN: usize = 452_675;
const MAX_COMPRESSED: usize = 200_000;
#[cfg(feature = "v14-research")]
include!(env!("BOUNCER_V14_LOADER_PIN_RS"));
#[cfg(not(feature = "v14-research"))]
const CODE_SHA256: [u8; 32] = [
    0x83, 0x5f, 0x0b, 0xaa, 0x51, 0xd0, 0x8d, 0xdf, 0x3a, 0xf6, 0x81, 0x2d, 0xf0, 0xca, 0xef, 0xb9,
    0x32, 0x83, 0x48, 0x07, 0x35, 0xa6, 0x3e, 0x3d, 0x38, 0x20, 0x73, 0xe0, 0x4f, 0xba, 0xf8, 0xee,
];
const TGAS: u64 = 1_000_000_000_000;

#[link(wasm_import_module = "env")]
extern "C" {
    fn read_register(register_id: u64, ptr: u64);
    fn register_len(register_id: u64) -> u64;
    fn predecessor_account_id(register_id: u64);
    fn current_account_id(register_id: u64);
    fn input(register_id: u64);
    fn attached_deposit(balance_ptr: u64);
    fn sha256(value_len: u64, value_ptr: u64, register_id: u64);
    fn panic_utf8(len: u64, ptr: u64) -> !;
    fn storage_has_key(key_len: u64, key_ptr: u64) -> u64;
    fn storage_read(key_len: u64, key_ptr: u64, register_id: u64) -> u64;
    fn storage_write(key_len: u64, key_ptr: u64, value_len: u64, value_ptr: u64, register_id: u64) -> u64;
    fn promise_batch_create(account_len: u64, account_ptr: u64) -> u64;
    fn promise_batch_action_deploy_contract(promise_index: u64, code_len: u64, code_ptr: u64);
    fn promise_batch_action_function_call(promise_index: u64, method_len: u64, method_ptr: u64,
        args_len: u64, args_ptr: u64, amount_ptr: u64, gas: u64);
    fn promise_batch_action_delete_account(promise_index: u64, beneficiary_len: u64, beneficiary_ptr: u64);
    fn promise_return(promise_id: u64);
}

fn ptr(bytes: &[u8]) -> u64 { bytes.as_ptr() as u64 }
fn stop() -> ! {
    let message = b"phone loader rejected input or authority";
    unsafe { panic_utf8(message.len() as u64, ptr(message)) }
}
fn read_register_bounded(id: u64, max: usize) -> Vec<u8> {
    let len = unsafe { register_len(id) };
    if len > max as u64 { stop(); }
    let mut result = vec![0u8; len as usize];
    unsafe { read_register(id, result.as_mut_ptr() as u64) };
    result
}
fn predecessor() -> Vec<u8> {
    unsafe { predecessor_account_id(0) };
    let account = read_register_bounded(0, 64);
    if account.len() < 2 || !account.iter().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"-_.".contains(b)) { stop(); }
    account
}
fn one_yocto() {
    let mut amount = [0u8; 16];
    unsafe { attached_deposit(amount.as_mut_ptr() as u64) };
    if amount[0] != 1 || amount[1..].iter().any(|b| *b != 0) { stop(); }
}
fn stored_owner() -> Vec<u8> {
    if unsafe { storage_read(OWNER_KEY.len() as u64, ptr(OWNER_KEY), 1) } != 1 { stop(); }
    let owner = read_register_bounded(1, 64);
    if owner != predecessor() { stop(); }
    one_yocto();
    owner
}
fn current() -> Vec<u8> {
    unsafe { current_account_id(2) };
    read_register_bounded(2, 64)
}

/// Must be in the same owner-signed action receipt as CreateAccount + deploy.
#[no_mangle]
pub extern "C" fn loader_init() {
    one_yocto();
    let owner = predecessor();
    if owner == current() || unsafe { storage_has_key(OWNER_KEY.len() as u64, ptr(OWNER_KEY)) } != 0 { stop(); }
    if unsafe { storage_write(OWNER_KEY.len() as u64, ptr(OWNER_KEY), owner.len() as u64, ptr(&owner), 3) } != 0 { stop(); }
}

/// Raw function-call bytes are compressed WASM, not JSON or a URL.
#[no_mangle]
pub extern "C" fn loader_deploy() {
    let owner = stored_owner();
    if unsafe { storage_has_key(PENDING_KEY.len() as u64, ptr(PENDING_KEY)) } != 0 { stop(); }
    unsafe { input(4) };
    let compressed = read_register_bounded(4, MAX_COMPRESSED);
    if compressed.is_empty() { stop(); }
    let code = match decompress_to_vec_with_limit(&compressed, CODE_LEN) { Ok(code) => code, Err(_) => stop() };
    if code.len() != CODE_LEN { stop(); }
    unsafe { sha256(code.len() as u64, ptr(&code), 5) };
    if read_register_bounded(5, 32) != CODE_SHA256 { stop(); }
    if unsafe { storage_write(PENDING_KEY.len() as u64, ptr(PENDING_KEY), 1, ptr(b"1"), 6) } != 0 { stop(); }
    let mut args = b"{\"owner\":\"".to_vec();
    args.extend_from_slice(&owner);
    args.extend_from_slice(b"\"}");
    let target = current();
    let amount = [0u8; 16];
    unsafe {
        let promise = promise_batch_create(target.len() as u64, ptr(&target));
        promise_batch_action_deploy_contract(promise, code.len() as u64, ptr(&code));
        promise_batch_action_function_call(promise, 3, ptr(b"new"), args.len() as u64, ptr(&args), ptr(&amount), 30 * TGAS);
        promise_return(promise);
    }
}

/// Explicit owner recovery only. Never call automatically after uncertainty.
#[no_mangle]
pub extern "C" fn loader_refund() {
    let owner = stored_owner();
    let target = current();
    unsafe {
        let promise = promise_batch_create(target.len() as u64, ptr(&target));
        promise_batch_action_delete_account(promise, owner.len() as u64, ptr(&owner));
        promise_return(promise);
    }
}
