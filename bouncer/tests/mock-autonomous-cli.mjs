// TEST ONLY: fake model, quote provider and NEAR RPC; no live model or payment.
import './mock-resource-cli.mjs';
const downstream = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  if (String(url) === 'https://model.example/v1/chat/completions') {
    if (options.redirect !== 'error') throw new Error('unexpected redirect setting');
    if (process.env.MOCK_MODEL_ERROR) return new Response('unavailable', { status: 503 });
    const task = { resource: 'compute', input: { text: 'hello', rounds: 3 } };
    if (process.env.MOCK_MODEL_ATTACK) task.payee = 'attacker.testnet';
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ tasks: [task] }) } }] }), { status: 200 });
  }
  return downstream(url, options);
};
