import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const workflow = fs.readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
const mutationJobs = [
  'resume-original-ref-sweep', 'youtick-owner-grant-probe', 'youtick-testnet-quote-only',
  'paid-vrf2-one-shot', 'paid-vrf-one-shot', 'guarded-ref-one-shot',
  'circle-usdc-live', 'oracle-mission-live', 'dependent-workflow-live', 'seller-v2-workflow-live',
  'seller-v3-workflow-live', 'piprail-onchain-proof-live', 'ft-call-live', 'outlayer-guarded',
  'outlayer-direct-research', 'seller-v3-fresh-proof', 'testnet-smoke', 'testnet-multi', 'ai-testnet',
];

function condition(job) {
  const escaped = job.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const found = new RegExp(`\\n  ${escaped}:\\n([\\s\\S]*?)(?=\\n  [a-zA-Z][a-zA-Z0-9_-]*:\\n|$)`).exec(workflow);
  assert.ok(found, `missing ${job}`);
  const guards = [...found[1].matchAll(/^    if: (.+)$/gm)];
  assert.equal(guards.length, 1, `${job} must have one top-level condition`);
  return guards[0][1];
}

// A small, non-eval interpreter for the subset of Actions expressions used by
// these gates. It evaluates the entire expression, so an unparenthesized OR
// cannot silently bypass the private/first-attempt guard. Unsupported syntax
// fails the test rather than being treated as safe.
function evaluate(expression, context) {
  const tokens = [], grammar = /\s*(?:('(?:[^'\\]|\\.)*')|(==|&&|\|\||[(),])|([a-zA-Z_][a-zA-Z0-9_.]*))/y;
  let index = 0;
  while (index < expression.length) {
    grammar.lastIndex = index;
    const match = grammar.exec(expression);
    if (!match || match.index !== index) throw new Error(`unsupported Actions expression at offset ${index}`);
    tokens.push(match[1] ?? match[2] ?? match[3]); index = grammar.lastIndex;
  }
  let pos = 0;
  const peek = () => tokens[pos], take = value => {
    if (tokens[pos] !== value) throw new Error(`expected ${value}`); pos += 1;
  };
  function primary() {
    if (peek() === '(') { take('('); const x = or(); take(')'); return x; }
    const token = tokens[pos++];
    if (!token) throw new Error('unexpected end of Actions expression');
    if (token.startsWith("'")) return token.slice(1, -1);
    if (token === 'true') return true;
    if (token === 'false') return false;
    if (token === 'contains' || token === 'startsWith') {
      take('('); const a = or(); take(','); const b = or(); take(')');
      if (typeof a !== 'string' || typeof b !== 'string') return false;
      return token === 'contains' ? a.includes(b) : a.startsWith(b);
    }
    return token.split('.').reduce((x, part) => x?.[part], context);
  }
  function equal() { let x = primary(); if (peek() === '==') { take('=='); x = x === primary(); } return x; }
  function and() { let x = equal(); while (peek() === '&&') { take('&&'); const y = equal(); x = Boolean(x && y); } return x; }
  function or() { let x = and(); while (peek() === '||') { take('||'); const y = and(); x = Boolean(x || y); } return x; }
  const value = or();
  if (pos !== tokens.length) throw new Error('unconsumed Actions expression');
  return Boolean(value);
}

function approvedPush(expr) {
  const branch = /github\.ref == '([^']+)'/.exec(expr)?.[1] ?? 'refs/heads/arena/3ee8cb60-near-hub';
  const before = /github\.event\.before == '([^']+)'/.exec(expr)?.[1] ?? 'a'.repeat(40);
  const markers = [...expr.matchAll(/'\[([^']+)\]'/g)].map(m => `[${m[1]}]`).join(' ');
  assert.notEqual(markers, '', 'a push must require a specific opt-in marker');
  return { github: { event_name: 'push', ref: branch, run_attempt: '1',
    event: { repository: { private: true }, before, head_commit: { message: markers } } },
    inputs: { run_testnet_smoke: false } };
}

test('live testnet and reservation jobs require private repo, first attempt and an explicit event opt-in', () => {
  for (const job of mutationJobs) {
    const expr = condition(job), ctx = approvedPush(expr);
    assert.equal(evaluate(expr, ctx), true, `${job}: expected the correctly gated push to be possible`);
    const publicRepo = structuredClone(ctx); publicRepo.github.event.repository.private = false;
    assert.equal(evaluate(expr, publicRepo), false, `${job}: public repo must not run historical live actions`);
    const rerun = structuredClone(ctx); rerun.github.run_attempt = '2';
    assert.equal(evaluate(expr, rerun), false, `${job}: reruns must not repeat live actions`);
    const pullRequest = structuredClone(ctx); pullRequest.github.event_name = 'pull_request';
    assert.equal(evaluate(expr, pullRequest), false, `${job}: a pull request must not run live actions`);
    const noMarker = structuredClone(ctx); noMarker.github.event.head_commit.message = 'ordinary test-only commit';
    assert.equal(evaluate(expr, noMarker), false, `${job}: an ordinary push must not run live actions`);
  }
});

test('manual dispatch defaults to no live smoke and requires a separate explicit checkbox', () => {
  assert.match(workflow, /workflow_dispatch:\n\s+inputs:\n\s+run_testnet_smoke:\n[\s\S]*?default: false\n\s+type: boolean/);
  const expr = condition('testnet-smoke'), ctx = approvedPush(expr);
  ctx.github.event_name = 'workflow_dispatch';
  ctx.github.event.head_commit.message = '';
  assert.equal(evaluate(expr, ctx), false);
  ctx.inputs.run_testnet_smoke = true;
  assert.equal(evaluate(expr, ctx), true);
  ctx.github.event.repository.private = false;
  assert.equal(evaluate(expr, ctx), false);
  ctx.github.event.repository.private = true; ctx.github.run_attempt = '2';
  assert.equal(evaluate(expr, ctx), false);
  for (const job of mutationJobs.filter(j => j !== 'testnet-smoke')) {
    const event = approvedPush(condition(job)); event.github.event_name = 'workflow_dispatch';
    event.inputs.run_testnet_smoke = true;
    assert.equal(evaluate(condition(job), event), false, `${job}: must not piggyback on dispatch`);
  }
});
