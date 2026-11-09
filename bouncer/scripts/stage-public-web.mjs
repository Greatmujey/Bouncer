// Stage only reviewed public website files. Vercel separately detects the
// server-side functions in web/api; they are never published as static files.
// Do not publish checkout files, journals, or credentials.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PUBLIC_WEB_FILES = Object.freeze([
  'index.html', 'styles.css', 'favicon.svg', 'hero-orbit.jpg',
  'manrope-latin.woff2', 'manrope-OFL.txt', 'evidence.mjs',
  'app.mjs', 'tour.mjs', 'google-signin.mjs', 'wallet.bundle.js', 'v14-bootstrap-artifact-v1.json',
  'intear-wallet.executor.js', 'intear-wallet-source.zip',
  'ethereum-wallet.executor.js', 'ethereum-wallet-NOTICE.txt',
  'walletconnect.bundle.js', 'walletconnect-config.json', 'walletconnect-NOTICES.txt',
]);
const DEFAULT_SOURCE = fileURLToPath(new URL('../web/', import.meta.url));

export function validatePublicWeb(source = DEFAULT_SOURCE) {
  const rootPath = path.resolve(source);
  const root = fs.lstatSync(rootPath);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('Public website source must be a real directory');
  for (const file of PUBLIC_WEB_FILES) {
    const stat = fs.lstatSync(path.join(rootPath, file));
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Refusing unexpected website file ${file}`);
  }
  // The source template is always empty; only a validated public client ID
  // from the deployment environment may be written to the staged copy.
  if (fs.readFileSync(path.join(rootPath, 'walletconnect-config.json'), 'utf8') !== '{"projectId":""}\n') {
    throw new Error('Committed WalletConnect configuration must not contain a project ID');
  }
  const html = fs.readFileSync(path.join(rootPath, 'index.html'), 'utf8');
  const metas = (html.match(/<meta\b[^>]*>/gi) || [])
    .filter(tag => /\bname\s*=\s*["']bouncer-wallet-origin["']/i.test(tag));
  if (metas.length !== 1 || metas[0] !== '<meta name="bouncer-wallet-origin" content="https://bouncer-near.vercel.app">') {
    throw new Error('Public website must approve exactly the dedicated Bouncer wallet origin');
  }
  const cspMetas = (html.match(/<meta\b[^>]*>/gi) || [])
    .filter(tag => /\bname\s*=\s*["']bouncer-csp-nonce["']/i.test(tag));
  if (cspMetas.length !== 1 || cspMetas[0] !== '<meta name="bouncer-csp-nonce" content="Qm91bmNlclRlc3RuZXQyMDI2">') {
    throw new Error('Public website must include the reviewed CSP execution marker');
  }
  const walletIds = [...html.matchAll(/data-wallet-id="([a-z-]+)"/g)].map(match => match[1]);
  const expected = ['near-mobile', 'meteor-wallet', 'intear-wallet', 'nightly-wallet', 'ledger', 'ethereum-wallets', 'near-cli', 'wallet-connect'];
  const pickerStart = html.indexOf('id="wallet-dialog"');
  const walletConnect = html.indexOf('data-wallet-id="wallet-connect"', pickerStart);
  const google = html.indexOf('id="google-start"', pickerStart);
  if (!/<script type="module" src="\.\/google-signin\.mjs\?v=\d+"><\/script>/.test(html) ||
      !/<script type="module" src="\.\/wallet\.bundle\.js\?v=\d+"><\/script>/.test(html) ||
      !html.includes('data-wallet-open') || pickerStart < 0 || walletConnect < pickerStart || google < walletConnect ||
      !html.includes('id="walletconnect-pairing"') || walletIds.join(',') !== expected.join(',')) {
    throw new Error('Public website must contain the reviewed testnet wallets and WalletConnect followed by Google sign-in');
  }
}

const SOURCE_WALLET_ORIGIN = 'https://bouncer-near.vercel.app';
function dedicatedOrigin(value) {
  let url; try { url = new URL(value); } catch { throw new Error('A dedicated HTTPS wallet origin is required'); }
  const host = url.hostname;
  if (url.origin !== value || url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash || url.username || url.password ||
      !/^[a-z0-9.-]+$/.test(host) || !host.includes('.') || /^\d+(?:\.\d+){3}$/.test(host) ||
      ['localhost','github.io','madethis.website'].some(shared => host === shared || host.endsWith(`.${shared}`))) {
    throw new Error('A dedicated HTTPS wallet origin is required');
  }
  return url.origin;
}
export function stagePublicWeb(destination, source = DEFAULT_SOURCE, { walletConnectProjectId = process.env.BOUNCER_WALLETCONNECT_PROJECT_ID || '',
  walletOrigin = process.env.BOUNCER_WALLET_ORIGIN || (process.env.NETLIFY === 'true' ? (process.env.URL || '') : SOURCE_WALLET_ORIGIN) } = {}) {
  if (typeof destination !== 'string' || !destination.trim()) throw new Error('A new staging directory is required');
  const origin = dedicatedOrigin(walletOrigin);
  if (typeof walletConnectProjectId !== 'string' || (walletConnectProjectId !== '' && !/^[a-f0-9]{32}$/i.test(walletConnectProjectId))) {
    throw new Error('Invalid WalletConnect project ID');
  }
  validatePublicWeb(source);
  // Refuse an existing directory so unrelated leftovers cannot be deployed.
  fs.mkdirSync(destination);
  for (const file of PUBLIC_WEB_FILES) {
    fs.copyFileSync(path.join(source, file), path.join(destination, file), fs.constants.COPYFILE_EXCL);
  }
  if (walletConnectProjectId) {
    fs.writeFileSync(path.join(destination, 'walletconnect-config.json'), `${JSON.stringify({ projectId: walletConnectProjectId })}\n`);
  }
  if (origin !== SOURCE_WALLET_ORIGIN) {
    const index = path.join(destination, 'index.html'), html = fs.readFileSync(index, 'utf8');
    fs.writeFileSync(index, html.replace(`content="${SOURCE_WALLET_ORIGIN}"`, `content="${origin}"`));
  }
  return [...PUBLIC_WEB_FILES];
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  if (process.argv.length !== 3) throw new Error('Usage: node stage-public-web.mjs <new-output-directory>');
  const staged = stagePublicWeb(process.argv[2]);
  console.log(`Staged ${staged.length} reviewed public website files. Google sign-in requires separate server configuration.`);
}
