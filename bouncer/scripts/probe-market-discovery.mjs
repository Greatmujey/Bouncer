/** Explicit, read-only live probe of the public marketplace catalog. */
import { discoverMarket } from '../agent/market-discovery.mjs';

try {
  const result = await discoverMarket({ limit: 3 });
  if (result.mode !== 'read-only' || result.payment_enabled !== false || !result.data_is_untrusted || !result.candidates.length) {
    throw new Error('marketplace did not return a usable read-only listing');
  }
  const handles = result.candidates.map(candidate => candidate.handle).join(',');
  console.log(`Read ${result.candidates.length} public listings from ${result.source}; handles: ${handles}`);
  console.log('These are untrusted marketplace listings, not approved providers, quotes, hires, or payments.');
  if (process.env.GITHUB_ACTIONS === 'true') {
    console.log(`::notice title=Independent marketplace discovery proof::source=market.near.ai; count=${result.candidates.length}; handles=${handles}; read-only=yes; payments=disabled`);
  }
} catch (error) {
  const message = String(error?.message || 'discovery failed').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 250);
  console.error(`Read-only marketplace probe failed: ${message}`);
  if (process.env.GITHUB_ACTIONS === 'true') console.log(`::error title=Marketplace discovery failed::${message.replace(/%/g, '%25')}`);
  process.exitCode = 1;
}
