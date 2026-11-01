/**
 * Verify the connector-probe's Ed25519-signature-based randomness against an
 * independently pinned public key and the request's reviewed seed/identity.
 * This is not a TEE attestation, proof of an unbiased key, or a substitute for
 * trusting the public-key source and finalized RPC evidence.
 */
import crypto from 'node:crypto';
import { isTestnetAccount } from '../shared/account-id.mjs';

const HEX32 = /^[a-f0-9]{64}$/;
const HEX64 = /^[a-f0-9]{128}$/;
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
export function verifyOutlayerProbeVrf({ output, requestId, owner, seed, expectedPublicKey }) {
  if (!output || typeof output !== 'object' || Array.isArray(output) || output.ok !== true || output.operation !== 'vrf' ||
      !Number.isSafeInteger(requestId) || requestId < 0 || !isTestnetAccount(owner) ||
      typeof seed !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(seed) ||
      typeof expectedPublicKey !== 'string' || !HEX32.test(expectedPublicKey) ||
      typeof output.vrf_signature !== 'string' || !HEX64.test(output.vrf_signature) ||
      typeof output.vrf_output !== 'string' || !HEX32.test(output.vrf_output)) throw new Error('invalid pinned testnet VRF evidence');
  const alpha = `vrf:${requestId}:${owner}:${seed}`;
  if (output.vrf_alpha !== alpha || (output.vrf_pubkey !== undefined && output.vrf_pubkey !== expectedPublicKey)) {
    throw new Error('VRF identity, seed, request or public key mismatch');
  }
  const signature = Buffer.from(output.vrf_signature, 'hex');
  const publicKey = crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(expectedPublicKey, 'hex')]),
    format: 'der', type: 'spki' });
  if (!crypto.verify(null, Buffer.from(alpha, 'utf8'), publicKey, signature) ||
      crypto.createHash('sha256').update(signature).digest('hex') !== output.vrf_output) {
    throw new Error('VRF signature or signature-derived output is invalid');
  }
  return { operation: 'vrf', request_id: requestId, alpha, output_hex: output.vrf_output,
    signature_hex: output.vrf_signature, public_key_hex: expectedPublicKey };
}
