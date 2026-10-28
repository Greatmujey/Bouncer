import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRpcEndpoint } from '../shared/rpc-endpoint.mjs';

test('RPC endpoint is HTTPS or loopback HTTP, without URL credentials', () => {
  assert.equal(validateRpcEndpoint('https://rpc.example/path'), 'https://rpc.example/path');
  assert.equal(validateRpcEndpoint('http://127.0.0.1:3030'), 'http://127.0.0.1:3030/');
  assert.equal(validateRpcEndpoint('http://[::1]:3030'), 'http://[::1]:3030/');
  for (const bad of ['http://remote.example', 'http://localhost.evil.example', 'file:///etc/passwd',
    'https://user:secret@rpc.example', 'https://rpc.example/path?token=secret', 'https://rpc.example/path#secret']) {
    assert.throws(() => validateRpcEndpoint(bad), error => !error.message.includes('secret'));
  }
});
