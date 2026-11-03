/** Validate the retained GitHub Actions artifact that fences a public signed
 * original before a one-shot testnet send. This fetches metadata only: it
 * never uploads keys, submits a transaction or authorizes a different action. */
import { readBoundedJson } from '../shared/bounded-json.mjs';
const id = x => typeof x === 'string' && /^[1-9][0-9]{0,15}$/.test(x) && Number.isSafeInteger(Number(x));
// Both V3 bearers were publicly exported and their outcomes remain unknown.
// They must never become eligible for a new send by adding a missing label.
const RETIRED_BEARER_PREFIXES = new Set(['outlayer-v12-v3-register-fence', 'outlayer-v12-v3-control-fence']);
export async function githubOriginalFence({ artifactId, runId, headSha, digest, token, maxArtifactBytes,
  prefix = 'vault-v2-bootstrap-fence', fetchImpl = globalThis.fetch } = {}) {
  if (RETIRED_BEARER_PREFIXES.has(prefix)) throw new Error('retired original bearer; reconcile only, never resend');
  if (!id(artifactId) || !id(runId) || !/^[a-f0-9]{40}$/.test(headSha ?? '') || !/^[a-f0-9]{64}$/.test(digest ?? '') ||
      typeof token !== 'string' || token.length < 20 || !Number.isSafeInteger(maxArtifactBytes) ||
      maxArtifactBytes < 1 || maxArtifactBytes > 2_000_000 || !['vault-v2-bootstrap-fence', 'vault-v3-v12-bootstrap-fence',
        'vault-circle-v2-register-fence', 'vault-circle-v2-fund-fence',
        'vault-circle-v3-v12-register-fence', 'vault-circle-v3-v12-fund-fence',
        'resource-agent-v2-guard-probe-fence', 'resource-agent-v2-guard-control-fence', 'resource-agent-v2-configure-fence',
        'resource-agent-v2-install-fence', 'named-testnet-recovery-fence', 'named-vault-topup-fence',
        'outlayer-burn-register-fence', 'outlayer-burn-control-fence',
        'outlayer-burn-register-after-control-fence', 'outlayer-burn-wrap-fence',
        'outlayer-burn-swap-fence', 'outlayer-burn-vault-fund-fence',
        'acquisition-v3-wrap-fence', 'acquisition-v3-swap-fence'].includes(prefix) || typeof fetchImpl !== 'function') {
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
