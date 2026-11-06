// Stage only reviewed public website files. The Vercel API function lives in
// web/api and is separately detected by Vercel; it is never published as a
// static asset. Do not publish checkout files, journals, or credentials.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PUBLIC_WEB_FILES = Object.freeze([
  'index.html', 'styles.css', 'favicon.svg', 'hero-orbit.jpg',
  'manrope-latin.woff2', 'manrope-OFL.txt', 'evidence.mjs',
  'app.mjs', 'tour.mjs', 'google-signin.mjs', 'wallet.bundle.js',
  'intear-wallet.executor.js', 'intear-wallet-source.zip',
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
  const html = fs.readFileSync(path.join(rootPath, 'index.html'), 'utf8');
  const walletIds = [...html.matchAll(/data-wallet-id="([a-z-]+)"/g)].map(match => match[1]);
  const expected = ['near-mobile', 'meteor-wallet', 'intear-wallet', 'nightly-wallet', 'ledger', 'near-cli'];
  const pickerStart = html.indexOf('id="wallet-dialog"');
  const cli = html.indexOf('data-wallet-id="near-cli"', pickerStart);
  const google = html.indexOf('id="google-start"', pickerStart);
  if (!/<script type="module" src="\.\/google-signin\.mjs\?v=\d+"><\/script>/.test(html) ||
      !/<script type="module" src="\.\/wallet\.bundle\.js\?v=\d+"><\/script>/.test(html) ||
      !html.includes('data-wallet-open') || pickerStart < 0 || cli < pickerStart || google < cli ||
      walletIds.join(',') !== expected.join(',') || /walletconnect|wc-relay/i.test(html)) {
    throw new Error('Public website must contain the reviewed testnet wallet picker followed by Google sign-in');
  }
}

export function stagePublicWeb(destination, source = DEFAULT_SOURCE) {
  if (typeof destination !== 'string' || !destination.trim()) throw new Error('A new staging directory is required');
  validatePublicWeb(source);
  // Refuse an existing directory so unrelated leftovers cannot be deployed.
  fs.mkdirSync(destination);
  for (const file of PUBLIC_WEB_FILES) {
    fs.copyFileSync(path.join(source, file), path.join(destination, file), fs.constants.COPYFILE_EXCL);
  }
  return [...PUBLIC_WEB_FILES];
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  if (process.argv.length !== 3) throw new Error('Usage: node stage-public-web.mjs <new-output-directory>');
  const staged = stagePublicWeb(process.argv[2]);
  console.log(`Staged ${staged.length} reviewed public website files. Google sign-in requires separate server configuration.`);
}
