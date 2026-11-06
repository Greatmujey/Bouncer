// Google Identity Services is an identity session, not a NEAR wallet. It does
// not sign transactions, create a vault or grant spending authority. The server
// verifies Google's signature, audience, issuer, expiry and one-time nonce.
const status = document.querySelector('#account-status');
const button = document.querySelector('#google-signin-button');
const start = document.querySelector('#google-start');
const signout = document.querySelector('#google-signout');
const retry = document.querySelector('#google-retry');
const openSite = document.querySelector('#account-open-site');
const dialog = document.querySelector('#wallet-dialog');
const endpoint = new URL('./api/google-session', location.href);
let authenticated = false;
let ready = false;
let busy = false;
let scriptPromise;

function showSignedOut(message) {
  authenticated = false;
  signout.hidden = true;
  start.hidden = false;
  button.hidden = true;
  if (message) status.textContent = message;
}
function showSignedIn(user) {
  authenticated = true;
  ready = false;
  start.hidden = true;
  button.hidden = true;
  button.replaceChildren();
  retry.hidden = true;
  openSite.hidden = true;
  signout.hidden = false;
  const display = user?.name || user?.email || 'Google account';
  status.textContent = `Signed in as ${display}. Google sign-in does not authorize a NEAR wallet or spending.`;
}
async function request(options = {}, query = '') {
  const url = new URL(endpoint);
  url.search = query;
  const response = await fetch(url, {
    ...options, credentials: 'same-origin', cache: 'no-store', redirect: 'error',
    headers: { 'X-Bouncer-Auth': '1', ...(options.headers || {}) },
    signal: AbortSignal.timeout(12000),
  });
  let data;
  try { data = await response.json(); } catch { data = {}; }
  if (!response.ok) {
    const error = new Error('Account service unavailable');
    error.status = response.status;
    throw error;
  }
  return data;
}
function loadGoogle() {
  if (window.google?.accounts?.id) return Promise.resolve(window.google.accounts.id);
  if (!scriptPromise) {
    scriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      const timer = setTimeout(() => { script.remove(); reject(new Error('Google could not load')); }, 12000);
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.onload = () => {
        clearTimeout(timer);
        window.google?.accounts?.id ? resolve(window.google.accounts.id) : reject(new Error('Google could not load'));
      };
      script.onerror = () => { clearTimeout(timer); script.remove(); reject(new Error('Google could not load')); };
      document.head.append(script);
    }).catch(error => { scriptPromise = null; throw error; });
  }
  return scriptPromise;
}
async function onCredential(response) {
  if (busy || typeof response?.credential !== 'string') return;
  busy = true;
  ready = false;
  button.hidden = true;
  button.replaceChildren();
  status.textContent = 'Verifying your Google account…';
  try {
    const result = await request({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credential: response.credential }) });
    if (!result.authenticated) throw new Error('Identity verification failed');
    // Confirm the HttpOnly cookie was accepted; never show a fabricated session.
    const session = await request();
    if (!session.authenticated || session.user?.sub !== result.user?.sub) throw new Error('Session could not be saved');
    showSignedIn(session.user);
  } catch {
    showSignedOut('Could not verify or save your Google sign-in. Please try again.');
    retry.hidden = false;
  } finally { busy = false; }
}
async function prepareButton() {
  if (authenticated || ready || busy) return;
  busy = true;
  start.disabled = true;
  retry.hidden = true;
  button.hidden = true;
  button.replaceChildren();
  status.textContent = 'Preparing Google sign-in…';
  try {
    const config = await request({}, '?challenge=1');
    if (typeof config.clientId !== 'string' || typeof config.nonce !== 'string') throw new Error('Invalid account configuration');
    const google = await loadGoogle();
    google.initialize({ client_id: config.clientId, nonce: config.nonce, callback: onCredential, auto_select: false, ux_mode: 'popup' });
    google.renderButton(button, { type: 'standard', theme: 'outline', size: 'large', text: 'signin_with', shape: 'rectangular', width: Math.max(200, Math.min(320, button.parentElement.clientWidth || 280)) });
    ready = true;
    start.hidden = true;
    button.hidden = false;
    openSite.hidden = true;
    status.textContent = 'Google identifies your account; NEAR wallet connection and spending authority are separate.';
  } catch (error) {
    showSignedOut(error.status === 503 ? 'Google sign-in is not configured yet.' :
      error.status === 403 ? 'Google sign-in is supported only on Bouncer’s dedicated site; setup may still be required.' :
        'Google sign-in is currently unavailable. Please try again.');
    openSite.hidden = location.origin === 'https://bouncer-near.vercel.app';
    retry.hidden = error.status === 503 || error.status === 403;
  } finally { busy = false; start.disabled = false; }
}

// Restore only a server-validated session. Wait for this read before preparing
// a login challenge so that a slow session restore cannot race the picker.
const sessionReady = (async () => {
  try {
    const session = await request();
    if (session.authenticated && typeof session.user?.sub === 'string') showSignedIn(session.user);
    else showSignedOut('Google identifies your account; NEAR wallet connection is separate.');
  } catch (error) {
    showSignedOut(error.status === 503 ? 'Google sign-in is not configured yet.' :
      error.status === 403 ? 'Google sign-in is supported only on Bouncer’s dedicated site; setup may still be required.' :
        'Google sign-in is currently unavailable.');
    openSite.hidden = location.origin === 'https://bouncer-near.vercel.app';
  }
})();
function openGoogle() {
  void sessionReady.then(() => {
    // Each picker opening gets a fresh nonce rather than reusing a button that
    // may have expired while the dialog was closed.
    if (!authenticated) { ready = false; void prepareButton(); }
  });
}
window.addEventListener('bouncer:account-picker-open', openGoogle);
start.addEventListener('click', openGoogle);
retry.addEventListener('click', openGoogle);
signout.addEventListener('click', async () => {
  if (busy) return;
  busy = true;
  signout.disabled = true;
  try {
    await request({ method: 'DELETE' });
    window.google?.accounts?.id?.disableAutoSelect();
    ready = false;
    showSignedOut('Signed out of Google.');
  } catch { status.textContent = 'Could not sign out of Google. Please try again.'; }
  finally { busy = false; signout.disabled = false; }
  if (!authenticated && dialog.open) void prepareButton();
});
