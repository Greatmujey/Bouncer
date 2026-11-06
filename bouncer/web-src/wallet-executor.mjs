// SHA-256 values of the exact reviewed Git blobs, and the reproducible Intear
// browser build. Updating a wallet requires reviewing both source and digest.
export const WALLET_EXECUTOR_SHA256 = Object.freeze({
  'near-mobile': 'dbd00ebdef0fd8ea913ad994ff5cad35041667d46ff95ef75e403e41fa2b2051',
  'meteor-wallet': 'b55347ec700b9d55b71aa6450aac24548045cb4cf0005700dab08e5326c7cfab',
  'intear-wallet': 'c23f5233c79719d5b3d0770ef95797587b699af2cede17915cfe644ccbcb5801',
  'nightly-wallet': '6e769f105fb30d37501439287ec901b4d858a503ab195e2e99c06c172c5b5d48',
  'ledger': 'e3b4569f91aa57fe0c4217c4b0cc394a991f582ae7961fb60b0abed5ade51729',
  'near-cli': '522f2a52403f6da84384a409718c54b49ed4432cdfd583363d35109be8c8e318',
  'ethereum-wallets': '8149d556df4544682d89dc62cd74b3843bd28d536d86928a029f4ce1f186056c',
});

const MAX_EXECUTOR_BYTES = 4 * 1024 * 1024;

// Visual/instruction-only patch, appended *after* verifying the exact Mobile
// executor. Its signed payload, backend, validation and wallet methods remain
// upstream's. A standard dark-on-white QR is easier for phone cameras to scan.
const MOBILE_PRESENTATION = String.raw`
;(() => {
  const style = document.createElement('style');
  style.textContent = ` + JSON.stringify(`
    .near-mobile-card{justify-content:flex-start;overflow:auto;background:radial-gradient(circle at 50% 0,#315b3f,#10251b 68%);padding:20px 20px 16px}
    .near-mobile-card header{display:none}
    .near-mobile-logo-section{flex:0 0 auto;padding:0 40px 15px}
    .near-mobile-logo{max-width:8rem;height:2rem}
    .near-mobile-layout{height:auto;min-height:0;flex:1;gap:15px;padding:18px 0 0}
    .near-mobile-qr-section{gap:12px}
    .near-mobile-qr-section>p:first-child{font-size:21px!important;line-height:1.25;letter-spacing:-.4px}
    .bouncer-mobile-hint{max-width:300px;text-align:center;color:#c9dfce;font-size:12px;font-weight:500;line-height:1.5}
    .near-mobile-qr-wrap{background:#fff;border-radius:12px;box-shadow:0 10px 25px #06160b60}
    .near-mobile-qr{padding:10px;line-height:0}
    .near-mobile-qr svg{display:block;width:min(180px,48vw);height:auto}
    .near-mobile-qr svg path{fill:#10231a!important}
    .near-mobile-responsive-layout{gap:6px}
    .near-mobile-button{min-height:46px;height:auto;padding:12px 16px;background:#c4ef92;color:#17321e!important;font-size:14px}
    .near-mobile-footer{gap:10px;margin-top:auto}
    .near-mobile-links{gap:8px}.near-mobile-links a{background:#233e2b;max-height:none;border:1px solid #55725a}
    .near-mobile-link{gap:6px;padding:9px 6px;font-size:11px}.near-mobile-link img{width:18px;height:18px}
    .near-mobile-subtitle,.near-mobile-subtitle a{font-size:11px;color:#b6ceb9!important}
    @media(max-height:550px){.near-mobile-card{padding-top:12px}.near-mobile-layout{padding-top:10px;gap:10px}.near-mobile-qr-section{gap:8px}.near-mobile-qr svg{width:min(150px,40vw)}.near-mobile-footer{gap:6px}}
  `) + String.raw`;
  document.head.appendChild(style);
  const heading = document.querySelector('.near-mobile-qr-section>p');
  if (heading) {
    heading.textContent = 'Connect NEAR Mobile';
    const hint = document.createElement('p');
    hint.className = 'bouncer-mobile-hint';
    hint.textContent = 'Use a testnet account. Approve the login message, then return to this tab. No payment or key is requested.';
    heading.insertAdjacentElement('afterend', hint);
  }
  const logo = document.querySelector('.near-mobile-logo');
  if (logo) logo.alt = 'NEAR Mobile';
  const button = document.getElementById('approve-button');
  if (button) button.textContent = 'Open NEAR Mobile';
})();
`;

/** Fetch only the curated executor and verify its actual bytes before use.
 *  In particular, never execute NEAR Connect's shared IndexedDB cache.
 */
export async function loadVerifiedExecutor(manifest, { fetch, crypto, location }) {
  const expected = WALLET_EXECUTOR_SHA256[manifest?.id];
  if (!expected || !crypto?.subtle || typeof fetch !== 'function') throw new Error('Wallet integrity check unavailable');
  const url = new URL(manifest.executor, location.origin);
  const localExecutor = url.origin === location.origin && (
    (manifest.id === 'intear-wallet' && url.pathname === '/intear-wallet.executor.js') ||
    (manifest.id === 'ethereum-wallets' && url.pathname === '/ethereum-wallet.executor.js')
  );
  if (!localExecutor && (url.protocol !== 'https:' || url.hostname !== 'raw.githubusercontent.com')) {
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
    // Its generic UI is adapted for this message-only flow without changing
    // the signed payload or invoking additional wallet methods.
    if (manifest.id === 'near-mobile') return `window.fetch = window.fetch.bind(window);\n${code}\n${MOBILE_PRESENTATION}\n`;
    if (manifest.id === 'near-cli') {
      // The pinned CLI adapter offers only an OS keychain or Ledger. Many
      // headless/Codespaces users have the standard ~/.near-credentials file
      // instead. Add that *local signing method* to the already verified UI;
      // the challenge and signature verification remain unchanged. Fail
      // closed if upstream bytes ever change, rather than patching unknown code.
      const replaceOnce = (source, from, to) => {
        if (source.indexOf(from) === -1 || source.indexOf(from) !== source.lastIndexOf(from)) throw new Error('CLI adapter patch unavailable');
        return source.replace(from, to);
      };
      let patched = replaceOnce(code,
        'function Et(i,o){return i==="sign-with-ledger"?`sign-with-ledger --seed-phrase-hd-path \'${k(o||Dt)}\'`:"sign-with-keychain"}',
        'function Et(i,o){return i==="sign-with-ledger"?`sign-with-ledger --seed-phrase-hd-path \'${k(o||Dt)}\'`:i==="sign-with-legacy-keychain"?"sign-with-legacy-keychain":"sign-with-keychain"}');
      patched = replaceOnce(patched,
        '<button type="button" class="signing-method-card" data-method="sign-with-ledger" aria-pressed="false">',
        '<button type="button" class="signing-method-card" data-method="sign-with-legacy-keychain" aria-pressed="false"><div class="signing-method-card-icon">⌁</div><div class="signing-method-card-title">Credentials file</div><div class="signing-method-card-desc">Use your local ~/.near-credentials file</div></button>\n        <button type="button" class="signing-method-card" data-method="sign-with-ledger" aria-pressed="false">');
      patched = replaceOnce(patched, '.signing-method-options {\n  display: flex;', '.signing-method-options {\n  display: flex;\n  flex-wrap: wrap;');
      patched = replaceOnce(patched, '.signing-method-card {\n  flex: 1;', '.signing-method-card {\n  flex: 1 0 42%;');
      return patched;
    }
    return code;
  } finally {
    clearTimeout(timeout);
  }
}
