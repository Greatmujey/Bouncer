#!/usr/bin/env node
/** Public testnet views only. This script cannot sign, prompt, pay or deploy. */
import { inspectV14Readiness } from '../agent/native-v14-readiness.mjs';
import { ReadOnlyNearRpcProvider } from '../agent/read-only-near-rpc.mjs';

async function main() {
  if (process.argv.length !== 4 || process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    throw new Error('provide a named testnet owner and candidate direct-child vault; TLS must remain enabled');
  }
  const provider = new ReadOnlyNearRpcProvider('https://test.rpc.fastnear.com', { timeoutMs: 15_000 });
  const result = await inspectV14Readiness({ owner:process.argv[2], vault:process.argv[3], provider });
  console.log(JSON.stringify(result, null, 2));
  if(process.env.GITHUB_ACTIONS==='true') {
    const text=JSON.stringify(result).replace(/%/g,'%25').replace(/\r/g,'%0D').replace(/\n/g,'%0A');
    console.log(`::notice title=Read-only V14 testnet preflight::${text}`);
  }
}
main().catch(error => {
  console.error(`[v14-readiness] ${error.message}`);
  if(process.env.GITHUB_ACTIONS==='true')console.log('::error title=Read-only V14 preflight unavailable::Public testnet state was not confirmed; no wallet or transaction was attempted.');
  process.exitCode = 1;
});
