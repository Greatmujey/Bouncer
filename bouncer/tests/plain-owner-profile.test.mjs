import test from 'node:test';
import assert from 'node:assert/strict';
import { hasPlainOwnerProfileAt, NO_LOCAL_CONTRACT_HASH } from '../shared/plain-owner-profile.mjs';
import { mockHash } from './mock-guarded-payment.mjs';

const BLOCK = mockHash('plain-owner-final');
const plain = () => ({ block_hash: BLOCK, code_hash: NO_LOCAL_CONTRACT_HASH });

test('plain owner profile requires a matching finalized account view with no local or global contract', () => {
  for (const extra of [{}, { global_contract_hash: null, global_contract_account_id: null },
    { state: 'initialized', bootstrap_nonce: null }]) {
    assert.equal(hasPlainOwnerProfileAt({ ...plain(), ...extra }, BLOCK), true);
  }
  const bad = [
    null, [], {}, { ...plain(), block_hash: mockHash('other') },
    { ...plain(), code_hash: mockHash('local-contract') }, { ...plain(), code_hash: null },
    { ...plain(), global_contract_hash: mockHash('global-contract') },
    { ...plain(), global_contract_account_id: 'shared.testnet' },
    { ...plain(), global_contract_hash: undefined }, { ...plain(), global_contract_account_id: '' },
    { ...plain(), state: 'uninitialized' }, { ...plain(), state: null },
    { ...plain(), bootstrap_nonce: '0' }, { ...plain(), bootstrap_nonce: undefined },
  ];
  for (const account of bad) assert.equal(hasPlainOwnerProfileAt(account, BLOCK), false, JSON.stringify(account));
  assert.equal(hasPlainOwnerProfileAt(plain(), 'not-a-block-hash'), false);
});
