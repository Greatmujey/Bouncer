// Rebuild only the reviewed NEAR Connect picker. No WalletConnect SDK is used.
import { build } from 'esbuild';
await build({
  entryPoints: ['web-src/wallet-entry.mjs'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  minify: true,
  legalComments: 'eof',
  outfile: 'web/wallet.bundle.js',
});
console.log('Built testnet wallet selector.');
