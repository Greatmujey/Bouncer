import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createModelClient, goalsFromModel, planObjective, saveGoals, validateObjective, validatePlanningConfig } from '../agent/goal-planner.mjs';

const config = () => ({
  version: 1, contract_id: 'bouncer.testnet', owner_account_id: 'bouncer.testnet',
  provider_url: 'https://provider.example', max_tasks: 3, required_resources: ['compute', 'storage', 'api'],
  resources: {
    compute: { policy_id: 'compute-wnear', token: 'wrap.testnet', payee: 'compute.testnet', max_amount: '100', max_tasks: 1, max_total_amount: '100' },
    storage: { policy_id: 'storage', token: 'storage.testnet', payee: 'storage-vendor.testnet', max_amount: '200', max_tasks: 1, max_total_amount: '200' },
    api: { policy_id: 'api', token: 'api-token.testnet', payee: 'api-vendor.testnet', max_amount: '300', max_tasks: 1, max_total_amount: '300' },
  },
});
const proposal = () => ({ tasks: [
  { resource: 'compute', input: { text: 'hash this', rounds: 1000 } },
  { resource: 'storage', input: { name: 'report', content: 'save this' } },
  { resource: 'api', input: { text: 'count these words' } },
] });
const clone = v => structuredClone(v);
function completion(content, changes = {}) {
  return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(content) }, ...changes }] }), { status: 200 });
}

test('model only proposes work; owner config supplies all financial authority', async () => {
  const c = config(); let modelInput;
  const result = await planObjective({ objective: 'Hash, store and count these texts.', config: c, modelClient: async input => { modelInput = input; return proposal(); } });
  assert.deepEqual(modelInput, { objective: 'Hash, store and count these texts.', allowedResources: ['compute', 'storage', 'api'] });
  assert.equal(JSON.stringify(modelInput).includes('wrap.testnet'), false);
  assert.deepEqual(result.goals.map(({ id, resource, policy_id, token, payee, max_amount }) => ({ id, resource, policy_id, token, payee, max_amount })), [
    { id: 'compute-1', resource: 'compute', policy_id: 'compute-wnear', token: 'wrap.testnet', payee: 'compute.testnet', max_amount: '100' },
    { id: 'storage-1', resource: 'storage', policy_id: 'storage', token: 'storage.testnet', payee: 'storage-vendor.testnet', max_amount: '200' },
    { id: 'api-1', resource: 'api', policy_id: 'api', token: 'api-token.testnet', payee: 'api-vendor.testnet', max_amount: '300' },
  ]);
  assert.deepEqual(result.goals.map(g => g.input), proposal().tasks.map(t => t.input));
});

test('prompt-injected or malformed output cannot change financial authority or add side effects', () => {
  const attacks = [
    p => { p.policy_id = 'attacker'; },
    p => { p.payee = 'attacker.testnet'; },
    p => { p.tasks[0].payee = 'attacker.testnet'; },
    p => { p.tasks[0].token = 'fake.testnet'; },
    p => { p.tasks[0].policy_id = 'override'; },
    p => { p.tasks[0].max_amount = '999999999'; },
    p => { p.tasks[0].command = 'withdraw'; },
    p => { p.tasks[0].input.url = 'http://evil.example'; },
    p => { p.tasks[0].input.__proto__ = { stolen: true }; },
    p => { p.tasks[0].resource = 'transfer'; },
    p => { p.tasks[1].input.name = '../../keys'; },
    p => { p.tasks[0].input.rounds = 20_001; },
    p => { p.tasks[0].input.text = 'x'.repeat(1025); },
    p => { p.tasks[2].input.text = '😀'.repeat(1025); },
    p => { p.tasks[0].input.rounds = '1000'; },
    p => { p.tasks = []; },
    p => { p.tasks.pop(); },
  ];
  for (const mutate of attacks) {
    const p = proposal(); mutate(p);
    assert.throws(() => goalsFromModel(p, config()), undefined, mutate.toString());
  }
  const jsonAttack = JSON.parse('{"tasks":[{"resource":"compute","input":{"text":"x","rounds":1,"__proto__":{"x":1}}}]}');
  const c = config(); c.required_resources = []; c.max_tasks = 1;
  assert.throws(() => goalsFromModel(jsonAttack, c), /input fields/);
});

