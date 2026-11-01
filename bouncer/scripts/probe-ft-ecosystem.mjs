// READ ONLY research: no accounts, keys, transactions, or resource purchases.
// Inspect the current testnet deployment, not a promise of future liquidity or
// a claim that the OutLayer prepaid balance is a policy-controlled purchase.
import nearApi from 'near-api-js';
import { validateRpcEndpoint } from '../shared/rpc-endpoint.mjs';

const rpc = validateRpcEndpoint(process.env.NEAR_TESTNET_RPC || 'https://test.rpc.fastnear.com');
const provider = new nearApi.providers.JsonRpcProvider({ url: rpc });
const ref = 'ref-finance-101.testnet';
const outlayer = 'outlayer.testnet';
const circle = '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af';
const wnear = 'wrap.testnet';
const fakeUsd = new Set(['usdc.fakes.testnet', 'usdt.fakes.testnet', 'nusdc.ft-fin.testnet']);
const view = (id, method, args = {}) => provider.callFunction(id, method, args, { finality: 'final' });
const safe = async (id, method, args = {}) => {
  try { return { ok: true, value: await view(id, method, args) }; }
  catch (error) { return { ok: false, error: String(error.message || error).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 180) }; }
};
const notice = (title, value) => {
  const text = JSON.stringify(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  console.log(`::notice title=${title}::${text.slice(0, 3800)}`);
};

async function main() {
  if ((await provider.viewNodeStatus())?.chain_id !== 'testnet') throw new Error('RPC must report testnet');
  const [paymentToken, pricedCount, pricedProjects, circleMeta, total] = await Promise.all([
    safe(outlayer, 'get_payment_token_contract'), safe(outlayer, 'get_priced_project_count'),
    safe(outlayer, 'get_priced_projects', { from_index: 0, limit: 30 }),
    safe(circle, 'ft_metadata'), safe(ref, 'get_number_of_pools'),
  ]);
  const slimMeta = result => result.ok ? { ok: true, value: { name: result.value?.name, symbol: result.value?.symbol, decimals: result.value?.decimals } } : result;
  const fakeMeta = await safe('usdc.fakes.testnet', 'ft_metadata');
  const configuration = { outlayer_payment_token: paymentToken, priced_project_count: pricedCount,
    priced_projects: pricedProjects, circle_testnet_metadata: slimMeta(circleMeta),
    outlayer_test_token_metadata: slimMeta(fakeMeta), ref_pool_count: total };
  notice('Read-only testnet provider configuration', configuration);
  for (const project_id of ['connectors.outlayer.testnet/connector-probe', 'connectors.outlayer.testnet/github']) {
    const [project, pricing] = await Promise.all([safe(outlayer, 'get_project', { project_id }),
      safe(outlayer, 'get_project_pricing', { project_id })]);
    const key = project.ok && project.value?.active_version;
    const version = key ? await safe(outlayer, 'get_version', { project_id, version_key: key }) : null;
    const select = new Set(['ping', 'whoami', 'burn', 'fetch', 'refund', 'trap', 'status', 'repo_get', 'file_get']);
    const rows = pricing.ok && Array.isArray(pricing.value?.operations)
      ? pricing.value.operations.filter(row => select.has(row.operation)) : [];
    notice('Independent priced project ' + project_id, { project, version, author: pricing.value?.author_account_id, selected_prices: rows,
      pricing_error: pricing.ok ? undefined : pricing.error });
  }
  if (!total.ok || !/^\d+$/.test(String(total.value))) throw new Error('cannot enumerate Ref testnet pools');
  const count = Number(total.value);
  if (!Number.isSafeInteger(count) || count < 0 || count > 100_000) throw new Error('unexpected Ref pool count');
  // Scan only a bounded number of pages. Each entry is untrusted; select only
  // two-token wNEAR pools with positive reserves and later ask Ref for a quote.
  const cap = Math.min(count, 10_000), pageSize = 100, pages = Math.ceil(cap / pageSize);
  const hits = [], errors = []; let next = 0;
  async function worker() {
    while (true) {
      const page = next++;
      if (page >= pages) return;
      const start = page * pageSize;
      const res = await safe(ref, 'get_pools', { from_index: start, limit: Math.min(pageSize, cap - start) });
      if (!res.ok || !Array.isArray(res.value)) { errors.push({ page, error: res.error || 'not an array' }); continue; }
      res.value.forEach((pool, i) => {
        const tokens = pool?.token_account_ids;
        if (!Array.isArray(tokens) || tokens.length !== 2 || !tokens.includes(wnear)) return;
        const stable = tokens.find(t => t === circle || fakeUsd.has(t));
        if (!stable || !Array.isArray(pool.amounts) || pool.amounts.length !== 2 ||
            pool.amounts.some(a => !/^\d+$/.test(String(a)) || BigInt(a) === 0n)) return;
        hits.push({ id: start + i, stable, token_account_ids: tokens, amounts: pool.amounts, pool_kind: pool.pool_kind });
      });
    }
  }
  await Promise.all(Array.from({ length: 3 }, worker));
  const sorted = hits.sort((a, b) => (a.stable === circle ? -1 : 0) - (b.stable === circle ? -1 : 0) || a.id - b.id);
  const candidates = sorted.slice(0, 12);
  for (const item of candidates) item.quote_for_0_01_wnear = await safe(ref, 'get_return', {
    pool_id: item.id, token_in: wnear, amount_in: '10000000000000000000000', token_out: item.stable,
  });
  notice('Read-only Ref liquidity discovery', { scanned: cap, total: count, circle_matches: hits.filter(p => p.stable === circle).length,
    candidates, errors: errors.slice(0, 5) });
  if (errors.length) throw new Error(`Ref pool scan had ${errors.length} page failures`);
  console.log('Research only. USD-labelled fakes are not Circle USDC, and an on-chain quote is not a guaranteed executable trade.');
}
main().catch(error => { console.error(`[ft-ecosystem-probe] ${error.message}`); process.exitCode = 1; });
