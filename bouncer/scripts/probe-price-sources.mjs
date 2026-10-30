// Read-only external price-source research from a GitHub runner. These probes
// do not prove an OutLayer worker can reach the same endpoint. No secrets,
// accounts, transaction signatures or payments are used.
import { readBoundedJson } from '../shared/bounded-json.mjs';
const endpoints = [
  { name: 'Coinbase NEAR/USD', url: 'https://api.coinbase.com/v2/prices/NEAR-USD/spot', read: x => x?.data?.amount },
  { name: 'Binance US NEAR/USD', url: 'https://api.binance.us/api/v3/ticker/price?symbol=NEARUSD', read: x => x?.price },
  { name: 'Binance NEAR/USDT', url: 'https://api.binance.com/api/v3/ticker/price?symbol=NEARUSDT', read: x => x?.price },
  { name: 'CoinGecko NEAR/USD', url: 'https://api.coingecko.com/api/v3/simple/price?ids=near&vs_currencies=usd', read: x => x?.near?.usd },
  { name: 'Pyth BTC/USD', url: 'https://hermes.pyth.network/v2/updates/price/latest?ids[]=e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43', read: x => x?.parsed?.[0]?.price?.price },
];
const results = await Promise.all(endpoints.map(async ({ name, url, read }) => {
  try {
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
    if (!response.ok) return { name, status: response.status };
    const value = read(await readBoundedJson(response, { maxBytes: 100_000, label: name }));
    const num = Number(value);
    return { name, status: response.status, positive_numeric_value: value !== undefined && Number.isFinite(num) && num > 0 };
  } catch (error) { return { name, error: String(error?.message || error).slice(0, 200) }; }
}));
const value = JSON.stringify({ source: 'GitHub runner only; OutLayer worker reachability is unproven', results }).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
console.log(`::notice title=Read-only public price-source probe::${value}`);
