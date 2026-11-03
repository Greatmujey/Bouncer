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

  // Approve only the user's dedicated Vercel origin. Guest/path-shared hosts
  // and iframes are still rejected by walletOriginAllowed at runtime.
  const html = fs.readFileSync(path.join(rootPath, 'index.html'), 'utf8');
  const metas = (html.match(/<meta\b[^>]*>/gi) || [])
    .filter(tag => /\bname\s*=\s*["']bouncer-wallet-origin["']/i.test(tag));
  if (metas.length !== 1 || metas[0] !== '<meta name="bouncer-wallet-origin" content="https://bouncer-near.vercel.app">') {
    throw new Error('Public website must approve exactly the dedicated Bouncer wallet origin');
  }
}

export function stagePublicWeb(destination, source = DEFAULT_SOURCE) {
  if (typeof destination !== 'string' || !destination.trim()) throw new Error('A new staging directory is required');
  validatePublicWeb(source);
  // Refuse an existing destination, even an empty one. That prevents leftover
  // or unrelated files from being included in a later public deployment.
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
  console.log(`Staged ${staged.length} reviewed public website files; wallet sign-in is limited to the dedicated origin or approved development hosts.`);
}
