// SHA-256 values of the exact reviewed Git blobs, and the reproducible Intear
// browser build. Updating a wallet requires reviewing both source and digest.
export const WALLET_EXECUTOR_SHA256 = Object.freeze({
  'near-mobile': 'dbd00ebdef0fd8ea913ad994ff5cad35041667d46ff95ef75e403e41fa2b2051',
  'meteor-wallet': 'b55347ec700b9d55b71aa6450aac24548045cb4cf0005700dab08e5326c7cfab',
  'intear-wallet': 'c23f5233c79719d5b3d0770ef95797587b699af2cede17915cfe644ccbcb5801',
  'nightly-wallet': '6e769f105fb30d37501439287ec901b4d858a503ab195e2e99c06c172c5b5d48',
  'ledger': 'e3b4569f91aa57fe0c4217c4b0cc394a991f582ae7961fb60b0abed5ade51729',
  'near-cli': '522f2a52403f6da84384a409718c54b49ed4432cdfd583363d35109be8c8e318',
});

const MAX_EXECUTOR_BYTES = 4 * 1024 * 1024;

/** Fetch only the curated executor and verify its actual bytes before use.
 *  In particular, never execute NEAR Connect's shared IndexedDB cache.
 */
export async function loadVerifiedExecutor(manifest, { fetch, crypto, location }) {
  const expected = WALLET_EXECUTOR_SHA256[manifest?.id];
  if (!expected || !crypto?.subtle || typeof fetch !== 'function') throw new Error('Wallet integrity check unavailable');
  const url = new URL(manifest.executor, location.origin);
  const localIntear = manifest.id === 'intear-wallet' && url.origin === location.origin && url.pathname === '/intear-wallet.executor.js';
  if (!localIntear && (url.protocol !== 'https:' || url.hostname !== 'raw.githubusercontent.com')) {
    throw new Error('Unapproved wallet executor origin');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url.href, { credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error('Wallet executor unavailable');
    const declaredSize = Number(response.headers.get('content-length'));
    if (declaredSize > MAX_EXECUTOR_BYTES) throw new Error('Wallet executor is too large');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_EXECUTOR_BYTES) throw new Error('Wallet executor is too large or empty');
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const actual = Array.from(digest, value => value.toString(16).padStart(2, '0')).join('');
    if (actual !== expected) throw new Error('Wallet executor integrity check failed');
    const code = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    // NEAR Connect injects this code into a module script in srcdoc.
    if (/<\/script/i.test(code)) throw new Error('Unsafe wallet executor content');
    // Fastnear's Mobile SDK stores native fetch as a class method. Browsers
    // reject that call with "Illegal invocation" unless fetch retains Window
    // as its receiver. Bind it inside this wallet's sandbox, after verification.
    // Its generic button says "Sign transaction" even in our message-only flow;
    // relabel it without changing the signed payload or invoking wallet methods.
    if (manifest.id === 'near-mobile') return `window.fetch = window.fetch.bind(window);\n${code}\n;{const button = document.getElementById("approve-button"); if (button) button.textContent = "Open NEAR Mobile";}\n`;
    return code;
  } finally {
    clearTimeout(timeout);
  }
}