test('model can request only safe fixed-origin public repository data', () => {
  const p = proposal();
  p.tasks[2].input = { repo: 'near/near-api-js' };
  assert.deepEqual(goalsFromModel(p, config()).goals[2].input, { repo: 'near/near-api-js' });
  p.tasks[2].input = { repo: 'https://evil.example/secret' };
  assert.throws(() => goalsFromModel(p, config()), /repository/);
  p.tasks[2].input = { repo: 'near/near-api-js', url: 'http://evil.example' };
  assert.throws(() => goalsFromModel(p, config()), /input fields/);
});

test('task caps, duplicate prevention and worst-case aggregate maxima are fail closed', () => {
  const c = config(); c.required_resources = []; c.max_tasks = 3;
  c.resources.compute.max_tasks = 3; c.resources.compute.max_total_amount = '199';
  const p = { tasks: [
    { resource: 'compute', input: { text: 'first', rounds: 1 } },
    { resource: 'compute', input: { text: 'second', rounds: 1 } },
  ] };
  assert.throws(() => goalsFromModel(p, c), /aggregate maximum/);
  c.resources.compute.max_total_amount = '200';
  assert.equal(goalsFromModel(p, c).goals.length, 2);
  p.tasks[1] = clone(p.tasks[0]);
  assert.throws(() => goalsFromModel(p, c), /duplicate/);
  p.tasks[1].input.text = 'other'; c.resources.compute.max_tasks = 1;
  assert.throws(() => goalsFromModel(p, c), /task limit/);
  p.tasks.push(clone(p.tasks[1])); p.tasks.push(clone(p.tasks[1]));
  assert.throws(() => goalsFromModel(p, c), /owner task limit/);
});

test('invalid owner authority fails before the model is contacted', async () => {
  const cases = [
    c => { c.contract_id = 'bouncer.near'; },
    c => { c.owner_account_id = 'testnet'; },
    c => { c.resources.compute.payee = 'attacker.near'; },
    c => { c.resources.compute.token = 'bad..testnet'; },
    c => { c.resources.compute.policy_id = 'a/b'; },
    c => { c.resources.compute.max_amount = '0'; },
    c => { c.resources.compute.max_amount = (1n << 128n).toString(); },
    c => { c.resources.compute.max_total_amount = '99'; },
    c => { c.resources.compute.max_tasks = 11; },
    c => { c.max_tasks = 0; },
    c => { c.required_resources = ['api', 'api']; },
    c => { c.resources.magic = c.resources.compute; },
    c => { c.provider_url = 'http://example.com'; },
    c => { c.provider_url = 'https://u:p@example.com'; },
    c => { c.extra = true; },
  ];
  for (const mutate of cases) {
    const c = config(); mutate(c); let called = false;
    await assert.rejects(planObjective({ objective: 'objective', config: c, modelClient: async () => { called = true; return proposal(); } }));
    assert.equal(called, false, mutate.toString());
  }
  assert.throws(() => validateObjective(' '), /nonempty/);
  assert.throws(() => validateObjective('😀'.repeat(1001)), /4000 bytes/);
  assert.equal(validatePlanningConfig(config()).resources.compute.payee, 'compute.testnet');
});

test('the owner can pin a 64-hex implicit testnet token without letting the model choose it', () => {
  const c = config(), implicit = 'a'.repeat(64);
  c.resources.api.token = implicit;
  const goals = goalsFromModel(proposal(), c);
  assert.equal(goals.goals[2].token, implicit);
  for (const invalid of ['a'.repeat(63), 'A'.repeat(64), 'g'.repeat(64), 'a'.repeat(65)]) {
    c.resources.api.token = invalid;
    assert.throws(() => validatePlanningConfig(c), /token and payee/);
  }
});

