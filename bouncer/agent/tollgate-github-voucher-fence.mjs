/** Optional cross-environment one-shot voucher fence for the experimental
 * Tollgate client. GitHub label names are repository-unique; a single create
 * therefore reserves a voucher key across cooperating runners before signing.
 * The label must never be deleted or renamed. This is not a contract policy,
 * cannot revoke an exposed voucher, and relies on GitHub, repository admins,
 * this process and the local pre-existing fence directory being trustworthy. */
import crypto from 'node:crypto';
import { TollgateVoucherFence } from './tollgate-quakes-v13.mjs';
import { readBoundedJson } from '../shared/bounded-json.mjs';

const REPO = 'Greatmujey/Bouncer';
const sha = value => crypto.createHash('sha256').update(value, 'utf8').digest('hex');

export class GithubTollgateVoucherFence extends TollgateVoucherFence {
  #token;
  #fetch;
  get fenceScope() { return 'GITHUB_LABEL_AND_LOCAL'; }
  constructor(directory, { token, fetchImpl = globalThis.fetch } = {}) {
    super(directory);
    if (typeof token !== 'string' || token.length < 20 || typeof fetchImpl !== 'function') {
      throw new Error('GitHub voucher fence requires a scoped token and transport');
    }
    this.#token = token; this.#fetch = fetchImpl;
  }
  async #api(method, path, data) {
    const r = await this.#fetch(`https://api.github.com/repos/${REPO}${path}`, { method, redirect: 'error',
      signal: AbortSignal.timeout(20_000), headers: { authorization: `Bearer ${this.#token}`,
        accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28',
        'user-agent': 'bouncer-tollgate-voucher-fence', ...(data ? { 'content-type': 'application/json' } : {}) },
      ...(data ? { body: JSON.stringify(data) } : {}) });
    try {
      if (method === 'POST' && r.status === 422) {
        const error = await readBoundedJson(r, { maxBytes: 32_768, label: 'GitHub voucher reservation conflict' });
        if (Array.isArray(error?.errors) && error.errors.some(e => e?.resource === 'Label' && e?.field === 'name' && e?.code === 'already_exists')) {
          throw new Error('GitHub voucher reservation already exists; do not sign or retry');
        }
        throw new Error('GitHub voucher reservation invalid; do not sign or retry');
      }
      if ((method === 'POST' && r.status !== 201) || (method === 'GET' && r.status !== 200)) {
        throw new Error('GitHub voucher reservation unavailable; do not sign or retry');
      }
      return await readBoundedJson(r, { maxBytes: 32_768, label: 'public GitHub voucher reservation' });
    } finally { await r.body?.cancel().catch(() => {}); }
  }
  async claim(review, snapshot) {
    // First durably reserve locally; loss of a POST response cannot allow this
    // process to try the same key again. The label then fences other machines.
    const evidence = super.claim(review, snapshot);
    const name = `bouncer-tollgate-voucher-${sha(evidence.voucher_public_key)}`;
    const description = `v13:${evidence.review_hash}:${evidence.channel_id}`;
    const created = await this.#api('POST', '/labels', { name, description, color: 'b60205' });
    if (!Number.isSafeInteger(created?.id) || created.name !== name || created.description !== description) {
      throw new Error('GitHub voucher reservation acknowledgement differs; do not sign or retry');
    }
    const check = await this.#api('GET', `/labels/${encodeURIComponent(name)}`);
    if (check?.id !== created.id || check.name !== name || check.description !== description) {
      throw new Error('GitHub voucher reservation read-back differs; do not sign or retry');
    }
    return { ...evidence, github_label_id: created.id, github_label_name: name,
      scope: 'local fsync and repository-unique public label before voucher signing; neither payment nor delivery proof' };
  }
}
