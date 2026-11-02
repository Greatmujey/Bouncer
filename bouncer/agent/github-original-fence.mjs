/** Validate the retained GitHub Actions artifact that fences a public signed
 * original before a one-shot testnet send. This fetches metadata only: it
 * never uploads keys, submits a transaction or authorizes a different action. */
import { readBoundedJson } from '../shared/bounded-json.mjs';
const id = x => typeof x === 'string' && /^[1-9][0-9]{0,15}$/.test(x) && Number.isSafeInteger(Number(x));
export async function githubOriginalFence({ artifactId, runId, headSha, digest, token, maxArtifactBytes,
  prefix = 'vault-v2-bootstrap-fence', fetchImpl = globalThis.fetch } = {}) {
  if (!id(artifactId) || !id(runId) || !/^[a-f0-9]{40}$/.test(headSha ?? '') || !/^[a-f0-9]{64}$/.test(digest ?? '') ||
      typeof token !== 'string' || token.length < 20 || !Number.isSafeInteger(maxArtifactBytes) ||
      maxArtifactBytes < 1 || maxArtifactBytes > 2_000_000 || !['vault-v2-bootstrap-fence',
        'vault-circle-v2-register-fence', 'vault-circle-v2-fund-fence',
        'resource-agent-v2-guard-probe-fence', 'resource-agent-v2-configure-fence',
        'resource-agent-v2-install-fence'].includes(prefix) || typeof fetchImpl !== 'function') {
    throw new Error('invalid original-hash artifact fence parameters');
  }
  const response = await fetchImpl(`https://api.github.com/repos/Greatmujey/Bouncer/actions/artifacts/${artifactId}`, {
    method: 'GET', redirect: 'error', headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`,
      'user-agent': 'bouncer-keyless-testnet-vault' }, signal: AbortSignal.timeout(15_000) });
  try {
    if (!response.ok) return false;
    const m = await readBoundedJson(response, { maxBytes: 32_768, label: 'original vault artifact' });
    return m?.id === Number(artifactId) && m.name === `${prefix}-${runId}-${digest}` && m.expired === false &&
      Number.isSafeInteger(m.size_in_bytes) && m.size_in_bytes > 0 && m.size_in_bytes < maxArtifactBytes &&
      m.workflow_run?.id === Number(runId) && m.workflow_run?.head_sha === headSha &&
      m.workflow_run?.head_branch === 'arena/25a7aaf6-near-hub';
  } finally { await response.body?.cancel().catch(() => {}); }
}