test('model transport sends only objective and capability names, prohibits redirects and does not leak errors', async () => {
  const seen = [];
  const client = createModelClient({ endpoint: 'https://model.example/v1/chat/completions', model: 'model-a', apiKey: 'private-api-key', fetchImpl: async (url, options) => {
    seen.push({ url: String(url), options }); return completion(proposal());
  } });
  const goals = await planObjective({ objective: 'Plan these test tasks.', config: config(), modelClient: client });
  assert.equal(goals.goals.length, 3);
  assert.equal(seen[0].url, 'https://model.example/v1/chat/completions');
  assert.equal(seen[0].options.redirect, 'error');
  assert.equal(seen[0].options.headers.authorization, 'Bearer private-api-key');
  const body = JSON.parse(seen[0].options.body);
  assert.equal(body.messages[1].content, 'Plan these test tasks.');
  assert.equal(body.response_format.type, 'json_schema');
  for (const secret of ['private-api-key', 'bouncer.testnet', 'compute.testnet', 'wrap.testnet', '100']) assert.equal(seen[0].options.body.includes(secret), false);
  const broken = createModelClient({ endpoint: 'http://127.0.0.1:1234/v1/chat/completions', model: 'x', apiKey: 'private-api-key', fetchImpl: async () => { throw new Error('private-api-key and hostile output'); } });
  await assert.rejects(broken({ objective: 'hello', allowedResources: ['compute'] }), error => /model request failed/.test(error.message) && !error.message.includes('private-api-key'));
  assert.throws(() => createModelClient({ endpoint: 'http://evil.example/v1/chat/completions', model: 'x' }), /HTTPS/);
  assert.throws(() => createModelClient({ endpoint: 'https://u:p@evil.example/path', model: 'x' }), /credentials/);
  assert.throws(() => createModelClient({ endpoint: 'https://evil.example/path?key=secret', model: 'x' }), /query/);
  assert.throws(() => createModelClient({ endpoint: 'http://localhost:1234/', model: 'x' }), /path/);
  assert.throws(() => createModelClient({ endpoint: 'http://localhost:1234/v1', model: 'x', apiKey: 'x\nheader: y' }), /API key/);
});

test('model schema is restricted to operator-available resource types', async () => {
  let sent;
  const client = createModelClient({ endpoint: 'http://127.0.0.1:1234/v1/chat/completions', model: 'x', fetchImpl: async (_url, options) => {
    sent = JSON.parse(options.body); return completion({ tasks: [{ resource: 'api', input: { repo: 'near/near-api-js' } }] });
  } });
  await client({ objective: 'Get a public repository', allowedResources: ['api'] });
  const branches = sent.response_format.json_schema.schema.properties.tasks.items.anyOf;
  assert.equal(branches.length, 2);
  assert.ok(branches.every(branch => branch.properties.resource.enum[0] === 'api'));
});

test('model refusal, truncation, invalid JSON and oversized bodies never become plans', async () => {
  const cases = [
    [() => completion(proposal(), { finish_reason: 'length' }), /incomplete/],
    [() => completion(proposal(), { message: { role: 'assistant', content: 'not json' } }), /not valid JSON/],
    [() => completion(proposal(), { message: { role: 'assistant', content: '{}', refusal: 'no' } }), /completed JSON/],
    [() => completion(proposal(), { message: { role: 'assistant', content: '{}', tool_calls: [] } }), /completed JSON/],
    [() => new Response('model secret details', { status: 503 }), /HTTP 503/],
    [() => new Response('x'.repeat(65_537)), /too large/],
    [() => new Response('garbage'), /invalid response/],
  ];
  for (const [response, expected] of cases) {
    const client = createModelClient({ endpoint: 'http://127.0.0.1:1234/v1/chat/completions', model: 'x', fetchImpl: async () => response() });
    await assert.rejects(client({ objective: 'hello', allowedResources: ['compute'] }), expected);
  }
});

test('goal files are private, carry a stable journal path, and never overwrite prior work', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-planner-test-'));
  try {
    const file = path.join(dir, 'goals.json');
    const goals = goalsFromModel(proposal(), config());
    assert.equal(saveGoals(file, goals), file);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(saved.journal_path, `${file}.bouncer-journal.json`);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.throws(() => saveGoals(file, goals), /EEXIST/);
    assert.equal(fs.existsSync(saved.journal_path), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
