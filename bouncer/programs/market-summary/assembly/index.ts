// Bounded WASI program for the Bouncer testnet mission. Input is the exact
// canonical JSON constructed by Bouncer after verifying the preceding oracle
// transaction. Output is an integer number of USD micro-units. The oracle
// result is rounded to micro-USD by the caller, not by this program.
//
// This module does not fetch a price, access a wallet, or sign a transaction.
@external('wasi_snapshot_preview1', 'fd_read')
declare function fd_read(fd: i32, iovs: usize, count: i32, read: usize): i32;
@external('wasi_snapshot_preview1', 'fd_write')
declare function fd_write(fd: i32, iovs: usize, count: i32, written: usize): i32;
@external('wasi_snapshot_preview1', 'proc_exit')
declare function proc_exit(code: i32): void;

// These fixed buffers are separate from AssemblyScript's small static data.
const INPUT: usize = 32768;
const IOV: usize = 34000;
const COUNT: usize = 34008;
const OUTPUT: usize = 34100;
const MAX_INPUT: i32 = 512;

function fail(): void { proc_exit(1); unreachable(); }

function readInput(): i32 {
  let length: i32 = 0;
  while (true) {
    store<u32>(IOV, <u32>(INPUT + length));
    store<u32>(IOV + 4, <u32>(MAX_INPUT + 1 - length));
    if (fd_read(0, IOV, 1, COUNT) != 0) fail();
    const received = <i32>load<u32>(COUNT);
    if (received == 0) break;
    length += received;
    if (length > MAX_INPUT) fail();
  }
  return length;
}

function matchLiteral(position: i32, length: i32, literal: string): i32 {
  if (position + literal.length > length) fail();
  for (let i: i32 = 0; i < literal.length; i++) {
    if (load<u8>(INPUT + position + i) != literal.charCodeAt(i)) fail();
  }
  return position + literal.length;
}

// Parse canonical nonzero integers with a hard upper bound. No float rounding,
// overflow, alternate JSON forms, whitespace, leading zeros or signs.
function readNumber(position: i32, length: i32, max: u64): u64 {
  let n: u64 = 0;
  let digits: i32 = 0;
  while (position + digits < length) {
    const c = load<u8>(INPUT + position + digits);
    if (c < 48 || c > 57) break;
    if (digits == 0 && c == 48) fail();
    const digit: u64 = c - 48;
    if (n > (max - digit) / 10) fail();
    n = n * 10 + digit;
    digits++;
  }
  if (digits == 0 || n == 0) fail();
  // Return the digit count in a separate static scratch slot.
  store<i32>(COUNT + 4, digits);
  return n;
}

function isBase58(c: u8): bool {
  return (c >= 49 && c <= 57) || (c >= 65 && c <= 72) || (c >= 74 && c <= 78) ||
    (c >= 80 && c <= 90) || (c >= 97 && c <= 107) || (c >= 109 && c <= 122);
}

function writeOutput(value: u64): void {
  const prefix = '{"value_usd_micros":';
  let offset: usize = 0;
  for (let i: i32 = 0; i < prefix.length; i++) store<u8>(OUTPUT + offset++, <u8>prefix.charCodeAt(i));
  // Write decimal digits backwards to a distinct scratch region, then copy.
  let digits: i32 = 0;
  do {
    store<u8>(OUTPUT + 128 + digits, <u8>(48 + value % 10));
    value /= 10;
    digits++;
  } while (value > 0);
  for (let i = digits - 1; i >= 0; i--) store<u8>(OUTPUT + offset++, load<u8>(OUTPUT + 128 + i));
  store<u8>(OUTPUT + offset++, 125); // }
  store<u32>(IOV, <u32>OUTPUT);
  store<u32>(IOV + 4, <u32>offset);
  if (fd_write(1, IOV, 1, COUNT) != 0 || load<u32>(COUNT) != <u32>offset) fail();
}

export function _start(): void {
  const length = readInput();
  let position = matchLiteral(0, length, '{"price_usd_micros":');
  const price = readNumber(position, length, 1_000_000_000_000);
  position += load<i32>(COUNT + 4);
  position = matchLiteral(position, length, ',"quantity":');
  const quantity = readNumber(position, length, 1000);
  position += load<i32>(COUNT + 4);
  position = matchLiteral(position, length, ',"oracle_tx_hash":"');
  const start = position;
  while (position < length && isBase58(load<u8>(INPUT + position))) position++;
  if (position - start < 32 || position - start > 60) fail();
  position = matchLiteral(position, length, '"}');
  if (position != length) fail();
  // Maximum 10^15; this is within u64 and JS's exact integer range.
  writeOutput(price * quantity);
}
