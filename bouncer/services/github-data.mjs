/**
 * Public repository metadata from the fixed GitHub REST origin. The caller can
 * choose an owner/repository, not a URL, HTTP method, headers or credential.
 * This is untrusted third-party data, not an authenticated or permanent feed.
 */
import { readBoundedJson } from '../shared/bounded-json.mjs';
import { normalizeRepository } from '../packages/provider-sdk/lib/resource-order.mjs';
export { normalizeRepository };

const MAX_BODY = 64 * 1024;
const MAX_DESCRIPTION = 2048;

export async function fetchPublicRepository(repository, fetchImpl = globalThis.fetch) {
  const repo = normalizeRepository(repository);
  if (typeof fetchImpl !== 'function') throw new Error('GitHub data transport is unavailable');
  const [owner, name] = repo.split('/');
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  let response;
  try {
    response = await fetchImpl(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(20_000),
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'bouncer-testnet-resource-provider' } });
  } catch { throw new Error('GitHub public data request failed or timed out'); }
  if (!response.ok) throw new Error(`GitHub public data request failed (HTTP ${response.status})`);
  const data = await readBoundedJson(response, { maxBytes: MAX_BODY, label: 'GitHub' });
  const validNumber = value => Number.isSafeInteger(value) && value >= 0;
  const description = data?.description;
  const license = data?.license?.spdx_id ?? null;
  if (data?.private !== false || typeof data.full_name !== 'string' || data.full_name.toLowerCase() !== repo.toLowerCase() ||
      !validNumber(data.id) || data.id === 0 || !validNumber(data.stargazers_count) || !validNumber(data.forks_count) || !validNumber(data.open_issues_count) ||
      !(description === null || (typeof description === 'string' && Buffer.byteLength(description) <= MAX_DESCRIPTION)) ||
      !(license === null || (typeof license === 'string' && Buffer.byteLength(license) <= 40))) {
    throw new Error('GitHub returned unexpected public repository metadata');
  }
  return { type: 'api', operation: 'github-repository', repository: data.full_name, repository_id: data.id,
    description, stars: data.stargazers_count, forks: data.forks_count, open_issues: data.open_issues_count,
    license, retrieved_at: new Date().toISOString() };
}
