// These are recorded public testnet runs, not a wallet or simulated settlement.
// The latest paid-provider mission is separate from the earlier multi-token
// resource example below. The site cannot run either mission.
export const LATEST_MISSION = Object.freeze({
  verifiedAt: '2026-10-28T12:46:12Z',
  account: 'bouncer-ft-07c759b0.testnet',
  owner: 'owner.bouncer-ft-07c759b0.testnet',
  actionUrl: 'https://github.com/abdullahimujeeb0505-stack/Bouncer/actions/runs/40689705483/job/122821855850',
  aiActionUrl: 'https://github.com/abdullahimujeeb0505-stack/Bouncer/actions/runs/40689705483/job/122821855839',
  fundingTx: 'FxaPzzPT3muthwjgEzC3MogW4RRqKTcTPisxAh7SeHxM',
  probeTx: 'HyLbpyHyX3PELEcJ5p3GpypXZzcKd4w6L63ohtHu7XFK',
  refundTx: 'G4Fq5zkwDG3JH2A5djEDrcDQ5sgyeFPeA41b3rQCaNQK',
  testToken: 'usdc.fakes.testnet', fundingMicro: '15000', probeHttpStatus: 405,
  computeTx: '6Zf1iATqDXJYfC2i7R6jxvq8879SWnn7urWc9x4bayWq',
  storageTx: 'CM1Tfm4XnZtRnwhXJdLYHD6oTXT49tW3Ra4mjg2B9eo4',
  apiTx: '66pQBQ3JMsXe28AhFW1PLCcXp95H8zoRAMNkMJGFYLvi',
});

// Source of the earlier three-token walkthrough:
// https://github.com/abdullahimujeeb0505-stack/Bouncer/actions/runs/40558301848
export const RUN = Object.freeze({
  verifiedAt: '2026-10-27T18:20:37Z',
  account: 'bouncer-42dcdfb7.testnet',
  securityAccount: 'bouncer-f646cc.testnet',
  securityRefundTx: 'GkQL6ZNHC7gGmRmCHc9uFv7fSsNdeJkTZaHtNPcxfhtw',
  actionUrl: 'https://github.com/abdullahimujeeb0505-stack/Bouncer/actions/runs/40558301848',
  resources: [
    {
      id: 'compute', title: 'Compute', service: 'SHA-256 compute job',
      vendor: 'compute.bouncer-42dcdfb7.testnet', policy: 'compute-wnear',
      token: 'wrap.testnet', tokenLabel: 'wNEAR', decimals: 24,
      amount: '100000000000000000000000', funded: '1000000000000000000000000',
      vault: '900000000000000000000000', perTx: '500000000000000000000000', daily: '1000000000000000000000000',
      tx: '6VELBm5bCbTF2jv88q2R4omrSJkvj8Ytr4aqa1FCtdTv',
      note: '1,000 rounds of SHA-256 were computed by the local provider.',
      story: {
        title: 'Compute a hash',
        request: 'Run 1,000 rounds of SHA-256 on “near-hub compute job”.',
        result: 'SHA-256 result: ad9458759e0093580ac1f7aa669deb8447571a5531691b53972ca1789b4e690c',
      },
    },
    {
      id: 'storage', title: 'Storage', service: 'Local file storage',
      vendor: 'storage.bouncer-42dcdfb7.testnet', policy: 'storage-credit',
      token: 'bs42dcdfb7.token.primitives.testnet', tokenLabel: 'storage credits', decimals: 6,
      amount: '1500000', funded: '10000000', vault: '8500000', perTx: '5000000', daily: '10000000',
      tx: '2oCD4escgD2JEnYRbTAKCRS3zNB13iafqsRPuEsqTQVB',
      note: 'A file was stored and retrieved from the local provider.',
      story: {
        title: 'Store and retrieve a note',
        request: 'Store a note named “bouncer-note” with the supplied text.',
        result: '“Persisted by the Bouncer testnet provider.” was stored and retrieved (42 bytes).',
      },
    },
    {
      id: 'api', title: 'API', service: 'Text statistics API',
      vendor: 'api.bouncer-42dcdfb7.testnet', policy: 'api-credit',
      token: 'ba42dcdfb7.token.primitives.testnet', tokenLabel: 'API credits', decimals: 6,
      amount: '2000000', funded: '10000000', vault: '8000000', perTx: '5000000', daily: '10000000',
      tx: '4HL53bUj6G8u1ZEKy8Wuj52sC5h2kzYAgzaREHL5M4sd',
      note: 'The local API returned statistics for the supplied text.',
      story: {
        title: 'Analyze a piece of text',
        request: 'Get text statistics for “actual testnet resource API”.',
        result: 'The API returned 4 words and 27 bytes.',
      },
    },
  ],
});
export const explorerTx = hash => `https://testnet.nearblocks.io/txns/${hash}`;
export const explorerAccount = id => `https://testnet.nearblocks.io/address/${id}`;
export function formatUnits(value, decimals) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 24 || !/^(0|[1-9]\d*)$/.test(String(value))) throw new Error('Invalid token amount');
  const digits = String(value).padStart(decimals + 1, '0');
  if (!decimals) return digits;
  const fraction = digits.slice(-decimals).replace(/0+$/, '');
  return digits.slice(0, -decimals) + (fraction ? `.${fraction}` : '');
}
export function shortId(value, left = 8, right = 5) {
  return value.length <= left + right + 3 ? value : `${value.slice(0, left)}…${value.slice(-right)}`;
}

// Optional browser-only public read. No key is requested, no transaction sent.
// If CORS or the public RPC is unavailable, the UI retains its recorded snapshot.
export async function readCurrentBalances(fetchImpl = globalThis.fetch, signal) {
  const requests = RUN.resources.map(async resource => {
    const args = btoa(JSON.stringify({ token: resource.token }));
    const response = await fetchImpl('https://test.rpc.fastnear.com', {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal,
      body: JSON.stringify({ jsonrpc: '2.0', id: resource.id, method: 'query', params: {
        request_type: 'call_function', finality: 'final', account_id: RUN.account,
        method_name: 'vault_balance', args_base64: args,
      } }),
    });
    if (!response.ok) throw new Error(`Testnet RPC HTTP ${response.status}`);
    const payload = await response.json();
    if (payload.error || !Array.isArray(payload.result?.result)) throw new Error('Testnet RPC returned an invalid response');
    const value = JSON.parse(new TextDecoder().decode(Uint8Array.from(payload.result.result)));
    if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) throw new Error('Testnet RPC returned an invalid balance');
    return [resource.id, value];
  });
  return Object.fromEntries(await Promise.all(requests));
}
