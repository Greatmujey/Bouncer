/** Public, pinned OutLayer registry identity for testnet read-only checks.
 * These views cannot authorize or prove a provider execution. */
import { isDeepStrictEqual } from 'node:util';

export const ORACLE_TESTNET_HASH = '3585b3890f49748713b43ccb9b0ef4148f317d62f4d598db80fdaffc3f3185a0';
export const ORACLE_PROJECT_ID = 'zavodil2.testnet/price-oracle';
export const ORACLE_PROJECT_UUID = 'p0000000000000007';
export const ORACLE_TESTNET_PROGRAM = Object.freeze({
  url: `https://wasmhub.testnet.fastfs.io/fastfs.testnet/${ORACLE_TESTNET_HASH}.wasm`, sha256: ORACLE_TESTNET_HASH,
  build_target: 'wasm32-wasip2', max_instructions: 10_000_000_000, max_memory_mb: 256, max_execution_seconds: 60,
});

export function oracleTestnetRegistryMatches(project, version, pricing) {
  const p = ORACLE_TESTNET_PROGRAM;
  return project?.project_id === ORACLE_PROJECT_ID && project?.uuid === ORACLE_PROJECT_UUID && project?.owner === 'zavodil2.testnet' &&
    version?.wasm_hash === ORACLE_TESTNET_HASH &&
    isDeepStrictEqual(version?.source, { WasmUrl: { url: p.url, hash: p.sha256, build_target: p.build_target } }) && pricing === null;
}

/** Non-atomic public views; the sending runner repeats this before a payment. */
export async function assertOracleProjectRegistry(provider) {
  const final = { finality: 'final' }, payee = 'outlayer.testnet';
  const [project, version, pricing] = await Promise.all([
    provider.callFunction(payee, 'get_project', { project_id: ORACLE_PROJECT_ID }, final),
    provider.callFunction(payee, 'get_version', { project_id: ORACLE_PROJECT_ID, version_key: ORACLE_TESTNET_HASH }, final),
    provider.callFunction(payee, 'get_project_pricing', { project_id: ORACLE_PROJECT_ID }, final),
  ]);
  if (!oracleTestnetRegistryMatches(project, version, pricing)) {
    throw new Error('independent project identity, pinned source or native-only pricing changed');
  }
}
