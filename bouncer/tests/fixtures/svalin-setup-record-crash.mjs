// Offline crash fixture only: the parent supplies disposable synthetic keys,
// test WASM and a temporary encrypted journal. It never sends a transaction.
import nearApi from 'near-api-js';
import { FileJournal } from '../../agent/procurement.mjs';
import { buildUnsignedSvalinTrialSetup } from '../../agent/svalin-setup-plan.mjs';
import { recordSvalinSetupSignedAttempt } from '../../agent/svalin-setup-journal.mjs';

const input = JSON.parse(process.env.BOUNCER_TEST_SETUP_INPUT);
const key = Buffer.from(input.journalKey, 'hex'), pair = nearApi.KeyPair.fromString(input.ownerPrivateKey);
const plan = buildUnsignedSvalinTrialSetup({ ...input.planInputs, wasmBytes: Buffer.from(input.planInputs.wasmBytes, 'base64') });
const journal = new FileJournal(input.file, plan.review.goal.vault, plan.review.goal.owner,
  { encryptionKey: key, requireExisting: true });
const batch = plan.batches[0], tx = nearApi.transactions.createTransaction(batch.signerId, pair.getPublicKey(), batch.receiverId,
  1n, batch.actions, Buffer.alloc(32, 7));
const [, signed] = await new nearApi.KeyPairSigner(pair).signTransaction(tx);
await recordSvalinSetupSignedAttempt({ plan, trustedReviewHash: plan.review.review_sha256,
  ownerPublicKey: String(pair.getPublicKey()), journal, stageId: batch.id, signed, acknowledgeRecovery: true });
// Simulate an abrupt process death after the durable write, not a clean close.
// The parent waits for process exit before removing this disposable stale lock.
process.stdout.write('recorded synthetic setup hash\n', () => process.kill(process.pid, 'SIGKILL'));
