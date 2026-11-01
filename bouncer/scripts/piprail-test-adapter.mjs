// TEST SUPPORT ONLY. Load a separately installed, pinned third-party SDK.
// PipRail 3.3.0's built-in NEAR preset is mainnet-only. This explicit wrapper
// substitutes only the network label/support check while retaining its real
// published NEAR verifier and directing its RPC to our supplied TESTNET URL.
// It is NOT an upstream testnet preset or an independent merchant deployment.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function loadPipRailTestSdk(packageRoot) {
  if (!packageRoot || typeof packageRoot !== 'string') throw new Error('provide a trusted local @piprail/sdk package directory');
  const root = path.resolve(packageRoot), pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (pkg.name !== '@piprail/sdk' || pkg.version !== '3.3.0') throw new Error('interop test requires @piprail/sdk 3.3.0');
  const sdk = await import(pathToFileURL(path.join(root, 'dist/index.js')).href);
  // This is a private build chunk, intentionally pinned to 3.3.0. It lets us
  // preserve the published verifyNear implementation instead of rewriting it.
  const { nearDriver } = await import(pathToFileURL(path.join(root, 'dist/near-5X2CQGML.js')).href);
  if (typeof sdk.createPaymentGate !== 'function' || typeof sdk.registerDriver !== 'function' || !nearDriver?.resolve) throw new Error('unexpected PipRail package layout');
  sdk.registerDriver({ family: 'near', resolve(options) {
    const actual = nearDriver.resolve({ ...options, chain: 'near' });
    if (!actual) throw new Error('PipRail NEAR driver could not be resolved');
    return { ...actual, network: 'near:testnet', supports: id => id === 'near:testnet' };
  } });
  return sdk;
}
