// Stage only the reviewed public website assets. Never publish a checkout,
// journals, credentials or unrelated generated files.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PUBLIC_WEB_FILES = Object.freeze([
  'index.html', 'styles.css', 'favicon.svg', 'hero-orbit.jpg',
  'manrope-latin.woff2', 'manrope-OFL.txt', 'evidence.mjs',
  'app.mjs', 'tour.mjs', 'wallet.bundle.js',
  'intear-wallet.executor.js', 'intear-wallet-source.zip',
  'walletconnect.bundle.js', 'walletconnect-config.json', 'walletconnect-NOTICES.txt',
]);
const DEFAULT_SOURCE = fileURLToPath(new URL('../web/', import.meta.url));

export function validatePublicWeb(source = DEFAULT_SOURCE) {
  // Normalize away a trailing slash so lstat cannot silently follow a directory symlink.
  const rootPath = path.resolve(source);
  const root = fs.lstatSync(rootPath);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('Public website source must be a real directory');
  for (const file of PUBLIC_WEB_FILES) {
    const stat = fs.lstatSync(path.join(rootPath, file));
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Refusing unexpected website file ${file}`);
  }

  // The project ID belongs in a deployment environment variable, not Git.
  // This file is generated during staging after strict validation.
  if (fs.readFileSync(path.join(rootPath, 'walletconnect-config.json'), 'utf8') !== '{"projectId":""}\n') {
    throw new Error('Committed WalletConnect configuration must not contain a project ID');
  }

  // Approve only the user's dedicated Vercel origin. Guest/path-shared hosts
  // and iframes are still rejected by walletOriginAllowed at runtime.
  const html = fs.readFileSync(path.join(rootPath, 'index.html'), 'utf8');
  const metas = (html.match(/<meta\b[^>]*>/gi) || [])
    .filter(tag => /\bname\s*=\s*["']bouncer-wallet-origin["']/i.test(tag));
  if (metas.length !== 1 || metas[0] !== '<meta name="bouncer-wallet-origin" content="https://bouncer-near.vercel.app">') {
    throw new Error('Public website must approve exactly the dedicated Bouncer wallet origin');
  }
}

export function stagePublicWeb(destination, source = DEFAULT_SOURCE, { walletConnectProjectId = process.env.BOUNCER_WALLETCONNECT_PROJECT_ID || '' } = {}) {
  if (typeof destination !== 'string' || !destination.trim()) throw new Error('A new staging directory is required');
  if (typeof walletConnectProjectId !== 'string' || (walletConnectProjectId !== '' && !/^[a-f0-9]{32}$/i.test(walletConnectProjectId))) {
    throw new Error('Invalid WalletConnect project ID');
  }
  validatePublicWeb(source);
  // Refuse an existing destination, even an empty one. That prevents leftover
  // or unrelated files from being included in a later public deployment.
  fs.mkdirSync(destination);
  for (const file of PUBLIC_WEB_FILES) {
    fs.copyFileSync(path.join(source, file), path.join(destination, file), fs.constants.COPYFILE_EXCL);
  }
  if (walletConnectProjectId) {
    // This value is a public client identifier, not a wallet secret. The
    // source template remains empty and private checkout files stay excluded.
    fs.writeFileSync(path.join(destination, 'walletconnect-config.json'), `${JSON.stringify({ projectId: walletConnectProjectId })}\n`);
  }
  return [...PUBLIC_WEB_FILES];
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  if (process.argv.length !== 3) throw new Error('Usage: node stage-public-web.mjs <new-output-directory>');
  const staged = stagePublicWeb(process.argv[2]);
  console.log(`Staged ${staged.length} reviewed public website files; wallet sign-in is limited to the dedicated origin or approved development hosts.`);
}
