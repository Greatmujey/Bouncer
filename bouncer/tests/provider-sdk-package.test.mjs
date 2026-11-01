import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import nearApi from 'near-api-js';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyDirectPayment as sharedVerifier } from '../shared/direct-payment-settlement.mjs';
import { verifyDirectPayment as sdkVerifier } from '../packages/provider-sdk/lib/direct-payment-settlement.mjs';
import { orderMemoV2 as buyerOrderMemoV2 } from '../services/resource-provider.mjs';
import { mockGuardedPayment, mockHash } from './mock-guarded-payment.mjs';

const require = createRequire(import.meta.url);
const packageDir = fileURLToPath(new URL('../packages/provider-sdk/', import.meta.url));

test('the seller SDK packs all runtime code and verifies receipts outside the Bouncer tree', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bouncer-sdk-package-'));
  try {
    const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', dir],
      { cwd: packageDir, encoding: 'utf8', timeout: 30_000 }));
    assert.equal(packed.length, 1);
    const metadata = packed[0];
    assert.equal(metadata.name, 'bouncer-near-testnet-provider-sdk');
    assert.equal(metadata.version, '0.3.0');
    assert.deepEqual(metadata.files.map(item => item.path).sort(),
      ['LICENSE', 'README.md', 'index.mjs', 'lib/account-id.mjs', 'lib/direct-payment-settlement.mjs', 'lib/final-payment.mjs', 'lib/resource-claim.mjs', 'lib/resource-order.mjs', 'package.json']);
    const archive = path.join(dir, metadata.filename), nodeModules = path.join(dir, 'node_modules');
    fs.mkdirSync(nodeModules);
    execFileSync('tar', ['-xzf', archive, '-C', nodeModules], { timeout: 10_000 });
    // Emulate an installed dependency in an otherwise separate project. This
    // keeps the test offline: npm pack itself never contacts the registry.
    const nearDir = path.dirname(require.resolve('near-api-js/package.json'));
    fs.symlinkSync(nearDir, path.join(nodeModules, 'near-api-js'), 'junction');
    const installedDir = path.join(nodeModules, metadata.name);
    fs.renameSync(path.join(nodeModules, 'package'), installedDir);
    const installedMetadata = JSON.parse(fs.readFileSync(path.join(installedDir, 'package.json'), 'utf8'));
    assert.equal(installedMetadata.private, true);
    assert.equal(installedMetadata.dependencies['near-api-js'], '6.5.1');
    const consumer = path.join(dir, 'consumer.mjs');
    fs.writeFileSync(consumer, `import { readAndVerifyProviderPayment, orderMemoV2 } from '${metadata.name}';\nconsole.log(typeof readAndVerifyProviderPayment, typeof orderMemoV2);\n`);
    assert.equal(execFileSync(process.execPath, [consumer], { encoding: 'utf8', timeout: 10_000 }).trim(), 'function function');
    const installed = await import(pathToFileURL(path.join(installedDir, 'index.mjs')).href);
    const order = { text: 'seller order', rounds: 3 }, challenge = '1234567890abcdef1234567890abcdef';
    const uniqueMemo = installed.orderMemoV2('compute', order, challenge);
    assert.equal(uniqueMemo, buyerOrderMemoV2('compute', order, challenge));
    assert.equal(installed.challengeFromOrderMemo('compute', order, uniqueMemo), challenge);
    const memoV3 = installed.orderMemoV3('compute', order, challenge), key = nearApi.KeyPair.fromRandom('ed25519');
    assert.equal(installed.challengeFromOrderMemoV3('compute', order, memoV3), challenge);
    const termsV3 = { network: 'near:testnet', contract_id: 'bouncer.testnet', owner_account_id: 'buyer.testnet',
      seller_origin: 'https://seller.example', resource: 'compute', policy_id: 'api', token: 'a'.repeat(64),
      payee: 'merchant.testnet', amount: '1000', memo: memoV3, tx_hash: mockHash('packaged-v3') };
    const signedV3 = await installed.signClaimAuthorization({ terms: termsV3, signer: new nearApi.KeyPairSigner(key), publicKey: key.getPublicKey() });
    const finalV3 = mockGuardedPayment({ hash: termsV3.tx_hash, owner: termsV3.owner_account_id, contract: termsV3.contract_id,
      publicKey: key.getPublicKey().toString(), args: { policy_id: termsV3.policy_id, expected_token: termsV3.token,
        payee: termsV3.payee, amount: termsV3.amount, memo: termsV3.memo } });
    const expectedV3 = Object.fromEntries(['tx_hash', 'contract_id', 'owner_account_id', 'policy_id', 'token', 'payee', 'amount', 'memo'].map(k => [k, termsV3[k]]));
    assert.equal(installed.verifyAuthenticatedProviderPayment(finalV3, expectedV3, termsV3, signedV3).agent_public_key, key.getPublicKey().toString());
    assert.throws(() => installed.verifyAuthenticatedProviderPayment(finalV3, expectedV3, { ...termsV3, seller_origin: 'https://other.example' }, signedV3));
    const expectation = { tx_hash: mockHash('standalone-seller'), contract_id: 'bouncer.testnet', owner_account_id: 'buyer.testnet',
      policy_id: 'api', token: 'a'.repeat(64), payee: 'merchant.testnet', amount: '1000', memo: 'seller-order:challenge' };
    const args = { policy_id: expectation.policy_id, expected_token: expectation.token, payee: expectation.payee,
      amount: expectation.amount, memo: expectation.memo };
    const evidence = mockGuardedPayment({ hash: expectation.tx_hash, owner: expectation.owner_account_id, contract: expectation.contract_id, args });
    assert.equal(installed.verifyProviderPayment(evidence, expectation).tx_hash, expectation.tx_hash);
    assert.throws(() => installed.verifyProviderPayment(evidence, { ...expectation, payee: 'attacker.testnet' }));
    const uniqueExpectation = { ...expectation, memo: uniqueMemo };
    const uniqueEvidence = mockGuardedPayment({ hash: expectation.tx_hash, owner: expectation.owner_account_id, contract: expectation.contract_id,
      args: { ...args, memo: uniqueMemo } });
    assert.equal(installed.verifyProviderPayment(uniqueEvidence, uniqueExpectation).tx_hash, expectation.tx_hash);
    assert.throws(() => installed.verifyProviderPayment(uniqueEvidence, { ...uniqueExpectation, memo: expectation.memo }));
    let reads = 0;
    const provider = { async viewNodeStatus() { return { chain_id: 'testnet' }; }, async txStatusReceipts(hash, owner, wait) {
      reads++; assert.equal(hash, expectation.tx_hash); assert.equal(owner, expectation.owner_account_id); assert.equal(wait, 'FINAL'); return evidence;
    } };
    assert.equal((await installed.readAndVerifyProviderPayment({ provider, expectation })).payee, expectation.payee);
    assert.equal(reads, 1);
    provider.viewNodeStatus = async () => ({ chain_id: 'mainnet' });
    await assert.rejects(installed.readAndVerifyProviderPayment({ provider, expectation }), /testnet/);
    assert.equal(reads, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('buyer and standalone SDK use one identical direct-settlement implementation', () => {
  assert.equal(sharedVerifier, sdkVerifier);
});
