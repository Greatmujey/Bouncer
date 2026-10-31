/**
 * Prepare and sign exactly one reviewed Bouncer function call. No network
 * broadcast or journal write happens here. A compromised/misbehaving account
 * builder or signer must not substitute the recipient, action, arguments,
 * payload, transaction hash or signature after off-chain review.
 */
import crypto from 'node:crypto';
import nearApi from 'near-api-js';

const { transactions, utils } = nearApi;

export async function signReviewedCall({ account, publicKey, ownerId, contractId, method, args, gas }) {
  if (!account || account.accountId !== ownerId || !account.signer || typeof account.createTransaction !== 'function' ||
      typeof account.signer.getPublicKey !== 'function' || typeof account.signer.signTransaction !== 'function' ||
      String(await account.signer.getPublicKey()) !== String(publicKey)) throw new Error('signer does not match the reviewed agent key');
  const reviewedKey = utils.PublicKey.from(String(publicKey));
  const expectedArgs = Buffer.from(JSON.stringify(args));
  const action = transactions.functionCall(method, args, gas, 0n);
  const transaction = await account.createTransaction(contractId, [action], publicKey);
  const call = transaction?.actions?.[0]?.functionCall;
  if (transaction?.signerId !== ownerId || transaction?.receiverId !== contractId || String(transaction?.publicKey) !== String(publicKey) ||
      !Array.isArray(transaction.actions) || transaction.actions.length !== 1 || transaction.actions[0]?.enum !== 'functionCall' ||
      call?.methodName !== method || call.gas !== gas || call.deposit !== 0n || !Buffer.from(call.args || []).equals(expectedArgs)) {
    throw new Error('prepared transaction does not match the reviewed call');
  }
  // Encode before invoking the signer: it cannot silently mutate the prepared
  // transaction or return unrelated signed bytes or an unrelated hash.
  const unsigned = Buffer.from(transactions.encodeTransaction(transaction));
  const digest = crypto.createHash('sha256').update(unsigned).digest();
  const [returnedHash, signed] = await account.signer.signTransaction(transaction);
  let matchingPayload = false, validSignature = false;
  try {
    matchingPayload = !!signed?.transaction && Buffer.from(transactions.encodeTransaction(signed.transaction)).equals(unsigned);
    const signatureType = reviewedKey.keyType === 0 ? 'ed25519Signature' : reviewedKey.keyType === 1 ? 'secp256k1Signature' : null;
    validSignature = !!signatureType && signed?.signature?.enum === signatureType &&
      signed.signature.data instanceof Uint8Array && reviewedKey.verify(digest, signed.signature.data);
  } catch { /* malformed signed objects fail closed */ }
  if (!(returnedHash instanceof Uint8Array) || !Buffer.from(returnedHash).equals(digest) || !matchingPayload || !validSignature) {
    throw new Error('signed transaction does not match the reviewed call');
  }
  return { txHash: utils.serialize.base_encode(digest), signed };
}
