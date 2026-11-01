#!/usr/bin/env node
/** Read-only testnet Ref capability research. No keys, signatures or sends. */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PaymentRpcProvider } from '../agent/near-account.mjs';
import { isTestnetAccount, isTestnetToken } from '../shared/account-id.mjs';

const REF = 'ref-finance-101.testnet';
const METHODS = ['get_client_echo_token_id_whitelist', 'get_client_echo_sender_id_whitelist', 'get_secure_sender_whitelist'];
const MAX_ROWS = 1024;
function parseList(value) {
  if (!Array.isArray(value) || value.length > MAX_ROWS || value.some(item => typeof item !== 'string' || item.length > 66 ||
      !/^(?:\*\.)?[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(item))) throw new Error('invalid public whitelist');
  return value;
}
function includes(list, account) {
  return list.some(pattern => pattern === account || (pattern.startsWith('*.') && account.endsWith(pattern.slice(1))));
}

/** The reported rule comes from an inspected source fork, not bytecode attestation. */
export async function inspectRefEcho({ provider, sender, inputToken }) {
  if (!provider || typeof provider.viewNodeStatus !== 'function' || typeof provider.callFunction !== 'function' ||
      !isTestnetAccount(sender) || !isTestnetToken(inputToken)) throw new Error('valid testnet sender, token and provider required');
  if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('RPC must report testnet');
  const lists = await Promise.all(METHODS.map(async method => {
    try { return { observed: true, entries: parseList(await provider.callFunction(REF, method, {}, { finality: 'final' })) }; }
    catch { return { observed: false, entries: null }; }
  }));
  const [tokens, senders, secure] = lists;
  const tokenAllowed = tokens.observed ? includes(tokens.entries, inputToken) : null;
  const senderAllowed = senders.observed ? includes(senders.entries, sender) : null;
  const secureAllowed = secure.observed ? includes(secure.entries, sender) : null;
  const sourceRuleAllows = secureAllowed === true ? true : secureAllowed === false && tokenAllowed !== null && senderAllowed !== null
    ? tokenAllowed && senderAllowed : null;
  let codeHash = null;
  if (typeof provider.query === 'function') {
    try {
      const account = await provider.query({ request_type: 'view_account', account_id: REF, finality: 'final' });
      if (typeof account?.code_hash === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,60}$/.test(account.code_hash)) codeHash = account.code_hash;
    } catch { /* View failure is not evidence of a particular deployment. */ }
  }
  return { network: 'testnet', exchange: REF, code_hash: codeHash, candidate_sender: sender, input_token: inputToken,
    whitelists: { input_tokens: tokens, senders, secure_senders: secure },
    matches: { input_token: tokenAllowed, sender: senderAllowed, secure_sender: secureAllowed },
    source_rule_allows: sourceRuleAllows,
    warning: 'Public views and an inspected source fork only: this is not deployed-code correspondence, a quote, a swap or a vault-credit proof.' };
}

async function main() {
  if (process.argv.length !== 2) throw new Error('this fixed probe accepts no arguments');
  const provider = new PaymentRpcProvider(process.env.NEAR_TESTNET_RPC || 'https://test.rpc.fastnear.com');
  const result = await inspectRefEcho({ provider, sender: 'bouncer-research.testnet', inputToken: 'wrap.testnet' });
  const report = JSON.stringify(result).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  console.log(`::notice title=Read-only Ref client-echo capability::${report.slice(0, 12_000)}`);
  console.log('No accounts, signatures or transactions were created. A wildcard match is not a promise of permission or output settlement.');
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(() => { console.error('[ref-echo-probe] could not complete read-only testnet inspection'); process.exitCode = 1; });
}
