// TEST ONLY: synthetic FINAL RPC and public API data for the real CLI.
// This fixture cannot prove any live transaction or provider delivery.
import fs from 'node:fs';
import { PaymentRpcProvider } from '../../agent/near-account.mjs';
const evidence = JSON.parse(fs.readFileSync(process.env.BOUNCER_MULTIAGENCY_SYNTHETIC, 'utf8'));
PaymentRpcProvider.prototype.viewNodeStatus = async () => ({ chain_id: 'testnet' });
PaymentRpcProvider.prototype.txStatusReceipts = async (hash, owner, finality) => {
  if (hash !== evidence.hash || owner !== evidence.owner || finality !== 'FINAL') throw new Error('unexpected synthetic receipt lookup');
  return structuredClone(evidence.chain);
};
PaymentRpcProvider.prototype.viewAccount = async (id, { blockId }) => {
  if (id !== evidence.vault || ![evidence.txBlock, evidence.executionBlock].includes(blockId)) throw new Error('unexpected synthetic vault lookup');
  return { block_hash: blockId, code_hash: evidence.codeHash };
};
PaymentRpcProvider.prototype.viewAccessKeyList = async (id, { blockId }) => {
  if (id !== evidence.vault || ![evidence.txBlock, evidence.executionBlock].includes(blockId)) throw new Error('unexpected synthetic key lookup');
  return { block_hash: blockId, keys: [] };
};
PaymentRpcProvider.prototype.sendTransactionOnce = async () => { throw new Error('read-only CLI must not broadcast'); };
PaymentRpcProvider.prototype.sendTransactionUntil = async () => { throw new Error('read-only CLI must not broadcast'); };
globalThis.fetch = async (url, options) => {
  if (options?.method !== 'GET' || !Object.hasOwn(evidence.gets, url)) throw new Error('unexpected synthetic network operation');
  return new Response(JSON.stringify(evidence.gets[url]), { status: 200 });
};
