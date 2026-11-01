/** Read-only testnet funding assessment, not a swap authorization. */
const ONE = 10n ** 24n, TARGET = 600_000n, RESERVE = 3n * ONE / 10n;
const integer = (value, max = 40) => typeof value === 'string' && new RegExp(`^(0|[1-9][0-9]{0,${max - 1}})$`).test(value);
export function assessYoutickFunding({ chain, ownerAmount, ownerStorageBytes, storagePrice, vaultLedger, vaultTokens, pools }) {
  if (chain !== 'testnet' || !integer(ownerAmount) || !Number.isSafeInteger(ownerStorageBytes) || ownerStorageBytes < 0 ||
      !integer(storagePrice) || !integer(vaultLedger) || !integer(vaultTokens) || !Array.isArray(pools)) throw new Error('invalid testnet funding observations');
  const ledger = BigInt(vaultLedger), tokens = BigInt(vaultTokens), total = BigInt(ownerAmount), cost = BigInt(ownerStorageBytes) * BigInt(storagePrice);
  if (cost > total || ledger > tokens) throw new Error('inconsistent observed account or vault balance');
  const spendable = total - cost, eligible = [];
  for (const entry of pools) {
    if (!entry || ![1845, 2206].includes(entry.pool_id) || entry.input !== ONE.toString() || !integer(entry.output)) continue;
    const output = BigInt(entry.output), min = output * 95n / 100n;
    if (min + ledger >= TARGET) eligible.push({ pool_id: entry.pool_id, input_yocto: entry.input,
      quoted_micro_usdc: output.toString(), min_micro_usdc: min.toString() });
  }
  eligible.sort((a, b) => BigInt(a.quoted_micro_usdc) === BigInt(b.quoted_micro_usdc) ? a.pool_id - b.pool_id :
    BigInt(a.quoted_micro_usdc) > BigInt(b.quoted_micro_usdc) ? -1 : 1);
  return { status: eligible.length && spendable >= ONE + RESERVE ? 'CANDIDATE_NEEDS_NEW_REVIEWED_ROUTER' : 'NOT_ESTABLISHED',
    vault_ledger_micro_usdc: ledger.toString(), vault_token_micro_usdc: tokens.toString(), owner_spendable_yocto: spendable.toString(),
    input_yocto: ONE.toString(), reserve_yocto: RESERVE.toString(), candidate: eligible[0] ?? null,
    scope: 'point-in-time read-only testnet estimate; no swap, funding, payment, liquidity guarantee or production claim' };
}
