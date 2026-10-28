// TEST ONLY: deterministic reply for the bounded compute example.
import crypto from 'node:crypto';
export function computeResult(input) {
  let value = Buffer.from(input.text, 'utf8');
  for (let i = 0; i < input.rounds; i++) value = crypto.createHash('sha256').update(value).digest();
  return { type: 'compute', algorithm: 'sha256-iterated', rounds: input.rounds, result: value.toString('hex') };
}
